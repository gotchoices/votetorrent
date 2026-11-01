/**
 * HomeScreen.test.tsx (Phase 63 plan 14) - H1..H13: Home derives its saved-vote state from the
 * marker on every focus (D-12, D-19, D-21). `readSavedVoteStatus` is mocked for the state cases;
 * H11 runs the real store and vault with an in-memory wrapper to prove zero prompts.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import * as fs from 'fs';
import * as path from 'path';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {NavigationContainer, createNavigationContainerRef, useRoute} from '@react-navigation/native';
import type {ParamListBase} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
jest.mock('../../../providers/VoterAppProvider');
jest.mock('../../../providers/CadreNodeProvider', () => ({
	useCadreNode: () => ({node: null, syncState: 'offline', connectedPeers: () => 0}),
	CadreNodeProvider: ({children}: {children: React.ReactNode}) => children,
}));
jest.mock('../../../engines/saved-vote-status', () => ({
	...jest.requireActual('../../../engines/saved-vote-status'),
	readSavedVoteStatus: jest.fn(),
}));
import {VoterAppProvider} from '../../../providers/VoterAppProvider';
import * as savedVoteStatus from '../../../engines/saved-vote-status';
import {createInMemorySecretWrapperForTests} from '../../../engines/__fixtures__/in-memory-secret-wrapper';
import type {InMemorySecretWrapper} from '../../../engines/__fixtures__/in-memory-secret-wrapper';
import {createVoteRecordWrapProvider, setVoteRecordWrapProviderForTests} from '../../../engines/vote-record-wrap';
import {isVoteRecord, sealVoteRecord} from '../../../engines/vote-record-vault';
import type {VoteRecord} from '../../../engines/vote-record-vault';
import {buildVoteMarker, writeVoteRecord} from '../../../engines/vote-record-store';
import {recordVoteSent} from '../../../engines/vote-sent-store';
import {LIFECYCLE_ORDER} from '../../../providers/types';
import HomeScreen from '../HomeScreen';
import {lightTheme} from '../../../theme/themes';
import i18n, {resources} from '../../../i18n';

const readStatus = savedVoteStatus.readSavedVoteStatus as jest.Mock;
const mockProvider = jest.requireMock('../../../providers/VoterAppProvider') as {
	__setMockGetElectionFailure: (e?: Error) => void;
};

const EID = 'fixture-election-1';
const EN_STALE = 'The election changed after you voted. Please vote again.';
const PROMPT = {title: 'Seal', subtitle: 'Seal', negativeButton: 'Cancel'};

function randHex(bytes: number): string {
	const a = new Uint8Array(bytes);
	globalThis.crypto.getRandomValues(a);
	return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}

function makeRecord(electionId: string, electionRevision: number): VoteRecord {
	const record: VoteRecord = {
		v: 1,
		electionId,
		electionRevision,
		savedAt: '2026-10-06T12:00:00.000Z',
		votes: [
			{
				v: 1,
				electionId,
				electionRevision,
				ballotId: 'ballot-1',
				templateDigest: 'td-' + randHex(4),
				answers: [{questionCode: 'q-a', optionCodes: ['o-1']}],
				nonce: randHex(32),
			},
		],
		voter: {
			v: 1,
			electionId,
			electionRevision,
			registrantId: 'reg-' + randHex(4),
			privateCid: 'cid-' + randHex(4),
			publicCid: null,
			deviceKey: 'dk-' + randHex(4),
			attestationCid: null,
			ballots: [{ballotId: 'ballot-1', templateDigest: 'td'}],
			signature: 'sig-' + randHex(8),
		},
	};
	if (!isVoteRecord(record)) {
		throw new Error('invalid record');
	}
	return record;
}

let receiptParams: unknown;
function ReceiptProbe() {
	receiptParams = useRoute().params;
	return null;
}
function DummyScreen() {
	return null;
}

const Stack = createNativeStackNavigator();
let navRef = createNavigationContainerRef<ParamListBase>();
let tr: renderer.ReactTestRenderer | null = null;
let wrapper: InMemorySecretWrapper;

async function flush() {
	for (let i = 0; i < 8; i++) {
		await renderer.act(async () => {
			await new Promise<void>(resolve => setTimeout(resolve, 0));
		});
	}
}

async function mount() {
	navRef = createNavigationContainerRef<ParamListBase>();
	receiptParams = undefined;
	await renderer.act(async () => {
		tr = renderer.create(
			<NavigationContainer ref={navRef} theme={lightTheme}>
				<VoterAppProvider>
					<Stack.Navigator initialRouteName="Home" screenOptions={{headerShown: false}}>
						<Stack.Screen name="Home" component={HomeScreen} />
						<Stack.Screen name="Ballot" component={DummyScreen} />
						<Stack.Screen name="ValidationDetails" component={DummyScreen} />
						<Stack.Screen name="VoteReceipt" component={ReceiptProbe} />
					</Stack.Navigator>
				</VoterAppProvider>
			</NavigationContainer>,
		);
	});
	await flush();
}

function hosts(id: string) {
	return tr!.root.findAll(n => typeof n.type === 'string' && n.props.testID === id);
}
function has(id: string): boolean {
	return hosts(id).length > 0;
}
function textOf(node: renderer.ReactTestInstance | string): string {
	if (typeof node === 'string') {
		return node;
	}
	return node.children.map(c => textOf(c as renderer.ReactTestInstance | string)).join('');
}
function textById(id: string): string {
	return textOf(hosts(id)[0]);
}
async function press(id: string) {
	const node = tr!.root.findAllByProps({testID: id}).find(n => typeof n.props.onPress === 'function');
	if (!node) {
		throw new Error(`no pressable ${id}`);
	}
	await renderer.act(async () => {
		node.props.onPress();
	});
	await flush();
}
async function cycleTo(state: string) {
	for (let i = 0; i <= LIFECYCLE_ORDER.length + 1; i++) {
		if (textById('home-dev-lifecycle-cycler').includes(`Dev state: ${state} `)) {
			return;
		}
		await press('home-dev-lifecycle-cycler');
	}
	throw new Error(`could not cycle to ${state}`);
}
async function mountOpen(status: unknown) {
	readStatus.mockResolvedValue(status);
	await mount();
	await cycleTo('Open');
}

const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m =>
	jest.spyOn(console, m).mockImplementation(() => undefined),
);

beforeEach(async () => {
	await AsyncStorage.clear();
	wrapper = createInMemorySecretWrapperForTests();
	setVoteRecordWrapProviderForTests(createVoteRecordWrapProvider(wrapper));
	readStatus.mockReset();
	readStatus.mockResolvedValue({state: 'none'});
});

afterEach(async () => {
	if (tr) {
		await renderer.act(async () => {
			tr!.unmount();
		});
		tr = null;
	}
	mockProvider.__setMockGetElectionFailure();
	await i18n.changeLanguage('en');
});

afterAll(() => {
	setVoteRecordWrapProviderForTests(undefined);
	for (const s of consoleSpies) {
		expect(s).not.toHaveBeenCalled();
		s.mockRestore();
	}
});

describe('HomeScreen saved vote (D-12, D-19, D-21)', () => {
	it('H1: reads the status with the engine deps, the shared clock and the election id', async () => {
		await mount();
		expect(readStatus).toHaveBeenCalled();
		const [deps, nowMs, electionId] = readStatus.mock.calls[0];
		expect(deps).toEqual({getEngine: expect.any(Function), fallbackElectionId: undefined});
		expect(Math.abs(nowMs - Date.now())).toBeLessThan(5000);
		expect(electionId).toBe(EID);
	});

	it('H2: none shows vote-now and no saved-vote node', async () => {
		await mountOpen({state: 'none'});
		expect(has('election-card-vote-now')).toBe(true);
		expect(JSON.stringify(tr!.toJSON())).not.toContain('election-card-saved-vote');
	});

	it('H3: saved shows the status, hides vote-now, and the link opens the receipt with electionId only', async () => {
		await mountOpen({state: 'saved', revisionKnown: true});
		expect(textById('election-card-saved-vote-status')).toBe('Vote saved — not sent');
		expect(has('election-card-vote-now')).toBe(false);
		await press('election-card-saved-vote-view');
		expect(navRef.getCurrentRoute()?.name).toBe('VoteReceipt');
		expect(receiptParams).toEqual({electionId: EID});
		expect(Object.keys(receiptParams as object)).toEqual(['electionId']);
	});

	it('H4: stale shows the exact D-21 line, vote-now and the link', async () => {
		await mountOpen({state: 'stale', revisionKnown: true});
		expect(textById('election-card-saved-vote-stale')).toBe(EN_STALE);
		expect(has('election-card-vote-now')).toBe(true);
		expect(has('election-card-saved-vote-view')).toBe(true);
	});

	it('H5: unreadable shows the unreadable line and hides vote-now', async () => {
		await mountOpen({state: 'unreadable'});
		expect(textById('election-card-saved-vote-unreadable')).toBe("Your saved vote can't be read on this phone.");
		expect(has('election-card-vote-now')).toBe(false);
	});

	it('H6: an unknown revision adds the honest note', async () => {
		await mountOpen({state: 'saved', revisionKnown: false});
		expect(textById('election-card-saved-vote-revision-unknown')).toBe(
			"We couldn't check whether the election has changed since you voted.",
		);
	});

	it('H7: re-reads on every focus and never caches', async () => {
		await mountOpen({state: 'none'});
		expect(has('election-card-vote-now')).toBe(true);
		readStatus.mockResolvedValue({state: 'saved', revisionKnown: true});
		await renderer.act(async () => {
			navRef.navigate('VoteReceipt', {electionId: EID});
		});
		await flush();
		const before = readStatus.mock.calls.length;
		await renderer.act(async () => {
			navRef.goBack();
		});
		await flush();
		expect(readStatus.mock.calls.length).toBe(before + 1);
		expect(textById('election-card-saved-vote-status')).toBe('Vote saved — not sent');
		expect(has('election-card-vote-now')).toBe(false);
	});

	// UAT 65 gap 2 (Run 4): the first return to Home 29 s after Sent still read "not sent"; later
	// returns read sent. The focus read waits on the strand election read before it looks at the sent
	// store, so a slow first read left the pre-send line on screen. Unproven on device: modelled here
	// as a strand read that has not landed yet.
	async function sendWhileOnReceipt(fullRead: () => Promise<unknown>) {
		const record = makeRecord(EID, 2);
		await writeVoteRecord(await sealVoteRecord(record, {prompt: PROMPT}), buildVoteMarker(record));
		await mountOpen({state: 'saved', revisionKnown: true});
		expect(has('election-card-saved-vote-status')).toBe(true);
		await renderer.act(async () => {
			navRef.navigate('VoteReceipt', {electionId: EID});
		});
		await flush();
		await recordVoteSent(EID, 2, 'ballot-1', 'cid-sent');
		readStatus.mockImplementation(fullRead);
		await renderer.act(async () => {
			navRef.goBack();
		});
		await flush();
	}

	it('H14: back from a send, Home shows sent before the slow full read lands (gap 2)', async () => {
		await sendWhileOnReceipt(() => new Promise(() => undefined));
		expect(has('election-card-saved-vote-sent')).toBe(true);
		expect(has('election-card-saved-vote-status')).toBe(false);
	});

	it('H15: the full read keeps the last word (stale wins over the local sent line)', async () => {
		let land: (s: unknown) => void = () => undefined;
		await sendWhileOnReceipt(() => new Promise(r => { land = r; }));
		expect(has('election-card-saved-vote-sent')).toBe(true);
		await renderer.act(async () => {
			land({state: 'stale', revisionKnown: true});
		});
		await flush();
		expect(has('election-card-saved-vote-stale')).toBe(true);
		expect(has('election-card-saved-vote-sent')).toBe(false);
	});

	it('H16: with nothing in the sent store the saved line stays until the full read lands', async () => {
		const record = makeRecord(EID, 2);
		await writeVoteRecord(await sealVoteRecord(record, {prompt: PROMPT}), buildVoteMarker(record));
		await mountOpen({state: 'saved', revisionKnown: true});
		await renderer.act(async () => {
			navRef.navigate('VoteReceipt', {electionId: EID});
		});
		await flush();
		readStatus.mockImplementation(() => new Promise(() => undefined));
		await renderer.act(async () => {
			navRef.goBack();
		});
		await flush();
		expect(has('election-card-saved-vote-status')).toBe(true);
		expect(has('election-card-saved-vote-sent')).toBe(false);
	});

	it('H8: a rejected read fails closed to unreadable with no error text', async () => {
		readStatus.mockRejectedValue(new Error('secret failure detail'));
		await mount();
		await cycleTo('Open');
		expect(has('election-card-saved-vote-unreadable')).toBe(true);
		expect(has('election-card-vote-now')).toBe(false);
		expect(JSON.stringify(tr!.toJSON())).not.toContain('secret failure detail');
	});

	it('H9: with no election the unavailable message shows and no read happens', async () => {
		mockProvider.__setMockGetElectionFailure(new Error('x'));
		await mount();
		expect(has('home-election-unavailable')).toBe(true);
		expect(readStatus).not.toHaveBeenCalled();
	});

	it('H10: es status line', async () => {
		await i18n.changeLanguage('es');
		await mountOpen({state: 'saved', revisionKnown: true});
		expect(textById('election-card-saved-vote-status')).toBe(
			(resources.es.ballot as unknown as Record<string, string>)['savedVote.status'],
		);
	});

	it('H11: real store and vault, zero prompts (D-19)', async () => {
		const record = makeRecord(EID, 2);
		const env = await sealVoteRecord(record, {prompt: PROMPT});
		await writeVoteRecord(env, buildVoteMarker(record));
		const snap = {p: wrapper.promptCount, u: wrapper.unwrapCalls, w: wrapper.wrapCalls};
		readStatus.mockImplementation(
			(jest.requireActual('../../../engines/saved-vote-status') as typeof savedVoteStatus).readSavedVoteStatus,
		);
		await mount();
		await cycleTo('Open');
		expect(textById('election-card-saved-vote-status')).toBe('Vote saved — not sent');
		expect(has('election-card-saved-vote-revision-unknown')).toBe(true);
		expect(has('election-card-vote-now')).toBe(false);
		expect({p: wrapper.promptCount, u: wrapper.unwrapCalls, w: wrapper.wrapCalls}).toEqual(snap);
	});

	describe('H12: source discipline', () => {
		const raw = fs.readFileSync(path.join(__dirname, '..', 'HomeScreen.tsx'), 'utf8');
		const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
		it.each(['useVoterApp(', 'useFocusEffect(', 'readSavedVoteStatus(', 'nowMs()', "navigation.navigate('VoteReceipt', {electionId"])(
			'contains %s',
			needle => {
				expect(code).toContain(needle);
			},
		);
		it.each(['has' + 'Voted', 'revealOnOpen', 'AsyncStorage', 'voteMarkerKey', 'openVoteRecord', 'console.'])(
			'does not contain %s',
			needle => {
				expect(code).not.toContain(needle);
			},
		);
		it('the raw file has no stale flag comment', () => {
			expect(raw).not.toContain('has' + 'Voted');
			expect(raw.toLowerCase()).not.toContain('submitted');
		});
	});

	it('H13: never logs', async () => {
		await mountOpen({state: 'saved', revisionKnown: true});
		for (const s of consoleSpies) {
			expect(s).not.toHaveBeenCalled();
		}
	});
});
