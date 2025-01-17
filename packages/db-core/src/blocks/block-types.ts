import type { BlockType } from ".";

const blockTypes = new Map<BlockType, string>();

export function registerBlockType(blockType: BlockType, name: string) {
	if (blockTypes.has(blockType)) {
		throw new Error(`Block type ${blockType} (${name}) already registered (${blockTypes.get(blockType)})`);
	}
	blockTypes.set(blockType, name);
	return blockType;
}
