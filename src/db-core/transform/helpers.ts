import { BlockId, BlockOperation, BlockStore, IBlock, Transform } from "../index.js";

export function applyOperation(block: IBlock, [entity, index, deleteCount, inserted]: BlockOperation) {
	if (Array.isArray(inserted)) {
    (block as unknown as any)[entity].splice(index, deleteCount, ...inserted);
	} else {
		(block as unknown as any)[entity] = inserted;
	}
}

/** The set of distinct block ids affected by the transform */
export function blockIdsForTransform(transform: Transform | undefined) {
	return !transform
			? []
			: [...new Set([...Object.keys(transform.inserts), ...Object.keys(transform.updates), ...transform.deletes])];
}

export function emptyTransform(): Transform {
	return { inserts: {}, updates: {}, deletes: new Set() };
}

export function mergeTransforms(a: Transform, b: Transform): Transform {
	return {
		inserts: { ...a.inserts, ...b.inserts },
		updates: { ...a.updates, ...b.updates },
		deletes: new Set([...a.deletes, ...b.deletes])
	};
}

export function concatTransforms(transform: Transform[]): Transform {
	return transform.reduce((acc, m) => mergeTransforms(acc, m), emptyTransform());
}

export function transformForBlockId(transform: Transform, blockId: BlockId): Transform {
	return {
		inserts: blockId in transform.inserts ? { [blockId]: transform.inserts[blockId] } : {},
		updates: blockId in transform.updates ? { [blockId]: transform.updates[blockId] } : {},
		deletes: transform.deletes.has(blockId) ? new Set([blockId]) : new Set()
	};
}

export function applyTransformToStore<T extends IBlock>(transform: Transform, store: BlockStore<T>) {
	for (const blockId of transform.deletes) {
		store.delete(blockId);
	}
	for (const [, block] of Object.entries(transform.inserts)) {
		store.insert(block as T);
	}
	for (const [blockId, operations] of Object.entries(transform.updates)) {
		for (const operation of operations) {
			store.update(blockId, operation);
		}
	}
}

