export interface Block {
    /** CID of the pool/block - hashes the votes & voters as content */
    cid: string,
		/** CID of the associated confirmed election */
		confirmedCid: string,
    /** Encrypted votes */
    votes: string[],
    /** Encrypted voters */
    voters: string[],
}

export interface BlockSignature {
    memberKey: string,
		/** Member's signature of block */
    signature: string,
}
/** Block plus member signatures - not given to authority */
export interface BlockRecord {
    block: Block,
    signatures: BlockSignature[],
}
