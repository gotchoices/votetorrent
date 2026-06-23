import type { ComponentLogger, Startable } from '@libp2p/interface';
import type { IRepo } from '@optimystic/db-core';
export interface SyncServiceInit {
    protocolPrefix?: string;
}
export interface SyncServiceComponents {
    logger: ComponentLogger;
    registrar: {
        handle: (...args: any[]) => Promise<void>;
        unhandle: (...args: any[]) => Promise<void>;
    };
    repo: IRepo;
}
/**
 * Service for handling incoming sync requests from other cluster peers.
 *
 * Listens on the sync protocol and responds to block requests by:
 * 1. Extracting the block from local storage
 * 2. Building a BlockArchive with requested revisions
 * 3. Sending the response back to the requester
 *
 * This is the server-side of the block restoration mechanism.
 */
export declare class SyncService implements Startable {
    private running;
    private readonly log;
    private readonly protocol;
    private readonly repo;
    private readonly registrar;
    constructor(components: SyncServiceComponents, init?: SyncServiceInit);
    start(): Promise<void>;
    stop(): Promise<void>;
    /**
     * Handle an incoming sync request stream.
     * Uses a streaming pipeline (like the repo service) to process the
     * first request and yield a response without waiting for the client
     * to close its write side — avoids a read/write deadlock.
     */
    /**
     * Handle an incoming sync request stream.
     * Uses a streaming pipeline (like the repo service) to process the
     * request and yield a response immediately — avoids a read/write deadlock.
     */
    private handleSyncRequest;
    /**
     * Build a block archive from local storage.
     *
     * @param blockId - Block to retrieve
     * @param rev - Optional specific revision
     * @param includePending - Whether to include pending transactions
     * @param maxRevisions - Maximum number of revisions to include
     * @returns BlockArchive if found, undefined otherwise
     */
    private buildArchive;
}
/**
 * Factory function for creating a SyncService.
 * Follows the libp2p service pattern.
 */
export declare const syncService: (init?: SyncServiceInit) => (components: SyncServiceComponents) => SyncService;
//# sourceMappingURL=service.d.ts.map