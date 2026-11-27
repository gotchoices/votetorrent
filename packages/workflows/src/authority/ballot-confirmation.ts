/**
 * ballot-confirmation.ts: propose a ballot, submit it for confirmation, read its confirmation state.
 *
 * Extracted by phase 67 plan 10 from `apps/VoteTorrentAuthority/src/screens/ballots/EditBallotScreen.tsx`:
 * handlePropose lines 352-387 (`toProposedBallot`, `proposeBallot`), handleSubmitForConfirmation lines
 * 268-302 (`submitBallot`) and the confirmation-state normalization at lines 183-190
 * (`toBallotConfirmationView`, `readBallotConfirmation`). The screen keeps its read sequencing, timeout,
 * retry, dirty-draft and withdraw presentation logic (and `withdrawBallotConfirmation` is one direct
 * engine call, not a workflow body).
 *
 * Secrecy contract: nothing here logs. The submit signer is a plain `SignCallback` the caller supplies;
 * this module never calls it itself and never sees a key. Every engine parameter is a `Pick` of exactly
 * the members used, so fakes and the screen's loosely typed route engine both fit.
 */
import type { Ballot, IElectionEngine } from '@votetorrent/vote-core'
import type { SignCallback } from '../platform/signer.js'

/** The loosely shaped draft the ballot form holds (`authority` is the dropdown's key for `authorityId`). */
export interface BallotDraft {
  id?: string
  electionId?: string
  authority?: string
  authorityId?: string
  description?: string
  districts?: string[]
  questions?: Ballot['questions']
}

export interface ToProposedBallotContext {
  /** The persisted ballot's id when editing; `undefined` for a new ballot. */
  ballotId?: string
  /** The route's election id, the fallback for a draft without one. */
  electionId?: string
  /** Used only for a brand-new ballot id (`ballot-<electionId>-<now>`). */
  now: number
}

/**
 * The EXACT fallback expression EditBallotScreen used (lines 362-369): id from the draft, else the
 * persisted ballotId, else `ballot-<electionId>-<now>`; `authority` preferred over `authorityId`;
 * empty defaults for the rest.
 */
export function toProposedBallot(draft: BallotDraft, ctx: ToProposedBallotContext): Ballot {
  return {
    id: draft.id ?? ctx.ballotId ?? `ballot-${ctx.electionId}-${ctx.now}`,
    electionId: draft.electionId ?? ctx.electionId ?? '',
    authorityId: draft.authority ?? draft.authorityId ?? '',
    description: draft.description ?? '',
    districts: draft.districts ?? [],
    questions: draft.questions ?? [],
  }
}

export interface ProposeBallotParams extends ToProposedBallotContext {
  electionEngine: Pick<IElectionEngine, 'proposeBallot'>
  draft: BallotDraft
}

/** G12: upsert via the engine (an existing id replaces the stored ballot, never duplicates it). */
export async function proposeBallot(params: ProposeBallotParams): Promise<Ballot> {
  const ballot = toProposedBallot(params.draft, params)
  await params.electionEngine.proposeBallot(ballot)
  return ballot
}

export interface SubmitBallotParams {
  electionEngine: Pick<IElectionEngine, 'submitBallotForConfirmation'>
  ballotId: string
  /**
   * The lazy-signer contract (D-03/D-08, EditBallotScreen lines 262-267): the engine invokes `sign` ONLY
   * when the authority's `ceb` threshold is above 1, to record the submitting officer's own signature at
   * submit time. A threshold-1 authority never calls it: it needs neither a provisioned key nor a prompt
   * to submit, and the engine opens a confirmation Task for the submitting officer instead. The app
   * passes a thunk that resolves its device signer on first use; the CLI passes its signer.
   */
  sign: SignCallback
}

/** Submit the persisted ballot for confirmation. The caller re-reads the state afterwards rather than guessing. */
export async function submitBallot(params: SubmitBallotParams): Promise<void> {
  await params.electionEngine.submitBallotForConfirmation(params.ballotId, params.sign)
}

export interface BallotConfirmationView {
  /** A pending confirmation Task exists: the ballot is out for confirmation and cannot be edited. */
  locked: boolean
  /** A finalized Ballot row exists. */
  confirmed: boolean
  /** An unreached open session whose AdminSigning.UserId is the caller. */
  canWithdraw: boolean
  /** An open ballot Task for this ballot whose UserId is the caller. */
  ownTaskOpen: boolean
}

/** EditBallotScreen's `apply` normalization (lines 184-189), tolerating an absent or partial state. */
export function toBallotConfirmationView(state: Partial<BallotConfirmationView> | null | undefined): BallotConfirmationView {
  return {
    locked: !!state?.locked,
    confirmed: !!state?.confirmed,
    canWithdraw: state?.canWithdraw === true,
    ownTaskOpen: state?.ownTaskOpen === true,
  }
}

export interface ReadBallotConfirmationParams {
  electionEngine: Pick<IElectionEngine, 'getBallotConfirmationState'>
  ballotId: string
}

/** D-05 / D-09: the edit-lock and confirmation state of one proposed ballot, normalized. */
export async function readBallotConfirmation(params: ReadBallotConfirmationParams): Promise<BallotConfirmationView> {
  return toBallotConfirmationView(await params.electionEngine.getBallotConfirmationState(params.ballotId))
}
