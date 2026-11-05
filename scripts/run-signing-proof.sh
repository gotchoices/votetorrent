#!/usr/bin/env bash
#
# run-signing-proof.sh
#
# Purpose : Phase 28 SIGN-04 on-device [spike013] signing round-trip proof.
#           Enables SIGNING_PROOF_ENABLED, relaunches the app on a Pixel_8/Hermes
#           emulator, and asserts the [spike013] signing-proof runner logs
#           SIGNING VERDICT: PASS — on the initial boot AND after a force-stop /
#           relaunch cycle (proves the fix survives process death). Also asserts
#           the pre-fix FATAL ("sign is not a function") does NOT reproduce.
#
# Usage   : SERIAL=emulator-5554 ./scripts/run-signing-proof.sh
#
# Prereqs : adb on PATH; the emulator running with the debug app installed;
#           Metro reachable (the script sets up `adb reverse tcp:8081`).
#
# Exit    : 0 — SIGNING VERDICT: PASS on both boots, no FATAL
#           1 — FAIL / no verdict / FATAL reproduced
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
. scripts/lib/logcat-wait.sh

PACKAGE="org.votetorrent.authority"
SERIAL="${SERIAL:-emulator-5554}"
ADBD="-s ${SERIAL}"
# Multi-arg console.log renders args quoted/comma-separated in RN logcat, so the
# patterns tolerate tokens between the tag and the message.
START_MARKER='spike013.*signing proof: starting'
VERDICT_TAG='spike013.*SIGNING VERDICT'
FATAL_PATTERN='sign is not a function'
FLAG_FILE="apps/VoteTorrentAuthority/src/engines/proof-flags.generated.ts"
MARKER_TIMEOUT=150
VERDICT_TIMEOUT=120

restore_flags() {
  if git checkout -- "${FLAG_FILE}" 2>/dev/null; then
    echo "[run-signing-proof] flags restored to committed default-false"
  else
    echo "[run-signing-proof] WARNING: git checkout restore failed — restore ${FLAG_FILE} manually" >&2
  fi
}
trap restore_flags EXIT

# ── STEP 0: enable SIGNING_PROOF_ENABLED only ────────────────────────────────
cat > "${FLAG_FILE}" << 'EOF'
// run-signing-proof.sh generated override — do not commit (EXIT trap restores default).
// Static import only — dynamic require() breaks Metro (Phase 16-07 lesson).
export const PROOF_ENABLED = false;
export const DIAL_PROBE_ENABLED = false;
export const REPLICATION_PROOF_ENABLED = false;
export const USE_LOCAL_DB_FACTORY = false;
export const SIGNING_PROOF_ENABLED = true;
export const STRAND_PERSISTENCE_PROOF_ENABLED = false;
export const USE_STUB_ATTESTATION_VERIFIER = false;
export const REGISTRANT_SEED_ENABLED = false;
export const RECOVERY_BRANCH_PROOF_ENABLED = false;
export const SEALED_PAYLOAD_PROOF_ENABLED = false;
EOF
echo "[run-signing-proof] SIGNING_PROOF_ENABLED=true"

# Debug build fetches the JS bundle from Metro on the host; bridge port 8081.
adb ${ADBD} reverse tcp:8081 tcp:8081 || true

run_boot() {
  local label="$1"
  echo "[run-signing-proof] ${label}: force-stop + clear logcat + relaunch ..."
  adb ${ADBD} shell am force-stop "${PACKAGE}"
  sleep 2
  adb ${ADBD} logcat -c
  adb ${ADBD} shell monkey -p "${PACKAGE}" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1

  local start_line
  start_line=$(wait_for_logcat_line "${START_MARKER}" "${MARKER_TIMEOUT}" "[run-signing-proof]" "${label}-start" "${ADBD}")
  if [ -z "${start_line}" ]; then
    echo "[run-signing-proof] ERROR (${label}): no [spike013] starting marker within ${MARKER_TIMEOUT}s — Metro rebundle in flight or flags-disabled bundle served; re-run" >&2
    return 1
  fi
  echo "[run-signing-proof] ${label} start: ${start_line}"

  local verdict
  verdict=$(wait_for_logcat_line "${VERDICT_TAG}" "${VERDICT_TIMEOUT}" "[run-signing-proof]" "${label}-verdict" "${ADBD}")
  if [ -z "${verdict}" ]; then
    echo "[run-signing-proof] ERROR (${label}): no SIGNING VERDICT within ${VERDICT_TIMEOUT}s" >&2
    return 1
  fi
  echo "[run-signing-proof] ${label} verdict: ${verdict}"
  if echo "${verdict}" | grep -q "FAIL"; then
    echo "[run-signing-proof] FAIL (${label}): verdict reported FAIL" >&2
    return 1
  fi
  # Old FATAL must not reproduce.
  if adb ${ADBD} logcat -d | grep -q "${FATAL_PATTERN}"; then
    echo "[run-signing-proof] FAIL (${label}): pre-fix FATAL '${FATAL_PATTERN}' reproduced" >&2
    return 1
  fi
  echo "[run-signing-proof] ${label}: PASS (no FATAL)"
  return 0
}

# ── STEP 1: initial boot ─────────────────────────────────────────────────────
run_boot "boot1-initial"

# ── STEP 2: force-stop / relaunch (process-death proof) ──────────────────────
run_boot "boot2-relaunch"

echo "[run-signing-proof] ========== SIGNING VERDICT: PASS (both boots) =========="
exit 0
