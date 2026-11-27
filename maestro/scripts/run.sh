#!/usr/bin/env bash
# run.sh - run VoteTorrent's Maestro journeys on ONE Android device (an emulator by default).
#
# Usage:
#   maestro/scripts/run.sh [options]                     every single-device journey, both apps
#   maestro/scripts/run.sh --app voter                    only the Voter's journeys
#   maestro/scripts/run.sh --tag smoke                    only flows tagged smoke (repeatable)
#   maestro/scripts/run.sh --flow maestro/voter/timeline.yaml   one flow (repeatable)
#
# Options:
#   --device <serial>     target device (default: the only attached emulator)
#   --app voter|authority restrict to one app's flows
#   --tag <tag>           include only flows with this tag (repeatable; any match)
#   --exclude-tag <tag>   drop flows with this tag (repeatable). multi-device is always dropped
#                         unless you name it with --tag or pass the flow with --flow.
#   --flow <file>         run exactly these flow files, in the order given (repeatable)
#   --env KEY=VALUE       pass a Maestro parameter (repeatable), e.g. --env RELAY_MULTIADDR=/dns4/...
#   --start-metro         start Metro for the app under test when :8081 is free, and stop it at the
#                         end (it never stops a Metro it did not start)
#   --no-biometric-helper do not run the emulator fingerprint helper
#   --allow-physical      allow a physical device (no fingerprint helper; answer prompts by hand)
#   --list                print the selected flows and exit
#
# Output: maestro/.out/<UTC stamp>/ holds one folder per flow (screenshots, maestro logs), a
# JUnit XML per flow, the fingerprint-helper log, and summary.txt. Exit 0 only if every selected
# flow passed.
set -u
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

# Fixed run order. Read-only journeys run before the ones that change app state, and each app's
# flows run together so Metro is swapped at most once. The state-changing flows clear app data
# themselves (registration-request, vote-cast-and-receipt, the Authority's network flows).
ORDER="
voter/launch-home.yaml
voter/tabs.yaml
voter/settings-language.yaml
voter/home-lifecycle-cycler.yaml
voter/join-network-invalid-code.yaml
voter/timeline.yaml
voter/ballot-preview.yaml
voter/keyholders-and-results.yaml
voter/registration-form-validation.yaml
voter/registration-request.yaml
voter/vote-cast-and-receipt.yaml
authority/launch-no-network.yaml
authority/tabs.yaml
authority/join-network-invalid-code.yaml
authority/accept-invitation-entry.yaml
authority/signing-key-setup.yaml
authority/create-network.yaml
authority/mint-voter-join-code.yaml
authority/tasks-seeded-signature.yaml
multi-device/voter-join-network.yaml
multi-device/voter-register-and-await-decision.yaml
multi-device/voter-submit-registration.yaml
multi-device/voter-check-registered.yaml
multi-device/voter-vote-when-open.yaml
multi-device/authority-join-network.yaml
multi-device/authority-registration-decision.yaml
multi-device/authority-keyholder-screen.yaml
multi-device/authority-key-release.yaml
"

DEVICE=""
APP_FILTER=""
TAGS=""
XTAGS=""
FLOWS=""
ENVS=()
START_METRO=0
BIO=1
LIST=0
while [ $# -gt 0 ]; do
	case "$1" in
		--device) DEVICE="${2:?}"; shift 2 ;;
		--app) APP_FILTER="${2:?}"; shift 2 ;;
		--tag) TAGS="$TAGS ${2:?}"; shift 2 ;;
		--exclude-tag) XTAGS="$XTAGS ${2:?}"; shift 2 ;;
		--flow) FLOWS="$FLOWS ${2:?}"; shift 2 ;;
		--env) ENVS+=("-e" "${2:?}"); shift 2 ;;
		--start-metro) START_METRO=1; shift ;;
		--no-biometric-helper) BIO=0; shift ;;
		--allow-physical) export ALLOW_PHYSICAL=1; shift ;;
		--list) LIST=1; shift ;;
		-h|--help) sed -n '2,32p' "$0"; exit 0 ;;
		*) die "unknown option '$1' (see --help)" ;;
	esac
done

# --- select flows ------------------------------------------------------------------------------
SELECTED=""
if [ -n "$FLOWS" ]; then
	for f in $FLOWS; do
		case "$f" in
			/*) p="$f" ;;
			maestro/*) p="$REPO_ROOT/$f" ;;
			*) p="$MAESTRO_DIR_ROOT/$f" ;;
		esac
		[ -f "$p" ] || die "no such flow: $f"
		SELECTED="$SELECTED $p"
	done
else
	case " $TAGS " in *" multi-device "*) ;; *) XTAGS="$XTAGS multi-device" ;; esac
	for rel in $ORDER; do
		p="$MAESTRO_DIR_ROOT/$rel"
		[ -f "$p" ] || continue
		if [ -n "$APP_FILTER" ] && ! flow_has_tag "$p" "$APP_FILTER"; then continue; fi
		if [ -n "$TAGS" ]; then
			hit=0
			for t in $TAGS; do flow_has_tag "$p" "$t" && hit=1; done
			[ "$hit" = "1" ] || continue
		fi
		skip=0
		for t in $XTAGS; do flow_has_tag "$p" "$t" && skip=1; done
		[ "$skip" = "1" ] && continue
		SELECTED="$SELECTED $p"
	done
	# Any journey flow that is not in ORDER still runs, after the ordered ones.
	for p in "$MAESTRO_DIR_ROOT"/voter/*.yaml "$MAESTRO_DIR_ROOT"/authority/*.yaml; do
		[ -f "$p" ] || continue
		case "$ORDER" in *"${p#$MAESTRO_DIR_ROOT/}"*) continue ;; esac
		if [ -n "$APP_FILTER" ] && ! flow_has_tag "$p" "$APP_FILTER"; then continue; fi
		SELECTED="$SELECTED $p"
	done
fi
[ -n "$SELECTED" ] || die "no flows selected"

if [ "$LIST" = "1" ]; then
	for p in $SELECTED; do printf '%-55s %s\n' "${p#$REPO_ROOT/}" "$(flow_tags "$p" | tr '\n' ' ')"; done
	exit 0
fi

# --- preflight ---------------------------------------------------------------------------------
ensure_java
MAESTRO="$(maestro_bin)"
export MAESTRO_CLI_NO_ANALYTICS=1
export FORCE_COLOR=0
DEVICE="$(resolve_device "$DEVICE")"
RUN_OUT="$MAESTRO_DIR_ROOT/.out/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$RUN_OUT"
export RUN_OUT
log "device $DEVICE, output $RUN_OUT"
quiet_host_check
prep_device "$DEVICE"

# Authority flows rely on testIDs added by maestro/patches/authority-testids.patch.
needs_authority=0
for p in $SELECTED; do flow_has_tag "$p" authority && needs_authority=1; done
if [ "$needs_authority" = "1" ] && ! grep -q 'tabBarButtonTestID' "$REPO_ROOT/apps/VoteTorrentAuthority/src/navigation/index.tsx"; then
	die "Authority flows need the testIDs in maestro/patches/authority-testids.patch (git apply it first; see README)"
fi

cleanup() {
	stop_biometric_helper
	stop_our_metro
}
trap cleanup EXIT INT TERM
[ "$BIO" = "1" ] && start_biometric_helper "$DEVICE"

# --- run ---------------------------------------------------------------------------------------
pass=0
fail=0
: >"$RUN_OUT/summary.txt"
for p in $SELECTED; do
	app=voter
	flow_has_tag "$p" authority && app=authority
	ensure_metro_for "$app" "$START_METRO"
	check_debuggable "$DEVICE" "$(app_id_for "$app")"
	adb -s "$DEVICE" reverse tcp:$METRO_PORT tcp:$METRO_PORT >/dev/null 2>&1 || true
	name="$(basename "$(dirname "$p")")-$(basename "$p" .yaml)"
	log "=== $name ($(flow_tags "$p" | tr '\n' ' '))"
	start=$(date +%s)
	"$MAESTRO" test --device "$DEVICE" \
		--config "$MAESTRO_DIR_ROOT/scripts/run-config.yaml" \
		--test-output-dir "$RUN_OUT/$name" \
		--format JUNIT --output "$RUN_OUT/$name.xml" \
		-e VOTER_APP_ID="$(app_id_for voter)" -e AUTHORITY_APP_ID="$(app_id_for authority)" \
		${ENVS[@]+"${ENVS[@]}"} \
		"$p" >"$RUN_OUT/$name.log" 2>&1
	rc=$?
	secs=$(( $(date +%s) - start ))
	if [ "$rc" = "0" ]; then
		verdict=PASS; pass=$((pass + 1))
	else
		verdict=FAIL; fail=$((fail + 1))
	fi
	printf '%-4s %5ss  %s\n' "$verdict" "$secs" "${p#$REPO_ROOT/}" | tee -a "$RUN_OUT/summary.txt"
	[ "$verdict" = FAIL ] && tail -15 "$RUN_OUT/$name.log" | sed 's/^/      /'
done
log "done: $pass passed, $fail failed. Summary: $RUN_OUT/summary.txt"
[ "$fail" = "0" ]
