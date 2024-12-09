import crypto from 'crypto';
import { IBlock, BlockType, BlockId, BlockHeader, BlockSource, IBlockNetwork, BlockTrxContext, Transform, TrxId, StaleFailure } from "../index.js";

export class NetworkSource<TBlock extends IBlock> implements BlockSource<TBlock> {
	constructor(
		private readonly collectionId: BlockId,
		private readonly network: IBlockNetwork,
		public trxContext: BlockTrxContext,
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
			const { trxId: pendingIds, rev } = result[0]!;
			if (rev > this.trxContext.rev) {
				this.trxContext = { trxId: pendingIds, rev };
			}
		}
		return result[0]?.block as TBlock | undefined;
	}

	async transact(transform: Transform, transactionId: TrxId, tailId: BlockId): Promise<undefined | StaleFailure> {
		const pendResult = await this.network.pend({ transform, trxId: transactionId, pending: 'fail' });
		if (!pendResult.success) {
			return pendResult;
		}
		const commitResult = await this.network.commit(tailId, pendResult.trxRef);
		if (!commitResult.success) {
			return commitResult;
		}
	}
}

