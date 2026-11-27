/**
 * network-index.test.mjs -- 56-29 Part B: a link that names a network but no
 * election lists that network's elections straight from the strand, and
 * creates nothing in the browser.
 *
 * Every collaborator is injected through the same `deps` seam `boot.js` uses,
 * so this runs with no browser, no socket and no IndexedDB.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publicSrc } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';
import {
	listNetworkElections,
	NETWORK_LIST_STATUS,
	NETWORK_LIST_ATTEMPTS,
	NO_PEER_CONNECTED,
} from '../../src/peer/network-index.js';

const HASH = 'abc123def456';

/**
 * @param {{
 *   config?: any,
 *   nodeThrows?: boolean,
 *   handleThrows?: boolean,
 *   noPeer?: boolean,
 *   coordinatorMisses?: number,
 *   results?: Array<'throw' | Array<any>>,
 * }} spec
 */
function makeDeps(spec = {}) {
	const calls = /** @type {string[]} */ ([]);
	const results = [...(spec.results ?? [[{ Id: 'el-1', Title: 'One', Date: '2026-11-01' }]])];
	const deps = {
		async loadBootstrapConfig() {
			calls.push('config');
			return spec.config ?? { ok: true, bootstrapNodes: ['/dns4/relay/tcp/443/wss/p2p/QmRelay'] };
		},
		fetchImpl: async () => ({}),
		pageProtocol: 'https:',
		sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
		async loadOrCreateSessionPeerKey() {
			calls.push('key');
			return { fake: 'key' };
		},
		/** @param {any} opts */
		async createEdgeNode(opts) {
			calls.push(`node:${opts.networkName}`);
			if (spec.nodeThrows) throw Object.assign(new Error('no node'), { name: 'EdgeNodeConfigError' });
			return {
				node: { coordinatedRepo: {} },
				async stop() {
					calls.push('node.stop');
				},
			};
		},
		async waitForFirstConnection() {
			calls.push('wait');
			return { connected: spec.noPeer !== true };
		},
		async openStrandReadHandle() {
			calls.push('handle');
			if (spec.handleThrows) throw Object.assign(new Error('no handle'), { name: 'StrandReadError' });
			if (spec.coordinatorMisses && spec.coordinatorMisses > 0) {
				spec.coordinatorMisses -= 1;
				throw Object.assign(new Error('No coordinator available for key'), { name: 'FindCoordinatorError', code: 'NO_NETWORK_COORDINATOR' });
			}
			return {
				db: {},
				async close() {
					calls.push('handle.close');
				},
			};
		},
		async listPublicElections() {
			calls.push('list');
			const next = results.length > 1 ? results.shift() : results[0];
			if (next === 'throw') throw Object.assign(new Error('row values must not leak'), { name: 'QuereusError' });
			return next;
		},
		sleep: async () => {
			calls.push('sleep');
		},
	};
	return { deps, calls };
}

test('no network: NO_ADDRESS, nothing called', async () => {
	for (const networkHash of [null, undefined, '']) {
		const { deps, calls } = makeDeps();
		const r = await listNetworkElections({ networkHash, deps });
		assert.equal(r.status, NETWORK_LIST_STATUS.NO_ADDRESS);
		assert.deepEqual(r.elections, []);
		assert.deepEqual(calls, []);
	}
});

test('config fault: CONFIG_FAULT, no node is built', async () => {
	const { deps, calls } = makeDeps({ config: { ok: false, fault: 'missing' } });
	const r = await listNetworkElections({ networkHash: HASH, deps });
	assert.equal(r.status, NETWORK_LIST_STATUS.CONFIG_FAULT);
	assert.deepEqual(calls, ['config']);
});

test('happy path: LISTED with each row mapped to { networkHash, electionId, title, date }, on the strand network name, then the handle and the node are released', async () => {
	const { deps, calls } = makeDeps({
		results: [[{ Id: 'el-1', Title: 'One', Date: '2026-11-01' }, { Id: 'el-2', Title: null, Date: '2026-10-01' }]],
	});
	const r = await listNetworkElections({ networkHash: HASH, deps });
	assert.equal(r.status, NETWORK_LIST_STATUS.LISTED);
	assert.deepEqual(r.elections, [
		{ networkHash: HASH, electionId: 'el-1', title: 'One', date: '2026-11-01' },
		{ networkHash: HASH, electionId: 'el-2', title: null, date: '2026-10-01' },
	]);
	assert.ok(calls.some((c) => /^node:strand-/.test(c)), `the node was not built on the strand network: ${calls}`);
	assert.deepEqual(calls.slice(-2), ['handle.close', 'node.stop'], 'release order: handle, then node');
});

test('an empty read is retried; rows on a later attempt are LISTED', async () => {
	const { deps, calls } = makeDeps({ results: [[], [{ Id: 'el-9', Title: 'Nine', Date: '2026-09-09' }]] });
	const r = await listNetworkElections({ networkHash: HASH, deps });
	assert.equal(r.status, NETWORK_LIST_STATUS.LISTED);
	assert.equal(r.elections.length, 1);
	assert.equal(calls.filter((c) => c === 'list').length, 2);
	assert.equal(calls.filter((c) => c === 'sleep').length, 1);
});

test('every attempt empty: LISTED with no elections after exactly NETWORK_LIST_ATTEMPTS reads', async () => {
	const { deps, calls } = makeDeps({ results: [[]] });
	const r = await listNetworkElections({ networkHash: HASH, deps });
	assert.equal(r.status, NETWORK_LIST_STATUS.LISTED);
	assert.deepEqual(r.elections, []);
	assert.equal(calls.filter((c) => c === 'list').length, NETWORK_LIST_ATTEMPTS);
});

test('every attempt throws: FAILED naming only the error name, and everything acquired is released', async () => {
	const { deps, calls } = makeDeps({ results: ['throw'] });
	const r = await listNetworkElections({ networkHash: HASH, deps });
	assert.equal(r.status, NETWORK_LIST_STATUS.FAILED);
	assert.equal(r.errorName, 'QuereusError');
	assert.ok(!JSON.stringify(r).includes('must not leak'), 'an error message reached the result');
	assert.deepEqual(calls.slice(-2), ['handle.close', 'node.stop']);
});

test('a throw then rows: LISTED (a first read can race the coordinator lookup)', async () => {
	const { deps } = makeDeps({ results: ['throw', [{ Id: 'el-1', Title: 'One', Date: '2026-11-01' }]] });
	const r = await listNetworkElections({ networkHash: HASH, deps });
	assert.equal(r.status, NETWORK_LIST_STATUS.LISTED);
	assert.equal(r.elections.length, 1);
});

test('node or handle failure: FAILED, and only what was acquired is released', async () => {
	{
		const { deps, calls } = makeDeps({ nodeThrows: true });
		const r = await listNetworkElections({ networkHash: HASH, deps });
		assert.equal(r.status, NETWORK_LIST_STATUS.FAILED);
		assert.equal(r.errorName, 'EdgeNodeConfigError');
		assert.ok(!calls.includes('node.stop') && !calls.includes('handle.close'));
	}
	{
		const { deps, calls } = makeDeps({ handleThrows: true });
		const r = await listNetworkElections({ networkHash: HASH, deps });
		assert.equal(r.status, NETWORK_LIST_STATUS.FAILED);
		assert.equal(r.errorName, 'StrandReadError');
		assert.ok(calls.includes('node.stop') && !calls.includes('handle.close'));
	}
});

test('rows without a usable Id are dropped; a non-string Title or Date is normalised, never fatal', async () => {
	const { deps } = makeDeps({ results: [[{ Id: '' }, { Title: 'x' }, null, { Id: 'el-3', Title: 7, Date: 5 }]] });
	const r = await listNetworkElections({ networkHash: HASH, deps });
	assert.deepEqual(r.elections, [{ networkHash: HASH, electionId: 'el-3', title: null, date: '' }]);
});

test('never throws on hostile options', async () => {
	for (const opts of [undefined, null, 5, 'x', { networkHash: 7 }, { networkHash: HASH, deps: null }]) {
		await assert.doesNotReject(async () => {
			// `deps: null` falls back to the real modules; with no fetch config in Node it degrades, never throws.
			const r = await listNetworkElections(/** @type {any} */ (opts));
			assert.ok(Object.values(NETWORK_LIST_STATUS).includes(r.status));
		});
	}
});

test('the module creates nothing in the browser: no store opener, no create:true, no web-storage write; it reads through the public listing query', () => {
	const src = stripComments(readFileSync(publicSrc('peer', 'network-index.js'), 'utf8'));
	for (const banned of ['attachLiveDb', 'openStoreHandle', 'createNetworkDb', 'attachNetworkDb', 'upsertNetwork', 'localStorage']) {
		assert.ok(!new RegExp(`\\b${banned}\\b`).test(src), `network-index.js names ${banned}`);
	}
	assert.doesNotMatch(src, /create:\s*true/);
	assert.match(src, /import \{[^}]*\blistPublicElections\b[^}]*\} from '@votetorrent\/web-data\/public'/);
	// Matcher control: the same scan does fire on a planted line.
	assert.ok(/\battachLiveDb\b/.test("import { attachLiveDb } from 'x';"));
});

test('no peer connects in time: FAILED with NoPeerConnected, the strand is never read, the node is released', async () => {
	const { deps, calls } = makeDeps({ noPeer: true });
	const out = await listNetworkElections({ networkHash: HASH, deps });
	assert.equal(out.status, NETWORK_LIST_STATUS.FAILED);
	assert.equal(out.errorName, NO_PEER_CONNECTED);
	assert.deepEqual(out.elections, []);
	assert.ok(!calls.includes('handle') && !calls.includes('list'), `the strand was read with no peer connected: ${calls}`);
	assert.ok(calls.includes('node.stop'), 'the node was not released');
});

test('the wait sits between building the node and opening the strand handle', async () => {
	const { deps, calls } = makeDeps();
	await listNetworkElections({ networkHash: HASH, deps });
	const node = calls.findIndex((c) => c.startsWith('node:'));
	assert.ok(node >= 0 && calls[node + 1] === 'wait' && calls[node + 2] === 'handle', `order: ${calls}`);
});

test('a relay-first network: the strand open is retried past coordinator misses, then the list is read', async () => {
	const { openWhenCoordinatorFound } = await import('../../src/peer/coordinator-wait.js');
	const { deps, calls } = makeDeps({ coordinatorMisses: 2 });
	/** @type {any} */ (deps).openWhenCoordinatorFound = (/** @type {() => Promise<any>} */ open) =>
		openWhenCoordinatorFound(open, { sleep: async () => {} });
	const out = await listNetworkElections({ networkHash: HASH, deps });
	assert.equal(out.status, NETWORK_LIST_STATUS.LISTED);
	assert.equal(out.elections.length, 1);
	assert.equal(calls.filter((c) => c === 'handle').length, 3, `calls: ${calls}`);
});

test('no coordinator within the bound: FAILED with NoCoordinatorError, the list is never read, the node is released', async () => {
	const { openWhenCoordinatorFound } = await import('../../src/peer/coordinator-wait.js');
	const { deps, calls } = makeDeps({ coordinatorMisses: 100 });
	let t = 0;
	/** @type {any} */ (deps).openWhenCoordinatorFound = (/** @type {() => Promise<any>} */ open) =>
		openWhenCoordinatorFound(open, { now: () => t, sleep: async (ms) => void (t += ms) });
	const out = await listNetworkElections({ networkHash: HASH, deps });
	assert.equal(out.status, NETWORK_LIST_STATUS.FAILED);
	assert.equal(out.errorName, 'NoCoordinatorError');
	assert.ok(!calls.includes('list'), `the list was read: ${calls}`);
	assert.ok(calls.includes('node.stop'));
});
