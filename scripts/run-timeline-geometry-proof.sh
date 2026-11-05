#!/usr/bin/env bash
#
# run-timeline-geometry-proof.sh
#
# Purpose : Phase 61 D-02 Tier-2 on-device geometry proof for the Voter app's election
#           timeline. Measures REAL rendered pixel geometry pulled from a `uiautomator`
#           view-tree dump -- a class of defect (clipped text, duplicate action labels,
#           undersized touch targets) that no Jest `onLayout`-based assertion can see,
#           because `react-test-renderer` never runs a Yoga layout pass. Every rendering
#           claim in this phase has to cite a Tier-2 result, and this script is the
#           Tier-2 surface (D-02).
#
# Usage   : SERIAL=43a209ff0806 LOCALE=en ./scripts/run-timeline-geometry-proof.sh <leg>
#           <leg> one of: clipping | duplicates | touch-targets | all
#           --selftest              host-only, no device required: proves the parser
#                                    against the committed fixtures under
#                                    scripts/lib/__fixtures__/timeline-geometry/, plus the
#                                    records-level cases run_selftest() builds inline.
#                                    IN-01: deliberately NO count here -- this sentence said
#                                    "four" while the set grew to eleven, and run_selftest()
#                                    already cross-checks its own array against that directory
#                                    and prints the real N/N, so a second hand-maintained
#                                    number can only ever be wrong.
#           --dump-records <xml>    host-only, no device required: prints the normalized
#                                    CARD/TEXT/CLICK/ORPHAN record stream for one XML file
#                                    and exits (debugging surface / --selftest internals)
#
# Prereqs : adb on PATH for the device legs (clipping|duplicates|touch-targets|all) --
#           NOT required for --selftest or --dump-records, which read only committed
#           fixtures / a given file. A booted, USB-debug-enabled device running the
#           debug build of org.votetorrent.voter is required for the device legs.
#
#           REQUIRED APP STATE (IN-06) -- the device legs do NOT navigate for you:
#             * the app must already be on the TIMELINE tab,
#             * scrolled to the TOP (collect_records() only ever swipes DOWNWARD),
#             * showing the locale named by LOCALE (the preflight cross-checks the live
#               dump for 'Voting Period' / 'Período de Votación'),
#             * with the votingStarts row reachable.
#           Starting anywhere else fails the locale cross-check below, which historically
#           read like a locale bug when it was really "you are on the wrong screen".
#
# Exit    : 0 -- every selected leg printed LEG <name>: PASS (or --selftest /
#               --dump-records completed successfully)
#           1 -- a preflight failed, any selected leg printed LEG <name>: FAIL, or
#               --selftest / --dump-records failed
#
# Verdict : a DEVICE run prints `LEG <name>: PASS|FAIL (<evidence>)`; --selftest prints
# lines     `SELFTEST-LEG <name>: ...` and `RECORDS-CASE <name>: ...` instead (IN-03). The two
#           are deliberately NOT interchangeable: a healthy --selftest emits many FAIL lines --
#           rejecting a broken fixture is what passing looks like -- and they carry the same
#           `locale=... serial=...` tail a device line does. Cite `LEG ` only for device
#           evidence; a `SELFTEST-LEG ` line proves the instrument, never the product.
#
# Note    : this script emits no ANSI colour codes in its own output. A future CI-style
#           consumer piping `LEG ` lines through a line-anchored parser must not assume a
#           colour-stripping step exists upstream -- this project has hit the
#           FORCE_COLOR=3 trap before on OTHER scripts' jest/tsc output (agent shells set
#           it, defeating naive `^...$` parsers); this script simply never emits ANSI in
#           the first place, so there is nothing to strip.
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PACKAGE="org.votetorrent.voter"
SERIAL="${SERIAL:-43a209ff0806}"   # D-05: the Redmi 8 this phase's device legs are bound to.
ADBD="-s ${SERIAL}"
LOCALE="${LOCALE:-en}"
FIXTURES_DIR="scripts/lib/__fixtures__/timeline-geometry"

# The ten stage ids of the exported `ROW_DISPLAY` map in
# apps/VoteTorrentVoter/src/components/TimelineRow.tsx, in the same order. The preflight must
# positively locate a card anchor for every one.
#
# IN-02: cite the SYMBOL, never a line range. This comment used to say `TimelineRow.tsx:48-59`;
# by the end of the same phase that wrote it, `ROW_DISPLAY` had moved to :57-68 and :48-59 was
# the tail of an unrelated interface. A grep for the symbol survives any edit above it.
EXPECTED_STAGES=(registrationEnds ballotsFinal votingStarts accruingVotes hashingVotes releasingKeys tallyingStarts validation certificationStarts closed)

# D-06: env overrides read from the device when unset; --selftest sets these explicitly so
# fixtures are density- and viewport-deterministic. Declared empty up front so `set -u`
# never trips on a reference before resolve_device_metrics()/--selftest assigns them.
DENSITY_DPI="${DENSITY_DPI:-}"
SCREEN_W="${SCREEN_W:-}"
SCREEN_H="${SCREEN_H:-}"

# D-05: set by preflight() when SERIAL is not the mandated device -- appended to every
# leg's evidence field so a substitution is never silently lost from the transcript.
SERIAL_NOTE=""

TMPDIR_TG="$(mktemp -d)"
# fix(61-03): preserve the real exit code across cleanup -- a bare `rm -rf` here used to
# become the script's final exit status (rm succeeds, so ANY fatal abort earlier in the
# script -- e.g. a `set -u` trip -- silently reported exit 0). The obvious fix
# (`cleanup(){ local rc=$?; rm -rf ...; exit "$rc"; }`) was tried first and empirically
# does NOT work on this repo's bash (3.2, macOS stock): verified live that `$?` as read
# from *inside* an EXIT trap is already 0 by the time the trap body runs when the trap was
# entered via a `set -u` unbound-variable abort specifically (as opposed to an explicit
# `exit N` call, which correctly threads through even without this fix) -- there is no
#"real" nonzero status left to capture at that point on this bash version. Used a
# fail-closed flag instead: default SCRIPT_EXIT_CODE to 1 (failure) up front, and only the
# three genuinely-successful exit points in this file (the two host-only --selftest /
# --dump-records completions and the final all-legs-passed line) flip it to 0 immediately
# before exiting. Any OTHER termination path -- including one this file's author never
# anticipated -- now exits nonzero by construction, which is the correct default for an
# instrument whose whole job is to report failure honestly.
# Found and authorized-fixed under 61-07 (see todos/pending/2026-09-16-timeline-geometry-
# proof-dump-ui-status-unbound-and-exit-masked.md); disclosed separately, not folded into
# 61-07's evidence.
SCRIPT_EXIT_CODE=1
cleanup() { rm -rf "${TMPDIR_TG}"; exit "${SCRIPT_EXIT_CODE}"; }
trap cleanup EXIT

# fix(61-03): DUMP_UI_STATUS ("unobservable" | "ok") is set by dump_ui() below, but every
# call site invokes it as `dump_path=$(dump_ui)` -- a command substitution, i.e. a
# SUBSHELL. Any assignment dump_ui() makes to a plain variable is local to that subshell
# and is discarded the instant the subshell exits; it never reaches the caller's scope.
# Declaring it here does not fix that (each call site must re-read the status explicitly,
# see dump_ui()'s trailing comment and its two call sites), but it does mean an accidental
# early reference fails predictably instead of crashing the whole script under `set -u`.
DUMP_UI_STATUS=""

TAB="$(printf '\t')"

# ---------------------------------------------------------------------------------------
# House-style verdict emitter + failure tracker, lifted verbatim from
# run-authority-signing-ceremony.sh:112-125 -- the exact three-field shape every
# downstream grep in this repo (incl. 61-07) expects.
# ---------------------------------------------------------------------------------------
RESULTS=()

# IN-03: the verdict-line prefix, so a HOST-ONLY --selftest transcript is never mistaken for a
# DEVICE run. A healthy --selftest prints dozens of verdict lines -- many of them FAIL, all of
# them carrying the same `locale=... serial=...` evidence tail a real device run produces --
# because rejecting a broken fixture IS the selftest passing. With one shared prefix,
# `grep -c "LEG clipping: PASS"` could not tell the two apart, and this file's own header warns
# about exactly that class of line-anchored consumer. run_selftest() overrides this to
# SELFTEST-LEG for the whole of its run; the device path keeps the historical `LEG ` prefix
# every 61-07 evidence file and downstream grep already expects.
VERDICT_PREFIX="LEG"

record_leg() {
  local name="$1" verdict="$2" evidence="$3"
  RESULTS+=("${name}|${verdict}|${evidence}")
  echo "${VERDICT_PREFIX} ${name}: ${verdict} (${evidence})"
}

# WR-06 -- FAIL-CLOSED. A leg counts as passing only if its verdict is EXACTLY "PASS".
# Anything else fails the run: "FAIL", "ERROR", an unrecognised token, or an EMPTY verdict
# (what a leg whose awk silently matched nothing produces). The previous form tested for the
# literal "|FAIL|" substring, so every one of those cases exited 0 -- a harness that cannot
# report the failure of its own instrument. An empty RESULTS set (no leg ran at all) is also
# a failure, never a silent success.
any_failed() {
  local r name verdict rest
  if [ "${#RESULTS[@]}" -eq 0 ]; then
    echo "${VERDICT_PREFIX} (none): ERROR (no leg produced a verdict -- refusing to report success)" >&2
    return 0
  fi
  for r in "${RESULTS[@]}"; do
    IFS='|' read -r name verdict rest <<< "${r}"
    if [ "${verdict}" != "PASS" ]; then
      return 0
    fi
  done
  return 1
}

# ---------------------------------------------------------------------------------------
# WR-04: `_find_nondegenerate_bounds` and `_parse_bounds` used to live here, lifted verbatim
# from run-authority-signing-ceremony.sh:431 along with their "Do NOT 'clean up' this regex"
# warning. Nothing in THIS script ever called them -- the record parser resolves degenerate
# bounds inside the awk walker instead (see the content-desc fallback in AWK_WALK_SCRIPT).
# Deleted rather than kept: dead code carrying a do-not-touch warning invites someone to
# "reconcile" it with the LIVE copy, which is the one that actually guards the 49-13 bug
# class. That live copy remains in scripts/run-authority-signing-ceremony.sh, unchanged.

# ---------------------------------------------------------------------------------------
# The awk program driving walk_dump(). Written once to a tmp file at startup rather than
# inlined per-call. Consumes a normalized (one-node-per-line) uiautomator XML dump and
# emits the CARD/TEXT/CLICK/ORPHAN record stream defined in the plan's interface_contract.
# See the design_notes in 61-03-PLAN.md items 1 and 6 for the card/notch resolution and
# MIUI content-desc fallback this implements.
# ---------------------------------------------------------------------------------------
AWK_WALK_SCRIPT="${TMPDIR_TG}/walk_dump.awk"
cat > "${AWK_WALK_SCRIPT}" <<'AWK_PROGRAM'
function attrval(line, name,    re, s, val) {
  re = " " name "=\"[^\"]*\""
  if (!match(line, re)) return ""
  s = substr(line, RSTART + 1, RLENGTH - 1)
  val = substr(s, length(name) + 3, length(s) - length(name) - 3)
  return val
}

function parse_bounds(b, arr,    s, n) {
  if (b !~ /^\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]$/) return 0
  s = b
  gsub(/\[/, " ", s)
  gsub(/\]/, " ", s)
  gsub(/,/, " ", s)
  n = split(s, arr, " ")
  return (n == 4)
}

# IN-06: the value this returns is printed as the LAST field of a TEXT record, and the whole
# record stream's contract is ONE RECORD PER LINE with tab-separated fields (every consumer
# matches on $1 with FS=TAB). So this function must never emit a tab or a newline. It used to
# decode &#10; to a REAL newline, which split a single TEXT record across two lines: the first
# line kept the geometry but carried TRUNCATED text, and the remainder became a free-standing
# line the walker never wrote. Measured against a control copy of clean.xml carrying
# text="Closed 3 days&#10;ago": the stream grew from 10 records to 11, with a bare `ago` line
# wedged between two real records. Worse, the remainder is attacker-shaped rather than merely
# lost -- a control carrying text="Closed&#10;CARD<TAB>closed<TAB>20<TAB>800<TAB>700<TAB>900<TAB>measured"
# FABRICATED a well-formed CARD record for a stage that never rendered, which on the device path
# would satisfy preflight's ten-anchor check and make `anchor-missing` unreachable for it.
# The text is used for display and equality comparison only and is never re-rendered, so
# collapsing separators to a space loses nothing that any leg reads.
function xml_unescape(s) {
  gsub(/&quot;/, "\"", s)
  gsub(/&apos;/, "'", s)
  gsub(/&lt;/, "<", s)
  gsub(/&gt;/, ">", s)
  gsub(/&#10;/, " ", s)
  gsub(/&#13;/, " ", s)
  gsub(/&#9;/, " ", s)
  # Last, so an encoded &amp;#10; cannot be decoded into a separator by the lines above.
  gsub(/&amp;/, "\\&", s)
  # Belt and braces: a RAW tab/newline/CR sitting in the attribute value (legal XML, and not
  # something the entity substitutions above can see) would corrupt the stream the same way.
  gsub(/[\t\n\r]/, " ", s)
  return s
}

BEGIN {
  n_stages = split(stage_list, stages_arr, " ")
  for (i = 1; i <= n_stages; i++) stage_set[stages_arr[i]] = 1
  depth = 0
  card_stage = ""
  card_depth = -1
}

/^[ \t]*<\?/ { next }
/^[ \t]*<!--/ { next }

/^[ \t]*<\// {
  depth--
  if (card_stage != "" && depth <= card_depth) {
    card_stage = ""
    card_depth = -1
  }
  next
}

/^[ \t]*</ {
  line = $0
  is_leaf = (line ~ /\/>[ \t]*$/) ? 1 : 0
  cur_depth = depth

  resid = attrval(line, "resource-id")
  cdesc = attrval(line, "content-desc")
  txt = attrval(line, "text")
  bounds = attrval(line, "bounds")
  clickable = attrval(line, "clickable")

  bounds_at_depth[cur_depth] = bounds
  desc_at_depth[cur_depth] = cdesc

  anchor_id = (resid != "") ? resid : cdesc

  if (anchor_id != "" && index(anchor_id, "timeline-row-") > 0) {
    pos = index(anchor_id, "timeline-row-")
    rest = substr(anchor_id, pos + length("timeline-row-"))
    role_n = split(rest, role_parts, "-")
    role = role_parts[1]
    cand_stage = role_parts[role_n]

    if (role == "notch" && (cand_stage in stage_set)) {
      parent_depth = cur_depth - 1
      # WR-05: field 7 records whether the card rectangle was actually parsed. A card whose
      # parent bounds do not parse used to be emitted as a bare 0/0/0/0 rectangle that read as a
      # legitimate measurement: collect_records() accepted it as "fully visible" (0 >= 0 and
      # 0 <= SCREEN_H), and leg_clipping then compared every text in that card against
      # card_x2 = 0 and reported the first one as "clipped-text". The run failed -- correctly --
      # but named the wrong root cause, which is exactly the discipline the selftest enforces on
      # every other reason. Naming it here lets all three legs report "degenerate-card" instead.
      if (parse_bounds(bounds_at_depth[parent_depth], cb)) {
        printf "CARD\t%s\t%s\t%s\t%s\t%s\t%s\n", cand_stage, cb[1], cb[2], cb[3], cb[4], "measured"
      } else {
        printf "CARD\t%s\t0\t0\t0\t0\t%s\n", cand_stage, "degenerate"
      }
      card_stage = cand_stage
      card_depth = parent_depth
    } else if (role != "notch" && (cand_stage in stage_set)) {
      inside_own_card = (card_stage == cand_stage && cur_depth > card_depth)
      if (!inside_own_card && !(cand_stage in orphan_emitted)) {
        printf "ORPHAN\t%s\n", cand_stage
        orphan_emitted[cand_stage] = 1
      }
    }
  }

  if (card_stage != "" && cur_depth > card_depth) {
    if (parse_bounds(bounds, ownb)) {
      ox1 = ownb[1]; oy1 = ownb[2]; ox2 = ownb[3]; oy2 = ownb[4]
      own_parsed = 1
    } else {
      ox1 = 0; oy1 = 0; ox2 = 0; oy2 = 0
      own_parsed = 0
    }

    if (txt != "") {
      source = "text"
      tx1 = ox1; ty1 = oy1; tx2 = ox2; ty2 = oy2
      is_degenerate = (bounds == "[0,0][0,0]" || !own_parsed)
      if (is_degenerate) {
        found = 0
        for (d = cur_depth - 1; d > card_depth; d--) {
          if (desc_at_depth[d] == txt && bounds_at_depth[d] != "" && bounds_at_depth[d] != "[0,0][0,0]") {
            if (parse_bounds(bounds_at_depth[d], fb)) {
              tx1 = fb[1]; ty1 = fb[2]; tx2 = fb[3]; ty2 = fb[4]
              source = "content-desc-fallback"
              found = 1
              break
            }
          }
        }
        if (!found) {
          source = "degenerate"
          tx1 = 0; ty1 = 0; tx2 = 0; ty2 = 0
        }
      }
      clk = (clickable == "true") ? "yes" : "no"
      utext = xml_unescape(txt)
      printf "TEXT\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", card_stage, tx1, ty1, tx2, ty2, source, clk, utext
    }

    if (clickable == "true") {
      printf "CLICK\t%s\t%s\t%s\t%s\t%s\t%s\n", card_stage, ox1, oy1, ox2, oy2, resid
    }
  }

  if (!is_leaf) depth++
  next
}
AWK_PROGRAM

# walk_dump XML-PATH -- normalizes the dump to one XML element per line and runs it
# through AWK_WALK_SCRIPT, printing the CARD/TEXT/CLICK/ORPHAN stream on stdout.
walk_dump() {
  local xml="$1"
  if [ ! -f "${xml}" ]; then
    echo "walk_dump: no such file: ${xml}" >&2
    return 1
  fi
  local normalized="${TMPDIR_TG}/normalized-$$-${RANDOM}.xml"
  sed 's/></>\n</g' "${xml}" > "${normalized}"
  awk -v stage_list="${EXPECTED_STAGES[*]}" -f "${AWK_WALK_SCRIPT}" "${normalized}"
}

# ---------------------------------------------------------------------------------------
# reconcile_orphans RECORDS-FILE -- rewrites the file in place, dropping every ORPHAN record
# whose stage also has a CARD record ANYWHERE in the same file. See the long rationale at the
# call site in preflight(): collect_records() emits an ORPHAN the first time a single pass sees
# a stage's content without its notch co-resolving IN THAT PASS, which is a routine
# scroll-boundary artifact once a LATER pass captures that stage's CARD.
#
# WR-06: extracted from preflight() so it is reachable from --selftest. This filter is the only
# thing standing between a genuine scroll-boundary observation and a false `anchor-missing`
# FAIL -- and, in the other direction, between a real missing anchor and a silent pass. It can
# only ever REMOVE an ORPHAN for a stage independently proven present by its own CARD record;
# it can never manufacture a CARD record, and a stage with no CARD record in any pass is left
# untouched and continues to fail. The records-level case in run_selftest() pins exactly that.
# ---------------------------------------------------------------------------------------
reconcile_orphans() {
  local records_file="$1"
  local reconciled="${records_file}.reconciled"
  awk -v FS="${TAB}" -v OFS="${TAB}" '
    NR==FNR { if ($1=="CARD") has_card[$2]=1; next }
    $1=="ORPHAN" && ($2 in has_card) { next }
    { print }
  ' "${records_file}" "${records_file}" > "${reconciled}"
  mv "${reconciled}" "${records_file}"
}
# ---------------------------------------------------------------------------------------
# dump_ui -- lifted verbatim from run-authority-signing-ceremony.sh:377-414 (renamed
# TMPDIR_CEREMONY -> TMPDIR_TG). The three-attempt retry loop, the well-formedness check,
# and DUMP_UI_STATUS ("unobservable" | "ok") are D-04(1)'s primitive: an unobservable
# dump is a DIFFERENT failure from an observed [0,0][0,0] node and the two must never be
# conflated.
# ---------------------------------------------------------------------------------------
dump_ui() {
  local out="${TMPDIR_TG}/dump-$$-${RANDOM}.xml"
  local attempt
  local status="unobservable"
  for attempt in 1 2 3; do
    adb ${ADBD} shell rm -f /sdcard/window_dump.xml >/dev/null 2>&1
    adb ${ADBD} shell uiautomator dump /sdcard/window_dump.xml >/dev/null 2>&1
    adb ${ADBD} pull /sdcard/window_dump.xml "${out}" >/dev/null 2>&1 || : > "${out}"
    if [ -s "${out}" ] && grep -q "</hierarchy>" "${out}" 2>/dev/null; then
      status="ok"
      break
    fi
    sleep 1
  done
  # fix(61-03): dump_ui() is always invoked via `dump_path=$(dump_ui)` (a subshell), so a
  # plain `DUMP_UI_STATUS=...` assignment here can never be observed by the caller -- write
  # the status to a file in TMPDIR_TG instead; every call site reads it back explicitly
  # immediately after the substitution (see preflight() and collect_records()).
  echo "${status}" > "${TMPDIR_TG}/dump_ui_status"
  if [ "${status}" = "unobservable" ]; then
    echo "[timeline-geometry] WARNING: dump_ui could not obtain a well-formed uiautomator hierarchy after 3 attempts." >&2
  fi
  echo "${out}"
}

# resolve_device_metrics -- reads DENSITY_DPI / SCREEN_W / SCREEN_H from the device,
# preferring an Override value over the Physical one, honoring any already-set env value
# so --selftest and manual re-analysis stay deterministic (D-06 / design_notes item 4).
resolve_device_metrics() {
  if [ -z "${DENSITY_DPI}" ]; then
    local density_out
    density_out=$(adb ${ADBD} shell wm density 2>/dev/null || true)
    DENSITY_DPI=$(printf '%s\n' "${density_out}" | grep -i "Override density:" | grep -o '[0-9]\+' | tail -1 || true)
    if [ -z "${DENSITY_DPI}" ]; then
      DENSITY_DPI=$(printf '%s\n' "${density_out}" | grep -i "Physical density:" | grep -o '[0-9]\+' | tail -1 || true)
    fi
    if [ -z "${DENSITY_DPI}" ]; then
      echo "PREFLIGHT FAIL: could not parse a density value from 'adb ${ADBD} shell wm density' (got: ${density_out})" >&2
      exit 1
    fi
  fi
  if [ -z "${SCREEN_W}" ] || [ -z "${SCREEN_H}" ]; then
    local size_out line wxh
    size_out=$(adb ${ADBD} shell wm size 2>/dev/null || true)
    line=$(printf '%s\n' "${size_out}" | grep -i "Override size:" | tail -1 || true)
    if [ -z "${line}" ]; then
      line=$(printf '%s\n' "${size_out}" | grep -i "Physical size:" | tail -1 || true)
    fi
    wxh=$(printf '%s' "${line}" | grep -o '[0-9]\+x[0-9]\+' || true)
    if [ -z "${wxh}" ]; then
      echo "PREFLIGHT FAIL: could not parse a screen size from 'adb ${ADBD} shell wm size' (got: ${size_out})" >&2
      exit 1
    fi
    SCREEN_W="${wxh%x*}"
    SCREEN_H="${wxh#*x}"
  fi
}

# ---------------------------------------------------------------------------------------
# preflight -- fails loudly, never proceeds silently (shape from
# run-authority-signing-ceremony.sh:143-150), extended per D-04(1)/D-05/D-06.
#
# Deviation from the plan's narrated step order: the plain LOCALE-format check (originally
# listed as step 4, after the adb device-state check) is run FIRST, before any adb call.
# The plan's own <verification> section requires `LOCALE=fr ... all` to exit 1 naming
# `en`/`es` as a host-verifiable-without-hardware check, which is only possible if this
# check precedes the (necessarily device-dependent) `adb get-state` check -- with no
# device attached, get-state would otherwise fail first and the LOCALE message would
# never be reached. The LOCALE CROSS-CHECK against the live dump (D-06, which does need a
# device) stays in its originally documented position, after device-state/package checks.
# ---------------------------------------------------------------------------------------
preflight() {
  echo "[timeline-geometry] Preflight: LOCALE format ..."
  case "${LOCALE}" in
    en|es) ;;
    *)
      echo "PREFLIGHT FAIL: LOCALE='${LOCALE}' is not accepted -- must be 'en' or 'es'" >&2
      exit 1
      ;;
  esac

  echo "[timeline-geometry] Preflight: adb device state ..."
  local state
  state=$(adb ${ADBD} get-state 2>/dev/null || true)
  if [ "${state}" != "device" ]; then
    echo "PREFLIGHT FAIL: '${SERIAL}' is not in 'device' state (got '${state}') -- is the device connected and authorized? (adb devices)" >&2
    exit 1
  fi

  if [ "${SERIAL}" != "43a209ff0806" ]; then
    echo "PREFLIGHT WARN: SUBSTITUTED DEVICE -- SERIAL=${SERIAL} is not the D-05-mandated Redmi 8 43a209ff0806" >&2
    SERIAL_NOTE="substituted"
  fi

  echo "[timeline-geometry] Preflight: package installed and debuggable ..."
  local pkg_list
  pkg_list=$(adb ${ADBD} shell pm list packages "${PACKAGE}" 2>/dev/null || true)
  if ! printf '%s' "${pkg_list}" | grep -q "${PACKAGE}"; then
    echo "PREFLIGHT FAIL: package ${PACKAGE} is not installed on ${SERIAL}" >&2
    exit 1
  fi
  local debuggable
  debuggable=$(adb ${ADBD} shell dumpsys package "${PACKAGE}" 2>/dev/null | grep -i "flags" | grep -i "DEBUGGABLE" || true)
  if [ -z "${debuggable}" ]; then
    echo "PREFLIGHT FAIL: ${PACKAGE} is not a debuggable build on ${SERIAL} -- a release APK ignores Metro and would measure the wrong tree" >&2
    exit 1
  fi

  echo "[timeline-geometry] Preflight: device metrics ..."
  resolve_device_metrics

  echo "[timeline-geometry] Preflight: locale cross-check ..."
  local dump_path
  dump_path=$(dump_ui)
  # fix(61-03): read the status dump_ui() wrote to TMPDIR_TG -- it cannot be read via a
  # subshell-local DUMP_UI_STATUS assignment (see dump_ui()'s comment).
  DUMP_UI_STATUS="$(cat "${TMPDIR_TG}/dump_ui_status" 2>/dev/null || echo unobservable)"
  if [ "${DUMP_UI_STATUS}" != "ok" ]; then
    echo "PREFLIGHT FAIL: dump-unobservable -- could not obtain a well-formed uiautomator hierarchy for the locale cross-check" >&2
    exit 1
  fi
  local has_en has_es
  has_en=$(grep -c "Voting Period" "${dump_path}" || true)
  has_es=$(grep -c "Período de Votación" "${dump_path}" || true)
  if [ "${LOCALE}" = "en" ] && [ "${has_en}" -eq 0 ]; then
    if [ "${has_es}" -gt 0 ]; then
      echo "PREFLIGHT FAIL: LOCALE=en requested but the dump contains the es marker 'Período de Votación' and not the en marker 'Voting Period' -- the app is rendering es" >&2
    else
      echo "PREFLIGHT FAIL: LOCALE=en requested but NEITHER marker was found ('Voting Period' / 'Período de Votación')." >&2
      echo "  This is usually NOT a locale problem: neither marker appears when the app is not on the Timeline tab," >&2
      echo "  or is scrolled past the Voting Period row. Put the app on the Timeline tab, scrolled to the top, and re-run." >&2
    fi
    exit 1
  fi
  if [ "${LOCALE}" = "es" ] && [ "${has_es}" -eq 0 ]; then
    if [ "${has_en}" -gt 0 ]; then
      echo "PREFLIGHT FAIL: LOCALE=es requested but the dump contains the en marker 'Voting Period' and not the es marker 'Período de Votación' -- the app is rendering en" >&2
    else
      echo "PREFLIGHT FAIL: LOCALE=es requested but NEITHER marker was found ('Período de Votación' / 'Voting Period')." >&2
      echo "  This is usually NOT a locale problem: neither marker appears when the app is not on the Timeline tab," >&2
      echo "  or is scrolled past the Voting Period row. Put the app on the Timeline tab, scrolled to the top, and re-run." >&2
    fi
    exit 1
  fi

  echo "[timeline-geometry] Preflight: node locatability for all ${#EXPECTED_STAGES[@]} stage ids ..."
  ACCUMULATED_RECORDS="${TMPDIR_TG}/accumulated.records"
  : > "${ACCUMULATED_RECORDS}"
  collect_records

  # fix(61-03): reconcile ORPHAN against the accumulated CARD set (authorized third fix,
  # same disclosure/scope discipline as the first two -- 61-07 discovered this against real
  # device output; see todos/pending/2026-09-16-timeline-geometry-proof-dump-ui-status-
  # unbound-and-exit-masked.md). collect_records() appends one ORPHAN record for a stage the
  # FIRST time any single pass observes that stage's title/subtitle/action content without
  # its notch co-resolving IN THAT SAME PASS (e.g. only two cards fit the viewport at once,
  # so a card's tail can be visible a pass before/after its own notch scrolls into frame).
  # That ORPHAN record was never retired even when a DIFFERENT pass in the very same
  # 8-iteration loop captured the stage's CARD (notch + bounds) correctly -- a real, valid
  # observation sitting in the same ACCUMULATED_RECORDS file. A stage with a CARD record
  # from ANY pass has, by definition, had its notch anchor positively resolved at least
  # once; an ORPHAN record for that same stage is then a stale artifact of a different
  # pass's transitional/boundary state, not evidence the anchor never resolves. Drop such
  # stale ORPHAN lines before anything downstream (this preflight check, or any leg) reads
  # the file. This can only ever REMOVE an ORPHAN line for a stage independently proven
  # present via its own CARD record -- it cannot manufacture a CARD record, and a stage
  # that truly has no CARD record in any pass is untouched by this filter and continues to
  # fail (via the "could not locate card anchor" check immediately below, which reads
  # CARD records only and was never affected by this bug) -- exactly the genuine
  # scroll-boundary case that must stay a real, reported failure.
  #
  # WR-06: the awk that does this used to be inlined right here, on the DEVICE-ONLY path --
  # --selftest goes straight from walk_dump() to run_leg() and never calls preflight() or
  # collect_records(), so nothing committed exercised it. A field-index drift ($1 for $2 in
  # either the has_card build or the ORPHAN test) would silently drop EVERY orphan and make
  # `anchor-missing` unreachable on the only path that checks it. It now lives in
  # reconcile_orphans() so the records-level selftest case and this call site run the same code.
  reconcile_orphans "${ACCUMULATED_RECORDS}"

  local missing="" s found_count
  for s in "${EXPECTED_STAGES[@]}"; do
    found_count=$(grep -c "^CARD${TAB}${s}${TAB}" "${ACCUMULATED_RECORDS}" || true)
    if [ "${found_count}" -eq 0 ]; then
      missing="${missing:+${missing},}${s}"
    fi
  done
  if [ -n "${missing}" ]; then
    echo "PREFLIGHT FAIL: could not locate card anchor for stage(s): ${missing}" >&2
    exit 1
  fi

  local orphan_stages
  orphan_stages=$(awk -v FS="${TAB}" '$1=="ORPHAN"{print $2}' "${ACCUMULATED_RECORDS}" | sort -u | paste -sd, - || true)
  if [ -n "${orphan_stages}" ]; then
    echo "PREFLIGHT FAIL: notch anchor did not surface as a resource-id/content-desc for stage(s): ${orphan_stages}" >&2
    exit 1
  fi

  echo "[timeline-geometry] Preflight: PASS (density=${DENSITY_DPI}dpi screen=${SCREEN_W}x${SCREEN_H} locale=${LOCALE} serial=${SERIAL}${SERIAL_NOTE:+ serial_note=${SERIAL_NOTE}})"
}

# ---------------------------------------------------------------------------------------
# collect_records -- the scroll accumulator (design_notes item 5). Loops at most 8
# iterations: dump, walk, and for each CARD record whose rectangle is FULLY inside the
# viewport and whose stage has not yet been recorded, append that stage's full record set
# to ACCUMULATED_RECORDS. Stops early once all ten stages have a fully-visible
# observation, or when two consecutive iterations add no new stage. Keeping only
# fully-visible observations is load-bearing, not an optimization: a partially-scrolled
# card reports vertically truncated bounds and would manufacture a false touch-targets
# FAIL that reads exactly like a real one.
# ---------------------------------------------------------------------------------------
collect_records() {
  local iter=0 max_iter=8 added_any same_count=0 stage_list_seen=""
  while [ "${iter}" -lt "${max_iter}" ]; do
    iter=$((iter + 1))
    local dump_path
    dump_path=$(dump_ui)
    # fix(61-03): see preflight()'s identical comment -- read the status back from the file
    # dump_ui() wrote, not from a subshell-local assignment.
    DUMP_UI_STATUS="$(cat "${TMPDIR_TG}/dump_ui_status" 2>/dev/null || echo unobservable)"
    if [ "${DUMP_UI_STATUS}" != "ok" ]; then
      echo "[timeline-geometry] WARNING: collect_records iteration ${iter}: dump-unobservable, skipping this pass." >&2
      continue
    fi
    local iter_records="${TMPDIR_TG}/iter-${iter}.records"
    walk_dump "${dump_path}" > "${iter_records}"

    added_any=0
    local rtype rstage rx1 ry1 rx2 ry2 rest
    while IFS="${TAB}" read -r rtype rstage rx1 ry1 rx2 ry2 rest; do
      [ "${rtype}" != "CARD" ] && continue
      case ",${stage_list_seen}," in
        *",${rstage},"*) continue ;;
      esac
      if [ "${ry1}" -ge 0 ] && [ "${ry2}" -le "${SCREEN_H}" ]; then
        awk -v FS="${TAB}" -v st="${rstage}" '$2==st' "${iter_records}" >> "${ACCUMULATED_RECORDS}"
        stage_list_seen="${stage_list_seen:+${stage_list_seen},}${rstage}"
        added_any=1
      fi
    done < "${iter_records}"

    local ostage
    for ostage in $(awk -v FS="${TAB}" '$1=="ORPHAN"{print $2}' "${iter_records}" | sort -u); do
      if ! grep -q "^ORPHAN${TAB}${ostage}\$" "${ACCUMULATED_RECORDS}" 2>/dev/null; then
        printf 'ORPHAN%s%s\n' "${TAB}" "${ostage}" >> "${ACCUMULATED_RECORDS}"
      fi
    done

    local seen_count
    seen_count=$(printf '%s' "${stage_list_seen}" | tr ',' '\n' | grep -c . || true)
    if [ "${seen_count}" -ge "${#EXPECTED_STAGES[@]}" ]; then
      break
    fi
    if [ "${added_any}" -eq 0 ]; then
      same_count=$((same_count + 1))
      [ "${same_count}" -ge 2 ] && break
    else
      same_count=0
    fi

    adb ${ADBD} shell input swipe $((SCREEN_W / 2)) $((SCREEN_H * 3 / 4)) $((SCREEN_W / 2)) $((SCREEN_H / 4)) 400 >/dev/null 2>&1 || true
    sleep 1
  done
}

# ---------------------------------------------------------------------------------------
# The three measuring legs (D-03). Each consumes a records FILE (the accumulated
# walk_dump stream), never re-derives geometry itself, and returns its result as a single
# "VERDICT<TAB>EVIDENCE" line on stdout for run_leg() to record. Every evidence string
# ends with " locale=${LOCALE} serial=${SERIAL}" (+ " serial_note=substituted" if D-05
# fired) so the locale and any device substitution are visible in every leg's evidence.
# ---------------------------------------------------------------------------------------

leg_clipping() {
  local records_file="$1"
  awk -v FS="${TAB}" -v locale="${LOCALE}" -v serial="${SERIAL}" -v serial_note="${SERIAL_NOTE}" '
    $1=="CARD" {
      card_x1[$2] = $3; card_y1[$2] = $4; card_x2[$2] = $5; card_y2[$2] = $6; n_cards++
      # WR-05: checked FIRST in END, ahead of anchor-missing. A degenerate CARD still counts as a
      # CARD for the ORPHAN reconciliation, so it suppresses anchor-missing anyway; and every
      # comparison this leg would otherwise make is against a 0/0/0/0 rectangle, which
      # manufactures a bogus clipped-text verdict. Name the card, not its symptom.
      if ($7=="degenerate" && deg_card=="") deg_card=$2
    }
    $1=="ORPHAN" { orphan_list = (orphan_list=="") ? $2 : orphan_list","$2 }
    $1=="TEXT" {
      stage=$2; x1=$3; y1=$4; x2=$5; y2=$6; source=$7; text=$9
      if (source=="degenerate" && deg_stage=="") { deg_stage=stage; deg_text=text }
      # CR-02: a "content-desc-fallback" record carries the nearest ANCESTOR-with-a-matching-
      # content-desc rectangle, not the rectangle of the text node itself -- the walker
      # substitutes it so a zero-size node stays LOCATABLE (which is what the containment test in
      # leg_duplicates and leg_touch_targets legitimately need). It is useless for THIS leg: that
      # substituted ancestor is the
      # touchable, Yoga keeps the touchable inside the card by construction, so comparing it
      # against the card is unfalsifiable. Such a node was previously counted in count_text and
      # compared like a measured one, so it could only ever push this leg toward "N text node(s)
      # measured -- PASS" while witnessing nothing. Count it separately, keep it OUT of the
      # clipped-text comparison (so "clipped-text" always means a genuinely measured text rect
      # overflowed), and refuse to certify the leg while any exist -- the same discipline
      # "no-measurement" already applies to zero evidence.
      if (source=="content-desc-fallback") {
        count_unmeasurable++
        if (unmeas_stage=="") { unmeas_stage=stage; unmeas_text=text }
        next
      }
      count_text++
      # WR-07: test ALL FOUR edges. This compared only the right edge, so a node overflowing the
      # left or (since 61-08 C1/C2 added 16px of height per current row) the bottom was invisible.
      if (clip_stage=="" && (stage in card_x2)) {
        edge=""
        if (x2+0 > card_x2[stage]+0)      { edge="right";  attr="x2"; tv=x2; cv=card_x2[stage] }
        else if (x1+0 < card_x1[stage]+0) { edge="left";   attr="x1"; tv=x1; cv=card_x1[stage] }
        else if (y2+0 > card_y2[stage]+0) { edge="bottom"; attr="y2"; tv=y2; cv=card_y2[stage] }
        else if (y1+0 < card_y1[stage]+0) { edge="top";    attr="y1"; tv=y1; cv=card_y1[stage] }
        if (edge != "") {
          clip_stage=stage; clip_text=text; clip_edge=edge; clip_attr=attr; clip_tv=tv; clip_cv=cv
        }
      }
    }
    END {
      note = (serial_note=="substituted") ? " serial_note=substituted" : ""
      if (deg_card != "") {
        printf "FAIL\tdegenerate-card: stage=%s (card bounds did not parse -- every comparison against this card is meaningless) locale=%s serial=%s%s\n", deg_card, locale, serial, note
      } else if (orphan_list != "") {
        printf "FAIL\tanchor-missing: %s locale=%s serial=%s%s\n", orphan_list, locale, serial, note
      } else if (deg_stage != "") {
        printf "FAIL\tdegenerate-bounds: stage=%s text=\"%s\" locale=%s serial=%s%s\n", deg_stage, deg_text, locale, serial, note
      } else if (clip_stage != "") {
        printf "FAIL\tclipped-text: stage=%s text=\"%s\" edge=%s text.%s=%s card.%s=%s locale=%s serial=%s%s\n", clip_stage, clip_text, clip_edge, clip_attr, clip_tv, clip_attr, clip_cv, locale, serial, note
      } else if (unmeas_stage != "") {
        # CR-02: zero-size text nodes resolved through the content-desc fallback carry the
        # touchable ancestor rectangle, so no amount of glyph overrun inside that touchable can
        # ever produce a verdict for them. Reporting PASS while they are present certifies
        # evidence this leg does not have -- and the phase cites this leg (via
        # TimelineRow.test.tsx) as the ONLY tier that can see action-label clipping. Name them.
        printf "FAIL\tunmeasurable-text: %d text node(s) resolved via content-desc-fallback (ancestor rect substituted -- cannot witness glyph overrun); first: stage=%s text=\"%s\" locale=%s serial=%s%s\n", count_unmeasurable+0, unmeas_stage, unmeas_text, locale, serial, note
      } else if (count_text+0 == 0) {
        # WR-06: zero measured nodes is NOT a pass. The cards resolved but nothing inside them
        # did -- the shape a parser regression takes. Reporting PASS here is a gate certifying
        # its own blindness.
        printf "FAIL\tno-measurement: 0 text node(s) measured inside %d resolved card(s) locale=%s serial=%s%s\n", n_cards+0, locale, serial, note
      } else {
        printf "PASS\tclean: %d text node(s) measured locale=%s serial=%s%s\n", count_text, locale, serial, note
      }
    }
  ' "${records_file}"
}

leg_duplicates() {
  local records_file="$1"
  awk -v FS="${TAB}" -v locale="${LOCALE}" -v serial="${SERIAL}" -v serial_note="${SERIAL_NOTE}" '
    # WR-05: see leg_clipping -- a card whose own rectangle did not parse must be named as such
    # by every leg, not left to surface as some downstream symptom.
    $1=="CARD" && $7=="degenerate" && deg_card=="" { deg_card=$2 }
    $1=="ORPHAN" { orphan_list = (orphan_list=="") ? $2 : orphan_list","$2 }
    $1=="TEXT" {
      n++; t_stage[n]=$2; t_x1[n]=$3; t_y1[n]=$4; t_x2[n]=$5; t_y2[n]=$6; t_source[n]=$7; t_click[n]=$8; t_text[n]=$9
      if ($7=="degenerate" && deg_stage=="") { deg_stage=$2; deg_text=$9 }
    }
    $1=="CLICK" {
      m++; c_stage[m]=$2; c_x1[m]=$3; c_y1[m]=$4; c_x2[m]=$5; c_y2[m]=$6
    }
    END {
      note = (serial_note=="substituted") ? " serial_note=substituted" : ""
      if (deg_card != "") {
        printf "FAIL\tdegenerate-card: stage=%s (card bounds did not parse -- every comparison against this card is meaningless) locale=%s serial=%s%s\n", deg_card, locale, serial, note
        exit
      }
      if (orphan_list != "") {
        printf "FAIL\tanchor-missing: %s locale=%s serial=%s%s\n", orphan_list, locale, serial, note
        exit
      }
      if (deg_stage != "") {
        printf "FAIL\tdegenerate-bounds: stage=%s text=\"%s\" locale=%s serial=%s%s\n", deg_stage, deg_text, locale, serial, note
        exit
      }
      for (i = 1; i <= n; i++) {
        eligible = (t_click[i] == "yes")
        if (!eligible) {
          for (j = 1; j <= m; j++) {
            if (c_stage[j] == t_stage[i] && t_x1[i]+0 >= c_x1[j]+0 && t_y1[i]+0 >= c_y1[j]+0 && t_x2[i]+0 <= c_x2[j]+0 && t_y2[i]+0 <= c_y2[j]+0) {
              eligible = 1
              break
            }
          }
        }
        if (!eligible) continue
        key = t_stage[i] SUBSEP t_text[i]
        seen_count[key]++
        seen_stage[key] = t_stage[i]
        seen_text[key] = t_text[i]
      }
      for (key in seen_count) {
        if (seen_count[key] > 1 && dup_stage == "") { dup_stage = seen_stage[key]; dup_text = seen_text[key] }
      }
      if (dup_stage != "") {
        printf "FAIL\tduplicate-label: stage=%s text=\"%s\" locale=%s serial=%s%s\n", dup_stage, dup_text, locale, serial, note
      } else if (n+0 == 0) {
        # WR-06: "no duplicates found" among ZERO candidates is vacuous, not a pass.
        printf "FAIL\tno-measurement: 0 text node(s) available to compare locale=%s serial=%s%s\n", locale, serial, note
      } else {
        printf "PASS\tno duplicate action labels locale=%s serial=%s%s\n", locale, serial, note
      }
    }
  ' "${records_file}"
}

leg_touch_targets() {
  local records_file="$1"
  local threshold_px=$((44 * DENSITY_DPI / 160))
  awk -v FS="${TAB}" -v locale="${LOCALE}" -v serial="${SERIAL}" -v serial_note="${SERIAL_NOTE}" -v thr="${threshold_px}" -v density="${DENSITY_DPI}" '
    # WR-05: see leg_clipping -- a card whose own rectangle did not parse must be named as such
    # by every leg, not left to surface as some downstream symptom.
    $1=="CARD" && $7=="degenerate" && deg_card=="" { deg_card=$2 }
    $1=="ORPHAN" { orphan_list = (orphan_list=="") ? $2 : orphan_list","$2 }
    $1=="TEXT" && $7=="degenerate" && deg_stage=="" { deg_stage=$2; deg_text=$9 }
    $1=="CLICK" {
      count++
      stage=$2; x1=$3; y1=$4; x2=$5; y2=$6; rid=$7
      w = x2 - x1; h = y2 - y1
      if ((w < thr || h < thr) && bad_stage == "") { bad_stage=stage; bad_rid=rid; bad_w=w; bad_h=h }
    }
    END {
      note = (serial_note=="substituted") ? " serial_note=substituted" : ""
      if (deg_card != "") {
        printf "FAIL\tdegenerate-card: stage=%s (card bounds did not parse -- every comparison against this card is meaningless) locale=%s serial=%s%s\n", deg_card, locale, serial, note
        exit
      }
      if (orphan_list != "") {
        printf "FAIL\tanchor-missing: %s locale=%s serial=%s%s\n", orphan_list, locale, serial, note
        exit
      }
      if (deg_stage != "") {
        printf "FAIL\tdegenerate-bounds: stage=%s text=\"%s\" locale=%s serial=%s%s\n", deg_stage, deg_text, locale, serial, note
        exit
      }
      if (bad_stage != "") {
        printf "FAIL\tundersized-target: stage=%s resource-id=%s measured=%dx%dpx threshold=%dpx(44dp@%ddpi) locale=%s serial=%s%s\n", bad_stage, bad_rid, bad_w, bad_h, thr, density, locale, serial, note
      } else if (count+0 == 0) {
        # WR-06: "all targets are large enough" across ZERO targets is vacuous, not a pass.
        printf "FAIL\tno-measurement: 0 touch target(s) measured locale=%s serial=%s%s\n", locale, serial, note
      } else {
        printf "PASS\t%d touch target(s) measured, all >= %dpx (44dp@%ddpi) locale=%s serial=%s%s\n", count+0, thr, density, locale, serial, note
      }
    }
  ' "${records_file}"
}

# run_leg NAME RECORDS-FILE -- dispatches to the named leg function, records the result
# via record_leg() (prints "LEG name: VERDICT (evidence)"), and exposes LAST_VERDICT /
# LAST_EVIDENCE for callers (run_selftest) that need to inspect the outcome.
LAST_VERDICT=""
LAST_EVIDENCE=""
run_leg() {
  local name="$1" records_file="$2"
  local out="" rc=0
  case "${name}" in
    clipping) out=$(leg_clipping "${records_file}") || rc=$? ;;
    duplicates) out=$(leg_duplicates "${records_file}") || rc=$? ;;
    touch-targets) out=$(leg_touch_targets "${records_file}") || rc=$? ;;
    *)
      echo "run_leg: unknown leg '${name}'" >&2
      return 1
      ;;
  esac

  # WR-06: a leg whose awk died, or that printed nothing at all, has NOT passed -- it failed to
  # measure. Record it as ERROR so the fail-closed any_failed() below trips on it.
  if [ "${rc}" -ne 0 ] || [ -z "${out}" ]; then
    LAST_VERDICT="ERROR"
    LAST_EVIDENCE="leg produced no verdict line (exit=${rc}) locale=${LOCALE} serial=${SERIAL}"
    record_leg "${name}" "${LAST_VERDICT}" "${LAST_EVIDENCE}"
    return 0
  fi

  LAST_VERDICT="${out%%${TAB}*}"
  LAST_EVIDENCE="${out#*${TAB}}"

  # WR-06: only PASS and FAIL are legal verdict tokens. Anything else means the leg's own
  # printf drifted from this contract; treat it as ERROR rather than letting it read as a pass.
  case "${LAST_VERDICT}" in
    PASS|FAIL) ;;
    *)
      LAST_EVIDENCE="unrecognised verdict token '"'"'${LAST_VERDICT}'"'"' in leg output: ${out}"
      LAST_VERDICT="ERROR"
      ;;
  esac

  record_leg "${name}" "${LAST_VERDICT}" "${LAST_EVIDENCE}"
}

# ---------------------------------------------------------------------------------------
# run_selftest -- D-04(3). Host-only, no device. Sets DENSITY_DPI/SCREEN_W/SCREEN_H so the
# committed fixtures are deterministic, runs all three legs against each, and asserts
# each rejection fixture is rejected FOR ITS OWN NAMED REASON (and that the other two
# reasons are NOT named), plus leg isolation (a single-defect fixture trips exactly one
# leg). Adapted from assert-voter-gates.mjs's --selftest idiom (lines 503-653), not ported.
# ---------------------------------------------------------------------------------------
run_selftest() {
  echo "[timeline-geometry] ========== --selftest =========="
  DENSITY_DPI=320
  SCREEN_W=720
  SCREEN_H=1520
  # IN-03: every verdict line below is a HOST-ONLY fixture result, not a device measurement, and
  # most of the FAIL ones are the selftest working correctly. Prefix them distinctly so no
  # line-anchored consumer can count a selftest transcript as device evidence. run_selftest()
  # always exits before returning, so this never leaks back into a device run.
  VERDICT_PREFIX="SELFTEST-LEG"

  local mismatches=0
  local f
  # Non-fixture checks that also increment `mismatches`: the fixture-list drift check plus the
  # two records-level cases below. Named here so the FAIL summary can never drift from how many
  # of them there actually are (the previous form hard-coded the number in the message).
  local NON_FIXTURE_CHECKS=3
  # WR-06/W-1: fixture list is an array so the summary count below cannot drift from it.
  local fixtures=(clean clipped degenerate missing-node no-measurement duplicate undersized clipped-left clipped-vertical unmeasurable-fallback degenerate-card)
  local total="${#fixtures[@]}"

  # CR-01: the fixture ARRAY and the fixtures on DISK must be the same set. A file on disk that
  # the array never names is simply unexercised; a name in the array with no `case` arm below is
  # worse -- it runs all three legs, asserts nothing, and is still counted toward the "N/N
  # fixtures behaved as specified" line this selftest is cited for. Compare the two sets up front
  # so neither direction of drift can inflate that count silently. (The per-name "no assertion
  # arm exists" default arm at the bottom of the `case` closes the second hole directly.)
  local on_disk expected
  on_disk=$(find "${FIXTURES_DIR}" -maxdepth 1 -name '*.xml' -exec basename {} .xml \; 2>/dev/null | sort | paste -sd, - || true)
  expected=$(printf '%s\n' "${fixtures[@]}" | sort | paste -sd, - || true)
  if [ "${on_disk}" != "${expected}" ]; then
    echo "SELFTEST MISMATCH: fixture list drifted -- array=[${expected}] disk=[${on_disk}]"
    mismatches=$((mismatches + 1))
  fi

  for f in "${fixtures[@]}"; do
    local xml="${FIXTURES_DIR}/${f}.xml"
    if [ ! -f "${xml}" ]; then
      echo "SELFTEST MISMATCH: ${f} -- fixture file missing: ${xml}"
      mismatches=$((mismatches + 1))
      continue
    fi

    local records="${TMPDIR_TG}/selftest-${f}.records"
    if ! walk_dump "${xml}" > "${records}" 2>"${TMPDIR_TG}/selftest-${f}.err"; then
      echo "SELFTEST MISMATCH: ${f} -- walk_dump failed: $(cat "${TMPDIR_TG}/selftest-${f}.err")"
      mismatches=$((mismatches + 1))
      continue
    fi

    echo "[timeline-geometry] -- fixture: ${f} --"
    run_leg "clipping" "${records}"
    local clip_verdict="${LAST_VERDICT}" clip_evidence="${LAST_EVIDENCE}"
    run_leg "duplicates" "${records}"
    local dup_verdict="${LAST_VERDICT}" dup_evidence="${LAST_EVIDENCE}"
    run_leg "touch-targets" "${records}"
    local tt_verdict="${LAST_VERDICT}" tt_evidence="${LAST_EVIDENCE}"

    local ok=1
    case "${f}" in
      clean)
        if [ "${clip_verdict}" != "PASS" ]; then
          echo "SELFTEST MISMATCH: clean -- expected clipping PASS, got ${clip_verdict} (${clip_evidence})"
          ok=0
        fi
        if [ "${dup_verdict}" != "PASS" ]; then
          echo "SELFTEST MISMATCH: clean -- expected duplicates PASS, got ${dup_verdict} (${dup_evidence})"
          ok=0
        fi
        if [ "${tt_verdict}" != "PASS" ]; then
          echo "SELFTEST MISMATCH: clean -- expected touch-targets PASS, got ${tt_verdict} (${tt_evidence})"
          ok=0
        fi
        ;;
      clipped)
        if [ "${clip_verdict}" != "FAIL" ] || [[ "${clip_evidence}" != *"clipped-text"* ]]; then
          echo "SELFTEST MISMATCH: clipped -- expected clipping FAIL naming clipped-text, got ${clip_verdict} (${clip_evidence})"
          ok=0
        fi
        if [[ "${clip_evidence}" == *"degenerate-bounds"* || "${clip_evidence}" == *"anchor-missing"* ]]; then
          echo "SELFTEST MISMATCH: clipped -- clipping evidence named a reason other than its own: ${clip_evidence}"
          ok=0
        fi
        if [ "${dup_verdict}" != "PASS" ]; then
          echo "SELFTEST MISMATCH: clipped -- expected duplicates PASS (leg isolation), got ${dup_verdict} (${dup_evidence})"
          ok=0
        fi
        if [ "${tt_verdict}" != "PASS" ]; then
          echo "SELFTEST MISMATCH: clipped -- expected touch-targets PASS (leg isolation), got ${tt_verdict} (${tt_evidence})"
          ok=0
        fi
        ;;
      degenerate)
        if [ "${clip_verdict}" != "FAIL" ] || [[ "${clip_evidence}" != *"degenerate-bounds"* ]]; then
          echo "SELFTEST MISMATCH: degenerate -- expected clipping FAIL naming degenerate-bounds, got ${clip_verdict} (${clip_evidence})"
          ok=0
        fi
        if [[ "${clip_evidence}" == *"clipped-text"* || "${clip_evidence}" == *"anchor-missing"* ]]; then
          echo "SELFTEST MISMATCH: degenerate -- clipping evidence named a reason other than its own: ${clip_evidence}"
          ok=0
        fi
        ;;
      missing-node)
        if [ "${clip_verdict}" != "FAIL" ] || [[ "${clip_evidence}" != *"anchor-missing"* ]]; then
          echo "SELFTEST MISMATCH: missing-node -- expected clipping FAIL naming anchor-missing, got ${clip_verdict} (${clip_evidence})"
          ok=0
        fi
        if [[ "${clip_evidence}" == *"clipped-text"* || "${clip_evidence}" == *"degenerate-bounds"* ]]; then
          echo "SELFTEST MISMATCH: missing-node -- clipping evidence named a reason other than its own: ${clip_evidence}"
          ok=0
        fi
        ;;
      no-measurement)
        # WR-06: the cards resolve but nothing inside them does. A gate that measured zero
        # nodes must never report success -- ALL THREE legs must FAIL for their own
        # `no-measurement` reason, not fall through to a PASS on an empty count.
        if [ "${clip_verdict}" != "FAIL" ] || [[ "${clip_evidence}" != *"no-measurement"* ]]; then
          echo "SELFTEST MISMATCH: no-measurement -- expected clipping FAIL naming no-measurement, got ${clip_verdict} (${clip_evidence})"
          ok=0
        fi
        if [ "${dup_verdict}" != "FAIL" ] || [[ "${dup_evidence}" != *"no-measurement"* ]]; then
          echo "SELFTEST MISMATCH: no-measurement -- expected duplicates FAIL naming no-measurement, got ${dup_verdict} (${dup_evidence})"
          ok=0
        fi
        if [ "${tt_verdict}" != "FAIL" ] || [[ "${tt_evidence}" != *"no-measurement"* ]]; then
          echo "SELFTEST MISMATCH: no-measurement -- expected touch-targets FAIL naming no-measurement, got ${tt_verdict} (${tt_evidence})"
          ok=0
        fi
        if [[ "${clip_evidence}" == *"clipped-text"* || "${clip_evidence}" == *"anchor-missing"* || "${clip_evidence}" == *"degenerate-bounds"* ]]; then
          echo "SELFTEST MISMATCH: no-measurement -- clipping evidence named a reason other than its own: ${clip_evidence}"
          ok=0
        fi
        ;;
      duplicate)
        # W-1: the duplicates leg maps to D1, this phase's flagship defect. Before this fixture
        # existed, `duplicate-label` appeared at exactly one site in the repo -- its own printf --
        # and had never been observed firing against anything committed.
        if [ "${dup_verdict}" != "FAIL" ] || [[ "${dup_evidence}" != *"duplicate-label"* ]]; then
          echo "SELFTEST MISMATCH: duplicate -- expected duplicates FAIL naming duplicate-label, got ${dup_verdict} (${dup_evidence})"
          ok=0
        fi
        if [[ "${dup_evidence}" == *"anchor-missing"* || "${dup_evidence}" == *"degenerate-bounds"* || "${dup_evidence}" == *"no-measurement"* ]]; then
          echo "SELFTEST MISMATCH: duplicate -- duplicates evidence named a reason other than its own: ${dup_evidence}"
          ok=0
        fi
        if [ "${clip_verdict}" != "PASS" ]; then
          echo "SELFTEST MISMATCH: duplicate -- expected clipping PASS (leg isolation), got ${clip_verdict} (${clip_evidence})"
          ok=0
        fi
        if [ "${tt_verdict}" != "PASS" ]; then
          echo "SELFTEST MISMATCH: duplicate -- expected touch-targets PASS (leg isolation), got ${tt_verdict} (${tt_evidence})"
          ok=0
        fi
        ;;
      clipped-left|clipped-vertical)
        # WR-07: leg_clipping compared only text.x2 > card.x2, so a node overflowing the LEFT or
        # the BOTTOM of its card was invisible. Vertical matters now that 61-08's C1/C2 added 16px
        # of height per current row.
        if [ "${clip_verdict}" != "FAIL" ] || [[ "${clip_evidence}" != *"clipped-text"* ]]; then
          echo "SELFTEST MISMATCH: ${f} -- expected clipping FAIL naming clipped-text, got ${clip_verdict} (${clip_evidence})"
          ok=0
        fi
        if [[ "${clip_evidence}" == *"anchor-missing"* || "${clip_evidence}" == *"degenerate-bounds"* || "${clip_evidence}" == *"no-measurement"* ]]; then
          echo "SELFTEST MISMATCH: ${f} -- clipping evidence named a reason other than its own: ${clip_evidence}"
          ok=0
        fi
        if [ "${dup_verdict}" != "PASS" ]; then
          echo "SELFTEST MISMATCH: ${f} -- expected duplicates PASS (leg isolation), got ${dup_verdict} (${dup_evidence})"
          ok=0
        fi
        if [ "${tt_verdict}" != "PASS" ]; then
          echo "SELFTEST MISMATCH: ${f} -- expected touch-targets PASS (leg isolation), got ${tt_verdict} (${tt_evidence})"
          ok=0
        fi
        ;;
      undersized)
        # W-1: same gap for `undersized-target` -- one printf, never observed firing.
        if [ "${tt_verdict}" != "FAIL" ] || [[ "${tt_evidence}" != *"undersized-target"* ]]; then
          echo "SELFTEST MISMATCH: undersized -- expected touch-targets FAIL naming undersized-target, got ${tt_verdict} (${tt_evidence})"
          ok=0
        fi
        if [[ "${tt_evidence}" == *"anchor-missing"* || "${tt_evidence}" == *"degenerate-bounds"* || "${tt_evidence}" == *"no-measurement"* ]]; then
          echo "SELFTEST MISMATCH: undersized -- touch-targets evidence named a reason other than its own: ${tt_evidence}"
          ok=0
        fi
        if [ "${clip_verdict}" != "PASS" ]; then
          echo "SELFTEST MISMATCH: undersized -- expected clipping PASS (leg isolation), got ${clip_verdict} (${clip_evidence})"
          ok=0
        fi
        if [ "${dup_verdict}" != "PASS" ]; then
          echo "SELFTEST MISMATCH: undersized -- expected duplicates PASS (leg isolation), got ${dup_verdict} (${dup_evidence})"
          ok=0
        fi
        ;;
      unmeasurable-fallback)
        # CR-02: a text node whose own rectangle is zero-size resolves through the content-desc
        # fallback, which substitutes the touchable ANCESTOR's rect. Yoga keeps that touchable
        # inside the card by construction, so the clipping comparison against the card was
        # unfalsifiable for the whole class -- and the leg reported PASS, counting the node among
        # the "N text node(s) measured". This fixture pins both halves of the fix: the clipping
        # leg refuses to certify (FAIL naming unmeasurable-text), while duplicates and
        # touch-targets still PASS -- which is the proof that the fallback is intact for the
        # locatability the other two legs legitimately need (without it, the node would resolve
        # as `degenerate` and all three legs would fail for the wrong reason).
        if [ "${clip_verdict}" != "FAIL" ] || [[ "${clip_evidence}" != *"unmeasurable-text"* ]]; then
          echo "SELFTEST MISMATCH: unmeasurable-fallback -- expected clipping FAIL naming unmeasurable-text, got ${clip_verdict} (${clip_evidence})"
          ok=0
        fi
        if [[ "${clip_evidence}" == *"clipped-text"* || "${clip_evidence}" == *"anchor-missing"* || "${clip_evidence}" == *"degenerate-bounds"* || "${clip_evidence}" == *"no-measurement"* ]]; then
          echo "SELFTEST MISMATCH: unmeasurable-fallback -- clipping evidence named a reason other than its own: ${clip_evidence}"
          ok=0
        fi
        if [ "${dup_verdict}" != "PASS" ]; then
          echo "SELFTEST MISMATCH: unmeasurable-fallback -- expected duplicates PASS (the fallback must still LOCATE the node), got ${dup_verdict} (${dup_evidence})"
          ok=0
        fi
        if [ "${tt_verdict}" != "PASS" ]; then
          echo "SELFTEST MISMATCH: unmeasurable-fallback -- expected touch-targets PASS (the fallback must still LOCATE the node), got ${tt_verdict} (${tt_evidence})"
          ok=0
        fi
        ;;
      degenerate-card)
        # WR-05: the notch resolves, the card ViewGroup's bounds do not parse. The run always
        # failed (fail-closed, good) but named `clipped-text` -- because leg_clipping compared
        # every text against the 0/0/0/0 card rectangle -- which is the wrong root cause, and no
        # fixture covered a degenerate CARD at all. All three legs must now name it.
        if [ "${clip_verdict}" != "FAIL" ] || [[ "${clip_evidence}" != *"degenerate-card"* ]]; then
          echo "SELFTEST MISMATCH: degenerate-card -- expected clipping FAIL naming degenerate-card, got ${clip_verdict} (${clip_evidence})"
          ok=0
        fi
        if [ "${dup_verdict}" != "FAIL" ] || [[ "${dup_evidence}" != *"degenerate-card"* ]]; then
          echo "SELFTEST MISMATCH: degenerate-card -- expected duplicates FAIL naming degenerate-card, got ${dup_verdict} (${dup_evidence})"
          ok=0
        fi
        if [ "${tt_verdict}" != "FAIL" ] || [[ "${tt_evidence}" != *"degenerate-card"* ]]; then
          echo "SELFTEST MISMATCH: degenerate-card -- expected touch-targets FAIL naming degenerate-card, got ${tt_verdict} (${tt_evidence})"
          ok=0
        fi
        # `degenerate-bounds` is a substring-safe negative here only because the reason token is
        # `degenerate-card`; both are checked explicitly against the other three reasons.
        if [[ "${clip_evidence}" == *"clipped-text"* || "${clip_evidence}" == *"anchor-missing"* || "${clip_evidence}" == *"degenerate-bounds"* || "${clip_evidence}" == *"no-measurement"* ]]; then
          echo "SELFTEST MISMATCH: degenerate-card -- clipping evidence named a reason other than its own: ${clip_evidence}"
          ok=0
        fi
        ;;
      *)
        # CR-01 -- FAIL-CLOSED. Before this arm existed, a fixture name in the `fixtures` array
        # that matched none of the arms above ran all three legs, asserted NOTHING, left `ok` at
        # its initial 1, and was counted as "behaved as specified" -- proven empirically by adding
        # a byte-copy of the deliberately-broken clipped.xml under a new name: the clipping leg
        # printed FAIL and the summary still read "SELFTEST: PASS (10/10 ...)", exit 0. That is a
        # gate that cannot fail, inside the one file every other rendering claim in this phase
        # cites. A fixture with no assertion arm is now a mismatch, never a silent pass.
        echo "SELFTEST MISMATCH: ${f} -- no assertion arm exists for this fixture name; refusing to count it as specified"
        ok=0
        ;;
    esac

    [ "${ok}" -eq 0 ] && mismatches=$((mismatches + 1))
  done

  # WR-06: records-level case -- device-free coverage for reconcile_orphans(), the one piece of
  # the preflight path the XML fixture loop above can never reach (--selftest goes straight from
  # walk_dump() to run_leg(); it never calls preflight() or collect_records()). That filter is
  # the only thing standing between a genuine scroll-boundary observation and a false
  # `anchor-missing` FAIL -- and, in the other direction, between a real missing anchor and a
  # silent pass. A field-index drift inside it ($1 for $2 in either the has_card build or the
  # ORPHAN test) would drop EVERY orphan and make `anchor-missing` unreachable on the device
  # path, where preflight() is the only place ORPHANs are ever checked. Feed it a fixed records
  # file and assert BOTH directions: the orphan that has its own CARD is retired, the orphan
  # that does not is kept, and the CARD itself is untouched.
  echo "[timeline-geometry] -- records case: orphan-reconciliation --"
  local recfile="${TMPDIR_TG}/selftest-reconcile.records"
  {
    printf 'CARD\tvotingStarts\t20\t420\t700\t720\tmeasured\n'
    printf 'ORPHAN\tvotingStarts\n'
    printf 'ORPHAN\tclosed\n'
  } > "${recfile}"
  reconcile_orphans "${recfile}"
  local rc_ok=1 surviving_orphans surviving_cards
  surviving_orphans=$(awk -v FS="${TAB}" '$1=="ORPHAN"{print $2}' "${recfile}" | sort | paste -sd, - || true)
  surviving_cards=$(awk -v FS="${TAB}" '$1=="CARD"{print $2}' "${recfile}" | sort | paste -sd, - || true)
  if [ "${surviving_orphans}" != "closed" ]; then
    echo "SELFTEST MISMATCH: orphan-reconciliation -- expected exactly [closed] to survive (votingStarts has its own CARD record, closed does not), got [${surviving_orphans}]"
    rc_ok=0
  fi
  if [ "${surviving_cards}" != "votingStarts" ]; then
    echo "SELFTEST MISMATCH: orphan-reconciliation -- the CARD record must pass through untouched, got [${surviving_cards}]"
    rc_ok=0
  fi
  if [ "${rc_ok}" -eq 0 ]; then
    mismatches=$((mismatches + 1))
  else
    echo "RECORDS-CASE orphan-reconciliation: PASS (ORPHAN votingStarts retired by its own CARD, ORPHAN closed survives, CARD untouched)"
  fi

  # IN-06: records-level case -- the ONE-RECORD-PER-LINE invariant of the stream walk_dump()
  # emits. No XML fixture in the loop above can assert this, because every leg reads the stream
  # through $1== predicates and a corrupted stream simply presents as different numbers, never
  # as a named failure. xml_unescape() previously decoded &#10; to a real newline; this case
  # pins both halves of what that cost: a record must not be SPLIT, and the remainder must not
  # be able to FABRICATE a record. The second half is the sharp one -- a text attribute carrying
  # an encoded newline followed by tab-separated fields synthesised a well-formed CARD for a
  # stage that never rendered, which on the device path satisfies preflight's ten-anchor check
  # and makes `anchor-missing` unreachable for that stage.
  echo "[timeline-geometry] -- records case: text-separator-sanitisation --"
  local sepxml="${TMPDIR_TG}/selftest-separators.xml"
  {
    printf '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>\n'
    printf '<hierarchy rotation="0">\n'
    printf '  <node index="0" text="" resource-id="" class="android.view.ViewGroup" content-desc="" clickable="false" bounds="[20,100][700,400]">\n'
    printf '    <node index="0" text="" resource-id="timeline-row-notch-registrationEnds" class="android.view.View" content-desc="" clickable="false" bounds="[20,140][28,156]" />\n'
    printf '    <node index="1" text="Closed 3 days&#10;ago" resource-id="timeline-row-subtitle-registrationEnds" class="android.widget.TextView" content-desc="" clickable="false" bounds="[40,145][320,170]" />\n'
    printf '    <node index="2" text="Closed&#10;CARD\tclosed\t20\t800\t700\t900\tmeasured" resource-id="timeline-row-title-registrationEnds" class="android.widget.TextView" content-desc="" clickable="false" bounds="[40,110][300,140]" />\n'
    printf '  </node>\n'
    printf '</hierarchy>\n'
  } > "${sepxml}"
  local seprecords="${TMPDIR_TG}/selftest-separators.records"
  local sep_ok=1 sep_lines sep_cards sep_subtitle
  if ! walk_dump "${sepxml}" > "${seprecords}" 2>/dev/null; then
    echo "SELFTEST MISMATCH: text-separator-sanitisation -- walk_dump failed on the separator fixture"
    sep_ok=0
  else
    # Three records exactly: one CARD for registrationEnds plus one TEXT per text node. Any
    # extra line is a split record or a fabricated one.
    sep_lines=$(wc -l < "${seprecords}" | tr -d ' ')
    sep_cards=$(awk -v FS="${TAB}" '$1=="CARD"{print $2}' "${seprecords}" | sort | paste -sd, - || true)
    sep_subtitle=$(awk -v FS="${TAB}" '$1=="TEXT" && $9 ~ /^Closed 3 days/{print $9}' "${seprecords}" || true)
    if [ "${sep_lines}" != "3" ]; then
      echo "SELFTEST MISMATCH: text-separator-sanitisation -- expected exactly 3 records (1 CARD + 2 TEXT), got ${sep_lines}; an encoded separator split or fabricated a record"
      sep_ok=0
    fi
    if [ "${sep_cards}" != "registrationEnds" ]; then
      echo "SELFTEST MISMATCH: text-separator-sanitisation -- expected exactly [registrationEnds] to have a CARD record, got [${sep_cards}]; a text attribute fabricated a CARD"
      sep_ok=0
    fi
    if [ "${sep_subtitle}" != "Closed 3 days ago" ]; then
      echo "SELFTEST MISMATCH: text-separator-sanitisation -- expected the subtitle text to survive whole as [Closed 3 days ago], got [${sep_subtitle}]"
      sep_ok=0
    fi
  fi
  if [ "${sep_ok}" -eq 0 ]; then
    mismatches=$((mismatches + 1))
  else
    echo "RECORDS-CASE text-separator-sanitisation: PASS (3 records, no fabricated CARD, subtitle text survives whole)"
  fi

  if [ "${mismatches}" -eq 0 ]; then
    echo "SELFTEST: PASS (${total}/${total} fixtures behaved as specified)"
    SCRIPT_EXIT_CODE=0
    exit 0
  else
    # CR-01/WR-06: `mismatches` now also counts NON-fixture checks (the fixture-list drift check
    # and the records-level cases), so `total - mismatches` stopped being a meaningful numerator
    # on this path -- it could read "10/11 fixtures behaved as specified" when all 11 fixtures
    # behaved and a records check failed. Report the mismatch count itself. The PASSING line
    # above is deliberately left byte-identical: it is quoted verbatim in this phase's
    # VERIFICATION.
    echo "SELFTEST: FAIL (${mismatches} mismatch(es) across ${total} fixture(s) + ${NON_FIXTURE_CHECKS} non-fixture checks)"
    exit 1
  fi
}

# ---------------------------------------------------------------------------------------
# Early, device-free dispatch (design_notes item 8): --selftest and --dump-records must be
# recognized BEFORE leg-name validation and BEFORE preflight() -- both read only committed
# fixtures / a given file and must work with no device attached at all.
# ---------------------------------------------------------------------------------------
for _arg in "$@"; do
  if [ "${_arg}" = "--selftest" ]; then
    run_selftest
  fi
done

if [ "${1:-}" = "--dump-records" ]; then
  DUMP_PATH="${2:-}"
  if [ -z "${DUMP_PATH}" ]; then
    echo "Usage: $0 --dump-records <xml-path>" >&2
    exit 1
  fi
  if [ ! -f "${DUMP_PATH}" ]; then
    echo "--dump-records: no such file: ${DUMP_PATH}" >&2
    exit 1
  fi
  walk_dump "${DUMP_PATH}"
  SCRIPT_EXIT_CODE=0
  exit 0
fi
# ---------------------------------------------------------------------------------------
# Leg dispatch and usage (shape from run-authority-signing-ceremony.sh:73-84).
# ---------------------------------------------------------------------------------------
LEG="${1:-}"
case "${LEG}" in
  clipping|duplicates|touch-targets|all) ;;
  *)
    echo "Usage: SERIAL=43a209ff0806 LOCALE=en ./scripts/run-timeline-geometry-proof.sh <clipping|duplicates|touch-targets|all>" >&2
    exit 1
    ;;
esac

preflight

case "${LEG}" in
  clipping) run_leg "clipping" "${ACCUMULATED_RECORDS}" ;;
  duplicates) run_leg "duplicates" "${ACCUMULATED_RECORDS}" ;;
  touch-targets) run_leg "touch-targets" "${ACCUMULATED_RECORDS}" ;;
  all)
    run_leg "clipping" "${ACCUMULATED_RECORDS}"
    run_leg "duplicates" "${ACCUMULATED_RECORDS}"
    run_leg "touch-targets" "${ACCUMULATED_RECORDS}"
    ;;
esac

echo "[timeline-geometry] ========== Summary =========="
# IN-03: prefixed SUMMARY, not a second "LEG " line. record_leg() already prints
# "LEG <name>: <verdict> (<evidence>)" once per leg; reprinting the same prefix here meant a
# line-anchored consumer -- exactly what this file's own header warns about -- counted every leg
# twice. `grep -c "LEG clipping: PASS"` returned 2 for a single run.
for r in "${RESULTS[@]}"; do
  IFS='|' read -r name verdict evidence <<< "${r}"
  echo "SUMMARY ${name}: ${verdict}"
done

if any_failed; then
  exit 1
fi
SCRIPT_EXIT_CODE=0
exit 0
