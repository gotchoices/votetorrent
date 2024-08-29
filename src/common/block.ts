export interface Block {
    /** CID of the pool/block - hashes the votes & voters as content */
    cid: string,
		/** CID of the associated ballot */
		ballotCid: string,
    /** Encrypted votes by nonce */
    votes: Record<string, string>,
    /** Encrypted voters by registrant key */
    voters: Record<string, string>,
}

/** Block plus member signatures - not given to authority */
export interface BlockRecord {
    block: Block,
		/** Member's signature of the block by registrant key */
    signatures: Record<string, string>,
}
