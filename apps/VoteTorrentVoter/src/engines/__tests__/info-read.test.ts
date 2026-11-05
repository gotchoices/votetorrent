/**
 * info-read.ts — the "Learn about this election / office / candidate" dialog reads and the
 * RegistrationInfo deadline read. The engine chain is stubbed at the `getEngine('elections')`
 * boundary; election pick, composite-id resolution and field mapping are real.
 */
import type {Ballot} from '@votetorrent/vote-core';
import {NoElectionError} from '../election-read';
import {
	InfoNotFoundError,
	readCandidateInfo,
	readElectionInfo,
	readOfficeInfo,
	readRegistrationDeadline,
	splitItemId,
} from '../info-read';

const D = Date.UTC(2031, 0, 15);

const BALLOT: Ballot = {
	id: 'ballot:with:colons',
	electionId: 'e-1',
	authorityId: 'a-1',
	description: '',
	districts: [],
	questions: [
		{
			code: 'mayor',
			title: 'Mayor',
			instructions: 'Choose one candidate for mayor.',
			type: 'select',
			optionRange: {min: 0, max: 2},
			options: [
				{code: 'x', title: 'Ada X', details: 'Party X', infoURL: 'https://example.org/ada', image: {url: 'https://example.org/ada.png'}},
				{code: 'y', title: 'Bo Y'},
			],
		},
	],
} as unknown as Ballot;

function fakeDeps(options: {summaries?: Array<{id: string; date: number; authorityName?: string}>; timeline?: unknown} = {}) {
	const electionEngine = {
		getElectionDetails: async () => ({
			election: {id: 'e-1', authorityId: 'a-1', title: 'City Election', date: D, revisionDeadline: D, ballotDeadline: D, type: 'a'},
			current: {
				instructions: 'Bring ID.',
				tags: ['city', 'general'],
				timeline: options.timeline ?? {registrationEnds: D - 1000},
				keyholders: [],
			},
		}),
		getBallotDetails: async (id: string) => {
			if (id !== BALLOT.id) throw new Error(`unknown ballot ${id}`);
			return {ballot: BALLOT};
		},
	};
	const electionsEngine = {
		getElections: async () =>
			(options.summaries ?? [{id: 'e-1', date: D, authorityName: 'County Clerk'}]).map(s => ({title: 't', type: 'a', ...s})),
		openElection: async () => electionEngine,
	};
	const getEngine = async <T,>(name: string): Promise<T> => {
		if (name !== 'elections') throw new Error(`unexpected engine ${name}`);
		return electionsEngine as unknown as T;
	};
	return {getEngine};
}

describe('splitItemId', () => {
	it('keeps colons inside the ballot id', () => {
		expect(splitItemId('a:b:mayor', 1)).toEqual({ballotId: 'a:b', codes: ['mayor']});
		expect(splitItemId('a:b:mayor:x', 2)).toEqual({ballotId: 'a:b', codes: ['mayor', 'x']});
	});

	it('rejects ids with too few or empty segments', () => {
		expect(splitItemId('mayor', 1)).toBeNull();
		expect(splitItemId('b::x', 2)).toBeNull();
		expect(splitItemId(':mayor', 1)).toBeNull();
	});
});

describe('readElectionInfo', () => {
	it('returns the authority-published election detail', async () => {
		await expect(readElectionInfo(fakeDeps())).resolves.toEqual({
			title: 'City Election',
			authorityName: 'County Clerk',
			date: D,
			instructions: 'Bring ID.',
			tags: ['city', 'general'],
		});
	});

	it('rejects with NoElectionError when the network lists no election and there is no fallback', async () => {
		await expect(readElectionInfo(fakeDeps({summaries: []}))).rejects.toBeInstanceOf(NoElectionError);
	});
});

describe('readOfficeInfo', () => {
	it('resolves the office by its composite id', async () => {
		await expect(readOfficeInfo(fakeDeps(), 'ballot:with:colons:mayor')).resolves.toEqual({
			title: 'Mayor',
			instructions: 'Choose one candidate for mayor.',
			voteFor: 2,
		});
	});

	it('rejects with InfoNotFoundError for an unknown question code', async () => {
		await expect(readOfficeInfo(fakeDeps(), 'ballot:with:colons:council')).rejects.toBeInstanceOf(InfoNotFoundError);
	});
});

describe('readCandidateInfo', () => {
	it('returns details, info link and image url', async () => {
		await expect(readCandidateInfo(fakeDeps(), 'ballot:with:colons:mayor:x')).resolves.toEqual({
			name: 'Ada X',
			details: 'Party X',
			infoURL: 'https://example.org/ada',
			imageUrl: 'https://example.org/ada.png',
		});
	});

	it('omits fields the authority did not publish', async () => {
		await expect(readCandidateInfo(fakeDeps(), 'ballot:with:colons:mayor:y')).resolves.toEqual({name: 'Bo Y'});
	});

	it('rejects with InfoNotFoundError for an unknown option code', async () => {
		await expect(readCandidateInfo(fakeDeps(), 'ballot:with:colons:mayor:z')).rejects.toBeInstanceOf(InfoNotFoundError);
	});
});

describe('readRegistrationDeadline', () => {
	it('returns the timeline registrationEnds instant', async () => {
		await expect(readRegistrationDeadline(fakeDeps())).resolves.toEqual({
			electionId: 'e-1',
			electionTitle: 'City Election',
			registrationEnds: D - 1000,
		});
	});

	it('leaves registrationEnds absent when the timeline publishes none — never defaulted', async () => {
		const result = await readRegistrationDeadline(fakeDeps({timeline: {}}));
		expect(result).toEqual({electionId: 'e-1', electionTitle: 'City Election'});
		expect('registrationEnds' in result).toBe(false);
	});
});
