import type { BlockId } from '@optimystic/db-core';
import type { BlockArchive } from '../storage/struct.js';
/**
 * Request to sync a specific block or revision from a peer.
 *
 * This protocol is used for block restoration across storage tiers,
 * allowing nodes to request missing blocks from cluster peers or storage rings.
 */
export interface SyncRequest {
    /** Block ID to retrieve */
    blockId: BlockId;
    /**
     * Optional specific revision to retrieve.
     * If undefined, retrieve the latest available revision.
     */
    rev?: number;
    /**
     * If true, include pending transactions in the response.
     * Typically true when requesting latest state, false for historical revisions.
     */
    includePending?: boolean;
    /**
     * Maximum number of revisions to return.
     * Prevents excessive response sizes.
     * @default 100
     */
    maxRevisions?: number;
    /**
     * Optional hint about which tier is requesting (for logging/metrics).
     * Values: 'ring-zulu', 'ring-0', 'ring-N', etc.
     */
    requestingTier?: string;
}
/**
 * Response containing block archive data.
 */
export interface SyncResponse {
    /** True if the peer has the requested data */
    success: boolean;
    /** Block archive if found */
    archive?: BlockArchive;
    /** Error message if unsuccessful */
    error?: string;
    /** Peer ID of responder (for tracking/metrics) */
    responderId?: string;
}
/** Sync protocol prefix - namespaced under db-p2p */
export declare const SYNC_PROTOCOL_PREFIX = "/db-p2p/sync/";
/** Sync protocol version */
export declare const SYNC_PROTOCOL_VERSION = "1.0.0";
/**
 * Builds the full protocol string for the sync protocol.
 *
 * @param protocolPrefix - Optional prefix (e.g., '/optimystic/testnet')
 * @returns Full protocol string
 */
export declare const buildSyncProtocol: (protocolPrefix?: string) => string;
//# sourceMappingURL=protocol.d.ts.map