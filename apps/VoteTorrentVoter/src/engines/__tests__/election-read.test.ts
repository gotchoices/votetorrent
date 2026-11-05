/**
 * election-read.ts — the voter's real election/ballot read (replacing the in-memory mockData
 * fixture). The engine chain is stubbed at the `getEngine('elections')` boundary; everything past
 * it (election pick, timeline derivation, ballot flattening, the confirmed-only filter) is real.
 */
import fs from 'fs';
import path from 'path';
import type {Ballot, ElectionSummary, Question} from '@votetorrent/vote-core';
import {NoElectionError, readVoteContext, resolveCurrentElectionId, readVoterBallot, readVoterElection, toVoterBallot} from '../election-read';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Relative offsets mirror dev-seed.ts's own timeline, so the fixture is a shape the app really sees.
const D = Date.UTC(2031, 0, 15, 12);
const TIMELINE = {
	registrationEnds: D - 52 * DAY,
	ballotsFinal: D - 40 * DAY,
	votingStarts: D - 31 * DAY,
	accruingVotes: D - 20 * HOUR,
	hashingVotes: D - 16 * HOUR,
	releasingKeys: D - 12 * HOUR,
	tallyingStarts: D,
	validation: D + DAY,
	certificationStarts: D + 2 * DAY,
	closed: D + 3 * DAY,
};

interface FakeOptions {
	summaries?: Array<{id: string; date: number}>;
	timeline?: unknown;
	keyholders?: unknown[];
	revision?: unknown;
	authorityId?: unknown;
	ballots?: Array<{ballot: Ballot; confirmed: boolean}>;
	/** Serves the vault-less 'keyRelease' engine; when omitted, getEngine('keyRelease') THROWS like any unknown name. */
	keyRelease?: {getKeyReleaseStatus: (electionId: string) => Promise<unknown>};
}

function fakeDeps(options: FakeOptions = {}, fallbackElectionId?: string) {
	const ballots = options.ballots ?? [];
	const opened: string[] = [];
	const detailsCalls: string[] = [];
	const electionEngine = {
		getElectionDetails: async () => ({
			election: {id: 'e-1', authorityId: 'authorityId' in options ? options.authorityId : 'a-1', title: 'Real Election', date: D, revisionDeadline: D - 30 * DAY, ballotDeadline: D - 7 * DAY, type: 'a'},
			current: {revision: 'revision' in options ? options.revision : 3, timeline: options.timeline ?? TIMELINE, keyholders: options.keyholders ?? []},
		}),
		getBallots: async () => ballots.map(({ballot}) => ({id: ballot.id, electionId: ballot.electionId, authorityId: ballot.authorityId})),
		getBallotConfirmationState: async (id: string) => ({locked: false, confirmed: ballots.find(b => b.ballot.id === id)!.confirmed}),
		getBallotDetails: async (id: string) => {
			detailsCalls.push(id);
			return {ballot: ballots.find(b => b.ballot.id === id)!.ballot};
		},
	};
	const electionsEngine = {
		getElections: async () => (options.summaries ?? [{id: 'e-1', date: D}]).map(s => ({...s, title: 't', authorityName: 'a', type: 'a'})),
		openElection: async (id: string) => {
			opened.push(id);
			return electionEngine;
		},
	};
	const getEngine = async <T,>(name: string): Promise<T> => {
		if (name === 'keyRelease' && options.keyRelease) return options.keyRelease as unknown as T;
		if (name !== 'elections') throw new Error(`unexpected engine ${name}`);
		return electionsEngine as unknown as T;
	};
	return {deps: {getEngine, fallbackElectionId}, opened, detailsCalls};
}

function question(code: string, overrides: Partial<Question> = {}): Question {
	return {
		code,
		title: `Title ${code}`,
		instructions: '',
		type: 'select',
		options: [
			{code: 'x', title: `${code} X`, details: 'Party X'},
			{code: 'y', title: `${code} Y`},
		],
		...overrides,
	};
}

function ballot(id: string, questions: Question[]): Ballot {
	return {id, electionId: 'e-1', authorityId: 'a-1', description: '', districts: [], questions};
}

describe('readVoterElection — lifecycle state derived from the real timeline', () => {
	it.each([
		['before voting opens', 'Upcoming', D - 60 * DAY, TIMELINE.votingStarts],
		['during voting', 'Open', D - 10 * DAY, TIMELINE.accruingVotes],
		['once voting closes (accruingVotes)', 'ReleasingKeys', D - 18 * HOUR, TIMELINE.tallyingStarts],
		['while keys release', 'ReleasingKeys', D - 6 * HOUR, TIMELINE.tallyingStarts],
		['during tallying/validation/certification', 'Validation', D + 2.5 * DAY, TIMELINE.closed],
	] as const)('%s -> %s, counting down to the event that ends it', async (_label, state, now, endMs) => {
		const election = await readVoterElection(fakeDeps().deps, now);
		expect(election.lifecycleState).toBe(state);
		expect(election.countdownTarget).toBe(new Date(endMs).toISOString());
	});

	it('after close -> Complete, with no countdown', async () => {
		const election = await readVoterElection(fakeDeps().deps, D + 4 * DAY);
		expect(election.lifecycleState).toBe('Complete');
		expect(election.countdownTarget).toBeUndefined();
	});

	it('carries the real id and title, and NEVER fills a field with no engine source', async () => {
		const election = await readVoterElection(fakeDeps({keyholders: [{}, {}, {}]}).deps, D - 6 * HOUR);
		expect(election).toMatchObject({id: 'e-1', title: 'Real Election', keysTotal: 3});
		// No keyRelease engine is served here, so keysReleased is absent too (the read failed).
		for (const unsourced of ['progress', 'keysReleased', 'checksComplete', 'checksTotal', 'fingerprint', 'certified', 'evidence']) {
			expect(election).not.toHaveProperty(unsourced);
		}
	});

	it('omits keysTotal when the election has no keyholders', async () => {
		expect(await readVoterElection(fakeDeps().deps, D - 60 * DAY)).not.toHaveProperty('keysTotal');
	});

	it('rejects on an indeterminate timeline rather than guessing a state', async () => {
		await expect(readVoterElection(fakeDeps({timeline: {}}).deps, D)).rejects.toThrow(/indeterminate timeline/);
	});

	it('rejects with NoElectionError when the network lists no election and there is no fallback', async () => {
		await expect(readVoterElection(fakeDeps({summaries: []}).deps, D)).rejects.toBeInstanceOf(NoElectionError);
	});

	it('opens the fallback (dev-seeded) election when the network lists none', async () => {
		const {deps, opened} = fakeDeps({summaries: []}, 'seeded-1');
		await readVoterElection(deps, D - 60 * DAY);
		expect(opened).toEqual(['seeded-1']);
	});
});

describe('readVoterElection — keysReleased from the release engine (62-29, D-17)', () => {
	const KEY = {jointPublicKey: '02aa'};
	const status = (overrides: Record<string, unknown>) => ({phase: 'releasing', releasedCount: 3, rejectedReleases: [], electionKey: KEY, ...overrides});
	const stub = (value: unknown) => {
		const getKeyReleaseStatus = jest.fn(async (_electionId: string) => value);
		return {getKeyReleaseStatus};
	};
	const FIVE = [{}, {}, {}, {}, {}];

	it('V1: fills keysReleased with the ACCEPTED count only (never counting a rejected row) in ReleasingKeys', async () => {
		const keyRelease = stub(status({releasedCount: 3, rejectedReleases: [{userId: 'u-9', reason: 'share-invalid'}]}));
		const election = await readVoterElection(fakeDeps({keyholders: FIVE, keyRelease}).deps, D - 6 * HOUR);
		expect(election.lifecycleState).toBe('ReleasingKeys');
		expect(election.keysReleased).toBe(3);
		expect(election.keysTotal).toBe(5);
		expect(keyRelease.getKeyReleaseStatus).toHaveBeenCalledWith('e-1');
	});

	it.each([
		['Validation', D + 2.5 * DAY],
		['Complete', D + 4 * DAY],
	] as const)('V2: phase reconstructable fills keysReleased in the %s state', async (state, now) => {
		const keyRelease = stub(status({phase: 'reconstructable', releasedCount: 4}));
		const election = await readVoterElection(fakeDeps({keyholders: FIVE, keyRelease}).deps, now);
		expect(election.lifecycleState).toBe(state);
		expect(election.keysReleased).toBe(4);
	});

	it.each(['no-election-key', 'election-key-inconsistent', 'no-current-revision'] as const)('V3: phase %s leaves keysReleased absent', async phase => {
		const keyRelease = stub(status({phase, releasedCount: 0, electionKey: phase === 'election-key-inconsistent' ? KEY : null}));
		const election = await readVoterElection(fakeDeps({keyholders: FIVE, keyRelease}).deps, D - 6 * HOUR);
		expect(election).not.toHaveProperty('keysReleased');
	});

	it('V3b: a null electionKey leaves keysReleased absent even in a measurable phase', async () => {
		const keyRelease = stub(status({phase: 'releasing', electionKey: null}));
		expect(await readVoterElection(fakeDeps({keyholders: FIVE, keyRelease}).deps, D - 6 * HOUR)).not.toHaveProperty('keysReleased');
	});

	it('V4: a throwing getEngine or a rejecting status read leaves keysReleased absent and the election still resolves', async () => {
		const withoutEngine = await readVoterElection(fakeDeps({keyholders: FIVE}).deps, D - 6 * HOUR);
		expect(withoutEngine).toMatchObject({id: 'e-1', keysTotal: 5});
		expect(withoutEngine).not.toHaveProperty('keysReleased');

		const rejecting = {getKeyReleaseStatus: jest.fn(async () => {
			throw new Error('read failed');
		})};
		const election = await readVoterElection(fakeDeps({keyholders: FIVE, keyRelease: rejecting}).deps, D - 6 * HOUR);
		expect(election).toMatchObject({id: 'e-1', keysTotal: 5});
		expect(election).not.toHaveProperty('keysReleased');
		expect(rejecting.getKeyReleaseStatus).toHaveBeenCalled();
	});

	it.each([
		['Upcoming', D - 60 * DAY],
		['Open', D - 10 * DAY],
	] as const)('V5: the %s state never calls getKeyReleaseStatus and has no keysReleased', async (state, now) => {
		const keyRelease = stub(status({}));
		const election = await readVoterElection(fakeDeps({keyholders: FIVE, keyRelease}).deps, now);
		expect(election.lifecycleState).toBe(state);
		expect(keyRelease.getKeyReleaseStatus).not.toHaveBeenCalled();
		expect(election).not.toHaveProperty('keysReleased');
	});
});

describe('toVoterBallot — authority ballot -> voter offices', () => {
	it('maps a select question to an office with literal text, voteFor from optionRange.max, and optional party', () => {
		const result = toVoterBallot('e-1', [ballot('b-1', [question('q1', {optionRange: {min: 1, max: 2}, group: 'Federal'})])]);
		expect(result).toEqual({
			electionId: 'e-1',
			unsupportedQuestionCount: 0,
			offices: [
				{
					id: 'b-1:q1',
					ballotId: 'b-1',
					questionCode: 'q1',
					title: 'Title q1',
					group: 'Federal',
					voteFor: 2,
					required: true,
					hasDependsOn: false,
					candidates: [
						{id: 'b-1:q1:x', optionCode: 'x', name: 'q1 X', party: 'Party X'},
						{id: 'b-1:q1:y', optionCode: 'y', name: 'q1 Y'},
					],
				},
			],
		});
	});

	it('defaults voteFor to 1 and treats an absent type as select', () => {
		const q = question('q1');
		delete (q as Partial<Question>).type;
		expect(toVoterBallot('e-1', [ballot('b-1', [q])]).offices[0].voteFor).toBe(1);
	});

	it('counts rank/score/text questions as unsupported instead of rendering or silently dropping them', () => {
		const result = toVoterBallot('e-1', [
			ballot('b-1', [question('q1'), question('q2', {type: 'rank'}), question('q3', {type: 'text'})]),
		]);
		expect(result.offices.map(o => o.id)).toEqual(['b-1:q1']);
		expect(result.unsupportedQuestionCount).toBe(2);
	});

	it('orders by group first appearance, then sequence, then declaration order — so sections stay contiguous', () => {
		const result = toVoterBallot('e-1', [
			ballot('b-1', [
				question('s2', {group: 'State', sequence: 2}),
				question('f1', {group: 'Federal'}),
				question('s1', {group: 'State', sequence: 1}),
				question('f0', {group: 'Federal'}),
			]),
		]);
		expect(result.offices.map(o => o.id)).toEqual(['b-1:s1', 'b-1:s2', 'b-1:f1', 'b-1:f0']);
	});

	it('flattens several ballots in id order with ids unique across ballots', () => {
		const result = toVoterBallot('e-1', [ballot('b-2', [question('q')]), ballot('b-1', [question('q')])]);
		expect(result.offices.map(o => o.id)).toEqual(['b-1:q', 'b-2:q']);
	});
});

describe('toVoterBallot — structured codes for the vote builders (D-04, D-05, spike 096 finding 6)', () => {
	const requiredOf = (q: Question) => toVoterBallot('e-1', [ballot('b-1', [q])]).offices[0].required;

	it('S2: an absent required flag reads as required; true is required; false is optional (D-04)', () => {
		expect(requiredOf(question('q1'))).toBe(true);
		expect(requiredOf(question('q1', {required: true}))).toBe(true);
		expect(requiredOf(question('q1', {required: false}))).toBe(false);
	});

	it('S3: dependsOn present is detected; absent or null is not (R-2)', () => {
		const has = (q: Question) => toVoterBallot('e-1', [ballot('b-1', [q])]).offices[0].hasDependsOn;
		expect(has(question('q1', {dependsOn: {code: 'q0'}}))).toBe(true);
		expect(has(question('q1'))).toBe(false);
		expect(has(question('q1', {dependsOn: null as unknown as Question['dependsOn']}))).toBe(false);
	});

	it('S4: codes containing the id separator survive; nothing is recovered by splitting', () => {
		const result = toVoterBallot('e-1', [ballot('b:1', [question('q:2', {options: [{code: 'o:3', title: 'O'}]})])]);
		const office = result.offices[0];
		expect(office.id).toBe('b:1:q:2');
		expect(office.ballotId).toBe('b:1');
		expect(office.questionCode).toBe('q:2');
		expect(office.candidates[0].id).toBe('b:1:q:2:o:3');
		expect(office.candidates[0].optionCode).toBe('o:3');
	});

	it('S5: the structured fields are independent of the question read order (proposal vs Code order)', () => {
		const make = (code: string) => question(code, {
			required: code !== 'governor',
			dependsOn: code === 'us-house' ? {code: 'governor'} : undefined,
			options: [{code: `${code}-a`, title: 'A'}, {code: `${code}-b`, title: 'B'}],
		});
		const byCode = (codes: string[]) => new Map(
			toVoterBallot('e-1', [ballot('b-1', codes.map(make))]).offices.map(o => [
				o.questionCode,
				{ballotId: o.ballotId, required: o.required, hasDependsOn: o.hasDependsOn, optionCodes: o.candidates.map(c => c.optionCode)},
			])
		);
		const proposal = byCode(['us-senate', 'us-house', 'governor']);
		const codeOrder = byCode(['governor', 'us-house', 'us-senate']);
		expect(proposal).toEqual(codeOrder);
		expect(proposal.get('governor')).toEqual({ballotId: 'b-1', required: false, hasDependsOn: false, optionCodes: ['governor-a', 'governor-b']});
		expect(proposal.get('us-house')?.hasDependsOn).toBe(true);
	});
});

describe('readVoterBallot — only officer-confirmed ballots reach a voter', () => {
	const ballots = [
		{ballot: ballot('confirmed', [question('c')]), confirmed: true},
		{ballot: ballot('proposed', [question('p')]), confirmed: false},
	];

	it('excludes proposed-but-unconfirmed ballots by default', async () => {
		const result = await readVoterBallot(fakeDeps({ballots}).deps, {includeProposed: false});
		expect(result.offices.map(o => o.id)).toEqual(['confirmed:c']);
	});

	it('admits proposed ballots only when asked (the __DEV__ path)', async () => {
		const result = await readVoterBallot(fakeDeps({ballots}).deps, {includeProposed: true});
		expect(result.offices.map(o => o.id)).toEqual(['confirmed:c', 'proposed:p']);
	});

	it('returns an empty ballot (not a rejection) when the election has none', async () => {
		expect((await readVoterBallot(fakeDeps().deps, {includeProposed: false})).offices).toEqual([]);
	});
});

describe('readVoteContext — the vote window, confirmed ballots and revision (D-01, D-03, D-05)', () => {
	it('R1: Open mid-window, with the election id, authority and revision', async () => {
		const ctx = await readVoteContext(fakeDeps().deps, D - 10 * DAY);
		expect(ctx).toMatchObject({open: true, lifecycleState: 'Open', electionId: 'e-1', authorityId: 'a-1', revision: 3});
	});

	it.each([
		[TIMELINE.votingStarts - 60_000, false, 'Upcoming'],
		[TIMELINE.votingStarts + 60_000, true, 'Open'],
		[TIMELINE.accruingVotes - 60_000, true, 'Open'],
		[TIMELINE.accruingVotes + 60_000, false, 'ReleasingKeys'],
		[D + 4 * DAY, false, 'Complete'],
	] as const)('R2: edge %#: open=%s state=%s', async (now, open, state) => {
		const ctx = await readVoteContext(fakeDeps().deps, now);
		expect(ctx.open).toBe(open);
		expect(ctx.lifecycleState).toBe(state);
	});

	it('R3: agrees with the Home derivation across a boundary sweep', async () => {
		const {deps} = fakeDeps();
		const sweep = [
			D - 60 * DAY, TIMELINE.votingStarts - 1, TIMELINE.votingStarts, TIMELINE.votingStarts + 1, D - 10 * DAY,
			TIMELINE.accruingVotes - 1, TIMELINE.accruingVotes, TIMELINE.accruingVotes + 1, D - 6 * HOUR, D + 2.5 * DAY, D + 4 * DAY,
		];
		for (const t of sweep) {
			const ctx = await readVoteContext(deps, t);
			const home = await readVoterElection(deps, t);
			expect(ctx.lifecycleState).toBe(home.lifecycleState);
			expect(ctx.open).toBe(ctx.lifecycleState === 'Open');
		}
	});

	it('R4: an indeterminate timeline reads as closed and does not reject', async () => {
		const ctx = await readVoteContext(
			fakeDeps({timeline: {}, ballots: [{ballot: ballot('b-1', [question('q1')]), confirmed: true}]}).deps,
			D - 10 * DAY
		);
		expect(ctx.open).toBe(false);
		expect(ctx.lifecycleState).toBeNull();
		expect(ctx.revision).toBe(3);
		expect(ctx.authorityId).toBe('a-1');
		expect(ctx.ballots.map(b => b.id)).toEqual(['b-1']);
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('R5: a non-finite clock (%s) reads as closed', async now => {
		const ctx = await readVoteContext(fakeDeps().deps, now);
		expect(ctx.open).toBe(false);
		expect(ctx.lifecycleState).toBeNull();
	});

	it('R6: only confirmed ballots are returned; unconfirmed are listed and never read (D-03)', async () => {
		const {deps, detailsCalls} = fakeDeps({
			ballots: [
				{ballot: ballot('b-2', [question('q')]), confirmed: true},
				{ballot: ballot('b-p', [question('q')]), confirmed: false},
				{ballot: ballot('b-1', [question('q')]), confirmed: true},
			],
		});
		const ctx = await readVoteContext(deps, D - 10 * DAY);
		expect(ctx.ballots.map(b => b.id)).toEqual(['b-1', 'b-2']);
		expect(ctx.unconfirmedBallotIds).toEqual(['b-p']);
		expect(detailsCalls).not.toContain('b-p');

		const none = fakeDeps({ballots: [{ballot: ballot('b-z', [question('q')]), confirmed: false}, {ballot: ballot('b-y', [question('q')]), confirmed: false}]});
		const allUnconfirmed = await readVoteContext(none.deps, D - 10 * DAY);
		expect(allUnconfirmed.ballots).toEqual([]);
		expect(allUnconfirmed.unconfirmedBallotIds).toEqual(['b-y', 'b-z']);
		expect(none.detailsCalls).toEqual([]);

		const empty = await readVoteContext(fakeDeps().deps, D - 10 * DAY);
		expect(empty.ballots).toEqual([]);
		expect(empty.unconfirmedBallotIds).toEqual([]);
	});

	it('R7: ballots are the raw engine objects, in engine question order, keeping dependsOn and optionRange', async () => {
		const raw = ballot('b-1', [
			question('a-q', {sequence: 3, dependsOn: {code: 'm-q'}, optionRange: {min: 2, max: 3}}),
			question('m-q', {sequence: 1}),
			question('z-q', {sequence: 2}),
		]);
		const ctx = await readVoteContext(fakeDeps({ballots: [{ballot: raw, confirmed: true}]}).deps, D - 10 * DAY);
		expect(ctx.ballots[0]).toBe(raw);
		expect(ctx.ballots[0].questions.map(q => q.code)).toEqual(['a-q', 'm-q', 'z-q']);
		expect(ctx.ballots[0].questions[0].dependsOn).toEqual({code: 'm-q'});
		expect(ctx.ballots[0].questions[0].optionRange).toEqual({min: 2, max: 3});
	});

	it('R8: counts unsupported questions over confirmed ballots only', async () => {
		const ctx = await readVoteContext(
			fakeDeps({
				ballots: [
					{ballot: ballot('b-1', [question('s'), question('r', {type: 'rank'}), question('t', {type: 'text'})]), confirmed: true},
					{ballot: ballot('b-2', [question('u', {type: 'rank'})]), confirmed: false},
				],
			}).deps,
			D - 10 * DAY
		);
		expect(ctx.unsupportedQuestionCount).toBe(2);
		expect(ctx.unconfirmedBallotIds).toEqual(['b-2']);

		const onlyUnconfirmed = await readVoteContext(
			fakeDeps({ballots: [{ballot: ballot('b-2', [question('u', {type: 'rank'})]), confirmed: false}]}).deps,
			D - 10 * DAY
		);
		expect(onlyUnconfirmed.unsupportedQuestionCount).toBe(0);
	});

	it('R9: normalises a bigint revision; rejects an unreadable revision or authority', async () => {
		expect((await readVoteContext(fakeDeps({revision: 4n}).deps, D)).revision).toBe(4);
		for (const revision of ['3', 1.5, -1, undefined, Number.NaN]) {
			await expect(readVoteContext(fakeDeps({revision}).deps, D)).rejects.toThrow(/unreadable revision/);
		}
		await expect(readVoteContext(fakeDeps({authorityId: ''}).deps, D)).rejects.toThrow(/unreadable authority/);
	});

	it('R10: rejects with NoElectionError when there is no election', async () => {
		await expect(readVoteContext(fakeDeps({summaries: []}).deps, D)).rejects.toBeInstanceOf(NoElectionError);
	});
});

describe('readVoteContext — source gate: derived window only, no dev override (D-01)', () => {
	function stripCommentsPreservingLines (src: string): string {
		return src
			.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
			.replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
	}
	function bodyOf (src: string): string {
		const start = src.indexOf('export async function readVoteContext');
		if (start < 0) return '';
		const rest = src.slice(start + 1);
		const next = rest.indexOf('\nexport ');
		return next < 0 ? rest : rest.slice(0, next);
	}
	function readVoteContextViolations (src: string): string[] {
		const body = bodyOf(src);
		const required = ['lifecycleFromTimeline(', 'deriveDetailsTimeline(', 'getBallotConfirmationState('];
		const banned = ['lifecycleOverride', 'includeProposed', 'Date.now(', 'DEV_LIFECYCLE', 'console.'];
		return [
			...required.filter(t => !body.includes(t)).map(t => `missing ${t}`),
			...banned.filter(t => body.includes(t)).map(t => `contains ${t}`),
		];
	}
	const source = stripCommentsPreservingLines(fs.readFileSync(path.join(__dirname, '..', 'election-read.ts'), 'utf8'));

	it('R11: readVoteContext derives the window and partitions confirmed ballots, with no override or wall clock', () => {
		expect(readVoteContextViolations(source)).toEqual([]);
		const helper = source.slice(source.indexOf('function deriveDetailsTimeline'));
		expect(helper.slice(0, helper.indexOf('\n}'))).toContain('deriveTimeline(');
	});

	it('R11 self-check: the checker reports a planted override', () => {
		const planted = 'export async function readVoteContext () { lifecycleFromTimeline( deriveDetailsTimeline( getBallotConfirmationState( lifecycleOverride }';
		expect(readVoteContextViolations(planted)).toEqual(['contains lifecycleOverride']);
	});
});

describe('resolveCurrentElectionId — the election registration uses (D-28)', () => {
  // The generic getEngine of fakeDeps is wrapped so calls are counted and openElection is observed.
  function resolverDeps(options: FakeOptions = {}, fallbackElectionId?: string) {
    const fake = fakeDeps(options, fallbackElectionId);
    const getEngine = jest.fn((name: 'elections') => fake.deps.getEngine<{getElections(): Promise<ElectionSummary[]>}>(name));
    return {deps: {getEngine, fallbackElectionId}, getEngine, opened: fake.opened};
  }

  it('resolves the one listed election on a joined network', async () => {
    const {deps} = resolverDeps({summaries: [{id: 'joined-election-7', date: D}]});
    expect(await resolveCurrentElectionId(deps)).toBe('joined-election-7');
  });

  it('falls back to the seed only when the list is empty', async () => {
    expect(await resolveCurrentElectionId(resolverDeps({summaries: []}, 'seed-1').deps)).toBe('seed-1');
    expect(await resolveCurrentElectionId(resolverDeps({summaries: []}, undefined).deps)).toBeUndefined();
  });

  it('picks the nearest of several, and the lower id on a tie', async () => {
    const spy = jest.spyOn(Date, 'now').mockReturnValue(D);
    try {
      expect(await resolveCurrentElectionId(resolverDeps({summaries: [{id: 'far', date: D + 9 * DAY}, {id: 'near', date: D + DAY}]}).deps)).toBe('near');
      expect(await resolveCurrentElectionId(resolverDeps({summaries: [{id: 'b', date: D + DAY}, {id: 'a', date: D - DAY}]}).deps)).toBe('a');
    } finally {
      spy.mockRestore();
    }
  });

  it('propagates the very error a rejected getElections raised, even with a fallback', async () => {
    const error = new Error('read failed');
    const getEngine = jest.fn(async () => ({getElections: async () => { throw error; }}));
    await expect(resolveCurrentElectionId({getEngine, fallbackElectionId: 'seed-1'})).rejects.toBe(error);
  });

  it('propagates the very error a rejected getEngine raised, even with a fallback', async () => {
    const error = new Error('engine failed');
    const getEngine = jest.fn(async (): Promise<{getElections(): Promise<never[]>}> => { throw error; });
    await expect(resolveCurrentElectionId({getEngine, fallbackElectionId: 'seed-1'})).rejects.toBe(error);
  });

  it('asks for the elections engine exactly once and never opens an election', async () => {
    const {deps, getEngine, opened} = resolverDeps({summaries: [{id: 'e-9', date: D}]});
    await resolveCurrentElectionId(deps);
    expect(getEngine).toHaveBeenCalledTimes(1);
    expect(getEngine).toHaveBeenCalledWith('elections');
    expect(opened).toEqual([]);
  });
});
