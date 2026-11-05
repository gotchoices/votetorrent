/**
 * is-privileged.test.mjs — seeded real-schema proof that
 * `UserEngine.isPrivileged` answers correctly in this runtime, reached only
 * through this app's own `is-privileged.js` wrapper.
 *
 * Uses an in-memory `new Database()` from `@quereus/quereus` — no IndexedDB
 * is touched, so this file does NOT import the IndexedDB test shim used
 * elsewhere in this suite, and does not imply coverage of 50-05's tier-2
 * `setDefaultVtabName` gate.
 *
 * Seed recipe (spike 078's exact `noCtx` clause, four unsigned shoe-in rows:
 * Authority -> User -> Admin -> Officer):
 *   `with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = 1`
 *
 * Two datetime rules govern the fixtures:
 *   - `AdminEffectiveAt` must be a canonical 19-character datetime with NO
 *     trailing `Z` — a `Z` makes every Digest mismatch and surfaces as a bare
 *     `InsertValid` failure that reads exactly like a genuine authorization
 *     failure.
 *   - The positive-control fixture's `AdminEffectiveAt` is unambiguously in
 *     the PAST (`2020-01-01T00:00:00`) because `CurrentAdmin` filters on the
 *     real wall clock (`EffectiveAt <= datetime('now')`). The fail-closed
 *     fixture's `AdminEffectiveAt` is unambiguously in the FUTURE
 *     (`2099-01-01T00:00:00`) — that is the only difference between the two
 *     seeds, which is what makes the fail-closed assertion meaningful.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@quereus/quereus';
import { prepareDb } from '@votetorrent/vote-engine/browser';

import { isPrivileged, readGrantedScopes } from '../../src/auth/is-privileged.js';
import { CAPABILITIES } from '../../src/auth/capabilities.js';

const AUTHORITY_ID = 'a1';
const OFFICER_USER_ID = 'u1';
const NO_CTX =
	'with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = 1';

/**
 * Seed a fresh, schema-loaded database with the four unsigned shoe-in rows
 * (Authority -> User -> Admin -> Officer).
 *
 * @param {{ adminEffectiveAt: string, scopes: string[] }} options
 * @returns {Promise<import('@quereus/quereus').Database>}
 */
async function seedDb({ adminEffectiveAt, scopes }) {
	const db = new Database();
	await prepareDb(db);

	await db.exec(
		`insert into Authority (Id,Name,DomainName,ImageRef) ${NO_CTX} values ('${AUTHORITY_ID}','Test County Elections',null,null)`,
	);
	await db.exec(
		`insert into User (Id,Name,ImageRef) ${NO_CTX} values ('${OFFICER_USER_ID}',:name,null)`,
		{ name: 'Test Officer' },
	);
	await db.exec(
		`insert into Admin (AuthorityId,EffectiveAt,ThresholdPolicies) ${NO_CTX} values ('${AUTHORITY_ID}','${adminEffectiveAt}','[]')`,
	);
	await db.exec(
		`insert into Officer (AuthorityId,AdminEffectiveAt,UserId,Title,Scopes) ${NO_CTX} values ('${AUTHORITY_ID}','${adminEffectiveAt}','${OFFICER_USER_ID}',:title,:scopes)`,
		{ title: 'Test Officer', scopes: JSON.stringify(scopes) },
	);

	return db;
}

test('positive control: readGrantedScopes resolves exactly the seeded scopes, in CAPABILITIES order', async () => {
	const db = await seedDb({ adminEffectiveAt: '2020-01-01T00:00:00', scopes: ['mel', 'ceb'] });
	const granted = await readGrantedScopes(db, OFFICER_USER_ID);
	assert.deepEqual(granted, ['mel', 'ceb']);

	// Order pin: 'mel' precedes 'ceb' in CAPABILITIES (elections before
	// ballotsQuestions, contract C5), and readGrantedScopes must preserve it.
	const order = CAPABILITIES.map((c) => c.scope);
	assert.ok(order.indexOf('mel') < order.indexOf('ceb'));
});

test('isPrivileged resolves false for a scope the officer was not granted', async () => {
	const db = await seedDb({ adminEffectiveAt: '2020-01-01T00:00:00', scopes: ['mel', 'ceb'] });
	const has = await isPrivileged(db, OFFICER_USER_ID, 'vrg');
	assert.equal(has, false);
});

test('an unknown user id resolves to [] and does not throw', async () => {
	const db = await seedDb({ adminEffectiveAt: '2020-01-01T00:00:00', scopes: ['mel', 'ceb'] });
	const granted = await readGrantedScopes(db, 'nobody');
	assert.deepEqual(granted, []);
});

test('WR-02 fail-closed: a future-dated Admin row makes every scope resolve false', async () => {
	const db = await seedDb({ adminEffectiveAt: '2099-01-01T00:00:00', scopes: ['mel', 'ceb'] });
	const granted = await readGrantedScopes(db, OFFICER_USER_ID);
	assert.deepEqual(
		granted,
		[],
		'a future-dated Admin.EffectiveAt must make CurrentAdmin join nothing, so isPrivileged answers false for every scope',
	);
});

test('readGrantedScopes(null, userId) rejects with an error naming EngineContext, not a silent []', async () => {
	await assert.rejects(() => readGrantedScopes(null, OFFICER_USER_ID), /EngineContext/);
});
