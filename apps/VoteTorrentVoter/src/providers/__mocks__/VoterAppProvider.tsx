/**
 * Manual Jest mock for `VoterAppProvider` (Phase 44-07, D-02/D-04).
 *
 * Auto-loaded by Jest when a test calls `jest.mock('.../providers/VoterAppProvider')` with NO
 * factory (Jest's manual-mock convention: a `__mocks__` directory adjacent to the mocked module).
 *
 * The real `VoterAppProvider` is now a composition root that requires a `CadreNodeProvider`
 * ancestor and boots a real `EngineFactory` + (in `__DEV__`) the D-07 dev-seed — heavy, native-
 * module-backed machinery that most screen/flow tests have no need to exercise (only
 * `src/providers/__tests__/VoterAppProvider.test.tsx` proves that boot for real, per 44-07 Task
 * 3). This mock serves the election/ballot/lifecycle surface (`isInitialized`/`lifecycleOverride`/
 * `setLifecycleOverride`/`getElection`/`getBallot`) from the TEST fixtures in
 * `__fixtures__/voter-fixtures.ts` as REAL, stateful React context — so tests exercising the
 * lifecycle cycler or ballot flows still behave correctly (the real provider reads the engine;
 * `engines/__tests__/election-read.test.ts` covers that read) — plus inert stand-ins for the real-engine surface
 * (`getEngine`/`hasEngine`/`selectNetwork`/`hasNetwork`/`seededElectionId`) that no existing
 * screen test needs to drive. Mirrors the authority app's App.test.tsx inert-mock convention
 * (39-04 precedent) applied at the module level instead of per-test-file. 51-12 (D-09/D-20):
 * `VoterAppContextType` no longer has a `sign` field at all (see `types.ts`'s doc comment), so
 * this mock has nothing to stand in for there.
 *
 * `createNewIdentity` is the exported `__mockCreateNewIdentity` jest.fn (resolves undefined).
 *
 * D-02: also mirrors the shared clock (`clockOffsetMs`/`setClockOffsetMs`/`nowMs`). Deviation from
 * 63-PATTERNS: the setter is STATEFUL (inert outside `__DEV__`), not a no-op, because later screen
 * tests drive the dev clock through this mock.
 */
import React, {createContext, useCallback, useContext, useState} from 'react';
import type {PropsWithChildren} from 'react';
import type {LifecycleState, VoterBallot, VoterElection, VoterAppContextType} from '../types';
import {DEV_LIFECYCLE_CONTENT} from '../devLifecycleFixtures';
import {FIXTURE_BALLOT, FIXTURE_ELECTION} from '../__fixtures__/voter-fixtures';

const VoterAppContext = createContext<VoterAppContextType | null>(null);

// Test hooks (reach them via `jest.requireMock`): swap what getBallot()/getElection() resolve or
// reject with, to drive a screen's unavailable state. Called with no argument, each resets to the
// fixture. Tests that use them must reset in `afterEach`.
const defaultBallotReader = async (): Promise<VoterBallot> => FIXTURE_BALLOT;
let ballotReader = defaultBallotReader;
let electionFailure: Error | null = null;
export function __setMockGetBallot(reader?: () => Promise<VoterBallot>): void {
	ballotReader = reader ?? defaultBallotReader;
}
export function __setMockGetElectionFailure(error?: Error): void {
	electionFailure = error ?? null;
}
// The context's createNewIdentity: a jest.fn resolving undefined. Assert on it via
// `jest.requireMock(...).__mockCreateNewIdentity`; tests that use it should clear it in `afterEach`.
export const __mockCreateNewIdentity = jest.fn(async (): Promise<void> => undefined);

export function useVoterApp(): VoterAppContextType {
	const context = useContext(VoterAppContext);
	if (!context) {
		throw new Error('useVoterApp must be used within a VoterAppProvider');
	}
	return context;
}

export function VoterAppProvider({children}: PropsWithChildren) {
	const [lifecycleOverride, setLifecycleOverride] = useState<LifecycleState | null>(null);

	const [clockOffsetMs, setClockOffsetMsState] = useState(0);
	const setClockOffsetMs = useCallback((ms: number) => {
		if (__DEV__ && Number.isFinite(ms)) {
			setClockOffsetMsState(ms);
		}
	}, []);
	const nowMs = useCallback(() => Date.now() + (__DEV__ ? clockOffsetMs : 0), [clockOffsetMs]);

	// Live mode reports 'Upcoming' (the fixture has no timeline to derive from); an override forces
	// the state and overlays its review fixture, exactly like the real provider.
	const getElection = useCallback(async (): Promise<VoterElection> => {
		if (electionFailure) {
			throw electionFailure;
		}
		const lifecycleState = lifecycleOverride ?? 'Upcoming';
		return {...FIXTURE_ELECTION, lifecycleState, ...DEV_LIFECYCLE_CONTENT[lifecycleState]};
	}, [lifecycleOverride]);

	const getBallot = useCallback((): Promise<VoterBallot> => ballotReader(), []);

	const getEngine = useCallback(async <T,>(): Promise<T> => {
		throw new Error('getEngine is not available in the test mock VoterAppProvider');
	}, []);

	const hasEngine = useCallback(() => false, []);

	const selectNetwork = useCallback(async () => {
		throw new Error('selectNetwork is not available in the test mock VoterAppProvider');
	}, []);

	const joinNetwork = useCallback(async () => {
		throw new Error('joinNetwork is not available in the test mock VoterAppProvider');
	}, []);

	return (
		<VoterAppContext.Provider
			value={{
				isInitialized: true,
				lifecycleOverride,
				setLifecycleOverride,
				clockOffsetMs,
				setClockOffsetMs,
				nowMs,
				getElection,
				getBallot,
				hasNetwork: false,
				networkName: undefined,
				getEngine,
				hasEngine,
				selectNetwork,
				joinNetwork,
				getNetworkNode: () => null,
				seededElectionId: undefined,
				createNewIdentity: __mockCreateNewIdentity,
			}}>
			{children}
		</VoterAppContext.Provider>
	);
}
