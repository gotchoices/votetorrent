import { pipe } from 'it-pipe';
import { decode as lpDecode, encode as lpEncode } from 'it-length-prefixed';
import { type Startable, type Logger } from '@libp2p/interface';
import type { IncomingStreamData } from '@libp2p/interface-internal';
import { ICluster } from '../db-core/cluster/i-cluster.js';
import { ClusterRecord } from '../db-core/cluster/structs.js';

interface BaseComponents {
	logger: { forComponent: (name: string) => Logger };
	registrar: {
		handle: (protocol: string, handler: (data: IncomingStreamData) => void, options: any) => Promise<void>;
		unhandle: (protocol: string) => Promise<void>;
	};
}

export interface ClusterServiceComponents extends BaseComponents {
	cluster: ICluster;
}

export interface ClusterServiceInit {
	protocol?: string;
	maxInboundStreams?: number;
	maxOutboundStreams?: number;
	logPrefix?: string;
}

type ClusterMessage = {
	operation: 'update';
	record: ClusterRecord;
}

/**
 * A libp2p service that handles cluster protocol messages
 */
export class ClusterService implements Startable {
	private readonly protocol: string;
	private readonly maxInboundStreams: number;
	private readonly maxOutboundStreams: number;
	private readonly log: Logger;
	private readonly cluster: ICluster;
	private running: boolean;

	constructor(components: ClusterServiceComponents, init: ClusterServiceInit = {}) {
		this.protocol = init.protocol ?? '/db-p2p-cluster/1.0.0';
		this.maxInboundStreams = init.maxInboundStreams ?? 32;
		this.maxOutboundStreams = init.maxOutboundStreams ?? 64;
		this.log = components.logger.forComponent(init.logPrefix ?? 'db-p2p:cluster-service');
		this.cluster = components.cluster;
		this.running = false;
	}

	readonly [Symbol.toStringTag] = '@libp2p/cluster-service';

	async start(): Promise<void> {
		if (this.running) {
			return;
		}

		await this.components.registrar.handle(this.protocol, this.handleIncomingStream.bind(this), {
			maxInboundStreams: this.maxInboundStreams,
			maxOutboundStreams: this.maxOutboundStreams
		});

		this.running = true;
	}

	async stop(): Promise<void> {
		if (!this.running) {
			return;
		}

		await this.components.registrar.unhandle(this.protocol);
		this.running = false;
	}

	private handleIncomingStream(data: IncomingStreamData): void {
		const { stream, connection } = data;
		const peerId = connection.remotePeer;

		void pipe(
			stream,
			lpDecode,
			async function* (source: AsyncIterable<Uint8Array>) {
				for await (const msg of source) {
					// Decode the message
					const decoded = new TextDecoder().decode(msg.subarray());
					const message = JSON.parse(decoded) as ClusterMessage;

					let response: ClusterRecord;
					try {
						response = await this.cluster.update(message.record);
						yield new TextEncoder().encode(JSON.stringify(response));
					} catch (err) {
						this.log.error('error processing cluster message from %p - %e', peerId, err);
						throw err;
					}
				}
			}.bind(this),
			lpEncode,
			stream
		).catch(err => {
			this.log.error('error handling cluster protocol message from %p - %e', peerId, err);
		});
	}
}
