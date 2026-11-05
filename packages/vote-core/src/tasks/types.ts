import type { ReleaseKeyTask, SignatureTask, SignatureResult } from './models'
import type { IBuilder } from '../common/builder.js'
import type { KeyholderDkgSigner } from '../keyholder/models.js'
import type { SigningStatus } from '../signing/models.js'

export interface IOnboardingTasksEngine {
  getCompletedOnboardingTasks(): Promise<string[]>
  setOnboardingTaskCompleted(taskId: string): Promise<void>
  buildSetOnboardingTaskCompleted(): IOnboardingTasksSetOnboardingTaskCompletedBuilder
}

export interface IKeysTasksEngine {
  /**
   * 62-20 (D-17, D-20): completing a release-key Task ALWAYS means a
   * publicly published share. `signer` is optional only so
   * `MockKeysTasksEngine` and `CompleteKeyReleaseBuilder` (whose
   * `IBuilder<ReleaseKeyTask, void>` surface carries no signer slot) still
   * compile — the REAL engine (`KeysTasksEngine`) refuses with
   * `KeyReleaseError('signer-required')` when `signer` is absent, writes no
   * row, and leaves the Task incomplete.
   */
  completeKeyRelease(
    task: ReleaseKeyTask,
    signer?: KeyholderDkgSigner
  ): Promise<void>
  getKeysToRelease(pending: boolean): Promise<ReleaseKeyTask[]>
  buildCompleteKeyRelease(): IKeysTasksCompleteKeyReleaseBuilder
}

export interface ISignatureTasksEngine {
  completeSignature(
    task: SignatureTask,
    result: SignatureResult
  ): Promise<void>
  getRequestedSignatures(pending: boolean): Promise<SignatureTask[]>
  buildCompleteSignature(): ISignatureTasksCompleteSignatureBuilder
  /**
   * D-03 — Return the engine-authoritative digest bytes for the pending task.
   *
   * Looks up the `AdminSigning.Digest` (base64url sha256) for the task's
   * `SigningNonce` and returns the decoded bytes. The screen passes these bytes
   * to the device-signer callback and never recomputes the canonical form itself.
   *
   * Throws a descriptive error when no pending task or no AdminSigning row exists.
   */
  getSignatureDigest(task: SignatureTask): Promise<Uint8Array>

  /**
   * Surface 5 (62-12, D-09/D-10/D-11) — read-only co-signing status for the session behind the
   * caller's OWN PENDING task. Locates the session through exactly the same lookup
   * `getSignatureDigest` uses (ballot scoped by `ballot.proposed.id`, registrant scoped by
   * `requestId`, else the single-pending-task-of-type form), then returns 62-07's
   * `SigningStatus` for that nonce verbatim.
   *
   * Returns `null` when the task has no pending row, when the engine has no context, or when
   * the resolved nonce has no `AdminSigning` session — never throws for those cases.
   *
   * Writes nothing and seeds nothing. Display-only: the returned status is NEVER an
   * authorization input — `completeSignature` and the schema's own CHECK constraints remain the
   * sole enforcement of who may sign and when a session is satisfied.
   */
  getTaskSigningStatus(task: SignatureTask): Promise<SigningStatus | null>

  /**
   * 62-27 (D-11 vrg) — read-only co-signing status for the vrg session behind a REGISTRATION
   * REQUEST, whatever the caller's own task state. `getTaskSigningStatus` returns null once the
   * caller's own task has completed, which would hide the progress from an officer who has
   * already voted; this reads the session through the request's registrant Task rows instead.
   *
   * Display-only and read-only: never an authorization input. Returns `null` when the request
   * has no registrant Task rows, when those rows disagree on their signing nonce (an ambiguous
   * session is never guessed), when the session has no `AdminSigning` row, or when the engine
   * has no context. Never throws for those cases.
   */
  getRegistrantSigningStatus(requestId: string): Promise<SigningStatus | null>
}

export interface IOnboardingTasksSetOnboardingTaskCompletedBuilder extends IBuilder<string, void> {
  fromPayload(payload: string): this
}

export interface IKeysTasksCompleteKeyReleaseBuilder extends IBuilder<ReleaseKeyTask, void> {
  fromPayload(payload: ReleaseKeyTask): this
}

export interface ISignatureTasksCompleteSignatureBuilder extends IBuilder<{ task: SignatureTask; result: SignatureResult }, void> {
  fromPayload(payload: { task: SignatureTask; result: SignatureResult }): this
}
