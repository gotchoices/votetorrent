// pairing/pairing-revocation.ts — revoke one dashboard browser pairing as a signed, append-only row.
//
// Role:
//   - `revokeDashboardPairing`: an officer's phone signs "revoke pairing <nonce>" and writes ONE
//     DashboardPairingRevocation (UserId, Nonce) row. The schema accepts the row only when the signature comes
//     from a live key of that officer (InsertValid), and the row can never be updated or deleted.
//   - `isPairingRevoked`: a primary-key point lookup. It needs no crypto plugin, so the browser's local store
//     can run it to learn that its own pairing was revoked.
//   - `pairingRevokeDigest`: the digest pre-image, Digest('vt-pairing-revoke', UserId, Nonce), evaluated by the
//     database so it always equals what the schema checks.
//
// Rules:
//   - Idempotent. An existing row means success, and the signer is not prompted again.
//   - Refuses BEFORE signing when the signer is not the revoking user or its key is not a current key of that
//     user, so a refused attempt never costs the officer a biometric prompt.
//   - No transaction is held across sign() (same rule as tally-publication.ts and key-release-engine.ts).
//   - Errors carry a closed `reason` and a fixed message, never SQL, a row value or Quereus text. A database
//     error that is not a schema refusal is rethrown unchanged.
//   - Browser-safe: no `node:` import, no Buffer, no console.

import type { Database } from '@quereus/quereus'
import type { KeyholderDkgSigner } from '@votetorrent/vote-core'
import type { EngineContext } from '../types.js'
import { digestToBytes, nowCanonicalDatetime } from '../utils.js'

/** The text that opens the revocation digest. The schema spells the same text in both curve branches. */
export const PAIRING_REVOKE_DIGEST_TAG = 'vt-pairing-revoke'

/** The officer's signing identity: a user id, one of its UserKeys, and a signer over a digest. */
export type PairingRevocationSigner = KeyholderDkgSigner

export type PairingRevocationReason = 'signer-mismatch' | 'key-not-current' | 'refused'

const MESSAGES: Record<PairingRevocationReason, string> = {
  'signer-mismatch': 'pairing revocation: signer is not the revoking user',
  'key-not-current': 'pairing revocation: signer key is not a current key of the revoking user',
  refused: 'pairing revocation: the schema refused the revocation'
}

export class PairingRevocationError extends Error {
  readonly reason: PairingRevocationReason
  constructor (reason: PairingRevocationReason) {
    super(MESSAGES[reason])
    this.name = 'PairingRevocationError'
    this.reason = reason
  }
}

/** The bytes the officer signs for revoking pairing `nonce` of `userId`. */
export async function pairingRevokeDigest (db: Database, args: { userId: string, nonce: string }): Promise<Uint8Array> {
  const row = await db
    .prepare('select Digest(:revokeTag, :userId, :nonce) as d')
    .get({ revokeTag: PAIRING_REVOKE_DIGEST_TAG, userId: args.userId, nonce: args.nonce })
  if (row == null || row.d == null) {
    throw new Error('pairing revocation: Digest() returned null (crypto plugin not registered?)')
  }
  return digestToBytes(row.d)
}

/** True only for the exact (userId, nonce) pair. One primary-key equality lookup, no crypto. */
export async function isPairingRevoked (db: Database, args: { userId: string, nonce: string }): Promise<boolean> {
  const row = await db
    .prepare('select 1 as hit from DashboardPairingRevocation where UserId = :userId and Nonce = :nonce')
    .get({ userId: args.userId, nonce: args.nonce })
  return row != null
}

/** Write the signed revocation row. Resolves when the row exists (written now, or already there). */
export async function revokeDashboardPairing (
  engineCtx: EngineContext,
  args: { userId: string, nonce: string, signer: PairingRevocationSigner }
): Promise<void> {
  const { userId, nonce, signer } = args
  const db = engineCtx.db

  if (signer.userId !== userId) throw new PairingRevocationError('signer-mismatch')
  if (await isPairingRevoked(db, { userId, nonce })) return

  const now = nowCanonicalDatetime()
  const live = await db
    .prepare('select 1 as ok from UserKey where UserId = :userId and PubKey = :signerKey and Expiration > :now')
    .get({ userId, signerKey: signer.signingPublicKey, now })
  if (live == null) throw new PairingRevocationError('key-not-current')

  const digest = await pairingRevokeDigest(db, { userId, nonce })
  const signature = await signer.sign(digest)
  if (signature.signerKey !== signer.signingPublicKey) throw new PairingRevocationError('signer-mismatch')

  try {
    await db.exec(
      'insert into DashboardPairingRevocation (UserId, Nonce) ' +
      'with context UserKey = :signerKey, Signature = :signature, now = :now ' +
      'values (:userId, :nonce)',
      { userId, nonce, signerKey: signature.signerKey, signature: signature.signature, now }
    )
  } catch (err) {
    // Another device may have written the same revocation meanwhile.
    if (await isPairingRevoked(db, { userId, nonce })) return
    const message = err instanceof Error ? err.message : String(err)
    if (/\bInsertValid\b/.test(message)) throw new PairingRevocationError('refused')
    throw err
  }
}
