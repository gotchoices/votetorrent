import { pipe } from 'it-pipe';
import { encode as lpEncode, decode as lpDecode } from 'it-length-prefixed';
import { pushable } from 'it-pushable';
import type { PeerId } from '@libp2p/interface';
import type { IKeyNetwork } from '@votetorrent/db-core';
import { first } from './it-utility.js';

export class ProtocolClient {
	constructor(
		protected readonly peerId: PeerId,
		protected readonly keyNetwork: IKeyNetwork,
	) { }

	protected async processMessage<T>(
		message: unknown,
		protocol: string,
		options?: { signal?: AbortSignal }
	): Promise<T> {
		const stream = await this.keyNetwork.dialProtocol(
			this.peerId,
			protocol,
			{ signal: options?.signal }
		);

		try {
			const source = pipe(
				stream.source,
				lpDecode,
				async function* (source) {
					for await (const data of source) {
						const decoded = new TextDecoder().decode(data.subarray());
						yield JSON.parse(decoded);
					}
				}
			) as AsyncIterable<T>;

			const sink = pushable();
			void pipe(
				sink,
				lpEncode,
				stream.sink
			);

			sink.push(new TextEncoder().encode(JSON.stringify(message)));
			sink.end();

			return await first(() => source, () => { throw new Error('No response received') });
		} finally {
			stream.close();
		}
	}
}
