/**
 * edge-reader-declaration.test.mjs -- the read-only visitor declaration on a
 * REAL libp2p stack (2026-11-16). A plain libp2p "host" listens on a loopback
 * websocket, with identify on the strand's own prefix (db-p2p runs identify as
 * `/optimystic/<networkName>/id/1.0.0`). The real `createEdgeNode` dials it as
 * its bootstrap node. The property: the FIRST protocol list the host learns
 * for the page already names `EDGE_READER_PROTOCOL` and neither storage
 * protocol, so no host can ever have classified the page as a storage peer.
 *
 * Measured while writing this (2026-11-16, same rig): built ungated, the first
 * connection landed ~55 ms after start and the first identify listed neither
 * storage nor the marker; gated, ~1050 ms (the bootstrap module's 1 s timer:
 * db-p2p's earlier seed dial is refused by the closed gate) with the marker.
 */
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLibp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { identify, identifyPush } from '@libp2p/identify';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { createEdgeNode, EDGE_READER_PROTOCOL, storageServiceProtocols } from '../../src/peer/edge-node.js';

const SETTLE_MS = 6000;

test('the host\'s first view of the page lists the read-only marker and no storage protocol', async () => {
	const strandId = `decl${Date.now()}`;
	const networkName = `strand-${strandId}`;
	const prefix = `optimystic/${networkName}`;
	const host = await createLibp2p({
		addresses: { listen: ['/ip4/127.0.0.1/tcp/0/ws'] },
		transports: [webSockets()],
		connectionEncrypters: [noise()],
		// Cast: the hoisted yamux's StreamMuxer typing skews from libp2p's by a minor version; runtime-compatible.
		streamMuxers: [/** @type {any} */ (yamux())],
		connectionGater: { denyDialMultiaddr: async () => false },
		services: { identify: identify({ protocolPrefix: prefix }), identifyPush: identifyPush({ protocolPrefix: prefix }) },
	});
	/** @type {any} */
	let edge = null;
	try {
		const addr = host
			.getMultiaddrs()
			.map((/** @type {any} */ m) => m.toString())
			.find((/** @type {string} */ a) => a.includes('/ws/'));
		assert.ok(addr, 'the host produced a websocket address');
		edge = await createEdgeNode({ strandId, networkName, bootstrapNodes: [addr], privateKey: await generateKeyPair('Ed25519') });
		const pageId = edge.node.peerId;

		// Sample the host's record of the page until it holds a protocol list; keep the FIRST one.
		/** @type {string[] | null} */
		let first = null;
		const t0 = Date.now();
		while (first === null && Date.now() - t0 < SETTLE_MS) {
			try {
				const record = await host.peerStore.get(pageId);
				const protocols = record.protocols.map(String);
				if (protocols.some((p) => p !== `/${prefix}/id/1.0.0`)) first = protocols;
			} catch {
				// not known yet
			}
			if (first === null) await new Promise((r) => setTimeout(r, 5));
		}
		assert.ok(first, `the host never learned the page's protocols within ${SETTLE_MS} ms`);
		assert.ok(first.includes(EDGE_READER_PROTOCOL), `the first identify did not name the marker: ${JSON.stringify(first)}`);
		for (const storage of storageServiceProtocols(networkName)) {
			assert.ok(!first.includes(storage), `the first identify listed a storage protocol: ${storage}`);
		}
	} finally {
		await edge?.stop();
		await host.stop();
	}
});
