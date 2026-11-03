#!/usr/bin/env bash
# run-multi-device.sh - orchestrate the journeys where an Authority and a Voter talk over the
# network. Each step is a normal per-device flow run through run.sh; this script only sequences
# them, swaps the one Metro on :8081 between the apps, and moves the join code.
#
# Modes:
#   same-device-join --device <emu>
#       ONE emulator, both apps installed. The Authority founds a network and mints a voter join
#       code (COPY puts it on the emulator clipboard); then the Voter pastes it and joins.
#       Steps: authority/mint-voter-join-code.yaml -> multi-device/voter-join-network.yaml
#       (JOIN_VIA=paste). Needs a reachable relay: pass --env RELAY_MULTIADDR=<your relay>.
#
#   host-seeded-voter --device <serial> --join-code-file <file>
#       A host-seeded election (scripts/seed-election.sh voters: officer + keyholders + 2 host
#       voters, officer auto-approves registrations, held live). The Voter joins with the code in
#       <file>, registers and waits for approval, then votes when voting opens and sends.
#       Steps: voter-join-network (JOIN_VIA=type) -> voter-register-and-await-decision ->
#       voter-vote-when-open. Pass --env VOTE_PICK_1=<option code> ... for that ballot.
#
#   officer-approves --authority-device <serial> --voter-device <serial> --join-code-file <file>
#       Two devices, run one after the other. The Voter joins and submits a registration; the
#       officer's Authority device (already an officer on that network with the approval task,
#       e.g. after multi-device/authority-join-network.yaml) approves it; the Voter relaunches
#       and must show the registered card.
#       Steps: voter-join-network -> voter-submit-registration ->
#       authority-registration-decision -> voter-check-registered.
#
# Common options: --start-metro (start/stop Metro per step when :8081 is free), --env KEY=VALUE
# (passed to every step), --allow-physical (phones: answer fingerprint prompts by hand).
#
# The join code is read from the file into the flow's environment only; it is never echoed.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib.sh"

MODE="${1:-}"
[ -n "$MODE" ] || { sed -n '2,33p' "$0"; exit 2; }
shift
DEVICE=""
ADEV=""
VDEV=""
CODE_FILE=""
PASS=()
while [ $# -gt 0 ]; do
	case "$1" in
		--device) DEVICE="${2:?}"; shift 2 ;;
		--authority-device) ADEV="${2:?}"; shift 2 ;;
		--voter-device) VDEV="${2:?}"; shift 2 ;;
		--join-code-file) CODE_FILE="${2:?}"; shift 2 ;;
		--env) PASS+=("--env" "${2:?}"); shift 2 ;;
		--start-metro) PASS+=("--start-metro"); shift ;;
		--allow-physical) PASS+=("--allow-physical"); shift ;;
		*) die "unknown option '$1'" ;;
	esac
done

read_code() {
	[ -n "$CODE_FILE" ] && [ -s "$CODE_FILE" ] || die "--join-code-file <file> is required and must not be empty"
	tr -d ' \r\n' <"$CODE_FILE"
}

run_step() {
	# run_step <device> <flow> [--env K=V ...]
	local dev="$1" flow="$2"
	shift 2
	log ">>> step: $flow on $dev"
	"$HERE/run.sh" --device "$dev" --flow "$flow" ${PASS[@]+"${PASS[@]}"} "$@"
}

case "$MODE" in
	same-device-join)
		[ -n "$DEVICE" ] || die "--device <emulator> is required"
		run_step "$DEVICE" authority/mint-voter-join-code.yaml || die "the Authority could not mint a join code"
		run_step "$DEVICE" multi-device/voter-join-network.yaml --env JOIN_VIA=paste
		;;
	host-seeded-voter)
		[ -n "$DEVICE" ] || die "--device <serial> is required"
		CODE="$(read_code)"
		run_step "$DEVICE" multi-device/voter-join-network.yaml --env JOIN_VIA=type --env "JOIN_CODE=$CODE" || die "join failed"
		run_step "$DEVICE" multi-device/voter-register-and-await-decision.yaml || die "registration was not approved"
		run_step "$DEVICE" multi-device/voter-vote-when-open.yaml
		;;
	officer-approves)
		[ -n "$ADEV" ] && [ -n "$VDEV" ] || die "--authority-device and --voter-device are required"
		[ "$ADEV" != "$VDEV" ] || die "use two devices (or same-device-join for one)"
		CODE="$(read_code)"
		# Sequential on purpose: both debug apps load their JS from the one Metro on :8081, so the
		# two apps never need it at the same moment (run.sh swaps it when --start-metro is given).
		run_step "$VDEV" multi-device/voter-join-network.yaml --env JOIN_VIA=type --env "JOIN_CODE=$CODE" || die "join failed"
		run_step "$VDEV" multi-device/voter-submit-registration.yaml || die "the registration was not submitted"
		run_step "$ADEV" multi-device/authority-registration-decision.yaml || die "the officer could not approve"
		run_step "$VDEV" multi-device/voter-check-registered.yaml
		;;
	*)
		die "unknown mode '$MODE' (same-device-join | host-seeded-voter | officer-approves)"
		;;
esac
