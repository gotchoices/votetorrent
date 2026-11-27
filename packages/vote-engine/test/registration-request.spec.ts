/**
 * registration-request.spec.ts — Phase 48 Plan 04 (D-02, D-03, D-05)
 *
 * Drives the REAL Quereus schema landed by 48-02 through raw SQL — no engine method exists yet
 * at wave 3 (`RegistrationEngine.submitRegistrationRequest` / `registerBridgeKey` and the
 * `'registrant'` `SignatureTasksEngine` branch land in 48-07/48-11, both AFTER this plan). This
 * file is deliberately scheduled EARLY to resolve RESEARCH Pitfall 2 / assumption A4 — whether a
 * `SignatureType='registrant'` Task can even be inserted — before any ceremony, transport, or
 * screen work is built on top of it.
 *
 * Covers:
 *   (a) D-05 / A4 — a 'registrant' Task + RegistrantSignatureTaskExtension pairing COMMITS.
 *   (b) D-05 regression — the amended Task.ExtensionExists still rejects all six pre-existing
 *       pairings, plus a crossed pairing.
 *   (c) D-02 — RegistrationRequest.SignatureValid accepts a genuine requester signature from a
 *       key with no User row, and rejects tampering.
 *   (d) D-03 — BridgeIdValid accepts a registered bridge key only, and machine-distinguishes a
 *       bridge assertion from a registrant's own act.
 *
 * ESCALATION RULE (carried verbatim from the plan): if the FIRST test below
 * ("commits a Task with SignatureType='registrant' ...") fails, RESEARCH assumption A4 is
 * REFUTED — this is a BLOCKING FINDING for the phase, not a test bug. Do NOT weaken the
 * assertion, do NOT add `.skip`, and do NOT edit `votetorrent.qsql`, `schema-sql.ts`, or any
 * engine source to make it pass. Record the exact Quereus error, the failing SQL, and the
 * `view SignatureType` row ordering in the plan SUMMARY under a `## BLOCKING FINDING` heading and
 * stop the plan there.
 */

import 'reflect-metadata'
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { createTestNetwork, addTestAuthority, seedSignedMutation, makeTestSignature, makeTestSignCallback, provisionTestIntakeRecipient } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import type { TestKeyPair } from './fixtures/keys.js'
import { digestToBytes, nowCanonicalDatetime } from '../src/utils.js'
import { toIsoZDatetime, reZuluDatetime, restoreCanonicalDatetime } from '../src/signing/ceremony-helpers.js'
import { addSiblingAuthority } from './fixtures/test-context.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import type { EngineContext } from '../src/types.js'
import type { RegisterInit, RegistrationBridgeKeyInit, RegistrationRequestInit, Signature } from '@votetorrent/vote-core'

type TestAuthority = Awaited<ReturnType<typeof addTestAuthority>>

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * WR-10 prehash contract: `secp256k1.sign(bytes, priv)` with NO explicit `prehash` option relies
 * on @noble/curves v2's default (`prehash:true`) — identical to `authority-transport.spec.ts:31-40`.
 * Any divergence from this exact call shape diverges from every other verifier in the codebase.
 *
 * Deliberately returns a bare hex signature string, not a `Signature` object — a prospective
 * registrant has no `signerUserId`, which is the D-02 point this whole spec exists to prove.
 */
function makeRequesterSigner (): { publicHex: string; signDigest: (digestBase64url: string) => string } {
  const { privateHex, publicHex } = randomTestKeyPair()
  const privBytes = hexToBytes(privateHex)
  const signDigest = (digestBase64url: string): string => {
    const digestBytes = digestToBytes(digestBase64url)
    return bytesToHex(secp256k1.sign(digestBytes, privBytes))
  }
  return { publicHex, signDigest }
}

interface SeedRegistrationRequestOverrides {
  /** External signer to use instead of a freshly-generated one — e.g. a registered bridge key. */
  signer?: { publicHex: string; signDigest: (digestBase64url: string) => string }
  issuerType?: string
  bridgeId?: string | null
  /** Deliberately bind a RequesterKey different from whoever actually signed — wrong-key negative tests. */
  requesterKey?: string
  /** Deliberately bind a RequesterSignature that was not produced over the row's own digest — tamper negative tests. */
  signature?: string
  payload?: string
  payloadCid?: string
}

interface SeedRegistrationRequestResult {
  id: string
  requesterKey: string
  signer: { publicHex: string; signDigest: (digestBase64url: string) => string }
}

/**
 * Insert one `RegistrationRequest` row by raw SQL (D-02: no `User` FK, no `IsUserValid`, no
 * officer ceremony required to submit). `overrides` lets Task 3's negative cases substitute a
 * single field without duplicating this helper.
 */
async function seedRegistrationRequest (
  auth: TestAuthority,
  overrides?: SeedRegistrationRequestOverrides
): Promise<SeedRegistrationRequestResult> {
  const authorityId = auth.authority.id
  const id = crypto.randomUUID()
  const signer = overrides?.signer ?? makeRequesterSigner()
  const requesterKey = overrides?.requesterKey ?? signer.publicHex
  const issuerType = overrides?.issuerType ?? 'registrant'
  const bridgeId = overrides?.bridgeId === undefined ? null : overrides.bridgeId
  // A minimal RegisterInit-shaped payload is sufficient — this plan asserts CHECK behaviour, not
  // payload semantics.
  const payload = overrides?.payload ?? JSON.stringify({ registrant: { authorityId, note: 'test-payload' } })
  // SubmittedAt is submitter-supplied and inside the SignatureValid digest (L-3) — must be written
  // with the Z-emitting helper the schema's `like('%Z', SubmittedAt)` CHECK requires.
  const submittedAt = toIsoZDatetime(Date.now())

  let payloadCid = overrides?.payloadCid
  if (payloadCid === undefined) {
    const cidRow = await auth.ctx.db.prepare('select Digest(:payload) as d').get({ payload })
    if (!cidRow || cidRow.d == null) throw new Error('seedRegistrationRequest: PayloadCid Digest() returned null')
    payloadCid = cidRow.d as string
  }

  let requesterSignature = overrides?.signature
  if (requesterSignature === undefined) {
    // RegistrationRequest.SignatureValid's Digest(...) argument order, field for field:
    //   Digest(Id, AuthorityId, RequesterKey, IssuerType, BridgeId, PayloadCid, SubmittedAt)
    const digestRow = await auth.ctx.db
      .prepare('select Digest(:id, :authorityId, :requesterKey, :issuerType, :bridgeId, :payloadCid, :submittedAt) as d')
      .get({ id, authorityId, requesterKey, issuerType, bridgeId, payloadCid, submittedAt })
    if (!digestRow || digestRow.d == null) throw new Error('seedRegistrationRequest: SignatureValid Digest() returned null')
    requesterSignature = signer.signDigest(digestRow.d as string)
  }

  // ReceivedAt is the authority's OWN observation of intake time — engine-written, inside NO
  // digest at all (distinct from SubmittedAt).
  const receivedAt = toIsoZDatetime(Date.now())

  await auth.ctx.db.exec(
    `insert into RegistrationRequest (
      Id, AuthorityId, RequesterKey, IssuerType, BridgeId, Payload, PayloadCid, SubmittedAt, ReceivedAt, RequesterSignature
    )
    with context SigningNonce = null, Tid = :tid
    values (:id, :authorityId, :requesterKey, :issuerType, :bridgeId, :payload, :payloadCid, :submittedAt, :receivedAt, :requesterSignature)`,
    { id, authorityId, requesterKey, issuerType, bridgeId, payload, payloadCid, submittedAt, receivedAt, requesterSignature, tid: Date.now() }
  )

  return { id, requesterKey, signer }
}

/**
 * BEGIN -> Task insert (SignatureType='registrant') -> RegistrantSignatureTaskExtension insert ->
 * COMMIT, copied structurally from `signing.spec.ts:806-828`'s `seedSignatureTask`. The extension
 * row's MutationValid requires a matching UNSIGNED AdminSigning row (scope 'vrg') whose Digest
 * reproduces `RegistrantSignatureTaskExtension.MutationValid`'s own
 * `Digest(context.Tid, R.Id, R.AuthorityId, R.RequesterKey, R.IssuerType, R.BridgeId, R.PayloadCid, R.SubmittedAt)`
 * formula over the seeded `RegistrationRequest`'s own columns — seeded with
 * `IsPlaceholderSignature = true` and WITHOUT calling `SigningEngine.sign()`, because the
 * extension's `not exists (... AdminSignature ...)` clause requires no `AdminSignature` to exist
 * yet at extension-insert time.
 */
async function seedRegistrantTask (auth: TestAuthority, requestId: string): Promise<{ taskId: string; nonce: string }> {
  const reqRow = await auth.ctx.db
    .prepare('select Id, AuthorityId, RequesterKey, IssuerType, BridgeId, PayloadCid, SubmittedAt from RegistrationRequest where Id = :id')
    .get({ id: requestId })
  if (!reqRow) throw new Error('seedRegistrantTask: RegistrationRequest not found')

  const sig = makeTestSignature(auth.user)
  const nonce = crypto.randomUUID()
  const taskId = crypto.randomUUID()
  // Same tid value used in the AdminSigning digest AND both `with context Tid` bindings below.
  const tid = Date.now()

  const adminRow = await auth.ctx.db
    .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
    .get({ authorityId: auth.authority.id })
  if (!adminRow) throw new Error('seedRegistrantTask: CurrentAdmin not found')
  const adminEffectiveAt = adminRow.EffectiveAt as string

  await auth.ctx.db.exec(
    `insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
     with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = true
     values (:nonce, :authorityId, :adminEffectiveAt, 'vrg',
             Digest(:tid, :reqId, :reqAuthorityId, :reqRequesterKey, :reqIssuerType, :reqBridgeId, :reqPayloadCid, :reqSubmittedAt),
             :userId, :signerKey, :signature)`,
    {
      nonce,
      authorityId: auth.authority.id,
      adminEffectiveAt,
      tid,
      reqId: reqRow.Id as string,
      reqAuthorityId: reqRow.AuthorityId as string,
      reqRequesterKey: reqRow.RequesterKey as string,
      reqIssuerType: reqRow.IssuerType as string,
      reqBridgeId: reqRow.BridgeId as string | null,
      reqPayloadCid: reqRow.PayloadCid as string,
      reqSubmittedAt: reqRow.SubmittedAt as string,
      userId: sig.signerUserId,
      signerKey: sig.signerKey,
      signature: sig.signature,
      now: nowCanonicalDatetime(),
    }
  )

  // Step: Task + RegistrantSignatureTaskExtension in one explicit transaction so the deferred
  // ExtensionExists (on Task) and TaskIdValid (on the extension) see each other at COMMIT.
  await auth.ctx.db.exec('BEGIN')
  try {
    await auth.ctx.db.exec(
      `insert into Task (Id, UserId, Type, SignatureType, SigningNonce, IsCompleted)
       with context IsMutationValid = true, Tid = :tid
       values (:id, :userId, 'signature', 'registrant', :nonce, 0)`,
      { id: taskId, userId: auth.user.id, nonce, tid }
    )
    await auth.ctx.db.exec(
      `insert into RegistrantSignatureTaskExtension (TaskId, RequestId)
       with context Tid = :tid
       values (:taskId, :requestId)`,
      { taskId, requestId, tid }
    )
    await auth.ctx.db.exec('COMMIT')
  } catch (err) {
    await auth.ctx.db.exec('ROLLBACK')
    throw err
  }

  return { taskId, nonce }
}

// ---------------------------------------------------------------------------
// (a) D-05 / A4 — the ambiguity-killer
// ---------------------------------------------------------------------------

describe("registration-request schema: ExtensionExists 'registrant' pairing (D-05)", () => {
  // ESCALATION RULE: see the file header. A failure here is a BLOCKING FINDING for the phase, not
  // a test bug — do not weaken this assertion, skip it, or edit schema/engine source to pass it.
  it("commits a Task with SignatureType='registrant' alongside a matching RegistrantSignatureTaskExtension row — quereus#21's 'only the first view row matches' comment does not block a 7th SignatureType", async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const { id: requestId } = await seedRegistrationRequest(auth)
    const { taskId } = await seedRegistrantTask(auth, requestId)

    // A4 is proven by row-count SELECTs, not by absence of a thrown error — a "silent rejection"
    // (quereus#21's failure mode) would still let COMMIT succeed while inserting zero rows.
    const taskRow = await auth.ctx.db
      .prepare(`select count(*) as n from Task where Id = :id and SignatureType = 'registrant'`)
      .get({ id: taskId })
    expect(Number(taskRow?.n), "A4: Task row with SignatureType='registrant' must exist post-COMMIT").to.equal(1)

    const extRow = await auth.ctx.db
      .prepare('select count(*) as n from RegistrantSignatureTaskExtension where TaskId = :taskId and RequestId = :requestId')
      .get({ taskId, requestId })
    expect(Number(extRow?.n), 'A4: RegistrantSignatureTaskExtension row must exist post-COMMIT').to.equal(1)
  })

  it("rejects a Task with SignatureType='registrant' and no extension row", async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const taskId = crypto.randomUUID()
    const nonce = crypto.randomUUID()
    const tid = Date.now()

    let caught: unknown
    await auth.ctx.db.exec('BEGIN')
    try {
      await auth.ctx.db.exec(
        `insert into Task (Id, UserId, Type, SignatureType, SigningNonce, IsCompleted)
         with context IsMutationValid = true, Tid = :tid
         values (:id, :userId, 'signature', 'registrant', :nonce, 0)`,
        { id: taskId, userId: auth.user.id, nonce, tid }
      )
      await auth.ctx.db.exec('COMMIT')
    } catch (err) {
      caught = err
      await auth.ctx.db.exec('ROLLBACK')
    }

    expect(caught, 'COMMIT must throw: SignatureType=registrant Task with no extension row').to.be.instanceOf(Error)
    const taskRow = await auth.ctx.db.prepare('select count(*) as n from Task where Id = :id').get({ id: taskId })
    expect(Number(taskRow?.n)).to.equal(0)
    const extRow = await auth.ctx.db
      .prepare('select count(*) as n from RegistrantSignatureTaskExtension where TaskId = :id')
      .get({ id: taskId })
    expect(Number(extRow?.n)).to.equal(0)
  })
})

// ---------------------------------------------------------------------------
// (b) D-05 regression — the six pre-existing ExtensionExists pairings
// ---------------------------------------------------------------------------

/**
 * The six SignatureType<->extension-table pairings `Task.ExtensionExists` enumerated BEFORE 48-02's
 * amendment — cross-checked against the landed schema text (votetorrent.qsql:1012-1023) before
 * writing this list down. `'registrant'` is deliberately NOT included here — Task 1 owns that
 * pairing.
 */
const PRE_EXISTING_PAIRINGS: ReadonlyArray<{ signatureType: string; extensionTable: string }> = [
  { signatureType: 'network', extensionTable: 'NetworkSignatureTaskExtension' },
  { signatureType: 'authority', extensionTable: 'AuthoritySignatureTaskExtension' },
  { signatureType: 'admin', extensionTable: 'AdminSignatureTaskExtension' },
  { signatureType: 'election', extensionTable: 'ElectionSignatureTaskExtension' },
  { signatureType: 'election-revision', extensionTable: 'ElectionRevisionSignatureTaskExtension' },
  { signatureType: 'ballot', extensionTable: 'BallotSignatureTaskExtension' },
]

describe('registration-request schema: ExtensionExists pre-existing pairing regression (D-05)', () => {
  // 48-02 amended a CHECK on a LIVE table (Task.ExtensionExists). Proving the new 'registrant'
  // clause works (the describe block above) proves NOTHING about the six clauses that were
  // already there. Neither mocha nor jest exercises Quereus re-attach reconcile, so this suite is
  // the ONLY automated evidence that the amendment was additive rather than destructive. 48-02's
  // on-device proof covers reconcile, not semantics — these two legs are complementary, and
  // neither substitutes for the other.
  for (const { signatureType, extensionTable } of PRE_EXISTING_PAIRINGS) {
    it(`rejects a Task with SignatureType='${signatureType}' and no ${extensionTable} row`, async () => {
      const auth = await addTestAuthority(await createTestNetwork())
      const taskId = crypto.randomUUID()
      const nonce = crypto.randomUUID()
      const tid = Date.now()

      // No extension row and no AdminSigning row is needed here — the insert must fail on
      // ExtensionExists before anything downstream matters; keeping the setup minimal keeps the
      // failure attributable.
      let caught: unknown
      await auth.ctx.db.exec('BEGIN')
      try {
        await auth.ctx.db.exec(
          `insert into Task (Id, UserId, Type, SignatureType, SigningNonce, IsCompleted)
           with context IsMutationValid = true, Tid = :tid
           values (:id, :userId, 'signature', :signatureType, :nonce, 0)`,
          { id: taskId, userId: auth.user.id, signatureType, nonce, tid }
        )
        await auth.ctx.db.exec('COMMIT')
      } catch (err) {
        caught = err
        await auth.ctx.db.exec('ROLLBACK')
      }

      expect(caught, `COMMIT must throw: SignatureType='${signatureType}' has no matching ${extensionTable} row`).to.be.instanceOf(Error)
      const taskRow = await auth.ctx.db.prepare('select count(*) as n from Task where Id = :id').get({ id: taskId })
      expect(Number(taskRow?.n)).to.equal(0)
    })
  }

  it("rejects a mismatched pairing: a SignatureType='network' Task carrying an AdminSignatureTaskExtension row", async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const taskId = crypto.randomUUID()
    const nonce = crypto.randomUUID()
    const tid = Date.now()

    const adminRow = await auth.ctx.db
      .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
      .get({ authorityId: auth.authority.id })
    if (!adminRow) throw new Error('mismatched-pairing test: CurrentAdmin not found')
    const adminEffectiveAt = adminRow.EffectiveAt as string

    // Deliberately imprecise about WHICH constraint fires: AdminSignatureTaskExtension.TaskIdValid
    // (requires T.SignatureType = 'admin') AND Task.ExtensionExists (a 'network' Task requires a
    // NetworkSignatureTaskExtension row, not an Admin one) BOTH reject this insert. Asserting on
    // the specific constraint name would couple the test to Quereus error-message formatting — the
    // contract under test is "the pairing cannot be crossed", not "constraint X is the one that
    // objected".
    let caught: unknown
    await auth.ctx.db.exec('BEGIN')
    try {
      await auth.ctx.db.exec(
        `insert into Task (Id, UserId, Type, SignatureType, SigningNonce, IsCompleted)
         with context IsMutationValid = true, Tid = :tid
         values (:id, :userId, 'signature', 'network', :nonce, 0)`,
        { id: taskId, userId: auth.user.id, nonce, tid }
      )
      await auth.ctx.db.exec(
        `insert into AdminSignatureTaskExtension (TaskId, AuthorityId, AdminEffectiveAt)
         with context Tid = :tid
         values (:taskId, :authorityId, :adminEffectiveAt)`,
        { taskId, authorityId: auth.authority.id, adminEffectiveAt, tid }
      )
      await auth.ctx.db.exec('COMMIT')
    } catch (err) {
      caught = err
      await auth.ctx.db.exec('ROLLBACK')
    }

    expect(caught, 'COMMIT must throw: a network Task cannot carry an AdminSignatureTaskExtension row').to.be.instanceOf(Error)
    const taskRow = await auth.ctx.db.prepare('select count(*) as n from Task where Id = :id').get({ id: taskId })
    expect(Number(taskRow?.n)).to.equal(0)
    const extRow = await auth.ctx.db
      .prepare('select count(*) as n from AdminSignatureTaskExtension where TaskId = :id')
      .get({ id: taskId })
    expect(Number(extRow?.n)).to.equal(0)
  })
})

// ---------------------------------------------------------------------------
// (c) D-02 — RegistrationRequest self-signature
// ---------------------------------------------------------------------------

describe('registration-request schema: RegistrationRequest self-signature (D-02)', () => {
  it('accepts a genuine requester signature from a key that belongs to no User row', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const { id, requesterKey } = await seedRegistrationRequest(auth)

    const row = await auth.ctx.db.prepare('select count(*) as n from RegistrationRequest where Id = :id').get({ id })
    expect(Number(row?.n), 'RegistrationRequest row must exist post-insert').to.equal(1)

    // D-02's decisive claim: this signature verifies under the supplied key, with NO requirement
    // that the key belong to a known User. UserKey is the table that would carry the FK from a
    // key to a User row (see fixtures/test-context.ts's makeTestUser) — its absence here is what
    // proves the requester key belongs to no User, not merely that a signature verified. This is
    // also the first table in the schema where the `SignatureValid(Digest(...), Signature, Key)`
    // shape validates an untrusted EXTERNAL party's key rather than the authority's own signor
    // (48-PATTERNS.md's Registrant analog caveat).
    // NOTE: `:key` collides with Quereus's contextual keyword `key` — bind as `:pubKey` instead.
    const userKeyRow = await auth.ctx.db.prepare('select count(*) as n from UserKey where PubKey = :pubKey').get({ pubKey: requesterKey })
    expect(Number(userKeyRow?.n), 'D-02: requester key must NOT belong to any User (no UserKey row)').to.equal(0)
  })

  it('rejects a row whose Payload was swapped after the digest was signed', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const authorityId = auth.authority.id
    const id = crypto.randomUUID()
    const signer = makeRequesterSigner()
    const requesterKey = signer.publicHex
    const issuerType = 'registrant'
    const bridgeId = null
    const submittedAt = toIsoZDatetime(Date.now())

    const payloadA = JSON.stringify({ registrant: { authorityId, note: 'payload-a' } })
    const payloadB = JSON.stringify({ registrant: { authorityId, note: 'payload-b' } })

    const cidARow = await auth.ctx.db.prepare('select Digest(:payload) as d').get({ payload: payloadA })
    if (!cidARow || cidARow.d == null) throw new Error('payload-swap test: Digest(payloadA) returned null')
    const payloadCidA = cidARow.d as string

    const cidBRow = await auth.ctx.db.prepare('select Digest(:payload) as d').get({ payload: payloadB })
    if (!cidBRow || cidBRow.d == null) throw new Error('payload-swap test: Digest(payloadB) returned null')
    const payloadCidB = cidBRow.d as string

    // Sign the digest over payload A's PayloadCid.
    const digestRow = await auth.ctx.db
      .prepare('select Digest(:id, :authorityId, :requesterKey, :issuerType, :bridgeId, :payloadCid, :submittedAt) as d')
      .get({ id, authorityId, requesterKey, issuerType, bridgeId, payloadCid: payloadCidA, submittedAt })
    if (!digestRow || digestRow.d == null) throw new Error('payload-swap test: SignatureValid Digest() returned null')
    const requesterSignature = signer.signDigest(digestRow.d as string)

    // INSERT with payload B and PayloadCid = Digest(B) — keeps PayloadCidValid satisfied so the
    // rejection is attributable to SignatureValid, not the cid check.
    let caught: unknown
    try {
      await auth.ctx.db.exec(
        `insert into RegistrationRequest (
          Id, AuthorityId, RequesterKey, IssuerType, BridgeId, Payload, PayloadCid, SubmittedAt, ReceivedAt, RequesterSignature
        )
        with context SigningNonce = null, Tid = :tid
        values (:id, :authorityId, :requesterKey, :issuerType, :bridgeId, :payload, :payloadCid, :submittedAt, :receivedAt, :requesterSignature)`,
        {
          id, authorityId, requesterKey, issuerType, bridgeId,
          payload: payloadB, payloadCid: payloadCidB, submittedAt,
          receivedAt: toIsoZDatetime(Date.now()), requesterSignature, tid: Date.now(),
        }
      )
    } catch (err) {
      caught = err
    }

    expect(caught, 'INSERT must throw: signature was over payload A, row carries payload B').to.be.instanceOf(Error)
    const row = await auth.ctx.db.prepare('select count(*) as n from RegistrationRequest where Id = :id').get({ id })
    expect(Number(row?.n)).to.equal(0)
  })

  it('rejects a signature produced by a key other than the RequesterKey column', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const authorityId = auth.authority.id
    const id = crypto.randomUUID()
    const signerX = makeRequesterSigner()
    const signerY = makeRequesterSigner()
    const issuerType = 'registrant'
    const bridgeId = null
    const payload = JSON.stringify({ registrant: { authorityId, note: 'wrong-key' } })
    const submittedAt = toIsoZDatetime(Date.now())

    const cidRow = await auth.ctx.db.prepare('select Digest(:payload) as d').get({ payload })
    if (!cidRow || cidRow.d == null) throw new Error('wrong-key test: Digest(payload) returned null')
    const payloadCid = cidRow.d as string

    // Sign the CORRECT digest with signer X's private key, while binding signer Y's publicHex
    // into RequesterKey.
    const digestRow = await auth.ctx.db
      .prepare('select Digest(:id, :authorityId, :requesterKey, :issuerType, :bridgeId, :payloadCid, :submittedAt) as d')
      .get({ id, authorityId, requesterKey: signerY.publicHex, issuerType, bridgeId, payloadCid, submittedAt })
    if (!digestRow || digestRow.d == null) throw new Error('wrong-key test: SignatureValid Digest() returned null')
    const requesterSignature = signerX.signDigest(digestRow.d as string)

    let caught: unknown
    try {
      await auth.ctx.db.exec(
        `insert into RegistrationRequest (
          Id, AuthorityId, RequesterKey, IssuerType, BridgeId, Payload, PayloadCid, SubmittedAt, ReceivedAt, RequesterSignature
        )
        with context SigningNonce = null, Tid = :tid
        values (:id, :authorityId, :requesterKey, :issuerType, :bridgeId, :payload, :payloadCid, :submittedAt, :receivedAt, :requesterSignature)`,
        {
          id, authorityId, requesterKey: signerY.publicHex, issuerType, bridgeId,
          payload, payloadCid, submittedAt,
          receivedAt: toIsoZDatetime(Date.now()), requesterSignature, tid: Date.now(),
        }
      )
    } catch (err) {
      caught = err
    }

    expect(caught, 'INSERT must throw: signature was produced by a key other than RequesterKey').to.be.instanceOf(Error)
    const row = await auth.ctx.db.prepare('select count(*) as n from RegistrationRequest where Id = :id').get({ id })
    expect(Number(row?.n)).to.equal(0)
  })
})

// ---------------------------------------------------------------------------
// (d) D-03 — bridge issuer binding
// ---------------------------------------------------------------------------

/**
 * Register a bridge key via the real `'vrg'`-scoped officer ceremony. This ceremony is an
 * OFFICER act (signed under scope 'vrg'), categorically different from the requester's own
 * self-signature above — `seedSignedMutation`/`signTestDigest` against the fixture `User` is
 * correct here. `digestParams` deliberately avoids `seedSignedMutation`'s reserved bind names
 * (`nonce`, `authorityId`, `adminEffectiveAt`, `scope`, `userId`, `signerKey`, `signature`, `now`)
 * by binding the row's own authority id as `authId`, not `authorityId`.
 */
async function seedBridgeKey (auth: TestAuthority, opts: { label: string; key: string }): Promise<{ id: string }> {
  const id = crypto.randomUUID()
  const authorityId = auth.authority.id
  const label = opts.label
  const bridgeKey = opts.key
  const revokedAt = null
  const tid = Date.now()

  // RegistrationBridgeKey.MutationValid's Digest(...) argument order, field for field:
  //   Digest(context.Tid, new.Id, new.AuthorityId, new.Label, new.BridgeKey, new.RevokedAt)
  const digestExpr = 'select Digest(:tid, :id, :authId, :label, :bridgeKey, :revokedAt) as d'
  const digestParams = { tid, id, authId: authorityId, label, bridgeKey, revokedAt }
  const { nonce } = await seedSignedMutation(auth.ctx, authorityId, 'vrg', tid, digestExpr, digestParams, auth.user)

  await auth.ctx.db.exec(
    `insert into RegistrationBridgeKey (Id, AuthorityId, Label, BridgeKey, RevokedAt)
     with context SigningNonce = :nonce, Tid = :tid
     values (:id, :authorityId, :label, :bridgeKey, :revokedAt)`,
    { id, authorityId, label, bridgeKey, revokedAt, nonce, tid }
  )

  return { id }
}

describe('registration-request schema: RegistrationRequest identity-column immutability (WR-08)', () => {
  it('rejects the coordinated re-signature attack: rewriting AuthorityId + RequesterKey + RequesterSignature together, with a digest that VERIFIES', async () => {
    // This is WR-08's attack verbatim, and the only shape that discriminates. SignatureValid is
    // deliberately UNQUALIFIED so it re-evaluates on UPDATE — but it verifies
    // Digest(Id, AuthorityId, RequesterKey, IssuerType, BridgeId, PayloadCid, SubmittedAt) against
    // RequesterSignature AND RequesterKey, both columns of the SAME row. Rewriting the identity
    // tuple and re-signing it with the ATTACKER's own key therefore SATISFIED SignatureValid, and
    // (with a 'vrg' AdminSignature at the new authority) DecisionValid too. Rewriting AuthorityId
    // was the last remaining way to move a request between authorities after intake — which is
    // exactly what the engine-side CR-02 refusal assumes cannot happen, since it compares the
    // payload against RegistrationRequest.AuthorityId.
    //
    // Single-column rewrites are NOT used as the assertion here: they break the digest and are
    // stopped by SignatureValid/PayloadCidValid first, so they would pass whether or not the
    // immutability constraints exist.
    const auth = await addTestAuthority(await createTestNetwork())
    const { id } = await seedRegistrationRequest(auth)

    const before = await auth.ctx.db
      .prepare(
        'select AuthorityId, RequesterKey, RequesterSignature, IssuerType, BridgeId, PayloadCid, SubmittedAt, ReceivedAt from RegistrationRequest where Id = :id'
      )
      .get({ id })
    expect(before, 'the seeded request must exist').to.not.be.undefined

    // A second REAL authority in the same db, so AuthorityIdValid cannot be what rejects this.
    const foreignAuthorityId = await addSiblingAuthority(auth, {
      name: 'WR-08 Sibling Authority',
      domainName: 'wr08-sibling.example.com',
    })

    // The attacker's own key, re-signing the REWRITTEN tuple. SubmittedAt/ReceivedAt are rebound to
    // their unchanged canonical values, exactly as both real decision ceremonies do — a partial
    // UPDATE that left them unbound would fail the unqualified SubmittedAtValid/ReceivedAtValid
    // CHECKs against a Z-stripped row reconstruction and make this test pass for the wrong reason.
    const attacker = makeRequesterSigner()
    const submittedAt = restoreCanonicalDatetime(before!.SubmittedAt as string)
    const receivedAt = restoreCanonicalDatetime(before!.ReceivedAt as string)
    const digestRow = await auth.ctx.db
      .prepare('select Digest(:id, :authorityId, :requesterKey, :issuerType, :bridgeId, :payloadCid, :submittedAt) as d')
      .get({
        id,
        authorityId: foreignAuthorityId,
        requesterKey: attacker.publicHex,
        issuerType: before!.IssuerType as string,
        bridgeId: before!.BridgeId as string | null,
        payloadCid: before!.PayloadCid as string,
        submittedAt,
      })
    if (!digestRow || digestRow.d == null) throw new Error('WR-08 test: Digest() returned null')
    const forgedSignature = attacker.signDigest(digestRow.d as string)

    let caught: unknown
    try {
      await auth.ctx.db.exec(
        `update RegistrationRequest
         with context SigningNonce = null, Tid = :tid
         set AuthorityId = :authorityId, RequesterKey = :requesterKey, RequesterSignature = :requesterSignature,
             SubmittedAt = :submittedAt, ReceivedAt = :receivedAt
         where Id = :id`,
        {
          id,
          authorityId: foreignAuthorityId,
          requesterKey: attacker.publicHex,
          requesterSignature: forgedSignature,
          submittedAt,
          receivedAt,
          tid: Date.now(),
        }
      )
    } catch (err) {
      caught = err
    }

    expect(caught, 'a coordinated, self-consistent re-signature must still be rejected').to.be.instanceOf(Error)
    expect(
      (caught as Error).message,
      'the rejection must come from an immutability constraint — SignatureValid cannot catch this, because the rewritten tuple verifies'
    ).to.include('Immutable')

    const after = await auth.ctx.db
      .prepare('select AuthorityId, RequesterKey, RequesterSignature from RegistrationRequest where Id = :id')
      .get({ id })
    expect(after?.AuthorityId, 'AuthorityId must be unchanged').to.equal(before!.AuthorityId)
    expect(after?.RequesterKey, 'RequesterKey must be unchanged').to.equal(before!.RequesterKey)
    expect(after?.RequesterSignature, 'RequesterSignature must be unchanged').to.equal(before!.RequesterSignature)
  })

  it('names the constraint: an AuthorityId rewrite re-signed by the ORIGINAL requester key is refused by AuthorityIdImmutable specifically', async () => {
    // The narrowest discriminating case, and the one that names the constraint. The ORIGINAL
    // requester re-signs the rewritten tuple with the SAME key, so RequesterKey and
    // RequesterSignature-vs-RequesterKey both stay coherent and SignatureValid PASSES — leaving
    // AuthorityIdImmutable as the only thing that can reject it. AuthorityId is the column the
    // engine-side CR-02 refusal directly depends on being immutable, since it compares the
    // requester-chosen payload authority against RegistrationRequest.AuthorityId.
    //
    // A rewrite WITHOUT re-signing is not used: it breaks the digest and is stopped by
    // SignatureValid first, which would prove nothing about immutability.
    const auth = await addTestAuthority(await createTestNetwork())
    const { id, signer } = await seedRegistrationRequest(auth)
    const foreignAuthorityId = await addSiblingAuthority(auth, {
      name: 'WR-08 Second Sibling',
      domainName: 'wr08-sibling-2.example.com',
    })
    const before = await auth.ctx.db
      .prepare('select RequesterKey, IssuerType, BridgeId, PayloadCid, SubmittedAt, ReceivedAt from RegistrationRequest where Id = :id')
      .get({ id })
    const submittedAt = restoreCanonicalDatetime(before!.SubmittedAt as string)
    const receivedAt = restoreCanonicalDatetime(before!.ReceivedAt as string)

    const digestRow = await auth.ctx.db
      .prepare('select Digest(:id, :authorityId, :requesterKey, :issuerType, :bridgeId, :payloadCid, :submittedAt) as d')
      .get({
        id,
        authorityId: foreignAuthorityId,
        requesterKey: before!.RequesterKey as string,
        issuerType: before!.IssuerType as string,
        bridgeId: before!.BridgeId as string | null,
        payloadCid: before!.PayloadCid as string,
        submittedAt,
      })
    if (!digestRow || digestRow.d == null) throw new Error('WR-08 test: Digest() returned null')
    const reSignature = signer.signDigest(digestRow.d as string)

    let caught: unknown
    try {
      await auth.ctx.db.exec(
        `update RegistrationRequest
         with context SigningNonce = null, Tid = :tid
         set AuthorityId = :authorityId, RequesterSignature = :requesterSignature,
             SubmittedAt = :submittedAt, ReceivedAt = :receivedAt
         where Id = :id`,
        {
          id,
          authorityId: foreignAuthorityId,
          requesterSignature: reSignature,
          submittedAt,
          receivedAt,
          tid: Date.now(),
        }
      )
    } catch (err) {
      caught = err
    }
    expect(caught, 'rewriting AuthorityId must be rejected even when the digest verifies').to.be.instanceOf(Error)
    expect((caught as Error).message).to.include('Immutable')
  })
})

describe('registration-request schema: RegistrationRequest bridge issuer binding (D-03)', () => {
  it('accepts an IssuerType=bridge row whose BridgeId resolves to a registered RegistrationBridgeKey with a matching Key', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const bridgeSigner = makeRequesterSigner()
    const { id: bridgeId } = await seedBridgeKey(auth, { label: 'Legacy Roll Importer', key: bridgeSigner.publicHex })

    const { id } = await seedRegistrationRequest(auth, { signer: bridgeSigner, issuerType: 'bridge', bridgeId })

    const row = await auth.ctx.db
      .prepare('select IssuerType, BridgeId from RegistrationRequest where Id = :id')
      .get({ id })
    expect(row, 'RegistrationRequest row must exist post-insert').to.not.be.undefined
    // D-03: the marker's persistence is the assertion, not just the insert's success — a bridge
    // assertion must be machine-distinguishable at the data layer, not merely in the UI.
    expect(row?.IssuerType).to.equal('bridge')
    expect(row?.BridgeId).to.equal(bridgeId)
  })

  it('rejects an IssuerType=bridge row whose BridgeId is not a registered RegistrationBridgeKey', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const bridgeSigner = makeRequesterSigner()
    const unregisteredBridgeId = crypto.randomUUID()

    // Threat: an unregistered bridge key submitting bulk rows would be an unbounded trust anchor
    // (T-48-04-02) — bridge keys must be a bounded, authority-registered set.
    let caught: unknown
    try {
      await seedRegistrationRequest(auth, { signer: bridgeSigner, issuerType: 'bridge', bridgeId: unregisteredBridgeId })
    } catch (err) {
      caught = err
    }
    expect(caught, 'INSERT must throw: BridgeId does not resolve to a registered RegistrationBridgeKey').to.be.instanceOf(Error)
  })

  it('rejects an IssuerType=registrant row carrying a non-null BridgeId', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const bogusBridgeId = crypto.randomUUID()

    // Threat: a bridge assertion masquerading as a voter's own cryptographically attributed act
    // (RESEARCH's Security Domain Spoofing threat; T-48-04-01) — a genuinely self-signed request
    // must not be able to also carry a BridgeId.
    let caught: unknown
    try {
      await seedRegistrationRequest(auth, { issuerType: 'registrant', bridgeId: bogusBridgeId })
    } catch (err) {
      caught = err
    }
    expect(caught, 'INSERT must throw: a registrant-issued row cannot carry a BridgeId').to.be.instanceOf(Error)
  })
})

// ---------------------------------------------------------------------------
// 48-07 — engine-level round-trips (D-02, D-03, D-04)
// ---------------------------------------------------------------------------

describe('registration-request engine: intake and bridge-key registry', () => {
  // 48-04 (above) proved the CHECKs through raw SQL — no engine method existed at wave 3. These
  // tests prove the ENGINE METHODS (submitRegistrationRequest / registerBridgeKey / listBridgeKeys)
  // drive those same CHECKs correctly through REAL secp256k1 signatures, for both issuer types,
  // for both signing modes (callback and pre-resolved), and across the skew window's boundaries.

  /**
   * A digest-bytes -> Signature callback for submitRegistrationRequest's callback-signer path.
   * The empty `signerUserId` is deliberate and is the D-02 point under test: a prospective
   * registrant has no user id, the field is a type artifact on this path, and the engine must
   * NEVER read it (Task 1's grep gate enforces the engine side of this).
   */
  function makeCallbackSigner (keyPair: TestKeyPair): (digest: Uint8Array) => Promise<Signature> {
    const privBytes = hexToBytes(keyPair.privateHex)
    return async (digest: Uint8Array): Promise<Signature> => {
      // WR-10: two-argument secp256k1.sign(digest, priv) — no explicit prehash option, relying on
      // @noble/curves v2's prehash:true default (matches authority-transport.spec.ts:31-40).
      const sig = secp256k1.sign(digest, privBytes)
      return { signature: bytesToHex(sig), signerKey: keyPair.publicHex, signerUserId: '' }
    }
  }

  /**
   * Computes the DG-1 digest INDEPENDENTLY of the engine — exactly as an injected `RequestDigestFn`
   * in a real transport binding would (48-09/48-10). Duplicating the expression here is the POINT,
   * not a smell: it demonstrates that a party which never sees the engine can reproduce the signed
   * bytes, which is the whole claim tests 6-8 depend on.
   */
  async function stagingDigest (
    ctx: EngineContext,
    init: { id: string; authorityId: string; payload: RegisterInit; submittedAt: string; issuerType?: string; bridgeId?: string | null },
    requesterKey: string
  ): Promise<Uint8Array> {
    const payload = JSON.stringify(init.payload)
    const payloadCidRow = await ctx.db.prepare('select Digest(:payload) as d').get({ payload })
    if (!payloadCidRow || payloadCidRow.d == null) throw new Error('stagingDigest: PayloadCid Digest() returned null')
    const payloadCid = payloadCidRow.d as string
    const issuerType = init.issuerType ?? 'registrant'
    const bridgeId = init.bridgeId === undefined ? null : init.bridgeId
    const digestRow = await ctx.db
      .prepare('select Digest(:id, :authorityId, :requesterKey, :issuerType, :bridgeId, :payloadCid, :submittedAt) as d')
      .get({ id: init.id, authorityId: init.authorityId, requesterKey, issuerType, bridgeId, payloadCid, submittedAt: init.submittedAt })
    if (!digestRow || digestRow.d == null) throw new Error('stagingDigest: SignatureValid Digest() returned null')
    return digestToBytes(digestRow.d as string)
  }

  /** Behavioral proof of the D-02 no-ceremony design — see test 1's load-bearing assertion. */
  async function countAdminSigning (ctx: EngineContext): Promise<number> {
    const row = await ctx.db.prepare('select count(*) as n from AdminSigning').get({})
    return Number(row?.n ?? 0)
  }

  /** Minimal, fully-typed RegisterInit payload — this suite asserts engine/CHECK behaviour, not payload semantics. */
  function makeTestPayload (authorityId: string): RegisterInit {
    return {
      registrant: { id: crypto.randomUUID(), authorityId, expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000) },
      private: { expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000), details: [] }
    }
  }

  function makeRequestInit (authorityId: string, overrides?: Partial<RegistrationRequestInit>): RegistrationRequestInit {
    return {
      id: crypto.randomUUID(),
      authorityId,
      payload: makeTestPayload(authorityId),
      submittedAt: toIsoZDatetime(Date.now()),
      ...overrides
    }
  }

  /**
   * Quereus's canonical stored form for a `datetime` column serializes fractional seconds at
   * MINIMAL precision — trailing zero digits dropped (`toIsoZDatetime`'s own doc comment) — even on
   * a plain, non-deferred read-back. Normalizes an expected ISO-Z string down to that same minimal
   * form before comparing it against a value read back off the row, so a millisecond value that
   * happens to end in `0` does not produce a false-negative byte-comparison failure.
   */
  function stripTrailingZeroMs (isoZ: string): string {
    let s = isoZ.replace(/Z$/, '')
    if (s.includes('.')) {
      s = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
    }
    return `${s}Z`
  }

  it('submits a registrant-issued request signed by a key that belongs to no User row, creating zero AdminSigning rows', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    await provisionTestIntakeRecipient(auth.ctx, auth.authority.id)
    const engine = new RegistrationEngine(auth.ctx)
    const requester = randomTestKeyPair()
    const init = makeRequestInit(auth.authority.id)

    const before = await countAdminSigning(auth.ctx)
    const returnedId = await engine.submitRegistrationRequest(init, requester.publicHex, makeCallbackSigner(requester))
    const after = await countAdminSigning(auth.ctx)

    expect(returnedId).to.equal(init.id)

    const row = await auth.ctx.db
      .prepare('select IssuerType, BridgeId, Status from RegistrationRequest where Id = :id')
      .get({ id: init.id })
    expect(row, 'RegistrationRequest row must exist post-call').to.not.be.undefined
    expect(row?.IssuerType).to.equal('registrant')
    expect(row?.BridgeId).to.equal(null)
    expect(row?.Status).to.equal('p')

    const userKeyRow = await auth.ctx.db.prepare('select count(*) as n from UserKey where PubKey = :pubKey').get({ pubKey: requester.publicHex })
    expect(Number(userKeyRow?.n), 'D-02: requester key must NOT belong to any User (no UserKey row)').to.equal(0)

    // LOAD-BEARING: the behavioral proof of D-02's no-ceremony design, complementing Task 1's grep
    // gate — a prospective registrant has no User row and no officer scope to seed a ceremony
    // against, and this call must not seed one on its own initiative either.
    expect(after, 'submitRegistrationRequest must create ZERO AdminSigning rows').to.equal(before)
  })

  it('submits a bridge-issued request under a registered bridge key, and the persisted IssuerType and BridgeId keep it machine-distinguishable from a self-submission', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    await provisionTestIntakeRecipient(auth.ctx, auth.authority.id)
    const engine = new RegistrationEngine(auth.ctx)
    const bridgeKeyPair = randomTestKeyPair()
    const bridgeInit: RegistrationBridgeKeyInit = {
      id: crypto.randomUUID(),
      authorityId: auth.authority.id,
      label: 'Legacy Roll Importer',
      key: bridgeKeyPair.publicHex
    }
    // Registering a bridge key is an authority act, signed under a 'vrg'-scoped AdminSigning
    // ceremony (D-03) — categorically different from the requester's own self-signature below.
    await engine.registerBridgeKey(bridgeInit, makeTestSignCallback(auth.user))

    const init = makeRequestInit(auth.authority.id, { issuerType: 'bridge', bridgeId: bridgeInit.id })
    const requestId = await engine.submitRegistrationRequest(init, bridgeKeyPair.publicHex, makeCallbackSigner(bridgeKeyPair))

    const row = await auth.ctx.db
      .prepare('select IssuerType, BridgeId from RegistrationRequest where Id = :id')
      .get({ id: requestId })
    // D-03's requirement is DATA-LAYER distinguishability — the markers' persistence is the
    // assertion under test, not merely the call's success.
    expect(row?.IssuerType).to.equal('bridge')
    expect(row?.BridgeId).to.equal(bridgeInit.id)

    const keys = await engine.listBridgeKeys(auth.authority.id)
    const found = keys.find((k) => k.id === bridgeInit.id)
    expect(found, 'listBridgeKeys must return the just-registered key').to.not.be.undefined
    expect(found?.key).to.equal(bridgeKeyPair.publicHex)
    expect(found?.label).to.equal('Legacy Roll Importer')
  })

  it('refuses a bridge-issued request whose BridgeId is not a registered bridge key', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    await provisionTestIntakeRecipient(auth.ctx, auth.authority.id)
    const engine = new RegistrationEngine(auth.ctx)
    const bridgeKeyPair = randomTestKeyPair()
    const unregisteredBridgeId = crypto.randomUUID()
    const init = makeRequestInit(auth.authority.id, { issuerType: 'bridge', bridgeId: unregisteredBridgeId })

    // Threat: an unregistered bridge key submitting bulk rows would be an unbounded trust anchor
    // (T-48-07-02) — bridge keys must be a bounded, authority-registered set.
    let caught: unknown
    try {
      await engine.submitRegistrationRequest(init, bridgeKeyPair.publicHex, makeCallbackSigner(bridgeKeyPair))
    } catch (err) {
      caught = err
    }
    expect(caught, 'submitRegistrationRequest must throw: BridgeId does not resolve to a registered RegistrationBridgeKey').to.be.instanceOf(Error)
    // D-49 (62-31): a recipient is provisioned above, so this must be the ORIGINAL BridgeIdValid
    // refusal, never IntakeError('no-recipients') firing first for the wrong reason.
    expect((caught as { name?: string }).name).to.not.equal('IntakeError')

    const row = await auth.ctx.db.prepare('select count(*) as n from RegistrationRequest where Id = :id').get({ id: init.id })
    expect(Number(row?.n)).to.equal(0)
  })

  it('refuses a registrant-issued request carrying a BridgeId', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    await provisionTestIntakeRecipient(auth.ctx, auth.authority.id)
    const engine = new RegistrationEngine(auth.ctx)
    const requester = randomTestKeyPair()
    const bogusBridgeId = crypto.randomUUID()
    const init = makeRequestInit(auth.authority.id, { issuerType: 'registrant', bridgeId: bogusBridgeId })

    // Threat: a bridge assertion masquerading as a voter's own cryptographically attributed act.
    // Deliberately agnostic about WHICH gate objects (the pre-flight guard or BridgeIdValid) — the
    // contract under test is that it cannot happen, not which layer stops it.
    let caught: unknown
    try {
      await engine.submitRegistrationRequest(init, requester.publicHex, makeCallbackSigner(requester))
    } catch (err) {
      caught = err
    }
    expect(caught, 'submitRegistrationRequest must throw: a registrant-issued row cannot carry a BridgeId').to.be.instanceOf(Error)
    // D-49 (62-31): a recipient is provisioned above, so this must be the ORIGINAL pre-flight
    // refusal, never IntakeError('no-recipients') firing first for the wrong reason.
    expect((caught as { name?: string }).name).to.not.equal('IntakeError')

    const row = await auth.ctx.db.prepare('select count(*) as n from RegistrationRequest where Id = :id').get({ id: init.id })
    expect(Number(row?.n)).to.equal(0)
  })

  it('registers a bridge key through one vrg-scoped AdminSigning ceremony', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    const bridgeKeyPair = randomTestKeyPair()
    const bridgeInit: RegistrationBridgeKeyInit = {
      id: crypto.randomUUID(),
      authorityId: auth.authority.id,
      label: 'Bulk Import Bridge',
      key: bridgeKeyPair.publicHex
    }

    const beforeVrg = await auth.ctx.db
      .prepare("select count(*) as n from AdminSigning where AuthorityId = :authorityId and Scope = 'vrg'")
      .get({ authorityId: auth.authority.id })
    await engine.registerBridgeKey(bridgeInit, makeTestSignCallback(auth.user))
    const afterVrg = await auth.ctx.db
      .prepare("select count(*) as n from AdminSigning where AuthorityId = :authorityId and Scope = 'vrg'")
      .get({ authorityId: auth.authority.id })

    // The new row was signed under a 'vrg'-scoped AdminSigning ceremony (T-48-07-09) — never
    // phrase this as "only a vrg officer can": AdminSigning.SignerKeyValid and
    // OfficerSignature.OfficerValid are hardcoded stub CHECKs, and AdminSigning.UserIdValid
    // requires only that the signer be SOME officer at that authority.
    expect(
      Number(afterVrg?.n) - Number(beforeVrg?.n),
      "registerBridgeKey must create exactly one 'vrg'-scoped AdminSigning row"
    ).to.equal(1)
  })

  it('accepts a pre-resolved offline signature: a submitter that signed at staging time, before the authority ever saw the request, verifies at INSERT', async () => {
    // THE direct proof that the offline courier path (48-09) is possible, and the reason 48-02's
    // L-3 exists. 48-04 drives raw SQL with a timestamp it chose itself, and test 1 above uses a
    // CALLBACK signer — the engine computes a digest and immediately asks the callback to sign it,
    // which sidesteps the offline case entirely. This is the ONLY test in the phase that exercises
    // the pre-resolved-signature path. If SubmittedAt ever reverts to being engine-generated, THIS
    // is the test that fails — in the plan that caused it, not a phase later inside a filesystem
    // binding.
    const auth = await addTestAuthority(await createTestNetwork())
    await provisionTestIntakeRecipient(auth.ctx, auth.authority.id)
    const engine = new RegistrationEngine(auth.ctx)
    const requester = randomTestKeyPair()
    const init = makeRequestInit(auth.authority.id)

    // Staging-time signing, entirely independent of the engine — exactly what the offline
    // filesystem courier (48-09) does.
    const digestBytes = await stagingDigest(auth.ctx, init, requester.publicHex)
    const resolvedSignature: Signature = {
      signature: bytesToHex(secp256k1.sign(digestBytes, hexToBytes(requester.privateHex))),
      signerKey: requester.publicHex,
      signerUserId: ''
    }

    const before = await countAdminSigning(auth.ctx)
    // The engine's ReceivedAt is provably a DIFFERENT instant from SubmittedAt.
    await new Promise((resolve) => setTimeout(resolve, 25))

    // Pass the resolved Signature VALUE, not a callback — resolveSign returns it verbatim, so the
    // engine has NO opportunity to re-sign anything a regenerated SubmittedAt would invalidate.
    const requestId = await engine.submitRegistrationRequest(init, requester.publicHex, resolvedSignature)
    const after = await countAdminSigning(auth.ctx)

    const row = await auth.ctx.db
      .prepare('select SubmittedAt, ReceivedAt from RegistrationRequest where Id = :id')
      .get({ id: requestId })
    // A plain SELECT of a `datetime` column comes back Z-stripped (T-42-06) — reZuluDatetime
    // re-stamps the exact stored wall-clock digits as UTC without re-parsing them.
    const submittedAtBack = reZuluDatetime(row?.SubmittedAt as string)
    const receivedAtBack = reZuluDatetime(row?.ReceivedAt as string)
    expect(submittedAtBack).to.equal(stripTrailingZeroMs(init.submittedAt))
    expect(receivedAtBack).to.match(/Z$/)
    expect(receivedAtBack).to.not.equal(submittedAtBack)
    expect(after, 'the pre-resolved offline path must also create ZERO AdminSigning rows').to.equal(before)
  })

  it('refuses a submittedAt outside the accepted skew window in either direction', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    await provisionTestIntakeRecipient(auth.ctx, auth.authority.id)
    const engine = new RegistrationEngine(auth.ctx)

    // Threat: submittedAt is attacker-controlled, and an unbounded value poisons D-09's median
    // time-to-decision and makes the audit record dishonest.
    const future = randomTestKeyPair()
    const futureInit = makeRequestInit(auth.authority.id, { submittedAt: toIsoZDatetime(Date.now() + 10 * 60 * 1000) })
    const futureDigest = await stagingDigest(auth.ctx, futureInit, future.publicHex)
    const futureSig: Signature = {
      signature: bytesToHex(secp256k1.sign(futureDigest, hexToBytes(future.privateHex))),
      signerKey: future.publicHex,
      signerUserId: ''
    }
    let futureCaught: unknown
    try {
      await engine.submitRegistrationRequest(futureInit, future.publicHex, futureSig)
    } catch (err) {
      futureCaught = err
    }
    expect(futureCaught, 'submitRegistrationRequest must throw: submittedAt 10 minutes in the future exceeds the +5-minute skew ceiling').to.be.instanceOf(Error)
    expect((futureCaught as { name?: string }).name).to.not.equal('IntakeError')
    const futureRow = await auth.ctx.db.prepare('select count(*) as n from RegistrationRequest where Id = :id').get({ id: futureInit.id })
    expect(Number(futureRow?.n)).to.equal(0)

    const past = randomTestKeyPair()
    const pastInit = makeRequestInit(auth.authority.id, { submittedAt: toIsoZDatetime(Date.now() - 60 * 24 * 60 * 60 * 1000) })
    const pastDigest = await stagingDigest(auth.ctx, pastInit, past.publicHex)
    const pastSig: Signature = {
      signature: bytesToHex(secp256k1.sign(pastDigest, hexToBytes(past.privateHex))),
      signerKey: past.publicHex,
      signerUserId: ''
    }
    let pastCaught: unknown
    try {
      await engine.submitRegistrationRequest(pastInit, past.publicHex, pastSig)
    } catch (err) {
      pastCaught = err
    }
    expect(pastCaught, 'submitRegistrationRequest must throw: submittedAt 60 days in the past exceeds the 30-day skew floor').to.be.instanceOf(Error)
    expect((pastCaught as { name?: string }).name).to.not.equal('IntakeError')
    const pastRow = await auth.ctx.db.prepare('select count(*) as n from RegistrationRequest where Id = :id').get({ id: pastInit.id })
    expect(Number(pastRow?.n)).to.equal(0)
  })

  it('accepts a submittedAt 60 seconds ahead of the authority clock, because honest device clocks drift', async () => {
    // REGRESSION GUARD on the tolerance itself: this project has a recorded failure where emulator
    // clocks ran ~45s BEHIND the host and expired consensus transactions (project memory: device
    // proof clock skew) — a bound tight enough to reject a minute of drift would reject honest
    // submissions on real hardware. A later "tighten the window" change has to argue with THIS
    // failing test, not with prose.
    const auth = await addTestAuthority(await createTestNetwork())
    await provisionTestIntakeRecipient(auth.ctx, auth.authority.id)
    const engine = new RegistrationEngine(auth.ctx)
    const requester = randomTestKeyPair()
    const init = makeRequestInit(auth.authority.id, { submittedAt: toIsoZDatetime(Date.now() + 60 * 1000) })

    const digestBytes = await stagingDigest(auth.ctx, init, requester.publicHex)
    const resolvedSignature: Signature = {
      signature: bytesToHex(secp256k1.sign(digestBytes, hexToBytes(requester.privateHex))),
      signerKey: requester.publicHex,
      signerUserId: ''
    }

    const requestId = await engine.submitRegistrationRequest(init, requester.publicHex, resolvedSignature)

    const row = await auth.ctx.db.prepare('select SubmittedAt from RegistrationRequest where Id = :id').get({ id: requestId })
    // T-42-06: a plain SELECT read-back of a `datetime` column is Z-stripped AND normalized to
    // minimal fractional-second precision.
    expect(reZuluDatetime(row?.SubmittedAt as string)).to.equal(stripTrailingZeroMs(init.submittedAt))
  })
})
