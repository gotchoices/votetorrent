/**
 * signature-task.ts: sign or reject an officer signature task, and find a ballot's task.
 *
 * Extracted by phase 67 plan 10 from `apps/VoteTorrentAuthority/src/screens/tasks/SignatureTaskScreen.tsx`
 * `sign()` (lines 105-140, `signTask`) and `reject()` (lines 150-173, `rejectTask`);
 * `findBallotSignatureTask` is the task lookup the lean rig and the CLI do by hand
 * (`the retired lean rig's main driver:806`, `the retired JSON-RPC vote-cli's authority workflow:427`).
 *
 * Secrecy contract: nothing here logs. The signer arrives as a callback factory invoked exactly once per
 * `signTask`; `rejectTask` has NO signer parameter at all, so a rejection can never produce an officer
 * signature (D-12). No key crosses in.
 */
import type { BallotSignatureTask, ISignatureTasksEngine, SignatureTask } from '@votetorrent/vote-core'
import type { SignCallback } from '../platform/signer.js'

/**
 * Whether the accept path must pass the re-invocable signer along with the one pre-computed signature.
 *
 * 39-03 (DEBT-11, D-06): the signer is a plain in-memory closure over the already-unlocked device
 * private key, re-invocable with no additional user decision, so it doubles as the reusable per-digest
 * `sign` callback finalizeBallot uses to REAL-sign each promoted per-row Question/Option AdminSigning
 * digest. Only `ballot` signature tasks drive finalizeBallot (IN-02, 39-REVIEW).
 * 57-08 (Trigger B): `admin` tasks are the second consumer. A co-signer accepting a pending "Revise
 * Administration" task may complete the 'rad' threshold, and completeSignature's promotion attempt
 * (applyAdminProposal) mints two or three distinct digests, so it likewise needs the re-invocable closure
 * rather than the single pre-computed signature. `sign` stays absent for every OTHER signatureType.
 */
export function taskTakesReinvocableSigner(task: Pick<SignatureTask, 'signatureType'>): boolean {
  return task.signatureType === 'ballot' || task.signatureType === 'admin'
}

export interface SignTaskParams {
  tasksEngine: Pick<ISignatureTasksEngine, 'getSignatureDigest' | 'completeSignature'>
  task: SignatureTask
  /** Called exactly once, after the digest is read. */
  createSigner: () => Promise<SignCallback>
}

/**
 * SIGN-02 accept path (D-01/D-03/D-04): the engine-authoritative digest via getSignatureDigest (the
 * caller never recomputes it), the signer once, the digest signed, then completeSignature with the
 * resulting Signature and, for ballot/admin tasks, the re-invocable signer.
 */
export async function signTask(params: SignTaskParams): Promise<void> {
  const { tasksEngine, task, createSigner } = params
  const digest = await tasksEngine.getSignatureDigest(task)
  const signer = await createSigner()
  const signature = await signer(digest)
  await tasksEngine.completeSignature(task, {
    isAccepted: true,
    signature,
    sign: taskTakesReinvocableSigner(task) ? signer : undefined,
  })
}

export interface RejectTaskParams {
  tasksEngine: Pick<ISignatureTasksEngine, 'completeSignature'>
  task: SignatureTask
}

/**
 * SIGN-02 reject path (D-12, NO signing): the engine's `if (result.isAccepted)` branch skips signing, so
 * no OfficerSignature is inserted and the signing session is not advanced. Above threshold 1 this is a
 * RECORDED VOTE, not a veto (62-12 D-11): no second engine call.
 */
export async function rejectTask(params: RejectTaskParams): Promise<void> {
  await params.tasksEngine.completeSignature(params.task, {
    isAccepted: false,
    signature: { signature: '', signerKey: '', signerUserId: '' },
  })
}

/** The pending ballot task for `ballotId`, or `undefined` when none is requested. */
export function findBallotSignatureTask(
  tasks: readonly SignatureTask[],
  ballotId: string
): BallotSignatureTask | undefined {
  return tasks.find(
    (task): task is BallotSignatureTask =>
      task.signatureType === 'ballot' && (task as BallotSignatureTask).ballot?.proposed?.id === ballotId
  )
}
