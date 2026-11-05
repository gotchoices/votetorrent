#!/usr/bin/env bash
#
# run-sealed-payload-proof.sh
#
# Purpose : Phase 52 D-05 on-device [seal-kat] sealed-payload gate. Proves that
#           `@noble/ciphers` resolves through Metro, evaluates under Hermes on a
#           REAL Android device, and computes AES-256-GCM bytes that a second,
#           independent implementation (`node:crypto`, on this host) accepts.
#
#           This is the cheap-failure gate: it runs immediately after the first
#           plan that puts a genuine `@noble/ciphers` import into the Authority
#           bundle, BEFORE any service work is sunk against D-05.
#
#           "The app didn't crash" is not the assertion. The assertion is that
#           the wrapper the DEVICE sealed decrypts on the HOST to the pinned
#           plaintext — see step 8 and scripts/lib/seal-kat-verify.mjs.
#
# Usage   : SERIAL=43a209ff0806 METRO_PORT=8083 ./scripts/run-sealed-payload-proof.sh
#
#           SERIAL     REQUIRED. No default: a default would silently target an
#                      emulator, and D-28 makes real hardware the gate.
#           METRO_PORT Optional, default 8081. Metro must ALREADY be running,
#                      started from THIS checkout, on this port. This script does
#                      not start it — a bundler started by the harness could be
#                      serving a different tree without anyone noticing.
#                        yarn workspace votetorrent-authority start \
#                          --port ${METRO_PORT} --reset-cache
#
# Prereqs : adb and curl on PATH; a real, unlocked Android device attached with a
#           DEBUGGABLE build of org.votetorrent.authority installed; Metro
#           reachable on 127.0.0.1:${METRO_PORT}.
#
# Exit    : 0 — SEALED PAYLOAD VERDICT: PASS on device AND the host cross-decrypt
#               of the device's own ciphertext succeeded
#           1 — any step failed. The failing step is named, and — for the
#               provenance and packaging steps — the diagnosis is spelled out
#               rather than left to the reader.
#
# ---------------------------------------------------------------------------
# What this script is defending against, in order
# ---------------------------------------------------------------------------
#
#   1. An EMULATOR standing in for hardware. This project has repeated evidence
#      that emulator results do not transfer (biometrics, StrongBox, P2P).
#   2. A RELEASE build. A release APK ignores Metro entirely, so every JS result
#      would be about a bundle baked in at build time, not the tree under test.
#   3. A STALE packages/vote-engine/dist/. The app bundles dist/, not src/, and
#      dist/ is gitignored so a stale build never shows up in `git status`.
#      `--reset-cache` does NOT help: the stale input is a file on disk, not
#      Metro's transform cache. On 2026-08-04 this exact hole produced a
#      FULL-CHAIN VERDICT: PASS that was completely vacuous.
#   4. A STRAY METRO from another checkout. The app fetches JS from a dev-server
#      host setting that, when set to 10.0.2.2, BYPASSES `adb reverse` — so a
#      leftover bundler from an unrelated tree silently serves the wrong bundle.
#      That trap has already cost this project three harness runs. Step 6 fails
#      on it explicitly rather than hoping.
#   5. MULTIPLE COPIES of the cipher in one bundle. Six copies of @noble/curves
#      once bound the wrong instance and made `secp256k1.sign` fatal on Hermes
#      while the bundle was statically correct and Node worked fine. Step 5
#      counts the copies instead of assuming there is one.
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
. scripts/lib/logcat-wait.sh

PACKAGE="org.votetorrent.authority"
METRO_PORT="${METRO_PORT:-8081}"
FLAG_FILE="apps/VoteTorrentAuthority/src/engines/proof-flags.generated.ts"
DIST_SEALED="packages/vote-engine/dist/bootstrap/sealed-payload.js"
VERIFIER="scripts/lib/seal-kat-verify.mjs"

# Multi-arg console.log renders args quoted/comma-separated in RN logcat, so the
# patterns tolerate tokens between the tag and the message. The proof emits its
# verdict as ONE string argument so it can be quoted verbatim into the evidence
# file, but the marker patterns stay tolerant anyway.
START_MARKER='seal-kat.*sealed payload proof: starting'
VERDICT_PATTERN='seal-kat.*SEALED PAYLOAD VERDICT'
MARKER_TIMEOUT=150
VERDICT_TIMEOUT=120

# Served-bundle provenance markers (52-07 <locked_construction>).
MARKER_A='bootstrap-content'          # the D-04 label — the sealing module is in the bundle
MARKER_B='sealed-payload-kat-v1'      # this plan's proof module is in the bundle
MARKER_C='aes/gcm: invalid ghash tag' # @noble/ciphers/aes.js — its COUNT is the copy count

if [ -z "${SERIAL:-}" ]; then
  echo "[seal-kat-run] ERROR: SERIAL is required and has no default." >&2
  echo "[seal-kat-run]   List attached devices with: adb devices -l" >&2
  echo "[seal-kat-run]   Then: SERIAL=<serial> METRO_PORT=<port> ./scripts/run-sealed-payload-proof.sh" >&2
  exit 1
fi
ADBD="-s ${SERIAL}"

fail() {
  echo "[seal-kat-run] ========== SEALED PAYLOAD VERDICT: FAIL ($1) ==========" >&2
  exit 1
}

# ── STEP 1: refuse an emulator (D-28) ────────────────────────────────────────
echo "[seal-kat-run] STEP 1: device identity"
QEMU="$(adb ${ADBD} shell getprop ro.kernel.qemu 2>/dev/null | tr -d '\r\n' || true)"
CHARS="$(adb ${ADBD} shell getprop ro.build.characteristics 2>/dev/null | tr -d '\r\n' || true)"
MODEL="$(adb ${ADBD} shell getprop ro.product.model 2>/dev/null | tr -d '\r\n' || true)"
RELEASE="$(adb ${ADBD} shell getprop ro.build.version.release 2>/dev/null | tr -d '\r\n' || true)"
SDK="$(adb ${ADBD} shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r\n' || true)"
ABI="$(adb ${ADBD} shell getprop ro.product.cpu.abi 2>/dev/null | tr -d '\r\n' || true)"
echo "[seal-kat-run]   serial=${SERIAL} model=${MODEL} android=${RELEASE} api=${SDK} abi=${ABI}"
echo "[seal-kat-run]   ro.kernel.qemu='${QEMU}' ro.build.characteristics='${CHARS}'"
if [ -n "${QEMU}" ] || echo "${CHARS}" | grep -qi 'emulator'; then
  echo "[seal-kat-run] ERROR: ${SERIAL} is an EMULATOR. D-28 makes real hardware the gate —" >&2
  echo "[seal-kat-run]        emulator + headless Chrome is explicitly not sufficient, and this" >&2
  echo "[seal-kat-run]        project has repeated evidence that emulator results do not transfer." >&2
  fail "step 1 — emulator refused"
fi

# ── STEP 2: refuse a non-debuggable build ────────────────────────────────────
echo "[seal-kat-run] STEP 2: debuggable-build check"
if ! adb ${ADBD} shell run-as "${PACKAGE}" id >/dev/null 2>&1; then
  echo "[seal-kat-run] ERROR: run-as ${PACKAGE} failed — the installed build is not debuggable." >&2
  echo "[seal-kat-run]        A release APK ignores Metro entirely, so every JS result would be" >&2
  echo "[seal-kat-run]        about a baked-in bundle, not this tree. Install a debug build:" >&2
  echo "[seal-kat-run]          yarn workspace votetorrent-authority build:debug" >&2
  echo "[seal-kat-run]          (or apps/VoteTorrentAuthority/android/gradlew installDebug)" >&2
  fail "step 2 — non-debuggable build"
fi
echo "[seal-kat-run]   run-as OK — build is debuggable"

# ── STEP 3: dist-freshness guard, BEFORE any flag write ──────────────────────
# Deliberately ordered ahead of step 4: this is the last point where aborting is
# still free, i.e. before the tree has been mutated at all.
echo "[seal-kat-run] STEP 3: dist-freshness guard (before any flag write)"
yarn --cwd packages/vote-engine build >/dev/null || fail "step 3 — vote-engine build failed"
if [ ! -f "${DIST_SEALED}" ]; then
  echo "[seal-kat-run] ERROR: ${DIST_SEALED} does not exist after a build." >&2
  echo "[seal-kat-run]        The app bundles dist/, not src/ — without this file the device" >&2
  echo "[seal-kat-run]        would run a bundle with no sealing module and the gate would be vacuous." >&2
  fail "step 3 — built sealing module missing"
fi
DIST_LABEL_HITS="$(grep -c -F "${MARKER_A}" "${DIST_SEALED}" || true)"
echo "[seal-kat-run]   ${DIST_SEALED}: '${MARKER_A}' x${DIST_LABEL_HITS}"
if [ "${DIST_LABEL_HITS}" -lt 1 ]; then
  echo "[seal-kat-run] ERROR: the built sealing module does not contain the '${MARKER_A}' label —" >&2
  echo "[seal-kat-run]        dist/ is stale or was built from a different source. Note that" >&2
  echo "[seal-kat-run]        --reset-cache does NOT fix this: the stale input is a file on disk." >&2
  fail "step 3 — stale dist"
fi
scripts/check-dist-freshness.sh || fail "step 3 — check-dist-freshness.sh reported a stale build"

# ── STEP 4: flag override (EXIT trap installed FIRST) ────────────────────────
echo "[seal-kat-run] STEP 4: Writing proof-flags.generated.ts (SEALED_PAYLOAD_PROOF_ENABLED=true)"
restore_flags() {
  if git checkout -- "${FLAG_FILE}" 2>/dev/null; then
    echo "[seal-kat-run] flags restored to committed default-false"
  else
    echo "[seal-kat-run] WARNING: git checkout restore failed — restore ${FLAG_FILE} manually" >&2
  fi
}
trap restore_flags EXIT
cat > "${FLAG_FILE}" << 'EOF'
// run-sealed-payload-proof.sh generated override — do not commit (EXIT trap restores default).
// Static import only — dynamic require() breaks Metro (Phase 16-07 lesson).
export const PROOF_ENABLED = false;
export const DIAL_PROBE_ENABLED = false;
export const REPLICATION_PROOF_ENABLED = false;
export const USE_LOCAL_DB_FACTORY = false;
export const SIGNING_PROOF_ENABLED = false;
export const STRAND_PERSISTENCE_PROOF_ENABLED = false;
export const USE_STUB_ATTESTATION_VERIFIER = false;
export const REGISTRANT_SEED_ENABLED = false;
export const RECOVERY_BRANCH_PROOF_ENABLED = false;
export const SEALED_PAYLOAD_PROOF_ENABLED = true;
EOF
echo "[seal-kat-run]   SEALED_PAYLOAD_PROOF_ENABLED=true"

# ── STEP 5: served-bundle provenance (host side) ─────────────────────────────
# The device dials its own default 8081; the reverse tunnel maps that to the
# Metro this script expects. Then assert on what that Metro ACTUALLY serves —
# not on what the source tree says, which is the whole point.
echo "[seal-kat-run] STEP 5: served-bundle provenance (Metro on 127.0.0.1:${METRO_PORT})"
adb ${ADBD} reverse tcp:8081 "tcp:${METRO_PORT}" >/dev/null || true
echo "[seal-kat-run]   adb reverse tcp:8081 -> tcp:${METRO_PORT}"

BUNDLE_FILE="$(mktemp -t seal-kat-bundle)"
cleanup_bundle() { rm -f "${BUNDLE_FILE}"; }
trap 'cleanup_bundle; restore_flags' EXIT

BUNDLE_URL="http://127.0.0.1:${METRO_PORT}/index.bundle?platform=android&dev=true&minify=false"
if ! curl -sf "${BUNDLE_URL}" -o "${BUNDLE_FILE}"; then
  echo "[seal-kat-run] ERROR: no Metro reachable at ${BUNDLE_URL}" >&2
  echo "[seal-kat-run]        Start one FROM THIS CHECKOUT (this script deliberately does not," >&2
  echo "[seal-kat-run]        so the bundler's provenance is yours, not the harness's):" >&2
  echo "[seal-kat-run]          yarn workspace votetorrent-authority start --port ${METRO_PORT} --reset-cache" >&2
  fail "step 5 — Metro unreachable"
fi

BUNDLE_BYTES="$(wc -c < "${BUNDLE_FILE}" | tr -d ' ')"
BUNDLE_SHA="$( (shasum -a 256 "${BUNDLE_FILE}" 2>/dev/null || sha256sum "${BUNDLE_FILE}") | awk '{print $1}')"
echo "[seal-kat-run]   served bundle: ${BUNDLE_BYTES} bytes  sha256=${BUNDLE_SHA}"

# Occurrence counts, not line counts: `grep -c` counts matching LINES, which
# would under-report two copies that happened to land on one line.
count_occurrences() { grep -o -F "$1" "${BUNDLE_FILE}" | wc -l | tr -d ' '; }
A_COUNT="$(count_occurrences "${MARKER_A}" || true)"
B_COUNT="$(count_occurrences "${MARKER_B}" || true)"
C_COUNT="$(count_occurrences "${MARKER_C}" || true)"
echo "[seal-kat-run]   marker A '${MARKER_A}'          x${A_COUNT}  (expect >= 1)"
echo "[seal-kat-run]   marker B '${MARKER_B}'      x${B_COUNT}  (expect >= 1)"
echo "[seal-kat-run]   marker C '${MARKER_C}' x${C_COUNT}  (expect EXACTLY 1)"

if [ "${A_COUNT}" -lt 1 ]; then
  echo "[seal-kat-run] ERROR: the served bundle has no '${MARKER_A}' — the sealing module is NOT in" >&2
  echo "[seal-kat-run]        the bundle the device will run. Either Metro is serving another tree" >&2
  echo "[seal-kat-run]        or dist/ was not rebuilt into it." >&2
  fail "step 5 — marker A absent"
fi
if [ "${B_COUNT}" -lt 1 ]; then
  echo "[seal-kat-run] ERROR: the served bundle has no '${MARKER_B}' — THIS plan's proof module is" >&2
  echo "[seal-kat-run]        not in the served bundle. A stale Metro is serving a pre-52-07 tree." >&2
  fail "step 5 — marker B absent"
fi
if [ "${C_COUNT}" -lt 1 ]; then
  echo "[seal-kat-run] ERROR: the served bundle has no '${MARKER_C}' — @noble/ciphers/aes.js is not" >&2
  echo "[seal-kat-run]        in the bundle at all. This is a RESOLUTION failure (packaging), not a" >&2
  echo "[seal-kat-run]        Hermes failure. D-05 stays closed; fix the packaging and re-run." >&2
  fail "step 5 — marker C absent (resolution failure)"
fi
if [ "${C_COUNT}" -ne 1 ]; then
  echo "[seal-kat-run] ERROR: @noble/ciphers/aes.js appears ${C_COUNT} times in the served bundle." >&2
  echo "[seal-kat-run]        This is the MULTI-COPY METRO-BINDING failure class: six copies of" >&2
  echo "[seal-kat-run]        @noble/curves once bound the wrong instance and made secp256k1.sign" >&2
  echo "[seal-kat-run]        fatal on Hermes while the bundle was statically correct and Node" >&2
  echo "[seal-kat-run]        worked. It is PACKAGING, not Hermes — D-05 stays closed." >&2
  echo "[seal-kat-run]        Remedy: confirm the root 'resolutions' pin for @noble/ciphers took," >&2
  echo "[seal-kat-run]        dedupe the workspace copies, then re-run this gate." >&2
  fail "step 5 — ${C_COUNT} copies of @noble/ciphers/aes.js"
fi

# Marker D: the flag's VALUE as it actually reached the bundle. A bundle that
# resolved the flag to `false` would boot cleanly, log nothing, and time out at
# step 7 with a misleading "Metro rebundle in flight" message.
echo "[seal-kat-run]   marker D — SEALED_PAYLOAD_PROOF_ENABLED occurrences in the served bundle:"
FLAG_OCCURRENCES="$(grep -o 'SEALED_PAYLOAD_PROOF_ENABLED[^,;]*' "${BUNDLE_FILE}" | sort -u || true)"
if [ -z "${FLAG_OCCURRENCES}" ]; then
  echo "[seal-kat-run] ERROR: SEALED_PAYLOAD_PROOF_ENABLED does not appear in the served bundle." >&2
  fail "step 5 — marker D absent"
fi
printf '%s\n' "${FLAG_OCCURRENCES}" | sed 's/^/[seal-kat-run]     /'
if printf '%s\n' "${FLAG_OCCURRENCES}" | grep -qE '=[[:space:]]*false'; then
  echo "[seal-kat-run] ERROR: an occurrence of SEALED_PAYLOAD_PROOF_ENABLED assigns false in the" >&2
  echo "[seal-kat-run]        SERVED bundle. Metro is serving a pre-override bundle (its transform" >&2
  echo "[seal-kat-run]        cache has not picked up the step-4 write yet) or it is serving a" >&2
  echo "[seal-kat-run]        DIFFERENT checkout. Restart Metro with --reset-cache from this tree." >&2
  fail "step 5 — flag resolves false in the served bundle"
fi

# ── STEP 6: rule out the dev-server-host bypass ──────────────────────────────
# The RN dev menu's "Debug server host & port" is persisted in shared_prefs. When
# it is set (classically to 10.0.2.2:8081, the emulator's host alias), the app
# fetches JS from THAT host and `adb reverse` is bypassed entirely — so a stray
# Metro from another checkout silently serves the wrong tree's bundle while every
# check above passes. This trap has already cost this project three harness runs.
echo "[seal-kat-run] STEP 6: dev-server-host bypass check"
# The glob MUST be expanded by the inner `sh -c`, which runs as the app's uid.
# Written as `run-as PKG cat .../*.xml` the outer (uid shell) device shell tries to
# expand it first, cannot read /data/data/PKG, passes the literal `*.xml` through,
# and `cat` fails — so the check would report "no debug_http_host" on EVERY device.
# A silently-vacuous version of this particular check is worse than no check: it is
# the one guarding the trap that has already cost three harness runs.
PREFS_LIST="$(adb ${ADBD} shell "run-as ${PACKAGE} ls /data/data/${PACKAGE}/shared_prefs" 2>/dev/null | tr -d '\r' || true)"
if [ -z "${PREFS_LIST}" ] || echo "${PREFS_LIST}" | grep -qi 'no such file'; then
  echo "[seal-kat-run]   no shared_prefs present — the app has never persisted a dev-server host"
  PREFS=""
else
  echo "[seal-kat-run]   shared_prefs: $(echo "${PREFS_LIST}" | tr '\n' ' ')"
  PREFS="$(adb ${ADBD} shell "run-as ${PACKAGE} sh -c 'cat /data/data/${PACKAGE}/shared_prefs/*.xml'" 2>/dev/null | tr -d '\r' || true)"
  if [ -z "${PREFS}" ]; then
    echo "[seal-kat-run] ERROR: shared_prefs files exist but could not be read, so the bypass" >&2
    echo "[seal-kat-run]        cannot be ruled out. Refusing to continue on an unverifiable" >&2
    echo "[seal-kat-run]        provenance chain — a vacuous pass here is the worst outcome." >&2
    fail "step 6 — shared_prefs unreadable"
  fi
fi
HTTP_HOST="$(printf '%s\n' "${PREFS}" | grep -i 'debug_http_host' | sed -e 's/.*>\(.*\)<.*/\1/' || true)"
if [ -n "${HTTP_HOST}" ]; then
  echo "[seal-kat-run] ERROR: the app has a debug_http_host set: '${HTTP_HOST}'" >&2
  echo "[seal-kat-run]        The app will fetch its JS bundle from THAT host, which bypasses" >&2
  echo "[seal-kat-run]        'adb reverse' entirely (10.0.2.2 is the classic value). Everything" >&2
  echo "[seal-kat-run]        this script verified about the SERVED bundle would then be about a" >&2
  echo "[seal-kat-run]        bundler the device never talks to." >&2
  echo "[seal-kat-run]        Remedy 1 (preferred): clear it from the RN dev menu ->" >&2
  echo "[seal-kat-run]          'Settings' / 'Debug server host & port for device' -> blank." >&2
  echo "[seal-kat-run]        Remedy 2: adb ${ADBD} shell pm clear ${PACKAGE}" >&2
  echo "[seal-kat-run]          COST: pm clear WIPES APP DATA, including the provisioned network." >&2
  echo "[seal-kat-run]          Leg C's real mint needs that network, so you would have to" >&2
  echo "[seal-kat-run]          re-provision before running it." >&2
  fail "step 6 — debug_http_host bypass active"
fi
echo "[seal-kat-run]   no debug_http_host set — the device will use adb reverse"

# ── STEP 7: boot and wait for the verdict ────────────────────────────────────
echo "[seal-kat-run] STEP 7: force-stop + clear logcat + relaunch"
adb ${ADBD} shell am force-stop "${PACKAGE}"
sleep 2
adb ${ADBD} logcat -c
adb ${ADBD} shell monkey -p "${PACKAGE}" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1

START_LINE="$(wait_for_logcat_line "${START_MARKER}" "${MARKER_TIMEOUT}" "[seal-kat-run]" "start" "${ADBD}")"
if [ -z "${START_LINE}" ]; then
  echo "[seal-kat-run] ERROR: no [seal-kat] starting marker within ${MARKER_TIMEOUT}s — Metro rebundle in flight or flags-disabled bundle served; re-run" >&2
  fail "step 7 — no start marker"
fi
echo "[seal-kat-run]   start: ${START_LINE}"

VERDICT_LINE="$(wait_for_logcat_line "${VERDICT_PATTERN}" "${VERDICT_TIMEOUT}" "[seal-kat-run]" "verdict" "${ADBD}")"
if [ -z "${VERDICT_LINE}" ]; then
  echo "[seal-kat-run] ERROR: no SEALED PAYLOAD VERDICT within ${VERDICT_TIMEOUT}s" >&2
  fail "step 7 — no verdict"
fi
echo "[seal-kat-run]   verdict: ${VERDICT_LINE}"

echo "[seal-kat-run]   leg lines:"
adb ${ADBD} logcat -d | grep -F '[seal-kat] leg ' | sed 's/^/[seal-kat-run]     /' || true

if echo "${VERDICT_LINE}" | grep -q 'FAIL'; then
  echo "[seal-kat-run] ERROR: the device verdict reported FAIL. Classify before escalating —" >&2
  echo "[seal-kat-run]        only a KAT BYTE MISMATCH reopens D-05. Resolution failures and" >&2
  echo "[seal-kat-run]        module-evaluation failures are packaging/bundling defects." >&2
  fail "step 7 — device verdict FAIL"
fi

# ── STEP 8: host cross-decrypt of the DEVICE's ciphertext ────────────────────
# The decisive assertion. Bytes AES-GCM-encrypted by @noble/ciphers under Hermes
# on the device, decrypted by node:crypto here.
echo "[seal-kat-run] STEP 8: host cross-decrypt (${VERIFIER})"
LOGCAT_DUMP="$(adb ${ADBD} logcat -d)"
DEVICE_LOOKUP_ID="$(printf '%s\n' "${LOGCAT_DUMP}" | grep -o 'lookupId=[A-Za-z0-9_-]*' | tail -1 | cut -d= -f2 || true)"
DEVICE_WRAPPER="$(printf '%s\n' "${LOGCAT_DUMP}" | grep -o 'wrapper={.*}' | tail -1 | cut -d= -f2- || true)"

if [ -z "${DEVICE_LOOKUP_ID}" ]; then
  echo "[seal-kat-run] ERROR: no '[seal-kat] lookupId=' line in logcat — the derive leg never ran." >&2
  fail "step 8 — no lookupId emitted"
fi
if [ -z "${DEVICE_WRAPPER}" ]; then
  echo "[seal-kat-run] ERROR: no '[seal-kat] wrapper=' line in logcat — the SEAL LEG NEVER RAN." >&2
  echo "[seal-kat-run]        An absent wrapper must never read as PASS: the host cross-decrypt is" >&2
  echo "[seal-kat-run]        the only assertion that measures RN-to-host byte parity, and without" >&2
  echo "[seal-kat-run]        a wrapper there is nothing to measure." >&2
  fail "step 8 — no wrapper emitted"
fi
echo "[seal-kat-run]   device lookupId=${DEVICE_LOOKUP_ID}"
echo "[seal-kat-run]   device wrapper=${DEVICE_WRAPPER}"

node "${VERIFIER}" --wrapper "${DEVICE_WRAPPER}" --lookup-id "${DEVICE_LOOKUP_ID}" \
  || fail "step 8 — host cross-decrypt REJECTED the device's ciphertext (KAT BYTE MISMATCH — this is the only classification that reopens D-05)"

# ── STEP 9: no packaging errors, no FATAL ────────────────────────────────────
echo "[seal-kat-run] STEP 9: logcat cleanliness"
UNKNOWN_MODULE="$(printf '%s\n' "${LOGCAT_DUMP}" | grep -c 'Requiring unknown module' || true)"
SEAL_FATAL="$(printf '%s\n' "${LOGCAT_DUMP}" | grep -c '\[seal-kat\] FATAL' || true)"
echo "[seal-kat-run]   'Requiring unknown module' x${UNKNOWN_MODULE} (expect 0)"
echo "[seal-kat-run]   '[seal-kat] FATAL'         x${SEAL_FATAL} (expect 0)"
if [ "${UNKNOWN_MODULE}" -ne 0 ]; then
  fail "step 9 — 'Requiring unknown module' in logcat (module-resolution failure: packaging, not Hermes)"
fi
if [ "${SEAL_FATAL}" -ne 0 ]; then
  fail "step 9 — [seal-kat] FATAL in logcat"
fi

# ── STEP 10: verdict ─────────────────────────────────────────────────────────
echo "[seal-kat-run] evidence summary (transcribe into 52-07-HERMES-GATE.md):"
echo "[seal-kat-run]   device        : ${MODEL} ${SERIAL} / Android ${RELEASE} / API ${SDK} / ${ABI}"
echo "[seal-kat-run]   metro port    : ${METRO_PORT} (adb reverse tcp:8081 -> tcp:${METRO_PORT})"
echo "[seal-kat-run]   bundle        : ${BUNDLE_BYTES} bytes sha256=${BUNDLE_SHA}"
echo "[seal-kat-run]   markers       : A=${A_COUNT} B=${B_COUNT} C=${C_COUNT} (C must be exactly 1)"
echo "[seal-kat-run]   device verdict: ${VERDICT_LINE}"
echo "[seal-kat-run] ========== SEALED PAYLOAD VERDICT: PASS (device + host cross-decrypt) =========="
exit 0
