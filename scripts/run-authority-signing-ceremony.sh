#!/usr/bin/env bash
#
# run-authority-signing-ceremony.sh
#
# Purpose : Phase 49 D-24/D-25 on-device Authority-app signing ceremony driver.
#           Drives the REAL product UI (Settings -> Secure Signing ->
#           ProvisionSigningKeyScreen, and any routed per-use signing call
#           site) on a booted emulator to observe the facts jest cannot see:
#           a real BiometricPrompt sheet, a real Keystore-backed P-256
#           signature accepted by the in-schema SignatureValid CHECK, clean
#           cancellation (both the negative button AND the BACK key), and no
#           plaintext key residue in AsyncStorage.
#
# Usage   : SERIAL=emulator-5554 ./scripts/run-authority-signing-ceremony.sh <leg>
#           <leg> one of: provision-local | provision-register | sign | cancel | storage |
#                         hw-provision | recover | all
#           `provision` is accepted as a deprecated alias for `provision-local`.
#
#           49-14 (real-hardware legs): `hw-provision` and `recover` are for REAL DEVICES ONLY
#           (they PREFLIGHT FAIL loudly if pointed at an emulator). Every biometric-satisfaction
#           step that used to inject `adb emu finger touch` now branches on whether the target
#           actually responds to `adb emu` — on real hardware there is no adb equivalent, so the
#           script PAUSES (bounded on HW_BIOMETRIC_TIMEOUT, default 90s) and prints a loud
#           "ACTION REQUIRED" instruction for a human to physically touch the sensor (or, for the
#           D-16/D-26 recovery ceremony's DEVICE_CREDENTIAL authenticator, enter the PIN/pattern/
#           password — never a fingerprint touch there). `hw-provision` also pauses twice for an
#           operator-driven network-creation step (HW_NETWORK_WAIT, default 90s) — same six-field
#           RN form limitation `provision-register` already documents below.
#
#           49-18 (Gap A's runtime proof vehicle): the onboarding order 49-16/49-17
#           landed splits provisioning into two network-independent/network-scoped
#           halves that cannot both complete in one pass on a clean device.
#           `provision-local` drives the local ceremony from a `pm clear` start and
#           lands on the awaiting-network state. Between `provision-local` and
#           `provision-register` there is a REQUIRED, NOT-AUTOMATED operator step:
#           create or join a network through the real in-app `AddNetworkScreen` flow.
#           This script deliberately does not drive that screen — it is a six-field
#           RN form, and this project has recorded that RN TextInputs resist `adb`
#           taps and report `text=""` to uiautomator, and that `adb input text`
#           containing two `r` characters triggers an RN reload. Driving it blind
#           would produce false failures indistinguishable from real ones.
#           `provision-register` then drives the network-scoped registration half
#           and asserts the success heading. `all` runs `provision-local`, `cancel`,
#           and `storage` only; `provision-register` is recorded NOT-EXERCISED under
#           `all` (it requires the operator-created network precondition above).
#
# Prereqs : adb on PATH; a booted EMULATOR (not a real device — this script's
#           fingerprint injection is emulator-only) with the debug app already
#           installed (`cd apps/VoteTorrentAuthority/android && ./gradlew
#           installDebug`); Metro reachable on METRO_PORT (default 8081,
#           override if the port is squatted by a sibling Expo project — see
#           the spike-findings-votetorrent skill).
#
# Exit    : 0 — every selected leg printed LEG <name>: PASS
#           1 — a preflight failed, or any selected leg printed LEG <name>: FAIL
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
. scripts/lib/logcat-wait.sh

PACKAGE="org.votetorrent.authority"
SERIAL="${SERIAL:-emulator-5554}"
ADBD="-s ${SERIAL}"
METRO_PORT="${METRO_PORT:-8081}"
DUMP_TIMEOUT=30
PROMPT_TIMEOUT=20
# How long observe_biometric_prompt watches for the sheet after the tap (harness fix, defect 1).
PROMPT_OBSERVE_TIMEOUT="${PROMPT_OBSERVE_TIMEOUT:-15}"
# How long wait_for_text_onscreen polls for a terminal heading before giving up (harness fix).
HEADING_WAIT_TIMEOUT="${HEADING_WAIT_TIMEOUT:-30}"
VERDICT_TIMEOUT=60

LEG="${1:-}"
if [ "${LEG}" = "provision" ]; then
  echo "[ceremony] NOTE: leg 'provision' is a deprecated alias — the split onboarding order (49-16/49-17) means it now runs 'provision-local'. Use 'provision-local' directly going forward." >&2
  LEG="provision-local"
fi
case "${LEG}" in
  provision-local|provision-register|sign|cancel|storage|hw-provision|recover|all) ;;
  *)
    echo "Usage: SERIAL=emulator-5554 $0 <provision-local|provision-register|sign|cancel|storage|hw-provision|recover|all>" >&2
    exit 1
    ;;
esac

# 49-14 — real-hardware pause windows. Overridable via env for a slower operator/device.
HW_BIOMETRIC_TIMEOUT="${HW_BIOMETRIC_TIMEOUT:-90}"
HW_NETWORK_WAIT="${HW_NETWORK_WAIT:-90}"
# Set by preflight() once the target's `adb emu` responsiveness is known. 1 = emulator (the
# existing 49-13/49-18 injection path), 0 = real hardware (49-14's job — every biometric/
# device-credential step pauses for a human instead).
IS_EMULATOR=1

# ── i18n strings this script asserts against (EN values, apps/VoteTorrentAuthority/src/i18n/index.ts) ──
STR_SETTINGS_ROW="Secure Signing"
STR_SETUP_BUTTON="Set Up Secure Signing"
STR_SUCCESS_HEADING="Signing key ready"
STR_AWAITING_NETWORK_HEADING="Secure signing is set up on this device"
STR_PROMPT_TITLE="Confirm your identity"
STR_NEGATIVE_BUTTON="Cancel"
STR_ERROR_STRINGS=(
  "This device has no biometrics enrolled"
  "Too many attempts"
  "Biometric verification is locked"
  "Couldn't verify your biometrics"
)

TMPDIR_CEREMONY="$(mktemp -d)"
cleanup() { rm -rf "${TMPDIR_CEREMONY}"; }
trap cleanup EXIT

RESULTS=()
record_leg() {
  local name="$1" verdict="$2" evidence="$3"
  RESULTS+=("${name}|${verdict}|${evidence}")
  echo "LEG ${name}: ${verdict} (${evidence})"
}

any_failed() {
  local r
  for r in "${RESULTS[@]}"; do
    [[ "${r}" == *"|FAIL|"* ]] && return 0
  done
  return 1
}

# R5a (57-03): shared platform-tag exclusion list for the cancel legs' post-dismissal
# error-count checks — a name in this set is a platform-emitted tag whose ` E ` lines share the
# app's pid (StrongBox-fallback keygen noise, GC pauses, ART) but are not evidence of an
# app-authored fault. Both leg_cancel_negative_button and leg_cancel_back_key read this SAME
# variable so the two legs cannot drift from each other. Matched against the threadtime-format
# tag field (` E TagName:`), never a bare substring, so an app-authored message that happens to
# contain one of these words cannot be excluded by accident.
PLATFORM_TAG_EXCLUSIONS=' E (KeyStore|Perf|ART):'

# R5d (57-03): set by dump_ui() alongside its existing stdout (a dump-file path) contract, which
# stays UNCHANGED for every caller. Callers that need to distinguish "could not observe" from
# "observed absent" read this immediately after calling dump_ui — see leg_cancel_negative_button /
# leg_cancel_back_key.
DUMP_UI_STATUS="ok"

# ── Preflights (all fail loudly, none proceed silently) ─────────────────────
preflight() {
  echo "[ceremony] Preflight: adb device state ..."
  local state
  state=$(adb ${ADBD} get-state 2>/dev/null || true)
  if [ "${state}" != "device" ]; then
    echo "[ceremony] PREFLIGHT FAIL: '${SERIAL}' is not in 'device' state (got '${state}') — is the emulator booted? (adb devices)" >&2
    exit 1
  fi

  echo "[ceremony] Preflight: emulator check (adb emu) ..."
  if adb ${ADBD} emu avd name >/dev/null 2>&1; then
    IS_EMULATOR=1
    echo "[ceremony]   -> emulator target detected; fingerprint injection via 'adb emu finger touch' is available (49-13/49-18 path)."
  else
    IS_EMULATOR=0
    echo "[ceremony]   -> real hardware target detected ('adb emu' unsupported, as expected on a physical device — this is 49-14's job). Every biometric/device-credential step will PAUSE for a physical action instead of injecting one." >&2
  fi

  echo "[ceremony] Preflight: secure lock screen + fingerprint enrollment ..."
  if [ "${IS_EMULATOR}" -eq 1 ]; then
    # A lock credential may already be set to this script's own PIN from a
    # prior ceremony run — `pm clear` (reset_identity) only resets the APP's
    # data, never the device lock screen, so a bare `set-pin 1234` on a second
    # run fails with "old credential was not provided" even though the PIN is
    # already correct. Try the no-`--old` form first (first-ever setup on a
    # fresh AVD), then retry with `--old 1234` (idempotent re-run) before
    # treating it as a genuine failure.
    if ! adb ${ADBD} shell locksettings set-pin 1234 >/dev/null 2>&1; then
      # `--old` must precede the PIN argument (locksettings' shell parser is
      # positional-sensitive: `set-pin 1234 --old 1234` is rejected the same
      # as no --old at all).
      if ! adb ${ADBD} shell locksettings set-pin --old 1234 1234 >/dev/null 2>&1; then
        echo "[ceremony] PREFLIGHT FAIL: 'locksettings set-pin 1234' failed (with and without --old 1234) — a Keystore key with setUserAuthenticationRequired(true) cannot even be GENERATED on a device with no secure lock screen, so a missing/mismatched PIN here presents downstream as a keygen failure, not a prompt failure. Set the PIN by hand ('adb shell locksettings clear --old <existing>' then re-run) and re-run." >&2
        exit 1
      fi
    fi
    # Enroll a fingerprint under finger id 1 for the emulator's virtual sensor.
    adb ${ADBD} emu finger touch 1 >/dev/null 2>&1 || true
  else
    # Real hardware (49-14-PLAN.md Task 1's own prerequisite): the human already configured a
    # secure lock screen + exactly one enrolled biometric BEFORE this script ever runs.
    # NEVER programmatically set a PIN or enroll a fingerprint here — doing so on a real device
    # would silently overwrite the DEVICE OWNER'S actual lock-screen credential. Verify, read-only,
    # instead of mutate.
    #
    # `dumpsys trust`'s `deviceLocked=` line is CURRENT lock state, not lock-screen
    # CONFIGURATION — a device the operator just unlocked to hand to this ceremony correctly
    # reads `deviceLocked=0`, and gating on `=1` here would wrongly PREFLIGHT FAIL a device that
    # is exactly ready to be driven. `locksettings get-disabled` (expect `false`) is the correct
    # configuration check and is used first; it throws `IllegalArgumentException` on some API
    # levels (49-14-PLAN.md's 2026-08-18 amendment, confirmed API 29) — `dumpsys fingerprint`'s
    # `acceptCrypto` count (non-zero = crypto-backed auth has genuinely succeeded against the
    # credential at some point) is the documented substitute there.
    local get_disabled
    get_disabled=$(adb ${ADBD} shell locksettings get-disabled 2>&1 | tr -d '\r')
    if [ "${get_disabled}" = "false" ] || [ "${get_disabled}" = "true" ]; then
      if [ "${get_disabled}" != "false" ]; then
        echo "[ceremony] PREFLIGHT FAIL: 'locksettings get-disabled' reports '${get_disabled}' (lock screen disabled) on '${SERIAL}' — a secure lock screen is required before any setUserAuthenticationRequired(true) Keystore key can even be generated. Set a PIN/pattern/password by hand and re-run." >&2
        exit 1
      fi
      echo "[ceremony]   -> secure lock screen confirmed read-only (locksettings get-disabled: false)"
    else
      # get-disabled unusable on this API level (e.g. API 29's IllegalArgumentException) — fall
      # back to the plan's documented substitute evidence.
      local accept_crypto
      # NOTE: dumpsys fingerprint's actual per-device format varies — some builds emit
      # key=value ("acceptCrypto=2"), others emit JSON ("acceptCrypto":2, as confirmed live on
      # this project's Redmi 8/API 29). Match both.
      accept_crypto=$(adb ${ADBD} shell dumpsys fingerprint 2>/dev/null | grep -o '"\?acceptCrypto"\?[:=][0-9]*' | head -1 || true)
      if [ -z "${accept_crypto}" ] || echo "${accept_crypto}" | grep -q '[:=]0$'; then
        echo "[ceremony] PREFLIGHT FAIL: 'locksettings get-disabled' unusable on this API level (${get_disabled}) and 'dumpsys fingerprint' reports no non-zero acceptCrypto count on '${SERIAL}' — cannot confirm a secure, crypto-backed lock screen is configured. (raw get-disabled: ${get_disabled})" >&2
        exit 1
      fi
      echo "[ceremony]   -> secure lock screen confirmed read-only via substitute evidence (dumpsys fingerprint: ${accept_crypto}) — get-disabled unusable on this API level"
    fi

    # A real device's screen times out and re-locks between ceremony steps — unlike an emulator,
    # adb has NO keyguard bypass for a real credential (45-11-PROOF-LOG.md's own re-confirmed
    # constraint: "adb cannot clear the keyguard"). Wake it and give a human a bounded window to
    # unlock physically HERE, rather than let launch_app spin uselessly against a lock screen for
    # its own 300s window with a much less specific failure message.
    adb ${ADBD} shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
    adb ${ADBD} shell svc power stayon usb >/dev/null 2>&1 || true
    local focus
    focus=$(adb ${ADBD} shell dumpsys window 2>/dev/null | grep -i mCurrentFocus || true)
    if echo "${focus}" | grep -qi "Keyguard\|NotificationShade"; then
      echo "[ceremony] ############################################################" >&2
      echo "[ceremony] ACTION REQUIRED on ${SERIAL}: the screen is currently LOCKED (mCurrentFocus: ${focus}). adb cannot bypass a real keyguard credential — unlock the device physically now." >&2
      echo "[ceremony] waiting up to ${HW_BIOMETRIC_TIMEOUT}s ..." >&2
      echo "[ceremony] ############################################################" >&2
      local start_epoch
      start_epoch=$(date +%s)
      while [ "$(( $(date +%s) - start_epoch ))" -lt "${HW_BIOMETRIC_TIMEOUT}" ]; do
        focus=$(adb ${ADBD} shell dumpsys window 2>/dev/null | grep -i mCurrentFocus || true)
        if ! echo "${focus}" | grep -qi "Keyguard\|NotificationShade"; then
          echo "[ceremony] unlocked after $(( $(date +%s) - start_epoch ))s." >&2
          break
        fi
        sleep 3
      done
      if echo "${focus}" | grep -qi "Keyguard\|NotificationShade"; then
        echo "[ceremony] PREFLIGHT FAIL: '${SERIAL}' is still locked after ${HW_BIOMETRIC_TIMEOUT}s (mCurrentFocus: ${focus}) — cannot proceed without a human present to unlock it. Unlock it and re-run." >&2
        exit 1
      fi
    fi
  fi

  echo "[ceremony] Preflight: Metro reachability + adb reverse ..."
  adb ${ADBD} reverse "tcp:${METRO_PORT}" "tcp:${METRO_PORT}" || {
    echo "[ceremony] PREFLIGHT FAIL: 'adb reverse tcp:${METRO_PORT} tcp:${METRO_PORT}' failed. Note: this repo's qrcode-daily-sync Expo project squats port 8081 — pass METRO_PORT=8082 (or another free port) if 8081 is taken, and start Metro on that same port. Re-apply this reverse after every emulator restart." >&2
    exit 1
  }

  echo "[ceremony] Preflight: host load (informational, this app boots CadreNode which is CPU-heavy) ..."
  uptime || true

  echo "[ceremony] Preflight: host/device clock skew ..."
  local host_epoch device_epoch skew
  host_epoch=$(date +%s)
  device_epoch=$(adb ${ADBD} shell date +%s | tr -d '\r')
  skew=$(( host_epoch - device_epoch ))
  echo "[ceremony] host epoch=${host_epoch} device epoch=${device_epoch} skew=${skew}s"
  if [ ${skew#-} -gt 30 ]; then
    echo "[ceremony] PREFLIGHT FAIL: host/device clock skew is ${skew}s (>30s) — UserKey.Expiration > :now comparisons run against the device clock and a skewed clock has previously expired signed records on this project's emulators. Sync the emulator clock (adb shell date, or restart the AVD) and re-run." >&2
    exit 1
  fi

  # R5b (57-03): the ceremony attributes device behaviour to source it may not actually be
  # running. Compare the installed APK's own lastUpdateTime against the newest commit under
  # packages/attestation-native/android — the native Kotlin surface every leg here exercises — and
  # abort rather than silently measure a stale build. The human-readable `lastUpdateTime=` string
  # dumpsys prints is converted to an epoch ON THE DEVICE (its own toybox `date -d`), never
  # host-side, so this comparison is immune to host/device timezone or date-binary differences —
  # same reasoning as the clock-skew check just above.
  echo "[ceremony] Preflight: installed APK freshness vs packages/attestation-native/android ..."
  local installed_update_str installed_update_epoch newest_source_epoch
  installed_update_str=$(adb ${ADBD} shell dumpsys package "${PACKAGE}" 2>/dev/null | grep -m1 'lastUpdateTime=' | sed -E 's/^[[:space:]]*lastUpdateTime=//' | tr -d '\r')
  if [ -n "${installed_update_str}" ]; then
    installed_update_epoch=$(adb ${ADBD} shell "date -d '${installed_update_str}' +%s" 2>/dev/null | tr -d '\r')
  fi
  newest_source_epoch=$(git log -1 --format=%ct -- packages/attestation-native/android 2>/dev/null || true)
  if [ -z "${installed_update_epoch:-}" ] || ! echo "${installed_update_epoch:-}" | grep -qE '^[0-9]+$' \
    || [ -z "${newest_source_epoch}" ] || ! echo "${newest_source_epoch}" | grep -qE '^[0-9]+$'; then
    echo "[ceremony] PREFLIGHT FAIL: could not read a usable installed-APK update time (raw dumpsys value: '${installed_update_str:-<none>}', device epoch: '${installed_update_epoch:-<none>}') or the newest packages/attestation-native/android commit time ('${newest_source_epoch:-<none>}') — an unreadable freshness check is an instrument gap, never a pass. Rebuild and install: 'cd apps/VoteTorrentAuthority/android && ./gradlew installDebug'." >&2
    exit 1
  fi
  if [ "${installed_update_epoch}" -lt "${newest_source_epoch}" ]; then
    echo "[ceremony] PREFLIGHT FAIL: the installed APK (lastUpdateTime epoch=${installed_update_epoch}) predates the newest packages/attestation-native/android change (committed epoch=${newest_source_epoch}) — this ceremony would measure device behaviour against STALE Kotlin. Rebuild and install: 'cd apps/VoteTorrentAuthority/android && ./gradlew installDebug'." >&2
    exit 1
  fi
  echo "[ceremony]   -> installed APK (lastUpdateTime epoch=${installed_update_epoch}) is at or after the newest attestation-native/android change (epoch=${newest_source_epoch})."

  echo "[ceremony] Preflight: installed build is debuggable (a release APK ignores Metro) ..."
  local pkg_flags
  pkg_flags=$(adb ${ADBD} shell dumpsys package "${PACKAGE}" 2>/dev/null | grep -m1 -i 'pkgFlags=' || true)
  if ! echo "${pkg_flags}" | grep -qi 'DEBUGGABLE'; then
    echo "[ceremony] PREFLIGHT FAIL: the installed '${PACKAGE}' build does not report DEBUGGABLE (pkgFlags: '${pkg_flags:-<not found>}') — a release APK ignores Metro's live JS bundle, so this ceremony would measure a stale JS bundle in addition to stale native code. Rebuild and install the DEBUG variant: 'cd apps/VoteTorrentAuthority/android && ./gradlew installDebug'." >&2
    exit 1
  fi
  echo "[ceremony]   -> installed build reports DEBUGGABLE."

  echo "[ceremony] Preflights OK."
}

reset_identity() {
  # Equivalent to: adb shell pm clear org.votetorrent.authority
  # (PACKAGE is a constant equal to that literal — kept as a variable so the
  # whole script has exactly one place naming the package).
  echo "[ceremony] Resetting app identity: adb shell pm clear ${PACKAGE} ..."
  adb ${ADBD} shell pm clear "${PACKAGE}" >/dev/null
}

launch_app() {
  adb ${ADBD} shell am force-stop "${PACKAGE}"
  sleep 1
  adb ${ADBD} logcat -c
  adb ${ADBD} shell monkey -p "${PACKAGE}" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
  # Cold start + first Metro bundle fetch is slow (CadreNode boot is CPU-heavy
  # per this project's own emulator-boot precedent), and duration varies
  # sharply with host load (observed 90-150s real render time under moderate
  # load in this session, occasionally worse). A fixed sleep is racy, so this
  # polls for the rendered Home tab bar instead of trusting a guessed
  # duration — bounded on REAL elapsed wall time (not an iteration count
  # times a guessed per-iteration duration), since each poll round-trip's own
  # cost varies with load too.
  #
  # Two failure modes specific to this project's emulator, both handled:
  # (a) a STALE com.android.settings window (used earlier in this ceremony
  #     for PIN/fingerprint enrollment) can still hold focus, and that app's
  #     own screens are full of the literal string "Settings" — a bare
  #     text-content grep can false-positive-match it well before our app
  #     has regained focus. Gate on window focus naming our own package
  #     before trusting any text-content match.
  # (b) a genuine system ANR dialog ("VoteTorrent Authority isn't
  #     responding") can appear while CadreNode boots under load — this is
  #     the documented 'a loaded host has previously ANR'd and killed the
  #     AVD' gotcha. Detect it and tap 'Wait' (never 'Close app') so the
  #     ceremony can survive a transient ANR instead of hanging or false-
  #     failing on it. Polling is deliberately infrequent (12s) so the
  #     dump/pull round-trips themselves don't add CPU pressure on an
  #     already-loaded emulator during the exact window this matters most.
  local start_epoch dump focus wait_bounds wx1 wy1 wx2 wy2 wcx wcy
  start_epoch=$(date +%s)
  while [ "$(( $(date +%s) - start_epoch ))" -lt 300 ]; do
    focus=$(adb ${ADBD} shell dumpsys window 2>/dev/null | grep -i mCurrentFocus || true)
    if echo "${focus}" | grep -qi "Application Not Responding"; then
      dump=$(dump_ui)
      wait_bounds=$(grep -o '<node[^>]*text="Wait"[^>]*>' "${dump}" | grep -o 'bounds="\[[0-9,]*\]\[[0-9,]*\]"' | head -1 | sed 's/bounds="//;s/"//')
      if [ -n "${wait_bounds}" ]; then
        wx1=$(echo "${wait_bounds}" | sed -E 's/\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]/\1/')
        wy1=$(echo "${wait_bounds}" | sed -E 's/\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]/\2/')
        wx2=$(echo "${wait_bounds}" | sed -E 's/\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]/\3/')
        wy2=$(echo "${wait_bounds}" | sed -E 's/\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]/\4/')
        wcx=$(( (wx1 + wx2) / 2 )); wcy=$(( (wy1 + wy2) / 2 ))
        echo "[ceremony] ANR dialog observed mid-boot (host-load gotcha) — tapping Wait, never Close app." >&2
        adb ${ADBD} shell input tap "${wcx}" "${wcy}"
      fi
      sleep 12
      continue
    fi
    if echo "${focus}" | grep -q "${PACKAGE}"; then
      dump=$(dump_ui)
      if grep -qi 'text="Settings"' "${dump}" || grep -qi 'text="Select Network"' "${dump}"; then
        return 0
      fi
    fi
    sleep 12
  done
  echo "[ceremony] WARNING: launch_app polled 300 real seconds without seeing Home render — proceeding anyway; the next dump-based assertion will fail loudly if the app truly isn't up." >&2
}

# uiautomator dump helper: dumps the current window hierarchy to a local file
# and echoes its path. Never uses `adb shell input text` (see header) — every
# control is located by EN label text and tapped by computed center coords.
dump_ui() {
  local out="${TMPDIR_CEREMONY}/dump-$$-${RANDOM}.xml"
  # uiautomator dump can transiently fail (no accessible root node, e.g.
  # mid app-transition, or under the host-load conditions this project's
  # emulator gotchas warn about) WITHOUT touching /sdcard/window_dump.xml —
  # leaving a STALE file from a previous, unrelated dump on the device, or
  # producing a truncated/partial pull. Remove the remote file first so a
  # failed dump this call produces an empty/missing local file (a real
  # negative) rather than silently returning a prior ceremony's leftover
  # content as a false positive. Retry up to 3 times (observed under load:
  # a single dump attempt can transiently fail even while the app is
  # genuinely fully rendered) before giving up.
  #
  # R5d (57-03): if all 3 retries still fail to produce a well-formed hierarchy, that is "could
  # not observe" — NOT the same fact as "observed absent" — and every prior version of this
  # function returned whatever partial/empty content it last captured with no way for a caller to
  # tell the two apart, so a genuine instrument gap read as a false negative. The stdout contract
  # (a dump-file path, unconditionally echoed) is UNCHANGED — existing callers that only ever
  # treated "no match" as a negative keep doing exactly that. Callers that need the distinction
  # read the shared DUMP_UI_STATUS variable immediately after calling dump_ui.
  local attempt
  DUMP_UI_STATUS="unobservable"
  for attempt in 1 2 3; do
    adb ${ADBD} shell rm -f /sdcard/window_dump.xml >/dev/null 2>&1
    adb ${ADBD} shell uiautomator dump /sdcard/window_dump.xml >/dev/null 2>&1
    adb ${ADBD} pull /sdcard/window_dump.xml "${out}" >/dev/null 2>&1 || : > "${out}"
    if [ -s "${out}" ] && grep -q "</hierarchy>" "${out}" 2>/dev/null; then
      DUMP_UI_STATUS="ok"
      break
    fi
    sleep 1
  done
  if [ "${DUMP_UI_STATUS}" = "unobservable" ]; then
    echo "[ceremony] WARNING: dump_ui could not obtain a well-formed uiautomator hierarchy after 3 attempts — attempting a dumpsys activity fallback for confirmation." >&2
    adb ${ADBD} shell dumpsys activity activities 2>/dev/null | grep -i "mResumedActivity\|mCurrentFocus" >&2 || true
  fi
  echo "${out}"
}

# _find_nondegenerate_bounds ATTR LABEL DUMP_FILE — case-insensitive substring match
# against the given XML attribute (`text` or `content-desc`), returning the FIRST
# bounds value among all matching nodes that is NOT the degenerate "[0,0][0,0]" sentinel.
# Bracket-expression note (real bug, found and fixed during 49-13 Task 2):
# POSIX bracket expressions (`[...]`) do NOT support backslash-escaping — `\[`/`\]`
# INSIDE a `[...]` class are literal backslash-then-bracket, not an escaped bracket.
# `[0-9,\[\]]` under BSD/POSIX grep (the actual interpreter this script runs under,
# confirmed via `grep --version` -> "BSD grep, GNU compatible" — NOT the same grep some
# interactive dev shells alias) therefore closes the class early at the first literal
# `]` and silently fails to match every real `bounds="[x1,y1][x2,y2]"` value, making
# every match fail 100% of the time despite the target text being genuinely present
# (observed: 12/12 identical false failures against a real, static, already-rendered
# dump — not a timing issue). `[][0-9,]` is the POSIX-safe form: placing `]`
# immediately after the opening `[` makes it a literal member of the class instead of
# closing it.
_find_nondegenerate_bounds() {
  local attr="$1" label="$2" dump="$3"
  local candidates b
  # 49-14 pipefail note (same bug class as commit 6f1aff2): under this script's
  # `set -euo pipefail`, an EMPTY match at either grep stage makes the whole pipeline
  # exit non-zero (pipefail propagates ANY stage's failure, not only the trailing
  # command's) even though `sed` itself would happily process zero lines — guard with
  # `|| true` so "no match" degrades to an empty `candidates`, handled below, instead
  # of aborting the script.
  candidates=$(grep -io "${attr}=\"[^\"]*${label}[^\"]*\"[^>]*bounds=\"[][0-9,]*\"" "${dump}" \
    | grep -o 'bounds="[][0-9,]*"' | sed 's/bounds="//;s/"//' || true)
  while IFS= read -r b; do
    [ -z "${b}" ] && continue
    if [ "${b}" != "[0,0][0,0]" ]; then
      printf '%s\n' "${b}"
      return 0
    fi
  done <<< "${candidates}"
  return 1
}

# tap_on_text LABEL DUMP_FILE — case-insensitive substring match against
# `text=` attributes; taps the matched node's bounds center. Fails loudly
# (non-zero return, no tap) rather than silently skipping when no node
# matches — CustomButton uppercases its rendered title, so this matches
# case-insensitively by design.
#
# MIUI fallback (49-14 follow-up session, Redmi 8 finding): this device's bottom
# tab-bar/button `TextView` labels report `bounds="[0,0][0,0]"` in a uiautomator
# dump — their icon/text pairing collapses to a zero-size label under MIUI's layout,
# unlike Samsung. The actually-tappable element is the parent `ViewGroup`, which
# carries a real `content-desc` (matching the same label text) and correct bounds
# (confirmed via direct on-device XML inspection, 49-14-PROOF-LOG.md). Rather than
# walking the XML tree (this script has no XML parser), first look for ANY `text=`
# match with non-degenerate bounds (Samsung's existing, unregressed path — a device
# whose FIRST text match is already non-degenerate takes the exact same bounds as
# before this fix); only if every `text=` match is degenerate (or absent) does this
# fall back to a `content-desc=` match with non-degenerate bounds.
tap_on_text() {
  local label="$1" dump="$2" expect="${3:-}"
  local bounds
  bounds=$(_find_nondegenerate_bounds "text" "${label}" "${dump}" || true)
  if [ -z "${bounds}" ]; then
    bounds=$(_find_nondegenerate_bounds "content-desc" "${label}" "${dump}" || true)
  fi
  if [ -z "${bounds}" ]; then
    return 1
  fi
  # bounds format: [x1,y1][x2,y2]
  local x1 y1 x2 y2 cx cy
  x1=$(echo "${bounds}" | sed -E 's/\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]/\1/')
  y1=$(echo "${bounds}" | sed -E 's/\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]/\2/')
  x2=$(echo "${bounds}" | sed -E 's/\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]/\3/')
  y2=$(echo "${bounds}" | sed -E 's/\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]/\4/')
  cx=$(( (x1 + x2) / 2 ))
  cy=$(( (y1 + y2) / 2 ))

  # 57-UAT round 2 (Redmi 8, Android 10 / API 29) — TWO measured defects fixed here.
  #
  # (1) PRESS DURATION. An instantaneous `input tap` on this device's RN controls is
  #     unreliable. Measured A/B inside a reproduced failure: ONE `input tap` on the
  #     Settings tab was a no-op (the app stayed on Elections), while THREE taps, or a
  #     single ~120ms press, navigated. A zero-distance `input swipe` gives the press a
  #     real duration; it is a strict superset of the old behaviour on devices where the
  #     instantaneous tap already worked.
  #
  # (2) DISPATCH != EFFECT. This function used to `return 0` the moment it had dispatched
  #     a tap, never checking that anything happened. A swallowed tap therefore propagated
  #     as a SUCCESS, and the leg failed later against a screen it never reached — which is
  #     the same "could not observe" vs "observed absent" conflation R5(d) exists to fix,
  #     one step earlier in the flow. Callers may now pass an optional EXPECT string: the
  #     press is retried until that string is observable, and a genuine miss is reported at
  #     the point it happens instead of downstream.
  #
  # Callers that omit EXPECT keep the previous fire-and-forget contract exactly.
  local attempt
  for attempt in 1 2 3; do
    adb ${ADBD} shell input swipe "${cx}" "${cy}" "${cx}" "${cy}" 120
    if [ -z "${expect}" ]; then
      return 0
    fi
    sleep 2
    if text_present "${expect}" "$(dump_ui)"; then
      return 0
    fi
    echo "[ceremony] tap_on_text: pressed '${label}' (attempt ${attempt}/3) but '${expect}' is not yet observable — retrying." >&2
    sleep 2
  done
  echo "[ceremony] ERROR: pressed '${label}' 3 times and '${expect}' never appeared — the press did not take effect." >&2
  return 1
}

text_present() {
  local label="$1" dump="$2"
  grep -qi "text=\"[^\"]*${label}" "${dump}"
}

navigate_to_settings() {
  # Home mounts unconditionally at boot (RootNavigator's first Stack.Screen),
  # so Settings is reachable with zero network context. The tab header's
  # circle-user icon navigates Home -> Settings on every tab; tap the Settings
  # tab bar item directly (present in the bottom TabNavigator).
  local dump attempt
  # A single dump_ui call immediately after launch_app's own successful
  # readiness match can occasionally miss the same control under host-load
  # adb/uiautomator flakiness. Retry a few times with a short settle pause
  # before declaring the leg FAILed on what would otherwise be a false
  # negative.
  for attempt in 1 2 3; do
    dump=$(dump_ui)
    # Verify we actually ARRIVED: the Settings screen is identified by its Secure Signing row.
    if tap_on_text "Settings" "${dump}" "${STR_SETTINGS_ROW}"; then
      sleep 2
      return 0
    fi
    sleep 3
  done
  echo "[ceremony] ERROR: Settings tab not found in uiautomator dump" >&2
  return 1
}

# pull_storage_db — pulls RKStorage + its WAL/SHM sidecars into a fresh scratch dir and
# echoes the dir path. Shared by provision-local's on-disk artifact assertions and
# leg_storage — both read the same AsyncStorage-backed sqlite file via `run-as`.
pull_storage_db() {
  local pulldir="${TMPDIR_CEREMONY}/storage-$$-${RANDOM}"
  mkdir -p "${pulldir}"
  local f
  for f in RKStorage RKStorage-wal RKStorage-shm; do
    adb ${ADBD} shell "run-as ${PACKAGE} cat databases/${f}" > "${pulldir}/${f}" 2>/dev/null || true
  done
  echo "${pulldir}"
}

# capture_signing_reject_line — reads the app-pid-scoped logcat buffer for a
# VtSigningReject line carrying an `errorCode=` token (KeyAttestationHelper.kt's
# regenerateAttested/produceAttestation onAuthenticationError override — the only
# signing prompt a pm-clear device reaches). Matches on the tag plus the
# `errorCode=` token only, never a specific entry-point name, so this keeps working
# if the prompt under test ever moves — but the matched line itself is returned
# verbatim, since which entry point emitted it is itself evidence. Falls back to a
# package-name grep when `pidof` returns empty, mirroring the existing fault-check
# fallback below. Echoes the matched line, or nothing if none was found.
capture_signing_reject_line() {
  local app_pid line
  app_pid=$(adb ${ADBD} shell pidof "${PACKAGE}" 2>/dev/null | tr -d '\r' | awk '{print $1}')
  if [ -n "${app_pid}" ]; then
    line=$(adb ${ADBD} logcat -d --pid="${app_pid}" 2>/dev/null | grep "VtSigningReject" | grep "errorCode=" | head -1 || true)
  else
    line=$(adb ${ADBD} logcat -d 2>/dev/null | grep " ${PACKAGE}" | grep "VtSigningReject" | grep "errorCode=" | head -1 || true)
  fi
  printf '%s\n' "${line}"
}

# satisfy_biometric REASON — the hardware-portable replacement for a bare
# `adb emu finger touch 1` call (49-14). On an emulator, injects the virtual touch exactly as
# 49-13/49-18 always did. On real hardware there is no adb equivalent — physically touching the
# fingerprint sensor is required, and only a human can do that (49-14-PLAN.md Task 2's own
# instruction: "pause for a real touch instead of failing"). Polls the current dump for the
# prompt title to clear, bounded on HW_BIOMETRIC_TIMEOUT real wall-clock seconds, printing a loud
# operator instruction. Returns 0 once the prompt clears (the NEXT assertion in the calling leg
# is what actually judges success/failure — this helper only unblocks the wait) and 1 (non-fatal)
# if the timeout elapses with the prompt still showing.
satisfy_biometric() {
  local reason="${1:-signing}"
  if [ "${IS_EMULATOR}" -eq 1 ]; then
    adb ${ADBD} emu finger touch 1 >/dev/null 2>&1 || true
    return 0
  fi
  echo "[ceremony] ############################################################" >&2
  echo "[ceremony] ACTION REQUIRED on ${SERIAL}: touch the fingerprint sensor now to satisfy the '${reason}' BiometricPrompt." >&2
  echo "[ceremony] (real hardware has no 'adb emu finger touch' equivalent — this is a physical action, 49-14-PLAN.md Task 2)" >&2
  echo "[ceremony] waiting up to ${HW_BIOMETRIC_TIMEOUT}s ..." >&2
  echo "[ceremony] ############################################################" >&2

  # 2026-08-24 harness fix — a CLEARED SHEET IS NOT A SUCCESSFUL AUTHENTICATION. This function used
  # to return 0 the moment the prompt vanished, which a CANCEL does exactly as well as a touch. On
  # 2026-08-24 a cancelled prompt reported a cheerful `prompt cleared after 31s` and the run only
  # failed two legs later, with the real reason (`RuntimeException: Fingerprint operation canceled
  # by user`) buried in logcat. Sample the monotonic crypto-auth counter across the wait and report
  # what actually happened, so the cancel is visible AT the point it occurs.
  local auth_before
  auth_before=$(fp_success_count)

  local start_epoch dump cleared=0
  start_epoch=$(date +%s)
  while [ "$(( $(date +%s) - start_epoch ))" -lt "${HW_BIOMETRIC_TIMEOUT}" ]; do
    dump=$(dump_ui)
    if ! text_present "${STR_PROMPT_TITLE}" "${dump}"; then
      cleared=1
      echo "[ceremony] prompt cleared after $(( $(date +%s) - start_epoch ))s." >&2
      break
    fi
    sleep 3
  done

  if [ "${cleared}" -eq 0 ]; then
    record_leg "biometric-satisfied" "FAIL" "'${reason}': prompt STILL SHOWING after ${HW_BIOMETRIC_TIMEOUT}s — no physical touch observed"
    return 1
  fi

  # The sheet is gone. Now establish WHY. acceptCrypto is monotonic and increments only on a
  # CryptoObject-backed success, so it distinguishes a real authentication from a cancel/dismiss —
  # verified 2026-08-24: a cancelled prompt left it unchanged, a successful one moved it by exactly 1.
  local auth_after delta
  auth_after=$(fp_success_count)
  if echo "${auth_before}" | grep -qE '^[0-9]+$' && echo "${auth_after}" | grep -qE '^[0-9]+$'; then
    delta=$(( auth_after - auth_before ))
    if [ "${delta}" -ge 1 ]; then
      record_leg "biometric-satisfied" "PASS" "'${reason}': authenticated for real (acceptCrypto ${auth_before} -> ${auth_after})"
      return 0
    fi
    # Name the cause when the OS logged one; a bare counter delta of 0 is enough to fail on either way.
    local why
    why=$(adb ${ADBD} logcat -d 2>/dev/null \
      | grep -aoE "canceled by user|ERROR_USER_CANCELED|ERROR_NEGATIVE_BUTTON|ERROR_CANCELED|ERROR_TIMEOUT|ERROR_LOCKOUT[A-Z_]*" \
      | tail -1 || true)
    record_leg "biometric-satisfied" "FAIL" "'${reason}': the sheet was DISMISSED WITHOUT AUTHENTICATING (acceptCrypto unchanged at ${auth_after}${why:+, OS reason: ${why}}) — every later leg in this ceremony is now measuring an ABORTED run, not the product"
    return 1
  fi

  record_leg "biometric-satisfied" "NOT-EXERCISED" "'${reason}': prompt cleared, but the acceptCrypto counter was unreadable (samples: '${auth_before}' '${auth_after}') so success vs cancel could not be established — instrument gap"
  return 0
}

# satisfy_device_credential REASON — the D-16/D-26 recovery ceremony's authenticator is
# DEVICE_CREDENTIAL (PIN/pattern/password), never a fingerprint (BiometricPrompt forbids
# combining setAllowedAuthenticators(DEVICE_CREDENTIAL) with a negative button) — so this is
# ALWAYS a manual action, on an emulator or real hardware alike (the emulator's virtual
# fingerprint sensor cannot satisfy a device-credential prompt either). D-26a RESCOPED
# 2026-08-21: recovery is supported on API 30+ only; below API 30 `signWithRecoveryKey` now
# rejects with RECOVERY_UNSUPPORTED_OS before this prompt would ever be reached. Same bounded-wait
# shape as satisfy_biometric,
# printed as a distinctly-worded instruction so an operator does not confuse the two ceremonies —
# touching the sensor here does nothing; the sheet asks for the PIN/pattern/password.
satisfy_device_credential() {
  local reason="${1:-recovery}"
  echo "[ceremony] ############################################################" >&2
  echo "[ceremony] ACTION REQUIRED on ${SERIAL}: enter the device PIN/pattern/password now to satisfy the '${reason}' device-credential prompt (NOT a fingerprint touch)." >&2
  echo "[ceremony] waiting up to ${HW_BIOMETRIC_TIMEOUT}s ..." >&2
  echo "[ceremony] ############################################################" >&2
  local start_epoch dump
  start_epoch=$(date +%s)
  while [ "$(( $(date +%s) - start_epoch ))" -lt "${HW_BIOMETRIC_TIMEOUT}" ]; do
    dump=$(dump_ui)
    if ! text_present "${STR_PROMPT_TITLE}" "${dump}" && ! text_present "Confirm" "${dump}"; then
      echo "[ceremony] device-credential prompt cleared after $(( $(date +%s) - start_epoch ))s." >&2
      return 0
    fi
    sleep 3
  done
  echo "[ceremony] WARNING: device-credential prompt still showing after ${HW_BIOMETRIC_TIMEOUT}s. Proceeding anyway." >&2
  return 1
}

# fp_success_count — count of crypto-backed fingerprint authentications (2026-08-24 harness fix,
# defect 3). This is USER-scoped, not app-scoped (no app-pid equivalent exists for the fingerprint
# HAL trace) — a delta increase across a bounded operation window is treated as evidence of a
# fresh authentication for that operation, not a perfectly isolated per-app count. Documented
# explicitly wherever this is used as a verdict input.
#
# WAS: `grep -c "wasSuccessful=true"` over the whole dumpsys output. That parses the
# AuthSessionCoordinator trace, which is a BOUNDED RING — measured at exactly 100 entries
# (#320..#419) on a Pixel 7 Pro. It saturates and then EVICTS, so it is not monotonic and deltas
# across it are meaningless: the 2026-08-24 run recorded `op1=1 op2=-1 op3=0` and FAILed a leg on
# a device that had in fact authenticated once per operation. A negative delta is arithmetic proof
# the old counter could not be used this way.
#
# NOW: `acceptCrypto` from the per-enrolment `"prints":[{...}]` JSON — a monotonic lifetime count
# of CryptoObject-backed authentications, which is exactly what a per-use Keystore key requires
# (and is already trusted by this script's own preflight as substitute evidence). Verified on the
# same run: 4 -> 7 across the three signing operations, i.e. +1 each.
#
# Emits nothing when the counter cannot be read, so callers can distinguish "no auth" from
# "instrument unavailable" instead of silently scoring a 0.
fp_success_count() {
  # Both shapes observed in the wild: JSON ("acceptCrypto":7) and key=value (acceptCrypto=7).
  # `grep -a` because dumpsys output can carry bytes that make grep treat the stream as binary
  # and silently suppress matches. Emits NOTHING when the counter cannot be read, so callers can
  # distinguish "instrument unavailable" from "zero authentications" instead of scoring a 0.
  adb ${ADBD} shell dumpsys fingerprint 2>/dev/null \
    | grep -ao '"\?acceptCrypto"\?[:=][0-9]*' | head -1 | grep -ao '[0-9]*$' | head -1 || true
}

# ── dismiss_logbox / wait_for_text_onscreen (2026-08-24 harness fix) ──────────────────────────
# `provision-local-awaiting-network` FAILed twice on 2026-08-24 while the app was demonstrably in
# the correct state: a manual `uiautomator dump` seconds later showed
# `text="Secure signing is set up on this device"`, BOTH AsyncStorage rows were written, and the
# persisted chain decoded to a full D-07 PASS. The assertion was a SINGLE dump at a fixed offset.
#
# Two things make that unreliable, and these helpers address both:
#   * Timing — one dump at one instant, with no retry (dump_ui retries a FAILED dump, but a dump
#     that succeeds against a not-yet-settled screen is not a failure it can see).
#   * React Native's LogBox — the run's dump also carried `"Open debugger to view warnings."` and
#     `"RETURN TO APP"`, and logcat showed the dumper `Skipping invisible child` for a full-screen
#     (1440x3120) node. That is consistent with LogBox's overlay sitting on top of the app content.
#     LogBox is RAISED BY THE EXPECTED WARNING in this very scenario
#     (`Failed to load base engines: NoNetworkEstablishedError` on a deliberately network-less
#     device), so the leg testing the network-less state is the one most likely to be obscured.
#     NOTE: the overlay is the leading SUSPECT, not a confirmed cause; the polling above is correct
#     regardless, and dismissing an overlay that is not there is a no-op.
#
# Checks for the wanted text FIRST on every pass, so a dump that contains both the heading and the
# LogBox furniture passes immediately instead of being needlessly dismissed and re-dumped.

dismiss_logbox() {
  local dump="$1" marker
  for marker in "RETURN TO APP" "Open debugger to view warnings."; do
    if text_present "${marker}" "${dump}"; then
      echo "[ceremony]   -> RN LogBox overlay detected ('${marker}') — dismissing before re-asserting" >&2
      # tap_on_text needs a non-degenerate node; fall back to BACK, which LogBox also honours.
      if ! tap_on_text "RETURN TO APP" "${dump}"; then
        adb ${ADBD} shell input keyevent KEYCODE_BACK >/dev/null 2>&1 || true
      fi
      sleep 1
      return 0
    fi
  done
  return 1
}

# wait_for_text_onscreen LABEL [TIMEOUT] — poll for LABEL, clearing LogBox out of the way.
# Strictly more tolerant than a single dump and never less: a product that genuinely never renders
# LABEL still fails, just TIMEOUT later.
wait_for_text_onscreen() {
  local label="$1" timeout="${2:-${HEADING_WAIT_TIMEOUT}}"
  local start_epoch dump
  start_epoch=$(date +%s)
  while :; do
    dump=$(dump_ui)
    if text_present "${label}" "${dump}"; then
      return 0
    fi
    dismiss_logbox "${dump}" || true
    [ "$(( $(date +%s) - start_epoch ))" -ge "${timeout}" ] && break
    sleep 2
  done
  return 1
}

# ── observe_biometric_prompt (2026-08-24 harness fix, defect 1) ───────────────────────────────
# Replaces a `sleep 3; dump_ui; text_present` one-shot that raced the operator. On real hardware
# a human satisfies the sheet in ~2s, so by the time the single post-tap uiautomator dump landed
# the sheet was already GONE — producing `prompt-appears: FAIL` immediately followed by
# `prompt cleared after 2s`, three times in the 2026-08-24 Pixel 7 Pro run, on a device where the
# prompt demonstrably appeared and authenticated.
#
# Polls three independent sources, cheapest first, and accepts the FIRST that fires:
#   (a) `dumpsys window`  — a live `BiometricPrompt` window. ~100ms, so it can poll fast enough to
#                           catch a sheet a human dismisses in 2s (uiautomator alone cannot: one
#                           dump costs 1-2s and can transiently fail, see dump_ui).
#   (b) logcat since tap  — BOTH call sites `adb logcat -c` immediately before tapping, so the
#                           buffer is clean; a BiometricPrompt window line or a
#                           requestReason=BiometricPromptAuthentication event is proof the sheet
#                           existed even if every poll missed it live.
#   (c) uiautomator       — the original title assertion, still the strongest UI-level evidence
#                           when the sheet is caught on screen. Tried once on the (a) path so the
#                           leg keeps reporting the title when it can.
# Echoes the evidence string; returns 0 if observed, 1 if not.
observe_biometric_prompt() {
  local deadline=$(( $(date +%s) + PROMPT_OBSERVE_TIMEOUT ))
  local evidence=""
  while [ "$(date +%s)" -lt "${deadline}" ]; do
    if adb ${ADBD} shell dumpsys window 2>/dev/null | grep -q "BiometricPrompt"; then
      evidence="live BiometricPrompt window observed in dumpsys window"
      local d
      d=$(dump_ui)
      if text_present "${STR_PROMPT_TITLE}" "${d}"; then
        evidence="deviceSigningPromptTitle ('${STR_PROMPT_TITLE}') present on screen; live BiometricPrompt window in dumpsys window"
      fi
      echo "${evidence}"
      return 0
    fi
    if adb ${ADBD} logcat -d 2>/dev/null | grep -qE "u0 BiometricPrompt|requestReason=BiometricPromptAuthentication"; then
      echo "BiometricPrompt session evidenced in logcat since the tap (sheet satisfied faster than the poll interval)"
      return 0
    fi
    sleep 0.5
  done
  echo "no BiometricPrompt observed on screen, in dumpsys window, or in logcat within ${PROMPT_OBSERVE_TIMEOUT}s of the tap"
  return 1
}

# ── Leg: provision-local (D-24 leg 1, network-independent half — 49-18 / Gap A) ──
# The clean-device half of the split ceremony (see header comment). Keeps 49-13's
# sequence verbatim up through the fingerprint injection and no-spki-error check —
# every one of those sub-legs PASSed in 49-13 and keeps its exact record_leg name so
# the two proof logs stay comparable. The terminal assertion changes: under the
# 49-16/49-17 onboarding order this ceremony lands on the awaiting-network state, not
# the success heading (that is provision-register's job, after an operator-created
# network exists) — plus two on-disk artifact assertions the empty pre-49-16/49-17
# store could never establish.
provision_local() {
  reset_identity
  launch_app

  if ! navigate_to_settings; then
    record_leg "provision-settings-nav" "FAIL" "Settings tab control not found"
    return
  fi

  local dump
  dump=$(dump_ui)
  if ! text_present "${STR_SETTINGS_ROW}" "${dump}"; then
    record_leg "provision-settings-row" "FAIL" "settingsSigningKeyRow ('${STR_SETTINGS_ROW}') not present in Settings dump"
    return
  fi
  record_leg "provision-settings-row" "PASS" "settingsSigningKeyRow present"

  if ! tap_on_text "${STR_SETTINGS_ROW}" "${dump}"; then
    record_leg "provision-nav-to-screen" "FAIL" "could not tap '${STR_SETTINGS_ROW}' row"
    return
  fi
  sleep 2

  dump=$(dump_ui)
  if ! text_present "${STR_SETUP_BUTTON}" "${dump}"; then
    record_leg "provision-nav-to-screen" "FAIL" "signingKeyProvisioningSetupButton ('${STR_SETUP_BUTTON}') not present after navigating from Settings"
    return
  fi
  record_leg "provision-nav-to-screen" "PASS" "ProvisionSigningKeyScreen first-run body reached"

  adb ${ADBD} logcat -c
  if ! tap_on_text "${STR_SETUP_BUTTON}" "${dump}"; then
    record_leg "provision-setup-tap" "FAIL" "could not tap setup button"
    return
  fi

  # Leg 1 sub-claim 1: the OS BiometricPrompt sheet appears.
  local prompt_evidence
  if prompt_evidence=$(observe_biometric_prompt); then
    record_leg "provision-prompt-appears" "PASS" "${prompt_evidence}"
  else
    record_leg "provision-prompt-appears" "FAIL" "${prompt_evidence}"
  fi

  # FragmentManager / main-thread exception check (the 45-11 defect class).
  local fm_hits
  fm_hits=$(adb ${ADBD} logcat -d 2>/dev/null | grep -c "FragmentManager" || true)
  if [ "${fm_hits}" -eq 0 ]; then
    record_leg "provision-no-fragmentmanager-exception" "PASS" "0 FragmentManager lines in provisioning-window logcat"
  else
    record_leg "provision-no-fragmentmanager-exception" "FAIL" "${fm_hits} FragmentManager line(s) in provisioning-window logcat"
  fi

  satisfy_biometric "first-run provisioning" || true

  local verdict_line
  verdict_line=$(wait_for_logcat_line "INVALID_DIGEST_ENCODING|NO_KEY_PROVISIONED|SPKI" "${VERDICT_TIMEOUT}" "[ceremony]" "spki-error" "${ADBD}")
  if [ -n "${verdict_line}" ]; then
    record_leg "provision-no-spki-error" "FAIL" "logcat: ${verdict_line}"
  else
    record_leg "provision-no-spki-error" "PASS" "no INVALID_DIGEST_ENCODING/NO_KEY_PROVISIONED/SPKI error observed"
  fi

  # 49-18 (Gap A's runtime proof vehicle): the local ceremony is network-independent
  # by design and now terminates on the awaiting-network landing, not the success
  # heading — the network User's UserKey registration is provision-register's job,
  # on a later run against an operator-created network.
  # 2026-08-24 harness fix, defect 2 — stash THIS ceremony's boundDigest for the challengeBound
  # check. UNCONDITIONAL and ahead of the awaiting-network assertion on purpose: the digest is
  # evidence about the ceremony, not about the heading, and an earlier revision nested it inside
  # that assertion's PASS branch — so a flaky uiautomator dump lost the digest too, turning one
  # marginal check into two failures. Placement and selection both matter, and that revision got
  # both wrong:
  #   * AFTER the terminal assertion, not right after satisfy_biometric. `satisfy_biometric`
  #     returns as soon as the sheet DISAPPEARS, which a CANCEL does just as well as a success —
  #     observed 2026-08-24, where a cancelled first attempt was followed by a successful retry
  #     whose digest did not exist yet at the old capture point.
  #   * `tail -1`, not `head -1`. On exactly that retry the persisted chain comes from the LAST
  #     attestation, not the first; `head -1` captured the cancelled attempt's digest and the
  #     decoder then correctly reported challengeBound:false against a perfectly good chain.
  # Scoping to this function is what keeps `tail -1` safe: the buffer was cleared immediately
  # before the setup tap and is never cleared again inside provision_local, so it contains this
  # ceremony's digests and no later provision-register ones.
  # (The app emits this only under __DEV__ — see ProvisionSigningKeyScreen.tsx. Before that line
  # existed nothing emitted the digest at all and the check could never pass on any device.)
  local captured_digest
  captured_digest=$(adb ${ADBD} logcat -d 2>/dev/null \
    | grep -ao 'signing-key-provisioning-[0-9]*-[0-9a-f]*' | tail -1 || true)
  if [ -n "${captured_digest}" ]; then
    printf '%s' "${captured_digest}" > "${TMPDIR_CEREMONY}/bound-digest.txt"
    echo "[ceremony]   -> captured this run's boundDigest for the challengeBound check (${captured_digest})" >&2
  else
    echo "[ceremony]   -> WARNING: no boundDigest seen in the provisioning window. Is this a __DEV__ build? challengeBound will be reported NOT-EXERCISED rather than false." >&2
  fi

  if wait_for_text_onscreen "${STR_AWAITING_NETWORK_HEADING}"; then
    record_leg "provision-local-awaiting-network" "PASS" "signingKeyProvisioningAwaitingNetworkHeading ('${STR_AWAITING_NETWORK_HEADING}') present — local stage 1 completed on a genuinely network-less device"

  else
    record_leg "provision-local-awaiting-network" "FAIL" "signingKeyProvisioningAwaitingNetworkHeading NOT present after satisfying the prompt on a network-less device"
    return
  fi

  # Artifact 1 — D-24 leg 4's positive control, unreachable in 49-13 (the store was
  # always empty). A real 'deviceUser' row must now exist.
  local pulldir sqlite_bin
  pulldir=$(pull_storage_db)
  sqlite_bin=$(command -v sqlite3 || true)
  if [ -z "${sqlite_bin}" ]; then
    record_leg "provision-local-device-user-row" "FAIL" "no host sqlite3 available to inspect the pulled RKStorage files"
    record_leg "provision-local-attestation-chain" "FAIL" "no host sqlite3 available to inspect the pulled RKStorage files"
    return
  fi

  local device_user_present
  device_user_present=$("${sqlite_bin}" "${pulldir}/RKStorage" \
    "select count(*) from catalystLocalStorage where key = 'deviceUser';" 2>/dev/null || echo 0)
  if [ "${device_user_present}" = "0" ]; then
    record_leg "provision-local-device-user-row" "FAIL" "no 'deviceUser' row present after local ceremony completion"
  else
    record_leg "provision-local-device-user-row" "PASS" "'deviceUser' row present — D-24 leg 4's positive control, unreachable in 49-13"
  fi

  # Artifact 2 — D-15b's chain-shape claim, NOT-EXERCISED in 49-13 because nothing
  # was ever persisted. The deviceSigningProvisioning record's certificateChainBase64
  # array must exist and be non-empty; record its element count as evidence.
  local provisioning_value chain_array chain_count
  provisioning_value=$("${sqlite_bin}" "${pulldir}/RKStorage" \
    "select value from catalystLocalStorage where key = 'deviceSigningProvisioning' limit 1;" 2>/dev/null || true)
  if [ -z "${provisioning_value}" ]; then
    record_leg "provision-local-attestation-chain" "FAIL" "no 'deviceSigningProvisioning' row present after local ceremony completion"
  else
    chain_array=$(echo "${provisioning_value}" | grep -o '"certificateChainBase64":\[[^]]*\]' || true)
    if [ -z "${chain_array}" ] || [ "${chain_array}" = '"certificateChainBase64":[]' ]; then
      record_leg "provision-local-attestation-chain" "FAIL" "'deviceSigningProvisioning' row present but certificateChainBase64 is empty or missing"
    else
      chain_count=$(( $(echo "${chain_array}" | grep -o ',' | wc -l | tr -d ' ') + 1 ))
      record_leg "provision-local-attestation-chain" "PASS" "certificateChainBase64 present with ${chain_count} element(s) — D-15b's leaf+intermediates shape, first exercised this session"
    fi
  fi
}

# ── Leg: provision-register (D-24 leg 1, network-scoped half — 49-18 / Gap A) ────
# Deliberately does NOT clear this device's app data first — its whole precondition
# is a device that already carries a local provisioning record (provision-local)
# AND a network created/joined through the real in-app flow since. Wiping the
# identity here would destroy exactly what this leg depends on. See the header
# comment for why the network-creation step is an explicit, printed operator
# interlude rather than an automated one.
provision_register() {
  echo "[ceremony] 'provision-register' precondition (operator-driven, NOT automated by this script):" >&2
  echo "[ceremony]   1. 'provision-local' has already completed on this device (deviceUser + deviceSigningProvisioning rows exist)." >&2
  echo "[ceremony]   2. A network has SINCE been created or joined through the real in-app AddNetworkScreen flow." >&2
  echo "[ceremony]   This script does not automate network creation — see the header comment." >&2

  local pulldir sqlite_bin device_user_present
  pulldir=$(pull_storage_db)
  sqlite_bin=$(command -v sqlite3 || true)
  if [ -z "${sqlite_bin}" ]; then
    record_leg "provision-register-precondition" "FAIL" "no host sqlite3 available to verify the 'deviceUser' precondition row"
    return
  fi
  device_user_present=$("${sqlite_bin}" "${pulldir}/RKStorage" \
    "select count(*) from catalystLocalStorage where key = 'deviceUser';" 2>/dev/null || echo 0)
  if [ "${device_user_present}" = "0" ]; then
    record_leg "provision-register-precondition" "FAIL" "no 'deviceUser' row on this device — run 'provision-local' first; running 'provision-register' on an unprovisioned device would produce a meaningless verdict"
    return
  fi

  launch_app
  if ! navigate_to_settings; then
    record_leg "provision-register-settings-nav" "FAIL" "Settings tab control not found"
    return
  fi

  local dump
  dump=$(dump_ui)
  if ! tap_on_text "${STR_SETTINGS_ROW}" "${dump}"; then
    record_leg "provision-register-settings-nav" "FAIL" "could not tap '${STR_SETTINGS_ROW}' row"
    return
  fi
  sleep 2

  adb ${ADBD} logcat -c
  dump=$(dump_ui)
  if ! tap_on_text "${STR_SETUP_BUTTON}" "${dump}"; then
    record_leg "provision-register-setup-tap" "FAIL" "could not tap '${STR_SETUP_BUTTON}' button"
    return
  fi

  local prompt_evidence
  if prompt_evidence=$(observe_biometric_prompt); then
    record_leg "provision-register-prompt-appears" "PASS" "stage 2's signed recovery-key BiometricPrompt — ${prompt_evidence}"
  else
    record_leg "provision-register-prompt-appears" "FAIL" "stage 2 did not reach the signed recovery-key prompt — ${prompt_evidence}"
  fi

  satisfy_biometric "stage-2 recovery-key registration" || true

  if wait_for_text_onscreen "${STR_SUCCESS_HEADING}"; then
    record_leg "provision-success-heading" "PASS" "signingKeyProvisioningSuccessHeading ('${STR_SUCCESS_HEADING}') present — end-to-end SignatureValidP256 evidence (see 49-13-PROOF-LOG.md)"
  else
    record_leg "provision-success-heading" "FAIL" "signingKeyProvisioningSuccessHeading NOT present after satisfying the stage-2 prompt"
  fi
}

# ── Leg: sign (D-24 leg 1 sub-claim 3 — a distinct per-use prompt) ──────────
leg_sign() {
  echo "[ceremony] 'sign' leg: drives a genuine per-use officer action distinct from provisioning." \
    "Requires the device to already be provisioned (run 'provision' first, without an intervening pm clear)." \
    "See 49-13-PROOF-LOG.md for the specific call site exercised and its evidence."
  record_leg "sign-per-use-prompt" "NOT-EXERCISED" "recorded manually in 49-13-PROOF-LOG.md — see leg 1 sub-claim 3"
}

# ── Leg: cancel (D-24 leg 2 + Gap B closure, 49-18) ──────────────────────────
# Drives BOTH user-initiated dismissal paths of the first-run provisioning prompt
# (the only BiometricPrompt sheet a pm-clear device reaches — see 49-GAPS.md Gap B
# and KeyAttestationHelper.kt's regenerateAttested onAuthenticationError override):
# the system prompt's own negative ("Cancel") button, and the hardware BACK key
# (NOT-EXERCISED in 49-13, folded in here per 49-GAPS.md). Each pass re-runs the
# full reset/relaunch/navigate preamble first — mirrors provision_local. Without
# this, running a dismissal check on top of a screen still showing a STALE error
# from an earlier attempt makes the "no error text" assertion meaningless, since
# it would fail on content that predates the action under test (49-13 Deviation 3).
leg_cancel_negative_button() {
  reset_identity
  launch_app
  if ! navigate_to_settings; then
    record_leg "cancel-negative-button" "FAIL" "could not reach Settings to start the cancel leg from a clean identity"
    return
  fi
  local dump
  dump=$(dump_ui)
  if ! tap_on_text "${STR_SETTINGS_ROW}" "${dump}"; then
    record_leg "cancel-negative-button" "FAIL" "could not tap '${STR_SETTINGS_ROW}' row to reach ProvisionSigningKeyScreen"
    return
  fi
  sleep 2
  dump=$(dump_ui)

  if ! tap_on_text "${STR_SETUP_BUTTON}" "${dump}" && ! tap_on_text "Replace Signing Key" "${dump}"; then
    echo "[ceremony] 'cancel' leg: no provisioning/replace action reachable from the current screen — drive to a signing action manually first." >&2
  fi
  sleep 3
  dump=$(dump_ui)
  # R5d: a dump_ui miss here used to be indistinguishable from "the prompt title genuinely isn't
  # there" — record the instrument gap as NOT-EXERCISED instead of a false FAIL.
  if [ "${DUMP_UI_STATUS}" = "unobservable" ]; then
    record_leg "cancel-negative-button" "NOT-EXERCISED" "uiautomator could not observe the screen state before attempting dismissal — instrument gap, not a negative result"
    return
  fi
  if ! text_present "${STR_PROMPT_TITLE}" "${dump}"; then
    record_leg "cancel-negative-button" "FAIL" "deviceSigningPromptTitle ('${STR_PROMPT_TITLE}') not observed before attempting dismissal"
    return
  fi

  # R5a: capture the DEVICE clock immediately before dispatching the dismissal — the error window
  # this leg measures starts HERE, not at the app's cold-boot keygen. A host timestamp would be
  # wrong: emulator clocks lag the host (see the clock-skew preflight above), which would silently
  # widen or empty the window.
  local dismissal_ts
  dismissal_ts=$(adb ${ADBD} shell date "+%Y-%m-%d %H:%M:%S.000" | tr -d '\r')

  if ! tap_on_text "${STR_NEGATIVE_BUTTON}" "${dump}"; then
    record_leg "cancel-negative-button" "FAIL" "deviceSigningPromptNegativeButton ('${STR_NEGATIVE_BUTTON}') not found to dismiss the prompt"
    return
  fi
  record_leg "cancel-negative-button" "PASS" "deviceSigningPromptNegativeButton tapped, dismissing the prompt"
  sleep 2

  dump=$(dump_ui)
  local err_hit=0 s
  for s in "${STR_ERROR_STRINGS[@]}"; do
    if text_present "${s}" "${dump}"; then err_hit=1; fi
  done
  if [ "${err_hit}" -eq 0 ]; then
    record_leg "cancel-no-error-text" "PASS" "none of the deviceSigningError* EN strings present post-dismissal"
  else
    record_leg "cancel-no-error-text" "FAIL" "a deviceSigningError* string was rendered post-dismissal"
  fi

  # R5a: window starts at dismissal_ts (captured above, device clock), scoped to our app's pid,
  # with platform-emitted tags (PLATFORM_TAG_EXCLUSIONS) excluded so a StrongBox-fallback keygen
  # line or similar cannot fail an app-authored-error leg. Previously this cleared logcat ~11-12s
  # BEFORE the dismissal (well before this leg even reached it) and counted everything since —
  # including boot/keygen noise unrelated to the dismissal under test. A read that returns ZERO
  # lines of ANY level means the window/timestamp is wrong, not that the app was silent —
  # NOT-EXERCISED, never PASS, in that case.
  local app_pid post_dismissal_log total_lines err_lines
  app_pid=$(adb ${ADBD} shell pidof "${PACKAGE}" 2>/dev/null | tr -d '\r' | awk '{print $1}')
  if [ -n "${app_pid}" ]; then
    post_dismissal_log=$(adb ${ADBD} logcat -d -T "${dismissal_ts}" --pid="${app_pid}" 2>/dev/null || true)
  else
    post_dismissal_log=$(adb ${ADBD} logcat -d -T "${dismissal_ts}" 2>/dev/null | grep " ${PACKAGE}" || true)
  fi
  total_lines=$(printf '%s\n' "${post_dismissal_log}" | grep -c . || true)
  if [ "${total_lines}" -eq 0 ]; then
    record_leg "cancel-no-logged-fault" "NOT-EXERCISED" "post-dismissal log window empty — instrument gap"
  else
    err_lines=$(printf '%s\n' "${post_dismissal_log}" | grep " E " | grep -vE "${PLATFORM_TAG_EXCLUSIONS}" | grep -c . || true)
    if [ "${err_lines}" -eq 0 ]; then
      record_leg "cancel-no-logged-fault" "PASS" "0 app-authored error-level logcat lines in the post-dismissal window (device-clock T=${dismissal_ts})"
    else
      record_leg "cancel-no-logged-fault" "FAIL" "${err_lines} app-authored error-level logcat line(s) in the post-dismissal window (device-clock T=${dismissal_ts})"
    fi
  fi

  # Gap B closure: the raw native errorCode must remain recoverable from an
  # app-pid-scoped VtSigningReject log line, so 49-14's hardware run can record
  # which BiometricPrompt constant real hardware delivers (5/10/13) instead of
  # that fact being silently absorbed by the widened CANCELED classification.
  local reject_line raw_code mapped_code
  reject_line=$(capture_signing_reject_line)
  if [ -z "${reject_line}" ]; then
    record_leg "cancel-errorcode-observability" "FAIL" "no VtSigningReject line found for this dismissal"
  else
    raw_code=$(echo "${reject_line}" | grep -o 'errorCode=[0-9-]*' | head -1 | sed 's/errorCode=//')
    mapped_code=$(echo "${reject_line}" | grep -o 'mapped=[A-Z_]*' | head -1 | sed 's/mapped=//')
    if [ "${mapped_code}" = "CANCELED" ]; then
      record_leg "cancel-errorcode-observability" "PASS" "errorCode=${raw_code} mapped=${mapped_code} (raw log: ${reject_line})"
    else
      record_leg "cancel-errorcode-observability" "FAIL" "mapped=${mapped_code:-<none>} (expected CANCELED) errorCode=${raw_code:-<none>}; raw log: ${reject_line}"
    fi
  fi
}

leg_cancel_back_key() {
  reset_identity
  launch_app
  if ! navigate_to_settings; then
    record_leg "cancel-negative-button-back" "FAIL" "could not reach Settings to start the cancel leg from a clean identity"
    return
  fi
  local dump
  dump=$(dump_ui)
  if ! tap_on_text "${STR_SETTINGS_ROW}" "${dump}"; then
    record_leg "cancel-negative-button-back" "FAIL" "could not tap '${STR_SETTINGS_ROW}' row to reach ProvisionSigningKeyScreen"
    return
  fi
  sleep 2
  dump=$(dump_ui)

  if ! tap_on_text "${STR_SETUP_BUTTON}" "${dump}" && ! tap_on_text "Replace Signing Key" "${dump}"; then
    echo "[ceremony] 'cancel' leg (BACK-key variant): no provisioning/replace action reachable from the current screen — drive to a signing action manually first." >&2
  fi
  sleep 3
  dump=$(dump_ui)
  # R5d: a dump_ui miss here used to be indistinguishable from "the prompt title genuinely isn't
  # there" — record the instrument gap as NOT-EXERCISED instead of a false FAIL.
  if [ "${DUMP_UI_STATUS}" = "unobservable" ]; then
    record_leg "cancel-negative-button-back" "NOT-EXERCISED" "uiautomator could not observe the screen state before attempting dismissal — instrument gap, not a negative result"
    return
  fi
  if ! text_present "${STR_PROMPT_TITLE}" "${dump}"; then
    record_leg "cancel-negative-button-back" "FAIL" "deviceSigningPromptTitle ('${STR_PROMPT_TITLE}') not observed before attempting dismissal"
    return
  fi

  # R5a: capture the DEVICE clock immediately before dispatching the dismissal — see
  # leg_cancel_negative_button's identical rationale above; the two legs share this shape
  # deliberately so they cannot drift from each other.
  local dismissal_ts
  dismissal_ts=$(adb ${ADBD} shell date "+%Y-%m-%d %H:%M:%S.000" | tr -d '\r')

  adb ${ADBD} shell input keyevent KEYCODE_BACK
  record_leg "cancel-negative-button-back" "PASS" "KEYCODE_BACK dispatched, dismissing the prompt"
  sleep 2

  dump=$(dump_ui)
  local err_hit=0 s
  for s in "${STR_ERROR_STRINGS[@]}"; do
    if text_present "${s}" "${dump}"; then err_hit=1; fi
  done
  if [ "${err_hit}" -eq 0 ]; then
    record_leg "cancel-no-error-text-back" "PASS" "none of the deviceSigningError* EN strings present post-dismissal"
  else
    record_leg "cancel-no-error-text-back" "FAIL" "a deviceSigningError* string was rendered post-dismissal"
  fi

  # R5a: see leg_cancel_negative_button's identical block above for the full rationale
  # (timestamped window + PLATFORM_TAG_EXCLUSIONS + empty-window NOT-EXERCISED guard).
  local app_pid post_dismissal_log total_lines err_lines
  app_pid=$(adb ${ADBD} shell pidof "${PACKAGE}" 2>/dev/null | tr -d '\r' | awk '{print $1}')
  if [ -n "${app_pid}" ]; then
    post_dismissal_log=$(adb ${ADBD} logcat -d -T "${dismissal_ts}" --pid="${app_pid}" 2>/dev/null || true)
  else
    post_dismissal_log=$(adb ${ADBD} logcat -d -T "${dismissal_ts}" 2>/dev/null | grep " ${PACKAGE}" || true)
  fi
  total_lines=$(printf '%s\n' "${post_dismissal_log}" | grep -c . || true)
  if [ "${total_lines}" -eq 0 ]; then
    record_leg "cancel-no-logged-fault-back" "NOT-EXERCISED" "post-dismissal log window empty — instrument gap"
  else
    err_lines=$(printf '%s\n' "${post_dismissal_log}" | grep " E " | grep -vE "${PLATFORM_TAG_EXCLUSIONS}" | grep -c . || true)
    if [ "${err_lines}" -eq 0 ]; then
      record_leg "cancel-no-logged-fault-back" "PASS" "0 app-authored error-level logcat lines in the post-dismissal window (device-clock T=${dismissal_ts})"
    else
      record_leg "cancel-no-logged-fault-back" "FAIL" "${err_lines} app-authored error-level logcat line(s) in the post-dismissal window (device-clock T=${dismissal_ts})"
    fi
  fi

  local reject_line raw_code mapped_code
  reject_line=$(capture_signing_reject_line)
  if [ -z "${reject_line}" ]; then
    record_leg "cancel-errorcode-observability-back" "FAIL" "no VtSigningReject line found for this dismissal"
  else
    raw_code=$(echo "${reject_line}" | grep -o 'errorCode=[0-9-]*' | head -1 | sed 's/errorCode=//')
    mapped_code=$(echo "${reject_line}" | grep -o 'mapped=[A-Z_]*' | head -1 | sed 's/mapped=//')
    if [ "${mapped_code}" = "CANCELED" ]; then
      record_leg "cancel-errorcode-observability-back" "PASS" "errorCode=${raw_code} mapped=${mapped_code} (raw log: ${reject_line})"
    else
      record_leg "cancel-errorcode-observability-back" "FAIL" "mapped=${mapped_code:-<none>} (expected CANCELED) errorCode=${raw_code:-<none>}; raw log: ${reject_line}"
    fi
  fi
}

leg_cancel() {
  leg_cancel_negative_button
  leg_cancel_back_key
}

# ── Leg: storage (D-24 leg 4 — no plaintext key residue) ────────────────────
# Bounded-hex-run fix (T-49-PLAIN, 49-18). A 32-byte private key serializes to
# exactly 64 hex characters (32*2=64) and MUST still match. The app's own 33-byte
# compressed P-256 public key serializes to exactly 66 hex characters (33*2=66) and
# MUST NOT — a 66-char hex run trivially CONTAINS a 64-char run, so the original
# unbounded `{64}` pattern false-FAILs the instant a real 'deviceUser' row exists
# (exactly the positive control the check below requires). Bounding the run on
# BOTH sides by a non-hex character or a string boundary keeps the 64-char private
# key matching while excluding any run that is part of a longer hex sequence.
HEX64_BOUNDED_PATTERN='(^|[^0-9a-fA-F])[0-9a-fA-F]{64}([^0-9a-fA-F]|$)'

leg_storage() {
  local pulldir
  pulldir=$(pull_storage_db)

  local sqlite_bin
  sqlite_bin=$(command -v sqlite3 || true)
  if [ -z "${sqlite_bin}" ]; then
    record_leg "storage-no-plaintext-key" "FAIL" "no host sqlite3 available to inspect the pulled RKStorage files"
    return
  fi

  local rows hex_hits
  rows=$("${sqlite_bin}" "${pulldir}/RKStorage" "select count(*) from catalystLocalStorage;" 2>/dev/null || echo 0)
  hex_hits=$("${sqlite_bin}" "${pulldir}/RKStorage" \
    "select count(*) from catalystLocalStorage where value regexp '${HEX64_BOUNDED_PATTERN}';" 2>/dev/null || echo "unknown")

  echo "[ceremony] storage: ${rows} row(s) scanned in catalystLocalStorage (RKStorage + WAL/SHM pulled to ${pulldir})"

  local device_user_present
  device_user_present=$("${sqlite_bin}" "${pulldir}/RKStorage" \
    "select count(*) from catalystLocalStorage where key = 'deviceUser';" 2>/dev/null || echo 0)
  if [ "${device_user_present}" = "0" ]; then
    record_leg "storage-positive-control" "FAIL" "no 'deviceUser' row present — the store may be empty, which would make the negative check below meaningless"
  else
    record_leg "storage-positive-control" "PASS" "'deviceUser' row present (${rows} total rows scanned)"
  fi

  if [ "${hex_hits}" = "unknown" ]; then
    # regexp() UDF not available in a bare sqlite3 build — fall back to a bounded
    # grep scan of the dumped .dump output. `-o` prints each match on its own
    # output line so a subsequent `wc -l` counts true OCCURRENCES, not matching
    # LINES — the original `grep -ocE` combined `-o` with `-c`, which counts
    # matching LINES regardless of `-o` and silently under-counts any row with
    # more than one hit.
    local grep_hits
    grep_hits=$("${sqlite_bin}" "${pulldir}/RKStorage" ".dump" 2>/dev/null | grep -oE "${HEX64_BOUNDED_PATTERN}" | wc -l | tr -d ' ')
    if [ "${grep_hits}" -eq 0 ]; then
      record_leg "storage-no-plaintext-key" "PASS" "0 rows match a bounded 64-hex-character run (grep fallback, ${rows} rows scanned)"
    else
      record_leg "storage-no-plaintext-key" "FAIL" "${grep_hits} bounded 64-hex-character run(s) found (grep fallback)"
    fi
  elif [ "${hex_hits}" = "0" ]; then
    record_leg "storage-no-plaintext-key" "PASS" "0 rows match a bounded 64-hex-character run (${rows} rows scanned)"
  else
    record_leg "storage-no-plaintext-key" "FAIL" "${hex_hits} row(s) match a bounded 64-hex-character run"
  fi
}

# ── Leg: hw-chain-decode / hw-strongbox-rung / hw-chain-shape (49-14, Task 2 items 1-2) ──────
# Pulls the persisted deviceSigningProvisioning record's certificateChainBase64 array (written by
# provision_local against the REAL Keystore-produced chain — hardware-rooted, unlike 49-13's
# emulator run which never persisted one), decodes the leaf via the Phase 45 offline decoder, and
# derives the D-07 StrongBox/TEE rung determination plus the D-15b chain-shape verdict from its
# machine output rather than a transcribed claim.
hw_decode_attestation_chain() {
  local pulldir sqlite_bin provisioning_value chain_array chain_json_path
  pulldir=$(pull_storage_db)
  sqlite_bin=$(command -v sqlite3 || true)
  if [ -z "${sqlite_bin}" ]; then
    record_leg "hw-chain-decode" "FAIL" "no host sqlite3 available to inspect the pulled RKStorage files"
    return
  fi
  provisioning_value=$("${sqlite_bin}" "${pulldir}/RKStorage" \
    "select value from catalystLocalStorage where key = 'deviceSigningProvisioning' limit 1;" 2>/dev/null || true)
  if [ -z "${provisioning_value}" ]; then
    record_leg "hw-chain-decode" "FAIL" "no 'deviceSigningProvisioning' row present — provisioning did not complete on this device"
    return
  fi
  chain_array=$(echo "${provisioning_value}" | grep -o '"certificateChainBase64":\[[^]]*\]' | sed 's/^"certificateChainBase64"://' || true)
  if [ -z "${chain_array}" ] || [ "${chain_array}" = '[]' ]; then
    record_leg "hw-chain-decode" "FAIL" "certificateChainBase64 empty or missing in the persisted provisioning record"
    return
  fi
  chain_json_path="${TMPDIR_CEREMONY}/hw-chain-${SERIAL}.json"
  printf '%s' "${chain_array}" > "${chain_json_path}"

  local node_bin decoder_rel="packages/vote-engine/scripts/decode-attestation-leaf.mjs"
  node_bin=$(command -v node || true)
  if [ -z "${node_bin}" ] || [ ! -f "${decoder_rel}" ]; then
    record_leg "hw-chain-decode" "FAIL" "node or ${decoder_rel} not available on this host"
    return
  fi

  # The decoder's (iii) challengeBound check needs the EXACT boundDigest string
  # (ProvisionSigningKeyScreen.tsx's runLocalCeremony: 'signing-key-provisioning-<ts>-<hex>'),
  # which is never persisted verbatim — recovered from this session's own logcat capture instead
  # (best-effort; a miss here only weakens challengeBound, not the attestationSecurityLevel /
  # chainLength / rootPresent values this leg actually gates on).
  local bound_digest
  if [ -s "${TMPDIR_CEREMONY}/bound-digest.txt" ]; then
    bound_digest=$(cat "${TMPDIR_CEREMONY}/bound-digest.txt")
  else
    # Fallback for a leg run standalone (no provision_local in this process). Unscoped, so this
    # is best-effort: `tail -1` matches the retry case above, but if a later provision-register
    # ceremony has since run, its digest wins and challengeBound will read false. The scoped
    # capture above is the reliable path; this exists only so the leg degrades rather than dies.
    bound_digest=$(adb ${ADBD} logcat -d 2>/dev/null | grep -ao 'signing-key-provisioning-[0-9]*-[0-9a-f]*' | tail -1 || true)
  fi
  [ -z "${bound_digest}" ] && bound_digest="unavailable-not-logged"

  local decode_log="${TMPDIR_CEREMONY}/hw-chain-decode-log-${SERIAL}.md" decode_out decode_status
  : > "${decode_log}"
  set +e
  decode_out=$(cd packages/vote-engine && "${node_bin}" scripts/decode-attestation-leaf.mjs \
    "${chain_json_path}" "${decode_log}" "${bound_digest}" 2>&1)
  decode_status=$?
  set -e
  echo "[ceremony] decode-attestation-leaf.mjs output (SERIAL=${SERIAL}):" >&2
  echo "${decode_out}" >&2

  local sec_level chain_len root_present
  sec_level=$(echo "${decode_out}" | grep -o 'attestationSecurityLevel: [0-9]*' | head -1 || true)
  chain_len=$(echo "${decode_out}" | grep -o 'chainLength: [0-9]*' | head -1 | grep -o '[0-9]*$' || true)
  root_present=$(echo "${decode_out}" | grep -o 'rootPresent: [a-z]*' | head -1 | grep -o '[a-z]*$' || true)

  # challengeBound is reported as its own leg (defect 2). When the expected digest could not be
  # captured the decoder necessarily compares against the placeholder and returns false — that is
  # an ABSENT MEASUREMENT, not a failed binding, and must never be recorded as the latter.
  local challenge_bound
  challenge_bound=$(echo "${decode_out}" | grep -o 'challengeBound: [a-z]*' | head -1 | grep -o '[a-z]*$' || true)
  if [ "${bound_digest}" = "unavailable-not-logged" ]; then
    record_leg "hw-challenge-bound" "NOT-EXERCISED" "this run's boundDigest was never captured (the app emits it only under __DEV__), so the decoder had nothing to compare the leaf challenge against — instrument gap, NOT a binding failure"
  elif [ "${challenge_bound}" = "true" ]; then
    record_leg "hw-challenge-bound" "PASS" "the attestation leaf's challenge is byte-identical to the boundDigest THIS ceremony generated (${bound_digest})"
  else
    record_leg "hw-challenge-bound" "FAIL" "leaf challenge does NOT match this run's boundDigest (${bound_digest}) — a stale or replayed chain"
  fi

  if [ -n "${sec_level}" ]; then
    record_leg "hw-chain-decode" "PASS" "decoder produced a verdict block (exit=${decode_status}) — ${sec_level}; see hw-strongbox-rung/hw-chain-shape/hw-challenge-bound for the derived verdicts (a non-zero exit here only reflects the decoder folding challengeBound into its own gate)"
  else
    record_leg "hw-chain-decode" "FAIL" "decoder produced no attestationSecurityLevel (exit=${decode_status}); output: ${decode_out}"
    return
  fi

  # D-07 / Phase 45 residual leg 1 (49-14-PLAN.md's 2026-08-18 amendment): PASS requires level 2
  # (StrongBox) on BOTH fields. A 1 (TEE) is recorded BLOCKED-NO-HARDWARE, not FAIL — this fleet's
  # devices carry no StrongBox chip at all (Task 1's confirmed `pm list features` result), so a
  # TEE-only result here is the EXPECTED, correctly-functioning fallback, not a defect. Never
  # reinterpret a TEE result as a StrongBox PASS.
  local strongbox_feature
  strongbox_feature=$(adb ${ADBD} shell pm list features 2>/dev/null | grep -i strongbox || true)
  if echo "${decode_out}" | grep -q "attestationSecurityLevel: 2"; then
    record_leg "hw-strongbox-rung" "PASS" "${sec_level} — StrongBox rung genuinely selected"
  elif [ -n "${strongbox_feature}" ]; then
    record_leg "hw-strongbox-rung" "FAIL" "${sec_level:-<not found>} — device DOES report ${strongbox_feature} but the decoder did not observe level 2; a real StrongBox-capable device fell through to TEE"
  else
    record_leg "hw-strongbox-rung" "BLOCKED-NO-HARDWARE" "${sec_level:-<not found>} — 'pm list features | grep strongbox' is empty on ${SERIAL} (confirmed Task 1); no device in this project's fleet has a StrongBox chip (Samsung ships it via Knox Vault on flagships only), so the StrongBox-primary rung cannot be exercised here. TEE fallback is the expected, correctly-functioning result. Residual stays OPEN in .planning/todos/pending/2026-08-03-attestation-strongbox-and-api34-residuals.md leg 1."
  fi

  # D-15b — leaf + intermediates, root dropped. Hardware-rooted (unlike 49-13's emulator run,
  # which never persisted a chain at all — NOT-EXERCISED there).
  if [ -n "${chain_len}" ] && [ "${chain_len}" -ge 2 ] && [ "${root_present}" = "false" ]; then
    record_leg "hw-chain-shape" "PASS" "chainLength=${chain_len} rootPresent=${root_present} — hardware-rooted leaf+intermediates, root dropped (49-13's emulator run never persisted a chain to check)"
  else
    record_leg "hw-chain-shape" "FAIL" "chainLength=${chain_len:-<none>} rootPresent=${root_present:-<none>}"
  fi
}

# ── Leg: hw-provision (49-14 Task 2 — real-hardware pre-invalidation legs) ───────────────────
# Combines provision_local + an operator-driven network-creation interlude + provision_register
# (Gap A's now-closed two-stage order, 49-16/49-17/49-18) on REAL hardware, then adds the
# hardware-only claims 49-13 could never reach on an emulator: a hardware-rooted chain, the
# StrongBox/TEE rung determination, and the API-30+ setUserAuthenticationParameters per-use
# semantics (three consecutive signing operations, each producing its own OS-level
# authentication) — or, below API 30, confirmation that the bare setUserAuthenticationRequired
# fallback branch provisioned and signed (D-17's other half).
hw_provision() {
  if [ "${IS_EMULATOR}" -eq 1 ]; then
    echo "[ceremony] PREFLIGHT FAIL: 'hw-provision' requires real hardware (this is 49-14's leg) — '${SERIAL}' resolved as an emulator; use 'provision-local'/'provision-register' instead." >&2
    exit 1
  fi

  local sdk
  sdk=$(adb ${ADBD} shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r')

  local auth_c0 auth_c1 auth_c2
  auth_c0=$(fp_success_count)
  provision_local
  auth_c1=$(fp_success_count)

  echo "[ceremony] ============================================================" >&2
  echo "[ceremony] OPERATOR ACTION on ${SERIAL}: create or join a network through the real in-app 'Select Network' -> 'Create Network' flow now (six-field RN form — not adb-driven, see script header)." >&2
  echo "[ceremony] Waiting ${HW_NETWORK_WAIT}s before attempting 'provision-register' automatically ..." >&2
  echo "[ceremony] ============================================================" >&2
  sleep "${HW_NETWORK_WAIT}"

  provision_register
  auth_c2=$(fp_success_count)

  hw_decode_attestation_chain

  # fp_success_count emits nothing if the counter could not be read (defect-3 fix). Empty vars
  # evaluate to 0 in bash arithmetic, which would silently manufacture a "zero fresh
  # authentications" FAIL out of a missing instrument — check before doing the subtraction.
  local c
  for c in "${auth_c0}" "${auth_c1}" "${auth_c2}"; do
    if ! echo "${c}" | grep -qE '^[0-9]+$'; then
      record_leg "hw-api34-per-use-semantics" "NOT-EXERCISED" "acceptCrypto counter unreadable on this device (samples: '${auth_c0}' '${auth_c1}' '${auth_c2}') — cannot measure per-operation authentication deltas; this is an instrument gap, NOT evidence about the product"
      return
    fi
  done

  local op1=$(( auth_c1 - auth_c0 )) op2=$(( auth_c2 - auth_c1 ))

  if [ "${sdk}" -ge 30 ] 2>/dev/null; then
    echo "[ceremony] ============================================================" >&2
    echo "[ceremony] OPERATOR ACTION (3rd signing operation, D-27 residual leg 2) on ${SERIAL}: create a SECOND network now (Select Network -> Create Network)." >&2
    echo "[ceremony] Waiting ${HW_NETWORK_WAIT}s before re-running the registration step automatically ..." >&2
    echo "[ceremony] ============================================================" >&2
    sleep "${HW_NETWORK_WAIT}"
    provision_register
    local auth_c3 op3
    auth_c3=$(fp_success_count)
    if ! echo "${auth_c3}" | grep -qE '^[0-9]+$'; then
      record_leg "hw-api34-per-use-semantics" "NOT-EXERCISED" "acceptCrypto counter unreadable after the 3rd operation (sample: '${auth_c3}') — instrument gap, not a product result"
      return
    fi
    op3=$(( auth_c3 - auth_c2 ))
    if [ "${op1}" -ge 1 ] && [ "${op2}" -ge 1 ] && [ "${op3}" -ge 1 ]; then
      record_leg "hw-api34-per-use-semantics" "PASS" "SDK=${sdk} (>=30, setUserAuthenticationParameters(0, AUTH_BIOMETRIC_STRONG) branch — Build.VERSION.SDK_INT>=30 guard is unconditional and source-guaranteed; KeyAttestationHelper.kt emits no runtime branch-name log line, so branch attribution here is via confirmed SDK level + source read, not a log line) — 3 consecutive signing ops each produced >=1 fresh crypto-backed OS auth event (dumpsys fingerprint acceptCrypto deltas: op1=${op1} provisioning, op2=${op2} 1st network recovery-key add, op3=${op3} 2nd network recovery-key add; acceptCrypto is a monotonic lifetime counter and is user- not app-scoped, treated as evidence not perfect isolation)"
    else
      record_leg "hw-api34-per-use-semantics" "FAIL" "SDK=${sdk} — acceptCrypto deltas op1=${op1} op2=${op2} op3=${op3}; one or more operations produced zero fresh authentications"
    fi
  else
    record_leg "hw-api34-per-use-semantics" "NOT-EXERCISED" "SDK=${sdk} (<30) — the setUserAuthenticationParameters branch does not exist on this device at all (KeyAttestationHelper.kt gates it behind 'if (Build.VERSION.SDK_INT >= 30)')"
    if [ "${op1}" -ge 1 ] && [ "${op2}" -ge 1 ]; then
      record_leg "hw-bare-auth-branch" "PASS" "SDK=${sdk} (<30) — the bare setUserAuthenticationRequired(true) fallback branch is source-guaranteed (no setUserAuthenticationParameters call below API 30); provisioning (acceptCrypto delta op1=${op1}) and per-use signing (op2=${op2}) both completed on it, closing D-17's pre-30 half on real hardware"
    else
      record_leg "hw-bare-auth-branch" "FAIL" "SDK=${sdk} — acceptCrypto deltas op1=${op1} op2=${op2}; provisioning or signing did not complete"
    fi
  fi
}

# ── Leg: recover (49-14 Task 4 — D-24 leg 3 / D-26a leg 5, real hardware only) ───────────────
# Deliberately does NOT reset_identity — its whole precondition is a device that already
# completed hw-provision AND has since had an ADDITIONAL biometric enrolled (49-14-PLAN.md Task
# 3, the invalidation trigger). Wiping identity here would destroy exactly the state this leg
# exists to observe. Settings' own 'Secure Signing' row always navigates with reason:'first-run'
# (SettingsScreen.tsx) which no-ops once both UserKey rows are already registered — it does NOT
# exercise the invalidated-key catch. A REAL per-use signing action (routed through
# createDeviceSigner at one of the 22 rollout call sites, 49-11/49-12) is what raises
# KeyPermanentlyInvalidatedException, so this leg asks the operator to trigger one.
recover() {
  if [ "${IS_EMULATOR}" -eq 1 ]; then
    echo "[ceremony] PREFLIGHT FAIL: 'recover' requires real hardware (this is 49-14 Task 4's leg)." >&2
    exit 1
  fi

  launch_app
  adb ${ADBD} logcat -c

  echo "[ceremony] ============================================================" >&2
  echo "[ceremony] OPERATOR ACTION on ${SERIAL}: trigger a REAL device-signing action now (e.g. invite an Administrator, edit your own Officer profile, or any other screen routed through createDeviceSigner — Settings > Secure Signing alone will NOT trigger this, it no-ops once both keys are already registered). This should raise KeyPermanentlyInvalidatedException and navigate you to the recovery screen." >&2
  echo "[ceremony] Waiting up to ${HW_NETWORK_WAIT}s for the recovery screen to appear ..." >&2
  echo "[ceremony] ============================================================" >&2

  local start_epoch dump found=0
  start_epoch=$(date +%s)
  while [ "$(( $(date +%s) - start_epoch ))" -lt "${HW_NETWORK_WAIT}" ]; do
    dump=$(dump_ui)
    if text_present "Replace" "${dump}" || text_present "recovery" "${dump}"; then
      found=1
      break
    fi
    sleep 5
  done

  local reject_line
  reject_line=$(adb ${ADBD} logcat -d 2>/dev/null | grep -i "KeyPermanentlyInvalidatedException\|KEY_INVALIDATED_REASSOCIATE" | head -3 || true)
  if [ -n "${reject_line}" ]; then
    record_leg "recover-invalidation-detected" "PASS" "logcat: $(echo "${reject_line}" | head -1)"
  else
    record_leg "recover-invalidation-detected" "FAIL" "no KeyPermanentlyInvalidatedException/KEY_INVALIDATED_REASSOCIATE line observed in this window"
  fi

  if [ "${found}" -eq 0 ]; then
    record_leg "recover-navigation" "FAIL" "recovery heading/button not observed within ${HW_NETWORK_WAIT}s — the 49-11/49-12 navigation contract did not fire, or the operator action did not reach a routed call site in time"
    return
  fi
  record_leg "recover-navigation" "PASS" "recovery screen reached (uiautomator dump: recovery heading or 'Replace' button present) — the 49-11/49-12 navigation contract fired at runtime"

  dump=$(dump_ui)
  if ! tap_on_text "Replace" "${dump}"; then
    record_leg "recover-replace-tap" "FAIL" "could not tap the recovery/replace button"
    return
  fi
  record_leg "recover-replace-tap" "PASS" "replace/recovery button tapped"

  adb ${ADBD} logcat -c
  satisfy_device_credential "recovery ceremony" || true

  dump=$(dump_ui)
  if text_present "${STR_SUCCESS_HEADING}" "${dump}"; then
    record_leg "recover-success-heading" "PASS" "signingKeyProvisioningSuccessHeading present post-recovery — a post-recovery signing action succeeded, and the replacement key was registered"
  else
    record_leg "recover-success-heading" "FAIL" "success heading not present post-recovery"
  fi

  local sdk branch_line
  sdk=$(adb ${ADBD} shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r')
  branch_line=$(adb ${ADBD} logcat -d 2>/dev/null | grep -i "signWithRecoveryKey\|createConfirmDeviceCredentialIntent" | tail -5 || true)
  if [ "${sdk}" -ge 30 ] 2>/dev/null; then
    record_leg "recover-branch" "PASS" "SDK=${sdk} (>=30) — BiometricPrompt/DEVICE_CREDENTIAL branch (signRecoveryViaBiometricPrompt), source-guaranteed by signWithRecoveryKey's SDK_INT>=30 dispatch; logcat: ${branch_line:-<none>}"
  else
    # D-26a RESCOPED 2026-08-21: recovery is unsupported below API 30. 49-19 deleted the
    # pre-49-19 sub-API-30 dispatch function from the native layer entirely (grep confirms zero
    # hits in packages/attestation-native/) — signWithRecoveryKey now rejects with
    # RECOVERY_UNSUPPORTED_OS before any ceremony, key handle, or UI. There is no branch left to
    # execute below API 30, so this leg is N/A rather than PASS — a PASS here would assert the
    # execution of a function that no longer exists.
    local removed_fn_evidence="signRecoveryViaKeyguardManager no longer exists (removed by 49-19)"
    record_leg "recover-branch" "N/A" "SDK=${sdk} (<30) — recovery is unsupported below API 30 by decision (2026-08-21, D-26a RESCOPED); ${removed_fn_evidence}; signWithRecoveryKey rejects RECOVERY_UNSUPPORTED_OS before any ceremony"
  fi
}

# ── Dispatch ──────────────────────────────────────────────────────────────
preflight

case "${LEG}" in
  provision-local)    provision_local ;;
  provision-register) provision_register ;;
  sign)                leg_sign ;;
  cancel)              leg_cancel ;;
  storage)             leg_storage ;;
  hw-provision)         hw_provision ;;
  recover)              recover ;;
  all)
    provision_local
    leg_sign
    leg_cancel
    leg_storage
    record_leg "provision-register-not-exercised" "NOT-EXERCISED" "requires an operator-created network first — run 'provision-register' directly once one exists"
    ;;
esac

echo "[ceremony] ========== Summary =========="
for r in "${RESULTS[@]}"; do
  IFS='|' read -r name verdict evidence <<< "${r}"
  echo "LEG ${name}: ${verdict}"
done

if any_failed; then
  exit 1
fi
exit 0
