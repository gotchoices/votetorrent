export interface Block {
	/** CID of the pool/block - hashes the votes & voters as content */
	cid: string,

	/** The contents of the block */
	body: BlockBody,

	/** Member's signature of the block by registrant key */
	signatures: Record<string, string>,
}

export interface BlockBody {
	/** CID of the associated template revision */
	templateRevisionCid: string,

	/** Encrypted votes by nonce */
	votes: Record<string, string>,
	/** Encrypted voters by registrant key */
	voters: Record<string, string>,
}
