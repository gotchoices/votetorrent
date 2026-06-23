import type { IBlock, BlockId, BlockHeader, ITransactor, ActionId, StaleFailure, ActionContext, BlockType, BlockSource, Transforms } from "../index.js";
import type { ReadDependency } from "../transaction/transaction.js";
export declare class TransactorSource<TBlock extends IBlock> implements BlockSource<TBlock> {
    private readonly collectionId;
    private readonly transactor;
    actionContext: ActionContext | undefined;
    private readDependencies;
    constructor(collectionId: BlockId, transactor: ITransactor, actionContext: ActionContext | undefined);
    createBlockHeader(type: BlockType, newId?: BlockId): BlockHeader;
    generateId(): BlockId;
    tryGet(id: BlockId): Promise<TBlock | undefined>;
    getReadDependencies(): ReadDependency[];
    clearReadDependencies(): void;
    /**
     * Attempts to apply the given transforms in a transactional manner.
     * @param transform - The transforms to apply.
     * @param actionId - The action id.
     * @param rev - The revision number.
     * @param headerId - The Id of the collection's header block.  If specified, this block's transform is performed first,
     * in the event that there is a race to create the collection itself, or in the event that the tail block is full and
     * is transitioning to a new block.  Ignored if the given headerId is not present in the transforms.
     * @param tailId - The Id of the collection's log tail block.  If specified, this block's transform is performed next
     * (prior to the rest of the block operations), to resolve the "winner" of a race to commit to the collection.
     * @returns A promise that resolves to undefined if the action is successful, or a StaleFailure if the action is stale.
     */
    transact(transform: Transforms, actionId: ActionId, rev: number, headerId: BlockId, tailId: BlockId): Promise<undefined | StaleFailure>;
}
//# sourceMappingURL=transactor-source.d.ts.map