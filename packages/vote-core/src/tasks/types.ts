import type { ReleaseKeyTask, SignatureTask, SignatureResult } from './models'
import type { IBuilder } from '../common/builder.js'

export interface IOnboardingTasksEngine {
  getCompletedOnboardingTasks(): Promise<string[]>
  setOnboardingTaskCompleted(taskId: string): Promise<void>
  buildSetOnboardingTaskCompleted(): IOnboardingTasksSetOnboardingTaskCompletedBuilder
}

export interface IKeysTasksEngine {
  completeKeyRelease(
    task: ReleaseKeyTask
  // keyShares: FinalShareData
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
