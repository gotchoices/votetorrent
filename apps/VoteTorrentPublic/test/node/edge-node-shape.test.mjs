/**
 * edge-node-shape.test.mjs — asserts the constructed `NodeOptions` carry the
 * browser Edge shape and are ABSENT the RN non-carries `edge-node.js`'s
 * header enumerates.
 *
 * These absence assertions are the point of this file: they are what turns
 * "do not copy the RN provider's options" from a comment into something
 * that goes red on a copy-paste regression. `createEdgeNode` takes an
 * injectable dependency bag precisely so this file never boots a real
 * libp2p node or touches IndexedDB — Task 3
 * (`strand-storage-isolation.test.mjs`) owns the real-storage proof.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mayServeAsReactivityForwarder } from '@optimystic/db-core';
import { connectionLifecycleSnapshot } from '../../src/peer/connection-lifecycle-probe.js';
import {
	strandStorageDbName,
	createEdgeNode,
	EdgeNodeConfigError,
	PUBLIC_COHORT_MIN_SIGS,
	storageServiceProtocols,
	EDGE_READER_PROTOCOL,
	EDGE_DECLARATION_GATED_CHECKS,
	edgeDeclarationGate,
} from '../../src/peer/edge-node.js';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// strandStorageDbName
// ---------------------------------------------------------------------------

test('strandStorageDbName returns different names for two different strandIds', () => {
	const a = strandStorageDbName('strand-aaaa1111bbbb2222cccc3333dddd4444');
	const b = strandStorageDbName('strand-eeee5555ffff6666aaaa7777bbbb8888');
	assert.notStrictEqual(a, b);
});

test('strandStorageDbName never returns the package default "optimystic", for any input, including the empty string, which throws instead', () => {
	assert.throws(() => strandStorageDbName(''), EdgeNodeConfigError);
	const shaped = strandStorageDbName('strand-aaaa1111bbbb2222cccc3333dddd4444');
	assert.notStrictEqual(shaped, 'optimystic');
});

test('strandStorageDbName fails closed on an empty, whitespace-only, null or undefined id', () => {
	assert.throws(() => strandStorageDbName(''), EdgeNodeConfigError);
	assert.throws(() => strandStorageDbName('   '), EdgeNodeConfigError);
	assert.throws(() => strandStorageDbName(null), EdgeNodeConfigError);
	assert.throws(() => strandStorageDbName(undefined), EdgeNodeConfigError);
});

test('strandStorageDbName sanitises to [A-Za-z0-9_-] only, and two ids differing only in characters that sanitise to "_" still produce different names', () => {
	const nameA = strandStorageDbName('strand!aaaa1111bbbb2222cccc3333dddd');
	const nameB = strandStorageDbName('strand@aaaa1111bbbb2222cccc3333dddd');
	assert.match(nameA, /^[A-Za-z0-9_-]+$/);
	assert.match(nameB, /^[A-Za-z0-9_-]+$/);
	assert.notStrictEqual(nameA, nameB);
});

// ---------------------------------------------------------------------------
// createEdgeNode
// ---------------------------------------------------------------------------

/**
 * Builds a fresh set of fake dependencies for one test. Fresh per test so
 * call counts never leak across tests.
 * @param {{ createLibp2pNodeImpl?: (options: unknown) => Promise<unknown> }} [overrides]
 */
function makeFakeDeps(overrides = {}) {
	/** @type {unknown[]} */
	const createLibp2pNodeCalls = [];
	const stubStorage = {};
	const stubDb = { closeCalls: 0, close() { stubDb.closeCalls += 1; } };
	/** @type {Array<{ name: string, fn: (evt: any) => void }>} */
	const addEventListenerCalls = [];
	const stubNode = {
		stopCalls: 0,
		async stop() { stubNode.stopCalls += 1; },
		/** @type {string[][]} */
		unhandleCalls: [],
		async unhandle(/** @type {string[]} */ protocols) { stubNode.unhandleCalls.push(protocols); stubNode.order.push('unhandle'); },
		/** @type {string[]} */
		order: [],
		/** @type {Array<{ protocol: string, handler: (stream: any) => void }>} */
		handleCalls: [],
		async handle(/** @type {string} */ protocol, /** @type {(stream: any) => void} */ handler) {
			stubNode.handleCalls.push({ protocol, handler });
			stubNode.order.push(`handle:${protocol}`);
		},
		// 56-24: real `attachConnectionLifecycleTap` (imported by edge-node.js
		// directly, never injected) is exercised against THIS fake node rather
		// than mocked out -- `addEventListenerCalls` lets a test assert the tap
		// actually registered listeners, and `connectionLifecycleSnapshot`
		// (imported separately below) is the honest way to prove attach ran at
		// all, since a node lacking `addEventListener` entirely would also
		// resolve without throwing (see the 'no addEventListener' probe case).
		addEventListener(/** @type {string} */ name, /** @type {(evt: any) => void} */ fn) {
			addEventListenerCalls.push({ name, fn });
		},
	};

	const defaultImpl = async () => stubNode;

	const fakeCreateLibp2pNode = overrides.createLibp2pNodeImpl ?? defaultImpl;
	/** @type {import('../../src/peer/edge-node.js').CreateEdgeNodeDeps['createLibp2pNode']} */
	const recordingCreateLibp2pNode = /** @type {any} */ (async (/** @type {unknown} */ options) => {
		createLibp2pNodeCalls.push(options);
		return fakeCreateLibp2pNode(options);
	});

	const websocketsSentinel = { sentinel: 'webSockets' };
	/** @type {import('../../src/peer/edge-node.js').CreateEdgeNodeDeps['webSockets']} */
	const fakeWebSockets = /** @type {any} */ (() => websocketsSentinel);

	// 56-25: the circuit-relay DIALER. Without it a strand node reachable only
	// through a relay reservation cannot be dialed (edge-circuit-dial.test.mjs).
	const circuitSentinel = { sentinel: 'circuitRelayTransport' };
	/** @type {import('../../src/peer/edge-node.js').CreateEdgeNodeDeps['circuitRelayTransport']} */
	const fakeCircuitRelayTransport = /** @type {any} */ (() => circuitSentinel);

	/** @type {import('../../src/peer/edge-node.js').CreateEdgeNodeDeps['openStrandBlockStorage']} */
	const fakeOpenStrandBlockStorage = /** @type {any} */ (async (/** @type {unknown} */ strandId) => ({
		dbName: strandStorageDbName(strandId),
		db: stubDb,
		storage: stubStorage,
	}));

	return {
		deps: {
			createLibp2pNode: recordingCreateLibp2pNode,
			webSockets: fakeWebSockets,
			circuitRelayTransport: fakeCircuitRelayTransport,
			openStrandBlockStorage: fakeOpenStrandBlockStorage,
		},
		createLibp2pNodeCalls,
		stubStorage,
		stubDb,
		stubNode,
		websocketsSentinel,
		circuitSentinel,
		addEventListenerCalls,
	};
}

const VALID_STRAND_ID = 'strand-aaaa1111bbbb2222cccc3333dddd4444';

test('createEdgeNode with an empty bootstrapNodes array rejects with EdgeNodeConfigError and does not call the injected createLibp2pNode', async () => {
	const { deps, createLibp2pNodeCalls } = makeFakeDeps();
	const injectedPrivateKey = { publicKey: { raw: new Uint8Array([1, 2, 3]) } };

	await assert.rejects(
		() =>
			createEdgeNode(
				{
					strandId: VALID_STRAND_ID,
					networkName: 'test-network',
					bootstrapNodes: [],
					privateKey: /** @type {any} */ (injectedPrivateKey),
				},
				deps,
			),
		EdgeNodeConfigError,
	);
	assert.strictEqual(createLibp2pNodeCalls.length, 0);
});

test('createEdgeNode with a valid config calls the injected createLibp2pNode exactly once, with the Edge shape and none of the RN non-carries', async () => {
	const { deps, createLibp2pNodeCalls, stubStorage, websocketsSentinel, circuitSentinel } = makeFakeDeps();
	const injectedPrivateKey = { publicKey: { raw: new Uint8Array([9, 9, 9]) } };
	const injectedBootstrapNodes = ['/dns4/gateway.example/tcp/443/wss/p2p/12D3KooWExample'];

	const handle = await createEdgeNode(
		{
			strandId: VALID_STRAND_ID,
			networkName: 'test-network',
			bootstrapNodes: injectedBootstrapNodes,
			privateKey: /** @type {any} */ (injectedPrivateKey),
		},
		deps,
	);

	assert.strictEqual(createLibp2pNodeCalls.length, 1);
	const options = /** @type {Record<string, unknown>} */ (createLibp2pNodeCalls[0]);

	// The twelve conditions, asserted individually so a single wrong field
	// names itself in the failure output.
	assert.strictEqual(/** @type {unknown[]} */ (options.transports).length, 2);
	assert.strictEqual(/** @type {unknown[]} */ (options.transports)[0], websocketsSentinel);
	assert.strictEqual(/** @type {unknown[]} */ (options.transports)[1], circuitSentinel);
	assert.strictEqual(options.fretProfile, 'edge');
	assert.strictEqual(options.privateKey, injectedPrivateKey);
	assert.deepStrictEqual(options.bootstrapNodes, injectedBootstrapNodes);
	assert.strictEqual(options.networkName, 'test-network');
	assert.strictEqual(options.storage, stubStorage);
	assert.strictEqual(/** @type {any} */ (options.storage).provider, undefined);
	assert.strictEqual('profile' in options, false);
	assert.strictEqual('requireSignedSchemas' in options, false);
	assert.strictEqual('strandFilter' in options, false);
	assert.strictEqual('relay' in options, false);
	assert.strictEqual('listenAddrs' in options, false);
	assert.strictEqual('hibernation' in options, false);

	// -- cohortTopic: subscriber-only posture (56-17) -----------------------
	// Each bullet in the plan's <behavior> asserted on its own line so a
	// single wrong field names itself.
	const cohortTopic = /** @type {any} */ (options.cohortTopic);
	assert.strictEqual(cohortTopic.enabled, true);
	assert.strictEqual(cohortTopic.host.profile.kind, 'edge');
	assert.strictEqual(cohortTopic.host.profile.willingTiers.size, 0);
	assert.strictEqual(cohortTopic.host.minSigs, PUBLIC_COHORT_MIN_SIGS);
	assert.strictEqual(PUBLIC_COHORT_MIN_SIGS, 1);
	assert.strictEqual('wantK' in cohortTopic, false);
	// The forwarder-forbidden PROPERTY the empty tier set exists to produce,
	// not only the field.
	assert.strictEqual(mayServeAsReactivityForwarder(cohortTopic.host.profile), false);

	assert.ok(handle.node);
	assert.strictEqual(typeof handle.dbName, 'string');
	assert.strictEqual(typeof handle.stop, 'function');

	await handle.stop();
});

// ---------------------------------------------------------------------------
// 56-24: the connection-lifecycle tap is attached, and the options object it
// is attached BESIDE is unchanged by that attachment.
// ---------------------------------------------------------------------------

test('createEdgeNode attaches the connection-lifecycle tap to the constructed node exactly once, with the caller\'s own bootstrapNodes, and the constructed options object is otherwise unchanged', async () => {
	const { deps, createLibp2pNodeCalls, addEventListenerCalls, stubNode } = makeFakeDeps();
	const injectedPrivateKey = { publicKey: { raw: new Uint8Array([9, 9, 9]) } };
	const injectedBootstrapNodes = ['/dns4/gateway.example/tcp/443/wss/p2p/12D3KooWExample'];

	const handle = await createEdgeNode(
		{
			strandId: VALID_STRAND_ID,
			networkName: 'test-network',
			bootstrapNodes: injectedBootstrapNodes,
			privateKey: /** @type {any} */ (injectedPrivateKey),
		},
		deps,
	);

	// The tap really did attach to THIS node: it registered a listener per
	// tapped event name (the exact count is `connection-lifecycle-probe.js`'s
	// own concern, not re-pinned here; asserting non-zero plus a snapshot
	// read is what proves attach happened without re-deriving that module's
	// own event list).
	assert.ok(addEventListenerCalls.length > 0, 'attachConnectionLifecycleTap did not register any listeners on the constructed node');
	assert.strictEqual(handle.node, stubNode);

	const snapshotAfterFirstAttach = await connectionLifecycleSnapshot(handle.node);
	assert.strictEqual(snapshotAfterFirstAttach.available, true);
	assert.deepStrictEqual(snapshotAfterFirstAttach.bootstrapNodes, injectedBootstrapNodes);

	// `attachConnectionLifecycleTap`'s own idempotence (a second call on the
	// SAME node registers no further listeners) is
	// `connection-lifecycle-probe.test.mjs`'s pinned, negative-controlled
	// claim -- not re-derived here. What THIS test adds is that
	// `createEdgeNode`'s wiring site calls it at all, on the RIGHT node, with
	// the RIGHT bootstrapNodes, which the assertions above already establish.

	// The options object the tap is attached BESIDE must be unchanged: the
	// exact same twelve-plus-cohortTopic shape the earlier test in this file
	// already pins, re-asserted here so a future change to the wiring site
	// cannot silently widen the browser's posture while adding the tap.
	const options = /** @type {Record<string, unknown>} */ (createLibp2pNodeCalls[0]);
	const cohortTopic = /** @type {any} */ (options.cohortTopic);
	assert.strictEqual(cohortTopic.host.profile.willingTiers.size, 0, 'willingTiers must still be empty after the tap is wired');
	assert.strictEqual(cohortTopic.host.profile.willingTiers.has(3), false, 'willingTiers must still exclude tier 3 after the tap is wired');
	assert.strictEqual('wantK' in cohortTopic, false, 'wantK must still be absent after the tap is wired');
	assert.strictEqual(cohortTopic.host.profile.kind, 'edge');
	assert.strictEqual(cohortTopic.host.minSigs, PUBLIC_COHORT_MIN_SIGS);

	await handle.stop();
});

test('createEdgeNode never opts this browser into T3 (reactivity push forwarding) -- willingTiers excludes 3', async () => {
	const { deps, createLibp2pNodeCalls } = makeFakeDeps();
	const injectedPrivateKey = { publicKey: { raw: new Uint8Array([9, 9, 9]) } };
	const injectedBootstrapNodes = ['/dns4/gateway.example/tcp/443/wss/p2p/12D3KooWExample'];

	await createEdgeNode(
		{
			strandId: VALID_STRAND_ID,
			networkName: 'test-network',
			bootstrapNodes: injectedBootstrapNodes,
			privateKey: /** @type {any} */ (injectedPrivateKey),
		},
		deps,
	);

	const options = /** @type {Record<string, unknown>} */ (createLibp2pNodeCalls[0]);
	assert.strictEqual(/** @type {any} */ (options.cohortTopic).host.profile.willingTiers.has(3), false);
});

test('stop() is safe to call twice and swallows errors from both the node stop and the database close', async () => {
	const { deps, stubDb, stubNode } = makeFakeDeps();
	// Simulate a node/db that themselves fail to stop/close cleanly — the
	// scenario a partial or failed start can leave behind. `stop()` must
	// still resolve rather than propagate either failure.
	stubNode.stop = async () => {
		stubNode.stopCalls += 1;
		throw new Error('node stop failed');
	};
	stubDb.close = () => {
		stubDb.closeCalls += 1;
		throw new Error('db close failed');
	};

	const handle = await createEdgeNode(
		{
			strandId: VALID_STRAND_ID,
			networkName: 'test-network',
			bootstrapNodes: ['/dns4/gateway.example/tcp/443/wss/p2p/12D3KooWExample'],
			privateKey: /** @type {any} */ ({ publicKey: { raw: new Uint8Array([1]) } }),
		},
		deps,
	);

	await handle.stop();
	await handle.stop();

	assert.strictEqual(stubNode.stopCalls, 1, 'stop() must be idempotent — the second call must not re-invoke node.stop()');
	assert.strictEqual(stubDb.closeCalls, 1, 'stop() must be idempotent — the second call must not re-invoke db.close()');
});


// ---------------------------------------------------------------------------
// A reader, not a replica (2026-11-03): the node withdraws this network's two
// storage services, so no peer counts it into a storage group.
// ---------------------------------------------------------------------------

test('storageServiceProtocols names exactly the cluster and repo protocols of the network', () => {
	assert.deepEqual(storageServiceProtocols('strand-abc'), ['/optimystic/strand-abc/cluster/1.0.0', '/optimystic/strand-abc/repo/1.0.0']);
});

test('createEdgeNode withdraws both storage services for the network it was built on, exactly once', async () => {
	const { deps, stubNode } = makeFakeDeps();
	await createEdgeNode(
		{ strandId: VALID_STRAND_ID, networkName: 'strand-abc', bootstrapNodes: ['/dns4/gateway.example/tcp/443/wss/p2p/12D3KooWExample'], privateKey: /** @type {any} */ ({}) },
		deps,
	);
	assert.deepEqual(stubNode.unhandleCalls, [storageServiceProtocols('strand-abc')]);
});

test('a node that cannot unregister handlers fails createEdgeNode, and the node and its storage are closed', async () => {
	const { deps, stubNode, stubDb } = makeFakeDeps();
	/** @type {any} */ (stubNode).unhandle = undefined;
	await assert.rejects(
		createEdgeNode(
			{ strandId: VALID_STRAND_ID, networkName: 'strand-abc', bootstrapNodes: ['/dns4/gateway.example/tcp/443/wss/p2p/12D3KooWExample'], privateKey: /** @type {any} */ ({}) },
			deps,
		),
		(/** @type {any} */ err) => err instanceof EdgeNodeConfigError,
	);
	assert.equal(stubNode.stopCalls, 1);
	assert.equal(stubDb.closeCalls, 1);
});

// ---------------------------------------------------------------------------
// 2026-11-16: the read-only visitor declaration. The node is built behind a
// closed gate, withdraws storage and declares EDGE_READER_PROTOCOL, and only
// then lets any connection through.
// ---------------------------------------------------------------------------

const DECL_CONFIG = { strandId: VALID_STRAND_ID, networkName: 'strand-abc', bootstrapNodes: ['/dns4/gateway.example/tcp/443/wss/p2p/12D3KooWExample'], privateKey: /** @type {any} */ ({}) };

/** @param {any} gater */
const allClosed = (gater) => EDGE_DECLARATION_GATED_CHECKS.every((name) => gater[name]() === true);
/** @param {any} gater */
const allOpen = (gater) => EDGE_DECLARATION_GATED_CHECKS.every((name) => gater[name]() === false);

test('declaration: the node is built behind a gate that refuses every gated check during the build and allows them all once createEdgeNode returns', async () => {
	/** @type {any} */
	let gaterSeenAtBuild = null;
	let closedDuringBuild = false;
	const { deps, stubNode } = makeFakeDeps({
		createLibp2pNodeImpl: async (/** @type {any} */ options) => {
			gaterSeenAtBuild = options.connectionGater;
			closedDuringBuild = allClosed(options.connectionGater);
			return stubNode;
		},
	});
	await createEdgeNode(DECL_CONFIG, deps);
	assert.ok(gaterSeenAtBuild, 'createLibp2pNode received no connectionGater');
	assert.equal(closedDuringBuild, true, 'a gated check allowed a connection while the node was being built');
	assert.equal(allOpen(gaterSeenAtBuild), true, 'the gate is still closed after createEdgeNode returned');
});

test('declaration: the gate leaves denyDialMultiaddr unset, so libp2p\'s browser default (no plain ws, no private address) still applies', () => {
	const { connectionGater } = edgeDeclarationGate();
	assert.equal('denyDialMultiaddr' in connectionGater, false);
	assert.deepEqual(Object.keys(connectionGater).sort(), [...EDGE_DECLARATION_GATED_CHECKS].sort());
	assert.ok(EDGE_DECLARATION_GATED_CHECKS.includes('denyDialPeer') && EDGE_DECLARATION_GATED_CHECKS.includes('denyOutboundConnection') && EDGE_DECLARATION_GATED_CHECKS.includes('denyInboundConnection'));
});

test('declaration: storage is withdrawn, then the marker is declared, both while the gate is closed', async () => {
	/** @type {any} */
	let gater = null;
	/** @type {boolean[]} */
	const closedAt = [];
	const { deps, stubNode } = makeFakeDeps({
		createLibp2pNodeImpl: async (/** @type {any} */ options) => {
			gater = options.connectionGater;
			return stubNode;
		},
	});
	const realUnhandle = stubNode.unhandle;
	stubNode.unhandle = async (/** @type {string[]} */ p) => { closedAt.push(allClosed(gater)); return realUnhandle(p); };
	const realHandle = stubNode.handle;
	stubNode.handle = async (/** @type {string} */ p, /** @type {any} */ h) => { closedAt.push(allClosed(gater)); return realHandle(p, h); };
	await createEdgeNode(DECL_CONFIG, deps);
	assert.deepEqual(stubNode.order, ['unhandle', `handle:${EDGE_READER_PROTOCOL}`]);
	assert.deepEqual(closedAt, [true, true], 'a declaration step ran with the gate open');
	assert.deepEqual(stubNode.handleCalls.map((c) => c.protocol), [EDGE_READER_PROTOCOL], 'exactly one handler, the marker');
});

test('declaration: the marker handler serves nothing -- it aborts every stream, and a stream that throws on abort is swallowed', async () => {
	const { deps, stubNode } = makeFakeDeps();
	await createEdgeNode(DECL_CONFIG, deps);
	const { handler } = stubNode.handleCalls[0];
	let aborted = 0;
	handler({ abort: () => { aborted += 1; } });
	assert.equal(aborted, 1);
	assert.doesNotThrow(() => handler({ abort: () => { throw new Error('already closed'); } }));
});

test('declaration: a node that cannot register a handler fails createEdgeNode, the gate never opens, and the node and its storage are closed', async () => {
	/** @type {any} */
	let gater = null;
	const { deps, stubNode, stubDb } = makeFakeDeps({
		createLibp2pNodeImpl: async (/** @type {any} */ options) => {
			gater = options.connectionGater;
			return stubNode;
		},
	});
	/** @type {any} */ (stubNode).handle = undefined;
	await assert.rejects(createEdgeNode(DECL_CONFIG, deps), (/** @type {any} */ err) => err instanceof EdgeNodeConfigError);
	assert.equal(allClosed(gater), true, 'the gate opened for a node that never declared the marker');
	assert.equal(stubNode.stopCalls, 1);
	assert.equal(stubDb.closeCalls, 1);
});

test('declaration parity: EDGE_READER_PROTOCOL is the literal vote-engine\'s refusal and the dashboard look for (source text)', () => {
	assert.equal(EDGE_READER_PROTOCOL, '/votetorrent/edge-reader/1.0.0');
	const engine = readFileSync(new URL('../../../../packages/vote-engine/src/network/edge-reader-refusal.ts', import.meta.url), 'utf8');
	assert.equal((engine.match(/export const EDGE_READER_PROTOCOL = '([^']+)'/) ?? [])[1], EDGE_READER_PROTOCOL);
	const dashboard = readFileSync(new URL('../../../VoteTorrentDashboard/src/peer/member-node.js', import.meta.url), 'utf8');
	assert.equal((dashboard.match(/const EDGE_READER_PROTOCOL = '([^']+)'/) ?? [])[1], EDGE_READER_PROTOCOL);
});
