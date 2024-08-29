import { AuthorizedTimestamp } from "./authorized-timestamp";
import { Vote } from "./vote";
import { Voter } from "./voter";

export interface Result {
		/** Cid of the result - hash of entire result */
		cid: string,
    /** Cid of the ballot, for which this is the result */
    ballotCid: string,
    /** Unencrypted votes, by nonce */
    votes: Record<string, Vote>,
    /** Unencrypted voters, by registrant key */
    voters: Record<string, Voter>,
    /** All peer blocks that were accepted */
    blockCids: string[],
    /** Authority's signature of ballotCid, votes, voters, and blockCids */
    signature: string,
    /** Timestamped result - hash of ballotCid, votes, voters, blockCids, and signature */
    timestamps: AuthorizedTimestamp[],
}
