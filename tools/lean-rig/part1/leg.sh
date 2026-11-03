#!/usr/bin/env bash
# leg.sh - sourced helper library of the lean rig part 1 (tools/lean-rig/part1; from plan 64-62's leg.sh, 2026-11-03): command log,
# key lines, peer launch/stop, control calls. The rehearsal-only leg open/close/verdict helpers (quiet-host preflight, D-14 snapshots)
# were not carried; lean-part1.sh never called them.
# Inputs (set by lean-part1.sh): HR5_PD, HR5_ST, HR5_RUN_ROOT, HR5_SEC, HR5_WORK, and VT_LEAN_RELAY_ENV (the relay.env file).
unset -f grep find 2>/dev/null
export FORCE_COLOR=0
S62="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # tools/lean-rig/part1
LEAN_RIG="$(cd "$S62/.." && pwd)"                      # tools/lean-rig
REPO="$(cd "$LEAN_RIG/../.." && pwd)"
WORK="${HR5_WORK:?HR5_WORK is not set}"
PD="${HR5_PD:?HR5_PD is not set}"
ST="${HR5_ST:?HR5_ST is not set}"
RUN="${HR5_RUN_ROOT:?HR5_RUN_ROOT is not set}"
SEC="${HR5_SEC:?HR5_SEC is not set}"
RELAY_ENV="${VT_LEAN_RELAY_ENV:?VT_LEAN_RELAY_ENV is not set}"
HR5_PEER_BOUND_S="${HR5_PEER_BOUND_S:-300}"

iso () { date -u +%Y-%m-%dT%H:%M:%SZ; }
nowms () { node -e 'console.log(Date.now())'; }
relay_get () { sed -n "s/^$1=//p" "$RELAY_ENV" | head -1; }

# cl <command text...>: append a command to PD/commands.log with $LEAN_RIG, $REPO and $HOME rewritten; the LAN IP is refused (exit 3).
cl () {
  local text="$*" lan
  lan="$(relay_get LAN_IP)"
  if [ -n "$lan" ]; then case "$text" in *"$lan"*) echo "cl: refused (the command text holds the LAN IP)" >&2; return 3 ;; esac; fi
  text="${text//$LEAN_RIG/<lean-rig>}"
  text="${text//$REPO/<repo>}"
  text="${text//$HOME/<home>}"
  [ -d "$PD" ] && printf '%s %s\n' "$(iso)" "$text" >> "$PD/commands.log"
  return 0
}

# ll <leg> <line>: append a driver line to the leg log.
ll () { printf '%s\n' "${2}" >> "$PD/$1/leg.log"; }

# kv <KEY> <value>: append a HR5 key line to keys.txt, write-once per key.
kv () {
  if grep -q "^$1:" "$WORK/keys.txt" 2>/dev/null; then echo "kv: $1 already written" >&2; return 3; fi
  printf '%s: %s\n' "$1" "$2" >> "$WORK/keys.txt"
}

# ---- peers -------------------------------------------------------------------------------------------------------------
# launch_peer <role>: start the part-1 peer (cwd packages/vote-engine), wait for READY or BOOT-FAILED. 0 ready, 1 failed/timeout, 3 refused.
launch_peer () {
  local role="$1" d="$RUN/$1" n L pid
  mkdir -p "$d"; chmod 700 "$d"
  n=$(( $(/bin/ls "$d" 2>/dev/null | grep -c '^peer-[0-9][0-9]*\.log$') + 1 ))
  L="$d/peer-$n.log"
  if [ -e "$L" ]; then echo "launch_peer: $L exists" >&2; return 3; fi
  rm -f "$d/ctl.port" "$d/pid"
  cl "launch peer $role (log peer-$n.log): cd packages/vote-engine && env -u NODE_OPTIONS -u DEBUG FORCE_COLOR=0 TS_NODE_PROJECT=./tsconfig.test.json HR5_ROLE=$role nohup node --import ./register-ts-node.mjs --import \$S62/register-hr5-hooks.mjs --experimental-specifier-resolution=node \$S62/hr5-peer.ts"
  (
    cd "$REPO/packages/vote-engine" || exit 1
    env -u NODE_OPTIONS -u DEBUG FORCE_COLOR=0 TS_NODE_PROJECT=./tsconfig.test.json HR5_ROLE="$role" HR5_STATE="$ST" HR5_RUN="$d" \
      HR5_RELAY_ENV="$RELAY_ENV" HR5_TOKEN_FILE="$SEC/ctl.token" HR5_ASYNC_STORAGE_FILE="$ST/$role/async-storage.json" \
      nohup node --import ./register-ts-node.mjs --import "$S62/register-hr5-hooks.mjs" --experimental-specifier-resolution=node "$S62/hr5-peer.ts" > "$L" 2>&1 &
    echo $! > "$d/launch.pid"
  )
  pid="$(cat "$d/launch.pid")"
  ps -o command= -p "$pid" | grep -q 'hr5-peer.ts' || { echo "launch_peer: pid $pid is not hr5-peer.ts" >&2; return 1; }
  local t=0
  while [ "$t" -lt "$HR5_PEER_BOUND_S" ]; do
    if grep -q '^HR5-PEER-READY ' "$L" 2>/dev/null; then grep '^HR5-PEER-READY ' "$L" | head -1; return 0; fi
    if grep -q '^HR5-PEER-BOOT-FAILED ' "$L" 2>/dev/null; then grep '^HR5-PEER-BOOT-FAILED ' "$L" | head -1; return 1; fi
    kill -0 "$pid" 2>/dev/null || { echo "HR5-PEER-EXITED role=$role"; return 1; }
    sleep 1; t=$((t + 1))
  done
  echo "HR5-PEER-TIMEOUT role=$role"
  return 1
}

# ctlv <role> <verb> [json]: one JSON line, logged to commands.log.
ctlv () {
  cl "hr5-ctl $1 $2 ${3:-}"
  HR5_RUN_ROOT="$RUN" HR5_SEC="$SEC" node "$S62/hr5-ctl.mjs" "$@"
}

peer_pid () { cat "$RUN/$1/pid" 2>/dev/null; }

pid_gone () { # <pid> <seconds>
  local pid="$1" t=0
  while [ "$t" -lt "$2" ]; do kill -0 "$pid" 2>/dev/null || return 0; sleep 1; t=$((t + 1)); done
  kill -0 "$pid" 2>/dev/null && return 1
  return 0
}

# stop_peer <role>: stop verb, pid gone within 15 s, else SIGTERM (recorded); never deletes state. 0 stopped, 1 not stopped.
stop_peer () {
  local role="$1" pid
  pid="$(cat "$RUN/$role/launch.pid" 2>/dev/null)"
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  ctlv "$role" stop >/dev/null 2>&1
  if pid_gone "$pid" 15; then return 0; fi
  kill -TERM "$pid" 2>/dev/null
  pid_gone "$pid" 10 && { echo "stop_peer: $role needed SIGTERM" >&2; return 0; }
  return 1
}

# poll_until <seconds> <command...>: re-run the command once a second until it exits 0 or the bound passes.
poll_until () {
  local bound="$1" t=0
  shift
  while [ "$t" -lt "$bound" ]; do "$@" >/dev/null 2>&1 && return 0; sleep 1; t=$((t + 1)); done
  return 1
}

# ctlq <role> <verb> [json]: like ctlv without the commands.log line (polling loops).
ctlq () { HR5_RUN_ROOT="$RUN" HR5_SEC="$SEC" node "$S62/hr5-ctl.mjs" "$@"; }
