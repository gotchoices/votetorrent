import type { AbortOptions, Libp2p, PeerId, Stream } from "@libp2p/interface";
import { first } from "./it-utility.js";
import type { ClusterPeers, FindCoordinatorOptions, IKeyNetwork, IPeerNetwork } from "@votetorrent/db-core";
import all from "it-all";

export class Libp2pKeyPeerNetwork implements IKeyNetwork, IPeerNetwork {
	constructor(private readonly libp2p: Libp2p) {
	}

	dialProtocol(peerId: PeerId, protocol: string, options?: AbortOptions): Promise<Stream> {
		const dialOptions = { runOnLimitedConnection: true, negotiateFully: false } as const;
		return this.libp2p.dialProtocol(peerId, [protocol], dialOptions);
	}

	async findCoordinator<T>(key: Uint8Array, options?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
		const peer = await first(
			signal => this.libp2p.peerRouting.getClosestPeers(key, { signal, useCache: Boolean(options?.excludedPeers?.length) }),
			() => { throw new Error('No coordinator found') }
		);
		return peer.id;
	}

	async findCluster(key: Uint8Array): Promise<ClusterPeers> {
		const peers = await all(this.libp2p.peerRouting.getClosestPeers(key, { useCache: true }));
		return Object.fromEntries(peers.map(peer => [peer.id, {
			multiaddr: peer.multiaddrs,
			publicKey: peer.id.publicKey || new Uint8Array()
		}]));
	}
}
