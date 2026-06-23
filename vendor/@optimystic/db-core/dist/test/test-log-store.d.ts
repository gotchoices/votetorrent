import { type BlockStore, type BlockOperation } from "../src/index.js";
import type { LogBlock } from "../src/log/log.js";
export declare class TestLogStore implements BlockStore<LogBlock<any>> {
    private blocks;
    private nextId;
    createBlockHeader(type: string, newId?: string): {
        id: string;
        type: string;
        collectionId: string;
    };
    insert(block: LogBlock<any>): void;
    tryGet(id: string): Promise<LogBlock<any> | undefined>;
    update(id: string, op: BlockOperation): void;
    delete(id: string): void;
    generateId(): string;
    logBlockIds(): void;
    getDirtiedBlockIds(): string[];
}
//# sourceMappingURL=test-log-store.d.ts.map