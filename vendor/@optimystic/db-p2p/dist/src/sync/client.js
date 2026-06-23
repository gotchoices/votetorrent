import { ProtocolClient } from '../protocol-client.js';
import { buildSyncProtocol } from './protocol.js';
/**
 * Client for sending sync requests to remote peers.
 *
 * Used by storage tiers to request missing blocks from other nodes in the network.
 * Extends ProtocolClient for consistent error handling and timeout behavior.
 */
export class SyncClient extends ProtocolClient {
    protocol;
    constructor(peerId, peerNetwork, protocolPrefix = '') {
        super(peerId, peerNetwork);
        this.protocol = buildSyncProtocol(protocolPrefix);
    }
    /**
     * Request a block from the remote peer.
     *
     * @param request - Sync request specifying block and options
     * @returns Response with archive if successful
     * @throws Error if request fails or times out
     */
    async requestBlock(request) {
        return await this.processMessage(request, this.protocol);
    }
    /**
     * Get the protocol string used by this client.
     */
    getProtocol() {
        return this.protocol;
    }
}
//# sourceMappingURL=client.js.map