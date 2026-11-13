/**
 * edge-circuit-dial.test.mjs — 56-25 Task 1: can the Public page's Edge node
 * reach a peer that is ONLY reachable through a relay?
 *
 * On a real VoteTorrent network every strand node is a phone or a NATed CLI
 * peer holding a reservation on the party relay, so the address the page is
 * handed is `/.../p2p/<relay>/p2p-circuit/p2p/<strand peer>`. libp2p can only
 * dial that with the DIALER half of circuit-relay-v2 in its transport list,
 * and `createEdgeNode` passes its own list, which replaces
 * `@optimystic/db-p2p`'s defaults wholesale (`libp2p-node-base.js`
 * `options.transports ?? defaults.transports`). Without it the dial queue
 * drops the circuit address as `NoValidAddressesError`, the page connects
 * only to the relay, and `findCoordinator` reports the relay as foreign —
 * the 2026-11-13 real-network failure. Loopback harnesses never showed it,
 * because the gateway there is directly dialable.
 *
 * Three in-process nodes on 127.0.0.1 websockets: a relay, a target that
 * listens ONLY on `/p2p-circuit`, and a dialer built from a transport list.
 * The pre-fix list `[webSockets()]` is kept as a standing control: it must
 * keep failing the circuit dial, or this test proves nothing about the fix.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createLibp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayServer, circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { identify } from '@libp2p/identify';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import * as edgeNodeModule from '../../src/peer/edge-node.js';

const RESERVATION_TIMEOUT_MS = 15_000;
const DIAL_TIMEOUT_MS = 10_000;

/** Node's default gater allows everything; pinned anyway so the test does not depend on it. */
const allowAll = { denyDialMultiaddr: async () => false };

/** @param {any[]} transports @param {Record<string, any>} [extra] */
function makeNode(transports, extra = {}) {
	return createLibp2p({
		transports,
		connectionEncrypters: [noise()],
		// Cast: the hoisted yamux's StreamMuxer typing skews from libp2p's by a minor version; runtime-compatible.
		streamMuxers: [/** @type {any} */ (yamux())],
		connectionGater: allowAll,
		...extra,
		services: { identify: identify(), ...(extra.services ?? {}) },
	});
}

/** @type {any} */ let relay;
/** @type {any} */ let target;
/** @type {any[]} */ const dialers = [];
/** @type {string} */ let relayAddr;
/** @type {string} */ let circuitAddr;

before(async () => {
	relay = await makeNode([webSockets()], {
		addresses: { listen: ['/ip4/127.0.0.1/tcp/0/ws'] },
		services: { relay: circuitRelayServer({ reservations: { applyDefaultLimit: false } }) },
	});
	relayAddr = relay
		.getMultiaddrs()
		.map((/** @type {any} */ m) => m.toString())
		.find((/** @type {string} */ a) => a.includes('/ws/'));
	assert.ok(relayAddr, 'relay produced a websocket listen address');

	// The target listens ONLY through its reservation: no direct address, like a phone behind NAT.
	target = await makeNode([webSockets(), circuitRelayTransport()], { addresses: { listen: ['/p2p-circuit'] } });
	const { multiaddr } = await import('@multiformats/multiaddr');
	await target.dial(multiaddr(relayAddr));
	const t0 = Date.now();
	while (Date.now() - t0 < RESERVATION_TIMEOUT_MS) {
		const found = target
			.getMultiaddrs()
			.map((/** @type {any} */ m) => m.toString())
			.find((/** @type {string} */ a) => a.includes('/p2p-circuit'));
		if (found) {
			circuitAddr = found;
			break;
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	assert.ok(circuitAddr, `target obtained a relay reservation within ${RESERVATION_TIMEOUT_MS} ms`);
	assert.equal(
		target.getMultiaddrs().filter((/** @type {any} */ m) => !m.toString().includes('/p2p-circuit')).length,
		0,
		'target has no direct address, so a circuit is the only route to it',
	);
});

after(async () => {
	for (const n of [...dialers, target, relay]) {
		try {
			await n?.stop();
		} catch {
			// teardown only
		}
	}
});

/** @param {any[]} transports */
async function dialerWith(transports) {
	const node = await makeNode(transports, { addresses: { listen: [] } });
	dialers.push(node);
	return node;
}

/** @param {any} node @param {string} addr */
async function tryDial(node, addr) {
	const { multiaddr } = await import('@multiformats/multiaddr');
	try {
		const conn = await node.dial(multiaddr(addr), { signal: AbortSignal.timeout(DIAL_TIMEOUT_MS) });
		return { ok: true, remotePeer: conn.remotePeer.toString(), limited: conn.limits != null };
	} catch (err) {
		return { ok: false, name: /** @type {any} */ (err)?.name ?? 'Error' };
	}
}

test('control: the pre-fix list [webSockets()] reaches the relay directly', async () => {
	const node = await dialerWith([webSockets()]);
	const r = await tryDial(node, relayAddr);
	assert.equal(r.ok, true, `direct relay dial failed: ${r.name}`);
});

test('control: the pre-fix list [webSockets()] CANNOT dial a circuit address (the 2026-11-13 defect)', async () => {
	const node = await dialerWith([webSockets()]);
	const r = await tryDial(node, circuitAddr);
	assert.equal(r.ok, false, 'a webSockets-only node dialed a circuit address; this control no longer discriminates');
	assert.equal(r.name, 'NoValidAddressesError');
});

test("the Edge node's own transport list dials a peer reachable only through a relay", async () => {
	const { edgeTransports } = /** @type {any} */ (edgeNodeModule);
	assert.equal(typeof edgeTransports, 'function', 'edge-node.js exports edgeTransports()');
	const node = await dialerWith(edgeTransports());
	const r = await tryDial(node, circuitAddr);
	assert.equal(r.ok, true, `circuit dial failed: ${r.name}`);
	assert.equal(r.remotePeer, target.peerId.toString());
});
