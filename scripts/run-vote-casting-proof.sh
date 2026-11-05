#!/usr/bin/env bash
#
# run-vote-casting-proof.sh - the Phase 63 D-30 device proof for local vote casting.
#
# Purpose : prove, on an Android emulator with an enrolled fingerprint, that the SHIPPED local
#           vote path (castVote, the receipt reveal, the vault, the store) behaves as 63-CONTEXT
#           decided. The in-app half is scripts/proof/vote-casting-probe.ts; the host half is
#           scripts/lib/vote-casting-verify.mjs. This script is the single entry point.
#
# Usage   : run-vote-casting-proof.sh <abs-outdir>   device mode. Run ONLY from a linked worktree
#                                                    (63-16 creates ../votetorrent-p63).
#           run-vote-casting-proof.sh --selftest     host-only parser and verifier selftest.
#           run-vote-casting-proof.sh --typecheck-probe
#                                                    host-only typecheck of the probe.
#
# Prereqs : the debug APK built in THIS tree (63-17), an enrollable Pixel_8_b AVD, and adb, curl,
#           node, yarn, lsof and shasum on PATH.
#
# Exit    : 0 only when every leg PASSes. Anything else is non-zero. The exit code is fail-closed:
#           SCRIPT_EXIT_CODE starts at 1 and only the explicit success points set it to 0 (bash 3.2
#           EXIT traps keep the status of the last command otherwise).
#
# Verdict prefix rule (IN-03): device legs print `LEG <name>: PASS|FAIL (...)`. The selftest prints
#           `SELFTEST-LEG ...` and never a line that starts `LEG `, so a selftest can never be read
#           as a device verdict.
#
# What this defends against (each is a recorded trap in this project):
#   - the shared checkout and the concurrent session: device mode refuses unless the tree is a
#     LINKED worktree, and the serial, AVD and Metro port are fixed constants with no override;
#   - a stale dist: check-dist-freshness.sh, a voting src to dist mtime check, exports present;
#   - a stale APK: older than the native wrap sources or the Voter package.json;
#   - a stray or other-tree Metro or a cached bundle: debug_http_host pinned and read back on every
#     launch, a per-run random needle in the SERVED bundle AND in the device boot line, the RN
#     version triple of this tree, Metro started from this tree with --reset-cache;
#   - the dev stub producer signing the vote: the producer-real leg and the verifier stub control;
#   - the multi-argument log trap: one string per line, and an extractor that rejects the quoted form;
#   - literal-needle false leaks: the needles are castVote's random nonces and the signature;
#   - per-use versus time-bound prompt confusion: one count per focus episode, by named window;
#   - an enabled proof flag left behind: an EXIT/INT/TERM trap, a status-entry count and an
#     all-false read-back;
#   - the Play Store WebView update killing the app mid-run: vending disabled after every boot.
#
# This script never commits and never stages anything with git.

set -euo pipefail
export FORCE_COLOR=0

TREE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$TREE/apps/VoteTorrentVoter"
PKG=org.votetorrent.voter
ACTIVITY=.MainActivity
SERIAL=emulator-5560
AVD=Pixel_8_b
EMU_PORT=5560
METRO_PORT=8091
FLAG_FILE=apps/VoteTorrentVoter/src/engines/proof-flags.generated.ts
INDEX_FILE=apps/VoteTorrentVoter/index.js
STAGE_DIR="$APP/__voteproof__"
PROBE_SRC="$TREE/scripts/proof/vote-casting-probe.ts"
VERIFIER="$TREE/scripts/lib/vote-casting-verify.mjs"
REQUIRE_LINE="require('./__voteproof__/vote-casting-probe');"
PROMPT_FOCUS_RE=BiometricPrompt
PROMPT_TITLES='Vote proof (sign|save|view now|view later|reopen|tamper ct|tamper aad|stale view)'
STRAND_FILE_RE='(\.ldb|/[0-9]+\.log|/MANIFEST-[0-9]+|/CURRENT)$'

SCRIPT_EXIT_CODE=1
CLEANUP_KIND=""
ST_TMP=""
OUT=""
METRO_PID=""
BASE_STATUS_COUNT=""
RUN_ID=""
NEEDLE=""

adb_() { adb -s "$SERIAL" "$@"; }
note() { echo "[vote-casting-proof] $*"; }
fail() { echo "[vote-casting-proof] FAIL: $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Pure parser functions (used by device mode and exercised by --selftest)
# ---------------------------------------------------------------------------

# flag_served_value <bundle> <FLAG> -> true | false | absent
flag_served_value() {
  local occ
  occ="$(grep -o "$2[^,;]*" "$1" 2>/dev/null || true)"
  if [ -z "$occ" ]; then echo absent; return 0; fi
  if grep -qE '=[[:space:]]*false' <<<"$occ"; then echo false; return 0; fi
  if grep -qE '=[[:space:]]*true' <<<"$occ"; then echo true; return 0; fi
  echo absent
}

# rn_triple_ok <bundle> <minor> <patch>: prints every triple found, 0 only when one matches.
rn_triple_ok() {
  node -e '
    const fs = require("fs")
    const text = fs.readFileSync(process.argv[1], "utf8")
    // RN <= 0.86 ships an object literal; RN 0.87 ships class statics (X.major = 0; X.minor = 87; ...).
    const re = /major:\s*0,\s*minor:\s*(\d+),\s*patch:\s*(\d+)/g
    const re2 = /\.major = 0;\s*\w+\.minor = (\d+);\s*\w+\.patch = (\d+);/g
    let m
    let ok = false
    const seen = []
    for (const r of [re, re2]) {
      while ((m = r.exec(text)) !== null) {
        seen.push("0." + m[1] + "." + m[2])
        if (m[1] === process.argv[2] && m[2] === process.argv[3]) ok = true
      }
    }
    console.log(seen.join(" "))
    process.exit(ok ? 0 : 1)
  ' "$1" "$2" "$3"
}

# count_occ <file> <fixed-string>: occurrences, not lines.
count_occ() {
  { grep -o -F -- "$2" "$1" 2>/dev/null || true; } | wc -l | tr -d ' '
}

# leg_status <js-log> <leg> -> PASS | FAIL | ABSENT. ABSENT is a FAIL everywhere.
leg_status() {
  local line
  line="$(grep -E "\[vcp\] leg $2 (PASS|FAIL)" "$1" 2>/dev/null | tail -n 1 || true)"
  if [ -z "$line" ]; then echo ABSENT; return 0; fi
  case "$line" in
    *"[vcp] leg $2 PASS"*) echo PASS ;;
    *) echo FAIL ;;
  esac
}

# extract_payload <js-log> <key>: text after `[vcp] <key> ` on the last matching line.
extract_payload() {
  { grep -F "[vcp] $2 " "$1" 2>/dev/null || true; } | tail -n 1 | sed -e "s/^.*\[vcp\] $2 //"
}

# tally <prompts.tsv> <window>: rows whose second field equals the window.
tally() {
  if [ ! -f "$1" ]; then echo 0; return 0; fi
  awk -F'\t' -v w="$2" '$2 == w { n++ } END { print n + 0 }' "$1"
}

# tally_between <prompts.tsv>: prompts attributed outside any window.
tally_between() {
  if [ ! -f "$1" ]; then echo 0; return 0; fi
  awk -F'\t' '$2 ~ /^between:/ { n++ } END { print n + 0 }' "$1"
}

# d14_mode <submit> <receipt-now> -> time-bound | per-use | inconsistent
d14_mode() {
  if [ "$1" -eq 1 ] && [ "$2" -eq 0 ]; then echo time-bound
  elif [ "$1" -eq 2 ] && [ "$2" -eq 1 ]; then echo per-use
  else echo inconsistent
  fi
}

# prompts_verdict <submit> <now> <later> <preflight> <guard> <guardRestart> <cleared> <between> <staleSubmit>
prompts_verdict() {
  local s="$1" n="$2" l="$3" pf="$4" g="$5" gr="$6" cl="$7" bt="$8" ss="$9"
  if [ "$s" -ne 1 ] && [ "$s" -ne 2 ]; then echo "FAIL submit-count=$s"; return 0; fi
  if [ "$l" -ne 1 ]; then echo "FAIL receipt-later=$l"; return 0; fi
  if [ "$pf" -ne 0 ]; then echo "FAIL preflight-prompts=$pf"; return 0; fi
  if [ "$g" -ne 0 ]; then echo "FAIL guard-prompts=$g"; return 0; fi
  if [ "$gr" -ne 0 ]; then echo "FAIL guard-restart-prompts=$gr"; return 0; fi
  if [ "$cl" -ne 0 ]; then echo "FAIL cleared-prompts=$cl"; return 0; fi
  if [ "$bt" -ne 0 ]; then echo "FAIL prompts-between-windows=$bt"; return 0; fi
  local mode
  mode="$(d14_mode "$s" "$n")"
  if [ "$mode" = inconsistent ]; then echo "FAIL inconsistent submit=$s receipt-now=$n"; return 0; fi
  if [ "$ss" -ne "$s" ]; then echo "FAIL stale-submit=$ss differs from submit=$s"; return 0; fi
  echo "PASS $mode"
}

# listing_same <a> <b>: 0 when the sorted `size name` listings are identical.
listing_same() {
  diff <(sort "$1") <(sort "$2") >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# Cleanup: one EXIT/INT/TERM path for every mode
# ---------------------------------------------------------------------------

dist_hint() { echo "rebuild dist in THIS tree with: yarn workspace @votetorrent/vote-engine build"; }

kill_own_metro() {
  if [ -n "$METRO_PID" ]; then
    kill "$METRO_PID" 2>/dev/null || true
    pkill -P "$METRO_PID" 2>/dev/null || true
  fi
  local pid cwd
  for pid in $(lsof -nP -tiTCP:"$METRO_PORT" -sTCP:LISTEN 2>/dev/null || true); do
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep '^n' | head -n 1 | cut -c2- || true)"
    case "$cwd" in
      "$TREE"|"$TREE"/*) kill "$pid" 2>/dev/null || true ;;
    esac
  done
}

count_true_flags() {
  { grep -E '= true;' "$TREE/$FLAG_FILE" 2>/dev/null || true; } | wc -l | tr -d ' '
}

cleanup_device() {
  kill_own_metro
  git -C "$TREE" checkout -- "$FLAG_FILE" "$INDEX_FILE" 2>/dev/null || true
  rm -rf "$STAGE_DIR"
  local status_now trues restore_ok=1 detail=""
  status_now="$(git -C "$TREE" status --porcelain | wc -l | tr -d ' ')"
  trues="$(count_true_flags)"
  if [ "$trues" != 0 ]; then restore_ok=0; detail="$detail flag-file-has-$trues-true-exports"; fi
  if ! git -C "$TREE" diff --quiet HEAD -- "$FLAG_FILE" "$INDEX_FILE"; then restore_ok=0; detail="$detail flag-or-index-differs-from-HEAD"; fi
  if [ -n "$BASE_STATUS_COUNT" ] && [ "$status_now" != "$BASE_STATUS_COUNT" ]; then
    restore_ok=0; detail="$detail status-count-$status_now-expected-$BASE_STATUS_COUNT"
  fi
  if [ "$restore_ok" = 1 ]; then
    note "RESTORE: PASS (flags and index.js restored, status entries $status_now)"
  else
    echo "RESTORE: FAIL$detail" >&2
    SCRIPT_EXIT_CODE=1
  fi
  note "Metro on :$METRO_PORT was stopped because it served a flag-enabled probe bundle. A UI pass must start its own: cd apps/VoteTorrentVoter && yarn start --port $METRO_PORT --reset-cache. The emulator was left running."
}

cleanup_probe_stage() {
  rm -rf "$STAGE_DIR"
  local dirty
  dirty="$(git -C "$TREE" status --porcelain -- apps/VoteTorrentVoter/__voteproof__ "$INDEX_FILE" "$FLAG_FILE")"
  if [ -n "$dirty" ]; then
    echo "RESTORE: FAIL path-scoped status is not clean: $dirty" >&2
    SCRIPT_EXIT_CODE=1
  fi
}

on_exit() {
  trap - EXIT INT TERM
  case "$CLEANUP_KIND" in
    device) cleanup_device ;;
    probe) cleanup_probe_stage ;;
  esac
  if [ -n "$ST_TMP" ]; then rm -rf "$ST_TMP"; fi
  exit "$SCRIPT_EXIT_CODE"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---------------------------------------------------------------------------
# Mode: --selftest (host-only, touches no tracked file)
# ---------------------------------------------------------------------------

ST_PASS=0
ST_TOTAL=0
st_check() { # name, then a command whose success means PASS
  local name="$1"
  shift
  ST_TOTAL=$((ST_TOTAL + 1))
  if "$@"; then
    ST_PASS=$((ST_PASS + 1))
    echo "SELFTEST-LEG $name: PASS"
  else
    echo "SELFTEST-LEG $name: FAIL"
  fi
}
st_eq() { [ "$1" = "$2" ]; }
st_quiet() { "$@" >/dev/null 2>&1; }
st_not() { ! "$@" >/dev/null 2>&1; }
st_starts() { case "$1" in "$2"*) return 0 ;; *) return 1 ;; esac; }

run_selftest() {
  ST_TMP="$(mktemp -d)"
  local d="$ST_TMP"

  st_check verifier-selftest st_quiet node "$VERIFIER" --selftest

  printf 'var SEED_REGISTERED_STATE_FIXTURE = exports.SEED_REGISTERED_STATE_FIXTURE = true;\n' > "$d/flag-true.js"
  printf 'var SEED_REGISTERED_STATE_FIXTURE = exports.SEED_REGISTERED_STATE_FIXTURE = false;\n' > "$d/flag-false.js"
  : > "$d/flag-empty.js"
  printf 'X = true;\nSEED_REGISTERED_STATE_FIXTURE = true;\nSEED_REGISTERED_STATE_FIXTURE = false;\n' > "$d/flag-mixed.js"
  st_check flag-true st_eq "$(flag_served_value "$d/flag-true.js" SEED_REGISTERED_STATE_FIXTURE)" true
  st_check flag-false st_eq "$(flag_served_value "$d/flag-false.js" SEED_REGISTERED_STATE_FIXTURE)" false
  st_check flag-absent st_eq "$(flag_served_value "$d/flag-empty.js" SEED_REGISTERED_STATE_FIXTURE)" absent
  st_check flag-mixed-is-false st_eq "$(flag_served_value "$d/flag-mixed.js" SEED_REGISTERED_STATE_FIXTURE)" false

  printf 'x = {\n  major: 0,\n  minor: 99,\n  patch: 3,\n  prerelease: null\n};\n' > "$d/rn.js"
  st_check rn-triple-match st_quiet rn_triple_ok "$d/rn.js" 99 3
  st_check rn-triple-98-rejected st_not rn_triple_ok "$d/rn.js" 98 3
  printf 'V.major = 0;\n  V.minor = 99;\n  V.patch = 3;\n' > "$d/rn2.js"
  st_check rn-triple-statics-match st_quiet rn_triple_ok "$d/rn2.js" 99 3
  st_check rn-triple-statics-98-rejected st_not rn_triple_ok "$d/rn2.js" 98 3

  printf 'I ReactNativeJS: [vcp] leg guard PASS {}\nI ReactNativeJS: [vcp] leg tamper FAIL {}\nI ReactNativeJS: [vcp] leg stale PASS {}\nI ReactNativeJS: [vcp] leg stale FAIL {}\n' > "$d/js.txt"
  st_check leg-pass st_eq "$(leg_status "$d/js.txt" guard)" PASS
  st_check leg-fail st_eq "$(leg_status "$d/js.txt" tamper)" FAIL
  st_check leg-last-line-wins st_eq "$(leg_status "$d/js.txt" stale)" FAIL
  st_check leg-absent st_eq "$(leg_status "$d/js.txt" persist)" ABSENT
  st_check leg-guard-not-guard-restart st_eq "$(leg_status "$d/js.txt" guard-restart)" ABSENT

  printf "I ReactNativeJS: '[vcp]', 'signed {}'\n" > "$d/multiarg.txt"
  printf 'I ReactNativeJS: [vcp] signed {"v":1}\n' > "$d/oneline.txt"
  st_check multi-arg-form-rejected st_eq "$(extract_payload "$d/multiarg.txt" signed)" ""
  st_check one-string-form-extracted st_eq "$(extract_payload "$d/oneline.txt" signed)" '{"v":1}'

  printf 'a\tsubmit\tt\nb\tsubmit\tt\nc\treceipt-later\tt\nd\tbetween:submit\tt\n' > "$d/prompts.tsv"
  st_check tally-submit st_eq "$(tally "$d/prompts.tsv" submit)" 2
  st_check tally-missing-window st_eq "$(tally "$d/prompts.tsv" guard)" 0
  st_check tally-between st_eq "$(tally_between "$d/prompts.tsv")" 1

  st_check prompts-time-bound st_eq "$(prompts_verdict 1 0 1 0 0 0 0 0 1)" "PASS time-bound"
  st_check prompts-per-use st_eq "$(prompts_verdict 2 1 1 0 0 0 0 0 2)" "PASS per-use"
  st_check prompts-inconsistent-fails st_starts "$(prompts_verdict 1 1 1 0 0 0 0 0 1)" FAIL
  st_check prompts-between-fails st_starts "$(prompts_verdict 2 1 1 0 0 0 0 1 2)" FAIL
  st_check prompts-later-zero-fails st_starts "$(prompts_verdict 1 0 0 0 0 0 0 0 1)" FAIL
  st_check prompts-three-submit-fails st_starts "$(prompts_verdict 3 1 1 0 0 0 0 0 3)" FAIL
  st_check prompts-stale-mismatch-fails st_starts "$(prompts_verdict 1 0 1 0 0 0 0 0 2)" FAIL

  printf '100 ./a/000001.ldb\n7 ./a/CURRENT\n' > "$d/l1.txt"
  printf '7 ./a/CURRENT\n100 ./a/000001.ldb\n' > "$d/l2.txt"
  printf '7 ./a/CURRENT\n101 ./a/000001.ldb\n' > "$d/l3.txt"
  st_check listing-identical listing_same "$d/l1.txt" "$d/l2.txt"
  st_check listing-size-change-detected st_not listing_same "$d/l1.txt" "$d/l3.txt"

  printf 'abc abc abc\nabc\n' > "$d/occ.txt"
  st_check count-occurrences-not-lines st_eq "$(count_occ "$d/occ.txt" abc)" 4

  if [ "$ST_PASS" -ne "$ST_TOTAL" ]; then
    echo "SELFTEST FAIL $ST_PASS/$ST_TOTAL"
    exit 1
  fi
  echo "SELFTEST OK $ST_PASS/$ST_TOTAL"
  SCRIPT_EXIT_CODE=0
}

# ---------------------------------------------------------------------------
# Mode: --typecheck-probe (host-only)
# ---------------------------------------------------------------------------

stage_probe() { # run-module needle and run id
  mkdir -p "$STAGE_DIR"
  cp "$PROBE_SRC" "$STAGE_DIR/vote-casting-probe.ts"
  printf "export const VOTE_PROOF_BUNDLE_NEEDLE = '%s'\nexport const VOTE_PROOF_RUN_ID = '%s'\n" "$1" "$2" > "$STAGE_DIR/vote-casting-probe.run.ts"
}

run_typecheck_probe() {
  if [ -e "$STAGE_DIR" ]; then fail "$STAGE_DIR already exists; refusing to stage over it"; fi
  CLEANUP_KIND=probe
  stage_probe vcp-typecheck-only 0000000000000000
  # `types` is pinned because the restricted include does not pull in the node ambient types
  # the app's own whole-directory program gets from its test files.
  printf '{"extends":"../tsconfig.json","compilerOptions":{"types":["node","jest"]},"include":["./*.ts"]}\n' > "$STAGE_DIR/tsconfig.json"
  local log
  log="$(mktemp)"
  (cd "$APP" && yarn tsc -p __voteproof__/tsconfig.json --noEmit --pretty false) > "$log" 2>&1 || true
  local probe_errs total_errs max
  probe_errs="$({ grep '^__voteproof__/' "$log" || true; } | { grep -c 'error TS' || true; })"
  total_errs="$({ grep 'error TS' "$log" || true; } | wc -l | tr -d ' ')"
  max="$(node -p "require('$TREE/scripts/ci-baselines.json').voterTypecheck.maxErrors")"
  rm -f "$log"
  if [ "$probe_errs" = 0 ] && [ "$total_errs" -le "$max" ]; then
    echo "TYPECHECK-PROBE: PASS (probe=$probe_errs total=$total_errs max=$max)"
    SCRIPT_EXIT_CODE=0
  else
    echo "TYPECHECK-PROBE: FAIL (probe=$probe_errs total=$total_errs max=$max)"
  fi
}

# ---------------------------------------------------------------------------
# Device mode helpers
# ---------------------------------------------------------------------------

touch1() {
  adb_ emu finger touch 1 >/dev/null 2>&1 || true
  sleep 1
  adb_ emu finger remove 1 >/dev/null 2>&1 || true
}

# ui_tap <regex>: tap the centre of the first node whose text or content-desc matches.
ui_tap() {
  adb_ shell 'rm -f /sdcard/vcp-ui.xml' >/dev/null 2>&1 || true
  adb_ shell 'uiautomator dump /sdcard/vcp-ui.xml >/dev/null 2>&1 && cat /sdcard/vcp-ui.xml' > "$OUT/ui.xml" 2>/dev/null || return 1
  local xy x y
  xy="$(node -e '
    const fs = require("fs")
    const xml = fs.readFileSync(process.argv[1], "utf8")
    const re = new RegExp(process.argv[2])
    for (const tag of xml.match(/<node [^>]*>/g) || []) {
      const t = (/ text="([^"]*)"/.exec(tag) || [])[1] || ""
      const c = (/ content-desc="([^"]*)"/.exec(tag) || [])[1] || ""
      const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(tag)
      if (b && (re.test(t) || re.test(c))) {
        console.log(Math.round((+b[1] + +b[3]) / 2) + " " + Math.round((+b[2] + +b[4]) / 2))
        break
      }
    }
  ' "$OUT/ui.xml" "$1")" || return 1
  [ -n "$xy" ] || return 1
  read -r x y <<<"$xy"
  adb_ shell input tap "$x" "$y"
}

prompt_title() {
  adb_ shell 'rm -f /sdcard/vcp-ui.xml' >/dev/null 2>&1 || true
  adb_ shell 'uiautomator dump /sdcard/vcp-ui.xml >/dev/null 2>&1 && cat /sdcard/vcp-ui.xml' > "$OUT/ui-title.xml" 2>/dev/null || { echo unknown; return 0; }
  local t
  t="$({ grep -oE "$PROMPT_TITLES" "$OUT/ui-title.xml" || true; } | head -n 1)"
  if [ -n "$t" ]; then echo "$t"; else echo unknown; fi
}

# window_of <js-log>: the window a prompt belongs to, or between:<last>.
window_of() {
  local last name bl el
  last="$({ grep -n '\[vcp\] window-begin ' "$1" 2>/dev/null || true; } | tail -n 1)"
  if [ -z "$last" ]; then echo "between:boot"; return 0; fi
  bl="${last%%:*}"
  name="$(sed -e 's/.*window-begin //' <<<"$last" | awk '{print $1}')"
  el="$({ grep -n "\[vcp\] window-end $name " "$1" || true; } | tail -n 1 | cut -d: -f1)"
  if [ -n "$el" ] && [ "$el" -gt "$bl" ]; then echo "between:$name"; else echo "$name"; fi
}

# pump_until <regex> <timeout-s> <launchN>: 0 matched, 1 timeout, 2 FATAL or dormant.
pump_until() {
  local re="$1" timeout="$2" n="$3" end focus in_prompt=0 touches=0 win title js
  js="$OUT/js-$n.txt"
  end=$((SECONDS + timeout))
  while [ "$SECONDS" -lt "$end" ]; do
    adb_ logcat -d -s 'ReactNativeJS:*' > "$js" 2>/dev/null || true
    if grep -Eq "$re" "$js"; then return 0; fi
    if grep -Eq '\[vcp\] (FATAL|dormant)' "$js"; then return 2; fi
    focus="$(adb_ shell dumpsys window 2>/dev/null | grep -m1 mCurrentFocus || true)"
    if grep -q "$PROMPT_FOCUS_RE" <<<"$focus"; then
      if [ "$in_prompt" -eq 0 ]; then
        in_prompt=1
        touches=0
        win="$(window_of "$js")"
        title="$(prompt_title)"
        printf '%s\t%s\t%s\n' "$(date +%s)" "$win" "$title" >> "$OUT/prompts.tsv"
      else
        # Back-to-back prompts never leave focus between them, so a focus-only episode count merges
        # them. Every probe prompt has its own title: a different title while still in a prompt is a
        # new episode (an instrument defect found on the first device run, 63-18).
        ntitle="$(prompt_title)"
        if [ "$ntitle" != unknown ] && [ "$ntitle" != "$title" ]; then
          touches=0
          title="$ntitle"
          win="$(window_of "$js")"
          printf '%s\t%s\t%s\n' "$(date +%s)" "$win" "$title" >> "$OUT/prompts.tsv"
        fi
      fi
      if [ "$touches" -lt 5 ]; then
        touch1
        touches=$((touches + 1))
      fi
    else
      in_prompt=0
    fi
    sleep 1
  done
  return 1
}

snapshot() { # name
  adb_ shell "run-as $PKG sh -c 'find . -type f -exec stat -c \"%s %n\" {} +'" 2>/dev/null | tr -d '\r' | { grep -E "$STRAND_FILE_RE" || true; } | sort > "$OUT/files-$1.txt"
  if [ ! -s "$OUT/files-$1.txt" ]; then
    fail "snapshot $1 is empty: the device-side find/stat command failed (an instrument defect, not a product result)"
  fi
}

grant_lan() {
  local info
  info="$(adb_ shell dumpsys package "$PKG" 2>/dev/null || true)"
  if ! grep -q 'android.permission.ACCESS_LOCAL_NETWORK' <<<"$info"; then
    note "ACCESS_LOCAL_NETWORK not requested by this APK"
    return 0
  fi
  adb_ shell pm grant "$PKG" android.permission.ACCESS_LOCAL_NETWORK >/dev/null 2>&1 || true
  info="$(adb_ shell dumpsys package "$PKG" 2>/dev/null || true)"
  if ! grep -qE 'ACCESS_LOCAL_NETWORK: granted=true' <<<"$info"; then
    fail "ACCESS_LOCAL_NETWORK is not granted after pm grant (read back)"
  fi
}

launch() { # <mode> [clear]
  local mode="$1" want got
  adb_ shell am force-stop "$PKG" >/dev/null 2>&1 || true
  if [ "${2:-}" = clear ]; then
    adb_ shell pm clear "$PKG" >/dev/null
  fi
  grant_lan
  adb_ shell "run-as $PKG sh -c 'mkdir -p shared_prefs && cat > shared_prefs/${PKG}_preferences.xml'" <<XML
<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <string name="debug_http_host">10.0.2.2:$METRO_PORT</string>
</map>
XML
  want="10.0.2.2:$METRO_PORT"
  got="$(adb_ shell "run-as $PKG sh -c 'cat shared_prefs/*.xml'" 2>/dev/null | tr -d '\r' | grep 'debug_http_host' | sed -e 's/.*>\(.*\)<.*/\1/' || true)"
  if [ "$got" != "$want" ]; then fail "debug_http_host read back '$got', expected '$want'"; fi
  adb_ logcat -c
  adb_ shell am start -W -a android.intent.action.VIEW -n "$PKG/$ACTIVITY" -d "vcp://$mode/$RUN_ID" > "$OUT/am-start-$mode.txt" 2>&1 || true
}

wait_for_emulator() {
  local devs
  devs="$(adb devices 2>/dev/null || true)"
  if ! grep -qE "^${SERIAL}[[:space:]]+device" <<<"$devs"; then
    local sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
    if [ -z "$sdk" ] || [ ! -x "$sdk/emulator/emulator" ]; then fail "no emulator binary (set ANDROID_HOME)"; fi
    note "booting $AVD on $EMU_PORT"
    nohup "$sdk/emulator/emulator" -avd "$AVD" -port 5560 -no-snapshot-save -no-boot-anim -no-audio > "$OUT/emulator.log" 2>&1 &
    adb_ wait-for-device
    for _ in $(seq 1 180); do
      if [ "$(adb_ shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; then break; fi
      sleep 2
    done
    sleep 25
  fi
  if [ "$(adb_ shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" != 1 ]; then fail "emulator did not finish booting"; fi
  local avd_out
  avd_out="$(adb_ emu avd name 2>/dev/null | tr -d '\r' || true)"
  if [ "$(head -n 1 <<<"$avd_out")" != "$AVD" ]; then fail "serial $SERIAL is not the $AVD AVD"; fi
  adb_ shell pm disable-user --user 0 com.android.vending >/dev/null 2>&1 || true
  local disabled
  disabled="$(adb_ shell pm list packages -d 2>/dev/null || true)"
  if ! grep -q 'com.android.vending' <<<"$disabled"; then fail "could not disable the Play Store (read back)"; fi
}

enroll_fingerprint() {
  local out n
  out="$(adb_ shell dumpsys fingerprint 2>/dev/null || true)"
  n="$({ grep -oE '"count":[0-9]+' <<<"$out" || true; } | head -n 1 | { grep -oE '[0-9]+' || true; })"
  if [ "${n:-0}" = 0 ]; then
    adb_ shell locksettings set-pin 1234 >/dev/null 2>&1 || true
    adb_ shell am start -a android.settings.BIOMETRIC_ENROLL --ei android.provider.extra.BIOMETRIC_AUTHENTICATORS_ALLOWED 15 >/dev/null 2>&1 || true
    sleep 3
    adb_ shell input text 1234
    adb_ shell input keyevent 66
    sleep 3
    for _ in 1 2 3 4; do ui_tap 'MORE' >/dev/null 2>&1 || break; sleep 1; done
    ui_tap 'I agree|AGREE|Agree' >/dev/null 2>&1 || true
    sleep 3
    for _ in $(seq 1 14); do touch1; sleep 1; done
    sleep 2
    ui_tap 'DONE' >/dev/null 2>&1 || true
    adb_ shell input keyevent 3
  fi
  out="$(adb_ shell dumpsys fingerprint 2>/dev/null || true)"
  n="$({ grep -oE '"count":[0-9]+' <<<"$out" || true; } | head -n 1 | { grep -oE '[0-9]+' || true; })"
  if [ "${n:-0}" -lt 1 ]; then fail "fingerprint enrolment read back count ${n:-0}"; fi
  note "fingerprints enrolled: $n"
}

# sweep <label> <needle>...: every needle must be absent from the app's files.
sweep() {
  local label="$1" nd hits found=0
  shift
  : > "$OUT/sweep-$label.txt"
  for nd in "$@"; do
    if ! [[ "$nd" =~ ^[0-9a-f]+$ ]]; then fail "sweep needle is not hex (instrument defect)"; fi
    hits="$(adb_ shell "run-as $PKG sh -c \"grep -rla '$nd' . 2>/dev/null\"" | tr -d '\r' | tr '\n' ' ' || true)"
    printf 'needle(len=%s) found in: %s\n' "${#nd}" "${hits:-<nowhere>}" >> "$OUT/sweep-$label.txt"
    if [ -n "${hits// /}" ]; then found=1; fi
  done
  return "$found"
}

needles_from_log() { # <js-log> -> hex nonces, one per line
  extract_payload "$1" needles | node -e '
    let s = ""
    process.stdin.on("data", d => { s += d }).on("end", () => {
      try { console.log(JSON.parse(s).nonces.join("\n")) } catch (e) { process.exit(1) }
    })
  ' 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Mode: device
# ---------------------------------------------------------------------------

run_device() {
  local outarg="$1" git_dir common_dir t
  case "$outarg" in
    /*) ;;
    *) fail "output dir must be absolute (got '$outarg')" ;;
  esac
  git_dir="$(cd "$TREE" && cd "$(git rev-parse --git-dir)" && pwd -P)"
  common_dir="$(cd "$TREE" && cd "$(git rev-parse --git-common-dir)" && pwd -P)"
  if [ "$git_dir" = "$common_dir" ]; then
    fail "device mode must run in a linked worktree (63-16 creates one); refusing to mutate the main checkout"
  fi
  mkdir -p "$outarg"
  OUT="$(cd "$outarg" && pwd -P)"
  : > "$OUT/summary.txt"

  for t in adb curl node yarn lsof; do
    command -v "$t" >/dev/null 2>&1 || fail "missing tool: $t"
  done
  command -v shasum >/dev/null 2>&1 || command -v sha256sum >/dev/null 2>&1 || fail "missing tool: shasum or sha256sum"

  git -C "$TREE" diff --quiet HEAD -- "$FLAG_FILE" "$INDEX_FILE" || fail "flag file or index.js differs from HEAD"
  if [ "$(count_true_flags)" != 0 ]; then fail "flag file already has a true export"; fi
  if [ -e "$STAGE_DIR" ]; then fail "$STAGE_DIR already exists"; fi
  if [ "$(node -p "require('$APP/app.json').name")" != VoteTorrentVoter ]; then fail "app.json name is not VoteTorrentVoter"; fi
  if lsof -nP -iTCP:"$METRO_PORT" -sTCP:LISTEN >/dev/null 2>&1; then fail "something already listens on :$METRO_PORT"; fi

  # Stale dist. This script never builds dist; it names the build command for this tree.
  bash "$TREE/scripts/check-dist-freshness.sh" || fail "stale dist (check-dist-freshness.sh). $(dist_hint)"
  local src base
  for src in "$TREE"/packages/vote-engine/src/voting/*.ts; do
    base="$(basename "$src" .ts)"
    [ -f "$TREE/packages/vote-engine/dist/voting/$base.js" ] || fail "dist/voting/$base.js missing. $(dist_hint)"
    if [ "$src" -nt "$TREE/packages/vote-engine/dist/voting/$base.js" ]; then fail "voting/$base.ts is newer than its dist. $(dist_hint)"; fi
  done
  local ent
  for ent in voterEntryDigest buildVoteEntry; do
    if [ "$(( $(count_occ "$TREE/packages/vote-engine/dist/rn-entry.js" "$ent") + $(count_occ "$TREE/packages/vote-engine/dist/voting/index.js" "$ent") ))" -lt 1 ]; then
      fail "dist does not export $ent. $(dist_hint)"
    fi
  done

  # Stale APK
  local apk="$APP/android/app/build/outputs/apk/debug/app-debug.apk" dep
  [ -f "$apk" ] || fail "debug APK missing: $apk (63-17 builds it)"
  for dep in \
    "$TREE/packages/attestation-native/android/src/main/java/org/votetorrent/attestationnative/SecretWrapHelper.kt" \
    "$TREE/packages/attestation-native/android/src/main/java/org/votetorrent/attestationnative/AttestationNativeModule.kt" \
    "$TREE/packages/attestation-native/src/specs/NativeAttestation.ts" \
    "$APP/package.json"; do
    if [ "$dep" -nt "$apk" ]; then fail "APK is older than $dep; rebuild the debug APK in this tree"; fi
  done
  local apk_sha
  apk_sha="$( (shasum -a 256 "$apk" 2>/dev/null || sha256sum "$apk") | awk '{print $1}')"

  node "$VERIFIER" --selftest > "$OUT/verifier-selftest.txt" || fail "verifier selftest failed; the instrument is not proven"

  BASE_STATUS_COUNT="$(git -C "$TREE" status --porcelain | wc -l | tr -d ' ')"
  local head_sha
  head_sha="$(git -C "$TREE" rev-parse HEAD)"
  RUN_ID="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
  NEEDLE="vcp-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"

  wait_for_emulator
  enroll_fingerprint

  # Mutation: the trap is installed BEFORE the first change.
  CLEANUP_KIND=device
  local tmpflag
  tmpflag="$(mktemp)"
  sed -e 's/^export const SEED_REGISTERED_STATE_FIXTURE = false;/export const SEED_REGISTERED_STATE_FIXTURE = true;/' \
      -e 's/^export const USE_REAL_ATTESTATION_PRODUCER = false;/export const USE_REAL_ATTESTATION_PRODUCER = true;/' \
      "$TREE/$FLAG_FILE" > "$tmpflag"
  cat "$tmpflag" > "$TREE/$FLAG_FILE"
  rm -f "$tmpflag"
  if [ "$(count_true_flags)" != 2 ]; then fail "expected exactly 2 true flag exports"; fi
  grep -q '^export const SEED_REGISTERED_STATE_FIXTURE = true;' "$TREE/$FLAG_FILE" || fail "SEED_REGISTERED_STATE_FIXTURE not enabled"
  grep -q '^export const USE_REAL_ATTESTATION_PRODUCER = true;' "$TREE/$FLAG_FILE" || fail "USE_REAL_ATTESTATION_PRODUCER not enabled"
  [ "$(grep -c '= false;' "$TREE/$FLAG_FILE")" = 3 ] || fail "the other three flags are not all false"

  stage_probe "$NEEDLE" "$RUN_ID"
  printf '%s\n' "$REQUIRE_LINE" >> "$APP/index.js"
  if [ "$(git -C "$TREE" diff --numstat -- "$INDEX_FILE" | cut -f1,2)" != "$(printf '1\t0')" ]; then fail "index.js did not gain exactly one line"; fi

  # Metro from THIS tree, with a cold transform cache.
  (cd "$APP" && exec yarn start --port "$METRO_PORT" --reset-cache > "$OUT/metro.log" 2>&1) &
  METRO_PID=$!
  local up=0 status
  for _ in $(seq 1 180); do
    status="$(curl -s "localhost:$METRO_PORT/status" 2>/dev/null || true)"
    if grep -q 'packager-status:running' <<<"$status"; then up=1; break; fi
    sleep 1
  done
  [ "$up" = 1 ] || fail "Metro did not come up on :$METRO_PORT"

  local served="$OUT/served.js"
  curl -sf --max-time 900 "http://localhost:$METRO_PORT/index.bundle?platform=android&dev=true&minify=false" -o "$served" || fail "could not fetch the served bundle"
  local bundle_bytes bundle_sha
  bundle_bytes="$(wc -c < "$served" | tr -d ' ')"
  bundle_sha="$( (shasum -a 256 "$served" 2>/dev/null || sha256sum "$served") | awk '{print $1}')"
  [ "$(count_occ "$served" "$NEEDLE")" -ge 1 ] || fail "per-run needle is absent from the served bundle (Metro serves another tree or a cache)"
  [ "$(count_occ "$served" '[vcp]')" -ge 1 ] || fail "probe is absent from the served bundle"
  [ "$(count_occ "$served" 'castVote prompt copy must be non-empty')" -ge 1 ] || fail "shipped castVote is absent from the served bundle"
  [ "$(count_occ "$served" 'BallotTemplate')" -ge 1 ] || fail "dist voting builder is absent from the served bundle"
  local f want val flags_report=""
  for f in SEED_REGISTERED_STATE_FIXTURE USE_REAL_ATTESTATION_PRODUCER USE_LOCAL_DB_FACTORY USE_STUB_ATTESTATION_VERIFIER USE_STUB_PLAY_INTEGRITY; do
    case "$f" in
      SEED_REGISTERED_STATE_FIXTURE|USE_REAL_ATTESTATION_PRODUCER) want=true ;;
      *) want=false ;;
    esac
    val="$(flag_served_value "$served" "$f")"
    flags_report="$flags_report $f=$val"
    if [ "$val" != "$want" ]; then fail "served flag $f is '$val', expected '$want'"; fi
  done
  local rn_version rn_minor rn_patch triples
  rn_version="$(node -p "require(require.resolve('react-native/package.json',{paths:['$APP']})).version")"
  rn_minor="$(cut -d. -f2 <<<"$rn_version")"
  rn_patch="$(cut -d. -f3 <<<"$rn_version" | sed -e 's/[^0-9].*//')"
  triples="$(rn_triple_ok "$served" "$rn_minor" "$rn_patch")" || fail "served bundle RN triple(s) '$triples' do not include this tree's react-native $rn_version"
  note "served bundle $bundle_bytes bytes sha256=$bundle_sha needle ok flags ok rn=$rn_version"

  # Install. Uninstall first so a stale vote-record wrap alias cannot survive (63-17 alias policy).
  adb_ uninstall "$PKG" >/dev/null 2>&1 || true
  adb_ install -r -d "$apk" > "$OUT/install.log" 2>&1 || fail "adb install failed"
  adb_ shell run-as "$PKG" id >/dev/null 2>&1 || fail "app is not debuggable (run-as failed)"
  grant_lan

  : > "$OUT/prompts.tsv"
  local rc

  # ---- launch 1 (cast)
  launch cast clear
  pump_until 'snapshot pre-a' 480 1 || fail "launch 1 never reached snapshot pre-a (rc=$?)"
  snapshot a1
  pump_until 'snapshot pre-b' 60 1 || fail "launch 1 never reached snapshot pre-b"
  snapshot a2
  pump_until 'snapshot post' 180 1 || fail "launch 1 never reached snapshot post"
  snapshot b
  rc=0
  pump_until 'phase1-done' 240 1 || rc=$?
  adb_ exec-out screencap -p > "$OUT/launch1.png" 2>/dev/null || true
  [ "$rc" = 0 ] || fail "launch 1 did not finish (rc=$rc); see $OUT/js-1.txt"
  local js1="$OUT/js-1.txt"
  local boot_needle
  boot_needle="$({ grep -o '\[vcp\] boot .*' "$js1" || true; } | head -n 1 | { grep -o 'needle=[^ ]*' || true; } | cut -d= -f2)"
  [ "$boot_needle" = "$NEEDLE" ] || fail "device ran a different bundle (boot needle '$boot_needle')"

  extract_payload "$js1" signed > "$OUT/signed.json"
  local signature sig_rc=0
  signature="$(node -p "JSON.parse(require('fs').readFileSync('$OUT/signed.json','utf8')).signature" 2>/dev/null || true)"
  node "$VERIFIER" --signed "$OUT/signed.json" > "$OUT/verify.txt" 2>&1 || sig_rc=$?

  local needles1
  needles1="$(needles_from_log "$js1")"
  local sweep1_rc=0
  if [ -z "$needles1" ] || [ -z "$signature" ]; then fail "launch 1 logged no needles or no signature; a sweep with no needle would be vacuous"; fi
  # shellcheck disable=SC2086 # needles are validated hex words, split on purpose
  sweep 1 $needles1 $signature || sweep1_rc=$?

  local notsent_status notsent_detail
  if ! listing_same "$OUT/files-a1.txt" "$OUT/files-a2.txt"; then
    notsent_status="INCONCLUSIVE"
    notsent_detail="app writes strand files while idle"
  elif listing_same "$OUT/files-a2.txt" "$OUT/files-b.txt"; then
    notsent_status="PASS"
    notsent_detail="strand file listing unchanged across Submit"
  else
    notsent_status="FAIL"
    notsent_detail="$(diff <(sort "$OUT/files-a2.txt") <(sort "$OUT/files-b.txt") | tr '\n' ';' || true)"
    sweep nsent $needles1 > /dev/null 2>&1 || true
  fi

  # ---- launch 2 (restart, no clear)
  launch restart
  rc=0
  pump_until 'phase2-done' 480 2 || rc=$?
  adb_ exec-out screencap -p > "$OUT/launch2.png" 2>/dev/null || true
  [ "$rc" = 0 ] || fail "launch 2 did not finish (rc=$rc); see $OUT/js-2.txt"
  local js2="$OUT/js-2.txt" needles2 sweep2_rc=0
  needles2="$(needles_from_log "$js2")"
  if [ -z "$needles2" ]; then fail "launch 2 logged no needles; a sweep with no needle would be vacuous"; fi
  # shellcheck disable=SC2086 # validated hex words
  sweep 2 $needles1 $needles2 $signature || sweep2_rc=$?

  # ---- launch 3 (cleared)
  launch cleared clear
  rc=0
  pump_until 'phase3-done' 480 3 || rc=$?
  [ "$rc" = 0 ] || fail "launch 3 did not finish (rc=$rc); see $OUT/js-3.txt"
  local js3="$OUT/js-3.txt" sweep3_rc=0 leaf leaf_hits
  # shellcheck disable=SC2086 # validated hex words
  sweep 3 $needles1 $needles2 $signature || sweep3_rc=$?
  leaf='votetorrent.''voteRecord.'
  # The dev bundle cache in files/ carries the key-prefix literal as source text; it is not storage.
  leaf_hits="$(adb_ shell "run-as $PKG sh -c \"find . -type f ! -name BridgelessReactNativeDevBundle.js -exec grep -la '$leaf' {} + 2>/dev/null\"" | tr -d '\r' | tr '\n' ' ' || true)"

  # ---- legs and verdict
  local legs="$OUT/legs.txt"
  : > "$legs"
  local pass_count=0 name st detail
  emit() { # name PASS|FAIL detail
    echo "LEG $1: $2 ($3)" | tee -a "$legs"
    if [ "$2" = PASS ]; then pass_count=$((pass_count + 1)); fi
  }
  for name in producer-real fixture-real-key; do
    st="$(leg_status "$js1" "$name")"
    emit "$name" "$([ "$st" = PASS ] && echo PASS || echo FAIL)" "in-app=$st"
  done
  if [ "$sig_rc" = 0 ]; then emit signature PASS "verifier exit 0, 4 controls: $(grep -c ' PASS' "$OUT/verify.txt") checks"; else emit signature FAIL "verifier exit $sig_rc, see verify.txt"; fi

  local p_pre p_sub p_now p_later p_guard p_gr p_clr p_btw p_ss mode verdict
  p_pre="$(tally "$OUT/prompts.tsv" preflight)"
  p_sub="$(tally "$OUT/prompts.tsv" submit)"
  p_now="$(tally "$OUT/prompts.tsv" receipt-now)"
  p_later="$(tally "$OUT/prompts.tsv" receipt-later)"
  p_guard="$(tally "$OUT/prompts.tsv" guard)"
  p_gr="$(tally "$OUT/prompts.tsv" guard-restart)"
  p_clr="$(tally "$OUT/prompts.tsv" cleared)"
  p_btw="$(tally_between "$OUT/prompts.tsv")"
  p_ss="$(tally "$OUT/prompts.tsv" stale-submit)"
  mode="$(d14_mode "$p_sub" "$p_now")"
  verdict="$(prompts_verdict "$p_sub" "$p_now" "$p_later" "$p_pre" "$p_guard" "$p_gr" "$p_clr" "$p_btw" "$p_ss")"
  detail="submit=$p_sub receipt-now=$p_now receipt-later=$p_later preflight=$p_pre guard=$p_guard guard-restart=$p_gr cleared=$p_clr between=$p_btw stale-submit=$p_ss d14-mode=$mode"
  case "$verdict" in
    PASS*) emit prompts PASS "$detail" ;;
    *) emit prompts FAIL "$verdict; $detail" ;;
  esac

  local g1 g2 st_persist st_stale st_tamper st_clear st_swjs
  g1="$(leg_status "$js1" guard)"
  g2="$(leg_status "$js2" guard-restart)"
  if [ "$g1" = PASS ] && [ "$g2" = PASS ] && [ "$p_guard" = 0 ] && [ "$p_gr" = 0 ]; then emit guard PASS "guard=$g1 guard-restart=$g2, zero prompts"; else emit guard FAIL "guard=$g1 guard-restart=$g2 prompts=$p_guard/$p_gr"; fi
  st_persist="$(leg_status "$js2" persist)"
  emit persist "$([ "$st_persist" = PASS ] && echo PASS || echo FAIL)" "in-app=$st_persist"
  st_stale="$(leg_status "$js2" stale)"
  emit stale "$([ "$st_stale" = PASS ] && echo PASS || echo FAIL)" "in-app=$st_stale stale-mode=injected-readContext"
  st_swjs="$(leg_status "$js1" sweep-js)"
  if [ "$st_swjs" = PASS ] && [ "$sweep1_rc" = 0 ] && [ "$sweep2_rc" = 0 ] && [ "$sweep3_rc" = 0 ]; then emit sweep PASS "sweep-js and 3 on-device sweeps empty"; else emit sweep FAIL "sweep-js=$st_swjs sweeps=$sweep1_rc/$sweep2_rc/$sweep3_rc"; fi
  st_tamper="$(leg_status "$js1" tamper)"
  emit tamper "$([ "$st_tamper" = PASS ] && echo PASS || echo FAIL)" "in-app=$st_tamper"
  st_clear="$(leg_status "$js3" clear)"
  if [ "$st_clear" = PASS ] && [ -z "${leaf_hits// /}" ]; then emit clear PASS "in-app=$st_clear, record key leaf absent from app files"; else emit clear FAIL "in-app=$st_clear leaf-found-in=${leaf_hits:-nowhere}"; fi
  emit not-sent "$([ "$notsent_status" = PASS ] && echo PASS || echo FAIL)" "$notsent_status: $notsent_detail"

  {
    echo "tree: $TREE"
    echo "head: $head_sha"
    echo "worktree-check: linked ($git_dir differs from $common_dir)"
    echo "apk-sha256: $apk_sha"
    echo "bundle: $bundle_bytes bytes sha256=$bundle_sha"
    echo "needle: $NEEDLE run=$RUN_ID"
    echo "react-native: $rn_version (triples in bundle: $triples)"
    echo "served-flags:$flags_report"
    echo "prompts: $detail"
    echo "d14-mode: $mode (no decision applied; 63-18 applies the R-5 rule)"
    cat "$legs"
  } >> "$OUT/summary.txt"

  if [ "$pass_count" = 11 ]; then
    note "ALL 11 LEGS PASS"
    SCRIPT_EXIT_CODE=0
  else
    note "$pass_count/11 legs PASS; see $legs"
  fi
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

case "${1:-}" in
  --selftest) run_selftest ;;
  --typecheck-probe) run_typecheck_probe ;;
  "") echo "usage: run-vote-casting-proof.sh <abs-outdir> | --selftest | --typecheck-probe" >&2; exit 1 ;;
  *) run_device "$1" ;;
esac
