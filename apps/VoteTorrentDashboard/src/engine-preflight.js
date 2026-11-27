/**
 * Engine preflight — proves the browser build actually reaches
 * `@votetorrent/vote-engine/browser` (50-01's browser-safe subpath export).
 *
 * Deliberately a NAMESPACE import whose key count is rendered by the caller
 * (`src/main.tsx`). A plain named import of an unused symbol would be tree-shaken
 * away by Vite/Rollup and would prove nothing about the real module graph. The
 * namespace-plus-`Object.keys` shape below cannot be shaken, so
 * `scripts/assert-no-node-polyfills.mjs`'s bundle scan is exercising the real
 * engine import graph, not a vacuous stub.
 *
 * Plain ESM `.js` with JSDoc types per contract C1 — this module is not itself
 * imported by a `test/node/*.test.mjs` file, but it lives under no C1-governed
 * directory (`src/transport/`, `src/auth/`, `src/i18n/`, `src/lifecycle/` —
 * `src/db/` moved out of this workspace into `packages/web-data` in 54-03a
 * and is governed there instead), so the extension choice here is a style
 * match with the rest of the tier-1-reachable surface, not a contract
 * requirement.
 */
import * as voteEngine from '@votetorrent/vote-engine/browser';

/**
 * @returns {{ exportCount: number, exportNames: string[] }}
 */
export function enginePreflight() {
	const exportNames = Object.keys(voteEngine).sort();
	return {
		exportCount: exportNames.length,
		exportNames,
	};
}
