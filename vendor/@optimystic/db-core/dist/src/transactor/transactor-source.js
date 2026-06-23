import { randomBytes } from '@noble/hashes/utils.js';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';
export class TransactorSource {
    collectionId;
    transactor;
    actionContext;
    readDependencies = [];
    constructor(collectionId, transactor, actionContext) {
        this.collectionId = collectionId;
        this.transactor = transactor;
        this.actionContext = actionContext;
    }
    createBlockHeader(type, newId) {
        return {
            type,
            id: newId ?? this.generateId(),
            collectionId: this.collectionId,
        };
    }
    generateId() {
        // 256-bits to fully utilize DHT address space
        return uint8ArrayToString(randomBytes(32), 'base64url');
    }
    async tryGet(id) {
        const result = await this.transactor.get({ blockIds: [id], context: this.actionContext });
        if (result) {
            const { block, state } = result[id];
            // Record read dependency for optimistic concurrency control
            this.readDependencies.push({ blockId: id, revision: state.latest?.rev ?? 0 });
            // TODO: if the state reports that there is a pending action, record this so that we are sure to update before syncing
            //state.pendings
            return block;
        }
    }
    getReadDependencies() {
        return this.readDependencies;
    }
    clearReadDependencies() {
        this.readDependencies = [];
    }
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
    async transact(transform, actionId, rev, headerId, tailId) {
        const pendResult = await this.transactor.pend({ transforms: transform, actionId, rev, policy: 'r' });
        if (!pendResult.success) {
            return pendResult;
        }
        const isNew = transform.inserts && Object.hasOwn(transform.inserts, headerId);
        try {
            const commitResult = await this.transactor.commit({
                headerId: isNew ? headerId : undefined,
                tailId,
                blockIds: pendResult.blockIds,
                actionId,
                rev
            });
            if (!commitResult.success) {
                await this.transactor.cancel({ actionId, blockIds: pendResult.blockIds });
                return commitResult;
            }
        }
        catch (e) {
            await this.transactor.cancel({ actionId, blockIds: pendResult.blockIds });
            throw e;
        }
    }
}
//# sourceMappingURL=transactor-source.js.map