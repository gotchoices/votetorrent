import type { UserKey } from '../user/models.js';

/** This contains something that needs to be signed */
export type Envelope<T extends Record<string, string>> = {
	/** The content has string properties to eliminate coding ambiguities when computing the digest. Attributes are sequentially concatenated to form the digest. */
	content: T;
	potentialKeys: UserKey[];
};
