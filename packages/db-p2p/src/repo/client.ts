import type { IRepo, GetBlockResults, PendSuccess, StaleFailure, TrxBlocks, MessageOptions, CommitResult,
	PendRequest, CommitRequest, BlockGets, IPeerNetwork} from "@votetorrent/db-core";
import type { RepoMessage } from "@votetorrent/db-core";
import type { PeerId } from "@libp2p/interface";
import { ProtocolClient } from "../protocol-client.js";

export class RepoClient extends ProtocolClient implements IRepo {
	private constructor(peerId: PeerId, peerNetwork: IPeerNetwork, readonly protocolPrefix?: string) {
		super(peerId, peerNetwork);
	}

	/** Create a new client instance */
	public static create(peerId: PeerId, peerNetwork: IPeerNetwork): RepoClient {
		return new RepoClient(peerId, peerNetwork);
	}

	async get(blockGets: BlockGets, options: MessageOptions): Promise<GetBlockResults> {
		return this.processRepoMessage<GetBlockResults>(
			[{ get: blockGets }],
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
			[{ cancel: { trxRef } }],
			options
		);
	}

	async commit(request: CommitRequest, options: MessageOptions): Promise<CommitResult> {
		return this.processRepoMessage<CommitResult>(
			[{ commit: request }],
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
			(this.protocolPrefix ?? '/db-p2p') + '/repo/1.0.0',
			{ signal: options?.signal }
		);
	}

}
