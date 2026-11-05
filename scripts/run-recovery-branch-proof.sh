#!/usr/bin/env bash
#
# run-recovery-branch-proof.sh
#
# Purpose : D-26a leg 5 — the LOCAL half. Drives the recovery-key signing branch on a real
#           device with NO network, NO relay and NO drone, and asserts the resulting P-256
#           signature is accepted by `verifySigP256` — the same function the schema's
#           `SignatureValidP256` CHECK calls.
#
#           D-26a as originally specified is folded into D-24 leg 3's revoke-then-add ceremony,
#           whose success criterion is a replacement key landing in the network `UserKey` table.
#           That needs a network whose `User` resolves with BOTH keys registered — a precondition
#           blocked behind an unrelated P2P/relay chain. The branch itself needs none of that.
#
#           Split:
#             LOCAL (this script) — the branch runs, signs, and the schema's verifier accepts it.
#             DEFERRED           — UserKey.DeleteValid/InsertValid accept the revoke+add round
#                                  trip. Genuinely network-dependent; rides along whenever a
#                                  network next exists on the device.
#
#           Does NOT close D-24 leg 3. Record it as D-26a-LOCAL.
#
# D-26A RESCOPED 2026-08-21 — API 30+ ONLY
#           Recovery is supported on API 30+ via BiometricPrompt DEVICE_CREDENTIAL. Below API 30 it
#           is explicitly UNSUPPORTED: measured n=2 on Device B (Redmi 8, API 29) after a clean
#           `pm clear`, the recovery key is auth-per-use below API 30 and the OS
#           confirm-device-credential API performs a time-bound authentication that cannot
#           authorize it (RESULT_OK followed by KeyStoreException: Key user not authenticated).
#           49-19 removed the sub-API-30 dispatch branch from the native layer entirely; the app
#           now rejects with RECOVERY_UNSUPPORTED_OS below API 30 before any key handle or UI. See
#           .planning/todos/pending/2026-08-19-d26-keyguard-fallback-cannot-authorize-per-use-key.md
#           for the n=2 measurement and the rescope decision.
#
# BRANCH ATTRIBUTION IS MEASURED, NOT INFERRED (API 30+, the only branch left)
#           The existing `recover` leg's `recover-branch` sub-assertion records PASS for SDK>=30 on
#           "source-guaranteed" dispatch — it captures the logcat but never gates on it, so it
#           would print PASS on a device where the BiometricPrompt path never executed. This
#           script GATES on the ABSENCE of a CONFIRM_DEVICE_CREDENTIAL activity on API 30+ (the
#           BiometricPrompt path starts no such activity — that activity was the SIGNATURE of the
#           now-removed sub-API-30 branch, historically distinguishable in logcat independently of
#           anything the app logs). Below API 30 there is no branch left to measure or infer; the
#           script reports N/A rather than PASS/FAIL for that SDK range.
#
# Usage   : SERIAL=<serial> ./scripts/run-recovery-branch-proof.sh
#           Requires a human at the device: the prompt must be satisfied with the DEVICE
#           CREDENTIAL (PIN/pattern/password), never a fingerprint.
#
# Exit    : 0 — verdict PASS and the branch assertion held
#           1 — verdict FAIL, timeout, or branch assertion failed
#           2 — verdict PRECONDITION-UNMET (branch never reached; claims nothing about D-26a)
#           3 — verdict UNSUPPORTED-OS (recovery unsupported below API 30 by decision, D-26a
#               RESCOPED 2026-08-21; claims nothing about D-26a)
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PACKAGE="org.votetorrent.authority"
SERIAL="${SERIAL:-}"
if [ -z "${SERIAL}" ]; then
  SERIAL="$(adb devices | awk 'NR>1 && $2=="device" {print $1; exit}')"
fi
if [ -z "${SERIAL}" ]; then
  echo "[d26a-local] no device — set SERIAL=<serial>" >&2
  exit 1
fi
ADBD="-s ${SERIAL}"
FLAG_FILE="apps/VoteTorrentAuthority/src/engines/proof-flags.generated.ts"
VERDICT_TIMEOUT="${VERDICT_TIMEOUT:-180}"

restore_flags() {
  if git checkout -- "${FLAG_FILE}" 2>/dev/null; then
    echo "[d26a-local] flags restored to committed default-false"
  else
    echo "[d26a-local] WARNING: git checkout restore failed — restore ${FLAG_FILE} manually" >&2
  fi
}
trap restore_flags EXIT

SDK="$(adb ${ADBD} shell getprop ro.build.version.sdk | tr -d '\r')"
echo "[d26a-local] device=${SERIAL} sdk=${SDK}"

# ── STEP 0: enable RECOVERY_BRANCH_PROOF_ENABLED only ────────────────────────
cat > "${FLAG_FILE}" << 'EOF'
// run-recovery-branch-proof.sh generated override — do not commit (EXIT trap restores default).
// Static import only — dynamic require() breaks Metro (Phase 16-07 lesson).
export const PROOF_ENABLED = false;
export const DIAL_PROBE_ENABLED = false;
export const REPLICATION_PROOF_ENABLED = false;
export const USE_LOCAL_DB_FACTORY = false;
export const SIGNING_PROOF_ENABLED = false;
export const STRAND_PERSISTENCE_PROOF_ENABLED = false;
export const USE_STUB_ATTESTATION_VERIFIER = false;
export const REGISTRANT_SEED_ENABLED = false;
export const RECOVERY_BRANCH_PROOF_ENABLED = true;
export const SEALED_PAYLOAD_PROOF_ENABLED = false;
EOF
echo "[d26a-local] RECOVERY_BRANCH_PROOF_ENABLED=true"

adb ${ADBD} reverse tcp:8081 tcp:8081 || true
adb ${ADBD} shell input keyevent KEYCODE_WAKEUP || true
adb ${ADBD} shell am force-stop "${PACKAGE}"
adb ${ADBD} logcat -c
adb ${ADBD} shell monkey -p "${PACKAGE}" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1

echo "[d26a-local] ============================================================"
echo "[d26a-local] ACTION REQUIRED on ${SERIAL}: satisfy the credential prompt with the DEVICE"
echo "[d26a-local] CREDENTIAL (PIN / pattern / password) — NOT a fingerprint."
echo "[d26a-local] Waiting up to ${VERDICT_TIMEOUT}s for the verdict ..."
echo "[d26a-local] ============================================================"

VERDICT=""
start_epoch=$(date +%s)
while [ "$(( $(date +%s) - start_epoch ))" -lt "${VERDICT_TIMEOUT}" ]; do
  VERDICT="$(adb ${ADBD} logcat -d 2>/dev/null | grep -o 'D-26A LOCAL VERDICT: [A-Z-]*' | tail -1 || true)"
  [ -n "${VERDICT}" ] && break
  sleep 5
done

if [ -z "${VERDICT}" ]; then
  echo "[d26a-local] LEG d26a-local-verdict: FAIL — no verdict within ${VERDICT_TIMEOUT}s"
  exit 1
fi
echo "[d26a-local] ${VERDICT}"

# ── Branch assertion, MEASURED from the OS, not inferred from the SDK ────────
# API 30+ is the only branch that still exists (D-26a RESCOPED 2026-08-21): BiometricPrompt
# starts no confirm-device-credential activity, so its ABSENCE is the correct assertion there.
# Below API 30 there is nothing left to measure — recovery is unsupported by decision, and the
# runner is expected to report UNSUPPORTED-OS rather than exercising any branch at all.
case "${VERDICT}" in
  *PRECONDITION-UNMET*)
    echo "[d26a-local] branch assertion SKIPPED — the branch was never reached, so presence or"
    echo "[d26a-local]   absence of the activity says nothing."
    echo "[d26a-local] LEG d26a-local: NOT-EXERCISED"
    exit 2 ;;
esac

CDC_HITS="$(adb ${ADBD} logcat -d 2>/dev/null | grep -ci 'CONFIRM_DEVICE_CREDENTIAL' || true)"
BRANCH_OK=1
if [ "${SDK}" -lt 30 ] 2>/dev/null; then
  echo "[d26a-local] LEG d26a-branch: N/A — SDK=${SDK} (<30); on-device recovery is unsupported below API 30 by decision (2026-08-21, D-26a RESCOPED), so the local runner is expected to report UNSUPPORTED-OS on this device rather than exercise any branch. This is not a PASS or a FAIL."
else
  if [ "${CDC_HITS}" -eq 0 ]; then
    echo "[d26a-local] LEG d26a-branch: PASS — SDK=${SDK} (>=30) and no CONFIRM_DEVICE_CREDENTIAL activity, consistent with the BiometricPrompt DEVICE_CREDENTIAL branch"
  else
    echo "[d26a-local] LEG d26a-branch: FAIL — SDK=${SDK} (>=30) but a CONFIRM_DEVICE_CREDENTIAL activity WAS observed; the wrong branch ran"
    BRANCH_OK=0
  fi
fi

# PRECONDITION-UNMET is NOT a failure of D-26a — the branch was never reached, so the leg is
# NOT-EXERCISED and claims nothing either way. UNSUPPORTED-OS is likewise not a failure — the
# branch does not exist on this OS version by decision (D-26a RESCOPED 2026-08-21). Exit
# non-zero-but-distinguishable codes so a caller can tell all the outcomes apart, and so neither a
# blocked run nor an unsupported-OS run is ever recorded as a refutation.
case "${VERDICT}" in
  *PRECONDITION-UNMET*)
    echo "[d26a-local] LEG d26a-local: NOT-EXERCISED — a precondition blocked the branch (see the raw"
    echo "[d26a-local]   error under [d26a-local] in logcat). This claims NOTHING about D-26a."
    exit 2 ;;
  *UNSUPPORTED-OS*)
    echo "[d26a-local] LEG d26a-local: N/A — recovery is unsupported below API 30 by decision"
    echo "[d26a-local]   (2026-08-21, D-26a RESCOPED). This claims NOTHING about D-26a on this device."
    exit 3 ;;
  *PASS*)
    if [ "${BRANCH_OK}" -eq 1 ]; then exit 0; fi
    exit 1 ;;
  *)  exit 1 ;;
esac
