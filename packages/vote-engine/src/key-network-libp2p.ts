import type { Libp2p } from "@libp2p/interface";
import type { AbortOptions } from "@libp2p/interface";
import type { PeerId } from "@libp2p/interface";
import type { ClusterPeers, FindCoordinatorOptions, IKeyNetwork } from "@votetorrent/db-core";
import type { Stream } from "stream";

export class KeyNetworkLibp2p implements IKeyNetwork {
	constructor(private readonly libp2p: Libp2p) { }

	async dialProtocol(peerId: PeerId, protocol: string, options?: AbortOptions): Promise<Stream> {
		throw new Error("Not implemented");
		//return this.libp2p.dialProtocol(peerId, protocol, options);
	}

	async findCoordinator<T>(key: Uint8Array, options?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
		throw new Error("Not implemented");
		//return this.libp2p.findCoordinator(key, options);
	}

	async findCluster(key: Uint8Array): Promise<ClusterPeers> {
		throw new Error("Not implemented");
		//return this.libp2p.findCluster(key);
	}
}
