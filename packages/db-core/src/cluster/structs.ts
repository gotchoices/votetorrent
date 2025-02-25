import type { Multiaddr } from "@multiformats/multiaddr";
import type { RepoMessage } from "../network/repo-protocol.js";

export type Signature = {
	type: 'approve' | 'reject';
	signature: string;
	rejectReason?: string;
}

export type ClusterPeers = {
	[id: string]: {
		multiaddrs: Multiaddr[];
		publicKey: Uint8Array;
	};
};

export type ClusterRecord = {
	messageHash: string;	// Serves as a unique identifier for the clustered transaction record
	peers: ClusterPeers;
	message: RepoMessage;
	promises: { [peerId: string]: Signature };
	commits: { [peerId: string]: Signature };
}
