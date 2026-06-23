import type { Startable } from '@libp2p/interface';
import type { IRepo, PeerId, IPeerNetwork } from '@optimystic/db-core';
import { ProtocolClient } from '../protocol-client.js';
export declare const buildBlockTransferProtocol: (protocolPrefix?: string) => string;
/** Request to transfer blocks */
export interface BlockTransferRequest {
    type: 'pull' | 'push';
    /** Block IDs being transferred */
    blockIds: string[];
    /** Reason for transfer */
    reason: 'rebalance' | 'replication' | 'recovery';
    /** For push: base64-encoded block data per block ID */
    blockData?: Record<string, string>;
}
/** Response with block data */
export interface BlockTransferResponse {
    /** Blocks successfully transferred: blockId → base64-encoded data */
    blocks: Record<string, string>;
    /** Block IDs that couldn't be found/transferred */
    missing: string[];
}
export interface BlockTransferServiceInit {
    protocolPrefix?: string;
}
export interface BlockTransferServiceComponents {
    registrar: {
        handle: (...args: any[]) => Promise<void>;
        unhandle: (...args: any[]) => Promise<void>;
    };
    repo: IRepo;
}
/**
 * Libp2p service that handles incoming block transfer requests.
 *
 * Responds to pull requests by reading blocks from local storage.
 * Handles push requests by accepting block data and storing it locally.
 */
export declare class BlockTransferService implements Startable {
    private running;
    private readonly protocol;
    private readonly repo;
    private readonly registrar;
    constructor(components: BlockTransferServiceComponents, init?: BlockTransferServiceInit);
    start(): Promise<void>;
    stop(): Promise<void>;
    private handleRequest;
    private handlePull;
    private handlePush;
    private readRequest;
    private sendResponse;
}
/** Factory for creating BlockTransferService following the libp2p service pattern. */
export declare const blockTransferService: (init?: BlockTransferServiceInit) => (components: BlockTransferServiceComponents) => BlockTransferService;
/**
 * Client for sending block transfer requests to remote peers.
 */
export declare class BlockTransferClient extends ProtocolClient {
    private readonly protocol;
    constructor(peerId: PeerId, peerNetwork: IPeerNetwork, protocolPrefix?: string);
    /** Pull blocks from the remote peer. */
    pullBlocks(blockIds: string[], reason?: BlockTransferRequest['reason']): Promise<BlockTransferResponse>;
    /** Push blocks to the remote peer. */
    pushBlocks(blockIds: string[], blockDataBuffers: Uint8Array[], reason?: BlockTransferRequest['reason']): Promise<BlockTransferResponse>;
}
//# sourceMappingURL=block-transfer-service.d.ts.map