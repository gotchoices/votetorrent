/**
 * association-request.spec.ts — Phase 51 Plan 08 (D-01, D-02, D-18)
 *
 * Drives the REAL `AssociationEngine.submitAssociationRequest` / `submitAssociationAttestation`
 * methods (51-08) through real secp256k1/P-256 signers — never a stubbed `SignatureValid`. Mirrors
 * `registration-request.spec.ts`'s engine-round-trip describe block (48-07), which is THE analog
 * this file's structure copies: `makeCallbackSigner`, `stagingDigest`, `countAdminSigning`,
 * `stripTrailingZeroMs`, the datetime-flake normalization, and the offline-courier proof.
 *
 * `association-request-schema.spec.ts` (51-01) already proved the CHECK constraints through raw
 * SQL at wave 0 — no engine method existed yet. This file proves the ENGINE METHODS drive those
 * same CHECKs correctly, for both intake legs, for both signing modes (callback and pre-resolved),
 * across the skew window's boundaries, and (D-18) that `validateStagedAttestationAnswer` is a real,
 * load-bearing gate — proven by a forged-signature MUTATION, not a passing happy path alone.
 *
 * Covers (one `it()` per `<behavior>` bullet in 51-08-PLAN.md Tasks 1/2, plus Task 3's P-256 extra):
 *   submitAssociationRequest (D-02):
 *     1. self-submission by a key with no User row, creating ZERO AdminSigning rows.
 *     2. a signature produced over a different tuple is REJECTED at INSERT.
 *     3. a PRE-RESOLVED offline signature (never a callback) verifies at INSERT.
 *     4. submittedAt outside the skew window in EITHER direction is REJECTED.
 *     5. submittedAt 60 seconds ahead of the authority clock is ACCEPTED.
 *     6. a P-256 device key round-trips exactly as a secp256k1 key does.
 *   submitAssociationAttestation (D-18):
 *     7. stages an answer for a 'c'-status request, creating ZERO AdminSigning rows.
 *     8. writes NO Association/AssociationPrivate/AttestationVerdict row.
 *     9. rejects an answer whose nonce does not match the persisted ChallengeNonce.
 *     10. rejects an answer for a request whose Status is not 'c'.
 *     11. rejects a forged self-signature — proven by MUTATION (flip one byte of a signature that
 *         just verified, and assert the identical call now throws).
 *   MockAssociationEngine parity:
 *     12. both new methods never invoke `signatureOrCallback`.
 */

import 'reflect-metadata'
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { p256 } from '@noble/curves/nist.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { createTestNetwork, addTestAuthority, makeTestSignCallback } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import type { TestKeyPair } from './fixtures/keys.js'
import { makeP256TestKey } from './fixtures/p256-signer.js'
import { digestToBytes } from '../src/utils.js'
import { toIsoZDatetime, reZuluDatetime, restoreCanonicalDatetime } from '../src/signing/ceremony-helpers.js'
import { seedSignedMutation } from '../src/signing/signed-mutation.js'
import { AssociationEngine } from '../src/association/association-engine.js'
import { MockAssociationEngine } from '../src/association/mock-association-engine.js'
import type { EngineContext } from '../src/types.js'
import type { AssociationAttestationAnswer, AssociationRequestInit, DeviceAttestation, Signature } from '@votetorrent/vote-core'

type TestAuthority = Awaited<ReturnType<typeof addTestAuthority>>

// ---------------------------------------------------------------------------
// Module-level helpers — mirrors registration-request.spec.ts's engine-test block
// ---------------------------------------------------------------------------

/**
 * A digest-bytes -> Signature callback for submitAssociationRequest's callback-signer path
 * (secp256k1). The empty `signerUserId` is deliberate and is the D-02 point under test: a
 * prospective registrant's device has no user id, the field is a type artifact on this path, and
 * the engine must NEVER read it.
 */
function makeCallbackSigner (keyPair: TestKeyPair): (digest: Uint8Array) => Promise<Signature> {
  const privBytes = hexToBytes(keyPair.privateHex)
  return async (digest: Uint8Array): Promise<Signature> => {
    // WR-10: two-argument secp256k1.sign(digest, priv) — no explicit prehash option, relying on
    // @noble/curves v2's prehash:true default.
    const sig = secp256k1.sign(digest, privBytes)
    return { signature: bytesToHex(sig), signerKey: keyPair.publicHex, signerUserId: '' }
  }
}

/** Behavioral proof of the D-02 no-ceremony design (mirrors registration-request.spec.ts). */
async function countAdminSigning (ctx: EngineContext): Promise<number> {
  const row = await ctx.db.prepare('select count(*) as n from AdminSigning').get({})
  return Number(row?.n ?? 0)
}

async function countRows (ctx: EngineContext, table: string): Promise<number> {
  const row = await ctx.db.prepare(`select count(*) as n from ${table}`).get({})
  return Number(row?.n ?? 0)
}

/**
 * Quereus's canonical stored form for a `datetime` column serializes fractional seconds at
 * MINIMAL precision — trailing zero digits dropped — even on a plain, non-deferred read-back.
 * Normalizes an expected ISO-Z string down to that same minimal form before comparing it against a
 * value read back off the row, so a millisecond value ending in `0` does not produce a
 * false-negative byte-comparison failure (48-07's recorded flake).
 */
function stripTrailingZeroMs (isoZ: string): string {
  let s = isoZ.replace(/Z$/, '')
  if (s.includes('.')) {
    s = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  }
  return `${s}Z`
}

function makeRequestInit (authorityId: string, deviceKey: string, overrides?: Partial<AssociationRequestInit>): AssociationRequestInit {
  return {
    id: crypto.randomUUID(),
    authorityId,
    registrantId: crypto.randomUUID(),
    deviceKey,
    // A minute in the past (well inside the 30-day skew floor), never `Date.now()`: the
    // engine stamps its own ReceivedAt, and on a quiet host a same-millisecond submit made
    // `ReceivedAt !== SubmittedAt` fail intermittently.
    submittedAt: toIsoZDatetime(Date.now() - 60_000),
    ...overrides
  }
}

/**
 * Computes the DG-1-equivalent digest INDEPENDENTLY of the engine — exactly as an injected
 * offline courier binding (51-06) would. Duplicating the expression here is the POINT: it
 * demonstrates that a party which never sees the engine can reproduce the signed bytes, which is
 * the whole claim the offline-courier test depends on. Field order matches 51-01's landed
 * `AssociationRequest.SignatureValid` tuple exactly:
 *   Digest(Id, AuthorityId, RegistrantId, DeviceKey, ElectionId, SubmittedAt)
 */
async function stagingDigest (ctx: EngineContext, init: AssociationRequestInit): Promise<Uint8Array> {
  const digestRow = await ctx.db
    .prepare('select Digest(:id, :authorityId, :registrantId, :deviceKey, :electionId, :submittedAt) as d')
    .get({
      id: init.id,
      authorityId: init.authorityId,
      registrantId: init.registrantId,
      deviceKey: init.deviceKey,
      electionId: init.electionId ?? null,
      submittedAt: init.submittedAt
    })
  if (!digestRow || digestRow.d == null) throw new Error('stagingDigest: SignatureValid Digest() returned null')
  return digestToBytes(digestRow.d as string)
}

/**
 * Computes `validateStagedAttestationAnswer`'s own digest tuple INDEPENDENTLY of the engine —
 * field for field: Digest(RequestId, Nonce, AttestationJson, DeviceHash), where
 * AttestationJson = JSON.stringify(answer.attestation). Duplicating it here is what proves a
 * courier binding (not just the engine itself) can produce a verifiable answer signature.
 */
async function answerDigest (ctx: EngineContext, answer: AssociationAttestationAnswer): Promise<Uint8Array> {
  const attestationJson = JSON.stringify(answer.attestation)
  const digestRow = await ctx.db
    .prepare('select Digest(:requestId, :nonce, :attestationJson, :deviceHash) as d')
    .get({ requestId: answer.requestId, nonce: answer.nonce, attestationJson, deviceHash: answer.deviceHash ?? null })
  if (!digestRow || digestRow.d == null) throw new Error('answerDigest: Digest() returned null')
  return digestToBytes(digestRow.d as string)
}

function makeDeviceAttestation (overrides?: Partial<DeviceAttestation>): DeviceAttestation {
  return {
    publicKey: 'device-pubkey-test',
    deviceId: crypto.randomUUID(),
    attestationTime: Date.now(),
    certificateChain: ['cert-a', 'cert-b'],
    ...overrides
  }
}

/**
 * The D-18 challenge-echo transition, 'p' -> 'c', signed 'vrg' — mirrors
 * `association-request-schema.spec.ts`'s `issueChallengeTransition` exactly. Needed here because
 * `processPendingAssociationRequests` (51-09's driver, the method that would normally issue this
 * transition) is still a CONTRACT STUB at this plan — this spec seeds the transition itself via
 * raw SQL, the same way 51-01's schema spec did before ANY engine method existed.
 */
async function issueChallengeTransition (auth: TestAuthority, requestId: string, challengeNonce: string): Promise<void> {
  const ctx = auth.ctx
  const row = await ctx.db
    .prepare('select AuthorityId, SubmittedAt, ReceivedAt from AssociationRequest where Id = :id')
    .get({ id: requestId })
  if (!row) throw new Error('issueChallengeTransition: AssociationRequest not found')
  const authorityId = row.AuthorityId as string
  const submittedAt = restoreCanonicalDatetime(row.SubmittedAt as string)
  const receivedAt = restoreCanonicalDatetime(row.ReceivedAt as string)
  const tid = Date.now()

  // TransitionValid's challenge-echo digest, field for field: Digest(context.Tid, new.Id, new.Status, new.ChallengeNonce)
  const digestExpr = 'select Digest(:tid, :requestId, :status, :challengeNonce) as d'
  const digestParams = { tid, requestId, status: 'c', challengeNonce }
  const signingNonce = await seedSignedMutation(ctx, authorityId, 'vrg', tid, digestExpr, digestParams, makeTestSignCallback(auth.user))

  await ctx.db.exec(
    `update AssociationRequest
     with context SigningNonce = :signingNonce, Tid = ${tid}
     set Status = :status, ChallengeNonce = :challengeNonce, SubmittedAt = :submittedAt, ReceivedAt = :receivedAt
     where Id = :requestId`,
    { signingNonce, status: 'c', challengeNonce, submittedAt, receivedAt, requestId }
  )
}

/** Submits a request via the real engine, then transitions it to 'c' — ready for an attestation answer. */
async function seedChallengeIssuedRequest (
  auth: TestAuthority,
  engine: AssociationEngine
): Promise<{ requestId: string; deviceKeyPair: TestKeyPair; challengeNonce: string }> {
  const deviceKeyPair = randomTestKeyPair()
  const init = makeRequestInit(auth.authority.id, deviceKeyPair.publicHex)
  const requestId = await engine.submitAssociationRequest(init, deviceKeyPair.publicHex, makeCallbackSigner(deviceKeyPair))
  const challengeNonce = crypto.randomUUID()
  await issueChallengeTransition(auth, requestId, challengeNonce)
  return { requestId, deviceKeyPair, challengeNonce }
}

// ===========================================================================
// submitAssociationRequest (D-02)
// ===========================================================================

describe('association-request engine: submitAssociationRequest (D-02)', () => {
  it('submits a request signed by a key that belongs to no User row, creating zero AdminSigning rows', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new AssociationEngine(auth.ctx)
    const requester = randomTestKeyPair()
    const init = makeRequestInit(auth.authority.id, requester.publicHex)

    const before = await countAdminSigning(auth.ctx)
    const returnedId = await engine.submitAssociationRequest(init, requester.publicHex, makeCallbackSigner(requester))
    const after = await countAdminSigning(auth.ctx)

    expect(returnedId).to.equal(init.id)

    const row = await auth.ctx.db
      .prepare('select AuthorityId, RegistrantId, DeviceKey, Status, SubmittedAt, ReceivedAt from AssociationRequest where Id = :id')
      .get({ id: init.id })
    expect(row, 'AssociationRequest row must exist post-call').to.not.be.undefined
    expect(row?.AuthorityId).to.equal(auth.authority.id)
    expect(row?.RegistrantId).to.equal(init.registrantId)
    expect(row?.DeviceKey).to.equal(requester.publicHex)
    expect(row?.Status).to.equal('p')

    const userKeyRow = await auth.ctx.db.prepare('select count(*) as n from UserKey where PubKey = :pubKey').get({ pubKey: requester.publicHex })
    expect(Number(userKeyRow?.n), 'D-02: requester key must NOT belong to any User (no UserKey row)').to.equal(0)

    // SubmittedAt reads back equal to init.submittedAt; ReceivedAt differs and is Z-suffixed.
    const submittedAtBack = reZuluDatetime(row?.SubmittedAt as string)
    const receivedAtBack = reZuluDatetime(row?.ReceivedAt as string)
    expect(submittedAtBack).to.equal(stripTrailingZeroMs(init.submittedAt))
    expect(receivedAtBack).to.match(/Z$/)
    expect(receivedAtBack).to.not.equal(submittedAtBack)

    // LOAD-BEARING: the behavioral proof of D-02's no-ceremony design — a prospective registrant
    // has no User row and no officer scope to seed a ceremony against, and this call must not
    // seed one on its own initiative either.
    expect(after, 'submitAssociationRequest must create ZERO AdminSigning rows').to.equal(before)
  })

  it('rejects a signature produced over a tuple binding a different DeviceKey', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new AssociationEngine(auth.ctx)
    const signerX = randomTestKeyPair()
    const signerY = randomTestKeyPair()
    const id = crypto.randomUUID()
    const registrantId = crypto.randomUUID()
    const submittedAt = toIsoZDatetime(Date.now())

    // Sign a digest binding signerX's own key as DeviceKey, then submit the row claiming
    // signerY's key — the pre-flight guard is satisfied (init.deviceKey === requesterKey), but
    // the SIGNATURE was produced over a completely different tuple, so SignatureValid must reject.
    const digestRowX = await auth.ctx.db
      .prepare('select Digest(:id, :authorityId, :registrantId, :deviceKey, :electionId, :submittedAt) as d')
      .get({ id, authorityId: auth.authority.id, registrantId, deviceKey: signerX.publicHex, electionId: null, submittedAt })
    if (!digestRowX || digestRowX.d == null) throw new Error('wrong-tuple test: Digest() returned null')
    const forgedSignature: Signature = {
      signature: bytesToHex(secp256k1.sign(digestToBytes(digestRowX.d as string), hexToBytes(signerX.privateHex))),
      signerKey: signerX.publicHex,
      signerUserId: ''
    }

    const init: AssociationRequestInit = { id, authorityId: auth.authority.id, registrantId, deviceKey: signerY.publicHex, submittedAt }

    let caught: unknown
    try {
      await engine.submitAssociationRequest(init, signerY.publicHex, forgedSignature)
    } catch (err) {
      caught = err
    }
    expect(caught, 'submitAssociationRequest must throw: signature was produced over a tuple binding a different DeviceKey').to.be.instanceOf(Error)

    const row = await auth.ctx.db.prepare('select count(*) as n from AssociationRequest where Id = :id').get({ id })
    expect(Number(row?.n)).to.equal(0)
  })

  it('accepts a pre-resolved offline signature: a device that signed at staging time, before the authority ever saw the request, verifies at INSERT', async () => {
    // THE direct proof that the offline courier path (51-06) is possible. Test 1 above uses a
    // CALLBACK signer, which sidesteps the offline case entirely (the engine computes a digest
    // and immediately asks the callback to sign it). This is the ONLY test in this file that
    // exercises the pre-resolved-signature path. If SubmittedAt ever reverts to being
    // engine-generated, THIS is the test that fails.
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new AssociationEngine(auth.ctx)
    const requester = randomTestKeyPair()
    const init = makeRequestInit(auth.authority.id, requester.publicHex)

    // Staging-time signing, entirely independent of the engine — exactly what an offline
    // filesystem/REST courier does.
    const digestBytes = await stagingDigest(auth.ctx, init)
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
    const requestId = await engine.submitAssociationRequest(init, requester.publicHex, resolvedSignature)
    const after = await countAdminSigning(auth.ctx)

    const row = await auth.ctx.db
      .prepare('select SubmittedAt, ReceivedAt from AssociationRequest where Id = :id')
      .get({ id: requestId })
    const submittedAtBack = reZuluDatetime(row?.SubmittedAt as string)
    const receivedAtBack = reZuluDatetime(row?.ReceivedAt as string)
    expect(submittedAtBack).to.equal(stripTrailingZeroMs(init.submittedAt))
    expect(receivedAtBack).to.match(/Z$/)
    expect(receivedAtBack).to.not.equal(submittedAtBack)
    expect(after, 'the pre-resolved offline path must also create ZERO AdminSigning rows').to.equal(before)
  })

  it('refuses a submittedAt outside the accepted skew window in either direction', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new AssociationEngine(auth.ctx)

    const future = randomTestKeyPair()
    const futureInit = makeRequestInit(auth.authority.id, future.publicHex, { submittedAt: toIsoZDatetime(Date.now() + 10 * 60 * 1000) })
    const futureDigest = await stagingDigest(auth.ctx, futureInit)
    const futureSig: Signature = {
      signature: bytesToHex(secp256k1.sign(futureDigest, hexToBytes(future.privateHex))),
      signerKey: future.publicHex,
      signerUserId: ''
    }
    let futureCaught: unknown
    try {
      await engine.submitAssociationRequest(futureInit, future.publicHex, futureSig)
    } catch (err) {
      futureCaught = err
    }
    expect(futureCaught, 'submitAssociationRequest must throw: submittedAt 10 minutes in the future exceeds the +5-minute skew ceiling').to.be.instanceOf(Error)
    const futureRow = await auth.ctx.db.prepare('select count(*) as n from AssociationRequest where Id = :id').get({ id: futureInit.id })
    expect(Number(futureRow?.n)).to.equal(0)

    const past = randomTestKeyPair()
    const pastInit = makeRequestInit(auth.authority.id, past.publicHex, { submittedAt: toIsoZDatetime(Date.now() - 60 * 24 * 60 * 60 * 1000) })
    const pastDigest = await stagingDigest(auth.ctx, pastInit)
    const pastSig: Signature = {
      signature: bytesToHex(secp256k1.sign(pastDigest, hexToBytes(past.privateHex))),
      signerKey: past.publicHex,
      signerUserId: ''
    }
    let pastCaught: unknown
    try {
      await engine.submitAssociationRequest(pastInit, past.publicHex, pastSig)
    } catch (err) {
      pastCaught = err
    }
    expect(pastCaught, 'submitAssociationRequest must throw: submittedAt 60 days in the past exceeds the 30-day skew floor').to.be.instanceOf(Error)
    const pastRow = await auth.ctx.db.prepare('select count(*) as n from AssociationRequest where Id = :id').get({ id: pastInit.id })
    expect(Number(pastRow?.n)).to.equal(0)
  })

  it('accepts a submittedAt 60 seconds ahead of the authority clock, because honest device clocks drift', async () => {
    // REGRESSION GUARD on the tolerance itself: this project has a recorded failure where
    // emulator clocks ran ~45s BEHIND the host and expired consensus transactions (project
    // memory: device proof clock skew) — a bound tight enough to reject a minute of drift would
    // reject honest submissions on real hardware.
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new AssociationEngine(auth.ctx)
    const requester = randomTestKeyPair()
    const init = makeRequestInit(auth.authority.id, requester.publicHex, { submittedAt: toIsoZDatetime(Date.now() + 60 * 1000) })

    const digestBytes = await stagingDigest(auth.ctx, init)
    const resolvedSignature: Signature = {
      signature: bytesToHex(secp256k1.sign(digestBytes, hexToBytes(requester.privateHex))),
      signerKey: requester.publicHex,
      signerUserId: ''
    }

    const requestId = await engine.submitAssociationRequest(init, requester.publicHex, resolvedSignature)

    const row = await auth.ctx.db.prepare('select SubmittedAt from AssociationRequest where Id = :id').get({ id: requestId })
    expect(reZuluDatetime(row?.SubmittedAt as string)).to.equal(stripTrailingZeroMs(init.submittedAt))
  })

  it('round-trips a P-256 device key through submitAssociationRequest exactly as a secp256k1 key does', async () => {
    // The iOS device-key curve — the mixed-curve SignatureValidP256 branch is live for a REAL
    // caller here, not just in the 51-01 schema spec.
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new AssociationEngine(auth.ctx)
    const { privBytes, pubHex } = makeP256TestKey()
    expect(pubHex, '33-byte compressed SEC1 point, hex-encoded').to.have.length(66)
    const init = makeRequestInit(auth.authority.id, pubHex)

    const digestBytes = await stagingDigest(auth.ctx, init)
    const signature: Signature = {
      signature: bytesToHex(p256.sign(digestBytes, privBytes)),
      signerKey: pubHex,
      signerUserId: ''
    }

    const before = await countAdminSigning(auth.ctx)
    const requestId = await engine.submitAssociationRequest(init, pubHex, signature)
    const after = await countAdminSigning(auth.ctx)

    const row = await auth.ctx.db.prepare('select DeviceKey, Status from AssociationRequest where Id = :id').get({ id: requestId })
    expect(row?.DeviceKey).to.equal(pubHex)
    expect(row?.Status).to.equal('p')
    expect(after, 'the P-256 path must also create ZERO AdminSigning rows').to.equal(before)
  })
})

// ===========================================================================
// submitAssociationAttestation (D-18)
// ===========================================================================

describe('association-request engine: submitAssociationAttestation (D-18)', () => {
  it("stages an attestation answer for a 'c'-status request, creating zero AdminSigning rows", async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new AssociationEngine(auth.ctx)
    const { requestId, deviceKeyPair, challengeNonce } = await seedChallengeIssuedRequest(auth, engine)
    const answer: AssociationAttestationAnswer = { requestId, nonce: challengeNonce, attestation: makeDeviceAttestation() }
    const digestBytes = await answerDigest(auth.ctx, answer)
    const signature: Signature = {
      signature: bytesToHex(secp256k1.sign(digestBytes, hexToBytes(deviceKeyPair.privateHex))),
      signerKey: deviceKeyPair.publicHex,
      signerUserId: ''
    }

    const before = await countAdminSigning(auth.ctx)
    await engine.submitAssociationAttestation(answer, deviceKeyPair.publicHex, signature)
    const after = await countAdminSigning(auth.ctx)

    expect(after, 'submitAssociationAttestation must create ZERO AdminSigning rows').to.equal(before)
  })

  it('writes no Association, AssociationPrivate or AttestationVerdict row', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new AssociationEngine(auth.ctx)
    const { requestId, deviceKeyPair, challengeNonce } = await seedChallengeIssuedRequest(auth, engine)
    const answer: AssociationAttestationAnswer = { requestId, nonce: challengeNonce, attestation: makeDeviceAttestation() }
    const digestBytes = await answerDigest(auth.ctx, answer)
    const signature: Signature = {
      signature: bytesToHex(secp256k1.sign(digestBytes, hexToBytes(deviceKeyPair.privateHex))),
      signerKey: deviceKeyPair.publicHex,
      signerUserId: ''
    }

    const before = {
      association: await countRows(auth.ctx, 'Association'),
      private: await countRows(auth.ctx, 'AssociationPrivate'),
      verdict: await countRows(auth.ctx, 'AttestationVerdict')
    }
    await engine.submitAssociationAttestation(answer, deviceKeyPair.publicHex, signature)
    const after = {
      association: await countRows(auth.ctx, 'Association'),
      private: await countRows(auth.ctx, 'AssociationPrivate'),
      verdict: await countRows(auth.ctx, 'AttestationVerdict')
    }

    expect(after, 'submitAssociationAttestation must write NO Association/AssociationPrivate/AttestationVerdict row').to.deep.equal(before)
  })

  it('rejects an answer whose nonce does not match the persisted ChallengeNonce', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new AssociationEngine(auth.ctx)
    const { requestId, deviceKeyPair } = await seedChallengeIssuedRequest(auth, engine)
    const wrongNonce = crypto.randomUUID()
    const answer: AssociationAttestationAnswer = { requestId, nonce: wrongNonce, attestation: makeDeviceAttestation() }
    const digestBytes = await answerDigest(auth.ctx, answer)
    const signature: Signature = {
      signature: bytesToHex(secp256k1.sign(digestBytes, hexToBytes(deviceKeyPair.privateHex))),
      signerKey: deviceKeyPair.publicHex,
      signerUserId: ''
    }

    let caught: unknown
    try {
      await engine.submitAssociationAttestation(answer, deviceKeyPair.publicHex, signature)
    } catch (err) {
      caught = err
    }
    expect(caught, 'submitAssociationAttestation must throw: answer.nonce does not match the persisted ChallengeNonce').to.be.instanceOf(Error)
  })

  it("rejects an answer for a request whose Status is not 'c'", async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new AssociationEngine(auth.ctx)
    const deviceKeyPair = randomTestKeyPair()
    const init = makeRequestInit(auth.authority.id, deviceKeyPair.publicHex)
    const requestId = await engine.submitAssociationRequest(init, deviceKeyPair.publicHex, makeCallbackSigner(deviceKeyPair))
    // Deliberately left at Status='p' — no challenge has been issued, so nothing is answerable yet.
    const bogusNonce = crypto.randomUUID()
    const answer: AssociationAttestationAnswer = { requestId, nonce: bogusNonce, attestation: makeDeviceAttestation() }
    const digestBytes = await answerDigest(auth.ctx, answer)
    const signature: Signature = {
      signature: bytesToHex(secp256k1.sign(digestBytes, hexToBytes(deviceKeyPair.privateHex))),
      signerKey: deviceKeyPair.publicHex,
      signerUserId: ''
    }

    let caught: unknown
    try {
      await engine.submitAssociationAttestation(answer, deviceKeyPair.publicHex, signature)
    } catch (err) {
      caught = err
    }
    expect(caught, "submitAssociationAttestation must throw: Status is 'p', not 'c'").to.be.instanceOf(Error)
  })

  it('rejects an answer whose self-signature does not verify under requesterKey (forged-signature mutation)', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new AssociationEngine(auth.ctx)
    const { requestId, deviceKeyPair, challengeNonce } = await seedChallengeIssuedRequest(auth, engine)
    const answer: AssociationAttestationAnswer = { requestId, nonce: challengeNonce, attestation: makeDeviceAttestation() }
    const digestBytes = await answerDigest(auth.ctx, answer)
    const validSignatureHex = bytesToHex(secp256k1.sign(digestBytes, hexToBytes(deviceKeyPair.privateHex)))

    // LOAD-BEARING POSITIVE CONTROL: the UNMODIFIED signature verifies — this proves the check
    // actually runs (a happy path alone proves nothing about a check that might not run).
    const validSignature: Signature = { signature: validSignatureHex, signerKey: deviceKeyPair.publicHex, signerUserId: '' }
    await engine.submitAssociationAttestation(answer, deviceKeyPair.publicHex, validSignature)

    // MUTATION: flip the first hex digit of the SAME signature (XOR by 0xf always changes a
    // 4-bit nibble) and resubmit an otherwise byte-identical answer — same nonce, same
    // attestation, corrupted signature only. submitAssociationAttestation does not consume or
    // transition the request (only stages the answer), so the request is still Status='c'.
    const firstNibble = parseInt(validSignatureHex[0]!, 16)
    const forgedHex = (firstNibble ^ 0xf).toString(16) + validSignatureHex.slice(1)
    expect(forgedHex).to.not.equal(validSignatureHex)
    const forgedSignature: Signature = { signature: forgedHex, signerKey: deviceKeyPair.publicHex, signerUserId: '' }

    let caught: unknown
    try {
      await engine.submitAssociationAttestation(answer, deviceKeyPair.publicHex, forgedSignature)
    } catch (err) {
      caught = err
    }
    expect(caught, 'submitAssociationAttestation must throw: self-signature does not verify under requesterKey').to.be.instanceOf(Error)
  })
})

// ===========================================================================
// MockAssociationEngine parity (D-02/D-18)
// ===========================================================================

describe('association-request mock parity: submitAssociationRequest / submitAssociationAttestation', () => {
  it('never invokes signatureOrCallback for either new method', async () => {
    const mock = new MockAssociationEngine()
    const deviceKeyPair = randomTestKeyPair()
    const init: AssociationRequestInit = {
      id: crypto.randomUUID(),
      authorityId: 'mock-authority',
      registrantId: crypto.randomUUID(),
      deviceKey: deviceKeyPair.publicHex,
      submittedAt: toIsoZDatetime(Date.now())
    }
    let callbackInvoked = false
    const callback = async (): Promise<Signature> => {
      callbackInvoked = true
      return { signature: 'unused', signerKey: deviceKeyPair.publicHex, signerUserId: '' }
    }

    const requestId = await mock.submitAssociationRequest(init, deviceKeyPair.publicHex, callback)
    expect(requestId).to.equal(init.id)
    expect(callbackInvoked, 'MockAssociationEngine.submitAssociationRequest must never call signatureOrCallback').to.equal(false)

    const answer: AssociationAttestationAnswer = { requestId, nonce: crypto.randomUUID(), attestation: makeDeviceAttestation() }
    await mock.submitAssociationAttestation(answer, deviceKeyPair.publicHex, callback)
    expect(callbackInvoked, 'MockAssociationEngine.submitAssociationAttestation must never call signatureOrCallback').to.equal(false)
  })
})
