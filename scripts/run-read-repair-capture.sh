#!/usr/bin/env bash
#
# run-read-repair-capture.sh
#
# Purpose : Capture and classify Optimystic's read-repair markers from a real
#           network-create on device, to settle whether this app hits the
#           gotchoices/Optimystic#8 solo read-repair non-termination defect.
#
#           Issue #8 resolved to: CoordinatorRepo.fetchBlockFromCluster's
#           solo-cluster short-circuit returned WITHOUT calling markBlocksSeen, so
#           lastSeenCommitMs was never stamped, so shouldReadRepair saw null and
#           returned true on every read — forever. It needs a cohort of exactly one
#           that is self, i.e. exactly a founder creating a network with no peers.
#           Fixed in @optimystic/db-p2p 0.29.0.
#
# ---------------------------------------------------------------------------
# The trap this script exists to close
# ---------------------------------------------------------------------------
# Every marker that could answer this question is emitted through the `debug`
# package, and NOTHING enables `debug` on React Native: its browser build reads
# localStorage (absent on RN, and the read throws inside debug's own try/catch)
# and falls back to process.env.DEBUG (which Metro never sets). So those
# namespaces are silently OFF.
#
# The consequence is a capture that greps CLEAN for `read-repair-triggered` and
# reads as "that path never ran" when the truth is "the logger was never armed".
# Both committed phase-58 device captures (58-07-t1-landed-logcat.txt,
# 58-08-redmi-logcat.txt) contain zero lines from any optimystic:db-p2p namespace
# for precisely this reason.
#
# So step 6 does not merely start a capture — it BLOCKS until the app has printed
# its own `[optidbg] armed` line, and fails if it does not. An unarmed capture is
# an unarmed instrument, never evidence of a healthy node, and the analyzer
# refuses a verdict on one for the same reason.
#
# Usage   : SERIAL=43a209ff0806 ./scripts/run-read-repair-capture.sh
#
#           SERIAL           REQUIRED. No default — a default would silently
#                            target an emulator.
#           METRO_PORT       Optional, default 8081. Metro must ALREADY be running
#                            from THIS checkout on this port; this script does not
#                            start one, so the bundler's provenance is yours.
#                              yarn workspace votetorrent-authority start \
#                                --port 8081 --reset-cache
#           CAPTURE_SECONDS  Optional, default 420. The Redmi 8 baseline landed a
#                            create in ~349-412s (58-08-PROFILE-EVIDENCE.md), so
#                            the default covers one full create with headroom.
#           NAMESPACES       Optional. Default is the ONE namespace carrying all
#                            four decisive markers. Widen only deliberately:
#                            `optimystic:db-p2p:*` on this path is tens of
#                            thousands of lines through the RN console bridge and
#                            perturbs the very timing being measured.
#           OUT_DIR          Optional, default .capture/read-repair.
#           ALLOW_EMULATOR   Optional. Set to 1 to permit a non-hardware target.
#                            Off by default: this project has repeated evidence
#                            that emulator timing does not transfer.
#
# Exit    : 0 — a capture was produced AND the instrument was armed. The VERDICT
#               line says which defect class (if any) the run exhibits; a
#               non-defect verdict is still exit 0, because "healthy" is a real
#               and useful answer here.
#           1 — any step failed, including "armed line never appeared", which is
#               a failed instrument rather than a healthy result.
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PACKAGE="org.votetorrent.authority"
METRO_PORT="${METRO_PORT:-8081}"
CAPTURE_SECONDS="${CAPTURE_SECONDS:-420}"
NAMESPACES="${NAMESPACES:-optimystic:db-p2p:coordinator-repo:*}"
OUT_DIR="${OUT_DIR:-.capture/read-repair}"
FLAG_FILE="apps/VoteTorrentAuthority/src/engines/debug-namespaces.generated.ts"
ANALYZER="scripts/lib/analyze-read-repair.mjs"
FILTER="scripts/filter-device-logcat.sh"
PREFIX_MARKER='[optidbg]'

log() { echo "[rr-capture] $*"; }
fail() { echo "[rr-capture] ========== READ-REPAIR CAPTURE: FAIL ($1) ==========" >&2; exit 1; }

if [ -z "${SERIAL:-}" ]; then
  echo "[rr-capture] ERROR: SERIAL is required and has no default." >&2
  echo "[rr-capture]   adb devices -l    then    SERIAL=<serial> $0" >&2
  exit 1
fi
ADBD="-s ${SERIAL}"
mkdir -p "${OUT_DIR}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RAW_LOG="${OUT_DIR}/${STAMP}-raw.txt"
CAPTURE="${OUT_DIR}/${STAMP}-capture.txt"
ANALYSIS="${OUT_DIR}/${STAMP}-analysis.md"
ANALYSIS_JSON="${OUT_DIR}/${STAMP}-analysis.json"

# ── STEP 1: device identity ──────────────────────────────────────────────────
log "STEP 1: device identity"
QEMU="$(adb ${ADBD} shell getprop ro.kernel.qemu 2>/dev/null | tr -d '\r\n' || true)"
CHARS="$(adb ${ADBD} shell getprop ro.build.characteristics 2>/dev/null | tr -d '\r\n' || true)"
MODEL="$(adb ${ADBD} shell getprop ro.product.model 2>/dev/null | tr -d '\r\n' || true)"
SDK="$(adb ${ADBD} shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r\n' || true)"
ABI="$(adb ${ADBD} shell getprop ro.product.cpu.abi 2>/dev/null | tr -d '\r\n' || true)"
log "  serial=${SERIAL} model=${MODEL} api=${SDK} abi=${ABI}"
if [ -n "${QEMU}" ] || echo "${CHARS}" | grep -qi 'emulator'; then
  if [ "${ALLOW_EMULATOR:-0}" != "1" ]; then
    echo "[rr-capture] ERROR: ${SERIAL} is an EMULATOR and ALLOW_EMULATOR is not set." >&2
    echo "[rr-capture]        The baseline this compares against (58-08) is Redmi 8 hardware," >&2
    echo "[rr-capture]        and emulator storage timing does not transfer." >&2
    fail "step 1 — emulator refused"
  fi
  log "  WARNING: emulator target permitted via ALLOW_EMULATOR=1 — timing is NOT comparable"
fi

# ── STEP 2: debuggable build ─────────────────────────────────────────────────
log "STEP 2: debuggable-build check"
if ! adb ${ADBD} shell run-as "${PACKAGE}" id >/dev/null 2>&1; then
  echo "[rr-capture] ERROR: run-as ${PACKAGE} failed — the installed build is not debuggable." >&2
  echo "[rr-capture]        A release APK ignores Metro, so the arming edit would never reach" >&2
  echo "[rr-capture]        the device and the capture would be silently unarmed." >&2
  fail "step 2 — non-debuggable build"
fi
log "  run-as OK — build is debuggable"

# ── STEP 3: arm the flag file (EXIT trap installed FIRST) ────────────────────
log "STEP 3: arming ${FLAG_FILE}"
# Restore by REWRITING the default content, not by `git checkout --`. The proof-flags
# scripts can use git because their flag file is tracked; this one must also work the
# first time it runs, before the file has ever been committed — and a restore that
# silently fails is how an armed value reaches a commit.
FLAG_DEFAULT_BODY="export const DEBUG_NAMESPACES = '';"
restore_flags() {
  if [ ! -f "${FLAG_FILE}" ]; then return 0; fi
  python3 - "${FLAG_FILE}" "${FLAG_DEFAULT_BODY}" <<'PYEOF'
import io, re, sys
path, default_body = sys.argv[1], sys.argv[2]
src = io.open(path, encoding='utf-8').read()
out = re.sub(r"^export const DEBUG_NAMESPACES = .*$", default_body, src, count=1, flags=re.M)
if out != src:
    io.open(path, 'w', encoding='utf-8').write(out)
PYEOF
  if grep -q "^export const DEBUG_NAMESPACES = '';$" "${FLAG_FILE}"; then
    log "flag file restored to default (disabled)"
  else
    echo "[rr-capture] WARNING: ${FLAG_FILE} is still armed — reset it before committing:" >&2
    echo "[rr-capture]   ${FLAG_DEFAULT_BODY}" >&2
  fi
}
trap restore_flags EXIT
cat > "${FLAG_FILE}" << EOF
// run-read-repair-capture.sh generated override — do not commit (EXIT trap restores default).
// Static import only — dynamic require() breaks Metro (Phase 16-07 lesson).
export const DEBUG_NAMESPACES = '${NAMESPACES}';
EOF
log "  DEBUG_NAMESPACES='${NAMESPACES}'"

# ── STEP 4: served-bundle provenance ─────────────────────────────────────────
# Assert on what Metro ACTUALLY serves, not on what the source tree says. The
# device dials its own 8081, which adb reverse maps to METRO_PORT — but a dev-server
# host set to 10.0.2.2 BYPASSES adb reverse, so a stray bundler from another tree
# can serve the wrong bundle. Checking the served bytes is the only defence.
log "STEP 4: served-bundle provenance (Metro on 127.0.0.1:${METRO_PORT})"
adb ${ADBD} reverse tcp:8081 "tcp:${METRO_PORT}" >/dev/null || true
log "  adb reverse tcp:8081 -> tcp:${METRO_PORT}"

BUNDLE_FILE="$(mktemp -t rr-bundle)"
cleanup_all() { rm -f "${BUNDLE_FILE}"; restore_flags; }
trap cleanup_all EXIT

BUNDLE_URL="http://127.0.0.1:${METRO_PORT}/index.bundle?platform=android&dev=true&minify=false"
if ! curl -sf "${BUNDLE_URL}" -o "${BUNDLE_FILE}"; then
  echo "[rr-capture] ERROR: no Metro reachable at ${BUNDLE_URL}" >&2
  echo "[rr-capture]        Start one FROM THIS CHECKOUT:" >&2
  echo "[rr-capture]          yarn workspace votetorrent-authority start --port ${METRO_PORT} --reset-cache" >&2
  fail "step 4 — Metro unreachable"
fi
BUNDLE_BYTES="$(wc -c < "${BUNDLE_FILE}" | tr -d ' ')"
log "  served bundle: ${BUNDLE_BYTES} bytes"

count_occurrences() { grep -o -F "$1" "${BUNDLE_FILE}" | wc -l | tr -d ' '; }
PREFIX_HITS="$(count_occurrences "${PREFIX_MARKER}" || true)"
NS_HITS="$(count_occurrences "${NAMESPACES}" || true)"
log "  '${PREFIX_MARKER}' x${PREFIX_HITS}  (expect >= 1: the arming module is in the bundle)"
log "  '${NAMESPACES}' x${NS_HITS}  (expect >= 1: the ARMED VALUE, not just the module)"
if [ "${PREFIX_HITS}" -lt 1 ]; then
  echo "[rr-capture] ERROR: the served bundle has no '${PREFIX_MARKER}' — arm-debug-namespaces is" >&2
  echo "[rr-capture]        not in the bundle the device will run. Metro is serving another tree." >&2
  fail "step 4 — arming module absent from served bundle"
fi
if [ "${NS_HITS}" -lt 1 ]; then
  echo "[rr-capture] ERROR: the served bundle contains the arming module but NOT the namespace" >&2
  echo "[rr-capture]        value '${NAMESPACES}'. Metro served a cached transform of the" >&2
  echo "[rr-capture]        pre-arming flag file. Restart Metro with --reset-cache." >&2
  fail "step 4 — armed value absent (stale Metro transform cache)"
fi

# ── STEP 5: clock reading (recorded, not gated) ──────────────────────────────
# Event timing comes from the device's own Date.now(), embedded in each line, so
# host/device skew cannot distort a gap. Recorded so the capture can still be
# correlated with host-side wall clock if that is ever needed.
DEV_EPOCH="$(adb ${ADBD} shell date +%s 2>/dev/null | tr -d '\r\n' || echo 0)"
HOST_EPOCH="$(date +%s)"
log "STEP 5: clock — device=${DEV_EPOCH} host=${HOST_EPOCH} skew=$((DEV_EPOCH - HOST_EPOCH))s (recorded, not gated)"

# ── STEP 6: cold start, then BLOCK until the instrument reports armed ────────
log "STEP 6: cold start + arming gate"
adb ${ADBD} logcat -c >/dev/null 2>&1 || true
adb ${ADBD} shell am force-stop "${PACKAGE}" >/dev/null 2>&1 || true
adb ${ADBD} logcat -v threadtime > "${RAW_LOG}" 2>&1 &
LOGCAT_PID=$!
stop_logcat() { kill "${LOGCAT_PID}" 2>/dev/null || true; }
cleanup_all2() { stop_logcat; rm -f "${BUNDLE_FILE}"; restore_flags; }
trap cleanup_all2 EXIT
sleep 1
adb ${ADBD} shell monkey -p "${PACKAGE}" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true

ARMED_TIMEOUT=180
log "  waiting up to ${ARMED_TIMEOUT}s for the app's own '${PREFIX_MARKER} armed' line ..."
ARMED_OK=0
for _ in $(seq "${ARMED_TIMEOUT}"); do
  if grep -qF "${PREFIX_MARKER} armed" "${RAW_LOG}" 2>/dev/null; then ARMED_OK=1; break; fi
  sleep 1
done
if [ "${ARMED_OK}" -ne 1 ]; then
  echo "[rr-capture] ERROR: the app never printed '${PREFIX_MARKER} armed' within ${ARMED_TIMEOUT}s." >&2
  echo "[rr-capture]        The instrument is NOT armed, so any capture from this run would be" >&2
  echo "[rr-capture]        silent whether or not read-repair looped. Do not interpret it." >&2
  echo "[rr-capture]        Likely causes: the app loaded a cached bundle (reload it), or it is" >&2
  echo "[rr-capture]        fetching JS from 10.0.2.2:8081 and bypassing adb reverse." >&2
  fail "step 6 — instrument never armed"
fi
log "  ARMED: $(grep -F "${PREFIX_MARKER} armed" "${RAW_LOG}" | tail -1 | sed 's/.*optidbg\] //')"

# ── STEP 7: capture window ───────────────────────────────────────────────────
echo ""
log "=============================================================="
log " DRIVE THE NETWORK CREATE NOW."
log " Capturing for ${CAPTURE_SECONDS}s (~$((CAPTURE_SECONDS / 60)) min)."
log " Live marker count updates every 30s below."
log "=============================================================="
echo ""
ELAPSED=0
while [ "${ELAPSED}" -lt "${CAPTURE_SECONDS}" ]; do
  sleep 30
  ELAPSED=$((ELAPSED + 30))
  TRIG="$(grep -cF 'read-repair-triggered' "${RAW_LOG}" 2>/dev/null || true)"
  SKIP="$(grep -cF 'solo-self-skip' "${RAW_LOG}" 2>/dev/null || true)"
  log "  t=${ELAPSED}s  triggered=${TRIG}  solo-self-skip=${SKIP}"
done
stop_logcat
sleep 1
log "STEP 7: capture complete — $(wc -l < "${RAW_LOG}" | tr -d ' ') raw lines"

# ── STEP 8: confidentiality filter ───────────────────────────────────────────
# A device-wide logcat from a personal handset carries every other app's
# telemetry; 58-08 committed one such capture naming 412 distinct dotted
# identifiers. Filter before anything is written anywhere durable.
log "STEP 8: filtering to this app's own lines"
if [ -x "${FILTER}" ] && "${FILTER}" --in "${RAW_LOG}" --out "${CAPTURE}" --package "${PACKAGE}"; then
  log "  filtered -> ${CAPTURE}"
  rm -f "${RAW_LOG}"
else
  log "  WARNING: filter failed; keeping the raw capture — DO NOT COMMIT IT UNFILTERED"
  cp "${RAW_LOG}" "${CAPTURE}"
fi

# ── STEP 9: analysis ─────────────────────────────────────────────────────────
log "STEP 9: analysis"
node "${ANALYZER}" --in "${CAPTURE}" --json "${ANALYSIS_JSON}" | tee "${ANALYSIS}"
echo ""
log "capture  : ${CAPTURE}"
log "analysis : ${ANALYSIS}"
