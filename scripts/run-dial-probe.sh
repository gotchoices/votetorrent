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
#       cd packages/p2p-probe-host && npm install  # once
#       nvm use 22 && node drone.mjs               # keep running in a separate terminal
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

PACKAGE="org.votetorrent.authority"
VERDICT_TAG='\[dial-probe\] ========== DIAL VERDICT'
LOGCAT_TIMEOUT=30  # seconds to wait for the verdict line
FLAG_FILE="apps/VoteTorrentAuthority/src/engines/proof-flags.generated.ts"

# WR-03 (17-REVIEW): restore the committed default-false flag file on EXIT
# (PASS, FAIL, or set -e abort) so the probe-enabled override never leaks
# into the next dev launch or into a commit. Mirrors run-vtest02.sh.
restore_flags() {
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
EOF
}
trap restore_flags EXIT

# 1. Write flag file: DIAL_PROBE_ENABLED=true, PROOF_ENABLED=false (D-18/D-19).
#    Metro picks up the change on the next bundle request (force-stop clears stale JS cache).
cat > "${FLAG_FILE}" << 'EOF'
// run-dial-probe.sh generated override — do not commit (EXIT trap restores default).
// Static import only — dynamic require() breaks Metro (Phase 16-07 lesson).
export const PROOF_ENABLED = false;
export const DIAL_PROBE_ENABLED = true;
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

# 3. Poll logcat for the DIAL VERDICT line (emitted by dial-probe.ts after the 20s poll loop).
echo "[run-dial-probe] Polling logcat for verdict (${LOGCAT_TIMEOUT}s timeout) ..."
# Portable timeout: prefer GNU timeout, then gtimeout (Homebrew coreutils), then bounded poll.
TIMEOUT_BIN=$(command -v timeout || command -v gtimeout || true)
VERDICT_LINE=""
if [ -n "${TIMEOUT_BIN}" ]; then
  VERDICT_LINE=$(${TIMEOUT_BIN} "${LOGCAT_TIMEOUT}" adb logcat -e "${VERDICT_TAG}" | head -1 || true)
else
  # Fallback: bounded poll loop (30 s cap, 5 s intervals) — avoids macOS missing timeout.
  _elapsed=0
  while [ "${_elapsed}" -lt "${LOGCAT_TIMEOUT}" ]; do
    VERDICT_LINE=$(adb logcat -d | grep "${VERDICT_TAG}" | head -1 || true)
    if [ -n "${VERDICT_LINE}" ]; then break; fi
    sleep 5
    _elapsed=$((_elapsed + 5))
  done
fi

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
