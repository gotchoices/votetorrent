import type { ImageRef, SID } from '../common';
import type { Invitation } from '../invitation/models';
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

	/** SID of the invitation to the authority */
	invitationSid?: SID;

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

export type AuthorityContent = {
	/** SID of the Authority issuing the invitation */
	authoritySid: string;
};

export type AuthorityInvitationContent = AuthorityContent & {
	/** Suggested name for the new Authority */
	name: string;
};

export type AuthorityInvitation = Invitation<AuthorityInvitationContent> & {
	type: 'Authority';
};

/*********** Administration ***********/
export type Administration = {
	/** Sovereign ID of the administration */
	sid: SID;

	/** The authority's sid */
	authoritySid: SID;

	/** The administrators */
	administrators: Administrator[];

	/** The threshold policies */
	thresholdPolicies: ThresholdPolicy[];

	/** The expiration date of this administration */
	expiration: Timestamp;

	/** The previous administration's signatures of this record (if there was one) */
	signatures?: Signature[];
};

export type AdministrationInit = {
	/** The administrators */
	administrators: AdministratorSelection[];

	/** Threshold policies */
	thresholdPolicies: ThresholdPolicy[];
};

export type AdministrationDetails = {
	/** The administration */
	administration: Administration;

	/** The proposed changes to the administration */
	proposed?: Proposal<AdministrationInit>;
};

/*********** Administrator ***********/
export type Administrator = {
	/** Sovereign ID of the administrator's user */
	userSid: SID;

	/** Title of the administrator */
	title: string;

	/** Scopes of the administrator */
	scopes: Scope[];

	/** The signature of this record by this user */
	signature: Signature;
};

export type AdministratorInit = {
	/** Suggested name of the administrator (informational for targeting the right person) */
	name: string;

	/** Title of the administrator */
	title: string;

	/** Scopes of the administrator */
	scopes: Scope[];
};

export type AdministratorSelection = {
	/** If it's a new administrator */
	init?: AdministratorInit;

	/** If it's an existing administrator */
	existing?: Administrator;
};

export type AdministratorInvitationContent = AuthorityContent &
	AdministratorInit;

export type AdministratorInvitation =
	Invitation<AdministratorInvitationContent> & {
		type: 'Administrator';
	};

/** Scope codes representing different administrator privileges */
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
