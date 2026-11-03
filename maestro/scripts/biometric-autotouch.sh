#!/usr/bin/env bash
# biometric-autotouch.sh <emulator-serial> - answer every BiometricPrompt on an EMULATOR with the
# enrolled fingerprint (`adb emu finger touch 1`), until killed.
#
# Maestro cannot touch an emulator's fingerprint sensor, and the apps sign with Keystore keys that
# need a biometric for every use (register, vote, sign, release). scripts/run.sh runs this in the
# background for the whole run. Same approach as the phase-64 rig's prompt watcher: poll the focused
# window, wait a moment for the prompt to arm, then touch.
#
# Emulator only: a physical phone has no `emu` console, so answer its prompts by hand.
# The emulator needs an enrolled fingerprint (finger id 1) and a screen-lock PIN; see README.
set -u
S="${1:?usage: biometric-autotouch.sh <emulator-serial>}"
case "$S" in
	emulator-*) ;;
	*) echo "refusing: $S is not an emulator" >&2; exit 2 ;;
esac

POLL_S="${BIO_POLL_S:-1}"
ARM_S="${BIO_ARM_S:-0.8}"
touches=0
while true; do
	focus="$(adb -s "$S" shell dumpsys window 2>/dev/null | tr -d '\r' | grep -m1 'mCurrentFocus=' || true)"
	case "$focus" in
		*BiometricPrompt*|*biometric*|*Biometric*)
			sleep "$ARM_S"
			adb -s "$S" emu finger touch 1 >/dev/null 2>&1 || true
			touches=$((touches + 1))
			echo "$(date -u +%H:%M:%S) touch #$touches ($focus)"
			# Give the prompt time to close before polling again, so one prompt gets one touch.
			sleep 2
			;;
	esac
	sleep "$POLL_S"
done
