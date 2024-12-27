import { pipe } from 'it-pipe';
import { encode as lpEncode, decode as lpDecode } from 'it-length-prefixed';
import { pushable } from 'it-pushable';
import { IKeyNetwork, IRepo, BlockGet, GetBlockResult, Transform, PendSuccess, StaleFailure, TrxBlocks, CommitSuccess, MessageOptions, CommitResult, PendRequest } from '../../db-core/src/index.js';
import { RepoMessage } from '../../db-core/src/network/repo-protocol.js';
import { PeerId } from '@libp2p/interface';
import { first } from './it-utility.js';
import { ProtocolClient } from './protocol-client.js';

export class RepoClient extends ProtocolClient implements IRepo {
	private constructor(peerId: PeerId, keyNetwork: IKeyNetwork) {
		super(peerId, keyNetwork);
	}

	/** Create a new client instance */
	public static create(peerId: PeerId, keyNetwork: IKeyNetwork): RepoClient {
		return new RepoClient(peerId, keyNetwork);
	}

	async get(gets: BlockGet[], options: MessageOptions): Promise<GetBlockResult[]> {
		return this.processRepoMessage<GetBlockResult[]>(
			[{ get: gets }],
			options
		);
	}

	async pend(request: PendRequest, options: MessageOptions): Promise<PendSuccess | StaleFailure> {
		return this.processRepoMessage<PendSuccess | StaleFailure>(
			[{ pend: request }],
			options
		);
	}

	async cancel(trxRef: TrxBlocks, options: MessageOptions): Promise<void> {
		return this.processRepoMessage<void>(
			[{ cancel: trxRef }],
			options
		);
	}

	async commit(trxRef: TrxBlocks, options: MessageOptions): Promise<CommitResult> {
		return this.processRepoMessage<CommitResult>(
			[{ commit: trxRef }],
			options
		);
	}

	private async processRepoMessage<T>(
		operations: RepoMessage['operations'],
		options: MessageOptions
	): Promise<T> {
		const message: RepoMessage = {
			operations,
			expiration: options.expiration,
		};

		return super.processMessage<T>(
			message,
			'/db-p2p-repo/1.0.0',
			{ signal: options?.signal }
		);
	}

}
