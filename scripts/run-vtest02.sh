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

# D-18/D-19: Write the generated flag file before launch so PROOF_ENABLED=true and
# DIAL_PROBE_ENABLED=false are bundled into the Metro-served JS.
# The dial probe is kept off during a proof run (D-19).
echo "[vtest02] Writing proof-flags.generated.ts (PROOF_ENABLED=true, DIAL_PROBE_ENABLED=false) ..."
cat > apps/VoteTorrentAuthority/src/engines/proof-flags.generated.ts << 'EOF'
// proof-flags.generated.ts — written by run-vtest02.sh before launch (D-18).
// DO NOT commit this override. The default-false version is the committed baseline.
export const PROOF_ENABLED = true;
export const DIAL_PROBE_ENABLED = false;
EOF

echo "[vtest02] Force-stopping ${PACKAGE} ..."
adb shell am force-stop "${PACKAGE}"
sleep 2

# CR-01: clear the logcat ring buffer so a verdict line from a PREVIOUS run
# (which survives force-stop) cannot be picked up as a stale PASS/FAIL.
adb logcat -c

echo "[vtest02] Relaunching ${PACKAGE} ..."
adb shell monkey -p "${PACKAGE}" -c android.intent.category.LAUNCHER 1

echo "[vtest02] Polling logcat for verdict (${LOGCAT_TIMEOUT}s timeout) ..."
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
