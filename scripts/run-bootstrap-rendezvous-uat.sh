#!/usr/bin/env bash
#
# run-bootstrap-rendezvous-uat.sh
#
# Purpose : The rig for the bootstrap rendezvous hardware UAT. It automates
#           everything about that run EXCEPT the four things a human must do:
#           attach and unlock a real phone, type the confirm-gate phrase on the
#           device, present a fingerprint, and paste a code into a real desktop
#           browser. It deliberately does NOT start the service — the instance
#           under test is the one the operator document produced, because a
#           hand-assembled instance would prove the code and not the document.
#
# Usage   : SERIAL=<serial> SERVICE_PORT=<port> METRO_PORT=<port> \
#             ./scripts/run-bootstrap-rendezvous-uat.sh <subcommand>
#
#           Subcommands, in the order a run uses them:
#             preflight      host + device + build-freshness gates
#             serve          apply both adb reverses, read them back, assert the
#                            operator-document instance is answering
#             arm            write the dev upload target, then HOLD it (blocking)
#                            with a restore trap armed; Ctrl-C or Enter disarms
#             provenance     prove the JS the device runs came from this tree
#             probe-staged   pull RKStorage, report the staged record + acceptCrypto
#             inject-legacy  land a synthesized pre-fix record and read it back
#             assert-clean   pull RKStorage and gate on the cleanup having run
#             teardown       remove this rig's reverse mappings, restore the tree
#
#           SERIAL       REQUIRED, no default. A default would silently target
#                        whatever is attached, and real hardware is the gate.
#           SERVICE_PORT REQUIRED, no default. Must be free before the operator
#                        document's instance binds it, and must differ from
#                        METRO_PORT. A default would squat a port another live
#                        session owns.
#           METRO_PORT   REQUIRED, no default. Metro must ALREADY be running,
#                        started by hand from THIS checkout. This script never
#                        starts it: a bundler the harness started could be
#                        serving a different tree without anyone noticing.
#           BOOTSTRAP_RENDEZVOUS_UPLOAD_TOKEN
#                        REQUIRED by `arm` only. Deliberately the SAME variable
#                        name the service reads, so the phone's half and the
#                        service's half cannot disagree by transcription.
#
# Prereqs : adb, curl, node and sqlite3 on PATH; a real, unlocked Android device
#           with a DEBUGGABLE build installed; Metro reachable on METRO_PORT; a
#           service answering on SERVICE_PORT before `serve` is run.
#
# Exit    : 0 — the requested subcommand's assertions all held
#           1 — an assertion failed. The failing check is named and, for the
#               provenance and bypass checks, the diagnosis is spelled out.
#           2 — usage error (missing environment, unknown subcommand).
#
# ---------------------------------------------------------------------------
# What this rig is defending against, in order
# ---------------------------------------------------------------------------
#
#   1. An EMULATOR standing in for hardware. Emulator + headless browser is
#      explicitly not sufficient for this gate, and this project has repeated
#      evidence that emulator results do not transfer: real devices return
#      ERROR_NEGATIVE_BUTTON 13 / ERROR_USER_CANCELED 10 where the emulator
#      returns a generic ERROR_CANCELED 5, and emulators have no StrongBox.
#   2. A RELEASE build, for two independent reasons. A release APK ignores Metro,
#      so every JS edit under test would be invisible; and cleartext HTTP to
#      127.0.0.1 is permitted only by the DEBUG source set's manifest
#      (apps/VoteTorrentAuthority/android/app/src/debug/AndroidManifest.xml:6,
#      android:usesCleartextTraffic="true"). On a release build the upload would
#      fail at the network layer for a reason that has nothing to do with the
#      product.
#   3. THE 10.0.2.2 BYPASS. The app fetches its JS from whatever the RN dev menu's
#      "Debug server host & port" setting says. When that is set, the app dials
#      that host directly and `adb reverse` is bypassed entirely, so a leftover
#      Metro from another checkout silently serves the wrong tree's bundle. That
#      trap has already cost this project three harness runs.
#   4. A SILENTLY VACUOUS BYPASS CHECK. Written as
#      `adb shell "run-as PKG cat .../*.xml"`, the glob is expanded by the OUTER
#      device shell, which runs as the shell uid and cannot read the app's data
#      directory — so it passes the literal `*.xml` through, cat fails, and the
#      check reports "clean" on EVERY device. The glob must be expanded by an
#      inner `sh -c` running as the app uid.
#   5. AN ASSUMED `adb reverse`. The mapping does not survive a device restart and
#      the command that sets it can exit 0 without the mapping being present. It
#      is always read back from `adb reverse --list`.
#   6. A STALE dist/, on BOTH sides. The dashboard is served from its built
#      output, and the app bundles the vote engine's built output, so a source
#      edit is inert until both are rebuilt. `--reset-cache` cannot help: the
#      stale input is a file on disk, not a transform cache.
#   7. A TRAP THAT DESTROYS WORK. An EXIT trap that restores a file from
#      COMMITTED content deletes any uncommitted work in that file. This rig
#      refuses to arm on a dirty upload source, and restores from a byte-for-byte
#      backup taken before the write rather than from git.
#   8. THE WRONG BIOMETRIC COUNTER. `fp_success_count` counts a 100-entry ring, is
#      not monotonic, and has returned -1 in this project. acceptCrypto is the
#      counter of record here and the only one this script reads.
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
. scripts/lib/logcat-wait.sh

PACKAGE="org.votetorrent.authority"
PROBE="scripts/lib/rkstorage-staged-probe.mjs"
UPLOAD_SRC="apps/VoteTorrentAuthority/src/services/bootstrap-upload.ts"
DASH_SRC="apps/VoteTorrentDashboard/src"
DASH_DIST="apps/VoteTorrentDashboard/dist"
OPERATOR_DOC="packages/bootstrap-rendezvous-service/OPERATOR.md"
STAGED_KEY="votetorrent.dashboardBootstrap.stagedCode"

# A fixture token, never a user-facing string, and absent from this tree — so a
# hit anywhere is unambiguous.
CANARY="legacy-staged-residue-canary"

# Served-bundle provenance markers. C's occurrence COUNT is the cipher copy
# count and must be exactly 1; more than one copy has bound the wrong instance
# before and made signing fatal while the bundle was statically correct.
MARKER_A='bootstrap-content'
MARKER_B='DEV_BOOTSTRAP_UPLOAD_BASE_URL'
MARKER_C='aes/gcm: invalid ghash tag'

TAG="[rendezvous-uat]"
SCRATCH_ROOT="${TMPDIR:-/tmp}/bootstrap-rendezvous-uat"
RUN_TMP=""

log() { echo "${TAG} $*"; }
err() { echo "${TAG} $*" >&2; }
fail() {
	err "========== VERDICT: FAIL ($1) =========="
	exit 1
}

usage() {
	sed -n '2,51p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

make_run_tmp() {
	if [ -z "${RUN_TMP}" ]; then
		mkdir -p "${SCRATCH_ROOT}"
		RUN_TMP="$(mktemp -d "${SCRATCH_ROOT}/run-XXXXXX")"
	fi
}

# The served bundle carries the operator credential once the target is armed, so
# every temp file this rig writes is removed on the way out.
cleanup_run_tmp() {
	if [ -n "${RUN_TMP}" ] && [ -d "${RUN_TMP}" ]; then
		rm -rf "${RUN_TMP}"
	fi
}

require_env() {
	local missing=0
	for v in SERIAL SERVICE_PORT METRO_PORT; do
		if [ -z "${!v:-}" ]; then
			err "ERROR: ${v} is required and has no default."
			missing=1
		fi
	done
	if [ "${missing}" -ne 0 ]; then
		err "  List attached devices with: adb devices -l"
		err "  Then: SERIAL=<serial> SERVICE_PORT=<port> METRO_PORT=<port> $0 <subcommand>"
		exit 2
	fi
	if [ "${SERVICE_PORT}" = "${METRO_PORT}" ]; then
		err "ERROR: SERVICE_PORT and METRO_PORT are both ${SERVICE_PORT}."
		err "  They are two different origins on the same host and cannot share a port."
		exit 2
	fi
	ADBD="-s ${SERIAL}"
}

# ---------------------------------------------------------------------------
# device helpers
# ---------------------------------------------------------------------------

getprop() { adb ${ADBD} shell getprop "$1" 2>/dev/null | tr -d '\r\n' || true; }

device_identity() {
	QEMU="$(getprop ro.kernel.qemu)"
	CHARS="$(getprop ro.build.characteristics)"
	MODEL="$(getprop ro.product.model)"
	RELEASE="$(getprop ro.build.version.release)"
	SDK="$(getprop ro.build.version.sdk)"
	ABI="$(getprop ro.product.cpu.abi)"
	log "  serial=${SERIAL} model=${MODEL} android=${RELEASE} api=${SDK} abi=${ABI}"
	log "  ro.kernel.qemu='${QEMU}' ro.build.characteristics='${CHARS}'"
}

assert_real_device() {
	device_identity
	if [ -n "${QEMU}" ] || echo "${CHARS}" | grep -qi 'emulator'; then
		err "ERROR: ${SERIAL} is an EMULATOR. Real hardware is the gate for this run —"
		err "       an emulator plus a headless browser is explicitly not sufficient, and this"
		err "       project has repeated evidence that emulator results do not transfer."
		fail "preflight — emulator refused"
	fi
	local enrolled
	enrolled="$(adb ${ADBD} shell dumpsys fingerprint 2>/dev/null | grep -o '"count":[0-9]*' | head -1 || true)"
	log "  enrolled fingerprints: ${enrolled:-unknown}"
}

assert_debuggable() {
	if ! adb ${ADBD} shell run-as "${PACKAGE}" id >/dev/null 2>&1; then
		err "ERROR: run-as ${PACKAGE} failed — the installed build is not debuggable."
		err "       Two independent consequences, either of which invalidates this run:"
		err "         1. a release APK ignores Metro, so every JS result would be about a"
		err "            baked-in bundle rather than this tree;"
		err "         2. cleartext HTTP to 127.0.0.1 is permitted only by the DEBUG source"
		err "            set's manifest, so the upload would fail at the network layer for a"
		err "            reason that has nothing to do with the product."
		err "       Remedy: yarn workspace votetorrent-authority build:debug"
		err "       (or apps/VoteTorrentAuthority/android/gradlew installDebug)"
		fail "preflight — non-debuggable build"
	fi
	log "  run-as OK — the build is debuggable"
}

assert_no_dev_host_bypass() {
	# The glob MUST be expanded by the inner `sh -c`, which runs as the app's uid.
	# The outer device shell runs as the shell uid, cannot read the app's data
	# directory, and would pass the literal pattern through — making this check
	# report "clean" on every device. A vacuously-passing version of THIS check is
	# worse than no check: it guards the trap that has already cost three runs.
	local prefs_list prefs http_host
	prefs_list="$(adb ${ADBD} shell "run-as ${PACKAGE} ls /data/data/${PACKAGE}/shared_prefs" 2>/dev/null | tr -d '\r' || true)"
	if [ -z "${prefs_list}" ] || echo "${prefs_list}" | grep -qi 'no such file'; then
		log "  no shared_prefs present — the app has never persisted a dev-server host"
		return 0
	fi
	log "  shared_prefs: $(echo "${prefs_list}" | tr '\n' ' ')"
	prefs="$(adb ${ADBD} shell "run-as ${PACKAGE} sh -c 'cat /data/data/${PACKAGE}/shared_prefs/*.xml'" 2>/dev/null | tr -d '\r' || true)"
	if [ -z "${prefs}" ]; then
		err "ERROR: shared_prefs files exist but could not be read, so the bypass cannot be"
		err "       ruled out. Refusing to continue on an unverifiable provenance chain."
		fail "preflight — shared_prefs unreadable"
	fi
	http_host="$(printf '%s\n' "${prefs}" | grep -i 'debug_http_host' | sed -e 's/.*>\(.*\)<.*/\1/' || true)"
	if [ -n "${http_host}" ]; then
		err "ERROR: the app has a debug_http_host set: '${http_host}'"
		err "       The app will fetch its JS from THAT host, which bypasses 'adb reverse'"
		err "       entirely — 10.0.2.2 is the classic value. Everything this rig verifies"
		err "       about the SERVED bundle would then be about a bundler the device never"
		err "       talks to, and the upload target would be a host that is not this one."
		err "       Remedy 1 (preferred): clear it from the RN dev menu ->"
		err "         'Settings' / 'Debug server host & port for device' -> blank."
		err "       Remedy 2: adb ${ADBD} shell pm clear ${PACKAGE}"
		err "         COST: pm clear WIPES APP DATA, including the provisioned network."
		err "         Every leg of this run needs that network, so you would have to"
		err "         re-provision the device before running any of them."
		fail "preflight — debug_http_host bypass active"
	fi
	log "  no debug_http_host set — the device will use the reverse tunnel"
}

# pull_storage_db — pulls RKStorage plus its WAL/SHM sidecars into a fresh scratch
# dir and echoes the dir path. Same three-file idiom the signing ceremony uses.
pull_storage_db() {
	mkdir -p "${SCRATCH_ROOT}"
	local pulldir
	pulldir="$(mktemp -d "${SCRATCH_ROOT}/storage-XXXXXX")"
	local f
	for f in RKStorage RKStorage-wal RKStorage-shm; do
		adb ${ADBD} shell "run-as ${PACKAGE} cat databases/${f}" > "${pulldir}/${f}" 2>/dev/null || true
	done
	echo "${pulldir}"
}

# acceptCrypto is the counter of record. Both output shapes occur in the wild —
# some builds emit key=value, others emit JSON — so the pattern matches both. The
# first match is the real user's sensor record; a second entry for the reserved
# user id is always present and always zero.
accept_crypto() {
	adb ${ADBD} shell dumpsys fingerprint 2>/dev/null \
		| grep -o '"\?acceptCrypto"\?[:=][0-9]*' | head -1 || true
}

apply_reverses() {
	adb ${ADBD} reverse "tcp:8081" "tcp:${METRO_PORT}" >/dev/null || true
	adb ${ADBD} reverse "tcp:${SERVICE_PORT}" "tcp:${SERVICE_PORT}" >/dev/null || true
}

# Read the mapping back rather than trusting the exit code of the command that
# set it. The mapping also does not survive a device restart, so this is re-run
# rather than remembered.
read_back_reverses() {
	local listing
	listing="$(adb ${ADBD} reverse --list 2>/dev/null || true)"
	log "  adb reverse --list:"
	printf '%s\n' "${listing}" | sed "s/^/${TAG}    /"
	if ! printf '%s\n' "${listing}" | grep -q "tcp:8081 tcp:${METRO_PORT}"; then
		err "ERROR: the bundler mapping tcp:8081 -> tcp:${METRO_PORT} is NOT in the read-back."
		err "       The app dials its own 8081; without this the device fetches no JS from"
		err "       this host at all. Re-apply it and note that it is lost on every restart."
		fail "reverse — bundler mapping absent from the read-back"
	fi
	if ! printf '%s\n' "${listing}" | grep -q "tcp:${SERVICE_PORT} tcp:${SERVICE_PORT}"; then
		err "ERROR: the service mapping tcp:${SERVICE_PORT} -> tcp:${SERVICE_PORT} is NOT in the"
		err "       read-back. Identical ports on both sides is what makes the phone's upload"
		err "       target and the browser's dashboard origin one and the same 127.0.0.1 origin."
		fail "reverse — service mapping absent from the read-back"
	fi
	log "  both mappings confirmed by read-back"
}

service_http_code() {
	# `|| echo` would CONCATENATE curl's own "000" with a second one when curl
	# exits non-zero, so the status is captured and normalised instead.
	local code
	code="$(curl -s -o /dev/null --max-time 10 -w '%{http_code}' "http://127.0.0.1:${SERVICE_PORT}/" 2>/dev/null || true)"
	if [ -z "${code}" ]; then code="000"; fi
	echo "${code}"
}

# ---------------------------------------------------------------------------
# preflight
# ---------------------------------------------------------------------------

cmd_preflight() {
	log "STEP 1: host load"
	# A CPU-heavy concurrent test run has ANR'd a device mid-run in this project
	# and the resulting blank screen read as an app bug. Recorded, not gated.
	log "  uptime: $(uptime | sed 's/^ *//')"

	log "STEP 2: device identity"
	assert_real_device

	log "STEP 3: debuggable-build check"
	assert_debuggable

	log "STEP 4: dev-server-host bypass check"
	assert_no_dev_host_bypass

	log "STEP 5: port hygiene"
	local busy
	busy="$(lsof -nP -iTCP:"${SERVICE_PORT}" -sTCP:LISTEN 2>/dev/null || true)"
	if [ -n "${busy}" ]; then
		err "ERROR: ${SERVICE_PORT} already has a listener:"
		printf '%s\n' "${busy}" | sed "s/^/${TAG}    /" >&2
		if [ "${SERVICE_PORT}" = "8081" ]; then
			err "       :8081 on this machine is habitually squatted by the qrcode-daily-sync"
			err "       Expo instance. Pick another port rather than killing it."
		fi
		err "       The operator document's instance must be the one that binds this port."
		fail "preflight — SERVICE_PORT is not free"
	fi
	log "  ${SERVICE_PORT} is free (the document's instance will bind it)"

	log "STEP 6: stale-artifact rebuilds"
	log "  building the vote engine (the app bundles its built output, not its source)"
	yarn workspace @votetorrent/vote-engine build >/dev/null || fail "preflight — vote-engine build failed"
	log "  building the dashboard (the service serves its built output, not its source)"
	yarn workspace votetorrent-dashboard build >/dev/null || fail "preflight — dashboard build failed"
	if [ ! -f "${DASH_DIST}/index.html" ]; then
		err "ERROR: ${DASH_DIST}/index.html does not exist after a build."
		fail "preflight — dashboard build produced no entry document"
	fi
	local newer
	newer="$(find "${DASH_SRC}" -type f -newer "${DASH_DIST}/index.html" 2>/dev/null | head -5 || true)"
	if [ -n "${newer}" ]; then
		err "ERROR: source files are NEWER than the built entry document:"
		printf '%s\n' "${newer}" | sed "s/^/${TAG}    /" >&2
		err "       The service serves the built output, so those edits would be inert and"
		err "       every browser observation would be about superseded JavaScript."
		fail "preflight — stale dashboard build"
	fi
	log "  ${DASH_DIST}/index.html mtime: $(date -r "${DASH_DIST}/index.html" '+%Y-%m-%dT%H:%M:%S' 2>/dev/null || echo unknown)"
	log "  no source file is newer than the build"

	log "STEP 7: the tree can be restored"
	if [ -n "$(git status --porcelain "${UPLOAD_SRC}" 2>/dev/null)" ]; then
		err "ERROR: ${UPLOAD_SRC} already has uncommitted changes."
		err "       This rig writes that file transiently and restores it. Refusing to start:"
		err "       a restore would delete whatever is currently uncommitted in it."
		err "       Commit or revert it by hand, then re-run."
		fail "preflight — upload source is dirty"
	fi
	log "  ${UPLOAD_SRC} is clean — a transient override can be restored safely"

	log "STEP 8: instrument selftest"
	node "${PROBE}" --selftest || fail "preflight — the storage probe failed its own selftest"

	log "========== PREFLIGHT: PASS =========="
}

# ---------------------------------------------------------------------------
# serve — assert the document's instance is up; never start one
# ---------------------------------------------------------------------------

cmd_serve() {
	log "applying the reverse mappings"
	apply_reverses
	read_back_reverses

	log "asserting a service is answering on http://127.0.0.1:${SERVICE_PORT}/"
	local code
	code="$(service_http_code)"
	log "  GET / -> ${code}"
	if [ "${code}" != "200" ]; then
		err "ERROR: nothing is answering on http://127.0.0.1:${SERVICE_PORT}/ (got ${code})."
		err "       This rig does NOT start the service, deliberately: the instance the device"
		err "       tests redeem against must be the one produced by following the operator"
		err "       document, or the document is reviewed rather than exercised."
		err "       Follow it from the top: ${OPERATOR_DOC}"
		fail "serve — no service on ${SERVICE_PORT}"
	fi
	log "========== SERVE: PASS (document-produced instance reachable, both mappings read back) =========="
}

# ---------------------------------------------------------------------------
# arm — write the dev upload target and HOLD it, with restore armed first
# ---------------------------------------------------------------------------

restore_upload_src() {
	if [ -n "${UPLOAD_BACKUP:-}" ] && [ -f "${UPLOAD_BACKUP}" ]; then
		cp "${UPLOAD_BACKUP}" "${UPLOAD_SRC}"
		log "upload target restored from the pre-write backup"
	else
		err "WARNING: no backup found — restore ${UPLOAD_SRC} by hand."
	fi
	log "git status --porcelain ${UPLOAD_SRC}: '$(git status --porcelain "${UPLOAD_SRC}" 2>/dev/null)'"
	cleanup_run_tmp
}

cmd_arm() {
	if [ -z "${BOOTSTRAP_RENDEZVOUS_UPLOAD_TOKEN:-}" ]; then
		err "ERROR: BOOTSTRAP_RENDEZVOUS_UPLOAD_TOKEN is required by this subcommand."
		err "       It is deliberately the same variable name the service reads, so the"
		err "       phone's half and the service's half cannot disagree by transcription."
		err "       Export the value the running instance was started with."
		exit 2
	fi
	if [ -n "$(git status --porcelain "${UPLOAD_SRC}" 2>/dev/null)" ]; then
		err "ERROR: ${UPLOAD_SRC} already has uncommitted changes. Refusing to arm — the"
		err "       restore would delete them. Commit or revert by hand, then re-run."
		fail "arm — upload source is dirty"
	fi

	make_run_tmp
	# THE ORDER HERE IS LOAD-BEARING. The backup is taken and the restore trap is
	# installed BEFORE the file is written, so a run killed at any point after the
	# write still restores. Restoring from a byte-for-byte backup rather than from
	# committed content is what makes the trap incapable of destroying work.
	UPLOAD_BACKUP="${RUN_TMP}/bootstrap-upload.ts.orig"
	cp "${UPLOAD_SRC}" "${UPLOAD_BACKUP}"
	trap restore_upload_src EXIT INT TERM
	log "restore armed (backup: ${UPLOAD_BACKUP})"

	local origin anchor_base anchor_token
	origin="http://127.0.0.1:${SERVICE_PORT}"
	anchor_base='^export const DEV_BOOTSTRAP_UPLOAD_BASE_URL: string | undefined = undefined;$'
	anchor_token='^export const DEV_BOOTSTRAP_UPLOAD_TOKEN: string | undefined = undefined;$'
	if ! grep -qF 'export const DEV_BOOTSTRAP_UPLOAD_BASE_URL: string | undefined = undefined;' "${UPLOAD_SRC}"; then
		err "ERROR: the base-URL constant is not in its expected declared form in ${UPLOAD_SRC}."
		err "       Expected exactly: export const DEV_BOOTSTRAP_UPLOAD_BASE_URL: string | undefined = undefined;"
		err "       A shape change must fail loudly here rather than have the rewrite match"
		err "       nothing and leave the target unset while everything else reports fine."
		fail "arm — declared form changed"
	fi
	if ! grep -qF 'export const DEV_BOOTSTRAP_UPLOAD_TOKEN: string | undefined = undefined;' "${UPLOAD_SRC}"; then
		err "ERROR: the token constant is not in its expected declared form in ${UPLOAD_SRC}."
		fail "arm — declared form changed"
	fi

	# sed with '#' as the delimiter: the anchors contain '|', and the replacement
	# contains '/'. Written to a temp file then moved, because -i differs between
	# BSD and GNU sed and this host is macOS.
	sed -e "s#${anchor_base}#export const DEV_BOOTSTRAP_UPLOAD_BASE_URL: string | undefined = \"${origin}\";#" \
		-e "s#${anchor_token}#export const DEV_BOOTSTRAP_UPLOAD_TOKEN: string | undefined = \"${BOOTSTRAP_RENDEZVOUS_UPLOAD_TOKEN}\";#" \
		"${UPLOAD_SRC}" > "${RUN_TMP}/bootstrap-upload.ts.new"
	mv "${RUN_TMP}/bootstrap-upload.ts.new" "${UPLOAD_SRC}"

	if ! grep -qF "DEV_BOOTSTRAP_UPLOAD_BASE_URL: string | undefined = \"${origin}\"" "${UPLOAD_SRC}"; then
		fail "arm — the base-URL rewrite did not land"
	fi
	if grep -qF 'DEV_BOOTSTRAP_UPLOAD_TOKEN: string | undefined = undefined;' "${UPLOAD_SRC}"; then
		fail "arm — the token rewrite did not land"
	fi
	# The token itself is never printed: it is an operator credential, and this
	# rig's output is transcribed into an evidence file.
	log "armed: base URL = ${origin}; token = (set, ${#BOOTSTRAP_RENDEZVOUS_UPLOAD_TOKEN} characters, not printed)"

	apply_reverses
	read_back_reverses

	local code
	code="$(service_http_code)"
	log "service GET / -> ${code}"
	if [ "${code}" != "200" ]; then
		err "WARNING: nothing is answering on ${SERVICE_PORT} yet — the upload will be refused"
		err "         as unreachable until the document's instance is up."
	fi

	log ""
	log "HOLDING the dev upload target. Do not close this terminal until the mints are done."
	log "  1. The constants are read at call time, but the module must be re-evaluated on the"
	log "     device for the new values to reach the uploader. Let Fast Refresh apply it, or"
	log "     relaunch the app — a cold start also destroys the provisioned network session,"
	log "     so prefer Fast Refresh."
	log "  2. Then, in ANOTHER terminal, confirm the value actually reached the served bundle:"
	log "       SERIAL=${SERIAL} SERVICE_PORT=${SERVICE_PORT} METRO_PORT=${METRO_PORT} $0 provenance"
	log "  3. Note that while this is armed, the authority app's own spec for this file will"
	log "     fail — it asserts both constants are unset. That is expected for the duration."
	log ""
	if [ -t 0 ]; then
		printf '%s Press Enter to disarm and restore (Ctrl-C also works): ' "${TAG}"
		read -r _ || true
	else
		log "stdin is not a terminal — holding until signalled (Ctrl-C / kill)."
		while true; do sleep 5; done
	fi
	log "========== ARM: released =========="
}

# ---------------------------------------------------------------------------
# provenance — prove the JS the device runs came from this tree
# ---------------------------------------------------------------------------

count_occurrences() { grep -o -F "$1" "$2" | wc -l | tr -d ' '; }

cmd_provenance() {
	make_run_tmp
	trap cleanup_run_tmp EXIT

	local bundle url
	bundle="${RUN_TMP}/index.bundle"
	url="http://127.0.0.1:${METRO_PORT}/index.bundle?platform=android&dev=true&minify=false"
	log "fetching the SERVED bundle from ${url}"
	if ! curl -sf --max-time 300 "${url}" -o "${bundle}"; then
		err "ERROR: no bundler reachable at ${url}."
		err "       This rig deliberately does not start one, so the bundler's provenance is"
		err "       yours rather than the harness's. Start it FROM THIS CHECKOUT:"
		err "         yarn workspace votetorrent-authority start --port ${METRO_PORT} --reset-cache"
		fail "provenance — bundler unreachable"
	fi

	local bytes sha
	bytes="$(wc -c < "${bundle}" | tr -d ' ')"
	sha="$( (shasum -a 256 "${bundle}" 2>/dev/null || sha256sum "${bundle}") | awk '{print $1}')"
	log "  served bundle: ${bytes} bytes  sha256=${sha}"

	local a b c
	a="$(count_occurrences "${MARKER_A}" "${bundle}" || true)"
	b="$(count_occurrences "${MARKER_B}" "${bundle}" || true)"
	c="$(count_occurrences "${MARKER_C}" "${bundle}" || true)"
	log "  marker A '${MARKER_A}'          x${a}  (expect >= 1)"
	log "  marker B '${MARKER_B}' x${b}  (expect >= 1)"
	log "  marker C '${MARKER_C}' x${c}  (expect EXACTLY 1)"

	if [ "${a}" -lt 1 ]; then
		err "ERROR: the sealing module's domain label is absent from the served bundle — the"
		err "       device would run a bundle with no sealing module at all."
		fail "provenance — marker A absent"
	fi
	if [ "${b}" -lt 1 ]; then
		err "ERROR: the uploader module is absent from the served bundle. A stale bundler is"
		err "       serving a tree that predates it."
		fail "provenance — marker B absent"
	fi
	if [ "${c}" -lt 1 ]; then
		err "ERROR: the cipher implementation is absent from the served bundle. That is a"
		err "       module RESOLUTION failure — packaging, not the JS engine."
		fail "provenance — marker C absent (resolution failure)"
	fi
	if [ "${c}" -ne 1 ]; then
		err "ERROR: the cipher appears ${c} times in the served bundle. This is the MULTI-COPY"
		err "       bundler-binding failure class: duplicate copies of a crypto package have"
		err "       bound the wrong instance before and made signing fatal at runtime while"
		err "       the bundle was statically correct and the host worked fine."
		err "       Remedy: confirm the root resolutions pin took, dedupe the workspace copies."
		fail "provenance — ${c} copies of the cipher"
	fi

	# Marker B's VALUE is the half that matters. A bundle that still resolves the
	# base URL to undefined boots cleanly, refuses the upload as not-configured,
	# and looks like a product defect.
	log "  the base URL's assigned VALUE in the served bundle:"
	local occurrences
	occurrences="$(grep -o 'DEV_BOOTSTRAP_UPLOAD_BASE_URL[^,;]*' "${bundle}" | sort -u || true)"
	if [ -z "${occurrences}" ]; then
		fail "provenance — the base-URL constant does not appear in the served bundle"
	fi
	printf '%s\n' "${occurrences}" | sed "s/^/${TAG}    /"
	if printf '%s\n' "${occurrences}" | grep -qE '=[[:space:]]*undefined'; then
		err "ERROR: an occurrence still assigns undefined in the SERVED bundle. Either the"
		err "       target is not armed, or the bundler's transform cache has not picked the"
		err "       write up, or it is serving a DIFFERENT checkout. Arm it, then restart the"
		err "       bundler with --reset-cache from this tree."
		fail "provenance — the upload target resolves undefined in the served bundle"
	fi
	# Deliberately NOT printed or grepped: the token constant's value. It is an
	# operator credential and this output is transcribed into an evidence file.

	log "  (corroborate this with an independent one-shot bundle of the same tree:"
	log "     npx react-native bundle --platform android --dev true --entry-file index.js"
	log "   two independent bundles agreeing rules out a bundler serving artifact)"
	log "========== PROVENANCE: PASS =========="
}

# ---------------------------------------------------------------------------
# probe-staged / inject-legacy / assert-clean
# ---------------------------------------------------------------------------

cmd_probe_staged() {
	local pulldir
	pulldir="$(pull_storage_db)"
	log "pulled RKStorage + sidecars to ${pulldir}"
	log "staged-record probe:"
	node "${PROBE}" --db "${pulldir}/RKStorage" --canary "${CANARY}" | sed "s/^/${TAG}   /"
	log "acceptCrypto: $(accept_crypto)"
	log "  (the counter of record for every signing op in this run; the other fingerprint"
	log "   counter in that dumpsys output is a 100-entry ring, is not monotonic, and is"
	log "   never read by this rig)"
}

cmd_inject_legacy() {
	make_run_tmp
	log "force-stopping the app so nothing writes while the database is replaced"
	adb ${ADBD} shell am force-stop "${PACKAGE}"
	sleep 2

	local pulldir
	pulldir="$(pull_storage_db)"
	log "pulled to ${pulldir}"
	if [ ! -s "${pulldir}/RKStorage" ]; then
		err "ERROR: the pulled database is empty. That is a failed pull, not a clean device."
		fail "inject-legacy — empty pull"
	fi

	# Fold the sidecars in before writing: a stale WAL replayed after the swap
	# would resurrect the row that was just replaced.
	log "checkpointing the write-ahead log into the main database"
	sqlite3 "${pulldir}/RKStorage" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null 2>&1 || true

	local expires record
	expires="$(node -e 'const d=new Date(Date.now()-15*3600*1000);process.stdout.write(d.toISOString().slice(0,19))')"
	record="${RUN_TMP}/legacy-record.json"
	log "synthesizing a pre-fix-shaped record expiring ${expires} (in the past, as the residue was)"
	node "${PROBE}" --make-legacy "${record}" --canary "${CANARY}" --expires "${expires}" \
		| sed "s/^/${TAG}   /" || fail "inject-legacy — synthesis failed"

	# CAST(... AS TEXT) because readfile() yields a BLOB and the app writes TEXT;
	# a BLOB column value is not what the app would read back.
	sqlite3 "${pulldir}/RKStorage" \
		"insert or replace into catalystLocalStorage(key, value) values('${STAGED_KEY}', CAST(readfile('${record}') AS TEXT));" \
		|| fail "inject-legacy — the local insert failed"

	log "pushing the modified database back"
	# `adb push` then an in-place `run-as cp`, never a piped `cat` through
	# `adb shell` — stdin handling there is not binary-safe. The copy runs as the
	# app uid, so the replaced file keeps the app's ownership.
	adb ${ADBD} push "${pulldir}/RKStorage" /data/local/tmp/RKStorage >/dev/null \
		|| fail "inject-legacy — adb push failed"
	adb ${ADBD} shell chmod 644 /data/local/tmp/RKStorage >/dev/null 2>&1 || true
	adb ${ADBD} shell "run-as ${PACKAGE} cp /data/local/tmp/RKStorage databases/RKStorage" \
		|| fail "inject-legacy — the on-device copy failed"
	# The stale sidecars would otherwise mask the replacement entirely.
	adb ${ADBD} shell "run-as ${PACKAGE} rm -f databases/RKStorage-wal databases/RKStorage-shm" || true
	# Leave no world-readable copy of the app's database behind.
	adb ${ADBD} shell rm -f /data/local/tmp/RKStorage >/dev/null 2>&1 || true

	log "reading the landing back BEFORE the app is started"
	local verifydir observed
	verifydir="$(pull_storage_db)"
	observed="$(node "${PROBE}" --db "${verifydir}/RKStorage" --canary "${CANARY}")"
	printf '%s\n' "${observed}" | sed "s/^/${TAG}   /"
	if ! printf '%s' "${observed}" | grep -q '"hasSnapshotJson":true'; then
		err "ERROR: the injected record does not read back carrying a payload. Without this"
		err "       positive control a later clean reading would prove nothing at all — an"
		err "       injection that never landed also reads clean."
		fail "inject-legacy — the injected record did not land"
	fi
	if printf '%s' "${observed}" | grep -q '"canaryHits":0'; then
		err "ERROR: the injected record read back with a canary count of 0."
		fail "inject-legacy — the canary did not land"
	fi
	log "========== INJECT-LEGACY: landed and read back (this is the positive control) =========="
	log "Now cold-start the app ONCE, then run: $0 assert-clean"
}

cmd_assert_clean() {
	local pulldir status
	pulldir="$(pull_storage_db)"
	log "pulled RKStorage to ${pulldir}"
	set +e
	node "${PROBE}" --assert-clean "${pulldir}/RKStorage" --canary "${CANARY}" 2>&1 | sed "s/^/${TAG}   /"
	status="${PIPESTATUS[0]}"
	set -e

	# Direct corroboration that the cleanup actually RAN, rather than that the
	# record merely happens to be clean. The app logs a closed-vocabulary outcome
	# token and nothing else. Absence is not fatal — logcat rotates.
	local sweep
	sweep="$(adb ${ADBD} logcat -d 2>/dev/null | grep -F 'staged sign-in-code sweep outcome' | tail -3 || true)"
	if [ -n "${sweep}" ]; then
		log "  sweep outcome lines in logcat:"
		printf '%s\n' "${sweep}" | sed "s/^/${TAG}    /"
	else
		log "  no sweep outcome line in the current logcat buffer (the clean and absent"
		log "   outcomes are silent by design, and the buffer may have rotated)"
	fi

	if [ "${status}" -ne 0 ]; then
		err "ERROR: the staged record did not come out clean after the app start."
		err "       Report this; do not repair it here."
		fail "assert-clean — the legacy record survived"
	fi
	log "========== ASSERT-CLEAN: PASS =========="
}

# ---------------------------------------------------------------------------
# teardown
# ---------------------------------------------------------------------------

cmd_teardown() {
	# Targeted removals only. A blanket remove-all would also drop mappings this
	# rig never created and that other live sessions on this host depend on.
	log "removing this rig's reverse mappings"
	adb ${ADBD} reverse --remove "tcp:${SERVICE_PORT}" >/dev/null 2>&1 || true
	log "  adb reverse --list after removal:"
	adb ${ADBD} reverse --list 2>/dev/null | sed "s/^/${TAG}    /" || true
	log "  (the bundler mapping tcp:8081 is left in place — it predates this run on this host)"

	local dirty
	dirty="$(git status --porcelain "${UPLOAD_SRC}" 2>/dev/null || true)"
	if [ -n "${dirty}" ]; then
		if grep -qF "DEV_BOOTSTRAP_UPLOAD_BASE_URL: string | undefined = \"http://127.0.0.1:" "${UPLOAD_SRC}"; then
			log "  the upload target is still armed from a run that did not release; restoring"
			git checkout -- "${UPLOAD_SRC}"
		else
			err "WARNING: ${UPLOAD_SRC} is modified but does not carry this rig's loopback"
			err "         target. Refusing to touch it — that is someone else's work."
		fi
	fi
	log "  git status --porcelain ${UPLOAD_SRC}: '$(git status --porcelain "${UPLOAD_SRC}" 2>/dev/null)'"

	if [ -d "${SCRATCH_ROOT}" ]; then
		log "removing pulled database copies from ${SCRATCH_ROOT}"
		rm -rf "${SCRATCH_ROOT}"
	fi
	log "========== TEARDOWN: done =========="
}

# ---------------------------------------------------------------------------

SUBCOMMAND="${1:-}"
case "${SUBCOMMAND}" in
	preflight)     require_env; cmd_preflight ;;
	serve)         require_env; cmd_serve ;;
	arm)           require_env; cmd_arm ;;
	provenance)    require_env; cmd_provenance ;;
	probe-staged)  require_env; cmd_probe_staged ;;
	inject-legacy) require_env; cmd_inject_legacy ;;
	assert-clean)  require_env; cmd_assert_clean ;;
	teardown)      require_env; cmd_teardown ;;
	""|-h|--help|help)
		usage
		exit 2
		;;
	*)
		err "unknown subcommand: ${SUBCOMMAND}"
		usage
		exit 2
		;;
esac
