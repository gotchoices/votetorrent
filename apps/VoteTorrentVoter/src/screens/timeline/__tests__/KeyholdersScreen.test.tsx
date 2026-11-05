/**
 * Unit tests for KeyholdersScreen (Phase 59, plan 59-10, D-15). Mounts inside a real
 * `ThemeProvider value={lightTheme}` (mirrors `SettingsScreen.test.tsx`'s pattern — this screen
 * calls the real `useTheme()`, not a hand-typed mock) with an inline `jest.mock` factory for
 * `providers/VoterAppProvider` exposing controllable `getEngine`, `getElection` and
 * `seededElectionId` (the manual mock at `providers/__mocks__/VoterAppProvider.tsx` cannot be
 * used — its `getEngine` unconditionally throws).
 *
 * Production-length fixtures throughout (59-UI-SPEC.md / project standing rule): a 53-char
 * election title and two realistic authority-authored keyholder names, one of which is 50 chars.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import * as fs from 'fs';
import * as path from 'path';
import {Text} from 'react-native';
import {ThemeProvider} from '@react-navigation/native';
import '../../../i18n'; // initializes the global i18next instance useTranslation() reads from
import {lightTheme} from '../../../theme/themes';

// ---- Production-length fixtures (59-UI-SPEC.md, no hand-picked short strings) ----

const PRODUCTION_ELECTION_TITLE = 'Salt Lake County School Board Special Election 2025'; // 53 chars
const SEEDED_ELECTION_ID = 'election-1';
const KEYHOLDER_NAME_1 = 'María-Fernanda Quintanilla-Barragán';
const KEYHOLDER_NAME_2 = "Salt Lake County Clerk's Office Records Division"; // 49 chars

const SUMMARY_A = {
	id: SEEDED_ELECTION_ID,
	title: PRODUCTION_ELECTION_TITLE,
	authorityName: 'Salt Lake County',
	date: Date.now() + 180 * 86_400_000,
	type: 'adhoc',
};

function buildKeyholders(names: string[]) {
	return names.map(name => ({invite: {name}}));
}

function buildElectionDetails(keyholders: Array<{invite: {name: string}}>) {
	return {
		election: {
			id: SEEDED_ELECTION_ID,
			authorityId: 'authority-1',
			title: PRODUCTION_ELECTION_TITLE,
			date: SUMMARY_A.date,
			revisionDeadline: SUMMARY_A.date - 30 * 86_400_000,
			ballotDeadline: SUMMARY_A.date - 7 * 86_400_000,
			type: 'adhoc',
		},
		current: {
			electionId: SEEDED_ELECTION_ID,
			revision: 0,
			revisionTimestamp: [],
			tags: [],
			instructions: '',
			keyholders,
			timeline: {},
			keyholderThreshold: 1,
		},
	};
}

// ---- Mocked engine boundary: getEngine('elections') -> getElections/openElection/getElectionDetails ----

const mockGetElectionDetails = jest.fn(async () => buildElectionDetails(buildKeyholders([KEYHOLDER_NAME_1, KEYHOLDER_NAME_2])));
const mockElectionEngine = {getElectionDetails: mockGetElectionDetails};

const mockOpenElection = jest.fn(async (_id: string) => mockElectionEngine);
const mockGetElections = jest.fn(async () => [SUMMARY_A]);
const mockElectionsEngine = {getElections: mockGetElections, openElection: mockOpenElection};

const mockGetEngine = jest.fn(async (engineName: string) => {
	if (engineName === 'elections') {
		return mockElectionsEngine;
	}
	throw new Error(`unexpected getEngine call: ${engineName}`);
});

// The election-level released/total surface (D-04) — a SEPARATE read from the engine chain.
const mockGetElection = jest.fn(async () => ({
	id: SEEDED_ELECTION_ID,
	title: PRODUCTION_ELECTION_TITLE,
	lifecycleState: 'ReleasingKeys' as const,
}));

let mockSeededElectionId: string | undefined = SEEDED_ELECTION_ID;

jest.mock('../../../providers/VoterAppProvider', () => ({
	useVoterApp: () => ({
		getEngine: mockGetEngine,
		getElection: mockGetElection,
		get seededElectionId() {
			return mockSeededElectionId;
		},
	}),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const KeyholdersScreen = require('../KeyholdersScreen').default;

function renderScreen() {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(
			<ThemeProvider value={lightTheme}>
				<KeyholdersScreen />
			</ThemeProvider>,
		);
	});
	return tr;
}

async function flushMicrotasks(times = 30) {
	for (let i = 0; i < times; i++) {
		await Promise.resolve();
	}
}

async function renderAndFlush(flushes = 30) {
	const tr = renderScreen();
	await renderer.act(async () => {
		await flushMicrotasks(flushes);
	});
	return tr;
}

/** Collects every rendered <Text> node's string content into one searchable string. */
function allText(tr: renderer.ReactTestRenderer): string {
	return tr.root
		.findAllByType(Text)
		.map(node => {
			const children = node.props.children;
			return Array.isArray(children) ? children.join('') : String(children ?? '');
		})
		.join(' | ');
}

/** Walks the rendered JSON tree looking for any node whose props carry an `isAccepted` key. */
function findsIsAcceptedProp(json: unknown): boolean {
	if (json === null || json === undefined) return false;
	const nodes: unknown[] = Array.isArray(json) ? json : [json];
	for (const node of nodes) {
		if (node === null || typeof node !== 'object') continue;
		const typed = node as {props?: Record<string, unknown>; children?: unknown};
		if (typed.props && Object.prototype.hasOwnProperty.call(typed.props, 'isAccepted')) {
			return true;
		}
		if (typed.children && findsIsAcceptedProp(typed.children)) {
			return true;
		}
	}
	return false;
}

beforeEach(() => {
	mockGetEngine.mockClear();
	mockGetElection.mockClear();
	mockGetElections.mockClear();
	mockOpenElection.mockClear();
	mockGetElectionDetails.mockClear();

	mockGetEngine.mockImplementation(async (engineName: string) => {
		if (engineName === 'elections') {
			return mockElectionsEngine;
		}
		throw new Error(`unexpected getEngine call: ${engineName}`);
	});
	mockGetElections.mockImplementation(async () => [SUMMARY_A]);
	mockOpenElection.mockImplementation(async (_id: string) => mockElectionEngine);
	mockGetElectionDetails.mockImplementation(async () => buildElectionDetails(buildKeyholders([KEYHOLDER_NAME_1, KEYHOLDER_NAME_2])));
	mockGetElection.mockImplementation(async () => ({
		id: SEEDED_ELECTION_ID,
		title: PRODUCTION_ELECTION_TITLE,
		lifecycleState: 'ReleasingKeys' as const,
	}));

	mockSeededElectionId = SEEDED_ELECTION_ID;
});

describe('KeyholdersScreen — names render verbatim (D-15)', () => {
	it('renders both production-length keyholder names', async () => {
		const tr = await renderAndFlush();
		const text = allText(tr);
		expect(text).toContain(KEYHOLDER_NAME_1);
		expect(text).toContain(KEYHOLDER_NAME_2);
	});
});

describe('KeyholdersScreen — the no-status contract (D-15)', () => {
	it('the rendered text contains no accepted/invited/revoked wording, case-insensitive', async () => {
		const tr = await renderAndFlush();
		const text = allText(tr).toLowerCase();
		expect(text).not.toContain('accepted');
		expect(text).not.toContain('invited');
		expect(text).not.toContain('revoked');
	});

	it('no rendered node carries an isAccepted prop', async () => {
		const tr = await renderAndFlush();
		expect(findsIsAcceptedProp(tr.toJSON())).toBe(false);
	});

	it('(anti-vacuity) the isAccepted walker DOES detect a planted isAccepted prop on a synthetic tree', () => {
		const syntheticTree = {
			type: 'View',
			props: {isAccepted: true},
			children: null,
		};
		expect(findsIsAcceptedProp(syntheticTree)).toBe(true);
	});
});

describe('KeyholdersScreen — empty state (D-15)', () => {
	it('renders emptyHeading + emptyBody and suppresses the releasedCount line when there are no keyholders', async () => {
		mockGetElectionDetails.mockImplementation(async () => buildElectionDetails([]));
		const tr = await renderAndFlush();
		const text = allText(tr);
		expect(text).toContain('No keyholders yet');
		expect(text).toContain('This election has no keyholders assigned yet.');
		expect(text).not.toContain('keys released');
	});
});

describe('KeyholdersScreen — read failure never falls through to the empty state (D-03)', () => {
	it('a rejecting getEngine renders indeterminate.heading, never emptyHeading', async () => {
		mockGetEngine.mockImplementation(async () => {
			throw new Error('boom');
		});
		const tr = await renderAndFlush();
		const text = allText(tr);
		expect(text).toContain("We can't show this election's timeline right now");
		expect(text).not.toContain('No keyholders yet');
	});
});

describe('KeyholdersScreen — an unmeasured released count is hidden, never "0 of N" (D-04)', () => {
	it('a real election read (no keysReleased) lists the keyholders but renders no released-count line', async () => {
		const tr = await renderAndFlush();
		const text = allText(tr);
		expect(text).toContain(KEYHOLDER_NAME_1);
		expect(text).not.toContain('keys released');
		expect(tr.root.findAllByProps({testID: 'keyholders-released-count'})).toHaveLength(0);
	});

	it('a rejecting getElection costs only the count line — the list still renders, not indeterminate', async () => {
		mockGetElection.mockImplementation(async () => {
			throw new Error('indeterminate timeline');
		});
		const tr = await renderAndFlush();
		const text = allText(tr);
		expect(text).toContain(KEYHOLDER_NAME_2);
		expect(text).not.toContain('keys released');
		expect(text).not.toContain("We can't show this election's timeline right now");
	});
});

describe('KeyholdersScreen — released count clamp (D-04)', () => {
	it('keysReleased: 9 against a two-keyholder election with no keysTotal clamps to "2 of 2", never "9 of 2"', async () => {
		mockGetElection.mockImplementation(async () => ({
			id: SEEDED_ELECTION_ID,
			title: PRODUCTION_ELECTION_TITLE,
			lifecycleState: 'ReleasingKeys' as const,
			keysReleased: 9,
			// keysTotal intentionally absent -- falls back to keyholders.length (2).
		}));
		const tr = await renderAndFlush();
		const text = allText(tr);
		expect(text).toContain('2 of 2 keys released');
		expect(text).not.toContain('9 of 2');
	});
});

describe('KeyholdersScreen — source assertions (D-15, T-59-10-01)', () => {
	const source = fs.readFileSync(path.join(__dirname, '../KeyholdersScreen.tsx'), 'utf8');

	function stripComments(text: string): string {
		return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
	}

	const stripped = stripComments(source);

	it('(anti-vacuity) the stripped source is non-empty and DOES contain invite.name', () => {
		expect(stripped.length).toBeGreaterThan(0);
		expect(stripped).toContain('invite.name');
	});

	it('contains none of isAccepted, .result, inviteKey, inviteSignature', () => {
		expect(stripped).not.toContain('isAccepted');
		expect(stripped).not.toContain('.result');
		expect(stripped).not.toContain('inviteKey');
		expect(stripped).not.toContain('inviteSignature');
	});
});
