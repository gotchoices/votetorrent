#!/usr/bin/env bash
# lib.sh - shared helpers for the Maestro runners (sourced, never executed directly).
#
# Every helper here is careful about two things this project learned the hard way:
#   - other sessions share this host: never kill a process this script did not start, and
#     never touch a physical phone unless the operator asked for it explicitly;
#   - the debug APKs load their JS from Metro on host port 8081 (via 10.0.2.2, which bypasses
#     `adb reverse`), so whichever Metro owns 8081 decides which app's code a device runs.

MAESTRO_DIR_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$MAESTRO_DIR_ROOT/.." && pwd)"
METRO_PORT=8081

VOTER_APP_ID_DEFAULT=org.votetorrent.voter
AUTHORITY_APP_ID_DEFAULT=org.votetorrent.authority

# Started-by-us Metro pid (empty when we did not start one).
OUR_METRO_PID=""
OUR_METRO_APP=""

log() { printf '[maestro-run] %s\n' "$*"; }
warn() { printf '[maestro-run] WARN: %s\n' "$*" >&2; }
die() { printf '[maestro-run] ERROR: %s\n' "$*" >&2; exit 2; }

maestro_bin() {
	if command -v maestro >/dev/null 2>&1; then
		command -v maestro
	elif [ -x "$HOME/.maestro/bin/maestro" ]; then
		echo "$HOME/.maestro/bin/maestro"
	else
		die "maestro CLI not found. Install: curl -fsSL https://get.maestro.mobile.dev | bash (see maestro/README.md)"
	fi
}

ensure_java() {
	if java -version >/dev/null 2>&1; then
		return 0
	fi
	# Android Studio ships a JBR; use it when no JDK is on PATH.
	local jbr="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
	if [ -x "$jbr/bin/java" ]; then
		export JAVA_HOME="$jbr"
		export PATH="$JAVA_HOME/bin:$PATH"
		log "using Android Studio's JBR as JAVA_HOME"
		return 0
	fi
	die "no JDK found. Install a JDK 17+ or set JAVA_HOME (see maestro/README.md)"
}

app_dir_for() {
	case "$1" in
		voter) echo "$REPO_ROOT/apps/VoteTorrentVoter" ;;
		authority) echo "$REPO_ROOT/apps/VoteTorrentAuthority" ;;
		*) die "unknown app '$1' (voter | authority)" ;;
	esac
}

app_id_for() {
	case "$1" in
		voter) echo "${VOTER_APP_ID:-$VOTER_APP_ID_DEFAULT}" ;;
		authority) echo "${AUTHORITY_APP_ID:-$AUTHORITY_APP_ID_DEFAULT}" ;;
	esac
}

# Pick the device: the explicit serial, or the only attached emulator. Refuses physical devices
# unless ALLOW_PHYSICAL=1.
resolve_device() {
	local want="${1:-}"
	local emus
	emus="$(adb devices | awk 'NR>1 && $2=="device" {print $1}')"
	if [ -z "$want" ]; then
		local only_emus
		only_emus="$(printf '%s\n' "$emus" | grep '^emulator-' || true)"
		if [ "$(printf '%s\n' "$only_emus" | grep -c . || true)" != "1" ]; then
			die "pass --device <serial>: attached devices are: $(echo $emus)"
		fi
		want="$only_emus"
	fi
	printf '%s\n' "$emus" | grep -qx "$want" || die "device '$want' is not attached (adb devices)"
	case "$want" in
		emulator-*) ;;
		*)
			[ "${ALLOW_PHYSICAL:-0}" = "1" ] || die "'$want' is a physical device. The suite targets emulators; pass --allow-physical only for a phone you own and have freed for this run"
			;;
	esac
	echo "$want"
}

# Warn (never kill) when the host is busy: the Voter's dev-seed boot starves under load.
quiet_host_check() {
	local busy rc
	busy="$(pgrep -fl '[j]est|[m]ocha|[t]sc --|[x]codebuild|[G]radleDaemon' 2>/dev/null)"
	rc=$?
	if [ "$rc" = "0" ]; then
		warn "busy host (Voter boot may starve): $(printf '%s' "$busy" | awk '{print $2}' | sort -u | tr '\n' ' ')"
	elif [ "$rc" != "1" ]; then
		warn "pgrep failed (exit $rc); host load unknown"
	fi
	log "host load: $(uptime | sed 's/.*load averages*: //')"
}

# Device prep before every run: power + Doze + Play Store + lock. Each of these has killed a
# device run in this project (see maestro/README.md "Known emulator limits").
prep_device() {
	local s="$1"
	log "prepping $s"
	case "$s" in
		emulator-*)
			adb -s "$s" emu power ac on >/dev/null 2>&1 || true
			adb -s "$s" emu power status charging >/dev/null 2>&1 || true
			# Play Store auto-updates WebView mid-run and Android force-stops our app.
			adb -s "$s" shell pm disable-user --user 0 com.android.vending >/dev/null 2>&1 || true
			;;
	esac
	adb -s "$s" shell dumpsys deviceidle disable >/dev/null 2>&1 || true
	adb -s "$s" shell svc power stayon true >/dev/null 2>&1 || true
	adb -s "$s" shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
	adb -s "$s" shell wm dismiss-keyguard >/dev/null 2>&1 || true
	local users keyguard
	users="$(adb -s "$s" shell dumpsys user 2>/dev/null | tr -d '\r' | grep -o 'RUNNING_[A-Z_]*' | head -1)"
	keyguard="$(adb -s "$s" shell dumpsys window 2>/dev/null | tr -d '\r' | grep -o 'isKeyguardShowing=[a-z]*' | head -1)"
	[ "$users" = "RUNNING_UNLOCKED" ] || warn "$s user state is '$users': unlock the screen (PIN) first, or apps report 'Activity class does not exist'"
	[ "$keyguard" = "isKeyguardShowing=true" ] && warn "$s is on the lock screen: unlock it before running flows"
	local fp
	fp="$(adb -s "$s" shell dumpsys fingerprint 2>/dev/null | tr -d '\r' | grep -o '"count":[0-9]*' | head -1)"
	case "$fp" in
		'"count":0'|'') warn "$s has no enrolled fingerprint: biometric flows will fail (README: enrol one)" ;;
	esac
}

# The installed APK must be a debuggable build, or it ignores Metro and runs a baked bundle.
check_debuggable() {
	local s="$1" pkg="$2"
	adb -s "$s" shell pm path "$pkg" >/dev/null 2>&1 || die "$pkg is not installed on $s (README: build + install the debug APK)"
	if adb -s "$s" shell run-as "$pkg" id 2>&1 | grep -q 'not debuggable'; then
		die "$pkg on $s is a RELEASE build: it ignores Metro. Install the debug APK"
	fi
}

metro_owner_dir() {
	local pid
	pid="$(lsof -tiTCP:$METRO_PORT -sTCP:LISTEN 2>/dev/null | head -1)"
	[ -n "$pid" ] || return 1
	lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
}

# Make sure the Metro on 8081 serves APP (voter | authority). With START=1 and a free port,
# start one (and remember it, so stop_our_metro can stop it). Never stops a Metro we did not start.
ensure_metro_for() {
	local app="$1" start="${2:-0}" dir owner
	dir="$(app_dir_for "$app")"
	owner="$(metro_owner_dir || true)"
	if [ -n "$owner" ]; then
		if [ "$owner" = "$dir" ]; then
			log "Metro on :$METRO_PORT serves $app ($owner)"
			return 0
		fi
		if [ -n "$OUR_METRO_PID" ]; then
			stop_our_metro
		else
			die "Metro on :$METRO_PORT serves '$owner', not $app. It is not ours: stop it yourself (or wait for its session) and retry"
		fi
	fi
	[ "$start" = "1" ] || die "no Metro on :$METRO_PORT. Start it: (cd $dir && yarn start), or pass --start-metro"
	log "starting Metro for $app on :$METRO_PORT"
	local logf="${RUN_OUT:-$MAESTRO_DIR_ROOT/.out}/metro-$app.log"
	mkdir -p "$(dirname "$logf")"
	(cd "$dir" && FORCE_COLOR=0 nohup npx --no-install react-native start --port "$METRO_PORT" >"$logf" 2>&1 &
		echo $! >"$logf.pid")
	OUR_METRO_PID="$(cat "$logf.pid")"
	OUR_METRO_APP="$app"
	local i
	for i in $(seq 1 60); do
		if curl -s "http://localhost:$METRO_PORT/status" 2>/dev/null | grep -q running; then
			break
		fi
		sleep 2
	done
	curl -s "http://localhost:$METRO_PORT/status" | grep -q running || die "Metro did not come up (see $logf)"
	log "pre-building the $app bundle (first build takes ~30 s)"
	curl -s -o /dev/null "http://localhost:$METRO_PORT/index.bundle?platform=android&dev=true&minify=false" || true
}

stop_our_metro() {
	[ -n "$OUR_METRO_PID" ] || return 0
	log "stopping the Metro this run started (pid $OUR_METRO_PID, $OUR_METRO_APP)"
	# npx -> node: stop the listener we started and its parent.
	local lpid
	lpid="$(lsof -tiTCP:$METRO_PORT -sTCP:LISTEN 2>/dev/null | head -1)"
	kill "$OUR_METRO_PID" 2>/dev/null || true
	if [ -n "$lpid" ] && [ "$(metro_owner_dir || true)" = "$(app_dir_for "$OUR_METRO_APP")" ]; then
		kill "$lpid" 2>/dev/null || true
	fi
	sleep 2
	OUR_METRO_PID=""
	OUR_METRO_APP=""
}

BIO_PID=""
start_biometric_helper() {
	local s="$1"
	case "$s" in
		emulator-*) ;;
		*)
			log "$s is a physical device: answer fingerprint prompts by hand"
			return 0
			;;
	esac
	"$MAESTRO_DIR_ROOT/scripts/biometric-autotouch.sh" "$s" >"${RUN_OUT:-/dev/null}/biometric-$s.log" 2>&1 &
	BIO_PID=$!
	log "fingerprint helper running for $s (pid $BIO_PID)"
}

stop_biometric_helper() {
	[ -n "$BIO_PID" ] || return 0
	kill "$BIO_PID" 2>/dev/null || true
	BIO_PID=""
}

# Tags of a flow file (the `tags:` list in its header, before `---`).
flow_tags() {
	awk '/^---/{exit} /^tags:/{t=1; next} t && /^  - /{sub(/^  - /,""); print; next} t && !/^  - /{t=0}' "$1"
}

flow_has_tag() {
	flow_tags "$1" | grep -qx "$2"
}
