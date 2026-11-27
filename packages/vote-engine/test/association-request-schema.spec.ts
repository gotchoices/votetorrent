/**
 * association-request-schema.spec.ts — Phase 51 Plan 01 (D-02/D-12/D-18)
 *
 * Drives the REAL Quereus schema landed by 51-01 through raw SQL — no engine method exists yet
 * (`AssociationEngine.submitAssociationRequest` / `processPendingAssociationRequests` land in a
 * later 51-0x plan). This is deliberately a SCHEMA-LEVEL proof: every case below asserts a CHECK
 * constraint's behavior directly against a real Quereus database with real secp256k1/P-256
 * signers — never a stubbed `SignatureValid`.
 *
 * Covers (one `it()` per `<behavior>` bullet in 51-01-PLAN.md Task 3):
 *   1. A well-formed, self-signed AssociationRequest INSERT succeeds and creates ZERO
 *      AdminSigning rows (D-02's no-ceremony design).
 *   2. An INSERT whose RequesterSignature was produced over a different tuple is REJECTED by
 *      SignatureValid.
 *   3. An INSERT signed by a P-256 DeviceKey (SignatureValidP256's branch) succeeds — the
 *      mixed-curve `or` form is live, not dead code.
 *   4. UPDATE 'p' -> 'c' with a matching 'vrg' AdminSignature succeeds and persists ChallengeNonce.
 *   5. UPDATE 'p' -> 'c' with NO signing nonce is REJECTED.
 *   6. UPDATE 'p' -> 'a' (skipping 'c') is REJECTED by TransitionValid.
 *   7. UPDATE 'c' -> 'a' with a matching 'vrg' AdminSignature succeeds.
 *   8. DELETE from AssociationRequest is REJECTED (NoDelete).
 *   9. INSERT into ElectionRecordValidityPolicy under a 'mel'-scoped ceremony succeeds; the same
 *      INSERT under 'vrg' is REJECTED (D-12/D-20).
 *
 * Every rejection case asserts the write THREW, never a row-count of 0 alone — a "silent
 * rejection" (quereus#21's failure mode, referenced in registration-request.spec.ts) would still
 * let the statement resolve while inserting/updating nothing.
 */

import 'reflect-metadata'
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import {
  createTestNetwork,
  addTestAuthority,
  addTestElection,
  makeTestSignCallback,
  seedSignedMutation as seedSignedMutationFixture,
} from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { makeP256TestKey, signDigestP256 } from './fixtures/p256-signer.js'
import { digestToBytes } from '../src/utils.js'
import { toIsoZDatetime, toDeferredCheckDatetime, restoreCanonicalDatetime } from '../src/signing/ceremony-helpers.js'
import { seedSignedMutation } from '../src/signing/signed-mutation.js'
import type { EngineContext } from '../src/types.js'

type TestAuthority = Awaited<ReturnType<typeof addTestAuthority>>

// ---------------------------------------------------------------------------
// Signer helpers — one per curve, same `{ publicHex, signDigest }` shape so
// seedAssociationRequest() is curve-agnostic (mirrors SignatureValid's own
// "try both curves" design — neither signer type is privileged).
// ---------------------------------------------------------------------------

interface TestSigner {
  publicHex: string
  signDigest: (digestBase64url: string) => string
}

/** WR-10 prehash contract: noble v2 default (`prehash:true`), no options object. */
function makeSecp256k1Signer (): TestSigner {
  const { privateHex, publicHex } = randomTestKeyPair()
  const privBytes = hexToBytes(privateHex)
  return {
    publicHex,
    signDigest: (digestBase64url: string): string =>
      bytesToHex(secp256k1.sign(digestToBytes(digestBase64url), privBytes)),
  }
}

/** The iOS device-key curve — 33-byte compressed P-256 SEC1 point (fixtures/p256-signer.ts). */
function makeP256Signer (): TestSigner {
  const { privBytes, pubHex } = makeP256TestKey()
  return {
    publicHex: pubHex,
    signDigest: (digestBase64url: string): string => signDigestP256(digestBase64url, privBytes),
  }
}

// ---------------------------------------------------------------------------
// seedAssociationRequest — D-02 ceremony-free self-signed intake
// ---------------------------------------------------------------------------

interface SeedAssociationRequestOverrides {
  /** External signer to use instead of a freshly-generated secp256k1 one. */
  signer?: TestSigner
  /** Deliberately bind a DeviceKey different from whoever actually signed — wrong-key negatives. */
  deviceKey?: string
  registrantId?: string
  electionId?: string | null
  /** Deliberately bind a RequesterSignature not produced over the row's own digest — tamper negatives. */
  signature?: string
}

interface SeedAssociationRequestResult {
  id: string
  registrantId: string
  deviceKey: string
  signer: TestSigner
}

/**
 * Insert one `AssociationRequest` row by raw SQL (D-02: no `Registrant` FK CHECK, no ceremony
 * required to submit — see 51-01-PLAN.md Task 1: this table deliberately carries no
 * `RegistrantIdValid` constraint, unlike `AttestationChallenge`/`Association`).
 */
async function seedAssociationRequest (
  auth: TestAuthority,
  overrides?: SeedAssociationRequestOverrides
): Promise<SeedAssociationRequestResult> {
  const authorityId = auth.authority.id
  const id = crypto.randomUUID()
  const registrantId = overrides?.registrantId ?? crypto.randomUUID()
  const signer = overrides?.signer ?? makeSecp256k1Signer()
  const deviceKey = overrides?.deviceKey ?? signer.publicHex
  const electionId = overrides?.electionId === undefined ? null : overrides.electionId
  const submittedAt = toIsoZDatetime(Date.now())

  let requesterSignature = overrides?.signature
  if (requesterSignature === undefined) {
    // AssociationRequest.SignatureValid's Digest(...) argument order, field for field:
    //   Digest(Id, AuthorityId, RegistrantId, DeviceKey, ElectionId, SubmittedAt)
    const digestRow = await auth.ctx.db
      .prepare('select Digest(:id, :authorityId, :registrantId, :deviceKey, :electionId, :submittedAt) as d')
      .get({ id, authorityId, registrantId, deviceKey, electionId, submittedAt })
    if (!digestRow || digestRow.d == null) throw new Error('seedAssociationRequest: SignatureValid Digest() returned null')
    requesterSignature = signer.signDigest(digestRow.d as string)
  }

  const receivedAt = toIsoZDatetime(Date.now())

  await auth.ctx.db.exec(
    `insert into AssociationRequest (
      Id, AuthorityId, RegistrantId, DeviceKey, ElectionId, Status, ChallengeNonce, SubmittedAt, ReceivedAt, DecidedAt, RejectionReason, RequesterSignature
    )
    with context SigningNonce = null, Tid = :tid
    values (:id, :authorityId, :registrantId, :deviceKey, :electionId, 'p', null, :submittedAt, :receivedAt, null, null, :requesterSignature)`,
    { id, authorityId, registrantId, deviceKey, electionId, submittedAt, receivedAt, requesterSignature, tid: Date.now() }
  )

  return { id, registrantId, deviceKey, signer }
}

/** Behavioral proof of the D-02 no-ceremony design (mirrors registration-request.spec.ts). */
async function countAdminSigning (ctx: EngineContext): Promise<number> {
  const row = await ctx.db.prepare('select count(*) as n from AdminSigning').get({})
  return Number(row?.n ?? 0)
}

// ---------------------------------------------------------------------------
// The two D-18 signed UPDATE transitions
// ---------------------------------------------------------------------------

/**
 * The D-18 challenge-echo transition: 'p' -> 'c', signed under 'vrg'. Rebinds SubmittedAt/
 * ReceivedAt to their restored canonical form even though this UPDATE does not otherwise touch
 * them — an unbound partial UPDATE evaluates the unqualified SignatureValid/*Immutable CHECKs
 * against a Z-stripped row snapshot (project memory: partial-UPDATE datetime rebind trap).
 */
async function issueChallengeTransition (
  auth: TestAuthority,
  requestId: string,
  challengeNonce: string,
  opts?: { skipSigningNonce?: boolean }
): Promise<void> {
  const ctx = auth.ctx
  const row = await ctx.db
    .prepare('select AuthorityId, SubmittedAt, ReceivedAt from AssociationRequest where Id = :id')
    .get({ id: requestId })
  if (!row) throw new Error('issueChallengeTransition: AssociationRequest not found')
  const authorityId = row.AuthorityId as string
  const submittedAt = restoreCanonicalDatetime(row.SubmittedAt as string)
  const receivedAt = restoreCanonicalDatetime(row.ReceivedAt as string)
  const tid = Date.now()

  let signingNonce: string | null = null
  if (!opts?.skipSigningNonce) {
    // TransitionValid's challenge-echo digest, field for field:
    //   Digest(context.Tid, new.Id, new.Status, new.ChallengeNonce)
    const digestExpr = 'select Digest(:tid, :requestId, :status, :challengeNonce) as d'
    const digestParams = { tid, requestId, status: 'c', challengeNonce }
    signingNonce = await seedSignedMutation(ctx, authorityId, 'vrg', tid, digestExpr, digestParams, makeTestSignCallback(auth.user))
  }

  await ctx.db.exec(
    `update AssociationRequest
     with context SigningNonce = :signingNonce, Tid = ${tid}
     set Status = :status, ChallengeNonce = :challengeNonce, SubmittedAt = :submittedAt, ReceivedAt = :receivedAt
     where Id = :requestId`,
    { signingNonce, status: 'c', challengeNonce, submittedAt, receivedAt, requestId }
  )
}

/**
 * The terminal decision transition: 'c'/'p' -> 'a'/'r', signed under 'vrg'. DecidedAt is a
 * `datetime` column and TransitionValid contains an `exists(...)` subquery (a DEFERRED CHECK), so
 * the digest binds `toDeferredCheckDatetime(decidedAt)` while the actual column write uses the
 * raw Z-suffixed `decidedAt` — the same asymmetry RegistrationRequest.DecisionValid's callers
 * observe (registrant-rejection.spec.ts's attemptDirectStatusFlip).
 */
async function decideAssociationRequest (
  auth: TestAuthority,
  requestId: string,
  toStatus: 'a' | 'r',
  rejectionReason: string | null
): Promise<void> {
  const ctx = auth.ctx
  const row = await ctx.db
    .prepare('select AuthorityId, SubmittedAt, ReceivedAt from AssociationRequest where Id = :id')
    .get({ id: requestId })
  if (!row) throw new Error('decideAssociationRequest: AssociationRequest not found')
  const authorityId = row.AuthorityId as string
  const submittedAt = restoreCanonicalDatetime(row.SubmittedAt as string)
  const receivedAt = restoreCanonicalDatetime(row.ReceivedAt as string)
  const tid = Date.now()
  const decidedAt = toIsoZDatetime(Date.now())
  const decidedAtForDigest = toDeferredCheckDatetime(decidedAt)

  // TransitionValid's decision digest, field for field:
  //   Digest(context.Tid, new.Id, new.Status, new.DecidedAt, new.RejectionReason)
  const digestExpr = 'select Digest(:tid, :requestId, :status, :decidedAt, :rejectionReason) as d'
  const digestParams = { tid, requestId, status: toStatus, decidedAt: decidedAtForDigest, rejectionReason }
  const signingNonce = await seedSignedMutation(ctx, authorityId, 'vrg', tid, digestExpr, digestParams, makeTestSignCallback(auth.user))

  await ctx.db.exec(
    `update AssociationRequest
     with context SigningNonce = :signingNonce, Tid = ${tid}
     set Status = :status, DecidedAt = :decidedAt, RejectionReason = :rejectionReason, SubmittedAt = :submittedAt, ReceivedAt = :receivedAt
     where Id = :requestId`,
    { signingNonce, status: toStatus, decidedAt, rejectionReason, submittedAt, receivedAt, requestId }
  )
}

// ===========================================================================
// 1/2/3 — AssociationRequest INSERT (D-02, mixed-curve SignatureValid)
// ===========================================================================

describe('AssociationRequest schema: ceremony-free self-signed intake (D-02)', () => {
  it('inserts a well-formed, self-signed request and creates ZERO AdminSigning rows', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const before = await countAdminSigning(auth.ctx)

    const { id, registrantId, deviceKey } = await seedAssociationRequest(auth)

    const after = await countAdminSigning(auth.ctx)
    const row = await auth.ctx.db
      .prepare('select AuthorityId, RegistrantId, DeviceKey, Status from AssociationRequest where Id = :id')
      .get({ id })
    expect(row, 'AssociationRequest row must exist post-insert').to.not.be.undefined
    expect(row?.AuthorityId).to.equal(auth.authority.id)
    expect(row?.RegistrantId).to.equal(registrantId)
    expect(row?.DeviceKey).to.equal(deviceKey)
    expect(row?.Status).to.equal('p')

    // LOAD-BEARING: the behavioral proof of D-02's no-ceremony design — a prospective registrant
    // has no officer scope to seed a ceremony against, and this insert must not create one.
    expect(after, 'a self-signed AssociationRequest insert must create ZERO AdminSigning rows').to.equal(before)
  })

  it('rejects an insert whose RequesterSignature was produced over a different tuple', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const signerX = makeSecp256k1Signer()
    const signerY = makeSecp256k1Signer()
    const id = crypto.randomUUID()
    const registrantId = crypto.randomUUID()
    const submittedAt = toIsoZDatetime(Date.now())

    // Sign a digest binding signerX's own key, then submit the row claiming signerY's key —
    // SignatureValid must reject because the signature does not verify under DeviceKey=signerY.
    const digestRow = await auth.ctx.db
      .prepare('select Digest(:id, :authorityId, :registrantId, :deviceKey, :electionId, :submittedAt) as d')
      .get({ id, authorityId: auth.authority.id, registrantId, deviceKey: signerX.publicHex, electionId: null, submittedAt })
    if (!digestRow || digestRow.d == null) throw new Error('wrong-tuple test: SignatureValid Digest() returned null')
    const requesterSignature = signerX.signDigest(digestRow.d as string)

    let caught: unknown
    try {
      await seedAssociationRequest(auth, {
        signer: signerY,
        deviceKey: signerY.publicHex,
        registrantId,
        signature: requesterSignature,
      })
    } catch (err) {
      caught = err
    }
    expect(caught, 'INSERT must throw: signature was produced over a tuple binding a different DeviceKey').to.be.instanceOf(Error)

    const row = await auth.ctx.db.prepare('select count(*) as n from AssociationRequest where Id = :id').get({ id })
    expect(Number(row?.n)).to.equal(0)
  })

  it('accepts a P-256-keyed request — SignatureValidP256 branch of the mixed-curve OR is live, not dead', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const p256Signer = makeP256Signer()
    expect(p256Signer.publicHex, '33-byte compressed SEC1 point, hex-encoded').to.have.length(66)

    const { id, deviceKey } = await seedAssociationRequest(auth, { signer: p256Signer })

    const row = await auth.ctx.db
      .prepare('select DeviceKey, Status from AssociationRequest where Id = :id')
      .get({ id })
    expect(row?.DeviceKey).to.equal(deviceKey)
    expect(row?.Status).to.equal('p')
  })
})

// ===========================================================================
// 4/5/6/7 — the two D-18 signed UPDATE transitions + the forbidden skip
// ===========================================================================

describe('AssociationRequest schema: D-18 challenge-echo + decision transitions', () => {
  it("UPDATE 'p' -> 'c' with a matching vrg AdminSignature succeeds and persists ChallengeNonce", async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const { id } = await seedAssociationRequest(auth)
    const challengeNonce = crypto.randomUUID()

    await issueChallengeTransition(auth, id, challengeNonce)

    const row = await auth.ctx.db
      .prepare('select Status, ChallengeNonce from AssociationRequest where Id = :id')
      .get({ id })
    expect(row?.Status).to.equal('c')
    expect(row?.ChallengeNonce).to.equal(challengeNonce)
  })

  it("rejects UPDATE 'p' -> 'c' with NO signing nonce", async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const { id } = await seedAssociationRequest(auth)
    const challengeNonce = crypto.randomUUID()

    let caught: unknown
    try {
      await issueChallengeTransition(auth, id, challengeNonce, { skipSigningNonce: true })
    } catch (err) {
      caught = err
    }
    expect(caught, "UPDATE must throw: 'p' -> 'c' with no AdminSignature under SigningNonce").to.be.instanceOf(Error)

    const row = await auth.ctx.db.prepare('select Status, ChallengeNonce from AssociationRequest where Id = :id').get({ id })
    expect(row?.Status, 'Status must remain unchanged after the rejected transition').to.equal('p')
    expect(row?.ChallengeNonce).to.equal(null)
  })

  it("rejects UPDATE 'p' -> 'a' (skipping the 'c' challenge-echo transition)", async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const { id } = await seedAssociationRequest(auth)

    let caught: unknown
    try {
      await decideAssociationRequest(auth, id, 'a', null)
    } catch (err) {
      caught = err
    }
    expect(caught, "UPDATE must throw: 'p' -> 'a' skip is rejected — TransitionValid's decision clause requires old.Status = 'c'").to.be.instanceOf(Error)

    const row = await auth.ctx.db.prepare('select Status from AssociationRequest where Id = :id').get({ id })
    expect(row?.Status).to.equal('p')
  })

  it("UPDATE 'c' -> 'a' with a matching vrg AdminSignature succeeds", async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const { id } = await seedAssociationRequest(auth)
    const challengeNonce = crypto.randomUUID()
    await issueChallengeTransition(auth, id, challengeNonce)

    await decideAssociationRequest(auth, id, 'a', null)

    const row = await auth.ctx.db
      .prepare('select Status, DecidedAt, RejectionReason from AssociationRequest where Id = :id')
      .get({ id })
    expect(row?.Status).to.equal('a')
    expect(row?.DecidedAt).to.not.equal(null)
    expect(row?.RejectionReason).to.equal(null)
  })
})

// ===========================================================================
// 8 — NoDelete permanence
// ===========================================================================

describe('AssociationRequest schema: NoDelete (D-06 permanence)', () => {
  it('rejects a DELETE — a decided or pending request is a permanent, attributable record', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const { id } = await seedAssociationRequest(auth)

    let caught: unknown
    try {
      await auth.ctx.db.exec('delete from AssociationRequest where Id = :id', { id })
    } catch (err) {
      caught = err
    }
    expect(caught, 'DELETE must throw: NoDelete check on delete (false)').to.be.instanceOf(Error)

    const row = await auth.ctx.db.prepare('select count(*) as n from AssociationRequest where Id = :id').get({ id })
    expect(Number(row?.n)).to.equal(1)
  })
})

// ===========================================================================
// 9 — ElectionRecordValidityPolicy (D-12), mel-scoped MutationValid
// ===========================================================================

describe('ElectionRecordValidityPolicy schema (D-12)', () => {
  /** Resolve the single Election row seeded by addTestElection() for this authority. */
  async function resolveElectionId (ctx: EngineContext, authorityId: string): Promise<string> {
    const row = await ctx.db.prepare('select Id from Election where AuthorityId = :authorityId limit 1').get({ authorityId })
    if (!row) throw new Error('resolveElectionId: Election not found for authority')
    return row.Id as string
  }

  it('inserts under a mel-scoped ceremony; the same insert under vrg is rejected', async () => {
    const auth = await addTestElection(await addTestAuthority(await createTestNetwork()))
    const electionId = await resolveElectionId(auth.ctx, auth.authority.id)

    // --- positive: mel-scoped ceremony succeeds ---
    const tid = Date.now()
    const registrantValidityDays = 365
    const associationValidityDays = 180
    // ElectionRecordValidityPolicy.MutationValid's Digest(...) argument order, field for field:
    //   Digest(context.Tid, new.ElectionId, new.RegistrantValidityDays, new.AssociationValidityDays)
    const digestExpr = 'select Digest(:tid, :electionId, :registrantValidityDays, :associationValidityDays) as d'
    const digestParams = { tid, electionId, registrantValidityDays, associationValidityDays }
    const { nonce } = await seedSignedMutationFixture(auth.ctx, auth.authority.id, 'mel', tid, digestExpr, digestParams, auth.user)

    await auth.ctx.db.exec(
      `insert into ElectionRecordValidityPolicy (ElectionId, RegistrantValidityDays, AssociationValidityDays)
       with context SigningNonce = :nonce, Tid = ${tid}
       values (:electionId, :registrantValidityDays, :associationValidityDays)`,
      { electionId, registrantValidityDays, associationValidityDays, nonce }
    )

    const row = await auth.ctx.db
      .prepare('select RegistrantValidityDays, AssociationValidityDays from ElectionRecordValidityPolicy where ElectionId = :electionId')
      .get({ electionId })
    expect(Number(row?.RegistrantValidityDays)).to.equal(registrantValidityDays)
    expect(Number(row?.AssociationValidityDays)).to.equal(associationValidityDays)

    // --- negative: the SAME insert shape signed under 'vrg' (wrong scope) is rejected ---
    // Re-attempting on the SAME election would collide on the PK before scope is even checked, so
    // a fresh election is used here — MutationValid's scope clause is genuinely what rejects
    // this, not a duplicate-PK error.
    const secondAuth = await addTestElection(await addTestAuthority(await createTestNetwork()))
    const secondElectionId = await resolveElectionId(secondAuth.ctx, secondAuth.authority.id)
    const tid2 = Date.now() + 1
    const digestExpr2 = 'select Digest(:tid, :electionId, :registrantValidityDays, :associationValidityDays) as d'
    const digestParams2 = { tid: tid2, electionId: secondElectionId, registrantValidityDays, associationValidityDays }
    const { nonce: wrongNonce } = await seedSignedMutationFixture(
      secondAuth.ctx,
      secondAuth.authority.id,
      'vrg',
      tid2,
      digestExpr2,
      digestParams2,
      secondAuth.user
    )

    let caught: unknown
    try {
      await secondAuth.ctx.db.exec(
        `insert into ElectionRecordValidityPolicy (ElectionId, RegistrantValidityDays, AssociationValidityDays)
         with context SigningNonce = :nonce, Tid = ${tid2}
         values (:electionId, :registrantValidityDays, :associationValidityDays)`,
        { electionId: secondElectionId, registrantValidityDays, associationValidityDays, nonce: wrongNonce }
      )
    } catch (err) {
      caught = err
    }
    expect(caught, "expected the vrg-scoped ceremony to be rejected by ElectionRecordValidityPolicy.MutationValid (requires 'mel')").to.be.instanceOf(Error)

    const secondRow = await secondAuth.ctx.db
      .prepare('select count(*) as n from ElectionRecordValidityPolicy where ElectionId = :electionId')
      .get({ electionId: secondElectionId })
    expect(Number(secondRow?.n)).to.equal(0)
  })
})
