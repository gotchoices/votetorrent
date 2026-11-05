import type { Database } from '@quereus/quereus'

/**
 * Engine-side answers for the schema's tier-2 signer CHECKs:
 * `AdminSigning.SignerKeyValid`, `OfficerSignature.SignerKeyValid` and
 * `OfficerSignature.OfficerValid` (`votetorrent.qsql`). Those constraints read
 * `context.IsSignerKeyValid` / `context.IsOfficerValid`, which every producer used to
 * bind as a literal `true`. Producers now bind the values computed here, so a signature
 * by an unregistered/expired key, or by a user who is not an officer of the session's
 * authority, is refused by the schema instead of being waved through.
 *
 * This is tier 2 (the engine decides, the schema enforces the boolean) — it binds every
 * honest client, but it is not a cryptographic guarantee against a client that bypasses
 * vote-engine. A schema-level EXISTS fold is the stronger follow-up (needs an on-device
 * re-attach proof, as for any CHECK amendment on a live table).
 */

/** True when `signerKey` is a registered, unexpired key of `userId`. */
export async function isSignerKeyValid (
  db: Database,
  userId: string,
  signerKey: string,
  now: string
): Promise<boolean> {
  const row = await db
    .prepare(
      `select 1 as x from UserKey
        where UserId = :userId and PubKey = :signerKey and Expiration > :now`
    )
    .get({ userId, signerKey, now })
  return row != null
}

/**
 * True when `userId` is an officer of the signing session's authority — under the
 * administration the session was opened against, or under the authority's current
 * administration (a session can outlive an admin change; threshold counting already
 * uses the current admin's scope holders).
 */
export async function isOfficerOfSession (
  db: Database,
  nonce: string,
  userId: string
): Promise<boolean> {
  const row = await db
    .prepare(
      `select 1 as x
        from AdminSigning S
        join Officer O on O.AuthorityId = S.AuthorityId and O.UserId = :userId
        where S.Nonce = :nonce
          and (
            O.AdminEffectiveAt = S.AdminEffectiveAt
            or O.AdminEffectiveAt = (select C.EffectiveAt from CurrentAdmin C where C.AuthorityId = S.AuthorityId)
          )`
    )
    .get({ nonce, userId })
  return row != null
}

/**
 * Context flags for an `insert into OfficerSignature`. A placeholder (system-derived,
 * DEBT-11) row carries no real signer, so key validity is not asserted for it — the
 * officer check still applies.
 */
export async function officerSignatureValidity (
  db: Database,
  args: { nonce: string, userId: string, signerKey: string, now: string, isPlaceholderSignature: boolean }
): Promise<{ isSignerKeyValid: boolean, isOfficerValid: boolean }> {
  // Sequential, not Promise.all: these run inside the caller's open transaction.
  const keyValid = args.isPlaceholderSignature
    ? true
    : await isSignerKeyValid(db, args.userId, args.signerKey, args.now)
  const officerValid = await isOfficerOfSession(db, args.nonce, args.userId)
  return { isSignerKeyValid: keyValid, isOfficerValid: officerValid }
}

/**
 * `context.IsSignerKeyValid` for an `insert into AdminSigning`. Placeholder rows
 * (`IsPlaceholderSignature = true`) may bind the all-zero key, so they are exempt.
 */
export async function adminSigningKeyValidity (
  db: Database,
  args: { userId: string, signerKey: string, now: string, isPlaceholderSignature: boolean }
): Promise<boolean> {
  if (args.isPlaceholderSignature) return true
  return isSignerKeyValid(db, args.userId, args.signerKey, args.now)
}
