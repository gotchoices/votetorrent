import type { ReleaseKeyTask } from '@votetorrent/vote-core';
import { KeysTasksEngine } from './keys-tasks-engine';
import {
	ElectionEvent, // Import as value for enum usage
	ElectionType, // Import as value for enum usage
} from '@votetorrent/vote-core';
import type {
	ElectionDetails,
	SID,
	ElectionCore,
	ElectionRevision,
	KeyholderInvitation,
	Timestamp,
	Signature,
	NetworkReference,
	KeyholderInvitationContent,
	InvitationSlot,
	InvitationStatus,
} from '@votetorrent/vote-core';

// Mock SID
const MOCK_USER_SID: SID = 'mock-user-sid-123';
const MOCK_ELECTION_SID: SID = 'mock-election-sid-456';
const MOCK_AUTHORITY_SID: SID = 'mock-authority-sid-789';

// Mock Timestamp (simplified)
const MOCK_TIMESTAMP: Timestamp = Date.now();

// Mock NetworkReference
const MOCK_NETWORK_REFERENCE: NetworkReference = {
	hash: 'as43GaFf',
	relays: ['/ip4/127.0.0.1/tcp/4001/p2p/mock-peer-id'],
	imageUrl: 'https://picsum.photos/500/500?random=2',
	name: 'Republican Primary Election',
	primaryAuthorityDomainName: 'Utah State Republican Party',
};

// Mock Signature
const MOCK_SIGNATURE_1: Signature = {
	signature: 'mock-signature-value-abcdef123456',
	signerKey: 'mock-signer-key-admin-001',
};

const MOCK_SIGNATURE_2: Signature = {
	signature: 'mock-signature-value-uvwxyz789012',
	signerKey: 'mock-signer-key-keyholder-002',
};

// Mock KeyholderInvitationContent
const MOCK_KEYHOLDER_INVITATION_CONTENT: KeyholderInvitationContent = {
	name: 'Mock Keyholder One',
};

// Mock InvitationSlot for KeyholderInvitationContent (used within KeyholderInvitation)
const MOCK_KH_INV_CONTENT_SLOT: InvitationSlot<KeyholderInvitationContent> = {
	invite: MOCK_KEYHOLDER_INVITATION_CONTENT,
	type: 'k', // A descriptive type for this specific slot structure
	expiration: MOCK_TIMESTAMP + 1000 * 60 * 60 * 24 * 7, // 7 days
};

// Mock KeyholderInvitation
const MOCK_KEYHOLDER_INVITATION: KeyholderInvitation = {
	slot: MOCK_KH_INV_CONTENT_SLOT, // This is InvitationSlot<KeyholderInvitationContent>
	privateKey: 'mock-private-key-for-keyholder-invitation',
	networkRef: MOCK_NETWORK_REFERENCE,
	type: 'Keyholder', // This is the discriminator for KeyholderInvitation
};

// Mock InvitationSlot for KeyholderInvitation (this is what ElectionRevision.keyholders expects)
const MOCK_KEYHOLDER_INVITATION_SLOT_FOR_STATUS: InvitationSlot<KeyholderInvitation> =
	{
		invite: MOCK_KEYHOLDER_INVITATION, // The actual KeyholderInvitation
		type: 'k', // Matches KeyholderInvitation.type
		expiration: MOCK_TIMESTAMP + 1000 * 60 * 60 * 24 * 14, // 14 days
	};

// Mock InvitationStatus for KeyholderInvitation
const MOCK_KEYHOLDER_INVITATION_STATUS: InvitationStatus<KeyholderInvitation> =
	{
		slot: MOCK_KEYHOLDER_INVITATION_SLOT_FOR_STATUS,
		sent: {
			key: 'mock-sent-key',
			signatures: [MOCK_SIGNATURE_1],
		},
		result: {
			userSid: 'mock-keyholder-user-sid',
			isAccepted: true,
			invitationSignature: 'mock-invitation-signature-value',
			invokedSid: 'mock-invoked-keyholder-sid',
		},
	};

// Mock ElectionCore
const MOCK_ELECTION_CORE: ElectionCore = {
	sid: MOCK_ELECTION_SID,
	authoritySid: MOCK_AUTHORITY_SID,
	title: 'Mock General Election 2024',
	date: new Date('2024-11-05T00:00:00.000Z').getTime(),
	revisionDeadline: new Date('2024-10-01T00:00:00.000Z').getTime(),
	type: ElectionType.official,
	signature: MOCK_SIGNATURE_1,
};

// Mock ElectionRevision
const MOCK_ELECTION_REVISION: ElectionRevision = {
	electionSid: MOCK_ELECTION_SID,
	revision: 1,
	revisionTimestamp: [MOCK_TIMESTAMP],
	tags: ['general', 'mock'],
	instructions:
		'## Mock Election Instructions\n\nPlease follow all mock procedures.',
	keyholders: [MOCK_KEYHOLDER_INVITATION_STATUS],
	timeline: {
		[ElectionEvent.registrationEnds]: new Date(
			'2024-10-15T00:00:00.000Z'
		).getTime(),
		[ElectionEvent.votingStarts]: new Date(
			'2024-10-20T00:00:00.000Z'
		).getTime(),
		[ElectionEvent.ballotsFinal]: new Date(
			'2024-10-25T00:00:00.000Z'
		).getTime(),
		[ElectionEvent.tallyingStarts]: new Date(
			'2024-10-30T00:00:00.000Z'
		).getTime(),
		[ElectionEvent.validation]: new Date('2024-11-01T00:00:00.000Z').getTime(),
		[ElectionEvent.closed]: new Date('2024-11-10T00:00:00.000Z').getTime(),
	} as Record<ElectionEvent, number>,
	keyholderThreshold: 1,
	signature: MOCK_SIGNATURE_2,
};

// Mock ElectionDetails
const MOCK_ELECTION_DETAILS: ElectionDetails = {
	election: MOCK_ELECTION_CORE,
	current: MOCK_ELECTION_REVISION,
};

// Mock ReleaseKeyTask
const MOCK_RELEASE_KEY_TASK_1: ReleaseKeyTask = {
	type: 'release-key',
	network: MOCK_NETWORK_REFERENCE,
	election: MOCK_ELECTION_DETAILS,
	userSid: MOCK_USER_SID,
};

const MOCK_RELEASE_KEY_TASK_2: ReleaseKeyTask = {
	type: 'release-key',
	network: {
		...MOCK_NETWORK_REFERENCE,
		hash: 'sdj36fF',
		name: 'Utah State Elections',
	},
	election: {
		...MOCK_ELECTION_DETAILS,
		election: {
			...MOCK_ELECTION_DETAILS.election,
			sid: MOCK_ELECTION_SID,
			title: 'Repubican Primary Election',
		},
	},
	userSid: MOCK_USER_SID,
};

const MOCK_PENDING_RELEASE_KEY_TASKS: ReleaseKeyTask[] = [
	MOCK_RELEASE_KEY_TASK_1,
];
const MOCK_COMPLETED_RELEASE_KEY_TASKS: ReleaseKeyTask[] = [
	MOCK_RELEASE_KEY_TASK_2,
];

export class MockKeysTasksEngine extends KeysTasksEngine {
	async completeKeyRelease(
		task: ReleaseKeyTask
		//keyShares: FinalShareData
	): Promise<void> {
		const index = MOCK_PENDING_RELEASE_KEY_TASKS.findIndex(
			(t) =>
				t.userSid === task.userSid &&
				t.election.election.sid === task.election.election.sid
		);
		if (index > -1) {
			const completedTask = MOCK_PENDING_RELEASE_KEY_TASKS.splice(index, 1)[0];
			if (completedTask) {
				MOCK_COMPLETED_RELEASE_KEY_TASKS.push(completedTask);
			}
		}
		return Promise.resolve();
	}

	async getKeysToRelease(pending: boolean): Promise<ReleaseKeyTask[]> {
		console.log(
			`MockKeysTasksEngine: getKeysToRelease called with pending=${pending}`
		);
		if (pending) {
			return Promise.resolve([...MOCK_PENDING_RELEASE_KEY_TASKS]);
		}
		return Promise.resolve([...MOCK_COMPLETED_RELEASE_KEY_TASKS]);
	}
}
