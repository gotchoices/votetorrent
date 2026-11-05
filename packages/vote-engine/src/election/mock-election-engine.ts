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
	Signature,
} from '@votetorrent/vote-core';
import { ElectionEvent, ElectionType, FeatureNotAvailableError } from '@votetorrent/vote-core';
import { ElectionInviteKeyholderBuilder } from './builders/election-invite-keyholder-builder.js';
import { ElectionProposeBallotBuilder } from './builders/election-propose-ballot-builder.js';
import { ElectionProposeRevisionBuilder } from './builders/election-propose-revision-builder.js';
import { ElectionRevokeKeyholderBuilder } from './builders/election-revoke-keyholder-builder.js';
import { fromCanonicalDatetime, toCanonicalDatetime } from '../utils.js';

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

/**
 * Shared confirmation-state object for the mock engines (D-10, 31-04).
 *
 * MockElectionEngine and MockSignatureTasksEngine both hold a reference to the
 * SAME instance so that completeSignature on the tasks engine can flip the ballot
 * from 'submitted' to 'confirmed' — mirroring the real finalize path.
 *
 * Usage in tests:
 *   const confirmState = new MockBallotConfirmationState();
 *   const electionEngine = new MockElectionEngine(confirmState);
 *   const tasksEngine = new MockSignatureTasksEngine(electionEngine);
 *
 * The app's EngineFactory constructs the REAL engines; mocks are paired only in
 * test code (compliance.spec.ts + RTL tests).
 */
export class MockBallotConfirmationState {
	private state: Map<string, 'proposed' | 'submitted' | 'confirmed'> = new Map();

	get(ballotId: string): 'proposed' | 'submitted' | 'confirmed' {
		return this.state.get(ballotId) ?? 'proposed';
	}

	set(ballotId: string, value: 'proposed' | 'submitted' | 'confirmed'): void {
		this.state.set(ballotId, value);
	}

	// gap8/WR-03: who submitted each ballot (the real engine's AdminSigning.UserId), so the mock
	// can refuse a withdraw by anyone else exactly as the real engine does.
	private submitters: Map<string, string> = new Map();

	getSubmitter(ballotId: string): string | undefined {
		return this.submitters.get(ballotId);
	}

	setSubmitter(ballotId: string, userId: string | undefined): void {
		if (userId === undefined) this.submitters.delete(ballotId);
		else this.submitters.set(ballotId, userId);
	}
}

export class MockElectionEngine implements IElectionEngine {
	// Phase 9 plan 09-09 (G12) — stateful in-memory ballot store. Starts EMPTY
	// so the ElectionDetails empty-state shows before any template is created.
	// AppProvider caches the engine instance, so this array persists across
	// navigations within a session (the intended persistence vehicle).
	private ballots: Ballot[] = [];

	// 31-04: shared confirmation-state — injectable so MockSignatureTasksEngine
	// can call markBallotConfirmed on the same state object.
	private confirmationState: MockBallotConfirmationState;

	// 62-76: keyholder invitations received via inviteKeyholder, name -> every expiration sent to that
	// name (62-84: appended on each send, like the real engine's one chain per send). Feeds the `sent`
	// field of the keyholder projection with the real engine's ranking: an invitee that has a result is
	// 'answered', else any unexpired send makes it 'live' (the latest such expiration), else a seeded
	// decline stays 'declined' (62 CR-01), else 'no-longer-valid' with the latest expiration;
	// never-invited invitees carry no `sent`.
	private sentKeyholderInvites = new Map<string, string[]>();

	// gap8/WR-03: the officer this mock acts as. Default keeps every existing caller behaving as
	// one officer who submits and may withdraw.
	private currentUserId: string;

	constructor(confirmationState?: MockBallotConfirmationState, currentUserId: string = 'mock-officer') {
		this.confirmationState = confirmationState ?? new MockBallotConfirmationState();
		this.currentUserId = currentUserId;
	}

	/** Switch the officer this mock acts as (screen/parity tests for the non-submitter case). */
	setCurrentUser(userId: string): void {
		this.currentUserId = userId;
	}

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
		return this.ballots.map(({ id, electionId, authorityId, description }) => ({
			id,
			electionId,
			authorityId,
			description,
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
						// 62 CR-01 (real-engine shape): a decline writes an InviteResult with IsAccepted false
						// but NO Keyholder row, so the engine carries it only as sent 'declined', never as a
						// `result`.
						invite: { name: 'Judge Michael Rodriguez' },
						sent: {
							state: 'declined',
							expiration: toCanonicalDatetime(new Date(MOCK_NOW - MOCK_DAY_MS)),
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
					[ElectionEvent.accruingVotes]: MOCK_NOW + 11 * MOCK_DAY_MS,
					[ElectionEvent.hashingVotes]: MOCK_NOW + 12 * MOCK_DAY_MS,
					[ElectionEvent.releasingKeys]: MOCK_NOW + 13 * MOCK_DAY_MS,
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
		const now = Date.now();
		// IN-06: parse with the engine's own datetime reader (canonicalise first: callers may pass a
		// trailing Z or an offset). An unparseable value sorts last and never reads live.
		const expirationMs = (value: string): number => {
			const ms = fromCanonicalDatetime(toCanonicalDatetime(value));
			return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
		};
		const latest = (values: string[]): string =>
			values.reduce((best, v) => (expirationMs(v) > expirationMs(best) ? v : best));
		mockElection.current.keyholders = mockElection.current.keyholders.map((k) => {
			const sends = this.sentKeyholderInvites.get(k.invite.name);
			if (sends === undefined || sends.length === 0) return k;
			if (k.result) return { ...k, sent: { state: 'answered' as const, expiration: latest(sends) } };
			const live = sends.filter((v) => expirationMs(v) > now);
			if (live.length > 0) return { ...k, sent: { state: 'live' as const, expiration: latest(live) } };
			// 62 CR-01: the real ranking puts a decline above a dead chain (answered > live > declined >
			// unknown > no-longer-valid). A seeded decline predates every session send, so only a live
			// resend outranks it.
			if (k.sent?.state === 'declined') return k;
			return { ...k, sent: { state: 'no-longer-valid' as const, expiration: latest(sends) } };
		});
		return Promise.resolve(mockElection);
	}

	async inviteKeyholder(
		keyholder: KeyholderInvite,
		_electionId: string,
		_signatureOrCallback: Signature | ((digest: Uint8Array) => Promise<Signature>),
	): Promise<void> {
		const sends = this.sentKeyholderInvites.get(keyholder.name);
		if (sends) sends.push(keyholder.expiration);
		else this.sentKeyholderInvites.set(keyholder.name, [keyholder.expiration]);
		return Promise.resolve();
	}

	async proposeBallot(ballot: Ballot): Promise<void> {
		// Real-engine parity (CR-03): a ballot out for confirmation or confirmed cannot be
		// overwritten. Same text as ElectionEngine.proposeBallot.
		const lockState = this.confirmationState.get(ballot.id);
		if (lockState === 'submitted') {
			throw new Error('This ballot is out for confirmation and cannot be edited. Withdraw it first.');
		}
		if (lockState === 'confirmed') {
			throw new Error('This ballot is already confirmed and can no longer be edited.');
		}
		const idx = this.ballots.findIndex((b) => b.id === ballot.id);
		if (idx >= 0) {
			this.ballots[idx] = ballot;
		} else {
			this.ballots.push(ballot);
		}
	}

	async proposeRevision(_revision: ElectionRevisionInit): Promise<void> {
		throw new FeatureNotAvailableError('proposeRevision is not available in the mock engine');
	}

	async revokeKeyholder(
		_keyholder: KeyholderInvite,
		_electionId: string,
	): Promise<void> {
		throw new FeatureNotAvailableError('revokeKeyholder is not available in the mock engine');
	}

	// ---------- confirm-path (D-10 mock parity, 31-04) ----------
	// Real in-memory behavior mirroring the real engine's submit → confirm → finalize → withdraw flow.

	async submitBallotForConfirmation(
		ballotId: string,
		_sign?: (digest: Uint8Array) => Promise<Signature>,
	): Promise<void> {
		// Real-engine parity (election-engine.ts ~L937, UAT 62 test 13): a ballot that
		// was never proposed has no ProposedBallot row, so submit is refused with the
		// same message. Without this check jest passed a Submit that fails on device.
		if (!this.ballots.some((b) => b.id === ballotId)) {
			throw new Error(`ProposedBallot not found: ${ballotId}`);
		}
		// Same fixed, id-free text as ElectionEngine (WR-04 parity).
		const current = this.confirmationState.get(ballotId);
		if (current === 'submitted') {
			throw new Error('This ballot is already submitted for confirmation.');
		}
		if (current === 'confirmed') {
			throw new Error('This ballot is already confirmed.');
		}
		// D-04 parity: ProposedBallot (this.ballots entry) is retained — only the state flag changes.
		this.confirmationState.set(ballotId, 'submitted');
		this.confirmationState.setSubmitter(ballotId, this.currentUserId);
	}

	async withdrawBallotConfirmation(ballotId: string): Promise<void> {
		const current = this.confirmationState.get(ballotId);
		if (current !== 'submitted') {
			throw new Error(`Ballot ${ballotId} is not currently submitted (state: ${current})`);
		}
		// Real-engine parity (T-62-11-03): only the officer who submitted may withdraw.
		// A state seeded straight through MockBallotConfirmationState.set has no recorded submitter;
		// that is not "someone else", so it stays withdrawable.
		const submitter = this.confirmationState.getSubmitter(ballotId);
		if (submitter !== undefined && submitter !== this.currentUserId) {
			throw new Error('withdrawBallotConfirmation: Only the officer who submitted this ballot can withdraw it.');
		}
		this.confirmationState.set(ballotId, 'proposed');
		this.confirmationState.setSubmitter(ballotId, undefined);
	}

	async getBallotConfirmationState(
		ballotId: string,
	): Promise<{ locked: boolean; confirmed: boolean; canWithdraw: boolean; ownTaskOpen: boolean }> {
		const state = this.confirmationState.get(ballotId);
		const mine = state === 'submitted' && this.confirmationState.getSubmitter(ballotId) === this.currentUserId;
		return {
			locked: state === 'submitted',
			confirmed: state === 'confirmed',
			// Threshold-1 model: the submitter may withdraw and owns the one open confirmation task.
			canWithdraw: mine,
			ownTaskOpen: mine,
		};
	}

	/**
	 * markBallotConfirmed — called by MockSignatureTasksEngine.completeSignature
	 * when a ballot task is accepted (simulating real finalizeBallot).
	 * D-04: ProposedBallot is retained in this.ballots after confirm.
	 */
	markBallotConfirmed(ballotId: string): void {
		this.confirmationState.set(ballotId, 'confirmed');
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
