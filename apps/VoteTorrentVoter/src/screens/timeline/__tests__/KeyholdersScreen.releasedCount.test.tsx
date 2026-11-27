/**
 * KeyholdersScreen.releasedCount.test.tsx — 62-29 (D-17): the election-level released count the
 * screen renders is the release engine's accepted count carried by `getElection()`. Mounted inside
 * a real ThemeProvider with real Voter i18n (EN and ES). K1 position/copy, K2 geometry, K3 an
 * absent count is hidden (never an implied 0) and an over-count clamps.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {StyleSheet, Text} from 'react-native';
import {ThemeProvider} from '@react-navigation/native';
import i18n from '../../../i18n';
import {lightTheme} from '../../../theme/themes';

const ELECTION_ID = 'election-1';
const TITLE = 'Salt Lake County School Board Special Election 2025';
const NAMES = ['María-Fernanda Quintanilla-Barragán', "Salt Lake County Clerk's Office Records Division"];

function details(count: number) {
	return {
		election: {id: ELECTION_ID, authorityId: 'a-1', title: TITLE, date: Date.now() + 86_400_000, revisionDeadline: 0, ballotDeadline: 0, type: 'adhoc'},
		current: {
			electionId: ELECTION_ID,
			revision: 0,
			revisionTimestamp: [],
			tags: [],
			instructions: '',
			keyholders: Array.from({length: count}, (_v, i) => ({invite: {name: NAMES[i % 2] + ` ${i}`}})),
			timeline: {},
			keyholderThreshold: 1,
		},
	};
}

let mockKeyholderCount = 5;
const mockGetElection = jest.fn(async (): Promise<unknown> => ({id: ELECTION_ID, title: TITLE, lifecycleState: 'ReleasingKeys' as const}));

const mockGetEngine = jest.fn(async (name: string) => {
	if (name !== 'elections') throw new Error(`unexpected getEngine call: ${name}`);
	return {
		getElections: async () => [{id: ELECTION_ID, title: TITLE, authorityName: 'a', date: Date.now() + 86_400_000, type: 'adhoc'}],
		openElection: async () => ({getElectionDetails: async () => details(mockKeyholderCount)}),
	};
});

jest.mock('../../../providers/VoterAppProvider', () => ({
	useVoterApp: () => ({getEngine: mockGetEngine, getElection: mockGetElection, seededElectionId: 'election-1'}),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const KeyholdersScreen = require('../KeyholdersScreen').default;

const mounted: renderer.ReactTestRenderer[] = [];

async function setLanguage(lng: 'en' | 'es') {
	await renderer.act(async () => {
		await i18n.changeLanguage(lng);
	});
}

async function mount() {
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(
			<ThemeProvider value={lightTheme}>
				<KeyholdersScreen />
			</ThemeProvider>,
		);
		for (let i = 0; i < 30; i++) await Promise.resolve();
	});
	mounted.push(tr);
	return tr;
}

function textOf(node: renderer.ReactTestInstance): string {
	const parts: string[] = [];
	const walk = (n: renderer.ReactTestInstance | string) => {
		if (typeof n === 'string') parts.push(n);
		else n.children.forEach(walk);
	};
	walk(node);
	return parts.join('');
}

function countNode(tr: renderer.ReactTestRenderer) {
	return tr.root.findAll(n => n.props?.testID === 'keyholders-released-count' && n.type === Text);
}

afterEach(async () => {
	for (const tr of mounted.splice(0)) {
		renderer.act(() => tr.unmount());
	}
	mockKeyholderCount = 5;
	await setLanguage('en');
});

describe('KeyholdersScreen released count (62-29, D-17)', () => {
	it('K1: keysReleased 3 of keysTotal 5 renders the full catalog string before the first keyholder row, EN and ES', async () => {
		mockGetElection.mockResolvedValue({id: ELECTION_ID, title: TITLE, lifecycleState: 'ReleasingKeys', keysReleased: 3, keysTotal: 5});
		for (const [lng, expected] of [['en', '3 of 5 keys released'], ['es', '3 de 5 claves liberadas']] as const) {
			await setLanguage(lng);
			const tr = await mount();
			const nodes = countNode(tr);
			expect(nodes).toHaveLength(1);
			expect(textOf(nodes[0]!)).toBe(expected);
			expect(tr.root.findAll(n => n.props?.testID === 'keyholders-row' && (n.type as unknown) === 'View').length).toBe(5);
			// Document order: the count line precedes the first row.
			const order: string[] = [];
			const walk = (n: renderer.ReactTestInstance | string) => {
				if (typeof n === 'string') return;
				const id = n.props?.testID;
				if (typeof n.type === 'string' || n.type === Text) {
					if (id === 'keyholders-released-count' || id === 'keyholders-row') order.push(id);
				}
				n.children.forEach(walk);
			};
			walk(tr.root);
			expect(order[0]).toBe('keyholders-released-count');
			expect(order.indexOf('keyholders-row')).toBeGreaterThan(0);
		}
	});

	it('K2 geometry: the count Text is never truncated or clipped, and 12 of 12 renders in full under ES', async () => {
		mockKeyholderCount = 12;
		mockGetElection.mockResolvedValue({id: ELECTION_ID, title: TITLE, lifecycleState: 'ReleasingKeys', keysReleased: 12, keysTotal: 12});
		await setLanguage('es');
		const tr = await mount();
		const node = countNode(tr)[0]!;
		expect(textOf(node)).toBe('12 de 12 claves liberadas');
		expect(node.props.numberOfLines).toBeUndefined();
		expect(node.props.ellipsizeMode).toBeUndefined();
		let anc: renderer.ReactTestInstance | null = node.parent;
		while (anc) {
			const flat = (StyleSheet.flatten(anc.props?.style) ?? {}) as Record<string, unknown>;
			expect(flat.height).toBeUndefined();
			expect(flat.maxHeight).toBeUndefined();
			expect(flat.overflow).not.toBe('hidden');
			anc = anc.parent;
		}
	});

	it('K3: an absent keysReleased renders no count line (never an implied 0); 9 against 5 keyholders clamps to 5 of 5', async () => {
		mockGetElection.mockResolvedValue({id: ELECTION_ID, title: TITLE, lifecycleState: 'ReleasingKeys'});
		let tr = await mount();
		expect(countNode(tr)).toHaveLength(0);
		expect(JSON.stringify(tr.toJSON())).not.toContain('keys released');

		mockGetElection.mockResolvedValue({id: ELECTION_ID, title: TITLE, lifecycleState: 'ReleasingKeys', keysReleased: 9});
		tr = await mount();
		expect(textOf(countNode(tr)[0]!)).toBe('5 of 5 keys released');
	});
});
