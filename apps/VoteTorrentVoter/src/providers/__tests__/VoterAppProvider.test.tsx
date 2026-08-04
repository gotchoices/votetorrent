/**
 * Behavioral tests for VoterAppProvider — the real composition root (Phase 44-07, D-02/D-04/D-07).
 *
 * Proves the plan's `must_haves`:
 *   - Rendering VoterAppProvider (wrapped in a mocked CadreNodeProvider, mirroring App.tsx's
 *     nesting) flips `isInitialized` to true after the mocked D-07 seed + network open resolve,
 *     and calls `hideSplash`.
 *   - `useVoterApp()` surfaces a real `getEngine` accessor plus `seededElectionId`/`sign`
 *     (captured from `seedDevNetwork`'s return) — NOT the removed `isRegistered` mock boolean.
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
import {Database} from '@quereus/quereus';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {UserKeyType, ElectionType} from '@votetorrent/vote-core';
import type {NetworkInit, Scope, Signature, User} from '@votetorrent/vote-core';
import type {NetworksEngine} from '@votetorrent/vote-engine/rn';
import type {DevSeedResult} from '../../engines/dev-seed';

// This test drives real NetworksEngine.create()/open() DB operations (not pure UI rendering),
// so give it headroom above Jest's 5000ms default on a loaded CI/dev machine.
jest.setTimeout(20000);

// Mirrors App.tsx's nesting (CadreNodeProvider wraps VoterAppProvider) with an inert
// pass-through — this test proves VoterAppProvider's OWN plumbing, not a real CadreNode boot.
jest.mock('../CadreNodeProvider', () => ({
	useCadreNode: () => ({node: null, syncState: 'offline', connectedPeers: () => 0}),
	CadreNodeProvider: ({children}: {children: React.ReactNode}) => children,
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

import {VoterAppProvider, useVoterApp} from '../VoterAppProvider';
import type {VoterAppContextType} from '../types';
import {hideSplash} from 'react-native-splash-view';

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
		officers: [{init: {name: FAKE_USER.name, title: 'Registrar', scopes: ['vrg'] as Scope[]}}],
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
 * setState) — bounded loop, mirrors CadreNodeProvider.test.tsx's flushBoot convention. */
async function flushBoot(ticks = 15) {
	for (let i = 0; i < ticks; i++) {
		// eslint-disable-next-line no-await-in-loop
		await renderer.act(async () => {
			await Promise.resolve();
		});
	}
}

beforeEach(async () => {
	mockSeedDevNetwork.mockReset();
	(hideSplash as jest.Mock).mockClear();
	// AsyncStorage's jest mock is a module-scope singleton store shared across every it() in this
	// file — clear it so each test's seedRealNetwork() creates a genuinely fresh network (mirrors
	// dev-seed.test.ts's own AsyncStorage.clear() isolation convention).
	await AsyncStorage.clear();
});

describe('VoterAppProvider — real composition root (D-02/D-04/D-07)', () => {
	it('boots to isInitialized after the mocked seed resolves, and calls hideSplash', async () => {
		mockSeedDevNetwork.mockImplementation(seedRealNetwork);
		const {captured} = renderProvider();
		await flushBoot();

		expect(captured.value).not.toBeNull();
		expect(captured.value!.isInitialized).toBe(true);
		expect(hideSplash).toHaveBeenCalled();
	});

	it('useVoterApp() exposes a real getEngine accessor plus seededElectionId + sign (not the removed isRegistered mock boolean)', async () => {
		mockSeedDevNetwork.mockImplementation(seedRealNetwork);
		const {captured} = renderProvider();
		await flushBoot();

		expect(typeof captured.value!.getEngine).toBe('function');
		expect(typeof captured.value!.hasEngine).toBe('function');
		expect(typeof captured.value!.selectNetwork).toBe('function');
		expect(captured.value!.seededElectionId).toBe('test-seeded-election-id');
		expect(typeof captured.value!.sign).toBe('function');
		expect((captured.value as unknown as Record<string, unknown>).isRegistered).toBeUndefined();
		expect((captured.value as unknown as Record<string, unknown>).registeredAt).toBeUndefined();
		expect((captured.value as unknown as Record<string, unknown>).hasVoted).toBeUndefined();
	});

	it('on a forced seedDevNetwork throw, renders the recoverable "Try Again" view — never a silent empty network (T-44-18)', async () => {
		mockSeedDevNetwork.mockRejectedValue(new Error('seed-boom'));
		const {tr} = renderProvider();
		await flushBoot();

		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain('Try Again');
		expect(text).toContain('Start Fresh');
		expect(hideSplash).toHaveBeenCalled();
	});
});
