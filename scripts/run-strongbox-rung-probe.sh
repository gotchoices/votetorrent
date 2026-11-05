#!/usr/bin/env bash
#
# run-strongbox-rung-probe.sh
#
# Purpose  : D-07 StrongBox rung probe — a MEASUREMENT, not an assertion. Runs
#            StrongBoxRungProbeTest on attached hardware and retrieves its JSON report,
#            so the rung question is settled by what the silicon does rather than by a
#            belief transcribed into a comment.
#
#            Five cases, varying only setIsStrongBoxBacked and the challenge form:
#              A strongbox/absent  B strongbox/empty  C strongbox/real
#              D tee/empty         E tee/real
#
# Usage    : ./scripts/run-strongbox-rung-probe.sh [-s SERIAL]
#
# Prerequisites:
#   - adb in PATH; exactly one device attached (or pass -s SERIAL)
#   - The device MUST have a secure lock screen and an enrolled STRONG biometric:
#     every case builds a key with setUserAuthenticationRequired(true) +
#     AUTH_BIOMETRIC_STRONG, so with nothing enrolled ALL cases fail for a reason
#     that has nothing to do with the rung. Check before believing a result:
#       adb shell locksettings get-disabled     # must print false
#       adb shell dumpsys fingerprint | head -3 # "count" must be >= 1
#   - A StrongBox-capable device for cases A-C to mean anything:
#       adb shell pm list features | grep strongbox_keystore
#     Absent → A/B/C all report STRONGBOX_UNAVAILABLE, which is a valid measurement
#     of THAT device and NOT evidence about StrongBox behaviour.
#
# Outputs (under .probe-out/, git-ignored):
#   strongbox-rung-probe.json  full report incl. base64 cert chains per case
#   chain-<CASE>.json          per-case chain, shaped for
#                              packages/vote-engine/scripts/decode-attestation-leaf.mjs
#   probe-logcat.txt           logcat for the run window — the ONLY place KeyMint's
#                              real reason appears (keystore2 truncates into the
#                              exception message; the HAL line does not)
#
# Exit codes:
#   0  — probe ran and the report was retrieved (regardless of per-case outcomes)
#   1  — probe could not run, or the report could not be retrieved
#
# WHY THIS DOES NOT USE `gradlew connectedDebugAndroidTest`:
#   AGP UNINSTALLS both APKs when that task finishes, taking the app's filesDir —
#   and therefore the report — with it. The report survives logcat's per-line
#   truncation but the cert chains do not, so the file is the point. This script
#   installs both APKs and drives `am instrument` itself, leaving them installed.
#

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

PACKAGE="org.votetorrent.authority"
TEST_PACKAGE="${PACKAGE}.test"
TEST_CLASS="${PACKAGE}.StrongBoxRungProbeTest"
RUNNER="androidx.test.runner.AndroidJUnitRunner"
ANDROID_DIR="apps/VoteTorrentAuthority/android"
APK_APP="${ANDROID_DIR}/app/build/outputs/apk/debug/app-debug.apk"
APK_TEST="${ANDROID_DIR}/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
OUT_DIR=".probe-out"

SERIAL=""
while getopts "s:" opt; do
	case "$opt" in
		s) SERIAL="$OPTARG" ;;
		*) echo "usage: $0 [-s SERIAL]" >&2; exit 1 ;;
	esac
done

if [[ -z "$SERIAL" ]]; then
	# Plain word-splitting rather than `mapfile`: macOS ships bash 3.2, where
	# mapfile does not exist and the array would silently come back empty.
	DEVICES=$(adb devices | awk '$2 == "device" { print $1 }')
	DEVICE_COUNT=$(printf '%s\n' "$DEVICES" | grep -c '[^[:space:]]' || true)
	if [[ "$DEVICE_COUNT" -ne 1 ]]; then
		echo "FAIL: expected exactly 1 attached device, found ${DEVICE_COUNT}. Pass -s SERIAL." >&2
		adb devices -l >&2
		exit 1
	fi
	SERIAL="$DEVICES"
fi

ADB=(adb -s "$SERIAL")

echo "== device =="
"${ADB[@]}" shell 'getprop ro.product.model; getprop ro.build.version.sdk'
# Recorded, never gated on: an absent feature makes A/B/C's STRONGBOX_UNAVAILABLE the
# correct answer for this device rather than a probe failure.
"${ADB[@]}" shell 'pm list features | grep -i strongbox_keystore || echo "feature:strongbox_keystore ABSENT"'

echo "== building probe APKs =="
# assembleDebugAndroidTest, not connectedDebugAndroidTest — see the header note on
# AGP's post-run uninstall.
(cd "$ANDROID_DIR" && ./gradlew :app:assembleDebug :app:assembleDebugAndroidTest --console=plain -q)

for apk in "$APK_APP" "$APK_TEST"; do
	[[ -f "$apk" ]] || { echo "FAIL: missing $apk after build" >&2; exit 1; }
done

echo "== installing =="
"${ADB[@]}" install -r -g "$APK_APP" >/dev/null
"${ADB[@]}" install -r "$APK_TEST" >/dev/null

mkdir -p "$OUT_DIR"
LOGCAT_FILE="${OUT_DIR}/probe-logcat.txt"
"${ADB[@]}" logcat -c
"${ADB[@]}" logcat -v time > "$LOGCAT_FILE" 2>&1 &
LOGCAT_PID=$!
# Detach from job control so killing the capture below does not spray a "Terminated: 15"
# line into the middle of the results. The PID stays valid for both kills.
disown "$LOGCAT_PID" 2>/dev/null || true
# Kill the capture on ANY exit path, or a failed run leaves an orphan adb holding the file.
trap 'kill "$LOGCAT_PID" 2>/dev/null || true' EXIT

echo "== running probe =="
"${ADB[@]}" shell am instrument -w -e class "$TEST_CLASS" "${TEST_PACKAGE}/${RUNNER}"

sleep 1
kill "$LOGCAT_PID" 2>/dev/null || true

REPORT="${OUT_DIR}/strongbox-rung-probe.json"
# run-as, not `adb pull`: the report lives in the app's internal filesDir, which is
# unreadable to the shell user (and getExternalFilesDir is hidden by scoped storage).
if ! "${ADB[@]}" shell run-as "$PACKAGE" cat files/strongbox-rung-probe.json > "$REPORT" 2>"${OUT_DIR}/pull-err.txt"; then
	echo "FAIL: could not retrieve the report:" >&2
	cat "${OUT_DIR}/pull-err.txt" >&2
	exit 1
fi
[[ -s "$REPORT" ]] || { echo "FAIL: retrieved report is empty" >&2; exit 1; }

# Split the chains out for decode-attestation-leaf.mjs, which takes a bare JSON array
# of base64 certs.
python3 - "$REPORT" "$OUT_DIR" <<'PY'
import json, sys
report, out_dir = sys.argv[1], sys.argv[2]
data = json.load(open(report))
print("== device (as measured) ==")
print(json.dumps(data["device"], indent=2))
print("== cases ==")
for c in data["cases"]:
    line = f'{c["case"]:<32} {c["outcome"]}'
    if c["outcome"] == "OK":
        line += f'  chainLength={c["chainLength"]}'
        key = c["case"].split("_")[0]
        with open(f'{out_dir}/chain-{key}.json', "w") as fh:
            json.dump(c["chainBase64"], fh)
    else:
        line += f'  {c.get("exceptionClass","")}'
    print(line)
PY

cat <<EOF

== next ==
Report      : $REPORT
Logcat      : $LOGCAT_FILE
  KeyMint's real reason for any non-OK case appears ONLY here:
    grep -aE 'keymint-service|keystore2|ATTESTATION_CHALLENGE' $LOGCAT_FILE

Decode any OK case's chain (rung + challenge binding):
  cd packages/vote-engine/scripts
  node decode-attestation-leaf.mjs ../../../$OUT_DIR/chain-C.json /tmp/decode.md \\
    'signing-key-provisioning-probe-0123456789abcdef'
  # Cases A/D use a non-real challenge, so a FAIL verdict there is EXPECTED and is
  # not a rung result — read the reported securityLevel, not the exit code.
EOF
