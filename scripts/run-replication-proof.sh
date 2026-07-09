#!/usr/bin/env bash
#
# run-replication-proof.sh
#
# Purpose  : P2P-06 symmetric replication proof.
#            Step 1 — Peer A (emulator-5554) boots FIRST solo in bootstrap mode
#            (no drone, no peer). Its replication-proof-runner creates the proof
#            strand and logs [replication-proof] strandId=<hash>.
#            Step 2 — The script captures the hash and launches the drone (Node 22)
#            with STRAND_ID=<hash>; the drone's READY ws multiaddr is injected into
#            the generated config so the runner connects automatically (D-07).
#            Step 3/4 — Both peers are force-stopped, logcat cleared, then relaunched
#            networked for the real symmetric proof run.
#            D-05 (peerId stability): captured before/after a Peer-A relaunch within
#            the networked run; asserts equality.
#            D-06 (peers>=1): the peers= marker is polled and its count asserted.
#            D-01 (both-PASS): BOTH emulators must emit REPLICATION VERDICT: PASS.
#
# Usage    : ./scripts/run-replication-proof.sh
#            Env vars (all optional):
#              FRESH_EMULATOR=1|0  — (default 1) wipe both emulators to a clean app
#                                    slate (pm clear + a votetorrent-* LevelDB store
#                                    wipe, D-11 idiom) before Step 1. Set to 0 to skip
#                                    (e.g. re-running immediately after a clean pass).
#
# 38-07 (route-forward from 38-05, all 8 prior runs died at a force-stop/relaunch
# marker-timeout checkpoint): checkpoint marker timeouts are raised (see
# MARKER_TIMEOUT/STRAND_TIMEOUT/DRONE_READY_TIMEOUT below), the D-05 Peer-A relaunch
# and the networked both-peer relaunch route through a local `relaunch_and_wait`
# helper that retries the force-stop/relaunch once (2 attempts total) on a transient
# marker miss instead of `set -e`-aborting the whole run, and the run starts from the
# FRESH_EMULATOR precondition above.
#
# Prerequisites:
#   - adb must be in PATH (Android SDK Platform Tools)
#   - Both emulators (emulator-5554 and emulator-5556) must be running and the
#     app (org.votetorrent.authority) must be installed on each.
#   - nvm must be available with Node 22 (drone.mjs requires Promise.withResolvers).
#   - The drone and CONTROL_ADDR injection are now automated — no manual steps needed.
#
# Exit codes:
#   0  — REPLICATION VERDICT: PASS (both peers) — both emulators passed
#   1  — REPLICATION VERDICT: FAIL, missing strandId/READY addr, D-05 mismatch,
#         D-06 peer count < 1, or no verdict within timeout (incl. after both
#         relaunch_and_wait attempts miss their marker)
#

set -euo pipefail

# WR-12 (17-REVIEW): anchor cwd to repo root so flag-file paths and EXIT-trap
# restores work regardless of the directory from which the script is invoked.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# IN-21 (17-REVIEW): shared logcat wait/poll helper (wait_for_logcat_line).
. scripts/lib/logcat-wait.sh

PACKAGE="org.votetorrent.authority"

# 38-07: local relaunch-retry helper — kept in THIS script (not logcat-wait.sh,
# which run-vtest02.sh also sources; editing the shared helper risks a D-11
# solo/strand regression). All 8 prior 38-05 runs died at a force-stop/relaunch
# marker-timeout checkpoint (`set -e`-abort on the FIRST miss). This wraps a
# force-stop + logcat-clear + relaunch + wait_for_logcat_line cycle under a
# temporarily relaxed `set +e` so a transient marker-timeout returns non-zero
# instead of aborting, then retries the whole cycle once more (2 attempts total)
# before giving up.
#
# Usage: relaunch_and_wait SERIAL PATTERN TIMEOUT_S WHAT [SECOND_SERIAL]
#   SERIAL         — the adb serial whose marker is waited on (e.g. emulator-5554)
#   PATTERN        — logcat pattern passed to wait_for_logcat_line
#   TIMEOUT_S      — seconds to wait per attempt
#   WHAT           — human label for wait_for_logcat_line's own error messages
#   SECOND_SERIAL  — optional: also force-stop/clear/relaunch this serial on every
#                    attempt (the networked both-peer relaunch needs both devices up
#                    together before either's marker is meaningful), but only SERIAL's
#                    marker is waited on.
#
# Echoes the matched logcat line to stdout (same contract as wait_for_logcat_line);
# prints nothing (empty) if both attempts miss — callers must check for an empty
# result exactly as they already do for a bare wait_for_logcat_line call.
relaunch_and_wait() {
  local serial="$1" pattern="$2" timeout_s="$3" what="$4" second_serial="${5:-}"
  local attempt line status
  for attempt in 1 2; do
    echo "[run-replication-proof] relaunch_and_wait: attempt ${attempt}/2 for '${what}' on ${serial}$([ -n "${second_serial}" ] && echo " (+ ${second_serial})") ..." >&2
    adb -s "${serial}" shell am force-stop "${PACKAGE}" >&2
    if [ -n "${second_serial}" ]; then
      adb -s "${second_serial}" shell am force-stop "${PACKAGE}" >&2
    fi
    sleep 2
    adb -s "${serial}" logcat -c >&2
    if [ -n "${second_serial}" ]; then
      adb -s "${second_serial}" logcat -c >&2
    fi
    adb -s "${serial}" shell monkey -p "${PACKAGE}" -c android.intent.category.LAUNCHER 1 >&2
    if [ -n "${second_serial}" ]; then
      adb -s "${second_serial}" shell monkey -p "${PACKAGE}" -c android.intent.category.LAUNCHER 1 >&2
    fi
    set +e
    line=$(wait_for_logcat_line "${pattern}" "${timeout_s}" "[run-replication-proof]" "${what}" "-s ${serial}")
    status=$?
    set -e
    if [ -n "${line}" ]; then
      printf '%s\n' "${line}"
      return 0
    fi
    echo "[run-replication-proof] relaunch_and_wait: attempt ${attempt}/2 MISSED '${what}' on ${serial} (status=${status})" >&2
  done
  echo "[run-replication-proof] relaunch_and_wait: both attempts missed '${what}' on ${serial} — giving up" >&2
  return 0
}
# replication-proof logs via multi-arg console.log('[replication-proof]', ...) —
# RN logcat renders each arg quoted and comma-separated. Patterns tolerate the
# quote/comma between tag and message (same as run-dial-probe.sh).
VERDICT_TAG='\[replication-proof\].*========== REPLICATION VERDICT'
PROBE_MARKER='\[replication-proof\].*starting'
STRAND_ID_MARKER='\[replication-proof\].*strandId='
PEER_ID_MARKER='\[replication-proof\].*peerId='
PEERS_MARKER='\[replication-proof\].*peers='
# D-09: relay-reservation READY marker (P2P-08). Gates the START of the networked
# replication run + every post-relaunch continuation (D-10) — the runner emits this
# unconditionally (true/false) after a bounded getMultiaddrs()/p2p-circuit poll.
RELAY_READY_MARKER='\[replication-proof\].*relayReservation='
LOGCAT_TIMEOUT=180  # seconds: longer than dial-probe to account for two emulators +
                    # replication latency (A writes → drone → B reads)
MARKER_TIMEOUT=180  # seconds to wait for [replication-proof] starting marker
                    # (38-07: raised from 90 — the D-05/networked-relaunch checkpoints
                    #  that killed all 8 prior 38-05 runs need headroom for a Metro
                    #  rebundle race + slow long-lived-emulator relaunch, on top of the
                    #  new relaunch_and_wait retry)
STRAND_TIMEOUT=240  # seconds to wait for strandId= marker from bootstrap-mode Peer A
                    # (38-07: raised from 120 — was bumped from 60 in 38-04 for the
                    #  always-on relay-reservation poll + slow strand materialization;
                    #  raised again for the same long-lived-emulator slowness that
                    #  stalled the D-05 checkpoint in 38-05)
DRONE_READY_TIMEOUT=60  # seconds to wait for drone READY line (38-07: raised from 30)
STRAND_PEERS_TIMEOUT=300  # seconds to wait for the REPL-01 strandPeers= marker (38-14:
                    # dedicated timeout, raised above LOGCAT_TIMEOUT=180 — 38-13 observed
                    # the write-phase strandPeers= emit at ~183s, ~3s AFTER the shared
                    # LOGCAT_TIMEOUT expired, so the script died before reaching the
                    # both-peer verdict poll and the trailing D-08 drone-side log capture)
FLAG_FILE="apps/VoteTorrentAuthority/src/engines/proof-flags.generated.ts"
# The generated config file that carries CONTROL_ADDR for the replication proof runner.
# The runner reads CONTROL_ADDR from this file (D-07 automated injection); restored on EXIT.
CONFIG_FILE="apps/VoteTorrentAuthority/src/engines/replication-proof-runner.ts"

# Extract a marker's VALUE from a multi-arg console.log logcat line. The runner emits
# markers as `L('key=', value)`, so logcat renders `'key=', 'strValue'` (strings) or
# `'key=', 42` (numbers) — the value is a SEPARATE quoted/bare token after the marker,
# not space-adjacent. Pull the first token after `<key>=`, stripping surrounding
# quotes/commas/whitespace. Handles both quoted-string and bare-number values.
# Usage: extract_marker_value "<logcat line>" "<key>"   (key WITHOUT the trailing '=')
extract_marker_value() {
  printf '%s\n' "$1" \
    | sed -E "s/.*${2}=//" \
    | sed -E "s/^[',[:space:]]+//" \
    | sed -E "s/[',[:space:]].*//"
}

# PROBE_STARTED: 0 until [replication-proof] starting is observed on Peer A (networked run).
# DRONE_PID: set when the drone is launched; used to kill it in restore_flags().
PROBE_STARTED=0
DRONE_PID=""
STRAND_ID=""
# D-08: initialized empty so restore_flags() (which may run under `set -u` before the
# drone is ever launched, e.g. on a Step-1 failure) can safely test it unset.
DRONE_LOG=""
# 38-05 (D-04 n=4 topology): SECOND drone (drone-B) state — mirrors DRONE_PID/DRONE_LOG.
# Initialized empty so restore_flags() can safely test them unset (e.g. drone-B never
# launched because drone-A failed first).
DRONE_B_PID=""
DRONE_B_LOG=""

# WR-03 (17-REVIEW): restore the committed default-false flag file on EXIT
# (PASS, FAIL, or set -e abort) so the probe-enabled override never leaks
# into the next dev launch or into a commit. T-23-04-01 mitigation.
# Also kills the drone (T-23-04-02: orphaned drone holds the ws port).
restore_flags() {
  if [ -n "${DRONE_PID}" ]; then
    kill "${DRONE_PID}" 2>/dev/null || true
    echo "[run-replication-proof] Drone PID ${DRONE_PID} killed" >&2
  fi
  # 38-05 (D-04 n=4 topology): kill drone-B alongside drone-A.
  if [ -n "${DRONE_B_PID}" ]; then
    kill "${DRONE_B_PID}" 2>/dev/null || true
    echo "[run-replication-proof] Drone-B PID ${DRONE_B_PID} killed" >&2
  fi
  # D-08 (diagnose-first): DRONE_LOG is deliberately retained through the ENTIRE run
  # (no rm -f before the verdict poll) so the drone's real cluster-protocol error is
  # captured, not discarded. This EXIT trap is the ONLY place it is removed.
  if [ -n "${DRONE_LOG}" ]; then
    rm -f "${DRONE_LOG}" 2>/dev/null || true
  fi
  # 38-05: drone-B's log is retained through the run the same way (only removed here).
  if [ -n "${DRONE_B_LOG}" ]; then
    rm -f "${DRONE_B_LOG}" 2>/dev/null || true
  fi
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
export const USE_LOCAL_DB_FACTORY = false;
EOF
}

# WR-21: install the trap only now — immediately before the first flag-file
# write, the first action the trap exists to undo.
trap restore_flags EXIT

# ── Fresh-emulator precondition (38-07 / D-05 route-forward) ─────────────────
# All 8 prior 38-05 runs died at a force-stop/relaunch marker-timeout checkpoint;
# long-lived emulators accumulate wedged app/LevelDB state that makes Metro
# rebundle races and relaunch markers flakier over successive runs
# (38-05-SUMMARY.md "Environmental flakiness"). Start every run from a genuinely
# fresh app slate on BOTH emulators: `pm clear` (mirrors the 38-05 de-wedge) THEN
# an explicit `votetorrent-*` LevelDB store wipe via `run-as ... rm -rf` (mirrors
# the D-11 reset idiom in run-vtest02.sh — defense-in-depth in case `pm clear`
# leaves residue; per-network isolation memory: a shared/stale LevelDB handle
# contaminates state across runs). Gated behind FRESH_EMULATOR so a caller can
# skip it (e.g. re-running immediately after a clean pass).
FRESH_EMULATOR="${FRESH_EMULATOR:-1}"
if [ "${FRESH_EMULATOR}" = "1" ]; then
  echo "[run-replication-proof] Fresh-emulator precondition: pm clear + votetorrent-* LevelDB wipe on both emulators (FRESH_EMULATOR=1) ..."
  for serial in emulator-5554 emulator-5556; do
    adb -s "${serial}" shell pm clear "${PACKAGE}" > /dev/null 2>&1 || true
    adb -s "${serial}" shell run-as "${PACKAGE}" \
      find /data/data/"${PACKAGE}"/files -name "votetorrent-*" -exec rm -rf {} + 2>/dev/null || true
  done
  echo "[run-replication-proof] Fresh-emulator precondition complete."
else
  echo "[run-replication-proof] Fresh-emulator precondition SKIPPED (FRESH_EMULATOR=0)."
fi

# ── STEP 0: Write the enabled flag file ──────────────────────────────────────
# Metro picks up the change on the next bundle request (force-stop clears stale JS cache).
cat > "${FLAG_FILE}" << 'EOF'
// run-replication-proof.sh generated override — do not commit (EXIT trap restores default).
// Static import only — dynamic require() breaks Metro (Phase 16-07 lesson).
export const PROOF_ENABLED = false;
export const DIAL_PROBE_ENABLED = false;
export const REPLICATION_PROOF_ENABLED = true;
export const USE_LOCAL_DB_FACTORY = false;
EOF
echo "[run-replication-proof] Flag file updated: REPLICATION_PROOF_ENABLED=true"

# ── STEP 1: BOOTSTRAP-MODE FIRST BOOT (Peer A only, solo, no drone) ──────────
# Peer A boots solo without the drone running. The runner's createStrandDbFactory
# selects CF-02 bootstrap mode automatically (no peers reachable). It creates the
# proof strand and logs [replication-proof] strandId=<hash>.
echo "[run-replication-proof] Step 1: bootstrap-mode first boot — Peer A solo (no drone) ..."
adb -s emulator-5554 shell am force-stop "${PACKAGE}"
sleep 2
# Pitfall 4: clear stale logcat ring buffer BEFORE the bootstrap-mode relaunch.
adb -s emulator-5554 logcat -c
echo "[run-replication-proof] Relaunching ${PACKAGE} on emulator-5554 (bootstrap mode, solo) ..."
adb -s emulator-5554 shell monkey -p "${PACKAGE}" -c android.intent.category.LAUNCHER 1

# Wait for the proof-start marker on Peer A (proves metro served the enabled bundle).
echo "[run-replication-proof] Waiting up to ${MARKER_TIMEOUT}s for [replication-proof] starting marker on emulator-5554 ..."
BOOTSTRAP_MARKER_LINE=$(wait_for_logcat_line "${PROBE_MARKER}" "${MARKER_TIMEOUT}" "[run-replication-proof]" "bootstrap-marker" "-s emulator-5554")
if [ -z "${BOOTSTRAP_MARKER_LINE}" ]; then
  echo "[run-replication-proof] ERROR: [replication-proof] never started on Peer A (bootstrap mode) — Metro rebundle likely in flight or flags-disabled bundle served; re-run" >&2
  exit 1
fi
echo "[run-replication-proof] Bootstrap-mode start marker seen: ${BOOTSTRAP_MARKER_LINE}"
# Set PROBE_STARTED=1 when starting marker observed (Pitfall 5 sentinel).
PROBE_STARTED=1

# ── STEP 2: CAPTURE the strand hash from Peer A's bootstrap-mode logcat ──────
# The runner logs [replication-proof] strandId=<hash> after createStrandDbFactory.
echo "[run-replication-proof] Waiting up to ${STRAND_TIMEOUT}s for strandId= marker on emulator-5554 ..."
STRAND_LINE=$(wait_for_logcat_line "${STRAND_ID_MARKER}" "${STRAND_TIMEOUT}" "[run-replication-proof]" "strandId" "-s emulator-5554")
if [ -z "${STRAND_LINE}" ]; then
  echo "[run-replication-proof] ERROR: strandId= marker never appeared — runner may have crashed; check logcat" >&2
  exit 1
fi
echo "[run-replication-proof] Captured strandId line: ${STRAND_LINE}"
STRAND_ID=$(extract_marker_value "${STRAND_LINE}" "strandId")
if [ -z "${STRAND_ID}" ]; then
  echo "[run-replication-proof] ERROR: could not extract strandId from: ${STRAND_LINE}" >&2
  exit 1
fi
echo "[run-replication-proof] STRAND_ID captured: ${STRAND_ID}"

# ── STEP 3: LAUNCH THE DRONE with STRAND_ID (D-07 automated injection) ───────
# Source nvm, run drone under Node 22. Capture READY line and inject ws multiaddr
# into the runner's generated config so it connects automatically.
echo "[run-replication-proof] Step 3: launching drone with STRAND_ID=${STRAND_ID} under Node 22 ..."
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "${NVM_DIR}/nvm.sh" ]; then
  # shellcheck source=/dev/null
  \. "${NVM_DIR}/nvm.sh"
else
  echo "[run-replication-proof] ERROR: nvm not found at ${NVM_DIR}/nvm.sh — install nvm or ensure NVM_DIR is set" >&2
  exit 1
fi

# Resolve the Node 22 binary path in the FOREGROUND. `nvm exec 22 ... &` fails with
# "v22 not installed" when backgrounded (nvm's version resolution breaks in a `&`
# subshell), so we resolve the explicit binary with `nvm which 22` here and background
# that binary directly — no nvm call in the backgrounded subshell.
NODE22=$(nvm which 22 2>/dev/null || true)
if [ -z "${NODE22}" ] || [ ! -x "${NODE22}" ]; then
  echo "[run-replication-proof] ERROR: Node 22 not found via 'nvm which 22' — run 'nvm install 22'" >&2
  exit 1
fi

# D-08 (diagnose-first): DEBUG= arms the drone's namespace-gated cluster-protocol error
# logging (cluster/service.js's this.log.error('error handling cluster protocol message...'))
# — OFF by default otherwise. Namespace corrected per 38-02-SUMMARY.md's runtime finding
# (createLogger's actual base is optimystic:db-p2p:*, NOT the bare db-p2p:* RESEARCH.md cited).
# DRONE_LOG is retained through the FULL run (no rm -f below) — only the EXIT trap removes it.
DRONE_LOG=$(mktemp /tmp/drone-full-run-XXXXXX.log)
DEBUG="optimystic:db-p2p:*:error,db-p2p:*:error,libp2p:*:error,sereus:cadre:*:error" STRAND_ID="${STRAND_ID}" "${NODE22}" packages/p2p-probe-host/drone.mjs > "${DRONE_LOG}" 2>&1 &
DRONE_PID=$!
echo "[run-replication-proof] Drone launched (PID ${DRONE_PID}, DEBUG= cluster-error logging armed), waiting for READY line ..."

# Wait for READY line in drone stdout, extract ws multiaddr.
DRONE_ADDR=""
STRAND_ADDR=""
ELAPSED=0
# Wait for BOTH the control addr (PROOF_WS_ADDR=) AND the strand addr
# (PROOF_STRAND_ADDR= or PROOF_STRAND_ADDR_MISSING) before reading the log.
# The drone emits PROOF_STRAND_ADDR= AFTER await node.addStrand(...) resolves,
# which is strictly later than PROOF_WS_ADDR=; a one-shot grep at the PROOF_WS_ADDR=
# break races and yields an empty STRAND_ADDR (Pitfall 3 guard).
# D-08: DRONE_LOG is NEVER rm -f'd here (or anywhere before the verdict poll) — it is
# retained through the full run so the real consensus-round cluster error is captured;
# the EXIT trap (restore_flags) is the ONLY place it is removed.
while [ "${ELAPSED}" -lt "${DRONE_READY_TIMEOUT}" ]; do
  if ! kill -0 "${DRONE_PID}" 2>/dev/null; then
    echo "[run-replication-proof] ERROR: drone process exited before emitting READY (PID ${DRONE_PID})" >&2
    cat "${DRONE_LOG}" >&2
    exit 1
  fi
  # Parse the machine-readable PROOF_WS_ADDR= line — NOT the human 'READY' instruction
  # line, which contains a literal /ip4/10.0.2.2/tcp/<PORT>/ws/p2p/<PEER_ID> TEMPLATE.
  if [ -z "${DRONE_ADDR}" ]; then
    ADDR_LINE=$(grep -m1 'PROOF_WS_ADDR=' "${DRONE_LOG}" 2>/dev/null || true)
    if [ -n "${ADDR_LINE}" ]; then
      DRONE_ADDR=$(echo "${ADDR_LINE}" | grep -o '/ip4/[^ ]*/ws/p2p/[^ ]*' || true)
    fi
  fi
  # Also wait for the strand-node address (emitted after addStrand resolves).
  if [ -n "${DRONE_ADDR}" ] && [ -z "${STRAND_ADDR}" ]; then
    STRAND_LINE_RAW=$(grep -m1 'PROOF_STRAND_ADDR' "${DRONE_LOG}" 2>/dev/null || true)
    if [ -n "${STRAND_LINE_RAW}" ]; then
      if echo "${STRAND_LINE_RAW}" | grep -q 'PROOF_STRAND_ADDR_MISSING'; then
        echo "[run-replication-proof] ERROR: drone strand node has no listen multiaddr (PROOF_STRAND_ADDR_MISSING)" >&2
        cat "${DRONE_LOG}" >&2
        exit 1
      fi
      STRAND_ADDR=$(echo "${STRAND_LINE_RAW}" | grep -o '/ip4/[^ ]*/ws/p2p/[^ ]*' || true)
      if [ -z "${STRAND_ADDR}" ]; then
        echo "[run-replication-proof] ERROR: PROOF_STRAND_ADDR= emitted but no valid multiaddr parsed" >&2
        cat "${DRONE_LOG}" >&2
        exit 1
      fi
      break
    fi
  fi
  sleep 1
  ELAPSED=$((ELAPSED + 1))
done
# D-08: the drone log is NOT removed here — both addresses have been captured (or timed
# out), but the log must survive through the real consensus round for the post-verdict
# cluster-error grep below. Only the EXIT trap removes DRONE_LOG.

if [ -z "${DRONE_ADDR}" ]; then
  echo "[run-replication-proof] ERROR: drone did not emit a READY ws multiaddr within ${DRONE_READY_TIMEOUT}s" >&2
  exit 1
fi
echo "[run-replication-proof] Drone READY addr: ${DRONE_ADDR}"

if [ -z "${STRAND_ADDR}" ]; then
  echo "[run-replication-proof] ERROR: drone did not emit PROOF_STRAND_ADDR= within ${DRONE_READY_TIMEOUT}s" >&2
  exit 1
fi
echo "[run-replication-proof] Drone strand addr: ${STRAND_ADDR}"

# ── STEP 3b: LAUNCH DRONE-B (38-05 / D-04 n=4 topology) ─────────────────────
# SECOND drone process, cross-bootstrapped to drone-A's control AND strand
# multiaddrs — exactly the wiring 38-02's two-drone-smoke.mjs proved (peerCount=3
# there; here it grows the strand cohort to n=4 alongside the 2 emulators).
# Cross-bootstrap uses the drone's own loopback (127.0.0.1) addrs, NOT the
# device-rewritten 10.0.2.2 addrs below — drone-A and drone-B are both host-side
# Node processes talking to each other directly over loopback (Pitfall 2: distinct
# host-loopback vs emulator-alias address spaces).
echo "[run-replication-proof] Step 3b: launching drone-B (cross-bootstrapped to drone-A) with STRAND_ID=${STRAND_ID} under Node 22 ..."
DRONE_B_LOG=$(mktemp /tmp/drone-b-full-run-XXXXXX.log)
DEBUG="optimystic:db-p2p:*:error,db-p2p:*:error,libp2p:*:error,sereus:cadre:*:error" \
  STRAND_ID="${STRAND_ID}" \
  DRONE_BOOTSTRAP_CONTROL_ADDR="${DRONE_ADDR}" \
  DRONE_BOOTSTRAP_STRAND_ADDR="${STRAND_ADDR}" \
  "${NODE22}" packages/p2p-probe-host/drone.mjs > "${DRONE_B_LOG}" 2>&1 &
DRONE_B_PID=$!
echo "[run-replication-proof] Drone-B launched (PID ${DRONE_B_PID}, DEBUG= cluster-error logging armed, cross-bootstrapped to drone-A), waiting for READY line ..."

DRONE_B_ADDR=""
STRAND_B_ADDR=""
ELAPSED=0
while [ "${ELAPSED}" -lt "${DRONE_READY_TIMEOUT}" ]; do
  if ! kill -0 "${DRONE_B_PID}" 2>/dev/null; then
    echo "[run-replication-proof] ERROR: drone-B process exited before emitting READY (PID ${DRONE_B_PID})" >&2
    cat "${DRONE_B_LOG}" >&2
    exit 1
  fi
  if [ -z "${DRONE_B_ADDR}" ]; then
    ADDR_LINE_B=$(grep -m1 'PROOF_WS_ADDR=' "${DRONE_B_LOG}" 2>/dev/null || true)
    if [ -n "${ADDR_LINE_B}" ]; then
      DRONE_B_ADDR=$(echo "${ADDR_LINE_B}" | grep -o '/ip4/[^ ]*/ws/p2p/[^ ]*' || true)
    fi
  fi
  if [ -n "${DRONE_B_ADDR}" ] && [ -z "${STRAND_B_ADDR}" ]; then
    STRAND_B_LINE_RAW=$(grep -m1 'PROOF_STRAND_ADDR' "${DRONE_B_LOG}" 2>/dev/null || true)
    if [ -n "${STRAND_B_LINE_RAW}" ]; then
      if echo "${STRAND_B_LINE_RAW}" | grep -q 'PROOF_STRAND_ADDR_MISSING'; then
        echo "[run-replication-proof] ERROR: drone-B strand node has no listen multiaddr (PROOF_STRAND_ADDR_MISSING)" >&2
        cat "${DRONE_B_LOG}" >&2
        exit 1
      fi
      STRAND_B_ADDR=$(echo "${STRAND_B_LINE_RAW}" | grep -o '/ip4/[^ ]*/ws/p2p/[^ ]*' || true)
      if [ -z "${STRAND_B_ADDR}" ]; then
        echo "[run-replication-proof] ERROR: drone-B PROOF_STRAND_ADDR= emitted but no valid multiaddr parsed" >&2
        cat "${DRONE_B_LOG}" >&2
        exit 1
      fi
      break
    fi
  fi
  sleep 1
  ELAPSED=$((ELAPSED + 1))
done
# D-08 (mirrored for drone-B): DRONE_B_LOG is NOT removed here — retained through the
# full run; only the EXIT trap removes it.

if [ -z "${DRONE_B_ADDR}" ]; then
  echo "[run-replication-proof] ERROR: drone-B did not emit a READY ws multiaddr within ${DRONE_READY_TIMEOUT}s" >&2
  exit 1
fi
echo "[run-replication-proof] Drone-B READY addr: ${DRONE_B_ADDR}"

if [ -z "${STRAND_B_ADDR}" ]; then
  echo "[run-replication-proof] ERROR: drone-B did not emit PROOF_STRAND_ADDR= within ${DRONE_READY_TIMEOUT}s" >&2
  exit 1
fi
echo "[run-replication-proof] Drone-B strand addr: ${STRAND_B_ADDR}"

# Inject the drone's ws multiaddr into the runner (D-07). The runner reads CONTROL_ADDR
# at the top of replication-proof-runner.ts; we rewrite just that constant line.
# The EXIT trap calls restore_flags which git-checkouts the FLAG_FILE; for CONFIG_FILE
# we rely on git checkout too (it is tracked). Add CONFIG_FILE to the EXIT restore.
# Capture the original runner for git-restore (it is tracked, git checkout -- restores it).
# shellcheck disable=SC2064
trap 'restore_flags; git checkout -- '"${CONFIG_FILE}"' 2>/dev/null || true' EXIT

# Replace the CONTROL_ADDR placeholder line in the runner with the real drone control address.
# The device emulator reaches the host at 10.0.2.2; replace the host IP in the addr.
# The drone emits its loopback (127.0.0.1) ws multiaddr; the Android emulator reaches the
# host loopback at 10.0.2.2. Rewrite either loopback/wildcard host to the emulator alias.
# Only drone-A's control addr is injected (CONTROL_ADDR) — the control network is
# unaffected by the n=4 strand-cohort growth (D-04); only the strand cohort (below)
# needs both drones' addresses.
DRONE_ADDR_FOR_DEVICE=$(echo "${DRONE_ADDR}" | sed -e 's|/ip4/127\.0\.0\.1/|/ip4/10.0.2.2/|' -e 's|/ip4/0\.0\.0\.0/|/ip4/10.0.2.2/|')
# Apply the same host-IP rewrite for the strand addresses (Pitfall 2: separate addresses, separate nodes).
STRAND_ADDR_FOR_DEVICE=$(echo "${STRAND_ADDR}" | sed -e 's|/ip4/127\.0\.0\.1/|/ip4/10.0.2.2/|' -e 's|/ip4/0\.0\.0\.0/|/ip4/10.0.2.2/|')
STRAND_B_ADDR_FOR_DEVICE=$(echo "${STRAND_B_ADDR}" | sed -e 's|/ip4/127\.0\.0\.1/|/ip4/10.0.2.2/|' -e 's|/ip4/0\.0\.0\.0/|/ip4/10.0.2.2/|')
# Use a temp marker that is not a regex special char.
python3 - "${CONFIG_FILE}" "${DRONE_ADDR_FOR_DEVICE}" "${STRAND_ADDR_FOR_DEVICE}" "${STRAND_B_ADDR_FOR_DEVICE}" << 'PYEOF'
import sys
path, control_addr, strand_addr, strand_addr_b = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
content = open(path).read()
import re
# Inject CONTROL_ADDR (control-network bootstrap — drone-A's control node).
new_content = re.sub(
    r"(const CONTROL_ADDR = ')[^']*(')",
    r"\g<1>" + control_addr + r"\g<2>",
    content,
    count=1,
)
# Inject STRAND_BOOTSTRAP_ADDR (strand-cohort bootstrap — drone-A's strand node).
# SEPARATE constant from CONTROL_ADDR — different libp2p nodes / ephemeral ports (Pitfall 2).
new_content = re.sub(
    r"(const STRAND_BOOTSTRAP_ADDR = ')[^']*(')",
    r"\g<1>" + strand_addr + r"\g<2>",
    new_content,
    count=1,
)
# 38-05 (D-04 n=4): inject STRAND_BOOTSTRAP_ADDR_B (strand-cohort bootstrap — drone-B's
# strand node) so the emulator's strand cohort dials BOTH voting-member drones.
new_content = re.sub(
    r"(const STRAND_BOOTSTRAP_ADDR_B = ')[^']*(')",
    r"\g<1>" + strand_addr_b + r"\g<2>",
    new_content,
    count=1,
)
open(path, 'w').write(new_content)
print(f"[run-replication-proof] CONTROL_ADDR in runner injected: {control_addr}")
print(f"[run-replication-proof] STRAND_BOOTSTRAP_ADDR in runner injected: {strand_addr}")
print(f"[run-replication-proof] STRAND_BOOTSTRAP_ADDR_B in runner injected: {strand_addr_b}")
PYEOF

# ── STEP 4: RELAUNCH BOTH PEERS NETWORKED for the symmetric proof run ─────────
# Both peers are stopped, logcat cleared (Pitfall 4), then relaunched. With the drone
# now reachable, createStrandDbFactory selects CF-02 networked mode on both peers.
PROBE_STARTED=0  # reset sentinel before the real networked run

# 38-07: force-stop + clear logcat + relaunch BOTH peers, waiting for Peer A's
# starting marker, routed through relaunch_and_wait (bounded 2-attempt retry —
# re-issues the force-stop/relaunch on BOTH devices if the marker misses). This
# is one of the exact checkpoints where prior 38-05 runs died on a transient
# Metro-rebundle/emulator-slowness marker timeout.
echo "[run-replication-proof] Step 4: relaunching BOTH peers networked (via relaunch_and_wait, bounded retry) ..."
MARKER_LINE=$(relaunch_and_wait "emulator-5554" "${PROBE_MARKER}" "${MARKER_TIMEOUT}" "marker" "emulator-5556")
if [ -z "${MARKER_LINE}" ]; then
  echo "[run-replication-proof] ERROR: [replication-proof] never started on Peer A (networked run) after 2 relaunch_and_wait attempts — Metro rebundle likely in flight; re-run" >&2
  exit 1
fi
echo "[run-replication-proof] Networked start marker seen on Peer A: ${MARKER_LINE}"
PROBE_STARTED=1

# ── D-09: relay-READY gate — gates the START of the replication run on the relay
# reservation being observed on BOTH peers (P2P-08). Both emulators run the same
# replication-proof-runner.ts, so both independently poll getMultiaddrs()/p2p-circuit
# and emit relayReservation= (true|false) unconditionally — wait for the marker line
# itself (its presence, not its boolean value) on each serial, mirroring the existing
# PROBE_MARKER/STRAND_ID_MARKER gating shape.
echo "[run-replication-proof] D-09: waiting for relayReservation= marker on emulator-5554 (networked run) ..."
RELAY_LINE_A=$(wait_for_logcat_line "${RELAY_READY_MARKER}" "${MARKER_TIMEOUT}" "[run-replication-proof]" "relay-ready-A" "-s emulator-5554")
if [ -z "${RELAY_LINE_A}" ]; then
  echo "[run-replication-proof] ERROR: relayReservation= marker never appeared on emulator-5554 (networked run) — relay reservation not established (P2P-08)" >&2
  exit 1
fi
echo "[run-replication-proof] D-09: relay-READY on emulator-5554: ${RELAY_LINE_A}"
echo "[run-replication-proof] D-09: waiting for relayReservation= marker on emulator-5556 (networked run) ..."
RELAY_LINE_B=$(wait_for_logcat_line "${RELAY_READY_MARKER}" "${MARKER_TIMEOUT}" "[run-replication-proof]" "relay-ready-B" "-s emulator-5556")
if [ -z "${RELAY_LINE_B}" ]; then
  echo "[run-replication-proof] ERROR: relayReservation= marker never appeared on emulator-5556 (networked run) — relay reservation not established (P2P-08)" >&2
  exit 1
fi
echo "[run-replication-proof] D-09: relay-READY on emulator-5556: ${RELAY_LINE_B}"

# ── D-05: peerId stability — capture before/after a Peer-A force-stop relaunch ─
# Peer A must emit the same peerId before and after a force-stop (P2P-04 / Test 4).
echo "[run-replication-proof] D-05: capturing peerId on Peer A before force-stop ..."
PEER_ID_LINE_BEFORE=$(wait_for_logcat_line "${PEER_ID_MARKER}" "${MARKER_TIMEOUT}" "[run-replication-proof]" "peerId-before" "-s emulator-5554")
if [ -z "${PEER_ID_LINE_BEFORE}" ]; then
  echo "[run-replication-proof] ERROR: peerId= marker not seen on Peer A before force-stop" >&2
  exit 1
fi
ID_BEFORE=$(extract_marker_value "${PEER_ID_LINE_BEFORE}" "peerId")
echo "[run-replication-proof] peerId before: ${ID_BEFORE}"

# 38-07: force-stop + clear logcat + relaunch Peer A, waiting for the starting
# marker, routed through relaunch_and_wait (bounded 2-attempt retry) — this exact
# checkpoint is where the best 38-05 run died (relaunched Peer A's starting/relay
# markers never re-emitted within the old 90s window; see 38-05-SUMMARY.md
# "Where it stopped").
D05_MARKER_LINE=$(relaunch_and_wait "emulator-5554" "${PROBE_MARKER}" "${MARKER_TIMEOUT}" "marker-d05-relaunch")
if [ -z "${D05_MARKER_LINE}" ]; then
  echo "[run-replication-proof] ERROR: [replication-proof] starting marker never appeared on Peer A after the D-05 relaunch (both relaunch_and_wait attempts missed)" >&2
  exit 1
fi
echo "[run-replication-proof] D-05 relaunch start marker seen: ${D05_MARKER_LINE}"

# ── D-10: re-reserve-on-relaunch — the force-stop killed the process AND its relay
# reservation; the relaunched runner must re-establish it before we trust any dial
# that follows. Re-gate on the SAME RELAY_READY_MARKER, same idiom as the D-09 gate.
echo "[run-replication-proof] D-10: waiting for relayReservation= marker on Peer A after D-05 relaunch ..."
wait_for_logcat_line "${RELAY_READY_MARKER}" "${MARKER_TIMEOUT}" "[run-replication-proof]" "relay-ready-d05-relaunch" "-s emulator-5554" > /dev/null
echo "[run-replication-proof] D-10: relay reservation re-established on Peer A after D-05 relaunch"

echo "[run-replication-proof] D-05: capturing peerId on Peer A after force-stop relaunch ..."
PEER_ID_LINE_AFTER=$(wait_for_logcat_line "${PEER_ID_MARKER}" "${MARKER_TIMEOUT}" "[run-replication-proof]" "peerId-after" "-s emulator-5554")
if [ -z "${PEER_ID_LINE_AFTER}" ]; then
  echo "[run-replication-proof] ERROR: peerId= marker not seen on Peer A after force-stop relaunch" >&2
  exit 1
fi
ID_AFTER=$(extract_marker_value "${PEER_ID_LINE_AFTER}" "peerId")
echo "[run-replication-proof] peerId after:  ${ID_AFTER}"

if [ "${ID_BEFORE}" != "${ID_AFTER}" ]; then
  echo "[run-replication-proof] FAIL: peerId changed after restart — ID_BEFORE=${ID_BEFORE} ID_AFTER=${ID_AFTER} (D-05 / P2P-04)" >&2
  exit 1
fi
echo "[run-replication-proof] D-05 PASS: peerId stable across restart (${ID_AFTER})"

# ── D-06: peers >= 1 ───────────────────────────────────────────────────────────
echo "[run-replication-proof] D-06: waiting for peers= marker on Peer A ..."
PEERS_LINE=$(wait_for_logcat_line "${PEERS_MARKER}" "${LOGCAT_TIMEOUT}" "[run-replication-proof]" "peers" "-s emulator-5554")
N=$(extract_marker_value "${PEERS_LINE}" "peers")
if [ -z "${N}" ] || [ "${N}" -lt 1 ]; then
  echo "[run-replication-proof] FAIL: peer count < 1 (peers=${N}) (D-06 / ENG-05)" >&2
  exit 1
fi
echo "[run-replication-proof] D-06 PASS: peers=${N} (>= 1)"

# ── REPL-01: strandPeers cohort-formation signal (bounded poll, warn-and-continue) ─
# The strandPeers=N marker from the runner reports the strand-cohort peer count.
# This is the strand-cohort formation signal (distinct from the control-network peers=N above).
# Bounded poll: pass as soon as N >= 1 (research states cohort-formed = strandPeers >= 1).
# A transient or sustained N < 2 is NOT a hard gate — emit a REPL-01 WARNING and continue
# to the verdict poll (the both-peer REPLICATION VERDICT is authoritative on PASS/FAIL).
# A never-emitted marker (wiring broken) IS a hard FAIL + exit 1 (Pitfall 2 fast-fail).
STRAND_PEERS_MARKER='\[replication-proof\].*strandPeers='
echo "[run-replication-proof] REPL-01: waiting for strandPeers= marker on Peer A (timeout ${STRAND_PEERS_TIMEOUT}s) ..."
STRAND_PEERS_LINE=$(wait_for_logcat_line "${STRAND_PEERS_MARKER}" "${STRAND_PEERS_TIMEOUT}" "[run-replication-proof]" "strandPeers" "-s emulator-5554")
if [ -z "${STRAND_PEERS_LINE}" ]; then
  echo "[run-replication-proof] FAIL: strandPeers= marker never emitted on Peer A — strand wiring broken (REPL-01); check STRAND_BOOTSTRAP_ADDR injection" >&2
  exit 1
fi
SP=$(extract_marker_value "${STRAND_PEERS_LINE}" "strandPeers")
echo "[run-replication-proof] REPL-01: strandPeers=${SP} on Peer A"
if [ -z "${SP}" ] || [ "${SP}" -lt 1 ]; then
  # Phase 30: the runner now waits (bounded) for the LIVE strand connection before emitting
  # strandPeers=, so a sustained strandPeers=${SP} < 1 is a genuine cohort-formation failure —
  # fail fast here instead of warn-and-continue into a 120s verdict timeout (REPL-01).
  echo "[run-replication-proof] FAIL: strandPeers=${SP} < 1 (REPL-01) — strand cohort did not form on Peer A after the runner's bounded wait; aborting before the verdict poll" >&2
  exit 1
else
  echo "[run-replication-proof] REPL-01 cohort signal: strandPeers=${SP} >= 1 on Peer A"
fi

# ── BOTH-PEER VERDICT (D-01) ──────────────────────────────────────────────────
# Poll BOTH serials. A and B emit REPLICATION VERDICT independently.
echo "[run-replication-proof] Polling REPLICATION VERDICT on emulator-5554 (${LOGCAT_TIMEOUT}s) ..."
VERDICT_A=$(wait_for_logcat_line "${VERDICT_TAG}" "${LOGCAT_TIMEOUT}" "[run-replication-proof]" "verdict-A" "-s emulator-5554")
echo "[run-replication-proof] Polling REPLICATION VERDICT on emulator-5556 (${LOGCAT_TIMEOUT}s) ..."
VERDICT_B=$(wait_for_logcat_line "${VERDICT_TAG}" "${LOGCAT_TIMEOUT}" "[run-replication-proof]" "verdict-B" "-s emulator-5556")

# ── D-08: cluster-error capture (diagnose-first, P2P-09) ─────────────────────
# MUST run BEFORE the verdict-empty guard below: a verdict TIMEOUT (empty
# VERDICT_A/B) IS the P2P-09 failure mode (the receiving peer's stream-abort
# hangs the consensus round so no verdict is emitted). Running the capture after
# an `exit 1` on empty verdicts would skip it on the exact case it exists to
# diagnose — and the EXIT trap then deletes DRONE_LOG. Persist a copy out of the
# auto-deleted /tmp path so the full server-side error survives for inspection.
echo "[run-replication-proof] D-08: capturing drone log for the real cluster-protocol error ..."
if [ -n "${DRONE_LOG}" ] && [ -f "${DRONE_LOG}" ]; then
  cp "${DRONE_LOG}" /tmp/drone-p2p09-capture.log 2>/dev/null \
    && echo "[run-replication-proof] D-08: drone log preserved at /tmp/drone-p2p09-capture.log (survives EXIT-trap cleanup)" >&2
  if grep -qi "error handling cluster protocol message" "${DRONE_LOG}" 2>/dev/null; then
    echo "[run-replication-proof] D-08 CAPTURED cluster protocol error (candidate #1 confirmed):" >&2
    grep -i "error handling cluster protocol message" "${DRONE_LOG}" >&2
  else
    echo "[run-replication-proof] D-08: no 'error handling cluster protocol message' line in drone log — inspect /tmp/drone-p2p09-capture.log for candidates #2-#5" >&2
  fi
else
  echo "[run-replication-proof] D-08: drone log unavailable (drone may not have launched)" >&2
fi

# 38-05 (D-04 n=4 topology): mirror the D-08 capture for drone-B.
if [ -n "${DRONE_B_LOG}" ] && [ -f "${DRONE_B_LOG}" ]; then
  cp "${DRONE_B_LOG}" /tmp/drone-b-p2p09-capture.log 2>/dev/null \
    && echo "[run-replication-proof] D-08: drone-B log preserved at /tmp/drone-b-p2p09-capture.log (survives EXIT-trap cleanup)" >&2
  if grep -qi "error handling cluster protocol message" "${DRONE_B_LOG}" 2>/dev/null; then
    echo "[run-replication-proof] D-08 CAPTURED cluster protocol error on drone-B (candidate #1 confirmed):" >&2
    grep -i "error handling cluster protocol message" "${DRONE_B_LOG}" >&2
  else
    echo "[run-replication-proof] D-08: no 'error handling cluster protocol message' line in drone-B log — inspect /tmp/drone-b-p2p09-capture.log for candidates #2-#5" >&2
  fi
else
  echo "[run-replication-proof] D-08: drone-B log unavailable (drone-B may not have launched)" >&2
fi

if [ -z "${VERDICT_A}" ] || [ -z "${VERDICT_B}" ]; then
  echo "[run-replication-proof] ERROR: one or both peers did not emit a verdict within ${LOGCAT_TIMEOUT}s — FAIL" >&2
  exit 1
fi

if echo "${VERDICT_A}" | grep -q "FAIL" || echo "${VERDICT_B}" | grep -q "FAIL"; then
  echo "[run-replication-proof] ========== REPLICATION VERDICT: FAIL (A: ${VERDICT_A}  B: ${VERDICT_B}) =========="
  exit 1
fi

echo "[run-replication-proof] ========== REPLICATION VERDICT: PASS (both peers) =========="
exit 0
