/**
 * officer-subscribe.test.mjs -- tier-1 suite for `src/officer/subscribe.js`,
 * the live dashboard's change-notice seam (contract C-7).
 *
 * O1-O3 pin the allowlist: derived, sorted, classified, and (O3) bounded by
 * the real consumers of the two hand-written lists -- the dashboard's
 * administration queries and the engine's advisory gate. O4-O9 pin delivery:
 * row-less, per network, exactly once per page, validated inbound. O10 scans
 * the module source.
 *
 * Every BroadcastChannel and subscription a test opens is closed in a
 * `finally`, so the Node test process exits on its own. Each test uses its
 * own network hash so per-network state never leaks between tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
	PAIRING_TABLES,
	ADMIN_PANEL_AND_GATE_TABLES,
	OFFICER_SUBSCRIBED_TABLES,
	OFFICER_CHANGE_OPS,
	OFFICER_CHANGE_CHANNEL_PREFIX,
	officerChangeChannelName,
	notifyOfficerPeerWrite,
	subscribeToOfficerChanges,
} from '../src/officer/subscribe.js';
import { CAPABILITY_TABLES } from '../src/officer/capability-tables.js';
import { TABLES_READ as ELECTIONS } from '../src/officer/elections.js';
import { TABLES_READ as BALLOTS } from '../src/officer/ballots.js';
import { TABLES_READ as REGISTRATIONS } from '../src/officer/registrations.js';
import { TABLES_READ as KEYHOLDERS } from '../src/officer/read-keyholders.js';
import { classOf, UnknownTableError } from '../src/classification.js';
import { stripComments } from './lib/source-scan.mjs';
import { dashboardSrc, workspacePath, webDataSrc } from '../../../scripts/lib/source-paths.mjs';

const FAKE_DB = Object.freeze({ kind: 'handle' });

/** One MessageChannel round trip, a setImmediate, then a short timer: past the task a broadcast is delivered on. */
async function pastBroadcastDelivery() {
	await new Promise((resolve) => {
		const channel = new MessageChannel();
		channel.port1.onmessage = () => {
			channel.port1.close();
			channel.port2.close();
			resolve(undefined);
		};
		channel.port2.postMessage(0);
	});
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setTimeout(resolve, 50));
}

/** @param {string} label */
function hashFor(label) {
	return `${label}-${Math.random().toString(36).slice(2, 10)}`;
}

/** @param {string} name */
function isClassified(name) {
	try {
		classOf(name);
		return true;
	} catch (err) {
		if (err instanceof UnknownTableError) return false;
		throw err;
	}
}

/**
 * Identifiers after `from` / `join` (keyword in any case, identifier starting
 * with an uppercase letter).
 * @param {string} sql
 * @returns {string[]}
 */
function tableIdentifiersOf(sql) {
	const re = /\b(?:[Ff][Rr][Oo][Mm]|[Jj][Oo][Ii][Nn])\s+([A-Z][A-Za-z0-9_]*)/g;
	/** @type {string[]} */
	const out = [];
	for (const match of sql.matchAll(re)) out.push(match[1]);
	return out;
}

const SCHEMA_QSQL = readFileSync(workspacePath('packages/vote-core', 'schema', 'votetorrent.qsql'), 'utf8');

/**
 * The body of `view <name> as ... ;` in the schema, or null when no such view.
 * @param {string} name
 * @returns {string | null}
 */
function viewBodyOf(name) {
	const marker = new RegExp(`\\bview\\s+${name}\\s+as\\b`);
	const match = marker.exec(SCHEMA_QSQL);
	if (!match) return null;
	const start = match.index + match[0].length;
	const end = SCHEMA_QSQL.indexOf(';', start);
	return SCHEMA_QSQL.slice(start, end === -1 ? undefined : end);
}

/**
 * Resolve every identifier against `list`: a classified table must be in
 * `list`; an unclassified name must be a schema view whose classified tables
 * are all in `list`; anything else is an offender.
 * @param {string[]} identifiers
 * @param {ReadonlyArray<string>} list
 * @returns {{ offenders: string[], required: string[] }}
 */
function resolveAgainst(identifiers, list) {
	/** @type {Set<string>} */
	const offenders = new Set();
	/** @type {Set<string>} */
	const required = new Set();
	/** @type {Set<string>} */
	const seenViews = new Set();
	/** @param {string} name */
	const visit = (name) => {
		if (isClassified(name)) {
			required.add(name);
			if (!list.includes(name)) offenders.add(name);
			return;
		}
		const body = viewBodyOf(name);
		if (body === null) {
			offenders.add(name);
			return;
		}
		if (seenViews.has(name)) return;
		seenViews.add(name);
		for (const inner of tableIdentifiersOf(body)) visit(inner);
	};
	for (const name of identifiers) visit(name);
	return { offenders: [...offenders].sort(), required: [...required].sort() };
}

test('O1: the subscribed list is the sorted, de-duplicated union of its sources, frozen and strictly ascending', () => {
	const expected = [
		...new Set([
			...Object.values(CAPABILITY_TABLES).flat(),
			...ELECTIONS,
			...BALLOTS,
			...REGISTRATIONS,
			...KEYHOLDERS,
			...ADMIN_PANEL_AND_GATE_TABLES,
			...PAIRING_TABLES,
		]),
	].sort();
	assert.deepEqual([...OFFICER_SUBSCRIBED_TABLES], expected);
	assert.equal(Object.isFrozen(OFFICER_SUBSCRIBED_TABLES), true);
	for (let i = 1; i < OFFICER_SUBSCRIBED_TABLES.length; i += 1) {
		assert.ok(OFFICER_SUBSCRIBED_TABLES[i - 1] < OFFICER_SUBSCRIBED_TABLES[i], 'the list is not strictly ascending');
	}
	assert.equal(Object.isFrozen(ADMIN_PANEL_AND_GATE_TABLES), true);
	assert.deepEqual([...ADMIN_PANEL_AND_GATE_TABLES], [...ADMIN_PANEL_AND_GATE_TABLES].sort());
	assert.deepEqual([...OFFICER_CHANGE_OPS], ['delete', 'insert', 'update']);
	assert.equal(Object.isFrozen(OFFICER_CHANGE_OPS), true);
});

test('O2: the pairing list has four members and every subscribed member is classified', () => {
	assert.equal(Object.isFrozen(PAIRING_TABLES), true);
	assert.equal(PAIRING_TABLES.length, 4);
	// Positive control first: the guard does reject a name the schema lacks.
	assert.throws(() => classOf('NoSuchTableForThisSuite'), UnknownTableError);
	for (const table of OFFICER_SUBSCRIBED_TABLES) {
		assert.doesNotThrow(() => classOf(table));
	}
	for (const table of PAIRING_TABLES) {
		assert.ok(OFFICER_SUBSCRIBED_TABLES.includes(table));
	}
});

test('O3: every table the admin panels and the advisory gate read is in the subscribed list', (t) => {
	const adminQueries = stripComments(readFileSync(dashboardSrc('screens', 'panels', 'authority-admin-queries.js'), 'utf8'));
	const engineSource = readFileSync(workspacePath('packages/vote-engine', 'src', 'user', 'user-engine.ts'), 'utf8');
	const start = engineSource.indexOf('async isPrivileged');
	assert.ok(start >= 0, 'the advisory gate method was not found in the engine source');
	const end = engineSource.indexOf('async ', start + 'async isPrivileged'.length);
	const gateBody = stripComments(engineSource.slice(start, end === -1 ? undefined : end));
	assert.ok(gateBody.length > 0, 'the advisory gate slice is empty');

	const panelIds = tableIdentifiersOf(adminQueries);
	const gateIds = tableIdentifiersOf(gateBody);
	assert.ok(gateIds.length >= 2, 'the advisory gate slice yielded too few identifiers');
	const identifiers = [...new Set([...panelIds, ...gateIds])].sort();
	assert.ok(identifiers.length >= 10, 'too few identifiers collected; the extraction is broken');

	const { offenders, required } = resolveAgainst(identifiers, OFFICER_SUBSCRIBED_TABLES);
	t.diagnostic('O3 identifiers: ' + identifiers.join(','));
	t.diagnostic('O3 required tables: ' + required.join(','));
	assert.deepEqual(offenders, []);

	// Every hand-written admin/gate member is actually read by one of the two sources.
	const unused = ADMIN_PANEL_AND_GATE_TABLES.filter((table) => !required.includes(table));
	assert.deepEqual(unused, []);

	// Matcher control: a classified table left out of a copied list is reported, exactly.
	const copied = OFFICER_SUBSCRIBED_TABLES.filter((table) => table !== 'Keyholder');
	const control = resolveAgainst(tableIdentifiersOf('select 1 from Officer O join Keyholder K on K.UserId = O.UserId'), copied);
	assert.deepEqual(control.offenders, ['Keyholder']);
	// And an unknown name is an offender, while a view resolves through its body.
	const viewControl = resolveAgainst(['CurrentAdmin', 'NotATableOrView'], OFFICER_SUBSCRIBED_TABLES);
	assert.deepEqual(viewControl.offenders, ['NotATableOrView']);
	assert.deepEqual(viewControl.required, ['Admin']);
});

test('O4: a listener for network A receives one frozen table/op notice; a listener for network B receives nothing', async () => {
	const a = hashFor('o4-a');
	const b = hashFor('o4-b');
	/** @type {any[]} */
	const seenA = [];
	/** @type {any[]} */
	const seenB = [];
	const releaseA = subscribeToOfficerChanges(a, (n) => seenA.push(n));
	const releaseB = subscribeToOfficerChanges(b, (n) => seenB.push(n));
	try {
		assert.equal(notifyOfficerPeerWrite(FAKE_DB, a, 'Officer', 'update'), true);
		await pastBroadcastDelivery();
		assert.equal(seenA.length, 1);
		assert.deepEqual(Object.keys(seenA[0]).sort(), ['op', 'table']);
		assert.equal(seenA[0].table, 'Officer');
		assert.equal(seenA[0].op, 'update');
		assert.equal(Object.isFrozen(seenA[0]), true);
		assert.equal(seenB.length, 0);
	} finally {
		releaseA();
		releaseB();
	}
});

test('O5: off-list table, upsert op, falsy db and empty network hash each return false and deliver nothing', async () => {
	const a = hashFor('o5');
	/** @type {any[]} */
	const seen = [];
	const release = subscribeToOfficerChanges(a, (n) => seen.push(n));
	try {
		assert.equal(notifyOfficerPeerWrite(FAKE_DB, a, 'NoSuchTableForThisSuite', 'update'), false);
		assert.equal(notifyOfficerPeerWrite(FAKE_DB, a, 'Officer', 'upsert'), false);
		assert.equal(notifyOfficerPeerWrite(null, a, 'Officer', 'insert'), false);
		assert.equal(notifyOfficerPeerWrite(FAKE_DB, '', 'Officer', 'insert'), false);
		assert.equal(notifyOfficerPeerWrite(FAKE_DB, /** @type {any} */ (42), 'Officer', 'insert'), false);
		assert.equal(notifyOfficerPeerWrite(FAKE_DB, a, /** @type {any} */ (undefined), /** @type {any} */ (undefined)), false);
		await pastBroadcastDelivery();
		assert.equal(seen.length, 0);
	} finally {
		release();
	}
});

test('O6: the wire message carries exactly kind, op and table, and nothing from the handle', async () => {
	const a = hashFor('o6');
	const sentinel = 'SENTINEL-' + Math.random().toString(36).slice(2);
	const db = { kind: 'handle', planted: sentinel };
	const raw = new BroadcastChannel(officerChangeChannelName(a));
	/** @type {any[]} */
	const messages = [];
	raw.onmessage = (event) => messages.push(event.data);
	try {
		assert.equal(notifyOfficerPeerWrite(db, a, 'UserKey', 'insert'), true);
		await pastBroadcastDelivery();
		assert.equal(messages.length, 1);
		assert.deepEqual(Object.keys(messages[0]).sort(), ['kind', 'op', 'table']);
		assert.equal(messages[0].kind, 'officer-change');
		assert.equal(messages[0].table, 'UserKey');
		assert.equal(messages[0].op, 'insert');
		assert.equal(JSON.stringify(messages[0]).includes(sentinel), false);
		assert.equal(officerChangeChannelName(a), OFFICER_CHANGE_CHANNEL_PREFIX + a);
	} finally {
		raw.onmessage = null;
		raw.close();
	}
});

test('O7: inbound messages are validated and re-delivered as a new frozen table/op literal', async () => {
	const a = hashFor('o7');
	/** @type {any[]} */
	const seen = [];
	const release = subscribeToOfficerChanges(a, (n) => seen.push(n));
	const raw = new BroadcastChannel(officerChangeChannelName(a));
	try {
		raw.postMessage({ kind: 'officer-change', table: 'Officer', op: 'delete' });
		raw.postMessage({ kind: 'public-change', table: 'Officer', op: 'delete' });
		raw.postMessage({ kind: 'officer-change', table: 'NoSuchTableForThisSuite', op: 'delete' });
		raw.postMessage({ kind: 'officer-change', table: 'Officer', op: 7 });
		raw.postMessage({ kind: 'officer-change', table: 'User', op: 'insert', row: { Name: 'planted' } });
		raw.postMessage('not an object');
		await pastBroadcastDelivery();
		assert.equal(seen.length, 2);
		assert.deepEqual({ ...seen[0] }, { table: 'Officer', op: 'delete' });
		assert.deepEqual(Object.keys(seen[1]).sort(), ['op', 'table']);
		assert.equal(seen[1].table, 'User');
		assert.equal('row' in seen[1], false);
		assert.equal(Object.isFrozen(seen[0]), true);
		assert.equal(Object.isFrozen(seen[1]), true);
	} finally {
		raw.onmessage = null;
		raw.close();
		release();
	}
});

test('O8: with a subscription in this page, one notify gives exactly one delivery and one wire message', async () => {
	const a = hashFor('o8');
	/** @type {any[]} */
	const seen = [];
	const release = subscribeToOfficerChanges(a, (n) => seen.push(n));
	const raw = new BroadcastChannel(officerChangeChannelName(a));
	/** @type {any[]} */
	const messages = [];
	raw.onmessage = (event) => messages.push(event.data);
	try {
		assert.equal(notifyOfficerPeerWrite(FAKE_DB, a, 'Network', 'update'), true);
		await pastBroadcastDelivery();
		assert.equal(seen.length, 1);
		assert.equal(messages.length, 1);
	} finally {
		raw.onmessage = null;
		raw.close();
		release();
	}
});

test('O9: release is idempotent, a released network hears nothing, a throwing listener does not stop others, bad args throw', async () => {
	const a = hashFor('o9');
	/** @type {any[]} */
	const seen = [];
	const releaseThrowing = subscribeToOfficerChanges(a, () => {
		throw new Error('listener failure for this suite');
	});
	const releaseSecond = subscribeToOfficerChanges(a, (n) => seen.push(n));
	const raw = new BroadcastChannel(officerChangeChannelName(a));
	const originalError = console.error;
	/** @type {any[][]} */
	const logged = [];
	console.error = (...args) => logged.push(args);
	try {
		assert.equal(notifyOfficerPeerWrite(FAKE_DB, a, 'Officer', 'insert'), true);
		await pastBroadcastDelivery();
		assert.equal(seen.length, 1);
		assert.equal(logged.length, 1);
		assert.deepEqual(logged[0], ['officer/subscribe:', 'Error']);

		releaseThrowing();
		releaseThrowing();
		releaseSecond();
		releaseSecond();

		raw.postMessage({ kind: 'officer-change', table: 'Officer', op: 'insert' });
		await pastBroadcastDelivery();
		assert.equal(seen.length, 1);
	} finally {
		console.error = originalError;
		raw.close();
		releaseThrowing();
		releaseSecond();
	}

	assert.throws(() => subscribeToOfficerChanges(a, /** @type {any} */ (null)), TypeError);
	assert.throws(() => subscribeToOfficerChanges('', () => {}), TypeError);
	assert.throws(() => subscribeToOfficerChanges(/** @type {any} */ (7), () => {}), TypeError);
	assert.throws(() => officerChangeChannelName(''), TypeError);
});

test('O10: the module source has no spread of an event or message, no stringify, and one name-only logger', () => {
	const source = stripComments(readFileSync(webDataSrc('officer', 'subscribe.js'), 'utf8'));
	const dots = '.'.repeat(3);
	const spreads = ['event', 'message', 'data', 'notice'].map((word) => dots + word);
	const stringify = ['JSON', 'stringify'].join('.');
	const found = [...spreads, stringify].filter((token) => source.includes(token));
	assert.deepEqual(found, []);
	const consoleCalls = source.match(/console\.[a-z]+\(/g) ?? [];
	assert.deepEqual(consoleCalls, ['console.error(']);
	assert.ok(source.includes('console.error(LOG_PREFIX, name)'), 'the logger is not the name-only form');
	// Matcher control: the same tokens fire on a source that spreads a message.
	const control = 'post({ ' + dots + 'message, extra: 1 });';
	assert.equal([...spreads, stringify].some((token) => control.includes(token)), true);
});
