/**
 * Dev-seed boot escape (65-15, D-99): a hung __DEV__ seed offers "Continue without a network" at 60 s.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {Text, TouchableOpacity} from 'react-native';
import {Database} from '@quereus/quereus';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {UserKeyType, ElectionType} from '@votetorrent/vote-core';
import type {NetworkInit, Scope, Signature, User} from '@votetorrent/vote-core';
import {NetworksEngine} from '@votetorrent/vote-engine/rn';
import {DeviceIdentityKeyUnavailableError} from '../../engines/device-user';
import {identityNotReplaceableError} from '../../engines/identity-errors';
import {IdentityRecoveryView} from '../../components/IdentityRecoveryView';
import type {DevSeedResult} from '../../engines/dev-seed';

// This test drives real NetworksEngine.create()/open() DB operations (not pure UI rendering),
// so give it headroom above Jest's 5000ms default on a loaded CI/dev machine.
jest.setTimeout(20000);

// Mirrors App.tsx's nesting (CadreNodeProvider wraps VoterAppProvider) with an inert
// pass-through — this test proves VoterAppProvider's OWN plumbing, not a real CadreNode boot.
//
// `mockCadreNodeValue` is a mutable module-scope object (not a fresh literal per call)
// so a test can flip `syncState` (quick task 260928-kkf's boot-syncing cases) while
// keeping `connectedPeers`/`node` referentially stable across renders — a fresh
// closure each render would spuriously re-fire VoterAppProvider's
// `[connectedPeers, node]` peer-count effect.
const mockCadreNodeValue: {
	node: unknown;
	syncState: 'connected' | 'syncing' | 'offline';
	nodeStatus: 'starting' | 'ready' | 'failed';
	connectedPeers: () => number;
} = {
	node: null,
	syncState: 'offline',
	nodeStatus: 'starting',
	connectedPeers: () => 0,
};
jest.mock('../CadreNodeProvider', () => ({
	useCadreNode: () => mockCadreNodeValue,
	CadreNodeProvider: ({children}: {children: React.ReactNode}) => children,
}));

// react-i18next — VoterAppProvider now calls useTranslation('common') for the Syncing
// label (quick task 260928-kkf). Echo the key so the assertions below are exact.
jest.mock('react-i18next', () => ({
	useTranslation: () => ({t: (key: string) => key}),
}));

// The engine layer's own in-memory-Database dbFactory default (networks-engine.ts's
// `inMemoryFactory`) — swapped in for the real `rnDbFactory` so this provider-plumbing test
// never depends on the native rn-leveldb/Quereus-LevelDB integration (already proven by
// `rn-db-factory`'s own port + `dev-seed.test.ts`'s NetworksEngine-default-dbFactory convention).
jest.mock('../../engines/rn-db-factory', () => ({
	rnDbFactory: async (_hash: string) => new (require('@quereus/quereus').Database)(),
}));

const mockSeedDevNetwork = jest.fn<Promise<DevSeedResult>, [NetworksEngine]>();
jest.mock('../../engines/dev-seed', () => ({
	seedDevNetwork: (networksEngine: NetworksEngine) => mockSeedDevNetwork(networksEngine),
}));

// D-42 (Phase 62 plan 08): the real migration sweep hits real AsyncStorage/crypto, which this
// provider-plumbing test does not need to exercise (device-user.migration.test.ts already proves
// it) — stub it to a quiet 'absent' outcome and keep every other device-user export real.
const mockMigrateLegacyPlaintextIdentityKey = jest.fn().mockResolvedValue('absent');
const mockReplaceUnrecoverableDeviceIdentity = jest.fn();
jest.mock('../../engines/device-user', () => ({
	...jest.requireActual('../../engines/device-user'),
	migrateLegacyPlaintextIdentityKey: () => mockMigrateLegacyPlaintextIdentityKey(),
	replaceUnrecoverableDeviceIdentity: (...args: unknown[]) => mockReplaceUnrecoverableDeviceIdentity(...args),
}));

// D-02: passthrough spy over the real read so a test can observe the clock the provider hands it.
jest.mock('../../engines/election-read', () => {
	const actual = jest.requireActual('../../engines/election-read');
	return {
		...actual,
		readVoterElection: jest.fn((...args: unknown[]) => actual.readVoterElection(...args)),
	};
});

// Spike 100: the provider requires the join wiring lazily; this stands in for it.
const mockRunVoterNetworkJoin = jest.fn();
jest.mock('../../engines/voter-network-join', () => ({
	runVoterNetworkJoin: (...args: unknown[]) => mockRunVoterNetworkJoin(...args),
}));

import {VoterAppProvider, useVoterApp} from '../VoterAppProvider';
import type {VoterAppContextType} from '../types';
import {hideSplash} from 'react-native-splash-view';
// The REAL EngineFactory (not mocked) — quick task 260928-kkf's tests spy on its
// prototype so a test can (a) capture the listener VoterAppProvider registers via
// `setFirstSyncListener` and invoke it directly (simulating the first-sync gate's
// budget elapsing without running the whole strand-backed DbFactory machinery, which
// this file's `rnDbFactory` mock deliberately bypasses), and (b) assert
// `clearEngineCache`/`cancelPendingStrandWaits` were actually called — both spies
// call through to the real implementation (no `mockImplementation`), so behaviour is
// unchanged; only the call record is added.
import {EngineFactory} from '../../engines/engine-factory';

const FAKE_USER: User = {
	id: 'test-device-user',
	name: 'Test Device User',
	activeKeys: [{key: 'deadbeefcafe', type: UserKeyType.mobile, expiration: Date.now() + 10_000_000}],
};
const FAKE_NETWORK_INIT: NetworkInit = {
	name: 'Test Seeded Network',
	relays: [],
	primaryAuthority: {name: 'Test Authority', domainName: 'test.local'},
	admin: {
		officers: [{init: {name: FAKE_USER.name, title: 'Registrar', scopes: ['mel'] as Scope[]}}],
		effectiveAt: Date.now(),
		thresholdPolicies: [],
	},
	policies: {timestampAuthorities: [], numberRequiredTSAs: 0, electionType: ElectionType.adhoc},
};
const FAKE_SIGN = async (_digest: Uint8Array): Promise<Signature> => ({
	signerUserId: FAKE_USER.id,
	signerKey: FAKE_USER.activeKeys[0]!.key,
	signature: 'deadbeef',
});
async function seedRealNetwork(networksEngine: NetworksEngine): Promise<DevSeedResult> {
	await networksEngine.create(FAKE_NETWORK_INIT, FAKE_USER);
	const [ref] = await networksEngine.getRecentNetworks();
	return {networkReference: ref!, electionId: 'test-seeded-election-id', deviceUser: FAKE_USER, sign: FAKE_SIGN};
}


function renderProvider() {
	const captured: {value: VoterAppContextType | null} = {value: null};
	function Probe() {
		captured.value = useVoterApp();
		return null;
	}
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(
			<VoterAppProvider>
				<Probe />
			</VoterAppProvider>,
		);
	});
	return {tr, captured};
}

const ESCAPE_KEY = 'bootError.continueWithoutNetwork';

function text(tr: renderer.ReactTestRenderer): string {
	return JSON.stringify(tr.toJSON());
}

function findEscape(tr: renderer.ReactTestRenderer) {
	return tr.root
		.findAllByType(TouchableOpacity)
		.find(t => t.findAll(n => n.type === Text && n.props.children === ESCAPE_KEY).length > 0);
}

async function spin(ms: number) {
	await renderer.act(async () => {
		await jest.advanceTimersByTimeAsync(ms);
	});
}

async function settle() {
	for (let i = 0; i < 10; i++) {
		// eslint-disable-next-line no-await-in-loop
		await spin(0);
	}
}

beforeEach(async () => {
	mockSeedDevNetwork.mockReset();
	mockMigrateLegacyPlaintextIdentityKey.mockClear().mockResolvedValue('absent');
	mockReplaceUnrecoverableDeviceIdentity.mockReset();
	mockCadreNodeValue.node = null;
	mockCadreNodeValue.syncState = 'offline';
	mockCadreNodeValue.nodeStatus = 'starting';
	await AsyncStorage.clear();
	jest.useFakeTimers();
});

afterEach(() => {
	jest.useRealTimers();
});

describe('VoterAppProvider: dev-seed boot escape (D-99, UAT 65 gap 4)', () => {
	it('DSE-1 a hung dev seed offers the escape at 60 s and not before', async () => {
		mockSeedDevNetwork.mockImplementation(() => new Promise<DevSeedResult>(() => undefined));
		const {tr} = renderProvider();
		await settle();
		await spin(59_000 - 1);
		expect(text(tr)).not.toContain(ESCAPE_KEY);
		await spin(2_000);
		expect(text(tr)).toContain(ESCAPE_KEY);
	});

	it('DSE-2 pressing the escape leaves the loading view', async () => {
		mockSeedDevNetwork.mockImplementation(() => new Promise<DevSeedResult>(() => undefined));
		const {tr, captured} = renderProvider();
		await settle();
		await spin(61_000);
		const escape = findEscape(tr);
		expect(escape).toBeDefined();
		renderer.act(() => {
			escape!.props.onPress();
		});
		await settle();
		expect(captured.value).not.toBeNull();
		expect(captured.value!.isInitialized).toBe(true);
		expect(text(tr)).not.toContain(ESCAPE_KEY);
	});

	it('DSE-3 a seed that resolves at 10 s never shows the escape', async () => {
		mockSeedDevNetwork.mockImplementation(
			(eng: NetworksEngine) =>
				new Promise<DevSeedResult>((resolve, reject) => {
					setTimeout(() => {
						seedRealNetwork(eng).then(resolve, reject);
					}, 10_000);
				}),
		);
		const {tr, captured} = renderProvider();
		await settle();
		await spin(10_000);
		// The real in-memory network create runs under the fake clock: advance it in small
		// steps (at most 15 s more, well short of the 60 s escape) until the boot lands.
		for (let i = 0; i < 300 && captured.value === null; i++) {
			// eslint-disable-next-line no-await-in-loop
			await spin(50);
		}
		expect(captured.value?.isInitialized).toBe(true);
		await spin(61_000);
		expect(text(tr)).not.toContain(ESCAPE_KEY);
	});

	it('DSE-4 unmounting at 30 s leaves no timer that writes state or shows an escape', async () => {
		mockSeedDevNetwork.mockImplementation(() => new Promise<DevSeedResult>(() => undefined));
		const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		const {tr} = renderProvider();
		await settle();
		await spin(30_000);
		renderer.act(() => {
			tr.unmount();
		});
		await spin(61_000);
		for (const call of errorSpy.mock.calls) {
			expect(String(call[0])).not.toContain('not wrapped in act');
			expect(String(call[0])).not.toContain('unmounted');
		}
		errorSpy.mockRestore();
		expect(jest.getTimerCount()).toBe(0);
		const {tr: tr2} = renderProvider();
		await settle();
		expect(text(tr2)).not.toContain(ESCAPE_KEY);
	});
});
