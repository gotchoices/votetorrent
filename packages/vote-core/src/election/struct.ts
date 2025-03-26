export type ElectionEngineInit = {
	/** The name for the network (published by the primary authority) - this should be verified once connected to prevent spoofing */
	name: string;
	/** The optional image for the network (published by the primary authority) - this should be verified once connected to prevent spoofing */
	imageUrl?: string;
	/** One or more multiaddresses to stable hosts, necessary to initially connect to the network */
	bootstrap: string[];
	/** The SAID of the primary authority, also used to identify the network's protocol */
	primaryAuthoritySid: string;
}
