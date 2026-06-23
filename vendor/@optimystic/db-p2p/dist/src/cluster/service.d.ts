import type { Startable, Logger, StreamHandler } from '@libp2p/interface';
import type { ICluster } from '@optimystic/db-core';
interface BaseComponents {
    logger: {
        forComponent: (name: string) => Logger;
    };
    registrar: {
        handle: (protocol: string, handler: StreamHandler, options: any) => Promise<void>;
        unhandle: (protocol: string) => Promise<void>;
    };
}
export interface ClusterServiceComponents extends BaseComponents {
    cluster: ICluster;
}
export interface ClusterServiceInit {
    protocol?: string;
    protocolPrefix?: string;
    maxInboundStreams?: number;
    maxOutboundStreams?: number;
    logPrefix?: string;
    kBucketSize?: number;
    configuredClusterSize?: number;
    allowClusterDownsize?: boolean;
    clusterSizeTolerance?: number;
    /**
     * Responsibility K - the replica set size for determining cluster membership.
     * This is distinct from kBucketSize (DHT routing) and configuredClusterSize (consensus quorum).
     * When set, this determines how many peers (by XOR distance) are considered
     * responsible for a key. If this node is not in the top responsibilityK peers,
     * it will redirect requests to closer peers.
     * Default: 1 (only the closest peer handles requests)
     */
    responsibilityK?: number;
}
export declare function clusterService(init?: ClusterServiceInit): (components: ClusterServiceComponents) => ClusterService;
/**
 * A libp2p service that handles cluster protocol messages
 */
export declare class ClusterService implements Startable {
    private readonly protocol;
    private readonly maxInboundStreams;
    private readonly maxOutboundStreams;
    private readonly log;
    private readonly cluster;
    private readonly components;
    private running;
    constructor(components: ClusterServiceComponents, init?: ClusterServiceInit);
    readonly [Symbol.toStringTag] = "@libp2p/cluster";
    start(): Promise<void>;
    stop(): Promise<void>;
    private handleIncomingStream;
}
export {};
//# sourceMappingURL=service.d.ts.map