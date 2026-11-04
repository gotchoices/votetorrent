/**
 * Tier-1 coverage of `src/peer/boot.js`, the live dashboard's one runtime
 * composition, driven entirely by fakes: a fake member node, strand reader and
 * replication, a manual clock with manual intervals, an in-memory
 * BroadcastChannel bus and the in-tab lock manager from forget-network.js.
 * The registry is the real web-data registry over a fake storage. B17 runs the
 * real `wipeNetwork` over fake-indexeddb with peer-storage fakes.
 *
 * No test waits in real time: every timer is the manual clock's.
 *
 * `import 'fake-indexeddb/auto'` first.
 */
import 'fake-indexeddb/auto';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
	upsertNetwork,
	findNetwork,
	recordLastPassAt,
	LiveStoreMissingError,
	LiveStoreUnavailableError,
} from '@votetorrent/web-data/officer';
import { dashboardRoot, dashboardSrc, moduleUrl } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';

// Every console.error of this file is captured for B18.
/** @type {any[][]} */
const CONSOLE_ERRORS = [];
const ORIGINAL_CONSOLE_ERROR = console.error;
console.error = (/** @type {any[]} */ ...args) => {
	CONSOLE_ERRORS.push(args);
};

const BOOT_URL = moduleUrl(dashboardSrc('peer', 'boot.js'));
/** @type {typeof import('../../src/peer/boot.js')} */
const bootMod = await import(BOOT_URL);
const { startDashboardBoot, switchDashboardBoot, BOOT_FAILURES, STATUS_TICK_MS, LAST_PASS_PERSIST_MS, KEY_INVALID_CONFIRM_PASSES } = bootMod;
/** @type {typeof import('../../src/lifecycle/forget-network.js')} */
const forget = await import(moduleUrl(dashboardSrc('lifecycle', 'forget-network.js')));
const { createInTabLockManager, createTabScope, nodeLockName, lifecycleChannelName } = forget;
/** @type {typeof import('../../src/peer/reactivity-bridge.js')} */
const bridge = await import(moduleUrl(dashboardSrc('peer', 'reactivity-bridge.js')));
/** @type {typeof import('../../src/peer/pairing.js')} */
const pairing = await import(moduleUrl(dashboardSrc('peer', 'pairing.js')));

const T0 = 1_780_000_000_000;
const CANARY = 'BOOT-CANARY-3e8a';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** @param {number} [n] */
async function ticks(n = 25) {
	for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
}

function makeFakeStorage() {
	/** @type {Map<string, string>} */
	const map = new Map();
	return {
		getItem: (/** @type {string} */ k) => (map.has(k) ? /** @type {string} */ (map.get(k)) : null),
		setItem: (/** @type {string} */ k, /** @type {string} */ v) => void map.set(k, v),
		removeItem: (/** @type {string} */ k) => void map.delete(k),
	};
}

/**
 * @param {string} hash
 * @param {Record<string, unknown>} [overrides]
 */
function pairedEntry(hash, overrides = {}) {
	return {
		networkHash: hash,
		authorityName: 'Authority',
		domain: 'example.org',
		officerUserId: 'officer1',
		pairing: {
			v: 1,
			requesterPeerId: '12D3KooWRequester',
			nonce: 'nonce-abc',
			expiresAt: '2026-11-03T10:15:00',
			keyPub: '02' + 'a'.repeat(64),
			sig: 'ab'.repeat(64),
			pairedAt: '2026-11-03T10:01:00',
			relayAddrs: ['/dns4/relay.example/tcp/443/wss/p2p/12D3KooWRelay'],
			strandId: `strand-of-${hash}`,
		},
		...overrides,
	};
}

/** A manual clock with manual intervals: `advance` fires due intervals in time order. */
function makeClock(start = T0) {
	let t = start;
	let nextId = 0;
	/** @type {Map<number, { fn: () => void, ms: number, due: number }>} */
	const timers = new Map();
	return {
		now: () => t,
		setInterval: (/** @type {() => void} */ fn, /** @type {number} */ ms) => {
			nextId += 1;
			timers.set(nextId, { fn, ms, due: t + ms });
			return nextId;
		},
		clearInterval: (/** @type {any} */ id) => void timers.delete(id),
		count: () => timers.size,
		/** @param {number} ms */
		async advance(ms) {
			const end = t + ms;
			for (;;) {
				let nextKey = -1;
				let nextDue = Infinity;
				for (const [key, timer] of timers) {
					if (timer.due <= end && timer.due < nextDue) {
						nextDue = timer.due;
						nextKey = key;
					}
				}
				if (nextKey === -1) break;
				const timer = /** @type {{ fn: () => void, ms: number, due: number }} */ (timers.get(nextKey));
				t = timer.due;
				timer.due += timer.ms;
				timer.fn();
				await ticks(5);
			}
			t = end;
			await ticks(5);
		},
	};
}

/** An in-memory BroadcastChannel bus (delivers to every other open channel of the name). */
function makeBus() {
	/** @type {Set<any>} */
	const open = new Set();
	class Channel {
		/** @param {string} name */
		constructor(name) {
			this.name = name;
			/** @type {any} */
			this.onmessage = null;
			open.add(this);
		}
		/** @param {any} data */
		postMessage(data) {
			for (const other of [...open]) {
				if (other !== this && other.name === this.name) queueMicrotask(() => other.onmessage?.({ data }));
			}
		}
		close() {
			open.delete(this);
		}
	}
	return { Channel, open };
}

/**
 * A fake member node.
 *
 * @param {string[]} log
 * @param {Record<string, any>} [opts]
 */
function makeFakeNode(log, opts = {}) {
	/** @type {Map<string, Set<(p: any) => void>>} */
	const listeners = new Map();
	const strandNode = { peerId: { toString: () => 'strand-peer-1' } };
	/** @type {any} */
	const node = {
		peerId: 'identity-peer-1',
		connections: opts.connections ?? 1,
		strandPeers: opts.strandPeers ?? 1,
		reconnects: 0,
		stops: 0,
		joins: 0,
		resumeCalls: 0,
		on(/** @type {string} */ event, /** @type {(p: any) => void} */ cb) {
			if (!listeners.has(event)) listeners.set(event, new Set());
			/** @type {Set<any>} */ (listeners.get(event)).add(cb);
			return () => listeners.get(event)?.delete(cb);
		},
		emit(/** @type {string} */ event, /** @type {any} */ payload) {
			for (const cb of [...(listeners.get(event) ?? [])]) cb(payload);
		},
		listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
		async joinCadre() {
			node.joins += 1;
			return 'joined';
		},
		async resume() {
			node.resumeCalls += 1;
			log.push('resume');
			return opts.resume ? opts.resume() : 'running';
		},
		async waitForStrand(/** @type {string} */ id, /** @type {any} */ o) {
			log.push('waitForStrand');
			node.waitArgs = { id, signal: o?.signal };
			return strandNode;
		},
		getStrandNode: () => strandNode,
		strandPeerId: () => 'strand-peer-1',
		getControlNode: () => ({ getConnections: () => new Array(node.connections).fill({}) }),
		strandPeerCount: () => node.strandPeers,
		async reconnect() {
			node.reconnects += 1;
			log.push('reconnect');
			if (opts.reconnectGate) await opts.reconnectGate;
		},
		async stop() {
			node.stops += 1;
			log.push('node.stop');
			if (opts.stopRejects) throw new Error('stop failed');
		},
		status: () => 'running',
	};
	node.strandNode = strandNode;
	return node;
}

/** @param {string[]} log */
function makeReader(log, opts = {}) {
	return {
		closes: 0,
		async current() {
			return {};
		},
		async readRows() {
			return [];
		},
		async close() {
			this.closes += 1;
			log.push('reader.close');
			if (/** @type {any} */ (opts).closeRejects) throw new Error('close failed');
		},
	};
}

/**
 * Build one tab's world: deps, fakes and logs.
 *
 * @param {Record<string, any>} [opts]
 */
function makeWorld(opts = {}) {
	const hash = opts.hash ?? 'net-a';
	/** @type {string[]} */
	const log = [];
	const storage = opts.storage ?? makeFakeStorage();
	if (!opts.storage && opts.entry !== null) upsertNetwork(opts.entry ?? pairedEntry(hash, opts.entryOverrides ?? {}), storage);
	const clock = opts.clock ?? makeClock();
	const innerLocks = opts.locks ?? createInTabLockManager();
	const locks = {
		request(/** @type {string} */ name, /** @type {any} */ o, /** @type {any} */ cb) {
			log.push(`lock:${name}`);
			return innerLocks.request(name, o, cb);
		},
		query: () => innerLocks.query(),
	};
	const tabScope = opts.tabScope ?? createTabScope();
	/** @type {any[]} */
	const nodes = [];
	/** @type {any[]} */
	const readers = [];
	/** @type {any[]} */
	const replications = [];
	/** @type {any[]} */
	const checks = [];
	/** @type {any[]} */
	const verdicts = [];
	/** @type {any[]} */
	const wipes = [];
	/** @type {Set<(n: any) => void>} */
	const noticeListeners = new Set();
	/** @type {Map<string, any>} */
	const dbs = new Map();
	/** @type {any} */
	const world = {
		hash,
		log,
		storage,
		clock,
		locks,
		innerLocks,
		tabScope,
		nodes,
		readers,
		replications,
		checks,
		verdicts,
		wipes,
		noticeListeners,
		dbs,
		wipeGate: Promise.resolve(),
		nodeOpts: opts.nodeOpts ?? {},
		readerOpts: opts.readerOpts ?? {},
		persisted: /** @type {Array<[string, number]>} */ ([]),
		dbFor(/** @type {string} */ h) {
			if (!dbs.has(h)) dbs.set(h, { name: `local-db-${h}`, closes: 0 });
			return dbs.get(h);
		},
	};
	world.deps = {
		storage,
		locks,
		tabScope,
		BroadcastChannel: opts.bus ? opts.bus.Channel : undefined,
		now: clock.now,
		setInterval: clock.setInterval,
		clearInterval: clock.clearInterval,
		attachLiveDb: async (/** @type {string} */ h, /** @type {any} */ o) => {
			log.push(`attach:${h}`);
			world.attachArgs = [h, o];
			if (opts.attachError) throw opts.attachError;
			return world.dbFor(h);
		},
		closeNetworkDb: async (/** @type {any} */ db) => {
			log.push(`closeNetworkDb:${db?.name}`);
			if (db) db.closes += 1;
		},
		recordLastPassAt: (/** @type {string} */ h, /** @type {number} */ at, /** @type {any} */ s) => {
			world.persisted.push([h, at]);
			return recordLastPassAt(h, at, s);
		},
		subscribeToOfficerChanges: (/** @type {string} */ _h, /** @type {(n: any) => void} */ listener) => {
			noticeListeners.add(listener);
			return () => noticeListeners.delete(listener);
		},
		createMemberNode: async (/** @type {any} */ o) => {
			log.push('createMemberNode');
			world.createArgs = o;
			if (world.createGate) await world.createGate;
			const node = makeFakeNode(log, world.nodeOpts);
			nodes.push(node);
			return node;
		},
		createIdbKeyStore: (/** @type {any} */ o) => ({ kind: 'fake-key-store', networkHash: o.networkHash }),
		openStrandReader: async (/** @type {any} */ o) => {
			log.push('openStrandReader');
			world.openArgs = o;
			if (world.openError) throw world.openError;
			const reader = makeReader(log, world.readerOpts);
			readers.push(reader);
			return reader;
		},
		startOfficerReplication: (/** @type {any} */ o) => {
			log.push(`start:${o.networkHash}`);
			const handle = {
				options: o,
				stops: 0,
				wakes: 0,
				whenIdleCalls: 0,
				async stop() {
					handle.stops += 1;
					log.push(`replication.stop:${o.networkHash}`);
					if (world.replicationStopGate) await world.replicationStopGate;
					if (world.replicationStopRejects) throw new Error('stop failed');
				},
				async whenIdle() {
					handle.whenIdleCalls += 1;
					if (world.whenIdleThrows) throw new Error('whenIdle must not be called during afterPass');
				},
				wake() {
					handle.wakes += 1;
				},
			};
			replications.push(handle);
			return handle;
		},
		checkPairingStillValid: async (/** @type {any} */ o) => {
			log.push('check');
			checks.push(o);
			const next = verdicts.length > 0 ? verdicts.shift() : { ok: true };
			if (next instanceof Error) throw next;
			return next;
		},
		wipeNetwork: async (/** @type {any} */ o) => {
			log.push(`wipe:${o.reason}`);
			wipes.push(o);
			await world.wipeGate;
			return { networkHash: o.networkHash, remaining: [] };
		},
	};
	return world;
}

/**
 * Run one completed pass through the captured replication options.
 *
 * @param {any} handle
 * @param {{ at?: number, changedTables?: string[], failed?: boolean }} [p]
 */
async function runPass(handle, p = {}) {
	const at = p.at ?? 0;
	const changedTables = Object.freeze([...(p.changedTables ?? [])].sort());
	handle.options.onPass({ type: 'pass-start' });
	if (p.failed) {
		handle.options.onPass({ type: 'pass-failed', name: 'Error', changedTables });
		return;
	}
	handle.options.onPass({ type: 'pass-complete', at, changedTables, changes: [] });
	await handle.options.afterPass({ at, changedTables });
}

/** Start a leader boot and wait for its bring-up. */
async function startLeader(/** @type {any} */ world, /** @type {Record<string, any>} */ extra = {}) {
	const boot = await startDashboardBoot({ networkHash: extra.hash ?? world.hash, adopt: extra.adopt, deps: world.deps });
	await ticks();
	return boot;
}

// ---------------------------------------------------------------------------
// B1-B19
// ---------------------------------------------------------------------------

test('B1 never throws: each open failure maps to its closed failure, with db null, no node lock and no member node', async () => {
	assert.deepEqual([...BOOT_FAILURES], ['invalid-network', 'unknown-network', 'legacy', 'absent', 'not-initialized', 'no-storage', 'open-failed', 'not-paired']);
	assert.ok(Object.isFrozen(BOOT_FAILURES));

	/** @type {Array<[string, Record<string, any>, string | number]>} */
	const cases = [
		['invalid-network', {}, ''],
		['invalid-network', {}, 42],
		['unknown-network', { entry: null }, 'net-b1-unknown'],
		['legacy', { entry: { networkHash: 'net-b1-legacy', authorityName: 'A', domain: 'd', officerUserId: 'u', bootstrappedAt: '2026-11-01T10:00:00' } }, 'net-b1-legacy'],
		['absent', { attachError: new LiveStoreMissingError('net-b1-absent', 'absent') }, 'net-b1-absent'],
		['not-initialized', { attachError: new LiveStoreMissingError('net-b1-ni', 'not-initialized') }, 'net-b1-ni'],
		['no-storage', { attachError: new LiveStoreUnavailableError() }, 'net-b1-ns'],
		['open-failed', { attachError: new RangeError(CANARY) }, 'net-b1-of'],
	];
	for (const [expected, opts, hash] of cases) {
		const world = makeWorld({ ...opts, hash: typeof hash === 'string' && hash.length > 0 ? hash : 'net-b1-x' });
		const boot = await startDashboardBoot({ networkHash: /** @type {any} */ (hash), deps: world.deps });
		await ticks();
		assert.equal(boot.failure, expected, `case ${expected}`);
		assert.equal(boot.db, null);
		assert.ok(!world.log.some((/** @type {string} */ l) => l.startsWith('lock:vt-dashboard-node-')), 'no node lock was requested');
		assert.ok(!world.log.includes('createMemberNode'));
		if (expected === 'legacy' || expected.endsWith('network')) {
			assert.ok(!world.log.some((/** @type {string} */ l) => l.startsWith('attach:')), 'attachLiveDb was not called');
		}
		await boot.stop();
		assert.equal(world.tabScope.active.boot, null);
	}
	const none = await startDashboardBoot(/** @type {any} */ (undefined));
	assert.equal(none.failure, 'invalid-network');
});

test('B2 order: local copy first, then the node lock, then create -> resume -> waitForStrand -> reader -> replication; resolves with db even when the node is held elsewhere', async () => {
	const world = makeWorld({ hash: 'net-b2', entryOverrides: { lastPassAt: T0 - 5_000 } });
	const originalRequest = world.locks.request;
	world.locks.request = (/** @type {string} */ name, /** @type {any} */ o, /** @type {any} */ cb) => {
		if (name === nodeLockName('net-b2') && o?.ifAvailable) {
			world.log.push(`node-lock-seen-lastPassAt:${world.tabScope.active.boot?.getStatus().lastPassAt}`);
		}
		return originalRequest(name, o, cb);
	};
	const boot = await startDashboardBoot({ networkHash: 'net-b2', deps: world.deps });
	assert.equal(boot.db, world.dbFor('net-b2'));
	assert.equal(boot.failure, null);
	await ticks();
	const order = world.log.filter((/** @type {string} */ l) => !l.startsWith('check'));
	assert.deepEqual(order, [
		'lock:vt-dashboard-lifecycle-net-b2',
		'attach:net-b2',
		`node-lock-seen-lastPassAt:${T0 - 5_000}`,
		'lock:vt-dashboard-node-net-b2',
		'createMemberNode',
		'resume',
		'waitForStrand',
		'openStrandReader',
		'start:net-b2',
	]);
	assert.deepEqual(world.attachArgs, ['net-b2', { create: false }]);
	assert.equal(boot.getStatus().lastPassAt, T0 - 5_000, 'reset carried the persisted lastPassAt');
	assert.equal(world.replications[0].wakes, 1, 'the replication was woken once at start');
	await boot.stop();

	// Node lock held elsewhere: the promise still resolves with db set.
	const held = makeWorld({ hash: 'net-b2-held' });
	/** @type {() => void} */
	let release = () => undefined;
	held.innerLocks.request(
		nodeLockName('net-b2-held'),
		() =>
			new Promise((r) => {
				release = () => r(undefined);
			}),
	);
	await ticks();
	const follower = await startDashboardBoot({ networkHash: 'net-b2-held', deps: held.deps });
	assert.equal(follower.db, held.dbFor('net-b2-held'));
	await ticks();
	assert.equal(follower.role, 'follower');
	await follower.stop();
	release();
});

test('B3 resume: createMemberNode gets the pairing relays, strand id and key store; resume only; removed unpairs and wipes; not-paired fails without a wipe and stops retrying', async () => {
	const world = makeWorld({ hash: 'net-b3' });
	const boot = await startLeader(world);
	const entry = /** @type {any} */ (findNetwork('net-b3', world.storage));
	assert.deepEqual(world.createArgs.relayAddrs, entry.pairing.relayAddrs);
	assert.equal(world.createArgs.strandId, entry.pairing.strandId);
	assert.equal(world.createArgs.networkHash, 'net-b3');
	assert.deepEqual(world.createArgs.keyStore, { kind: 'fake-key-store', networkHash: 'net-b3' });
	assert.equal(world.nodes[0].resumeCalls, 1);
	assert.equal(world.nodes[0].joins, 0, 'joinCadre is never called');
	await boot.stop();

	const removed = makeWorld({ hash: 'net-b3-removed', nodeOpts: { resume: () => 'removed' } });
	/** @type {string[]} */
	const reasons = [];
	const rboot = await startDashboardBoot({ networkHash: 'net-b3-removed', deps: removed.deps });
	rboot.onUnpaired((r) => reasons.push(r));
	await ticks();
	assert.equal(rboot.getStatus().kind, 'unpaired');
	assert.equal(rboot.getStatus().reason, 'removed');
	assert.deepEqual(removed.wipes.map((/** @type {any} */ w) => w.reason), ['removed']);
	assert.deepEqual(reasons, ['removed']);

	const np = makeWorld({ hash: 'net-b3-np', nodeOpts: { resume: () => 'not-paired' } });
	const npBoot = await startLeader(np);
	assert.equal(npBoot.failure, 'not-paired');
	assert.deepEqual(np.wipes, []);
	const before = np.log.length;
	await np.clock.advance(3 * 20_000 + 10);
	const after = np.log.slice(before).filter((/** @type {string} */ l) => ['createMemberNode', 'resume', 'waitForStrand', 'openStrandReader', 'reconnect'].includes(l));
	assert.deepEqual(after, [], 'no bring-up call across three retry ticks');
	await npBoot.stop();
});

test('B4 replication options: the local handle, the reader, OFFICER_REPLICATION_TABLES by reference, strand-<id>, the strand node and its peer id', async () => {
	const world = makeWorld({ hash: 'net-b4' });
	const boot = await startLeader(world);
	const o = world.replications[0].options;
	assert.equal(o.db, world.dbFor('net-b4'));
	assert.equal(o.strandReader, world.readers[0]);
	assert.equal(o.tables, bridge.OFFICER_REPLICATION_TABLES);
	assert.equal(o.networkName, 'strand-strand-of-net-b4');
	assert.equal(o.strandNode, world.nodes[0].strandNode);
	assert.equal(o.strandPeerId, 'strand-peer-1');
	assert.equal(o.networkHash, 'net-b4');
	assert.deepEqual(Object.keys(world.openArgs).sort(), ['memberNode', 'signal', 'strandId']);
	assert.equal(world.openArgs.memberNode, world.nodes[0]);
	assert.equal(world.openArgs.strandId, 'strand-of-net-b4');
	await boot.stop();
});

test('B5 adopt: no create/resume/waitForStrand/reader open and no boot-time check; the handoff drives replication; a follower stops the handed-over node and reader', async () => {
	const world = makeWorld({ hash: 'net-b5', entryOverrides: { lastPassAt: T0 - 1_000 } });
	const handoff = { memberNode: makeFakeNode(world.log), strandReader: makeReader(world.log) };
	const boot = await startLeader(world, { adopt: handoff });
	for (const call of ['createMemberNode', 'resume', 'waitForStrand', 'openStrandReader', 'check']) {
		assert.ok(!world.log.includes(call), `${call} ran on an adopted boot`);
	}
	assert.equal(world.replications[0].options.strandReader, handoff.strandReader);
	assert.equal(world.replications[0].options.strandNode, handoff.memberNode.strandNode);
	assert.equal(boot.getStatus().lastPassAt, null);
	await boot.stop();
	assert.equal(handoff.memberNode.stops, 1, 'the adopted node is stopped by the boot that owns it');

	const followerWorld = makeWorld({ hash: 'net-b5-f' });
	followerWorld.innerLocks.request(nodeLockName('net-b5-f'), () => new Promise(() => undefined));
	await ticks();
	const handoff2 = { memberNode: makeFakeNode(followerWorld.log), strandReader: makeReader(followerWorld.log) };
	const follower = await startLeader(followerWorld, { adopt: handoff2 });
	assert.equal(follower.role, 'follower');
	assert.equal(handoff2.memberNode.stops, 1, 'the follower stopped the handed-over node');
	assert.equal(handoff2.strandReader.closes, 1, 'the follower closed the handed-over reader');
	assert.deepEqual(followerWorld.replications, []);
	await follower.stop();
	assert.equal(handoff2.memberNode.stops, 1, 'not stopped twice');
});

test('B6 status: control seeded, node events mapped, strand peers polled, live only after a connected pass, stable view object, decay to catching-up and offline after the grace', async () => {
	const world = makeWorld({ hash: 'net-b6' });
	const boot = await startLeader(world);
	const node = world.nodes[0];
	assert.ok(node.listenerCount() >= 3, 'node listeners attached');
	/** @type {any[]} */
	const views = [];
	boot.subscribeStatus((v) => views.push(v));

	assert.equal(boot.getStatus().kind, 'catching-up');
	await runPass(world.replications[0], { at: world.clock.now() });
	assert.equal(boot.getStatus().kind, 'live', 'a pass started connected completes -> live');
	const s1 = boot.getStatus();
	await world.clock.advance(STATUS_TICK_MS);
	assert.equal(boot.getStatus(), s1, 'same object between ticks with no change');
	const viewCount = views.length;
	await world.clock.advance(5 * STATUS_TICK_MS);
	assert.equal(views.length, viewCount, 'no listener call without a view change');

	await world.clock.advance(36_000);
	assert.equal(boot.getStatus().kind, 'catching-up', 'live decays after 40 s without a pass');

	node.emit('control:disconnected');
	await world.clock.advance(9_000);
	assert.equal(boot.getStatus().kind, 'catching-up', 'within the offline grace');
	await world.clock.advance(2_000);
	assert.equal(boot.getStatus().kind, 'offline', 'offline after the 10 s grace');

	node.emit('control:connected');
	await world.clock.advance(STATUS_TICK_MS);
	assert.equal(boot.getStatus().kind, 'catching-up');
	node.strandPeers = 0;
	await world.clock.advance(STATUS_TICK_MS);
	await runPass(world.replications[0], { at: world.clock.now() });
	assert.notEqual(boot.getStatus().kind, 'live', 'a pass with no strand peer (polled) is not live');
	node.strandPeers = 2;
	await world.clock.advance(STATUS_TICK_MS);
	await runPass(world.replications[0], { at: world.clock.now() });
	assert.equal(boot.getStatus().kind, 'live');
	await boot.stop();

	const cold = makeWorld({ hash: 'net-b6-cold', nodeOpts: { connections: 0 } });
	const coldBoot = await startLeader(cold);
	await runPass(cold.replications[0], { at: cold.clock.now() });
	assert.notEqual(coldBoot.getStatus().kind, 'live', 'seeded disconnected: a pass is not live');
	await coldBoot.stop();
});

test('B7 data: an empty pass emits nothing; a changing pass bumps with a read-only Set; a failed pass with changes bumps; markEligible false on the catch-up pass, true after', async () => {
	const world = makeWorld({ hash: 'net-b7' });
	const boot = await startLeader(world);
	/** @type {any[]} */
	const events = [];
	boot.subscribeData((v) => events.push(v));
	assert.deepEqual(boot.getDataVersion().version, 0);

	await runPass(world.replications[0], { at: world.clock.now(), changedTables: [] });
	assert.equal(events.length, 0, 'an empty changedTables emits nothing');

	await runPass(world.replications[0], { at: world.clock.now(), changedTables: ['Election'] });
	assert.equal(events.length, 1);
	assert.equal(events[0].version, 1);
	assert.deepEqual([...events[0].changedTables], ['Election']);
	assert.equal(events[0].markEligible, true, 'passDone was already true from the empty pass');
	assert.throws(() => events[0].changedTables.add('X'), TypeError);
	assert.ok(Object.isFrozen(events[0]));

	await runPass(world.replications[0], { at: world.clock.now(), changedTables: ['Ballot'], failed: true });
	assert.equal(events.length, 2);
	assert.equal(events[1].version, 2);
	assert.deepEqual([...events[1].changedTables], ['Ballot']);
	assert.equal(boot.getDataVersion(), events[1]);
	await boot.stop();

	const fresh = makeWorld({ hash: 'net-b7-fresh' });
	const freshBoot = await startLeader(fresh);
	/** @type {any[]} */
	const freshEvents = [];
	freshBoot.subscribeData((v) => freshEvents.push(v));
	await runPass(fresh.replications[0], { at: fresh.clock.now(), changedTables: ['Election'] });
	await runPass(fresh.replications[0], { at: fresh.clock.now(), changedTables: ['Ballot'] });
	assert.deepEqual(
		freshEvents.map((e) => e.markEligible),
		[false, true],
		'the pass that first completes the catch-up is not mark-eligible',
	);
	await freshBoot.stop();
});

test('B8 lastPassAt: first qualifying pass persists, one within 60 s does not, one after does, stop flushes, an ignored pass is never persisted', async () => {
	const world = makeWorld({ hash: 'net-b8' });
	const boot = await startLeader(world);
	const r = world.replications[0];
	const t1 = world.clock.now();
	await runPass(r, { at: t1 });
	assert.deepEqual(world.persisted, [['net-b8', t1]]);
	await world.clock.advance(10_000);
	await runPass(r, { at: world.clock.now() });
	assert.equal(world.persisted.length, 1, 'a second pass within 60 s is not persisted');
	await world.clock.advance(LAST_PASS_PERSIST_MS);
	const t3 = world.clock.now();
	await runPass(r, { at: t3 });
	assert.deepEqual(world.persisted.at(-1), ['net-b8', t3]);
	await world.clock.advance(1_000);
	const t4 = world.clock.now();
	await runPass(r, { at: t4 });
	assert.equal(world.persisted.length, 2);
	await boot.stop();
	assert.deepEqual(world.persisted.at(-1), ['net-b8', t4], 'stop flushed the latest unpersisted value');
	assert.equal(/** @type {any} */ (findNetwork('net-b8', world.storage)).lastPassAt, t4);

	const cold = makeWorld({ hash: 'net-b8-cold', nodeOpts: { connections: 0 } });
	const coldBoot = await startLeader(cold);
	await runPass(cold.replications[0], { at: cold.clock.now() });
	await coldBoot.stop();
	assert.deepEqual(cold.persisted, [], 'a pass started disconnected is never persisted');
});

test('B9 afterPass: checks the LOCAL copy with a fresh entry; revoked unpairs at once and wipes outside the pass; key-invalid needs two in a row; a check rejection never wipes', async () => {
	const world = makeWorld({ hash: 'net-b9' });
	world.whenIdleThrows = true;
	const boot = await startLeader(world);
	const r = world.replications[0];

	await runPass(r, { at: world.clock.now() });
	assert.equal(world.checks.length, 1);
	assert.equal(world.checks[0].db, world.dbFor('net-b9'), 'the LOCAL handle, never the reader');
	assert.notEqual(world.checks[0].db, world.readers[0]);
	assert.equal(world.checks[0].networkHash, 'net-b9');
	assert.deepEqual(world.checks[0].entry, findNetwork('net-b9', world.storage));
	assert.deepEqual(world.wipes, []);

	// key-invalid once -> nothing; ok resets; twice in a row -> wipe.
	world.verdicts.push({ ok: false, reason: 'key-invalid' }, { ok: true }, { ok: false, reason: 'key-invalid' }, { ok: true });
	for (let i = 0; i < 4; i += 1) await runPass(r, { at: world.clock.now() });
	assert.deepEqual(world.wipes, [], 'an ok verdict in between resets the count');

	// A PairingCheckUnavailableError never wipes and logs the name only.
	const logsBefore = CONSOLE_ERRORS.length;
	world.verdicts.push(new pairing.PairingCheckUnavailableError('revocation'));
	await runPass(r, { at: world.clock.now() });
	assert.deepEqual(world.wipes, []);
	assert.deepEqual(CONSOLE_ERRORS.slice(logsBefore), [['peer/boot:', 'PairingCheckUnavailableError']]);

	world.verdicts.push({ ok: false, reason: 'key-invalid' }, { ok: false, reason: 'key-invalid' });
	await runPass(r, { at: world.clock.now() });
	assert.deepEqual(world.wipes, [], 'one key-invalid does not wipe (a rejected check neither counts nor resets)');
	/** @type {string[]} */
	const reasons = [];
	boot.onUnpaired((reason) => reasons.push(reason));
	/** @type {() => void} */
	let openWipe = () => undefined;
	world.wipeGate = new Promise((resolve) => {
		openWipe = () => resolve(undefined);
	});
	await runPass(r, { at: world.clock.now() });
	assert.deepEqual(world.wipes.map((/** @type {any} */ w) => w.reason), ['key-invalid'], 'two consecutive key-invalid verdicts wipe');
	assert.equal(boot.getStatus().kind, 'unpaired');
	assert.equal(reasons.length, 0, 'onUnpaired waits for the wipe');
	openWipe();
	await ticks();
	assert.deepEqual(reasons, ['key-invalid']);
	assert.equal(r.whenIdleCalls, 0, 'whenIdle was never called');

	// revoked: unpaired at once, afterPass resolves while the wipe is pending.
	const rev = makeWorld({ hash: 'net-b9-rev' });
	rev.whenIdleThrows = true;
	const revBoot = await startLeader(rev);
	/** @type {string[]} */
	const revReasons = [];
	revBoot.onUnpaired((reason) => revReasons.push(reason));
	/** @type {() => void} */
	let openRevWipe = () => undefined;
	rev.wipeGate = new Promise((resolve) => {
		openRevWipe = () => resolve(undefined);
	});
	rev.verdicts.push({ ok: false, reason: 'revoked' });
	await runPass(rev.replications[0], { at: rev.clock.now() });
	assert.equal(revBoot.getStatus().kind, 'unpaired');
	assert.equal(revBoot.getStatus().reason, 'revoked');
	assert.deepEqual(rev.wipes.map((/** @type {any} */ w) => [w.networkHash, w.reason]), [['net-b9-rev', 'revoked']]);
	assert.deepEqual(revReasons, [], 'afterPass resolved while the wipe is still pending');
	openRevWipe();
	await ticks();
	assert.deepEqual(revReasons, ['revoked']);
	assert.equal(rev.replications[0].whenIdleCalls, 0);
	assert.equal(rev.replications[0].stops, 1, 'the boot is stopped after the wipe');
});

test('B10 cadre:removed unpairs, wipes and calls onUnpaired; later node events change nothing', async () => {
	const world = makeWorld({ hash: 'net-b10' });
	const boot = await startLeader(world);
	/** @type {string[]} */
	const reasons = [];
	boot.onUnpaired((r) => reasons.push(r));
	world.nodes[0].emit('cadre:removed', {});
	await ticks();
	assert.equal(boot.getStatus().kind, 'unpaired');
	assert.equal(boot.getStatus().reason, 'removed');
	assert.deepEqual(world.wipes.map((/** @type {any} */ w) => w.reason), ['removed']);
	assert.deepEqual(reasons, ['removed']);
	const view = boot.getStatus();
	world.nodes[0].emit('control:connected');
	world.nodes[0].emit('cadre:removed', {});
	await world.clock.advance(60_000);
	assert.equal(boot.getStatus(), view, 'unpaired is terminal');
	assert.equal(world.wipes.length, 1);
});

test('B11 boot-time check: runs after the node lock and before createMemberNode when lastPassAt is numeric; revoked wipes without a node; absent lastPassAt runs no check', async () => {
	const world = makeWorld({ hash: 'net-b11', entryOverrides: { lastPassAt: T0 - 60_000 } });
	const boot = await startLeader(world);
	const iLock = world.log.indexOf('lock:vt-dashboard-node-net-b11');
	const iCheck = world.log.indexOf('check');
	const iCreate = world.log.indexOf('createMemberNode');
	assert.ok(iLock >= 0 && iCheck > iLock && iCreate > iCheck, `order: ${world.log.join(', ')}`);
	assert.equal(world.checks[0].db, world.dbFor('net-b11'));
	await boot.stop();

	const rev = makeWorld({ hash: 'net-b11-rev', entryOverrides: { lastPassAt: T0 - 60_000 } });
	rev.verdicts.push({ ok: false, reason: 'revoked' });
	const revBoot = await startLeader(rev);
	assert.deepEqual(rev.wipes.map((/** @type {any} */ w) => w.reason), ['revoked']);
	assert.ok(!rev.log.includes('createMemberNode'), 'no node was created');
	assert.equal(revBoot.getStatus().kind, 'unpaired');

	const none = makeWorld({ hash: 'net-b11-none' });
	const noneBoot = await startLeader(none);
	assert.ok(none.log.indexOf('createMemberNode') >= 0);
	assert.equal(none.log.indexOf('check'), -1, 'no boot-time check without a lastPassAt');
	await noneBoot.stop();
});

test('B12 retry and reconnect: a failed resume retries on the 20 s tick; disconnected -> reconnect + wake per tick; connected -> nothing; reconnect() is framed and single-flight; a follower does nothing', async () => {
	let resumeFails = 1;
	const world = makeWorld({
		hash: 'net-b12',
		nodeOpts: {
			resume: () => {
				if (resumeFails > 0) {
					resumeFails -= 1;
					throw new Error(CANARY);
				}
				return 'running';
			},
		},
	});
	const boot = await startLeader(world);
	assert.equal(world.replications.length, 0, 'bring-up stopped at the failed resume');
	assert.equal(world.nodes.length, 1);
	await world.clock.advance(20_000);
	assert.equal(world.nodes[0].resumeCalls, 2, 'resume retried on the tick');
	assert.equal(world.nodes.length, 1, 'the node is not created twice');
	assert.equal(world.replications.length, 1);

	const node = world.nodes[0];
	const r = world.replications[0];
	const wakesBefore = r.wakes;
	await world.clock.advance(20_000);
	assert.equal(node.reconnects, 0, 'connected: no reconnect');
	node.connections = 0;
	node.emit('control:disconnected');
	await world.clock.advance(20_000);
	assert.equal(node.reconnects, 1);
	assert.equal(r.wakes, wakesBefore + 1);
	await world.clock.advance(20_000);
	assert.equal(node.reconnects, 2, 'one reconnect per tick while disconnected');

	/** @type {any[]} */
	const views = [];
	boot.subscribeStatus((v) => views.push(v));
	/** @type {() => void} */
	let openReconnect = () => undefined;
	world.nodeOpts.reconnectGate = new Promise((resolve) => {
		openReconnect = () => resolve(undefined);
	});
	node.reconnects = 0;
	const gated = makeFakeNode(world.log, world.nodeOpts);
	node.reconnect = gated.reconnect;
	const first = boot.reconnect();
	const second = boot.reconnect();
	await ticks();
	assert.equal(boot.getStatus().reconnecting, true);
	openReconnect();
	await Promise.all([first, second]);
	assert.equal(gated.reconnects, 1, 'two overlapping reconnect() calls cause one member-node reconnect');
	assert.equal(boot.getStatus().reconnecting, false);
	assert.ok(views.some((v) => v.reconnecting === true));
	await boot.stop();

	const followerWorld = makeWorld({ hash: 'net-b12-f' });
	followerWorld.innerLocks.request(nodeLockName('net-b12-f'), () => new Promise(() => undefined));
	await ticks();
	const follower = await startLeader(followerWorld);
	await follower.reconnect();
	assert.equal(follower.getStatus().reconnecting, false);
	assert.deepEqual(followerWorld.nodes, []);
	await follower.stop();
});

test('B13 teardown: fixed order, rejecting legs do not block, second stop is a no-op, silent after stop, lock free, stop during a pending resume, runtime unregistered', async () => {
	const world = makeWorld({ hash: 'net-b13', nodeOpts: { stopRejects: true }, readerOpts: { closeRejects: true } });
	world.replicationStopRejects = true;
	const boot = await startLeader(world);
	assert.equal(world.tabScope.runtimes.get('net-b13')?.size, 1);
	/** @type {any[]} */
	const statusEvents = [];
	/** @type {any[]} */
	const dataEvents = [];
	boot.subscribeStatus((v) => statusEvents.push(v));
	boot.subscribeData((v) => dataEvents.push(v));
	const before = world.log.length;
	await boot.stop();
	assert.deepEqual(world.log.slice(before), ['replication.stop:net-b13', 'reader.close', 'node.stop', 'closeNetworkDb:local-db-net-b13']);
	const afterFirst = world.log.length;
	await boot.stop();
	assert.equal(world.log.length, afterFirst, 'a second stop makes no calls');
	await runPass(world.replications[0], { at: world.clock.now(), changedTables: ['Election'] });
	world.nodes[0].emit('control:disconnected');
	await world.clock.advance(30_000);
	assert.deepEqual(statusEvents, []);
	assert.deepEqual(dataEvents, []);
	assert.equal(world.clock.count(), 0, 'both ticks cleared');
	assert.equal(await world.innerLocks.request(nodeLockName('net-b13'), { ifAvailable: true }, (/** @type {any} */ l) => l !== null), true, 'the node lock is free');
	assert.equal(world.tabScope.runtimes.has('net-b13'), false, 'runtime unregistered');
	assert.equal(world.tabScope.active.boot, null);

	/** @type {() => void} */
	let openResume = () => undefined;
	const gate = new Promise((resolve) => {
		openResume = () => resolve(undefined);
	});
	const pending = makeWorld({
		hash: 'net-b13-pending',
		nodeOpts: {
			resume: async () => {
				await gate;
				return 'running';
			},
		},
	});
	const pboot = await startLeader(pending);
	assert.equal(pending.nodes.length, 1);
	let stopped = false;
	const stopping = pboot.stop().then(() => {
		stopped = true;
	});
	await ticks();
	assert.equal(stopped, false, 'stop waits for the pending resume');
	openResume();
	await stopping;
	assert.equal(pending.nodes[0].stops, 1, 'the node created in the bring-up was stopped');
	assert.ok(!pending.log.includes('waitForStrand'), 'the bring-up unwound');
});

test('B14 D-19: a new boot (or switchDashboardBoot) waits for the old replication stop before it opens its store; the old boot is silent after', async () => {
	const storage = makeFakeStorage();
	upsertNetwork(pairedEntry('net-b14-a'), storage);
	upsertNetwork(pairedEntry('net-b14-b'), storage);
	upsertNetwork(pairedEntry('net-b14-c'), storage);
	const world = makeWorld({ hash: 'net-b14-a', storage });
	const a = await startLeader(world);
	/** @type {any[]} */
	const aEvents = [];
	a.subscribeStatus((v) => aEvents.push(v));
	a.subscribeData((v) => aEvents.push(v));
	/** @type {() => void} */
	let openStop = () => undefined;
	world.replicationStopGate = new Promise((resolve) => {
		openStop = () => resolve(undefined);
	});
	const bPending = startDashboardBoot({ networkHash: 'net-b14-b', deps: world.deps });
	await ticks();
	assert.ok(world.log.includes('replication.stop:net-b14-a'), "A's replication stop started");
	assert.ok(!world.log.includes('attach:net-b14-b'), "B does not open its store while A's replication is still stopping");
	world.replicationStopGate = null;
	openStop();
	const b = await bPending;
	await ticks();
	const iStopA = world.log.indexOf('replication.stop:net-b14-a');
	const iAttachB = world.log.indexOf('attach:net-b14-b');
	assert.ok(iStopA >= 0 && iAttachB > iStopA, `A stopped before B opened: ${world.log.join(', ')}`);
	assert.equal(world.tabScope.active.boot, b);
	await runPass(world.replications[0], { at: world.clock.now(), changedTables: ['Election'] });
	assert.deepEqual(aEvents, [], "A's subscribers hear nothing after the switch");

	const c = await switchDashboardBoot(b, { networkHash: 'net-b14-c', deps: world.deps });
	await ticks();
	const iStopB = world.log.indexOf('replication.stop:net-b14-b');
	const iAttachC = world.log.indexOf('attach:net-b14-c');
	assert.ok(iStopB >= 0 && iAttachC > iStopB);
	assert.equal(c.networkHash, 'net-b14-c');
	await c.stop();
});

test('B15 two tabs: the second is a follower (not-live, no node), re-reads on notices, and is promoted when the leader stops', async () => {
	const storage = makeFakeStorage();
	upsertNetwork(pairedEntry('net-b15'), storage);
	const locks = createInTabLockManager();
	const bus = makeBus();
	const clock = makeClock();
	const tab1 = makeWorld({ hash: 'net-b15', storage, locks, bus, clock });
	const tab2 = makeWorld({ hash: 'net-b15', storage, locks, bus, clock });
	const leader = await startLeader(tab1);
	const follower = await startLeader(tab2);
	assert.equal(leader.role, 'leader');
	assert.equal(follower.role, 'follower');
	assert.equal(follower.getStatus().kind, 'not-live');
	assert.deepEqual(tab2.nodes, []);

	/** @type {any[]} */
	const data = [];
	follower.subscribeData((v) => data.push(v));
	for (const listener of tab2.noticeListeners) {
		listener({ table: 'Election', op: 'insert' });
		listener({ table: 'Ballot', op: 'update' });
	}
	await ticks(3);
	assert.equal(data.length, 1, 'notices in one task fold into one bump');
	assert.deepEqual([...data[0].changedTables].sort(), ['Ballot', 'Election']);
	assert.equal(data[0].markEligible, true);

	await leader.stop();
	await ticks();
	assert.equal(follower.role, 'leader');
	assert.equal(follower.getStatus().kind, 'catching-up');
	assert.equal(tab2.nodes.length, 1, 'the promoted tab created its member node');
	assert.equal(tab2.noticeListeners.size, 0, 'the follower subscription was released');
	await follower.stop();
});

test('B16 network-closing: a leader tears down and fires onForgotten; a follower aborts its queued promotion and closes its store; a later grant never creates a node', async () => {
	const storage = makeFakeStorage();
	upsertNetwork(pairedEntry('net-b16'), storage);
	const locks = createInTabLockManager();
	const bus = makeBus();
	const tab1 = makeWorld({ hash: 'net-b16', storage, locks, bus });
	const tab2 = makeWorld({ hash: 'net-b16', storage, locks, bus });
	const leader = await startLeader(tab1);
	const follower = await startLeader(tab2);
	let leaderForgotten = 0;
	let followerForgotten = 0;
	leader.onForgotten(() => (leaderForgotten += 1));
	follower.onForgotten(() => (followerForgotten += 1));
	assert.equal((await locks.query()).pending.length, 1, 'the follower queued for the node lock');

	const sender = new bus.Channel(lifecycleChannelName('net-b16'));
	sender.postMessage({ kind: 'network-closing', reason: 'forgotten' });
	await ticks();
	assert.equal(leaderForgotten, 1);
	assert.equal(followerForgotten, 1);
	assert.equal(tab1.nodes[0].stops, 1, 'the leader stopped its node');
	assert.equal(tab2.dbFor('net-b16').closes, 1, 'the follower closed its store handle');
	assert.deepEqual(await locks.query(), { held: [], pending: [] }, 'no queued promotion remains');
	assert.deepEqual(tab2.nodes, [], 'the follower never created a node');
	sender.close();
	await leader.stop();
	await follower.stop();
});

test('B17 composition with the real wipeNetwork: a revocation stops the boot through its runtime, removes the registry entry and calls onUnpaired once', async () => {
	const world = makeWorld({ hash: 'net-b17' });
	delete world.deps.wipeNetwork;
	/** @type {string[]} */
	const peerCalls = [];
	world.deps.wipeDeps = {
		deleteMemberStorage: async (/** @type {string} */ h) => void peerCalls.push(`member:${h}`),
		memberStorageDbName: (/** @type {string} */ h, /** @type {string} */ s) => `vt-member-${h}-${s}-0000abcd`,
		deleteDeviceKeys: async (/** @type {string} */ h) => void peerCalls.push(`keys:${h}`),
		listDeviceKeyIds: async () => [],
		deviceKeysDbName: 'vt-test-no-keys-db',
		timeoutSignal: () => new AbortController().signal,
	};
	const boot = await startLeader(world);
	/** @type {string[]} */
	const reasons = [];
	boot.onUnpaired((r) => reasons.push(r));
	world.verdicts.push({ ok: false, reason: 'revoked' });
	await runPass(world.replications[0], { at: world.clock.now() });
	for (let i = 0; i < 40 && reasons.length === 0; i += 1) await ticks();
	assert.deepEqual(reasons, ['revoked']);
	assert.equal(findNetwork('net-b17', world.storage), undefined, 'the registry entry is gone');
	assert.equal(world.replications[0].stops, 1, 'replication stopped through the registered runtime');
	assert.equal(world.nodes[0].stops, 1);
	assert.equal(world.dbFor('net-b17').closes, 1);
	assert.deepEqual(peerCalls, ['member:net-b17', 'keys:net-b17']);
	await ticks();
	assert.deepEqual(reasons, ['revoked'], 'onUnpaired called once');
});

test('B18 logs: every console.error of B1-B17 is the fixed prefix and an error name; the canary never appears', async () => {
	const world = makeWorld({ hash: 'net-b18' });
	world.openError = new Error(CANARY);
	const boot = await startLeader(world);
	await boot.stop();
	assert.ok(CONSOLE_ERRORS.length >= 2, `errors were logged (${CONSOLE_ERRORS.length})`);
	for (const args of CONSOLE_ERRORS) {
		assert.equal(args.length, 2, 'prefix and name only');
		assert.equal(args[0], 'peer/boot:');
		assert.match(String(args[1]), /^[A-Za-z]*Error$/);
		for (const arg of args) assert.ok(!String(arg).includes(CANARY), 'a console.error argument leaked the canary');
	}
});

test('B19 source scan: resume and no joinCadre; no whenIdle inside handleAfterPass; no officer-swap import, no StrandChangeHub, no strand reader .db read; no mutation words', () => {
	const source = stripComments(readFileSync(new URL(BOOT_URL), 'utf8'));
	/** @param {string} src @param {string} name */
	const bodyOf = (src, name) => {
		const start = src.indexOf(`async function ${name}(`);
		if (start === -1) return null;
		const open = src.indexOf('{', src.indexOf(')', start));
		let depth = 0;
		for (let i = open; i < src.length; i += 1) {
			if (src[i] === '{') depth += 1;
			else if (src[i] === '}') {
				depth -= 1;
				if (depth === 0) return src.slice(open, i + 1);
			}
		}
		return null;
	};
	const whenIdleRe = new RegExp('when' + 'Idle\\(');
	const joinRe = new RegExp('join' + 'Cadre\\(');
	const swapRe = new RegExp('lifecycle/' + 'officer-swap');
	const hubRe = new RegExp('Strand' + 'ChangeHub');
	const dbReadRe = new RegExp('(strandReader|reader)\\.' + 'db\\b');
	const mutationRe = new RegExp(['insert\\s+into', 'update\\s+\\S+\\s+set', 'delete\\s+from'].map((s) => `\\b${s}\\b`).join('|'), 'i');

	// Positive controls first.
	const fixture = 'async function handleAfterPass(x) { if (a) { await r.when' + 'Idle(); } }';
	assert.match(/** @type {string} */ (bodyOf(fixture, 'handleAfterPass')), whenIdleRe);
	assert.match('m.join' + 'Cadre(code)', joinRe);
	assert.match("import { a } from '../lifecycle/officer" + "-swap.js';", swapRe);
	assert.match('new Strand' + 'ChangeHub()', hubRe);
	assert.match('const d = reader.' + 'db;', dbReadRe);
	assert.match('delete ' + 'from T where 1', mutationRe);

	assert.match(source, /resume\(/);
	assert.doesNotMatch(source, joinRe);
	const body = bodyOf(source, 'handleAfterPass');
	assert.ok(body && body.length > 50, 'handleAfterPass found');
	assert.doesNotMatch(/** @type {string} */ (body), whenIdleRe);
	assert.doesNotMatch(source, swapRe);
	assert.doesNotMatch(source, hubRe);
	assert.doesNotMatch(source, dbReadRe);
	assert.doesNotMatch(source, mutationRe);
	assert.equal(KEY_INVALID_CONFIRM_PASSES, 2);
	assert.equal(STATUS_TICK_MS, 1_000);
	assert.equal(LAST_PASS_PERSIST_MS, 60_000);
});

// ---------------------------------------------------------------------------
// U1-U4: the React bridge (`src/live/useLiveStatus.ts`), run in ONE child
// process with Node's type stripping and a `.js` -> `.ts` resolve hook (the
// mapping the bundler does). Hooks render through `react-dom/server`.
// ---------------------------------------------------------------------------

const LOADER = [
	"import { existsSync } from 'node:fs';",
	"import { fileURLToPath } from 'node:url';",
	'export async function resolve(specifier, context, next) {',
	"\tconst relative = specifier.startsWith('./') || specifier.startsWith('../');",
	"\tconst fromTs = typeof context.parentURL === 'string' && context.parentURL.endsWith('.ts');",
	"\tif (relative && fromTs && specifier.endsWith('.js')) {",
	'\t\tconst jsUrl = new URL(specifier, context.parentURL);',
	'\t\tif (!existsSync(fileURLToPath(jsUrl))) {',
	"\t\t\tconst tsUrl = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);",
	'\t\t\tif (existsSync(fileURLToPath(tsUrl))) return next(tsUrl.href, context);',
	'\t\t}',
	'\t}',
	'\treturn next(specifier, context);',
	'}',
].join('\n');

const REGISTER = [
	"import { register } from 'node:module';",
	`register(${JSON.stringify('data:text/javascript,' + encodeURIComponent(LOADER))});`,
].join('\n');

const BRIDGE_URLS = {
	useLiveStatus: moduleUrl(dashboardSrc('live', 'useLiveStatus.ts')),
	dataVersion: moduleUrl(dashboardSrc('live', 'DataVersionContext.ts')),
};

const HARNESS = [
	`const M = ${JSON.stringify(BRIDGE_URLS)};`,
	'const rows = {};',
	'async function row(name, fn) {',
	'\ttry { rows[name] = await fn(); }',
	"\tcatch (err) { rows[name] = { thrown: { name: (err && err.name) || 'Error', message: String((err && err.message) || '') } }; }",
	'}',
	"const { createElement } = await import('react');",
	"const { renderToStaticMarkup } = await import('react-dom/server');",
	'const live = await import(M.useLiveStatus);',
	'const dv = await import(M.dataVersion);',
	"const view = Object.freeze({ kind: 'offline', lastPassAt: 5, reconnecting: false });",
	"const version = Object.freeze({ version: 3, changedTables: new Set(['Election']), markEligible: true });",
	'const fakeBoot = { getStatus: () => view, subscribeStatus: () => () => undefined, getDataVersion: () => version, subscribeData: () => () => undefined };',
	"await row('selectNull', () => live.selectLiveStatus(null));",
	"await row('selectSameRef', () => live.selectLiveStatus(fakeBoot) === view);",
	"function StatusProbe(props) { const s = live.useLiveStatus(props.boot); return createElement('span', null, s ? s.kind : 'none'); }",
	"await row('statusFake', () => renderToStaticMarkup(createElement(StatusProbe, { boot: fakeBoot })));",
	"await row('statusNull', () => renderToStaticMarkup(createElement(StatusProbe, { boot: null })));",
	"function DataProbe(props) { const v = live.useBootDataVersion(props.boot); return createElement('span', null, [v.version, v.markEligible, [...v.changedTables].join(',')].join('|')); }",
	"await row('dataFake', () => renderToStaticMarkup(createElement(DataProbe, { boot: fakeBoot })));",
	"await row('dataNull', () => renderToStaticMarkup(createElement(DataProbe, { boot: null })));",
	"await row('defaultVersion', () => dv.DEFAULT_DATA_VERSION.version);",
	'process.stdout.write(JSON.stringify(rows));',
].join('\n');

/** @type {Record<string, any> | null} */
let BRIDGE_ROWS = null;

/** @returns {Record<string, any>} */
function bridgeRows() {
	if (BRIDGE_ROWS) return BRIDGE_ROWS;
	const child = spawnSync(
		process.execPath,
		['--experimental-strip-types', '--no-warnings', '--import', 'data:text/javascript,' + encodeURIComponent(REGISTER), '--input-type=module', '-e', HARNESS],
		{ cwd: dashboardRoot(), encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } },
	);
	try {
		BRIDGE_ROWS = JSON.parse(child.stdout || '{}');
	} catch {
		BRIDGE_ROWS = {};
	}
	assert.ok(BRIDGE_ROWS && Object.keys(BRIDGE_ROWS).length > 0, `the harness printed no rows: ${child.stderr}`);
	return /** @type {Record<string, any>} */ (BRIDGE_ROWS);
}

/** @param {string} name */
function bridgeRow(name) {
	const rows = bridgeRows();
	assert.ok(name in rows, `harness produced no row "${name}"`);
	const value = rows[name];
	if (value && typeof value === 'object' && 'thrown' in value) assert.fail(`harness row "${name}" threw ${value.thrown.name}: ${value.thrown.message}`);
	return value;
}

test('U1 selectLiveStatus: null without a boot; the boot\'s own view object by reference', () => {
	assert.equal(bridgeRow('selectNull'), null);
	assert.equal(bridgeRow('selectSameRef'), true);
});

test('U2 useLiveStatus: a server render shows the fake view\'s kind; null renders the null branch', () => {
	assert.equal(bridgeRow('statusFake'), '<span>offline</span>');
	assert.equal(bridgeRow('statusNull'), '<span>none</span>');
});

test('U3 useBootDataVersion: the default (version 0, never marks) without a boot; the boot\'s version, mark flag and tables with one', () => {
	assert.equal(bridgeRow('defaultVersion'), 0);
	assert.equal(bridgeRow('dataNull'), '<span>0|false|</span>');
	assert.equal(bridgeRow('dataFake'), '<span>3|true|Election</span>');
});

test('U4 source: useSyncExternalStore; imports only react and the data-version module; no peer path, console, Date, enum or namespace', () => {
	const raw = readFileSync(new URL(BRIDGE_URLS.useLiveStatus), 'utf8');
	const source = stripComments(raw);
	const specifiers = new Set([...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]));
	assert.deepEqual([...specifiers].sort(), ['./DataVersionContext.js', 'react']);
	assert.match(source, /useSyncExternalStore\(/);
	const peerRe = new RegExp('\\.\\./' + 'peer/');
	assert.match("import x from '../" + "peer/boot.js'", peerRe, 'positive control');
	assert.doesNotMatch(raw, peerRe);
	assert.doesNotMatch(source, /\bconsole\b/);
	assert.doesNotMatch(source, /\bDate\b/);
	assert.doesNotMatch(source, /\benum\b|\bnamespace\b/);
});

// ---------------------------------------------------------------------------
// L1-L2: the lazy peer chunk. Markers are cadre-core protocol-id string
// literals (they survive minification; the quote style may change).
// ---------------------------------------------------------------------------

const MARKER_RE = /["'`]\/sereus\/[a-z][a-z-]*\/1\.0\.0["'`]/g;

/**
 * Split a Vite manifest into the entry's static-import closure and the
 * dynamic-import closure (everything reached through `dynamicImports`, with
 * its own imports, minus the static closure).
 *
 * @param {Record<string, { file: string, isEntry?: boolean, imports?: string[], dynamicImports?: string[], name?: string, src?: string }>} manifest
 */
function manifestClosures(manifest) {
	const entryKey = Object.keys(manifest).find((k) => manifest[k].isEntry);
	assert.ok(entryKey, 'the manifest has an entry');
	/** @type {Set<string>} */
	const staticKeys = new Set();
	/** @param {string} key */
	const walkStatic = (key) => {
		if (staticKeys.has(key) || !manifest[key]) return;
		staticKeys.add(key);
		for (const next of manifest[key].imports ?? []) walkStatic(next);
	};
	walkStatic(/** @type {string} */ (entryKey));
	/** @type {Set<string>} */
	const reached = new Set();
	/** @param {string} key */
	const walkDynamic = (key) => {
		if (reached.has(key) || !manifest[key]) return;
		reached.add(key);
		for (const next of manifest[key].imports ?? []) walkDynamic(next);
		for (const next of manifest[key].dynamicImports ?? []) walkDynamic(next);
	};
	for (const key of Object.keys(manifest)) for (const next of manifest[key].dynamicImports ?? []) walkDynamic(next);
	const dynamicKeys = [...reached].filter((k) => !staticKeys.has(k));
	return { entryKey: /** @type {string} */ (entryKey), staticKeys: [...staticKeys], dynamicKeys };
}

/** @param {string} code */
function markersIn(code) {
	return new Set([...code.matchAll(MARKER_RE)].map((m) => m[0].slice(1, -1)));
}

test('L1 matcher controls: the marker regex hits a minified literal and not a bare prefix; the closure walker separates static and dynamic chunks', () => {
	assert.deepEqual([...markersIn('x="/sereus/cadre-invite/1.0.0",y=`/sereus/seed/1.0.0`')].sort(), ['/sereus/cadre-invite/1.0.0', '/sereus/seed/1.0.0']);
	assert.equal(markersIn('const p = "/sereus/";').size, 0);
	assert.equal(markersIn("'/sereus/Cadre/1.0.0'").size, 0);
	const synthetic = {
		'index.html': { file: 'assets/index.js', isEntry: true, imports: ['_shared.js'], dynamicImports: ['src/peer/boot.js'] },
		'_shared.js': { file: 'assets/shared.js' },
		'src/peer/boot.js': { file: 'assets/peer.js', imports: ['_shared.js', '_lib.js'], dynamicImports: ['_late.js'] },
		'_lib.js': { file: 'assets/lib.js' },
		'_late.js': { file: 'assets/late.js' },
		'_orphan.js': { file: 'assets/orphan.js' },
	};
	const c = manifestClosures(synthetic);
	assert.equal(c.entryKey, 'index.html');
	assert.deepEqual([...c.staticKeys].sort(), ['_shared.js', 'index.html']);
	assert.deepEqual([...c.dynamicKeys].sort(), ['_late.js', '_lib.js', 'src/peer/boot.js']);
});

const DIST = process.env.DASHBOARD_DIST_DIR;

test(
	'L2 dist proof: the entry closure carries no cadre-core marker; the dynamic closure carries at least two; a peer chunk exists outside the entry closure',
	{ skip: DIST ? false : 'DASHBOARD_DIST_DIR is not set' },
	(t) => {
		const dist = /** @type {string} */ (DIST);
		const manifestPath = path.join(dist, '.vite', 'manifest.json');
		assert.ok(existsSync(manifestPath), 'the build wrote .vite/manifest.json');
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
		const { entryKey, staticKeys, dynamicKeys } = manifestClosures(manifest);
		/** @param {string[]} keys */
		const closureMarkers = (keys) => {
			/** @type {Set<string>} */
			const all = new Set();
			for (const key of keys) for (const m of markersIn(readFileSync(path.join(dist, manifest[key].file), 'utf8'))) all.add(m);
			return all;
		};
		const staticMarkers = closureMarkers(staticKeys);
		const dynamicMarkers = closureMarkers(dynamicKeys);
		const staticFiles = new Set(staticKeys.map((k) => manifest[k].file));
		const peerKeys = dynamicKeys.filter((k) => k.startsWith('src/peer/') || manifest[k].name === 'peer');
		const peerFiles = [...new Set(peerKeys.map((k) => manifest[k].file))];
		t.diagnostic(`entry ${entryKey} -> ${manifest[entryKey].file}; static chunks ${staticKeys.length}, dynamic chunks ${dynamicKeys.length}`);
		t.diagnostic(`entry closure markers: ${staticMarkers.size} [${[...staticMarkers].sort().join(', ')}]`);
		t.diagnostic(`dynamic closure markers: ${dynamicMarkers.size} [${[...dynamicMarkers].sort().join(', ')}]`);
		for (const file of peerFiles) t.diagnostic(`peer chunk ${file} ${statSync(path.join(dist, file)).size} bytes`);
		assert.equal(staticMarkers.size, 0, `the entry closure carries cadre-core markers: ${[...staticMarkers].join(', ')}`);
		assert.ok(dynamicMarkers.size >= 2, `the dynamic closure carries fewer than two markers (${dynamicMarkers.size})`);
		assert.ok(peerFiles.length > 0, 'a chunk built from src/peer exists in the dynamic closure');
		for (const file of peerFiles) assert.ok(!staticFiles.has(file), 'the peer chunk is in the entry closure');
	},
);

after(() => {
	console.error = ORIGINAL_CONSOLE_ERROR;
});
