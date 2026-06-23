import type { PeerId, IPeerNetwork, ICluster, ClusterRecord } from '@optimystic/db-core';
import { ProtocolClient } from '../protocol-client.js';
export declare class ClusterClient extends ProtocolClient implements ICluster {
    readonly protocolPrefix?: string | undefined;
    private constructor();
    /** Create a new client instance */
    static create(peerId: PeerId, peerNetwork: IPeerNetwork, protocolPrefix?: string): ClusterClient;
    update(record: ClusterRecord, hop?: number): Promise<ClusterRecord>;
    private recordCoordinatorForRecordIfSupported;
}
//# sourceMappingURL=client.d.ts.map