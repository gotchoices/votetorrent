#!/usr/bin/env bash
#
# run-replication-proof.sh
#
# Purpose  : P2P-06 replication proof — Peer A (emulator-5554) writes a network
#            record, the always-on drone replicates it, and Peer B (emulator-5556)
#            reads it back.  Emits PASS|FAIL via logcat verdict line.
#
# Usage    : ./scripts/run-replication-proof.sh
#
# Prerequisites:
#   - adb must be in PATH (Android SDK Platform Tools)
#   - Both emulators (emulator-5554 and emulator-5556) must be running and the
#     app (org.votetorrent.authority) must be installed on each.
#   - The p2p-probe-host drone must be running with strand hosting enabled:
#       yarn install   # once, at the repo root
#       STRAND_ID=<networkHash> node packages/p2p-probe-host/drone.mjs
#   - CONTROL_ADDR in apps/VoteTorrentAuthority/src/engines/dial-probe.ts must
#     be updated with the drone's ws multiaddr from its READY line.
#   - Set REPLICATION_PROOF_ENABLED=true is done by this script before bundling
#     and restored in the EXIT trap below.
#
# Exit codes:
#   0  — [replication-proof] REPLICATION VERDICT: PASS captured from logcat
#   1  — REPLICATION VERDICT: FAIL captured, or no verdict within the timeout
#
# Failure modes:
#   Drone not running / wrong STRAND_ID  — Peer B reads nothing
#   Bootstrap mode on both peers (no sync)  — write visible on A only
#

set -euo pipefail

# WR-12 (17-REVIEW): anchor cwd to repo root so flag-file paths and EXIT-trap
# restores work regardless of the directory from which the script is invoked.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# IN-21 (17-REVIEW): shared logcat wait/poll helper (wait_for_logcat_line).
. scripts/lib/logcat-wait.sh

PACKAGE="org.votetorrent.authority"
# replication-proof logs via multi-arg console.log('[replication-proof]', ...) —
# RN logcat renders each arg quoted and comma-separated. Patterns tolerate the
# quote/comma between tag and message (same as run-dial-probe.sh).
VERDICT_TAG='\[replication-proof\].*========== REPLICATION VERDICT'
PROBE_MARKER='\[replication-proof\].*starting'
LOGCAT_TIMEOUT=180  # seconds: longer than dial-probe to account for two emulators +
                    # replication latency (A writes → drone → B reads)
MARKER_TIMEOUT=90   # seconds to wait for [replication-proof] starting marker on Peer A
FLAG_FILE="apps/VoteTorrentAuthority/src/engines/proof-flags.generated.ts"

# PROBE_STARTED tracks whether Peer A reached the [replication-proof] starting marker
# BEFORE the EXIT trap fires.  Initialized to 0 here (before the trap is installed)
# so restore_flags() can emit a warning if it fires before the probe-start was observed
# (mirrors the race documented in 17-REVIEW for run-dial-probe.sh).
PROBE_STARTED=0

# WR-03 (17-REVIEW): restore the committed default-false flag file on EXIT
# (PASS, FAIL, or set -e abort) so the probe-enabled override never leaks
# into the next dev launch or into a commit.  T-22-01 mitigation: EXIT trap
# always restores flags; committed default is REPLICATION_PROOF_ENABLED=false.
restore_flags() {
  if [ "${PROBE_STARTED}" -eq 0 ]; then
    echo "[run-replication-proof] WARNING: restoring flags before [replication-proof] starting observed — app may have fetched a flags-disabled bundle (probe silent no-op); re-run" >&2
  fi
  # IN-12 (17-REVIEW): git owns the committed default-false content — restore
  # from the index so an edit to the committed file cannot leave this script
  # regenerating stale content.  The heredoc below is a FALLBACK only (e.g.
  # git unavailable or the file untracked).
  if git checkout -- "${FLAG_FILE}" 2>/dev/null; then
    return 0
  fi
  echo "[run-replication-proof] WARNING: git checkout restore failed — writing fallback default-false content (may be stale vs the committed file)" >&2
  cat > "${FLAG_FILE}" << 'EOF'
// proof-flags.generated.ts — committed default fallback (all flags false).
// The run scripts (run-vtest02.sh, run-dial-probe.sh, run-replication-proof.sh) overwrite
// this file before bundling and restore the default-false content in an EXIT trap.
// NOTE: this file IS git-tracked (gitignore would be a no-op for a tracked
// file — WR-02, 17-REVIEW). If a run script is killed before its EXIT trap
// fires, `git status` will show this file modified: restore it with
// `git checkout -- apps/VoteTorrentAuthority/src/engines/proof-flags.generated.ts`
// and NEVER commit an enabled-flag override.
// Static import ONLY — dynamic require() breaks Metro (Phase 16-07 lesson).
export const PROOF_ENABLED = false;
export const DIAL_PROBE_ENABLED = false;
export const REPLICATION_PROOF_ENABLED = false;
EOF
}

# WR-21: install the trap only now — immediately before the first flag-file
# write, the first action the trap exists to undo.
trap restore_flags EXIT

# 1. Write flag file: REPLICATION_PROOF_ENABLED=true, others false.
#    Metro picks up the change on the next bundle request (force-stop clears stale JS cache).
cat > "${FLAG_FILE}" << 'EOF'
// run-replication-proof.sh generated override — do not commit (EXIT trap restores default).
// Static import only — dynamic require() breaks Metro (Phase 16-07 lesson).
export const PROOF_ENABLED = false;
export const DIAL_PROBE_ENABLED = false;
export const REPLICATION_PROOF_ENABLED = true;
EOF

echo "[run-replication-proof] Flag file updated: REPLICATION_PROOF_ENABLED=true"

# 2. Force-stop → relaunch Peer A (emulator-5554) so Metro re-evaluates the updated flag file.
echo "[run-replication-proof] Force-stopping ${PACKAGE} on emulator-5554 ..."
adb -s emulator-5554 shell am force-stop "${PACKAGE}"
sleep 2

# CR-01: clear the logcat ring buffer on BOTH emulators so a verdict line from a
# previous run cannot be picked up as a stale PASS/FAIL.
adb -s emulator-5554 logcat -c
adb -s emulator-5556 logcat -c

echo "[run-replication-proof] Relaunching ${PACKAGE} on emulator-5554 (Peer A — writer) ..."
adb -s emulator-5554 shell monkey -p "${PACKAGE}" -c android.intent.category.LAUNCHER 1

# 3. Force-stop → relaunch Peer B (emulator-5556).
echo "[run-replication-proof] Force-stopping ${PACKAGE} on emulator-5556 ..."
adb -s emulator-5556 shell am force-stop "${PACKAGE}"
sleep 2

echo "[run-replication-proof] Relaunching ${PACKAGE} on emulator-5556 (Peer B — reader) ..."
adb -s emulator-5556 shell monkey -p "${PACKAGE}" -c android.intent.category.LAUNCHER 1

# 4. Wait for the probe-start marker on Peer A BEFORE arming the verdict countdown.
#    This marker is emitted by the replication-proof code ONLY after Metro has served
#    the enabled bundle and the gated probe code path is executing on emulator-5554.
echo "[run-replication-proof] Waiting up to ${MARKER_TIMEOUT}s for [replication-proof] starting marker on emulator-5554 ..."
MARKER_LINE=$(wait_for_logcat_line "${PROBE_MARKER}" "${MARKER_TIMEOUT}" "[run-replication-proof]" "marker")

if [ -z "${MARKER_LINE}" ]; then
  echo "[run-replication-proof] ERROR: [replication-proof] never started on Peer A — Metro rebundle likely still in flight or flags-disabled bundle served; re-run" >&2
  exit 1
fi

echo "[run-replication-proof] Probe-start marker seen on Peer A: ${MARKER_LINE}"
PROBE_STARTED=1

# 5. Poll logcat (default device = emulator-5554, Peer A) for the REPLICATION VERDICT line.
#    The proof code on Peer A writes the network record, waits for drone replication,
#    then reads from Peer B via the CadreNode replication path and emits the verdict.
echo "[run-replication-proof] Polling logcat for REPLICATION VERDICT (${LOGCAT_TIMEOUT}s timeout) ..."
VERDICT_LINE=$(wait_for_logcat_line "${VERDICT_TAG}" "${LOGCAT_TIMEOUT}" "[run-replication-proof]" "verdict")

if [ -z "${VERDICT_LINE}" ]; then
  echo "[run-replication-proof] ERROR: no REPLICATION VERDICT line captured within ${LOGCAT_TIMEOUT}s — FAIL"
  exit 1
fi

echo "[run-replication-proof] Captured: ${VERDICT_LINE}"

# T-22-02 (accept): logcat verdict text is dev-only; not a production trust path.
if echo "${VERDICT_LINE}" | grep -q "FAIL"; then
  echo "[run-replication-proof] ========== REPLICATION VERDICT: FAIL =========="
  exit 1
fi

echo "[run-replication-proof] ========== REPLICATION VERDICT: PASS =========="
exit 0
