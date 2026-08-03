/**
 * Manual Jest mock for `VotingAppProvider` (Phase 44-07, D-02/D-04).
 *
 * Auto-loaded by Jest when a test calls `jest.mock('.../providers/VotingAppProvider')` with NO
 * factory (Jest's manual-mock convention: a `__mocks__` directory adjacent to the mocked module).
 *
 * The real `VotingAppProvider` is now a composition root that requires a `CadreNodeProvider`
 * ancestor and boots a real `EngineFactory` + (in `__DEV__`) the D-07 dev-seed — heavy, native-
 * module-backed machinery that most screen/flow tests have no need to exercise (only
 * `src/providers/__tests__/VotingAppProvider.test.tsx` proves that boot for real, per 44-07 Task
 * 3). This mock reproduces ONLY the mock-data-backed election/ballot/lifecycle surface that
 * Phase 44 leaves unchanged (`isInitialized`/`lifecycleState`/`setLifecycleState`/`getElection`/
 * `getBallot`) as REAL, stateful React context — so tests exercising the __DEV__ lifecycle cycler
 * or ballot flows still behave correctly — plus inert stand-ins for the real-engine surface
 * (`getEngine`/`hasEngine`/`selectNetwork`/`hasNetwork`/`seededElectionId`/`sign`) that no
 * existing screen test needs to drive. Mirrors the authority app's App.test.tsx inert-mock
 * convention (39-04 precedent) applied at the module level instead of per-test-file.
 */
import React, {createContext, useCallback, useContext, useState} from 'react';
import type {PropsWithChildren} from 'react';
import type {LifecycleState, MockBallot, MockElection, VotingAppContextType} from '../types';
import {LIFECYCLE_CONTENT, mockBallot, mockElection} from '../mockData';

const VotingAppContext = createContext<VotingAppContextType | null>(null);

export function useVotingApp(): VotingAppContextType {
	const context = useContext(VotingAppContext);
	if (!context) {
		throw new Error('useVotingApp must be used within a VotingAppProvider');
	}
	return context;
}

export function VotingAppProvider({children}: PropsWithChildren) {
	const [lifecycleState, setLifecycleState] = useState<LifecycleState>('Upcoming');

	const getElection = useCallback(async (): Promise<MockElection> => {
		return {...mockElection, lifecycleState, ...LIFECYCLE_CONTENT[lifecycleState]};
	}, [lifecycleState]);

	const getBallot = useCallback(async (): Promise<MockBallot> => {
		return mockBallot;
	}, []);

	const getEngine = useCallback(async <T,>(): Promise<T> => {
		throw new Error('getEngine is not available in the test mock VotingAppProvider');
	}, []);

	const hasEngine = useCallback(() => false, []);

	const selectNetwork = useCallback(async () => {
		throw new Error('selectNetwork is not available in the test mock VotingAppProvider');
	}, []);

	return (
		<VotingAppContext.Provider
			value={{
				isInitialized: true,
				lifecycleState,
				setLifecycleState,
				getElection,
				getBallot,
				hasNetwork: false,
				getEngine,
				hasEngine,
				selectNetwork,
				seededElectionId: undefined,
				sign: undefined,
			}}>
			{children}
		</VotingAppContext.Provider>
	);
}
