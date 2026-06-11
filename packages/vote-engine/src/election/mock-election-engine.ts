import type {
	Ballot,
	BallotDetails,
	BallotSummary,
	ElectionDetails,
	ElectionRevisionInit,
	IElectionEngine,
	IElectionInviteKeyholderBuilder,
	IElectionProposeBallotBuilder,
	IElectionProposeRevisionBuilder,
	IElectionRevokeKeyholderBuilder,
	KeyholderInvite,
} from '@votetorrent/vote-core';
import { ElectionEvent, ElectionType, FeatureNotAvailableError } from '@votetorrent/vote-core';
import { ElectionInviteKeyholderBuilder } from './builders/election-invite-keyholder-builder.js';
import { ElectionProposeBallotBuilder } from './builders/election-propose-ballot-builder.js';
import { ElectionProposeRevisionBuilder } from './builders/election-propose-revision-builder.js';
import { ElectionRevokeKeyholderBuilder } from './builders/election-revoke-keyholder-builder.js';

// Phase 9 plan 09-01 (D-14, D-18) — seed data for the demo Timeline + Ballot
// renderers. Anchored to "now + N days" so the Timeline's past/current/future
// status-dot logic resolves correctly at runtime regardless of when the demo
// is run.
//
// Timeline mapping (ElectionEvent enum → Phase 9 D-06 milestone labels):
//   registrationStarts → (synthetic: revision.revisionTimestamp[0])
//   registrationEnds   → ElectionEvent.registrationEnds   ("Registration Closes")
//   votingStarts       → ElectionEvent.votingStarts       ("Voting Opens")
//   votingEnds         → ElectionEvent.tallyingStarts     ("Voting Closes")
//   revisionDeadline   → election.revisionDeadline        ("Revision Deadline")
const MOCK_DAY_MS = 24 * 60 * 60 * 1000;
const MOCK_NOW = Date.now();

export class MockElectionEngine implements IElectionEngine {
	// Phase 9 plan 09-09 (G12) — stateful in-memory ballot store. Starts EMPTY
	// so the ElectionDetails empty-state shows before any template is created.
	// AppProvider caches the engine instance, so this array persists across
	// navigations within a session (the intended persistence vehicle).
	private ballots: Ballot[] = [];

	async getBallotDetails(id: string): Promise<BallotDetails> {
		// Return the stored ballot if found; fall back to a safe stub so
		// ElectionDetails/EditBallot do not crash on stale or unknown ids.
		return {
			ballot: this.ballots.find((b) => b.id === id) ?? {
				id,
				electionId: '',
				authorityId: '',
				description: '',
				districts: [],
				questions: [],
			},
		};
	}

	async getBallots(): Promise<BallotSummary[]> {
		return this.ballots.map(({ id, electionId, authorityId }) => ({
			id,
			electionId,
			authorityId,
		}));
	}

	async getElectionDetails(): Promise<ElectionDetails> {
		// All 5 D-06 milestone dates are non-null. Dates anchored to MOCK_NOW so
		// the Timeline component (Phase 9 plan 09-01) resolves past/current/future
		// status correctly at runtime.
		const mockElection: ElectionDetails = {
			election: {
				id: 'election-2',
				authorityId: 'auth-b',
				title: 'Test Election 2 (Future)',
				date: MOCK_NOW + 14 * MOCK_DAY_MS,
				revisionDeadline: MOCK_NOW + 7 * MOCK_DAY_MS,
				type: ElectionType.official,
				ballotDeadline: MOCK_NOW + 5 * MOCK_DAY_MS,
			},
			current: {
				electionId: 'election-2',
				revision: 1,
				// registrationStarts (synthetic) — used by Timeline as "Registration Opens"
				revisionTimestamp: [MOCK_NOW - 3 * MOCK_DAY_MS],
				tags: ['general', 'demo', '2026'],
				instructions: '# Mock Election\n\nMock seed for the Phase 9 demo.',
				keyholders: [
					{
						invite: { name: 'Dr. Sarah Chen' },
					},
					{
						invite: { name: 'Judge Michael Rodriguez' },
						result: {
							isAccepted: false,
							invitationSignature: 'mock-invitation-signature-2',
							invokedId: 'mock-invoked-id-2',
						},
					},
					{
						invite: { name: 'Prof. James Wilson' },
						result: {
							isAccepted: true,
							invitationSignature: 'mock-invitation-signature-3',
							invokedId: 'mock-invoked-id-3',
						},
					},
				],
				timeline: {
					// D-06 milestones (5) — all non-null per the plan's acceptance criteria:
					//   registrationStarts (synthetic) is sourced from revisionTimestamp above.
					[ElectionEvent.registrationEnds]: MOCK_NOW + 2 * MOCK_DAY_MS,
					[ElectionEvent.ballotsFinal]: MOCK_NOW + 5 * MOCK_DAY_MS,
					[ElectionEvent.votingStarts]: MOCK_NOW + 10 * MOCK_DAY_MS,
					// votingEnds is rendered from tallyingStarts in the Timeline mapping.
					[ElectionEvent.tallyingStarts]: MOCK_NOW + 14 * MOCK_DAY_MS,
					[ElectionEvent.validation]: MOCK_NOW + 15 * MOCK_DAY_MS,
					[ElectionEvent.certificationStarts]: MOCK_NOW + 16 * MOCK_DAY_MS,
					[ElectionEvent.closed]: MOCK_NOW + 17 * MOCK_DAY_MS,
				},
				keyholderThreshold: 3,
			},
		};

		// No `proposed` revision is seeded: a freshly created election has not been
		// revised, so the Proposed-Revision UI must stay hidden until a real
		// proposed revision exists. (The blanket demo seed added in 09-15 made every
		// election show a phantom revision — removed per UAT.)
		return Promise.resolve(mockElection);
	}

	async inviteKeyholder(
		_keyholder: KeyholderInvite,
		_electionId: string,
	): Promise<void> {
		throw new FeatureNotAvailableError('inviteKeyholder — available in Phase 21 (signing pipeline)');
	}

	async proposeBallot(ballot: Ballot): Promise<void> {
		const idx = this.ballots.findIndex((b) => b.id === ballot.id);
		if (idx >= 0) {
			this.ballots[idx] = ballot;
		} else {
			this.ballots.push(ballot);
		}
	}

	async proposeRevision(_revision: ElectionRevisionInit): Promise<void> {
		throw new FeatureNotAvailableError('proposeRevision — available in Phase 21 (signing pipeline)');
	}

	async revokeKeyholder(
		_keyholder: KeyholderInvite,
		_electionId: string,
	): Promise<void> {
		throw new FeatureNotAvailableError('revokeKeyholder — available in Phase 21 (signing pipeline)');
	}

	buildProposeBallot(): IElectionProposeBallotBuilder {
		return new ElectionProposeBallotBuilder(this);
	}

	buildProposeRevision(): IElectionProposeRevisionBuilder {
		return new ElectionProposeRevisionBuilder(this);
	}

	buildInviteKeyholder(): IElectionInviteKeyholderBuilder {
		return new ElectionInviteKeyholderBuilder(this);
	}

	buildRevokeKeyholder(): IElectionRevokeKeyholderBuilder {
		return new ElectionRevokeKeyholderBuilder(this);
	}
}
