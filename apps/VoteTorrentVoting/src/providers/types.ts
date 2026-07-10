/**
 * App-local, future-engine-shaped interfaces for VoteTorrentVoting's mock provider (D-04).
 *
 * These shapes deliberately mirror what a future `vote-core` election read surface would look
 * like (id, title, lifecycle state, async reads) so that swapping VotingAppProvider's mock
 * implementation for a real engine later is DI-only, not a rewrite of every screen (D-01).
 *
 * Voter/Registration/Ballot-selection shapes that have no `vote-core` analog stay app-local
 * here — they are NOT promoted to `vote-core` this phase (D-04, REQUIREMENTS Out of Scope).
 * This module must never import from `vote-core`.
 */

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
 * `getBallot()` on `VotingAppContextType`, mirroring `getElection()`'s swap-fidelity shape
 * (D-01) — no per-lifecycle-state merge, unlike `MockElection` (RESEARCH Pattern 3).
 */
export interface MockBallot {
	electionId: string;
	offices: Office[];
}

/**
 * The provider's context shape. Read methods are async (Promise-returning) even though the
 * backing data is in-memory this phase — a deliberate swap-fidelity investment (D-01) so the
 * eventual real-engine wiring becomes DI-only, not a rewrite of every screen.
 */
export interface VotingAppContextType {
	isInitialized: boolean;
	lifecycleState: LifecycleState;
	setLifecycleState: (state: LifecycleState) => void;
	getElection: () => Promise<MockElection>;
	/**
	 * Whether the current voter is registered. Gates ONLY the Registration-tab card's
	 * not-registered/registered branch — never the Vote flow (HOME-02). Plain synchronous
	 * boolean (not a Promise), mirroring lifecycleState rather than the async getElection() shape.
	 */
	isRegistered: boolean;
	/**
	 * Flips isRegistered and, when set to true, freezes `registeredAt` to the confirm-time ISO
	 * timestamp (RESEARCH Anti-Patterns — the registered card's valid-through date is derived
	 * from this frozen value, not recomputed per render).
	 */
	setIsRegistered: (value: boolean) => void;
	/** Confirm-time ISO-8601 timestamp set by setIsRegistered(true); null until then. */
	registeredAt: string | null;
}
