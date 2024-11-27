import { Libp2p, PeerId, Stream } from "@libp2p/interface";
import { FindCoordinatorOptions, KeyNetwork as IKeyNetwork } from "../db-core/key-network.js";
import { first } from "./it-utility.js";

export class KeyNetwork implements IKeyNetwork {
	constructor(private readonly libp2p: Libp2p) {
	}

	dialProtocol(peerId: PeerId, protocol: string): Promise<Stream> {
		return this.libp2p.dialProtocol(peerId, [protocol], { runOnLimitedConnection: true, negotiateFully: false });
	}

	async findCoordinator<T>(key: Uint8Array, options?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
		return (await first(
			signal => this.libp2p.peerRouting.getClosestPeers(key, { signal, useCache: Boolean(options?.excludedPeers?.length) }),
			() => { throw new Error('No coordinator found') }
		)).id;
	}
}
