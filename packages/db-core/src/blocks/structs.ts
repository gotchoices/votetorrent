export type BlockId = string;	// base32 encoded
export type BlockType = string;	// Generally a short code

export type BlockHeader = {
	id: BlockId;  // Domain wide block identifier
	type: BlockType;
	collectionId: BlockId;
}

/** A simple block with only a header.  Blocks should be treated as immutable */
export type IBlock = {
	header: BlockHeader;
}

export type BlockOperation = [entity: string, index: number, deleteCount: number, inserted: unknown[] | unknown]
export type BlockOperations = BlockOperation[];

