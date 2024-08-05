import { Question } from "./question";

export type Deadline = 'signatures' | 'voting' | 'resolution' | 'reporting' | 'validation' | 'close';

export interface Election {
	code: string,

	/** The description/name of the election */
	description: string,
}

export interface ElectionRev {
	/** Hash key (of body) and identifier for election */
	cid: string,

	replacesCid?: string,


	/** Markdown instructions for the election. */
	instructions: string,

	/** Unix timestamps corresponding to each deadline */
	deadlines: Map<Deadline, number>,

	// TODO: /** Rules for the pending election */
	// rules: Map<string, string>,

	/** Authority's signature of election detail digest */
	signature: string,
}

// TODO: runoff as follow up election (round)
