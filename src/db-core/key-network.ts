import { AbortOptions, PeerId, Stream } from "@libp2p/interface";

export type FindCoordinatorOptions = {
	/** Peers that have already been tried (and failed) */
	excludedPeers?: PeerId[];
};


export interface KeyNetwork {
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
}
