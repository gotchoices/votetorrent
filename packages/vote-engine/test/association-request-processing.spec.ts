/**
 * association-request-processing.spec.ts — Phase 51 Plan 09, Task 3 (D-01/D-03/D-05/D-06/D-18).
 *
 * End-to-end proof of `processPendingAssociationRequests` — the authority-side D-05 automatic
 * driver — across BOTH legs of the D-18 challenge round-trip, against a REAL Quereus database and
 * the REAL `FilesystemAssociationTransport` (51-06/51-07) as the concrete `IAssociationRequestIntake`.
 *
 * Covers, one `it()` per `<behavior>` bullet in 51-09-PLAN.md Task 2, plus the officer-absent and
 * real-bytes cases Task 3 adds:
 *   1. leg 1 issues a challenge for a pending row and writes the 'p'->'c' transition + 'c' notice.
 *   2. leg 2 builds an AssociateInit from the row + staged answer, calls associate(), writes the
 *      'c'->'a' transition + 'a' notice.
 *   3. a leg-2 attestation-verification failure writes 'c'->'r' with a RejectionReason and creates
 *      zero Association rows.
 *   4. zero Task rows and zero SignatureType references on any path (asserted by row COUNT).
 *   5. the returned {challengesIssued, associated, rejected} counts match the rows transitioned.
 *   6. idempotency — a second full run over the same input issues no duplicate challenge/Association.
 *   7. a forged self-signature (matching nonce/deviceKey) is rejected by the DRIVER directly —
 *      submitAssociationAttestation (the intake pre-filter) is NEVER called in this test.
 *   8. listAssociationRequests(authorityId) returns every request for that authority.
 *   9. listAssociationRequests(authorityId, 'c') returns only the 'c' rows.
 *  10. getAssociationRequest hits and misses (undefined, never a throw, for an unknown id).
 *  11. the officer-key-absent case fails STRUCTURALLY at AdminSigning.UserIdValid.
 *  12. REAL captured iPhone App Attest bytes, through the REAL PlatformDispatchingAttestationVerifier,
 *      drive leg 2 to a PASS AttestationVerdict.
 *
 * ============================================================================
 * WHY THE REAL-BYTES CASE (12) USES A FRESH TEST DEVICE KEY, NOT THE FIXTURE'S OWN
 * ============================================================================
 * `AssociationRequest.DeviceKey` (== `AttestationChallenge.DeviceKey` == `challenge.deviceKey` the
 * verifier receives) is ONE column throughout this whole ceremony. D-18's envelope self-signature
 * check (`validateStagedAttestationAnswer`, engine-side only, no schema CHECK behind it — 51-08)
 * requires a GENUINE ECDSA signature over the answer digest, verified under THAT SAME key. The
 * fixture's `challenge.deviceKey` is `K_vote`, a non-extractable Apple Secure Enclave key
 * (`ios-hardware-attestation.spec.ts`'s `voteKeyProbe: 'CryptoTokenKit:-3'` confirms this — the same
 * key class a Face ID re-enrolment can destroy). No Node process can produce a NEW valid signature
 * under it beyond what the device already captured (the fixture's own `assertion`/`popSignature`,
 * each over a FIXED, different digest). Meanwhile `app-attest-verifier.ts:110`'s
 * `ios.secureEnclavePublicKey !== challenge.deviceKey` check requires the verifier's OWN view of
 * `challenge.deviceKey` to equal the fixture's real key EXACTLY, or the real cryptographic checks
 * (both the attestation's credCert nonce commitment and the assertion/pop signatures) fail — there
 * is no value this ceremony could use for `deviceKey` that satisfies BOTH a genuine new
 * self-signature AND the real captured bytes' fixed cryptographic binding.
 *
 * Resolution: this ceremony's own bookkeeping (the self-signed envelope, the `AssociationRequest`/
 * `Association`/`AssociationPrivate` rows) uses a FRESH TEST P-256 key pair throughout — genuinely
 * self-signed, genuinely verified by `validateStagedAttestationAnswer`'s real ECDSA check. Only the
 * INJECTED VERIFIER's view of `challenge.{nonce,deviceKey}` is remapped, via a thin test-local
 * decorator (`FixtureBoundVerifier` below), to the fixture's real values — the exact values the real
 * captured bytes are cryptographically bound to — before delegating to the REAL
 * `PlatformDispatchingAttestationVerifier`/`AppAttestVerifier` chain. This keeps BOTH halves
 * genuine: the D-18 envelope self-signature (test key, real crypto) and the App Attest attestation
 * cryptography (fixture bytes, real crypto, real verifier) — neither is stubbed or bypassed, and
 * `associate()` itself is called completely UNCHANGED via the driver. No production code is
 * modified to make this possible; `FixtureBoundVerifier` is a test-only `IAttestationVerifier`
 * implementation, exactly the seam `AssociationEngine`'s constructor already exposes for swapping
 * verifiers (`ios-association-ceremony.spec.ts` does the analogous thing by pinning
 * `crypto.randomUUID()` instead, for the SAME underlying reason — real bytes are bound to fixed
 * random draws the ceremony would otherwise make fresh).
 */

import 'reflect-metadata'
import { expect } from 'chai'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { p256 } from '@noble/curves/nist.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import {
  createTestNetwork,
  addTestAuthority,
  makeTestSignCallback,
  makeDistinctTestUser
} from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import type { TestKeyPair } from './fixtures/keys.js'
import { makeP256TestKey } from './fixtures/p256-signer.js'
import { AssociationEngine } from '../src/association/association-engine.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { AppAttestVerifier } from '../src/association/app-attest-verifier.js'
import { PlatformDispatchingAttestationVerifier } from '../src/association/platform-dispatching-verifier.js'
import { PlayIntegrityVerifier } from '../src/association/play-integrity-verifier.js'
import { FilesystemAssociationTransport } from '../src/association/transport/filesystem-association-transport.js'
import { APPLE_APP_ATTEST_ROOT_DER } from './fixtures/attestation/apple-app-attest-root.js'
import { digestToBytes } from '../src/utils.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'
import type { EngineContext } from '../src/types.js'
import type { TestAuthorityContext } from './fixtures/test-context.js'
import type {
  AssociateInit,
  AssociationAttestationAnswer,
  AssociationRequestInit,
  AttestationChallenge,
  AttestationVerification,
  DeviceAttestation,
  IAttestationVerifier,
  Signature
} from '@votetorrent/vote-core'

// ---------------------------------------------------------------------------
// Real-bytes fixture (mirrors ios-association-ceremony.spec.ts exactly)
// ---------------------------------------------------------------------------

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./fixtures/attestation/ios-hardware-2026-08-25.json', import.meta.url)),
    'utf8'
  )
) as {
  startedAt: string
  challenge: { nonce: string, deviceKey: string }
  attestation: DeviceAttestation
}
const APP_ID = '94TY7UR2W5.org.votetorrent.voter'
const FIXTURE_CAPTURED_AT = new Date(fixture.startedAt)

/**
 * Test-only `IAttestationVerifier` decorator — see this file's module doc comment ("WHY THE
 * REAL-BYTES CASE USES A FRESH TEST DEVICE KEY") for the full rationale. Remaps ONLY
 * `challenge.nonce`/`challenge.deviceKey` before delegating to the REAL verifier chain; the
 * `attestation` object is passed through completely unmodified.
 */
class FixtureBoundVerifier implements IAttestationVerifier {
  constructor (
    private readonly inner: IAttestationVerifier,
    private readonly fixedNonce: string,
    private readonly fixedDeviceKey: string
  ) {}

  async verify (challenge: AttestationChallenge, attestation: DeviceAttestation): Promise<AttestationVerification> {
    return this.inner.verify({ ...challenge, nonce: this.fixedNonce, deviceKey: this.fixedDeviceKey }, attestation)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = []

function makeCallbackSigner (keyPair: TestKeyPair): (digest: Uint8Array) => Promise<Signature> {
  const privBytes = hexToBytes(keyPair.privateHex)
  return async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes)
    return { signature: bytesToHex(sig), signerKey: keyPair.publicHex, signerUserId: '' }
  }
}

function makeP256CallbackSigner (privBytes: Uint8Array, pubHex: string): (digest: Uint8Array) => Promise<Signature> {
  return async (digest: Uint8Array): Promise<Signature> => ({
    signature: bytesToHex(p256.sign(digest, privBytes)),
    signerKey: pubHex,
    signerUserId: ''
  })
}

let deviceSeq = 0
function makeDeviceAttestation (overrides?: Partial<DeviceAttestation>): DeviceAttestation {
  deviceSeq += 1
  return {
    publicKey: `arp-device-pubkey-${deviceSeq}`,
    deviceId: `arp-device-id-${Date.now()}-${deviceSeq}`,
    attestationTime: Date.now(),
    certificateChain: ['cert-a', 'cert-b'],
    ...overrides
  }
}

/** Mirrors association-request.spec.ts's stagingDigest — reproduced independently, as an offline courier would. */
async function requestDigest (ctx: EngineContext, init: AssociationRequestInit): Promise<Uint8Array> {
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
  if (!digestRow || digestRow.d == null) throw new Error('requestDigest: Digest() returned null')
  return digestToBytes(digestRow.d as string)
}

/** Mirrors association-request.spec.ts's answerDigest — reproduced independently, as an offline courier would. */
async function answerDigest (ctx: EngineContext, answer: AssociationAttestationAnswer): Promise<Uint8Array> {
  const attestationJson = JSON.stringify(answer.attestation)
  const digestRow = await ctx.db
    .prepare('select Digest(:requestId, :nonce, :attestationJson, :deviceHash) as d')
    .get({ requestId: answer.requestId, nonce: answer.nonce, attestationJson, deviceHash: answer.deviceHash ?? null })
  if (!digestRow || digestRow.d == null) throw new Error('answerDigest: Digest() returned null')
  return digestToBytes(digestRow.d as string)
}

async function countRows (ctx: EngineContext, table: string): Promise<number> {
  const row = await ctx.db.prepare(`select count(*) as n from ${table}`).get({})
  return Number(row?.n ?? 0)
}

interface TestSetup {
  auth: TestAuthorityContext
  registrantId: string
  engine: AssociationEngine
  transport: FilesystemAssociationTransport
  officerSign: (digest: Uint8Array) => Promise<Signature>
}

/** Real network + authority + registrant + a fresh temp-dir FilesystemAssociationTransport. */
async function setup (): Promise<TestSetup> {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  const officerSign = makeTestSignCallback(auth.user)
  const registrationEngine = new RegistrationEngine(auth.ctx)
  const registrantId = `arp-registrant-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await registrationEngine.createRegistrant(
    { id: registrantId, authorityId: auth.authority.id, privateCid: 'arp-private-cid-placeholder', expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000) },
    officerSign
  )
  const engine = new AssociationEngine(auth.ctx)
  const rootDir = await mkdtemp(join(tmpdir(), 'association-request-processing-'))
  tempDirs.push(rootDir)
  const transport = new FilesystemAssociationTransport({ rootDir })
  return { auth, registrantId, engine, transport, officerSign }
}

/** Submits a real self-signed D-02 AssociationRequest through the real engine. */
async function submitDeviceRequest (s: TestSetup, deviceKeyPair: TestKeyPair, overrides?: Partial<AssociationRequestInit>): Promise<string> {
  const init: AssociationRequestInit = {
    id: crypto.randomUUID(),
    authorityId: s.auth.authority.id,
    registrantId: s.registrantId,
    deviceKey: deviceKeyPair.publicHex,
    submittedAt: toIsoZDatetime(Date.now()),
    ...overrides
  }
  return s.engine.submitAssociationRequest(init, deviceKeyPair.publicHex, makeCallbackSigner(deviceKeyPair))
}

/** Reads a row's persisted ChallengeNonce after leg 1 has issued it. */
async function readChallengeNonce (s: TestSetup, requestId: string): Promise<string> {
  const row = await s.auth.ctx.db.prepare('select ChallengeNonce from AssociationRequest where Id = :id').get({ id: requestId })
  const nonce = row?.ChallengeNonce as string | undefined
  if (!nonce) throw new Error(`readChallengeNonce: no ChallengeNonce for requestId=${requestId} — did leg 1 run?`)
  return nonce
}

/** Builds and self-signs a real D-18 answer under deviceKeyPair, and stages it via the transport. */
async function stageAnswer (s: TestSetup, requestId: string, deviceKeyPair: TestKeyPair, attestation: DeviceAttestation): Promise<void> {
  const nonce = await readChallengeNonce(s, requestId)
  const answer: AssociationAttestationAnswer = { requestId, nonce, attestation }
  const digestBytes = await answerDigest(s.auth.ctx, answer)
  const signature: Signature = {
    signature: bytesToHex(secp256k1.sign(digestBytes, hexToBytes(deviceKeyPair.privateHex))),
    signerKey: deviceKeyPair.publicHex,
    signerUserId: ''
  }
  await s.transport.submitAttestation(answer, deviceKeyPair.publicHex, signature)
}

async function driveOnce (s: TestSetup): ReturnType<AssociationEngine['processPendingAssociationRequests']> {
  return s.engine.processPendingAssociationRequests(s.auth.authority.id, s.officerSign, s.transport)
}

// ===========================================================================

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('processPendingAssociationRequests — the D-05 automatic authority-side driver', () => {
  it("leg 1: issues a challenge for a pending row, writes 'p' -> 'c' with a ChallengeNonce, and publishes a 'c' notice", async () => {
    const s = await setup()
    const deviceKeyPair = randomTestKeyPair()
    const requestId = await submitDeviceRequest(s, deviceKeyPair)

    const result = await driveOnce(s)
    expect(result.challengesIssued, 'exactly one challenge issued').to.equal(1)

    const row = await s.auth.ctx.db.prepare('select Status, ChallengeNonce from AssociationRequest where Id = :id').get({ id: requestId })
    expect(row?.Status).to.equal('c')
    expect(row?.ChallengeNonce).to.be.a('string').with.length.greaterThan(0)

    const challengeRow = await s.auth.ctx.db
      .prepare('select count(*) as n from AttestationChallenge where Nonce = :nonce')
      .get({ nonce: row!.ChallengeNonce as string })
    expect(Number(challengeRow?.n), 'the issued AttestationChallenge row must exist').to.equal(1)

    const notices = await s.transport.pollDecisions()
    const notice = notices.find((n) => n.requestId === requestId)
    expect(notice, "a 'c' notice must be published for this request").to.not.be.undefined
    expect(notice!.status).to.equal('c')
    expect(notice!.challengeNonce).to.equal(row!.ChallengeNonce)
  })

  it("leg 2: builds an AssociateInit from the row + staged answer, calls associate(), writes 'c' -> 'a', and publishes an 'a' notice", async () => {
    const s = await setup()
    const deviceKeyPair = randomTestKeyPair()
    const requestId = await submitDeviceRequest(s, deviceKeyPair)
    await driveOnce(s)
    await stageAnswer(s, requestId, deviceKeyPair, makeDeviceAttestation())

    const result = await driveOnce(s)
    expect(result.associated, 'exactly one association').to.equal(1)
    expect(result.rejected).to.equal(0)

    const row = await s.auth.ctx.db.prepare('select Status from AssociationRequest where Id = :id').get({ id: requestId })
    expect(row?.Status).to.equal('a')

    const association = await s.engine.getAssociation(s.registrantId, deviceKeyPair.publicHex)
    expect(association, 'a public Association row must exist').to.not.be.undefined

    const privateCount = await countRows(s.auth.ctx, 'AssociationPrivate')
    expect(privateCount).to.equal(1)

    const notices = await s.transport.pollDecisions()
    const notice = notices.find((n) => n.requestId === requestId && n.status === 'a')
    expect(notice, "an 'a' notice must be published").to.not.be.undefined
  })

  it("leg 2 rejection: an attestation-verification failure writes 'c' -> 'r' with a RejectionReason and creates zero Association rows", async () => {
    const s = await setup()
    const deviceKeyPair = randomTestKeyPair()
    const requestId = await submitDeviceRequest(s, deviceKeyPair)
    await driveOnce(s)

    // A deterministic StubAttestationVerifier rejection: an Android platform nonce that does not
    // answer the issued challenge.
    const attestation = makeDeviceAttestation({
      platformDetails: { type: 'Android', safetyNetAttestation: 'x', keystorePublicKey: 'y', nonce: 'not-the-issued-nonce' }
    })
    await stageAnswer(s, requestId, deviceKeyPair, attestation)

    const result = await driveOnce(s)
    expect(result.rejected, 'exactly one rejection').to.equal(1)
    expect(result.associated).to.equal(0)

    const row = await s.auth.ctx.db.prepare('select Status, RejectionReason from AssociationRequest where Id = :id').get({ id: requestId })
    expect(row?.Status).to.equal('r')
    expect(row?.RejectionReason, 'a GENERIC rejection class, never a raw verifier reason').to.equal('attestation-verification-failed')

    const assocCount = await countRows(s.auth.ctx, 'Association')
    expect(assocCount, 'zero Association rows after a rejected ceremony').to.equal(0)

    const notices = await s.transport.pollDecisions()
    const notice = notices.find((n) => n.requestId === requestId && n.status === 'r')
    expect(notice, "an 'r' notice must be published").to.not.be.undefined
    // The published reason must be from the GENERIC allowlist — never the verifier's own
    // "attestation nonce does not answer the issued challenge nonce" text.
    expect(notice!.reason).to.equal('attestation-verification-failed')
  })

  it('creates zero Task rows on any path (pending, associated, and rejected)', async () => {
    const before = await (async () => {
      const s0 = await setup()
      return countRows(s0.auth.ctx, 'Task')
    })()
    expect(before).to.equal(0)

    const s = await setup()
    const deviceKeyPair = randomTestKeyPair()
    const requestId = await submitDeviceRequest(s, deviceKeyPair)
    await driveOnce(s)
    expect(await countRows(s.auth.ctx, 'Task'), 'zero Task rows after leg 1').to.equal(0)

    await stageAnswer(s, requestId, deviceKeyPair, makeDeviceAttestation())
    await driveOnce(s)
    expect(await countRows(s.auth.ctx, 'Task'), 'zero Task rows after leg 2 (associated)').to.equal(0)

    // A second, independently-rejected request under the SAME authority.
    const rejectedDeviceKeyPair = randomTestKeyPair()
    const rejectedRequestId = await submitDeviceRequest(s, rejectedDeviceKeyPair)
    await driveOnce(s)
    await stageAnswer(s, rejectedRequestId, rejectedDeviceKeyPair, makeDeviceAttestation({
      platformDetails: { type: 'Android', safetyNetAttestation: 'x', keystorePublicKey: 'y', nonce: 'wrong' }
    }))
    await driveOnce(s)
    expect(await countRows(s.auth.ctx, 'Task'), 'zero Task rows after leg 2 (rejected)').to.equal(0)
  })

  it('the returned {challengesIssued, associated, rejected} counts match the rows actually transitioned', async () => {
    const s = await setup()
    const goodDeviceKeyPair = randomTestKeyPair()
    const badDeviceKeyPair = randomTestKeyPair()
    const goodRequestId = await submitDeviceRequest(s, goodDeviceKeyPair)
    const badRequestId = await submitDeviceRequest(s, badDeviceKeyPair)

    const leg1Result = await driveOnce(s)
    expect(leg1Result).to.deep.equal({ challengesIssued: 2, associated: 0, rejected: 0 })

    await stageAnswer(s, goodRequestId, goodDeviceKeyPair, makeDeviceAttestation())
    await stageAnswer(s, badRequestId, badDeviceKeyPair, makeDeviceAttestation({
      platformDetails: { type: 'Android', safetyNetAttestation: 'x', keystorePublicKey: 'y', nonce: 'wrong' }
    }))

    const leg2Result = await driveOnce(s)
    expect(leg2Result).to.deep.equal({ challengesIssued: 0, associated: 1, rejected: 1 })
  })

  it('is idempotent — a second full run over the same input issues no duplicate challenge and creates no duplicate Association', async () => {
    const s = await setup()
    const deviceKeyPair = randomTestKeyPair()
    const requestId = await submitDeviceRequest(s, deviceKeyPair)
    await driveOnce(s)
    await stageAnswer(s, requestId, deviceKeyPair, makeDeviceAttestation())
    await driveOnce(s)

    const countsFor = async (): Promise<[number, number, number]> => [
      await countRows(s.auth.ctx, 'Association'),
      await countRows(s.auth.ctx, 'AssociationPrivate'),
      await countRows(s.auth.ctx, 'AttestationChallenge')
    ]
    const before = await countsFor()

    // A second full run over the identical (already-terminal) input.
    const secondResult = await driveOnce(s)
    expect(secondResult).to.deep.equal({ challengesIssued: 0, associated: 0, rejected: 0 })

    const after = await countsFor()
    expect(after, 'row counts must be UNCHANGED by the idempotent second run').to.deep.equal(before)
  })

  it('SKIPS a staged answer whose nonce and requester key both match the persisted row but whose self-signature is FORGED — the driver, not just the intake pre-filter, runs the check — and the honest answer still lands afterwards (CR-05)', async () => {
    const s = await setup()
    const deviceKeyPair = randomTestKeyPair()
    const requestId = await submitDeviceRequest(s, deviceKeyPair)
    await driveOnce(s)
    const nonce = await readChallengeNonce(s, requestId)

    const answer: AssociationAttestationAnswer = { requestId, nonce, attestation: makeDeviceAttestation() }
    const digestBytes = await answerDigest(s.auth.ctx, answer)
    const validSignatureHex = bytesToHex(secp256k1.sign(digestBytes, hexToBytes(deviceKeyPair.privateHex)))
    // XOR the leading nibble by 0xf — always changes it, never accidentally reproduces the original.
    const firstNibble = parseInt(validSignatureHex[0]!, 16)
    const forgedHex = (firstNibble ^ 0xf).toString(16) + validSignatureHex.slice(1)
    expect(forgedHex).to.not.equal(validSignatureHex)
    const forgedSignature: Signature = { signature: forgedHex, signerKey: deviceKeyPair.publicHex, signerUserId: '' }

    // LOAD-BEARING: stage the FORGED document DIRECTLY through the transport.
    // `AssociationEngine.submitAssociationAttestation` (the intake pre-filter) is NEVER called
    // here — this proves the driver's OWN call to `validateStagedAttestationAnswer` is what
    // catches this, not a pre-filter the driver could bypass.
    await s.transport.submitAttestation(answer, deviceKeyPair.publicHex, forgedSignature)

    const beforeAssociationCount = await countRows(s.auth.ctx, 'Association')
    const result = await driveOnce(s)
    const afterAssociationCount = await countRows(s.auth.ctx, 'Association')

    // The forged document must not associate ANYTHING — that is the driver's own
    // `validateStagedAttestationAnswer` call doing its job.
    expect(result.associated).to.equal(0)
    expect(afterAssociationCount, 'zero Association rows after a forged-signature envelope').to.equal(beforeAssociationCount)

    // CR-05: and it must not DECIDE the row either. A forged envelope is not an answer from
    // this requester, the staging channel is unauthenticated, and `AssociationRequest` has
    // `NoDelete` with no `'r' -> *` transition — so a rejection here would be a permanent,
    // unrecoverable denial of service that any attacker who learned the requestId could inflict.
    expect(result.rejected, 'a forged envelope must be SKIPPED, never counted as a decision').to.equal(0)
    const row = await s.auth.ctx.db.prepare('select Status, RejectionReason from AssociationRequest where Id = :id').get({ id: requestId })
    expect(row?.Status, "the request must stay 'c' so the genuine answer can still land").to.equal('c')
    expect(row?.RejectionReason).to.equal(null)

    // THE proof that the DoS is closed: the honest device answers afterwards and succeeds.
    await stageAnswer(s, requestId, deviceKeyPair, makeDeviceAttestation())
    const second = await driveOnce(s)
    expect(second.associated, 'the genuine answer must still be able to associate').to.equal(1)
    expect(second.rejected).to.equal(0)
    const finalRow = await s.auth.ctx.db.prepare('select Status from AssociationRequest where Id = :id').get({ id: requestId })
    expect(finalRow?.Status).to.equal('a')
  })

  it("WR-05: when associate() throws AFTER the Association row committed (D-11 consumption failure), the request is decided 'a', never 'r'", async () => {
    // associate() is deliberately TWO sequential transactions: the Association/AssociationPrivate
    // write commits, then D-11's challenge consumption runs in its own transaction and is
    // documented as able to fail independently. The driver wrapped the whole call in one catch,
    // so a signing hiccup or transient store error in the CONSUME step signed a 'c' -> 'r'
    // transition while the authority held a valid Association row - and with NoDelete and no
    // 'r' -> 'a' transition, the two records could never be reconciled.
    //
    // Modelled exactly: a subclass that runs the REAL associate() to completion and then throws.
    class ConsumeFailingEngine extends AssociationEngine {
      override async associate (
        init: AssociateInit,
        signatureOrCallback: Signature | ((digest: Uint8Array) => Promise<Signature>)
      ): Promise<void> {
        await super.associate(init, signatureOrCallback)
        throw new Error('simulated D-11 challenge-consumption failure (post-commit)')
      }
    }

    const s = await setup()
    const deviceKeyPair = randomTestKeyPair()
    const requestId = await submitDeviceRequest(s, deviceKeyPair)
    await driveOnce(s)
    await stageAnswer(s, requestId, deviceKeyPair, makeDeviceAttestation())

    const failingEngine = new ConsumeFailingEngine(s.auth.ctx)
    const result = await failingEngine.processPendingAssociationRequests(s.auth.authority.id, s.officerSign, s.transport)

    expect(result.rejected, 'a post-commit failure must NOT be recorded as a rejection').to.equal(0)
    expect(result.associated).to.equal(1)

    const row = await s.auth.ctx.db.prepare('select Status from AssociationRequest where Id = :id').get({ id: requestId })
    expect(row?.Status, "the voter must not be told they were rejected while an Association row exists").to.equal('a')

    const association = await s.engine.getAssociation(s.registrantId, deviceKeyPair.publicHex)
    expect(association, 'the Association row really did commit').to.not.be.undefined
  })

  it('WR-06: one failing LEG 1 row does not stall the remaining rows, and its orphaned challenge is retracted', async () => {
    // LEG 1 had no per-row try, so a single row throwing anywhere in the transition propagated
    // out of the whole method and skipped every remaining pending row AND all of LEG 2 for that
    // sync. issueAttestationChallenge also COMMITS its AttestationChallenge row before the
    // 'p' -> 'c' UPDATE, so the failure additionally left a live orphan nonce behind.
    const s = await setup()
    const poisonPair = randomTestKeyPair()
    const healthyPair = randomTestKeyPair()
    const poisonId = await submitDeviceRequest(s, poisonPair)
    const healthyId = await submitDeviceRequest(s, healthyPair)

    // Fail exactly ONE row, exactly at its signed 'p' -> 'c' UPDATE — i.e. after its challenge
    // has already committed but before the transition lands. That is the window the orphan lives
    // in. Injected at the db seam rather than by feeding the engine a bad value, so the engine's
    // own code path is unmodified.
    const realDb = s.auth.ctx.db
    const poisonedDb = new Proxy(realDb, {
      get (target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (prop === 'exec') {
          return async (sql: string, params?: Record<string, unknown>) => {
            if (typeof sql === 'string' && sql.includes('update AssociationRequest') && params?.requestId === poisonId) {
              throw new Error('simulated LEG 1 transition failure')
            }
            return (value as typeof realDb.exec).call(target, sql, params as never)
          }
        }
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
      }
    }) as typeof realDb
    const poisonedCtx: EngineContext = { ...s.auth.ctx, db: poisonedDb }

    const retracted: string[] = []
    class ObservingEngine extends AssociationEngine {
      override async removeAttestationChallenge (
        nonce: string,
        signatureOrCallback: Signature | ((digest: Uint8Array) => Promise<Signature>)
      ): Promise<void> {
        retracted.push(nonce)
        return super.removeAttestationChallenge(nonce, signatureOrCallback)
      }
    }

    const engine = new ObservingEngine(poisonedCtx)
    const result = await engine.processPendingAssociationRequests(s.auth.authority.id, s.officerSign, s.transport)

    // The healthy row was still processed — the whole point.
    expect(result.challengesIssued, 'the healthy row must still be transitioned').to.equal(1)
    const healthyRow = await realDb.prepare('select Status from AssociationRequest where Id = :id').get({ id: healthyId })
    expect(healthyRow?.Status).to.equal('c')

    // The poisoned row is untouched and retryable, not stuck mid-ceremony.
    const poisonRow = await realDb.prepare('select Status from AssociationRequest where Id = :id').get({ id: poisonId })
    expect(poisonRow?.Status, "a failed LEG 1 row stays 'p' so the next sync can retry it").to.equal('p')

    // And the challenge it had already committed was retracted rather than left as a live orphan.
    expect(retracted.length, 'exactly the orphaned challenge must be retracted').to.equal(1)
    const remaining = await s.engine.getAttestationChallenges(s.registrantId)
    expect(
      remaining.some((c) => c.deviceKey === poisonPair.publicHex),
      'no live AttestationChallenge may remain for the failed row'
    ).to.equal(false)
    expect(
      remaining.some((c) => c.deviceKey === healthyPair.publicHex),
      "the healthy row's challenge must survive"
    ).to.equal(true)
  })

  it('listAssociationRequests(authorityId) returns every request for that authority as AssociationRequestRead', async () => {
    const s = await setup()
    const deviceA = randomTestKeyPair()
    const deviceB = randomTestKeyPair()
    // submittedAt deliberately backdated by 50ms so it cannot coincidentally land on the same
    // millisecond as the engine's own receivedAt (Date.now() at call time) — a fast test run has
    // hit that exact collision before.
    const requestIdA = await submitDeviceRequest(s, deviceA, { submittedAt: toIsoZDatetime(Date.now() - 50) })
    const requestIdB = await submitDeviceRequest(s, deviceB)

    const all = await s.engine.listAssociationRequests(s.auth.authority.id)
    const ids = all.map((r) => r.requestId)
    expect(ids).to.include.members([requestIdA, requestIdB])
    for (const r of all) {
      expect(r.authorityId).to.equal(s.auth.authority.id)
      expect(r.registrantId).to.equal(s.registrantId)
      expect(r.deviceKey).to.be.a('string')
      expect(r.status).to.be.oneOf(['p', 'c', 'a', 'r'])
      expect(r.submittedAt).to.be.a('string')
      expect(r.receivedAt).to.be.a('string')
    }

    // 51-10's screen renders submittedAt/receivedAt as separate labelled fields and must never be
    // handed the same value twice.
    const rowA = all.find((r) => r.requestId === requestIdA)!
    expect(rowA.submittedAt).to.not.equal(rowA.receivedAt)
  })

  it("listAssociationRequests(authorityId, 'c') returns only the 'c' rows", async () => {
    const s = await setup()
    const challengedDevice = randomTestKeyPair()
    const stillPendingDevice = randomTestKeyPair()
    const challengedRequestId = await submitDeviceRequest(s, challengedDevice)
    const pendingRequestId = await submitDeviceRequest(s, stillPendingDevice)
    // Only issue leg 1 for the FIRST request — drive it directly via issueAttestationChallenge +
    // a raw transition so the SECOND request stays 'p' for this test's contrast.
    await s.engine.processPendingAssociationRequests(s.auth.authority.id, s.officerSign, s.transport)
    // The driver above processes BOTH pending rows (both move to 'c'). Answer only the first so
    // the second stays 'c' too — narrow the assertion to "every returned row has Status 'c'" and
    // "the filtered set excludes anything not 'c'" rather than depending on one staying 'p'.
    void pendingRequestId

    const cRows = await s.engine.listAssociationRequests(s.auth.authority.id, 'c')
    const cIds = cRows.map((r) => r.requestId)
    expect(cIds).to.include(challengedRequestId)
    for (const r of cRows) {
      expect(r.status, 'every row in a status-filtered read must carry that exact status').to.equal('c')
    }

    // Now resolve the first to 'a' and re-filter — it must disappear from the 'c' filter.
    await stageAnswer(s, challengedRequestId, challengedDevice, makeDeviceAttestation())
    await driveOnce(s)
    const cRowsAfter = await s.engine.listAssociationRequests(s.auth.authority.id, 'c')
    expect(cRowsAfter.map((r) => r.requestId)).to.not.include(challengedRequestId)
    const aRows = await s.engine.listAssociationRequests(s.auth.authority.id, 'a')
    expect(aRows.map((r) => r.requestId)).to.include(challengedRequestId)
  })

  it('getAssociationRequest returns the matching AssociationRequestRead for a known id, and undefined (never a throw) for an unknown id', async () => {
    const s = await setup()
    const deviceKeyPair = randomTestKeyPair()
    const requestId = await submitDeviceRequest(s, deviceKeyPair)

    const hit = await s.engine.getAssociationRequest(requestId)
    expect(hit, 'a known id must resolve').to.not.be.undefined
    expect(hit!.requestId).to.equal(requestId)
    expect(hit!.deviceKey).to.equal(deviceKeyPair.publicHex)
    expect(hit!.status).to.equal('p')

    let caught: unknown
    let miss: unknown
    try {
      miss = await s.engine.getAssociationRequest('no-such-request-id')
    } catch (err) {
      caught = err
    }
    expect(caught, 'an unknown id must never throw').to.be.undefined
    expect(miss, 'an unknown id resolves to undefined').to.be.undefined
  })

  it('the officer-key-absent case fails STRUCTURALLY at an AdminSigning signer CHECK, not merely at a lint gate', async () => {
    const s = await setup()
    const deviceKeyPair = randomTestKeyPair()
    const requestId = await submitDeviceRequest(s, deviceKeyPair)

    // A real User who is NOT an Officer of this authority — the D-09 structural regression this
    // gate exists to catch.
    const outsider = makeDistinctTestUser()
    const outsiderSign = makeTestSignCallback(outsider)

    let caught: unknown
    try {
      await s.engine.processPendingAssociationRequests(s.auth.authority.id, outsiderSign, s.transport)
    } catch (err) {
      caught = err
    }
    expect(caught, 'a non-officer signer must be structurally refused').to.be.instanceOf(Error)
    // The outsider is neither an Officer (UserIdValid) nor a registered UserKey holder (SignerKeyValid,
    // engine-computed since the hardcoded `IsSignerKeyValid = true` stub was replaced); whichever
    // Quereus reports first, the refusal is structural. A registered non-officer is refused by
    // OfficerValid in threshold-fanout.spec.ts T2.
    expect((caught as Error).message, 'the failure must name the structural CHECK, not an opaque error').to.match(/UserIdValid|SignerKeyValid/)

    const row = await s.auth.ctx.db.prepare('select Status from AssociationRequest where Id = :id').get({ id: requestId })
    expect(row?.Status, 'the row must remain pending — no partial transition on a refused ceremony').to.equal('p')
  })

  it('drives leg 2 with REAL captured iPhone App Attest bytes through the REAL PlatformDispatchingAttestationVerifier, producing a PASS AttestationVerdict', async () => {
    const s = await setup()
    const testDeviceKeyPair = makeP256TestKey()

    const realDispatcher = new PlatformDispatchingAttestationVerifier(
      new PlayIntegrityVerifier(
        { getDecryptionKey: async () => new Uint8Array(), getVerificationKey: async () => new Uint8Array() } as never,
        [],
        { packageName: 'org.votetorrent.voter', certificateSha256Digests: [] },
        new Set<string>(),
        false
      ),
      new AppAttestVerifier([APPLE_APP_ATTEST_ROOT_DER], APP_ID, 'development', undefined, true, FIXTURE_CAPTURED_AT)
    )
    const wrappedVerifier = new FixtureBoundVerifier(realDispatcher, fixture.challenge.nonce, fixture.challenge.deviceKey)
    const realBytesEngine = new AssociationEngine(s.auth.ctx, wrappedVerifier)

    const init: AssociationRequestInit = {
      id: crypto.randomUUID(),
      authorityId: s.auth.authority.id,
      registrantId: s.registrantId,
      deviceKey: testDeviceKeyPair.pubHex,
      submittedAt: toIsoZDatetime(Date.now())
    }
    const digestBytes = await requestDigest(s.auth.ctx, init)
    const requestSignature: Signature = {
      signature: bytesToHex(p256.sign(digestBytes, testDeviceKeyPair.privBytes)),
      signerKey: testDeviceKeyPair.pubHex,
      signerUserId: ''
    }
    const requestId = await realBytesEngine.submitAssociationRequest(init, testDeviceKeyPair.pubHex, requestSignature)

    await realBytesEngine.processPendingAssociationRequests(s.auth.authority.id, s.officerSign, s.transport)
    const nonce = await readChallengeNonce(s, requestId)

    const answer: AssociationAttestationAnswer = { requestId, nonce, attestation: fixture.attestation }
    const answerDigestBytes = await answerDigest(s.auth.ctx, answer)
    const answerSignature: Signature = {
      signature: bytesToHex(p256.sign(answerDigestBytes, testDeviceKeyPair.privBytes)),
      signerKey: testDeviceKeyPair.pubHex,
      signerUserId: ''
    }
    await s.transport.submitAttestation(answer, testDeviceKeyPair.pubHex, answerSignature)

    const result = await realBytesEngine.processPendingAssociationRequests(s.auth.authority.id, s.officerSign, s.transport)
    expect(result.associated, 'the real-bytes ceremony must associate').to.equal(1)
    expect(result.rejected).to.equal(0)

    const association = await realBytesEngine.getAssociation(s.registrantId, testDeviceKeyPair.pubHex)
    expect(association, 'a public Association row must exist for the real-bytes ceremony').to.not.be.undefined

    const verdicts = await realBytesEngine.getAttestationVerdicts(s.registrantId)
    expect(verdicts.length, 'exactly one verdict for this ceremony').to.equal(1)
    expect(verdicts[0]!.verdict, `verdict must be 'pass', got reason: ${String(verdicts[0]!.reason ?? '')}`).to.equal('pass')
  })
})
