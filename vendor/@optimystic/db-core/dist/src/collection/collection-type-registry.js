const collectionTypes = new Map();
/** Register a collection type by its header block type. Throws if already registered. */
export function registerCollectionType(descriptor) {
    if (collectionTypes.has(descriptor.blockType)) {
        throw new Error(`Collection type ${descriptor.blockType} (${descriptor.name}) already registered`
            + ` (${collectionTypes.get(descriptor.blockType).name})`);
    }
    collectionTypes.set(descriptor.blockType, descriptor);
}
/** Look up a collection type descriptor by its header block type. */
export function getCollectionType(blockType) {
    return collectionTypes.get(blockType);
}
/** Returns all registered collection type descriptors. */
export function getCollectionTypes() {
    return collectionTypes;
}
//# sourceMappingURL=collection-type-registry.js.map