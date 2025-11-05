import type {
	BallotDetails,
	BallotInit,
	ElectionDetails,
	ElectionRevisionInit,
	KeyholderInvitationContent,
	Signature,
	Timestamp,
	BallotSummary,
	IElectionEngine,
} from '@votetorrent/vote-core';
import { ElectionType, ElectionEvent } from '@votetorrent/vote-core';

export class MockElectionEngine implements IElectionEngine {
	getBallotDetails(id: string): Promise<BallotDetails> {
		throw new Error('Not implemented');
	}

	getBallots(): Promise<BallotSummary[]> {
		throw new Error('Not implemented');
	}

	getElectionDetails(): Promise<ElectionDetails> {
		// Mock data for Utah General Election
		const mockElection: ElectionDetails = {
			election: {
				id: 'utah-general-2024',
				authorityId: 'utah-election-authority',
				title: 'Utah General Election 2024',
				date: new Date('2024-11-05').getTime(), // Election Day
				revisionDeadline: new Date('2024-10-15').getTime(), // 3 weeks before election
				type: ElectionType.official,
				signature: 'mock-signature-1' as unknown as Signature,
			},
			current: {
				electionId: 'utah-general-2024',
				revision: 1,
				revisionTimestamp: [new Date().getTime() as Timestamp],
				tags: ['general', 'state', '2024'],
				instructions: `# Utah General Election 2024

This election will determine various state and local offices in Utah, including:
- Governor
- State Legislature
- Congressional Representatives
- State Supreme Court Justices
- Local County Officials

Please review all candidates and measures carefully before voting.`,
				keyholders: [
					{
						slot: {
							invite: {
								slot: {
									invite: {
										name: 'Dr. Sarah Chen',
									},
									type: 'k',
									expiration: new Date('2024-10-15').getTime(),
								},
								privateKey: 'mock-private-key-1',
								networkRef: {
									hash: 'mock-hash-1',
									relays: ['/ip4/127.0.0.1/tcp/4001/p2p/mock-peer-id-1'],
									imageUrl: 'https://picsum.photos/500/500?random=1',
									name: 'Utah State Network',
									primaryAuthorityDomainName: 'utah.gov',
								},
								type: 'Keyholder',
							},
							type: 'k',
							expiration: new Date('2024-10-15').getTime(),
						},
					},
					{
						slot: {
							invite: {
								slot: {
									invite: {
										name: 'Judge Michael Rodriguez',
									},
									type: 'k',
									expiration: new Date('2024-10-15').getTime(),
								},
								privateKey: 'mock-private-key-2',
								networkRef: {
									hash: 'mock-hash-2',
									relays: ['/ip4/127.0.0.1/tcp/4001/p2p/mock-peer-id-2'],
									imageUrl: 'https://picsum.photos/500/500?random=2',
									name: 'Utah State Network',
									primaryAuthorityDomainName: 'utah.gov',
								},
								type: 'Keyholder',
							},
							type: 'k',
							expiration: new Date('2024-10-15').getTime(),
						},
						sent: {
							key: 'mock-sent-key-2',
							signatures: [
								{
									signature: 'mock-signature-2',
									signerKey: 'mock-signer-key-2',
								},
							],
						},
						result: {
							userId: 'mock-user-id-2',
							isAccepted: false,
							invitationSignature: 'mock-invitation-signature-2',
							invokedId: 'mock-invoked-id-2',
						},
					},
					{
						slot: {
							invite: {
								slot: {
									invite: {
										name: 'Prof. James Wilson',
									},
									type: 'k',
									expiration: new Date('2024-10-15').getTime(),
								},
								privateKey: 'mock-private-key-3',
								networkRef: {
									hash: 'mock-hash-3',
									relays: ['/ip4/127.0.0.1/tcp/4001/p2p/mock-peer-id-3'],
									imageUrl: 'https://picsum.photos/500/500?random=3',
									name: 'Utah State Network',
									primaryAuthorityDomainName: 'utah.gov',
								},
								type: 'Keyholder',
							},
							type: 'k',
							expiration: new Date('2024-10-15').getTime(),
						},
						sent: {
							key: 'mock-sent-key-3',
							signatures: [
								{
									signature: 'mock-signature-3',
									signerKey: 'mock-signer-key-3',
								},
							],
						},
						result: {
							userId: 'mock-user-id-3',
							isAccepted: true,
							invitationSignature: 'mock-invitation-signature-3',
							invokedId: 'mock-invoked-id-3',
						},
					},
				],
				timeline: {
					[ElectionEvent.registrationEnds]: new Date('2024-10-25').getTime(),
					[ElectionEvent.ballotsFinal]: new Date('2024-10-15').getTime(),
					[ElectionEvent.votingStarts]: new Date('2024-10-22').getTime(),
					[ElectionEvent.tallyingStarts]: new Date(
						'2024-11-05T20:00:00'
					).getTime(),
					[ElectionEvent.validation]: new Date('2024-11-06').getTime(),
					[ElectionEvent.certificationStarts]: new Date('2024-11-07').getTime(),
					[ElectionEvent.closed]: new Date('2024-11-08').getTime(),
				},
				keyholderThreshold: 3,
				signature: {
					signature: 'mock-signature-2',
					signerKey: 'mock-signer-key-2',
				},
			},
		};

		return Promise.resolve(mockElection);
	}

	inviteKeyholder(
		keyholder: KeyholderInvitationContent,
		electionId: string
	): Promise<void> {
		throw new Error('Not implemented');
	}

	proposeBallot(ballot: BallotInit): Promise<void> {
		throw new Error('Not implemented');
	}

	proposeRevision(revision: ElectionRevisionInit): Promise<void> {
		throw new Error('Not implemented');
	}

	revokeKeyholder(
		keyholder: KeyholderInvitationContent,
		electionId: string
	): Promise<void> {
		throw new Error('Not implemented');
	}
}
