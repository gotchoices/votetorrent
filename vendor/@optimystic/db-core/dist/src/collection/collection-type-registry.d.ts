import type { BlockType } from "../blocks/index.js";
import type { ITransactor } from "../transactor/index.js";
import type { CollectionId, ICollection } from "./struct.js";
export interface CollectionTypeDescriptor {
    /** The block type used for this collection's header block (e.g. "DIH", "TRE") */
    blockType: BlockType;
    /** Human-readable name (e.g. "Diary", "Tree") */
    name: string;
    /** Optional factory to open a collection with default settings.
     *  Not all types support this (e.g. Tree requires keyFromEntry/compare). */
    open?: (transactor: ITransactor, id: CollectionId) => Promise<ICollection<any>>;
}
/** Register a collection type by its header block type. Throws if already registered. */
export declare function registerCollectionType(descriptor: CollectionTypeDescriptor): void;
/** Look up a collection type descriptor by its header block type. */
export declare function getCollectionType(blockType: BlockType): CollectionTypeDescriptor | undefined;
/** Returns all registered collection type descriptors. */
export declare function getCollectionTypes(): ReadonlyMap<BlockType, CollectionTypeDescriptor>;
//# sourceMappingURL=collection-type-registry.d.ts.map