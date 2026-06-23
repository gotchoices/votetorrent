import { ProtocolClient } from '../protocol-client.js';
import { peerIdFromString } from '@libp2p/peer-id';
export class ClusterClient extends ProtocolClient {
    protocolPrefix;
    constructor(peerId, peerNetwork, protocolPrefix) {
        super(peerId, peerNetwork);
        this.protocolPrefix = protocolPrefix;
    }
    /** Create a new client instance */
    static create(peerId, peerNetwork, protocolPrefix) {
        return new ClusterClient(peerId, peerNetwork, protocolPrefix);
    }
    async update(record, hop = 0) {
        const message = {
            operation: 'update',
            record
        };
        const preferred = (this.protocolPrefix ?? '/db-p2p') + '/cluster/1.0.0';
        let response;
        try {
            response = await this.processMessage(message, preferred);
        }
        catch (err) {
            if (preferred !== '/db-p2p/cluster/1.0.0') {
                try {
                    response = await this.processMessage(message, '/db-p2p/cluster/1.0.0');
                }
                catch (fallbackErr) {
                    // Throw original error - fallback protocol is likely not registered
                    throw err;
                }
            }
            else {
                throw err;
            }
        }
        if (response?.redirect?.peers?.length) {
            if (hop >= 2) {
                throw new Error('Redirect loop detected in ClusterClient (max hops reached)');
            }
            const currentIdStr = this.peerId.toString();
            const next = response.redirect.peers.find((p) => p.id !== currentIdStr) ?? response.redirect.peers[0];
            const nextId = peerIdFromString(next.id);
            if (next.id === currentIdStr) {
                throw new Error('Redirect loop detected in ClusterClient (same peer)');
            }
            this.recordCoordinatorForRecordIfSupported(record, nextId);
            const nextClient = ClusterClient.create(nextId, this.peerNetwork, this.protocolPrefix);
            return await nextClient.update(record, hop + 1);
        }
        return response;
    }
    recordCoordinatorForRecordIfSupported(record, peerId) {
        const rmsg = record?.message;
        let tailId;
        if (rmsg?.commit?.tailId)
            tailId = rmsg.commit.tailId;
        else if (rmsg?.pend?.transforms) {
            const keys = Object.keys(rmsg.pend.transforms);
            if (keys.length > 0)
                tailId = keys[0];
        }
        if (tailId) {
            const kbytes = new TextEncoder().encode(tailId);
            const pn = this.peerNetwork;
            if (typeof pn?.recordCoordinator === 'function')
                pn.recordCoordinator(kbytes, peerId);
        }
    }
}
//# sourceMappingURL=client.js.map