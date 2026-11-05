#!/usr/bin/env bash
#
# run-vtest02.sh
#
# Purpose  : VTEST-02 — Automated full-chain restart-persistence proof for VoteTorrentAuthority.
#            Force-stops the app, relaunches it via adb, then polls logcat for the verdict
#            that the in-app persistence-proof-runner.ts emits once the read phase completes.
#
# Usage    : ./scripts/run-vtest02.sh [--solo] [--no-reset]
#            Bare invocation  : strand-on (default) — flips STRAND_PERSISTENCE_PROOF_ENABLED=true,
#                                resets BOTH the votetorrent-q2-* and votetorrent-cadre-probe-persistence*
#                                LevelDB stores, exercises the strand path (D-05b).
#            --solo           : STRAND off — writes STRAND_PERSISTENCE_PROOF_ENABLED=false (keeps
#                                PROOF_ENABLED=true), skips the strand-store reset, and exercises the
#                                solo rnDbFactory path only (D-15 solo regression gate).
#            --no-reset       : Skip the D-11 LevelDB reset entirely, preserving whatever the
#                                stores already hold. Required for any proof whose premise is
#                                "re-attach to a store that ALREADY holds rows" — e.g. a live-table
#                                CHECK amendment meeting pre-amendment rows. Without this the reset
#                                below deletes the very rows such a proof depends on, making the
#                                "store held pre-existing rows" and "harness emitted a verdict"
#                                conditions unsatisfiable in the same run. Flags compose in any order.
#
# Prerequisites:
#   - adb must be in PATH (Android SDK Platform Tools)
#   - A real device or AVD must be connected and recognised by adb
#   - The app (org.votetorrent.authority) must be installed on the device
#   - The app must already be in "write-complete" state: run the app once so the write phase
#     executes and persists the full-chain reference under PROOF_CHAIN_REF_KEY in AsyncStorage;
#     then force-stop manually (or let this script do the first force-stop).
#
# Exit codes:
#   0  — FULL-CHAIN VERDICT: PASS captured from logcat
#   1  — FULL-CHAIN VERDICT: FAIL captured, or no verdict within the timeout
#

set -euo pipefail

# 37-04 (T-37-15): parse an optional --solo arg into STRAND_MODE. Default
# (bare invocation) is strand-on so the existing D-05b flow is unchanged.
# 48-02: --no-reset added alongside it. Parsed as an order-independent loop so
# `--solo --no-reset` and `--no-reset --solo` behave identically; the previous
# positional `$1`-only check silently ignored a second flag.
STRAND_MODE="on"
RESET_STORES="yes"
for arg in "$@"; do
  case "$arg" in
    --solo)     STRAND_MODE="off" ;;
    --no-reset) RESET_STORES="no" ;;
    *)
      echo "[vtest02] ERROR: unknown argument '$arg' (expected --solo and/or --no-reset)" >&2
      exit 2
      ;;
  esac
done

# WR-12 (17-REVIEW): every path below (FLAG_FILE) is repo-root-relative. Anchor
# the cwd to the repo root so the script — and crucially its EXIT-trap flag
# restore — works when invoked from any directory.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# IN-21 (17-REVIEW): shared logcat wait/poll helper (wait_for_logcat_line) —
# previously duplicated verbatim across both run scripts' marker + verdict waits.
. scripts/lib/logcat-wait.sh

PACKAGE="org.votetorrent.authority"
VERDICT_TAG='\[proof\] ========== FULL-CHAIN VERDICT'
BOOT_MARKER='\[proof\] ========== BOOT: READ PHASE'
LOGCAT_TIMEOUT=120  # seconds to wait for the verdict line; accounts for Metro dev-server
                    # rebundle latency (~30-40s) plus the ~17s store re-attach in the read
                    # phase (observed ~37s+ end-to-end in 17-UAT).
MARKER_TIMEOUT=60   # seconds to wait for the BOOT: READ PHASE marker (proves Metro served
                    # the enabled bundle and the gated read phase is executing).
FLAG_FILE="apps/VoteTorrentAuthority/src/engines/proof-flags.generated.ts"

# PROBE_STARTED tracks whether the app reached the READ PHASE marker BEFORE the EXIT trap
# fires.  Initialized to 0 here (before the trap is installed) so restore_flags() can emit
# a warning if the trap fires before the probe-start marker was observed.  The flag is SET
# to 1 after the marker wait succeeds (see the marker-wait block below).
PROBE_STARTED=0

# WR-03 (17-REVIEW): restore the committed default-false flag file on EXIT
# (PASS, FAIL, or set -e abort) so the proof-enabled override never leaks
# into the next dev launch or into a commit. Mirrors run-dial-probe.sh.
restore_flags() {
  if [ "${PROBE_STARTED}" -eq 0 ]; then
    echo "[vtest02] WARNING: restoring flags before BOOT: READ PHASE observed — app may have fetched flags-disabled bundle; re-run if no verdict" >&2
  fi
  # IN-12 (17-REVIEW): git owns the committed default-false content — restore
  # from the index so an edit to the committed file cannot leave this script
  # regenerating stale content. The heredoc below is a FALLBACK only (e.g.
  # git unavailable or the file untracked).
  if git checkout -- "${FLAG_FILE}" 2>/dev/null; then
    return 0
  fi
  echo "[vtest02] WARNING: git checkout restore failed — writing fallback default-false content (may be stale vs the committed file)" >&2
  cat > "${FLAG_FILE}" << 'EOF'
// proof-flags.generated.ts — committed default fallback (all flags false).
// The run scripts (run-vtest02.sh, run-dial-probe.sh) overwrite this file
// before bundling and restore the default-false content in an EXIT trap.
// NOTE: this file IS git-tracked (gitignore would be a no-op for a tracked
// file — WR-02, 17-REVIEW). If a run script is killed before its EXIT trap
// fires, `git status` will show this file modified: restore it with
// `git checkout -- apps/VoteTorrentAuthority/src/engines/proof-flags.generated.ts`
// and NEVER commit an enabled-flag override.
// Static import ONLY — dynamic require() breaks Metro (Phase 16-07 lesson).
export const PROOF_ENABLED = false;
export const DIAL_PROBE_ENABLED = false;
export const REPLICATION_PROOF_ENABLED = false;
export const USE_LOCAL_DB_FACTORY = false;
export const SIGNING_PROOF_ENABLED = false;
export const STRAND_PERSISTENCE_PROOF_ENABLED = false;
export const USE_STUB_ATTESTATION_VERIFIER = false;
export const REGISTRANT_SEED_ENABLED = false;
export const RECOVERY_BRANCH_PROOF_ENABLED = false;
export const SEALED_PAYLOAD_PROOF_ENABLED = false;
EOF
}
trap restore_flags EXIT

# D-18/D-19: Write the generated flag file before launch so PROOF_ENABLED=true and
# DIAL_PROBE_ENABLED=false are bundled into the Metro-served JS.
# The dial probe is kept off during a proof run (D-19).
# Phase 37 (D-05): STRAND_PERSISTENCE_PROOF_ENABLED=true also flips this run into strand mode —
# the app boots its own bootstrap/solo CadreNode (strand-persistence-proof-runner.ts) and calls
# the SAME runPersistenceProof(node) that PROOF_ENABLED's solo rnDbFactory path already exercises;
# the verdict poll below is unchanged either way.
# 37-04 (T-37-15): --solo flips STRAND_FLAG to false so the solo rnDbFactory path runs
# (index.js's gated solo runPersistenceProof() call fires because the strand flag is false)
# while PROOF_ENABLED stays true — the concrete STRAND-off D-15 solo gate invocation.
if [ "${STRAND_MODE}" = "off" ]; then
  STRAND_FLAG="false"
else
  STRAND_FLAG="true"
fi
# D-16 (47-01 Task 4): fail closed on a stale BUILT vote-engine BEFORE anything is
# bundled. The app resolves @votetorrent/vote-engine to dist/, never src/, so a
# dist that lags votetorrent.qsql yields a VACUOUS on-device PASS against the old
# schema (observed 2026-08-04). This MUST stay ahead of the flag write below —
# that is the last point where aborting is still free. `set -euo pipefail` makes a
# non-zero exit abort the run; keep this a bare call, never a soft conditional.
echo "[vtest02] Checking built vote-engine schema freshness (D-16) ..."
bash scripts/check-dist-freshness.sh

echo "[vtest02] Writing proof-flags.generated.ts (PROOF_ENABLED=true, DIAL_PROBE_ENABLED=false, STRAND_PERSISTENCE_PROOF_ENABLED=${STRAND_FLAG}, mode=${STRAND_MODE}) ..."
cat > "${FLAG_FILE}" << EOF
// proof-flags.generated.ts — written by run-vtest02.sh before launch (D-18).
// DO NOT commit this override (EXIT trap restores the committed default-false baseline).
export const PROOF_ENABLED = true;
export const DIAL_PROBE_ENABLED = false;
export const REPLICATION_PROOF_ENABLED = false;
export const USE_LOCAL_DB_FACTORY = false;
export const SIGNING_PROOF_ENABLED = false;
export const STRAND_PERSISTENCE_PROOF_ENABLED = ${STRAND_FLAG};
export const USE_STUB_ATTESTATION_VERIFIER = false;
export const REGISTRANT_SEED_ENABLED = false;
export const RECOVERY_BRANCH_PROOF_ENABLED = false;
export const SEALED_PAYLOAD_PROOF_ENABLED = false;
EOF

# D-11: Fresh LevelDB reset — isolates the 4.x proof from any 3.x-written data.
# Restart-persistence is still proven within 4.x (write → relaunch → read).
# 48-02: gated on --no-reset. This reset was previously unconditional and sat ABOVE the
# STRAND_MODE guard below, so even `--solo` wiped every votetorrent-q2-* store before the
# read phase — which silently defeats any proof premised on pre-existing rows.
if [ "${RESET_STORES}" = "yes" ]; then
  echo "[vtest02] Resetting LevelDB stores (D-11) ..."
  adb shell run-as org.votetorrent.authority \
    find /data/data/org.votetorrent.authority/files -name "votetorrent-q2-*" -exec rm -rf {} + 2>/dev/null || true

  # Phase 37 (D-05/D-06): the strand persistence proof runner boots its OWN CadreNode store
  # (votetorrent-cadre-probe-persistence) — the votetorrent-q2-* glob above does NOT cover it
  # (per project_strand_storage_per_network_isolation memory — a shared handle contaminates
  # count(*) across paths). Reset it too so the strand proof starts from a fresh slate.
  # 37-04 (T-37-15): skip in --solo mode — no strand node boots, so there is nothing to reset.
  if [ "${STRAND_MODE}" = "on" ]; then
    adb shell run-as org.votetorrent.authority \
      find /data/data/org.votetorrent.authority/files -name "votetorrent-cadre-probe-persistence*" -exec rm -rf {} + 2>/dev/null || true
  fi
else
  echo "[vtest02] --no-reset: preserving existing LevelDB stores (D-11 reset skipped)."
fi

echo "[vtest02] Force-stopping ${PACKAGE} ..."
adb shell am force-stop "${PACKAGE}"
sleep 2

# CR-01: clear the logcat ring buffer so a verdict line from a PREVIOUS run
# (which survives force-stop) cannot be picked up as a stale PASS/FAIL.
adb logcat -c

echo "[vtest02] Relaunching ${PACKAGE} ..."
adb shell monkey -p "${PACKAGE}" -c android.intent.category.LAUNCHER 1

# Wait for the probe-start marker BEFORE arming the verdict countdown.
# This marker is emitted by persistence-proof-runner.ts ONLY after Metro has served the
# enabled bundle and the gated READ PHASE code path is executing.  Waiting here closes the
# EXIT-trap rebundle race (WR-03 TIMING fix): the trap is allowed to restore flags at any
# time, but if we haven't seen this marker it means the app likely fetched the flags-disabled
# bundle — in which case restore_flags() emits a warning (PROBE_STARTED still 0).
echo "[vtest02] Waiting up to ${MARKER_TIMEOUT}s for BOOT: READ PHASE marker ..."
# IN-21 (17-REVIEW): wait/poll logic lives in scripts/lib/logcat-wait.sh
# (single home for the WR-22/WR-23 status handling and the IN-19 latency note).
MARKER_LINE=$(wait_for_logcat_line "${BOOT_MARKER}" "${MARKER_TIMEOUT}" "[vtest02]" "marker")

if [ -z "${MARKER_LINE}" ]; then
  # IN-22 (17-REVIEW): if the write-complete precondition was unmet, the app
  # emitted BOOT: WRITE PHASE instead of the READ marker — it sits in the
  # freshly-cleared buffer, so check it before blaming Metro/flags.
  if adb logcat -d 2>/dev/null | grep -q 'BOOT: WRITE PHASE'; then
    echo "[vtest02] ERROR: app was in WRITE phase (no saved chain ref) — wait for '[proof] WRITE PHASE DONE' in logcat, then re-run for the read-phase verdict" >&2
    exit 1
  fi
  echo "[vtest02] ERROR: app never reached READ PHASE — Metro rebundle likely still in flight or flags-disabled bundle served; re-run" >&2
  exit 1
fi

echo "[vtest02] READ PHASE marker seen: ${MARKER_LINE}"
PROBE_STARTED=1

echo "[vtest02] Polling logcat for verdict (${LOGCAT_TIMEOUT}s timeout) ..."
# IN-21: shared helper — see scripts/lib/logcat-wait.sh.
VERDICT_LINE=$(wait_for_logcat_line "${VERDICT_TAG}" "${LOGCAT_TIMEOUT}" "[vtest02]" "verdict")

if [ -z "${VERDICT_LINE}" ]; then
  echo "[vtest02] ERROR: no verdict line captured within ${LOGCAT_TIMEOUT}s — FAIL"
  exit 1
fi

echo "[vtest02] Captured: ${VERDICT_LINE}"

if echo "${VERDICT_LINE}" | grep -q "FAIL"; then
  echo "[vtest02] VERDICT: FAIL"
  exit 1
fi

# Belt-and-suspenders DEBT-04 gate: digestParity=false is a FAIL even when the overall
# PASS/FAIL substring reads PASS (the runner already folds parity into the verdict boolean,
# but this second grep makes the failure explicit in the script output).
if echo "${VERDICT_LINE}" | grep -q "digestParity=false"; then
  echo "[vtest02] VERDICT: FAIL (digestParity=false)"
  exit 1
fi

echo "[vtest02] VERDICT: PASS"
exit 0
