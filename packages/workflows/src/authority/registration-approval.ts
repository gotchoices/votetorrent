/**
 * registration-approval.ts — the officer's registration decision workflow (phase 67 plan 18).
 *
 * Moved from the Authority app's `RegistrationRequestApprovalScreen.tsx` (screens/registration): the
 * load, the approve ceremony, the refusal, the threshold vote and the stale close. The screen keeps
 * React state and presentation and calls these functions; the CLI officer verbs call the same code.
 * The bodies are the screen's, statement for statement: same calls, same order, same arguments.
 *
 * The gate order is a security property, not a style choice:
 * - WR-02 / WR-19 / D-07: `approveRegistrationRequest` re-asserts the verification-checklist gate and
 *   the own-task check BEFORE any engine read, any signer resolution and any signature, so an ungated
 *   call spends no biometric prompt and writes nothing. The engine refuses an ungated completion
 *   independently; this gate exists so the refusal comes before a signature is requested.
 * - 48-11 L-2: the accept passes `sign` UNCONDITIONALLY and binds the SAME checklist array into
 *   `decision`; there is no placeholder fallback, because a placeholder would produce an approval whose
 *   checklist is covered by nothing.
 * - 48-11 L-3: the officer's task is found by `requestId` equality, never by signature type alone: an
 *   officer legitimately has several pending requests, and the first registrant task could be another
 *   request's digest.
 * - D-12: a refusal never advances the signing session. `refuseRegistrationRequest` never reads the
 *   signature digest and never invokes the signer itself; the signer goes to the engine, which signs the
 *   rejection RECORD (L-2: the record must be attributable, D-06). The task close is the blank triple
 *   with no `sign` and no `decision`.
 * - WR-14: past the rejection (or the stale close) the decision IS RECORDED, signed and `NoDelete`. The
 *   task close and the publish are separate acts whose failure is never reported as a failed decision:
 *   the close is swallowed and reported as `taskClose: 'failed'`, the publish never throws.
 *
 * Never-log rule (the screen's header note 3): a request carries registrant PII, and the rejection
 * reason, the request id, the checklist and the signature are decision data. None of them ever reaches
 * an error message, a step event or a log. This file contains zero console calls, no debug logger and
 * no template literal over an id; `RegistrationApprovalError.message` is its code and nothing else, and
 * a step event is exactly `{ step, atMs }`. Errors from engines and signers are rethrown as the
 * identical object (no wrapping, no retry, no fallback), so the callers' structural classifiers
 * (closed-as-duplicate, content-access, requester-unverifiable, device-signing key invalidation)
 * behave exactly as before the move. Error classification is structural (name + code), never
 * `instanceof`, across the package boundary.
 */
import { isChecklistGateMet } from '@votetorrent/vote-core'
import type {
  IRegistrationEngine,
  ISignatureTasksEngine,
  LikelyDuplicateRequest,
  PriorRejection,
  RegistrantSignatureTask,
  RegistrationDuplicateClosure,
  RegistrationRequestRead,
  RegistrationStaleCloseAvailability,
  RegistrationVerificationChecklistItem,
  SignatureTask,
  SigningStatus,
} from '@votetorrent/vote-core'
import type { SignCallback } from '../platform/signer.js'
import { publishRegistrationDecisionAfterDecide, registrationContentUnreadKey } from './continuity-review.js'
import type { PeerReviewDeps, PublishAfterDecideOutcome } from './continuity-review.js'

/** Engine lookup by name, as both apps' `useApp().getEngine` and the CLI daemon provide it. */
export type GetEngine = <T>(engineName: string) => Promise<T>

/**
 * The signer seam. The app passes `() => createDeviceSigner("Device User")`, the CLI a token signer.
 * Never a key: the private key stays closed over on the implementing side.
 */
export type SignResolver = () => Promise<SignCallback>

/** Wraps the writes a decision makes (the app's commit tracker); defaults to identity. */
export type DecisionTrack = <T>(fn: () => Promise<T>) => Promise<T>

export type RegistrationDecisionStepName =
  | 'gate-checked'
  | 'digest-read'
  | 'signed'
  | 'completed'
  | 'rejected'
  | 'closed-stale'
  | 'vote-recorded'
  | 'task-closed'
  | 'published'

/** A step event carries the step name and a clock reading. No other field, ever. */
export interface RegistrationDecisionStep {
  step: RegistrationDecisionStepName
  atMs: number
}

export type RegistrationDecisionStepObserver = (step: RegistrationDecisionStep) => void

export type RegistrationApprovalErrorCode = 'not-found' | 'checklist-incomplete' | 'no-task'

const APPROVAL_ERROR_CODES: readonly RegistrationApprovalErrorCode[] = ['not-found', 'checklist-incomplete', 'no-task']

/**
 * A local failure carried by code only. The code is the whole message: it never holds a request id
 * or a screen name, so the callers map it to catalog copy and nothing here can reach a screen or a
 * terminal as text.
 */
export class RegistrationApprovalError extends Error {
  readonly code: RegistrationApprovalErrorCode

  constructor(code: RegistrationApprovalErrorCode) {
    super(code)
    this.name = 'RegistrationApprovalError'
    this.code = code
  }
}

/** Structural read of a `RegistrationApprovalError` (name + one of the three codes). */
export function registrationApprovalErrorCode(err: unknown): RegistrationApprovalErrorCode | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const x = err as { name?: unknown; code?: unknown }
  if (x.name !== 'RegistrationApprovalError') return undefined
  return (APPROVAL_ERROR_CODES as readonly unknown[]).includes(x.code) ? (x.code as RegistrationApprovalErrorCode) : undefined
}

/** The engine's stale-close refusal (name + a string code such as `too-early`). */
export function isRegistrationStaleCloseError(err: unknown): err is { name: 'RegistrationStaleCloseError'; code: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'RegistrationStaleCloseError' &&
    typeof (err as { code?: unknown }).code === 'string'
  )
}

/**
 * 48-11 L-3: the requestId equality is mandatory. An officer legitimately has several pending
 * registration requests at once, and taking the first 'registrant' task would hand the officer a
 * DIFFERENT request's digest to sign.
 */
export function findRegistrantTask(tasks: readonly SignatureTask[], requestId: string): RegistrantSignatureTask | undefined {
  return tasks.find(
    (x) => x.signatureType === 'registrant' && (x as RegistrantSignatureTask).requestId === requestId,
  ) as RegistrantSignatureTask | undefined
}

/**
 * D-44: the request the duplicate callout showed, or null, never omitted (automatic closure would
 * close a request the officer was never shown). An unavailable duplicate check closes nothing.
 */
export function closesRequestIdOf(view: { duplicate?: LikelyDuplicateRequest; duplicateUnavailable: boolean }): string | null {
  return view.duplicateUnavailable ? null : (view.duplicate?.requestId ?? null)
}

/**
 * What the officer sees before deciding. Fields are set only when the corresponding read happened
 * (the screen's "set only when read" state semantics): `read` only when the request was found,
 * `priorRejections` only when that read resolved, `taskLookup` only when the pending-task lookup ran to
 * completion (so a caller keeps a previous task on a failed reload). `failure` holds the caught value
 * of the outer path (a `RegistrationApprovalError('not-found')`, or the identical engine error) and
 * everything read before it stays in the view.
 */
export interface RegistrationApprovalView {
  read?: RegistrationRequestRead
  priorRejections?: PriorRejection[]
  priorRejectionsUnavailable: boolean
  priorRejectionsFailure?: unknown
  closure?: RegistrationDuplicateClosure
  closureUnavailable: boolean
  duplicate?: LikelyDuplicateRequest
  duplicateUnavailable: boolean
  taskLookup?: { task?: RegistrantSignatureTask }
  signingStatus: SigningStatus | null
  staleClose?: RegistrationStaleCloseAvailability
  failure?: unknown
  readMs: number
}

export interface LoadRegistrationApprovalInput {
  getEngine: GetEngine
  requestId: string
  /** Checked once, after the request read: a true value returns the view as it stands (the screen's unmount guard). */
  shouldStop?: () => boolean
  now?: () => number
}

/**
 * The screen's `load()`. Never throws. Read order: the request (undefined is `not-found`), the prior
 * rejections (D-06: a failure is surfaced and blocks Approve, because nothing rendered would read as
 * "no prior rejections"), the duplicate closure (D-44), the likely duplicates (only for a pending
 * request with no closure), and for a pending request the officer's own task (48-11 L-3), the signing
 * status (D-11, display only) and the stale-close availability.
 */
export async function loadRegistrationApproval(input: LoadRegistrationApprovalInput): Promise<RegistrationApprovalView> {
  const now = input.now ?? Date.now
  const startedAt = now()
  const view: RegistrationApprovalView = {
    priorRejectionsUnavailable: false,
    closureUnavailable: false,
    duplicateUnavailable: false,
    signingStatus: null,
    readMs: 0,
  }
  try {
    const reg = await input.getEngine<IRegistrationEngine>('registration')
    const r = await reg.getRegistrationRequest(input.requestId)
    if (r === undefined) {
      // Coded, so a caller shows catalog copy and never an id.
      throw new RegistrationApprovalError('not-found')
    }
    view.read = r
    if (input.shouldStop?.() === true) {
      view.readMs = now() - startedAt
      return view
    }

    try {
      view.priorRejections = await reg.getPriorRejections(r.requesterKey, r.requestId)
    } catch (err) {
      // L-3: refusing under uncertainty is safe; approving under it is not.
      view.priorRejectionsUnavailable = true
      view.priorRejectionsFailure = err
    }

    // D-44: the closure state first. A request already closed (or closing) as a duplicate is never
    // decided, and needs no candidate callout.
    let closed: RegistrationDuplicateClosure | undefined
    try {
      closed = await reg.getDuplicateClosure(input.requestId)
      view.closure = closed
    } catch {
      view.closureUnavailable = true
    }

    if (r.status === 'p' && closed === undefined) {
      try {
        const likely = await reg.getLikelyDuplicateRequests(input.requestId)
        view.duplicate = likely[0]
      } catch {
        // L-3 mirror: the engine message is never shown, and Approve is blocked.
        view.duplicateUnavailable = true
      }
    }

    if (r.status === 'p') {
      const tasksEngine = await input.getEngine<ISignatureTasksEngine>('signatureTasksEngine')
      const tasks = await tasksEngine.getRequestedSignatures(true)
      view.taskLookup = { task: findRegistrantTask(tasks, input.requestId) }
      // D-11: display-only; a failed read is simply no note.
      try {
        view.signingStatus = await tasksEngine.getRegistrantSigningStatus(input.requestId)
      } catch {
        view.signingStatus = null
      }
      try {
        view.staleClose = await reg.getStaleCloseAvailability(input.requestId)
      } catch {
        view.staleClose = undefined
      }
    }
  } catch (err) {
    view.failure = err
  }
  view.readMs = now() - startedAt
  return view
}

export type ApproveBlocker =
  | 'not-pending'
  | 'prior-rejections-unavailable'
  | 'duplicate-check-unavailable'
  | 'closure-check-unavailable'
  | 'closed-as-duplicate'
  | 'no-task'
  | 'content-unreadable'

export type RefuseBlocker = 'not-pending' | 'closed-as-duplicate' | 'no-task-above-threshold' | 'content-unreadable'

export interface RegistrationDecisionBlockers {
  approve: ApproveBlocker[]
  refuse: RefuseBlocker[]
  thresholdAboveOne: boolean
  unreachable: boolean
  closedAsDuplicate: boolean
  contentReadable: boolean
  rejectableUnread: boolean
}

/** The data terms the blockers derive from (a loaded view, or a screen's state assembled into one). */
export type RegistrationDecisionInputs = Pick<
  RegistrationApprovalView,
  'read' | 'priorRejectionsUnavailable' | 'closure' | 'closureUnavailable' | 'duplicateUnavailable' | 'taskLookup' | 'signingStatus'
>

/**
 * The data-derived terms of the screen's Approve and Reject `disabled` expressions (D-44 / D-11 /
 * D-49), without the UI-only terms (the checklist gate, the officer's scope, an in-flight submit).
 * A non-empty list is a refusal for the CLI, so it can never approve what the screen would not let
 * an officer approve. An officer cannot refuse a request they cannot see, but may refuse content that
 * fails its signed digest: refusing under uncertainty is the safe direction.
 */
export function registrationDecisionBlockers(view: RegistrationDecisionInputs): RegistrationDecisionBlockers {
  const pending = view.read?.status === 'p'
  const thresholdAboveOne = (view.signingStatus?.threshold ?? 1) > 1
  const unreachable = pending && view.signingStatus?.unreachable === true && view.signingStatus.reached === false
  const closedAsDuplicate = view.closure !== undefined
  const contentReadable = registrationContentUnreadKey(view.read?.payloadAccess) === undefined
  const rejectableUnread = view.read?.payloadAccess === 'tampered'
  const task = view.taskLookup?.task

  const approve: ApproveBlocker[] = []
  if (!pending) approve.push('not-pending')
  if (view.priorRejectionsUnavailable) approve.push('prior-rejections-unavailable')
  if (view.duplicateUnavailable) approve.push('duplicate-check-unavailable')
  if (view.closureUnavailable) approve.push('closure-check-unavailable')
  if (closedAsDuplicate) approve.push('closed-as-duplicate')
  if (!task) approve.push('no-task')
  if (!contentReadable) approve.push('content-unreadable')

  const refuse: RefuseBlocker[] = []
  if (!pending) refuse.push('not-pending')
  if (closedAsDuplicate) refuse.push('closed-as-duplicate')
  if (thresholdAboveOne && !task) refuse.push('no-task-above-threshold')
  if (!contentReadable && !rejectableUnread) refuse.push('content-unreadable')

  return { approve, refuse, thresholdAboveOne, unreachable, closedAsDuplicate, contentReadable, rejectableUnread }
}

const identityTrack: DecisionTrack = (fn) => fn()

/** Builds `{ step, atMs }` and swallows anything the observer throws: an observer can never alter a decision. */
function emit(onStep: RegistrationDecisionStepObserver | undefined, step: RegistrationDecisionStepName, now: () => number): void {
  if (onStep === undefined) return
  try {
    onStep({ step, atMs: now() })
  } catch {
    // an observer never alters a decision
  }
}

/** The blank triple, byte-identical to the app's reject paths: no `sign` field, no `decision` field. */
function blankCompletion(): { isAccepted: false; signature: { signature: ''; signerKey: ''; signerUserId: '' } } {
  return { isAccepted: false, signature: { signature: '', signerKey: '', signerUserId: '' } }
}

export interface ApproveRegistrationRequestInput {
  getEngine: GetEngine
  requestId: string
  task: RegistrantSignatureTask | undefined
  checklist: RegistrationVerificationChecklistItem[]
  resolveSign: SignResolver
  review: PeerReviewDeps
  closesRequestId: string | null
  track?: DecisionTrack
  onStep?: RegistrationDecisionStepObserver
  now?: () => number
}

export interface ApproveRegistrationRequestResult {
  published: PublishAfterDecideOutcome
  timings: { decideMs: number; publishMs: number }
}

/**
 * The accept ceremony (D-07). Gate, then digest, then signature, then completion, then publish; nothing
 * before the gate. The engine is authoritative for the digest (the caller never recomputes one).
 * `decideMs` spans the engine read through the completion, `publishMs` the publish tail.
 */
export async function approveRegistrationRequest(input: ApproveRegistrationRequestInput): Promise<ApproveRegistrationRequestResult> {
  // WR-02 / WR-19: the gate is evaluated against the array actually bound into `decision.checklist`
  // below, so the value gated and the value signed cannot diverge.
  if (!isChecklistGateMet(input.checklist)) {
    throw new RegistrationApprovalError('checklist-incomplete')
  }
  if (!input.task) {
    throw new RegistrationApprovalError('no-task')
  }
  const task = input.task
  const now = input.now ?? Date.now
  const track = input.track ?? identityTrack
  emit(input.onStep, 'gate-checked', now)

  const decideStartedAt = now()
  const engine = await input.getEngine<ISignatureTasksEngine>('signatureTasksEngine')
  const digest = await engine.getSignatureDigest(task)
  emit(input.onStep, 'digest-read', now)
  const sign = await input.resolveSign()
  const signature = await sign(digest)
  emit(input.onStep, 'signed', now)
  // 48-11 L-2: `sign` UNCONDITIONALLY, `decision.checklist` the SAME array instance; no placeholder.
  await track(() =>
    engine.completeSignature(task, {
      isAccepted: true,
      signature,
      sign,
      decision: { checklist: input.checklist },
    }),
  )
  const decideMs = now() - decideStartedAt
  emit(input.onStep, 'completed', now)

  // D-44: publish right after the decision resolves. Never throws, and a failure here is never
  // reported as a failed decision: the drain publishes it later.
  const publishStartedAt = now()
  const published = await track(() => publishRegistrationDecisionAfterDecide(input.review, input.requestId, input.closesRequestId))
  const publishMs = now() - publishStartedAt
  emit(input.onStep, 'published', now)
  return { published, timings: { decideMs, publishMs } }
}

export type RegistrationTaskCloseOutcome = 'closed' | 'failed' | 'skipped'

export interface RefuseRegistrationRequestInput {
  getEngine: GetEngine
  requestId: string
  task: RegistrantSignatureTask | undefined
  checklist: RegistrationVerificationChecklistItem[]
  /** Arrives trimmed from the caller; never re-trimmed here. */
  reason: string
  resolveSign: SignResolver
  review: PeerReviewDeps
  closesRequestId: string | null
  track?: DecisionTrack
  onStep?: RegistrationDecisionStepObserver
  now?: () => number
}

export interface RefuseRegistrationRequestResult {
  published: PublishAfterDecideOutcome
  taskClose: RegistrationTaskCloseOutcome
}

/**
 * The refusal (D-12 / L-2 / WR-14). The gate first, so an ungated call spends no biometric prompt;
 * the signer goes only to the engine, which signs the rejection record; the task close is the blank
 * triple, isolated and swallowed; the publish never throws. This function never reads the signature
 * digest and never invokes the signer itself.
 */
export async function refuseRegistrationRequest(input: RefuseRegistrationRequestInput): Promise<RefuseRegistrationRequestResult> {
  // D-07 / WR-02: the engine refuses an ungated reject; this is the belt to those braces.
  if (!isChecklistGateMet(input.checklist)) {
    throw new RegistrationApprovalError('checklist-incomplete')
  }
  const now = input.now ?? Date.now
  const track = input.track ?? identityTrack
  emit(input.onStep, 'gate-checked', now)

  const reg = await input.getEngine<IRegistrationEngine>('registration')
  const sign = await input.resolveSign()
  await track(() => reg.rejectRegistrationRequest(input.requestId, { checklist: input.checklist, rejectionReason: input.reason }, sign))
  emit(input.onStep, 'rejected', now)

  // WR-14: past this line the rejection IS RECORDED. The task close is a separate act: a failure
  // leaves a stale open task (cosmetic) and is never reported as a failed refusal.
  const taskClose = await closeTaskBlank(input.getEngine, input.task, input.onStep, now)

  // WR-14 (62-27): publishing is a third, separately failing act. It never throws.
  const published = await track(() => publishRegistrationDecisionAfterDecide(input.review, input.requestId, input.closesRequestId))
  emit(input.onStep, 'published', now)
  return { published, taskClose }
}

/** The swallowed blank-triple task close the refusal and the stale close share. */
async function closeTaskBlank(
  getEngine: GetEngine,
  task: RegistrantSignatureTask | undefined,
  onStep: RegistrationDecisionStepObserver | undefined,
  now: () => number,
): Promise<RegistrationTaskCloseOutcome> {
  if (!task) return 'skipped'
  try {
    const tasksEngine = await getEngine<ISignatureTasksEngine>('signatureTasksEngine')
    await tasksEngine.completeSignature(task, blankCompletion())
    emit(onStep, 'task-closed', now)
    return 'closed'
  } catch {
    // Deliberately swallowed: the decision is recorded; a stale open task is cosmetic.
    return 'failed'
  }
}

export interface RecordRegistrationRejectVoteInput {
  getEngine: GetEngine
  task: RegistrantSignatureTask | undefined
  onStep?: RegistrationDecisionStepObserver
  now?: () => number
}

/**
 * D-11: at a 'vrg' threshold above 1 a rejection is a RECORDED VOTE, not a veto. The officer's own task
 * is completed with the blank triple: no `sign`, no `decision`, no signer at all, no reason. Not
 * tracked (it is not a decision write).
 */
export async function recordRegistrationRejectVote(input: RecordRegistrationRejectVoteInput): Promise<void> {
  if (!input.task) {
    throw new RegistrationApprovalError('no-task')
  }
  const now = input.now ?? Date.now
  const engine = await input.getEngine<ISignatureTasksEngine>('signatureTasksEngine')
  await engine.completeSignature(input.task, blankCompletion())
  emit(input.onStep, 'vote-recorded', now)
}

export interface CloseRegistrationRequestAsStaleInput {
  getEngine: GetEngine
  requestId: string
  task: RegistrantSignatureTask | undefined
  reason: string
  resolveSign: SignResolver
  review: PeerReviewDeps
  track?: DecisionTrack
  onStep?: RegistrationDecisionStepObserver
  now?: () => number
}

/**
 * Close as Rejected (stale close): one officer closes a request whose co-signers did not decide in
 * time. The engine re-checks the timeout and the officer's 'vrg' scope and records the checklist
 * 'none'. The decision is then published (with no duplicate closure) so the requester is told; as with
 * the refusal, a failed task close or publish is never reported as a failed close.
 */
export async function closeRegistrationRequestAsStale(input: CloseRegistrationRequestAsStaleInput): Promise<RefuseRegistrationRequestResult> {
  const now = input.now ?? Date.now
  const track = input.track ?? identityTrack
  const reg = await input.getEngine<IRegistrationEngine>('registration')
  const sign = await input.resolveSign()
  await track(() => reg.closeStaleRegistrationRequest(input.requestId, { rejectionReason: input.reason }, sign))
  emit(input.onStep, 'closed-stale', now)
  const taskClose = await closeTaskBlank(input.getEngine, input.task, input.onStep, now)
  const published = await track(() => publishRegistrationDecisionAfterDecide(input.review, input.requestId, null))
  emit(input.onStep, 'published', now)
  return { published, taskClose }
}
