import { AuthorizedTimestamp } from "./authorized-timestamp";
import { Vote } from "./vote";
import { Voter } from "./voter";

// TODO: should this contain a tally?

export interface Result {
    /** Signature of election, for which this is the result */
    electionSignature: string,
    /** Unencrypted votes, sorted by nonce */
    votes: Vote[],
    /** Unencrypted voters, sorted by key */
    voters: Voter[],
    /** All peer blocks that were accepted */
    blockCids: string[],
    /** Authority's signature of the result */
    signature: string,
}

export interface TimestampedResult {
    resultSignature: string,
    timestamps: AuthorizedTimestamp[],
}

export interface FinalResult {
    resultSignature: string,
    /** Authority's signature timestamped result */
    signature: string,
}
