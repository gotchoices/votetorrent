import type { PeerId, IPeerNetwork } from '@optimystic/db-core';
/**
 * Thrown when the per-peer dial deadline expires before a stream is established.
 * Distinct from a libp2p dial failure (no route, refused, etc.) so the
 * batch-retry loop and diagnostic surfaces can identify a slow/unreachable peer
 * specifically. `.code === DIAL_TIMEOUT_ERROR_CODE`.
 */
export declare const DIAL_TIMEOUT_ERROR_CODE = "DIAL_TIMEOUT";
export declare class DialTimeoutError extends Error {
    readonly code = "DIAL_TIMEOUT";
    constructor(peer: string, protocol: string, ms: number);
}
/** Base class for clients that communicate via a libp2p protocol */
export declare class ProtocolClient {
    protected readonly peerId: PeerId;
    protected readonly peerNetwork: IPeerNetwork;
    constructor(peerId: PeerId, peerNetwork: IPeerNetwork);
    protected processMessage<T>(message: unknown, protocol: string, options?: {
        signal?: AbortSignal;
        correlationId?: string;
        dialTimeoutMs?: number;
    }): Promise<T>;
}
//# sourceMappingURL=protocol-client.d.ts.map