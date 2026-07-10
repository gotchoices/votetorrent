/**
 * VotingAppProvider — the single app-wide mock provider for this phase (D-02: no draft
 * providers yet). Mirrors ONLY Authority `AppProvider`'s `isInitialized` gate + `useApp()`
 * throw-if-outside pattern + async engine-mimicking read API (D-01) — stripped of all
 * real-engine plumbing (EngineFactory / CadreNode / re-attach / retry UI, D-02).
 *
 * Voting has no `hideSplash`/`EngineFactory`/`CadreNodeProvider`/`LocalStorageReact` — those are
 * Authority-only real-engine concerns explicitly excluded this phase (D-02). Do NOT port
 * `selectNetwork`, `initError`/"Try Again"/"Start Fresh" recovery UI, or `initNonce` retry.
 * Do NOT scaffold `RegistrationDraftProvider` or `BallotDraftProvider` (D-02 — each lands with
 * its own flow in Phase 41/42).
 */
import React, {createContext, useCallback, useContext, useEffect, useState} from 'react';
import type {PropsWithChildren} from 'react';
import {ActivityIndicator, View} from 'react-native';
import type {LifecycleState, MockBallot, MockElection, VotingAppContextType} from './types';
import {LIFECYCLE_CONTENT, mockBallot, mockElection} from './mockData';

const VotingAppContext = createContext<VotingAppContextType | null>(null);

export function useVotingApp(): VotingAppContextType {
	const context = useContext(VotingAppContext);
	if (!context) {
		throw new Error('useVotingApp must be used within a VotingAppProvider');
	}
	return context;
}

export function VotingAppProvider({children}: PropsWithChildren) {
	const [isInitialized, setIsInitialized] = useState(false);
	// D-03: one lifecycle state, defaulted to 'Upcoming', with a setter exposed through context
	// so Phase 40's __DEV__ cycler can drive it.
	const [lifecycleState, setLifecycleState] = useState<LifecycleState>('Upcoming');

	// REG-01/REG-04: sync registration-status pair mirroring lifecycleState (Pattern 3) — NOT
	// routed through getElection(), there is no per-state merge step for a plain boolean.
	const [isRegistered, setIsRegisteredState] = useState(false);
	const [registeredAt, setRegisteredAt] = useState<string | null>(null);

	const setIsRegistered = useCallback((value: boolean) => {
		setIsRegisteredState(value);
		if (value) {
			// Freeze the confirm-time timestamp (RESEARCH Anti-Patterns) — the registered card's
			// valid-through date is derived from this, not recomputed per render.
			setRegisteredAt(new Date().toISOString());
		}
	}, []);

	// VOTE-04/D-08: sync voted-status flag, mirroring isRegistered — a flag read directly in a
	// JSX branch condition (ElectionCard's Open-state CTA) needs no Promise/loading state and no
	// timestamp companion (unlike isRegistered/registeredAt).
	const [hasVoted, setHasVoted] = useState(false);

	useEffect(() => {
		// Instant this phase — no real async boot work yet (D-01/D-02: no EngineFactory, no
		// CadreNode, no re-attach). The gate exists so screens/tests exercise the same
		// isInitialized pattern the eventual real-engine swap will reuse.
		setIsInitialized(true);
	}, []);

	// Async even though the data is in-memory — mirrors the shape a real engine's read method
	// would have (D-01 swap-fidelity investment). Reflects the current lifecycleState so
	// consumers reading through getElection() stay in sync with the __DEV__ cycler, merging in
	// that state's per-state LIFECYCLE_CONTENT entry (Phase 40, RESEARCH Pitfall 1) — still a
	// single async read point, no second context method (D-01 swap-fidelity).
	const getElection = useCallback(async (): Promise<MockElection> => {
		return {...mockElection, lifecycleState, ...LIFECYCLE_CONTENT[lifecycleState]};
	}, [lifecycleState]);

	// VOTE-01/02, D-02: mirrors getElection()'s async-read shape, but simpler — no per-state
	// merge (mockBallot's content doesn't vary by lifecycle state this phase, RESEARCH Pattern 3).
	const getBallot = useCallback(async (): Promise<MockBallot> => {
		return mockBallot;
	}, []);

	if (!isInitialized) {
		return (
			<View style={{flex: 1, justifyContent: 'center', alignItems: 'center'}}>
				<ActivityIndicator size="large" />
			</View>
		);
	}

	return (
		<VotingAppContext.Provider
			value={{
				isInitialized,
				lifecycleState,
				setLifecycleState,
				getElection,
				isRegistered,
				setIsRegistered,
				registeredAt,
				getBallot,
				hasVoted,
				setHasVoted,
			}}>
			{children}
		</VotingAppContext.Provider>
	);
}
