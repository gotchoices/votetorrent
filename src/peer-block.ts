// TODO: How many are allowed in a block?
// TODO: Need a finality mechanism for a block so that different versions aren't submitted
// TODO: Do voters all sign the block?

export interface PeerBlock {
    /** 256bit identity of peer block  */
    cid: string,    
    /** Encrypted (using election's public key) set of votes in random order */
    voteEntries: string[],
    /** Encrypted (using election's public key) set of voters in random order */
    voterEntries: string[],
}