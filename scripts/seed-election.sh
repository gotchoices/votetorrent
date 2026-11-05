#!/usr/bin/env bash
# seed-election.sh - seed an all-host VoteTorrent election up to a chosen stage (2026-11-03).
#
# Drives the lean host rig in tools/lean-rig (see its README): lean-part1.sh (officer founds the network, kh-a + kh-b join) and
# lean-part2.ts via run-lean.sh with SEED_STOP=<stage>. For any stage short of "full" the host peers are HELD live after the stage
# (officer, kh-a, kh-b, and the host voters once seeded) so you can carry on by hand (phones, dashboard). Ctrl-C releases them cleanly.
#
# Machine-local inputs, both outside the repo (run dirs hold secrets):
#   VT_LEAN_RUNS       run dirs (seed-<stamp>), default <checkout>/../vt-lean-runs
#   VT_LEAN_RELAY_ENV  the relay to use, default $VT_LEAN_RUNS/relay.env (RELAY_MULTIADDR=, PEER_ID=, LAN_IP=, STARTED_AT=)
#
# Stages (each includes the ones before it):
#   1 network     officer founds the network, mints the join code (secrets/n7-code.txt), kh-a + kh-b join
#   2 election    officer intake key + election + ballot, confirmed, with the chosen timeline
#   3 keyholders  both keyholder seats invited and accepted (threshold 2)
#   4 dkg         keyholders run the DKG: the election key is published
#   5 voters      2 host voters join (secrets/hr5-code.txt), register, are approved and associated; the officer keeps approving
#                 new registrations during the hold, and at votingStarts the 2 host voters cast their votes (a 3rd voter, e.g. a
#                 phone, fills the pool of 3)
#   6 full        the whole election: 3 voters vote, keys released, decrypt, results + publish (no hold)
#
# Usage: scripts/seed-election.sh                                   interactive
#        scripts/seed-election.sh <stage> [--minutes N] [--network NAME] [--title T] [--yes]
#        stage: 1-6 or network|election|keyholders|dkg|voters|full; --minutes: 60, 90, 120 or any N >= 35 (election length)
# Env passed through to the driver: LEAN_DEBUG, SEED_HOLD_MIN (hold length override), SEED_HV_N (voters stage, default 2).
set -u
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
REPO="$(cd "$(dirname "$SELF")/.." && pwd)"
LEAN="$REPO/tools/lean-rig/lean"
export VT_LEAN_RUNS="${VT_LEAN_RUNS:-$(dirname "$REPO")/vt-lean-runs}"
export VT_LEAN_RELAY_ENV="${VT_LEAN_RELAY_ENV:-$VT_LEAN_RUNS/relay.env}"
case "$VT_LEAN_RUNS/" in "$REPO/"*) echo "REFUSE: VT_LEAN_RUNS is inside the repo (run dirs hold secrets)"; exit 2 ;; esac
cd "$LEAN" || exit 2

STAGES="network election keyholders dkg voters full"
stage_of () { case "$1" in 1|network) echo network ;; 2|election) echo election ;; 3|keyholders) echo keyholders ;; 4|dkg) echo dkg ;;
  5|voters) echo voters ;; 6|full) echo full ;; *) echo "" ;; esac; }

STAGE=""; MINUTES=""; NET_NAME=""; TITLE=""; YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --minutes) MINUTES="${2:-}"; shift 2 ;;
    --hours) case "${2:-}" in 1) MINUTES=60 ;; 1.5) MINUTES=90 ;; 2) MINUTES=120 ;; *) echo "--hours takes 1, 1.5 or 2"; exit 2 ;; esac; shift 2 ;;
    --network) NET_NAME="${2:-}"; shift 2 ;;
    --title) TITLE="${2:-}"; shift 2 ;;
    --yes|-y) YES=1; shift ;;
    -h|--help) awk 'NR > 1 && !/^#/ { exit } NR > 1' "$SELF"; exit 0 ;;
    *) STAGE="$(stage_of "$1")"; [ -n "$STAGE" ] || { echo "unknown stage: $1 (one of: $STAGES)"; exit 2; }; shift ;;
  esac
done

# ---- preflight -------------------------------------------------------------------------------------------------------
live="$(ps -axo pid,command | grep -E 'lean-part2\.ts|host-voter\.ts|lean-part1\.sh' | grep -v grep)"
if [ -n "$live" ]; then
  echo "REFUSE: another lean run is live (same party \"votetorrent\" on the relay; a second one forks the control network):"
  echo "$live"; exit 3
fi
[ -s "$VT_LEAN_RELAY_ENV" ] || { echo "REFUSE: no relay config at $VT_LEAN_RELAY_ENV (see tools/lean-rig/README.md)"; exit 3; }
relay_from="$(grep -E '^STARTED_AT=' "$VT_LEAN_RELAY_ENV" | cut -d= -f2-)"
if [ -n "${LEAN_PHONE:-}${LEAN_PHONE_KH:-}${LEAN_PHONE_KH2:-}${LEAN_PHONE_VOTER:-}" ]; then
  echo "NOTE: LEAN_PHONE* is set - the driver will wait on phone flags (see KH2-PLAN.md). seed.sh is meant for all-host runs."
fi

# ---- choices -----------------------------------------------------------------------------------------------------------
if [ -z "$STAGE" ]; then
  echo "Seed the election up to which stage?"
  echo "  1) network     - create the network (officer + 2 keyholder peers joined)"
  echo "  2) election    - + create the election and ballot"
  echo "  3) keyholders  - + keyholders accept their seats"
  echo "  4) dkg         - + keyholders run the DKG (election key ready)"
  echo "  5) voters      - + 2 voters registered and associated"
  echo "  6) full        - the whole election: vote, release, decrypt, results"
  while [ -z "$STAGE" ]; do read -r -p "stage [1-6]: " a; STAGE="$(stage_of "$a")"; done
fi
if [ "$STAGE" != network ] && [ -z "$MINUTES" ]; then
  echo "How long should the election run (creation -> closed)?"
  echo "  1) 1 h    (voting opens in ~39 min, 15 min voting window)"
  echo "  2) 1.5 h  (voting opens in ~64 min, 20 min voting window)"
  echo "  3) 2 h    (voting opens in ~89 min, 25 min voting window)"
  echo "  4) custom (minutes, >= 35)"
  while [ -z "$MINUTES" ]; do
    read -r -p "timeline [1-4]: " a
    case "$a" in 1) MINUTES=60 ;; 2) MINUTES=90 ;; 3) MINUTES=120 ;; 4) read -r -p "minutes: " MINUTES ;; esac
  done
fi
MINUTES="${MINUTES:-60}"
case "$MINUTES" in ''|*[!0-9]*) echo "minutes must be a whole number"; exit 2 ;; esac
[ "$MINUTES" -ge 35 ] || { echo "minutes must be >= 35 (the host voters need ~15 min to register before voting opens)"; exit 2; }
# window: 15/20/25 min for the presets, else a fifth of the length clamped to 10-30; 6 min of hashing/release/tally after it
case "$MINUTES" in 60) WIN=15 ;; 90) WIN=20 ;; 120) WIN=25 ;; *) WIN=$((MINUTES / 5)); [ $WIN -lt 10 ] && WIN=10; [ $WIN -gt 30 ] && WIN=30 ;; esac
LEAD=$((MINUTES - WIN - 6))
[ $LEAD -ge 15 ] || { echo "lead to votingStarts would be ${LEAD} min (< 15); pick a longer election"; exit 2; }

STAMP="$(date +%Y%m%d-%H%M%S)"
SHORT="$(date +%H%M)"
NET_NAME="${NET_NAME:-Seed Network $SHORT}"
TITLE="${TITLE:-seed-election-$SHORT}"
BALLOT="seed-ballot-$STAMP"
mkdir -p "$VT_LEAN_RUNS"; chmod 700 "$VT_LEAN_RUNS"
RD="$VT_LEAN_RUNS/seed-$STAMP"
HOLD_MIN="${SEED_HOLD_MIN:-}"
[ "$STAGE" = network ] && [ -z "$HOLD_MIN" ] && HOLD_MIN=120
# alarms: the driver (perl alarm, no cleanup) and the host voters must outlive the election + the hold
ALARM_MIN=$((MINUTES + 40)); [ -n "$HOLD_MIN" ] && [ $((HOLD_MIN + 40)) -gt $ALARM_MIN ] && ALARM_MIN=$((HOLD_MIN + 40))

echo
echo "  stage      $STAGE"
echo "  network    \"$NET_NAME\"   (relay: ${relay_from:-?})"
[ "$STAGE" != network ] && echo "  election   \"$TITLE\"  ${MINUTES} min: votingStarts = creation + ${LEAD} min, window ${WIN} min, closed + 6 min"
[ "$STAGE" != full ] && echo "  hold       peers stay live until Ctrl-C$([ -n "$HOLD_MIN" ] && echo " or ${HOLD_MIN} min" || echo " or 10 min after the election closes")"
echo "  run dir    $RD"
echo "  NOTE: nothing else of party \"votetorrent\" may be live on this relay (phones from another run included)."
if [ $YES -ne 1 ]; then read -r -p "go? [y/N] " a; case "$a" in y|Y|yes) ;; *) echo "aborted"; exit 1 ;; esac; fi

# ---- part 1: network ---------------------------------------------------------------------------------------------------
T0=$(date +%s)
mkdir -p "$RD"
KHB=with-khb; [ -n "${LEAN_PHONE:-}${LEAN_PHONE_KH:-}${LEAN_PHONE_KH2:-}" ] && KHB=""
echo "[seed] part 1: founding \"$NET_NAME\" ..."
LEAN_NET_NAME="$NET_NAME" ./lean-part1.sh "$RD" $KHB > "$RD/part1.out" 2>&1
grep -E 'LEAN-P1|joined:|found n7' "$RD/part1.out" | sed 's/^/[part1] /'
grep -q 'LEAN-P1: PASS' "$RD/part1.out" || { echo "[seed] part 1 FAILED - see $RD/part1.out"; exit 1; }

# ---- part 2: up to the stage -------------------------------------------------------------------------------------------
export LEAN_TITLE="$TITLE" LEAN_BALLOT="$BALLOT"
export HR5_LEAD_MS=$((LEAD * 60000)) HR5_WINDOW_MS=$((WIN * 60000))
export LEAN_ALARM_S=$((ALARM_MIN * 60)) LEAN_HV_ALARM_S=$(((MINUTES + 25) * 60)) HV_MAX_RUNTIME_MS=$(((MINUTES + 20) * 60000))
[ -n "$HOLD_MIN" ] && export SEED_HOLD_MIN="$HOLD_MIN"
if [ "$STAGE" = full ]; then
  unset SEED_STOP
  # all-host: no device Results screens to open first, so skip the 10 min publish-go wait
  [ -z "${LEAN_PHONE:-}${LEAN_PHONE_KH:-}${LEAN_PHONE_KH2:-}${LEAN_PHONE_VOTER:-}" ] && : > "$RD/secrets/flag-publish-go"
else
  export SEED_STOP="$STAGE"
fi
EV="$RD/ev"; LOG="$EV/driver.log"
echo "[seed] part 2: driver -> $LOG"
./run-lean.sh run "$EV" "$RD" > "$RD/part2.out" 2>&1 &
RUNPID=$!
DRV=""
for _ in $(seq 1 50); do DRV="$(pgrep -P $RUNPID | head -1)"; [ -n "$DRV" ] && break; sleep 0.2; done

STOPS=0
on_int () {
  STOPS=$((STOPS + 1))
  : > "$RD/secrets/flag-seed-stop" 2>/dev/null
  [ -n "$DRV" ] && kill -TERM "$DRV" 2>/dev/null
  if [ $STOPS -eq 1 ]; then echo; echo "[seed] stopping cleanly (current leg finishes, peers close; up to ~1 min). Ctrl-C twice more to force."
  elif [ $STOPS -ge 3 ] && [ -n "$DRV" ]; then kill -KILL "$DRV" 2>/dev/null; fi
}
trap on_int INT TERM

# progress: the driver's leg / wait / seed lines
for _ in $(seq 1 100); do [ -e "$LOG" ] && break; sleep 0.2; done
( tail -n +1 -F "$LOG" 2>/dev/null | grep --line-buffered -E 'LEG +h?[0-9a-z-]+ (start|PASS|FAIL|VOID)|SEED-|LEAN-WAIT|SOFT-FAIL|CRASH|FATAL|SUMMARY' ) &
TAILPID=$!

SHOWN=0
while kill -0 $RUNPID 2>/dev/null; do
  if [ $SHOWN -eq 0 ] && [ -s "$EV/seed-state.json" ]; then
    SHOWN=1
    echo
    echo "================ SEEDED: $STAGE  ($(( ($(date +%s) - T0) / 60 )) min) ================"
    jq -r '"network     \(.networkHash[0:16])…  authority \(.authorityId[0:16])…",
           (if .election then "election    \(.election.title)  id \(.election.id)\n  votingStarts \(.election.timeline.votingStarts)\n  accruing     \(.election.timeline.accruingVotes)\n  closed       \(.election.timeline.closed)" else empty end),
           "host peers  \(.hostPeers | join(", "))" + (if (.hostVoters | length) > 0 then "   host voters \(.hostVoters | join(", "))" else "" end),
           "files:", (.files[] | "  " + .),
           "holding until \(.holdUntil)"' "$EV/seed-state.json" 2>/dev/null || cat "$EV/seed-state.json"
    echo "network join code (Authority app):  $RD/secrets/n7-code.txt"
    [ -s "$RD/secrets/hr5-code.txt" ] && echo "voter join code (Voter app):        $RD/secrets/hr5-code.txt"
    echo "Ctrl-C to stop the peers.  State: $EV/seed-state.json"
    echo "================================================================"
  fi
  sleep 1 & wait $! 2>/dev/null   # short + interruptible: the banner check and the Ctrl-C trap both stay responsive
done
wait $RUNPID 2>/dev/null
sleep 1; kill $TAILPID 2>/dev/null; wait $TAILPID 2>/dev/null
trap - INT TERM
rm -f "$RD/secrets/flag-seed-stop"

SUM="$(grep -E '^SUMMARY ' "$LOG" 2>/dev/null | tail -1)"
echo "[seed] driver ended: ${SUM:-no SUMMARY (see $RD/part2.out)}  after $(( ($(date +%s) - T0) / 60 )) min"
echo "[seed] results: $EV/driver-results.json"
case "$SUM" in "SUMMARY PASS") exit 0 ;; *) exit 1 ;; esac
