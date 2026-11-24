/**
 * election-setup.realschema.test.ts — the officer's election-setup sequence end to end over the REAL
 * Quereus schema, through the SHARED functions only (`@votetorrent/workflows/authority`, resolved to the
 * built dist exactly as the app resolves it). This is the lean rig's legElection replayed through the code
 * the CLI's create-election / invite-keyholder / ballot-submit / task-sign verbs call (phase 67 plan 10).
 *
 * R1 uses the CLI short-timeline shape (voting starts in 10 minutes, every later event one minute apart,
 * `date = closed`, `revisionDeadline = ballotDeadline = votingStarts`, threshold 2): create, two live seats,
 * propose + submit a ballot, find and sign its task, read it confirmed. R2 uses the app's default shape
 * (no ballotDeadline, the blank-form timeline) and proves the too-soon refusal writes nothing.
 *
 * No key literal and nothing is printed; shares are asserted by shape and slot liveness only.
 */

import { ElectionsEngine, InvitationEngine, SignatureTasksEngine } from '@votetorrent/vote-engine/rn';
import { addTestAuthority, createTestNetwork, makeTestSignCallback } from '@votetorrent/vote-engine/test/fixtures/test-context';
import { ElectionEvent, ElectionType } from '@votetorrent/vote-core';
import type { Ballot, IElectionsEngine, Signature } from '@votetorrent/vote-core';
import {
	BALLOT_DEADLINE_LEAD_MS,
	CREATE_FALLBACK_DAYS,
	createElection,
	findBallotSignatureTask,
	inviteKeyholderSeat,
	proposeBallot,
	readBallotConfirmation,
	resolveElectionTimeline,
	signTask,
	submitBallot,
} from '@votetorrent/workflows/authority';

jest.setTimeout(180_000);

const DAY_MS = 86_400_000;

/** The ballot-confirm.spec networkRef shape. */
const networkRef = { hash: 'test-election-setup-hash', name: 'Test Network', relays: [] as string[], primaryAuthorityDomainName: 'test.example' };

/** A counted signer factory over the fixture's registered test key. */
function countedSigner(sign: (digest: Uint8Array) => Promise<Signature>) {
	let created = 0;
	return {
		createSigner: async () => {
			created += 1;
			return sign;
		},
		createdCount: () => created,
	};
}

/** The lean rig's legElection timeline: votingStarts = now + 10 min, later events a minute apart. */
function shortTimeline(now: number): Record<ElectionEvent, number> {
	const votingStarts = now + 600_000;
	const accruing = votingStarts + 480_000;
	return {
		[ElectionEvent.registrationEnds]: votingStarts - 60_000,
		[ElectionEvent.ballotsFinal]: votingStarts - 60_000,
		[ElectionEvent.votingStarts]: votingStarts,
		[ElectionEvent.accruingVotes]: accruing,
		[ElectionEvent.hashingVotes]: accruing + 60_000,
		[ElectionEvent.releasingKeys]: accruing + 120_000,
		[ElectionEvent.tallyingStarts]: accruing + 180_000,
		[ElectionEvent.validation]: accruing + 240_000,
		[ElectionEvent.certificationStarts]: accruing + 300_000,
		[ElectionEvent.closed]: accruing + 360_000,
	};
}

const blankForm = {
	registrationEnds: '',
	ballotsFinal: '',
	votingStarts: '',
	accruingVotes: '',
	hashingVotes: '',
	releasingKeys: '',
	tallyingStarts: '',
	validation: '',
	certificationStarts: '',
	closed: '',
};

describe('election setup over the real schema', () => {
	it('R1: the CLI short timeline — threshold 2, two live seats, a confirmed ballot, all through the shared functions', async () => {
		const net = await createTestNetwork();
		const auth = await addTestAuthority(net);
		const electionsEngine: IElectionsEngine = new ElectionsEngine(auth.ctx);
		const sign = makeTestSignCallback(auth.user);
		const signer = countedSigner(sign);

		const now = Date.now();
		const timeline = shortTimeline(now);
		const created = await createElection({
			electionsEngine,
			input: {
				authorityId: auth.authority.id,
				title: 'rig election',
				date: timeline.closed,
				revisionDeadline: timeline.votingStarts,
				type: ElectionType.adhoc,
				keyholders: ['seat-a', 'seat-b'],
				threshold: 2,
				tags: ['rig'],
				instructions: '# rig',
				timeline,
				ballotDeadline: timeline.votingStarts,
			},
			createSigner: signer.createSigner,
			now,
		});
		expect(created).toEqual({ ok: true, electionId: `election-${now}` });
		expect(signer.createdCount()).toBe(1);
		if (!created.ok) return;

		const electionEngine = await electionsEngine.openElection(created.electionId);
		const details = await electionEngine.getElectionDetails();
		expect(details.current.keyholderThreshold).toBe(2);

		// Two keyholder seats, each minted by the shared seat-share builder; both slots resolve live.
		const invitationEngine = new InvitationEngine(auth.ctx);
		for (const name of ['seat-a', 'seat-b']) {
			const { electionId, share } = await inviteKeyholderSeat({
				electionEngine,
				name,
				expiryHours: 24,
				createSigner: signer.createSigner,
				now: Date.now(),
			});
			expect(electionId).toBe(created.electionId);
			expect(share.invitePrivate).toMatch(/^[0-9a-f]{64}$/);
			expect(share.name).toBe(name);
			const resolution = await invitationEngine.resolveInviteSlot(share.inviteKey, 'k');
			expect(resolution.status).toBe('live');
		}
		expect(signer.createdCount()).toBe(3);

		// B1: the ballot, proposed and submitted through the shared functions.
		const ballot: Ballot = await proposeBallot({
			electionEngine,
			draft: {
				authorityId: auth.authority.id,
				description: 'rig ballot',
				questions: [
					{
						code: 'q1',
						title: 'Question one',
						instructions: 'Choose one option.',
						type: 'select',
						options: [
							{ code: 'opt-a', title: 'Option A' },
							{ code: 'opt-b', title: 'Option B' },
						],
					},
				],
			},
			electionId: created.electionId,
			now: Date.now(),
		});
		expect(ballot.id).toBe(`ballot-${created.electionId}-${ballot.id.split('-').pop()}`);
		await submitBallot({ electionEngine, ballotId: ballot.id, sign });
		const afterSubmit = await readBallotConfirmation({ electionEngine, ballotId: ballot.id });
		expect(afterSubmit.locked).toBe(true);
		expect(afterSubmit.confirmed).toBe(false);

		// The officer's ballot task, found and signed through the shared functions.
		const tasksEngine = new SignatureTasksEngine(networkRef, auth.ctx);
		const task = findBallotSignatureTask(await tasksEngine.getRequestedSignatures(true), ballot.id);
		expect(task).toBeDefined();
		if (!task) return;
		await signTask({ tasksEngine, task, createSigner: signer.createSigner });
		expect(signer.createdCount()).toBe(4);

		const confirmed = await readBallotConfirmation({ electionEngine, ballotId: ballot.id });
		expect(confirmed.confirmed).toBe(true);
		expect(confirmed.locked).toBe(false);
	});

	it('R2: the app default shape creates once; a date inside the 10-day rule is refused before any write', async () => {
		const net = await createTestNetwork();
		const auth = await addTestAuthority(net);
		const electionsEngine: IElectionsEngine = new ElectionsEngine(auth.ctx);
		const signer = countedSigner(makeTestSignCallback(auth.user));

		const now = Date.now();
		const timeline = resolveElectionTimeline(blankForm, now, CREATE_FALLBACK_DAYS);
		const input = {
			authorityId: auth.authority.id,
			title: 'app election',
			// Inside the rules: the date is at or after the 10-day ballot deadline and before `closed`
			// (now + 17 d); the revision deadline is before the date.
			date: now + 12 * DAY_MS,
			revisionDeadline: now + 11 * DAY_MS,
			type: ElectionType.official,
			keyholders: ['Alice', 'Bob'],
			threshold: 2,
			tags: [],
			instructions: '# app',
			timeline,
		};
		const created = await createElection({ electionsEngine, input, createSigner: signer.createSigner, now });
		expect(created).toEqual({ ok: true, electionId: `election-${now}` });
		expect(signer.createdCount()).toBe(1);
		const countAfterFirst = (await electionsEngine.getElections()).length;
		expect(countAfterFirst).toBe(1);

		const later = now + 1;
		const refused = await createElection({
			electionsEngine,
			input: { ...input, date: later + 5 * DAY_MS, revisionDeadline: later + 4 * DAY_MS },
			createSigner: signer.createSigner,
			now: later,
		});
		expect(refused.ok).toBe(false);
		if (refused.ok) return;
		expect(refused.refusal.code).toBe('election-date-too-soon');
		expect(refused.refusal.ballotDeadline).toBe(later + BALLOT_DEADLINE_LEAD_MS);
		expect(BALLOT_DEADLINE_LEAD_MS).toBe(10 * DAY_MS);
		expect((await electionsEngine.getElections()).length).toBe(countAfterFirst);
	});
});
