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

# 1. Write flag file: DIAL_PROBE_ENABLED=true, PROOF_ENABLED=false (D-18/D-19).
#    Metro picks up the change on the next bundle request (force-stop clears stale JS cache).
cat > apps/VoteTorrentAuthority/src/engines/proof-flags.generated.ts << 'EOF'
// run-dial-probe.sh generated override — do not commit.
// Static import only — dynamic require() breaks Metro (Phase 16-07 lesson).
export const PROOF_ENABLED = false;
export const DIAL_PROBE_ENABLED = true;
EOF

echo "[run-dial-probe] Flag file updated: DIAL_PROBE_ENABLED=true"

# 2. Force-stop → relaunch so Metro re-evaluates the updated flag file.
echo "[run-dial-probe] Force-stopping ${PACKAGE} ..."
adb shell am force-stop "${PACKAGE}"
sleep 2

echo "[run-dial-probe] Relaunching ${PACKAGE} ..."
adb shell monkey -p "${PACKAGE}" -c android.intent.category.LAUNCHER 1

# 3. Poll logcat for the DIAL VERDICT line (emitted by dial-probe.ts after the 20s poll loop).
echo "[run-dial-probe] Polling logcat for verdict (${LOGCAT_TIMEOUT}s timeout) ..."
VERDICT_LINE=$(timeout "${LOGCAT_TIMEOUT}" adb logcat -e "${VERDICT_TAG}" | head -1 || true)

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
