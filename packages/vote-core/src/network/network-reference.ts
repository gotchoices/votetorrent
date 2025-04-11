export type NetworkReference = {
	/** Hash of name and primaryAuthoritySid - encoded into the network protocols */
	hash: string;	
	/** The optional image for the network (published by the primary authority) - this should be verified once connected to prevent spoofing */
	imageUrl?: string;
	/** One or more multiaddresses to stable hosts, necessary to initially connect to the network */
	relays: string[];
}
