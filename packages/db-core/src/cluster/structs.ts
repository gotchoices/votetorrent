import { RepoMessage } from "../network/repo-protocol.js";

export type Signature = {
	type: 'approve' | 'reject';
	signature: string;
	rejectReason?: string;
}

export type ClusterPeers = {
	[id: string]: {
		multiaddr: string;
		publicKey: string;
	};
};

export type ClusterRecord = {
	messageHash: string;	// Serves as a unique identifier for the clustered transaction record
	peers: ClusterPeers;
	message: RepoMessage;
	promises: { [peerId: string]: Signature };
	commits: { [peerId: string]: Signature };
}
