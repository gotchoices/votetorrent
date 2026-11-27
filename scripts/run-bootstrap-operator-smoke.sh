#!/usr/bin/env bash
#
# run-bootstrap-operator-smoke.sh
#
# Purpose : Validate packages/bootstrap-rendezvous-service/OPERATOR.md by FOLLOWING
#           it. Phase A extracts that document's own fenced blocks and executes
#           them, in order, against a clean target. Phase B then asserts the
#           behaviours the same document claims about the service those blocks
#           started.
#
#           WHAT THIS GUARDS: a deployment document is only true if somebody runs
#           it. Prose review cannot see a missing build step, a variable name the
#           service never reads, a command that only worked because the author
#           already had a warm tree, or a step that was deleted from the middle of
#           a list. Every one of those defects is invisible to every other gate in
#           this repository and surfaces for the first time on an operator's first
#           deploy, which is the worst possible moment. So the deployment commands
#           this script runs are not written here — they are extracted from the
#           document, and a step that needs improvisation to succeed is reported
#           as a defect in the document rather than quietly worked around.
#
#           The dashboard build output is deleted before phase A. That is what
#           makes the run a proof rather than a warm-tree illusion: if the
#           document's dashboard-build step went missing, every later step would
#           now fail. That directory is ignored by version control, so nothing
#           tracked is mutated; the run leaves a freshly built one behind. One
#           source file's mtime is touched (and only its mtime) to provoke the
#           stale-build refusal, so the working tree stays clean.
#
# Usage   : ./scripts/run-bootstrap-operator-smoke.sh
#
# Prereqs : Node >= 20.19, Corepack-managed Yarn, curl. Nothing else — every
#           dependency and every build comes from the document's own steps.
#
# Exit    : 0 — every documented step executed and every documented behaviour held
#           1 — a documented BEHAVIOUR did not hold (a service defect)
#           2 — a documented STEP could not be extracted or failed to execute
#               (a DOCUMENTATION defect — fix OPERATOR.md, not this script)
#
# ALLOWED IMPROVISATIONS
#   Every command this script issues that does NOT come out of OPERATOR.md, with
#   its justification. Anything else the run turns out to need is a gap in the
#   document and must be fixed THERE, never added here — a smoke that is free to
#   improvise past a gap proves nothing about the document it claims to validate.
#   1. Create a throwaway data directory, so the run touches no real deployment.
#   2. Select a free TCP port, so a developer's own instance cannot collide.
#   3. Generate a throwaway upload token, because a real secret must not live in a document.
#   4. Export the environment the document tells the operator to supply.
#   5. Background the long-running start step, poll until it accepts connections, and terminate it after.
#   6. Delete the dashboard build output up front, so the target is genuinely clean.
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

SERVICE_PACKAGE="packages/bootstrap-rendezvous-service"
DOC_PATH="${SERVICE_PACKAGE}/OPERATOR.md"
STEPS_MJS="${SERVICE_PACKAGE}/scripts/operator-steps.mjs"
DASHBOARD_DIST="apps/VoteTorrentDashboard/dist"
DASHBOARD_SRC="apps/VoteTorrentDashboard/src"
STALE_TRIGGER_FILE="${DASHBOARD_SRC}/main.tsx"

log () { echo "[operator-smoke] $*"; }
note () { echo "[operator-smoke]   $*"; }

# A documentation defect. Distinct exit code, and a trailer that says where the
# fix belongs, because the whole point of the split is the diagnosis.
doc_defect () {
	echo "[operator-smoke] DOCUMENTATION DEFECT: $*" >&2
	echo "[operator-smoke] The deployment procedure lives in ${DOC_PATH}. Every command this script" >&2
	echo "[operator-smoke] runs is extracted from that file, so a failure here is a defect in THAT" >&2
	echo "[operator-smoke] file — fix the document, do not work around it in this script." >&2
	exit 2
}

# ── Setup (improvisations 1, 2, 3, 4) ────────────────────────────────────────
RUN_DIR="$(mktemp -d)"
SERVICE_PID=""
SERVICE_LOG="${RUN_DIR}/service.log"
DEV_LOG="${RUN_DIR}/service-dev.log"

stop_service () {
	if [ -n "${SERVICE_PID}" ]; then
		kill "${SERVICE_PID}" 2>/dev/null || true
		wait "${SERVICE_PID}" 2>/dev/null || true
		SERVICE_PID=""
	fi
}

cleanup () {
	stop_service
	rm -rf "${RUN_DIR}"
}
trap cleanup EXIT

PORT="$(node -e 'const net=require("node:net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>process.stdout.write(String(p)))})')"
TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
BASE="http://127.0.0.1:${PORT}"

# The environment the document tells the operator to supply — including the
# source directory, because the document RECOMMENDS setting it and a smoke that
# ran in a configuration the document does not recommend would be testing
# something nobody deploys.
export BOOTSTRAP_RENDEZVOUS_UPLOAD_TOKEN="${TOKEN}"
export BOOTSTRAP_RENDEZVOUS_DATA_DIR="${RUN_DIR}/data"
export BOOTSTRAP_RENDEZVOUS_DIST_DIR="${DASHBOARD_DIST}"
export BOOTSTRAP_RENDEZVOUS_DIST_SOURCE_DIR="${DASHBOARD_SRC}"
export BOOTSTRAP_RENDEZVOUS_PORT="${PORT}"
# BOOTSTRAP_RENDEZVOUS_DEV_LOGGING is deliberately left UNSET for phase A:
# production silence is the default an operator actually gets.

port_is_free () {
	node -e '
const net = require("node:net")
const server = net.createServer()
server.once("error", () => process.exit(1))
server.listen(Number(process.argv[1]), "127.0.0.1", () => { server.close(() => process.exit(0)) })
' "${PORT}"
}

emit_step () {
	node "${STEPS_MJS}" --emit "$1"
}

wait_for_port () {
	local attempt=0
	while [ "${attempt}" -lt 30 ]; do
		if curl --silent --output /dev/null "${BASE}/" 2>/dev/null; then
			return 0
		fi
		if [ -n "${SERVICE_PID}" ] && ! kill -0 "${SERVICE_PID}" 2>/dev/null; then
			return 1
		fi
		attempt=$((attempt + 1))
		sleep 1
	done
	return 1
}

# Runs a documented step body in the FOREGROUND under a time bound, returning
# its exit status — or 124 if it had to be killed.
#
# The bound is load-bearing, not defensive padding. Legs B9 and B10 run the
# document's own start step expecting it to REFUSE; a service that instead comes
# up healthy never returns, and an unbounded run would hang the whole smoke
# instead of reporting "it did not refuse". A hang is not a refusal, so 124 is
# kept distinct from every ordinary non-zero status and is reported as a failed
# leg.
run_bounded () {
	local body="$1" log_file="$2" limit="${3:-30}"
	local pid waited=0 rc=0
	bash -euo pipefail -c "${body}" >"${log_file}" 2>&1 &
	pid=$!
	while kill -0 "${pid}" 2>/dev/null; do
		if [ "${waited}" -ge "${limit}" ]; then
			kill "${pid}" 2>/dev/null || true
			wait "${pid}" 2>/dev/null || true
			return 124
		fi
		sleep 1
		waited=$((waited + 1))
	done
	wait "${pid}" || rc=$?
	return "${rc}"
}

# Runs the document's `start` step in the background (improvisation 5). The body
# still comes from the document; only the backgrounding and the readiness poll
# are ours.
start_service () {
	local log_file="$1"
	local body
	body="$(emit_step "${START_STEP}")" || doc_defect "the start step could not be emitted"
	bash -euo pipefail -c "${body}" >>"${log_file}" 2>&1 &
	SERVICE_PID=$!
	if ! wait_for_port; then
		echo "--- ${log_file} ---" >&2
		cat "${log_file}" >&2 || true
		doc_defect "the service started by the document's start step never accepted a connection on port ${PORT}"
	fi
}

# ═════════════════════════════════════════════════════════════════════════════
# PHASE A — walk the document
# ═════════════════════════════════════════════════════════════════════════════

log "phase A — executing the deployment steps in ${DOC_PATH}"
log "run directory: ${RUN_DIR}   port: ${PORT}"

if ! STEP_ROWS="$(node "${STEPS_MJS}" --list 2>"${RUN_DIR}/list.err")"; then
	cat "${RUN_DIR}/list.err" >&2
	doc_defect "the runnable steps could not be extracted"
fi

STEP_TOTAL="$(printf '%s\n' "${STEP_ROWS}" | grep -c . || true)"
START_STEP=""
PREFLIGHT_STEP=""
BUILD_DASHBOARD_STEP=""
while IFS=$'\t' read -r step_n step_slug step_flag; do
	case "${step_slug}" in
		start) START_STEP="${step_n}" ;;
		preflight) PREFLIGHT_STEP="${step_n}" ;;
		build-dashboard) BUILD_DASHBOARD_STEP="${step_n}" ;;
	esac
done <<< "${STEP_ROWS}"

[ -n "${START_STEP}" ] || doc_defect "no step named 'start' — this script cannot run a service the document does not start"
[ -n "${PREFLIGHT_STEP}" ] || doc_defect "no step named 'preflight' — the stale-build recovery is undocumented"
[ -n "${BUILD_DASHBOARD_STEP}" ] || doc_defect "no step named 'build-dashboard' — nothing in the document builds the dashboard"

# Improvisation 6: a genuinely clean target. If the document lost its dashboard
# build step, every later step fails from here.
log "clearing ${DASHBOARD_DIST} so the target is clean"
rm -rf "${DASHBOARD_DIST}"

PHASE_A_STARTED_AT="$(date +%s)"
while IFS=$'\t' read -r step_n step_slug step_flag; do
	log "step ${step_n}/${STEP_TOTAL}: ${step_slug}${step_flag:+ (${step_flag})}"
	step_started_at="$(date +%s)"

	if [ "${step_flag}" = "background" ]; then
		start_service "${SERVICE_LOG}"
		note "started, pid ${SERVICE_PID}, accepting connections on port ${PORT}"
	else
		body="$(emit_step "${step_n}")" || doc_defect "step ${step_n} (${step_slug}) could not be emitted"
		if ! bash -euo pipefail -c "${body}" >"${RUN_DIR}/step-${step_n}.log" 2>&1; then
			echo "--- the command this step ran, verbatim from ${DOC_PATH} ---" >&2
			printf '%s\n' "${body}" >&2
			echo "--- its output ---" >&2
			cat "${RUN_DIR}/step-${step_n}.log" >&2 || true
			doc_defect "step ${step_n} (${step_slug}) exited non-zero"
		fi
	fi

	note "done in $(( $(date +%s) - step_started_at ))s"
done <<< "${STEP_ROWS}"

log "phase A complete — all ${STEP_TOTAL} documented steps executed in $(( $(date +%s) - PHASE_A_STARTED_AT ))s"

# ═════════════════════════════════════════════════════════════════════════════
# PHASE B — assert the behaviours the document claims
# ═════════════════════════════════════════════════════════════════════════════

FAILURES=0
RESULTS=()

pass () {
	echo "[operator-smoke] PASS  $1 — $2"
	RESULTS+=("PASS  $1  $2")
}

fail () {
	echo "[operator-smoke] FAIL  $1 — $2" >&2
	RESULTS+=("FAIL  $1  $2")
	FAILURES=$((FAILURES + 1))
}

# Prints the HTTP status code and writes the body to the given file.
status_of () {
	curl -sS -o "$1" -w '%{http_code}' "${@:2}" || echo "000"
}

UNKNOWN_LOOKUP_ID="operator-smoke-unknown-lookup-identifier000"
DEV_LOOKUP_ID="operator-smoke-development-logging-lookup00"
PAD="$(printf 'a%.0s' {1..900})"
OVERSIZED_BODY="{\"lookupId\":\"${UNKNOWN_LOOKUP_ID}\",\"expiresAt\":\"2030-01-01T00:00:00\",\"sealed\":{\"v\":1,\"nonce\":\"${PAD}\",\"ciphertext\":\"${PAD}\"}}"

log "phase B — asserting the behaviours ${DOC_PATH} claims"

# ── B1: one origin serves both roles ─────────────────────────────────────────
leg_b1 () {
	local label="$1" code entry entry_code entry_type
	code="$(status_of "${RUN_DIR}/index.html" "${BASE}/")"
	if [ "${code}" != "200" ]; then
		fail "${label}" "GET / answered ${code}, expected 200"
		return
	fi
	if ! grep -q 'id="root"' "${RUN_DIR}/index.html"; then
		fail "${label}" "GET / did not return the dashboard entry document"
		return
	fi
	entry="$(sed -n 's/.*<script[^>]*src="\([^"]*\)".*/\1/p' "${RUN_DIR}/index.html" | sed -n '1p')"
	if [ -z "${entry}" ]; then
		fail "${label}" "the served index.html references no entry script"
		return
	fi
	entry_code="$(status_of /dev/null "${BASE}${entry}")"
	entry_type="$(curl -sS -o /dev/null -w '%{content_type}' "${BASE}${entry}")"
	if [ "${entry_code}" != "200" ]; then
		fail "${label}" "the entry script ${entry} answered ${entry_code} on the API's own port"
		return
	fi
	case "${entry_type}" in
		*javascript*) ;;
		*) fail "${label}" "the entry script was served as ${entry_type}, not JavaScript"; return ;;
	esac
	pass "${label}" "one port serves the dashboard (${entry}, ${entry_type}) and the API"
}
leg_b1 B1

# ── B2: the upload endpoint is bearer-gated ──────────────────────────────────
anon_code="$(status_of /dev/null -X POST -H 'content-type: application/json' --data '{}' "${BASE}/bootstrap/uploads")"
auth_code="$(status_of /dev/null -X POST -H 'content-type: application/json' -H "authorization: Bearer ${TOKEN}" --data '{}' "${BASE}/bootstrap/uploads")"
if [ "${anon_code}" = "401" ] && [ "${auth_code}" != "401" ]; then
	# The positive control matters: a service that answered 401 to everything
	# would pass the first half on its own.
	pass B2 "unauthenticated upload answered 401; the same request with the token answered ${auth_code}"
else
	fail B2 "unauthenticated=${anon_code} (expected 401), authenticated=${auth_code} (expected anything but 401)"
fi

# ── B3/B4: the ceiling names its limit, and discloses nothing to strangers ───
# Run with the ceiling temporarily lowered through a restart rather than by
# generating eight megabytes. The value under test is the CONFIGURED limit,
# which is the whole point of the refusal naming it.
log "restarting with a lowered upload ceiling for B3/B4"
stop_service
export BOOTSTRAP_RENDEZVOUS_MAX_UPLOAD_BYTES=512
start_service "${SERVICE_LOG}"

big_auth_code="$(status_of "${RUN_DIR}/oversize.json" -X POST -H 'content-type: application/json' -H "authorization: Bearer ${TOKEN}" --data "${OVERSIZED_BODY}" "${BASE}/bootstrap/uploads")"
if [ "${big_auth_code}" = "413" ] && grep -q '512' "${RUN_DIR}/oversize.json"; then
	pass B3 "an oversized authenticated upload answered 413 naming the configured limit (512)"
else
	fail B3 "oversized authenticated upload answered ${big_auth_code} with body $(cat "${RUN_DIR}/oversize.json" 2>/dev/null)"
fi

# B4 must run inside the same lowered-ceiling window, or the body would not be
# oversized at all and the leg would pass vacuously.
big_anon_code="$(status_of "${RUN_DIR}/oversize-anon.json" -X POST -H 'content-type: application/json' --data "${OVERSIZED_BODY}" "${BASE}/bootstrap/uploads")"
if [ "${big_anon_code}" = "401" ] && ! grep -q '512' "${RUN_DIR}/oversize-anon.json"; then
	pass B4 "the same oversized body with no token answered 401 and disclosed no limit"
else
	fail B4 "oversized unauthenticated upload answered ${big_anon_code} with body $(cat "${RUN_DIR}/oversize-anon.json" 2>/dev/null)"
fi

log "restoring the documented upload ceiling"
stop_service
unset BOOTSTRAP_RENDEZVOUS_MAX_UPLOAD_BYTES
start_service "${SERVICE_LOG}"

# ── B5: an unknown code is a 200 answer, not an HTTP error ───────────────────
redeem_code="$(status_of "${RUN_DIR}/redeem-unknown.json" -X POST -H 'content-type: application/json' --data "{\"lookupId\":\"${UNKNOWN_LOOKUP_ID}\"}" "${BASE}/bootstrap/redemptions")"
redeem_body="$(cat "${RUN_DIR}/redeem-unknown.json")"
if [ "${redeem_code}" = "200" ] && [ "${redeem_body}" = '{"status":"unknown"}' ]; then
	pass B5 "an unknown code answered HTTP 200 with {\"status\":\"unknown\"}"
else
	fail B5 "unknown redemption answered ${redeem_code} with body ${redeem_body} (a non-2xx refusal would break the shipped client)"
fi

# ── B6: the API prefix is reserved, and never falls through to the dashboard ──
unrouted_code="$(status_of "${RUN_DIR}/unrouted.json" -X POST -H 'content-type: application/json' --data '{}' "${BASE}/bootstrap/nope")"
if [ "${unrouted_code}" = "404" ] && grep -q '"error"' "${RUN_DIR}/unrouted.json" && ! grep -q 'id="root"' "${RUN_DIR}/unrouted.json"; then
	pass B6 "an unmatched API path answered a JSON 404 and not the dashboard"
else
	fail B6 "unmatched API path answered ${unrouted_code} with body $(cat "${RUN_DIR}/unrouted.json" 2>/dev/null)"
fi

# ── B7: production is silent, and that is the documented default ─────────────
if [ -s "${SERVICE_LOG}" ]; then
	fail B7 "the production-mode log is not empty: $(head -5 "${SERVICE_LOG}")"
else
	pass B7 "production emitted nothing across every request above — the documented default and its accepted cost"
fi

# ── B8: development logging, and what it structurally cannot carry ───────────
log "restarting with development logging for B8"
stop_service
export BOOTSTRAP_RENDEZVOUS_DEV_LOGGING=1
start_service "${DEV_LOG}"
status_of /dev/null -X POST -H 'content-type: application/json' --data "{\"lookupId\":\"${DEV_LOOKUP_ID}\"}" "${BASE}/bootstrap/redemptions" >/dev/null

request_lines="$(grep -c 'bootstrap-rendezvous request ' "${DEV_LOG}" || true)"
redeem_lines="$(grep -c 'bootstrap-rendezvous request route=redeem ' "${DEV_LOG}" || true)"
if [ "${request_lines}" -lt 1 ]; then
	# The positive control: an empty log must never pass this leg.
	fail B8 "development logging produced no request line at all"
elif [ "${redeem_lines}" != "1" ]; then
	fail B8 "expected exactly one redemption line, found ${redeem_lines}"
elif ! grep -qE '^bootstrap-rendezvous request route=redeem outcome=unknown latency_ms=[0-9]+$' "${DEV_LOG}"; then
	fail B8 "the redemption line does not match the documented format: $(grep 'route=redeem' "${DEV_LOG}")"
elif grep -q "${DEV_LOOKUP_ID}" "${DEV_LOG}"; then
	fail B8 "the development log carries the look-up identifier"
elif grep -q '127.0.0.1' "${DEV_LOG}"; then
	fail B8 "the development log carries a client address"
else
	pass B8 "one redemption produced one documented request line carrying neither the look-up identifier nor a client address"
fi

stop_service
unset BOOTSTRAP_RENDEZVOUS_DEV_LOGGING

# ── B9: the non-loopback refusal ─────────────────────────────────────────────
start_body="$(emit_step "${START_STEP}")" || doc_defect "the start step could not be emitted"
# Exported and unset explicitly rather than as a `VAR=value func` prefix: bash
# leaves such an assignment in effect after a FUNCTION returns, which would leak
# a non-loopback bind host into leg B10 and make its refusal the wrong one.
export BOOTSTRAP_RENDEZVOUS_BIND_HOST=0.0.0.0
set +e
run_bounded "${start_body}" "${RUN_DIR}/b9.log"
b9_status=$?
set -e
unset BOOTSTRAP_RENDEZVOUS_BIND_HOST
if [ "${b9_status}" -eq 124 ]; then
	fail B9 "the start step did not refuse a non-loopback bind host — it kept running and had to be killed"
elif [ "${b9_status}" -ne 0 ] &&
	grep -q 'refusing to bind non-loopback host' "${RUN_DIR}/b9.log" &&
	grep -q 'BOOTSTRAP_RENDEZVOUS_ALLOW_NON_LOOPBACK' "${RUN_DIR}/b9.log"; then
	pass B9 "a non-loopback bind host was refused at startup, naming the opt-in variable"
else
	fail B9 "exit ${b9_status}, log: $(cat "${RUN_DIR}/b9.log" 2>/dev/null)"
fi

# ── B10: the stale-build trap, proved and then recovered ─────────────────────
# `touch` changes an mtime and nothing else, so `git status` stays clean.
log "provoking the stale-build refusal by touching ${STALE_TRIGGER_FILE}"
touch "${STALE_TRIGGER_FILE}"

b10_ok=1
b10_reason=""

preflight_body="$(emit_step "${PREFLIGHT_STEP}")" || doc_defect "the preflight step could not be emitted"
set +e
run_bounded "${preflight_body}" "${RUN_DIR}/b10-preflight-stale.log"
b10_preflight_status=$?
set -e
if [ "${b10_preflight_status}" -eq 0 ] || ! grep -q 'BOOTSTRAP_RENDEZVOUS_ALLOW_STALE_DIST' "${RUN_DIR}/b10-preflight-stale.log"; then
	b10_ok=0
	b10_reason="the documented preflight accepted a stale build (exit ${b10_preflight_status})"
fi

if [ "${b10_ok}" -eq 1 ]; then
	set +e
	run_bounded "${start_body}" "${RUN_DIR}/b10-start-stale.log"
	b10_start_status=$?
	set -e
	if [ "${b10_start_status}" -eq 0 ] || [ "${b10_start_status}" -eq 124 ]; then
		b10_ok=0
		b10_reason="the service started against a stale build instead of refusing (exit ${b10_start_status})"
	elif ! grep -q 'event=config-invalid' "${RUN_DIR}/b10-start-stale.log"; then
		b10_ok=0
		b10_reason="the refusal did not carry event=config-invalid: $(cat "${RUN_DIR}/b10-start-stale.log")"
	elif ! port_is_free; then
		b10_ok=0
		b10_reason="port ${PORT} is not free — the refusing process bound it anyway"
	fi
fi

if [ "${b10_ok}" -eq 1 ]; then
	log "recovering exactly as the document says: rebuild, preflight, restart"
	rebuild_body="$(emit_step "${BUILD_DASHBOARD_STEP}")" || doc_defect "the build-dashboard step could not be emitted"
	if ! bash -euo pipefail -c "${rebuild_body}" >"${RUN_DIR}/b10-rebuild.log" 2>&1; then
		cat "${RUN_DIR}/b10-rebuild.log" >&2
		doc_defect "the document's build-dashboard step failed during the recovery"
	fi
	set +e
	run_bounded "${preflight_body}" "${RUN_DIR}/b10-preflight-clean.log"
	b10_recovered_status=$?
	set -e
	if [ "${b10_recovered_status}" -ne 0 ]; then
		b10_ok=0
		b10_reason="the preflight still refused after the documented rebuild: $(cat "${RUN_DIR}/b10-preflight-clean.log")"
	fi
fi

if [ "${b10_ok}" -eq 1 ]; then
	pass B10 "a stale build was refused by name, the port was never bound, and the documented rebuild restored it"
	start_service "${SERVICE_LOG}"
	leg_b1 B10-reserve
else
	fail B10 "${b10_reason}"
fi

# ═════════════════════════════════════════════════════════════════════════════
# Report
# ═════════════════════════════════════════════════════════════════════════════

echo
log "──────────────────────────── summary ────────────────────────────"
log "phase A: ${STEP_TOTAL}/${STEP_TOTAL} documented steps executed"
for result in "${RESULTS[@]}"; do
	log "${result}"
done
echo

if [ "${FAILURES}" -eq 0 ]; then
	log "EXIT 0 — every step in ${DOC_PATH} ran, and every behaviour it claims held."
	exit 0
fi

log "EXIT 1 — ${FAILURES} documented behaviour(s) did not hold. The steps all ran, so this is a"
log "         service defect rather than a documentation defect; exit 2 is the documentation case."
exit 1
