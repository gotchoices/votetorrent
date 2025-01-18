import { type BlockStore, type BlockOperation, applyOperation } from "../src/index.js";
import type { ITreeNode } from "../src/btree/nodes.js";

// Simple in-memory block store for testing
export class TestBlockStore implements BlockStore<ITreeNode> {
	private blocks = new Map<string, ITreeNode>();
	private nextId = 1;

	createBlockHeader(type: string, newId?: string) {
		const id = newId ?? this.generateId();
		return { id, type, collectionId: 'test' };
	}

	insert(block: ITreeNode): void {
		this.blocks.set(block.header.id, structuredClone(block));
	}

	async tryGet(id: string): Promise<ITreeNode | undefined> {
		return structuredClone(this.blocks.get(id));
	}

	update(id: string, op: BlockOperation): void {
		const block = this.blocks.get(id);
		if (!block) throw new Error(`Block ${id} not found`);
		applyOperation(block, op);
	}

	delete(id: string): void {
		this.blocks.delete(id);
	}

	generateId(): string {
		return `block-${this.nextId++}`;
	}

	logBlockIds() {
		console.log('Current blocks:', [...this.blocks.keys()]);
	}
}
