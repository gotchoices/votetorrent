/**
 * authority-admin-queries.test.mjs — seeded real-schema proof of all six
 * `authority-admin-queries.js` fetchers, with instrument controls for the
 * empty results (an empty result that cannot be distinguished from a broken
 * query is not evidence).
 *
 * Uses an in-memory `new Database()` from `@quereus/quereus` -- no
 * IndexedDB is touched, so this file does NOT import the IndexedDB test
 * shim, mirroring `is-privileged.test.mjs`'s (50-06) own recipe.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Database } from '@quereus/quereus';
import { prepareDb } from '@votetorrent/vote-engine/browser';

import { dashboardSrc, workspacePath } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';

import { seedFoundingAuthority } from '../../../../packages/web-data/test/fixtures/seed-founding-authority.js';
import {
	seedNetwork,
	seedAuthorityPeers,
	seedAuthorityInvite,
	seedOtherScopeInvite,
	seedOfficerWithMalformedScopes,
} from '../fixtures/seed-authority-admin-extras.js';
import {
	resolveAuthorityId,
	fetchNetworkSettings,
	fetchAuthorityProfile,
	fetchAuthorityPeers,
	fetchAdministrationOfficers,
	fetchKeyholders,
	fetchAuthorityInvites,
	NETWORK_SETTINGS_TABLES,
	AUTHORITY_PROFILE_TABLES,
	AUTHORITY_PEERS_TABLES,
	ADMINISTRATION_OFFICERS_TABLES,
	KEYHOLDERS_TABLES,
	AUTHORITY_INVITES_TABLES,
	PANEL_READ_LOADING,
	settlePanelRead,
	markRowsOrNull,
	markRowKey,
	markRowSig,
	networkSettingsMarkRows,
	authorityProfileMarkRows,
	authorityPeersMarkRows,
	administrationOfficersMarkRows,
	officerMarkKey,
	authorityInvitesMarkRows,
	isOpenInvite,
} from '../../src/screens/panels/authority-admin-queries.js';

const AUTHORITY_ID = 'a1';

/** A schema-loaded, empty database -- no Authority, no User, nothing. */
async function emptyDb() {
	const db = new Database();
	await prepareDb(db);
	return db;
}

/** A database with just the founding shoe-in (Authority/User/Admin/Officer). */
async function foundingDb() {
	const db = new Database();
	await prepareDb(db);
	await seedFoundingAuthority(db);
	return db;
}

// --- resolveAuthorityId -------------------------------------------------

test('resolveAuthorityId: with a Network row present, resolves PrimaryAuthorityId', async () => {
	const db = await foundingDb();
	await seedNetwork(db, { authorityId: AUTHORITY_ID });
	assert.equal(await resolveAuthorityId(db), AUTHORITY_ID);
});

test('resolveAuthorityId: with no Network row but exactly one Authority, resolves that Authority.Id', async () => {
	const db = await foundingDb();
	assert.equal(await resolveAuthorityId(db), AUTHORITY_ID);
});

test('resolveAuthorityId: with neither a Network row nor any Authority, resolves null without throwing', async () => {
	const db = await emptyDb();
	assert.equal(await resolveAuthorityId(db), null);
});

test('resolveAuthorityId: with db === null, resolves null', async () => {
	assert.equal(await resolveAuthorityId(null), null);
});

// --- fetchNetworkSettings ------------------------------------------------

test('fetchNetworkSettings: resolves parsed Relays/TimestampAuthorities, NumberRequiredTSAs as a number, and ElectionTypeName', async () => {
	const db = await foundingDb();
	await seedNetwork(db, { authorityId: AUTHORITY_ID });
	const settings = await fetchNetworkSettings(db);
	assert.ok(settings);
	assert.equal(settings.Name, 'Gate County Network');
	assert.ok(Array.isArray(settings.Relays));
	assert.equal(settings.Relays.length, 2);
	assert.ok(Array.isArray(settings.TimestampAuthorities));
	assert.equal(typeof settings.NumberRequiredTSAs, 'number');
	assert.equal(settings.NumberRequiredTSAs, 2);
	assert.equal(settings.ElectionType, 'o');
	assert.equal(settings.ElectionTypeName, 'Official');
});

test('fetchNetworkSettings: with no Network row, resolves null', async () => {
	const db = await foundingDb();
	assert.equal(await fetchNetworkSettings(db), null);
});

test('fetchNetworkSettings: malformed Relays JSON resolves Relays: [] rather than throwing', async () => {
	const db = await foundingDb();
	await db.exec(
		`insert into Network (Id,Hash,PrimaryAuthorityId,Name,ImageRef,Relays,TimestampAuthorities,NumberRequiredTSAs,ElectionType)
		 with context SigningNonce = null, Tid = 1
		 values ('net1','h1',:aid,'Malformed Relays Network',null,:relays,'[]',1,'o')`,
		{ aid: AUTHORITY_ID, relays: 'not-valid-json[[[' },
	);
	const settings = await fetchNetworkSettings(db);
	assert.ok(settings);
	assert.deepEqual(settings.Relays, []);
});

test('fetchNetworkSettings: db === null resolves null', async () => {
	assert.equal(await fetchNetworkSettings(null), null);
});

// --- fetchAuthorityProfile ------------------------------------------------

test('fetchAuthorityProfile: resolves Id (the SID)/Name/DomainName/ImageRef for the resolved authority', async () => {
	const db = await foundingDb();
	const profile = await fetchAuthorityProfile(db);
	assert.ok(profile);
	assert.equal(profile.Id, AUTHORITY_ID);
	assert.equal(profile.Name, 'Gate County Elections');
	assert.equal(profile.DomainName, 'gate50.example');
});

test('fetchAuthorityProfile: resolves null when resolveAuthorityId resolves null', async () => {
	const db = await emptyDb();
	assert.equal(await fetchAuthorityProfile(db), null);
});

test('fetchAuthorityProfile: db === null resolves null', async () => {
	assert.equal(await fetchAuthorityProfile(null), null);
});

// --- fetchAuthorityPeers ---------------------------------------------------

test('fetchAuthorityPeers: before the peer rungs run, resolves []', async () => {
	const db = await foundingDb();
	assert.deepEqual(await fetchAuthorityPeers(db), []);
});

test('fetchAuthorityPeers: with two peers seeded, resolves both PeerId values sorted ascending', async () => {
	const db = await foundingDb();
	await seedAuthorityPeers(db, { authorityId: AUTHORITY_ID, peerIds: ['peer-zzz', 'peer-aaa'] });
	const peers = await fetchAuthorityPeers(db);
	assert.deepEqual(peers, ['peer-aaa', 'peer-zzz']);
});

test('fetchAuthorityPeers: db === null resolves []', async () => {
	assert.deepEqual(await fetchAuthorityPeers(null), []);
});

// --- fetchAdministrationOfficers -------------------------------------------

test('fetchAdministrationOfficers: resolves admin + officers, Scopes round-trips as an array of valid Scope codes', async () => {
	const db = await foundingDb();
	const result = await fetchAdministrationOfficers(db);
	assert.ok(result.admin);
	assert.equal(result.officers.length, 1);
	const [officer] = result.officers;
	assert.equal(officer.UserId, 'u1');
	assert.deepEqual(officer.Scopes, ['mel', 'ceb']);

	const scopeCodes = [];
	for await (const row of db.eval(`select Code from Scope`, {})) scopeCodes.push(row.Code);
	for (const code of officer.Scopes) {
		assert.ok(scopeCodes.includes(code), `${code} must be a member of view Scope`);
	}
});

test('fetchAdministrationOfficers: fail-closed -- a future-dated Admin resolves { admin: null, officers: [] }', async () => {
	// The ONLY difference from a positive-control fixture is AdminEffectiveAt,
	// compared side by side here: the founding fixture below uses
	// '2099-01-01T00:00:00.000Z' where seed-founding-authority.js uses
	// '2026-01-01T00:00:00.000Z' -- everything else is identical to that
	// file's own seedFoundingAuthority body.
	const db = await emptyDb();
	const noCtx = 'with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = 1';
	const futureEffectiveAt = '2099-01-01T00:00:00.000Z';
	await db.exec(`insert into Authority (Id, Name, DomainName, ImageRef) ${noCtx} values ('a1','Gate County Elections','gate50.example',null)`);
	await db.exec(`insert into User (Id, Name, ImageRef) ${noCtx} values ('u1','Ada Officer',null)`);
	await db.exec(`insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies) ${noCtx} values ('a1','${futureEffectiveAt}','[]')`);
	await db.exec(
		`insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title, Scopes) ${noCtx} values ('a1','${futureEffectiveAt}','u1','Clerk','["mel","ceb"]')`,
	);

	const result = await fetchAdministrationOfficers(db);
	assert.deepEqual(
		result,
		{ admin: null, officers: [] },
		'a future-dated Admin.EffectiveAt must make the CurrentAdmin join yield nothing, the same wall-clock behaviour isPrivileged imposes',
	);
});

test('fetchAdministrationOfficers: a malformed (non-array) Scopes value on one officer resolves Scopes: [] for that officer only, others unaffected', async () => {
	const db = await foundingDb();
	await seedOfficerWithMalformedScopes(db, { authorityId: AUTHORITY_ID, userId: 'u2', title: 'Deputy Clerk', scopes: '{}' });

	const result = await fetchAdministrationOfficers(db);
	assert.equal(result.officers.length, 2);
	const founding = result.officers.find((o) => o.UserId === 'u1');
	const malformed = result.officers.find((o) => o.UserId === 'u2');
	assert.ok(founding);
	assert.ok(malformed);
	assert.deepEqual(founding.Scopes, ['mel', 'ceb'], 'the unrelated officer must be unaffected by the malformed one');
	assert.deepEqual(malformed.Scopes, [], 'a well-formed-but-non-array Scopes value must resolve to []');
});

test('fetchAdministrationOfficers: db === null resolves { admin: null, officers: [] }', async () => {
	assert.deepEqual(await fetchAdministrationOfficers(null), { admin: null, officers: [] });
});

// --- fetchKeyholders --------------------------------------------------------

test('fetchKeyholders: resolves [] on the seeded database without throwing', async () => {
	const db = await foundingDb();
	assert.deepEqual(await fetchKeyholders(db), []);
});

test('fetchKeyholders: instrument control -- the same query shape with a non-existent column rejects, naming the column', async () => {
	const db = await foundingDb();
	await assert.rejects(async () => {
		// eslint-disable-next-line no-unused-vars
		for await (const _row of db.eval(`select K.NoSuchColumn from Keyholder K`, {})) {
			/* never reached */
		}
	}, /NoSuchColumn/);
});

test('fetchKeyholders: db === null resolves []', async () => {
	assert.deepEqual(await fetchKeyholders(null), []);
});

test('fetchKeyholders: source text names no key-material column -- a keyholder is an identity here, never key material', async () => {
	const source = readFileSync(dashboardSrc('screens', 'panels', 'authority-admin-queries.js'), 'utf8');
	assert.doesNotMatch(source, /UserKey|PubKey|PrivateKey|ReleaseKey|SignerKey|Signature/i);
});

// --- fetchAuthorityInvites ---------------------------------------------------

test('fetchAuthorityInvites: resolves [] before the invite rungs run, with the same non-existent-column instrument control', async () => {
	const db = await foundingDb();
	assert.deepEqual(await fetchAuthorityInvites(db), []);

	await assert.rejects(async () => {
		// eslint-disable-next-line no-unused-vars
		for await (const _row of db.eval(`select IS_.NoSuchColumn from InviteSlot IS_`, {})) {
			/* never reached */
		}
	}, /NoSuchColumn/);
});

test('fetchAuthorityInvites: an iad invite resolves one entry with Cid/Name/Type/TypeName/Expiration/IsAccepted normalized to a real false/CancelledAt null', async () => {
	const db = await foundingDb();
	await seedAuthorityInvite(db, { authorityId: AUTHORITY_ID, name: 'Neighboring County Authority', expiration: '2026-06-01T00:00:00' });

	const invites = await fetchAuthorityInvites(db);
	assert.equal(invites.length, 1);
	const [invite] = invites;
	assert.equal(invite.Name, 'Neighboring County Authority');
	assert.equal(invite.Type, 'au');
	assert.equal(invite.TypeName, 'Authority');
	assert.equal(invite.Expiration, '2026-06-01T00:00:00');
	assert.equal(invite.IsAccepted, false, 'IsAccepted must be a real boolean false, never the raw 0');
	assert.notEqual(invite.IsAccepted, 0);
	assert.equal(invite.CancelledAt, null);
	assert.ok(typeof invite.Cid === 'string' && invite.Cid.length > 0);
});

test('fetchAuthorityInvites: the iad filter is positive-and-negative -- an iad slot is returned, an other-scope (uai) slot on the same authority is not', async () => {
	const db = await foundingDb();
	await seedAuthorityInvite(db, { authorityId: AUTHORITY_ID, name: 'Neighboring County Authority', expiration: '2026-06-01T00:00:00' });
	await seedOtherScopeInvite(db, { authorityId: AUTHORITY_ID });

	const invites = await fetchAuthorityInvites(db);
	const names = invites.map((i) => i.Name);
	assert.ok(names.includes('Neighboring County Authority'), 'the iad-scoped invite must be present (positive control)');
	assert.ok(
		!names.includes('Wrong-Scope Invite (must not appear as an authority invite)'),
		'the uai-scoped invite must be excluded (negative control) -- an all-empty result could not pass this assertion',
	);
	assert.equal(invites.length, 1);
});

test('fetchAuthorityInvites: db === null resolves []', async () => {
	assert.deepEqual(await fetchAuthorityInvites(null), []);
});

// --- Every fetcher accepts db === null without throwing ---------------------

test('every fetcher resolves its empty shape for db === null, none throws', async () => {
	assert.equal(await resolveAuthorityId(null), null);
	assert.equal(await fetchNetworkSettings(null), null);
	assert.equal(await fetchAuthorityProfile(null), null);
	assert.deepEqual(await fetchAuthorityPeers(null), []);
	assert.deepEqual(await fetchAdministrationOfficers(null), { admin: null, officers: [] });
	assert.deepEqual(await fetchKeyholders(null), []);
	assert.deepEqual(await fetchAuthorityInvites(null), []);
});

// =============================================================================
// Live helpers for the administration panels (table lists, mark rows, the
// open-invite rule, read settling). Titles start with `live:`.
// =============================================================================

// --- (a) drift: every *_TABLES list equals the tables its fetcher's SQL reads --

const QUERIES_SOURCE = stripComments(readFileSync(dashboardSrc('screens', 'panels', 'authority-admin-queries.js'), 'utf8'));
const SCHEMA_QSQL = readFileSync(workspacePath('packages/vote-core', 'schema', 'votetorrent.qsql'), 'utf8');

const TABLE_REF_RE = /\b(?:from|join)\s+([A-Z][A-Za-z0-9_]*)/g;

/** Sorted, de-duplicated identifiers named after `from` / `join`.
 * @param {string} sql @returns {string[]} */
function collectTableRefs(sql) {
	return [...new Set([...sql.matchAll(TABLE_REF_RE)].map((m) => m[1]))].sort();
}

/** `view <Name> as ... ;` bodies out of the schema.
 * @type {Map<string, string>} */
const VIEW_BODIES = new Map();
for (const m of SCHEMA_QSQL.matchAll(/\bview\s+([A-Z][A-Za-z0-9_]*)\s+as\b/g)) {
	const start = (m.index ?? 0) + m[0].length;
	const end = SCHEMA_QSQL.indexOf(';', start);
	VIEW_BODIES.set(m[1], SCHEMA_QSQL.slice(start, end === -1 ? undefined : end));
}

/** Expand views to the base tables they read. A constant view (one that names
 * no table, e.g. a `select 'o' as Code union all ...` code list) stays as itself.
 * @param {string[]} names @param {Set<string>} [seen] @returns {string[]} */
function expandViews(names, seen = new Set()) {
	/** @type {Set<string>} */
	const out = new Set();
	for (const name of names) {
		const body = VIEW_BODIES.get(name);
		if (body === undefined || seen.has(name)) {
			out.add(name);
			continue;
		}
		const inner = collectTableRefs(body);
		if (inner.length === 0) {
			out.add(name);
			continue;
		}
		for (const table of expandViews(inner, new Set([...seen, name]))) out.add(table);
	}
	return [...out].sort();
}

/** The comment-stripped body of `export async function <name>(` up to the next export.
 * @param {string} name @returns {string} */
function fetcherSlice(name) {
	const marker = `export async function ${name}(`;
	const start = QUERIES_SOURCE.indexOf(marker);
	assert.ok(start >= 0, `${name} was not found in authority-admin-queries.js`);
	const end = QUERIES_SOURCE.indexOf('\nexport ', start + marker.length);
	const slice = QUERIES_SOURCE.slice(start, end === -1 ? undefined : end);
	assert.ok(slice.length > marker.length, `the ${name} slice is empty`);
	return slice;
}

/** The tables a fetcher reads: its own from/join names, views expanded, plus
 * resolveAuthorityId's tables when it calls that helper.
 * @param {string} name @returns {string[]} */
function derivedTables(name) {
	const body = fetcherSlice(name);
	const refs = collectTableRefs(body);
	if (body.includes('resolveAuthorityId(')) refs.push(...collectTableRefs(fetcherSlice('resolveAuthorityId')));
	return expandViews(refs);
}

/** @type {Array<[string, readonly string[], string]>} */
const DRIFT_CASES = [
	['fetchNetworkSettings', NETWORK_SETTINGS_TABLES, 'NETWORK_SETTINGS_TABLES'],
	['fetchAuthorityProfile', AUTHORITY_PROFILE_TABLES, 'AUTHORITY_PROFILE_TABLES'],
	['fetchAuthorityPeers', AUTHORITY_PEERS_TABLES, 'AUTHORITY_PEERS_TABLES'],
	['fetchAdministrationOfficers', ADMINISTRATION_OFFICERS_TABLES, 'ADMINISTRATION_OFFICERS_TABLES'],
	['fetchKeyholders', KEYHOLDERS_TABLES, 'KEYHOLDERS_TABLES'],
	['fetchAuthorityInvites', AUTHORITY_INVITES_TABLES, 'AUTHORITY_INVITES_TABLES'],
];

test('live: drift control -- the collector over a synthetic SQL string yields exactly its two tables', () => {
	assert.deepEqual(collectTableRefs('select 1 from Foo F left join Bar B on 1'), ['Bar', 'Foo']);
});

test('live: drift control -- a copied list with one table removed is reported unequal', () => {
	const derived = derivedTables('fetchAuthorityInvites');
	const copied = AUTHORITY_INVITES_TABLES.filter((table) => table !== 'InviteCancellation');
	assert.equal(copied.length, AUTHORITY_INVITES_TABLES.length - 1, 'the control must actually drop one table');
	assert.throws(() => assert.deepEqual(derived, copied), assert.AssertionError);
});

test('live: drift control -- the CurrentAdmin view resolves to Admin, a constant code-list view stays itself, a resolveAuthorityId caller gains its tables', () => {
	assert.deepEqual(expandViews(['CurrentAdmin']), ['Admin']);
	assert.deepEqual(expandViews(['ElectionType']), ['ElectionType']);
	assert.deepEqual(collectTableRefs(fetcherSlice('resolveAuthorityId')), ['Authority', 'Network']);
	assert.ok(!collectTableRefs(fetcherSlice('fetchAuthorityPeers')).includes('Network'), 'Network must come from resolveAuthorityId, not the fetcher body');
	assert.ok(derivedTables('fetchAuthorityPeers').includes('Network'));
});

for (const [fetcher, list, listName] of DRIFT_CASES) {
	test(`live: drift -- ${listName} equals the tables ${fetcher}'s SQL reads`, () => {
		assert.deepEqual([...list], derivedTables(fetcher));
	});
}

test('live: every *_TABLES list is frozen, sorted and free of duplicates', () => {
	for (const [, list, listName] of DRIFT_CASES) {
		assert.ok(Object.isFrozen(list), `${listName} must be frozen`);
		assert.deepEqual([...list], [...new Set(list)].sort(), `${listName} must be sorted without duplicates`);
	}
});

// --- (b) mark rows -------------------------------------------------------------

const SAMPLE_SETTINGS = {
	Name: 'Gate County Network',
	Hash: 'aa11networkhash',
	PrimaryAuthorityId: 'a1',
	Relays: ['/dns4/relay1.example/tcp/4001'],
	TimestampAuthorities: [{ url: 'https://tsa1.example' }],
	NumberRequiredTSAs: 1,
	ElectionType: 'o',
	ElectionTypeName: 'Official',
};

test('live: networkSettingsMarkRows -- keys are the seven field labels; changing only Relays changes only the Relays sig; null gives []', () => {
	const before = networkSettingsMarkRows(SAMPLE_SETTINGS);
	assert.deepEqual(before.map(markRowKey), ['Name', 'Hash', 'PrimaryAuthorityId', 'Relays', 'TimestampAuthorities', 'NumberRequiredTSAs', 'ElectionType']);
	const after = networkSettingsMarkRows({ ...SAMPLE_SETTINGS, Relays: ['/dns4/relay9.example/tcp/4001'] });
	const changed = before.filter((row, i) => markRowSig(row) !== markRowSig(after[i])).map(markRowKey);
	assert.deepEqual(changed, ['Relays']);
	assert.deepEqual(networkSettingsMarkRows(null), []);
});

test('live: authorityProfileMarkRows -- keys Name, DomainName, Id, ImageRef; null gives []', () => {
	const rows = authorityProfileMarkRows({ Id: 'a1', Name: 'Gate County Elections', DomainName: null, ImageRef: null });
	assert.deepEqual(rows.map(markRowKey), ['Name', 'DomainName', 'Id', 'ImageRef']);
	assert.equal(rows[1].sig, 'null');
	assert.deepEqual(authorityProfileMarkRows(null), []);
});

test('live: authorityPeersMarkRows -- keeps input order, key and sig are the peer id', () => {
	assert.deepEqual(authorityPeersMarkRows(['p2', 'p1']), [
		{ key: 'p2', sig: 'p2' },
		{ key: 'p1', sig: 'p1' },
	]);
	assert.deepEqual(authorityPeersMarkRows(null), []);
});

test('live: administrationOfficersMarkRows -- the seeded founding db gives the two admin keys then one officer key each', async () => {
	const db = await foundingDb();
	await seedOfficerWithMalformedScopes(db, { authorityId: AUTHORITY_ID, userId: 'u2', title: 'Deputy Clerk', scopes: '{}' });
	const value = await fetchAdministrationOfficers(db);
	const rows = administrationOfficersMarkRows(value);
	const officerKeys = value.officers.map((o) => officerMarkKey(o.UserId));
	assert.equal(officerKeys.length, 2);
	assert.deepEqual(rows.map(markRowKey), ['admin:EffectiveAt', 'admin:ThresholdPolicies', ...officerKeys]);
	assert.equal(officerMarkKey('u1'), 'officer:u1');
	assert.ok(officerKeys.includes('officer:u1') && officerKeys.includes('officer:u2'));

	// Changing one officer's Title changes only that officer's sig.
	const edited = {
		admin: value.admin,
		officers: value.officers.map((o) => (o.UserId === 'u2' ? { ...o, Title: 'Chief Deputy Clerk' } : o)),
	};
	const after = administrationOfficersMarkRows(edited);
	const changed = rows.filter((row, i) => markRowSig(row) !== markRowSig(after[i])).map(markRowKey);
	assert.deepEqual(changed, ['officer:u2']);
});

test('live: administrationOfficersMarkRows -- no current administration gives [] (and null gives [])', () => {
	assert.deepEqual(administrationOfficersMarkRows({ admin: null, officers: [] }), []);
	assert.deepEqual(administrationOfficersMarkRows(null), []);
});

test('live: authorityInvitesMarkRows -- key is the Cid; an extra property on the row object never reaches the sig', () => {
	const invite = {
		Cid: 'cid-1',
		Name: 'Neighboring County Authority',
		Type: 'au',
		TypeName: 'Authority',
		Expiration: '2026-06-01T00:00:00',
		IsAccepted: null,
		CancelledAt: null,
		InviteKey: 'k-secret',
	};
	const [row] = authorityInvitesMarkRows([invite]);
	assert.equal(row.key, 'cid-1');
	assert.ok(!row.sig.includes('k-secret'), 'a property outside the six displayed values must never reach the sig');
	assert.equal(row.sig, JSON.stringify(['Neighboring County Authority', 'au', 'Authority', '2026-06-01T00:00:00', null, null]));
	assert.deepEqual(authorityInvitesMarkRows(null), []);
});

// --- (c) isOpenInvite ------------------------------------------------------------

const AT_SEED = Date.parse('2026-01-15T00:00:00Z');
const AT_EXPIRY = Date.parse('2026-06-01T00:00:00Z');

/** @param {Partial<import('../../src/screens/panels/authority-admin-queries.js').AuthorityInvite>} [over] */
function inviteRow(over = {}) {
	return {
		Cid: 'cid-1',
		Name: 'Neighboring County Authority',
		Type: 'au',
		TypeName: 'Authority',
		Expiration: '2026-06-01T00:00:00',
		IsAccepted: null,
		CancelledAt: null,
		...over,
	};
}

test('live: isOpenInvite -- only an unanswered, uncancelled invite with a future expiration is open', () => {
	assert.equal(isOpenInvite(inviteRow(), AT_SEED), true);
	assert.equal(isOpenInvite(inviteRow({ IsAccepted: false }), AT_SEED), false, 'a declined invite is answered');
	assert.equal(isOpenInvite(inviteRow({ IsAccepted: true }), AT_SEED), false, 'an accepted invite is answered');
	assert.equal(isOpenInvite(inviteRow({ CancelledAt: '2026-01-10T00:00:00' }), AT_SEED), false);
	assert.equal(isOpenInvite(inviteRow(), AT_EXPIRY), false, 'an invite is closed AT its expiration');
	assert.equal(isOpenInvite(inviteRow(), AT_EXPIRY + 1000), false);
});

test('live: isOpenInvite -- an unreadable expiration or a non-finite now is never open', () => {
	assert.equal(isOpenInvite(inviteRow({ Expiration: 'not-a-date' }), AT_SEED), false);
	assert.equal(isOpenInvite(inviteRow(), Number.NaN), false);
	assert.equal(isOpenInvite(inviteRow(), Number.POSITIVE_INFINITY), false);
});

test('live: isOpenInvite -- the seeded iad invite, read through fetchAuthorityInvites: its fixture result row is a decline (closed); unanswered it is open at the seed instant and closed after expiry', async () => {
	const db = await foundingDb();
	await seedAuthorityInvite(db, { authorityId: AUTHORITY_ID, name: 'Neighboring County Authority', expiration: '2026-06-01T00:00:00' });
	const [invite] = await fetchAuthorityInvites(db);
	assert.ok(invite);
	assert.equal(invite.IsAccepted, false);
	assert.equal(isOpenInvite(invite, AT_SEED), false, 'the fixture seeds a declined InviteResult row');
	const unanswered = { ...invite, IsAccepted: null };
	assert.equal(isOpenInvite(unanswered, AT_SEED), true);
	assert.equal(isOpenInvite(unanswered, AT_EXPIRY + 60_000), false);
});

// --- (d) read settling ------------------------------------------------------------

test('live: settlePanelRead -- ok after loading is ready; not-ok after ready keeps the SAME object; not-ok after loading is an error', () => {
	const ready = settlePanelRead(PANEL_READ_LOADING, { ok: true, data: ['p1'] });
	assert.deepEqual(ready, { status: 'ready', data: ['p1'] });
	assert.equal(settlePanelRead(ready, { ok: false }), ready);
	assert.deepEqual(settlePanelRead(PANEL_READ_LOADING, { ok: false }), { status: 'error', data: null });
	assert.ok(Object.isFrozen(PANEL_READ_LOADING));
	assert.deepEqual(PANEL_READ_LOADING, { status: 'loading', data: null });
});

test('live: markRowsOrNull -- loading and error give null (never []); ready calls the mapper once with the data', () => {
	let calls = 0;
	/** @param {string[] | null} data */
	const toRows = (data) => {
		calls += 1;
		return authorityPeersMarkRows(data);
	};
	assert.strictEqual(markRowsOrNull(PANEL_READ_LOADING, toRows), null);
	assert.strictEqual(markRowsOrNull({ status: 'error', data: null }, toRows), null);
	assert.equal(calls, 0);
	const data = ['p1'];
	/** @type {string[] | null} */
	let seen = null;
	const rows = markRowsOrNull({ status: 'ready', data }, (d) => {
		calls += 1;
		seen = d;
		return authorityPeersMarkRows(d);
	});
	assert.equal(calls, 1);
	assert.equal(seen, data);
	assert.deepEqual(rows, [{ key: 'p1', sig: 'p1' }]);
});
