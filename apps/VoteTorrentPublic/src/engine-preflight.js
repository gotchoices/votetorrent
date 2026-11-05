/**
 * Engine preflight — the schema-reaches-the-bundle probe, and nothing else.
 *
 * THE RULE (unchanged, and it survives D-01)
 * ------------------------------------------
 * This module performs a NAMED import of ONLY `VOTETORRENT_SCHEMA_SQL` — no
 * namespace/wildcard import, and no second named binding. This diverges from
 * `apps/VoteTorrentDashboard/src/engine-preflight.js`, which imports the whole
 * subpath namespace-style. That divergence is deliberate. Do NOT "fix" this
 * back to the dashboard's wildcard shape, and do NOT add a second binding
 * "while you are here" — `test/node/engine-reach.test.mjs` section 5 asserts
 * exactly one import statement carrying exactly one binding, precisely so
 * neither can happen by accident.
 *
 * THE OLD JUSTIFICATION, NOW FALSE — labelled rather than deleted
 * --------------------------------------------------------------
 * Phase 53 justified the rule by saying that NO database-opening code of any
 * kind may enter a public build. Phase 54's D-01 retired that claim ON
 * PURPOSE: an anonymous reader's data comes from an already-bootstrapped
 * browser's own IndexedDB, so the public page legitimately opens a real
 * database and the emitted bundle legitimately contains the code that does
 * it. The retirement is planned work owned by 54-10 (see
 * `.planning/phases/54-public-no-login-election-view/54-ISSUES.md` I-02). It
 * is recorded here, rather than quietly removed, so the next reader inherits
 * a decision instead of a contradiction between this header and the tree.
 *
 * THE NARROWER JUSTIFICATION THAT SURVIVES
 * ----------------------------------------
 * A wildcard import drags EVERY export of the subpath into this app's bundle,
 * including `UserEngine` — the carrier of `isPrivileged`, the officer-scope
 * check. D-01 redefines *public* as *no officer identity*, not *anyone with a
 * link*. So this page legitimately opens a database and NEVER legitimately
 * evaluates an officer scope. The named import is what keeps that true by
 * construction rather than by review, and `scripts/assert-engine-reach.mjs`'s
 * module-graph negative proves it on the built artefact.
 *
 * WHERE THE DATABASE LEGITIMATELY COMES FROM
 * ------------------------------------------
 * `@votetorrent/web-data/public` — the audience-split entry (D-03/D-04) whose
 * public half exposes no officer surface at all. This module is NOT that path
 * and never becomes it. It stays the schema-reaches-the-bundle probe; it
 * opens nothing itself, and the app's database access is delegated to that
 * package rather than hand-rolled here.
 *
 * THE MEASURED VACUITY TRAP (untouched by D-01)
 * ---------------------------------------------
 * The two runtime fields below are BOTH computed by a method call
 * (`.length`, `.split('\n').length`) on the imported `VOTETORRENT_SCHEMA_SQL`
 * binding, never by slicing a fixed prefix out of it. A fixed short prefix
 * (such as the schema's first line, "declare schema main") could be
 * constant-folded into a small literal by the minifier, and a bundle check
 * that greps for that literal would then pass while the real ~132 KB schema
 * string was tree-shaken away. A `split` call on the imported binding cannot
 * be folded away, so the whole string must survive into the bundle for these
 * fields to be computed correctly. Both
 * `apps/VoteTorrentPublic/scripts/assert-engine-reach.mjs` and
 * `test/node/engine-reach.test.mjs` section 6 depend on this reasoning.
 *
 * Plain ESM `.js` with JSDoc types, matching the dashboard's file-type
 * convention for this surface.
 */
import { VOTETORRENT_SCHEMA_SQL } from '@votetorrent/vote-engine/browser';

/**
 * @returns {{ schemaByteLength: number, schemaLineCount: number }}
 */
export function enginePreflight() {
	return {
		schemaByteLength: VOTETORRENT_SCHEMA_SQL.length,
		schemaLineCount: VOTETORRENT_SCHEMA_SQL.split('\n').length,
	};
}
