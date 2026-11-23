// src/association/association-review.ts — co-signed association decisions above a 'vrg'
// threshold of 1 (schema version 2's AssociationSignatureTaskExtension).
//
// An officer's decision on a pending AssociationRequest (approve as a registrant, or reject) is a
// REVIEW: the initiator signs a 'vrg' session over
//   Digest(ReviewTid, 'AssociationReview', request Id, AuthorityId, DeviceKey, RegistrantId, Decision)
// and every other current 'vrg' holder gets an 'association' signature Task through the shared
// fan-out. Nothing is written to the request until the session reaches the threshold. Then the
// sync driver carries the decision out with an engine bound to the reached session
// (`ReassociationHost.withVrgHeader`), so every 'vrg' write it makes (the challenge, the request's
// transitions, the Association rows) derives from that session (signDerived) and no single officer
// can make them alone. A rejection vote on a co-signer's Task is a vote, never a veto.

import type { Database, SqlValue } from '@quereus/quereus'
import type { Scope, Signature } from '@votetorrent/vote-core'
import type { EngineContext } from '../types.js'
import { allocateTid } from '../database/tid-allocator.js'
import { seedSignedMutation } from '../signing/signed-mutation.js'
import { fanOutSignatureTasks } from '../signing/fan-out.js'
import { computeSigningStatus } from '../signing/threshold.js'

export type AssociationReviewDecision = 'a' | 'r'

export interface AssociationReviewSession {
  readonly nonce: string
  readonly requestId: string
  readonly decision: AssociationReviewDecision
  readonly registrantId?: string
  readonly reviewTid: number
  readonly threshold: number
  readonly signatures: number
  readonly reached: boolean
  readonly unreachable: boolean
}

const REVIEW_DIGEST = "select Digest(:reviewTid, 'AssociationReview', :requestId, :rowAuthorityId, :deviceKey, :registrantId, :decision) as d"

/** Every review session opened for `requestId` (one per decision proposed), oldest first by nonce. */
export async function listAssociationReviews (db: Database, requestId: string): Promise<AssociationReviewSession[]> {
  const found = new Map<string, { decision: AssociationReviewDecision, registrantId?: string, reviewTid: number }>()
  for await (const row of db.eval(
    `select T.SigningNonce as Nonce, E.Decision as Decision, E.RegistrantId as RegistrantId, E.ReviewTid as ReviewTid
       from AssociationSignatureTaskExtension E join Task T on T.Id = E.TaskId
      where E.RequestId = :requestId`,
    { requestId } as Record<string, SqlValue>
  )) {
    const nonce = String(row.Nonce)
    if (found.has(nonce)) continue
    found.set(nonce, {
      decision: row.Decision === 'a' ? 'a' : 'r',
      registrantId: row.RegistrantId == null ? undefined : String(row.RegistrantId),
      reviewTid: Number(row.ReviewTid)
    })
  }
  const out: AssociationReviewSession[] = []
  for (const [nonce, v] of [...found.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const status = await computeSigningStatus(db, nonce)
    out.push({
      nonce,
      requestId,
      decision: v.decision,
      ...(v.registrantId !== undefined ? { registrantId: v.registrantId } : {}),
      reviewTid: v.reviewTid,
      threshold: status?.threshold ?? 1,
      signatures: status?.signatures ?? 0,
      reached: status?.reached ?? false,
      unreachable: status?.unreachable ?? false
    })
  }
  return out
}

/** The review that is reached, if any; else the one still open; never an unreachable one. */
export function liveReview (reviews: readonly AssociationReviewSession[]): AssociationReviewSession | undefined {
  return reviews.find((r) => r.reached) ?? reviews.find((r) => !r.unreachable)
}

export function reachedReview (reviews: readonly AssociationReviewSession[]): AssociationReviewSession | undefined {
  return reviews.find((r) => r.reached)
}

/**
 * Opens a review for `row`: the initiator's signed session plus one 'association' Task (with its
 * extension row) per other current 'vrg' holder, in one transaction. Returns the session nonce.
 */
export async function openAssociationReview (
  ctx: EngineContext,
  row: { readonly id: string, readonly authorityId: string, readonly deviceKey: string },
  decision: AssociationReviewDecision,
  registrantId: string | null,
  sign: (digest: Uint8Array) => Promise<Signature>
): Promise<string> {
  const db = ctx.db
  const reviewTid = await allocateTid(db, 'registration-request')
  const params = { reviewTid, requestId: row.id, rowAuthorityId: row.authorityId, deviceKey: row.deviceKey, registrantId, decision }
  await db.exec('BEGIN')
  try {
    const nonce = await seedSignedMutation(ctx, row.authorityId, 'vrg' as Scope, reviewTid, REVIEW_DIGEST, params, sign, { ownsTransaction: false })
    await fanOutSignatureTasks(ctx, {
      authorityId: row.authorityId,
      scope: 'vrg' as Scope,
      nonce,
      initiatorUserId: ctx.user?.id ?? null,
      signatureType: 'association',
      taskTid: reviewTid,
      insertExtension: async (taskId: string) => {
        await db.exec(
          `insert into AssociationSignatureTaskExtension (TaskId, RequestId, RegistrantId, Decision, ReviewTid)
           with context Tid = ${reviewTid}
           values (:taskId, :requestId, :registrantId, :decision, :reviewTid)`,
          { taskId, requestId: row.id, registrantId, decision, reviewTid }
        )
      }
    }, { ownsTransaction: false })
    await db.exec('COMMIT')
    return nonce
  } catch (err) {
    try {
      await db.exec('ROLLBACK')
    } catch {
      // The original error is what the caller needs.
    }
    throw err
  }
}
