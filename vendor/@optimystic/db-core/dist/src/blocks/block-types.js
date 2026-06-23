const blockTypes = new Map();
export function registerBlockType(blockType, name) {
    if (blockTypes.has(blockType)) {
        throw new Error(`Block type ${blockType} (${name}) already registered (${blockTypes.get(blockType)})`);
    }
    blockTypes.set(blockType, name);
    return blockType;
}
//# sourceMappingURL=block-types.js.map