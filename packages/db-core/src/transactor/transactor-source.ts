import { randomBytes } from '@libp2p/crypto'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import type { IBlock, BlockId, BlockHeader, ITransactor, TrxId, StaleFailure, TrxContext, BlockType, BlockSource, Transforms } from "../index.js";

export class TransactorSource<TBlock extends IBlock> implements BlockSource<TBlock> {
	constructor(
		private readonly collectionId: BlockId,
		private readonly transactor: ITransactor,
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
		const result = await this.transactor.get({ blockIds: [id], context: this.trxContext });
		if (result) {
			const { block, state } = result[id]!;
			// TODO: if the state reports that there is a pending transaction, record this so that we are sure to update before syncing
			//state.pendings
			return block as TBlock;
		}
	}

	async transact(transform: Transforms, trxId: TrxId, rev: number, headerId: BlockId, tailId: BlockId): Promise<undefined | StaleFailure> {
		const isNew = Object.hasOwn(transform.inserts, headerId);
		const pendResult = await this.transactor.pend({ transforms: transform, trxId, policy: 'f' });
		if (!pendResult.success) {
			return pendResult;
		}
		const commitResult = await this.transactor.commit({ headerId: isNew ? headerId : undefined, tailId, blockIds: pendResult.blockIds, trxId, rev });
		if (!commitResult.success) {
			return commitResult;
		}
	}
}

