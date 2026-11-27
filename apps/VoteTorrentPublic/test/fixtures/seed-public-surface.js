/**
 * seed-public-surface.js — TEST-ONLY (D-17). The ONE composition both tiers
 * call, so the tier-1 suite and the browser gate can never drift apart. Same
 * discipline `packages/web-data/test/fixtures/seed-founding-authority.js`'s
 * header states: one module, imported by every tier, rather than a seed per
 * tier that nothing reconciles.
 *
 * This is the ONLY module in this plan that reaches outside the app, and it
 * does so by relative specifier into `packages/web-data/test/fixtures/` — the
 * paths 54-03b relocated those fixtures to. A package importing an app's test
 * fixture would be a layering inversion; this direction is the sanctioned one.
 */

import { seedFoundingAuthority, EXPECTED_COUNTS } from '../../../../packages/web-data/test/fixtures/seed-founding-authority.js';
import {
	ceremony,
	seedElectionSurface,
	SEED_NOW,
	SEED_ELECTION,
	SEED_TIMELINE,
	SEED_EXPECTED_COUNTS,
} from '../../../../packages/web-data/test/fixtures/seed-election-surface.js';
import { ROLL_EXPECTED_COUNTS, seedRegistrantRoll } from './registrant-roll-fixture.js';
import {
	KEYRELEASE_EXPECTED_COUNTS,
	SHARE_RELEASE_USER_IDS,
	seedKeyReleaseTasks,
	seedKeyReleaseShares,
} from './keyrelease-fixture.js';

/**
 * A fixed hash DISTINCT from the dashboard's `GATE_NETWORK_HASH`
 * (`gate50network`), so the two apps' fake/real IndexedDB databases can never
 * collide. Carries the `vtx-fixture`-adjacent `vtxfixture` token so a scan has
 * something to name.
 * @type {string}
 */
export const FIXTURE_NETWORK_HASH = 'vtxfixture54';

/** The election every read in this surface is scoped to. @type {string} */
export const FIXTURE_ELECTION_DB_ID = SEED_ELECTION.id;

/**
 * A production-length election id this surface never seeds — 56-03's D-21
 * not-held fixture (`test/browser/election-shell-gate.tsx`'s `not-held`
 * branch). `FIXTURE_ELECTION_DB_ID` above is `SEED_ELECTION.id`, a
 * 2-character seed token; a not-held id derived from it (or transcribed at
 * similar length) would be exactly the kind of short fixture
 * `project_ui_defects_invisible_to_every_tier` names as "too short to fail" —
 * a real `Election.Id` is a 32-byte random value, and this id is rendered
 * inside `.election-address code` on the page under measurement, so it must
 * look like one. 43 characters is the length a SHA-256 content digest
 * base64url-renders at; the value below is the base64url digest of a fixed,
 * unrelated string, chosen only for its length and alphabet, not for any
 * cryptographic property. It conforms to `ELECTION_ID_PATTERN`
 * (`[A-Za-z0-9_-]{1,128}`) and is never equal to `FIXTURE_ELECTION_DB_ID`.
 * @type {string}
 */
export const UNHELD_ELECTION_ID = 'TZucCxBAf1EXCKWzb01SR9IdrpYq72fIEBOzwUlorNI';

/**
 * 56-14's own production-length election id. `FIXTURE_ELECTION_DB_ID` above
 * is the same short, 2-character seed token `UNHELD_ELECTION_ID`'s own
 * comment warns against reusing as a rendered/measured id — the liveness
 * gate (`test/liveness/liveness-gate.tsx`) clones `FIXTURE_ELECTION_DB_ID`'s
 * own `Election`/`ElectionRevision` rows byte-identical except for the id,
 * under this value, specifically so its own runner's anti-vacuity check (a
 * requested election id under 43 characters, or failing
 * `ELECTION_ID_PATTERN`, is a hard bail) has something real to pass. Same
 * convention as `UNHELD_ELECTION_ID`: the base64url digest of a fixed,
 * unrelated string, chosen only for its length and alphabet, and DISTINCT
 * from `UNHELD_ELECTION_ID`. Colocated here (rather than defined once in the
 * `.tsx` harness) for the same reason every other fixture constant is here:
 * `run-liveness-gate.mjs` (a `.mjs` runner) cannot import a `.tsx` module,
 * and both tiers must agree on the exact same value.
 * @type {string}
 */
export const LIVENESS_ELECTION_ID = 'efzhBNtzJ4CuBQdhHbor9hFAwCtZIxrEL2APZNQIjl0';

/**
 * The `ElectionRevision.Revision` value `seedElectionSurface` inserts.
 *
 * `seed-election-surface.js` does NOT export it — it is the internal literal
 * `R.revision = 0` in that module's founding-revision block — so it is
 * re-declared here rather than imported. `public-fixtures.test.mjs` asserts
 * `select Revision from ElectionRevision where ElectionId = :eid` equals this
 * value, so a divergence is a TEST FAILURE rather than a silently empty
 * key-release aggregate.
 * @type {number}
 */
export const FIXTURE_REVISION = 0;

/**
 * The instant a page rendered against this surface is read at.
 *
 * Canonical 19 characters, no `Z`. It sits strictly inside `SEED_TIMELINE`'s
 * `tallyingStarts` → `closed` interval, so the page is in the SETTLING phase —
 * the only phase where D-14's key-release fact is live. The containment is
 * asserted in the tier-1 suite by comparing against `SEED_TIMELINE`'s own
 * values rather than by restating them here.
 * @type {string}
 */
export const FIXTURE_SETTLING_INSTANT = '2026-11-10T12:00:00';

/** Re-exported so the tier-1 suite can assert containment against the source of truth. */
export { SEED_TIMELINE, SEED_NOW, SEED_ELECTION };

/**
 * The merged row-count expectation for the whole public surface.
 *
 * THE SPREAD ORDER IS LOAD-BEARING: `KEYRELEASE_EXPECTED_COUNTS` must come LAST
 * so its `User: 5` overrides the founding fixture's `User: 1`. A spread written
 * in the wrong order would silently expect 1 and fail far from its cause, so
 * `public-fixtures.test.mjs` asserts `PUBLIC_SURFACE_EXPECTED_COUNTS.User === 5`
 * directly.
 * @type {Readonly<Record<string, number>>}
 */
export const PUBLIC_SURFACE_EXPECTED_COUNTS = Object.freeze({
	...EXPECTED_COUNTS,
	...SEED_EXPECTED_COUNTS,
	...ROLL_EXPECTED_COUNTS,
	...KEYRELEASE_EXPECTED_COUNTS,
});

/**
 * Seed the entire public surface, in dependency order: founding authority →
 * election surface → the vrg-signed registrant roll → the release-key tasks.
 *
 * Takes an already-prepared handle (one from `createNetworkDb`, so the crypto
 * plugin and the `SignatureValid` / `isISODatetime` scalar functions the seed's
 * CHECKs call are registered). Opens nothing and registers nothing.
 *
 * @param {import('@quereus/quereus').Database} db
 * @returns {Promise<void>}
 */
export async function seedPublicSurface(db) {
	await seedFoundingAuthority(db);
	await seedElectionSurface(db);
	await seedRegistrantRoll(db, ceremony, {
		electionId: FIXTURE_ELECTION_DB_ID,
		seedNow: SEED_NOW,
	});
	await seedKeyReleaseTasks(db, {
		electionId: FIXTURE_ELECTION_DB_ID,
		revision: FIXTURE_REVISION,
		seedNow: SEED_NOW,
	});
	// 62-126: the public "released" figure counts published share rows, not completed tasks.
	await seedKeyReleaseShares(db, {
		electionId: FIXTURE_ELECTION_DB_ID,
		revision: FIXTURE_REVISION,
		userIds: SHARE_RELEASE_USER_IDS,
	});
}
