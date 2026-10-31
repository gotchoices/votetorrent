/**
 * VoteReceiptScreen.test.tsx (Phase 63 plan 12) - S1..S15: zero prompts for the status and loss
 * lines, reveal-on-tap, revealOnOpen, blur re-hide, grouped nonces, exact copy, stale,
 * revision-unknown, unreadable, none, canceled, es, Done and source assertions.
 *
 * Real store, real vault, in-memory secret wrapper. Real device prompt counts are proven only by
 * the 63-18 legs.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {AppState, Platform} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {NavigationContainer, createNavigationContainerRef} from '@react-navigation/native';
import type {ParamListBase} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import type {Ballot} from '@votetorrent/vote-core';
jest.mock('../../../providers/VoterAppProvider');
// CR-01 (review): observe the FLAG_SECURE toggle; everything else in the package stays real.
jest.mock('@votetorrent/attestation-native', () => ({
	...jest.requireActual('@votetorrent/attestation-native'),
	setSecureScreen: jest.fn(async () => false),
}));
jest.mock('../../../engines/vote-receipt', () => ({
	...jest.requireActual('../../../engines/vote-receipt'),
	readReceiptElection: jest.fn(),
}));
import {VoterAppProvider} from '../../../providers/VoterAppProvider';
import * as receipt from '../../../engines/vote-receipt';
import {createInMemorySecretWrapperForTests} from '../../../engines/__fixtures__/in-memory-secret-wrapper';
import type {InMemorySecretWrapper} from '../../../engines/__fixtures__/in-memory-secret-wrapper';
import {
	createVoteRecordWrapProvider,
	setVoteRecordWrapProviderForTests,
} from '../../../engines/vote-record-wrap';
import {isVoteRecord, sealVoteRecord} from '../../../engines/vote-record-vault';
import type {VoteRecord} from '../../../engines/vote-record-vault';
import {
	buildVoteMarker,
	voteMarkerKey,
	voteRecordKey,
	writeVoteRecord,
} from '../../../engines/vote-record-store';
import VoteReceiptScreen from '../VoteReceiptScreen';
import {ToastProvider} from '../../../components/Toast';
import {lightTheme} from '../../../theme/themes';
import i18n, {resources} from '../../../i18n';
import {setSecureScreen} from '@votetorrent/attestation-native';

const secureCalls = setSecureScreen as jest.Mock;

const readElection = receipt.readReceiptElection as jest.Mock;

const EN_STATUS = 'Your vote is saved on this phone. It has not been sent to the election yet.';
const EN_LOSS =
	"Your vote exists only on this phone. Clearing this app's data or reinstalling the app deletes it.";
const EN_STALE = 'The election changed after you voted. Please vote again.';
const EN_WARNING = 'Anyone with this code can find how you voted.';
const PROMPT = {title: 'Seal', subtitle: 'Seal', negativeButton: 'Cancel'};

function randHex(bytes: number): string {
	const a = new Uint8Array(bytes);
	globalThis.crypto.getRandomValues(a);
	return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}

function makeRecord(electionId = 'e1', electionRevision = 2): VoteRecord {
	const ids = ['ballot-1', 'ballot-2'];
	const record: VoteRecord = {
		v: 1,
		electionId,
		electionRevision,
		savedAt: '2026-10-06T12:00:00.000Z',
		votes: ids.map((ballotId, i) => ({
			v: 1 as const,
			electionId,
			electionRevision,
			ballotId,
			templateDigest: 'td-' + randHex(4),
			answers: i === 0 ? [{questionCode: 'q-a', optionCodes: ['o-1']}] : [],
			nonce: randHex(32),
		})),
		voter: {
			v: 1,
			electionId,
			electionRevision,
			registrantId: 'reg-' + randHex(4),
			privateCid: 'cid-' + randHex(4),
			publicCid: null,
			deviceKey: 'dk-' + randHex(4),
			attestationCid: null,
			ballots: ids.map(ballotId => ({ballotId, templateDigest: 'td'})),
			signature: 'sig-' + randHex(8),
		},
	};
	if (!isVoteRecord(record)) {
		throw new Error('invalid record');
	}
	return record;
}

const BALLOTS = [
	{
		id: 'ballot-1',
		electionId: 'e1',
		authorityId: 'a',
		description: 'City ballot',
		districts: [],
		questions: [
			{
				code: 'q-a',
				title: 'Mayor question',
				instructions: '',
				type: 'select',
				options: [{code: 'o-1', title: 'Diana Foster'}],
			},
			{code: 'q-b', title: 'Treasurer question', instructions: '', type: 'select', options: []},
		],
	},
	{
		id: 'ballot-2',
		electionId: 'e1',
		authorityId: 'a',
		description: 'School ballot',
		districts: [],
		questions: [{code: 'q-c', title: 'Board question', instructions: '', type: 'select', options: []}],
	},
] as unknown as Ballot[];

async function save(record: VoteRecord): Promise<void> {
	const env = await sealVoteRecord(record, {prompt: PROMPT});
	await writeVoteRecord(env, buildVoteMarker(record));
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

async function mount(params: {electionId: string; revealOnOpen?: boolean} | undefined) {
	navRef = createNavigationContainerRef<ParamListBase>();
	await renderer.act(async () => {
		tr = renderer.create(
			<NavigationContainer ref={navRef} theme={lightTheme}>
				<VoterAppProvider>
					<ToastProvider>
						<Stack.Navigator initialRouteName="Home" screenOptions={{headerShown: false}}>
							<Stack.Screen name="Home" component={DummyScreen} />
							<Stack.Screen name="Other" component={DummyScreen} />
							<Stack.Screen name="VoteReceipt" component={VoteReceiptScreen} />
						</Stack.Navigator>
					</ToastProvider>
				</VoterAppProvider>
			</NavigationContainer>,
		);
	});
	await flush();
	await renderer.act(async () => {
		navRef.navigate('VoteReceipt', params as object);
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
	const node = tr!.root
		.findAllByProps({testID: id})
		.find(n => typeof n.props.onPress === 'function');
	if (!node) {
		throw new Error(`no pressable ${id}`);
	}
	await renderer.act(async () => {
		node.props.onPress();
	});
	await flush();
}
function everything(): string {
	return JSON.stringify(tr!.toJSON());
}
function nonceGroups(i: number): string[] {
	return tr!.root
		.findAll(
			n => typeof n.type === 'string' && String(n.props.testID).startsWith(`receipt-nonce-group-${i}-`),
		)
		.map(n => textOf(n));
}

const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m =>
	jest.spyOn(console, m).mockImplementation(() => undefined),
);

beforeEach(async () => {
	await AsyncStorage.clear();
	wrapper = createInMemorySecretWrapperForTests();
	setVoteRecordWrapProviderForTests(createVoteRecordWrapProvider(wrapper));
	readElection.mockReset();
	readElection.mockResolvedValue({revision: 2, ballots: BALLOTS});
});

afterEach(async () => {
	if (tr) {
		await renderer.act(async () => {
			tr!.unmount();
		});
		tr = null;
	}
	jest.restoreAllMocks();
	for (const s of consoleSpies) {
		s.mockImplementation(() => undefined);
	}
	await i18n.changeLanguage('en');
});

afterAll(() => {
	setVoteRecordWrapProviderForTests(undefined);
	for (const s of consoleSpies) {
		expect(s).not.toHaveBeenCalled();
		s.mockRestore();
	}
});

describe('VoteReceiptScreen', () => {
	it('S1: shows status and loss with zero prompts and no choices', async () => {
		await save(makeRecord());
		const before = wrapper.promptCount;
		await mount({electionId: 'e1'});
		expect(textById('receipt-status')).toBe(EN_STATUS);
		expect(textById('receipt-loss')).toBe(EN_LOSS);
		expect(wrapper.promptCount).toBe(before);
		expect(wrapper.unwrapCalls).toBe(0);
		expect(has('receipt-reveal')).toBe(true);
		expect(everything()).not.toContain('receipt-nonce-group');
		expect(everything()).not.toContain('receipt-copy-');
		expect(everything()).not.toContain('Mayor question');
		expect(everything()).not.toContain('Diana Foster');
	});

	it('S2: reveals choices and 16 groups per ballot after one prompt', async () => {
		const record = makeRecord();
		await save(record);
		await mount({electionId: 'e1'});
		const before = wrapper.promptCount;
		await press('receipt-reveal');
		expect(wrapper.promptCount).toBe(before + 1);
		expect(everything()).toContain('Mayor question');
		expect(everything()).toContain('Diana Foster');
		expect(everything()).toContain('Treasurer question');
		expect(everything()).toContain('Left blank');
		for (let i = 0; i < 2; i++) {
			const groups = nonceGroups(i);
			expect(groups).toHaveLength(16);
			for (const g of groups) {
				expect(g).toMatch(/^[0-9a-f]{4}$/);
			}
			expect(groups.join('')).toBe(record.votes[i]!.nonce);
		}
		expect(has('receipt-reveal')).toBe(false);
	});

	it('S3: revealOnOpen opens once without a press and clears the param', async () => {
		await save(makeRecord());
		const before = wrapper.promptCount;
		await mount({electionId: 'e1', revealOnOpen: true});
		expect(wrapper.promptCount).toBe(before + 1);
		expect(nonceGroups(0)).toHaveLength(16);
		const params = navRef.getCurrentRoute()?.params as {revealOnOpen?: boolean};
		expect(params.revealOnOpen).toBe(false);
	});

	it('S4: leaving and returning re-hides and needs a new tap', async () => {
		await save(makeRecord());
		await mount({electionId: 'e1'});
		await press('receipt-reveal');
		expect(nonceGroups(0)).toHaveLength(16);
		const afterReveal = wrapper.promptCount;
		await renderer.act(async () => {
			navRef.navigate('Other');
		});
		await flush();
		await renderer.act(async () => {
			navRef.goBack();
		});
		await flush();
		expect(nonceGroups(0)).toHaveLength(0);
		expect(wrapper.promptCount).toBe(afterReveal);
		await press('receipt-reveal');
		expect(wrapper.promptCount).toBe(afterReveal + 1);
		expect(nonceGroups(0)).toHaveLength(16);
	});

	it('S4b: inactive covers the record without clearing it; background clears it (CR-01)', async () => {
		const handlers: Array<(s: string) => void> = [];
		jest.spyOn(AppState, 'addEventListener').mockImplementation(((_e: string, h: (s: string) => void) => {
			handlers.push(h);
			return {remove: () => undefined};
		}) as never);
		const emit = (state: string) => handlers.forEach(h => h(state));
		const record = makeRecord();
		await save(record);
		await mount({electionId: 'e1'});
		await press('receipt-reveal');
		expect(nonceGroups(0)).toHaveLength(16);
		expect(has('receipt-privacy-cover')).toBe(false);
		await renderer.act(async () => {
			emit('inactive');
		});
		// The cover is up and no plaintext choice or code is anywhere in the tree.
		expect(has('receipt-privacy-cover')).toBe(true);
		expect(nonceGroups(0)).toHaveLength(0);
		const tree = everything();
		expect(tree).not.toContain('Diana Foster');
		expect(tree).not.toContain('Mayor question');
		for (const v of record.votes) {
			expect(tree).not.toContain(v.nonce.slice(0, 4));
		}
		// Back to active: the same record is shown again with no new prompt.
		const prompts = wrapper.promptCount;
		await renderer.act(async () => {
			emit('active');
		});
		expect(has('receipt-privacy-cover')).toBe(false);
		expect(nonceGroups(0)).toHaveLength(16);
		expect(wrapper.promptCount).toBe(prompts);
		await renderer.act(async () => {
			emit('inactive');
		});
		await renderer.act(async () => {
			emit('background');
		});
		await renderer.act(async () => {
			emit('active');
		});
		expect(nonceGroups(0)).toHaveLength(0);
		expect(has('receipt-reveal')).toBe(true);
	});

	it('S4c: FLAG_SECURE is on while the receipt is focused, off on blur and on unmount (CR-01)', async () => {
		secureCalls.mockClear();
		await save(makeRecord());
		await mount({electionId: 'e1'});
		expect(secureCalls.mock.calls).toEqual([[true]]);
		await renderer.act(async () => {
			navRef.navigate('Other');
		});
		await flush();
		expect(secureCalls.mock.calls).toEqual([[true], [false]]);
		await renderer.act(async () => {
			navRef.goBack();
		});
		await flush();
		expect(secureCalls.mock.calls).toEqual([[true], [false], [true]]);
		await renderer.act(async () => {
			tr!.unmount();
		});
		tr = null;
		expect(secureCalls.mock.calls).toEqual([[true], [false], [true], [false]]);
	});

	it('S4d: the cover is not shown when nothing is revealed (no plaintext to hide)', async () => {
		const handlers: Array<(s: string) => void> = [];
		jest.spyOn(AppState, 'addEventListener').mockImplementation(((_e: string, h: (s: string) => void) => {
			handlers.push(h);
			return {remove: () => undefined};
		}) as never);
		await save(makeRecord());
		await mount({electionId: 'e1'});
		await renderer.act(async () => {
			handlers.forEach(h => h('inactive'));
		});
		expect(has('receipt-privacy-cover')).toBe(false);
		expect(has('receipt-reveal')).toBe(true);
	});

	it('S5: copies the ungrouped code and shows the warning for every ballot', async () => {
		const record = makeRecord();
		await save(record);
		await mount({electionId: 'e1'});
		expect(has('receipt-copy-0')).toBe(false);
		await press('receipt-reveal');
		const spy = jest.spyOn(require('@react-native-clipboard/clipboard').default, 'setString');
		await press('receipt-copy-0');
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith(record.votes[0]!.nonce);
		expect(spy.mock.calls[0]![0]).not.toContain(' ');
		expect(textById('receipt-copied-0')).toBe('Copied');
		expect(textById('receipt-copy-warning-0')).toBe(EN_WARNING);
		expect(textById('receipt-copy-warning-1')).toBe(EN_WARNING);
	});

	it('S6: a failing clipboard shows the copy-failed toast', async () => {
		await save(makeRecord());
		await mount({electionId: 'e1'});
		await press('receipt-reveal');
		jest.spyOn(require('@react-native-clipboard/clipboard').default, 'setString').mockImplementationOnce(() => {
			throw new Error('no native module');
		});
		await press('receipt-copy-0');
		expect(textById('receipt-copy-failed-0')).toBe("Copying isn't available on this phone.");
		expect(has('receipt-copied-0')).toBe(false);
	});

	it('S7: shows the stale line when the election revision moved on', async () => {
		await save(makeRecord());
		readElection.mockResolvedValue({revision: 3, ballots: BALLOTS});
		await mount({electionId: 'e1'});
		expect(textById('receipt-stale')).toBe(EN_STALE);
		expect(textById('receipt-status')).toBe(EN_STATUS);
		expect(textById('receipt-loss')).toBe(EN_LOSS);
		await press('receipt-reveal');
		expect(nonceGroups(0)).toHaveLength(16);
	});

	it('S8: says so when the revision cannot be checked', async () => {
		await save(makeRecord());
		readElection.mockResolvedValue(null);
		await mount({electionId: 'e1'});
		expect(has('receipt-revision-unknown')).toBe(true);
		expect(has('receipt-stale')).toBe(false);
		expect(textById('receipt-status')).toBe(EN_STATUS);
		await press('receipt-reveal');
		expect(nonceGroups(0)).toHaveLength(16);
	});

	it('S9: a corrupt record is unreadable with no reveal and no prompt', async () => {
		await save(makeRecord());
		await AsyncStorage.setItem(voteRecordKey('e1'), '{garbage');
		const before = wrapper.promptCount;
		await mount({electionId: 'e1'});
		expect(has('receipt-unreadable')).toBe(true);
		expect(textById('receipt-loss')).toBe(EN_LOSS);
		expect(has('receipt-reveal')).toBe(false);
		expect(wrapper.promptCount).toBe(before);
	});

	it('S9: a corrupt marker is unreadable too', async () => {
		await save(makeRecord());
		await AsyncStorage.setItem(voteMarkerKey('e1'), '{garbage');
		const before = wrapper.promptCount;
		await mount({electionId: 'e1'});
		expect(has('receipt-unreadable')).toBe(true);
		expect(has('receipt-reveal')).toBe(false);
		expect(wrapper.promptCount).toBe(before);
	});

	it('S9: an invalidated key found on reveal becomes unreadable', async () => {
		await save(makeRecord());
		await mount({electionId: 'e1'});
		wrapper.failNextCall('unwrap', 'KEY_INVALIDATED');
		await press('receipt-reveal');
		expect(has('receipt-unreadable')).toBe(true);
		expect(has('receipt-reveal')).toBe(false);
	});

	it('S10: no saved vote shows only the none line', async () => {
		await mount({electionId: 'e1'});
		expect(has('receipt-none')).toBe(true);
		expect(has('receipt-status')).toBe(false);
		expect(has('receipt-loss')).toBe(false);
		expect(has('receipt-reveal')).toBe(false);
	});

	it.each([
		['CANCELED', 'Your choices are still hidden.'],
		['UNWRAP_FAILED', "We couldn't open your saved vote. Try again."],
	] as const)('S11: %s keeps choices hidden with a notice', async (code, expected) => {
		await save(makeRecord());
		await mount({electionId: 'e1'});
		wrapper.failNextCall('unwrap', code);
		await press('receipt-reveal');
		expect(textById('receipt-reveal-notice')).toBe(expected);
		expect(has('receipt-reveal')).toBe(true);
		expect(nonceGroups(0)).toHaveLength(0);
		expect(everything()).not.toContain('Mayor question');
	});

	describe.each([
		['ios', "Face ID can't be checked right now. Make sure Face ID is set up on this iPhone, then try again.", "You'll be asked for Face ID."],
		['android', "Your fingerprint can't be checked right now. Make sure a fingerprint is set up on this phone, then try again.", "You'll be asked for your fingerprint."],
	] as const)('biometric copy on %s', (os, unavailable, hint) => {
		const realOS = Platform.OS;
		beforeEach(() => { Object.defineProperty(Platform, 'OS', {value: os, configurable: true}); });
		afterEach(() => { Object.defineProperty(Platform, 'OS', {value: realOS, configurable: true}); });

		it('S11b: NO_BIOMETRICS_ENROLLED notice follows the platform', async () => {
			await save(makeRecord());
			await mount({electionId: 'e1'});
			wrapper.failNextCall('unwrap', 'NO_BIOMETRICS_ENROLLED');
			await press('receipt-reveal');
			expect(textById('receipt-reveal-notice')).toBe(unavailable);
		});

		it('S11c: the reveal hint follows the platform', async () => {
			await save(makeRecord());
			await mount({electionId: 'e1'});
			expect(everything()).toContain(hint);
		});
	});

	it('S12: renders in Spanish', async () => {
		await save(makeRecord());
		await i18n.changeLanguage('es');
		await mount({electionId: 'e1'});
		const es = resources.es.ballot as unknown as Record<string, string>;
		expect(textById('receipt-status')).toBe(es['receipt.status']);
	});

	it('S13: Done pops to the top', async () => {
		await save(makeRecord());
		await mount({electionId: 'e1'});
		expect(navRef.getCurrentRoute()?.name).toBe('VoteReceipt');
		await press('receipt-done');
		expect(navRef.getCurrentRoute()?.name).toBe('Home');
	});

	it('shows the none line for a missing electionId param without touching storage', async () => {
		const get = AsyncStorage.getItem as jest.Mock;
		get.mockClear();
		await mount(undefined);
		expect(has('receipt-none')).toBe(true);
		expect(get).not.toHaveBeenCalled();
	});

	it('S14: source assertions', () => {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const fs = require('fs') as {readFileSync(p: string, e: string): string};
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const path = require('path') as {join(...p: string[]): string};
		const src = fs
			.readFileSync(path.join(__dirname, '..', 'VoteReceiptScreen.tsx'), 'utf8')
			.split('\n')
			.filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
			.join('\n');
		for (const needle of [
			'useVoterApp(',
			'copyVoteCode(',
			'revealVoteReceipt(',
			'loadVoteReceipt(',
			'useFocusEffect(',
			"flexWrap: 'wrap'",
		]) {
			expect(src).toContain(needle);
		}
		for (const banned of [
			/\bShare\b/,
			/react-native-share/,
			/numberOfLines/,
			/adjustsFontSizeToFit/,
			/selectable/,
			/console\./,
			/@react-native-clipboard\/clipboard/,
			/AsyncStorage/,
			/writeVoteRecord/,
			/openVoteRecord/,
			/navigation\.navigate\(/,
		]) {
			expect(src).not.toMatch(banned);
		}
	});
});
