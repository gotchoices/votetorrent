import type { ImageRef, Proposal, Timestamp, VideoRef } from '../common';
import type { Invite, InviteStatus } from '../invite/models';

/** The immutable election record - any change requires abandoning and replacing the election */
export type ElectionCore = {
	/** The id of the election */
	id: string;

	/** The id of the election authority */
	authorityId: string;

	/** The title of the election */
	title: string;

	/** The date/time of the election */
	date: number;

	/** The deadline for making revisions to the election - this deadline cannot itself be revised */
	revisionDeadline: number;

	/** The deadline for adding or revising ballots to the election */
	ballotDeadline: number;

	/** The type of election */
	type: ElectionType;
};

export interface ElectionRevision {
	/** ID of the election */
	electionId: string;

	/** The monotonically increasing sequence number of the revision */
	revision: number;

	/** Evidence that the revision was made prior to the revisionDeadline of the election */
	revisionTimestamp: Timestamp[];

	/** Tags describing and grouping the election.  e.g. ["general"] or ["democrat", "primary"] */
	tags: string[];

	/** Markdown instructions for the election. */
	instructions: string;

	/** The keyholders who's combined signatures decrypt the election records - there must be at least one */
	keyholders: InviteStatus<SentKeyholderInvite>[];

	/** Unix timestamps corresponding to each cut-off event */
	timeline: Record<ElectionEvent, number>;

	/** The policy for the required number of keyholders */
	keyholderThreshold: number;
}

export type ElectionCoreInit = {
	/** The id of the election */
	id: string;

	/** The id of the election authority */
	authorityId: string;

	/** The title of the election */
	title: string;

	/** The date/time of the election */
	date: number;

	/** The deadline for making revisions to the election - this deadline cannot itself be revised */
	revisionDeadline: number;

	/** The deadline for adding or revising ballots to the election */
	ballotDeadline: number;

	/** The type of election */
	type: ElectionType;
};

export type ElectionRevisionInit = {
	/** ID of the election */
	electionId: string;

	/** The monotonically increasing sequence number of the revision */
	revision: number;

	/** Evidence that the revision was made prior to the revisionDeadline of the election */
	revisionTimestamp: Timestamp;

	/** Tags describing and grouping the election.  e.g. ["general"] or ["democrat", "primary"] */
	tags: string[];

	/** Markdown instructions for the election. */
	instructions: string;

	/** The keyholders who's combined signatures decrypt the election records - there must be at least one */
	keyholders: KeyholderInvite[];

	/** Unix timestamps corresponding to each cut-off event */
	timeline: Record<ElectionEvent, number>;

	/** The policy for the required number of keyholders */
	keyholderThreshold: number;
};

export type ElectionDetails = {
	/** The election information published by the authority */
	election: ElectionCore;

	/** The current revision of the election */
	current: ElectionRevision;

	/** The proposed revision of the election */
	proposed?: Proposal<ElectionRevisionInit>;
};

export type ElectionInit = {
	/** The immutable election information */
	election: ElectionCoreInit;

	/** The initial revision of the election */
	revision: ElectionRevisionInit;
};

export type ElectionSummary = {
	/** The id of the election */
	id: string;

	/** The title of the election */
	title: string;

	/** The name of the election authority */
	authorityName: string;

	/** The date/time of the election */
	date: number;

	/** The type of election */
	type: ElectionType;
};

export enum ElectionType {
	official = 'o',
	adhoc = 'a',
}

export enum ElectionEvent {
	registrationEnds = 'registrationEnds',
	ballotsFinal = 'ballotsFinal',
	votingStarts = 'votingStarts',
	tallyingStarts = 'tallyingStarts',
	validation = 'validation',
	certificationStarts = 'certificationStarts',
	closed = 'closed',
}

export type KeyholderInvite = Invite & {
	name: string;
};

export type SentKeyholderInvite = {
	name: string;
};

export type Ballot = {
	/** The id of the ballot */
	id: string;

	/** The id of the election */
	electionId: string;

	/** The id of the authority posting the ballot */
	authorityId: string;

	/** The description of the ballot (who is this for, what is the purpose of this ballot, etc.) */
	description: string;

	/** The district/group codes on the ballot */
	districts: string[];

	/** The questions on the ballot */
	questions: Question[];
};

export type BallotDetails = {
	/** The ballot information published by the authority */
	ballot: Ballot;

	/** The proposed revision of the ballot */
	proposed?: Proposal<Ballot>;
};

export type BallotSummary = {
	/** The id of the ballot */
	id: string;

	/** The id of the election */
	electionId: string;

	/** The id of the authority posting the ballot */
	authorityId: string;
};

export type Option = {
	/** The option code */
	code: string;

	/** The option description */
	title: string;

	/** Details about the option */
	details?: string;

	/** Additional information link */
	infoURL?: string;

	/** The image for the option */
	image?: ImageRef;

	/** The video for the option */
	video?: VideoRef;
};

export type Question = {
	/** The slot code on the election describing the position, role, or question filled by this question */
	code: string;

	/** Description of the position, role, or question to be filled by the eventual election */
	title: string;

	/** Markdown instructions for this question. */
	instructions: string;

	dependsOn?: {
		/** The question code that this question depends on */
		code: string;

		/** The answer value(s) to the question that this question depends on */
		valuesExpression?: string;
	};

	/** The options to be selected from or ranked - must have at least one entry for a select or rank question */
	options: Option[];

	/** Type of question. Default: 'select'	*/
	type: 'select' | 'rank' | 'score' | 'text';

	/** minimum and maximum number of options to select from or rank (default 1 and 1) */
	optionRange?: { min: number; max: number };

	/** Preserve the order of the options (default false) */
	optionsOrdered?: boolean;

	/** The range and step of scores that can be given */
	scoreRange?: { min: number; max: number; step: number };

	/** The grouping (hierarchy) containing the question */
	group?: string;

	/** The sequence of the question within the group */
	sequence?: number;

	/** Required.  Default: true. */
	required?: boolean;
};

export type QuestionSummary = {
	/** The code of the question */
	code: string;

	/** The title of the question */
	title: string;

	/** The type of question */
	type: 'select' | 'rank' | 'score' | 'text';
};
