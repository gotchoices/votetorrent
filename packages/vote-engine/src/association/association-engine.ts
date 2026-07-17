import { MisuseError, QuereusError } from '@quereus/quereus'
import { bytesToHex } from '@noble/curves/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { asText, digestToBytes, nowCanonicalDatetime } from '../utils.js'
import { seedSignedMutation } from '../signing/signed-mutation.js'
import { StubAttestationVerifier } from './stub-attestation-verifier.js'
import { AssociationAssociateBuilder } from './builders/association-associate-builder.js'
import type { EngineContext } from '../types.js'
import type {
  AssociateInit,
  Association,
  AttestationChallenge,
  AttestationVerification,
  IAssociationAssociateBuilder,
  IAssociationEngine,
  IAttestationVerifier,
  Signature,
  Timestamp
} from '@votetorrent/vote-core'

/**
 * D-01/D-19: every mutating method's signing parameter is a real `Signature`
 * OR a callback that receives the canonical digest bytes and returns one —
 * NEVER a raw private key. The engine never holds the key (D-01). Matches
 * `IAssociationEngine`'s (unexported) `SignatureOrCallback` shape structurally.
 */
type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

// Phase 42-04 — module-scoped monotonic Tid counter for AssociationEngine
// mutations, mirroring ElectionsEngine/RegistrationEngine's `nextTid`/`peek*`
// pattern. Same WR-16/WR-25 heuristic caveats apply (seeded from Date.now(),
// not store-reconciled).
let nextAssociationTid = Date.now()

/** For test use only — returns the Tid the next AssociationEngine mutation will use. */
export function peekNextAssociationTid (): number { return nextAssociationTid }

/**
 * AttestationChallenge/Association/AssociationPrivate's `ExpirationValid`/
 * `AttestationTimeValid` CHECKs require `isISODatetime(...) and like('%Z', ...)`
 * — a trailing `Z` is MANDATORY, the same convention `RegistrationEngine`
 * uses for `Registrant`/`RegistrantPrivate`/`RegistrantSelective`.Expiration
 * (see registration-engine.ts's `toIsoZDatetime` doc comment). Do NOT reuse
 * the shared no-`Z` `toCanonicalDatetime` for these columns.
 */
function toIsoZDatetime (input: Timestamp | string): string {
  if (typeof input === 'number') return new Date(input).toISOString()
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(input)) return input
  // Quereus's canonical stored form (what a plain `select ... from AttestationChallenge`
  // read-back gives for a datetime column, as opposed to the Z-suffixed value we WROTE) is
  // UTC with the trailing `Z` stripped and fractional seconds at minimal precision. Append
  // `Z` directly rather than re-parsing through `new Date(...)`, which would misinterpret the
  // bare string as LOCAL time (mirrors utils.ts's `fromCanonicalDatetime` convention) and
  // silently shift the instant by the host's UTC offset.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(input)) return `${input}Z`
  const parsed = new Date(input)
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  return input
}

/**
 * Deferred-CHECK-aware datetime coercion (T-42-03 class, ported from
 * `registration-engine.ts`'s `toDeferredCheckDatetime`). Any CHECK containing
 * a subquery — `AttestationChallenge.InsertValid`, `Association.InsertValid`,
 * `AssociationPrivate.InsertValid`/`AssociationCidMatch`/`ChallengeValid` all
 * qualify — is DEFERRED in Quereus and re-derives `new.*` from a
 * `Temporal.PlainDateTime`-coerced snapshot: the trailing `Z` is dropped AND
 * fractional seconds are serialized at MINIMAL precision (trailing zero
 * digits dropped). The `vrg` AdminSigning ceremony digest for these tables'
 * datetime columns MUST use this coerced form; every IMMEDIATE (non-deferred)
 * CHECK — `ExpirationValid`, `AttestationTimeValid`, `CidValid`,
 * `SignatureValid` — sees the RAW Z-suffixed, always-3-digit value instead.
 */
function toDeferredCheckDatetime (input: Timestamp | string): string {
  let s = toIsoZDatetime(input).replace(/Z$/, '')
  if (s.includes('.')) {
    s = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  }
  return s
}

/** sha256(deviceId) hex-encoded — matches `PollingDevice.DeviceHash`/`Association.DeviceHash`'s documented "sha256 hash of the device ID" convention. */
function sha256Hex (input: string): string {
  return bytesToHex(sha256(utf8ToBytes(input)))
}

/**
 * AssociationEngine — Phase 42-04 (D-03..D-07, D-01/D-02) implementation.
 *
 * Unwired `(ctx?: EngineContext)` constructor per the `ElectionsEngine`/
 * `RegistrationEngine` precedent, PLUS an injectable `verifier` (D-07): the
 * device-attestation platform-verification seam defaults to
 * `StubAttestationVerifier` (nonce-freshness only, seam-only this phase) so
 * the engine is Node-testable without a real iOS/Android device. A real
 * verifier can be swapped in later without any change to this class's shape.
 *
 * Attestation flow (D-03..D-05): `issueAttestationChallenge` seeds a one-time
 * nonce bound to (RegistrantId, DeviceKey); `associate` verifies the device's
 * answering attestation through the seam BEFORE opening any transaction,
 * then writes the authority-held `AssociationPrivate` row and the public
 * `Association` row (committing to it via `AttestationCid`) inside one
 * BEGIN/COMMIT/ROLLBACK envelope (Pitfall 4 — Cids-before-parent order,
 * Association-before-AssociationPrivate here because `AssociationCidMatch`
 * needs the public row to already exist).
 *
 * Device uniqueness (D-06) is authority-side (needs the private DeviceId)
 * and engine-enforced — no cross-row schema CHECK. Waived only for a
 * `PollingDevice` whitelist entry (shared-tablet scenario), keyed by
 * `sha256(DeviceId)` — the same hash convention `Association.DeviceHash`/
 * `PollingDevice.DeviceHash` document.
 */
export class AssociationEngine implements IAssociationEngine {
  constructor (
    private readonly ctx?: EngineContext,
    private readonly verifier: IAttestationVerifier = new StubAttestationVerifier()
  ) {}

  /** Normalizes the Signature|callback union into a single callback shape. */
  private resolveSign (signatureOrCallback: SignatureOrCallback): (digest: Uint8Array) => Promise<Signature> {
    return typeof signatureOrCallback === 'function'
      ? signatureOrCallback
      : async () => signatureOrCallback
  }

  // ---------- Cid compute helper (pure, no insert — Pitfall 4) ----------

  /** AssociationPrivate.CidValid: Cid = cid(Digest(RegistrantId, DeviceKey, DeviceId, AttestationTime, Nonce, AttestationDetails, Expiration)). */
  private async computeAssociationPrivateCid (input: {
    registrantId: string
    deviceKey: string
    deviceId: string
    attestationTime: string
    nonce: string
    attestationDetails: string
    expiration: string
  }): Promise<string> {
    const ctx = this.ctx!
    const row = await ctx.db
      .prepare('select cid(Digest(:registrantId, :deviceKey, :deviceId, :attestationTime, :nonce, :attestationDetails, :expiration)) as c')
      .get(input)
    if (!row || row.c == null) {
      throw new Error('computeAssociationPrivateCid: cid(Digest(...)) returned null — crypto plugin not registered?')
    }
    return row.c as string
  }

  // ---------- D-03: attestation-challenge issuance / removal ----------

  /**
   * D-03: issue a one-time `AttestationChallenge` nonce bound to
   * (RegistrantId, DeviceKey). `AuthorityId` is resolved from the
   * `Registrant` row (the interface takes no explicit authorityId param);
   * the schema's own `RegistrantIdValid` CHECK rejects a non-`Status='a'`
   * registrant at insert time.
   */
  async issueAttestationChallenge (
    registrantId: string,
    deviceKey: string,
    expiration: string,
    signatureOrCallback: SignatureOrCallback
  ): Promise<AttestationChallenge> {
    this.requireCtx('issueAttestationChallenge')
    const ctx = this.ctx!
    const tid = nextAssociationTid++
    try {
      const registrantRow = await ctx.db
        .prepare('select AuthorityId from Registrant where Id = :registrantId')
        .get({ registrantId })
      if (!registrantRow) {
        throw new Error(`issueAttestationChallenge: Registrant not found for registrantId=${registrantId}`)
      }
      const authorityId = asText(registrantRow.AuthorityId, 'Registrant.AuthorityId')

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const nonce: string = (globalThis as any).crypto.randomUUID()
      const expirationZ = toIsoZDatetime(expiration)
      const expirationDeferred = toDeferredCheckDatetime(expirationZ)

      // NOTE: bind names `challengeNonce`/`challengeAuthorityId` (NOT `nonce`/`authorityId`) —
      // seedSignedMutation reserves `nonce`/`authorityId`/etc for ITS OWN ceremony bind params
      // and would silently overwrite a same-named digestParams entry (T-42-03 bug class found
      // via TDD on 42-03's RegistrationEngine: a `signature` key collided there; here the
      // colliding keys would have been the challenge's own Nonce/AuthorityId).
      const digestExpr = 'select Digest(:tid, :challengeNonce, :challengeAuthorityId, :registrantId, :deviceKey, :expirationDeferred) as d'
      const digestParams = { tid, challengeNonce: nonce, challengeAuthorityId: authorityId, registrantId, deviceKey, expirationDeferred }
      const signingNonce = await seedSignedMutation(ctx, authorityId, 'vrg', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback))

      await ctx.db.exec(
        `insert into AttestationChallenge (Nonce, AuthorityId, RegistrantId, DeviceKey, Expiration)
         with context SigningNonce = :signingNonce, Tid = ${tid}, now = :now
         values (:nonce, :authorityId, :registrantId, :deviceKey, :expiration)`,
        {
          nonce,
          authorityId,
          registrantId,
          deviceKey,
          expiration: expirationZ,
          signingNonce,
          now: nowCanonicalDatetime()
        }
      )

      return { nonce, authorityId, registrantId, deviceKey, expiration: expirationZ }
    } catch (err) {
      this.rethrow(err, 'issueAttestationChallenge')
    }
  }

  /** D-03: authority deletes a consumed/expired challenge ('vrg'-signed delete). */
  async removeAttestationChallenge (nonce: string, signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.requireCtx('removeAttestationChallenge')
    const ctx = this.ctx!
    const tid = nextAssociationTid++
    try {
      const row = await ctx.db
        .prepare('select AuthorityId from AttestationChallenge where Nonce = :nonce')
        .get({ nonce })
      if (!row) {
        throw new Error(`removeAttestationChallenge: AttestationChallenge not found for nonce=${nonce}`)
      }
      const authorityId = asText(row.AuthorityId, 'AttestationChallenge.AuthorityId')

      // NOTE: `challengeNonce` (not `nonce`) — avoids the seedSignedMutation reserved-bind collision (see issueAttestationChallenge).
      const digestExpr = "select Digest(:tid, :challengeNonce, 'delete') as d"
      const digestParams = { tid, challengeNonce: nonce }
      const signingNonce = await seedSignedMutation(ctx, authorityId, 'vrg', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback))

      await ctx.db.exec(
        `delete from AttestationChallenge
         with context SigningNonce = :signingNonce, Tid = ${tid}, now = :now
         where Nonce = :nonce`,
        { nonce, signingNonce, now: nowCanonicalDatetime() }
      )
    } catch (err) {
      this.rethrow(err, 'removeAttestationChallenge')
    }
  }

  // ---------- D-03..D-06: the associate ceremony ----------

  buildAssociate (): IAssociationAssociateBuilder {
    return new AssociationAssociateBuilder(this)
  }

  /**
   * D-03/D-04/D-05/D-06/D-07: the multi-row associate ceremony.
   *
   * 1. Load the `AttestationChallenge` bound to (nonce, registrantId, deviceKey) —
   *    a mismatch on ANY of the three (wrong nonce, wrong registrant, wrong
   *    device) fails the lookup, which is the structural nonce-replay
   *    mitigation (T-42-02): the nonce cannot be redirected to a different
   *    registrant+device pair.
   * 2. Call `IAttestationVerifier.verify(challenge, attestation)` BEFORE
   *    opening any transaction (D-07) — reject on `!ok`, no row written.
   * 3. D-06 device-uniqueness: reject if `AssociationPrivate` already has a
   *    row for this `DeviceId` under a DIFFERENT `RegistrantId`, UNLESS a
   *    `PollingDevice` row whitelists `sha256(DeviceId)` for this authority
   *    (the shared-tablet waiver). Engine-side only — no cross-row CHECK.
   * 4. BEGIN. Compute `AssociationPrivate.Cid` (pure select). Insert the
   *    public `Association` FIRST (its own row-level `SignatureValid`
   *    signature PLUS a 'vrg' AdminSigning ceremony, mirroring
   *    `RegistrationEngine.createRegistrant`'s two-digest pattern) — THEN
   *    `AssociationPrivate` (`AssociationCidMatch` needs the public row to
   *    already exist). COMMIT, ROLLBACK on any failure.
   *
   * `Association`/`AssociationPrivate.Expiration` reuse the matched
   * `AttestationChallenge.Expiration` — `AssociateInit` carries no
   * independent expiration field, and the challenge's expiration is the
   * only expiration value in scope at associate time.
   */
  async associate (init: AssociateInit, signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.requireCtx('associate')
    const ctx = this.ctx!
    const { registrantId, deviceKey, deviceHash, nonce, attestation } = init

    const challengeRow = await ctx.db
      .prepare(
        'select Nonce, AuthorityId, RegistrantId, DeviceKey, Expiration from AttestationChallenge where Nonce = :nonce and RegistrantId = :registrantId and DeviceKey = :deviceKey'
      )
      .get({ nonce, registrantId, deviceKey })
    if (!challengeRow) {
      throw new Error(
        `AssociationEngine.associate: no AttestationChallenge found for nonce=${nonce} registrantId=${registrantId} deviceKey=${deviceKey} — either it was never issued, has already been consumed, or does not bind this exact (registrant, device) pair`
      )
    }
    const challenge: AttestationChallenge = {
      nonce: asText(challengeRow.Nonce, 'AttestationChallenge.Nonce'),
      authorityId: asText(challengeRow.AuthorityId, 'AttestationChallenge.AuthorityId'),
      registrantId: asText(challengeRow.RegistrantId, 'AttestationChallenge.RegistrantId'),
      deviceKey: asText(challengeRow.DeviceKey, 'AttestationChallenge.DeviceKey'),
      // Read back from a plain SELECT — Quereus's stored canonical form lacks the
      // trailing `Z` (see `toIsoZDatetime`'s doc comment); re-Z-suffix it here so the
      // verifier (and every downstream expiration/digest computation) sees the
      // correct absolute instant, not a `new Date(...)`-local-time misinterpretation.
      expiration: toIsoZDatetime(challengeRow.Expiration as string)
    }

    // D-07 seam — verify BEFORE opening any transaction; no row written on rejection.
    const verification: AttestationVerification = await this.verifier.verify(challenge, attestation)
    if (!verification.ok) {
      throw new Error(
        `AssociationEngine.associate: attestation verification failed${verification.reason ? `: ${verification.reason}` : ''}`
      )
    }

    // D-06 device-uniqueness (authority-side — needs the private DeviceId).
    const deviceIdHash = sha256Hex(attestation.deviceId)
    const conflictingRow = await ctx.db
      .prepare('select RegistrantId from AssociationPrivate where DeviceId = :deviceId and RegistrantId <> :registrantId limit 1')
      .get({ deviceId: attestation.deviceId, registrantId })
    if (conflictingRow) {
      const waiverRow = await ctx.db
        .prepare('select AuthorityId from PollingDevice where AuthorityId = :authorityId and DeviceHash = :deviceHash')
        .get({ authorityId: challenge.authorityId, deviceHash: deviceIdHash })
      if (!waiverRow) {
        throw new Error(
          `AssociationEngine.associate: device already associated with a different registrant (no PollingDevice waiver present for this device — D-06)`
        )
      }
    }

    const expiration = toIsoZDatetime(challenge.expiration)
    const expirationDeferred = toDeferredCheckDatetime(expiration)
    const attestationTime = toIsoZDatetime(attestation.attestationTime)
    const attestationTimeDeferred = toDeferredCheckDatetime(attestationTime)
    const attestationDetailsJson = JSON.stringify({
      location: attestation.location,
      attestationStatement: attestation.attestationStatement,
      certificateChain: attestation.certificateChain,
      platformDetails: attestation.platformDetails
    })

    try {
      await ctx.db.exec('BEGIN')
      try {
        const cid = await this.computeAssociationPrivateCid({
          registrantId,
          deviceKey,
          deviceId: attestation.deviceId,
          attestationTime,
          nonce,
          attestationDetails: attestationDetailsJson,
          expiration
        })

        // ---- Association (public row) FIRST — AssociationCidMatch (below) needs it. ----
        const associationTid = nextAssociationTid++
        const rowDigestRow = await ctx.db
          .prepare('select Digest(:registrantId, :deviceKey, :deviceHash, :attestationCid, :expiration) as d')
          .get({ registrantId, deviceKey, deviceHash: deviceHash ?? null, attestationCid: cid, expiration })
        if (!rowDigestRow || rowDigestRow.d == null) {
          throw new Error('AssociationEngine.associate: Digest() returned null for Association row-level signature — crypto plugin not registered?')
        }
        const rowSignature = await this.resolveSign(signatureOrCallback)(digestToBytes(rowDigestRow.d))

        const associationDigestExpr = 'select Digest(:tid, :registrantId, :deviceKey, :deviceHash, :attestationCid, :expirationDeferred, :rowSignorKey, :rowSignature) as d'
        const associationDigestParams = {
          tid: associationTid,
          registrantId,
          deviceKey,
          deviceHash: deviceHash ?? null,
          attestationCid: cid,
          expirationDeferred,
          rowSignorKey: rowSignature.signerKey,
          rowSignature: rowSignature.signature
        }
        const associationNonce = await seedSignedMutation(
          ctx,
          challenge.authorityId,
          'vrg',
          associationTid,
          associationDigestExpr,
          associationDigestParams,
          this.resolveSign(signatureOrCallback),
          { ownsTransaction: false }
        )

        await ctx.db.exec(
          `insert into Association (RegistrantId, DeviceKey, DeviceHash, AttestationCid, Expiration, SignorKey, Signature)
           with context SigningNonce = :signingNonce, Tid = ${associationTid}, now = :now
           values (:registrantId, :deviceKey, :deviceHash, :attestationCid, :expiration, :signorKey, :signature)`,
          {
            registrantId,
            deviceKey,
            deviceHash: deviceHash ?? null,
            attestationCid: cid,
            expiration,
            signorKey: rowSignature.signerKey,
            signature: rowSignature.signature,
            signingNonce: associationNonce,
            now: nowCanonicalDatetime()
          }
        )

        // ---- AssociationPrivate (authority-held) SECOND — re-derives the SAME Cid. ----
        // NOTE: `challengeNonce` (not `nonce`) — avoids the seedSignedMutation reserved-bind
        // collision (see issueAttestationChallenge's doc comment); this is the AttestationChallenge
        // nonce this attestation answered, stored in AssociationPrivate.Nonce.
        const privateTid = nextAssociationTid++
        const privateDigestExpr = 'select Digest(:tid, :cid, :registrantId, :deviceKey, :deviceId, :attestationTimeDeferred, :challengeNonce, :attestationDetails, :expirationDeferred) as d'
        const privateDigestParams = {
          tid: privateTid,
          cid,
          registrantId,
          deviceKey,
          deviceId: attestation.deviceId,
          attestationTimeDeferred,
          challengeNonce: nonce,
          attestationDetails: attestationDetailsJson,
          expirationDeferred
        }
        const privateNonce = await seedSignedMutation(
          ctx,
          challenge.authorityId,
          'vrg',
          privateTid,
          privateDigestExpr,
          privateDigestParams,
          this.resolveSign(signatureOrCallback),
          { ownsTransaction: false }
        )

        await ctx.db.exec(
          `insert into AssociationPrivate (Cid, RegistrantId, DeviceKey, DeviceId, AttestationTime, Nonce, AttestationDetails, Expiration)
           with context SigningNonce = :signingNonce, Tid = ${privateTid}, now = :now
           values (:cid, :registrantId, :deviceKey, :deviceId, :attestationTime, :nonce, :attestationDetails, :expiration)`,
          {
            cid,
            registrantId,
            deviceKey,
            deviceId: attestation.deviceId,
            attestationTime,
            nonce,
            attestationDetails: attestationDetailsJson,
            expiration,
            signingNonce: privateNonce,
            now: nowCanonicalDatetime()
          }
        )

        await ctx.db.exec('COMMIT')
      } catch (innerErr) {
        await ctx.db.exec('ROLLBACK')
        throw innerErr
      }
    } catch (err) {
      this.rethrow(err, 'associate')
    }
  }

  // ---------- reads / removal ----------

  /** D-04 information-disclosure boundary: exposes at most `DeviceHash` — never `AssociationPrivate.DeviceId`. */
  async getAssociation (registrantId: string, deviceKey: string): Promise<Association | undefined> {
    if (!this.ctx) return undefined
    try {
      const row = await this.ctx.db
        .prepare('select RegistrantId, DeviceKey, DeviceHash, AttestationCid, Expiration, SignorKey, Signature from Association where RegistrantId = :registrantId and DeviceKey = :deviceKey')
        .get({ registrantId, deviceKey })
      if (!row) return undefined
      return {
        registrantId: asText(row.RegistrantId, 'Association.RegistrantId'),
        deviceKey: asText(row.DeviceKey, 'Association.DeviceKey'),
        deviceHash: row.DeviceHash == null ? undefined : asText(row.DeviceHash, 'Association.DeviceHash'),
        attestationCid: row.AttestationCid == null ? undefined : asText(row.AttestationCid, 'Association.AttestationCid'),
        expiration: row.Expiration as string,
        signorKey: asText(row.SignorKey, 'Association.SignorKey'),
        signature: asText(row.Signature, 'Association.Signature')
      }
    } catch (err) {
      this.rethrow(err, 'getAssociation')
    }
  }

  /** 'vrg'-signed delete. */
  async removeAssociation (registrantId: string, deviceKey: string, signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.requireCtx('removeAssociation')
    const ctx = this.ctx!
    const tid = nextAssociationTid++
    try {
      const existing = await ctx.db
        .prepare('select 1 as found from Association where RegistrantId = :registrantId and DeviceKey = :deviceKey')
        .get({ registrantId, deviceKey })
      if (!existing) {
        throw new Error(`removeAssociation: Association not found for registrantId=${registrantId} deviceKey=${deviceKey}`)
      }
      // Association carries no AuthorityId column of its own — resolve via Registrant.
      const registrantRow = await ctx.db
        .prepare('select AuthorityId from Registrant where Id = :registrantId')
        .get({ registrantId })
      if (!registrantRow) {
        throw new Error(`removeAssociation: Registrant not found for registrantId=${registrantId}`)
      }
      const authorityId = asText(registrantRow.AuthorityId, 'Registrant.AuthorityId')

      const digestExpr = "select Digest(:tid, :registrantId, :deviceKey, 'delete') as d"
      const digestParams = { tid, registrantId, deviceKey }
      const signingNonce = await seedSignedMutation(ctx, authorityId, 'vrg', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback))

      await ctx.db.exec(
        `delete from Association
         with context SigningNonce = :signingNonce, Tid = ${tid}, now = :now
         where RegistrantId = :registrantId and DeviceKey = :deviceKey`,
        { registrantId, deviceKey, signingNonce, now: nowCanonicalDatetime() }
      )
    } catch (err) {
      this.rethrow(err, 'removeAssociation')
    }
  }

  // ---------- helpers ----------

  private requireCtx (method: string): void {
    if (!this.ctx) {
      throw new Error(`AssociationEngine.${method}: no EngineContext bound — construct with (ctx) for DB-backed methods`)
    }
  }

  private rethrow (err: unknown, method: string): never {
    if (err instanceof QuereusError) {
      throw new Error(`Quereus error (code ${err.code}): ${err.message}`)
    } else if (err instanceof MisuseError) {
      throw new Error(`API misuse: ${err.message}`)
    } else if (err instanceof Error) {
      throw new Error(`AssociationEngine.${method}: ${err.message}`)
    } else {
      throw new Error(`AssociationEngine.${method}: unknown error: ${String(err)}`)
    }
  }
}
