import { applyOperation } from "../src/index.js";
// Simple in-memory block store for testing
export class TestBlockStore {
    blocks = new Map();
    nextId = 1;
    createBlockHeader(type, newId) {
        const id = newId ?? this.generateId();
        return { id, type, collectionId: 'test' };
    }
    insert(block) {
        this.blocks.set(block.header.id, structuredClone(block));
    }
    async tryGet(id) {
        return structuredClone(this.blocks.get(id));
    }
    update(id, op) {
        const block = this.blocks.get(id);
        if (!block)
            throw new Error(`Block ${id} not found`);
        applyOperation(block, op);
    }
    delete(id) {
        this.blocks.delete(id);
    }
    generateId() {
        return `block-${this.nextId++}`;
    }
    logBlockIds() {
        console.log('Current blocks:', [...this.blocks.keys()]);
    }
}
//# sourceMappingURL=test-block-store.js.map