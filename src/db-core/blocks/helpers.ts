import { BlockId, BlockOperation, IBlock, IBlockStore, Mutations } from "./index.js";

export function applyOperation(block: IBlock, [entity, index, deleteCount, inserted]: BlockOperation) {
	if (Array.isArray(inserted)) {
    (block as unknown as any)[entity].splice(index, deleteCount, ...inserted);
	} else {
		(block as unknown as any)[entity] = inserted;
	}
}

export function blockIdsForMutation(mutations: Mutations | undefined) {
	return !mutations
			? []
			: mutations.inserts.map(i => i.block.id)
					.concat(Array.from(mutations.updates.keys()))
					.concat(mutations.deletes);
}

export function emptyMutations(): Mutations {
	return { inserts: [], updates: new Map(), deletes: [] };
}

export function mergeMutations(a: Mutations, b: Mutations): Mutations {
	return {
		inserts: [...a.inserts, ...b.inserts],
		updates: new Map([...a.updates, ...b.updates]),
		deletes: [...a.deletes, ...b.deletes]
	};
}

export function mutationsForBlockId(mutations: Mutations, blockId: BlockId): Mutations {
	return {
		inserts: mutations.inserts.filter(b => b.block.id === blockId),
		updates: new Map(
			Array.from(mutations.updates.entries())
				.filter(([bid]) => bid === blockId)
		),
		deletes: mutations.deletes.filter(bid => bid === blockId)
	};
}

export async function get<T extends IBlock>(store: IBlockStore<T>, id: BlockId): Promise<T> {
	const block = await store.tryGet(id);
	if (!block) {
			// TODO: some way to recover from a missing block
			throw Error(`Missing block (${id})`);
	}
	return block!;
}

export function apply<T extends IBlock>(store: IBlockStore<T>, block: IBlock, op: BlockOperation) {
	applyOperation(block, op);
	store.update(block.block.id, op);
}
