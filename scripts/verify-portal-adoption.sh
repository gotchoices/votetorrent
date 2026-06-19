#!/usr/bin/env bash
#
# verify-portal-adoption.sh
#
# Purpose  : Phase 25 acceptance gate — PORT-01 / PORT-02 success criteria.
#            Runs yarn install + Metro android bundle (SC1) + the vote-engine suite
#            (SC2, 0 failing) + a published/portal boundary sanity check (D-04).
#            Designed to be reusable by Phase 27's reproducibility-from-clean-clone
#            proof (--skip-install fast re-run path included).
#
# Usage    : ./scripts/verify-portal-adoption.sh [--skip-install]
#
#   --skip-install  Skip Step 1 (yarn install) when the install is known-good and
#                   you only need to verify bundle + test + boundary. Phase 27 uses
#                   the full path (no flag) for a clean-clone proof.
#
# Prerequisites:
#   - nvm must be available with Node 22 (portal install requires Node >= 20.19)
#   - The sibling ../sereus and ../Optimystic working trees must be present
#
# Exit codes:
#   0  — all gates pass; PORTAL ADOPTION GATE: PASS emitted
#   1  — one or more gates fail; the failing step is printed to stderr
#
# Failure modes:
#   Step 1 FAIL  — yarn install exited non-zero (check Node version / portal trees)
#   Step 2 FAIL  — Metro bundle exited non-zero (check metro.config.js / portal dist)
#   Step 3 FAIL  — vote-engine suite has failing tests (see /tmp/vt-test.log)
#   Step 4 FAIL  — boundary violation detected (yarn lint:peers or quereus portal: leak)
#

set -euo pipefail

# Anchor cwd to repo root so all relative paths work regardless of invocation dir.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# ── FLAG PARSING ──────────────────────────────────────────────────────────────

SKIP_INSTALL=0
for arg in "$@"; do
  case "${arg}" in
    --skip-install) SKIP_INSTALL=1 ;;
    *)
      echo "[verify-portal-adoption] ERROR: unknown flag: ${arg}" >&2
      echo "[verify-portal-adoption] Usage: $0 [--skip-install]" >&2
      exit 1
      ;;
  esac
done

# ── NODE + NVM SETUP ──────────────────────────────────────────────────────────

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "${NVM_DIR}/nvm.sh" ]; then
  # shellcheck source=/dev/null
  \. "${NVM_DIR}/nvm.sh"
else
  echo "[verify-portal-adoption] ERROR: nvm not found at ${NVM_DIR}/nvm.sh — install nvm or set NVM_DIR" >&2
  exit 1
fi

# Resolve the Node 22 binary path in the foreground. `nvm exec 22 ... &` fails when
# backgrounded; resolve via `nvm which 22` then use the explicit binary directly.
NODE22=$(nvm which 22 2>/dev/null || true)
if [ -z "${NODE22}" ] || [ ! -x "${NODE22}" ]; then
  echo "[verify-portal-adoption] ERROR: Node 22 not found via 'nvm which 22' — run 'nvm install 22'" >&2
  exit 1
fi

# D-05 soft gate: warn if active node < 20.19, do NOT exit (no hard gate).
NODE_VER=$(node --version 2>/dev/null | sed 's/^v//' || echo "0.0.0")
NODE_MAJOR=$(echo "${NODE_VER}" | cut -d. -f1)
NODE_MINOR=$(echo "${NODE_VER}" | cut -d. -f2)
# Compare: warn if major < 20, or major == 20 and minor < 19
if [ "${NODE_MAJOR}" -lt 20 ] || { [ "${NODE_MAJOR}" -eq 20 ] && [ "${NODE_MINOR}" -lt 19 ]; }; then
  echo "[verify-portal-adoption] WARNING: active Node ${NODE_VER} is below 20.19 (required for portal install); run: nvm use 22.15.0" >&2
fi

echo "[verify-portal-adoption] Using Node 22 from: ${NODE22}"
echo "[verify-portal-adoption] Active node: $(node --version)"

# ── STEP 1: YARN INSTALL (SC1) ────────────────────────────────────────────────

if [ "${SKIP_INSTALL}" -eq 1 ]; then
  echo "[verify-portal-adoption] Step 1: yarn install — SKIPPED (--skip-install)"
else
  echo "[verify-portal-adoption] Step 1: yarn install ..."
  if yarn install; then
    echo "[verify-portal-adoption] Step 1 PASS: yarn install exited 0"
  else
    echo "[verify-portal-adoption] Step 1 FAIL: yarn install exited non-zero" >&2
    echo "[verify-portal-adoption] ========== PORTAL ADOPTION GATE: FAIL ==========" >&2
    exit 1
  fi
fi

# ── STEP 2: METRO ANDROID BUNDLE (SC1) ───────────────────────────────────────
#
# Run under Node 22 (portal wiring was validated under nvm 22.15.0; Node < 20.19
# may fail to resolve portal: deps). We switch the active node for this subshell
# by invoking `nvm use 22` inside a bash -c so the parent shell's PATH is not
# permanently mutated (avoids interference with step 3 which uses the yarn shim).

echo "[verify-portal-adoption] Step 2: Metro android bundle (under Node 22) ..."
BUNDLE_OUT=/tmp/vt-portal.bundle

BUNDLE_EXIT=0
bash -c "
  export NVM_DIR=\"${NVM_DIR}\"
  . \"${NVM_DIR}/nvm.sh\"
  nvm use 22 >/dev/null 2>&1
  yarn workspace votetorrent-authority react-native bundle \
    --platform android \
    --dev false \
    --entry-file index.js \
    --bundle-output \"${BUNDLE_OUT}\" \
    --reset-cache
" || BUNDLE_EXIT=$?

if [ "${BUNDLE_EXIT}" -ne 0 ]; then
  echo "[verify-portal-adoption] Step 2 FAIL: Metro android bundle exited ${BUNDLE_EXIT}" >&2
  echo "[verify-portal-adoption] ========== PORTAL ADOPTION GATE: FAIL ==========" >&2
  exit 1
fi

# Count the number of Metro module definitions (__d() calls) as bundle evidence.
if [ -f "${BUNDLE_OUT}" ]; then
  MODULE_COUNT=$(grep -c '__d(' "${BUNDLE_OUT}" 2>/dev/null || echo "0")
  echo "[verify-portal-adoption] Step 2 PASS: Metro bundle exited 0 (module count: ${MODULE_COUNT} __d() defines)"
else
  echo "[verify-portal-adoption] Step 2 PASS: Metro bundle exited 0 (bundle written to ${BUNDLE_OUT})"
fi

# ── STEP 3: VOTE-ENGINE SUITE (SC2, D-08) ────────────────────────────────────
#
# Gate: 0 failing (count-agnostic — D-08: do NOT pin an exact passing total).
# The passing count is captured at execution time for the SUMMARY + runbook.

echo "[verify-portal-adoption] Step 3: vote-engine suite ..."
TEST_LOG=/tmp/vt-test.log

(
  cd packages/vote-engine
  yarn test 2>&1 | tee "${TEST_LOG}"
)

# Parse Mocha summary lines from the tee output.
PASSING=$(grep -Eo "[0-9]+ passing" "${TEST_LOG}" | head -1 || true)
# Look for a non-zero failing count. Mocha emits "  N failing" with leading spaces.
FAILING=$(grep -E "^\s+[0-9]+ failing" "${TEST_LOG}" || true)

if [ -n "${FAILING}" ]; then
  echo "[verify-portal-adoption] Step 3 FAIL: vote-engine suite has failures: ${FAILING}" >&2
  echo "[verify-portal-adoption] See ${TEST_LOG} for full output" >&2
  echo "[verify-portal-adoption] ========== PORTAL ADOPTION GATE: FAIL ==========" >&2
  exit 1
fi

if [ -z "${PASSING}" ]; then
  echo "[verify-portal-adoption] Step 3 FAIL: could not parse a passing count from Mocha output — suite may not have run" >&2
  echo "[verify-portal-adoption] See ${TEST_LOG} for full output" >&2
  echo "[verify-portal-adoption] ========== PORTAL ADOPTION GATE: FAIL ==========" >&2
  exit 1
fi

echo "[verify-portal-adoption] Step 3 PASS: vote-engine suite ${PASSING}, 0 failing"

# ── STEP 4: PUBLISHED/PORTAL BOUNDARY (SC1, D-04) ────────────────────────────
#
# Two checks:
#   4a. Run yarn lint:peers (the existing Phase-13 guard) — exits non-zero on unexpected
#       peer-boundary violations.
#   4b. Grep apps/VoteTorrentAuthority/package.json to assert @quereus/quereus and both
#       quereus-plugin-* entries do NOT carry a portal: prefix — they must stay published.

echo "[verify-portal-adoption] Step 4: published/portal boundary check ..."

# 4a — Phase-13 lint:peers guard.
if yarn lint:peers; then
  echo "[verify-portal-adoption] Step 4a PASS: yarn lint:peers exited 0 (no unexpected peer mismatches)"
else
  echo "[verify-portal-adoption] Step 4a FAIL: yarn lint:peers exited non-zero — unexpected peer boundary violation" >&2
  echo "[verify-portal-adoption] ========== PORTAL ADOPTION GATE: FAIL ==========" >&2
  exit 1
fi

# 4b — Assert no portal: prefix on the quereus / quereus-plugin lines in the app manifest.
APP_PKG=apps/VoteTorrentAuthority/package.json
QUEREUS_PORTAL_LEAK=$(grep -E '"@quereus/quereus"|"@optimystic/quereus-plugin' "${APP_PKG}" | grep "portal:" || true)
if [ -n "${QUEREUS_PORTAL_LEAK}" ]; then
  echo "[verify-portal-adoption] Step 4b FAIL: quereus or quereus-plugin deps carry a portal: prefix — boundary violated!" >&2
  echo "[verify-portal-adoption]   Offending lines:" >&2
  echo "${QUEREUS_PORTAL_LEAK}" | while IFS= read -r line; do
    echo "[verify-portal-adoption]     ${line}" >&2
  done
  echo "[verify-portal-adoption] ========== PORTAL ADOPTION GATE: FAIL ==========" >&2
  exit 1
fi
echo "[verify-portal-adoption] Step 4b PASS: @quereus/quereus + quereus-plugin-* have no portal: prefix (boundary intact)"

echo "[verify-portal-adoption] Step 4 PASS: boundary check complete"

# ── FINAL VERDICT ─────────────────────────────────────────────────────────────

echo "[verify-portal-adoption] ========== PORTAL ADOPTION GATE: PASS =========="
exit 0
