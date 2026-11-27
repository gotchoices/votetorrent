/**
 * connection-lifecycle-probe.test.mjs — behaviour contract for
 * `src/peer/connection-lifecycle-probe.js` (`56-24` Task 1).
 *
 * The fake node built below exposes only the seam this module reads:
 * `addEventListener` (recording listeners so a test can fire a synthetic
 * event through them, exactly the way a real `TypedEventTarget` would
 * invoke a registered listener), `peerStore.all()`, `peerId`,
 * `getConnections()` and `dial()`. Every discriminating field is driven to
 * BOTH of its outcomes below — a suite that only exercised the happy path
 * could not catch a field that has stopped discriminating, the exact defect
 * class `56-20` found and fixed in the sibling probe (a `"[object Object]"`
 * literal in place of a real peer-id string).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	CONNECTION_LIFECYCLE_PROBE_PREFIX,
	CONNECTION_LIFECYCLE_LOG_LIMIT,
	attachConnectionLifecycleTap,
	connectionLifecycleSnapshot,
	probeBootstrapDial,
} from '../../src/peer/connection-lifecycle-probe.js';

/**
 * A fake libp2p-shaped node. `addEventListener` records listeners per event
 * name so a test can `fire(eventName, detail)` to invoke them directly,
 * mirroring how a real `TypedEventTarget` dispatches a `CustomEvent`.
 * @param {{ omitAddEventListener?: boolean, connections?: any[], peerStoreAllImpl?: () => Promise<any[]>, dialImpl?: (peerId: any, options: any) => Promise<any> }} [opts]
 */
function makeFakeNode(opts = {}) {
	/** @type {Map<string, Array<(evt: any) => void>>} */
	const listeners = new Map();
	/** A count of every `addEventListener` REGISTRATION call, independent of
	 * which internal state object a listener closes over -- this is what
	 * makes the idempotence negative control below meaningful: a listener
	 * that closes over an orphaned, overwritten `WeakMap` entry would still
	 * report the SAME `recordCount` through `connectionLifecycleSnapshot`
	 * (which only ever reads the CURRENT entry), so a registration-count
	 * assertion is the only one that actually falls over when the guard is
	 * removed. @type {number} */
	let registrationCount = 0;
	/** @type {any} */
	const node = {
		getConnections: () => opts.connections ?? [],
		peerStore: {
			all: opts.peerStoreAllImpl ?? (async () => []),
		},
		dial: opts.dialImpl ?? (async () => ({ remotePeer: { toString: () => 'dialed-peer' }, remoteAddr: { toString: () => '/dialed/addr' } })),
	};
	if (!opts.omitAddEventListener) {
		node.addEventListener = (/** @type {string} */ name, /** @type {(evt: any) => void} */ fn) => {
			registrationCount += 1;
			const arr = listeners.get(name) ?? [];
			arr.push(fn);
			listeners.set(name, arr);
		};
	}
	return {
		node,
		/** @param {string} name @param {any} detail */
		fire: (name, detail) => {
			for (const fn of listeners.get(name) ?? []) fn({ detail });
		},
		getRegistrationCount: () => registrationCount,
	};
}

// ---------------------------------------------------------------------------
// attachConnectionLifecycleTap — idempotence and availability gate
// ---------------------------------------------------------------------------

test('attachConnectionLifecycleTap attaches exactly one set of listeners; a second call on the same node registers no further listeners', async () => {
	const { node, fire, getRegistrationCount } = makeFakeNode();
	attachConnectionLifecycleTap(node, ['/dns4/gw/tcp/1/tls/ws/p2p/12D3KooWFixtureGateway']);
	const afterFirstAttach = getRegistrationCount();
	attachConnectionLifecycleTap(node, ['/dns4/gw/tcp/1/tls/ws/p2p/12D3KooWFixtureGateway']);

	// The load-bearing assertion for this idempotence claim: registration
	// COUNT, not `recordCount` off a snapshot (see `makeFakeNode`'s own
	// comment for why a snapshot-based assertion here would not discriminate).
	assert.equal(getRegistrationCount(), afterFirstAttach, 'a second attach must register no further listeners');

	fire('connection:open', { remotePeer: { toString: () => 'peer-a' }, remoteAddr: { toString: () => '/addr-a' }, direction: 'outbound', status: 'open' });
	const snapshot = await connectionLifecycleSnapshot(node);
	assert.equal(snapshot.recordCount, 1, 'exactly one record per fired event, given exactly one listener set');
});

test('connectionLifecycleSnapshot on a never-tapped node returns available:false reason:tap-not-attached, and never throws', async () => {
	const { node } = makeFakeNode();
	const snapshot = await connectionLifecycleSnapshot(node);
	assert.deepEqual(snapshot, { available: false, reason: 'tap-not-attached' });
});

test('attachConnectionLifecycleTap on a node with no addEventListener records available:false reason:events-unavailable, and never throws', async () => {
	const { node } = makeFakeNode({ omitAddEventListener: true });
	attachConnectionLifecycleTap(node, []);
	const snapshot = await connectionLifecycleSnapshot(node);
	assert.deepEqual(snapshot, { available: false, reason: 'events-unavailable' });
});

// ---------------------------------------------------------------------------
// The bounded log and truncation
// ---------------------------------------------------------------------------

test('the log is bounded at CONNECTION_LIFECYCLE_LOG_LIMIT; once full it stops appending and the snapshot reports truncated:true with recordCount at the limit', async () => {
	const { node, fire } = makeFakeNode();
	attachConnectionLifecycleTap(node, []);
	for (let i = 0; i < CONNECTION_LIFECYCLE_LOG_LIMIT + 10; i += 1) {
		fire('peer:discovery', { id: { toString: () => `peer-${i}` }, multiaddrs: [] });
	}
	const snapshot = await connectionLifecycleSnapshot(node);
	assert.equal(snapshot.recordCount, CONNECTION_LIFECYCLE_LOG_LIMIT);
	assert.equal(snapshot.truncated, true);
});

test('a log under the limit reports truncated:false', async () => {
	const { node, fire } = makeFakeNode();
	attachConnectionLifecycleTap(node, []);
	fire('peer:discovery', { id: { toString: () => 'peer-only-one' }, multiaddrs: [] });
	const snapshot = await connectionLifecycleSnapshot(node);
	assert.equal(snapshot.truncated, false);
});

// ---------------------------------------------------------------------------
// openObserved — proven to discriminate, per this module's own negative
// control requirement (Task 1 acceptance criterion 12)
// ---------------------------------------------------------------------------

test('openObserved is 0 when the tap has seen only a discovery event', async () => {
	const { node, fire } = makeFakeNode();
	attachConnectionLifecycleTap(node, []);
	fire('peer:discovery', { id: { toString: () => 'peer-x' }, multiaddrs: [] });
	const snapshot = await connectionLifecycleSnapshot(node);
	assert.equal(snapshot.openObserved, 0);
});

test('openObserved is 1 when the tap has seen exactly one connection:open event', async () => {
	const { node, fire } = makeFakeNode();
	attachConnectionLifecycleTap(node, []);
	fire('connection:open', { remotePeer: { toString: () => 'peer-y' }, remoteAddr: { toString: () => '/addr-y' }, direction: 'outbound', status: 'open' });
	const snapshot = await connectionLifecycleSnapshot(node);
	assert.equal(snapshot.openObserved, 1);
});

// ---------------------------------------------------------------------------
// Every other counted event discriminates too
// ---------------------------------------------------------------------------

test('closeObserved, peerConnectObserved, peerDisconnectObserved and peerDiscoveryObserved each count only their own event name', async () => {
	const { node, fire } = makeFakeNode();
	attachConnectionLifecycleTap(node, []);
	fire('connection:close', { remotePeer: { toString: () => 'peer-a' }, remoteAddr: { toString: () => '/a' }, direction: 'outbound', status: 'closed' });
	fire('peer:connect', { toString: () => 'peer-b' });
	fire('peer:connect', { toString: () => 'peer-c' });
	fire('peer:disconnect', { toString: () => 'peer-d' });
	fire('peer:discovery', { id: { toString: () => 'peer-e' }, multiaddrs: [] });

	const snapshot = await connectionLifecycleSnapshot(node);
	assert.equal(snapshot.closeObserved, 1);
	assert.equal(snapshot.peerConnectObserved, 2);
	assert.equal(snapshot.peerDisconnectObserved, 1);
	assert.equal(snapshot.peerDiscoveryObserved, 1);
	assert.equal(snapshot.openObserved, 0, 'no connection:open was fired in this test');
});

test('connection:prune fires with an ARRAY detail and records one entry per pruned connection', async () => {
	const { node, fire } = makeFakeNode();
	attachConnectionLifecycleTap(node, []);
	fire('connection:prune', [
		{ remotePeer: { toString: () => 'peer-f' }, remoteAddr: { toString: () => '/f' }, direction: 'outbound', status: 'closed' },
		{ remotePeer: { toString: () => 'peer-g' }, remoteAddr: { toString: () => '/g' }, direction: 'outbound', status: 'closed' },
	]);
	const snapshot = await connectionLifecycleSnapshot(node);
	assert.equal(snapshot.recordCount, 2);
	assert.deepEqual(
		snapshot.records.map((/** @type {any} */ r) => r.peerId).sort(),
		['peer-f', 'peer-g'],
	);
});

test('eventNames on an available snapshot is the exact frozen list this module taps', async () => {
	const { node } = makeFakeNode();
	attachConnectionLifecycleTap(node, []);
	const snapshot = await connectionLifecycleSnapshot(node);
	assert.deepEqual(snapshot.eventNames, [
		'connection:open',
		'connection:close',
		'connection:prune',
		'peer:connect',
		'peer:disconnect',
		'peer:discovery',
		'transport:close',
	]);
});

// ---------------------------------------------------------------------------
// peerStore readback for the configured bootstrap peer
// ---------------------------------------------------------------------------

const GATEWAY_ADDR = '/ip4/127.0.0.1/tcp/61305/tls/ws/p2p/12D3KooWFixtureGateway';
const GATEWAY_PEER_ID = '12D3KooWFixtureGateway';

test('bootstrapPeerFound is true, with populated fields, when a peer matching the configured bootstrap address exists in the peerStore', async () => {
	const { node } = makeFakeNode({
		peerStoreAllImpl: async () => [
			{
				id: { toString: () => GATEWAY_PEER_ID },
				addresses: [{ multiaddr: { toString: () => GATEWAY_ADDR }, isCertified: false }],
				protocols: ['/fret/1.0.0'],
				tags: new Map([['bootstrap', { value: 50 }]]),
			},
		],
	});
	attachConnectionLifecycleTap(node, [GATEWAY_ADDR]);
	const snapshot = await connectionLifecycleSnapshot(node);
	assert.equal(snapshot.peerStoreSize, 1);
	assert.equal(snapshot.bootstrapPeerFound, true);
	assert.equal(snapshot.bootstrapPeerAddrCount, 1);
	assert.equal(snapshot.bootstrapPeerAddrsAllTlsWs, true);
	assert.deepEqual(snapshot.bootstrapPeerTagNames, ['bootstrap']);
	assert.equal(snapshot.bootstrapPeerProtocolCount, 1);
});

test('bootstrapPeerFound is false, with zeroed fields, when the peerStore holds no peer matching the configured bootstrap address', async () => {
	const { node } = makeFakeNode({ peerStoreAllImpl: async () => [] });
	attachConnectionLifecycleTap(node, [GATEWAY_ADDR]);
	const snapshot = await connectionLifecycleSnapshot(node);
	assert.equal(snapshot.peerStoreSize, 0);
	assert.equal(snapshot.bootstrapPeerFound, false);
	assert.equal(snapshot.bootstrapPeerAddrCount, 0);
	assert.equal(snapshot.bootstrapPeerAddrsAllTlsWs, false);
	assert.deepEqual(snapshot.bootstrapPeerTagNames, []);
	assert.equal(snapshot.bootstrapPeerProtocolCount, 0);
});

test('connectionLifecycleSnapshot on a node whose peerStore.all() throws still returns a full snapshot: event fields populated, peerStore fields carry a named reason string', async () => {
	const { node, fire } = makeFakeNode({
		peerStoreAllImpl: async () => {
			throw new Error('synthetic peerStore failure');
		},
	});
	attachConnectionLifecycleTap(node, [GATEWAY_ADDR]);
	fire('connection:open', { remotePeer: { toString: () => 'peer-h' }, remoteAddr: { toString: () => '/h' }, direction: 'outbound', status: 'open' });

	const snapshot = await connectionLifecycleSnapshot(node);
	assert.equal(snapshot.openObserved, 1, 'the event-derived fields must survive a peerStore failure unaffected');
	assert.equal(typeof snapshot.peerStoreSize, 'string');
	assert.ok(snapshot.peerStoreSize.startsWith('read-failed:'), 'peerStoreSize must carry a named reason string, not a blank value');
	assert.equal(typeof snapshot.bootstrapPeerFound, 'string');
	assert.ok(snapshot.bootstrapPeerFound.startsWith('read-failed:'));
});

test('a node whose peerStore.all() is entirely absent reports a named reason rather than throwing', async () => {
	const { node } = makeFakeNode();
	delete node.peerStore;
	attachConnectionLifecycleTap(node, []);
	const snapshot = await connectionLifecycleSnapshot(node);
	assert.equal(snapshot.peerStoreSize, 'peerstore-unavailable');
});

// ---------------------------------------------------------------------------
// The tap never mutates the node
// ---------------------------------------------------------------------------

test('attachConnectionLifecycleTap never assigns a new property onto the node', async () => {
	const { node } = makeFakeNode();
	const keysBefore = Object.keys(node).sort();
	attachConnectionLifecycleTap(node, ['/x']);
	const keysAfter = Object.keys(node).sort();
	assert.deepEqual(keysAfter, keysBefore, 'the tap must hold its state off-node, in its own WeakMap');
});

// ---------------------------------------------------------------------------
// probeBootstrapDial
// ---------------------------------------------------------------------------

test('probeBootstrapDial returns dialAttempted:false dialOutcome:skipped:no-matching-peer when the peerStore holds no peer with the target id, and never throws', async () => {
	const { node } = makeFakeNode({ peerStoreAllImpl: async () => [] });
	const result = await probeBootstrapDial(node, { targetPeerIdString: GATEWAY_PEER_ID, timeoutMs: 50 });
	assert.equal(result.dialAttempted, false);
	assert.equal(result.dialOutcome, 'skipped:no-matching-peer');
});

test('probeBootstrapDial on a dial that resolves returns dialOutcome:ok with dialRemotePeerId read from the returned connection', async () => {
	const { node } = makeFakeNode({
		peerStoreAllImpl: async () => [{ id: { toString: () => GATEWAY_PEER_ID }, addresses: [], protocols: [], tags: new Map() }],
		dialImpl: async () => ({ remotePeer: { toString: () => GATEWAY_PEER_ID }, remoteAddr: { toString: () => GATEWAY_ADDR } }),
	});
	const result = await probeBootstrapDial(node, { targetPeerIdString: GATEWAY_PEER_ID, timeoutMs: 50 });
	assert.equal(result.dialAttempted, true);
	assert.equal(result.dialOutcome, 'ok');
	assert.equal(result.dialRemotePeerId, GATEWAY_PEER_ID);
	assert.equal(result.dialRemoteAddr, GATEWAY_ADDR);
	assert.equal(typeof result.dialElapsedMs, 'number');
});

test('probeBootstrapDial on a dial that rejects returns dialOutcome:error with a non-empty dialErrorName and a truncated dialErrorMessage', async () => {
	const { node } = makeFakeNode({
		peerStoreAllImpl: async () => [{ id: { toString: () => GATEWAY_PEER_ID }, addresses: [], protocols: [], tags: new Map() }],
		dialImpl: async () => {
			const err = new Error('x'.repeat(1000));
			err.name = 'SyntheticDialError';
			throw err;
		},
	});
	const result = await probeBootstrapDial(node, { targetPeerIdString: GATEWAY_PEER_ID, timeoutMs: 50 });
	assert.equal(result.dialAttempted, true);
	assert.equal(result.dialOutcome, 'error');
	assert.equal(result.dialErrorName, 'SyntheticDialError');
	assert.ok(result.dialErrorMessage.length > 0);
	assert.ok(result.dialErrorMessage.length < 1000, 'dialErrorMessage must be truncated to a fixed bound');
});

test('probeBootstrapDial never throws even when peerStore.all() itself throws', async () => {
	const { node } = makeFakeNode({
		peerStoreAllImpl: async () => {
			throw new Error('synthetic peerStore failure');
		},
	});
	const result = await probeBootstrapDial(node, { targetPeerIdString: GATEWAY_PEER_ID, timeoutMs: 50 });
	assert.equal(result.dialAttempted, false);
	assert.equal(result.dialOutcome, 'skipped:peerstore-read-failed');
});

test('probeBootstrapDial reports connectionCountAfterDial from node.getConnections(), independent of dial outcome', async () => {
	const { node } = makeFakeNode({
		connections: [{ remotePeer: { toString: () => 'other-peer' } }],
		peerStoreAllImpl: async () => [],
	});
	const result = await probeBootstrapDial(node, { targetPeerIdString: GATEWAY_PEER_ID, timeoutMs: 50 });
	assert.equal(result.connectionCountAfterDial, 1);
});

// ---------------------------------------------------------------------------
// Structural-facts-only shape — the [object Object] defect class, foreclosed
// ---------------------------------------------------------------------------

test('CONNECTION_LIFECYCLE_PROBE_PREFIX is the exact literal the driver greps for, distinct from the other two probe prefixes', () => {
	assert.equal(CONNECTION_LIFECYCLE_PROBE_PREFIX, 'CONNECTION_LIFECYCLE_PROBE=');
});

test('JSON.stringify(snapshot) never carries the discrimination-destroying "[object Object]" substring, for a snapshot exercising every field', async () => {
	const { node, fire } = makeFakeNode({
		peerStoreAllImpl: async () => [
			{
				id: { toString: () => GATEWAY_PEER_ID },
				addresses: [{ multiaddr: { toString: () => GATEWAY_ADDR }, isCertified: false }],
				protocols: ['/fret/1.0.0', '/ping/1.0.0'],
				tags: new Map([['bootstrap', { value: 50 }]]),
			},
		],
	});
	attachConnectionLifecycleTap(node, [GATEWAY_ADDR]);
	fire('connection:open', { remotePeer: { toString: () => 'peer-i' }, remoteAddr: { toString: () => '/i' }, direction: 'outbound', status: 'open' });
	fire('peer:discovery', { id: { toString: () => 'peer-j' }, multiaddrs: [{ toString: () => '/j' }] });

	const snapshot = await connectionLifecycleSnapshot(node);
	const serialized = JSON.stringify(snapshot);
	assert.ok(!serialized.includes('[object Object]'), 'snapshot serialization carried the [object Object] literal — a field stopped discriminating');

	const dialResult = await probeBootstrapDial(node, { targetPeerIdString: GATEWAY_PEER_ID, timeoutMs: 50 });
	assert.ok(!JSON.stringify(dialResult).includes('[object Object]'));
});
