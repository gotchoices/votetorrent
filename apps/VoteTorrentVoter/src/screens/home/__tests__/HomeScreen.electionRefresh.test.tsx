/**
 * HomeScreen.electionRefresh.test.tsx — the Home election card must follow the network's election
 * list, not stay on what it read at mount.
 *
 * Reproduces the iPhone reading of 2026-10-29: Home mounted at first launch, before the phone
 * joined a network, read an EMPTY election list, and `pickElectionId` fell back to the __DEV__
 * seed (`seededElectionId`). The joined network then listed one election, but Home read the
 * election only in a `useEffect` keyed on `getElection`, whose identity never changed, so the
 * card showed the dev seed ("148 days") for good.
 *
 * The provider here is a small stand-in with the real provider's shape where it matters:
 * `getElection` is ONE stable callback that runs the real `pickElectionId` over the current list
 * with the seed as fallback, `getEngine('elections')` serves the same list, and `hasNetwork` is
 * state a test can flip (a join's selectNetwork sets it).
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {Text} from 'react-native';
import {NavigationContainer, createNavigationContainerRef} from '@react-navigation/native';
import type {ParamListBase} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';

const SEED_ID = 'seed-election-4b1da978';
const SEED_TITLE = 'Dev Seed Election';
const NETWORK_ID = 'election';
const NETWORK_TITLE = 'Joined Network Election';

type Summary = {id: string; title: string; date: number};
const mockState: {
	list: Summary[];
	getElectionsCalls: number;
	setHasNetwork: ((v: boolean) => void) | null;
} = {list: [], getElectionsCalls: 0, setHasNetwork: null};

jest.mock('../../../providers/VoterAppProvider', () => {
	const ReactLib = require('react');
	const {pickElectionId} = require('../../../engines/election-read');
	const Context = ReactLib.createContext(null);
	function VoterAppProvider({children, initialHasNetwork}: {children: React.ReactNode; initialHasNetwork: boolean}) {
		const [hasNetwork, setHasNetwork] = ReactLib.useState(initialHasNetwork);
		mockState.setHasNetwork = setHasNetwork;
		const getElections = async () => {
			mockState.getElectionsCalls++;
			return mockState.list;
		};
		const getEngine = ReactLib.useCallback(async (name: string) => {
			if (name !== 'elections') {
				throw new Error('not in this test: ' + name);
			}
			return {getElections};
		}, []);
		// Stable identity, like the real provider's (its deps do not change on a join).
		const getElection = ReactLib.useCallback(async () => {
			const id = pickElectionId(await getElections(), SEED_ID);
			const title = id === SEED_ID ? SEED_TITLE : mockState.list.find((e: Summary) => e.id === id)!.title;
			return {id, title, lifecycleState: 'Upcoming'};
		}, []);
		const nowMs = ReactLib.useCallback(() => Date.now(), []);
		const value = {
			isInitialized: true,
			lifecycleOverride: null,
			setLifecycleOverride: () => undefined,
			clockOffsetMs: 0,
			setClockOffsetMs: () => undefined,
			nowMs,
			getElection,
			getBallot: async () => {
				throw new Error('not in this test');
			},
			hasNetwork,
			getEngine,
			hasEngine: () => false,
			selectNetwork: async () => undefined,
			joinNetwork: async () => undefined,
			getNetworkNode: () => null,
			seededElectionId: SEED_ID,
			createNewIdentity: async () => undefined,
		};
		return ReactLib.createElement(Context.Provider, {value}, children);
	}
	return {
		VoterAppProvider,
		useVoterApp: () => ReactLib.useContext(Context),
	};
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
import HomeScreen, {ELECTION_LIST_RECHECK_MS} from '../HomeScreen';
import {lightTheme} from '../../../theme/themes';
import '../../../i18n';

const TestProvider = VoterAppProvider as unknown as React.ComponentType<{children: React.ReactNode; initialHasNetwork: boolean}>;
const Stack = createNativeStackNavigator();
function OtherScreen() {
	return null;
}

let tr: renderer.ReactTestRenderer | null = null;
let navRef = createNavigationContainerRef<ParamListBase>();

let fakeTimers = false;
async function flush() {
	for (let i = 0; i < 8; i++) {
		await renderer.act(async () => {
			if (fakeTimers) {
				await jest.advanceTimersByTimeAsync(0);
			} else {
				await new Promise<void>(resolve => setTimeout(resolve, 0));
			}
		});
	}
}

/** Fake timers from before the mount, so the recheck timer Home arms is one jest controls. */
function useFakeTimersFromMount() {
	jest.useFakeTimers();
	fakeTimers = true;
}

async function mount(initialHasNetwork: boolean) {
	navRef = createNavigationContainerRef<ParamListBase>();
	await renderer.act(async () => {
		tr = renderer.create(
			<NavigationContainer ref={navRef} theme={lightTheme}>
				<TestProvider initialHasNetwork={initialHasNetwork}>
					<Stack.Navigator initialRouteName="Home" screenOptions={{headerShown: false}}>
						<Stack.Screen name="Home" component={HomeScreen} />
						<Stack.Screen name="Other" component={OtherScreen} />
					</Stack.Navigator>
				</TestProvider>
			</NavigationContainer>,
		);
	});
	await flush();
}

/** The election title the card shows, or null when no card is rendered. */
function cardTitle(): string | null {
	const titles = [SEED_TITLE, NETWORK_TITLE];
	const shown = tr!.root.findAllByType(Text).map(n => n.props.children).filter(c => titles.includes(c));
	return shown.length > 0 ? shown[0] : null;
}

const listed: Summary = {id: NETWORK_ID, title: NETWORK_TITLE, date: Date.now() + 29 * 86_400_000};

beforeEach(() => {
	mockState.list = [];
	mockState.getElectionsCalls = 0;
	mockState.setHasNetwork = null;
});

afterEach(async () => {
	if (tr) {
		await renderer.act(async () => {
			tr!.unmount();
		});
		tr = null;
	}
	jest.useRealTimers();
	fakeTimers = false;
});

describe('HomeScreen election card follows the network list (iPhone 2026-10-29)', () => {
	it('mounted on an empty list it shows the dev seed, and a re-focus after the list fills switches the card', async () => {
		await mount(true);
		expect(cardTitle()).toBe(SEED_TITLE);

		mockState.list = [listed];
		await renderer.act(async () => {
			navRef.navigate('Other');
		});
		await flush();
		await renderer.act(async () => {
			navRef.goBack();
		});
		await flush();
		expect(cardTitle()).toBe(NETWORK_TITLE);
	});

	it('a joined network attached while Home stays focused (hasNetwork) switches the card', async () => {
		await mount(false);
		expect(cardTitle()).toBe(SEED_TITLE);

		mockState.list = [listed];
		await renderer.act(async () => {
			mockState.setHasNetwork!(true);
		});
		await flush();
		expect(cardTitle()).toBe(NETWORK_TITLE);
	});

	it('an election that replicates in while Home stays focused replaces the dev seed within one recheck', async () => {
		useFakeTimersFromMount();
		await mount(true);
		expect(cardTitle()).toBe(SEED_TITLE);

		// Still empty: a recheck finds nothing and the card stays.
		await renderer.act(async () => {
			await jest.advanceTimersByTimeAsync(ELECTION_LIST_RECHECK_MS);
		});
		await flush();
		expect(cardTitle()).toBe(SEED_TITLE);

		mockState.list = [listed];
		await renderer.act(async () => {
			await jest.advanceTimersByTimeAsync(ELECTION_LIST_RECHECK_MS);
		});
		await flush();
		expect(cardTitle()).toBe(NETWORK_TITLE);
	});

	it('once the network lists an election, a focused Home stops re-checking the list', async () => {
		useFakeTimersFromMount();
		mockState.list = [listed];
		await mount(true);
		expect(cardTitle()).toBe(NETWORK_TITLE);

		const calls = mockState.getElectionsCalls;
		await renderer.act(async () => {
			await jest.advanceTimersByTimeAsync(ELECTION_LIST_RECHECK_MS * 5);
		});
		await flush();
		expect(mockState.getElectionsCalls).toBe(calls);
	});
});
