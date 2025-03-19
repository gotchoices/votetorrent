import type { AuthorizedTimestamp } from "./authorized-timestamp.js";
import type { Question } from "./question.js";

export type Event =	/* These aren't necessarily listed in chronological order */
	'KI' // keyholders invited
	| 'KA' // keyholders accepted
	| 'KR' // keyholders revised
	| 'RE' // registration ends
	| 'BF' // ballots final
	| 'VS' // voting starts
	| 'AV' // accruing votes
	| 'HV' // hashing votes
	| 'RK' // releasing keys
	| 'TS' // tallying starts
	| 'V' // validation
	| 'CS' // certification starts
	| 'C' // closed;

/** The immutable election record - any change requires abandoning and replacing the election */
export type Election = {
	/** The cid of the election authority */
	authorityCid: string,

	/** The title of the election */
	title: string,

	/** The date of the election */
	date: number,

	/** The deadline for making revisions to the election - this deadline cannot itself be revised */
	revisionDeadline: number,

	/** The timestamp authorities that are used to timestamp the election */
	timestampAuthorities: { url: string }[];

	/** The number of timestamp authorities that must sign records to make them valid */
	timestampAuthorityCount: number,

	/** The signature of the election authority's administrator(s) */
	signature: string,
}

/** Election specific keyholder */
export interface Keyholder {
	inviteNonce: string,

	inviteExpiration: number,

	inviteSignature: string,

	/** The keyholder's name */
	name: string,

	/** The keyholder's official title */
	title: string,

	/** The public key portion of the keyholder's election specific key pair */
	key: string,

	/** The signature of the keyholder, using the registrant private key */
	signature: string,
}

export interface ElectionRevision {
	/** CID of the election */
	electionCid: string,

	/** The monotonically increasing sequence number of the revision */
	revision: number,

	/** Evidence that the revision was made prior to the revisionDeadline of the election */
	revisionTimestamp: AuthorizedTimestamp[],

	/** Tags describing and grouping the election.  e.g. ["general"] or ["democrat", "primary"] */
	tags: string[],

	/** Markdown instructions for the election. */
	instructions: string,

	/** The keyholders who's combined signatures decrypt the election records - there must be at least one */
	keyholders: Keyholder[],

	/** The combined public key of all the keyholders for the election used to encrypt the vote and voter records */
	key: string,

	/** Unix timestamps corresponding to each cut-off event */
	timeline: Record<Event, number>,

	/** Authority's administrator's signature of election revision digest */
	signature: string,
}
