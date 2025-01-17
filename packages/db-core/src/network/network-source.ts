import { randomBytes } from '@libp2p/crypto'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import type { IBlock, BlockId, BlockHeader, IBlockNetwork, TrxId, StaleFailure, TrxContext, BlockType, BlockSource, Transforms } from "../index.js";

export class NetworkSource<TBlock extends IBlock> implements BlockSource<TBlock> {
	constructor(
		private readonly collectionId: BlockId,
		private readonly network: IBlockNetwork,
		public trxContext: TrxContext | undefined,
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
		return uint8ArrayToString(randomBytes(32), 'base64url')
	}

	async tryGet(id: BlockId): Promise<TBlock | undefined> {
		const result = await this.network.get({ blockIds: [id], context: this.trxContext });
		if (result) {
			const { block, state } = result[id]!;
			// TODO: if the state reports that there is a pending transaction, record this so that we are sure to update before syncing
			//state.pendings
			return block as TBlock;
		}
	}

	async transact(transform: Transforms, trxId: TrxId, rev: number, tailId: BlockId): Promise<undefined | StaleFailure> {
		const pendResult = await this.network.pend({ transforms: transform, trxId, pending: 'f' });
		if (!pendResult.success) {
			return pendResult;
		}
		const commitResult = await this.network.commit(tailId, { blockIds: pendResult.blockIds, trxId, rev });
		if (!commitResult.success) {
			return commitResult;
		}
	}
}

