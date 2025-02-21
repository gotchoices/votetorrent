import type { IBlock } from "@votetorrent/db-core";

export type VoteBlock = IBlock & {
	/** CID of the associated template revision */

	templateRevisionCid: string,

	/** Encrypted votes by nonce */
	votes: Record<string, string>,
	/** Encrypted voters by registrant key */
	voters: Record<string, string>,

	/** Members' signature of the block by registrant key */
	signatures: Record<string, string>,
};
