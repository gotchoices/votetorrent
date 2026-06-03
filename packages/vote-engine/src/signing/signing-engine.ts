import { ConstraintError, MisuseError, QuereusError } from '@quereus/quereus'
import {
  type AdminDigestArgs,
  type ISigningEngine,
  type ISigningSignBuilder,
  type ISigningStartSigningSessionBuilder,
  type Scope,
  type Signature,
  type SigningResult
} from '@votetorrent/vote-core'
import { SigningSignBuilder } from './builders/signing-sign-builder.js'
import { SigningStartSigningSessionBuilder } from './builders/signing-start-signing-session-builder.js'
import { type EngineContext } from '../types'
import { nowCanonicalDatetime } from '../utils.js'

export class SigningEngine implements ISigningEngine {
  constructor (private readonly ctx: EngineContext) {}

  /** D-18: Generate a fresh nonce without creating AdminSigning.
   *  Invite flows call this first, then INSERT InviteSlots (with the nonce),
   *  then call startSigningSession with digestArgs=null + the same nonce. */
  generateSigningNonce (): string {
    return crypto.randomUUID()
  }

  async sign (nonce: string, signature: Signature): Promise<boolean> {
    try {
      // AUTH-08: BEGIN/COMMIT/ROLLBACK envelope around OfficerSignature
      // insert + threshold check + (optional) AdminSignature insert.
      await this.ctx.db.exec('BEGIN')
      try {
        // AUTH-06: bind :signerKey (not :key) — the previous binding silently
        // dropped the signer's public key. The SQL placeholder is :signerKey;
        // the JS object key now matches.
        await this.ctx.db.exec(
					`insert into OfficerSignature (
						SigningNonce,
						UserId,
						SignerKey,
						Signature
					)
					with context now = :now, IsSignatureValid = true, IsSignerKeyValid = true, IsOfficerValid = true
					values (
						:nonce,
						:userId,
						:signerKey,
						:signature
					)`,
					{
					  nonce,
					  userId: signature.signerUserId,
					  signerKey: signature.signerKey,
					  signature: signature.signature,
					  now: nowCanonicalDatetime()
					}
        )

        // Get the scope for the current signing session
        const scopeRes = await this.ctx.db
          .prepare('select Scope from AdminSigning where Nonce = :nonce')
          .get({ nonce })
        const scope = scopeRes?.Scope as Scope

        // Get the current number of OfficerSignatures for the given signing nonce
        const signatureCountRes = await this.ctx.db
          .prepare(
            'select count(*) as signatureCount from OfficerSignature where SigningNonce = :nonce'
          )
          .get({ nonce })
        const signatureCount = Number(signatureCountRes?.signatureCount)

        // Get the threshold for this signing session from the Admin table, matching the authority, effective date, and scope
        const thresholdRes = await this.ctx.db
          .prepare(
						`select
							coalesce(
								cast(
									json_extract(
										-- get the first policy object that matches the scope; fallback to 1 if not found
										(
										  select value
										  from json_each(ThresholdPolicies)
										  where json_extract(value, '$.scope') = :scope
										  limit 1
										), '$.threshold'
									) as integer
								), 1
							) as threshold
					from AdminSigning ADS
					join Admin A
						on ADS.AuthorityId = A.AuthorityId
						and ADS.AdminEffectiveAt = A.EffectiveAt
					where ADS.Nonce = :nonce`
          )
          .get({ nonce, scope })

        const threshold = Number(thresholdRes?.threshold) || 1

        if (signatureCount >= threshold) {
          try {
            await this.ctx.db.exec(
              'insert into AdminSignature (SigningNonce) with context IsSignatureValid = true values (:nonce)',
              { nonce }
            )
            await this.ctx.db.exec('COMMIT')
            return true
          } catch (pkErr) {
            // D-17: PK violation on AdminSignature.SigningNonce means a
            // concurrent caller already inserted the AdminSignature row
            // for this nonce. Treat as idempotent threshold completion.
            // The signatureCount gate guarantees SignatureValid is already
            // satisfied, so the only reachable ConstraintError here is a
            // PK collision.
            if (pkErr instanceof ConstraintError) {
              await this.ctx.db.exec('ROLLBACK')
              console.warn(
                `SigningEngine.sign: threshold already reached for nonce ${nonce}; AdminSignature row exists.`
              )
              return true
            }
            throw pkErr
          }
        } else {
          await this.ctx.db.exec('COMMIT')
          return false
        }
      } catch (innerErr) {
        await this.ctx.db.exec('ROLLBACK')
        throw innerErr
      }
    } catch (err) {
      // AUTH-07: control flow exits via the inner try's return statements or
      // via this throw. No statements remain reachable after the catch.
      if (err instanceof QuereusError) {
        throw new Error(`Quereus error (code ${err.code}): ${err.message}`)
      } else if (err instanceof MisuseError) {
        throw new Error(`API misuse: ${err.message}`)
      } else {
        throw new Error(`Unknown error: ${err}`)
      }
    }
  }

  /** D-06/D-08/D-17: Two-path startSigningSession.
   *
   * PATH A (digestArgs provided — used by proposeAdmin):
   *   Generate a fresh nonce, INSERT AdminSigning with inline
   *   Digest(:authorityId, :effectiveAt, :thresholdPolicies) in alphabetical order.
   *
   * PATH B (digestArgs is null — used by invite flows via saveInviteWithSigning):
   *   Callers must first call generateSigningNonce() to get the nonce, INSERT
   *   InviteSlots with that nonce, then call this with digestArgs=null + the same nonce.
   *   INSERT AdminSigning with a Digest subquery over the InviteSlot tagged with that nonce.
   */
  async startSigningSession (
    authorityId: string,
    digestArgs: AdminDigestArgs | null,
    scope: Scope,
    signature: Signature,
    nonce?: string
  ): Promise<SigningResult> {
    // PATH A: non-invite callers — generate a fresh nonce
    // PATH B: invite callers — must supply the pre-generated nonce
    const sessionNonce = digestArgs !== null
      ? crypto.randomUUID()
      : (() => {
          if (!nonce) throw new Error('nonce is required when digestArgs is null (invite flow)')
          return nonce
        })()

    try {
      const adminDB = await this.ctx.db
        .prepare(
					`select CurrentAdmin.EffectiveAt from CurrentAdmin join Officer
						on CurrentAdmin.AuthorityId = Officer.AuthorityId
							and CurrentAdmin.EffectiveAt = Officer.AdminEffectiveAt
								where Officer.UserId = :userId and Officer.AuthorityId = :authorityId`
        )
        .get({
          userId: signature.signerUserId,
          authorityId
        })
      if (!adminDB) {
        throw new Error('Admin not found')
      }

      if (digestArgs !== null) {
        // PATH A: inline Digest() — fields in alphabetical order (D-07d)
        // AdminDigestArgs fields: authorityId, effectiveAt, thresholdPolicies
        await this.ctx.db.exec(
					`insert into AdminSigning (
						Nonce,
						AuthorityId,
						AdminEffectiveAt,
						Scope,
						Digest,
						UserId,
						SignerKey,
						Signature
					)
					with context now = :now, IsSignatureValid = true, IsSignerKeyValid = true
					values (
						:nonce,
						:authorityId,
						:adminEffectiveAt,
						:scope,
						Digest(:authorityId, :effectiveAt, :thresholdPolicies),
						:userId,
						:signerKey,
						:signature
					)`,
					{
					  nonce: sessionNonce,
					  authorityId,
					  adminEffectiveAt: adminDB.EffectiveAt as string,
					  scope,
					  effectiveAt: digestArgs.effectiveAt,
					  thresholdPolicies: digestArgs.thresholdPolicies,
					  userId: signature.signerUserId,
					  signerKey: signature.signerKey,
					  signature: signature.signature,
					  now: nowCanonicalDatetime()
					}
        )
      } else {
        // PATH B: Digest subquery over the InviteSlot tagged with this nonce (D-17)
        await this.ctx.db.exec(
					`insert into AdminSigning (
						Nonce,
						AuthorityId,
						AdminEffectiveAt,
						Scope,
						Digest,
						UserId,
						SignerKey,
						Signature
					)
					with context now = :now, IsSignatureValid = true, IsSignerKeyValid = true
					values (
						:nonce,
						:authorityId,
						:adminEffectiveAt,
						:scope,
						(SELECT Digest(Cid) FROM InviteSlot WHERE SigningNonce = :nonce),
						:userId,
						:signerKey,
						:signature
					)`,
					{
					  nonce: sessionNonce,
					  authorityId,
					  adminEffectiveAt: adminDB.EffectiveAt as string,
					  scope,
					  userId: signature.signerUserId,
					  signerKey: signature.signerKey,
					  signature: signature.signature,
					  now: nowCanonicalDatetime()
					}
        )
      }
    } catch (err) {
      if (err instanceof QuereusError) {
        throw new Error(`Quereus error (code ${err.code}): ${err.message}`)
      } else if (err instanceof MisuseError) {
        throw new Error(`API misuse: ${err.message}`)
      } else {
        throw new Error(`Unknown error: ${err}`)
      }
    }
    const thresholdReached = await this.sign(sessionNonce, signature)
    return { nonce: sessionNonce, thresholdReached }
  }

  buildSign (): ISigningSignBuilder {
    return new SigningSignBuilder(this)
  }

  buildStartSigningSession (): ISigningStartSigningSessionBuilder {
    return new SigningStartSigningSessionBuilder(this)
  }
}
