export interface Authority {
		/** CID of the authority */
		cid: string,

    /** Public key of the authority */
    key: string,

		/** Official, legal name */
    name: string,

		/** Registered domain name of the authority */
    domainName: string,

		/** URL of the REST API */
    apiAddress: string,

		/** Bootstrap multiaddress of peer 2 peer network */
		p2pAddress: string,

		/** Authority's signature of digest */
    signature: string,
}
