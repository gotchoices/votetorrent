import { Question } from "./question"

export interface Ballot {
	/** Hash key and identifier for ballot */
	cid: string,

	/** CID of the associated election */
	electionCid: string,

	/** The associated authority */
	authorityCid: string,

	/** Options to be voted on */
	questions: Question[],

	/** Authority's signature of this digest */
	signature: string,
}

// TODO: ballot revisions
