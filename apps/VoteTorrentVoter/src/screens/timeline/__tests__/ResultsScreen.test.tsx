/**
 * ResultsScreen.test.tsx — the Voter results screen picks the Timeline's election, computes its results through
 * the 'electionResults' engine, and renders each outcome. Mounted inside a real ThemeProvider with real Voter i18n.
 * The engine itself is covered by vote-engine's election-results.spec.ts.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {Text} from 'react-native';
import {ThemeProvider} from '@react-navigation/native';
import i18n from '../../../i18n';
import {lightTheme} from '../../../theme/themes';

const ELECTION_ID = 'election-1';

const TALLIED = {
	status: 'tallied',
	electionId: ELECTION_ID,
	revision: 1,
	threshold: 2,
	keyholdersUsed: 2,
	blockCount: 1,
	totals: {blocks: 1, entries: 3, valid: 3, invalid: 0, excluded: 0, undecryptable: 0},
	ballots: [
		{
			ballotId: 'ballot-1',
			description: 'Fruit poll',
			votes: 3,
			valid: 3,
			invalid: 0,
			excluded: 0,
			questions: [
				{
					code: 'Q1', title: 'Favourite fruit', type: 'select', counted: true, answered: 3, blank: 0,
					options: [
						{code: 'A', title: 'Apple', count: 2},
						{code: 'B', title: 'Banana', count: 1},
						{code: 'C', title: 'Mango', count: 0},
					],
				},
			],
		},
	],
	tallyRoot: 'ab',
	blockRoot: 'cd',
	tally: {},
};

let mockResults: unknown = TALLIED;
let mockElections: Array<{id: string}> = [{id: ELECTION_ID}];
const mockGetElectionResults = jest.fn(async (_id: string) => {
	if (mockResults instanceof Error) throw mockResults;
	return mockResults;
});
const mockGetEngine = jest.fn(async (name: string) => {
	if (name === 'elections') {
		return {getElections: async () => mockElections.map(e => ({...e, title: 't', authorityName: 'a', date: Date.now() + 86_400_000, type: 'adhoc'}))};
	}
	if (name === 'electionResults') return {getElectionResults: mockGetElectionResults};
	throw new Error(`unexpected getEngine call: ${name}`);
});

jest.mock('../../../providers/VoterAppProvider', () => ({
	useVoterApp: () => ({getEngine: mockGetEngine, seededElectionId: undefined}),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ResultsScreen = require('../ResultsScreen').default;

const mounted: renderer.ReactTestRenderer[] = [];

async function mount() {
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(
			<ThemeProvider value={lightTheme}>
				<ResultsScreen />
			</ThemeProvider>,
		);
		for (let i = 0; i < 30; i++) await Promise.resolve();
	});
	mounted.push(tr);
	return tr;
}

function text(tr: renderer.ReactTestRenderer, testID: string): string {
	const node = tr.root.findAll(n => n.props?.testID === testID && n.type === Text)[0];
	if (!node) throw new Error(`no ${testID}`);
	const parts: string[] = [];
	const walk = (n: renderer.ReactTestInstance | string) => {
		if (typeof n === 'string') parts.push(n);
		else n.children.forEach(walk);
	};
	walk(node);
	return parts.join('');
}

const has = (tr: renderer.ReactTestRenderer, testID: string) => tr.root.findAll(n => n.props?.testID === testID).length > 0;

beforeEach(async () => {
	mockResults = TALLIED;
	mockElections = [{id: ELECTION_ID}];
	mockGetElectionResults.mockClear();
	await renderer.act(async () => {
		await i18n.changeLanguage('en');
	});
});

afterEach(() => {
	for (const tr of mounted.splice(0)) renderer.act(() => tr.unmount());
});

describe('ResultsScreen', () => {
	it('counts the picked election and shows each option with its share', async () => {
		const tr = await mount();
		expect(mockGetElectionResults).toHaveBeenCalledWith(ELECTION_ID);
		expect(text(tr, 'results-valid-total')).toBe('Valid votes: 3');
		expect(text(tr, 'results-count-Q1-A')).toBe('2 (67%)');
		expect(text(tr, 'results-count-Q1-B')).toBe('1 (33%)');
		expect(text(tr, 'results-count-Q1-C')).toBe('0 (0%)');
		expect(has(tr, 'results-not-counted')).toBe(false);
	});

	it('shows the locked state and the released count before the keys are released', async () => {
		mockResults = {status: 'awaiting-keys', electionId: ELECTION_ID, phase: 'releasing', revision: 1, threshold: 2, participants: 2, releasedCount: 1, releasingKeysAt: null};
		const tr = await mount();
		expect(has(tr, 'results-awaiting-keys')).toBe(true);
		expect(text(tr, 'results-released-count')).toBe('1 of 2 needed keys released');
	});

	it('shows the refusal reason when the results cannot be worked out', async () => {
		mockResults = {status: 'unavailable', electionId: ELECTION_ID, reason: 'secret-mismatch', detail: 'x'};
		const tr = await mount();
		expect(text(tr, 'results-unavailable-reason')).toBe('Reason: secret-mismatch');
	});

	it('says there is no election when the phone has none, without computing anything', async () => {
		mockElections = [];
		const tr = await mount();
		expect(has(tr, 'results-no-election')).toBe(true);
		expect(mockGetElectionResults).not.toHaveBeenCalled();
	});

	it('shows a failure when the engine throws, and Refresh computes again', async () => {
		mockResults = new Error('boom');
		const tr = await mount();
		expect(has(tr, 'results-failed')).toBe(true);
		mockResults = TALLIED;
		const refresh = tr.root.findAll(n => n.props?.testID === 'results-refresh' && typeof n.props.onPress === 'function')[0]!;
		await renderer.act(async () => {
			refresh.props.onPress();
			for (let i = 0; i < 30; i++) await Promise.resolve();
		});
		expect(mockGetElectionResults).toHaveBeenCalledTimes(2);
		expect(text(tr, 'results-valid-total')).toBe('Valid votes: 3');
	});

	it('says no vote blocks have reached the phone (never a bare 0) when it has none yet', async () => {
		mockResults = {...TALLIED, blockCount: 0, totals: {...TALLIED.totals, blocks: 0, entries: 0, valid: 0}};
		const tr = await mount();
		expect(has(tr, 'results-no-blocks')).toBe(true);
		expect(has(tr, 'results-valid-total')).toBe(false);
	});

	it('renders in Spanish', async () => {
		await renderer.act(async () => {
			await i18n.changeLanguage('es');
		});
		const tr = await mount();
		expect(text(tr, 'results-valid-total')).toBe('Votos válidos: 3');
	});
});
