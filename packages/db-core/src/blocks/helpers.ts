import type { BlockOperation, IBlock, BlockId, BlockStore } from "../index.js";
import { applyOperation } from "../transform/helpers.js";

export async function get<T extends IBlock>(store: BlockStore<T>, id: BlockId): Promise<T> {
	const block = await store.tryGet(id);
	if (!block) throw Error(`Missing block (${id})`);
	return block;
}

export function apply<T extends IBlock>(store: BlockStore<T>, block: IBlock, op: BlockOperation) {
	applyOperation(block, op);
	store.update(block.header.id, op);
}
