/**
 * VoterAppProvider — the app-wide composition root (Phase 44-07, D-02/D-04/D-07).
 *
 * Rewritten from the Phase-39/40/42 mock provider into a REAL composition root mirroring the
 * authority app's `AppProvider` (44-PATTERNS.md "Composition-root useRef-stable factory +
 * isInitialized gate"): one `EngineFactory` via `useRef` (never recreated), `useCadreNode()`
 * wired via `setNode`/`setGetPeerCount`, `selectNetwork` for runtime network switching, and the
 * `initError`/"Try Again"/"Start Fresh" recovery UI.
 *
 * D-07: in `__DEV__` the boot effect AWAITS `seedDevNetwork(...)` BEFORE opening the network (so
 * the seeded network exists when the voter reads it — never fire-and-forget), then captures the
 * seed's returned `electionId`/`sign` onto context as `seededElectionId`/`sign` — the register
 * seam `ConfirmationScreen` (44-08) reads.
 *
 * The `lifecycleState`/`getElection`/`getBallot` mock-data-backed election/ballot read surface is
 * UNCHANGED (Phase 44's scope is the registration flow only, per 44-CONTEXT.md's Phase Boundary —
 * swapping the election/ballot surface for a real engine is a later phase's concern). The
 * `isRegistered`/`registeredAt`/`hasVoted` mock booleans are REMOVED — the real registration flow
 * (real `Registrant` rows via `RegistrationEngine`) replaces them (D-02).
 *
 * MUST have a `CadreNodeProvider` ancestor (mounted in `App.tsx`) — `useCadreNode()` throws
 * otherwise, mirroring the authority app's requirement.
 */
import React, {createContext, useCallback, useContext, useEffect, useRef, useState} from 'react';
import type {PropsWithChildren} from 'react';
import {ActivityIndicator, Text, TouchableOpacity, View} from 'react-native';
import {hideSplash} from 'react-native-splash-view';
import type {IDefaultUserEngine, NetworkReference} from '@votetorrent/vote-core';
import {EngineFactory} from '../engines/engine-factory';
import {LocalStorageReact} from '@votetorrent/vote-engine/rn';
import {rnDbFactory} from '../engines/rn-db-factory';
import {getOrCreateDeviceUser} from '../engines/device-user';
import {seedDevNetwork} from '../engines/dev-seed';
import type {SignCallback} from '../engines/device-signer';
import {useCadreNode} from './CadreNodeProvider';
import type {LifecycleState, MockBallot, MockElection, VoterAppContextType} from './types';
import {LIFECYCLE_CONTENT, mockBallot, mockElection} from './mockData';

const VoterAppContext = createContext<VoterAppContextType | null>(null);

export function useVoterApp(): VoterAppContextType {
	const context = useContext(VoterAppContext);
	if (!context) {
		throw new Error('useVoterApp must be used within a VoterAppProvider');
	}
	return context;
}

export function VoterAppProvider({children}: PropsWithChildren) {
	const [isInitialized, setIsInitialized] = useState(false);
	const [hasNetwork, setHasNetwork] = useState(false);
	const [initError, setInitError] = useState<string | null>(null);
	// CR-02 parity: bump this to re-run the init effect ("Try Again"). The init effect's dep
	// array includes initNonce; setIsInitialized(false) alone cannot re-fire it.
	const [initNonce, setInitNonce] = useState(0);

	// D-07: the dev-seeded election id + device sign callback, captured from seedDevNetwork's
	// return once the boot effect resolves. Only populated in __DEV__ (undefined otherwise).
	const [seededElectionId, setSeededElectionId] = useState<string | undefined>(undefined);
	const [sign, setSign] = useState<SignCallback | undefined>(undefined);

	// D-03: one lifecycle state, defaulted to 'Upcoming', with a setter exposed through context
	// so Phase 40's __DEV__ cycler can drive it. UNCHANGED from the mock provider — the
	// election/ballot read surface stays mock-data-backed this phase (Phase 44 scope is
	// registration only).
	const [lifecycleState, setLifecycleState] = useState<LifecycleState>('Upcoming');

	// D-02/D-04: one app-lifetime EngineFactory via useRef (constructed once, stable across
	// renders) — mirrors the authority app's AppProvider (44-PATTERNS.md).
	const engineFactoryRef = useRef<EngineFactory | null>(null);
	if (!engineFactoryRef.current) {
		engineFactoryRef.current = new EngineFactory(new LocalStorageReact(), rnDbFactory);
	}

	// Collapse to factory delegation — empty dep array, factory is stable via useRef.
	const getEngine = useCallback(async <T,>(engineName: string, initParams?: unknown): Promise<T> => {
		return engineFactoryRef.current!.getEngine<T>(engineName, initParams);
	}, []);

	const hasEngine = useCallback((engineName: string) => {
		return engineFactoryRef.current?.hasEngine(engineName) ?? false;
	}, []);

	// Activate a network at runtime (picker "Select") without a reboot. Mirrors the boot
	// re-attach block below so behavior is identical to a restart.
	const selectNetwork = useCallback(async (networkRef: NetworkReference) => {
		const factory = engineFactoryRef.current!;
		const defaultUserEng = await factory.getEngine<IDefaultUserEngine>('defaultUser');
		const defaultUser = await defaultUserEng.get();
		const user = await getOrCreateDeviceUser(defaultUser?.name ?? 'Device User');
		factory.setCurrentUser(user);
		await factory.getNetworksEngine().open(networkRef, user);
		await factory.getEngine('network', networkRef);
		setHasNetwork(true);
	}, []);

	// D-04/D-05: register the CadreNode live peer-count source + booted node with the factory,
	// mirroring the authority app's AppProvider. connectedPeers is keyed by strandId
	// (== networkHash); node is null until CadreNode boots (rnDbFactory stays active until then,
	// solo-safe — P2P-11 stays paused this phase).
	const {connectedPeers, node} = useCadreNode();
	useEffect(() => {
		engineFactoryRef.current?.setGetPeerCount(connectedPeers);
		engineFactoryRef.current?.setNode(node);
	}, [connectedPeers, node]);

	useEffect(() => {
		async function initialize() {
			try {
				const factory = engineFactoryRef.current!;

				// RE-ATTACH FIX (mirrors authority AppProvider): synchronise the current
				// CadreNode state into the factory before any DbFactory call — the lazy-dispatch
				// DbFactory selects strand vs solo based on factory.node AT CALL TIME.
				factory.setNode(node);

				const networksEng = factory.getNetworksEngine();

				if (__DEV__) {
					// D-07: AWAIT seedDevNetwork BEFORE opening the network (never
					// fire-and-forget) — creates (or re-attaches to) the dev-seeded network +
					// founding-officer authority + election + field-registration policy, and
					// resolves the SAME device signer used both as founding officer and as the
					// registrant's own signing key (44-06).
					try {
						const seeded = await seedDevNetwork(networksEng);
						// Bind the resolved device user into the factory BEFORE
						// getEngine("network", ...) so the factory's internal open() also uses
						// the real user.
						factory.setCurrentUser(seeded.deviceUser);
						await factory.getEngine('network', seeded.networkReference);
						setHasNetwork(true);
						setSeededElectionId(seeded.electionId);
						// Function values need the useState updater form — otherwise React
						// treats the argument as a lazy initializer and invokes it.
						setSign(() => seeded.sign);
						// Clear any initError from a previous failed attempt so the error
						// screen is not shown when a retry succeeds.
						setInitError(null);
						// Deterministic boot marker: the real dev-seed + network open
						// succeeded, so the app is about to render Home against the real
						// engine. Consumed as the logcat PASS token by the on-device
						// cold-start smoke (scripts/voter-boot-smoke.sh). Additive only.
						console.log('[voter-boot] VoterAppProvider isInitialized');
					} catch (seedError) {
						// D-15 parity: surface the recoverable error; spinner resolves to an
						// error view. NEVER fall back to a silent empty in-memory network.
						console.error('seedDevNetwork failed:', seedError);
						setInitError(String(seedError));
						// fall through to setIsInitialized(true) below so the spinner never
						// hangs.
					}
				}
				// Non-__DEV__ (production) boot: no join flow exists yet (P2P-11 paused, no
				// production seed source) — hasNetwork stays false; screens that need a real
				// network gate on it, mirroring the authority app's cold-start-no-network state.

				setIsInitialized(true);
				hideSplash();
			} catch (fatalError) {
				// Outer catch handles failures before/after the seed/re-attach block (e.g.
				// LocalStorageReact init failure).
				console.error('Fatal init error:', fatalError);
				setInitError(String(fatalError));
				setIsInitialized(true);
				hideSplash();
			}
		}

		initialize();
		// Re-run when initNonce changes (Try Again) or node changes (CadreNode boot race,
		// mirrors authority AppProvider's re-attach-fix dep array).
	}, [initNonce, node]);

	// Async even though the data is in-memory — mirrors the shape a real engine's read method
	// would have (D-01 swap-fidelity investment). UNCHANGED from the mock provider.
	const getElection = useCallback(async (): Promise<MockElection> => {
		return {...mockElection, lifecycleState, ...LIFECYCLE_CONTENT[lifecycleState]};
	}, [lifecycleState]);

	// UNCHANGED from the mock provider — no per-state merge (Phase 42, RESEARCH Pattern 3).
	const getBallot = useCallback(async (): Promise<MockBallot> => {
		return mockBallot;
	}, []);

	// Only show the spinner while initialization is truly pending.
	if (!isInitialized) {
		return (
			<View style={{flex: 1, justifyContent: 'center', alignItems: 'center'}}>
				<ActivityIndicator size="large" />
			</View>
		);
	}

	// Recoverable boot-error state — shown INSIDE the existing loading View, no new screen, no
	// visual redesign. Never fabricate an empty in-memory context; user must retry or start
	// fresh. No GSD phase numbers in this user-facing copy (project rule).
	if (initError && !hasNetwork) {
		return (
			<View style={{flex: 1, justifyContent: 'center', alignItems: 'center'}}>
				<Text style={{marginBottom: 16, textAlign: 'center'}}>
					{'Failed to load network: ' + initError}
				</Text>
				<TouchableOpacity
					onPress={() => {
						// Try Again: reset error state and re-run initialize().
						setInitError(null);
						setIsInitialized(false);
						setInitNonce(n => n + 1);
					}}
					style={{marginBottom: 8}}>
					<Text>{'Try Again'}</Text>
				</TouchableOpacity>
				<TouchableOpacity
					onPress={() => {
						// Start Fresh: clear the engine cache and reset to a clean-slate boot.
						engineFactoryRef.current?.clearEngineCache();
						setInitError(null);
						setIsInitialized(true);
					}}>
					<Text>{'Start Fresh'}</Text>
				</TouchableOpacity>
			</View>
		);
	}

	return (
		<VoterAppContext.Provider
			value={{
				isInitialized,
				lifecycleState,
				setLifecycleState,
				getElection,
				getBallot,
				hasNetwork,
				getEngine,
				hasEngine,
				selectNetwork,
				seededElectionId,
				sign,
			}}>
			{children}
		</VoterAppContext.Provider>
	);
}
