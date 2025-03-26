import type { Timestamp } from "../common/timestamp";

export type Authority = {
	/** Sovereign ID of the authority */
	sid: string;

	/** Official, legal name */
	name: string;

	/** Registered domain name of the authority */
	domainName: string;

	/** URL of the authority's image */
	imageUrl?: string;

	/** CID of the authority's image */
	imageCid?: string;

	/** The network information published by the authority */
	network?: AuthorityNetwork;

	/** The signature of this record by the current administration */
	signature: string;
}

/** Network information published by the primary authority */
export type AuthorityNetwork = {
	/** The name for the network */
	name: string;

	/** The optional image for the network */
	imageUrl?: string;

	/** One or more multiaddresses to stable hosts, necessary to initially connect to the network */
	bootstrap: string[];
}

export type Administrator = {
	/** Sovereign ID of the administrator */
	sid: string;

	/** Public key of the administrator */
	key: string;

	/** Name of the administrator */
	name: string;

	/** Title of the administrator */
	title: string;

	/** Scopes of the administrator */
	scopes: Scope[];

	/** URL of the administrator's image */
	imageUrl?: string;

	/** CID of the administrator's image */
	imageCid?: string;

	/** Signatures of the administrator */
	signatures: string[];

	/** CID of the invitation to the administrator */
	invitationCid?: string;
}

export type Administration = {
	/** Sovereign ID of the administration */
	sid: string;

	/** The authority's said */
	authoritySid: string;

	/** The administrators */
	administrators: Administrator[];

	/** The expiration date of this administration */
	expiration: Timestamp;

	/** The previous administration's signatures of this record (if there was one) */
	signatures?: string[];
}

/** Scope codes representing different administrator privileges */
export type Scope = 
    | 'rad'  // Revise or replace the Administration
    | 'vrg'  // Validate registrations
    | 'iad'  // Invite other Authorities
    | 'rnp'  // Revise Network Policies
    | 'uai'  // Update Authority Information
    | 'ceb'  // Create/Edit ballot templates
    | 'mel'  // Manage Elections
    | 'cap'; // Configure Authority Peers

export type AuthorityPeer = {
	/** Reference to the Authority this peer belongs to */
	authoritySid: string;

	/** List of peer node identifiers that can act for this Authority */
	peersIds: string[];

	/** Array of Signature objects validating this peer relationship */
	signatures: string[];
}

export type Signature = {
	/** CID of the administrator that signed this signature */
	administratorCid: string;

	/** When the signature was created */
	timestamp: Timestamp;

	/** The cryptographic signature value */
	value: string;
}

export type InvitationType = "Administrator" | "Authority";

export type Invitation = {
	/** Content ID uniquely identifying this Invitation */
	cid: string;

	/** Type of invitation - Administrator or Authority */
	type: InvitationType;

	/** SID of the Authority issuing the invitation */
	authoritySid: string;

	/** Optional hash of the target's public key if known in advance */
	targetPublicKeyHash?: string;

	/** Random value used to prevent correlation of invitations with their acceptances */
	invitationNonce: string;

	/** Public verification token used to validate the invitation acceptance */
	publicInviteToken: string;

	/** Array of privilege scopes proposed for the new Administrator or Authority */
	proposedScopes: Scope[];

	/** Suggested name for the new Administrator or Authority */
	proposedName: string;

	/** For Authority invitations: suggested domain for the new Authority */
	proposedDomain?: string;

	/** Timestamp when this invitation expires */
	expiration: Timestamp;

	/** Array of Signature objects from Administrators with appropriate invitation scopes */
	signatures: Signature[];

	/** CID of the entity that used this invitation (only populated after use) */
	usedBy?: string;
}

export type AdministratorAcceptance = {
	/** Content ID uniquely identifying this acceptance */
	cid: string;

	/** CID of the invitation being accepted */
	invitationCid: string;

	/** Public key of the new Administrator */
	administratorKey: string;

	/** Name of the new Administrator */
	administratorName: string;

	/** Title of the new Administrator */
	administratorTitle: string;

	/** Array of scopes the Administrator is accepting */
	acceptedScopes: Scope[];

	/** URL pointing to the Administrator's photo or avatar */
	imageUrl?: string;

	/** Content ID pointing to the Administrator's photo or avatar */
	imageCid?: string;

	/** Cryptographic proof that the acceptor possessed the private invitation token */
	proofOfPossession: string;

	/** Signature from the new Administrator's private key, confirming acceptance of the scopes and role */
	signature: Signature;
}

export type AuthorityAcceptance = {
	/** Content ID uniquely identifying this acceptance */
	cid: string;

	/** CID of the invitation being accepted */
	invitationCid: string;

	/** Name of the new Authority */
	authorityName: string;

	/** Domain name of the new Authority */
	domainName: string;

	/** Public key of the initial Administrator */
	initialAdministratorKey: string;

	/** Name of the initial Administrator */
	initialAdministratorName: string;

	/** Title of the initial Administrator */
	initialAdministratorTitle: string;

	/** Array of scopes for the initial Administrator */
	initialAdministratorScopes: Scope[];

	/** Cryptographic proof that the acceptor possessed the private invitation token */
	proofOfPossession: string;

	/** Signature from the initial Administrator's private key */
	signature: Signature;
}