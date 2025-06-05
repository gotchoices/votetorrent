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

	/**
	 * Attempts to apply the given transforms in a transactional manner.
	 * @param transform - The transforms to apply.
	 * @param trxId - The transaction id.
	 * @param rev - The revision number.
	 * @param headerId - The Id of the collection's header block.  If specified, this block's transform is performed first,
	 * in the event that there is a race to create the collection itself, or in the event that the tail block is full and
	 * is transitioning to a new block.  Ignored if the given headerId is not present in the transforms.
	 * @param tailId - The Id of the collection's log tail block.  If specified, this block's transform is performed next
	 * (prior to the rest of the block operations), to resolve the "winner" of a race to commit to the collection.
	 * @returns A promise that resolves to undefined if the transaction is successful, or a StaleFailure if the transaction is stale.
	 */
	async transact(transform: Transforms, trxId: TrxId, rev: number, headerId: BlockId, tailId: BlockId): Promise<undefined | StaleFailure> {
		const pendResult = await this.transactor.pend({ transforms: transform, trxId, rev, policy: 'r' });
		if (!pendResult.success) {
			return pendResult;
		}
		const isNew = Object.hasOwn(transform.inserts, headerId);
		const commitResult = await this.transactor.commit({
			headerId: isNew ? headerId : undefined,
			tailId,
			blockIds: pendResult.blockIds,
			trxId,
			rev
		});
		if (!commitResult.success) {
			return commitResult;
		}
	}
}

