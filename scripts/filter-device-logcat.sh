#!/usr/bin/env bash
#
# filter-device-logcat.sh
#
# Purpose : T-58-07-06 — reduce a raw device logcat to only the lines produced by
#           the app under test (and the system lines that name its package) before
#           the capture is committed to .planning/.
#
# Why this exists:
#   A device-wide `adb logcat` from a developer's personal handset carries every
#   other running app's telemetry. 58-08 committed one such capture: 43,187 lines
#   naming 412 distinct dotted identifiers, including social and messaging apps
#   unrelated to VoteTorrent. That is a confidentiality problem in the phase record
#   even when it carries no key material.
#
# Why it filters by PID rather than by grepping the package name:
#   The app's own log lines are tagged with a TRUNCATED process name
#   ("rrent.authorit"), not the package, so a package grep silently drops almost
#   all of them. The process ids are the only reliable handle, and they are
#   recoverable from the capture itself via the "Start proc" lines.
#
# What is KEPT:
#   1. every line whose pid field is one of --pid
#   2. every line naming --package (system-side lifecycle: Start proc / Killing /
#      Force stopping — these carry the cold-start proof)
#   3. the "--------- beginning of <buffer>" section markers
#
# Both logcat layouts are handled: "brief" (L/tag( pid): msg) and "threadtime"
# (date time pid tid L tag: msg).
#
# Usage:
#   scripts/filter-device-logcat.sh --in RAW --out FILTERED \
#     --package org.votetorrent.authority --pid 20132 --pid 422 --pid 1484
#
#   Omit --pid to auto-discover them from the capture's own "Start proc" lines.
#
# Exits non-zero if the filter would keep zero app lines — a filter that empties
# the capture is a broken filter, not a clean one.

set -euo pipefail

# ---------------------------------------------------------------------------
# --selftest : offline behavioural gate for this script's own filtering logic.
#
# T-58-07-06 closed a confidentiality control with NO automated verification. Two
# silent failure modes matter, in order of danger:
#   (a) a future edit makes the filter KEEP third-party lines -> confidentiality leak.
#   (b) a future edit makes the filter DROP app-emitted lines -> 58-08-REDMI-EVIDENCE.md's
#       negative controls (grep -c of forbidden strings == 0) are only meaningful because
#       100% of app lines survive; a filter that silently drops app lines makes every such
#       zero trivially true while the evidence becomes worthless. The more dangerous mode.
#
# Every behavioural assertion below drives THIS SAME SCRIPT as a subprocess
# (bash "$ST_SELF" --in ... --out ... --package ...) -- there is exactly one copy of the
# parsing logic in this repository, never a second hand-written parser to check against.
# Rigor instead comes from mutation controls: each core assertion is proven non-inert by
# copying this script, breaking ONE specific behaviour in the copy via an exact,
# occurrence-counted text substitution, and showing the same assertion goes RED against
# the mutant. A mutation whose target snippet is not found exactly once in this file is a
# harness bug (FATAL), never a silent skip.
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--selftest" ]; then

  ST_SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  ST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/filter-logcat-selftest.XXXXXX")"
  trap 'rm -rf "$ST_TMP"' EXIT
  ST_PKG="org.votetorrent.authority"

  ST_ASSERTIONS=0
  ST_FAILURES=0

  st_eq() {
    local expected="$1" actual="$2" desc="$3"
    ST_ASSERTIONS=$((ST_ASSERTIONS + 1))
    if [ "$expected" != "$actual" ]; then
      ST_FAILURES=$((ST_FAILURES + 1))
      echo "FAIL [$desc]: expected [$expected] got [$actual]" >&2
    fi
  }

  # Runs: bash SCRIPT --in IN --out OUT --package PKG [extra args...]
  # Sets ST_RC (exit code) and ST_STDOUT (combined stdout+stderr). Safe under set -e.
  st_invoke() {
    local script="$1"; shift
    set +e
    ST_STDOUT="$(bash "$script" "$@" 2>&1)"
    ST_RC=$?
    set -e
  }

  # Copies $ST_SELF, replacing the unique snippet in $2 (file) with $3 (file) exactly
  # once. Fails LOUDLY (not a silent no-op) if the snippet isn't found exactly once.
  make_mutant() {
    local label="$1" oldfile="$2" newfile="$3"
    local out="$ST_TMP/mutant-$label.sh"
    node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const [, srcPath, oldPath, newPath, outPath] = process.argv;
const src = readFileSync(srcPath, "utf8");
const oldStr = readFileSync(oldPath, "utf8");
const newStr = readFileSync(newPath, "utf8");
const parts = src.split(oldStr);
const hits = parts.length - 1;
if (hits !== 1) {
  console.error(`mutation target found ${hits} time(s), expected exactly 1: ${oldPath}`);
  process.exit(1);
}
writeFileSync(outPath, parts.join(newStr));
' "$ST_SELF" "$oldfile" "$newfile" "$out" \
      || { echo "FATAL: mutation harness broken for '$label' -- target snippet not unique in $ST_SELF" >&2; exit 1; }
    chmod +x "$out"
    printf '%s' "$out"
  }

  # -------------------------------------------------------------------------
  # Fixtures (synthetic only -- never the committed capture)
  # -------------------------------------------------------------------------
  # 15 lines: 2 section markers + 13 content lines, spanning BOTH logcat layouts
  # (brief, lines 3-11; threadtime, lines 12-14) plus one more brief Start proc line.
  # Expected KEEP set (pids 9001 + 5001 explicit, or auto-discovered): positions
  # 1,2,3,5,6,7,10,12,13,15 = 10 lines. Expected DROP set: 4,8,9,11,14 = 5 lines.
  MASTER_IN="$ST_TMP/master-in.txt"
  cat > "$MASTER_IN" <<'FIXTURE'
--------- beginning of main
--------- beginning of system
09-09 21:19:37.100 I/ActivityManager( 1620): Start proc 9001:org.votetorrent.authority/u0a318 for activity {org.votetorrent.authority/.MainActivity} caller=com.android.shell
09-09 21:19:37.110 I/ActivityManager( 1620): Start proc 7003:com.other.unrelated.app/u0a5 for activity {com.other.unrelated.app/.MainActivity} caller=com.android.shell
09-09 21:19:37.300 D/AppTag  ( 9001): app brief line one
09-09 21:19:37.301 D/AppTag  ( 9001): app brief line two
09-09 21:19:37.302 D/AppTag  ( 9001): embedded paren probe (4242): should not steal pid
09-09 21:19:37.310 D/OtherTg(  555): unrelated other-process brief line
09-09 21:19:37.320 I/ActivityManager( 1620): Killing 555:com.other.unrelated.app/u0a5 (adj 906): empty #17
09-09 21:19:37.330 I/ActivityManager( 1620): Force stopping org.votetorrent.authority appid=10318 user=0
09-09 21:19:37.340 D/SysNoise(  700): totally unrelated system noise line
09-09 18:30:24.542  5001  5050 I ReactNativeJS: app threadtime line one
09-09 18:30:24.552  5001  5050 I ReactNativeJS: app threadtime line two
09-09 18:30:24.562  4321  4321 I OtherProc: unrelated threadtime line
09-09 21:19:37.400 I/ActivityManager( 1620): Start proc 5001:org.votetorrent.authority/u0a318 for activity {org.votetorrent.authority/.MainActivity} caller=com.android.shell
FIXTURE

  # No line here matches pid 9999 or names the package -- kept must be exactly zero.
  EMPTY_IN="$ST_TMP/empty-in.txt"
  cat > "$EMPTY_IN" <<'FIXTURE'
09-09 21:19:37.100 I/ActivityManager( 1620): Start proc 7003:com.other.unrelated.app/u0a5 for activity {com.other.unrelated.app/.MainActivity} caller=com.android.shell
09-09 21:19:37.310 D/OtherTg(  555): unrelated other-process brief line
09-09 18:30:24.562  4321  4321 I OtherProc: unrelated threadtime line
FIXTURE

  # -------------------------------------------------------------------------
  # 1-4, 6, 7, 9. Real script, explicit pids: pid-based keep/drop (both layouts),
  # package-named system lines kept, embedded-paren probe resolved correctly,
  # section markers survive, 100% app-line retention.
  # -------------------------------------------------------------------------
  REAL_OUT="$ST_TMP/real-out.txt"
  st_invoke "$ST_SELF" --in "$MASTER_IN" --out "$REAL_OUT" --package "$ST_PKG" --pid 9001 --pid 5001
  st_eq 0 "$ST_RC" "real script: explicit-pid run exits 0"
  st_eq 10 "$(wc -l < "$REAL_OUT" | tr -d ' ')" "real script: kept exactly 10/15 lines"
  st_eq yes "$(grep -qF -- '--------- beginning of main' "$REAL_OUT" && echo yes || echo no)" "section marker (main) survives"
  st_eq yes "$(grep -qF -- '--------- beginning of system' "$REAL_OUT" && echo yes || echo no)" "section marker (system) survives"
  st_eq yes "$(grep -qF 'app brief line one' "$REAL_OUT" && echo yes || echo no)" "brief app-pid line 1/5 kept (pid 9001)"
  st_eq yes "$(grep -qF 'app brief line two' "$REAL_OUT" && echo yes || echo no)" "brief app-pid line 2/5 kept (pid 9001)"
  st_eq yes "$(grep -qF 'app threadtime line one' "$REAL_OUT" && echo yes || echo no)" "threadtime app-pid line 3/5 kept (pid 5001)"
  st_eq yes "$(grep -qF 'app threadtime line two' "$REAL_OUT" && echo yes || echo no)" "threadtime app-pid line 4/5 kept (pid 5001)"
  st_eq yes "$(grep -qF 'embedded paren probe' "$REAL_OUT" && echo yes || echo no)" \
    "brief app-pid line 5/5 kept: pid resolved from the FIRST '): ', not the embedded '(4242): ' in the message body"
  st_eq no "$(grep -qF 'unrelated other-process brief line' "$REAL_OUT" && echo yes || echo no)" "other-pid brief line dropped (pid 555)"
  st_eq no "$(grep -qF 'unrelated threadtime line' "$REAL_OUT" && echo yes || echo no)" "other-pid threadtime line dropped (pid 4321)"
  st_eq no "$(grep -qF 'totally unrelated system noise' "$REAL_OUT" && echo yes || echo no)" "other-pid system line dropped (pid 700)"
  st_eq no "$(grep -qF 'com.other.unrelated.app' "$REAL_OUT" && echo yes || echo no)" "system lifecycle lines naming a DIFFERENT package are dropped"
  st_eq yes "$(grep -qF 'Force stopping org.votetorrent.authority' "$REAL_OUT" && echo yes || echo no)" \
    "system pid (1620, not an app pid) lifecycle line NAMING our package is kept (cold-start proof)"

  # -------------------------------------------------------------------------
  # 5. Pid auto-discovery: omit --pid, must independently reach the identical
  # 10-line result (and must NOT pick up the 7003:com.other.unrelated.app pid).
  # -------------------------------------------------------------------------
  AUTO_OUT="$ST_TMP/auto-out.txt"
  st_invoke "$ST_SELF" --in "$MASTER_IN" --out "$AUTO_OUT" --package "$ST_PKG"
  st_eq 0 "$ST_RC" "auto-discovery run exits 0"
  st_eq yes "$(echo "$ST_STDOUT" | grep -qF 'auto-discovered pids:5001 9001 ' && echo yes || echo no)" \
    "auto-discovery finds exactly {5001, 9001}, not the 7003 (other package) pid"
  st_eq identical "$(diff -q "$AUTO_OUT" "$REAL_OUT" > /dev/null 2>&1 && echo identical || echo different)" \
    "auto-discovery output is byte-identical to the explicit --pid run"

  # -------------------------------------------------------------------------
  # 8. Fail-closed guards: zero-keep capture, and missing required arguments.
  # -------------------------------------------------------------------------
  ZERO_OUT="$ST_TMP/zero-out.txt"
  st_invoke "$ST_SELF" --in "$EMPTY_IN" --out "$ZERO_OUT" --package "$ST_PKG" --pid 9999
  st_eq nonzero "$([ "$ST_RC" -ne 0 ] && echo nonzero || echo zero)" "filter exits non-zero when it would keep zero app lines"

  st_invoke "$ST_SELF" --out "$ST_TMP/x.txt" --package "$ST_PKG"
  st_eq nonzero "$([ "$ST_RC" -ne 0 ] && echo nonzero || echo zero)" "missing --in exits non-zero"
  st_invoke "$ST_SELF" --in "$MASTER_IN" --package "$ST_PKG"
  st_eq nonzero "$([ "$ST_RC" -ne 0 ] && echo nonzero || echo zero)" "missing --out exits non-zero"
  st_invoke "$ST_SELF" --in "$MASTER_IN" --out "$ST_TMP/x.txt"
  st_eq nonzero "$([ "$ST_RC" -ne 0 ] && echo nonzero || echo zero)" "missing --package exits non-zero"

  # -------------------------------------------------------------------------
  # Mutation controls -- each core assertion above proven non-inert by breaking
  # exactly the behaviour it claims, one mutation at a time, against a COPY.
  # -------------------------------------------------------------------------
  OLD1="$ST_TMP/old1.txt"; NEW1="$ST_TMP/new1.txt"
  printf '  if (pid != "" && (pid in want)) { kept++; print; next }\n' > "$OLD1"
  printf '  if (pid != "" && !(pid in want)) { kept++; print; next }\n' > "$NEW1"
  M1="$(make_mutant m1-invert-keep-decision "$OLD1" "$NEW1")"
  st_invoke "$M1" --in "$MASTER_IN" --out "$ST_TMP/m1-out.txt" --package "$ST_PKG" --pid 9001 --pid 5001
  M1_KEPT="$(wc -l < "$ST_TMP/m1-out.txt" | tr -d ' ')"
  # Total kept count is a MISLEADING signal for this mutation: inverting keep/drop swaps
  # which 5 lines are dropped for which 5 are leaked, so the raw total (10) coincidentally
  # survives unchanged. Report the actual composition swap, not just the total.
  M1_APP_LOST="$(grep -cF 'app brief line' "$ST_TMP/m1-out.txt" || true)"
  M1_LEAKED="$(grep -cF 'unrelated' "$ST_TMP/m1-out.txt" || true)"
  echo "MUTATION m1 (invert pid keep/drop): real kept=10 (2/2 'app brief line' present, 0/5 'unrelated' leaked) ->" \
    "mutant kept=$M1_KEPT ($M1_APP_LOST/2 'app brief line' present, $M1_LEAKED/5 'unrelated' leaked)" \
    "-- total count is a false negative here (10 == 10); composition is what breaks"
  st_eq no "$(grep -qF 'app brief line one' "$ST_TMP/m1-out.txt" && echo yes || echo no)" \
    "RED CONTROL m1: app-pid line 'app brief line one' now DROPPED (assertion 1 depends on the un-inverted decision)"
  st_eq yes "$(grep -qF 'unrelated other-process brief line' "$ST_TMP/m1-out.txt" && echo yes || echo no)" \
    "RED CONTROL m1: other-pid line now wrongly KEPT (assertion 2 depends on the un-inverted decision)"

  OLD2="$ST_TMP/old2.txt"; NEW2="$ST_TMP/new2.txt"
  printf '  if (index($0, pkg) > 0)         { kept++; print; next }\n' > "$OLD2"
  printf '  if (0)                              { kept++; print; next }\n' > "$NEW2"
  M2="$(make_mutant m2-disable-package-match "$OLD2" "$NEW2")"
  st_invoke "$M2" --in "$MASTER_IN" --out "$ST_TMP/m2-out.txt" --package "$ST_PKG" --pid 9001 --pid 5001
  M2_KEPT="$(wc -l < "$ST_TMP/m2-out.txt" | tr -d ' ')"
  echo "MUTATION m2 (disable package-name keep): real kept=10 -> mutant kept=$M2_KEPT"
  st_eq no "$(grep -qF 'Force stopping org.votetorrent.authority' "$ST_TMP/m2-out.txt" && echo yes || echo no)" \
    "RED CONTROL m2: system-pid cold-start line now DROPPED (assertion 3 depends on the package-name fallback)"
  st_eq 7 "$M2_KEPT" "RED CONTROL m2: kept count drops from 10 to 7 (loses exactly the 3 package-only-matched lines)"

  OLD3="$ST_TMP/old3.txt"; NEW3="$ST_TMP/new3.txt"
  printf '    p = index($0, "): ")\n' > "$OLD3"
  printf '    p = 0\n    off = 0\n    s = $0\n    while ((q = index(s, "): ")) > 0) { p = off + q; off = p + 3; s = substr($0, off + 1) }\n' > "$NEW3"
  M3="$(make_mutant m3-greedy-last-occurrence "$OLD3" "$NEW3")"
  st_invoke "$M3" --in "$MASTER_IN" --out "$ST_TMP/m3-out.txt" --package "$ST_PKG" --pid 9001 --pid 5001
  M3_KEPT="$(wc -l < "$ST_TMP/m3-out.txt" | tr -d ' ')"
  echo "MUTATION m3 (pid located at LAST '): ' instead of FIRST): real kept=10 -> mutant kept=$M3_KEPT"
  st_eq no "$(grep -qF 'embedded paren probe' "$ST_TMP/m3-out.txt" && echo yes || echo no)" \
    "RED CONTROL m3: embedded-paren probe now DROPPED -- proves the FIRST-occurrence rule (assertion 6) is load-bearing, not incidental"
  st_eq 9 "$M3_KEPT" "RED CONTROL m3: kept count drops from 10 to 9 (loses exactly the one ambiguous line)"

  OLD4="$ST_TMP/old4.txt"; NEW4="$ST_TMP/new4.txt"
  printf 'END { if (kept + 0 == 0) { print "filter kept zero app lines" > "/dev/stderr"; exit 1 } }\n' > "$OLD4"
  printf 'END { if (kept + 0 == 0) { print "filter kept zero app lines" > "/dev/stderr" } }\n' > "$NEW4"
  M4="$(make_mutant m4-remove-zero-guard "$OLD4" "$NEW4")"
  st_invoke "$M4" --in "$EMPTY_IN" --out "$ST_TMP/m4-out.txt" --package "$ST_PKG" --pid 9999
  echo "MUTATION m4 (remove zero-keep guard): real exit=nonzero on an emptied capture -> mutant exit=$ST_RC"
  st_eq zero "$([ "$ST_RC" -ne 0 ] && echo nonzero || echo zero)" \
    "RED CONTROL m4: an emptied capture now exits 0 -- proves assertion 8's guard is load-bearing, not incidental"

  OLD5="$ST_TMP/old5.txt"; NEW5="$ST_TMP/new5.txt"
  printf '    pid = $3\n' > "$OLD5"
  printf '    pid = $4\n' > "$NEW5"
  M5="$(make_mutant m5-threadtime-wrong-field "$OLD5" "$NEW5")"
  st_invoke "$M5" --in "$MASTER_IN" --out "$ST_TMP/m5-out.txt" --package "$ST_PKG" --pid 9001 --pid 5001
  M5_KEPT="$(wc -l < "$ST_TMP/m5-out.txt" | tr -d ' ')"
  echo "MUTATION m5 (threadtime pid read from tid field): real kept=10 -> mutant kept=$M5_KEPT"
  st_eq no "$(grep -qF 'app threadtime line one' "$ST_TMP/m5-out.txt" && echo yes || echo no)" \
    "RED CONTROL m5: threadtime app-pid lines now DROPPED -- proves assertion 4's threadtime field selection is load-bearing"
  st_eq 8 "$M5_KEPT" "RED CONTROL m5: kept count drops from 10 to 8 (loses exactly the 2 threadtime app lines)"

  OLD6="$ST_TMP/old6.txt"; NEW6="$ST_TMP/new6.txt"
  printf '  PIDS=$(LC_ALL=C grep -oE "Start proc [0-9]+:${PKG}[/ ]" "$IN" \\\n' > "$OLD6"
  printf '  PIDS=$(LC_ALL=C grep -oE "NEVER-MATCHES-XYZ-${PKG}" "$IN" \\\n' > "$NEW6"
  M6="$(make_mutant m6-break-autodiscovery "$OLD6" "$NEW6")"
  st_invoke "$M6" --in "$MASTER_IN" --out "$ST_TMP/m6-out.txt" --package "$ST_PKG"
  echo "MUTATION m6 (break Start-proc auto-discovery regex): real exit=0, pids={5001,9001} -> mutant exit=$ST_RC"
  st_eq nonzero "$([ "$ST_RC" -eq 0 ] && echo zero || echo nonzero)" \
    "RED CONTROL m6: auto-discovery now finds no pids and exits non-zero -- proves assertion 5 is load-bearing"

  OLD7="$ST_TMP/old7.txt"; NEW7="$ST_TMP/new7.txt"
  printf '/^-----+ beginning of/ { print; next }\n' > "$OLD7"
  printf '/^ZZZ-NEVER-MATCHES-ZZZ/ { print; next }\n' > "$NEW7"
  M7="$(make_mutant m7-break-section-markers "$OLD7" "$NEW7")"
  st_invoke "$M7" --in "$MASTER_IN" --out "$ST_TMP/m7-out.txt" --package "$ST_PKG" --pid 9001 --pid 5001
  M7_KEPT="$(wc -l < "$ST_TMP/m7-out.txt" | tr -d ' ')"
  echo "MUTATION m7 (break section-marker rule): real kept=10 -> mutant kept=$M7_KEPT"
  st_eq no "$(grep -qF -- '--------- beginning of main' "$ST_TMP/m7-out.txt" && echo yes || echo no)" \
    "RED CONTROL m7: section marker now DROPPED -- proves assertion 7 is load-bearing"
  st_eq 8 "$M7_KEPT" "RED CONTROL m7: kept count drops from 10 to 8 (loses exactly the 2 markers)"

  if [ "$ST_FAILURES" -gt 0 ]; then
    echo "selftest FAILED: $ST_FAILURES/$ST_ASSERTIONS assertions failed" >&2
    exit 1
  fi
  echo "selftest: $ST_ASSERTIONS assertions passed (7 mutation controls, all confirmed RED against a broken copy)."
  exit 0
fi

IN=""; OUT=""; PKG=""; PIDS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --in)      IN="$2"; shift 2 ;;
    --out)     OUT="$2"; shift 2 ;;
    --package) PKG="$2"; shift 2 ;;
    --pid)     PIDS="$PIDS $2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$IN" ]  || { echo "--in is required" >&2; exit 2; }
[ -n "$OUT" ] || { echo "--out is required" >&2; exit 2; }
[ -n "$PKG" ] || { echo "--package is required" >&2; exit 2; }
[ -f "$IN" ]  || { echo "no such capture: $IN" >&2; exit 2; }

# Auto-discover the app's pids from the capture when none were named.
if [ -z "${PIDS// /}" ]; then
  PIDS=$(LC_ALL=C grep -oE "Start proc [0-9]+:${PKG}[/ ]" "$IN" \
         | sed -E 's/Start proc ([0-9]+):.*/\1/' | sort -u | tr '\n' ' ')
  echo "auto-discovered pids:${PIDS:- none}"
fi
[ -n "${PIDS// /}" ] || { echo "no pids for $PKG in $IN" >&2; exit 1; }

LC_ALL=C awk -v pidlist="$PIDS" -v pkg="$PKG" '
BEGIN { n = split(pidlist, a, /[ ]+/); for (i = 1; i <= n; i++) if (a[i] != "") want[a[i]] = 1 }

# Section markers carry no app data but preserve the capture structure.
/^-----+ beginning of/ { print; next }

{
  pid = ""

  # threadtime: "09-09 21:19:37.260  4010  4063 I Tag: msg"
  if ($0 ~ /^[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]\.[0-9][0-9][0-9] +[0-9]+ +[0-9]+ [VDIWEF] /) {
    pid = $3
  }
  # brief: "09-09 21:19:37.260 D/Tag  (  872): msg" — the pid is the parenthesised
  # field immediately before the FIRST "): ", located exactly rather than by a
  # greedy regex that could match a "(123): " inside the message body.
  else if ($0 ~ /^[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]\.[0-9][0-9][0-9] [VDIWEF]\//) {
    p = index($0, "): ")
    if (p > 0) {
      pre = substr($0, 1, p - 1)
      for (i = length(pre); i > 0; i--) if (substr(pre, i, 1) == "(") break
      if (i > 0) { cand = substr(pre, i + 1); gsub(/ /, "", cand); if (cand ~ /^[0-9]+$/) pid = cand }
    }
  }

  if (pid != "" && (pid in want)) { kept++; print; next }
  if (index($0, pkg) > 0)         { kept++; print; next }
}

END { if (kept + 0 == 0) { print "filter kept zero app lines" > "/dev/stderr"; exit 1 } }
' "$IN" > "$OUT"

in_lines=$(LC_ALL=C wc -l < "$IN"); out_lines=$(LC_ALL=C wc -l < "$OUT")
in_bytes=$(LC_ALL=C wc -c < "$IN"); out_bytes=$(LC_ALL=C wc -c < "$OUT")
ident() { LC_ALL=C grep -oE '\b[a-z][a-z0-9_]*(\.[a-z0-9_]+){2,}\b' "$1" 2>/dev/null | sort -u | wc -l | tr -d ' '; }

echo "package : $PKG"
echo "pids    :${PIDS}"
echo "lines   : ${in_lines} -> ${out_lines}"
echo "bytes   : ${in_bytes} -> ${out_bytes}"
echo "idents  : $(ident "$IN") -> $(ident "$OUT")   (distinct dotted identifiers)"
