#!/usr/bin/env bash
#
# verify-vendoring.sh
#
# Purpose  : Phase 27 acceptance gate — PORT-03 / SC2 success criteria.
#            Simulates absence of ../sereus sibling (clean-clone condition), runs
#            yarn install + Metro android bundle, and asserts:
#              (a) exit 0 for both steps;
#              (b) @serfab/cadre-core resolves to the in-repo vendor/ copy (not a
#                  sibling portal: path);
#              (c) connectionGater forward is present in the vendored cadre-core dist.
#            Proves the repo builds reproducibly from a clean clone with no ../sereus
#            working tree present.
#
# Usage    : ./scripts/verify-vendoring.sh [--skip-install]
#
#   --skip-install  Skip Step 1 (yarn install) when the install is known-good and
#                   you only need to verify bundle + resolution assertions.
#
# Prerequisites:
#   - nvm must be available with Node 22
#
# Exit codes:
#   0  — all gates pass; VENDORING GATE: PASS emitted
#   1  — one or more gates fail; the failing step is printed to stderr
#
# Failure modes:
#   sereus-hide FAIL  — could not rename ../sereus (permission or path issue)
#   Step 1 FAIL       — yarn install exited non-zero
#   Step 2 FAIL       — Metro bundle exited non-zero, or bundle missing/empty
#   Step 3a FAIL      — @serfab/cadre-core does not resolve to vendor/ copy
#   Step 3b FAIL      — connectionGater not present in vendored cadre-core dist
#                       (re-vendor from correct sereus tree with connectionGater applied)
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
      echo "[verify-vendoring] ERROR: unknown flag: ${arg}" >&2
      echo "[verify-vendoring] Usage: $0 [--skip-install]" >&2
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
  echo "[verify-vendoring] ERROR: nvm not found at ${NVM_DIR}/nvm.sh — install nvm or set NVM_DIR" >&2
  exit 1
fi

# Resolve the Node 22 binary path in the foreground. `nvm exec 22 ... &` fails when
# backgrounded; resolve via `nvm which 22` then use the explicit binary directly.
NODE22=$(nvm which 22 2>/dev/null || true)
if [ -z "${NODE22}" ] || [ ! -x "${NODE22}" ]; then
  echo "[verify-vendoring] ERROR: Node 22 not found via 'nvm which 22' — run 'nvm install 22'" >&2
  exit 1
fi

echo "[verify-vendoring] Using Node 22 from: ${NODE22}"
echo "[verify-vendoring] Active node: $(node --version)"

# ── CLEAN-CLONE SIMULATION: HIDE ../sereus ────────────────────────────────────
#
# SC2 demands the build not depend on the ../sereus working tree. Temporarily rename
# it so Yarn cannot resolve any portal: ../sereus paths. An EXIT trap restores the
# original name on any exit path (PASS, FAIL, or interrupt).

SEREUS_SIBLING="$(cd .. && pwd)/sereus"
SEREUS_BAK="${SEREUS_SIBLING}.verify-vendoring.bak"
SEREUS_HIDDEN=0

restore_sereus() {
  if [ "${SEREUS_HIDDEN}" -eq 1 ] && [ -d "${SEREUS_BAK}" ]; then
    mv "${SEREUS_BAK}" "${SEREUS_SIBLING}"
    echo "[verify-vendoring] ../sereus sibling restored (EXIT trap)"
  fi
}
trap restore_sereus EXIT

if [ -d "${SEREUS_SIBLING}" ]; then
  echo "[verify-vendoring] Hiding ../sereus sibling for clean-clone simulation ..."
  mv "${SEREUS_SIBLING}" "${SEREUS_BAK}"
  SEREUS_HIDDEN=1
  echo "[verify-vendoring] ../sereus hidden as $(basename "${SEREUS_BAK}") for the duration of this run"
else
  echo "[verify-vendoring] ../sereus not present — already simulating clean-clone conditions"
fi

# ── STEP 1: YARN INSTALL ──────────────────────────────────────────────────────

if [ "${SKIP_INSTALL}" -eq 1 ]; then
  echo "[verify-vendoring] Step 1: yarn install — SKIPPED (--skip-install)"
else
  echo "[verify-vendoring] Step 1: yarn install ..."
  if yarn install --immutable; then
    echo "[verify-vendoring] Step 1 PASS: yarn install exited 0"
  else
    echo "[verify-vendoring] Step 1 FAIL: yarn install exited non-zero" >&2
    echo "[verify-vendoring] ========== VENDORING GATE: FAIL ==========" >&2
    exit 1
  fi
fi

# ── STEP 2: METRO ANDROID BUNDLE ─────────────────────────────────────────────
#
# Run under Node 22 (portal wiring was validated under nvm 22.15.0; Node < 20.19
# may fail to resolve portal: deps). Switch the active node for this subshell
# by invoking `nvm use 22` inside a bash -c so the parent shell's PATH is not
# permanently mutated.

echo "[verify-vendoring] Step 2: Metro android bundle (under Node 22) ..."
BUNDLE_OUT=/tmp/vt-vendor.bundle

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
  echo "[verify-vendoring] Step 2 FAIL: Metro android bundle exited ${BUNDLE_EXIT}" >&2
  echo "[verify-vendoring] ========== VENDORING GATE: FAIL ==========" >&2
  exit 1
fi

# A zero exit with no bundle artifact is a false PASS — treat a missing/empty
# bundle as a Step 2 failure (T-27-05 guard).
if [ ! -s "${BUNDLE_OUT}" ]; then
  echo "[verify-vendoring] Step 2 FAIL: Metro exited 0 but no bundle was written to ${BUNDLE_OUT}" >&2
  echo "[verify-vendoring] ========== VENDORING GATE: FAIL ==========" >&2
  exit 1
fi

# Count the number of Metro module definitions (__d() calls) as bundle evidence.
MODULE_COUNT=$(grep -c '__d(' "${BUNDLE_OUT}" || true)
echo "[verify-vendoring] Step 2 PASS: Metro bundle exited 0 (module count: ${MODULE_COUNT} __d() defines)"

# ── STEP 3a: RESOLUTION ASSERTION ────────────────────────────────────────────
#
# Assert @serfab/cadre-core resolves to the in-repo vendor/ copy, not a sibling
# portal: path. This is the D-05 assertion that proves SC2 (T-27-04 mitigation).

echo "[verify-vendoring] Step 3a: @serfab/cadre-core resolution check ..."

CADRE_RESOLUTION=$(yarn why @serfab/cadre-core 2>/dev/null || true)
if echo "${CADRE_RESOLUTION}" | grep -q "vendor/@serfab/cadre-core"; then
  echo "[verify-vendoring] Step 3a PASS: @serfab/cadre-core resolves to vendor/ copy"
else
  echo "[verify-vendoring] Step 3a FAIL: @serfab/cadre-core does NOT resolve to vendor/@serfab/cadre-core" >&2
  echo "[verify-vendoring]   yarn why output:" >&2
  echo "${CADRE_RESOLUTION}" | while IFS= read -r line; do
    echo "[verify-vendoring]     ${line}" >&2
  done
  echo "[verify-vendoring] ========== VENDORING GATE: FAIL ==========" >&2
  exit 1
fi

# ── STEP 3b: connectionGater CANARY (D-04) ───────────────────────────────────
#
# Assert the connectionGater forward is baked into the vendored cadre-core dist.
# This is the D-04 canary — if it is absent, the vendor/ was copied from a sereus
# tree that did not have the connectionGater edit applied (T-27-06 mitigation).

echo "[verify-vendoring] Step 3b: connectionGater canary in vendor/@serfab/cadre-core/dist ..."

CADRE_DIST="vendor/@serfab/cadre-core/dist"
if grep -rl --include='*.js' "connectionGater" "${CADRE_DIST}" | grep -qE '(cadre-node|strand-instance-manager)\.js$'; then
  echo "[verify-vendoring] Step 3b PASS: connectionGater present in ${CADRE_DIST}"
else
  echo "[verify-vendoring] Step 3b FAIL: connectionGater NOT found in ${CADRE_DIST}" >&2
  echo "[verify-vendoring]   Re-vendor from the correct sereus tree (with connectionGater forward applied)." >&2
  echo "[verify-vendoring]   Run: ./scripts/sync-vendor.sh after applying the connectionGater edit to ../sereus." >&2
  echo "[verify-vendoring] ========== VENDORING GATE: FAIL ==========" >&2
  exit 1
fi

# ── FINAL VERDICT ─────────────────────────────────────────────────────────────

echo "[verify-vendoring] ========== VENDORING GATE: PASS =========="
exit 0
