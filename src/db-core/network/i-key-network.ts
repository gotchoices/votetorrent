import { AbortOptions, PeerId, Stream } from "@libp2p/interface";
import { ClusterPeers } from "../cluster/structs.js";

export type FindCoordinatorOptions = {
	/** Peers that have already been tried (and failed) */
	excludedPeers?: PeerId[];
};


export interface IKeyNetwork {
	/**
	 * Dial a peer and establish a protocol stream
	 */
	dialProtocol(peerId: PeerId, protocol: string, options?: AbortOptions): Promise<Stream>;

	/**
	 * Find a coordinator node responsible for a given key in the KadDHT and establish connection
	 * @param key The key to find coordinator for
	 * @returns Promise resolving to ID of coordinator node
	 */
	findCoordinator<T>(key: Uint8Array, options?: Partial<FindCoordinatorOptions>): Promise<PeerId>;

	/**
	 * Find the peers in the cluster responsible for a given key
	 * @param key The key to find peers for
	 * @returns Promise resolving to the peers in the cluster
	 */
	findCluster(key: Uint8Array): Promise<ClusterPeers>;
}
