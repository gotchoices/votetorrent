/**
 * Behavioral tests for VoterAppProvider — the real composition root (Phase 44-07, D-02/D-04/D-07).
 *
 * Proves the plan's `must_haves`:
 *   - Rendering VoterAppProvider (wrapped in a mocked CadreNodeProvider, mirroring App.tsx's
 *     nesting) flips `isInitialized` to true after the mocked D-07 seed + network open resolve,
 *     and calls `hideSplash`.
 *   - `useVoterApp()` surfaces a real `getEngine` accessor plus `seededElectionId` (captured from
 *     `seedDevNetwork`'s return) — NOT the removed `isRegistered` mock boolean, and (51-12,
 *     D-09/D-20) NOT a `sign` field at all — the context type no longer has one.
 *   - A forced `seedDevNetwork` throw renders the recoverable "Try Again" view rather than
 *     silently proceeding with an empty in-memory network (T-44-18).
 *
 * `CadreNodeProvider` is mocked to an inert pass-through (mirrors the authority app's
 * App.test.tsx / this app's own App.test.tsx convention) — this test proves VoterAppProvider's
 * OWN boot plumbing, not CadreNodeProvider's (that is CadreNodeProvider's own test's job).
 * `seedDevNetwork` is mocked/stubbed per the plan's Task 3 action — it still drives a REAL
 * `NetworksEngine.create()` call against the SAME networksEngine instance the provider owns (via
 * an in-memory `Database`, mirroring vote-engine's own default-dbFactory test convention), so the
 * provider's subsequent real `getEngine('network', ref)` call resolves against a genuinely
 * cached context rather than a fabricated reference — proving the provider's real composition-root
 * plumbing without re-exercising the full register/election/policy seed ceremony (already proven
 * by `dev-seed.test.ts`, 44-06).
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
		// 51-12 (D-09/D-20): 'mel', not 'vrg' — mirrors the real dev-seed's own narrowed grant.
		officers: [{init: {name: FAKE_USER.name, title: 'Registrar', scopes: ['mel'] as Scope[]}}],
		effectiveAt: Date.now(),
		thresholdPolicies: [],
	},
	policies: {timestampAuthorities: [], numberRequiredTSAs: 0, electionType: ElectionType.adhoc},
};

// `DevSeedResult.sign` is still a required field (dev-seed.ts / dev-seed.test.ts still need the
// SAME device signer for the seed's own election/policy-row ceremony) — this fixture must still
// supply one to satisfy the type, even though 51-12 (D-09/D-20) means VoterAppProvider no longer
// reads it onto context.
const FAKE_SIGN = async (_digest: Uint8Array): Promise<Signature> => ({
	signerUserId: FAKE_USER.id,
	signerKey: FAKE_USER.activeKeys[0]!.key,
	signature: 'deadbeef',
});

/** Real NetworksEngine.create() against the SAME instance the provider owns, so the provider's
 * subsequent getEngine('network', ref) call resolves against a genuinely cached context. */
async function seedRealNetwork(networksEngine: NetworksEngine): Promise<DevSeedResult> {
	await networksEngine.create(FAKE_NETWORK_INIT, FAKE_USER);
	const [ref] = await networksEngine.getRecentNetworks();
	return {
		networkReference: ref!,
		electionId: 'test-seeded-election-id',
		deviceUser: FAKE_USER,
		sign: FAKE_SIGN,
	};
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

/** Flush the multi-turn async boot chain (seedDevNetwork -> NetworksEngine.create/open ->
 * setState) — bounded loop, mirrors CadreNodeProvider.test.tsx's flushBoot convention.
 *
 * Two modes:
 *  - No `until` predicate: a fixed microtask-only spin (`ticks` hops of `Promise.resolve()`).
 *    Correct for a chain that resolves via pure promise chaining with no real-timer dependency
 *    (e.g. the forced-rejection path below, which rejects on the very first `await`).
 *  - With an `until` predicate: polls with REAL timer yields (`setTimeout`, not
 *    `Promise.resolve()`) up to a bounded real-time ceiling, exiting as soon as the predicate is
 *    true. Required for the real `NetworksEngine.create()` + schema-init path this file also
 *    drives: on a loaded host, real module/class initialization inside `@quereus/quereus` can
 *    take several hundred ms of genuine wall-clock time (measured directly against this file:
 *    Database construction + type-registry + optimizer-framework setup alone can cost 400-500ms
 *    under CPU contention). A microtask-only spin can never observe that — no number of
 *    `await Promise.resolve()` hops advances the event loop's timer phase, so the chain
 *    completes strictly AFTER the fixed-tick loop already returned, landing outside any `act()`
 *    and leaving `captured.value` null at assertion time. This is a synchronization-robustness
 *    fix, not a relaxed assertion: every existing expectation below is unchanged. */
async function flushBoot(ticks = 15, until?: () => boolean) {
	if (!until) {
		for (let i = 0; i < ticks; i++) {
			// eslint-disable-next-line no-await-in-loop
			await renderer.act(async () => {
				await Promise.resolve();
			});
		}
		return;
	}
	const start = Date.now();
	const maxMs = 10000; // headroom under this file's own jest.setTimeout(20000)
	while (!until() && Date.now() - start < maxMs) {
		// eslint-disable-next-line no-await-in-loop
		await renderer.act(async () => {
			await new Promise<void>(resolve => setTimeout(() => resolve(), 20));
		});
	}
}

beforeEach(async () => {
	mockSeedDevNetwork.mockReset();
	mockMigrateLegacyPlaintextIdentityKey.mockClear().mockResolvedValue('absent');
	mockReplaceUnrecoverableDeviceIdentity.mockReset();
	(hideSplash as jest.Mock).mockClear();
	mockCadreNodeValue.node = null;
	mockCadreNodeValue.syncState = 'offline';
	mockCadreNodeValue.nodeStatus = 'starting';
	// AsyncStorage's jest mock is a module-scope singleton store shared across every it() in this
	// file — clear it so each test's seedRealNetwork() creates a genuinely fresh network (mirrors
	// dev-seed.test.ts's own AsyncStorage.clear() isolation convention).
	await AsyncStorage.clear();
});

describe('VoterAppProvider — real composition root (D-02/D-04/D-07)', () => {
	it('boots to isInitialized after the mocked seed resolves, and calls hideSplash', async () => {
		mockSeedDevNetwork.mockImplementation(seedRealNetwork);
		const {captured} = renderProvider();
		await flushBoot(15, () => captured.value !== null);

		expect(captured.value).not.toBeNull();
		expect(captured.value!.isInitialized).toBe(true);
		expect(hideSplash).toHaveBeenCalled();
	});

	it('useVoterApp() exposes a real getEngine accessor plus seededElectionId (not the removed isRegistered mock boolean, and NOT a sign field — 51-12/D-09/D-20)', async () => {
		mockSeedDevNetwork.mockImplementation(seedRealNetwork);
		const {captured} = renderProvider();
		await flushBoot(15, () => captured.value !== null);

		expect(typeof captured.value!.getEngine).toBe('function');
		expect(typeof captured.value!.hasEngine).toBe('function');
		expect(typeof captured.value!.selectNetwork).toBe('function');
		expect(captured.value!.seededElectionId).toBe('test-seeded-election-id');
		await flushBoot(15, () => captured.value?.networkName !== undefined);
		expect(captured.value!.networkName).toBe(FAKE_NETWORK_INIT.name);
		// 51-12 (D-09/D-20): the context has NO `sign` field at all — dead plumbing that would
		// hand a future contributor an officer-capable signer is removed structurally, not just
		// left unused.
		expect((captured.value as unknown as Record<string, unknown>).sign).toBeUndefined();
		expect((captured.value as unknown as Record<string, unknown>).isRegistered).toBeUndefined();
		expect((captured.value as unknown as Record<string, unknown>).registeredAt).toBeUndefined();
		expect((captured.value as unknown as Record<string, unknown>).hasVoted).toBeUndefined();
	});

	it('calls migrateLegacyPlaintextIdentityKey exactly once on mount (D-42)', async () => {
		mockSeedDevNetwork.mockImplementation(seedRealNetwork);
		const {captured} = renderProvider();
		await flushBoot(15, () => captured.value !== null);

		expect(mockMigrateLegacyPlaintextIdentityKey).toHaveBeenCalledTimes(1);
	});

	it('on a forced seedDevNetwork throw, renders the recoverable "Try Again" view — never a silent empty network (T-44-18)', async () => {
		mockSeedDevNetwork.mockRejectedValue(new Error('seed-boom'));
		const {tr} = renderProvider();
		await flushBoot();

		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain('bootError.tryAgain');
		expect(text).toContain('bootError.continueWithoutNetwork');
		expect(hideSplash).toHaveBeenCalled();
	});

	it('keeps every VoterAppContext key it exposed before the recovery work (superset check, not a snapshot)', async () => {
		mockSeedDevNetwork.mockImplementation(seedRealNetwork);
		const {captured} = renderProvider();
		await flushBoot(15, () => captured.value !== null);
		const keys = Object.keys(captured.value!);
		for (const key of [
			'isInitialized',
			'lifecycleOverride',
			'setLifecycleOverride',
			'getElection',
			'getBallot',
			'hasNetwork',
			'getEngine',
			'hasEngine',
			'selectNetwork',
			'seededElectionId',
			'createNewIdentity',
		]) {
			expect(keys).toContain(key);
		}
	});
});

describe('VoterAppProvider — boot errors never show raw engine text', () => {
	const RAW = ['DeviceIdentityKeyUnavailableError', 'no-wrap-key', 'Failed to load network', 'boom'];
	function expectNoRawText(tr: renderer.ReactTestRenderer) {
		const text = JSON.stringify(tr.toJSON());
		for (const raw of RAW) {
			expect(text).not.toContain(raw);
		}
	}
	function findByTestId(tr: renderer.ReactTestRenderer, id: string) {
		return tr.root.findAll(n => n.props.testID === id && typeof n.props.onPress === 'function')[0];
	}
	// A failed assertion skips a test's trailing restoreAllMocks; never leak its spies onward.
	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('1: an unwrappable identity renders the translated recovery view', async () => {
		mockSeedDevNetwork.mockRejectedValue(new DeviceIdentityKeyUnavailableError('no-wrap-key'));
		const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		const {tr} = renderProvider();
		await flushBoot();
		expect(tr.root.findAll(n => n.props.testID === 'identity-recovery-view').length).toBeGreaterThan(0);
		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain('bootError.identityLost.title');
		expect(text).toContain('bootError.identityLost.body');
		expectNoRawText(tr);
		// Console carries the class name only.
		expect(errSpy.mock.calls.flat().join(' ')).not.toContain('no-wrap-key');
		errSpy.mockRestore();
	});

	it('2: confirm creates a new identity, clears the dev recents and re-runs the boot; cancel does nothing', async () => {
		mockSeedDevNetwork.mockRejectedValueOnce(new DeviceIdentityKeyUnavailableError('no-wrap-key'));
		mockSeedDevNetwork.mockImplementation(seedRealNetwork);
		mockReplaceUnrecoverableDeviceIdentity.mockResolvedValue(FAKE_USER);
		const clearSpy = jest.spyOn(NetworksEngine.prototype, 'clearRecentNetworks');
		jest.spyOn(console, 'error').mockImplementation(() => undefined);

		const {tr, captured} = renderProvider();
		await flushBoot();
		expect(mockSeedDevNetwork).toHaveBeenCalledTimes(1);

		renderer.act(() => findByTestId(tr, 'identity-recovery-create').props.onPress());
		expect(JSON.stringify(tr.toJSON())).toContain('bootError.identityLost.confirmBody');
		renderer.act(() => findByTestId(tr, 'identity-recovery-cancel').props.onPress());
		expect(mockReplaceUnrecoverableDeviceIdentity).not.toHaveBeenCalled();

		renderer.act(() => findByTestId(tr, 'identity-recovery-create').props.onPress());
		await renderer.act(async () => {
			findByTestId(tr, 'identity-recovery-confirm').props.onPress();
		});
		await flushBoot(30, () => captured.value !== null && captured.value.isInitialized === true);

		expect(mockReplaceUnrecoverableDeviceIdentity).toHaveBeenCalledTimes(1);
		expect(clearSpy).toHaveBeenCalledTimes(1);
		expect(mockSeedDevNetwork).toHaveBeenCalledTimes(2);
		expect(captured.value!.isInitialized).toBe(true);
		clearSpy.mockRestore();
		jest.restoreAllMocks();
	});

	it('3: a failed replacement shows translated failure copy, no raw text, and Try Again', async () => {
		mockSeedDevNetwork.mockRejectedValue(new DeviceIdentityKeyUnavailableError('tag-mismatch'));
		mockReplaceUnrecoverableDeviceIdentity.mockRejectedValue(new Error('boom'));
		jest.spyOn(console, 'error').mockImplementation(() => undefined);
		const {tr} = renderProvider();
		await flushBoot();
		renderer.act(() => findByTestId(tr, 'identity-recovery-create').props.onPress());
		await renderer.act(async () => {
			findByTestId(tr, 'identity-recovery-confirm').props.onPress();
		});
		await flushBoot(5);
		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain('bootError.identityLost.replaceFailed');
		expect(text).toContain('bootError.tryAgain');
		expectNoRawText(tr);
		jest.restoreAllMocks();
	});

	// WR-03: a step AFTER the replacement fails. The retry must finish the remaining steps. It asks
	// the engine again (62-REVIEW WR-03: always attempt), and the engine refuses the now-readable
	// record as 'readable'; that refusal is accepted ONLY because this session already replaced it.
	it('5: a failed step after the replacement is finished by the retry; the readable refusal of the replaced record is accepted', async () => {
		mockSeedDevNetwork.mockRejectedValueOnce(new DeviceIdentityKeyUnavailableError('no-wrap-key'));
		mockSeedDevNetwork.mockImplementation(seedRealNetwork);
		mockReplaceUnrecoverableDeviceIdentity
			.mockResolvedValueOnce(FAKE_USER)
			.mockRejectedValue(identityNotReplaceableError('identity is readable', 'readable'));
		const clearRecentsSpy = jest
			.spyOn(NetworksEngine.prototype, 'clearRecentNetworks')
			.mockRejectedValueOnce(new Error('boom'));
		const clearCacheSpy = jest.spyOn(EngineFactory.prototype, 'clearEngineCache');
		jest.spyOn(console, 'error').mockImplementation(() => undefined);

		const {tr, captured} = renderProvider();
		await flushBoot();

		renderer.act(() => findByTestId(tr, 'identity-recovery-create').props.onPress());
		await renderer.act(async () => {
			findByTestId(tr, 'identity-recovery-confirm').props.onPress();
		});
		await flushBoot(5);
		expect(tr.root.findAll(n => n.props.testID === 'identity-recovery-failed').length).toBeGreaterThan(0);
		expect(mockReplaceUnrecoverableDeviceIdentity).toHaveBeenCalledTimes(1);
		expect(clearRecentsSpy).toHaveBeenCalledTimes(1);
		expect(clearCacheSpy).not.toHaveBeenCalled();
		expectNoRawText(tr);

		renderer.act(() => findByTestId(tr, 'identity-recovery-create').props.onPress());
		await renderer.act(async () => {
			findByTestId(tr, 'identity-recovery-confirm').props.onPress();
		});
		await flushBoot(30, () => captured.value !== null && captured.value.isInitialized === true);

		expect(mockReplaceUnrecoverableDeviceIdentity).toHaveBeenCalledTimes(2);
		expect(clearRecentsSpy).toHaveBeenCalledTimes(2);
		expect(clearCacheSpy).toHaveBeenCalledTimes(1);
		expect(mockSeedDevNetwork).toHaveBeenCalledTimes(2);
		expect(tr.root.findAll(n => n.props.testID === 'identity-recovery-view')).toHaveLength(0);
		expect(captured.value!.isInitialized).toBe(true);
		jest.restoreAllMocks();
	});

	// T-62-87-01: nothing was replaced this session, so a 'readable' refusal is a real refusal —
	// it surfaces as the failed state and the next press asks the engine again (no skip).
	it('6: a readable refusal on the first attempt surfaces and is not treated as already replaced', async () => {
		mockSeedDevNetwork.mockRejectedValue(new DeviceIdentityKeyUnavailableError('no-wrap-key'));
		mockReplaceUnrecoverableDeviceIdentity.mockRejectedValue(
			identityNotReplaceableError('identity is readable', 'readable'),
		);
		const clearRecentsSpy = jest.spyOn(NetworksEngine.prototype, 'clearRecentNetworks');
		const clearCacheSpy = jest.spyOn(EngineFactory.prototype, 'clearEngineCache');
		jest.spyOn(console, 'error').mockImplementation(() => undefined);

		const {tr} = renderProvider();
		await flushBoot();
		for (let attempt = 1; attempt <= 2; attempt++) {
			renderer.act(() => findByTestId(tr, 'identity-recovery-create').props.onPress());
			// eslint-disable-next-line no-await-in-loop
			await renderer.act(async () => {
				findByTestId(tr, 'identity-recovery-confirm').props.onPress();
			});
			// eslint-disable-next-line no-await-in-loop
			await flushBoot(5);
			expect(tr.root.findAll(n => n.props.testID === 'identity-recovery-failed').length).toBeGreaterThan(0);
			expect(mockReplaceUnrecoverableDeviceIdentity).toHaveBeenCalledTimes(attempt);
		}
		expect(clearRecentsSpy).not.toHaveBeenCalled();
		expect(clearCacheSpy).not.toHaveBeenCalled();
		expect(mockSeedDevNetwork).toHaveBeenCalledTimes(1);
		jest.restoreAllMocks();
	});

	it('7: after a fully successful createNewIdentity the session flag resets, so a later loss is replaced again', async () => {
		mockSeedDevNetwork.mockRejectedValueOnce(new DeviceIdentityKeyUnavailableError('no-wrap-key'));
		mockSeedDevNetwork.mockRejectedValueOnce(new DeviceIdentityKeyUnavailableError('tag-mismatch'));
		mockSeedDevNetwork.mockImplementation(seedRealNetwork);
		mockReplaceUnrecoverableDeviceIdentity.mockResolvedValue(FAKE_USER);
		jest.spyOn(console, 'error').mockImplementation(() => undefined);

		const {tr, captured} = renderProvider();
		await flushBoot();
		for (let attempt = 1; attempt <= 2; attempt++) {
			renderer.act(() => findByTestId(tr, 'identity-recovery-create').props.onPress());
			// eslint-disable-next-line no-await-in-loop
			await renderer.act(async () => {
				findByTestId(tr, 'identity-recovery-confirm').props.onPress();
			});
			// eslint-disable-next-line no-await-in-loop
			await flushBoot(30, () =>
				mockSeedDevNetwork.mock.calls.length > attempt &&
				(tr.root.findAll(n => n.props.testID === 'identity-recovery-create').length > 0 ||
					(captured.value !== null && captured.value.isInitialized === true)),
			);
			expect(mockReplaceUnrecoverableDeviceIdentity).toHaveBeenCalledTimes(attempt);
		}
		await flushBoot(30, () => captured.value !== null && captured.value.isInitialized === true);
		expect(mockSeedDevNetwork).toHaveBeenCalledTimes(3);
		expect(captured.value!.isInitialized).toBe(true);
		jest.restoreAllMocks();
	});

	// 62-REVIEW WR-03: the session flag must not outlive the boot that proves the replacement
	// worked. Sequence: Create -> a step after the replacement fails -> the boot's Try Again (NOT
	// Create) succeeds on the new identity -> later in the same process that identity is lost too
	// -> Create. That Create must replace again and the boot must recover, never loop back to the
	// recovery view. The mocks model the record: the replacement refuses 'readable' unless the
	// record is lost, and the seed (the boot's identity read) fails while it is lost.
	it('9: a loss after an abandoned retry and a successful boot is replaced again, with no boot loop', async () => {
		let lost = true;
		mockReplaceUnrecoverableDeviceIdentity.mockImplementation(async () => {
			if (!lost) throw identityNotReplaceableError('identity is readable', 'readable');
			lost = false;
			return FAKE_USER;
		});
		mockSeedDevNetwork.mockImplementation(async (networksEngine: NetworksEngine) => {
			if (lost) throw new DeviceIdentityKeyUnavailableError('no-wrap-key');
			return seedRealNetwork(networksEngine);
		});
		jest.spyOn(NetworksEngine.prototype, 'clearRecentNetworks').mockRejectedValueOnce(new Error('boom'));
		jest.spyOn(console, 'error').mockImplementation(() => undefined);

		const {tr, captured} = renderProvider();
		await flushBoot();

		// 1-2: Create; the replacement succeeds, then clearing the recents fails.
		renderer.act(() => findByTestId(tr, 'identity-recovery-create').props.onPress());
		await renderer.act(async () => {
			findByTestId(tr, 'identity-recovery-confirm').props.onPress();
		});
		await flushBoot(5);
		expect(tr.root.findAll(n => n.props.testID === 'identity-recovery-failed').length).toBeGreaterThan(0);
		expect(mockReplaceUnrecoverableDeviceIdentity).toHaveBeenCalledTimes(1);

		// 3: the boot's Try Again (not Create) boots on the new, readable identity.
		renderer.act(() => findByTestId(tr, 'identity-recovery-retry').props.onPress());
		await flushBoot(30, () => captured.value !== null && captured.value.isInitialized === true);
		expect(captured.value!.isInitialized).toBe(true);

		// 4-5: the new identity is lost later in the same process; the voter confirms Create.
		lost = true;
		const seedCallsBefore = mockSeedDevNetwork.mock.calls.length;
		await renderer.act(async () => {
			await captured.value!.createNewIdentity();
		});
		await flushBoot(30, () =>
			mockSeedDevNetwork.mock.calls.length > seedCallsBefore &&
			(tr.root.findAll(n => n.props.testID === 'identity-recovery-view').length > 0 ||
				(captured.value !== null && captured.value.isInitialized === true)),
		);

		expect(mockReplaceUnrecoverableDeviceIdentity).toHaveBeenCalledTimes(2);
		expect(lost).toBe(false);
		expect(tr.root.findAll(n => n.props.testID === 'identity-recovery-view')).toHaveLength(0);
		expect(captured.value!.isInitialized).toBe(true);
		jest.restoreAllMocks();
	});

	it('8: useVoterApp().createNewIdentity is the same function the boot recovery view receives', async () => {
		mockSeedDevNetwork.mockRejectedValueOnce(new DeviceIdentityKeyUnavailableError('no-wrap-key'));
		mockSeedDevNetwork.mockImplementation(seedRealNetwork);
		mockReplaceUnrecoverableDeviceIdentity.mockResolvedValue(FAKE_USER);
		jest.spyOn(console, 'error').mockImplementation(() => undefined);

		const {tr, captured} = renderProvider();
		await flushBoot();
		const fromView = tr.root.findByType(IdentityRecoveryView).props.onCreateNewIdentity;
		expect(typeof fromView).toBe('function');
		await renderer.act(async () => {
			await fromView();
		});
		await flushBoot(30, () => captured.value !== null && captured.value.isInitialized === true);
		expect(captured.value!.createNewIdentity).toBe(fromView);
		jest.restoreAllMocks();
	});

	it.each([
		['wrap-unavailable', new DeviceIdentityKeyUnavailableError('wrap-unavailable')],
		['plain error', new Error('boom')],
	])('4: %s renders the generic translated view, never the create-identity button', async (_label, error) => {
		mockSeedDevNetwork.mockRejectedValue(error);
		jest.spyOn(console, 'error').mockImplementation(() => undefined);
		const {tr} = renderProvider();
		await flushBoot();
		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain('bootError.generic');
		expect(text).toContain('bootError.tryAgain');
		expect(text).toContain('bootError.continueWithoutNetwork');
		expect(text).not.toContain('bootError.identityLost.create');
		expectNoRawText(tr);
		jest.restoreAllMocks();
	});
});

describe('VoterAppProvider — shared __DEV__ clock (D-02)', () => {
	const DAY = 86_400_000;
	async function boot() {
		mockSeedDevNetwork.mockImplementation(seedRealNetwork);
		const r = renderProvider();
		await flushBoot(15, () => r.captured.value !== null);
		return r.captured;
	}

	it('A: defaults to live (offset 0, nowMs ~ Date.now())', async () => {
		const captured = await boot();
		expect(captured.value!.clockOffsetMs).toBe(0);
		expect(typeof captured.value!.setClockOffsetMs).toBe('function');
		expect(typeof captured.value!.nowMs).toBe('function');
		expect(Math.abs(captured.value!.nowMs() - Date.now())).toBeLessThan(1000);
	});

	it('B: a dev shift moves nowMs and changes getElection identity', async () => {
		const captured = await boot();
		const before = captured.value!.getElection;
		renderer.act(() => captured.value!.setClockOffsetMs(DAY));
		expect(captured.value!.clockOffsetMs).toBe(DAY);
		expect(Math.abs(captured.value!.nowMs() - Date.now() - DAY)).toBeLessThan(1000);
		expect(captured.value!.getElection).not.toBe(before);
	});

	it('C: getElection derives against the shared clock', async () => {
		const readMock = jest.requireMock('../../engines/election-read').readVoterElection as jest.Mock;
		const captured = await boot();
		renderer.act(() => captured.value!.setClockOffsetMs(DAY));
		readMock.mockResolvedValueOnce({id: 'e', title: 't', lifecycleState: 'Upcoming'});
		await captured.value!.getElection();
		const lastCall = readMock.mock.calls[readMock.mock.calls.length - 1];
		expect(Math.abs((lastCall[1] as number) - (Date.now() + DAY))).toBeLessThan(5000);
	});

	it('D: release build is inert (offset stays 0)', async () => {
		const captured = await boot();
		const g = globalThis as {__DEV__?: boolean};
		const saved = g.__DEV__;
		try {
			g.__DEV__ = false;
			renderer.act(() => captured.value!.setClockOffsetMs(DAY));
			expect(captured.value!.clockOffsetMs).toBe(0);
			expect(Math.abs(captured.value!.nowMs() - Date.now())).toBeLessThan(1000);
		} finally {
			g.__DEV__ = saved;
		}
	});

	it('E: non-finite offsets are ignored', async () => {
		const captured = await boot();
		renderer.act(() => captured.value!.setClockOffsetMs(Number.NaN));
		renderer.act(() => captured.value!.setClockOffsetMs(Number.POSITIVE_INFINITY));
		expect(captured.value!.clockOffsetMs).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Quick task 260928-kkf — "Syncing + escape button" (locked decision), mirroring
// the authority app's AppProvider test coverage.
//
// `seedDevNetwork` is given a "gate" via `makeDeferredSeed`: it still performs the
// REAL `NetworksEngine.create()` seed work (so a later `getEngine('network', ref)`
// resolves against a genuinely cached context, exactly like the tests above), but
// its outer promise does not settle until the test releases the gate — letting a
// test observe the PENDING (syncing) state before deciding how the boot finishes.
// ---------------------------------------------------------------------------
function findTouchableWithText(tr: renderer.ReactTestRenderer, text: string) {
	const touchables = tr.root.findAllByType(TouchableOpacity);
	return touchables.find(
		t => t.findAll(n => n.type === Text && n.props.children === text).length > 0,
	);
}

// The escape's label is now the translated "continue without a network" copy (echoed key in tests).
function findStartFreshButton(tr: renderer.ReactTestRenderer) {
	return findTouchableWithText(tr, 'bootError.continueWithoutNetwork');
}

/** True if the localized Syncing label (echoed key 'syncSyncing') is rendered anywhere. */
function hasSyncingLabel(tr: renderer.ReactTestRenderer): boolean {
	return JSON.stringify(tr.toJSON()).includes('syncSyncing');
}

/** A seedDevNetwork implementation that does the REAL seed work up front, then blocks
 * on an externally-releasable gate before resolving (or, if `releaseSeed('reject')` is
 * called, rejecting instead). `reachedGateCount` increments the instant a given
 * invocation starts awaiting the gate — a caller that invokes seedDevNetwork more than
 * once (the "node changed, superseded run" case) MUST poll this up to the expected
 * count (with `flushBoot`'s real-timer `until` mode — real `NetworksEngine.create()`
 * work needs real timer yields, not just microtask hops) BEFORE releasing the gate;
 * releasing before every expected invocation has reached it leaves the late arrival's
 * eventual throw/setState landing outside any `act()` wrapper. */
function makeDeferredSeed() {
	let release!: (mode: 'resolve' | 'reject') => void;
	const gate = new Promise<'resolve' | 'reject'>(resolve => {
		release = resolve;
	});
	const state = {reachedGateCount: 0};
	mockSeedDevNetwork.mockImplementation(async networksEngine => {
		const result = await seedRealNetwork(networksEngine);
		state.reachedGateCount += 1;
		const mode = await gate;
		if (mode === 'reject') {
			throw new Error('seed rejected after release');
		}
		return result;
	});
	return {releaseSeed: (mode: 'resolve' | 'reject') => release(mode), state};
}

/** Releases a deferred seed's gate AND flushes the microtask chain it unblocks —
 * INSIDE the same `act(async () => ...)` call — so every resulting state update
 * (including a superseded run's OWN legitimate `setInitError`, which can span
 * several microtask ticks past the synchronous `release()` call) is captured by
 * act() rather than warning "not wrapped in act(...)". A bare
 * `renderer.act(() => releaseSeed(...))` followed by a SEPARATE `flushBoot()` call
 * leaves exactly that gap open. */
async function releaseAndFlush(releaseSeed: (mode: 'resolve' | 'reject') => void, mode: 'resolve' | 'reject') {
	await renderer.act(async () => {
		releaseSeed(mode);
		for (let i = 0; i < 15; i++) {
			// eslint-disable-next-line no-await-in-loop
			await Promise.resolve();
		}
	});
}

describe("VoterAppProvider boot 'still syncing' surface + escape — quick task 260928-kkf", () => {
	it('hides the splash and shows the Syncing label while a boot re-attach is pending; resolves to isInitialized with no error once the seed settles', async () => {
		const {releaseSeed} = makeDeferredSeed();
		mockCadreNodeValue.syncState = 'syncing';

		const {tr, captured} = renderProvider();
		await flushBoot(30, () => hasSyncingLabel(tr));

		expect(hideSplash).toHaveBeenCalled();
		expect(hasSyncingLabel(tr)).toBe(true);
		expect(findStartFreshButton(tr)).toBeUndefined();

		await releaseAndFlush(releaseSeed, 'resolve');
		await flushBoot(30, () => captured.value !== null && captured.value.isInitialized === true);

		expect(captured.value!.isInitialized).toBe(true);
		expect(JSON.stringify(tr.toJSON())).not.toContain('Failed to load network');
	});

	it("(d) hides Start Fresh until the first-sync listener fires once, then shows it under the Syncing label", async () => {
		const {} = makeDeferredSeed();
		mockCadreNodeValue.syncState = 'syncing';
		const setFirstSyncListenerSpy = jest.spyOn(EngineFactory.prototype, 'setFirstSyncListener');

		const {tr} = renderProvider();
		await flushBoot(30, () => hasSyncingLabel(tr));

		expect(findStartFreshButton(tr)).toBeUndefined();

		const registeredListener = setFirstSyncListenerSpy.mock.calls[setFirstSyncListenerSpy.mock.calls.length - 1][0];
		expect(typeof registeredListener).toBe('function');
		renderer.act(() => {
			registeredListener?.('fake-strand-id');
		});
		await flushBoot(10);

		expect(hasSyncingLabel(tr)).toBe(true);
		expect(findStartFreshButton(tr)).toBeDefined();

		setFirstSyncListenerSpy.mockRestore();
	});

	it('(e) pressing the syncing-view Start Fresh calls clearEngineCache (which runs cancelPendingStrandWaits) and resolves to isInitialized with no error, even if the pending seed later rejects', async () => {
		const {releaseSeed} = makeDeferredSeed();
		mockCadreNodeValue.syncState = 'syncing';
		const clearEngineCacheSpy = jest.spyOn(EngineFactory.prototype, 'clearEngineCache');
		const cancelPendingStrandWaitsSpy = jest.spyOn(EngineFactory.prototype, 'cancelPendingStrandWaits');
		const setFirstSyncListenerSpy = jest.spyOn(EngineFactory.prototype, 'setFirstSyncListener');

		const {tr, captured} = renderProvider();
		await flushBoot(30, () => hasSyncingLabel(tr));

		const registeredListener = setFirstSyncListenerSpy.mock.calls[setFirstSyncListenerSpy.mock.calls.length - 1][0];
		renderer.act(() => {
			registeredListener?.('fake-strand-id');
		});
		await flushBoot(10);

		const startFresh = findStartFreshButton(tr);
		expect(startFresh).toBeDefined();

		renderer.act(() => {
			startFresh!.props.onPress();
		});
		await flushBoot(10);

		expect(clearEngineCacheSpy).toHaveBeenCalled();
		expect(cancelPendingStrandWaitsSpy).toHaveBeenCalled();
		expect(captured.value).not.toBeNull();
		expect(captured.value!.isInitialized).toBe(true);
		expect(JSON.stringify(tr.toJSON())).not.toContain('Failed to load network');

		// The superseded seed rejecting AFTER the escape must write no state — no
		// error view, no unmounted/act-violation console noise.
		const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		await releaseAndFlush(releaseSeed, 'reject');

		expect(JSON.stringify(tr.toJSON())).not.toContain('Failed to load network');
		for (const call of errorSpy.mock.calls) {
			expect(String(call[0])).not.toContain('not wrapped in act');
		}
		errorSpy.mockRestore();
		clearEngineCacheSpy.mockRestore();
		cancelPendingStrandWaitsSpy.mockRestore();
		setFirstSyncListenerSpy.mockRestore();
	});

	it('(c) unmounting while the seed is pending cancels the wait; a later rejection writes no state', async () => {
		const {releaseSeed} = makeDeferredSeed();
		mockCadreNodeValue.syncState = 'syncing';
		const cancelPendingStrandWaitsSpy = jest.spyOn(EngineFactory.prototype, 'cancelPendingStrandWaits');

		const {tr} = renderProvider();
		await flushBoot(30, () => hasSyncingLabel(tr));

		const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		renderer.act(() => {
			tr.unmount();
		});

		expect(cancelPendingStrandWaitsSpy).toHaveBeenCalled();

		await releaseAndFlush(releaseSeed, 'reject');

		for (const call of errorSpy.mock.calls) {
			expect(String(call[0])).not.toContain('not wrapped in act');
		}
		errorSpy.mockRestore();
		cancelPendingStrandWaitsSpy.mockRestore();
	});

	it('(c) a node change re-running the init effect cancels the pending wait for the superseded run', async () => {
		const {releaseSeed, state} = makeDeferredSeed();
		mockCadreNodeValue.syncState = 'syncing';
		const cancelPendingStrandWaitsSpy = jest.spyOn(EngineFactory.prototype, 'cancelPendingStrandWaits');

		function Harness({generation}: {generation: number}) {
			void generation;
			return (
				<VoterAppProvider>
					<Text>child-rendered</Text>
				</VoterAppProvider>
			);
		}

		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(<Harness generation={0} />);
		});
		await flushBoot(30, () => hasSyncingLabel(tr));
		// Real `NetworksEngine.create()` work needs real timer yields, not just
		// microtask hops (see makeDeferredSeed's header) — wait for run 1's OWN seed
		// work to have actually reached the gate before triggering the node change,
		// so the ordering below is deterministic rather than racing real DB I/O.
		await flushBoot(30, () => state.reachedGateCount >= 1);

		const callsBeforeNodeChange = cancelPendingStrandWaitsSpy.mock.calls.length;

		// Simulate the CadreNode boot's `node` value CHANGING (null -> undefined is a
		// distinct value, same as the real null -> live-node transition for
		// change-detection purposes) — re-runs the `[initNonce, node]` init effect
		// (mirrors the authority app's equivalent case). Deliberately NOT a truthy fake
		// node object: that would flip the lazy DbFactory dispatch onto the
		// strand-backed path this file's `rnDbFactory` mock does not support, crashing
		// the still-real `NetworksEngine.create()` the deferred seed performs — this
		// test's target is the engine-factory's "node actually changed" cancellation
		// logic, not the strand dispatch itself (already covered by rn-db-factory's
		// own first-sync gate tests).
		mockCadreNodeValue.node = undefined;
		renderer.act(() => {
			tr.update(<Harness generation={1} />);
		});
		await flushBoot(10);

		expect(cancelPendingStrandWaitsSpy.mock.calls.length).toBeGreaterThan(callsBeforeNodeChange);

		// Wait for the SUPERSEDING run's own seed work to reach the gate too — only
		// THEN is it safe to release without a late arrival landing outside act().
		await flushBoot(30, () => state.reachedGateCount >= 2);

		// The superseded seed's later rejection must write no state.
		const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		await releaseAndFlush(releaseSeed, 'reject');

		for (const call of errorSpy.mock.calls) {
			expect(String(call[0])).not.toContain('not wrapped in act');
		}
		errorSpy.mockRestore();
		cancelPendingStrandWaitsSpy.mockRestore();
	});
});

describe('VoterAppProvider — joined networks (spike 100)', () => {
	const JOIN_CODE = {
		v: 1 as const,
		invitation: 'encoded-invitation',
		networkHash: 'unused',
		name: 'Joined Network',
		genesis: {userId: 'u', signerKey: 'k', authorityId: 'a', adminEffectiveAt: '2026-10-12T10:00:00'},
		digest: 'F7BlCC_VqrIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
	};

	beforeEach(() => {
		mockRunVoterNetworkJoin.mockReset();
	});

	it('joinNetwork answers no-peers without touching the engine while the CadreNode has not started', async () => {
		mockSeedDevNetwork.mockImplementation(seedRealNetwork);
		const {captured} = renderProvider();
		await flushBoot(15, () => captured.value !== null);

		let result: unknown;
		await renderer.act(async () => {
			result = await captured.value!.joinNetwork(JOIN_CODE);
		});
		expect(result).toMatchObject({ok: false, reason: 'no-peers'});
		expect(mockRunVoterNetworkJoin).not.toHaveBeenCalled();
	});

	it('a successful join records the network as joined and makes it current', async () => {
		// The seed creates (and caches) a real network once; later boots reuse its result, so the
		// network the join "returns" is one the engine can open from its cache.
		let seeded: DevSeedResult | undefined;
		mockSeedDevNetwork.mockImplementation(async (engine: NetworksEngine) => (seeded ??= await seedRealNetwork(engine)));
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const deviceUser = require('../../engines/device-user');
		const userSpy = jest.spyOn(deviceUser, 'getOrCreateDeviceUser').mockResolvedValue(FAKE_USER);
		const {tr, captured} = renderProvider();
		await flushBoot(15, () => captured.value?.hasNetwork === true);

		const fakeNode = {getControlNode: () => ({getConnections: () => [{}]})};
		mockCadreNodeValue.node = fakeNode;
		function Probe() {
			captured.value = useVoterApp();
			return null;
		}
		renderer.act(() => {
			tr.update(
				<VoterAppProvider>
					<Probe />
				</VoterAppProvider>,
			);
		});
		await flushBoot(15, () => captured.value?.hasNetwork === true);

		mockRunVoterNetworkJoin.mockImplementation(async () => ({
			ok: true,
			outcome: 'joined',
			admittedVia: 'redeemed',
			networkRef: seeded!.networkReference,
			fingerprint: '17b0 6508 2fd5 aab2',
		}));
		let result: unknown;
		await renderer.act(async () => {
			result = await captured.value!.joinNetwork(JOIN_CODE);
		});

		expect(result).toMatchObject({ok: true, outcome: 'joined'});
		expect(mockRunVoterNetworkJoin).toHaveBeenCalledWith(
			expect.objectContaining({node: fakeNode, user: FAKE_USER, code: JOIN_CODE}),
		);
		expect(JSON.parse((await AsyncStorage.getItem('@votetorrent/voterJoinedNetworks'))!)).toEqual([seeded!.networkReference.hash]);
		expect(captured.value!.hasNetwork).toBe(true);
		userSpy.mockRestore();
	});

	it("a join replaces the open network's name with the joined network's", async () => {
		let seeded: DevSeedResult | undefined;
		let networks: NetworksEngine | undefined;
		mockSeedDevNetwork.mockImplementation(async (engine: NetworksEngine) => {
			networks = engine;
			return (seeded ??= await seedRealNetwork(engine));
		});
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const deviceUser = require('../../engines/device-user');
		const userSpy = jest.spyOn(deviceUser, 'getOrCreateDeviceUser').mockResolvedValue(FAKE_USER);
		const {tr, captured} = renderProvider();
		await flushBoot(15, () => captured.value?.networkName === FAKE_NETWORK_INIT.name);
		expect(captured.value!.networkName).toBe(FAKE_NETWORK_INIT.name);
		// Created before the node is set, so it takes the same local path as the seed.
		await networks!.create({...FAKE_NETWORK_INIT, name: 'Lean Network'}, FAKE_USER);
		const joinedRef = (await networks!.getRecentNetworks()).find(ref => ref.hash !== seeded!.networkReference.hash)!;

		mockCadreNodeValue.node = {getControlNode: () => ({getConnections: () => [{}]})};
		function Probe() {
			captured.value = useVoterApp();
			return null;
		}
		renderer.act(() => {
			tr.update(
				<VoterAppProvider>
					<Probe />
				</VoterAppProvider>,
			);
		});
		await flushBoot(15, () => captured.value?.networkName === FAKE_NETWORK_INIT.name);

		mockRunVoterNetworkJoin.mockImplementation(async () => ({
			ok: true,
			outcome: 'joined',
			admittedVia: 'redeemed',
			networkRef: joinedRef,
			fingerprint: '17b0 6508 2fd5 aab2',
		}));
		await renderer.act(async () => {
			await captured.value!.joinNetwork(JOIN_CODE);
		});
		await flushBoot(15, () => captured.value?.networkName === 'Lean Network');

		expect(captured.value!.networkName).toBe('Lean Network');
		userSpy.mockRestore();
	});
});

describe('VoterAppProvider — a joined network whose node settles late (#99, port of the Authority fix)', () => {
	const JOINED_REF = {hash: 'a1b2c3d4e5f60718', relays: [], name: 'Joined Network', primaryAuthorityDomainName: 'example.org'};
	const FAKE_LIVE_NODE = {getControlNode: () => ({getConnections: () => [{}]})};

	async function seedJoined() {
		await AsyncStorage.setItem('recentNetworks', JSON.stringify([JOINED_REF]));
		await AsyncStorage.setItem('@votetorrent/voterJoinedNetworks', JSON.stringify([JOINED_REF.hash]));
	}

	// Spies on the open path: the networks-engine open (recording the factory's node at call
	// time), the 'network' engine resolve, and the device user. Restored in afterEach.
	function installOpenSpies() {
		let factoryNode: unknown = null;
		const origSetNode = EngineFactory.prototype.setNode;
		jest.spyOn(EngineFactory.prototype, 'setNode').mockImplementation(function (this: EngineFactory, n: any) {
			factoryNode = n;
			return origSetNode.call(this, n);
		});
		const nodesAtOpen: unknown[] = [];
		const openSpy = jest
			.spyOn(NetworksEngine.prototype, 'open')
			.mockImplementation((async () => {
				nodesAtOpen.push(factoryNode);
			}) as any);
		const origGetEngine = EngineFactory.prototype.getEngine;
		jest.spyOn(EngineFactory.prototype, 'getEngine').mockImplementation(function (this: EngineFactory, name: string, params?: unknown) {
			return name === 'network' ? Promise.resolve({}) : (origGetEngine as any).call(this, name, params);
		} as any);
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const deviceUser = require('../../engines/device-user');
		jest.spyOn(deviceUser, 'getOrCreateDeviceUser').mockResolvedValue(FAKE_USER);
		return {openSpy, nodesAtOpen};
	}

	const captured: {value: VoterAppContextType | null} = {value: null};
	function Probe() {
		captured.value = useVoterApp();
		return null;
	}
	function mount() {
		captured.value = null;
		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(
				<VoterAppProvider>
					<Probe />
				</VoterAppProvider>,
			);
		});
		return tr;
	}
	function flip(tr: renderer.ReactTestRenderer, node: unknown, status: 'starting' | 'ready' | 'failed') {
		mockCadreNodeValue.node = node;
		mockCadreNodeValue.nodeStatus = status;
		renderer.act(() => {
			tr.update(
				<VoterAppProvider>
					<Probe />
				</VoterAppProvider>,
			);
		});
	}
	const text = (tr: renderer.ReactTestRenderer) => JSON.stringify(tr.toJSON());

	afterEach(() => {
		jest.restoreAllMocks();
		jest.useRealTimers();
	});

	it('a joined most-recent network waits for a starting node: no open, no dev seed, no join entry; the splash hides and the Syncing label shows', async () => {
		await seedJoined();
		const {openSpy} = installOpenSpies();
		const tr = mount();
		await flushBoot(30);

		expect(text(tr)).toContain('syncSyncing');
		expect(text(tr)).not.toContain('bootError.continueWithoutNetwork');
		expect(hideSplash).toHaveBeenCalled();
		expect(openSpy).toHaveBeenCalledTimes(0);
		expect(mockSeedDevNetwork).not.toHaveBeenCalled();
		expect(captured.value).toBeNull();
	});

	it('a node that settles between the recent-networks read and the open: exactly one open, on the live node', async () => {
		await seedJoined();
		const {openSpy, nodesAtOpen} = installOpenSpies();
		let openGate!: () => void;
		const gate = new Promise<void>(resolve => {
			openGate = resolve;
		});
		const realRecent = NetworksEngine.prototype.getRecentNetworks;
		jest.spyOn(NetworksEngine.prototype, 'getRecentNetworks').mockImplementation(async function (this: NetworksEngine) {
			await gate;
			return realRecent.call(this);
		});
		const tr = mount();
		await flushBoot(10);
		flip(tr, FAKE_LIVE_NODE, 'ready');
		await renderer.act(async () => {
			openGate();
		});
		await flushBoot(30, () => captured.value?.hasNetwork === true);

		expect(openSpy).toHaveBeenCalledTimes(1);
		expect((openSpy.mock.calls[0]![0] as {hash: string}).hash).toBe(JOINED_REF.hash);
		expect(nodesAtOpen[0]).toBe(FAKE_LIVE_NODE);
		expect(captured.value!.hasNetwork).toBe(true);
	});

	it('a node that fails to start shows the recoverable boot-error view, never the join entry, and opens nothing', async () => {
		await seedJoined();
		const {openSpy} = installOpenSpies();
		const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		const tr = mount();
		await flushBoot(30);
		expect(text(tr)).not.toContain('bootError.generic');
		flip(tr, null, 'failed');
		await flushBoot(30, () => text(tr).includes('bootError.generic'));

		expect(text(tr)).toContain('bootError.generic');
		expect(text(tr)).toContain('bootError.tryAgain');
		expect(openSpy).toHaveBeenCalledTimes(0);
		expect(errSpy.mock.calls.some(c => c[0] === 'joined network re-attach failed:' && c[1] === 'NetworkNodeUnavailableError')).toBe(true);
	});

	it('after 15 s of waiting the Continue-without-network escape appears and the run keeps waiting; a later ready settle still opens once on the live node', async () => {
		await seedJoined();
		const {openSpy, nodesAtOpen} = installOpenSpies();
		jest.useFakeTimers();
		const spin = async (ms: number) => {
			await renderer.act(async () => {
				await jest.advanceTimersByTimeAsync(ms);
			});
		};
		try {
			const tr = mount();
			for (let i = 0; i < 10; i++) {
				// eslint-disable-next-line no-await-in-loop
				await spin(0);
			}
			await spin(14999);
			expect(text(tr)).not.toContain('bootError.continueWithoutNetwork');
			await spin(1);
			expect(text(tr)).toContain('bootError.continueWithoutNetwork');
			expect(text(tr)).toContain('syncSyncing');
			expect(openSpy).toHaveBeenCalledTimes(0);

			flip(tr, FAKE_LIVE_NODE, 'ready');
			for (let i = 0; i < 30 && captured.value?.hasNetwork !== true; i++) {
				// eslint-disable-next-line no-await-in-loop
				await spin(0);
			}
			expect(openSpy).toHaveBeenCalledTimes(1);
			expect(nodesAtOpen[0]).toBe(FAKE_LIVE_NODE);
			expect(captured.value!.hasNetwork).toBe(true);
		} finally {
			jest.useRealTimers();
		}
	});

	it('a phone with no joined network is not held by a starting node (the dev seed runs as before)', async () => {
		mockSeedDevNetwork.mockImplementation(seedRealNetwork);
		mount();
		await flushBoot(15, () => captured.value !== null);

		expect(mockSeedDevNetwork).toHaveBeenCalledTimes(1);
		expect(captured.value!.isInitialized).toBe(true);
		expect(captured.value!.hasNetwork).toBe(true);
	});
});
