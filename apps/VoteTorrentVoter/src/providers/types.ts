/**
 * App-local, future-engine-shaped interfaces for VoteTorrentVoter's provider (D-04).
 *
 * The election/ballot lifecycle shapes below deliberately mirror what a future `vote-core`
 * election read surface would look like (id, title, lifecycle state, async reads) so that
 * swapping their mock backing for a real engine later is DI-only, not a rewrite of every
 * screen (D-01). They stay mock-data-backed this phase (Phase 44 scope is the registration
 * flow only, per 44-CONTEXT.md's Phase Boundary — the election/ballot read surface is a later
 * phase's concern).
 *
 * Phase 44 (D-02/D-04/D-07): `VoterAppContextType` now ALSO carries the real composition
 * root's surface (`getEngine`/`hasEngine`/`selectNetwork`/`hasNetwork`) mirroring the authority
 * app's `AppProvider`, plus the D-07 dev-seeded `seededElectionId`/`sign` the register seam
 * (44-08) reads. The three former registration/voted-status mock booleans (and their setters)
 * are REMOVED from this context — the real registration flow (real `Registrant` rows via
 * `RegistrationEngine`) replaces them; any screen that still needs a local registered/voted flag
 * now owns it as component-local state (see `RegistrationScreen.tsx`/`HomeScreen.tsx`/
 * `ReviewSubmitScreen.tsx`).
 *
 * Voter/Registration/Ballot-selection shapes that have no `vote-core` analog stay app-local
 * here — they are NOT promoted to `vote-core` this phase (D-04, REQUIREMENTS Out of Scope).
 * This module must never import from `vote-core` (a bare `NetworkReference`/`Signature` type
 * import is fine — those are pure type-only re-exports, not a runtime dependency on vote-core).
 */
import type {NetworkReference, Signature} from '@votetorrent/vote-core';

/**
 * The 7-state election lifecycle, in canonical order (D-03). Phase 40's `__DEV__` cycler steps
 * through LIFECYCLE_ORDER to force review of every state; Phase 40 fills in each state's actual
 * screen content.
 */
export type LifecycleState =
	| 'Upcoming'
	| 'Open'
	| 'ReviewSelections'
	| 'ReleasingKeys'
	| 'Validation'
	| 'ValidationDetails'
	| 'Complete';

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
 * A single evidence row for the Validation Details drill-in (HOME-03/D-11). Mirrors what a real
 * `vote-core` validation-report row would expose (a check identity, its outcome, timing, and
 * completion status) — the name/result are i18n KEYS, not literal copy (SHELL-03 spirit: the
 * data layer holds identifiers/values, the i18n layer holds user-facing strings).
 */
export interface ValidationCheck {
	/**
	 * Bare (no namespace prefix) i18n key resolving to this check's name within the `home`
	 * namespace (e.g. `validationDetails.check1.name`) — resolved via `t(nameKey)` from a
	 * `useTranslation('home')` call.
	 */
	nameKey: string;
	/** Bare i18n key resolving to this check's result copy (e.g. `validationDetails.check1.result`). */
	resultKey: string;
	/** Elapsed time for this check, in seconds (mock timing data, per-state fixture-sourced). */
	elapsedSeconds: number;
	/** Whether this check has completed verification, or is still pending. */
	verified: boolean;
}

/**
 * The per-lifecycle-state content that varies across the `__DEV__` cycler (RESEARCH Pitfall 1).
 * A flat `MockElection` cannot represent "3/5 keys released" (ReleasingKeys) and "5/5 keys
 * released" (Validation) simultaneously — both would have to live on the same static fields of
 * the same object. Instead, one `LifecycleContent` entry per state is merged into the resolved
 * election by `getElection()` (`providers/mockData.ts`'s `LIFECYCLE_CONTENT` map). All fields are
 * optional because not every state uses every field (e.g. `ReviewSelections`/`Complete` show no
 * countdown or progress — RESEARCH Pitfall 4/A3).
 */
export interface LifecycleContent {
	/** ISO-8601 countdown target, for states whose card shows a countdown. */
	countdownTarget?: string;
	/** Progress ratio (0-1), for states whose card shows a progress bar (Open only, per D-10). */
	progress?: number;
	/** Number of election keys released so far (ReleasingKeys/Validation). */
	keysReleased?: number;
	/** Total number of election keys required (ReleasingKeys/Validation). */
	keysTotal?: number;
	/** Number of validation checks completed so far (Validation/ValidationDetails). */
	checksComplete?: number;
	/** Total number of validation checks (Validation/ValidationDetails). */
	checksTotal?: number;
	/** Validation fingerprint string (ValidationDetails), e.g. mock "Birddog133". */
	fingerprint?: string;
	/** Whether the election has been certified (Complete). */
	certified?: boolean;
	/** Per-check evidence rows for the Validation Details drill-in (ValidationDetails). */
	evidence?: ValidationCheck[];
}

/**
 * Future-engine-shaped mock election — the base identity (id, title, lifecycle state) a real
 * `vote-core` election read would expose, intersected with the current lifecycle state's
 * `LifecycleContent` (merged in by `getElection()`). This is the single shape every downstream
 * screen consumes — the eventual real-engine swap stays DI-only (D-01) because the merged shape
 * never changes, only what populates it does.
 */
export type MockElection = {
	id: string;
	title: string;
	lifecycleState: LifecycleState;
} & LifecycleContent;

/**
 * A single ballot candidate (Phase 42, VOTE-01/02, D-02/D-03). `nameKey`/`partyKey` are i18n
 * KEYS resolved within the `ballot` namespace (e.g. `t(candidate.nameKey)`), not literal
 * copy — mirrors `ValidationCheck.nameKey`/`resultKey`'s i18n-key-not-literal convention above
 * (SHELL-03 spirit: the data layer holds identifiers, the i18n layer holds user-facing strings).
 */
export interface Candidate {
	id: string;
	nameKey: string;
	partyKey: string;
}

/**
 * A single ballot office/question (Phase 42, VOTE-01/02, D-02/D-03/D-04). `titleKey` is an i18n
 * key (same convention as `Candidate`). `jurisdiction` drives the Ballot Page's Federal/State
 * display-time grouping (RESEARCH Pattern 3 — a flat, order-stable `offices` array is the single
 * source of truth; grouping is a filter, never a split array, so Next/Previous can walk one
 * index space). `voteFor` drives both the "Vote for N" modal header and radio-(1)-vs-capped-
 * checkbox-(>1) rendering (D-03) — the `voteFor` cap is the ONLY selection constraint.
 */
export interface Office {
	id: string;
	titleKey: string;
	jurisdiction: 'Federal' | 'State';
	voteFor: number;
	candidates: Candidate[];
}

/**
 * The mock ballot for the current election (Phase 42, VOTE-01, D-02). Served async via
 * `getBallot()` on `VoterAppContextType`, mirroring `getElection()`'s swap-fidelity shape
 * (D-01) — no per-lifecycle-state merge, unlike `MockElection` (RESEARCH Pattern 3).
 */
export interface MockBallot {
	electionId: string;
	offices: Office[];
}

/**
 * The provider's context shape. Election/ballot read methods are async (Promise-returning) even
 * though the backing data is in-memory this phase — a deliberate swap-fidelity investment (D-01)
 * so the eventual real-engine wiring for THAT surface becomes DI-only, not a rewrite of every
 * screen.
 *
 * Phase 44 (D-02/D-04): the composition-root surface below (`getEngine`/`hasEngine`/
 * `selectNetwork`/`hasNetwork`) is REAL — it delegates to a real `EngineFactory` + booted
 * `CadreNode`, mirroring the authority app's `AppProvider`. `seededElectionId`/`sign` are
 * captured from the D-07 dev-seed's return and are only populated in `__DEV__` (undefined
 * otherwise — there is no production join flow yet, P2P-11 stays paused).
 */
export interface VoterAppContextType {
	isInitialized: boolean;
	lifecycleState: LifecycleState;
	setLifecycleState: (state: LifecycleState) => void;
	getElection: () => Promise<MockElection>;
	/**
	 * Async read of the current election's mock ballot (Phase 42, VOTE-01/02, D-02) — mirrors
	 * `getElection()`'s swap-fidelity shape (D-01). No per-lifecycle-state merge, unlike
	 * `getElection()` (RESEARCH Pattern 3).
	 */
	getBallot: () => Promise<MockBallot>;
	/**
	 * True once the D-07 seeded/most-recent network has been re-attached (or the seeding attempt
	 * has resolved, success or failure) — mirrors the authority `AppProvider`'s `hasNetwork`,
	 * gating the recoverable error view (`initError && !hasNetwork`).
	 */
	hasNetwork: boolean;
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
	 * The D-07 dev-seeded election's id, captured from `seedDevNetwork`'s return — pass as
	 * `RegisterInit.electionId` (44-08) so `validateFieldPolicy` enforces the seeded policy.
	 * Only set in `__DEV__`; `undefined` otherwise (no production join flow yet).
	 */
	seededElectionId: string | undefined;
	/**
	 * The SAME device signer used both as the dev-seed's founding-officer key and as
	 * `register()`'s `signatureOrCallback` (44-08) — one identity, two roles (D-05). Only set in
	 * `__DEV__`; `undefined` otherwise.
	 */
	sign: ((digest: Uint8Array) => Promise<Signature>) | undefined;
}
