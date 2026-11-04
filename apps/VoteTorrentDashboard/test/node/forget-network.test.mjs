/**
 * Tier-1 coverage of `src/lifecycle/forget-network.js`: the one destructive
 * path (typed forget and confirmation-free wipe), its lifecycle lock, the
 * other-tab wait, the runtime registry, and the resurrection-safe settle.
 *
 * HONESTY NOTE: `fake-indexeddb` cannot demonstrate genuine durability across
 * a real browser reload, and it cannot demonstrate that a deleted network is
 * truly gone from disk. It proves the ORDERING this module enforces and the
 * error classes it throws; the browser gate carries the rest.
 *
 * Tests that do not exercise peer storage inject no-op peer fakes (`peerFakes`)
 * so the member node's modules are never loaded; F10 uses the real modules.
 * No test waits in real time: lock waits use injected signals.
 *
 * `import 'fake-indexeddb/auto'` first. A distinct network hash per test.
 */
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
	createNetworkDb,
	closeNetworkDb,
	deleteNetworkDb,
	dbNameFor,
	attachNetworkDb,
	readRowCounts,
	readRowCountsRecord,
	writeRowCounts,
	upsertNetwork,
	findNetwork,
	removeNetwork,
	listNetworks,
	NETWORKS_REGISTRY_KEY,
	rowCountsKeyFor,
} from '@votetorrent/web-data/officer';
import { seedFoundingAuthority, SEED_TABLES } from '../../../../packages/web-data/test/fixtures/seed-founding-authority.js';
import { nowCanonicalDatetime } from '@votetorrent/vote-engine/browser';
import { dashboardSrc, moduleUrl } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';

const FORGET_URL = moduleUrl(dashboardSrc('lifecycle', 'forget-network.js'));
/** @type {typeof import('../../src/lifecycle/forget-network.js')} */
const forget = await import(FORGET_URL);
const {
	ForgetConfirmationMismatchError,
	UnknownNetworkError,
	NetworkStillPresentError,
	NetworkInUseError,
	forgetNetwork,
	wipeNetwork,
	assertNetworkForgotten,
	withNetworkLifecycleLock,
	registerNetworkRuntime,
	createTabScope,
	createInTabLockManager,
	nodeLockName,
	lifecycleLockName,
	lifecycleChannelName,
} = forget;

/** A tiny Map-backed localStorage-shaped fake. */
function makeFakeStorage(/** @type {string[] | null} */ log = null) {
	/** @type {Map<string, string>} */
	const map = new Map();
	return {
		getItem: (/** @type {string} */ key) => (map.has(key) ? /** @type {string} */ (map.get(key)) : null),
		setItem: (/** @type {string} */ key, /** @type {string} */ value) => {
			map.set(key, value);
			if (log) log.push(`set:${key}`);
		},
		removeItem: (/** @type {string} */ key) => {
			map.delete(key);
			if (log) log.push(`remove:${key}`);
		},
	};
}

/**
 * Seed a network directly and register it, so forget has something real to delete.
 *
 * @param {string} hash
 * @param {string} authorityName
 * @param {string[] | null} [log]
 * @param {{ seed?: boolean }} [options] - seed: false skips the fixture rows (ordering tests need only a store)
 */
async function setupNetwork(hash, authorityName, log = null, { seed = true } = {}) {
	await deleteNetworkDb(hash).catch(() => undefined);
	const storage = makeFakeStorage(log);
	const db = await createNetworkDb(hash);
	if (seed) await seedFoundingAuthority(db);
	const counts = seed ? await readRowCounts(db, SEED_TABLES) : { Authority: 0 };
	await writeRowCounts(hash, counts, storage);
	upsertNetwork(
		{ networkHash: hash, authorityName, domain: 'fixture.example', officerUserId: 'u1', bootstrappedAt: nowCanonicalDatetime() },
		storage,
	);
	await closeNetworkDb(db);
	if (log) log.length = 0;
	return { storage, counts };
}

/** Fake member-storage names: `vt-member-<hash>-<scope>-0000abcd`. */
const fakeMemberName = (/** @type {string} */ h, /** @type {string} */ scope) => `vt-member-${h}-${scope}-0000abcd`;

/**
 * Peer-layer fakes so the member node's modules are never loaded.
 *
 * @param {Record<string, any>} [extra]
 */
function peerFakes(extra = {}) {
	/** @type {string[]} */
	const calls = [];
	/** @type {any} */
	const deps = {
		deleteMemberStorage: async (/** @type {string} */ h) => {
			calls.push(`member:${h}`);
		},
		memberStorageDbName: fakeMemberName,
		deleteDeviceKeys: async (/** @type {string} */ h) => {
			calls.push(`keys:${h}`);
		},
		listDeviceKeyIds: async () => [],
		deviceKeysDbName: 'vt-test-no-keys-db',
		BroadcastChannel: undefined,
		timeoutSignal: () => new AbortController().signal,
		tabScope: createTabScope(),
		...extra,
	};
	return { calls, deps };
}

/** @returns {Promise<string[]>} */
async function dbNames() {
	return (await indexedDB.databases()).map((d) => /** @type {string} */ (d.name));
}

/** @param {number} [n] */
async function ticks(n = 20) {
	for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
}

/** A BroadcastChannel fake that records every message posted, by channel name. */
function makeChannelRecorder() {
	/** @type {Array<{ name: string, data: any }>} */
	const posted = [];
	class FakeChannel {
		/** @param {string} name */
		constructor(name) {
			this.name = name;
		}
		/** @param {any} data */
		postMessage(data) {
			posted.push({ name: this.name, data });
		}
		close() {}
	}
	return { posted, FakeChannel };
}

/** @param {string} name */
function openRaw(name) {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(name);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

// ---------------------------------------------------------------------------
// F1-F8 (moved from freshness-forget.test.mjs)
// ---------------------------------------------------------------------------

test('F1 forgetNetwork: an EMPTY authorityName confirms nothing -- an empty input is refused, not satisfied', async () => {
	const hash = 'fn-empty-expected';
	const { storage, counts } = await setupNetwork(hash, '');
	const { deps } = peerFakes();

	for (const typed of ['', '   ', 'anything']) {
		await assert.rejects(
			() => forgetNetwork({ networkHash: hash, typedConfirmation: typed, storage, deps }),
			(/** @type {any} */ err) => err instanceof ForgetConfirmationMismatchError,
			`typedConfirmation ${JSON.stringify(typed)} was accepted against an empty expected name`,
		);
	}

	assert.ok(findNetwork(hash, storage));
	assert.deepEqual((await readRowCountsRecord(hash, storage))?.counts, counts);
	const reopened = await attachNetworkDb(hash, { storage });
	assert.deepEqual(await readRowCounts(reopened, Object.keys(counts)), counts);
	await closeNetworkDb(reopened);
	await deleteNetworkDb(hash, { storage });
});

test('F2 positive control: a NON-empty authorityName still forgets when typed exactly', async () => {
	const hash = 'fn-empty-control';
	const { storage } = await setupNetwork(hash, 'Nonempty Authority');
	const { deps } = peerFakes();
	const result = await forgetNetwork({ networkHash: hash, typedConfirmation: 'Nonempty Authority', storage, deps });
	assert.equal(result.networkHash, hash);
	assert.equal(findNetwork(hash, storage), undefined);
});

test('F3 forgetNetwork: a mismatched confirmation throws, and the store still exists afterward (measured with indexedDB.databases())', async () => {
	const hash = 'fn-mismatch';
	const { storage, counts } = await setupNetwork(hash, 'Mismatch Authority');
	const { deps, calls } = peerFakes();
	const db = await attachNetworkDb(hash, { storage });

	await assert.rejects(
		() => forgetNetwork({ networkHash: hash, typedConfirmation: 'Wrong Name Entirely', db, storage, deps }),
		(/** @type {any} */ err) => err instanceof ForgetConfirmationMismatchError,
	);
	await closeNetworkDb(db);

	assert.ok((await dbNames()).includes(dbNameFor(hash)), 'the store is still listed');
	const reopened = await attachNetworkDb(hash, { storage });
	assert.deepEqual(await readRowCounts(reopened, Object.keys(counts)), counts);
	await closeNetworkDb(reopened);
	assert.ok(findNetwork(hash, storage));
	assert.deepEqual((await readRowCountsRecord(hash, storage))?.counts, counts);
	assert.deepEqual(calls, [], 'no peer delete ran');
	await deleteNetworkDb(hash);
});

test('F4 forgetNetwork: a matching confirmation deletes the store, clears the row-count record and removes the registry entry', async () => {
	const hash = 'fn-match';
	const { storage } = await setupNetwork(hash, 'Match Authority');
	const { deps } = peerFakes();
	const db = await attachNetworkDb(hash, { storage });

	const result = await forgetNetwork({ networkHash: hash, typedConfirmation: 'Match Authority', db, storage, deps });

	assert.equal(result.networkHash, hash);
	assert.deepEqual(result.remaining, listNetworks(storage));
	assert.equal(findNetwork(hash, storage), undefined);
	assert.equal(await readRowCountsRecord(hash, storage), undefined);
	assert.ok(!(await dbNames()).includes(dbNameFor(hash)));
	await assertNetworkForgotten(hash, storage, { deps });
});

test('F5 forgetNetwork: leading/trailing whitespace in the typed confirmation is trimmed before comparison', async () => {
	const hash = 'fn-trim';
	const { storage } = await setupNetwork(hash, 'Trimmed Authority');
	const { deps } = peerFakes();
	const db = await attachNetworkDb(hash, { storage });

	const result = await forgetNetwork({ networkHash: hash, typedConfirmation: '  Trimmed Authority  ', db, storage, deps });
	assert.equal(findNetwork(hash, storage), undefined);
	assert.deepEqual(result.remaining, []);
});

test('F6 forgetNetwork: an unknown network hash throws UnknownNetworkError naming the hash and deletes nothing', async () => {
	const storage = makeFakeStorage();
	const { deps, calls } = peerFakes();
	await assert.rejects(
		() => forgetNetwork({ networkHash: 'fn-no-such-network', typedConfirmation: 'whatever', storage, deps }),
		(/** @type {any} */ err) => {
			assert.ok(err instanceof UnknownNetworkError);
			assert.ok(err.message.includes('fn-no-such-network'));
			return true;
		},
	);
	assert.deepEqual(calls, []);
});

test('F7 forgetNetwork: a delete blocked by another open connection rejects DeleteBlockedError by name; registry entry and row-count record survive', async () => {
	const hash = 'fn-blocked';
	const { storage, counts } = await setupNetwork(hash, 'Blocked Authority');
	const { deps, calls } = peerFakes();
	const db = await attachNetworkDb(hash, { storage });
	const blockingConn = /** @type {any} */ (await openRaw(dbNameFor(hash)));

	await assert.rejects(
		() => forgetNetwork({ networkHash: hash, typedConfirmation: 'Blocked Authority', db, storage, timeoutMs: 200, deps }),
		(/** @type {any} */ err) => err.name === 'DeleteBlockedError',
	);

	blockingConn.close();
	await closeNetworkDb(db);
	assert.ok(findNetwork(hash, storage), 'the network stays listed after a blocked delete');
	assert.deepEqual((await readRowCountsRecord(hash, storage))?.counts, counts, 'the row-count record survives a blocked delete');
	assert.deepEqual(calls, [], 'no peer delete ran after the blocked store delete');
	await deleteNetworkDb(hash);
});

test('F8 assertNetworkForgotten: names a surviving registry entry and a surviving row-count record, each with a fully-forgotten positive control', async () => {
	const hash = 'fn-assert-registry';
	const { storage } = await setupNetwork(hash, 'Registry Survivor Authority');
	const db = await attachNetworkDb(hash, { storage });
	await deleteNetworkDb(hash, { db });
	await assert.rejects(
		() => assertNetworkForgotten(hash, storage),
		(/** @type {any} */ err) => err instanceof NetworkStillPresentError && err.survivor === 'registry entry',
	);

	const hash2 = 'fn-assert-rowcounts';
	const second = await setupNetwork(hash2, 'Row-Count Survivor Authority');
	const db2 = await attachNetworkDb(hash2, { storage: second.storage });
	await deleteNetworkDb(hash2, { db: db2 });
	removeNetwork(hash2, second.storage);
	await writeRowCounts(hash2, { Authority: 1 }, second.storage);
	await assert.rejects(
		() => assertNetworkForgotten(hash2, second.storage),
		(/** @type {any} */ err) => err instanceof NetworkStillPresentError && err.survivor === 'row-count record',
	);

	const cleanHash = 'fn-assert-clean';
	const clean = await setupNetwork(cleanHash, 'Clean Authority');
	const { deps } = peerFakes();
	const cleanDb = await attachNetworkDb(cleanHash, { storage: clean.storage });
	await forgetNetwork({ networkHash: cleanHash, typedConfirmation: 'Clean Authority', db: cleanDb, storage: clean.storage, deps });
	await assert.doesNotReject(() => assertNetworkForgotten(cleanHash, clean.storage));
});

// ---------------------------------------------------------------------------
// F9-F19
// ---------------------------------------------------------------------------

test('F9 ordering: closing message -> runtime stop -> store gone -> member storage -> device keys -> row-count gone -> registry gone', async () => {
	const hash = 'fn-order';
	/** @type {string[]} */
	const storageLog = [];
	const { storage } = await setupNetwork(hash, 'Order Authority', storageLog, { seed: false });
	/** @type {string[]} */
	const events = [];
	const recorder = makeChannelRecorder();
	const tabScope = createTabScope();
	let stops = 0;
	registerNetworkRuntime(
		hash,
		{
			stop: async () => {
				stops += 1;
				events.push('stop');
			},
		},
		{ tabScope },
	);
	class LoggingChannel extends recorder.FakeChannel {
		/** @param {any} data */
		postMessage(data) {
			events.push('closing');
			super.postMessage(data);
		}
	}
	/** @type {Record<string, any>} */
	const seen = {};
	const { deps } = peerFakes({
		BroadcastChannel: LoggingChannel,
		tabScope,
		deleteMemberStorage: async () => {
			events.push('member');
			seen.memberStoreGone = !(await dbNames()).includes(dbNameFor(hash));
			seen.memberRegistry = Boolean(findNetwork(hash, storage));
			seen.memberRowCounts = Boolean(await readRowCountsRecord(hash, storage));
		},
		deleteDeviceKeys: async () => {
			events.push('keys');
			seen.keysRegistry = Boolean(findNetwork(hash, storage));
			seen.keysRowCounts = Boolean(await readRowCountsRecord(hash, storage));
			storageLog.length = 0;
		},
	});

	await forgetNetwork({ networkHash: hash, typedConfirmation: 'Order Authority', storage, deps });

	assert.deepEqual(events, ['closing', 'stop', 'member', 'keys']);
	assert.equal(stops, 1, 'the runtime stop ran exactly once');
	assert.equal(seen.memberStoreGone, true, 'the store was gone before the member storage delete');
	assert.equal(seen.memberRegistry, true, 'the registry entry was present during the member storage delete');
	assert.equal(seen.keysRegistry, true, 'the registry entry was present during the device-key delete');
	assert.equal(seen.keysRowCounts, true, 'the row-count record was still present when the keys went');
	const rowCountGone = storageLog.indexOf(`remove:${rowCountsKeyFor(hash)}`);
	const registryWrite = storageLog.indexOf(`set:${NETWORKS_REGISTRY_KEY}`);
	assert.ok(rowCountGone >= 0 && registryWrite > rowCountGone, `row-count cleared before the registry write: ${storageLog.join(', ')}`);
	assert.equal(findNetwork(hash, storage), undefined);
	assert.deepEqual(recorder.posted, [{ name: lifecycleChannelName(hash), data: { kind: 'network-closing', reason: 'forgotten' } }]);
	assert.equal(tabScope.runtimes.has(hash), false, 'the runtime was unregistered');
});

test('F10 real peer storage: forget removes this network\'s member databases and device keys and leaves another network\'s untouched', async () => {
	const memberNode = await import(moduleUrl(dashboardSrc('peer', 'member-node.js')));
	const keyStoreMod = await import(moduleUrl(dashboardSrc('peer', 'idb-key-store.js')));
	const hash = 'fn-real-peer';
	const other = 'fn-real-peer-other';
	const { storage } = await setupNetwork(hash, 'Real Peer Authority', null, { seed: false });

	const ours = [memberNode.memberStorageDbName(hash, 'control'), memberNode.memberStorageDbName(hash, '~node-local')];
	const theirs = memberNode.memberStorageDbName(other, 'control');
	for (const name of [...ours, theirs]) {
		const conn = /** @type {any} */ (await openRaw(name));
		conn.close();
	}
	const ourKeys = keyStoreMod.createIdbKeyStore({ networkHash: hash });
	await ourKeys.set('cadre/identity', new Uint8Array(32).fill(7));
	ourKeys.close();
	const otherKeys = keyStoreMod.createIdbKeyStore({ networkHash: other });
	await otherKeys.set('cadre/identity', new Uint8Array(32).fill(9));

	await forgetNetwork({
		networkHash: hash,
		typedConfirmation: 'Real Peer Authority',
		storage,
		deps: { BroadcastChannel: undefined, timeoutSignal: () => new AbortController().signal, tabScope: createTabScope() },
	});

	const names = await dbNames();
	for (const name of ours) assert.ok(!names.includes(name), 'a member database of this network survived');
	assert.ok(names.includes(theirs), "the other network's member database was deleted");
	const check = keyStoreMod.createIdbKeyStore({ networkHash: hash });
	assert.deepEqual(await check.list(), []);
	check.close();
	assert.deepEqual(await otherKeys.list(), ['cadre/identity'], "the other network's key was deleted");
	otherKeys.close();
	await assertNetworkForgotten(hash, storage);

	await memberNode.deleteMemberStorage(other);
	await keyStoreMod.deleteDeviceKeys(other);
});

test('F11 wipeNetwork: no confirmation; an unknown reason is a TypeError without the input; an absent entry still runs every delete; two wipes both resolve', async () => {
	const canary = 'WIPE-REASON-CANARY-71c2';
	await assert.rejects(
		() => wipeNetwork({ networkHash: 'fn-wipe', reason: /** @type {any} */ (canary) }),
		(/** @type {any} */ err) => err instanceof TypeError && !err.message.includes(canary),
	);

	const hash = 'fn-wipe';
	const { storage } = await setupNetwork(hash, 'Wipe Authority', null, { seed: false });
	const { deps, calls } = peerFakes();
	const first = await wipeNetwork({ networkHash: hash, reason: 'revoked', storage, deps });
	assert.equal(first.networkHash, hash);
	assert.equal(findNetwork(hash, storage), undefined);
	assert.deepEqual(calls, [`member:${hash}`, `keys:${hash}`]);

	const second = await wipeNetwork({ networkHash: hash, reason: 'removed', storage, deps });
	assert.equal(second.networkHash, hash);
	assert.deepEqual(calls, [`member:${hash}`, `keys:${hash}`, `member:${hash}`, `keys:${hash}`], 'the absent-entry wipe ran every delete');
	await assertNetworkForgotten(hash, storage, { deps });
});

test('F12 MemberStorageBusyError rejects by name and leaves the registry entry and the row-count record (data before registry)', async () => {
	const hash = 'fn-member-busy';
	const { storage, counts } = await setupNetwork(hash, 'Busy Authority', null, { seed: false });
	const { deps, calls } = peerFakes({
		deleteMemberStorage: async () => {
			const err = new Error('busy');
			err.name = 'MemberStorageBusyError';
			throw err;
		},
	});
	await assert.rejects(
		() => wipeNetwork({ networkHash: hash, reason: 'removed', storage, deps }),
		(/** @type {any} */ err) => err.name === 'MemberStorageBusyError',
	);
	assert.ok(findNetwork(hash, storage), 'the registry entry stays');
	assert.deepEqual((await readRowCountsRecord(hash, storage))?.counts, counts, 'the row-count record stays');
	assert.deepEqual(calls, [], 'the device keys were not reached');
	removeNetwork(hash, storage);
});

test('F13 runtime registry: idempotent unregister; a rejecting stop is logged by name only and the deletes still run; another network is not stopped', async () => {
	const tabScope = createTabScope();
	const unregister = registerNetworkRuntime('fn-rt-x', { stop: () => undefined }, { tabScope });
	assert.equal(tabScope.runtimes.get('fn-rt-x')?.size, 1);
	unregister();
	unregister();
	assert.equal(tabScope.runtimes.has('fn-rt-x'), false);

	const hash = 'fn-runtime';
	const { storage } = await setupNetwork(hash, 'Runtime Authority', null, { seed: false });
	let otherStopped = 0;
	registerNetworkRuntime(
		hash,
		{
			stop: async () => {
				throw new Error('RUNTIME-STOP-CANARY');
			},
		},
		{ tabScope },
	);
	registerNetworkRuntime('fn-runtime-other', { stop: () => void (otherStopped += 1) }, { tabScope });
	/** @type {any[][]} */
	const logged = [];
	const original = console.error;
	console.error = (/** @type {any[]} */ ...args) => logged.push(args);
	try {
		const { deps, calls } = peerFakes({ tabScope });
		await wipeNetwork({ networkHash: hash, reason: 'key-invalid', storage, deps });
		assert.deepEqual(calls, [`member:${hash}`, `keys:${hash}`]);
	} finally {
		console.error = original;
	}
	assert.equal(findNetwork(hash, storage), undefined);
	assert.equal(otherStopped, 0);
	assert.deepEqual(logged, [['lifecycle/forget-network:', 'Error']]);
	assert.equal(tabScope.runtimes.get('fn-runtime-other')?.size, 1);
});

test('F14 lifecycle lock: two forgets of one hash run in sequence (the second is UnknownNetworkError); wipes of two hashes overlap', async () => {
	const hash = 'fn-lock-one';
	const { storage } = await setupNetwork(hash, 'Lock Authority', null, { seed: false });
	let active = 0;
	let maxActive = 0;
	const { deps } = peerFakes({
		deleteMemberStorage: async () => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await ticks(5);
			active -= 1;
		},
	});
	const results = await Promise.allSettled([
		forgetNetwork({ networkHash: hash, typedConfirmation: 'Lock Authority', storage, deps }),
		forgetNetwork({ networkHash: hash, typedConfirmation: 'Lock Authority', storage, deps }),
	]);
	assert.equal(results[0].status, 'fulfilled');
	assert.equal(results[1].status, 'rejected');
	assert.ok(/** @type {any} */ (results[1]).reason instanceof UnknownNetworkError);
	assert.equal(maxActive, 1, 'the two forgets never deleted in parallel');

	const a = 'fn-lock-a';
	const b = 'fn-lock-b';
	const sa = await setupNetwork(a, 'A Authority', null, { seed: false });
	const sb = await setupNetwork(b, 'B Authority', null, { seed: false });
	/** @type {string[]} */
	const order = [];
	/** @type {Array<() => void>} */
	const gates = [];
	const overlap = peerFakes({
		deleteMemberStorage: async (/** @type {string} */ h) => {
			order.push(`start:${h}`);
			await new Promise((resolve) => gates.push(() => resolve(undefined)));
			order.push(`end:${h}`);
		},
	});
	const both = Promise.all([
		wipeNetwork({ networkHash: a, reason: 'revoked', storage: sa.storage, deps: overlap.deps }),
		wipeNetwork({ networkHash: b, reason: 'revoked', storage: sb.storage, deps: overlap.deps }),
	]);
	for (let i = 0; i < 200 && gates.length < 2; i += 1) await ticks(5);
	assert.equal(gates.length, 2, 'both wipes started before either finished');
	assert.deepEqual(order.slice(0, 2).sort(), [`start:${a}`, `start:${b}`]);
	for (const open of gates) open();
	await both;
	assert.equal(findNetwork(a, sa.storage), undefined);
	assert.equal(findNetwork(b, sb.storage), undefined);
});

test('F15 other tab: forget posts network-closing and waits for the node lock; a holder that never lets go is NetworkInUseError with the entry kept', async () => {
	const hash = 'fn-other-tab';
	const { storage } = await setupNetwork(hash, 'Tab Authority', null, { seed: false });
	const locks = createInTabLockManager();
	const recorder = makeChannelRecorder();
	/** @type {() => void} */
	let release = () => undefined;
	const held = new Promise((resolve) => {
		release = () => resolve(undefined);
	});
	const holderDone = locks.request(nodeLockName(hash), () => held);
	await ticks();

	const { deps, calls } = peerFakes({ locks, BroadcastChannel: recorder.FakeChannel });
	let settled = false;
	const pending = forgetNetwork({ networkHash: hash, typedConfirmation: 'Tab Authority', storage, deps }).finally(() => {
		settled = true;
	});
	await ticks(40);
	assert.deepEqual(recorder.posted, [{ name: lifecycleChannelName(hash), data: { kind: 'network-closing', reason: 'forgotten' } }]);
	assert.equal(settled, false, 'forget waits while the other tab holds the node');
	assert.deepEqual(calls, []);
	assert.ok(findNetwork(hash, storage));
	release();
	await holderDone;
	await pending;
	assert.equal(findNetwork(hash, storage), undefined);

	const hash2 = 'fn-other-tab-stuck';
	const stuck = await setupNetwork(hash2, 'Stuck Authority', null, { seed: false });
	locks.request(nodeLockName(hash2), () => new Promise(() => undefined));
	await ticks();
	const controller = new AbortController();
	const stuckDeps = peerFakes({ locks, BroadcastChannel: recorder.FakeChannel, timeoutSignal: () => controller.signal });
	const attempt = forgetNetwork({ networkHash: hash2, typedConfirmation: 'Stuck Authority', storage: stuck.storage, deps: stuckDeps.deps });
	await ticks(20);
	controller.abort();
	await assert.rejects(attempt, (/** @type {any} */ err) => err instanceof NetworkInUseError && err.subject === 'other-tab');
	assert.ok(findNetwork(hash2, stuck.storage), 'the entry stays when the other tab never lets go');
	assert.ok((await dbNames()).includes(dbNameFor(hash2)), 'nothing was deleted');
	assert.deepEqual(stuckDeps.calls, []);
	removeNetwork(hash2, stuck.storage);
	await deleteNetworkDb(hash2);
});

test('F16 resurrection: a store re-created after its delete and a member database listed one extra round are deleted again; one that never stops listing is DeleteBlockedError with the entry kept', async () => {
	const hash = 'fn-resurrect';
	const { storage } = await setupNetwork(hash, 'Resurrect Authority', null, { seed: false });
	const factory = /** @type {any} */ (indexedDB);
	const originalDatabases = factory.databases.bind(factory);
	const originalDelete = factory.deleteDatabase.bind(factory);
	let storeDeletes = 0;
	let resurrectOnce = true;
	let memberDeletes = 0;
	const phantom = fakeMemberName(hash, 'control');
	try {
		factory.deleteDatabase = (/** @type {string} */ name) => {
			if (name === dbNameFor(hash)) storeDeletes += 1;
			return originalDelete(name);
		};
		factory.databases = async () => {
			const list = await originalDatabases();
			if (resurrectOnce && storeDeletes === 1 && !list.some((/** @type {any} */ d) => d.name === dbNameFor(hash))) {
				resurrectOnce = false;
				const conn = /** @type {any} */ (await openRaw(dbNameFor(hash)));
				conn.close();
			}
			return memberDeletes === 1 ? [...list, { name: phantom, version: 1 }] : list;
		};
		const { deps } = peerFakes({
			deleteMemberStorage: async () => {
				memberDeletes += 1;
			},
		});
		await forgetNetwork({ networkHash: hash, typedConfirmation: 'Resurrect Authority', storage, deps });
		assert.equal(resurrectOnce, false, 'the store was resurrected once');
		assert.ok(storeDeletes >= 2, `the resurrected store was deleted again (${storeDeletes})`);
		assert.equal(memberDeletes, 2, 'the member database listed one extra round was deleted again');
		assert.ok(!(await originalDatabases()).some((/** @type {any} */ d) => d.name === dbNameFor(hash)));
		assert.equal(findNetwork(hash, storage), undefined);

		const hash2 = 'fn-resurrect-stuck';
		const stuck = await setupNetwork(hash2, 'Stuck Resurrect Authority', null, { seed: false });
		const forever = fakeMemberName(hash2, 'control');
		factory.databases = async () => [...(await originalDatabases()), { name: forever, version: 1 }];
		const stuckDeps = peerFakes();
		await assert.rejects(
			() => wipeNetwork({ networkHash: hash2, reason: 'revoked', storage: stuck.storage, deps: stuckDeps.deps }),
			(/** @type {any} */ err) => err.name === 'DeleteBlockedError',
		);
		assert.ok(findNetwork(hash2, stuck.storage), 'the entry stays when a member database never stops listing');
		assert.deepEqual(stuckDeps.calls.filter((c) => c.startsWith('keys:')), [], 'the device keys were not reached');
		removeNetwork(hash2, stuck.storage);
	} finally {
		delete factory.databases;
		delete factory.deleteDatabase;
	}
});

test('F17 createInTabLockManager: FIFO per name, ifAvailable hands null while held, an aborted queued request rejects AbortError, query reports held and pending', async () => {
	const locks = createInTabLockManager();
	/** @type {string[]} */
	const order = [];
	/** @type {() => void} */
	let releaseFirst = () => undefined;
	const first = locks.request('L', async () => {
		order.push('first');
		await new Promise((resolve) => {
			releaseFirst = () => resolve(undefined);
		});
	});
	const second = locks.request('L', {}, async () => order.push('second'));
	const third = locks.request('L', async () => order.push('third'));
	await ticks();
	assert.equal(await locks.request('L', { ifAvailable: true }, (/** @type {any} */ lock) => lock), null);
	assert.equal(
		await locks.request('free', { ifAvailable: true }, (/** @type {any} */ lock) => lock?.name),
		'free',
		'ifAvailable takes a free lock',
	);
	const controller = new AbortController();
	const aborted = locks.request('L', { signal: controller.signal }, () => order.push('aborted'));
	const snapshot = await locks.query();
	assert.deepEqual(snapshot.held, [{ name: 'L', mode: 'exclusive' }]);
	assert.equal(snapshot.pending.length, 3);
	controller.abort();
	await assert.rejects(aborted, (/** @type {any} */ err) => err.name === 'AbortError');
	assert.equal((await locks.query()).pending.length, 2);
	releaseFirst();
	await Promise.all([first, second, third]);
	assert.deepEqual(order, ['first', 'second', 'third']);
	assert.deepEqual(await locks.query(), { held: [], pending: [] });

	const lifecycle = createInTabLockManager();
	assert.equal(await withNetworkLifecycleLock('fn-lifecycle', async () => 42, { locks: lifecycle }), 42);
	await assert.rejects(
		withNetworkLifecycleLock('fn-lifecycle', async () => Promise.reject(new RangeError('x')), { locks: lifecycle }),
		RangeError,
	);
	assert.equal(lifecycleLockName('h'), 'vt-dashboard-lifecycle-h');
	assert.equal(nodeLockName('h'), 'vt-dashboard-node-h');
	assert.throws(() => nodeLockName(''), TypeError);
});

test('F18 PII: an authorityName canary appears in no thrown message and in no console.error argument', async () => {
	const CANARY = 'PII-CANARY-5d1e';
	/** @type {string[]} */
	const messages = [];
	/** @type {any[][]} */
	const logged = [];
	const original = console.error;
	console.error = (/** @type {any[]} */ ...args) => logged.push(args);
	try {
		const hash = 'fn-canary';
		const { storage } = await setupNetwork(hash, CANARY, null, { seed: false });
		const tabScope = createTabScope();
		registerNetworkRuntime(
			hash,
			{
				stop: async () => {
					throw new Error(CANARY);
				},
			},
			{ tabScope },
		);
		const { deps } = peerFakes({ tabScope });

		await forgetNetwork({ networkHash: hash, typedConfirmation: `${CANARY}-wrong`, storage, deps }).catch((err) => messages.push(err.message));
		await forgetNetwork({ networkHash: 'fn-canary-unknown', typedConfirmation: CANARY, storage, deps }).catch((err) =>
			messages.push(err.message),
		);

		const db = await attachNetworkDb(hash, { storage });
		const blocking = /** @type {any} */ (await openRaw(dbNameFor(hash)));
		await forgetNetwork({ networkHash: hash, typedConfirmation: CANARY, db, storage, timeoutMs: 100, deps }).catch((err) =>
			messages.push(err.message),
		);
		blocking.close();
		await closeNetworkDb(db);

		const locks = createInTabLockManager();
		locks.request(nodeLockName(hash), () => new Promise(() => undefined));
		await forgetNetwork({ networkHash: hash, typedConfirmation: CANARY, storage, deps: { ...deps, locks, timeoutSignal: () => AbortSignal.abort() } }).catch(
			(err) => messages.push(err.message),
		);
		await assertNetworkForgotten(hash, storage, { deps }).catch((err) => messages.push(err.message));
		removeNetwork(hash, storage);
		await deleteNetworkDb(hash);
	} finally {
		console.error = original;
	}
	assert.ok(messages.length >= 5, `every forced error path ran (${messages.length})`);
	for (const message of messages) assert.ok(!message.includes(CANARY), 'a thrown message leaked the canary');
	assert.ok(logged.length >= 1, 'the rejecting runtime stop was logged');
	for (const args of logged) {
		assert.equal(args[0], 'lifecycle/forget-network:');
		for (const arg of args) assert.ok(!String(arg).includes(CANARY), 'a console.error argument leaked the canary');
	}
});

test('F19 source scan: no static peer import, exactly the three lazy peer specifiers, no timer, no mutation words', () => {
	const PEER = '..' + '/peer/';
	const staticPeerRe = new RegExp(`^\\s*import[^(]*from\\s*['"]${PEER.replace(/\./g, '\\.').replace(/\//g, '\\/')}`, 'm');
	const lazyRe = new RegExp(`import\\(\\s*'${PEER.replace(/\./g, '\\.').replace(/\//g, '\\/')}(member-node|idb-key-store|device-key)\\.js'\\s*\\)`, 'g');
	const timerRe = new RegExp(['set' + 'Timeout', 'set' + 'Interval'].join('|'));
	const mutationRe = new RegExp(['insert\\s+into', 'update\\s+\\S+\\s+set', 'delete\\s+from'].map((s) => `\\b${s}\\b`).join('|'), 'i');

	// Positive controls first.
	assert.match(`import { x } from '${PEER}member-node.js';`, staticPeerRe);
	assert.equal(`const m = import('${PEER}device-key.js');`.match(lazyRe)?.length, 1);
	assert.match('globalThis.set' + 'Timeout(fn, 1)', timerRe);
	assert.match('insert ' + 'into T (a) values (1)', mutationRe);

	const source = stripComments(readFileSync(new URL(FORGET_URL), 'utf8'));
	assert.doesNotMatch(source, staticPeerRe);
	const lazy = (source.match(lazyRe) ?? []).map((m) => /** @type {RegExpMatchArray} */ (m.match(/(member-node|idb-key-store|device-key)/))[0]);
	assert.deepEqual([...new Set(lazy)].sort(), ['device-key', 'idb-key-store', 'member-node']);
	assert.equal(lazy.length, 3);
	assert.doesNotMatch(source, timerRe);
	assert.doesNotMatch(source, mutationRe);
});

test('F20 a busy member-storage delete is retried, bounded, with one fixed log line per retry; then the wipe finishes', async () => {
	const hash = 'fn-member-busy-twice';
	const { storage } = await setupNetwork(hash, 'Busy Twice Authority', null, { seed: false });
	let attempts = 0;
	const { deps, calls } = peerFakes({
		deleteMemberStorage: async (/** @type {string} */ h) => {
			attempts += 1;
			if (attempts <= 2) {
				const err = new Error(`busy ${h}`);
				err.name = 'MemberStorageBusyError';
				throw err;
			}
			calls.push(`member:${h}`);
		},
	});
	/** @type {unknown[][]} */
	const logged = [];
	const original = console.error;
	console.error = (/** @type {unknown[]} */ ...args) => logged.push(args);
	try {
		await wipeNetwork({ networkHash: hash, reason: 'removed', storage, deps });
	} finally {
		console.error = original;
	}
	assert.equal(attempts, 3, 'two busy attempts, then the delete that went through');
	assert.equal(findNetwork(hash, storage), undefined, 'the registry entry is gone');
	assert.equal(await readRowCountsRecord(hash, storage), undefined, 'the row-count record is gone');
	assert.deepEqual(calls, [`member:${hash}`, `keys:${hash}`], 'the device keys were reached');
	const retry = ['lifecycle/forget-network:', 'MemberStorageBusyError', 'retry:member-storage'];
	assert.deepEqual(logged, [retry, retry], 'exactly two retry lines, a fixed store label only');
	for (const args of logged) for (const arg of args) assert.ok(!String(arg).includes(hash), 'no hash in a retry line');
});
