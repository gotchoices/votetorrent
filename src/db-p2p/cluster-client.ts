import { PeerId } from '@libp2p/interface';
import { IKeyNetwork } from '../db-core/network/i-key-network.js';
import { ProtocolClient } from './protocol-client.js';
import { ICluster, ClusterRecord } from '../db-core/index.js';

export class ClusterClient extends ProtocolClient implements ICluster {
	private constructor(peerId: PeerId, keyNetwork: IKeyNetwork) {
		super(peerId, keyNetwork);
	}

	/** Create a new client instance */
	public static create(peerId: PeerId, keyNetwork: IKeyNetwork): ClusterClient {
		return new ClusterClient(peerId, keyNetwork);
	}

	async update(record: ClusterRecord): Promise<ClusterRecord> {
		const message = {
			operation: 'update',
			record
		};

		return this.processMessage<ClusterRecord>(
			message,
			'/db-p2p-cluster/1.0.0'
		);
	}
}
