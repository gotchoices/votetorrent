import { Question } from "./question";

export type Deadline = 'signatures' | 'voting' | 'resolution' | 'reporting' | 'validation' | 'close';

export interface Election {
	cid: string,

	// **** Note: none of the following can change without invalidating election

	/** The title of the election */
	title: string,

	sponsorAuthorityCid: string,
}

export interface ElectionRevision {
	/** Hash key (of body) and identifier for election */
	cid: string,

	replacesCid?: string,

	/** The monotonically increasing sequence number of the revision */
	revision: number,

	/** Tags describing and grouping the election.  e.g. ["general"] or ["democrat", "primary"] */
	tags: string[],

	/** Markdown instructions for the election. */
	instructions: string,

	/** The date of the election and core data which the deadlines are relative to */
	date: number,

	/** Unix timestamps corresponding to each deadline - these are in milliseconds and are relative to the election date */
	deadlines: Record<Deadline, number>,

	/** The interval at which runoff elections are triggered if the rules indicate no clear winner, in milliseconds */
	runoffInterval?: number,

	// TODO: rule definition for when to trigger a runoff - this is a measure of confidence based on the validation phase - if the validation discrepancy is greater than the spread between the top candidates, then a runoff is triggered
	rules: {
		/** The ratio of passing whole result validations (validating entire results) to failed ones */
		wholeResultRatio: number,
	}

	/** The timestamp authorities that are used to timestamp the election */
	timestampAuthorities: { url: string }[];

	/** Authority's signature of election detail digest */
	signature: string,
}

// TODO: runoff as follow up election (round)
