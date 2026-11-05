#!/usr/bin/env bash
#
# run-dial-probe.sh
#
# Purpose  : P2P-01 dial proof — proves a device→host WebSocket dial completes
#            without a "connection gater denied" error, validating the cadre-core
#            connectionGater yarn patch authored in Phase 17.
#
# Usage    : ./scripts/run-dial-probe.sh
#
# Prerequisites:
#   - adb must be in PATH (Android SDK Platform Tools)
#   - A real device or AVD (Pixel_8) must be connected and recognised by adb
#   - The app (org.votetorrent.authority) must be installed on the device
#   - The host drone must already be running BEFORE this script is called:
#       yarn install   # once, at the repo root (p2p-probe-host is a yarn workspace)
#       cd packages/p2p-probe-host && nvm use 22 && node drone.mjs   # keep running in a separate terminal
#   - CONTROL_ADDR in apps/VoteTorrentAuthority/src/engines/dial-probe.ts must be
#     updated with the port and peerId printed by the drone on startup.
#     Re-build and hot-reload (or bundle rebuild) the app after updating CONTROL_ADDR.
#
# Exit codes:
#   0  — [dial-probe] DIAL VERDICT: PASS captured from logcat (conn >= 1)
#   1  — [dial-probe] DIAL VERDICT: FAIL captured, or no verdict within the timeout
#
# Failure modes:
#   ECONNREFUSED / ETIMEDOUT  — drone not running or CONTROL_ADDR wrong (not a gater failure)
#   "connection gater denied" — patch not applied or gater not forwarded into libp2p
#

set -euo pipefail

# WR-12 (17-REVIEW): every path below (FLAG_FILE, the dial-probe.ts placeholder
# guard) is repo-root-relative. Anchor the cwd to the repo root so the script —
# and crucially its EXIT-trap flag restore — works when invoked from any directory.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# IN-21 (17-REVIEW): shared logcat wait/poll helper (wait_for_logcat_line) —
# previously duplicated verbatim across both run scripts' marker + verdict waits.
. scripts/lib/logcat-wait.sh

PACKAGE="org.votetorrent.authority"
# dial-probe.ts logs via multi-arg console.log('[dial-probe]', ...) — RN logcat renders
# each arg quoted and comma-separated: '[dial-probe]', 'starting — ...'. Patterns must
# therefore tolerate the quote/comma between the tag and the message (single-string
# [proof] logs in run-vtest02.sh do not need this).
VERDICT_TAG='\[dial-probe\].*========== DIAL VERDICT'
# IN-20 (17-REVIEW): anchored to the exact dial-probe.ts log line
# ('starting — CONTROL_ADDR=...') so a future '[dial-probe] ... restarting'
# line cannot set PROBE_STARTED prematurely.
PROBE_MARKER='\[dial-probe\].*starting — CONTROL_ADDR'
LOGCAT_TIMEOUT=120  # seconds to wait for the verdict line; accounts for Metro dev-server
                    # rebundle latency plus the probe's own up-to-20s poll loop
                    # (observed false-FAIL at 30s in 17-UAT when verdict landed just outside).
MARKER_TIMEOUT=60   # seconds to wait for the [dial-probe] starting marker (proves Metro
                    # served the enabled bundle and the probe code path is executing).
FLAG_FILE="apps/VoteTorrentAuthority/src/engines/proof-flags.generated.ts"

# PROBE_STARTED tracks whether the app reached the [dial-probe] starting marker BEFORE the
# EXIT trap fires.  Initialized to 0 here (before the trap is installed) so restore_flags()
# can emit a warning if it fires before the probe-start was observed — the exact race
# observed on dial attempt 1 in 17-UAT (trap restored DIAL_PROBE_ENABLED=false while Metro
# was still rebundling; app fetched a flags-disabled bundle; probe never ran).
PROBE_STARTED=0

# WR-03 (17-REVIEW): restore the committed default-false flag file on EXIT
# (PASS, FAIL, or set -e abort) so the probe-enabled override never leaks
# into the next dev launch or into a commit. Mirrors run-vtest02.sh.
restore_flags() {
  if [ "${PROBE_STARTED}" -eq 0 ]; then
    echo "[run-dial-probe] WARNING: restoring flags before [dial-probe] starting observed — app may have fetched a flags-disabled bundle (probe silent no-op); re-run" >&2
  fi
  # IN-12 (17-REVIEW): git owns the committed default-false content — restore
  # from the index so an edit to the committed file cannot leave this script
  # regenerating stale content. The heredoc below is a FALLBACK only (e.g.
  # git unavailable or the file untracked).
  if git checkout -- "${FLAG_FILE}" 2>/dev/null; then
    return 0
  fi
  echo "[run-dial-probe] WARNING: git checkout restore failed — writing fallback default-false content (may be stale vs the committed file)" >&2
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

# 0. WR-11 (17-REVIEW): abort BEFORE touching the device if CONTROL_ADDR is
#    still the committed placeholder — otherwise the operator gets an ambiguous
#    "DIAL VERDICT: FAIL" / "no verdict line captured" with no hint of the cause.
#    WR-21 (17-REVIEW): this guard runs BEFORE the EXIT trap is installed — the
#    script has not touched the flag file or the device yet, so an abort here
#    must not fire restore_flags() and its misleading "flags-disabled bundle …
#    re-run" warning (re-running without fixing CONTROL_ADDR hits this same abort).
if grep -q 'UPDATE_AFTER_DRONE_RESTART' apps/VoteTorrentAuthority/src/engines/dial-probe.ts; then
  echo "[run-dial-probe] ERROR: CONTROL_ADDR in dial-probe.ts is still the committed placeholder" >&2
  echo "[run-dial-probe]        Start the drone (packages/p2p-probe-host/drone.mjs), copy the ws" >&2
  echo "[run-dial-probe]        multiaddr from its READY line into CONTROL_ADDR, then re-run." >&2
  exit 1
fi
# IN-16 (17-REVIEW): a half-edited CONTROL_ADDR (peer ID replaced, port left as
# the committed /tcp/0/) passes the placeholder grep above but reproduces the
# same ambiguous FAIL — reject it explicitly.
if grep -q '/tcp/0/ws' apps/VoteTorrentAuthority/src/engines/dial-probe.ts; then
  echo "[run-dial-probe] ERROR: CONTROL_ADDR in dial-probe.ts still carries the placeholder port /tcp/0/" >&2
  echo "[run-dial-probe]        Replace the port with the one printed on the drone's READY line, then re-run." >&2
  exit 1
fi

# WR-21: install the trap only now — immediately before the first flag-file
# write, the first action the trap exists to undo.
trap restore_flags EXIT

# 1. Write flag file: DIAL_PROBE_ENABLED=true, PROOF_ENABLED=false (D-18/D-19).
#    Metro picks up the change on the next bundle request (force-stop clears stale JS cache).
cat > "${FLAG_FILE}" << 'EOF'
// run-dial-probe.sh generated override — do not commit (EXIT trap restores default).
// Static import only — dynamic require() breaks Metro (Phase 16-07 lesson).
export const PROOF_ENABLED = false;
export const DIAL_PROBE_ENABLED = true;
export const REPLICATION_PROOF_ENABLED = false;
export const USE_LOCAL_DB_FACTORY = false;
export const SIGNING_PROOF_ENABLED = false;
export const STRAND_PERSISTENCE_PROOF_ENABLED = false;
export const USE_STUB_ATTESTATION_VERIFIER = false;
export const REGISTRANT_SEED_ENABLED = false;
export const RECOVERY_BRANCH_PROOF_ENABLED = false;
export const SEALED_PAYLOAD_PROOF_ENABLED = false;
EOF

echo "[run-dial-probe] Flag file updated: DIAL_PROBE_ENABLED=true"

# 2. Force-stop → relaunch so Metro re-evaluates the updated flag file.
echo "[run-dial-probe] Force-stopping ${PACKAGE} ..."
adb shell am force-stop "${PACKAGE}"
sleep 2

# CR-01: clear the logcat ring buffer so a verdict line from a PREVIOUS run
# (which survives force-stop) cannot be picked up as a stale PASS/FAIL.
adb logcat -c

echo "[run-dial-probe] Relaunching ${PACKAGE} ..."
adb shell monkey -p "${PACKAGE}" -c android.intent.category.LAUNCHER 1

# Wait for the probe-start marker BEFORE arming the verdict countdown.
# This marker is emitted by dial-probe.ts ONLY after Metro has served the enabled bundle and
# the gated dial-probe code path is executing.  Waiting here closes the EXIT-trap rebundle
# race (WR-03 TIMING fix): the trap is allowed to restore flags at any time, but if we
# haven't seen this marker it means the app likely fetched the flags-disabled bundle — in
# which case restore_flags() emits a warning (PROBE_STARTED still 0).
echo "[run-dial-probe] Waiting up to ${MARKER_TIMEOUT}s for [dial-probe] starting marker ..."
# IN-21 (17-REVIEW): wait/poll logic lives in scripts/lib/logcat-wait.sh
# (single home for the WR-22/WR-23 status handling and the IN-19 latency note).
MARKER_LINE=$(wait_for_logcat_line "${PROBE_MARKER}" "${MARKER_TIMEOUT}" "[run-dial-probe]" "marker")

if [ -z "${MARKER_LINE}" ]; then
  echo "[run-dial-probe] ERROR: [dial-probe] never started — Metro rebundle likely still in flight or flags-disabled bundle served; re-run" >&2
  exit 1
fi

echo "[run-dial-probe] Probe-start marker seen: ${MARKER_LINE}"
PROBE_STARTED=1

# 3. Poll logcat for the DIAL VERDICT line (emitted by dial-probe.ts after the 20s poll loop).
echo "[run-dial-probe] Polling logcat for verdict (${LOGCAT_TIMEOUT}s timeout) ..."
# IN-21: shared helper — see scripts/lib/logcat-wait.sh.
VERDICT_LINE=$(wait_for_logcat_line "${VERDICT_TAG}" "${LOGCAT_TIMEOUT}" "[run-dial-probe]" "verdict")

if [ -z "${VERDICT_LINE}" ]; then
  echo "[run-dial-probe] ERROR: no verdict line captured within ${LOGCAT_TIMEOUT}s — FAIL"
  exit 1
fi

echo "[run-dial-probe] Captured: ${VERDICT_LINE}"

if echo "${VERDICT_LINE}" | grep -q "FAIL"; then
  echo "[run-dial-probe] VERDICT: FAIL"
  exit 1
fi

echo "[run-dial-probe] VERDICT: PASS"
exit 0
