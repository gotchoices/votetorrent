import type { EngineContext } from '../types.js'
import type { Scope } from '@votetorrent/vote-core'
import { listCurrentScopeHolders, readSessionThreshold, computeSigningStatus } from './threshold.js'

/**
 * 62-07 (D-08, D-09, D-12): the ONE shared fan-out helper used by every scope with a Task path
 * (`ceb` ballot co-signing, `vrg` registrant decisions, `rad` admin proposals — 62-11/62-13 wire
 * the call sites).
 *
 * Invariants a caller MUST honor (not enforced beyond what's listed in the Validation section
 * below):
 *  - D-09: siblings STAY OPEN once the threshold is reached. This helper never updates, completes
 *    or deletes a Task — the structure gate in threshold-fanout.spec.ts enforces that mechanically.
 *  - Callers MUST invoke this helper BEFORE any AdminSignature exists for `spec.nonce` (the
 *    `'already-reached'` refusal below also catches a caller that gets this wrong). For `rad`/`ceb`
 *    that means calling it AFTER the initiator's own below-threshold signature has been recorded
 *    (the initiator is excluded from the recipient set, D-08 "recorded at proposal time"). For
 *    `vrg` it means calling it at SEED time, with `initiatorUserId: null` so every current holder
 *    — including whichever officer eventually reviews the request — becomes a recipient (A5).
 *  - Officers promoted into the scope AFTER fan-out runs get no Task for this nonce (D-08:
 *    "every CURRENT scope-holder" is evaluated once, at fan-out time, not continuously).
 *  - Withdraw (62-11) must delete every sibling Task for the nonce itself — this helper has no
 *    withdraw/cleanup half.
 *
 * The helper NEVER signs on the initiator's behalf (D-08: "the initiator's signature is recorded
 * at proposal time" is the CALLER's job, via SigningEngine.sign()/signWithOutcome(), not this
 * helper's). It never logs bound values — user ids and nonces are security-relevant (T-62-07-08).
 */

export type FanOutSignatureType = 'ballot' | 'registrant' | 'admin'

export const SIGNATURE_TYPE_SCOPE: Readonly<Record<FanOutSignatureType, Scope>> = Object.freeze({
  ballot: 'ceb',
  registrant: 'vrg',
  admin: 'rad',
})

export interface FanOutSpec {
  authorityId: string
  /** Must equal SIGNATURE_TYPE_SCOPE[signatureType] AND the nonce's own AdminSigning.Scope. */
  scope: Scope
  /** An EXISTING AdminSigning.Nonce with no AdminSignature yet. */
  nonce: string
  /** Excluded from recipients. `null` = system-seeded; fans out to EVERY current holder (A5). */
  initiatorUserId: string | null
  signatureType: FanOutSignatureType
  /** Bound as the Task insert's context Tid. */
  taskTid: number
  /** Caller's own per-scope extension insert, using its own extension Tid. */
  insertExtension: (taskId: string, recipientUserId: string) => Promise<void>
}

export interface FanOutOptions {
  /** Default true. Pass false inside a caller's own open BEGIN. */
  ownsTransaction?: boolean
}

export interface FanOutResult {
  nonce: string
  taskIds: string[]
  recipientUserIds: string[]
  threshold: number
  eligibleHolderCount: number
}

export type FanOutErrorReason = 'session-not-found' | 'session-mismatch' | 'already-reached' | 'unreachable-at-birth'

export class FanOutError extends Error {
  readonly reason: FanOutErrorReason

  constructor (reason: FanOutErrorReason, message?: string) {
    super(message ?? `FanOutError: ${reason}`)
    this.name = 'FanOutError'
    this.reason = reason
  }
}

/**
 * Atomically create one open sibling Task (+ caller-supplied extension row) per current
 * scope-holder except `spec.initiatorUserId`, for an EXISTING, not-yet-reached AdminSigning
 * session. D-12: this is the ONLY place any scope's fan-out logic lives.
 */
export async function fanOutSignatureTasks (
  ctx: EngineContext,
  spec: FanOutSpec,
  options?: FanOutOptions
): Promise<FanOutResult> {
  const db = ctx.db

  // a) Validation — ALL before any write.
  const sessionRow = await db
    .prepare('select Scope, AuthorityId from AdminSigning where Nonce = :nonce')
    .get({ nonce: spec.nonce })
  if (!sessionRow) {
    throw new FanOutError('session-not-found', `fanOutSignatureTasks: no AdminSigning for nonce ${spec.nonce}`)
  }
  const sessionScope = sessionRow.Scope as Scope
  const sessionAuthorityId = sessionRow.AuthorityId as string

  if (
    spec.scope !== SIGNATURE_TYPE_SCOPE[spec.signatureType] ||
    spec.scope !== sessionScope ||
    spec.authorityId !== sessionAuthorityId
  ) {
    throw new FanOutError(
      'session-mismatch',
      `fanOutSignatureTasks: scope/authority mismatch for nonce ${spec.nonce} (signatureType=${spec.signatureType}, spec.scope=${spec.scope}, session.scope=${sessionScope})`
    )
  }

  // The extension CHECK would refuse this anyway (BallotSignatureTaskExtension.MutationValid /
  // RegistrantSignatureTaskExtension.MutationValid's "no uncompleted tasks once AdminSignature
  // exists" clause) — this gives a typed error up front instead of a CHECK failure mid-fan-out.
  const existingAdminSignature = await db
    .prepare('select 1 as x from AdminSignature where SigningNonce = :nonce')
    .get({ nonce: spec.nonce })
  if (existingAdminSignature) {
    throw new FanOutError('already-reached', `fanOutSignatureTasks: nonce ${spec.nonce} already has an AdminSignature`)
  }

  // b) Compute recipients and check reachability BEFORE any write.
  const holders = await listCurrentScopeHolders(db, spec.authorityId, spec.scope)
  const recipients = holders.filter(userId => userId !== spec.initiatorUserId).sort()
  const threshold = await readSessionThreshold(db, spec.nonce, spec.scope)
  const initiatorCanApprove = spec.initiatorUserId != null && holders.includes(spec.initiatorUserId)
  const possibleApprovals = recipients.length + (initiatorCanApprove ? 1 : 0)
  if (threshold > possibleApprovals) {
    throw new FanOutError(
      'unreachable-at-birth',
      `fanOutSignatureTasks: threshold ${threshold} exceeds possible approvals ${possibleApprovals} for nonce ${spec.nonce}`
    )
  }

  const ownsTransaction = options?.ownsTransaction ?? true
  if (ownsTransaction) await db.exec('BEGIN')

  const taskIds: string[] = []
  try {
    // d) One open Task + caller extension per recipient, in order.
    for (const recipientUserId of recipients) {
      const taskId = crypto.randomUUID()
      await db.exec(
        `insert into Task (Id, UserId, Type, SignatureType, SigningNonce, IsCompleted)
         with context IsMutationValid = true, Tid = :tid
         values (:id, :userId, 'signature', :signatureType, :nonce, 0)`,
        {
          id: taskId,
          userId: recipientUserId,
          signatureType: spec.signatureType,
          nonce: spec.nonce,
          tid: spec.taskTid,
        }
      )
      await spec.insertExtension(taskId, recipientUserId)
      // 57-07 workaround: drain the deferred-CHECK queue after EVERY pair, regardless of what
      // the batched-no-flush probe (P0/A11) showed — never rely on a batched evaluation.
      await db.runDeferredRowConstraints()
      taskIds.push(taskId)
    }

    if (ownsTransaction) await db.exec('COMMIT')
  } catch (err) {
    if (ownsTransaction) {
      try {
        await db.exec('ROLLBACK')
      } catch {
        // CR-04 shape: one bounded, autocommit-guarded recovery attempt. Either way, the
        // ORIGINAL error is what the caller needs to see — never substitute a rollback error.
        try {
          if (!db.getAutocommit()) {
            await db.exec('ROLLBACK')
          }
        } catch {
          // Swallowed — the handle's transaction state is reported truthfully by
          // db.getAutocommit() to any caller that checks it; this helper does not pretend.
        }
      }
    }
    throw err
  }

  return {
    nonce: spec.nonce,
    taskIds,
    recipientUserIds: recipients,
    threshold,
    eligibleHolderCount: holders.length,
  }
}

export { listCurrentScopeHolders, computeSigningStatus } from './threshold.js'
