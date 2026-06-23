import type { PeerId, IPeerNetwork } from '@optimystic/db-core';
import { ProtocolClient } from '../protocol-client.js';
import type { DisputeChallenge, DisputeResolution, ArbitrationVote } from './types.js';
/**
 * Client for the dispute protocol. Sends challenges to arbitrators
 * and broadcasts resolutions.
 */
export declare class DisputeClient extends ProtocolClient {
    private readonly protocol;
    constructor(peerId: PeerId, peerNetwork: IPeerNetwork, protocolPrefix?: string);
    static create(peerId: PeerId, peerNetwork: IPeerNetwork, protocolPrefix?: string): DisputeClient;
    /** Send a challenge to an arbitrator and get their vote */
    sendChallenge(challenge: DisputeChallenge, timeoutMs?: number): Promise<ArbitrationVote>;
    /** Send a resolution to a peer (broadcast) */
    sendResolution(resolution: DisputeResolution): Promise<void>;
}
//# sourceMappingURL=client.d.ts.map