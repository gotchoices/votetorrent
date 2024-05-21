export interface Receipt {
    /** CID of peer block */
    peerBlockCid: string,
    /** Result of submission */
    result: 'accepted' | 'duplicate' | 'invalid' | 'error',
    /** Duplicate or invalid voter CID(s) */
    resultCids?: string[],
    /** Authority's signature of peer block digest (peer block plus results) */
    signature: string,
}