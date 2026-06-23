import type { Startable, Logger, StreamHandler } from '@libp2p/interface';
import type { DisputeService } from './dispute-service.js';
interface BaseComponents {
    logger: {
        forComponent: (name: string) => Logger;
    };
    registrar: {
        handle: (protocol: string, handler: StreamHandler, options: any) => Promise<void>;
        unhandle: (protocol: string) => Promise<void>;
    };
}
export interface DisputeProtocolServiceComponents extends BaseComponents {
    disputeService: DisputeService;
}
export interface DisputeProtocolServiceInit {
    protocol?: string;
    protocolPrefix?: string;
    maxInboundStreams?: number;
    maxOutboundStreams?: number;
}
export declare function disputeProtocolService(init?: DisputeProtocolServiceInit): (components: DisputeProtocolServiceComponents) => DisputeProtocolService;
/**
 * Libp2p service that handles dispute protocol messages.
 * Follows the same pattern as ClusterService.
 */
export declare class DisputeProtocolService implements Startable {
    private readonly protocol;
    private readonly maxInboundStreams;
    private readonly maxOutboundStreams;
    private readonly log;
    private readonly disputeService;
    private readonly components;
    private running;
    constructor(components: DisputeProtocolServiceComponents, init?: DisputeProtocolServiceInit);
    readonly [Symbol.toStringTag] = "@libp2p/dispute";
    start(): Promise<void>;
    stop(): Promise<void>;
    private handleIncomingStream;
}
export {};
//# sourceMappingURL=service.d.ts.map