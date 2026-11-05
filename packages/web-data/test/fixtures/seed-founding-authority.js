/**
 * The ONE seed every gate uses — this package's own tier-1
 * `test/reattach.test.mjs`, the dashboard's tier-2 browser gate
 * (`apps/VoteTorrentDashboard/test/browser/db-gate.js`, `gate-matrix.tsx`)
 * and its `freshness-forget.test.mjs`/`authority-admin-queries.test.mjs` all
 * import this SAME module by relative path, so no tier or app can drift
 * apart from another (the skill doc's "the SAME module the browser uses"
 * discipline). This fixture moved here, alongside `test/reattach.test.mjs`,
 * by 54-03b -- before that it lived in the dashboard's own `test/fixtures/`;
 * the four dashboard consumers now reach it by a longer relative path
 * instead of the reverse (a package importing an app's test fixture would be
 * a layering inversion).
 *
 * TEST SCAFFOLDING, NOT A PRODUCTION WRITE PATH. Phase 50's dashboard makes NO
 * writes (D-01); these four rows exist only so the gates have something real
 * to persist and re-read.
 *
 * This seeds through the schema's own unsigned founding shoe-in path (raw
 * SQL) rather than through `vote-engine`. The standing "write through
 * vote-engine, never the raw handle" rule exists because `iad`/`ik` have zero
 * schema sites — but the engine entry point that would honour it
 * (`NetworksEngine.create`) is exactly what outline contract 2 forbids the
 * dashboard from importing. This is a deliberate, recorded exception for TEST
 * FIXTURES ONLY; it is not a precedent for any production write path in this
 * dashboard.
 *
 * Do NOT "fix" the datetime literal below. It ends in `Z`, and that is
 * correct here: it is a plain `datetime` column validated by
 * `isISODatetime`, which REQUIRES the `Z`, and the founding path runs with
 * `SigningNonce = null` so no `Digest`-bound CHECK ever evaluates it. The
 * 19-character, no-`Z` canonical form applies only to values THIS DASHBOARD
 * PRODUCES (contract C5's `capturedAt`, which must come from
 * `nowCanonicalDatetime()` — see `@votetorrent/web-data`'s `reattach.js`,
 * moved out of the dashboard's own `src/db/` by 54-03a).
 */

/** The fixed network hash both gates seed and verify against. @type {string} */
export const GATE_NETWORK_HASH = 'gate50network';

/** The four tables this fixture inserts one row into each. @type {string[]} */
export const SEED_TABLES = ['Authority', 'User', 'Admin', 'Officer'];

/** The row counts a correctly-seeded, never-mutated store must report. @type {Record<string, number>} */
export const EXPECTED_COUNTS = { Authority: 1, User: 1, Admin: 1, Officer: 1 };

const EFFECTIVE_AT = '2026-01-01T00:00:00.000Z';
const GRANTED_SCOPES = ['mel', 'ceb'];

/**
 * Seed the founding Authority + User + Admin + Officer through the schema's
 * own unsigned first-authority shoe-in path (`InsertValid`'s
 * `(select count(*) from Authority) = 1` clause and its User/Officer
 * counterparts).
 *
 * @param {import('@quereus/quereus').Database} db
 * @returns {Promise<void>}
 */
export async function seedFoundingAuthority(db) {
	const noCtx =
		'with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = 1';
	await db.exec(
		`insert into Authority (Id, Name, DomainName, ImageRef) ${noCtx} values ('a1','Gate County Elections','gate50.example',null)`,
	);
	await db.exec(`insert into User (Id, Name, ImageRef) ${noCtx} values ('u1','Ada Officer',null)`);
	// `cast(... as datetime)` wraps EFFECTIVE_AT on both inserts below -- the literal TEXT is
	// byte-identical to before (see this file's header: never change the literal itself), only
	// its binding is now explicitly typed. This is 56-11's fix for a defect that fixture only
	// surfaces against a strand-connected (Optimystic-vtab-backed) `Database`, never against the
	// plugin-indexeddb-backed local store every other consumer of this fixture uses: a bare
	// datetime string literal in a VALUES clause binds as untyped text until storage, so
	// Officer's `AdminValid` deferred CHECK -- `exists (select 1 from Admin A where ... A.EffectiveAt
	// = new.AdminEffectiveAt)` -- compares a properly-decoded `datetime`-affinity value read back
	// through the Optimystic row codec against an untyped `new.AdminEffectiveAt`, and the two never
	// compare equal, so the exists() spuriously returns nothing. Verified failing without the cast
	// and passing with it, via a minimal two-table repro isolating the defect to exactly this shape
	// (a `new.<datetime column>` compared against another table's stored `datetime` column inside a
	// deferred CHECK) -- see `56-11-SUMMARY.md`. The plugin-indexeddb path this fixture's other
	// callers use does not route through that codec, so this cast is a no-op there.
	await db.exec(
		`insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies) ${noCtx} values ('a1',cast('${EFFECTIVE_AT}' as datetime),'[]')`,
	);
	await db.exec(
		`insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title, Scopes) ${noCtx} values ('a1',cast('${EFFECTIVE_AT}' as datetime),'u1','Clerk','${JSON.stringify(GRANTED_SCOPES)}')`,
	);
}
