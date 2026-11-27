// src/intake/recipients.ts — Phase 62 Plan 14 (D-04, D-32)
//
// Every CURRENT officer's current, usable encryption key, read from
// replicated Officer/CurrentAdmin/UserEncryptionKey/UserKey rows through a
// read-only `IntakeQueryPort`. Zero recipients is reported, never silently
// dropped to a plaintext fallback — that hard-failure decision belongs to
// `createIntakeSealer` (sealing.ts), which calls this module on every seal.
//
// PK-prefix point lookups only (the LevelDB vtab rule): `Officer`/`CurrentAdmin`
// are scanned once per authority (a real index-shaped join), and every
// `UserEncryptionKey`/`UserKey` lookup below is scoped `where UserId = :userId`.

import { ENCRYPTION_KEY_ALG, isValidEncryptionPublicKey } from '../crypto/index.js'
import type { EnvelopeRecipient } from '../crypto/index.js'
import { IntakeError } from './types.js'
import type { IntakeRecipientDroppedKey, IntakeRecipientSet } from './types.js'
import type { IntakeQueryPort } from './query-port.js'

interface UserEncryptionKeyRow {
  readonly PubKey: string
  readonly Alg: string
  readonly RegisteredAt: string
  readonly SignerKey: string
}

/** A `UserEncryptionKey` row that passed the Alg/public-key/signer-presence filters. */
export interface CandidateEncryptionKey {
  readonly userId: string
  readonly publicKey: string
  readonly registeredAt: string
  readonly signerKey: string
}

/**
 * Read `userId`'s `UserEncryptionKey` rows and keep only the usable ones:
 * matching `ENCRYPTION_KEY_ALG`, a structurally valid public key, and a
 * `SignerKey` that is still present in `UserKey` (revocation is a DELETE —
 * an absent row means revoked). Expiry of the signer key is deliberately
 * NOT a filter here: expiry is normal key-lifecycle, not compromise, and
 * requiring it would silently drop officers whose signing key rotated.
 *
 * Exported (module-level) for `IntakeEngine.getOfficerEncryptionKeyStatus`'s
 * single-user read — NOT re-exported from the barrel.
 */
export async function readUsableEncryptionKeys (
  port: IntakeQueryPort,
  userId: string
): Promise<{ usable: CandidateEncryptionKey[], dropped: IntakeRecipientDroppedKey[] }> {
  const rows = await port.query<UserEncryptionKeyRow>(
    'select PubKey, Alg, RegisteredAt, SignerKey from UserEncryptionKey where UserId = :userId',
    { userId }
  )
  const usable: CandidateEncryptionKey[] = []
  const dropped: IntakeRecipientDroppedKey[] = []
  for (const row of rows) {
    if (row.Alg !== ENCRYPTION_KEY_ALG) continue
    if (!isValidEncryptionPublicKey(row.PubKey)) {
      dropped.push({ userId, publicKey: row.PubKey, reason: 'invalid-public-key' })
      continue
    }
    const signerRows = await port.query<{ found: number }>(
      'select 1 as found from UserKey where UserId = :userId and PubKey = :signerKey',
      { userId, signerKey: row.SignerKey }
    )
    if (signerRows.length === 0) {
      dropped.push({ userId, publicKey: row.PubKey, reason: 'signer-key-revoked' })
      continue
    }
    usable.push({ userId, publicKey: row.PubKey, registeredAt: row.RegisteredAt, signerKey: row.SignerKey })
  }
  return { usable, dropped }
}

/**
 * Pick the current key among a user's usable keys: greatest
 * `Date.parse(registeredAt)`, ties broken by publicKey descending
 * (deterministic — never an insertion-order artifact).
 *
 * Exported (module-level) for `IntakeEngine.getOfficerEncryptionKeyStatus` —
 * kept OFF the barrel (`src/intake/index.ts`).
 */
export function pickCurrentEncryptionKey (
  keys: readonly CandidateEncryptionKey[]
): CandidateEncryptionKey | undefined {
  let best: CandidateEncryptionKey | undefined
  for (const key of keys) {
    if (best === undefined) {
      best = key
      continue
    }
    const keyTime = Date.parse(key.registeredAt)
    const bestTime = Date.parse(best.registeredAt)
    if (keyTime > bestTime || (keyTime === bestTime && key.publicKey > best.publicKey)) {
      best = key
    }
  }
  return best
}

function compareUserId (a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * D-04/D-32: every current officer's current, usable key — one entry per
 * officer (even when several officers publish the same key), sorted by userId. Throws `IntakeError('invalid-argument')` for an
 * empty `authorityId`; an unknown authority yields an empty set (no current
 * officers, so nothing to resolve).
 */
export async function resolveIntakeRecipients (
  port: IntakeQueryPort,
  authorityId: string
): Promise<IntakeRecipientSet> {
  if (typeof authorityId !== 'string' || authorityId.length === 0) {
    throw new IntakeError('invalid-argument', 'resolveIntakeRecipients: authorityId must be a non-empty string')
  }

  const officerRows = await port.query<{ UserId: string }>(
    `select distinct O.UserId as UserId
       from Officer O
       join CurrentAdmin CA on CA.AuthorityId = O.AuthorityId and CA.EffectiveAt = O.AdminEffectiveAt
      where O.AuthorityId = :authorityId
      order by O.UserId`,
    { authorityId }
  )
  const currentOfficerIds = officerRows.map((row) => row.UserId).sort(compareUserId)

  const droppedKeys: IntakeRecipientDroppedKey[] = []
  const pickedByUser = new Map<string, CandidateEncryptionKey>()

  for (const userId of currentOfficerIds) {
    const { usable, dropped } = await readUsableEncryptionKeys(port, userId)
    droppedKeys.push(...dropped)
    const picked = pickCurrentEncryptionKey(usable)
    if (picked !== undefined) pickedByUser.set(userId, picked)
  }

  // Cross-officer duplicate public keys (initial/G1 WR-03). No claimant is
  // ever dropped: a PubKey carries no proof of possession, so an insider who
  // copies another officer's key (and backdates RegisteredAt) must not evict
  // the owner. Every claimant is sealed to under its OWN userId (the wrap AAD
  // binds the userId, so a claimant without the private key gains nothing);
  // the shared keys are reported in `contestedKeys` so the owner can be told.
  const byPublicKey = new Map<string, CandidateEncryptionKey[]>()
  for (const picked of pickedByUser.values()) {
    const list = byPublicKey.get(picked.publicKey) ?? []
    list.push(picked)
    byPublicKey.set(picked.publicKey, list)
  }

  const finalRecipients: EnvelopeRecipient[] = []
  const contestedKeys: Array<{ publicKey: string, userIds: string[] }> = []
  for (const [publicKey, claimants] of byPublicKey) {
    for (const claimant of claimants) finalRecipients.push({ userId: claimant.userId, publicKey })
    if (claimants.length > 1) {
      contestedKeys.push({ publicKey, userIds: claimants.map((c) => c.userId).sort(compareUserId) })
    }
  }
  contestedKeys.sort((a, b) => compareUserId(a.publicKey, b.publicKey))

  finalRecipients.sort((a, b) => compareUserId(a.userId, b.userId))
  const recipientUserIds = new Set(finalRecipients.map((r) => r.userId))
  const officersWithoutKey = currentOfficerIds.filter((id) => !recipientUserIds.has(id)).sort(compareUserId)

  return {
    authorityId,
    recipients: finalRecipients,
    officersWithoutKey,
    droppedKeys,
    contestedKeys
  }
}
