import { AuthorizedTimestamp } from "./authorized-timestamp.js";

/** Receipt from authority that the block was assimilated (successful or not). */
export interface Receipt {
    /** CID of block */
    blockCid: string,
    /** Result of submission */
    result: 'accepted' | 'duplicate' | 'invalid' | 'inopportune' | 'error',
    /** Duplicate or invalid voter CID(s) */
    resultCids?: string[],
		/** Timestamps of the receipt */
		timestamps: AuthorizedTimestamp[],
    /** Authority's signature of receipt digest (CID encodes hash of block record) */
    signature: string,
}
