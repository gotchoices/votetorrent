import { ProtocolClient } from '../protocol-client.js';
/**
 * Client for the dispute protocol. Sends challenges to arbitrators
 * and broadcasts resolutions.
 */
export class DisputeClient extends ProtocolClient {
    protocol;
    constructor(peerId, peerNetwork, protocolPrefix) {
        super(peerId, peerNetwork);
        this.protocol = (protocolPrefix ?? '/db-p2p') + '/dispute/1.0.0';
    }
    static create(peerId, peerNetwork, protocolPrefix) {
        return new DisputeClient(peerId, peerNetwork, protocolPrefix);
    }
    /** Send a challenge to an arbitrator and get their vote */
    async sendChallenge(challenge, timeoutMs) {
        const message = { type: 'challenge', challenge };
        const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
        const response = await this.processMessage(message, this.protocol, { signal });
        return response.vote;
    }
    /** Send a resolution to a peer (broadcast) */
    async sendResolution(resolution) {
        const message = { type: 'resolution', resolution };
        await this.processMessage(message, this.protocol);
    }
}
//# sourceMappingURL=client.js.map