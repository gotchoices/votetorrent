import type { Startable, Logger, StreamHandler, PeerId } from '@libp2p/interface';
import type { IRepo, RepoMessage } from '@optimystic/db-core';
import { type RedirectPayload } from './redirect.js';
interface BaseComponents {
    logger: {
        forComponent: (name: string) => Logger;
    };
    registrar: {
        handle: (protocol: string, handler: StreamHandler, options: any) => Promise<void>;
        unhandle: (protocol: string) => Promise<void>;
    };
}
export interface NetworkManagerLike {
    getCluster(key: Uint8Array): Promise<PeerId[]>;
}
export type RepoServiceComponents = BaseComponents & {
    repo: IRepo;
    networkManager?: NetworkManagerLike;
    peerId?: PeerId;
    getConnectionAddrs?: (peerId: PeerId) => string[];
};
export type RepoServiceInit = {
    protocol?: string;
    protocolPrefix?: string;
    maxInboundStreams?: number;
    maxOutboundStreams?: number;
    logPrefix?: string;
    kBucketSize?: number;
    /**
     * Responsibility K - the replica set size for determining cluster membership.
     * This is distinct from kBucketSize (DHT routing).
     * When set, this determines how many peers (by XOR distance) are considered
     * responsible for a key. If this node is not in the top responsibilityK peers,
     * it will redirect requests to closer peers.
     * Default: 1 (only the closest peer handles requests)
     */
    responsibilityK?: number;
};
export declare function repoService(init?: RepoServiceInit): (components: RepoServiceComponents) => RepoService;
/**
 * A libp2p service that handles repo protocol messages
 */
export declare class RepoService implements Startable {
    private readonly protocol;
    private readonly maxInboundStreams;
    private readonly maxOutboundStreams;
    private readonly log;
    private readonly repo;
    private readonly components;
    private running;
    /** Responsibility K - how many peers are responsible for a key (for redirect decisions) */
    private readonly responsibilityK;
    constructor(components: RepoServiceComponents, init?: RepoServiceInit);
    readonly [Symbol.toStringTag] = "@libp2p/repo-service";
    /**
     * Start the service
     */
    start(): Promise<void>;
    /**
     * Stop the service
     */
    stop(): Promise<void>;
    private getNetworkManager;
    private getSelfId;
    private getPeerAddrs;
    /**
     * Check if this node should redirect the request for a given key.
     * Returns a RedirectPayload if not responsible, null if should handle locally.
     * Also attaches cluster info to the message for downstream use.
     */
    checkRedirect(blockKey: string, opName: string, message: RepoMessage): Promise<RedirectPayload | null>;
    /**
     * Handle incoming streams on the repo protocol
     */
    private handleIncomingStream;
}
export {};
//# sourceMappingURL=service.d.ts.map