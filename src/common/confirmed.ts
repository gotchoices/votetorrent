import { Question } from "./question"

export interface ConfirmedElection {
	/** Hash key (of electionCid and questions) and identifier for confirmed election */
	cid: string,

	/** CID of the associated election */
	electionCid: string,

	/** Options to be voted on */
	questions: Question[],

	/** Authority's signature of this digest */
	signature: string,
}
