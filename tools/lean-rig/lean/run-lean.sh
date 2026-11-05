#!/usr/bin/env bash
# run-lean.sh <selfcheck|run> <ev-dir> <run-dir> - lean hardware run launcher (2026-10-29; tools/lean-rig since 2026-11-03). LEAN_PHONE=1 for
# the phone run; HR5_LEAD_MS/HR5_WINDOW_MS knobs. Both dirs must be absolute and outside the repo (secrets).
unset -f grep find 2>/dev/null
export FORCE_COLOR=0
MODE="$1"; EV="$2"; RD="${3:-}"
S="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$S/../../.." && pwd)"
[ -n "$EV" ] || { echo "usage: $0 selfcheck|run <ev-dir>"; exit 2; }
case "$EV" in /*) ;; *) echo "REFUSE: <ev-dir> must be absolute"; exit 2 ;; esac
case "$EV/" in "$REPO/"*) echo "REFUSE: <ev-dir> is inside the repo"; exit 2 ;; esac
. "$S/links.sh"
mkdir -p "$EV"
case "$MODE" in selfcheck) A=300; LOG="$EV/selfcheck.log" ;; run) A="${LEAN_ALARM_S:-7200}"; LOG="$EV/driver.log" ;; *) echo usage; exit 2 ;; esac
[ -e "$LOG" ] && { echo "REFUSE: $LOG exists"; exit 3; }
cd "$REPO/packages/vote-engine" || exit 9
# LEAN_DEBUG (E88 diagnosis): optimystic debug namespaces; their stderr goes to $EV/debug.log, the driver's stdout to $LOG
DBG=(); [ -n "${LEAN_DEBUG:-}" ] && DBG=(DEBUG="$LEAN_DEBUG" DEBUG_COLORS=0 DEBUG_HIDE_DATE=0)
env -u NODE_OPTIONS -u DEBUG "${DBG[@]}" FORCE_COLOR=0 TS_NODE_PROJECT=./tsconfig.test.json HR5_MODE="$MODE" HR5_EV="$EV" HR5_SCRATCH="$S" HR5_PRECHECK_ENV="$RD/precheck.env" HR5_STATE_DIR="$RD/state" HR5_SEC="$RD/secrets" HR5_PIDS_FILE="$RD/hv-pids.txt" \
  perl -e "alarm $A; exec @ARGV" node --import ./register-ts-node.mjs --experimental-specifier-resolution=node "$S/lean-part2.ts" > "$LOG" 2> "${LEAN_DEBUG:+$EV/debug.log}${LEAN_DEBUG:+}$([ -z "${LEAN_DEBUG:-}" ] && echo /dev/stdout)"
echo "exit=$?"
