import crypto from 'crypto';
import { IBlock, BlockType, BlockId, BlockHeader, BlockSource, BlockNetwork, BlockTrxContext, Transform, TransactionId, StaleFailure } from "../index.js";

export type NetworkSourceOptions = {
	pendDurationMs: number;
};

export class NetworkSource<TBlock extends IBlock> implements BlockSource<TBlock> {
	constructor(
		private readonly collectionId: BlockId,
		private readonly network: BlockNetwork,
		public trxContext: BlockTrxContext,
		private readonly options?: NetworkSourceOptions,
	) { }

	createBlockHeader(type: BlockType, newId?: BlockId): BlockHeader {
		return {
			type,
			id: newId ?? this.generateId(),
			collectionId: this.collectionId,
		};
	}

	generateId(): BlockId {
		// 256-bits to fully utilize DHT address space
		return crypto.randomBytes(32).toString('base64url');
	}

	async tryGet(id: BlockId): Promise<TBlock | undefined> {
		const result = await this.network.get([{ blockId: id, ...this.trxContext }]);
		if (result) {
			const { pendingIds, rev } = result[0]!;
			if (rev > this.trxContext.rev) {
				this.trxContext = { pendingIds, rev };
			}
		}
		return result[0]?.block as TBlock | undefined;
	}

	async transact(transform: Transform, transactionId: TransactionId, tailId: BlockId): Promise<undefined | StaleFailure> {
		const pendExpiration = Date.now() + (this.options?.pendDurationMs ?? 60000);
		const pendResult = await this.network.pend({ transform, transactionId, expiration: pendExpiration }, { pending: "fail" });
		if (!pendResult.success) {
			return pendResult;
		}
		const commitResult = await this.network.commit(tailId, pendResult.trxRef);
		if (!commitResult.success) {
			return commitResult;
		}
	}
}

