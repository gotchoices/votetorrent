#!/usr/bin/env bash
#
# run-replication-proof.sh
#
# Purpose  : P2P-06 symmetric replication proof.
#            Step 1 — Peer A (${PEER_A_SERIAL}) boots FIRST solo in bootstrap mode
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
#              DRONE_DEBUG=<ns>    — (optional) override the drones' DEBUG namespaces.
#                                    Default keeps the `:error` surface AND adds
#                                    `optimystic:db-p2p:libp2p-key-network:*`, which carries
#                                    `findCluster:done … peers=N addressless=N` and
#                                    `findCluster:addressless-members` — the direct read-out on
#                                    whether cohort members have dialable addresses (Optimystic#11).
#                                    Spike 066: under `:error` alone these are INVISIBLE, and a
#                                    healthy drone logs ~99 lines, which reads as a dead drone.
#                                    Widen to `optimystic:db-p2p:*` for a deep dive (~46k lines).
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
#   - Both emulators (${PEER_A_SERIAL} and ${PEER_B_SERIAL}) must be running and the
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
# wipe_proof_strand_store SERIAL
#
# D-03 fresh-state wipe of the proof STRAND store only, done from the host while the app is
# force-stopped. It used to run inside the app on EVERY boot, including the D-05 relaunch. By
# then Peer A had already joined networked in Step 4 and, at strandClusterSize 2, was one of the
# two holders of blocks it wrote. Wiping it there left the drones holding headers that point at
# blocks nobody serves any more, so the next read was a CONFIRMED absence: `Missing block` on
# `Strand.Header` / `App.InviteSlot`, on the Peer-A role only (checkpoint 4, item 3). The wipe
# now happens ONLY before Step 1 and before the Step-4 relaunch, never before D-05. It targets
# the exact store name; the `...-control-...` store and `votetorrent-cadre-node` (peerId) must
# survive.
PROOF_STRAND_STORE="votetorrent-replication-strand-replication-proof-strand"
wipe_proof_strand_store() {
  local serial="$1"
  adb -s "${serial}" shell run-as "${PACKAGE}" rm -rf "files/${PROOF_STRAND_STORE}" >&2 || true
  if adb -s "${serial}" shell run-as "${PACKAGE}" ls "files/${PROOF_STRAND_STORE}" > /dev/null 2>&1; then
    echo "[run-replication-proof] WARN: proof strand store still present on ${serial} after wipe" >&2
  else
    echo "[run-replication-proof] wiped proof strand store on ${serial}" >&2
  fi
}

# Usage: relaunch_and_wait SERIAL PATTERN TIMEOUT_S WHAT [SECOND_SERIAL] [WIPE_STRAND]
#   SERIAL         — the adb serial whose marker is waited on (e.g. ${PEER_A_SERIAL})
#   PATTERN        — logcat pattern passed to wait_for_logcat_line
#   TIMEOUT_S      — seconds to wait per attempt
#   WHAT           — human label for wait_for_logcat_line's own error messages
#   SECOND_SERIAL  — optional: also force-stop/clear/relaunch this serial on every
#                    attempt (the networked both-peer relaunch needs both devices up
#                    together before either's marker is meaningful), but only SERIAL's
#                    marker is waited on. Pass "" to skip it.
#   WIPE_STRAND    — optional: "1" wipes the proof strand store on every relaunched serial
#                    between force-stop and launch. Only the Step-4 relaunch passes it; the
#                    D-05 relaunch must NOT (see wipe_proof_strand_store).
#
# Echoes the matched logcat line to stdout (same contract as wait_for_logcat_line);
# prints nothing (empty) if both attempts miss — callers must check for an empty
# result exactly as they already do for a bare wait_for_logcat_line call.
relaunch_and_wait() {
  local serial="$1" pattern="$2" timeout_s="$3" what="$4" second_serial="${5:-}" wipe_strand="${6:-0}"
  local attempt line status
  for attempt in 1 2; do
    echo "[run-replication-proof] relaunch_and_wait: attempt ${attempt}/2 for '${what}' on ${serial}$([ -n "${second_serial}" ] && echo " (+ ${second_serial})") ..." >&2
    adb -s "${serial}" shell am force-stop "${PACKAGE}" >&2
    if [ -n "${second_serial}" ]; then
      adb -s "${second_serial}" shell am force-stop "${PACKAGE}" >&2
    fi
    sleep 2
    if [ "${wipe_strand}" = "1" ]; then
      wipe_proof_strand_store "${serial}"
      if [ -n "${second_serial}" ]; then
        wipe_proof_strand_store "${second_serial}"
      fi
    fi
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

# read_logcat_line_now PATTERN SERIAL [TRIES]
#
# Bounded 5s-interval POLL of the logcat buffer (`logcat -d`), returning the first match
# immediately. Use this — never wait_for_logcat_line — for any marker the runner emits ONCE
# PER BOOT.
#
# wait_for_logcat_line streams (`adb logcat -e`), and its documented IN-19 latency is that
# `head` exits on the first match while the command substitution only returns when adb dies —
# via SIGPIPE on the NEXT matching write, or at the end of the window. A once-per-boot marker
# has no next matching write, so a SUCCESSFUL capture still burns the entire timeout. That is
# free when the window is 10s and ruinous when it is 300s: the D-04 captures below sat on two
# such windows back to back, 600s of dead wall-clock indistinguishable from a stalled device.
#
# Echoes the matched line (empty if none arrived within TRIES*5s), same contract as
# wait_for_logcat_line.
read_logcat_line_now() {
  local pattern="$1" serial="$2" tries="${3:-24}" i out
  for i in $(seq 1 "${tries}"); do
    out=$(adb -s "${serial}" logcat -d 2>/dev/null | grep -v '^--------- ' | grep -E "${pattern}" | head -1)
    if [ -n "${out}" ]; then printf '%s\n' "${out}"; return 0; fi
    sleep 5
  done
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
# D-04 (41-02): per-drone relay-reservation instrumentation marker. Emitted by the runner
# alongside strandPeers= (once the strand node exists), reporting the /p2p-circuit
# multiaddrs actually reserved with each known drone — so a wall-#8-class per-drone
# reservation asymmetry is visible from run #1 without waiting for a FAIL verdict.
RELAY_ADDRS_PER_DRONE_MARKER='\[replication-proof\].*relayAddrsPerDrone='
# REPL-01 phase split: `controlRelayAddrs=` is the LAST line the runner emits before the strand
# acquire and `strandPeers=` the first one after it, so this marker is where the strand budget
# starts. Before the split, REPL-01's single window opened at the `peers=` read and the ~90s auth
# gate was charged against it — run 25 killed Peer A 215s into an acquire its sibling completed in
# 162s, and the run was recorded as a strand-wiring failure that had not occurred.
ACQUIRE_START_MARKER='\[replication-proof\].*controlRelayAddrs='
LOGCAT_TIMEOUT=180  # seconds: longer than dial-probe to account for two emulators +
                    # replication latency (A writes → drone → B reads)
MARKER_TIMEOUT=180  # seconds to wait for [replication-proof] starting marker
                    # (38-07: raised from 90 — the D-05/networked-relaunch checkpoints
                    #  that killed all 8 prior 38-05 runs need headroom for a Metro
                    #  rebundle race + slow long-lived-emulator relaunch, on top of the
                    #  new relaunch_and_wait retry)
STRAND_TIMEOUT=420  # seconds to wait for strandId= marker from bootstrap-mode Peer A
                    # (2026-09-11: raised from 240 — measured 216s on a host whose Metro had
                    #  grown to 1.6 GB over three back-to-back runs, i.e. 90% of the old budget
                    #  with nothing wrong. The next run stalled past it and died at Step 1,
                    #  which reads as a runner crash and is not one. Strand materialization is
                    #  CPU/IO-heavy and degrades with environment age; budget for the bad case.)
                    # (38-07: raised from 120 — was bumped from 60 in 38-04 for the
                    #  always-on relay-reservation poll + slow strand materialization;
                    #  raised again for the same long-lived-emulator slowness that
                    #  stalled the D-05 checkpoint in 38-05)
DRONE_READY_TIMEOUT=60  # seconds to wait for drone READY line (38-07: raised from 30)
ACQUIRE_START_TIMEOUT=180  # seconds to reach the ACQUIRE_START_MARKER (controlRelayAddrs=) on
                    # Peer A. Covers boot + enrolment + the runner's own AUTH_GATE_BUDGET_MS (90s)
                    # with margin. Polled, so overshooting this costs nothing on a healthy run.
STRAND_PEERS_TIMEOUT=420  # seconds to wait for the REPL-01 strandPeers= marker, measured FROM
                    # ACQUIRE_START_MARKER rather than from the peers= read — the auth gate is no
                    # longer charged against it. Sized to STRAND_TIMEOUT, which budgets the same
                    # operation (strand materialization) in Step 1 and was itself raised to 420
                    # after that build measured 216s on an aged host. Measured here: 63s and 90s
                    # in run 24, 162s in run 25 — the spread is why 300s was not enough.
                    # (38-14: dedicated timeout, raised above LOGCAT_TIMEOUT=180 — 38-13 observed
                    # the write-phase strandPeers= emit at ~183s, ~3s AFTER the shared
                    # LOGCAT_TIMEOUT expired, so the script died before reaching the
                    # both-peer verdict poll and the trailing D-08 drone-side log capture)
RELAY_ADDRS_PER_DRONE_TIMEOUT=300  # seconds to wait for the D-04 relayAddrsPerDrone= marker —
                    # emitted at the SAME point in the runner as strandPeers= (immediately
                    # after, both success and failure paths), so sized identically to
                    # STRAND_PEERS_TIMEOUT to avoid racing that same emit point
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
  #
  # SPIKE-073: set KEEP_DRONE_LOGS to a directory to COPY both drone logs there before
  # they are removed. Without this the logs die with the run, and a post-mortem that
  # needs them (spike 066's whole method; spike 073's T2/T3/T4 read-out) has to re-run
  # the ~20-minute harness just to get the file back.
  if [ -n "${KEEP_DRONE_LOGS:-}" ]; then
    mkdir -p "${KEEP_DRONE_LOGS}" 2>/dev/null || true
    [ -n "${DRONE_LOG}" ] && cp "${DRONE_LOG}" "${KEEP_DRONE_LOGS}/drone-a.log" 2>/dev/null || true
    [ -n "${DRONE_B_LOG}" ] && cp "${DRONE_B_LOG}" "${KEEP_DRONE_LOGS}/drone-b.log" 2>/dev/null || true
    echo "[run-replication-proof] Drone logs copied to ${KEEP_DRONE_LOGS}" >&2
  fi
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
export const SIGNING_PROOF_ENABLED = false;
export const STRAND_PERSISTENCE_PROOF_ENABLED = false;
export const USE_STUB_ATTESTATION_VERIFIER = false;
export const REGISTRANT_SEED_ENABLED = false;
export const RECOVERY_BRANCH_PROOF_ENABLED = false;
export const SEALED_PAYLOAD_PROOF_ENABLED = false;
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
# PEER_A_SERIAL / PEER_B_SERIAL — (default ${PEER_A_SERIAL} / ${PEER_B_SERIAL}) which adb serial
# plays "Peer A" (the D-05 force-stop+relaunch role, D-06/D-09/REPL-01 sampling target) vs
# "Peer B". Added for the P2P-11 debug session's leg-5 role-swap test (does Missing block
# follow the emulator/on-device store, or the Peer-A script role?) — override both to swap
# which physical AVD plays which role without editing this script.
PEER_A_SERIAL="${PEER_A_SERIAL:-emulator-5554}"
PEER_B_SERIAL="${PEER_B_SERIAL:-emulator-5556}"
FRESH_EMULATOR="${FRESH_EMULATOR:-1}"
if [ "${FRESH_EMULATOR}" = "1" ]; then
  echo "[run-replication-proof] Fresh-emulator precondition: pm clear + votetorrent-* LevelDB wipe on both emulators (FRESH_EMULATOR=1) ..."
  for serial in ${PEER_A_SERIAL} ${PEER_B_SERIAL}; do
    adb -s "${serial}" shell pm clear "${PACKAGE}" > /dev/null 2>&1 || true
    adb -s "${serial}" shell run-as "${PACKAGE}" \
      find /data/data/"${PACKAGE}"/files -name "votetorrent-*" -exec rm -rf {} + 2>/dev/null || true
  done
  echo "[run-replication-proof] Fresh-emulator precondition complete."
else
  echo "[run-replication-proof] Fresh-emulator precondition SKIPPED (FRESH_EMULATOR=0)."
fi

# prewarm_bundle WHAT
#
# Opt-in: with PREWARM_BUNDLE_URL set (the app's own Metro bundle URL), block until Metro has
# rebuilt the bundle after a generated-file write, so the launch ~2 s later fetches a finished
# bundle rather than racing the rebundle (the race the "Metro rebundle likely in flight" errors
# below name). Unset, it does nothing.
#
# Not the cause of every "Unable to load script": on 2026-10-12 that was an emulator in Doze. An
# AVD on battery ignores `svc power stayon`, sleeps, and Doze blocks the app's network, so it
# cannot reach Metro at all ("Failed to connect to /10.0.2.2:<port>" under
# `unknown:ReactNative`). Run `adb emu power ac on` and `dumpsys deviceidle disable` first.
prewarm_bundle() {
  [ -n "${PREWARM_BUNDLE_URL:-}" ] || return 0
  local started=$SECONDS code
  sleep 3  # let Metro's watcher see the write first, or the fetch returns the stale bundle
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 600 "${PREWARM_BUNDLE_URL}" || true)
  echo "[run-replication-proof] prewarm (${1}): HTTP ${code} after $((SECONDS - started))s" >&2
}

# ── STEP 0: Write the enabled flag file ──────────────────────────────────────
# Metro picks up the change on the next bundle request (force-stop clears stale JS cache).
cat > "${FLAG_FILE}" << 'EOF'
// run-replication-proof.sh generated override — do not commit (EXIT trap restores default).
// Static import only — dynamic require() breaks Metro (Phase 16-07 lesson).
export const PROOF_ENABLED = false;
export const DIAL_PROBE_ENABLED = false;
export const REPLICATION_PROOF_ENABLED = true;
export const USE_LOCAL_DB_FACTORY = false;
export const SIGNING_PROOF_ENABLED = false;
export const STRAND_PERSISTENCE_PROOF_ENABLED = false;
export const USE_STUB_ATTESTATION_VERIFIER = false;
export const REGISTRANT_SEED_ENABLED = false;
export const RECOVERY_BRANCH_PROOF_ENABLED = false;
export const SEALED_PAYLOAD_PROOF_ENABLED = false;
EOF
echo "[run-replication-proof] Flag file updated: REPLICATION_PROOF_ENABLED=true"
prewarm_bundle "flags"

# ── STEP 1: BOOTSTRAP-MODE FIRST BOOT (Peer A only, solo, no drone) ──────────
# Peer A boots solo without the drone running. The runner's createStrandDbFactory
# selects CF-02 bootstrap mode automatically (no peers reachable). It creates the
# proof strand and logs [replication-proof] strandId=<hash>.
echo "[run-replication-proof] Step 1: bootstrap-mode first boot — Peer A solo (no drone) ..."
adb -s ${PEER_A_SERIAL} shell am force-stop "${PACKAGE}"
sleep 2
wipe_proof_strand_store "${PEER_A_SERIAL}"
# Pitfall 4: clear stale logcat ring buffer BEFORE the bootstrap-mode relaunch.
adb -s ${PEER_A_SERIAL} logcat -c
echo "[run-replication-proof] Relaunching ${PACKAGE} on ${PEER_A_SERIAL} (bootstrap mode, solo) ..."
adb -s ${PEER_A_SERIAL} shell monkey -p "${PACKAGE}" -c android.intent.category.LAUNCHER 1

# Wait for the proof-start marker on Peer A (proves metro served the enabled bundle).
echo "[run-replication-proof] Waiting up to ${MARKER_TIMEOUT}s for [replication-proof] starting marker on ${PEER_A_SERIAL} ..."
BOOTSTRAP_MARKER_LINE=$(wait_for_logcat_line "${PROBE_MARKER}" "${MARKER_TIMEOUT}" "[run-replication-proof]" "bootstrap-marker" "-s ${PEER_A_SERIAL}")
if [ -z "${BOOTSTRAP_MARKER_LINE}" ]; then
  echo "[run-replication-proof] ERROR: [replication-proof] never started on Peer A (bootstrap mode) — Metro rebundle likely in flight or flags-disabled bundle served; re-run" >&2
  exit 1
fi
echo "[run-replication-proof] Bootstrap-mode start marker seen: ${BOOTSTRAP_MARKER_LINE}"
# Set PROBE_STARTED=1 when starting marker observed (Pitfall 5 sentinel).
PROBE_STARTED=1

# ── STEP 2: CAPTURE the strand hash from Peer A's bootstrap-mode logcat ──────
# The runner logs [replication-proof] strandId=<hash> after createStrandDbFactory.
echo "[run-replication-proof] Waiting up to ${STRAND_TIMEOUT}s for strandId= marker on ${PEER_A_SERIAL} ..."
STRAND_LINE=$(wait_for_logcat_line "${STRAND_ID_MARKER}" "${STRAND_TIMEOUT}" "[run-replication-proof]" "strandId" "-s ${PEER_A_SERIAL}")
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
# Drone-A FOUNDS the proof strand by default (DRONE_STRAND_ROLE=found). STRAND_ID here is the fixed
# proof-strand id, and the only device-side history under it is Peer A's Step-1 solo boot, which
# wipe_proof_strand_store deletes before the Step-4 networked relaunch. With drone-A joining instead
# (the 62-85 default), no node in the networked run holds the strand's founding Header: every node
# logs `founder: false`, cadre-core's first-sync gate withholds the strand DB from all of them, and
# acquireProofDb neither resolves nor throws, so REPL-01 times out at 420 s (2026-10-08 runs 2 and 4).
# The round-3 UAT fork (test 15) needs a device-founded strand that SURVIVES into the drone's run;
# this proof never has one. Pass DRONE_STRAND_ROLE=join to reproduce that variant. Drone-B reads its
# OWN variable, DRONE_B_STRAND_ROLE (default join), and never inherits DRONE_STRAND_ROLE: drone-B
# was never a founder, and inheriting `found` would make it found a second history (WR-05).
echo "[run-replication-proof] Step 3: launching drone with STRAND_ID=${STRAND_ID} DRONE_STRAND_ROLE=${DRONE_STRAND_ROLE:-found} under Node 22 ..."
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
# W1b (2026-09-10): `sereus:cadre:node` ADDED. cadre-core's authorizeInboundControlStream() is the
# predicate behind every `inbound stream denied ... reason=predicate returned false` line, and it
# logs the WHY — "DENYING <peer> on <protocol> — not in the materialized authorized set (N
# member(s))" — on `debug('sereus:cadre:node')` (cadre-node.js:43). The pre-existing
# `sereus:cadre:*:error` does NOT match that namespace (it matches sereus:cadre:<x>:error), so the
# one line that explains a denial was filtered out of EVERY run: 214 denials in the 2026-09-10
# device run, 0 lines of reason. Also enables refreshAuthorizedControlPeers()'s member-count line,
# which says whether the cold-start carve-out is still open.
# DRONE_LOG is retained through the FULL run (no rm -f below) — only the EXIT trap removes it.
DRONE_LOG=$(mktemp /tmp/drone-full-run-XXXXXX.log)
DEBUG="${DRONE_DEBUG:-optimystic:db-p2p:*:error,db-p2p:*:error,libp2p:*:error,sereus:cadre:*:error,sereus:cadre:node,optimystic:db-p2p:libp2p-key-network:*,sereus:cadre:strand-addr,sereus:cadre:delegate-admission,sereus:cadre:invite-proto,sereus:cadre:control-protocol-guard}" STRAND_ID="${STRAND_ID}" DRONE_STRAND_ROLE="${DRONE_STRAND_ROLE:-found}" "${NODE22}" packages/p2p-probe-host/drone.mjs > "${DRONE_LOG}" 2>&1 &
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

# Capture the cadre invite drone-A minted at genesis (P2P-11 membership gate). Emitted
# BEFORE PROOF_STRAND_ADDR=, so by here it is already in the log.
#
# Without membership every device is refused with `Refusing strand-addr from non-member`,
# the strand cohort never forms, and the run fails looking like an addressing problem — the
# root cause found 2026-08-24 and the reason every n=4 run through 41-09 failed. Treat a
# missing invite as fatal rather than proceeding into that misleading failure.
# Since cadre-core 1.15 the invitation starts with `sereus-invite:1.`, hence `.` and `:`.
DRONE_INVITE=$(grep -m1 -o 'PROOF_INVITE=[A-Za-z0-9_.:-]*' "${DRONE_LOG}" 2>/dev/null | cut -d= -f2- || true)
if [ -z "${DRONE_INVITE}" ]; then
  echo "[run-replication-proof] ERROR: drone did not emit PROOF_INVITE= — owner genesis did not run," >&2
  echo "[run-replication-proof]        so no device can become a cadre member and the strand cohort" >&2
  echo "[run-replication-proof]        cannot form. Check the drone log for a genesis error." >&2
  cat "${DRONE_LOG}" >&2
  exit 1
fi
echo "[run-replication-proof] Drone invite captured (${#DRONE_INVITE} chars)"

# ── STEP 3b: LAUNCH DRONE-B (38-05 / D-04 n=4 topology) ─────────────────────
# SECOND drone process, cross-bootstrapped to drone-A's control AND strand
# multiaddrs — exactly the wiring 38-02's two-drone-smoke.mjs proved (peerCount=3
# there; here it grows the strand cohort to n=4 alongside the 2 emulators).
# Cross-bootstrap uses the drone's own loopback (127.0.0.1) addrs, NOT the
# device-rewritten 10.0.2.2 addrs below — drone-A and drone-B are both host-side
# Node processes talking to each other directly over loopback (Pitfall 2: distinct
# host-loopback vs emulator-alias address spaces).
# Drone-B's role comes from DRONE_B_STRAND_ROLE only (default join), never from DRONE_STRAND_ROLE
# (WR-05; see Step 3). With STRAND_ID set, drone.mjs refuses an unset role, so historical drone-B's
# derived founder-ness ({}) is not reproducible here; join (founder: false) is the closest match.
echo "[run-replication-proof] Step 3b: launching drone-B (cross-bootstrapped to drone-A) with STRAND_ID=${STRAND_ID} DRONE_STRAND_ROLE=${DRONE_B_STRAND_ROLE:-join} (from DRONE_B_STRAND_ROLE) under Node 22 ..."
DRONE_B_LOG=$(mktemp /tmp/drone-b-full-run-XXXXXX.log)
DEBUG="${DRONE_DEBUG:-optimystic:db-p2p:*:error,db-p2p:*:error,libp2p:*:error,sereus:cadre:*:error,sereus:cadre:node,optimystic:db-p2p:libp2p-key-network:*,sereus:cadre:strand-addr,sereus:cadre:delegate-admission,sereus:cadre:invite-proto,sereus:cadre:control-protocol-guard}" \
  STRAND_ID="${STRAND_ID}" \
  DRONE_STRAND_ROLE="${DRONE_B_STRAND_ROLE:-join}" \
  DRONE_BOOTSTRAP_CONTROL_ADDR="${DRONE_ADDR}" \
  DRONE_BOOTSTRAP_STRAND_ADDR="${STRAND_ADDR}" \
  DRONE_INVITE="${DRONE_INVITE}" \
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
# The EXIT trap restores CONFIG_FILE from a byte copy taken HERE, before injection. It used to
# `git checkout --` it, which also silently discarded any UNCOMMITTED edit to the runner at the
# end of the first run (2026-10-08: the fixes under test would have vanished after one run).
CONFIG_BACKUP=$(mktemp "/tmp/replication-proof-runner-backup-XXXXXX")
cp "${CONFIG_FILE}" "${CONFIG_BACKUP}"

# Invite-share channel (62-102). NetworkEngine.respondToInvite needs the invite's one-time
# PRIVATE key, which only the founder phone holds. The founder logs PROOF_INVITE_SHARE=
# <inviteKey>.<invitePrivate>; a watcher copies every one it sees on either phone into
# SHARE_DIR/invite-share.txt, and a loopback HTTP server serves it to the joiner, which the
# emulator reaches at 10.0.2.2. Throwaway keys of a throwaway proof network, dev harness only.
SHARE_PORT="${PROOF_SHARE_PORT:-8790}"
SHARE_DIR=$(mktemp -d "/tmp/replication-proof-share-XXXXXX")
: > "${SHARE_DIR}/invite-share.txt"
python3 -m http.server "${SHARE_PORT}" --bind 127.0.0.1 --directory "${SHARE_DIR}" > /dev/null 2>&1 &
SHARE_SERVER_PID=$!
sleep 1
if ! kill -0 "${SHARE_SERVER_PID}" 2>/dev/null; then
  echo "[run-replication-proof] ERROR: invite-share server could not bind 127.0.0.1:${SHARE_PORT} (set PROOF_SHARE_PORT)" >&2
  exit 1
fi
(
  # The script runs under `set -euo pipefail`, which this subshell inherits: a pass with no share
  # yet (grep matches nothing, exit 1) would fail the pipeline and kill the watcher on its first
  # iteration, before the founder has logged anything (2026-10-08 run 7: 0 shares relayed).
  set +e +o pipefail
  while true; do
    for serial in "${PEER_A_SERIAL}" "${PEER_B_SERIAL}"; do
      adb -s "${serial}" logcat -d -s ReactNativeJS:I 2>/dev/null \
        | grep -oE 'PROOF_INVITE_SHARE=[0-9a-fA-F]+\.[0-9a-fA-F]{64}' | cut -d= -f2
    done | cat "${SHARE_DIR}/invite-share.txt" - | sort -u > "${SHARE_DIR}/invite-share.next"
    mv "${SHARE_DIR}/invite-share.next" "${SHARE_DIR}/invite-share.txt"
    sleep 3
  done
) &
SHARE_WATCH_PID=$!
SHARE_URL_FOR_DEVICE="http://10.0.2.2:${SHARE_PORT}/invite-share.txt"
cleanup_share() {
  kill "${SHARE_WATCH_PID}" "${SHARE_SERVER_PID}" 2>/dev/null || true
  local n
  n=$(grep -c . "${SHARE_DIR}/invite-share.txt" 2>/dev/null || echo 0)
  echo "[run-replication-proof] invite-share channel: ${n} share(s) relayed" >&2
  rm -rf "${SHARE_DIR}" 2>/dev/null || true
}
# shellcheck disable=SC2064
trap 'restore_flags; cleanup_share; cp "'"${CONFIG_BACKUP}"'" "'"${CONFIG_FILE}"'" && rm -f "'"${CONFIG_BACKUP}"'"' EXIT

# Replace the CONTROL_ADDR placeholder line in the runner with the real drone control address.
# The device emulator reaches the host at 10.0.2.2; replace the host IP in the addr.
# The drone emits its loopback (127.0.0.1) ws multiaddr; the Android emulator reaches the
# host loopback at 10.0.2.2. Rewrite either loopback/wildcard host to the emulator alias.
# Both drones' control addrs are injected: CONTROL_ADDR (drone-A) and CONTROL_ADDR_B (drone-B).
# With drone-A alone, drone-B held no connection to either phone and every dial-back to a phone
# ended in NO_RESERVATION (2026-10-08). The runner uses both as control bootstraps and relays.
DRONE_ADDR_FOR_DEVICE=$(echo "${DRONE_ADDR}" | sed -e 's|/ip4/127\.0\.0\.1/|/ip4/10.0.2.2/|' -e 's|/ip4/0\.0\.0\.0/|/ip4/10.0.2.2/|')
DRONE_B_ADDR_FOR_DEVICE=$(echo "${DRONE_B_ADDR}" | sed -e 's|/ip4/127\.0\.0\.1/|/ip4/10.0.2.2/|' -e 's|/ip4/0\.0\.0\.0/|/ip4/10.0.2.2/|')
# Apply the same host-IP rewrite for the strand addresses (Pitfall 2: separate addresses, separate nodes).
STRAND_ADDR_FOR_DEVICE=$(echo "${STRAND_ADDR}" | sed -e 's|/ip4/127\.0\.0\.1/|/ip4/10.0.2.2/|' -e 's|/ip4/0\.0\.0\.0/|/ip4/10.0.2.2/|')
STRAND_B_ADDR_FOR_DEVICE=$(echo "${STRAND_B_ADDR}" | sed -e 's|/ip4/127\.0\.0\.1/|/ip4/10.0.2.2/|' -e 's|/ip4/0\.0\.0\.0/|/ip4/10.0.2.2/|')
# Use a temp marker that is not a regex special char.
# Device-sized poll budgets (ticks of the runner's 1 s POLL_INTERVAL_MS; each tick is a real
# distributed read, so wall time is longer). The source keeps its short defaults for jest.
INVITE_SLOT_POLL_FOR_DEVICE="${PROOF_INVITE_SLOT_POLL_MAX:-420}"
READ_POLL_FOR_DEVICE="${PROOF_READ_POLL_MAX:-480}"
python3 - "${CONFIG_FILE}" "${DRONE_ADDR_FOR_DEVICE}" "${STRAND_ADDR_FOR_DEVICE}" "${STRAND_B_ADDR_FOR_DEVICE}" "${DRONE_INVITE}" "${DRONE_B_ADDR_FOR_DEVICE}" "${SHARE_URL_FOR_DEVICE}" "${INVITE_SLOT_POLL_FOR_DEVICE}" "${READ_POLL_FOR_DEVICE}" << 'PYEOF'
import sys
path, control_addr, strand_addr, strand_addr_b = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
invite = sys.argv[5]
control_addr_b, share_url = sys.argv[6], sys.argv[7]
invite_slot_poll, read_poll = sys.argv[8], sys.argv[9]
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

# Inject PROOF_INVITE (cadre membership). The invitation is `sereus-invite:1.` (cadre-core 1.15's
# CADRE_INVITATION_PREFIX, which decodeCadreInvitation requires) + base64url-encoded JSON whose
# `members` are the dialable multiaddrs of the machines it can be redeemed at, and
# redeemCadreInvitation DIALS them — so the drone's own 127.0.0.1 addresses have to get the same
# emulator-alias rewrite the constants above get, or the device holds an invitation it can never
# redeem. `members` is outside the owner-signed row, so rewriting it does not break the
# invitation's proof. Decode, rewrite, re-encode.
import base64, json

def _b64url_decode(s):
    return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))

def _b64url_encode(b):
    return base64.urlsafe_b64encode(b).decode().rstrip('=')

INVITE_PREFIX = 'sereus-invite:1.'
if not invite.startswith(INVITE_PREFIX):
    print(f'[run-replication-proof] ERROR: PROOF_INVITE does not start with {INVITE_PREFIX} - not a cadre-core 1.15 CadreInvitation', file=sys.stderr)
    sys.exit(1)
decoded = json.loads(_b64url_decode(invite[len(INVITE_PREFIX):]))
if not decoded.get('members'):
    print('[run-replication-proof] ERROR: PROOF_INVITE has no `members` - not a cadre-core 1.15 CadreInvitation', file=sys.stderr)
    sys.exit(1)
decoded['members'] = [
    a.replace('/ip4/127.0.0.1/', '/ip4/10.0.2.2/').replace('/ip4/0.0.0.0/', '/ip4/10.0.2.2/')
    for a in decoded['members']
]
invite_for_device = INVITE_PREFIX + _b64url_encode(json.dumps(decoded).encode())
new_content, n_invite = re.subn(
    r"(const PROOF_INVITE = ')[^']*(')",
    r"\g<1>" + invite_for_device + r"\g<2>",
    new_content,
    count=1,
)
for const_name, value in (('CONTROL_ADDR_B', control_addr_b), ('PROOF_INVITE_SHARE_URL', share_url)):
    new_content, n_const = re.subn(
        r"(const " + const_name + r" = ')[^']*(')",
        r"\g<1>" + value + r"\g<2>",
        new_content,
        count=1,
    )
    if n_const != 1:
        print(f'[run-replication-proof] ERROR: {const_name} constant not found in the runner', file=sys.stderr)
        sys.exit(1)

for const_name, value in (('INVITE_SLOT_POLL_MAX', invite_slot_poll), ('REPL_POLL_MAX', read_poll)):
    new_content, n_const = re.subn(
        r"(const " + const_name + r" = )\d+(;)",
        r"\g<1>" + str(int(value)) + r"\g<2>",
        new_content,
        count=1,
    )
    if n_const != 1:
        print(f'[run-replication-proof] ERROR: {const_name} constant not found in the runner', file=sys.stderr)
        sys.exit(1)
    print(f"[run-replication-proof] {const_name} in runner injected: {value}")

if n_invite != 1:
    # Fail loudly: a silently-unwritten invite boots every device unenrolled, which fails
    # later as an unexplained empty strand cohort — the exact misdiagnosis this closes.
    print('[run-replication-proof] ERROR: PROOF_INVITE constant not found in the runner', file=sys.stderr)
    sys.exit(1)

open(path, 'w').write(new_content)
print(f"[run-replication-proof] PROOF_INVITE in runner injected ({len(invite_for_device)} chars, "
      f"members={decoded['members']})")
print(f"[run-replication-proof] CONTROL_ADDR in runner injected: {control_addr}")
print(f"[run-replication-proof] STRAND_BOOTSTRAP_ADDR in runner injected: {strand_addr}")
print(f"[run-replication-proof] STRAND_BOOTSTRAP_ADDR_B in runner injected: {strand_addr_b}")
print(f"[run-replication-proof] CONTROL_ADDR_B in runner injected: {control_addr_b}")
print(f"[run-replication-proof] PROOF_INVITE_SHARE_URL in runner injected: {share_url}")
PYEOF
prewarm_bundle "config"

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
MARKER_LINE=$(relaunch_and_wait "${PEER_A_SERIAL}" "${PROBE_MARKER}" "${MARKER_TIMEOUT}" "marker" "${PEER_B_SERIAL}" 1)
if [ -z "${MARKER_LINE}" ]; then
  echo "[run-replication-proof] ERROR: [replication-proof] never started on Peer A (networked run) after 2 relaunch_and_wait attempts — Metro rebundle likely in flight; re-run" >&2
  exit 1
fi
echo "[run-replication-proof] Networked start marker seen on Peer A: ${MARKER_LINE}"
PROBE_STARTED=1

# ── D-09: relay-READY gate — gates the START of the replication run on the relay
# reservation being observed on BOTH peers (P2P-08). Both emulators run the same
# replication-proof-runner.ts, so both independently poll getMultiaddrs()/p2p-circuit
# and emit relayReservation= (true|false) unconditionally. We wait for the marker line
# on each serial (mirroring the PROBE_MARKER/STRAND_ID_MARKER gating shape) AND assert
# its boolean is `true`: waiting on presence alone let run 28 proceed on
# relayReservation=false, i.e. with the very precondition this gate exists to establish
# already broken, which makes every reservation-sensitive result downstream
# uninterpretable. See the strand-addr-throttle todo's "Rig caveat on runs 27-29".
echo "[run-replication-proof] D-09: waiting for relayReservation= marker on ${PEER_A_SERIAL} (networked run) ..."
RELAY_LINE_A=$(wait_for_logcat_line "${RELAY_READY_MARKER}" "${MARKER_TIMEOUT}" "[run-replication-proof]" "relay-ready-A" "-s ${PEER_A_SERIAL}")
if [ -z "${RELAY_LINE_A}" ]; then
  echo "[run-replication-proof] ERROR: relayReservation= marker never appeared on ${PEER_A_SERIAL} (networked run) — relay reservation not established (P2P-08)" >&2
  exit 1
fi
case "${RELAY_LINE_A}" in
  *"relayReservation=', true"*|*"relayReservation= true"*|*"relayReservation=true"*) : ;;
  *)
    echo "[run-replication-proof] ERROR: D-09 relayReservation is NOT true on ${PEER_A_SERIAL} — the relay precondition this gate exists to establish is broken, so every reservation-sensitive result downstream would be uninterpretable. Line: ${RELAY_LINE_A}" >&2
    exit 1
    ;;
esac
echo "[run-replication-proof] D-09: relay-READY on ${PEER_A_SERIAL}: ${RELAY_LINE_A}"
echo "[run-replication-proof] D-09: waiting for relayReservation= marker on ${PEER_B_SERIAL} (networked run) ..."
RELAY_LINE_B=$(wait_for_logcat_line "${RELAY_READY_MARKER}" "${MARKER_TIMEOUT}" "[run-replication-proof]" "relay-ready-B" "-s ${PEER_B_SERIAL}")
if [ -z "${RELAY_LINE_B}" ]; then
  echo "[run-replication-proof] ERROR: relayReservation= marker never appeared on ${PEER_B_SERIAL} (networked run) — relay reservation not established (P2P-08)" >&2
  exit 1
fi
case "${RELAY_LINE_B}" in
  *"relayReservation=', true"*|*"relayReservation= true"*|*"relayReservation=true"*) : ;;
  *)
    echo "[run-replication-proof] ERROR: D-09 relayReservation is NOT true on ${PEER_B_SERIAL} — the relay precondition this gate exists to establish is broken, so every reservation-sensitive result downstream would be uninterpretable. Line: ${RELAY_LINE_B}" >&2
    exit 1
    ;;
esac
echo "[run-replication-proof] D-09: relay-READY on ${PEER_B_SERIAL}: ${RELAY_LINE_B}"

# ── D-05: peerId stability — capture before/after a Peer-A force-stop relaunch ─
# Peer A must emit the same peerId before and after a force-stop (P2P-04 / Test 4).
echo "[run-replication-proof] D-05: capturing peerId on Peer A before force-stop ..."
PEER_ID_LINE_BEFORE=$(wait_for_logcat_line "${PEER_ID_MARKER}" "${MARKER_TIMEOUT}" "[run-replication-proof]" "peerId-before" "-s ${PEER_A_SERIAL}")
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
D05_MARKER_LINE=$(relaunch_and_wait "${PEER_A_SERIAL}" "${PROBE_MARKER}" "${MARKER_TIMEOUT}" "marker-d05-relaunch")
if [ -z "${D05_MARKER_LINE}" ]; then
  echo "[run-replication-proof] ERROR: [replication-proof] starting marker never appeared on Peer A after the D-05 relaunch (both relaunch_and_wait attempts missed)" >&2
  exit 1
fi
echo "[run-replication-proof] D-05 relaunch start marker seen: ${D05_MARKER_LINE}"

# Capture peerId-after HERE, not after D-10.
#
# `peerId=` is emitted once per boot, immediately after `starting` — so by this point it is
# already in the logcat buffer and will never be written again. Waiting for it with
# `wait_for_logcat_line` therefore cannot "arrive"; it can only be READ. Worse, every wait for a
# once-per-boot marker burns its full window (the IN-19 latency noted in logcat-wait.sh: `head`
# exits on first match but the substitution only returns when adb dies, which for a marker with
# no "next matching write" means the whole TIMEOUT). Stacking relaunch_and_wait's window and
# D-10's put the old read ~2x MARKER_TIMEOUT after the line was logged, and `relaunch_and_wait`
# had just cleared the buffer — so on a chatty boot the 2 MiB ring wraps the line away and the
# run dies at a checkpoint that has nothing to do with replication. That is exactly how run 15
# died; run 14 passed the identical gate on timing luck.
#
# Read the buffer directly (`logcat -d`), bounded-retry for the case where the relaunched app has
# not reached the line yet. Same extraction, same comparison, no window to outlive.
echo "[run-replication-proof] D-05: capturing peerId on Peer A after force-stop relaunch ..."
PEER_ID_LINE_AFTER=$(read_logcat_line_now "${PEER_ID_MARKER}" "${PEER_A_SERIAL}")
if [ -z "${PEER_ID_LINE_AFTER}" ]; then
  echo "[run-replication-proof] ERROR: peerId= marker not seen on Peer A after force-stop relaunch" >&2
  echo "[run-replication-proof] --- last 20 [replication-proof] lines on Peer A (diagnostic) ---" >&2
  adb -s ${PEER_A_SERIAL} logcat -d 2>/dev/null | grep 'replication-proof' | tail -20 >&2
  exit 1
fi
ID_AFTER=$(extract_marker_value "${PEER_ID_LINE_AFTER}" "peerId")
echo "[run-replication-proof] peerId after:  ${ID_AFTER}"

if [ "${ID_BEFORE}" != "${ID_AFTER}" ]; then
  echo "[run-replication-proof] FAIL: peerId changed after restart — ID_BEFORE=${ID_BEFORE} ID_AFTER=${ID_AFTER} (D-05 / P2P-04)" >&2
  exit 1
fi
echo "[run-replication-proof] D-05 PASS: peerId stable across restart (${ID_AFTER})"

# ── D-10: re-reserve-on-relaunch — the force-stop killed the process AND its relay
# reservation; the relaunched runner must re-establish it before we trust any dial
# that follows. Re-gate on the SAME RELAY_READY_MARKER, same idiom as the D-09 gate.
echo "[run-replication-proof] D-10: waiting for relayReservation= marker on Peer A after D-05 relaunch ..."
wait_for_logcat_line "${RELAY_READY_MARKER}" "${MARKER_TIMEOUT}" "[run-replication-proof]" "relay-ready-d05-relaunch" "-s ${PEER_A_SERIAL}" > /dev/null
echo "[run-replication-proof] D-10: relay reservation re-established on Peer A after D-05 relaunch"


# ── D-06: peers >= 1 ───────────────────────────────────────────────────────────
echo "[run-replication-proof] D-06: waiting for peers= marker on Peer A ..."
PEERS_LINE=$(wait_for_logcat_line "${PEERS_MARKER}" "${LOGCAT_TIMEOUT}" "[run-replication-proof]" "peers" "-s ${PEER_A_SERIAL}")
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
# Phase 1 — reach the START of the acquire. Until this marker lands the runner is still in boot,
# enrolment and the auth gate, none of which is strand work; charging their cost to the strand
# budget is what made run 25 unreadable.
echo "[run-replication-proof] REPL-01: waiting for the acquire-start marker (controlRelayAddrs=) on Peer A (timeout ${ACQUIRE_START_TIMEOUT}s) ..."
ACQUIRE_START_LINE=$(read_logcat_line_now "${ACQUIRE_START_MARKER}" "${PEER_A_SERIAL}" $((ACQUIRE_START_TIMEOUT / 5)))
if [ -z "${ACQUIRE_START_LINE}" ]; then
  echo "[run-replication-proof] FAIL: controlRelayAddrs= marker never emitted on Peer A within ${ACQUIRE_START_TIMEOUT}s — the runner never reached the strand acquire (REPL-01 phase 1); the failure is upstream of strand wiring, read the auth gate markers" >&2
  exit 1
fi
echo "[run-replication-proof] REPL-01: acquire started on Peer A: ${ACQUIRE_START_LINE}"

# Phase 2 — the acquire itself, budgeted from here. Polled, not streamed: strandPeers= is a
# once-per-boot marker and wait_for_logcat_line would burn the full 420s even on success (IN-19,
# see read_logcat_line_now). The runner heartbeats `acquire pending <n> s` throughout, so a run
# that spends this budget can be read afterwards as slow-but-alive or genuinely stuck.
echo "[run-replication-proof] REPL-01: waiting for strandPeers= marker on Peer A (timeout ${STRAND_PEERS_TIMEOUT}s, measured from acquire start) ..."
STRAND_PEERS_LINE=$(read_logcat_line_now "${STRAND_PEERS_MARKER}" "${PEER_A_SERIAL}" $((STRAND_PEERS_TIMEOUT / 5)))
if [ -z "${STRAND_PEERS_LINE}" ]; then
  echo "[run-replication-proof] FAIL: strandPeers= marker never emitted on Peer A within ${STRAND_PEERS_TIMEOUT}s of the acquire starting (REPL-01 phase 2)" >&2
  echo "[run-replication-proof] --- acquire heartbeat on Peer A (was it alive?) ---" >&2
  adb -s ${PEER_A_SERIAL} logcat -d 2>/dev/null | grep -E 'acquire pending|acquire settled|write phase' | tail -10 >&2
  exit 1
fi
SP=$(extract_marker_value "${STRAND_PEERS_LINE}" "strandPeers")
echo "[run-replication-proof] REPL-01: strandPeers=${SP} on Peer A"
if [ -z "${SP}" ] || [ "${SP}" -lt 1 ]; then
  # W1b (2026-09-10): NO LONGER FATAL. The Phase-30 premise below — "the runner waits, so a
  # sustained strandPeers < 1 is a genuine cohort-formation failure" — is FALSE against the
  # enrolment ceremony added in ad559fa5. The runner's wait is STRAND_PEER_POLL_MAX (was 10s)
  # while drone.mjs holds each newly-seen peer for DELEGATE_GRACE_MS (15s) before accepting it,
  # so a peer that connects late reads strandPeers=0 simply because it is NOT YET A MEMBER.
  # Measured in run 4: drone-A lived 42s, the two peers connected at ~34s and needed grace until
  # ~49s; this abort killed the drones at 42s and the ceremony never finished. The run then
  # reported a cohort-formation failure that had not occurred.
  #
  # Aborting here also DESTROYS the diagnostics that explain the run: the read-phase row census
  # and the drone's `DENYING ... not in the materialized authorized set (N member(s))` lines all
  # come later. Warn and continue to the verdict poll; the verdict still decides pass/fail, so
  # nothing is hidden — a genuine cohort failure still ends in FAIL, with evidence attached.
  echo "[run-replication-proof] WARNING: strandPeers=${SP} < 1 on Peer A at sample time (REPL-01) — continuing to the verdict poll so the ceremony can finish and the diagnostics survive" >&2
else
  echo "[run-replication-proof] REPL-01 cohort signal: strandPeers=${SP} >= 1 on Peer A"
fi

# ── D-04: per-drone relay-reservation instrumentation (diagnostic, non-gating) ──
# Captures the relayAddrsPerDrone= marker on BOTH peers so a wall-#8-class per-drone
# reservation asymmetry (reserved with only ONE drone instead of both) is visible from
# run #1, without waiting for a costly FAIL verdict to investigate. Diagnostic only —
# does NOT gate the run (warn-and-continue on a miss), since the both-peer REPLICATION
# VERDICT below remains the authoritative PASS/FAIL signal.
echo "[run-replication-proof] D-04: waiting for relayAddrsPerDrone= marker on ${PEER_A_SERIAL} (timeout ${RELAY_ADDRS_PER_DRONE_TIMEOUT}s) ..."
RELAY_ADDRS_LINE_A=$(read_logcat_line_now "${RELAY_ADDRS_PER_DRONE_MARKER}" "${PEER_A_SERIAL}" $((RELAY_ADDRS_PER_DRONE_TIMEOUT / 5)))
if [ -n "${RELAY_ADDRS_LINE_A}" ]; then
  echo "[run-replication-proof] D-04: relayAddrsPerDrone= on ${PEER_A_SERIAL}: ${RELAY_ADDRS_LINE_A}"
else
  echo "[run-replication-proof] D-04 WARNING: relayAddrsPerDrone= marker never appeared on ${PEER_A_SERIAL} (diagnostic only, not gating)" >&2
fi
echo "[run-replication-proof] D-04: waiting for relayAddrsPerDrone= marker on ${PEER_B_SERIAL} (timeout ${RELAY_ADDRS_PER_DRONE_TIMEOUT}s) ..."
RELAY_ADDRS_LINE_B=$(read_logcat_line_now "${RELAY_ADDRS_PER_DRONE_MARKER}" "${PEER_B_SERIAL}" $((RELAY_ADDRS_PER_DRONE_TIMEOUT / 5)))
if [ -n "${RELAY_ADDRS_LINE_B}" ]; then
  echo "[run-replication-proof] D-04: relayAddrsPerDrone= on ${PEER_B_SERIAL}: ${RELAY_ADDRS_LINE_B}"
else
  echo "[run-replication-proof] D-04 WARNING: relayAddrsPerDrone= marker never appeared on ${PEER_B_SERIAL} (diagnostic only, not gating)" >&2
fi

# ── BOTH-PEER VERDICT (D-01) ──────────────────────────────────────────────────
# Poll BOTH serials. A and B emit REPLICATION VERDICT independently.
# Polled, not streamed, and budgeted for the LAGGING peer. The verdict is a once-per-boot
# marker, so wait_for_logcat_line burned its whole window whether or not it matched (IN-19,
# see read_logcat_line_now) — and worse, the window was LOGCAT_TIMEOUT=180 s measured from
# whenever the harness happened to arrive here, while the read phase alone runs 120 ticks
# (~125 s) and the two peers start it minutes apart.
#
# Run 26 is what that costs: BOTH peers emitted `REPLICATION VERDICT: FAIL`, Peer A's simply
# landing ~27 s after its window shut. The harness reported "one or both peers did not emit a
# verdict" — a statement about the instrument dressed as a statement about the peers. The
# verdict was FAIL either way there, so nothing was misjudged; on a PASS it would have
# discarded the pass.
#
# Raised from 420 (commit 1920b696) — that value assumed the runner's own "REPL_POLL_MAX: 120
# ticks x 1 s = 120 s" comment held on device. It does not: the 2026-09-28 device run captured
# Peer A still at `read tick 105` of 120 when THIS poll gave up after burning its full 420 s
# window — ~4 s per tick, not 1 s, because each tick's `SELECT Id FROM Authority` is a real
# distributed-DB round trip, not a local read. At that measured rate a full 120-tick read phase
# needs ~480 s; budget for the bad case (same margin pattern as STRAND_PEERS_TIMEOUT/
# STRAND_TIMEOUT above, both raised past their own measured worst case for the same reason).
# 2026-10-08 run 8: the founder's genesis + invite ceremony took ~4 min after its acquire, and
# the joiner then needs minutes more to accept and create its authority, so both read phases run
# far longer than the 120-tick default. The runner's device budgets are injected below
# (PROOF_INVITE_SLOT_POLL_MAX / PROOF_READ_POLL_MAX); this poll must outlast them.
VERDICT_TIMEOUT=1200
echo "[run-replication-proof] Polling REPLICATION VERDICT on ${PEER_A_SERIAL} (${VERDICT_TIMEOUT}s) ..."
VERDICT_A=$(read_logcat_line_now "${VERDICT_TAG}" "${PEER_A_SERIAL}" $((VERDICT_TIMEOUT / 5)))
echo "[run-replication-proof] Polling REPLICATION VERDICT on ${PEER_B_SERIAL} (${VERDICT_TIMEOUT}s) ..."
VERDICT_B=$(read_logcat_line_now "${VERDICT_TAG}" "${PEER_B_SERIAL}" $((VERDICT_TIMEOUT / 5)))

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
  # Mislabel fix (2026-09-28): this used to read "${LOGCAT_TIMEOUT}s" (180s), a leftover from
  # before commit 1920b696 raised the ACTUAL poll budget to VERDICT_TIMEOUT — the message never
  # matched what the script actually waited, and reading it (rather than the real code) is what
  # produced the "180s" mislabel in prior run write-ups. Report the timeout that was really used.
  echo "[run-replication-proof] ERROR: one or both peers did not emit a verdict within ${VERDICT_TIMEOUT}s — FAIL" >&2
  exit 1
fi

if echo "${VERDICT_A}" | grep -q "FAIL" || echo "${VERDICT_B}" | grep -q "FAIL"; then
  echo "[run-replication-proof] ========== REPLICATION VERDICT: FAIL (A: ${VERDICT_A}  B: ${VERDICT_B}) =========="
  exit 1
fi

echo "[run-replication-proof] ========== REPLICATION VERDICT: PASS (both peers) =========="
exit 0
