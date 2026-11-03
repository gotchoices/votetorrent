/**
 * peer-reactivity-bridge.test.mjs — behaviour contract for
 * `src/peer/reactivity-bridge.js` (`56-09` Task 2; moved to `node.reactivityWatch` in step 3 of the
 * 2026-11-02 recommended order).
 *
 * The fakes below are fakes of the SEAMS this module reads, never of the
 * module itself:
 *   - a fake `node` exposing only `reactivityWatch`, whose `watch(req)` records each request so a
 *     test can wake the bridge by calling the request's own `onChange` -- exactly what the watch
 *     service does on a notification, a local landing or a tick;
 *   - ONE group of tests drives the REAL `ReactivityCollectionWatch` from `@optimystic/db-p2p`
 *     instead, over a fake `CohortTopicService` whose `verifier().verifyMessage(...)` returns a
 *     caller-controlled verdict and the REAL `ReactivitySubscriberRegistry`, so a synthetic
 *     `NotificationV1` delivered through `registry.deliver(topicId, n)` -- the real socket-delivery
 *     seam -- wakes the page only when the upstream manager verified it;
 *   - a fake `Database` exposing `schemaManager` and `ingestExternalRowChanges`, plus a store module
 *     whose `applyExternalRowChanges` returns a caller-controlled `BackingRowChange[]`;
 *   - a REAL `subscribeToPublicChanges` subscription on that same fake handle, so every
 *     notice-content assertion below runs through the real `subscribe.js` code this module calls
 *     into, not a stand-in.
 *
 * No test here waits on a real timer: the real watch service gets a `setTimer` that records and never
 * fires, and the bridge itself schedules nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bytesToB64url, edgeProfile, reactivityCollectionTopicId, DEFAULT_SUPER_MAJORITY_THRESHOLD } from '@optimystic/db-core';
import { ReactivityCollectionWatch, ReactivitySubscriberRegistry, reactivityCollectionIdBytes, reactivityTailBytes } from '@optimystic/db-p2p';
import { PUBLIC_SUBSCRIBED_TABLES } from '@votetorrent/web-data/public';
import { publicSrc, moduleUrl } from '../../../../scripts/lib/source-paths.mjs';
import {
	PeerReplicationError,
	resolveWatchService,
	resolvePublicStoreModule,
	applyPeerRowBatch,
	startPeerReplication,
} from '../../src/peer/reactivity-bridge.js';

/**
 * Let queued microtasks and immediates run.
 * @returns {Promise<void>}
 */
function flush() {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Flush until `predicate()` holds, a bounded number of times. No real timer.
 * @param {() => boolean} predicate
 * @param {string} label
 */
async function flushUntil(predicate, label) {
	for (let i = 0; i < 200; i++) {
		if (predicate()) return;
		await flush();
	}
	assert.fail(`never reached: ${label}`);
}

/**
 * A call-recording spy. `calls` is the ARGUMENT LISTS.
 * @param {(...args: any[]) => any} [impl]
 */
function spy(impl = () => undefined) {
	/** @type {any[][]} */
	const calls = [];
	/** @type {any} */
	const fn = (/** @type {any[]} */ ...args) => {
		calls.push(args);
		return impl(...args);
	};
	fn.calls = calls;
	return fn;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A real, subscribed table -- it must be a genuine member of the derived allowlist so the
 * "allowed" tests are not vacuous. @type {string} */
const VALID_TABLE = PUBLIC_SUBSCRIBED_TABLES[0];

/** A real schema table that is NOT public-safe. @type {string} */
const FORBIDDEN_TABLE = 'RegistrationBridgeKey';

const NETWORK_HASH = 'aBcDeF0123456789aBcDeF0123456789fixture';

/** A collection id in the shape the strand's blocks carry (`default/<Table>`). */
const COLLECTION_ID = `default/${VALID_TABLE}`;
const TAIL_ID = 'vt-fixture-tail-block-id-0123456789abcdef';

/** A sentinel that must never reach a delivered notice -- planted inside an applied row's image. */
const SECRET = 'PLANTED-ROW-SECRET-MUST-NOT-ESCAPE-0123456789';

/** A tail reader the bridge only passes through to the watch service. */
const FAKE_TAILS = { readTails: async () => new Map() };

/**
 * A fake `node.reactivityWatch`. Each `watch(req)` is recorded; `wake()` calls every recorded
 * request's `onChange`, as the watch service does.
 */
function makeFakeWatch() {
	/** @type {any[]} */
	const requests = [];
	const closes = spy(async () => undefined);
	const watch = spy((/** @type {any} */ req) => {
		requests.push(req);
		return { close: () => closes(req.collectionId) };
	});
	return { watch, requests, closes, wake: () => requests.forEach((req) => req.onChange()) };
}

/**
 * A fake externally-writable store table.
 * @param {(ops: readonly any[]) => Promise<any[]> | any[]} applyImpl
 */
function makeFakeStoreTable(applyImpl) {
	const applyExternalRowChanges = spy(async (/** @type {readonly any[]} */ ops) => applyImpl(ops));
	return { applyExternalRowChanges };
}

/**
 * A fake `Database`. `storeTable` is what `getTableForExternalWrite` returns
 * for `VALID_TABLE`; `undefined` for any other table name, mirroring
 * `snapshot-restore.js`'s own store-module contract.
 * @param {{ storeTable?: any, isolationWrap?: boolean, noModule?: boolean }} [opts]
 */
function makeFakeDb(opts = {}) {
	const ingestExternalRowChanges = spy(async () => undefined);
	const moduleCore = {
		getTableForExternalWrite: spy((/** @type {any} */ _db, /** @type {string} */ _schema, /** @type {string} */ tableName) =>
			tableName === VALID_TABLE ? opts.storeTable : undefined,
		),
	};
	const registeredModule = opts.noModule
		? undefined
		: opts.isolationWrap
			? { module: { underlying: moduleCore } }
			: { module: moduleCore };
	/** @type {any} */
	const db = {
		schemaManager: {
			getModule: spy((/** @type {string} */ _name) => registeredModule),
			getCurrentSchemaName: () => 'main',
			getTable: () => ({ name: VALID_TABLE, columns: [] }),
		},
		ingestExternalRowChanges,
		// A no-op release is enough: `subscribeToPublicChanges` only needs
		// `onDataChange` to be a function to report `live: true` and register
		// into `subscribe.js`'s own `REMOTE_SINKS`, which is the channel
		// `notifyPeerWrite`'s local dispatch actually feeds.
		onDataChange: () => () => undefined,
	};
	return { db, ingestExternalRowChanges, moduleCore };
}

// ---------------------------------------------------------------------------
// 1. resolveWatchService
// ---------------------------------------------------------------------------

test('resolveWatchService returns node.reactivityWatch when present', () => {
	const fake = makeFakeWatch();
	assert.equal(resolveWatchService({ reactivityWatch: fake }), fake);
});

test('resolveWatchService throws PeerReplicationError naming reactivityWatch when the node has none, never returns undefined', () => {
	for (const node of [{}, { reactivityWatch: {} }, null]) {
		assert.throws(
			() => resolveWatchService(node),
			(/** @type {any} */ err) => err instanceof PeerReplicationError && err.subject === 'reactivityWatch',
		);
	}
});

// ---------------------------------------------------------------------------
// 2. resolvePublicStoreModule
// ---------------------------------------------------------------------------

test('resolvePublicStoreModule returns the module directly when it exposes getTableForExternalWrite', () => {
	const { db, moduleCore } = makeFakeDb({ storeTable: makeFakeStoreTable(() => []) });
	assert.equal(resolvePublicStoreModule(db), moduleCore);
});

test('resolvePublicStoreModule unwraps an isolation wrapper\'s underlying module', () => {
	const { db, moduleCore } = makeFakeDb({ storeTable: makeFakeStoreTable(() => []), isolationWrap: true });
	assert.equal(resolvePublicStoreModule(db), moduleCore);
});

test('resolvePublicStoreModule throws PeerReplicationError naming STORE_MODULE_NAME when no module is registered', () => {
	const { db } = makeFakeDb({ noModule: true });
	assert.throws(
		() => resolvePublicStoreModule(db),
		(/** @type {any} */ err) => err instanceof PeerReplicationError && err.subject === 'store',
	);
});

// ---------------------------------------------------------------------------
// 3. applyPeerRowBatch
// ---------------------------------------------------------------------------

test('applyPeerRowBatch refuses a table outside PUBLIC_SUBSCRIBED_TABLES and applies nothing', async () => {
	assert.ok(!PUBLIC_SUBSCRIBED_TABLES.includes(FORBIDDEN_TABLE), 'fixture sanity: FORBIDDEN_TABLE must not be a real member of the allowlist');
	const { db } = makeFakeDb({ storeTable: makeFakeStoreTable(() => []) });
	await assert.rejects(
		applyPeerRowBatch(db, FORBIDDEN_TABLE, [{ op: 'upsert', row: ['x'] }]),
		(/** @type {any} */ err) => err instanceof PeerReplicationError && err.subject === FORBIDDEN_TABLE,
	);
});

test('applyPeerRowBatch returns the effective BackingRowChange[] the store table reports and applies through ingestExternalRowChanges once', async () => {
	const changes = [{ op: 'insert', newRow: ['a'] }];
	const storeTable = makeFakeStoreTable(() => changes);
	const { db, ingestExternalRowChanges } = makeFakeDb({ storeTable });
	const result = await applyPeerRowBatch(db, VALID_TABLE, [{ op: 'upsert', row: ['a'] }]);
	assert.deepEqual(result, changes);
	assert.equal(storeTable.applyExternalRowChanges.calls.length, 1);
	assert.equal(ingestExternalRowChanges.calls.length, 1);
	const [batches, options] = ingestExternalRowChanges.calls[0];
	assert.equal(batches.length, 1);
	assert.equal(batches[0].tableName, VALID_TABLE);
	assert.deepEqual(options, { captureChanges: false, applyForeignKeyActions: false });
});

test('applyPeerRowBatch returns an empty array for a value-identical batch, and does not call ingestExternalRowChanges', async () => {
	const storeTable = makeFakeStoreTable(() => []);
	const { db, ingestExternalRowChanges } = makeFakeDb({ storeTable });
	const result = await applyPeerRowBatch(db, VALID_TABLE, [{ op: 'upsert', row: ['a'] }]);
	assert.deepEqual(result, []);
	assert.equal(ingestExternalRowChanges.calls.length, 0, 'an empty effective-change batch must not reach ingestExternalRowChanges');
});

test('applyPeerRowBatch throws PeerReplicationError naming the table when the store module has no externally-writable handle for it', async () => {
	const { db } = makeFakeDb({ storeTable: undefined });
	await assert.rejects(
		applyPeerRowBatch(db, VALID_TABLE, [{ op: 'upsert', row: ['a'] }]),
		(/** @type {any} */ err) => err instanceof PeerReplicationError && err.subject === VALID_TABLE,
	);
});

// ---------------------------------------------------------------------------
// 4. startPeerReplication -- required options
// ---------------------------------------------------------------------------

/** @returns {any} a complete, otherwise-valid options object over a fake watch. */
function validOptions() {
	const { db } = makeFakeDb({ storeTable: makeFakeStoreTable(() => []) });
	const fake = makeFakeWatch();
	return {
		db,
		networkHash: NETWORK_HASH,
		node: { reactivityWatch: fake },
		collections: [{ table: VALID_TABLE, collectionId: COLLECTION_ID }],
		tails: FAKE_TAILS,
		readRows: async () => [],
	};
}

test('startPeerReplication throws PeerReplicationError naming each required option when omitted', () => {
	for (const key of ['db', 'networkHash', 'node', 'collections', 'tails', 'readRows']) {
		const options = validOptions();
		delete options[key];
		assert.throws(
			() => startPeerReplication(options),
			(/** @type {any} */ err) => err instanceof PeerReplicationError && err.subject === key,
			`omitting ${key} must throw naming it`,
		);
	}
});

test('readRows has no default: a non-function readRows throws naming "readRows" rather than silently starting', () => {
	const options = validOptions();
	options.readRows = 'not-a-function';
	assert.throws(
		() => startPeerReplication(options),
		(/** @type {any} */ err) => err instanceof PeerReplicationError && err.subject === 'readRows',
	);
});

test('an empty collections list, a table outside the allowlist, or a missing collectionId is refused by name, and nothing is watched', () => {
	/** @type {Array<[any, string]>} */
	const cases = [
		[[], 'collections'],
		[[{ table: FORBIDDEN_TABLE, collectionId: 'default/x' }], FORBIDDEN_TABLE],
		[[{ table: VALID_TABLE, collectionId: '' }], VALID_TABLE],
	];
	for (const [collections, subject] of cases) {
		const options = validOptions();
		options.collections = collections;
		assert.throws(
			() => startPeerReplication(options),
			(/** @type {any} */ err) => err instanceof PeerReplicationError && err.subject === subject,
		);
		assert.equal(options.node.reactivityWatch.watch.calls.length, 0, 'a refused start must open no watch');
	}
});

test('a node without a watch service fails the start by name, never a page that quietly never updates', () => {
	const options = validOptions();
	options.node = {};
	assert.throws(
		() => startPeerReplication(options),
		(/** @type {any} */ err) => err instanceof PeerReplicationError && err.subject === 'reactivityWatch',
	);
});

test('startPeerReplication opens one watch per collection, each with the collection id, the shared tail reader and an onChange', () => {
	const options = validOptions();
	options.collections = PUBLIC_SUBSCRIBED_TABLES.map((table) => ({ table, collectionId: `default/${table}` }));
	const fake = options.node.reactivityWatch;
	startPeerReplication(options);
	assert.equal(fake.requests.length, PUBLIC_SUBSCRIBED_TABLES.length);
	assert.deepEqual(
		fake.requests.map((/** @type {any} */ req) => req.collectionId),
		PUBLIC_SUBSCRIBED_TABLES.map((table) => `default/${table}`),
	);
	for (const req of fake.requests) {
		assert.equal(req.tails, FAKE_TAILS, 'every watch must share the ONE tail reader, so a tick reads them together');
		assert.equal(typeof req.onChange, 'function');
	}
});

test('nothing is read before a wake: the watch service\'s first tail read is what triggers the first pass', async () => {
	const options = validOptions();
	const readRows = spy(async () => []);
	options.readRows = readRows;
	startPeerReplication(options);
	await flush();
	assert.equal(readRows.calls.length, 0);
});

// ---------------------------------------------------------------------------
// 5. A wake -> readRows -> apply -> notice
// ---------------------------------------------------------------------------

/**
 * Start the bridge over a fake watch and a fake db with a REAL `subscribeToPublicChanges`
 * subscription on it. `startPeerReplicationImpl` defaults to the real export; the source-transform
 * control below passes the MUTATED copy's export, so both run the same harness.
 * @param {any} storeTable
 * @param {() => Promise<any[]>} readRows
 * @param {(options: any) => any} [startPeerReplicationImpl]
 */
async function startHarness(storeTable, readRows, startPeerReplicationImpl = startPeerReplication) {
	const { subscribeToPublicChanges } = await import('@votetorrent/web-data/public');
	const { db } = makeFakeDb({ storeTable });
	const fake = makeFakeWatch();
	/** @type {any[]} */
	const notices = [];
	const subscription = subscribeToPublicChanges(db, (/** @type {any} */ notice) => notices.push(notice));
	assert.equal(subscription.live, true, 'harness sanity: the fake db must expose a live change channel');
	const handle = startPeerReplicationImpl({
		db,
		networkHash: NETWORK_HASH,
		node: { reactivityWatch: fake },
		collections: [{ table: VALID_TABLE, collectionId: COLLECTION_ID }],
		tails: FAKE_TAILS,
		readRows,
	});
	/** Wake the bridge and wait for its pass to finish. */
	const wakeAndSettle = async () => {
		fake.wake();
		await handle.whenIdle();
	};
	return { db, fake, notices, handle, subscription, wakeAndSettle };
}

test('on a wake, readRows is called exactly once, with no argument -- a wake carries no payload to pass on', async () => {
	const readRows = spy(async () => []);
	const { wakeAndSettle } = await startHarness(makeFakeStoreTable(() => []), readRows);
	await wakeAndSettle();
	assert.equal(readRows.calls.length, 1);
	assert.deepEqual(readRows.calls[0], []);
});

test('the bridge applies each returned batch and calls notifyPeerWrite once per distinct (table, op) pair present in the effective changes', async () => {
	const storeTable = makeFakeStoreTable(() => [
		{ op: 'insert', newRow: ['a'] },
		{ op: 'insert', newRow: ['b'] }, // same op -- must not double-notify
		{ op: 'update', oldRow: ['c'], newRow: ['d'] },
	]);
	const { notices, wakeAndSettle } = await startHarness(storeTable, async () => [{ table: VALID_TABLE, ops: [{ op: 'upsert', row: ['a'] }] }]);

	await wakeAndSettle();

	assert.equal(notices.length, 2, `expected exactly 2 notices for 2 distinct (table, op) pairs, got ${notices.length}`);
	assert.deepEqual(
		notices.map((/** @type {any} */ n) => `${n.table}:${n.type}`).sort(),
		[`${VALID_TABLE}:insert`, `${VALID_TABLE}:update`].sort(),
	);
	for (const n of notices) {
		assert.equal(n.remote, true);
		assert.deepEqual(Object.keys(n).sort(), ['remote', 'table', 'type']);
	}
});

test('a wake whose readRows yields batches producing no effective change results in ZERO notices', async () => {
	const { notices, wakeAndSettle } = await startHarness(makeFakeStoreTable(() => []), async () => [
		{ table: VALID_TABLE, ops: [{ op: 'upsert', row: ['a'] }] },
	]);
	await wakeAndSettle();
	assert.equal(notices.length, 0);
});

test('a batch naming a table outside PUBLIC_SUBSCRIBED_TABLES is refused whole and produces no notice, without throwing out of the wake', async () => {
	const storeTable = makeFakeStoreTable(() => [{ op: 'insert', newRow: ['a'] }]);
	const { notices, wakeAndSettle } = await startHarness(storeTable, async () => [{ table: FORBIDDEN_TABLE, ops: [{ op: 'upsert', row: ['a'] }] }]);
	await wakeAndSettle();
	assert.equal(storeTable.applyExternalRowChanges.calls.length, 0);
	assert.equal(notices.length, 0);
});

test('a rejecting readRows is caught, logs the error NAME only, fires no notice, and the next wake still runs', async () => {
	let calls = 0;
	const storeTable = makeFakeStoreTable(() => [{ op: 'insert', newRow: ['a'] }]);
	const { notices, wakeAndSettle } = await startHarness(storeTable, async () => {
		calls += 1;
		if (calls === 1) {
			const err = new Error(`a message carrying ${SECRET}`);
			err.name = 'FixtureReadError';
			throw err;
		}
		return [{ table: VALID_TABLE, ops: [{ op: 'upsert', row: ['a'] }] }];
	});
	/** @type {any[][]} */
	const logged = [];
	const original = console.error;
	console.error = (...args) => logged.push(args);
	try {
		await wakeAndSettle();
	} finally {
		console.error = original;
	}
	assert.equal(notices.length, 0);
	assert.deepEqual(logged, [['peer/reactivity-bridge:', 'FixtureReadError']]);
	assert.ok(!JSON.stringify(logged).includes(SECRET));

	await wakeAndSettle();
	assert.equal(notices.length, 1, 'the bridge must keep working after a failed pass');
});

test('an applyPeerRowBatch throw (a refused batch) is caught the same way: no notice fires, and a later wake still delivers', async () => {
	let fail = true;
	const storeTable = makeFakeStoreTable(() => {
		if (fail) throw new Error('refused');
		return [{ op: 'insert', newRow: ['a'] }];
	});
	const { notices, wakeAndSettle } = await startHarness(storeTable, async () => [{ table: VALID_TABLE, ops: [{ op: 'upsert', row: ['a'] }] }]);
	const original = console.error;
	console.error = () => undefined;
	try {
		await wakeAndSettle();
	} finally {
		console.error = original;
	}
	assert.equal(notices.length, 0);
	fail = false;
	await wakeAndSettle();
	assert.equal(notices.length, 1);
});

test('a sentinel value planted in an applied row never reaches a delivered notice', async () => {
	const storeTable = makeFakeStoreTable(() => [{ op: 'insert', newRow: [SECRET, 'other-field'] }]);
	const { notices, wakeAndSettle } = await startHarness(storeTable, async () => [
		{ table: VALID_TABLE, ops: [{ op: 'upsert', row: [SECRET, 'other-field'] }] },
	]);
	await wakeAndSettle();
	assert.equal(notices.length, 1);
	assert.ok(!JSON.stringify(notices).includes(SECRET), 'the planted row sentinel escaped into a delivered notice');
});

test('wakes are folded: wakes during a pass cause exactly ONE more pass, never one per wake and never two at once', async () => {
	/** @type {Array<() => void>} */
	const releases = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const readRows = spy(async () => {
		inFlight += 1;
		maxInFlight = Math.max(maxInFlight, inFlight);
		await new Promise((resolve) => releases.push(() => resolve(undefined)));
		inFlight -= 1;
		return [];
	});
	const { fake, handle } = await startHarness(makeFakeStoreTable(() => []), readRows);

	fake.wake();
	await flushUntil(() => releases.length === 1, 'the first pass started');
	fake.wake();
	fake.wake();
	fake.wake();
	releases[0]();
	await flushUntil(() => releases.length === 2, 'the folded second pass started');
	releases[1]();
	await handle.whenIdle();

	assert.equal(readRows.calls.length, 2, 'three wakes during one pass must fold into exactly one more pass');
	assert.equal(maxInFlight, 1, 'two passes ran at once');
});

// ---------------------------------------------------------------------------
// 6. stop()
// ---------------------------------------------------------------------------

test('stop() closes every watch, is idempotent, and no pass starts after it', async () => {
	const options = validOptions();
	options.collections = PUBLIC_SUBSCRIBED_TABLES.map((table) => ({ table, collectionId: `default/${table}` }));
	const readRows = spy(async () => []);
	options.readRows = readRows;
	const fake = options.node.reactivityWatch;
	const handle = startPeerReplication(options);

	await handle.stop();
	assert.equal(fake.closes.calls.length, PUBLIC_SUBSCRIBED_TABLES.length);
	await handle.stop();
	assert.equal(fake.closes.calls.length, PUBLIC_SUBSCRIBED_TABLES.length, 'a second stop() must not close again');

	fake.wake();
	await handle.whenIdle();
	assert.equal(readRows.calls.length, 0, 'a wake after stop() must not start a pass');
});

test('a watch whose close rejects does not stop the others closing, and stop() does not throw', async () => {
	const options = validOptions();
	options.collections = PUBLIC_SUBSCRIBED_TABLES.slice(0, 3).map((table) => ({ table, collectionId: `default/${table}` }));
	let closed = 0;
	let first = true;
	options.node = {
		reactivityWatch: {
			watch: () => ({
				close: async () => {
					if (first) {
						first = false;
						throw new Error('close failed');
					}
					closed += 1;
				},
			}),
		},
	};
	const handle = startPeerReplication(options);
	const original = console.error;
	console.error = () => undefined;
	try {
		await handle.stop();
	} finally {
		console.error = original;
	}
	assert.equal(closed, 2);
});

// ---------------------------------------------------------------------------
// 7. The REAL upstream watch service: a notification wakes the page only once verified.
// ---------------------------------------------------------------------------

/**
 * A fake `CohortTopicService`. `verify` is read on every `verifyMessage` call, so a test can flip it.
 * @param {{ verify: 'verified' | 'untrusted' }} state
 */
function makeFakeService(state) {
	return {
		register: spy(async (/** @type {any} */ req) => ({
			topicId: req.topicId,
			tier: req.tier,
			primary: new Uint8Array([1]),
			backups: [],
			cohortEpoch: new Uint8Array([2]),
			cohortMembers: [],
			renewal: {},
		})),
		renew: spy(async () => undefined),
		renewMany: spy(async () => []),
		withdraw: spy(async () => undefined),
		moveRoot: spy(async () => undefined),
		lookup: async () => {
			throw new Error('lookup: not exercised by this fixture');
		},
		cohortGossip: () => ({}),
		verifier: () => ({ verifyMessage: async () => state.verify }),
	};
}

/**
 * A syntactically valid `NotificationV1` for `COLLECTION_ID` at `revision`. Its signature fields are
 * dummy text: the fake service decides the verdict.
 * @param {number} revision
 */
function makeNotification(revision) {
	return {
		v: /** @type {1} */ (1),
		collectionId: bytesToB64url(reactivityCollectionIdBytes(COLLECTION_ID)),
		tailId: bytesToB64url(reactivityTailBytes(TAIL_ID)),
		revision,
		digest: bytesToB64url(new TextEncoder().encode(`digest-${revision}`)),
		timestamp: Date.now(),
		sig: bytesToB64url(new TextEncoder().encode(`sig-${revision}`)),
		signers: [bytesToB64url(new TextEncoder().encode('signer-1'))],
	};
}

/**
 * The bridge over a REAL `ReactivityCollectionWatch`. Its timer seam records and never fires, so no
 * tick runs; the first committed-tail read (revision 1) and delivered notifications are the only wakes.
 */
async function startRealWatchHarness() {
	const state = { verify: /** @type {'verified' | 'untrusted'} */ ('verified') };
	const service = makeFakeService(state);
	const registry = new ReactivitySubscriberRegistry();
	const watchService = new ReactivityCollectionWatch({
		service: /** @type {any} */ (service),
		profile: edgeProfile(),
		subscribers: registry,
		quorumRatio: DEFAULT_SUPER_MAJORITY_THRESHOLD,
		scheduleRotation: () => undefined,
		setTimer: () => () => undefined,
	});
	const tails = {
		readTails: async (/** @type {any[]} */ queries) =>
			new Map(queries.map((q) => [q.collectionId, { tail: { tailId: TAIL_ID, revision: 1 } }])),
	};
	const readRows = spy(async () => []);
	const { db } = makeFakeDb({ storeTable: makeFakeStoreTable(() => []) });
	const handle = startPeerReplication({
		db,
		networkHash: NETWORK_HASH,
		node: { reactivityWatch: watchService },
		collections: [{ table: VALID_TABLE, collectionId: COLLECTION_ID }],
		tails,
		readRows,
	});
	const topicId = reactivityCollectionTopicId(reactivityCollectionIdBytes(COLLECTION_ID));
	return { state, service, registry, watchService, readRows, handle, topicId };
}

test('real watch: the first committed-tail read wakes the page once, and the subscription registers with the cohort', async () => {
	const h = await startRealWatchHarness();
	try {
		await flushUntil(() => h.readRows.calls.length === 1 && h.watchService.isAttached(COLLECTION_ID), 'first wake + registration');
		await h.handle.whenIdle();
		assert.equal(h.readRows.calls.length, 1);
		assert.ok(h.service.register.calls.length >= 1);
	} finally {
		await h.handle.stop();
		await h.watchService.stop();
	}
});

test('real watch: the same next-revision notification does not wake the page while UNTRUSTED, and does once VERIFIED', async () => {
	const h = await startRealWatchHarness();
	try {
		await flushUntil(() => h.readRows.calls.length === 1 && h.watchService.isAttached(COLLECTION_ID), 'first wake + registration');
		await h.handle.whenIdle();

		h.state.verify = 'untrusted';
		h.registry.deliver(h.topicId, makeNotification(2));
		for (let i = 0; i < 20; i++) await flush();
		await h.handle.whenIdle();
		assert.equal(h.readRows.calls.length, 1, 'an unverified notification woke the page');

		// The SAME revision again, now verified: only the verdict differs. (A later revision would be a
		// gap after the dropped one, which upstream fills by a re-read on its timer, not by this delivery.)
		h.state.verify = 'verified';
		h.registry.deliver(h.topicId, makeNotification(2));
		await flushUntil(() => h.readRows.calls.length === 2, 'verified notification wake');
		await h.handle.whenIdle();
		assert.equal(h.readRows.calls.length, 2);
	} finally {
		await h.handle.stop();
		await h.watchService.stop();
	}
});

test('real watch: stop() releases the subscription (the service watches nothing afterwards)', async () => {
	const h = await startRealWatchHarness();
	try {
		await flushUntil(() => h.watchService.isAttached(COLLECTION_ID), 'registration');
		await h.handle.stop();
		await flushUntil(() => h.watchService.watchedCount === 0, 'subscription released');
	} finally {
		await h.watchService.stop();
	}
});

// ---------------------------------------------------------------------------
// 8. `56-09` Task 3 -- the source-transform isolation control.
//
// Proves the single `notifyPeerWrite(...)` call site is mechanically
// removable, and that removing it kills EXACTLY the notify while rows still
// land: the transform matched exactly one line, the store still received the
// applied batch, and the subscription received zero notices.
//
// DOES NOT PROVE the browser page re-renders (`56-11`'s liveness proof) and
// is NOT `56-13`'s D-16 production-variant inversion, which must rebuild a
// genuinely mutated BUNDLE rather than transform a source copy.
// ---------------------------------------------------------------------------

test('the single notifyPeerWrite(...) call site is mechanically removable by a one-line source transform -- exactly one line matched, rows still land, zero notices fire', async () => {
	const sourcePath = publicSrc('peer', 'reactivity-bridge.js');
	const source = readFileSync(sourcePath, 'utf8');

	const CALL_LINE_RE = /^\t+notifyPeerWrite\(db, networkHash, table, op\);\n/gm;
	const matches = source.match(CALL_LINE_RE);
	assert.equal(
		matches ? matches.length : 0,
		1,
		`the pinned notifyPeerWrite call-site pattern matched ${matches ? matches.length : 0} line(s), not exactly 1`,
	);

	const mutated = source.replace(CALL_LINE_RE, '');
	assert.notEqual(mutated, source, 'the transform did not change the source');

	// Written BESIDE the original, under this app's own src/peer/ tree, so the
	// mutated copy's bare-specifier imports still resolve through this app's
	// own node_modules. Cleaned up in a `finally`; never committed.
	const tmpDir = mkdtempSync(publicSrc('peer', '.tmp-mutant-'));
	try {
		const mutantPath = path.join(tmpDir, 'reactivity-bridge.mutant.mjs');
		writeFileSync(mutantPath, mutated);
		/** @type {any} */
		const mutantModule = await import(moduleUrl(mutantPath));
		assert.equal(typeof mutantModule.startPeerReplication, 'function', 'the mutated copy failed to import cleanly -- this control would prove nothing');

		const storeTable = makeFakeStoreTable(() => [{ op: 'insert', newRow: ['a'] }]);
		const { notices, wakeAndSettle } = await startHarness(
			storeTable,
			async () => [{ table: VALID_TABLE, ops: [{ op: 'upsert', row: ['a'] }] }],
			mutantModule.startPeerReplication,
		);
		await wakeAndSettle();

		assert.equal(
			storeTable.applyExternalRowChanges.calls.length,
			1,
			'the mutated copy never applied the batch at all -- a broken copy would also show zero notices, proving nothing',
		);
		assert.equal(notices.length, 0, 'the mutated copy still delivered a notice -- the transform did not isolate the notify call');
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});
