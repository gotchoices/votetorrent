#!/usr/bin/env bash
#
# run-vtest02.sh
#
# Purpose  : VTEST-02 — Automated full-chain restart-persistence proof for VoteTorrentAuthority.
#            Force-stops the app, relaunches it via adb, then polls logcat for the verdict
#            that the in-app persistence-proof-runner.ts emits once the read phase completes.
#
# Usage    : ./scripts/run-vtest02.sh
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

PACKAGE="org.votetorrent.authority"
VERDICT_TAG='\[proof\] ========== FULL-CHAIN VERDICT'
LOGCAT_TIMEOUT=30  # seconds to wait for the verdict line

echo "[vtest02] Force-stopping ${PACKAGE} ..."
adb shell am force-stop "${PACKAGE}"
sleep 2

echo "[vtest02] Relaunching ${PACKAGE} ..."
adb shell monkey -p "${PACKAGE}" -c android.intent.category.LAUNCHER 1

echo "[vtest02] Polling logcat for verdict (${LOGCAT_TIMEOUT}s timeout) ..."
VERDICT_LINE=$(timeout "${LOGCAT_TIMEOUT}" adb logcat -e "${VERDICT_TAG}" | head -1 || true)

if [ -z "${VERDICT_LINE}" ]; then
  echo "[vtest02] ERROR: no verdict line captured within ${LOGCAT_TIMEOUT}s — FAIL"
  exit 1
fi

echo "[vtest02] Captured: ${VERDICT_LINE}"

if echo "${VERDICT_LINE}" | grep -q "FAIL"; then
  echo "[vtest02] VERDICT: FAIL"
  exit 1
fi

echo "[vtest02] VERDICT: PASS"
exit 0
