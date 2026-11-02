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
	/** Elapsed time for this check, in seconds. */
	elapsedSeconds: number;
	/** Whether this check has completed verification, or is still pending. */
	verified: boolean;
}

/**
 * The per-lifecycle-state content of an election card. All fields are optional: not every state
 * uses every field (e.g. `ReviewSelections`/`Complete` show no countdown or progress — RESEARCH
 * Pitfall 4/A3), and a REAL read only fills what the engine can source (`countdownTarget`,
 * `keysTotal`, and `keysReleased` from the release engine). The rest have no engine source yet and are only ever populated by the `__DEV__`
 * lifecycle override (`devLifecycleFixtures.ts`'s `DEV_LIFECYCLE_CONTENT`).
 */
export interface LifecycleContent {
	/** ISO-8601 countdown target, for states whose card shows a countdown. */
	countdownTarget?: string;
	/** Progress ratio (0-1), for states whose card shows a progress bar (Open only, per D-10). */
	progress?: number;
	/**
	 * Number of election keys released so far (ReleasingKeys/Validation/Complete). Read from the
	 * release engine's ACCEPTED count (`getKeyReleaseStatus().releasedCount`); absent, never 0, when
	 * no election key is published or the read fails.
	 */
	keysReleased?: number;
	/** Total number of election keys required (ReleasingKeys/Validation). */
	keysTotal?: number;
	/** Number of validation checks completed so far (Validation/ValidationDetails). */
	checksComplete?: number;
	/** Total number of validation checks (Validation/ValidationDetails). */
	checksTotal?: number;
	/** Validation fingerprint string (ValidationDetails). */
	fingerprint?: string;
	/** Whether the election has been certified (Complete). */
	certified?: boolean;
	/** Per-check evidence rows for the Validation Details drill-in (ValidationDetails). */
	evidence?: ValidationCheck[];
}

/**
 * The voter's current election: its identity and title (from `getElectionDetails()`), the
 * lifecycle state derived from its timeline at read time, and that state's `LifecycleContent`.
 * The single shape every downstream screen consumes.
 */
export type VoterElection = {
	id: string;
	title: string;
	lifecycleState: LifecycleState;
} & LifecycleContent;

/**
 * A single ballot candidate — one `Option` of a `select` `Question`. `name`/`party` are the
 * authority's literal published text (`Option.title` / `Option.details`), NOT i18n keys: ballot
 * content is election data, so it is shown exactly as the authority published it.
 */
export interface Candidate {
	/**
	 * `${ballotId}:${questionCode}:${optionCode}` — unique across every ballot in the election. A
	 * display/selection key only: code that needs the codes reads the structured fields and never
	 * splits this id on `:`.
	 */
	id: string;
	/** The authority's `Option.code`, the value a vote answer carries (D-23). Use it instead of parsing `id`. */
	optionCode: string;
	name: string;
	/** `Option.details` — the secondary line under the name (e.g. a party). Absent when unpublished. */
	party?: string;
}

/**
 * A single ballot office/question — one `select` `Question`. `group` (`Question.group`) drives
 * the Ballot Page's display-time sections, in first-appearance order; the flat, order-stable
 * `offices` array (already sorted by group) is the single source of truth, so Next/Previous walk
 * one index space (RESEARCH Pattern 3). `voteFor` (`Question.optionRange.max`, default 1) drives
 * both the "Vote for N" header and radio-(1)-vs-capped-checkbox-(>1) rendering (D-03).
 */
export interface Office {
	/**
	 * `${ballotId}:${questionCode}` — a display/selection key only; never split it on `:`, read
	 * `ballotId` / `questionCode` instead.
	 */
	id: string;
	/** The owning `Ballot.id`. */
	ballotId: string;
	/** `Question.code`, the key a vote answer carries. */
	questionCode: string;
	/** `Question.required !== false`; vote-core defaults an absent flag to required (D-04). */
	required: boolean;
	/** `Question.dependsOn != null`; this app cannot evaluate a dependency, so Submit is blocked (D-05). */
	hasDependsOn: boolean;
	title: string;
	group?: string;
	voteFor: number;
	candidates: Candidate[];
}

/**
 * The voter's ballot for the current election: every `select` question across the election's
 * ballots, flattened into one `offices` list. `unsupportedQuestionCount` counts questions this
 * app cannot render (`rank`/`score`/`text`) so the Ballot Page can say so instead of silently
 * dropping them.
 */
export interface VoterBallot {
	electionId: string;
	offices: Office[];
	unsupportedQuestionCount: number;
}

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
