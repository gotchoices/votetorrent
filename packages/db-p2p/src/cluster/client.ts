import { type PeerId } from '@libp2p/interface';
import type { IPeerNetwork, ICluster, ClusterRecord } from '@votetorrent/db-core';
import { ProtocolClient } from '../protocol-client.js';

export class ClusterClient extends ProtocolClient implements ICluster {
	private constructor(peerId: PeerId, peerNetwork: IPeerNetwork, readonly protocolPrefix?: string) {
		super(peerId, peerNetwork);
	}

	/** Create a new client instance */
	public static create(peerId: PeerId, peerNetwork: IPeerNetwork): ClusterClient {
		return new ClusterClient(peerId, peerNetwork);
	}

	async update(record: ClusterRecord): Promise<ClusterRecord> {
		const message = {
			operation: 'update',
			record
		};

		return this.processMessage<ClusterRecord>(
			message,
			(this.protocolPrefix ?? '/db-p2p') + '/cluster/1.0.0'
		);
	}
}
