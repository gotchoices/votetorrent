import type { RepoMessage } from "../network/repo-protocol.js";
export type Signature = {
    type: 'approve' | 'reject';
    signature: string;
    rejectReason?: string;
};
export type ClusterPeers = {
    [id: string]: {
        multiaddrs: string[];
        /** Base64url-encoded public key (serialization-safe) */
        publicKey: string;
    };
};
export type ClusterRecord = {
    messageHash: string;
    peers: ClusterPeers;
    message: RepoMessage;
    coordinatingBlockIds?: string[];
    promises: {
        [peerId: string]: Signature;
    };
    commits: {
        [peerId: string]: Signature;
    };
    /** Sender's recommended cluster size: min(estimated network size, configured cluster size) */
    suggestedClusterSize?: number;
    minRequiredSize?: number;
    /** Sender's current network size estimate */
    networkSizeHint?: number;
    /** Confidence in the network size estimate (0-1) */
    networkSizeConfidence?: number;
    /** Transaction proceeded despite minority rejections */
    disputed?: boolean;
    /** Evidence of the dispute: which peers rejected and why */
    disputeEvidence?: {
        rejectingPeers: string[];
        rejectReasons: {
            [peerId: string]: string;
        };
    };
};
export interface ClusterConsensusConfig {
    /** Super-majority threshold for promises (default 0.75 = 3/4) */
    superMajorityThreshold: number;
    /** Simple majority threshold for commits (default 0.51 = >50%) */
    simpleMajorityThreshold: number;
    /** Minimum absolute cluster size (default 3) */
    minAbsoluteClusterSize: number;
    /** Allow cluster to operate below configured size (default false) */
    allowClusterDownsize: boolean;
    /** Tolerance for cluster size variance as fraction (default 0.5 = 50%) */
    clusterSizeTolerance: number;
    /** Window for detecting partition in milliseconds (default 60000 = 1 min) */
    partitionDetectionWindow: number;
    /** Enable dispute escalation protocol (default false) */
    disputeEnabled?: boolean;
    /** Timeout for dispute arbitration in milliseconds (default 60000) */
    disputeArbitrationTimeoutMs?: number;
    /** Initial scheduled-retry interval for failed commit broadcasts, ms (default 250) */
    commitBroadcastRetryInitialMs?: number;
    /** Backoff factor for commit-broadcast scheduled retries (default 2) */
    commitBroadcastRetryBackoffFactor?: number;
    /** Max scheduled-retry interval, ms (default 8000) */
    commitBroadcastRetryMaxIntervalMs?: number;
    /** Max scheduled retry attempts before giving up (default 5) */
    commitBroadcastRetryMaxAttempts?: number;
    /** Immediate in-line retries per failed peer inside the broadcast (default 1) */
    commitBroadcastImmediateRetries?: number;
    /** Read-repair behavior: 'off' (only fetch on missing — legacy), 'lazy' (fetch when local age > window), 'paranoid' (always verify against cluster on read). Default 'lazy'. */
    readRepairMode?: 'off' | 'lazy' | 'paranoid';
    /** For 'lazy' mode: read-repair triggers when (now - localEntry.lastSeenCommitMs) > this. Default 10000. */
    readRepairWindowMs?: number;
    /** Per-read probability of triggering read-repair in 'lazy' mode even within the window (0..1). Default 0 (no random check). */
    readRepairSampleRate?: number;
}
//# sourceMappingURL=structs.d.ts.map