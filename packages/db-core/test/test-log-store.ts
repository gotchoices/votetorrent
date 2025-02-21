import { type BlockStore, type BlockOperation, applyOperation } from "../src/index.js";
import type { LogBlock } from "../src/log/log.js";

// Simple in-memory block store for testing logs
export class TestLogStore implements BlockStore<LogBlock<any>> {
	private blocks = new Map<string, LogBlock<any>>();
	private nextId = 1;

	createBlockHeader(type: string, newId?: string) {
		const id = newId ?? this.generateId();
		return { id, type, collectionId: 'test' };
	}

	insert(block: LogBlock<any>): void {
		this.blocks.set(block.header.id, structuredClone(block));
	}

	async tryGet(id: string): Promise<LogBlock<any> | undefined> {
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

	getDirtiedBlockIds() {
		return [...this.blocks.keys()];
	}
}
