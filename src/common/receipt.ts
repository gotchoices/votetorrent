/** Receipt from authority that the block was assimilated (successful or not). */
export interface Receipt {
    /** CID of block */
    blockCid: string,
    /** Result of submission */
    result: 'accepted' | 'duplicate' | 'invalid' | 'error',
    /** Duplicate or invalid voter CID(s) */
    resultCids?: string[],
    /** Authority's signature of block record digest (peer block record plus results) */
    signature: string,
}