/**
 * election-types.ts — the Voter's election and ballot view-model types, moved from
 * `apps/VoteTorrentVoter/src/providers/types.ts` by phase 67 plan 19 (that file re-exports them).
 *
 * The election/ballot shapes below are the voter's view-models over the REAL engine read surface
 * (`election-read.ts`: `IElectionsEngine` -> `getElectionDetails()` / `getBallots()` /
 * `getBallotDetails()`). Fields with no engine source yet (voting progress, keys released,
 * validation checks/fingerprint, certification) are OPTIONAL and left absent in a real read —
 * never faked. The app's dev-only lifecycle override fills them from its fixtures so every card
 * state can still be design-reviewed; `LIFECYCLE_ORDER` (the cycler list) stays in the app.
 *
 * Type-only: this module has no value export.
 */

/**
 * The 7-state election lifecycle, in canonical order (D-03). The app's dev-only cycler steps
 * through its `LIFECYCLE_ORDER` to force review of every state.
 */
export type LifecycleState =
  | 'Upcoming'
  | 'Open'
  | 'ReviewSelections'
  | 'ReleasingKeys'
  | 'Validation'
  | 'ValidationDetails'
  | 'Complete'

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
  nameKey: string
  /** Bare i18n key resolving to this check's result copy (e.g. `validationDetails.check1.result`). */
  resultKey: string
  /** Elapsed time for this check, in seconds. */
  elapsedSeconds: number
  /** Whether this check has completed verification, or is still pending. */
  verified: boolean
}

/**
 * The per-lifecycle-state content of an election card. All fields are optional: not every state
 * uses every field (e.g. `ReviewSelections`/`Complete` show no countdown or progress — RESEARCH
 * Pitfall 4/A3), and a REAL read only fills what the engine can source (`countdownTarget`,
 * `keysTotal`, and `keysReleased` from the release engine). The rest have no engine source yet and
 * are only ever populated by the app's dev-only lifecycle override (`DEV_LIFECYCLE_CONTENT`).
 */
export interface LifecycleContent {
  /** ISO-8601 countdown target, for states whose card shows a countdown. */
  countdownTarget?: string
  /** Progress ratio (0-1), for states whose card shows a progress bar (Open only, per D-10). */
  progress?: number
  /**
   * Number of election keys released so far (ReleasingKeys/Validation/Complete). Read from the
   * release engine's ACCEPTED count (`getKeyReleaseStatus().releasedCount`); absent, never 0, when
   * no election key is published or the read fails.
   */
  keysReleased?: number
  /** Total number of election keys required (ReleasingKeys/Validation). */
  keysTotal?: number
  /** Number of validation checks completed so far (Validation/ValidationDetails). */
  checksComplete?: number
  /** Total number of validation checks (Validation/ValidationDetails). */
  checksTotal?: number
  /** Validation fingerprint string (ValidationDetails). */
  fingerprint?: string
  /** Whether the election has been certified (Complete). */
  certified?: boolean
  /** Per-check evidence rows for the Validation Details drill-in (ValidationDetails). */
  evidence?: ValidationCheck[]
}

/**
 * The voter's current election: its identity and title (from `getElectionDetails()`), the
 * lifecycle state derived from its timeline at read time, and that state's `LifecycleContent`.
 * The single shape every downstream screen consumes.
 */
export type VoterElection = {
  id: string
  title: string
  lifecycleState: LifecycleState
} & LifecycleContent

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
  id: string
  /** The authority's `Option.code`, the value a vote answer carries (D-23). Use it instead of parsing `id`. */
  optionCode: string
  name: string
  /** `Option.details` — the secondary line under the name (e.g. a party). Absent when unpublished. */
  party?: string
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
  id: string
  /** The owning `Ballot.id`. */
  ballotId: string
  /** `Question.code`, the key a vote answer carries. */
  questionCode: string
  /** `Question.required !== false`; vote-core defaults an absent flag to required (D-04). */
  required: boolean
  /** `Question.dependsOn != null`; this app cannot evaluate a dependency, so Submit is blocked (D-05). */
  hasDependsOn: boolean
  title: string
  group?: string
  voteFor: number
  candidates: Candidate[]
}

/**
 * The voter's ballot for the current election: every `select` question across the election's
 * ballots, flattened into one `offices` list. `unsupportedQuestionCount` counts questions this
 * app cannot render (`rank`/`score`/`text`) so the Ballot Page can say so instead of silently
 * dropping them.
 */
export interface VoterBallot {
  electionId: string
  offices: Office[]
  unsupportedQuestionCount: number
}
