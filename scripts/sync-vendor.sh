#!/usr/bin/env bash
#
# sync-vendor.sh
#
# Purpose  : Maintainer-only re-sync of vendored @serfab packages from the
#            ../sereus sibling working tree. Rebuilds dist/ for each @serfab
#            package and copies the result into vendor/@serfab/<pkg>/.
#            NOT needed for a clean-clone build — vendor/dist is committed.
#
# Usage    : ./scripts/sync-vendor.sh
#
# Prerequisites:
#   - ../sereus sibling must be present with connectionGater forward applied
#   - nvm must be available with Node 22
#   - esbuild must be available via npx
#   - tsc must be available in the cadre-core package (via the sereus tree)
#
# Exit codes:
#   0  — all packages synced; vendor/@serfab/ is up-to-date
#   1  — a prerequisite check or build/copy step failed
#
# After running:
#   Update vendor/VENDOR.md source-commit line to the new sereus HEAD:
#   git -C ../sereus rev-parse HEAD
#

set -euo pipefail

# Anchor cwd to repo root so all relative paths work regardless of invocation dir.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# ── NODE + NVM SETUP ──────────────────────────────────────────────────────────

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "${NVM_DIR}/nvm.sh" ]; then
  # shellcheck source=/dev/null
  \. "${NVM_DIR}/nvm.sh"
else
  echo "[sync-vendor] ERROR: nvm not found at ${NVM_DIR}/nvm.sh — install nvm or set NVM_DIR" >&2
  exit 1
fi

# Resolve the Node 22 binary path. `nvm which 22` gives the full path so the
# binary can be used in backgrounded subshells without re-sourcing nvm.
NODE22=$(nvm which 22 2>/dev/null || true)
if [ -z "${NODE22}" ] || [ ! -x "${NODE22}" ]; then
  echo "[sync-vendor] ERROR: Node 22 not found via 'nvm which 22' — run 'nvm install 22'" >&2
  exit 1
fi

echo "[sync-vendor] Using Node 22 from: ${NODE22}"

# ── STEP 1: GUARD — ../sereus sibling must be present ────────────────────────

SEREUS_ROOT="../sereus"

echo "[sync-vendor] Step 1: checking for ${SEREUS_ROOT} sibling ..."
if [ ! -d "${SEREUS_ROOT}" ]; then
  echo "[sync-vendor] Step 1 FAIL: ../sereus sibling not found at ${SEREUS_ROOT}" >&2
  echo "[sync-vendor] This script is a maintainer-only operation requiring the sereus working tree." >&2
  echo "[sync-vendor] A clean-clone build does NOT require this script — vendor/dist is committed." >&2
  exit 1
fi
echo "[sync-vendor] Step 1 PASS: ${SEREUS_ROOT} found"

# ── STEP 2: BUILD + COPY strand-proto and quereus-plugin-sereus ──────────────
#
# These packages ship without a committed dist in the sereus monorepo.
# Build via esbuild (ESM, node platform) then copy dist/ + package.json.

for PKG in strand-proto quereus-plugin-sereus; do
  echo "[sync-vendor] Step 2: building @serfab/${PKG} with esbuild ..."
  (
    cd "${SEREUS_ROOT}/packages/${PKG}"
    npx esbuild src/*.ts --outdir=dist --format=esm --platform=node
  )
  echo "[sync-vendor] Step 2 PASS: @serfab/${PKG} esbuild complete"

  echo "[sync-vendor] Step 2: copying @serfab/${PKG} dist/ + package.json into vendor/ ..."
  rm -rf "vendor/@serfab/${PKG}/dist"
  cp -r "${SEREUS_ROOT}/packages/${PKG}/dist" "vendor/@serfab/${PKG}/dist"
  cp "${SEREUS_ROOT}/packages/${PKG}/package.json" "vendor/@serfab/${PKG}/package.json"
  echo "[sync-vendor] Step 2 PASS: @serfab/${PKG} synced"
done

# ── STEP 3: BUILD + COPY cadre-core ──────────────────────────────────────────
#
# cadre-core uses tsc --emitDeclarationOnly to emit the missing .d.ts files.
# The .js dist files are produced by the package's own build (already present
# in the sereus tree once built); emitDeclarationOnly adds the types on top.

echo "[sync-vendor] Step 3: building @serfab/cadre-core .d.ts with tsc ..."
(
  cd "${SEREUS_ROOT}/packages/cadre-core"
  tsc -p tsconfig.build.json --emitDeclarationOnly --declaration
)
echo "[sync-vendor] Step 3 PASS: @serfab/cadre-core tsc --emitDeclarationOnly complete"

echo "[sync-vendor] Step 3: copying @serfab/cadre-core dist/ + package.json into vendor/ ..."
rm -rf "vendor/@serfab/cadre-core/dist"
cp -r "${SEREUS_ROOT}/packages/cadre-core/dist" "vendor/@serfab/cadre-core/dist"
cp "${SEREUS_ROOT}/packages/cadre-core/package.json" "vendor/@serfab/cadre-core/package.json"
echo "[sync-vendor] Step 3 PASS: @serfab/cadre-core synced"

# ── STEP 4: connectionGater CANARY (D-04) ────────────────────────────────────
#
# The connectionGater forward (spike 011) is a source-level edit in the sereus
# working tree that MUST travel with every re-synced cadre-core dist. If the
# sereus tree does not have the edit applied, the vendored dist will be missing
# the forward and libp2p connections will fail at runtime.

echo "[sync-vendor] Step 4: asserting connectionGater canary in re-synced cadre-core dist ..."
CADRE_DIST="vendor/@serfab/cadre-core/dist"
if grep -rl --include='*.js' "connectionGater" "${CADRE_DIST}" | grep -qE '(cadre-node|strand-instance-manager)\.js$'; then
  echo "[sync-vendor] Step 4 PASS: connectionGater present in ${CADRE_DIST}"
else
  echo "[sync-vendor] Step 4 FAIL: connectionGater NOT found in ${CADRE_DIST} after sync." >&2
  echo "[sync-vendor] The sereus working tree must have the connectionGater forward applied before re-syncing." >&2
  echo "[sync-vendor] See vendor/VENDOR.md for the source-commit + rebuild steps." >&2
  exit 1
fi

# ── STEP 5: REMINDER — update VENDOR.md source-commit line ──────────────────

SEREUS_HEAD=$(git -C "${SEREUS_ROOT}" rev-parse HEAD 2>/dev/null || echo "unknown")
echo "[sync-vendor] Step 5: sereus HEAD is ${SEREUS_HEAD}"
echo "[sync-vendor] Step 5: REMINDER — update vendor/VENDOR.md source-commit lines to ${SEREUS_HEAD}"
echo "[sync-vendor]   Edit the 3 @serfab rows in the 'Source commits' table."

# ── FINAL VERDICT ─────────────────────────────────────────────────────────────

echo "[sync-vendor] ========== VENDOR SYNC: COMPLETE =========="
exit 0
