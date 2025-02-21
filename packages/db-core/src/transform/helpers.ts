import type { BlockId, BlockOperation, BlockOperations, BlockStore, IBlock, Transform, Transforms } from "../index.js";

/** Mutates the given block with a copy of the given operation */
export function applyOperation(block: IBlock, [entity, index, deleteCount, inserted]: BlockOperation) {
	if (Array.isArray(inserted)) {
    (block as unknown as any)[entity].splice(index, deleteCount, ...structuredClone(inserted));
	} else {
		(block as unknown as any)[entity] = structuredClone(inserted);
	}
}

/** Mutates the given block with the given set of operations */
export function applyOperations(block: IBlock, operations: BlockOperations) {
	for (const op of operations) {
		applyOperation(block, op);
	}
}

/** Returns a copy of the block with the given operation applied */
export function withOperation(block: IBlock, [entity, index, deleteCount, inserted]: BlockOperation) {
	if (Array.isArray(inserted)) {
		const source = (block as any)[entity];
		return { ...block, [entity]: [...source.slice(0, index), ...structuredClone(inserted), ...source.slice(index + deleteCount)] };
	} else {
		return { ...block, [entity]: structuredClone(inserted) };
	}
}

/** The set of distinct block ids affected by the transform */
export function blockIdsForTransforms(transforms: Transforms | undefined) {
	return !transforms
			? []
			: [...new Set([...Object.keys(transforms.inserts), ...Object.keys(transforms.updates), ...transforms.deletes])];
}

/** Returns an empty transform */
export function emptyTransforms(): Transforms {
	return { inserts: {}, updates: {}, deletes: new Set() };
}

export function copyTransforms(transform: Transforms): Transforms {
	return { inserts: { ...transform.inserts }, updates: { ...transform.updates }, deletes: new Set(transform.deletes) };
}

export function mergeTransforms(a: Transforms, b: Transforms): Transforms {
	return {
		inserts: { ...a.inserts, ...b.inserts },
		updates: { ...a.updates, ...b.updates },
		deletes: new Set([...a.deletes, ...b.deletes])
	};
}

export function isTransformsEmpty(transform: Transforms): boolean {
	return Object.keys(transform.inserts).length === 0
		&& Object.keys(transform.updates).length === 0
		&& transform.deletes.size === 0;
}

export function concatTransforms(...transforms: Transforms[]): Transforms {
	return transforms.reduce((acc, m) => mergeTransforms(acc, m), emptyTransforms());
}


export function transformForBlockId(transform: Transforms, blockId: BlockId): Transform {
	return {
		...(blockId in transform.inserts ? { insert: transform.inserts[blockId] } : {}),
		...(blockId in transform.updates ? { updates: transform.updates[blockId] } : {}),
		...(blockId in transform.deletes ? { delete: true } : {})
	};
}

export function transformsFromTransform(transform: Transform, blockId: BlockId): Transforms {
	return {
		...(transform.insert ? { inserts: { [blockId]: transform.insert } } : { inserts: {} }),
		...(transform.updates ? { updates: { [blockId]: transform.updates } } : { updates: {} }),
		...(transform.delete ? { deletes: new Set([blockId]) } : { deletes: new Set() })
	};
}

export function applyTransformToStore<T extends IBlock>(transform: Transforms, store: BlockStore<T>) {
	for (const blockId of transform.deletes) {
		store.delete(blockId);
	}
	for (const [, block] of Object.entries(transform.inserts)) {
		store.insert(block as T);
	}
	for (const [blockId, operations] of Object.entries(transform.updates)) {
		for (const op of operations) {
			store.update(blockId, op);
		}
	}
}

/** Applies a transform to the given block */
export function applyTransform(block: IBlock | undefined, transform: Transform): IBlock | undefined {
	if (transform.insert) {
		block = transform.insert;
	}
	if (block && transform.updates) {
		applyOperations(block, transform.updates);
	}
	if (transform.delete) {
		return undefined;
	}
	return block;
}

/** Concatenates a transform to the given transforms */
export function concatTransform(transforms: Transforms, blockId: BlockId, transform: Transform): Transforms {
	return {
		inserts: { ...transforms.inserts, ...(transform.insert ? { [blockId]: transform.insert } : {}) },
		updates: { ...transforms.updates, ...(transform.updates ? { [blockId]: transform.updates } : {}) },
		deletes: new Set([...transforms.deletes, ...(transform.delete ? [blockId] : [])])
	};
}
