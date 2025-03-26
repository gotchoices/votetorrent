export type Network = {
	name: string;
	primaryAuthoritySid: string;
	hash: string;	// Hash of name and primaryAuthoritySid - encoded into the network protocols
	imageUrl?: string;
	imageCid?: string;
	// ... any other network-wide policies here
	signature: string;	// Signature of the authority of the primary authority's administration
}
