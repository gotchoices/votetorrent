import type { ImageRef, SID } from '../common';
import type { Invitation, InvitationContent } from '../invitation/models';
import type {
	Proposal,
	Signature,
	Timestamp,
	ThresholdPolicy,
} from '../common/index.js';

/*********** Authority ***********/
export type Authority = {
	/** Sovereign ID of the authority */
	sid: SID;

	/** Official, legal name */
	name: string;

	/** Registered domain name of the authority */
	domainName: string;

	/** Image reference for the authority */
	imageRef?: ImageRef;

	/** The signature of this record by the current administration */
	signature: Signature;
};

export type AuthorityInit = {
	/** Name of the authority */
	name: string;

	/** Domain name of the authority */
	domainName: string;

	/** Image reference for the authority */
	imageRef?: ImageRef;
};

export type AuthorityDetails = {
	/** The authority */
	authority: Authority;

	/** The proposed changes to the authority */
	proposed?: Proposal<AuthorityInit>;
};

export type AuthorityInvitationContent = InvitationContent & {
	/** Suggested name for the new Authority */
	name: string;

	/** The type of the invitation */
	type: 'au';
};

export type AuthorityInvitation = Invitation<AuthorityInvitationContent> & {
	type: 'Authority';
};

/*********** Administration ***********/
export type Admin = {
	/** Sovereign ID of the administration */
	sid: SID;

	/** The authority's sid */
	authoritySid: SID;

	/** The officers */
	officers: Officer[];

	/** The threshold policies */
	thresholdPolicies: ThresholdPolicy[];

	/** The expiration date of this administration */
	expiration: Timestamp;

	/** The previous administration's signatures of this record (if there was one) */
	signatures?: Signature[];
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
	/** Sovereign ID of the officer's user */
	userSid: SID;

	/** Title of the officer */
	title: string;

	/** Scopes of the officer */
	scopes: Scope[];

	/** The signature of this record by this user */
	signature: Signature;
};

export type OfficerInit = {
	/** Suggested name of the officer (informational for targeting the right person) */
	name: string;

	/** Title of the officer */
	title: string;

	/** Scopes of the officer, comma separated list of scope codes */
	scopes: string;
};

export type OfficerSelection = {
	/** If it's a new officer */
	init?: OfficerInit;

	/** If it's an existing officer */
	existing?: Officer;
};

export type OfficerInvitationContent = InvitationContent &
	OfficerInit & {
		/** The type of the invitation */
		type: 'of';
	};

export type OfficerInvitation = Invitation<OfficerInvitationContent> & {
	type: 'Officer';
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
