import type { ImageRef } from '../common';
import type { Invite } from '../invite/models';
import type { Proposal, Timestamp, ThresholdPolicy } from '../common/index.js';

/*********** Authority ***********/
export type Authority = {
	/** Sovereign ID of the authority */
	id: string;

	/** Official, legal name */
	name: string;

	/** Registered domain name of the authority */
	domainName: string;

	/** Image reference for the authority */
	imageRef?: ImageRef;
};

export type AuthorityInit = {
	/** Name of the authority */
	name: string;

	/** Domain name of the authority */
	domainName: string;

	/** Image url for the authority */
	imageUrl?: string;
};

export type AuthorityDetails = {
	/** The authority */
	authority: Authority;

	/** The proposed changes to the authority */
	proposed?: Proposal<AuthorityInit>;
};

export type AuthorityInvite = Invite & {
	/** Suggested name for the new Authority */
	name: string;

	/** The type of the invite */
	type: 'au';
};

export type SentAuthorityInvite = {
	name: string;
	type: 'au';
};

/*********** Administration ***********/
export type Admin = {
	/** ID of the administration */
	id: string;

	/** The authority's id */
	authorityId: string;

	/** The effective date of the administration */
	effectiveAt: Timestamp;

	/** The officers */
	officers: Officer[];

	/** The threshold policies */
	thresholdPolicies: ThresholdPolicy[];
};

export type AdminInit = {
	/** The officers */
	officers: OfficerSelection[];

	/** The effective date of the administration */
	effectiveAt: Timestamp;

	/** Threshold policies */
	thresholdPolicies: ThresholdPolicy[];
};

export type AdminDetails = {
	/** The administration */
	admin: Admin;

	/** The proposed changes to the administration */
	proposed?: Proposal<AdminInit>;
};

/*********** Officer ***********/
export type Officer = {
	/** ID of the officer's user */
	userId: string;

	/** The authority's id */
	authorityId: string;

	/** Title of the officer */
	title: string;

	/** Scopes of the officer */
	scopes: Scope[];
};

export type OfficerInit = {
	/** Suggested name of the officer (informational for targeting the right person) */
	name: string;

	/** Title of the officer */
	title: string;

	/** Scopes of the officer */
	scopes: Scope[];
};

export type OfficerSelection = {
	/** If it's a new officer */
	init?: OfficerInit;

	/** If it's an existing officer */
	existing?: Officer;
};

export type OfficerInvite = Invite &
	OfficerInit & {
		/** The type of the invite */
		type: 'of';
	};

export type SentOfficerInvite = OfficerInit & {
	type: 'of';
};

/** Scope codes representing different officer privileges */
export type Scope =
	| 'rn'
	| 'rad'
	| 'vrg'
	| 'iad'
	| 'rnp'
	| 'uai'
	| 'ceb'
	| 'mel'
	| 'cap';

export const scopeDescriptions: Record<string, string> = {
	rn: 'Revise Network',
	rad: 'Revise or replace the Administration',
	vrg: 'Validate registrations',
	iad: 'Invite other Authorities',
	uai: 'Update Authority Information',
	ceb: 'Create/Edit ballot templates',
	mel: 'Manage Elections',
	cap: 'Configure Authority Peers',
};
