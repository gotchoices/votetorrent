import { pipe } from 'it-pipe';
import { encode as lpEncode, decode as lpDecode } from 'it-length-prefixed';
import { pushable } from 'it-pushable';
import { IKeyNetwork, Repo, BlockGet, GetBlockResult, Transform, PendSuccess, StaleFailure, TrxBlocks, CommitSuccess, MessageOptions, CommitResult, PendRequest } from '../db-core/index.js';
import { RepoMessage } from '../db-core/network/repo-protocol.js';
import { PeerId } from '@libp2p/interface';
import { first } from './it-utility.js';

export class RepoClient implements Repo {
	private constructor(
		private readonly peerId: PeerId,
		private readonly keyNetwork: IKeyNetwork,
	) { }

	/** Create a new client instance */
	public static create(peerId: PeerId, keyNetwork: IKeyNetwork): RepoClient {
		return new RepoClient(peerId, keyNetwork);
	}

	async get(gets: BlockGet[], options: MessageOptions): Promise<GetBlockResult[]> {
		return this.processMessage<GetBlockResult[]>(
			[{ get: gets }],
			options
		);
	}

	async pend(request: PendRequest, options: MessageOptions): Promise<PendSuccess | StaleFailure> {
		return this.processMessage<PendSuccess | StaleFailure>(
			[{ pend: request }],
			options
		);
	}

	async cancel(trxRef: TrxBlocks, options: MessageOptions): Promise<void> {
		return this.processMessage<void>(
			[{ cancel: trxRef }],
			options
		);
	}

	async commit(trxRef: TrxBlocks, options: MessageOptions): Promise<CommitResult> {
		return this.processMessage<CommitResult>(
			[{ commit: trxRef }],
			options
		);
	}

	private async processMessage<T>(
		operations: RepoMessage['operations'],
		options: MessageOptions
	): Promise<T> {
		const message: RepoMessage = {
			operations,
			expiration: options.expiration,
		};

		const stream = await this.keyNetwork.dialProtocol(
			this.peerId,
			'/db-p2p-repo/1.0.0',
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

			// Combine push and end into a single operation
			sink.push(new TextEncoder().encode(JSON.stringify(message)));
			sink.end();

			return await first(() => source, () => { throw new Error('No response received') });
		} finally {
			stream.close();
		}
	}

}
