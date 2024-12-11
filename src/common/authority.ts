export interface Authority {
		/** CID of the authority */
		cid: string,

    /** Public key of the authority */
    key: string,

		/** Official, legal name */
    name: string,
}

export interface AuthorityInfrastructure {
	/** CID of the authority */
	authorityCid: string,

	/** Expiration date of this record */
	expires: number,

	/** Registered domain name of the authority */
	domainName: string,

	/** URL of the REST API */
	apiAddress: string,

	/** Bootstrap multiaddresses of peer 2 peer network */
	p2pAddresses: string[],

	/** The administrations signature of this record */
	signature: string,
}

export interface Administrator {
	/** CID of the administrator */
	cid: string,

	/** Name of the administrator */
	name: string,

	/** Public key of the administrator */
	key: string,
}

export interface Administration {
	/** CID of this administration */
	cid: string,

	/** CID of the authority */
	authorityCid: string,

	/** The combined public key of the administrators */
	key: string,

	/** The administrators */
	administrators: Administrator[],

	/** Expiration date of this administration record */
	expires: number,

	/** The administrator's signature of this record */
	signature: string,
}
