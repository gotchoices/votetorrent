import type {
	NetworkReference,
	ISignatureTasksEngine,
	SID,
	SignatureResult,
	SignatureTask,
	Proposal,
	Signature,
	Timestamp,
	AuthoritySignatureTask,
	NetworkSignatureTask,
	ElectionSignatureTask,
	ElectionRevisionSignatureTask,
	BallotSignatureTask,
	Authority,
	AuthorityInit,
	ElectionInit,
	BallotInit,
	// Assuming the following types are available from @votetorrent/vote-core or its sub-paths
	// based on the previously read files. Actual import paths might differ.
	OfficerSelection,
	ThresholdPolicy,
	Scope,
	ImageRef,
	NetworkPolicies,
	TimestampAuthority,
	ElectionCoreInit,
	ElectionRevisionInit,
	KeyholderInvitationContent,
	Question,
	AdminInit,
	NetworkInit,
	AdminSignatureTask,
} from '@votetorrent/vote-core';
import { ElectionEvent, ElectionType } from '@votetorrent/vote-core';

// Mock SID
const MOCK_USER_SID: SID = 'mock-user-sid-sig-123';

// Mock Timestamp
const MOCK_TIMESTAMP: Timestamp = Date.now();

// Mock Signature
const MOCK_SIGNATURE: Signature = {
	signature: 'mock-sig-value-generic',
	signerKey: 'mock-signer-key-generic',
};

// Mock NetworkReference
const MOCK_NETWORK_REFERENCE: NetworkReference = {
	hash: 'sigNet43GaFf',
	relays: ['/ip4/127.0.0.1/tcp/4002/p2p/mock-sig-peer-id'],
	imageUrl: 'https://picsum.photos/500/500?random=3',
	name: 'Signature Task Network General',
	primaryAuthorityDomainName: 'Mock Signature Authority General',
};

// Mock Authority (simplified)
const MOCK_AUTHORITY: Authority = {
	sid: 'mock-authority-sid-gen',
	name: 'Mock General Authority',
	domainName: 'authority.example.com',
	signature: MOCK_SIGNATURE,
};

// --- MOCK PROPOSAL DATA (simplified) ---
const MOCK_ADMINISTRATION_INIT: AdminInit = {
	officers: [
		{
			init: {
				name: 'Admin One',
				title: 'Chief Admin',
				scopes: 'rad',
			},
		},
	],
	thresholdPolicies: [],
	effectiveAt: MOCK_TIMESTAMP,
};

const MOCK_AUTHORITY_INIT: AuthorityInit = {
	name: 'New Mock Authority',
	domainName: 'new.authority.example.com',
};

const MOCK_NETWORK_INIT: NetworkInit = {
	name: 'Revised Mock Network',
	imageUrl: 'https://picsum.photos/500/500?random=4',
	relays: ['/ip4/127.0.0.1/tcp/4003/p2p/mock-rev-peer-id'],
	policies: {
		timestampAuthorities: [
			{ url: 'http://tsa.example.com' } as TimestampAuthority,
		],
		numberRequiredTSAs: 1,
		electionType: ElectionType.official,
	},
	admin: MOCK_ADMINISTRATION_INIT,
	primaryAuthority: MOCK_AUTHORITY_INIT,
};

const MOCK_ELECTION_CORE_INIT: ElectionCoreInit = {
	sid: 'mock-election-core-sid',
	authoritySid: MOCK_AUTHORITY.sid,
	title: 'Mock Core Election',
	date: MOCK_TIMESTAMP + 86400000, // Tomorrow
	revisionDeadline: MOCK_TIMESTAMP + 172800000, // Day after tomorrow
	type: ElectionType.official,
};

const MOCK_ELECTION_REVISION_INIT: ElectionRevisionInit = {
	electionSid: MOCK_ELECTION_CORE_INIT.sid,
	revision: 1,
	revisionTimestamp: [MOCK_TIMESTAMP],
	tags: ['mock', 'initial'],
	instructions: '## Mock Election Instructions',
	keyholders: [{ name: 'Keyholder One' } as KeyholderInvitationContent], // Simplified
	timeline: {
		[ElectionEvent.registrationEnds]: MOCK_TIMESTAMP + 86400000 * 3,
		[ElectionEvent.ballotsFinal]: MOCK_TIMESTAMP + 86400000 * 4,
		[ElectionEvent.votingStarts]: MOCK_TIMESTAMP + 86400000 * 5,
		[ElectionEvent.tallyingStarts]: MOCK_TIMESTAMP + 86400000 * 6,
		[ElectionEvent.validation]: MOCK_TIMESTAMP + 86400000 * 7,
		[ElectionEvent.certificationStarts]: MOCK_TIMESTAMP + 86400000 * 8,
		[ElectionEvent.closed]: MOCK_TIMESTAMP + 86400000 * 9,
	} as Record<ElectionEvent, number>,
	keyholderThreshold: 1,
};

const MOCK_ELECTION_INIT: ElectionInit = {
	election: MOCK_ELECTION_CORE_INIT,
	revision: MOCK_ELECTION_REVISION_INIT,
};

const MOCK_BALLOT_INIT: BallotInit = {
	sid: 'mock-ballot-sid',
	electionSid: MOCK_ELECTION_CORE_INIT.sid,
	authoritySid: MOCK_AUTHORITY.sid,
	description: 'Mock Ballot for Something Important',
	districts: ['District A'],
	questions: [
		// Simplified Question
		{
			code: 'Q1',
			title: 'What is your favorite color?',
			instructions: 'Pick one.',
			options: [{ code: 'red', title: 'Red' }],
			type: 'select',
		} as Question,
	],
	timestamp: MOCK_TIMESTAMP,
};

// --- MOCK PROPOSALS ---
const MOCK_PROPOSAL_ADMINISTRATION: Proposal<AdminInit> = {
	proposed: MOCK_ADMINISTRATION_INIT,
	timestamp: MOCK_TIMESTAMP,
	signatures: [MOCK_SIGNATURE],
};

const MOCK_PROPOSAL_AUTHORITY: Proposal<AuthorityInit> = {
	proposed: MOCK_AUTHORITY_INIT,
	timestamp: MOCK_TIMESTAMP,
	signatures: [MOCK_SIGNATURE],
};

const MOCK_PROPOSAL_NETWORK_REVISION: Proposal<NetworkInit> = {
	proposed: MOCK_NETWORK_INIT,
	timestamp: MOCK_TIMESTAMP,
	signatures: [MOCK_SIGNATURE],
};

const MOCK_PROPOSAL_ELECTION: Proposal<ElectionInit> = {
	proposed: MOCK_ELECTION_INIT,
	timestamp: MOCK_TIMESTAMP,
	signatures: [MOCK_SIGNATURE],
};

const MOCK_PROPOSAL_BALLOT: Proposal<BallotInit> = {
	proposed: MOCK_BALLOT_INIT,
	timestamp: MOCK_TIMESTAMP,
	signatures: [MOCK_SIGNATURE],
};

// --- MOCK SIGNATURE TASKS ---
const MOCK_ADMINISTRATION_SIGNATURE_TASK: AdminSignatureTask = {
	type: 'signature',
	network: MOCK_NETWORK_REFERENCE,
	userSid: MOCK_USER_SID,
	signatureType: 'admin',
	administration: MOCK_PROPOSAL_ADMINISTRATION,
	authority: MOCK_AUTHORITY,
};

const MOCK_AUTHORITY_SIGNATURE_TASK: AuthoritySignatureTask = {
	type: 'signature',
	network: MOCK_NETWORK_REFERENCE,
	userSid: MOCK_USER_SID,
	signatureType: 'authority',
	authority: MOCK_PROPOSAL_AUTHORITY,
};

// Commenting out the helper for combined data as it's not needed with the correct type understanding
// const MOCK_COMBINED_NETWORK_DATA_FOR_TASK: NetworkReference & Proposal<NetworkRevisionInit> = {
//     hash: MOCK_ADORNED_NETWORK_REFERENCE.hash,
//     relays: MOCK_ADORNED_NETWORK_REFERENCE.relays,
//     imageUrl: MOCK_ADORNED_NETWORK_REFERENCE.imageUrl,
//     name: MOCK_ADORNED_NETWORK_REFERENCE.name,
//     primaryAuthorityDomainName: MOCK_ADORNED_NETWORK_REFERENCE.primaryAuthorityDomainName,
//     proposed: MOCK_PROPOSAL_NETWORK_REVISION.proposed,
//     timestamp: MOCK_PROPOSAL_NETWORK_REVISION.timestamp,
//     signatures: MOCK_PROPOSAL_NETWORK_REVISION.signatures,
// };

const MOCK_NETWORK_SIGNATURE_TASK: NetworkSignatureTask = {
	type: 'signature',
	network: MOCK_NETWORK_REFERENCE, // This is NetworkReference from SignatureTask
	userSid: MOCK_USER_SID,
	signatureType: 'network',
	networkRevision: MOCK_PROPOSAL_NETWORK_REVISION, // This is the new Proposal<NetworkRevisionInit> field
};

const MOCK_ELECTION_SIGNATURE_TASK: ElectionSignatureTask = {
	type: 'signature',
	network: MOCK_NETWORK_REFERENCE,
	userSid: MOCK_USER_SID,
	signatureType: 'election',
	election: MOCK_PROPOSAL_ELECTION,
};

const MOCK_ELECTION_REVISION_SIGNATURE_TASK: ElectionRevisionSignatureTask = {
	type: 'signature',
	network: MOCK_NETWORK_REFERENCE,
	userSid: MOCK_USER_SID,
	signatureType: 'election-revision',
	election: MOCK_PROPOSAL_ELECTION,
};

const MOCK_BALLOT_SIGNATURE_TASK: BallotSignatureTask = {
	type: 'signature',
	network: MOCK_NETWORK_REFERENCE,
	userSid: MOCK_USER_SID,
	signatureType: 'ballot',
	ballot: MOCK_PROPOSAL_BALLOT,
};

const MOCK_PENDING_SIGNATURE_TASKS: SignatureTask[] = [
	MOCK_ADMINISTRATION_SIGNATURE_TASK,
	MOCK_AUTHORITY_SIGNATURE_TASK,
	MOCK_NETWORK_SIGNATURE_TASK, // Updated to the correct structure
	MOCK_ELECTION_SIGNATURE_TASK,
	MOCK_ELECTION_REVISION_SIGNATURE_TASK,
	MOCK_BALLOT_SIGNATURE_TASK,
];

export class MockSignatureTasksEngine implements ISignatureTasksEngine {
	private pendingTasks: SignatureTask[] = [...MOCK_PENDING_SIGNATURE_TASKS];
	constructor() {}

	completeSignature(
		task: SignatureTask,
		result: SignatureResult
	): Promise<void> {
		this.pendingTasks = this.pendingTasks.filter((t) => {
			return t !== task;
		});
		return Promise.resolve();
	}
	getRequestedSignatures(pending: boolean): Promise<SignatureTask[]> {
		if (pending) {
			return Promise.resolve([...this.pendingTasks]);
		}
		return Promise.resolve([]);
	}
}
