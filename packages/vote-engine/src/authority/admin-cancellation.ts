// authority/admin-cancellation.ts — cancel one administration change that has not taken effect yet (D-05).
//
// Role:
//   - `insertAdminCancellation`: a current officer who holds 'rad' signs "cancel the change at <time>" and writes
//     ONE AdminCancellation (AuthorityId, AdminEffectiveAt, UserId) row. That row stops that one change: it never
//     becomes the current administration anywhere (the CurrentAdmin view, the schema CHECKs and the pairing test all
//     skip a cancelled generation). The schema accepts the row only when the signature comes from a live key of a
//     current 'rad' officer and the change still lies in the future, and the row can never be updated or deleted.
//   - `adminCancelDigest`: the digest pre-image, Digest('vt-admin-cancel', AuthorityId, AdminEffectiveAt, UserId),
//     evaluated by the database so it always equals what the schema checks.
//
// Rules:
//   - One signature is enough, whatever threshold approved the change: one sign() call, one biometric prompt.
//   - Idempotent. An existing row for the change means success, and the officer is not prompted again.
//   - Refuses BEFORE signing whenever the facts are knowable then (bad input, no such pending change, caller not a
//     current 'rad' officer or without a live key), so those refusals never cost a prompt.
//   - The signer's identity and key are checked AFTER the prompt, because the key is only known then.
//   - No transaction is held across sign() (same rule as pairing-revocation.ts and tally-publication.ts).
//   - Errors carry a closed `code` from ADMIN_CHANGE_ERROR_CODES and a fixed message, never SQL, a row value or
//     Quereus text. A database error that is not a schema refusal is rethrown unchanged.
//   - Browser-safe: no `node:` import, no byte-buffer class, no console.

import type { Database } from '@quereus/quereus'
import type { Signature } from '@votetorrent/vote-core'
import { ADMIN_CHANGE_ERROR_CODES } from '@votetorrent/vote-core'
import type { EngineContext } from '../types.js'
import { digestToBytes, nowCanonicalDatetime, toCanonicalDatetime } from '../utils.js'
import { listCurrentScopeHolders } from '../signing/threshold.js'

/** The text that opens the cancellation digest. The schema spells the same text in both curve branches. */
export const ADMIN_CANCEL_DIGEST_TAG = 'vt-admin-cancel'

type CancelCode =
  | typeof ADMIN_CHANGE_ERROR_CODES.cancelNotPending
  | typeof ADMIN_CHANGE_ERROR_CODES.cancelNotAuthorized
  | typeof ADMIN_CHANGE_ERROR_CODES.cancelRefused

const MESSAGES: Record<CancelCode, string> = {
  [ADMIN_CHANGE_ERROR_CODES.cancelNotPending]: 'There is no pending administration change at that time',
  [ADMIN_CHANGE_ERROR_CODES.cancelNotAuthorized]: 'Only a current officer who can revise the administration can cancel this change',
  [ADMIN_CHANGE_ERROR_CODES.cancelRefused]: 'The administration change could not be cancelled'
}

const CANONICAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/

function coded (code: CancelCode): Error & { code: CancelCode } {
  return Object.assign(new Error(MESSAGES[code]), { code })
}

// 66.1-04 shipped AdminEffectiveAt as `text` (66.1-01 A1 = PASS), so the digest takes the canonical 19-char string
// itself, with no zone suffix.
function digestEffectiveAtForm (canonical: string): string {
  return canonical
}

/** The bytes the officer signs to cancel the change at `effectiveAt` (canonical 19-char UTC, no Z). */
export async function adminCancelDigest (
  db: Database,
  args: { authorityId: string, effectiveAt: string, userId: string }
): Promise<Uint8Array> {
  const row = await db
    .prepare('select Digest(:cancelTag, :authorityId, :effectiveAtForm, :userId) as d')
    .get({
      cancelTag: ADMIN_CANCEL_DIGEST_TAG,
      authorityId: args.authorityId,
      effectiveAtForm: digestEffectiveAtForm(args.effectiveAt),
      userId: args.userId
    })
  if (row == null || row.d == null) {
    throw new Error('admin cancellation: Digest() returned null (crypto plugin not registered?)')
  }
  return digestToBytes(row.d)
}

async function isCancelled (db: Database, authorityId: string, effectiveAt: string): Promise<boolean> {
  const row = await db
    .prepare('select 1 as x from AdminCancellation where AuthorityId = :authorityId and AdminEffectiveAt = :effectiveAt')
    .get({ authorityId, effectiveAt })
  return row != null
}

/** True when an Admin row or a ProposedAdmin row exists at (authorityId, effectiveAt). Two point lookups. */
async function targetExists (db: Database, authorityId: string, effectiveAt: string): Promise<boolean> {
  const admin = await db
    .prepare('select 1 as x from Admin where AuthorityId = :authorityId and EffectiveAt = :effectiveAt')
    .get({ authorityId, effectiveAt })
  if (admin != null) return true
  const proposed = await db
    .prepare('select 1 as x from ProposedAdmin where AuthorityId = :authorityId and EffectiveAt = :effectiveAt')
    .get({ authorityId, effectiveAt })
  return proposed != null
}

/** True when `userId` has a key that expires after `now` (and, when given, that key is `signerKey`). */
async function hasLiveKey (db: Database, userId: string, now: string, signerKey?: string): Promise<boolean> {
  const row = signerKey === undefined
    ? await db
      .prepare('select 1 as ok from UserKey where UserId = :userId and Expiration > :now')
      .get({ userId, now })
    : await db
      .prepare('select 1 as ok from UserKey where UserId = :userId and PubKey = :signerKey and Expiration > :now')
      .get({ userId, signerKey, now })
  return row != null
}

/**
 * Cancel the administration change at `effectiveAt` as `userId`, with one call to `sign`.
 * Resolves when the cancellation row exists (written now, or already there).
 */
export async function insertAdminCancellation (
  ctx: EngineContext,
  args: { authorityId: string, effectiveAt: string, userId: string, sign: (digest: Uint8Array) => Promise<Signature> }
): Promise<void> {
  const db = ctx.db
  const authorityId = args.authorityId
  const userId = args.userId

  // 1. Input shape.
  const effectiveAt = typeof args.effectiveAt === 'string' ? toCanonicalDatetime(args.effectiveAt) : ''
  if (typeof authorityId !== 'string' || authorityId === '' || !CANONICAL_RE.test(effectiveAt)) {
    throw coded(ADMIN_CHANGE_ERROR_CODES.cancelNotPending)
  }
  if (typeof userId !== 'string' || userId === '') throw coded(ADMIN_CHANGE_ERROR_CODES.cancelNotAuthorized)

  // 2. Already cancelled: success, no prompt.
  if (await isCancelled(db, authorityId, effectiveAt)) return

  // 3. The change must exist and still lie in the future.
  const now = nowCanonicalDatetime()
  if (effectiveAt <= now || !(await targetExists(db, authorityId, effectiveAt))) {
    throw coded(ADMIN_CHANGE_ERROR_CODES.cancelNotPending)
  }

  // 4. The caller must be a current 'rad' officer with a live key.
  const radHolders = await listCurrentScopeHolders(db, authorityId, 'rad')
  if (!radHolders.includes(userId) || !(await hasLiveKey(db, userId, now))) {
    throw coded(ADMIN_CHANGE_ERROR_CODES.cancelNotAuthorized)
  }

  // 5. The one prompt.
  const digest = await adminCancelDigest(db, { authorityId, effectiveAt, userId })
  const signature = await args.sign(digest)

  // 6. The signature must come from the cancelling user and one of its live keys. A fresh clock, so a slow prompt
  //    cannot push a stale time into the checks or the insert.
  const signedAt = nowCanonicalDatetime()
  if (
    signature == null ||
    signature.signerUserId !== userId ||
    typeof signature.signerKey !== 'string' ||
    !(await hasLiveKey(db, userId, signedAt, signature.signerKey))
  ) {
    throw coded(ADMIN_CHANGE_ERROR_CODES.cancelNotAuthorized)
  }

  // 7. Write the row.
  try {
    await db.exec(
      'insert into AdminCancellation (AuthorityId, AdminEffectiveAt, UserId) ' +
      'with context UserKey = :signerKey, Signature = :signature, now = :now ' +
      'values (:authorityId, :effectiveAt, :userId)',
      { authorityId, effectiveAt, userId, signerKey: signature.signerKey, signature: signature.signature, now: signedAt }
    )
  } catch (err) {
    // 8. Another device may have written the same cancellation meanwhile.
    if (await isCancelled(db, authorityId, effectiveAt)) return
    const message = err instanceof Error ? err.message : String(err)
    if (/\b(CancelSignatureValid|TargetPending|CancellerIsRadOfficer)\b/.test(message)) {
      throw coded(ADMIN_CHANGE_ERROR_CODES.cancelRefused)
    }
    throw err
  }
}
