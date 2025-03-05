import type { Timestamp } from "../common/timestamp";

export type Authority = {
	/** Sovereign ID of the authority */
	said: string;

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
	said: string;

	/** Public key of the administrator */
	key: string;

	/** Name of the administrator */
	name: string;

	/** Role of the administrator - Note: may be an automated IT system */
	role: string;

	/** URL of the administrator's image */
	imageUrl?: string;

	/** CID of the administrator's image */
	imageCid?: string;
}

export type Administration = {
	/** Sovereign ID of the administration */
	said: string;

	/** The authority's said */
	authoritySaid: string;

	/** The administrators */
	administrators: Administrator[];

	/** The expiration date of this administration */
	expiration: Timestamp;

	/** The previous administration's signature of this record (if there was one) */
	signature?: string;
}
