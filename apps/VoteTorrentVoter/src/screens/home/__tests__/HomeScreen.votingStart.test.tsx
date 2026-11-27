/**
 * UAT 65 gap 3 / D-97: a focused Home follows the election's next boundary. getElection derives the
 * state from the clock AT CALL TIME, like the real provider, so Home must re-read when the countdown
 * target passes and when the app returns to the foreground, without a blur and refocus.
 */
import React from 'react';
import {AppState} from 'react-native';
import renderer from 'react-test-renderer';
import {NavigationContainer, createNavigationContainerRef} from '@react-navigation/native';
import type {ParamListBase} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';

const mockT0 = Date.parse('2026-10-31T13:30:00Z');
const mockVotingStarts = Date.parse('2026-10-31T13:32:35Z');
const mockAccruing = Date.parse('2026-10-31T14:12:00Z');
const mockClosing = Date.parse('2026-10-31T15:00:00Z');
// `targets`: countdown targets (ms) the next reads return, one per read, as an Upcoming card; empty = the fixed timeline
const mockState = {reads: 0, targets: [] as number[]};

jest.mock('../../../providers/VoterAppProvider', () => {
	const ReactLib = require('react');
	const Context = ReactLib.createContext(null);
	function VoterAppProvider({children}: {children: React.ReactNode}) {
		const getEngine = ReactLib.useCallback(async () => ({getElections: async () => [{id: 'e1', title: 'E', date: 0}]}), []);
		const nowMs = ReactLib.useCallback(() => Date.now(), []);
		const getElection = ReactLib.useCallback(async () => {
			mockState.reads++;
			const now = Date.now();
			const forced = mockState.targets.shift();
			if (forced !== undefined) {
				return {id: 'e1', title: 'E', lifecycleState: 'Upcoming', countdownTarget: new Date(forced).toISOString()};
			}
			if (now >= mockAccruing) {
				return {id: 'e1', title: 'E', lifecycleState: 'ReviewSelections', countdownTarget: new Date(mockClosing).toISOString()};
			}
			return now >= mockVotingStarts
				? {id: 'e1', title: 'E', lifecycleState: 'Open', countdownTarget: new Date(mockAccruing).toISOString()}
				: {id: 'e1', title: 'E', lifecycleState: 'Upcoming', countdownTarget: new Date(mockVotingStarts).toISOString()};
		}, []);
		const value = {
			isInitialized: true, lifecycleOverride: null, setLifecycleOverride: () => undefined,
			clockOffsetMs: 0, setClockOffsetMs: () => undefined, nowMs, getElection,
			getBallot: async () => { throw new Error('n/a'); },
			hasNetwork: true, getEngine, hasEngine: () => false, selectNetwork: async () => undefined,
			joinNetwork: async () => undefined, getNetworkNode: () => null, seededElectionId: undefined,
			createNewIdentity: async () => undefined,
		};
		return ReactLib.createElement(Context.Provider, {value}, children);
	}
	return {VoterAppProvider, useVoterApp: () => ReactLib.useContext(Context)};
});
jest.mock('../../../providers/CadreNodeProvider', () => ({
	useCadreNode: () => ({node: null, syncState: 'offline', connectedPeers: () => 0}),
	CadreNodeProvider: ({children}: {children: React.ReactNode}) => children,
}));
jest.mock('../../../engines/saved-vote-status', () => ({
	...jest.requireActual('../../../engines/saved-vote-status'),
	readSavedVoteStatus: jest.fn(async () => ({state: 'none'})),
}));

import {VoterAppProvider} from '../../../providers/VoterAppProvider';
import HomeScreen from '../HomeScreen';
import {lightTheme} from '../../../theme/themes';
import '../../../i18n';

const Stack = createNativeStackNavigator();
const Other = () => null;
let tr: renderer.ReactTestRenderer | null = null;
const navRef = createNavigationContainerRef<ParamListBase>();

async function flush() {
	for (let i = 0; i < 8; i++) {
		await renderer.act(async () => { await jest.advanceTimersByTimeAsync(0); });
	}
}
const ids = () => tr!.root.findAll(n => typeof n.props.testID === 'string' && typeof n.type === 'string').map(n => n.props.testID);
const has = (id: string) => ids().includes(id);
const seconds = () => tr!.root.findAll(n => typeof n.type === 'string' && /^countdown-.*-value$/.test(String(n.props.testID))).map(n => JSON.stringify(n.props.children));

const startedAt = () => renderer.act(async () => {
	tr = renderer.create(
		<NavigationContainer ref={navRef} theme={lightTheme}>
			<VoterAppProvider>
				<Stack.Navigator initialRouteName="Home" screenOptions={{headerShown: false}}>
					<Stack.Screen name="Home" component={HomeScreen} />
					<Stack.Screen name="Other" component={Other} />
				</Stack.Navigator>
			</VoterAppProvider>
		</NavigationContainer>,
	);
});
const advance = async (ms: number) => {
	await renderer.act(async () => { await jest.advanceTimersByTimeAsync(ms); });
	await flush();
};

// Other components subscribe to AppState too; emit to every listener, as the real AppState does.
const appStateListeners: Array<(s: string) => void> = [];
const emitAppState = (s: string) => appStateListeners.slice().forEach(fn => fn(s));
beforeEach(() => {
	mockState.reads = 0;
	mockState.targets = [];
	appStateListeners.length = 0;
	jest.spyOn(AppState, 'addEventListener').mockImplementation(((_type: string, fn: (s: string) => void) => {
		appStateListeners.push(fn);
		return {remove: jest.fn()};
	}) as never);
	jest.useFakeTimers();
	jest.setSystemTime(mockT0);
});

afterEach(async () => {
	if (tr) { await renderer.act(async () => { tr!.unmount(); }); tr = null; }
	jest.useRealTimers();
	jest.restoreAllMocks();
});

it('a focused Home switches the card to Open when votingStarts passes', async () => {
	await startedAt();
	await flush();
	expect(has('election-card-vote-now')).toBe(false);
	const before = mockState.reads;

	await advance(200_000);
	expect(mockState.reads).toBeGreaterThanOrEqual(before + 1);
	expect(mockState.reads).toBeGreaterThanOrEqual(2);
	expect(has('election-card-learn-link')).toBe(true);
	expect(has('election-card-vote-now')).toBe(true);
});

it('a re-read follows the next boundary too', async () => {
	await startedAt();
	await flush();
	await advance(200_000);
	const afterOpen = mockState.reads;
	// 13:33:20 -> 14:12:30 passes accruingVotes (14:12:00) with Home still focused.
	await advance(39 * 60_000 + 10_000);
	expect(mockState.reads).toBeGreaterThan(afterOpen);
	expect(has('election-card-vote-now')).toBe(false);
}, 120_000);

it('returning to the foreground re-reads', async () => {
	await startedAt();
	await flush();
	expect(appStateListeners.length).toBeGreaterThan(0);
	const before = mockState.reads;
	await renderer.act(async () => { emitAppState('background'); });
	await flush();
	expect(mockState.reads).toBe(before);
	await renderer.act(async () => { emitAppState('active'); });
	await flush();
	expect(mockState.reads).toBe(before + 1);
});

it('the timer is cleared on blur', async () => {
	await startedAt();
	await flush();
	await renderer.act(async () => { navRef.navigate('Other'); });
	await flush();
	const before = mockState.reads;
	await advance(200_000);
	expect(mockState.reads).toBe(before);
});

// T-65-13-01: the boundary delay is clamped to [0, 2^31-1] ms. A timer set above 2^31-1 fires at once
// (so Home would re-read in a hot loop), and a negative one means the target is already past.
const MAX_TIMEOUT = 2 ** 31 - 1;
const armedDelays = (spy: jest.SpyInstance) => spy.mock.calls.map(c => c[1]).filter((d): d is number => typeof d === 'number');

it('a past countdown target arms a 0 ms re-read (not a negative delay) and settles', async () => {
	const spy = jest.spyOn(global, 'setTimeout');
	mockState.targets = [mockT0 - 3_600_000]; // one hour in the past; the next read is the normal timeline
	await startedAt();
	await flush();
	// the past target re-read at once: exactly one extra read, then the real boundary (votingStarts) is armed
	expect(mockState.reads).toBe(2);
	const delays = armedDelays(spy);
	expect(Math.min(...delays)).toBeGreaterThanOrEqual(0);
	expect(delays).toContain(0);
	await advance(10_000);
	expect(mockState.reads).toBe(2);
});

it('a far-future countdown target is clamped to 2^31-1 ms and does not re-read in a loop', async () => {
	const spy = jest.spyOn(global, 'setTimeout');
	mockState.targets = [mockT0 + 60 * 86_400_000]; // 60 days: 5.2e9 ms, above the timer maximum
	await startedAt();
	await flush();
	const delays = armedDelays(spy);
	expect(Math.max(...delays)).toBe(MAX_TIMEOUT);
	expect(delays.filter(d => d > MAX_TIMEOUT)).toEqual([]);
	// armed far out: nothing re-reads meanwhile
	await advance(120_000);
	expect(mockState.reads).toBe(1);
});
