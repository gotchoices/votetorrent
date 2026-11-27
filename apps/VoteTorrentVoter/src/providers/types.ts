/**
 * App-local, future-engine-shaped interfaces for VoteTorrentVoter's provider (D-04).
 *
 * The election/ballot shapes below are the voter's view-models over the REAL engine read surface
 * (`engines/election-read.ts`: `IElectionsEngine` -> `getElectionDetails()` / `getBallots()` /
 * `getBallotDetails()`). Fields with no engine source yet (voting progress, keys released,
 * validation checks/fingerprint, certification) are OPTIONAL and left absent in a real read —
 * never faked. The `__DEV__` lifecycle override fills them from `devLifecycleFixtures.ts` so
 * every card state can still be design-reviewed.
 *
 * Phase 44 (D-02/D-04/D-07): `VoterAppContextType` now ALSO carries the real composition
 * root's surface (`getEngine`/`hasEngine`/`selectNetwork`/`hasNetwork`) mirroring the authority
 * app's `AppProvider`, plus the D-07 dev-seeded `seededElectionId` the registration seam reads.
 * The three former registration/voted-status mock booleans (and their setters) are REMOVED from
 * this context — the real registration flow (real `Registrant` rows via `RegistrationEngine`)
 * replaces them; any screen that still needs a local registered/voted flag now owns it as
 * component-local state (see `RegistrationScreen.tsx`/`HomeScreen.tsx`/`ReviewSubmitScreen.tsx`).
 *
 * 51-12 (D-09/D-20): the context's `sign` field (the founding-officer device signer,
 * `DevSeedResult.sign`) is REMOVED. `ConfirmationScreen.tsx` was rewritten by 51-11 to never
 * destructure `useVoterApp().sign` — it is dead plumbing, and dead plumbing that hands out an
 * officer-capable signer is exactly the kind of "obvious, convenient" surface a future
 * contributor could wire back into a reintroduced admin-signed ceremony (T-51-12-02). Removing
 * it here means there is no `sign` left on this context to wire back in the first place —
 * `DevSeedResult.sign` itself is UNCHANGED (dev-seed.ts / dev-seed.test.ts still need it as the
 * seed's own election/policy-row signer).
 *
 * Voter/Registration/Ballot-selection shapes that have no `vote-core` analog stay app-local
 * here — they are NOT promoted to `vote-core` this phase (D-04, REQUIREMENTS Out of Scope).
 * This module must never import from `vote-core` (a bare `NetworkReference` type import is
 * fine — that is a pure type-only re-export, not a runtime dependency on vote-core).
 */
import type {NetworkReference} from '@votetorrent/vote-core';
import type {NetworkJoinCode, NetworkJoinResult, NetworkJoinStep, PoolMatchmakingPorts} from '@votetorrent/vote-engine/rn';

/**
 * The election/ballot view-model types (`LifecycleState`, `ValidationCheck`, `LifecycleContent`,
 * `VoterElection`, `Candidate`, `Office`, `VoterBallot`) moved to
 * `packages/workflows/src/voter/election-types.ts` (phase 67 plan 19) and are re-exported here, type-only,
 * so every existing importer keeps its path. In short: `LifecycleState` is the 7-state lifecycle in
 * canonical order (D-03); `ValidationCheck` is one evidence row for the Validation Details drill-in
 * (HOME-03/D-11) whose name/result are i18n keys; `LifecycleContent` is the per-state card content, all
 * optional and only engine-sourced fields filled in a real read; `VoterElection` is the current election
 * (id, title, derived state) plus its content; `Candidate` is one `Option` of a `select` `Question`;
 * `Office` is one `select` `Question` with its `group`/`voteFor`; `VoterBallot` is the flattened office
 * list with its `unsupportedQuestionCount`.
 */
import type {Candidate, LifecycleContent, LifecycleState, Office, ValidationCheck, VoterBallot, VoterElection} from '@votetorrent/workflows/voter';

export type {Candidate, LifecycleContent, LifecycleState, Office, ValidationCheck, VoterBallot, VoterElection};

/** Ordered mirror of LifecycleState, for the `__DEV__` cycler (D-03) and tests. */
export const LIFECYCLE_ORDER: readonly LifecycleState[] = [
	'Upcoming',
	'Open',
	'ReviewSelections',
	'ReleasingKeys',
	'Validation',
	'ValidationDetails',
	'Complete',
];

/**
 * The provider's context shape. `getElection`/`getBallot` are real engine reads and REJECT when
 * there is no election (or no ballot) to read — callers render an unavailable state, never a
 * guessed one.
 *
 * Phase 44 (D-02/D-04): the composition-root surface below (`getEngine`/`hasEngine`/
 * `selectNetwork`/`hasNetwork`) is REAL — it delegates to a real `EngineFactory` + booted
 * `CadreNode`, mirroring the authority app's `AppProvider`. `seededElectionId` is captured from
 * the D-07 dev-seed's return and is only populated in `__DEV__` (undefined otherwise — there is
 * no production join flow yet, P2P-11 stays paused). There is no `sign` field (51-12, D-09/D-20)
 * — see the module doc comment above.
 */
export interface VoterAppContextType {
	isInitialized: boolean;
	/**
	 * `__DEV__`-only design-review override (D-03 cycler). `null` = live: `getElection()` reports
	 * the state derived from the election's timeline. Non-null forces that state AND overlays its
	 * `DEV_LIFECYCLE_CONTENT` fixture. Always `null` in a release build (the setter is inert).
	 */
	lifecycleOverride: LifecycleState | null;
	setLifecycleOverride: (state: LifecycleState | null) => void;
	/**
	 * D-02: the `__DEV__`-only offset in ms added to the wall clock; 0 = live. Always 0 in a
	 * release build (the setter is inert).
	 */
	clockOffsetMs: number;
	/** D-02: inert unless `__DEV__`; ignores non-finite input. */
	setClockOffsetMs: (ms: number) => void;
	/**
	 * D-02: the one clock every election-window read uses (Home card state, Timeline rail, the
	 * Submit window gate). Equals `Date.now()` in a release build. Consumers call `nowMs()` per
	 * read and never cache it.
	 */
	nowMs: () => number;
	/** Real read of the current election. Rejects when there is no election to read. */
	getElection: () => Promise<VoterElection>;
	/** Real read of the current election's ballot. Rejects when there is no election to read. */
	getBallot: () => Promise<VoterBallot>;
	/**
	 * True once the D-07 seeded/most-recent network has been re-attached (or the seeding attempt
	 * has resolved, success or failure) — mirrors the authority `AppProvider`'s `hasNetwork`,
	 * gating the recoverable error view (`initError && !hasNetwork`).
	 */
	hasNetwork: boolean;
	/**
	 * The open network's name (`Network.Name`), read after each join, re-attach or dev seed.
	 * `undefined` until a network is open or when that read fails; screens then show the
	 * `common:networkName` fallback (see `useNetworkName`).
	 */
	networkName?: string;
	/**
	 * Real engine accessor — delegates to the `EngineFactory` this provider owns via `useRef`.
	 * Mirrors the authority app's `AppProvider.getEngine` (D-02/D-04).
	 */
	getEngine: <T>(engineName: string, initParams?: unknown) => Promise<T>;
	/** True if the named engine is already cached in the factory. Mirrors `AppProvider.hasEngine`. */
	hasEngine: (engineName: string) => boolean;
	/**
	 * Make `networkRef` the active/current network for this session without an app restart.
	 * Mirrors the authority app's `AppProvider.selectNetwork` (D-02/D-04).
	 */
	selectNetwork: (networkRef: NetworkReference) => Promise<void>;
	/**
	 * Spike 100: join an authority-created network from a decoded join code — redeem its cadre
	 * invitation, open and verify the network's strand, then make it current (selectNetwork).
	 * Resolves a typed result for every join problem; only an identity failure rejects.
	 */
	joinNetwork: (code: NetworkJoinCode, onStep?: (step: NetworkJoinStep) => void) => Promise<NetworkJoinResult>;
	/**
	 * Spike 102: the running network node, whose control connection carries vote-pool traffic to
	 * the authority's rendezvous; null until the node boots. Screens hand it to engines only.
	 */
	getNetworkNode: () => {getControlNode(): unknown} | null;
	/**
	 * Optimystic matchmaking ports for the current network's strand node (engines/pool-matchmaking-ports.ts),
	 * or null when the node, the strand or its cohort-topic substrate is not up. Optional so test doubles of
	 * this context need not provide it.
	 */
	getPoolMatchmaking?: () => PoolMatchmakingPorts | null;
	/**
	 * The D-07 dev-seeded election's id, captured from `seedDevNetwork`'s return — pass as
	 * `RegisterInit.electionId` (44-08) so `validateFieldPolicy` enforces the seeded policy.
	 * Only set in `__DEV__`; `undefined` otherwise (no production join flow yet).
	 */
	seededElectionId: string | undefined;
	/**
	 * Replace a PERMANENTLY unrecoverable device identity (lost wrap key, tag or key mismatch)
	 * with a brand-new one, then re-run the boot. Explicit and user-confirmed only — wire it to
	 * `IdentityRecoveryView`'s confirm step; never call it from a boot path or automatically.
	 * Nothing is recovered (D-40). A refusal (e.g. the identity is readable) rejects; a retry
	 * after a later step failed finishes that step without replacing a second time.
	 */
	createNewIdentity: () => Promise<void>;
}
