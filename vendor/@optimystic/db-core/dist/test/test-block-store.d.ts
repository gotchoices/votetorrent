import { type BlockStore, type BlockOperation } from "../src/index.js";
import type { ITreeNode } from "../src/btree/nodes.js";
export declare class TestBlockStore implements BlockStore<ITreeNode> {
    private blocks;
    private nextId;
    createBlockHeader(type: string, newId?: string): {
        id: string;
        type: string;
        collectionId: string;
    };
    insert(block: ITreeNode): void;
    tryGet(id: string): Promise<ITreeNode | undefined>;
    update(id: string, op: BlockOperation): void;
    delete(id: string): void;
    generateId(): string;
    logBlockIds(): void;
}
//# sourceMappingURL=test-block-store.d.ts.map