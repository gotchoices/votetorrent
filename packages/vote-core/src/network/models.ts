import type { ImageRef, Proposal, Signature, SID, Timestamp } from '../common';
import type { AdministrationInit, AuthorityInit } from '../authority/models';
import type { ElectionType } from '../election/models';

export type Network = {
	/** The network sovereign ID which is the same as the primary authority's sovereign ID */
	sid: SID;

	/** The hash of the primary authority's sovereign ID */
	hash: string;

	/** The signature by the primary authority */
	signature: Signature;
};

export type NetworkRevision = {
	/** The network's sovereign ID */
	networkSid: SID;

	/** The revision number of the network */
	revision: number;

	/** The timestamp of the revision (untrusted) */
	timestamp: Timestamp;

	/** The name for the network */
	name: string;

	/** The optional image for the network */
	imageRef?: ImageRef;

	/** One or more multiaddresses to stable hosts, necessary to initially connect to the network */
	relays: string[];

	/** The policies for the network */
	policies: NetworkPolicies;

	/** The signature of the network */
	signature: Signature;
};

export type NetworkRevisionInit = {
	/** The network's sovereign ID */
	networkSid: SID;

	/** The revision number of the network */
	revision: number;

	/** The timestamp of the revision (untrusted) */
	timestamp: Timestamp;

	/** The name for the network */
	name: string;

	/** The optional image for the network */
	imageRef?: ImageRef;

	/** One or more multiaddresses to stable hosts, necessary to initially connect to the network */
	relays: string[];

	/** The policies for the network */
	policies: NetworkPolicies;
};

export type NetworkDetails = {
	/** The network information published by the primary authority */
	network: Network;

	/** The current revision of the network */
	current: NetworkRevision;

	/** The proposed revision of the network */
	proposed?: Proposal<NetworkRevisionInit>;
};

export type NetworkPolicies = {
	/** The timestamp authorities (TSAs) for the network */
	timestampAuthorities: TimestampAuthority[];

	/** The number of required timestamp authorities for the network */
	numberRequiredTSAs: number;

	/** The type of election allowed on the network */
	electionType: ElectionType;
};

export type NetworkReference = {
	/** Hash of networkSid - encoded into the network protocols */
	hash: string;
	/** The optional image for the network (published by the primary authority) - this should be verified once connected to prevent spoofing
	 * This is a url not an ImageRef because you can't reference a cid from outside the network
	 */
	imageUrl?: string;
	/** One or more multiaddresses to stable hosts, necessary to initially connect to the network */
	relays: string[];
};

export type AdornedNetworkReference = NetworkReference & {
	/** The name of the network */
	name: string;

	/** The domain name of the primary authority */
	primaryAuthorityDomainName: string;
};

export type NetworkInit = {
	/** The name of the network */
	name: string;

	/** The image for the network
	 * This is a url not an ImageRef because you can't reference a cid from outside the network
	 */
	imageUrl?: string;

	/** The multiaddresses to stable hosts, necessary to initially connect to the network */
	relays: string[];

	/** The initial information for the primary authority */
	primaryAuthority: AuthorityInit;

	/** The initial information for the administration */
	administration: AdministrationInit;
};

export type NetworkSummary = {
	/** The network sovereign ID which is the same as the primary authority's sovereign ID */
	sid: SID;

	/** The hash of the network sovereign ID */
	hash: string;

	/** The name of the network */
	name: string;

	/** The optional image for the network
	 * This is a url not an ImageRef because you can't reference a cid from outside the network
	 */
	imageUrl?: string;

	/** The domain name of the primary authority */
	primaryAuthorityDomainName: string;
};

export type NetworkInfrastructure = {
	/** The estimated number of nodes in the network */
	estimatedNodes: number;

	/** The estimated number of servers in the network */
	estimatedServers: number;

	/** The configuration of the network */
	configuration: AdornedNetworkReference;
};

export type HostingProvider = {
	/** The name of the hosting provider */
	name: string;

	/** The description of the hosting provider */
	description: string;

	/** The visible URL of the hosting provider */
	informationUrl: string;

	/** The URL used to handoff to the hosting provider */
	handoffUrl: string;
};

export type TimestampAuthority = {
	/** The URL of the timestamp authority */
	url: string;
};
