/**
 * reactivity-bridge.test.mjs -- behaviour contract for `src/peer/reactivity-bridge.js`, the officer
 * dashboard's replication (66-13 Task 3).
 *
 * The fakes are fakes of the SEAMS the bridge reads, never of the bridge:
 *   - a fake strand node exposing `peerId` and `reactivityWatch`, whose `watch(req)` records each
 *     request so a test can wake the bridge through the request's own `onChange`;
 *   - a fake tail reader passed through `deps.createTailReader`;
 *   - fake timers through `deps.setTimeout` / `deps.clearTimeout` that record and never fire on
 *     their own, so the quiet tick is driven by hand;
 *   - a fake local Database exposing `schemaManager`, `eval` and `ingestExternalRowChanges`, with a
 *     store module whose `applyExternalRowChanges` returns caller-scripted effective changes;
 *   - a fake strand reader returning scripted ops per table.
 *
 * Two groups use real parts instead: E1-E4 run the bridge end to end over a REAL local store
 * (`attachLiveDb` + the shared seed), the REAL `openOfficerStrandReader` and the REAL notice seam;
 * R1 drives the REAL `ReactivityCollectionWatch` from `@optimystic/db-p2p`.
 */
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { edgeProfile, DEFAULT_SUPER_MAJORITY_THRESHOLD } from '@optimystic/db-core';
import { ReactivityCollectionWatch, ReactivitySubscriberRegistry } from '@optimystic/db-p2p';
import {
	OFFICER_SUBSCRIBED_TABLES,
	PAIRING_TABLES,
	ADMIN_PANEL_AND_GATE_TABLES,
	CAPABILITY_TABLES,
	STORE_MODULE_NAME,
	attachLiveDb,
	closeNetworkDb,
	subscribeToOfficerChanges,
} from '@votetorrent/web-data/officer';
import { seedFoundingAuthority, SEED_TABLES, EXPECTED_COUNTS } from '../../../../packages/web-data/test/fixtures/seed-founding-authority.js';
import { dashboardSrc } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../packages/web-data/test/lib/source-scan.mjs';
import { LIVE_FRESH_WINDOW_MS, BACKGROUND_RETRY_MS } from '../../src/live/status.js';
import { collectionIdForTable } from '../../src/peer/collection-id.js';
import { openOfficerStrandReader } from '../../src/peer/strand-read.js';
import {
	startOfficerReplication,
	applyOfficerRowBatch,
	readLocalPrimaryKeys,
	resolveOfficerStoreModule,
	resolveWatchService,
	PeerReplicationError,
	PEER_ROW_BATCH_ROWS,
	QUIET_PASS_INTERVAL_MS,
	OFFICER_REPLICATION_TABLES,
} from '../../src/peer/reactivity-bridge.js';

const NETWORK_HASH = 'bridgeFixtureHash0123456789';
const STRAND_ID = 'strand-fixture-abc';
const NETWORK_NAME = `strand-${STRAND_ID}`;
const STRAND_PEER = 'StrandPeerFixture';
const SECRET = 'PLANTED-ROW-SECRET-MUST-NOT-ESCAPE-0123456789';
const TABLE_A = 'Officer';
const TABLE_B = 'User';

/** Let queued microtasks and immediates run. */
function flush() {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * @param {() => boolean} predicate
 * @param {string} label
 */
async function flushUntil(predicate, label) {
	for (let i = 0; i < 400; i++) {
		if (predicate()) return;
		await flush();
	}
	assert.fail(`never reached: ${label}`);
}

/** One MessageChannel round trip plus an immediate, as the 66-07 notice tests settle delivery. */
async function settle() {
	await new Promise((resolve) => {
		const { port1, port2 } = new MessageChannel();
		port1.onmessage = () => {
			port1.close();
			port2.close();
			resolve(undefined);
		};
		port2.postMessage(null);
	});
	await flush();
}

/**
 * A call-recording spy.
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

/** A controllable promise. */
function deferred() {
	/** @type {(v?: any) => void} */
	let resolve = () => undefined;
	const promise = new Promise((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** A fake watch service. `wakeAll()` calls every recorded request's `onChange`. */
function makeFakeWatch() {
	/** @type {any[]} */
	const requests = [];
	const closes = spy(async () => undefined);
	const watch = spy((/** @type {any} */ req) => {
		requests.push(req);
		return { close: () => closes(req.collectionId) };
	});
	return { watch, requests, closes, wakeAll: () => requests.forEach((req) => req.onChange()) };
}

/** Fake timers that record `(fn, ms)` and never fire on their own. */
function makeFakeTimers() {
	/** @type {{ fn: () => void, ms: number }[]} */
	const armed = [];
	/** @type {any[]} */
	const cleared = [];
	const setTimeout = spy((/** @type {() => void} */ fn, /** @type {number} */ ms) => {
		const handle = { fn, ms };
		armed.push(handle);
		return handle;
	});
	const clearTimeout = spy((/** @type {any} */ handle) => {
		cleared.push(handle);
	});
	return { setTimeout, clearTimeout, armed, cleared };
}

/**
 * A fake local Database. `changesFor(table, ops)` scripts the effective changes the store returns.
 * @param {{ changesFor?: (table: string, ops: readonly any[]) => any[], noModule?: boolean }} [opts]
 */
function makeFakeDb(opts = {}) {
	const ingestExternalRowChanges = spy(async () => undefined);
	/** @type {Map<string, any>} */
	const storeTables = new Map();
	const getTableForExternalWrite = spy((/** @type {any} */ _db, /** @type {string} */ _schema, /** @type {string} */ table) => {
		if (!storeTables.has(table)) {
			storeTables.set(table, {
				applyExternalRowChanges: spy(async (/** @type {readonly any[]} */ ops) => (opts.changesFor ? opts.changesFor(table, ops) : [])),
			});
		}
		return storeTables.get(table);
	});
	const evalCalls = spy();
	/** @type {any} */
	const db = {
		schemaManager: {
			getModule: (/** @type {string} */ name) => (opts.noModule || name !== STORE_MODULE_NAME ? undefined : { module: { getTableForExternalWrite } }),
			getCurrentSchemaName: () => 'main',
			getTable: () => ({ columns: [{ name: 'Id' }], primaryKeyDefinition: [{ index: 0 }] }),
		},
		eval: (/** @type {string} */ sql) => {
			evalCalls(sql);
			return (async function* () {})();
		},
		ingestExternalRowChanges,
	};
	return { db, ingestExternalRowChanges, getTableForExternalWrite, storeTables, evalCalls };
}

/**
 * A fake strand reader. `opsFor(table)` scripts the ops (default none).
 * @param {(table: string) => any} [opsFor]
 */
function makeFakeReader(opsFor = () => []) {
	const readRows = spy(async (/** @type {string} */ table) => opsFor(table));
	return { readRows };
}

const FAKE_TAILS = { readTails: async () => new Map() };

/** The valid option set every test starts from. */
function validOptions() {
	const watch = makeFakeWatch();
	const timers = makeFakeTimers();
	const fakeDb = makeFakeDb();
	const reader = makeFakeReader();
	/** @type {any[]} */
	const events = [];
	const notify = spy(() => true);
	const createTailReader = spy(() => FAKE_TAILS);
	/** @type {any} */
	const options = {
		db: fakeDb.db,
		networkHash: NETWORK_HASH,
		strandReader: reader,
		strandNode: { peerId: { toString: () => STRAND_PEER }, reactivityWatch: watch },
		networkName: NETWORK_NAME,
		tables: OFFICER_REPLICATION_TABLES,
		onPass: (/** @type {any} */ e) => events.push(e),
		deps: { createTailReader, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, now: () => 1_700_000_000_000, notifyOfficerPeerWrite: notify },
	};
	return { options, watch, timers, fakeDb, reader, events, notify, createTailReader };
}

/** @param {any[]} events @param {string} type */
function countOf(events, type) {
	return events.filter((e) => e.type === type).length;
}

/** @param {() => any} fn @param {string} subject */
function throwsNaming(fn, subject) {
	assert.throws(fn, (/** @type {any} */ err) => {
		assert.ok(err instanceof PeerReplicationError, 'not a PeerReplicationError');
		assert.equal(err.subject, subject);
		return true;
	});
}

/** Silence console.error for the duration of `fn`, returning what was logged. */
async function captureConsoleError(/** @type {() => Promise<void>} */ fn) {
	const original = console.error;
	/** @type {any[][]} */
	const logged = [];
	console.error = (...args) => logged.push(args);
	try {
		await fn();
	} finally {
		console.error = original;
	}
	return logged;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

test('B1: every missing or invalid option throws naming it, and nothing is watched on any refusal', () => {
	/** @type {Array<[string, (o: any, h: ReturnType<typeof validOptions>) => void]>} */
	const cases = [
		['db', (o) => delete o.db],
		['networkHash', (o) => (o.networkHash = '')],
		['strandReader', (o) => (o.strandReader = {})],
		['strandNode', (o) => (o.strandNode = null)],
		['networkName', (o) => (o.networkName = '')],
		['networkName', (o) => (o.networkName = NETWORK_HASH)],
		['networkName', (o) => (o.networkName = 'strand-')],
		['tables', (o) => (o.tables = [])],
		['tables', (o) => (o.tables = [...OFFICER_REPLICATION_TABLES, ['Zz', 'Off', 'List'].join('')])],
		['onPass', (o) => (o.onPass = 'x')],
		[STORE_MODULE_NAME, (o) => (o.db = makeFakeDb({ noModule: true }).db)],
	];
	for (const [subject, mutate] of cases) {
		const h = validOptions();
		mutate(h.options, h);
		throwsNaming(() => startOfficerReplication(h.options), subject);
		assert.equal(h.watch.watch.calls.length, 0, 'a refused start opened a watch');
		assert.equal(h.timers.setTimeout.calls.length, 0, 'a refused start armed the quiet timer');
	}
	throwsNaming(() => startOfficerReplication(/** @type {any} */ (null)), 'options');

	// A list missing a pairing table, then one missing an admin/gate table: each names the first missing one.
	const pairingOnly = PAIRING_TABLES.find((t) => !ADMIN_PANEL_AND_GATE_TABLES.includes(t));
	const adminOnly = ADMIN_PANEL_AND_GATE_TABLES.find((t) => !PAIRING_TABLES.includes(t));
	assert.ok(pairingOnly && adminOnly);
	for (const left of [pairingOnly, adminOnly]) {
		const h = validOptions();
		h.options.tables = OFFICER_REPLICATION_TABLES.filter((t) => t !== left);
		assert.throws(
			() => startOfficerReplication(h.options),
			(/** @type {any} */ err) => err instanceof PeerReplicationError && err.subject === 'tables' && err.message.includes(left),
		);
		assert.equal(h.watch.watch.calls.length, 0);
	}
});

test('B2: a strand peer id that differs from the strand node is refused naming strandNode; equal ids start', async () => {
	const h = validOptions();
	h.options.strandPeerId = 'IdentityPeerFixture';
	throwsNaming(() => startOfficerReplication(h.options), 'strandNode');
	assert.equal(h.watch.watch.calls.length, 0);

	const ok = validOptions();
	ok.options.strandPeerId = STRAND_PEER;
	const handle = startOfficerReplication(ok.options);
	assert.ok(ok.watch.watch.calls.length > 0);
	await handle.stop();
});

test('B3: a strand node with no reactivityWatch is refused naming reactivityWatch', () => {
	const h = validOptions();
	h.options.strandNode = { peerId: { toString: () => STRAND_PEER } };
	throwsNaming(() => startOfficerReplication(h.options), 'reactivityWatch');
	throwsNaming(() => resolveWatchService({ reactivityWatch: {} }), 'reactivityWatch');
});

test('B4: one watch per table in table order, sharing the one tail reader, and no read before the first wake', async () => {
	const h = validOptions();
	const handle = startOfficerReplication(h.options);
	try {
		const sorted = [...OFFICER_REPLICATION_TABLES].sort();
		assert.deepEqual(h.watch.requests.map((r) => r.collectionId), sorted.map((t) => collectionIdForTable(t)));
		assert.equal(h.createTailReader.calls.length, 1);
		assert.equal(h.createTailReader.calls[0][0], h.options.strandNode);
		assert.equal(h.createTailReader.calls[0][1], NETWORK_NAME);
		for (const req of h.watch.requests) {
			assert.equal(req.tails, FAKE_TAILS);
			assert.equal(typeof req.onChange, 'function');
		}
		await flush();
		assert.equal(h.reader.readRows.calls.length, 0);
		assert.equal(h.fakeDb.evalCalls.calls.length, 0);
		assert.equal(h.events.length, 0);
	} finally {
		await handle.stop();
	}
});

test('B5 (D-12): the replicated list is the officer list and holds every admin/gate, pairing and capability table', () => {
	assert.equal(OFFICER_REPLICATION_TABLES, OFFICER_SUBSCRIBED_TABLES);
	const required = [...ADMIN_PANEL_AND_GATE_TABLES, ...PAIRING_TABLES, ...Object.values(CAPABILITY_TABLES).flat()];
	assert.ok(required.length > 0);
	assert.deepEqual(required.filter((t) => !OFFICER_REPLICATION_TABLES.includes(t)), []);
});

// ---------------------------------------------------------------------------
// Passes
// ---------------------------------------------------------------------------

test('B6: one wake gives one pass, reading every table once with its local keys and the local handle', async () => {
	const h = validOptions();
	const handle = startOfficerReplication(h.options);
	try {
		handle.wake();
		await handle.whenIdle();
		assert.deepEqual(h.events.map((e) => e.type), ['pass-start', 'pass-complete']);
		const sorted = [...OFFICER_REPLICATION_TABLES].sort();
		assert.deepEqual(h.reader.readRows.calls.map((/** @type {any[]} */ c) => c[0]), sorted);
		for (const call of h.reader.readRows.calls) {
			assert.ok(Array.isArray(call[1]));
			assert.deepEqual(call[2], { uiDb: h.options.db });
			assert.equal(call[2].uiDb, h.options.db);
		}
	} finally {
		await handle.stop();
	}
});

test('B7 (66-07 item 5): notices come from the effective kinds, once per (table, kind), never the submitted kind', async () => {
	const h = validOptions();
	const fakeDb = makeFakeDb({
		changesFor: (table) =>
			table === TABLE_A
				? [{ op: 'insert' }, { op: 'insert' }, { op: 'update' }]
				: table === TABLE_B
					? [{ op: 'delete' }]
					: [],
	});
	h.options.db = fakeDb.db;
	h.options.strandReader = makeFakeReader((table) => (table === TABLE_A || table === TABLE_B ? [{ op: 'upsert', row: ['x'] }] : []));
	const handle = startOfficerReplication(h.options);
	try {
		handle.wake();
		await handle.whenIdle();
		const calls = h.notify.calls.map((/** @type {any[]} */ c) => [c[0], c[1], c[2], c[3]]);
		assert.equal(calls.length, 3);
		for (const expected of [
			[fakeDb.db, NETWORK_HASH, TABLE_A, 'insert'],
			[fakeDb.db, NETWORK_HASH, TABLE_A, 'update'],
			[fakeDb.db, NETWORK_HASH, TABLE_B, 'delete'],
		]) {
			assert.equal(calls.filter((/** @type {any[]} */ c) => c.every((/** @type {any} */ v, /** @type {number} */ i) => v === expected[i])).length, 1);
		}
		assert.ok(h.notify.calls.every((/** @type {any[]} */ c) => c[3] !== 'upsert'));
		const complete = h.events.find((e) => e.type === 'pass-complete');
		assert.deepEqual(complete.changedTables, [TABLE_A, TABLE_B]);
		assert.ok(Object.isFrozen(complete.changedTables));
		assert.deepEqual(complete.changes, [
			{ table: TABLE_A, op: 'insert' },
			{ table: TABLE_A, op: 'update' },
			{ table: TABLE_B, op: 'delete' },
		]);
		assert.ok(Object.isFrozen(complete.changes));
		assert.equal(complete.at, 1_700_000_000_000);
	} finally {
		await handle.stop();
	}
});

test('B8: a value-identical pass sends no notice, reports no changed table, and still runs afterPass once', async () => {
	const h = validOptions();
	h.options.strandReader = makeFakeReader((table) => (table === TABLE_A ? [{ op: 'upsert', row: ['x'] }] : []));
	const afterPass = spy(async () => undefined);
	h.options.afterPass = afterPass;
	const handle = startOfficerReplication(h.options);
	try {
		handle.wake();
		await handle.whenIdle();
		assert.equal(h.notify.calls.length, 0);
		const complete = h.events.find((e) => e.type === 'pass-complete');
		assert.deepEqual(complete.changedTables, []);
		assert.deepEqual(complete.changes, []);
		assert.equal(afterPass.calls.length, 1);
		assert.deepEqual(afterPass.calls[0][0], { at: 1_700_000_000_000, changedTables: [] });
	} finally {
		await handle.stop();
	}
});

test('B9: wakes during a pass fold into exactly one more pass, never two at once', async () => {
	const h = validOptions();
	const gate = deferred();
	let first = true;
	h.options.strandReader = {
		readRows: spy(async () => {
			if (first) {
				first = false;
				await gate.promise;
			}
			return [];
		}),
	};
	let active = 0;
	let maxActive = 0;
	h.options.onPass = (/** @type {any} */ e) => {
		h.events.push(e);
		if (e.type === 'pass-start') {
			active += 1;
			maxActive = Math.max(maxActive, active);
		} else {
			active -= 1;
		}
	};
	const handle = startOfficerReplication(h.options);
	try {
		handle.wake();
		await flushUntil(() => h.options.strandReader.readRows.calls.length === 1, 'first pass started');
		handle.wake();
		handle.wake();
		handle.wake();
		gate.resolve();
		await handle.whenIdle();
		assert.equal(countOf(h.events, 'pass-start'), 2);
		assert.equal(countOf(h.events, 'pass-complete'), 2);
		assert.equal(maxActive, 1);

		// A synchronous burst of wakes (every watch firing on one tail read) is one pass.
		h.watch.wakeAll();
		await handle.whenIdle();
		assert.equal(countOf(h.events, 'pass-start'), 3);
	} finally {
		await handle.stop();
	}
});

test('B10 (66-05 ruling 4): the quiet timer is armed at start, runs a pass with no wake, and is re-armed after each pass', async () => {
	assert.ok(QUIET_PASS_INTERVAL_MS * 2 <= LIVE_FRESH_WINDOW_MS);
	assert.equal(QUIET_PASS_INTERVAL_MS, BACKGROUND_RETRY_MS);
	assert.equal(QUIET_PASS_INTERVAL_MS, 20_000);
	const h = validOptions();
	const handle = startOfficerReplication(h.options);
	try {
		assert.equal(h.timers.armed.length, 1);
		assert.equal(h.timers.armed[0].ms, QUIET_PASS_INTERVAL_MS);
		h.timers.armed[0].fn();
		await handle.whenIdle();
		assert.deepEqual(h.events.map((e) => e.type), ['pass-start', 'pass-complete']);
		assert.equal(h.timers.armed.length, 2);
		assert.equal(h.timers.armed[1].ms, QUIET_PASS_INTERVAL_MS);
		assert.ok(h.timers.cleared.includes(h.timers.armed[0]), 'the previous timer was not cleared');

		handle.wake();
		await handle.whenIdle();
		assert.equal(h.timers.armed.length, 3);
		assert.ok(h.timers.cleared.includes(h.timers.armed[1]));
	} finally {
		await handle.stop();
	}
});

test('B11 (D-15): a read failure mid-pass keeps earlier rows and their notices, reports pass-failed by name, skips afterPass, and the next wake runs a full pass', async () => {
	const h = validOptions();
	h.options.db = makeFakeDb({ changesFor: (table) => (table === TABLE_A ? [{ op: 'insert' }] : []) }).db;
	let failB = true;
	h.options.strandReader = makeFakeReader((table) => {
		if (table === TABLE_B && failB) {
			const err = new Error(`${SECRET} row value`);
			err.name = 'PlantedError';
			throw err;
		}
		return table === TABLE_A ? [{ op: 'upsert', row: ['x'] }] : [];
	});
	const afterPass = spy(async () => undefined);
	h.options.afterPass = afterPass;
	const handle = startOfficerReplication(h.options);
	try {
		const logged = await captureConsoleError(async () => {
			handle.wake();
			await handle.whenIdle();
		});
		const failed = h.events.find((e) => e.type === 'pass-failed');
		assert.ok(failed);
		assert.equal(failed.name, 'PlantedError');
		assert.deepEqual(failed.changedTables, [TABLE_A]);
		assert.equal(countOf(h.events, 'pass-complete'), 0);
		assert.equal(h.notify.calls.length, 1);
		assert.deepEqual(h.notify.calls[0].slice(1), [NETWORK_HASH, TABLE_A, 'insert']);
		assert.equal(afterPass.calls.length, 0);
		assert.ok(!JSON.stringify(logged).includes(SECRET));
		assert.ok(logged.every((args) => args.length === 2 && args[0] === 'peer/reactivity-bridge:' && typeof args[1] === 'string'));
		assert.ok(!JSON.stringify(failed).includes(SECRET));

		failB = false;
		handle.wake();
		await handle.whenIdle();
		assert.equal(countOf(h.events, 'pass-complete'), 1);
		assert.equal(afterPass.calls.length, 1);
	} finally {
		await handle.stop();
	}
});

test('B12: a batch for an off-list table, or one outside this run, is refused whole with zero store calls', async () => {
	const fakeDb = makeFakeDb({ changesFor: () => [{ op: 'insert' }] });
	const offList = ['Zz', 'Off', 'List'].join('');
	await assert.rejects(() => applyOfficerRowBatch(fakeDb.db, offList, [{ op: 'upsert', row: ['x'] }]), PeerReplicationError);
	const inListNotRun = OFFICER_SUBSCRIBED_TABLES.find((t) => t !== TABLE_A);
	assert.ok(inListNotRun);
	await assert.rejects(() => applyOfficerRowBatch(fakeDb.db, inListNotRun, [{ op: 'upsert', row: ['x'] }], [TABLE_A]), PeerReplicationError);
	assert.equal(fakeDb.getTableForExternalWrite.calls.length, 0);
	assert.equal(fakeDb.ingestExternalRowChanges.calls.length, 0);

	// Control: an allowed table is applied, in chunks of PEER_ROW_BATCH_ROWS, through the one seam call.
	const ops = Array.from({ length: PEER_ROW_BATCH_ROWS + 1 }, () => ({ op: 'upsert', row: ['x'] }));
	const changes = await applyOfficerRowBatch(fakeDb.db, TABLE_A, ops, [TABLE_A]);
	assert.equal(fakeDb.storeTables.get(TABLE_A).applyExternalRowChanges.calls.length, 2);
	assert.equal(changes.length, 2);
	assert.equal(fakeDb.ingestExternalRowChanges.calls.length, 1);
	assert.deepEqual(fakeDb.ingestExternalRowChanges.calls[0][1], { captureChanges: false, applyForeignKeyActions: false });
	throwsNaming(() => resolveOfficerStoreModule(makeFakeDb({ noModule: true }).db), STORE_MODULE_NAME);
});

test('B13: a throwing onPass and a rejecting afterPass are logged by name, and the next pass still runs', async () => {
	const h = validOptions();
	h.options.onPass = (/** @type {any} */ e) => {
		h.events.push(e);
		const err = new Error(SECRET);
		err.name = 'ListenerError';
		throw err;
	};
	h.options.afterPass = async () => {
		const err = new Error(SECRET);
		err.name = 'AfterPassError';
		throw err;
	};
	const handle = startOfficerReplication(h.options);
	try {
		const logged = await captureConsoleError(async () => {
			handle.wake();
			await handle.whenIdle();
			handle.wake();
			await handle.whenIdle();
		});
		assert.equal(countOf(h.events, 'pass-complete'), 2);
		const names = logged.map((args) => args[1]);
		assert.ok(names.includes('ListenerError'));
		assert.ok(names.includes('AfterPassError'));
		assert.ok(!JSON.stringify(logged).includes(SECRET));
	} finally {
		await handle.stop();
	}
});

test('B14: stop() is idempotent, clears the timer, closes every watch, and no pass starts after it; afterPass may call stop()', async () => {
	const h = validOptions();
	let closed = 0;
	let firstClose = true;
	h.options.strandNode = {
		peerId: { toString: () => STRAND_PEER },
		reactivityWatch: {
			watch: () => ({
				close: async () => {
					if (firstClose) {
						firstClose = false;
						throw new Error('close failed');
					}
					closed += 1;
				},
			}),
		},
	};
	const handle = startOfficerReplication(h.options);
	const armed = h.timers.armed[0];
	await captureConsoleError(async () => {
		await handle.stop();
		await handle.stop();
	});
	assert.equal(closed, OFFICER_REPLICATION_TABLES.length - 1);
	assert.ok(h.timers.cleared.includes(armed));
	handle.wake();
	armed.fn();
	await handle.whenIdle();
	assert.equal(h.events.length, 0, 'a pass started after stop()');

	// afterPass calling stop() does not deadlock.
	const s = validOptions();
	/** @type {any} */
	let selfHandle = null;
	s.options.afterPass = async () => {
		await selfHandle.stop();
	};
	const held = deferred();
	s.options.strandReader = { readRows: spy(async () => held.promise.then(() => [])) };
	selfHandle = startOfficerReplication(s.options);
	selfHandle.wake();
	await flushUntil(() => s.options.strandReader.readRows.calls.length === 1, 'first pass reading');
	// Queued during the pass: without the stop() inside afterPass this would run a second pass.
	selfHandle.wake();
	held.resolve();
	await selfHandle.whenIdle();
	assert.equal(countOf(s.events, 'pass-complete'), 1, 'the folded pass ran after stop()');

	// whenIdle resolves after an in-flight pass ends.
	const w = validOptions();
	const gate = deferred();
	w.options.strandReader = { readRows: spy(async () => gate.promise.then(() => [])) };
	const wHandle = startOfficerReplication(w.options);
	wHandle.wake();
	let idle = false;
	const idlePromise = wHandle.whenIdle().then(() => {
		idle = true;
	});
	await flush();
	assert.equal(idle, false);
	gate.resolve();
	await idlePromise;
	assert.equal(countOf(w.events, 'pass-complete'), 1);
	await wHandle.stop();
});

// ---------------------------------------------------------------------------
// Real local store
// ---------------------------------------------------------------------------

let hashCounter = 0;
function nextHash() {
	hashCounter += 1;
	return `bridgeE${hashCounter}x${Date.now().toString(36)}`;
}

/** @param {any} db @param {string} table */
async function captureRows(db, table) {
	const rows = [];
	for await (const row of db.eval(`select * from ${table}`)) rows.push({ ...row });
	return rows;
}

/** @param {any} db @param {string} table */
async function countRows(db, table) {
	for await (const row of db.eval(`select count(*) as n from ${table}`)) return Number(/** @type {any} */ (row).n);
	return 0;
}

test('B15: readLocalPrimaryKeys returns key arrays in PK-definition order, and is bounded by the shared row limit', async () => {
	const db = await attachLiveDb(nextHash(), { create: true });
	try {
		await seedFoundingAuthority(db);
		for (const table of SEED_TABLES) {
			const schema = /** @type {any} */ (db.schemaManager.getTable(db.schemaManager.getCurrentSchemaName(), table));
			const names = schema.primaryKeyDefinition.map((/** @type {any} */ d) => schema.columns[d.index].name);
			const expected = (await captureRows(db, table)).map((row) => names.map((/** @type {string} */ n) => row[n]));
			assert.deepEqual(await readLocalPrimaryKeys(db, table), expected);
		}
		await assert.rejects(() => readLocalPrimaryKeys(db, ['Zz', 'Off', 'List'].join('')), PeerReplicationError);
	} finally {
		await closeNetworkDb(db);
	}
	const stripped = stripComments(readFileSync(dashboardSrc('peer', 'reactivity-bridge.js'), 'utf8'));
	assert.match(stripped, /import \{ STRAND_READ_ROW_LIMIT \} from '\.\/strand-read\.js';/);
	const body = stripped.slice(stripped.indexOf('export async function readLocalPrimaryKeys'), stripped.indexOf('export async function applyOfficerRowBatch'));
	assert.ok(body.length > 0 && body.includes('STRAND_READ_ROW_LIMIT'));
});

/**
 * The end-to-end rig: a seeded real store, a strand row map captured from it, the REAL reader over a
 * fake member node, the REAL notice seam.
 */
async function startEndToEnd() {
	const hash = nextHash();
	const db = await attachLiveDb(hash, { create: true });
	await seedFoundingAuthority(db);
	/** @type {Map<string, Record<string, any>[]>} */
	const strandRows = new Map();
	for (const table of SEED_TABLES) strandRows.set(table, await captureRows(db, table));
	const strandSideDb = {
		setSchemaPath: () => undefined,
		eval: (/** @type {string} */ sql) => {
			const match = /from\s+(\w+)/.exec(sql);
			const rows = strandRows.get(match ? match[1] : '') ?? [];
			return (async function* () {
				for (const row of rows) yield { ...row };
			})();
		},
	};
	const holder = { current: /** @type {any} */ ({ getTransactor: () => 'network', getDatabase: () => strandSideDb }) };
	const memberNode = { getStrandDatabase: () => holder.current };
	let clock = 0;
	const reader = await openOfficerStrandReader({
		memberNode,
		strandId: STRAND_ID,
		deps: {
			sleep: async (ms) => {
				clock += ms;
			},
			now: () => clock,
			waitMs: 1_000,
			pollMs: 500,
			registerDbPlugins: async () => undefined,
		},
	});
	/** @type {any[]} */
	const notices = [];
	const release = subscribeToOfficerChanges(hash, (notice) => notices.push(notice));
	/** @type {any[]} */
	const events = [];
	const timers = makeFakeTimers();
	const handle = startOfficerReplication({
		db,
		networkHash: hash,
		strandReader: reader,
		strandNode: { peerId: { toString: () => STRAND_PEER }, reactivityWatch: makeFakeWatch() },
		networkName: NETWORK_NAME,
		tables: OFFICER_REPLICATION_TABLES,
		onPass: (e) => events.push(e),
		strandPeerId: STRAND_PEER,
		deps: { createTailReader: () => FAKE_TAILS, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
	});
	async function pass() {
		notices.length = 0;
		handle.wake();
		await handle.whenIdle();
		await settle();
	}
	async function close() {
		await handle.stop();
		release();
		await closeNetworkDb(db);
	}
	return { db, strandRows, holder, notices, events, pass, close };
}

test('E1: the first pass over identical sides applies nothing new and sends no notice', async () => {
	const rig = await startEndToEnd();
	try {
		await rig.pass();
		assert.equal(rig.events.at(-1).type, 'pass-complete');
		assert.deepEqual(rig.events.at(-1).changedTables, []);
		assert.deepEqual(rig.notices, []);
		for (const [table, count] of Object.entries(EXPECTED_COUNTS)) assert.equal(await countRows(rig.db, table), count);
	} finally {
		await rig.close();
	}
});

test('E2: a row removed on the strand is removed locally with exactly one delete notice', async () => {
	const rig = await startEndToEnd();
	try {
		rig.strandRows.set('Officer', []);
		await rig.pass();
		assert.equal(rig.events.at(-1).type, 'pass-complete');
		assert.equal(await countRows(rig.db, 'Officer'), 0);
		assert.deepEqual(rig.notices.map((n) => ({ ...n })), [{ table: 'Officer', op: 'delete' }]);
	} finally {
		await rig.close();
	}
});

test('E3: a row restored on the strand comes back locally with exactly one insert notice', async () => {
	const rig = await startEndToEnd();
	try {
		const officer = rig.strandRows.get('Officer');
		rig.strandRows.set('Officer', []);
		await rig.pass();
		assert.equal(await countRows(rig.db, 'Officer'), 0);
		rig.strandRows.set('Officer', /** @type {any} */ (officer));
		await rig.pass();
		assert.equal(await countRows(rig.db, 'Officer'), 1);
		assert.deepEqual(rig.notices.map((n) => ({ ...n })), [{ table: 'Officer', op: 'insert' }]);
	} finally {
		await rig.close();
	}
});

test('E4: a changed non-key text column gives exactly one update notice and the new value locally; a failed pass leaves every row readable', async () => {
	const rig = await startEndToEnd();
	try {
		const schema = /** @type {any} */ (rig.db.schemaManager.getTable(rig.db.schemaManager.getCurrentSchemaName(), 'Officer'));
		const pkIndexes = new Set(schema.primaryKeyDefinition.map((/** @type {any} */ d) => d.index));
		const row = /** @type {Record<string, any>[]} */ (rig.strandRows.get('Officer'))[0];
		const column = schema.columns.find((/** @type {any} */ c, /** @type {number} */ i) => !pkIndexes.has(i) && typeof row[c.name] === 'string');
		assert.ok(column, 'the seeded Officer row has no non-key text column');
		const changedValue = `${row[column.name]} changed`;
		rig.strandRows.set('Officer', [{ ...row, [column.name]: changedValue }]);
		await rig.pass();
		assert.deepEqual(rig.notices.map((n) => ({ ...n })), [{ table: 'Officer', op: 'update' }]);
		const after = await captureRows(rig.db, 'Officer');
		assert.equal(after[0][column.name], changedValue);

		// D-15: the strand database vanishes; the pass fails and every seeded row stays readable.
		rig.holder.current = null;
		const logged = await captureConsoleError(() => rig.pass());
		assert.equal(rig.events.at(-1).type, 'pass-failed');
		assert.equal(rig.events.at(-1).name, 'StrandReadError');
		assert.ok(logged.length >= 1);
		for (const [table, count] of Object.entries(EXPECTED_COUNTS)) assert.equal(await countRows(rig.db, table), count);
	} finally {
		await rig.close();
	}
});

// ---------------------------------------------------------------------------
// The REAL upstream watch service
// ---------------------------------------------------------------------------

/** A fake CohortTopicService whose verifier accepts everything. */
function makeFakeService() {
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
		verifier: () => ({ verifyMessage: async () => 'verified' }),
	};
}

test('R1: over the REAL ReactivityCollectionWatch the first committed-tail read wakes the bridge once, and stop() leaves nothing watched', async () => {
	const service = makeFakeService();
	const watchService = new ReactivityCollectionWatch({
		service: /** @type {any} */ (service),
		profile: edgeProfile(),
		subscribers: new ReactivitySubscriberRegistry(),
		quorumRatio: DEFAULT_SUPER_MAJORITY_THRESHOLD,
		scheduleRotation: () => undefined,
		setTimer: () => () => undefined,
	});
	const tails = {
		readTails: async (/** @type {any[]} */ queries) =>
			new Map(queries.map((q) => [q.collectionId, { tail: { tailId: 'vt-fixture-tail-block-id-0123456789abcdef', revision: 1 } }])),
	};
	const h = validOptions();
	h.options.strandNode = { peerId: { toString: () => STRAND_PEER }, reactivityWatch: watchService };
	h.options.deps.createTailReader = () => tails;
	const handle = startOfficerReplication(h.options);
	const someCollection = collectionIdForTable(TABLE_A);
	try {
		await flushUntil(() => countOf(h.events, 'pass-start') >= 1 && watchService.isAttached(someCollection), 'first wake + attach');
		await handle.whenIdle();
		for (let i = 0; i < 20; i++) await flush();
		await handle.whenIdle();
		assert.equal(countOf(h.events, 'pass-start'), 1);
		assert.ok(service.register.calls.length >= 1);
		await handle.stop();
		await flushUntil(() => watchService.watchedCount === 0, 'every watch released');
	} finally {
		await handle.stop();
		await watchService.stop();
	}
});

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

test('N1: one self-contained notice line, one seam call, and none of the banned identifiers', () => {
	const stripped = stripComments(readFileSync(dashboardSrc('peer', 'reactivity-bridge.js'), 'utf8'));
	const noticeLines = stripped.split('\n').filter((l) => /notifyOfficerPeerWrite\(/.test(l));
	assert.equal(noticeLines.length, 1);
	assert.match(noticeLines[0], /^\s*notifyOfficerPeerWrite\(db, networkHash, table, op\);\s*$/);
	const seam = ['ingest', 'External', 'Row', 'Changes'].join('');
	assert.equal(stripped.split(seam).length - 1, 1);
	for (const token of [
		['attach', 'Live', 'Db'].join(''),
		['open', 'Store', 'Handle'].join(''),
		['attach', 'Network', 'Db'].join(''),
		['new ', 'Database'].join(''),
		['Strand', 'Change', 'Hub'].join(''),
		['network', '_watch'].join(''),
	]) {
		assert.ok(!stripped.includes(token), 'a banned identifier is in the bridge');
	}
	assert.doesNotMatch(stripped, /\b(insert\s+into|update\s+\S+\s+set|delete\s+from)\b/i);
	assert.ok(!stripped.includes("'upsert'"));
});
