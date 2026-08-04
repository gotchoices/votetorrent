#!/usr/bin/env bash
#
# voter-boot-smoke.sh
#
# Purpose  : On-device cold-start boot smoke for apps/VoteTorrentVoter. Proves the
#            real-engine register path BUNDLES + BOOTS on Hermes — the class of defect
#            jest and 44-VERIFICATION.md are structurally blind to (they mock
#            @peculiar/@noble/multiformats). Closes 44-UAT.md Test 1.
#
#            Cold-starts the debug build on a connected AVD (fresh __DEV__ dev-seed via
#            `pm clear`), then polls logcat for the boot PASS token emitted by
#            VoterAppProvider.tsx once the real dev-seed + network open completes, while
#            asserting the ABSENCE of every known bundle/boot failure signal. Captures a
#            screenshot of the landed screen for the human-verify checkpoint (44-10 Task 2).
#
# Usage    : ./scripts/voter-boot-smoke.sh
#
# Prerequisites:
#   - adb in PATH (Android SDK Platform Tools); one AVD/device connected.
#   - Metro dev server for apps/VoteTorrentVoter reachable (script starts one if absent).
#   - Debug build (release APK ignores Metro). Script installs it via `gradlew installDebug`
#     if the app is not present on the device.
#   - The 44-09 metro.config tslib fix must be in place (this script proves it).
#
# Exit codes:
#   0  — PASS token seen in logcat AND zero failure signals (booted to Home).
#   1  — failure signal seen, or PASS token not seen within the timeout.
#
set -euo pipefail

# --- Anchor cwd to repo root so every relative path (and the EXIT-trap capture) is stable.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

APP_DIR="apps/VoteTorrentVoter"
GRADLE_BUILD="$APP_DIR/android/app/build.gradle"

# --- Scratchpad for captures (override with VOTER_SMOKE_OUT); portable default.
OUT_DIR="${VOTER_SMOKE_OUT:-${TMPDIR:-/tmp}/voter-boot-smoke}"
mkdir -p "$OUT_DIR"
LOGCAT_CAP="$OUT_DIR/voter-boot-logcat.txt"
SCREENSHOT="$OUT_DIR/voter-boot-home.png"

BOOT_TOKEN='[voter-boot] VoterAppProvider isInitialized'
# Every known bundle/boot failure signal from 44-UAT.md. Any hit = FAIL.
FAILURE_SIGNALS=(
  'The development server returned response error code: 500'
  '__extends'
  'runtime not ready'
  'VoteTorrentVoter has not been registered'
  'seedDevNetwork failed'
)
BOOT_TIMEOUT="${BOOT_TIMEOUT:-180}"   # seconds to wait for the PASS token
METRO_TIMEOUT="${METRO_TIMEOUT:-90}"  # seconds to wait for Metro to answer

log() { printf '[voter-boot-smoke] %s\n' "$*"; }
fail() { log "FAIL: $*"; exit 1; }

command -v adb >/dev/null 2>&1 || fail "adb not found in PATH (Android SDK Platform Tools)."

# --- Resolve a single connected device serial.
SERIAL="$(adb devices | awk 'NR>1 && $2=="device" {print $1; exit}')"
[ -n "$SERIAL" ] || fail "no adb device in 'device' state (boot an AVD first)."
ADB="adb -s $SERIAL"
log "device: $SERIAL"

# --- App id from build.gradle (do NOT assume — voter app != authority app).
APP_ID="$(grep -oE 'applicationId[[:space:]]+"[^"]+"' "$GRADLE_BUILD" | head -1 | sed -E 's/.*"([^"]+)".*/\1/')"
[ -n "$APP_ID" ] || fail "could not read applicationId from $GRADLE_BUILD"
log "app id: $APP_ID"

# --- EXIT trap: always snapshot logcat + screen for post-mortem / the human-verify gate.
cleanup() {
  local ec=$?
  $ADB logcat -d > "$LOGCAT_CAP" 2>/dev/null || true
  $ADB exec-out screencap -p > "$SCREENSHOT" 2>/dev/null || true
  log "logcat captured : $LOGCAT_CAP"
  log "screenshot      : $SCREENSHOT"
  exit "$ec"
}
trap cleanup EXIT

# --- Ensure Metro is up (packager-status:running on :8081).
if curl -s "http://localhost:8081/status" 2>/dev/null | grep -q "packager-status:running"; then
  log "Metro already running on :8081"
else
  log "starting Metro (yarn start) in $APP_DIR ..."
  ( cd "$APP_DIR" && nohup yarn start >"$OUT_DIR/metro.log" 2>&1 & )
  for _ in $(seq 1 "$METRO_TIMEOUT"); do
    curl -s "http://localhost:8081/status" 2>/dev/null | grep -q "packager-status:running" && break
    sleep 1
  done
  curl -s "http://localhost:8081/status" 2>/dev/null | grep -q "packager-status:running" \
    || fail "Metro did not come up within ${METRO_TIMEOUT}s (see $OUT_DIR/metro.log)"
  log "Metro up"
fi

# --- Ensure the debug build is installed (release APK ignores Metro).
if $ADB shell pm list packages 2>/dev/null | grep -q "^package:${APP_ID}$"; then
  log "app already installed"
else
  log "installing debug build (gradlew installDebug) ..."
  ( cd "$APP_DIR/android" && ANDROID_SERIAL="$SERIAL" ./gradlew installDebug ) \
    || fail "gradlew installDebug failed"
fi

# --- Resolve the launcher activity for an explicit `am start`.
LAUNCH_CMP="$($ADB shell cmd package resolve-activity --brief -c android.intent.category.LAUNCHER "$APP_ID" 2>/dev/null | tail -1 | tr -d '\r')"

# --- Cold start: clear app data (fresh __DEV__ dev-seed) + clear logcat, then launch.
log "cold start: pm clear + relaunch ..."
$ADB shell am force-stop "$APP_ID" 2>/dev/null || true
$ADB shell pm clear "$APP_ID" >/dev/null 2>&1 || true
$ADB logcat -c 2>/dev/null || true
if [ -n "$LAUNCH_CMP" ] && printf '%s' "$LAUNCH_CMP" | grep -q "/"; then
  $ADB shell am start -n "$LAUNCH_CMP" >/dev/null 2>&1 || true
else
  $ADB shell monkey -p "$APP_ID" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true
fi

# --- Poll logcat: PASS token vs any failure signal, whichever appears first.
log "polling logcat up to ${BOOT_TIMEOUT}s for the boot verdict ..."
deadline=$((SECONDS + BOOT_TIMEOUT))
verdict=""
while [ "$SECONDS" -lt "$deadline" ]; do
  dump="$($ADB logcat -d 2>/dev/null || true)"
  for sig in "${FAILURE_SIGNALS[@]}"; do
    if printf '%s' "$dump" | grep -qF "$sig"; then
      verdict="FAIL"; log "failure signal seen: $sig"; break
    fi
  done
  [ "$verdict" = "FAIL" ] && break
  if printf '%s' "$dump" | grep -qF "$BOOT_TOKEN"; then
    verdict="PASS"; break
  fi
  sleep 3
done

case "$verdict" in
  PASS) log "PASS: boot token seen, zero failure signals — booted to Home."; exit 0 ;;
  FAIL) fail "a boot/bundle failure signal was present (see $LOGCAT_CAP)." ;;
  *)    fail "boot token '$BOOT_TOKEN' not seen within ${BOOT_TIMEOUT}s (see $LOGCAT_CAP)." ;;
esac
