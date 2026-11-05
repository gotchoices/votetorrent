#!/usr/bin/env bash
#
# check-dist-freshness.sh
#
# Purpose : D-16 (47-01 Task 4) — fail closed when the BUILT vote-engine package
#           disagrees with the canonical schema source.
#
# Why this exists (the hole the other D-16 locks do not cover):
#   schema-type-regression.spec.ts already asserts that votetorrent.qsql is
#   byte-identical to packages/vote-engine/src/database/schema-sql.ts. That is
#   necessary but NOT sufficient. The React Native app resolves
#   @votetorrent/vote-engine through package.json `main`/`exports`, which both
#   point at dist/ — so Metro bundles the BUILT package and never reads src/.
#
#   On 2026-08-04 an on-device re-attach proof passed every existing lock,
#   emitted `FULL-CHAIN VERDICT: PASS`, and was VACUOUS: dist/database/schema-sql.js
#   was a day-stale build containing zero occurrences of the two tables under test,
#   so the proof exercised the OLD schema. Two things make this failure mode
#   invisible without a dedicated guard:
#     - `--reset-cache` does not help. The stale input is a file on disk, not
#       Metro's transform cache.
#     - dist/ is gitignored, so a stale build never shows up in `git status`.
#
# Exit codes:
#   0 — the built schema matches votetorrent.qsql (fresh), OR no build is present
#       (see SKIP rationale below)
#   1 — a build IS present and disagrees with votetorrent.qsql (stale)
#
# SKIP rationale: an ABSENT dist is not this guard's failure mode. Metro fails
# loudly at module resolution when the package is unbuilt, so an absent build
# cannot be silently served. Skipping keeps this guard usable in a clean
# checkout and in CI (where the suite runs from src via ts-node).

set -euo pipefail

# Anchor to the repo root so every path below is repo-root-relative and the
# script works when invoked from any directory (mirrors run-vtest02.sh).
cd "$(dirname "${BASH_SOURCE[0]}")/.."

QSQL_PATH="packages/vote-core/schema/votetorrent.qsql"
DIST_PATH="packages/vote-engine/dist/database/schema-sql.js"
REBUILD_CMD="yarn --cwd packages/vote-engine build"

if [ ! -f "${QSQL_PATH}" ]; then
  echo "[dist-check] FAIL: canonical schema source not found at ${QSQL_PATH}" >&2
  exit 1
fi

if [ ! -f "${DIST_PATH}" ]; then
  echo "[dist-check] SKIP: no build present at ${DIST_PATH} — nothing stale can be served."
  echo "[dist-check]       (An unbuilt package fails loudly at Metro module resolution.)"
  exit 0
fi

# Compare the schema the BUILT package actually exports against the .qsql source.
# Dynamic-import the module rather than regex-scraping the emitted JS, so this
# check cannot rot against a codegen/bundler format change.
node --input-type=module -e '
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const qsqlPath = process.argv[1];
const distPath = process.argv[2];

const expected = readFileSync(qsqlPath, "utf8");
const mod = await import(pathToFileURL(distPath).href);
const actual = mod.VOTETORRENT_SCHEMA_SQL;

if (typeof actual !== "string") {
  console.error(`[dist-check] FAIL: ${distPath} does not export a string VOTETORRENT_SCHEMA_SQL`);
  process.exit(1);
}
if (actual !== expected) {
  console.error("[dist-check] FAIL: the BUILT vote-engine schema does not match votetorrent.qsql.");
  console.error(`[dist-check]   source: ${qsqlPath} (${expected.length} chars)`);
  console.error(`[dist-check]   built : ${distPath} (${actual.length} chars)`);
  console.error("[dist-check] The app bundles dist/, NOT src/ — so an on-device run would");
  console.error("[dist-check] silently exercise the OLD schema and report a VACUOUS PASS.");
  process.exit(1);
}
' "${QSQL_PATH}" "${DIST_PATH}" || {
  echo "[dist-check] Rebuild with: ${REBUILD_CMD}" >&2
  exit 1
}

echo "[dist-check] OK: built vote-engine schema matches ${QSQL_PATH}"
