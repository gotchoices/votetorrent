import type {
	AdornedNetworkReference,
	Authority,
	ImageRef,
	Signature,
	SID,
	Network,
	NetworkPolicies,
	NetworkRevision,
	NetworkDetails,
	NetworkRevisionInit,
	ElectionType,
	TimestampAuthority,
	HostingProvider,
	DefaultUser,
	User,
	UserKey,
	UserHistory,
	CreateUserHistory,
	AddUserKeyHistory,
	ReviseUserHistory,
	RevokeUserKeyHistory,
	Administrator,
	ThresholdPolicy,
	Scope,
	Administration,
	AdministrationInit,
	Proposal,
	AdministrationDetails,
} from '@votetorrent/vote-core';
import { UserHistoryEvent, UserKeyType } from '@votetorrent/vote-core';

// Function to generate a plausible SID with a prefix
export const generateSid = (prefix: string, hashLength: number = 16): SID => {
	const characters =
		'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let result = '';
	for (let i = 0; i < hashLength; i++) {
		result += characters.charAt(Math.floor(Math.random() * characters.length));
	}
	return `${prefix}-${result}` as SID;
};

// Define a standard mock signature object
export const MOCK_SIGNATURE: Signature = {
	signature: 'mock-signature-value-1234567890abcdefghijklmnopqrstuvwxyz',
	signerKey: 'mock-signer-key-abcdefghijklmnopqrstuvwxyz1234567890',
};

// Helper function to get Unix timestamp
export const getUnixTimestamp = (date: Date): number =>
	Math.floor(date.getTime() / 1000);

export const MOCK_NETWORKS: AdornedNetworkReference[] = [
	{
		hash: 'mock-network-hash-utah-123',
		imageUrl: 'https://picsum.photos/500/500?random=1',
		name: 'Utah State Network',
		primaryAuthorityDomainName: 'utah.gov',
		relays: ['/ip4/127.0.0.1/tcp/8080/p2p/QmRelayExample1'],
	},
	{
		hash: 'mock-network-hash-idaho-456',
		imageUrl: 'https://picsum.photos/500/500?random=2',
		name: 'Idaho State Network',
		primaryAuthorityDomainName: 'idaho.gov',
		relays: ['/ip4/127.0.0.1/tcp/8080/p2p/QmRelayExample2'],
	},
	{
		hash: 'mock-network-hash-calif-789',
		imageUrl: 'https://picsum.photos/500/500?random=3',
		name: 'California State Network',
		primaryAuthorityDomainName: 'ca.gov',
		relays: ['/ip4/127.0.0.1/tcp/8080/p2p/QmRelayExample3'],
	},
];

// --- Mock Authority Data ---
export const MOCK_AUTHORITIES: Authority[] = [
	{
		sid: generateSid('auth'),
		name: 'Salt Lake County',
		domainName: 'slco.org',
		imageRef: {
			cid: 'mock-cid-slco',
			url: 'https://picsum.photos/500/500?random=101',
		},
		signature: MOCK_SIGNATURE,
	},
	{
		sid: generateSid('auth'),
		name: 'Utah County',
		domainName: 'utahcounty.gov',
		imageRef: {
			cid: 'mock-cid-utahco',
			url: 'https://picsum.photos/500/500?random=102',
		},
		signature: MOCK_SIGNATURE,
	},
	{
		sid: generateSid('auth'),
		name: 'Ada County',
		domainName: 'adacounty.id.gov',
		imageRef: {
			cid: 'mock-cid-ada',
			url: 'https://picsum.photos/500/500?random=103',
		},
		signature: MOCK_SIGNATURE,
	},
	{
		sid: generateSid('auth'),
		name: 'Canyon County',
		domainName: 'canyonco.org',
		imageRef: {
			cid: 'mock-cid-canyon',
			url: 'https://picsum.photos/500/500?random=104',
		},
		signature: MOCK_SIGNATURE,
	},
	{
		sid: generateSid('auth'),
		name: 'Los Angeles County',
		domainName: 'lavote.gov',
		imageRef: {
			cid: 'mock-cid-la',
			url: 'https://picsum.photos/500/500?random=105',
		},
		signature: MOCK_SIGNATURE,
	},
	{
		sid: generateSid('auth'),
		name: 'San Diego County',
		domainName: 'sdvote.com',
		imageRef: {
			cid: 'mock-cid-sd',
			url: 'https://picsum.photos/500/500?random=106',
		},
		signature: MOCK_SIGNATURE,
	},
	{
		sid: generateSid('auth-ut'),
		name: 'State of Utah',
		domainName: 'utah.gov',
		imageRef: {
			cid: 'mock-cid-ut-state',
			url: 'https://picsum.photos/500/500?random=107',
		},
		signature: MOCK_SIGNATURE,
	},
	{
		sid: generateSid('auth-id'),
		name: 'State of Idaho',
		domainName: 'idaho.gov',
		imageRef: {
			cid: 'mock-cid-id-state',
			url: 'https://picsum.photos/500/500?random=108',
		},
		signature: MOCK_SIGNATURE,
	},
	{
		sid: generateSid('auth-ca'),
		name: 'State of California',
		domainName: 'ca.gov',
		imageRef: {
			cid: 'mock-cid-ca-state',
			url: 'https://picsum.photos/500/500?random=109',
		},
		signature: MOCK_SIGNATURE,
	},
];

// --- Network Specific Data (Primarily for Utah State Network) ---

// Helper to find a network by name, throwing if not found for critical mocks
const findNetworkOrThrow = (name: string): AdornedNetworkReference => {
	const network = MOCK_NETWORKS.find((n) => n.name === name);
	if (!network) {
		throw new Error(
			`Mock data generation error: Network named '${name}' not found in MOCK_NETWORKS.`
		);
	}
	return network;
};

// Helper to find an authority by name, throwing if not found
const findAuthorityOrThrow = (name: string): Authority => {
	const authority = MOCK_AUTHORITIES.find((a) => a.name === name);
	if (!authority) {
		throw new Error(
			`Mock data generation error: Authority named '${name}' not found in MOCK_AUTHORITIES.`
		);
	}
	return authority;
};

export const UTAH_STATE_NETWORK_REF = findNetworkOrThrow('Utah State Network');
// Find the designated primary authority using the *new* name
export const UTAH_PRIMARY_AUTHORITY = findAuthorityOrThrow('State of Utah');

// This specific adorned reference can be used where an explicit one for Utah is needed.
export const MOCK_UTAH_ADORNED_NETWORK_REFERENCE: AdornedNetworkReference =
	UTAH_STATE_NETWORK_REF;

// Rename to shared policies
export const MOCK_SHARED_NETWORK_POLICIES: NetworkPolicies = {
	numberRequiredTSAs: 1,
	timestampAuthorities: [{ url: 'https://timestamp.digicert.com' }],
	electionType: 'adhoc' as ElectionType,
};

export const MOCK_UTAH_NETWORK: Network = {
	hash: UTAH_STATE_NETWORK_REF.hash,
	sid: UTAH_PRIMARY_AUTHORITY.sid,
	signature: MOCK_SIGNATURE,
};

export const MOCK_UTAH_NETWORK_REVISION: NetworkRevision = {
	networkSid: UTAH_PRIMARY_AUTHORITY.sid,
	revision: 1,
	timestamp: getUnixTimestamp(new Date(Date.now() - 1000 * 60 * 60 * 24 * 30)),
	name: UTAH_STATE_NETWORK_REF.name,
	imageRef: { cid: 'mock-cid-ut-rev1', url: UTAH_STATE_NETWORK_REF.imageUrl },
	relays: UTAH_STATE_NETWORK_REF.relays,
	policies: MOCK_SHARED_NETWORK_POLICIES,
	signature: MOCK_SIGNATURE,
};

// Define shared proposed network revision
export const MOCK_SHARED_NETWORK_REVISION_PROPOSAL: Proposal<NetworkRevisionInit> =
	{
		proposed: {
			revision: 2,
			timestamp: getUnixTimestamp(
				new Date(Date.now() - 1000 * 60 * 60 * 24 * 2)
			),
			name: `Network Revision Proposal v2`,
			imageRef: {
				cid: 'mock-cid-prop-rev2',
				url: 'https://picsum.photos/500/500?random=10',
			},
			relays: ['/ip4/127.0.0.1/tcp/9091/p2p/QmSharedProposalRelay'],
			policies: MOCK_SHARED_NETWORK_POLICIES,
		} as NetworkRevisionInit,
		signatures: [MOCK_SIGNATURE],
		timestamp: getUnixTimestamp(new Date(Date.now() - 1000 * 60 * 60 * 24 * 2)),
	};

export const MOCK_UTAH_NETWORK_DETAILS: NetworkDetails = {
	network: MOCK_UTAH_NETWORK,
	current: MOCK_UTAH_NETWORK_REVISION,
	proposed: MOCK_SHARED_NETWORK_REVISION_PROPOSAL,
};

// --- Mock Hosting Providers ---
export const MOCK_HOSTING_PROVIDERS: HostingProvider[] = [
	{
		description:
			'Specialized in secure election infrastructure with 99.99% uptime',
		handoffUrl: 'https://casa-de-vote.example.com/handoff',
		informationUrl: 'https://casa-de-vote.example.com',
		name: 'Casa de Vote',
	},
	{
		description: 'Dedicated election hosting with end-to-end encryption',
		handoffUrl: 'https://electioncloud.example.com/handoff',
		informationUrl: 'https://electioncloud.example.com',
		name: 'ElectionCloud',
	},
	{
		description: 'Professional election hosting with 24/7 support',
		handoffUrl: 'https://votehost-pro.example.com/handoff',
		informationUrl: 'https://votehost-pro.example.com',
		name: 'VoteHost Pro',
	},
];

// --- Mock User Data ---

export const MOCK_DEFAULT_USER: DefaultUser = {
	name: 'Jane Doe',
	image: { url: 'https://picsum.photos/200/200?random=201' },
};

// --- Mock User Data (for MockUserEngine) ---

export const MOCK_USER_KEYS: UserKey[] = [
	{
		key: 'mock-key-mobile-1',
		type: UserKeyType.mobile,
		expiration: getUnixTimestamp(
			new Date(Date.now() + 1000 * 60 * 60 * 24 * 365)
		),
	},
	{
		key: 'mock-key-yubico-1',
		type: UserKeyType.yubico,
		expiration: getUnixTimestamp(
			new Date(Date.now() + 1000 * 60 * 60 * 24 * 730)
		),
	},
	{
		key: 'mock-key-mobile-2',
		type: UserKeyType.mobile,
		expiration: getUnixTimestamp(
			new Date(Date.now() + 1000 * 60 * 60 * 24 * 90)
		),
	},
];

export const MOCK_CURRENT_USER: User = {
	sid: generateSid('user'),
	name: 'Alice Wonderland',
	image: { url: 'https://picsum.photos/200/200?random=202' },
	activeKeys: [MOCK_USER_KEYS[0]!, MOCK_USER_KEYS[1]!],
};

export const MOCK_USER_HISTORY_EVENTS: UserHistory[] = [
	// 1. Create User event
	{
		event: UserHistoryEvent.create,
		timestamp: getUnixTimestamp(
			new Date(Date.now() - 1000 * 60 * 60 * 24 * 10)
		),
		signature: MOCK_SIGNATURE,
		userKey: MOCK_USER_KEYS[0]!,
		name: MOCK_CURRENT_USER.name,
		image: MOCK_CURRENT_USER.image,
	} as CreateUserHistory,
	// 2. Add a new key event
	{
		event: UserHistoryEvent.addKey,
		timestamp: getUnixTimestamp(new Date(Date.now() - 1000 * 60 * 60 * 24 * 5)),
		signature: MOCK_SIGNATURE,
		userKey: MOCK_USER_KEYS[1]!,
	} as AddUserKeyHistory,
	// 3. Revise User event (e.g., name change)
	{
		event: UserHistoryEvent.revise,
		timestamp: getUnixTimestamp(new Date(Date.now() - 1000 * 60 * 60 * 24 * 2)),
		signature: MOCK_SIGNATURE,
		info: {
			name: 'Alice "Allie" Wonderland',
			image: { url: 'https://picsum.photos/200/200?random=203' },
		},
	} as ReviseUserHistory,
	// 4. Revoke a key event
	{
		event: UserHistoryEvent.revokeKey,
		timestamp: getUnixTimestamp(new Date(Date.now() - 1000 * 60 * 60 * 24 * 1)),
		signature: MOCK_SIGNATURE,
		key: MOCK_USER_KEYS[1]!.key,
	} as RevokeUserKeyHistory,
];

// --- Mock Authority Engine Data (Shared) ---

// const SLCO_AUTHORITY = ... // Lookup still useful if needed elsewhere
// const aliceUserSid = ... // Lookup still useful

export const MOCK_SHARED_ADMINISTRATORS: Administrator[] = [
	{
		scopes: ['rad', 'vrg', 'iad', 'rnp', 'uai'] as Scope[],
		title: 'Chief Election Official',
		userSid: MOCK_CURRENT_USER.sid,
		signature: MOCK_SIGNATURE,
	},
	{
		scopes: ['rad', 'vrg', 'iad'] as Scope[],
		title: 'Deputy Election Official',
		userSid: generateSid('user'),
		signature: MOCK_SIGNATURE,
	},
];

export const MOCK_SHARED_THRESHOLD_POLICIES: ThresholdPolicy[] = [
	{ threshold: 1, policy: 'rn' as Scope },
	{ threshold: 1, policy: 'rad' as Scope },
	{ threshold: 2, policy: 'vrg' as Scope },
	{ threshold: 1, policy: 'iad' as Scope },
	{ threshold: 1, policy: 'rnp' as Scope },
];

export const MOCK_SHARED_ADMINISTRATION: Administration = {
	sid: 'admin-shared-sid',
	authoritySid: 'authority-sid-placeholder-needs-override' as SID,
	administrators: MOCK_SHARED_ADMINISTRATORS,
	thresholdPolicies: MOCK_SHARED_THRESHOLD_POLICIES,
	expiration: getUnixTimestamp(
		new Date(Date.now() + 1000 * 60 * 60 * 24 * 365 * 5)
	),
};

export const MOCK_SHARED_PROPOSED_ADMINISTRATION: Proposal<AdministrationInit> =
	{
		proposed: {
			administrators: MOCK_SHARED_ADMINISTRATORS.map((admin) => ({
				existing: admin,
			})),
			thresholdPolicies: MOCK_SHARED_THRESHOLD_POLICIES,
		} as AdministrationInit,
		timestamp: getUnixTimestamp(new Date(Date.now() - 1000 * 60 * 60 * 24 * 5)),
		signatures: [MOCK_SIGNATURE],
	};

export const MOCK_SHARED_ADMINISTRATION_DETAILS: AdministrationDetails = {
	administration: MOCK_SHARED_ADMINISTRATION,
	proposed: MOCK_SHARED_PROPOSED_ADMINISTRATION,
};
