import type { ImageRef, Proposal, SID } from '../common';
import type { AdminInit, AuthorityInit } from '../authority/models';
import type { ElectionType } from '../election/models';

export type Network = {
	/** The hash of the network sovereign ID */
	hash: string;

	/** The optional image for the network */
	imageRef?: ImageRef;

	/** The name for the network */
	name: string;

	/** The policies for the network */
	policies: NetworkPolicies;

	/** The primary authority sovereign ID */
	primaryAuthoritySid: SID;

	/** One or more multiaddresses to stable hosts, necessary to initially connect to the network */
	relays: string[];

	/** The network sovereign ID */
	sid: SID;
};

export type NetworkRevision = {
	/** The optional image for the network */
	imageRef?: ImageRef;

	/** The name for the network */
	name: string;

	/** The policies for the network */
	policies: NetworkPolicies;

	/** One or more multiaddresses to stable hosts, necessary to initially connect to the network */
	relays: string[];
};

export type NetworkDetails = {
	/** The network information published by the primary authority */
	network: Network;

	/** The proposed revision of the network */
	proposed?: Proposal<NetworkRevision>;
};

export type NetworkPolicies = {
	/** The type of election allowed on the network */
	electionType: ElectionType;

	/** The number of required timestamp authorities for the network */
	numberRequiredTSAs: number;

	/** The timestamp authorities (TSAs) for the network */
	timestampAuthorities: TimestampAuthority[];
};

export type NetworkReference = {
	/** Hash of networkSid - encoded into the network protocols */
	hash: string;

	/** The optional image for the network (published by the primary authority) - this should be verified once connected to prevent spoofing
	 * This is a url not an ImageRef because you can't reference a cid from outside the network
	 */
	imageUrl?: string;

	/** The name of the network */
	name: string;

	/** The domain name of the primary authority */
	primaryAuthorityDomainName: string;

	/** One or more multiaddresses to stable hosts, necessary to initially connect to the network */
	relays: string[];
};

export type NetworkInit = {
	/** The initial information for the administration */
	admin: AdminInit;

	/** The image for the network
	 * This is a url not an ImageRef because you can't reference a cid from outside the network
	 */
	imageUrl?: string;

	/** The name of the network */
	name: string;

	/** The policies for the network */
	policies: NetworkPolicies;

	/** The initial information for the primary authority */
	primaryAuthority: AuthorityInit;

	/** The multiaddresses to stable hosts, necessary to initially connect to the network */
	/** Do these neet to be here? alreay in the revision init */
	relays: string[];
};

export type NetworkSummary = {
	/** The hash of the network sovereign ID */
	hash: string;

	/** The optional image for the network
	 * This is a url not an ImageRef because you can't reference a cid from outside the network
	 */
	imageUrl?: string;

	/** The name of the network */
	name: string;

	/** The domain name of the primary authority */
	primaryAuthorityDomainName: string;

	/** The network sovereign ID */
	sid: SID;
};

export type NetworkInfrastructure = {
	/** The configuration of the network */
	configuration: NetworkReference;

	/** The estimated number of nodes in the network */
	estimatedNodes: number;

	/** The estimated number of servers in the network */
	estimatedServers: number;
};

export type HostingProvider = {
	/** The description of the hosting provider */
	description: string;

	/** The URL used to handoff to the hosting provider */
	handoffUrl: string;

	/** The visible URL of the hosting provider */
	informationUrl: string;

	/** The name of the hosting provider */
	name: string;
};

export type TimestampAuthority = {
	/** The URL of the timestamp authority */
	url: string;
};
