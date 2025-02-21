import type { Question } from "./question.js"

export type Template = {
	/** Hash key and identifier for ballot - hash includes questions deeply */
	cid: string,

	/** CID of the associated election */
	electionCid: string,

	/** The associated authority */
	authorityCid: string,

	/** Authority's signature of this digest */
	signature: string,
}

export interface TemplateRevision {
	/** CID of the template revision */
	cid: string,

	/** CID of the template */
	templateCid: string,

	/** The monotonically increasing sequence number of the revision */
	revision: number,

	/** CIDs of certifiers - if other than authority's administrator(s) */
	certifiers?: string[],

	/** Options to be voted on */
	questions: Question[],

	/** Authority's signature of this revision */
	signature: string,
}
