export interface Authority {
    /** Public key of the authority */
    key: string,
    /** Official, legal name */
    name: string,
    /** Registered domain name of the authority */
    domainName: string,
    /** URL of the REST API */
    apiAddress: string,
    /** Signature of digest consisting of: key, name, and domainName */
    signature: string,
}
