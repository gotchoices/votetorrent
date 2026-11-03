/**
 * peer-boot.test.mjs — behaviour, not source text, over `src/peer/boot.js`'s
 * injected deps: every `PEER_BOOT_STATUS` value is reachable, the bootstrap
 * config fault is propagated unchanged for both `56-06` variants, a missing
 * `coordinatedRepo` attachment throws `PeerBootError` naming it, `stop()` is
 * idempotent and tears down in the fixed order the module promises, and
 * `strandIdForNetwork` is total over the address pattern's character set.
 * Plus the two comment-stripped source assertions the plan's own acceptance
 * criteria name, so the file's own prose cannot satisfy them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	startPublicPeerBoot,
	strandIdForNetwork,
	PEER_BOOT_STATUS,
	PeerBootError,
} from '../../src/peer/boot.js';

const APP_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');

/** Whole-line comment stripper matching this plan's own acceptance-criteria
 * shell command exactly (a line is dropped when, after leading whitespace,
 * its first character is a star or a slash), so a passing test here means
 * the real verify command also passes.
 * @param {string} source
 * @returns {string}
 */
function stripCommentLines(source) {
	return source
		.split('\n')
		.filter((line) => !/^\s*[*/]/.test(line))
		.join('\n');
}

// ---------------------------------------------------------------------------
// Fake dependency factory
// ---------------------------------------------------------------------------

const FAKE_BOOTSTRAP_NODES = Object.freeze(['/dns4/gateway.invalid/tcp/443/tls/ws/p2p/12D3KooWFakePeerIdFakePeerIdFakePeerIdFake']);

/** @typedef {{ calls: string[] }} CallLog */

/**
 * @param {any} [overrides]
 */
function makeFakeDeps(overrides = {}) {
	/** @type {string[]} */
	const calls = [];

	const subscribedTables = overrides.subscribedTables ?? ['TableA', 'TableB'];

	// The strand read handle still needs the node's coordinatedRepo, but boot
	// itself must never read through it: the watch service finds each tail.
	const coordinatedRepoGet = async () => {
		calls.push('coordinatedRepo.get');
		return {};
	};

	/** @type {any} */
	const fakeNode = overrides.omitCoordinatedRepo
		? { peerId: { toString: () => 'FAKE_PEER_ID' } }
		: { peerId: { toString: () => 'FAKE_PEER_ID' }, coordinatedRepo: { get: coordinatedRepoGet } };

	/** @type {{ stop: () => Promise<void>, dbName: string, node: any }} */
	const fakeEdgeNode = {
		node: fakeNode,
		dbName: 'vt-edge-strand-fake-00000000',
		stop: async () => {
			calls.push('edgeNode.stop');
		},
	};

	// A fake `db.schemaManager.getModule('optimystic').module.tables` map,
	// mirroring the shape `resolveCollectionId` reaches into: one entry per
	// subscribed table, keyed `app.<table lowercased>`, each holding a live
	// `{ id, sync }` collection object two levels down
	// (`vtable.collection.collection`). `overrides.missingCollectionTables`
	// simulates a table this strand never instantiated (omit its entry
	// entirely); `sync` records a call, which boot must never make.
	const optimysticTables = new Map();
	for (const table of subscribedTables) {
		if (overrides.missingCollectionTables?.includes(table)) continue;
		optimysticTables.set(`app.${table.toLowerCase()}`, {
			collection: {
				collection: {
					id: `default/${table}`,
					sync: async () => {
						calls.push(`sync:${table}`);
					},
				},
			},
		});
	}
	/** @type {{ close: () => Promise<void>, db: any }} */
	const fakeStrandReadHandle = {
		close: async () => {
			calls.push('strandReadHandle.close');
		},
		db: {
			schemaManager: {
				getModule: (/** @type {string} */ name) => (name === 'optimystic' ? { module: { tables: optimysticTables } } : undefined),
			},
		},
	};

	const fakeUiDb = { marker: 'fake-ui-db' };

	/** @type {any[]} */
	const replicationHandles = [];
	const fakeTails = { readTails: async () => new Map() };
	const fakeReadRows = async () => [];

	/** @type {any} */
	const deps = {
		loadBootstrapConfig: async () => overrides.configResult ?? { ok: true, bootstrapNodes: FAKE_BOOTSTRAP_NODES },
		loadOrCreateSessionPeerKey: async () => ({ marker: 'fake-private-key' }),
		createEdgeNode: /** @param {any} config */ async (config) => {
			calls.push('createEdgeNode');
			assert.equal(config.networkName, `strand-${config.strandId}`, 'the Edge node must be built on the strand\'s network name (strand-<strandId>), the name every strand node and the strand read handle use');
			return fakeEdgeNode;
		},
		openStrandReadHandle: async () => {
			calls.push('openStrandReadHandle');
			return fakeStrandReadHandle;
		},
		createStrandRowSource: () => ({ readRows: fakeReadRows }),
		createPageTailReader: /** @param {any} node @param {string} networkName */ (node, networkName) => {
			calls.push(`createPageTailReader:${networkName}`);
			assert.equal(node, fakeNode, 'the tail reader must be built over the Edge node boot created');
			return fakeTails;
		},
		openUiHandleForNetwork: async () => {
			calls.push('openUiHandleForNetwork');
			return fakeUiDb;
		},
		closeNetworkDb: async () => {
			calls.push('closeNetworkDb');
		},
		startPeerReplication: /** @param {any} options */ (options) => {
			assert.equal(options.db, fakeUiDb, 'replication writes into the ui handle boot opened');
			assert.equal(options.node, fakeNode);
			assert.equal(options.tails, fakeTails, 'every watch shares the ONE tail reader boot built');
			assert.equal(options.readRows, fakeReadRows, 'the SAME readRows closure serves every table');
			calls.push(`startPeerReplication:${options.collections.map((/** @type {any} */ c) => `${c.table}=${c.collectionId}`).join(',')}`);
			const handle = {
				stop: async () => {
					calls.push('replication.stop');
				},
			};
			replicationHandles.push(handle);
			return handle;
		},
		subscribedTables,
	};

	return { deps, calls, fakeNode, fakeEdgeNode, fakeStrandReadHandle, fakeUiDb, replicationHandles };
}

// ---------------------------------------------------------------------------
// NO_ADDRESS
// ---------------------------------------------------------------------------

test('NO_ADDRESS: an empty/null/undefined networkHash short-circuits before any dep is called', async () => {
	for (const bad of ['', null, undefined]) {
		const { deps, calls } = makeFakeDeps();
		const result = await startPublicPeerBoot({ networkHash: bad, deps });
		assert.equal(result.status, PEER_BOOT_STATUS.NO_ADDRESS);
		assert.deepEqual(calls, [], `no dep may be called for networkHash=${JSON.stringify(bad)}`);
	}
});

// ---------------------------------------------------------------------------
// CONFIG_FAULT
// ---------------------------------------------------------------------------

test('CONFIG_FAULT: the "missing" variant is propagated unchanged, verbatim', async () => {
	const { deps } = makeFakeDeps({ configResult: { ok: false, fault: 'missing', reason: 'fetch failed: boom' } });
	const result = await startPublicPeerBoot({ networkHash: 'nh-1', deps });
	assert.equal(result.status, PEER_BOOT_STATUS.CONFIG_FAULT);
	assert.equal(result.fault, 'missing');
});

test('CONFIG_FAULT: the "malformed" variant is propagated unchanged, verbatim', async () => {
	const { deps } = makeFakeDeps({ configResult: { ok: false, fault: 'malformed', reason: 'bootstrapNodes is empty' } });
	const result = await startPublicPeerBoot({ networkHash: 'nh-1', deps });
	assert.equal(result.status, PEER_BOOT_STATUS.CONFIG_FAULT);
	assert.equal(result.fault, 'malformed');
});

// ---------------------------------------------------------------------------
// STARTED — the full happy path
// ---------------------------------------------------------------------------

test('STARTED: one replication watches every subscribed table by its collection id, over one tail reader and the SAME readRows closure', async () => {
	const { deps, calls } = makeFakeDeps({ subscribedTables: ['TableA', 'TableB', 'TableC'] });
	const result = await startPublicPeerBoot({ networkHash: 'nh-1', electionId: 'el-1', deps });

	assert.equal(result.status, PEER_BOOT_STATUS.STARTED);
	assert.equal(result.peerId, 'FAKE_PEER_ID');
	assert.equal(result.dbName, 'vt-edge-strand-fake-00000000');
	assert.equal(typeof result.stop, 'function');

	assert.deepEqual(
		calls.filter((c) => c.startsWith('startPeerReplication:')),
		['startPeerReplication:TableA=default/app/TableA,TableB=default/app/TableB,TableC=default/app/TableC'],
		'one replication, one watched collection per table, keyed by the plugin\'s default collection URI (tree://default/app/<Table>)',
	);
	assert.deepEqual(calls.filter((c) => c.startsWith('createPageTailReader:')), ['createPageTailReader:strand-nh-1'], 'one tail reader, over the network the node was built for');
});

test('STARTED: boot neither syncs a collection nor reads a header block -- a table that has never committed does not fail the page', async () => {
	const { deps, calls } = makeFakeDeps({ subscribedTables: ['TableA', 'TableB'] });
	const result = await startPublicPeerBoot({ networkHash: 'nh-1', deps });
	assert.equal(result.status, PEER_BOOT_STATUS.STARTED);
	assert.deepEqual(calls.filter((c) => c.startsWith('sync:') || c === 'coordinatedRepo.get'), []);
});

test('STARTED: a missing coordinatedRepo attachment on the constructed node is FAILED, naming "coordinatedRepo"', async () => {
	const { deps } = makeFakeDeps({ omitCoordinatedRepo: true });
	const result = await startPublicPeerBoot({ networkHash: 'nh-1', deps });
	assert.equal(result.status, PEER_BOOT_STATUS.FAILED);
	assert.equal(result.subject, 'coordinatedRepo');
});

test('STARTED: a table the strand read handle has not instantiated yet does not fail boot -- the collection id is computed, not looked up (mesh-read gate 2026-11-03, subject Election)', async () => {
	const { deps, calls } = makeFakeDeps({
		subscribedTables: ['TableA', 'TableB'],
		missingCollectionTables: ['TableA', 'TableB'],
	});
	const result = await startPublicPeerBoot({ networkHash: 'nh-1', deps });
	assert.equal(result.status, PEER_BOOT_STATUS.STARTED);
	assert.deepEqual(calls.filter((c) => c.startsWith('startPeerReplication:')), ['startPeerReplication:TableA=default/app/TableA,TableB=default/app/TableB']);
});

test('a thrown PeerBootError\'s own subject survives to the FAILED result unchanged', async () => {
	const { deps } = makeFakeDeps();
	deps.createEdgeNode = async () => {
		throw new PeerBootError('bootstrapNodes', 'synthetic failure for this test');
	};
	const result = await startPublicPeerBoot({ networkHash: 'nh-1', deps });
	assert.equal(result.status, PEER_BOOT_STATUS.FAILED);
	assert.equal(result.subject, 'bootstrapNodes');
});

// ---------------------------------------------------------------------------
// stop() — idempotent, fixed teardown order
// ---------------------------------------------------------------------------

test('stop() tears down the replication, then the strand-read handle, then the Edge node, then the ui db -- and is idempotent', async () => {
	const { deps, calls } = makeFakeDeps({ subscribedTables: ['TableA', 'TableB'] });
	const result = await startPublicPeerBoot({ networkHash: 'nh-1', deps });
	assert.equal(result.status, PEER_BOOT_STATUS.STARTED);

	calls.length = 0; // only care about stop()'s own call order from here
	await result.stop();
	assert.deepEqual(calls, ['replication.stop', 'strandReadHandle.close', 'edgeNode.stop', 'closeNetworkDb']);

	calls.length = 0;
	await result.stop(); // idempotent: second call does nothing
	assert.deepEqual(calls, []);
});

test('stop() swallows a throwing teardown leg and still runs the rest', async () => {
	const { deps, calls } = makeFakeDeps({ subscribedTables: ['TableA'] });
	const result = await startPublicPeerBoot({ networkHash: 'nh-1', deps });
	assert.equal(result.status, PEER_BOOT_STATUS.STARTED);

	// Monkey-patch one of the fakes' close/stop to throw, after boot already
	// captured references to them.
	deps.closeNetworkDb = async () => {
		throw new Error('closeNetworkDb boom');
	};

	calls.length = 0;
	await assert.doesNotReject(result.stop());
	assert.ok(calls.includes('edgeNode.stop'), 'later teardown legs still ran despite the earlier throw');
});

// ---------------------------------------------------------------------------
// strandIdForNetwork — re-exported, total over the address pattern's charset
// ---------------------------------------------------------------------------

test('strandIdForNetwork is total (identity) over every character the address pattern allows', () => {
	const sample = 'Az09_-' + 'a'.repeat(120);
	assert.equal(strandIdForNetwork(sample), sample);
});

// ---------------------------------------------------------------------------
// Source assertions (comment-stripped) — the plan's own acceptance criteria
// ---------------------------------------------------------------------------

test('src/peer/boot.js contains zero references to test/fixtures (comment-stripped)', () => {
	const source = readFileSync(path.join(APP_ROOT, 'src', 'peer', 'boot.js'), 'utf8');
	const stripped = stripCommentLines(source);
	assert.equal((stripped.match(/test\/fixtures/g) ?? []).length, 0);
});

test('src/peer/boot.js contains zero references to the persisted browser-key helper 56-05 forbids (comment-stripped)', () => {
	const source = readFileSync(path.join(APP_ROOT, 'src', 'peer', 'boot.js'), 'utf8');
	const stripped = stripCommentLines(source);
	assert.equal((stripped.match(/loadOrCreateBrowserPeerKey/g) ?? []).length, 0);
});

test('src/peer/boot.js contains exactly one occurrence of attachNetworkDb, and zero of openStoreHandle / new Database (comment-stripped)', () => {
	const source = readFileSync(path.join(APP_ROOT, 'src', 'peer', 'boot.js'), 'utf8');
	const stripped = stripCommentLines(source);
	const attachLines = stripped.split('\n').filter((line) => line.includes('attachNetworkDb'));
	assert.equal(attachLines.length, 1);
	assert.equal((stripped.match(/openStoreHandle/g) ?? []).length, 0);
	assert.equal((stripped.match(/new Database/g) ?? []).length, 0);
});

// 56-14 MOVED the one production `startPublicPeerBoot` call site out of
// `src/main.tsx` and into `src/screens/PublicApp.tsx` -- a boot whose result
// lives outside React can never reach a component, and `PublicApp.tsx` is the
// first plan that needs the result (the connection predicate's second
// conjunct). This is the superseding pair of assertions `56-14-PLAN.md`'s own
// `<interface_contract>` §4 names: the zero-count below on `main.tsx`, and the
// exactly-one-count on `PublicApp.tsx` that replaces the retired assertion.
test('src/main.tsx no longer names startPublicPeerBoot anywhere, and still mounts PublicApp with no props', () => {
	const source = readFileSync(path.join(APP_ROOT, 'src', 'main.tsx'), 'utf8');
	assert.equal((source.match(/startPublicPeerBoot/g) ?? []).length, 0, '56-14 moved the call into PublicApp.tsx; main.tsx must name it nowhere');
	assert.match(source, /<PublicApp \/>/, 'main.tsx still mounts the root element 56-12 left it mounting');
});

test('src/screens/PublicApp.tsx names startPublicPeerBoot exactly once (the aliased import, same discipline main.tsx used before this move), calls the peer boot with no election prop, and no third file under src/ names the export at all', () => {
	const source = readFileSync(path.join(APP_ROOT, 'src', 'screens', 'PublicApp.tsx'), 'utf8');
	const occurrences = (source.match(/startPublicPeerBoot/g) ?? []).length;
	assert.equal(occurrences, 1, 'exactly one whole-file occurrence, satisfied by the aliased import line');
	assert.match(source, /import \{ startPublicPeerBoot as \w+, PEER_BOOT_STATUS \} from '\.\.\/peer\/boot\.js';/, 'the one occurrence must be the aliased import line, not a call or a prose restatement');
	assert.equal((source.match(/election=\{/g) ?? []).length, 0);

	/** @param {string} dir @returns {string[]} */
	function walkAll(dir) {
		/** @type {string[]} */
		const out = [];
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) out.push(...walkAll(full));
			else out.push(full);
		}
		return out;
	}
	const srcRoot = path.join(APP_ROOT, 'src');
	const thirdFileOffenders = walkAll(srcRoot).filter((file) => {
		if (file === path.join(APP_ROOT, 'src', 'screens', 'PublicApp.tsx')) return false;
		if (file === path.join(APP_ROOT, 'src', 'peer', 'boot.js')) return false;
		return /startPublicPeerBoot/.test(readFileSync(file, 'utf8'));
	});
	assert.deepEqual(thirdFileOffenders, [], `a third file under src/ names startPublicPeerBoot: ${thirdFileOffenders.join(', ')}`);
});
