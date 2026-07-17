/**
 * association.spec.ts — Phase 42-04 real-engine spec for AssociationEngine +
 * StubAttestationVerifier + MockAssociationEngine + AssociationAssociateBuilder.
 *
 * Covers (per 42-04-PLAN.md):
 *   - Task 1: attestation-challenge issuance, the associate ceremony (seam
 *     verify -> AssociationPrivate -> public Association via AttestationCid),
 *     seam-reject, replay-reject, device-uniqueness reject + PollingDevice
 *     waiver-allow (D-06), StubAttestationVerifier unit behavior (D-07), and
 *     MockAssociationEngine parity.
 *   - Task 2: AssociationAssociateBuilder (KIND='association.associate')
 *     validation/delegation/serialization, root-barrel wiring.
 *   - Task 3: trust-boundary assertions (forged-field reject, nonce-replay
 *     structural reject, DeviceId non-disclosure, uniqueness reject).
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError
} from '@votetorrent/vote-core'
import type { AttestationChallenge, AttestationVerification, DeviceAttestation, IAttestationVerifier, Signature } from '@votetorrent/vote-core'
import { AssociationEngine } from '../src/association/association-engine.js'
import { MockAssociationEngine } from '../src/association/mock-association-engine.js'
import { StubAttestationVerifier } from '../src/association/stub-attestation-verifier.js'
import { AssociationAssociateBuilder } from '../src/association/builders/association-associate-builder.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { createTestNetwork, addTestAuthority, seedSignedMutation as seedSignedMutationFixture } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { digestToBytes, nowCanonicalDatetime } from '../src/utils.js'
import type { TestAuthorityContext } from './fixtures/test-context.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a real secp256k1 sign callback (@noble/curves v2 defaults — prehash:true). */
function makeRealSigner (userId: string): { sign: (digest: Uint8Array) => Promise<Signature>; publicHex: string; privateHex: string } {
  const { privateHex, publicHex } = randomTestKeyPair()
  const privBytes = hexToBytes(privateHex)
  const sign = async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes) // v2 default: prehash:true
    return { signerUserId: userId, signerKey: publicHex, signature: bytesToHex(sig) }
  }
  return { sign, publicHex, privateHex }
}

/** sha256(input) hex — mirrors association-engine.ts's internal (unexported) sha256Hex. */
function sha256Hex (input: string): string {
  return bytesToHex(sha256(utf8ToBytes(input)))
}

let registrantSeq = 0
function nextRegistrantId (): string {
  registrantSeq += 1
  return `assoc-registrant-${Date.now()}-${registrantSeq}`
}

let deviceSeq = 0
function nextDeviceKey (): string {
  deviceSeq += 1
  return `assoc-device-key-${Date.now()}-${deviceSeq}`
}

const FUTURE_REGISTRANT_EXPIRATION = Date.now() + 365 * 86_400_000
const FUTURE_CHALLENGE_EXPIRATION = new Date(Date.now() + 10 * 60_000).toISOString()

function makeDeviceAttestation (overrides?: Partial<DeviceAttestation>): DeviceAttestation {
  deviceSeq += 1
  return {
    publicKey: `device-pubkey-${deviceSeq}`,
    deviceId: `device-id-${Date.now()}-${deviceSeq}`,
    attestationTime: Date.now(),
    certificateChain: ['cert-a', 'cert-b'],
    ...overrides
  }
}

/** Seed an active Registrant (Status='a') for the attestation flow to associate against. */
async function setupAssociationTest (): Promise<{
  auth: TestAuthorityContext
  registrantId: string
  engine: AssociationEngine
  sign: (digest: Uint8Array) => Promise<Signature>
  publicHex: string
  privateHex: string
}> {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  const { sign, publicHex, privateHex } = makeRealSigner(auth.user.id)
  const registrationEngine = new RegistrationEngine(auth.ctx)
  const registrantId = nextRegistrantId()
  await registrationEngine.createRegistrant(
    { id: registrantId, authorityId: auth.authority.id, privateCid: 'assoc-test-private-cid-placeholder', expiration: FUTURE_REGISTRANT_EXPIRATION },
    sign
  )
  const engine = new AssociationEngine(auth.ctx)
  return { auth, registrantId, engine, sign, publicHex, privateHex }
}

/** Seed a PollingDevice whitelist entry (D-06 shared-tablet waiver) via a raw 'vrg' ceremony. */
async function seedPollingDevice (auth: TestAuthorityContext, deviceHash: string, label?: string): Promise<void> {
  const tid = Date.now() + Math.floor(Math.random() * 100_000)
  const digestExpr = 'select Digest(:tid, :authorityId, :deviceHash, :label) as d'
  const digestParams = { tid, authorityId: auth.authority.id, deviceHash, label: label ?? null }
  const { nonce } = await seedSignedMutationFixture(auth.ctx, auth.authority.id, 'vrg', tid, digestExpr, digestParams, auth.user)
  await auth.ctx.db.exec(
    `insert into PollingDevice (AuthorityId, DeviceHash, Label)
     with context SigningNonce = :nonce, Tid = ${tid}
     values (:authorityId, :deviceHash, :label)`,
    { authorityId: auth.authority.id, deviceHash, label: label ?? null, nonce }
  )
}

// ===========================================================================
// AssociationEngine — attestation-challenge issuance + associate ceremony (Task 1)
// ===========================================================================

describe('AssociationEngine', () => {
  describe('issueAttestationChallenge / removeAttestationChallenge', () => {
    it('issues a one-time AttestationChallenge bound to (RegistrantId, DeviceKey) with a short TTL', async () => {
      const { auth, registrantId, engine, sign } = await setupAssociationTest()
      const deviceKey = nextDeviceKey()

      const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, FUTURE_CHALLENGE_EXPIRATION, sign)
      expect(challenge.registrantId).to.equal(registrantId)
      expect(challenge.deviceKey).to.equal(deviceKey)
      expect(challenge.authorityId).to.equal(auth.authority.id)
      expect(challenge.nonce).to.be.a('string').with.length.greaterThan(0)

      const row = await auth.ctx.db
        .prepare('select count(*) as n from AttestationChallenge where Nonce = :nonce')
        .get({ nonce: challenge.nonce })
      expect(Number(row?.n)).to.equal(1)
    })

    it('authorizes the challenge insert via a vrg-scoped AdminSigning row', async () => {
      const { auth, registrantId, engine, sign } = await setupAssociationTest()
      const deviceKey = nextDeviceKey()
      await engine.issueAttestationChallenge(registrantId, deviceKey, FUTURE_CHALLENGE_EXPIRATION, sign)
      const row = await auth.ctx.db
        .prepare(`select count(*) as n from AdminSigning where AuthorityId = :id and Scope = 'vrg'`)
        .get({ id: auth.authority.id })
      expect(Number(row?.n)).to.be.greaterThan(0)
    })

    it('removeAttestationChallenge deletes the row via its own vrg-signed delete', async () => {
      const { auth, registrantId, engine, sign } = await setupAssociationTest()
      const deviceKey = nextDeviceKey()
      const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, FUTURE_CHALLENGE_EXPIRATION, sign)

      await engine.removeAttestationChallenge(challenge.nonce, sign)

      const row = await auth.ctx.db
        .prepare('select count(*) as n from AttestationChallenge where Nonce = :nonce')
        .get({ nonce: challenge.nonce })
      expect(Number(row?.n)).to.equal(0)
    })
  })

  describe('associate — happy path', () => {
    it('verifies the seam, writes AssociationPrivate then the public Association (AttestationCid), Association=1/AssociationPrivate=1', async () => {
      const { auth, registrantId, engine, sign } = await setupAssociationTest()
      const deviceKey = nextDeviceKey()
      const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, FUTURE_CHALLENGE_EXPIRATION, sign)
      const attestation = makeDeviceAttestation()

      await engine.associate({ registrantId, deviceKey, nonce: challenge.nonce, attestation }, sign)

      const associationCount = await auth.ctx.db
        .prepare('select count(*) as n from Association where RegistrantId = :registrantId and DeviceKey = :deviceKey')
        .get({ registrantId, deviceKey })
      expect(Number(associationCount?.n)).to.equal(1)

      const privateCount = await auth.ctx.db
        .prepare('select count(*) as n from AssociationPrivate where RegistrantId = :registrantId and DeviceKey = :deviceKey')
        .get({ registrantId, deviceKey })
      expect(Number(privateCount?.n)).to.equal(1)

      const association = await engine.getAssociation(registrantId, deviceKey)
      expect(association).to.not.be.undefined
      expect(association!.attestationCid).to.be.a('string').with.length.greaterThan(0)
    })

    it('carries deviceHash through to the public Association row when supplied', async () => {
      const { registrantId, engine, sign } = await setupAssociationTest()
      const deviceKey = nextDeviceKey()
      const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, FUTURE_CHALLENGE_EXPIRATION, sign)
      const attestation = makeDeviceAttestation()
      const deviceHash = sha256Hex(attestation.deviceId)

      await engine.associate({ registrantId, deviceKey, deviceHash, nonce: challenge.nonce, attestation }, sign)

      const association = await engine.getAssociation(registrantId, deviceKey)
      expect(association!.deviceHash).to.equal(deviceHash)
    })
  })

  describe('associate — seam-reject (D-07)', () => {
    it('writes no Association/AssociationPrivate row and throws when the verifier returns ok:false', async () => {
      const { auth, registrantId, engine: _unused, sign } = await setupAssociationTest()
      const rejectingVerifier: IAttestationVerifier = {
        async verify (): Promise<AttestationVerification> {
          return { ok: false, reason: 'simulated rejection' }
        }
      }
      const engine = new AssociationEngine(auth.ctx, rejectingVerifier)
      const deviceKey = nextDeviceKey()
      const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, FUTURE_CHALLENGE_EXPIRATION, sign)
      const attestation = makeDeviceAttestation()

      let threw = false
      try {
        await engine.associate({ registrantId, deviceKey, nonce: challenge.nonce, attestation }, sign)
      } catch {
        threw = true
      }
      expect(threw, 'expected associate() to throw on seam rejection').to.be.true

      const associationCount = await auth.ctx.db
        .prepare('select count(*) as n from Association where RegistrantId = :registrantId and DeviceKey = :deviceKey')
        .get({ registrantId, deviceKey })
      expect(Number(associationCount?.n)).to.equal(0)
      const privateCount = await auth.ctx.db
        .prepare('select count(*) as n from AssociationPrivate where RegistrantId = :registrantId and DeviceKey = :deviceKey')
        .get({ registrantId, deviceKey })
      expect(Number(privateCount?.n)).to.equal(0)
    })
  })

  describe('associate — replay-reject (D-06 structural)', () => {
    it('rejects a second associate for the same (RegistrantId, DeviceKey) — Association PK collision, no 2nd row', async () => {
      const { auth, registrantId, engine, sign } = await setupAssociationTest()
      const deviceKey = nextDeviceKey()
      const challenge1 = await engine.issueAttestationChallenge(registrantId, deviceKey, FUTURE_CHALLENGE_EXPIRATION, sign)
      await engine.associate({ registrantId, deviceKey, nonce: challenge1.nonce, attestation: makeDeviceAttestation() }, sign)

      // A second challenge for the SAME (registrantId, deviceKey) — the challenge layer
      // permits re-issuance, but the Association PK still structurally blocks a 2nd row.
      const challenge2 = await engine.issueAttestationChallenge(registrantId, deviceKey, FUTURE_CHALLENGE_EXPIRATION, sign)
      let threw = false
      try {
        await engine.associate({ registrantId, deviceKey, nonce: challenge2.nonce, attestation: makeDeviceAttestation() }, sign)
      } catch {
        threw = true
      }
      expect(threw, 'expected the second associate() to be rejected by the Association PK').to.be.true

      const row = await auth.ctx.db
        .prepare('select count(*) as n from Association where RegistrantId = :registrantId and DeviceKey = :deviceKey')
        .get({ registrantId, deviceKey })
      expect(Number(row?.n)).to.equal(1)
    })
  })

  describe('associate — device uniqueness (D-06) + PollingDevice waiver', () => {
    it('rejects associating a DeviceId already bound to a different registrant when no waiver exists', async () => {
      const { auth, registrantId: registrantA, engine, sign } = await setupAssociationTest()
      const registrationEngine = new RegistrationEngine(auth.ctx)
      const registrantB = nextRegistrantId()
      await registrationEngine.createRegistrant(
        { id: registrantB, authorityId: auth.authority.id, privateCid: 'assoc-test-private-cid-b', expiration: FUTURE_REGISTRANT_EXPIRATION },
        sign
      )

      const sharedDeviceId = `shared-device-${Date.now()}`
      const deviceKeyA = nextDeviceKey()
      const challengeA = await engine.issueAttestationChallenge(registrantA, deviceKeyA, FUTURE_CHALLENGE_EXPIRATION, sign)
      await engine.associate({ registrantId: registrantA, deviceKey: deviceKeyA, nonce: challengeA.nonce, attestation: makeDeviceAttestation({ deviceId: sharedDeviceId }) }, sign)

      const deviceKeyB = nextDeviceKey()
      const challengeB = await engine.issueAttestationChallenge(registrantB, deviceKeyB, FUTURE_CHALLENGE_EXPIRATION, sign)
      let threw = false
      try {
        await engine.associate({ registrantId: registrantB, deviceKey: deviceKeyB, nonce: challengeB.nonce, attestation: makeDeviceAttestation({ deviceId: sharedDeviceId }) }, sign)
      } catch {
        threw = true
      }
      expect(threw, 'expected the second registrant reusing the same DeviceId to be rejected without a waiver').to.be.true

      const row = await auth.ctx.db
        .prepare('select count(*) as n from AssociationPrivate where RegistrantId = :registrantId')
        .get({ registrantId: registrantB })
      expect(Number(row?.n)).to.equal(0)
    })

    it('allows the second registrant to reuse the same DeviceId once a PollingDevice waiver is seeded', async () => {
      const { auth, registrantId: registrantA, engine, sign } = await setupAssociationTest()
      const registrationEngine = new RegistrationEngine(auth.ctx)
      const registrantB = nextRegistrantId()
      await registrationEngine.createRegistrant(
        { id: registrantB, authorityId: auth.authority.id, privateCid: 'assoc-test-private-cid-b2', expiration: FUTURE_REGISTRANT_EXPIRATION },
        sign
      )

      const sharedDeviceId = `shared-device-waived-${Date.now()}`
      const deviceKeyA = nextDeviceKey()
      const challengeA = await engine.issueAttestationChallenge(registrantA, deviceKeyA, FUTURE_CHALLENGE_EXPIRATION, sign)
      await engine.associate({ registrantId: registrantA, deviceKey: deviceKeyA, nonce: challengeA.nonce, attestation: makeDeviceAttestation({ deviceId: sharedDeviceId }) }, sign)

      // Seed the PollingDevice whitelist entry for sha256(sharedDeviceId).
      await seedPollingDevice(auth, sha256Hex(sharedDeviceId), 'Precinct 7 shared tablet')

      const deviceKeyB = nextDeviceKey()
      const challengeB = await engine.issueAttestationChallenge(registrantB, deviceKeyB, FUTURE_CHALLENGE_EXPIRATION, sign)
      await engine.associate({ registrantId: registrantB, deviceKey: deviceKeyB, nonce: challengeB.nonce, attestation: makeDeviceAttestation({ deviceId: sharedDeviceId }) }, sign)

      const row = await auth.ctx.db
        .prepare('select count(*) as n from AssociationPrivate where RegistrantId = :registrantId and DeviceId = :deviceId')
        .get({ registrantId: registrantB, deviceId: sharedDeviceId })
      expect(Number(row?.n)).to.equal(1)
    })
  })

  describe('MockAssociationEngine parity', () => {
    it('exposes the same IAssociationEngine surface (buildAssociate + issue/associate/get) without a DB', async () => {
      const mock = new MockAssociationEngine()
      const registrantId = nextRegistrantId()
      const deviceKey = nextDeviceKey()
      const dummySig: Signature = { signature: 'a'.repeat(128), signerKey: 'b'.repeat(66), signerUserId: 'user-1' }

      const challenge = await mock.issueAttestationChallenge(registrantId, deviceKey, FUTURE_CHALLENGE_EXPIRATION, dummySig)
      expect(challenge.nonce).to.be.a('string').with.length.greaterThan(0)

      await mock.associate({ registrantId, deviceKey, nonce: challenge.nonce, attestation: makeDeviceAttestation() }, dummySig)
      const association = await mock.getAssociation(registrantId, deviceKey)
      expect(association).to.not.be.undefined
      expect(association!.registrantId).to.equal(registrantId)

      let threw = false
      try {
        await mock.associate({ registrantId, deviceKey, nonce: challenge.nonce, attestation: makeDeviceAttestation() }, dummySig)
      } catch {
        threw = true
      }
      expect(threw, 'expected a second associate() for the same key to throw (mock replay parity)').to.be.true
    })
  })
})

// ===========================================================================
// StubAttestationVerifier — D-07 seam unit behavior
// ===========================================================================

describe('StubAttestationVerifier', () => {
  const verifier = new StubAttestationVerifier()

  function makeChallenge (overrides?: Partial<AttestationChallenge>): AttestationChallenge {
    return {
      nonce: 'challenge-nonce-1',
      authorityId: 'authority-1',
      registrantId: 'registrant-1',
      deviceKey: 'device-key-1',
      expiration: new Date(Date.now() + 60_000).toISOString(),
      ...overrides
    }
  }

  it('returns ok:true for a non-expired challenge with no platform-level nonce to check (iOS shape)', async () => {
    const result = await verifier.verify(makeChallenge(), makeDeviceAttestation())
    expect(result.ok).to.equal(true)
  })

  it('returns ok:false for an expired challenge', async () => {
    const expired = makeChallenge({ expiration: new Date(Date.now() - 60_000).toISOString() })
    const result = await verifier.verify(expired, makeDeviceAttestation())
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/expired/)
  })

  it('returns ok:true when the Android platform nonce matches the challenge nonce', async () => {
    const challenge = makeChallenge({ nonce: 'match-me' })
    const attestation = makeDeviceAttestation({
      platformDetails: { type: 'Android', safetyNetAttestation: 'blob', keystorePublicKey: 'kpk', nonce: 'match-me' }
    })
    const result = await verifier.verify(challenge, attestation)
    expect(result.ok).to.equal(true)
  })

  it('returns ok:false when the Android platform nonce does NOT match the challenge nonce', async () => {
    const challenge = makeChallenge({ nonce: 'expected-nonce' })
    const attestation = makeDeviceAttestation({
      platformDetails: { type: 'Android', safetyNetAttestation: 'blob', keystorePublicKey: 'kpk', nonce: 'wrong-nonce' }
    })
    const result = await verifier.verify(challenge, attestation)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/nonce/)
  })
})

// ===========================================================================
// AssociationAssociateBuilder — validation/delegation/serialization (Task 2)
// ===========================================================================

describe('AssociationAssociateBuilder', () => {
  it('has the expected KIND/KIND_VERSION', () => {
    expect(AssociationAssociateBuilder.KIND).to.equal('association.associate')
    expect(AssociationAssociateBuilder.KIND_VERSION).to.equal(1)
  })

  it('commit() validates, delegates 1:1 to engine.associate, and lands both rows', async () => {
    const { auth, registrantId, engine, sign } = await setupAssociationTest()
    const deviceKey = nextDeviceKey()
    const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, FUTURE_CHALLENGE_EXPIRATION, sign)

    const builder = engine
      .buildAssociate()
      .setRegistrantId(registrantId)
      .setDeviceKey(deviceKey)
      .setNonce(challenge.nonce)
      .setAttestation(makeDeviceAttestation())
      .setSignatureOrCallback(sign)

    await builder.commit()

    const row = await auth.ctx.db
      .prepare('select count(*) as n from Association where RegistrantId = :registrantId and DeviceKey = :deviceKey')
      .get({ registrantId, deviceKey })
    expect(Number(row?.n)).to.equal(1)
  })

  it('throws BuilderValidationError from toEngineInput()/commit() when required fields are missing', async () => {
    const { engine } = await setupAssociationTest()
    const builder = engine.buildAssociate()
    expect(() => builder.toEngineInput()).to.throw(BuilderValidationError)
    let threw = false
    try {
      await builder.commit()
    } catch (err) {
      threw = err instanceof BuilderValidationError
    }
    expect(threw, 'expected commit() to throw BuilderValidationError').to.be.true
  })

  it('rejects a cross-field Android platform-nonce mismatch before any engine call', async () => {
    const { registrantId, engine, sign } = await setupAssociationTest()
    const deviceKey = nextDeviceKey()
    const builder = engine
      .buildAssociate()
      .setRegistrantId(registrantId)
      .setDeviceKey(deviceKey)
      .setNonce('the-real-nonce')
      .setAttestation(makeDeviceAttestation({
        platformDetails: { type: 'Android', safetyNetAttestation: 'blob', keystorePublicKey: 'kpk', nonce: 'a-different-nonce' }
      }))
      .setSignatureOrCallback(sign)

    expect(() => builder.toEngineInput()).to.throw(BuilderValidationError)
  })

  it('throws BuilderAlreadyCommittedError on a second commit()', async () => {
    const { registrantId, engine, sign } = await setupAssociationTest()
    const deviceKey = nextDeviceKey()
    const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, FUTURE_CHALLENGE_EXPIRATION, sign)
    const builder = engine
      .buildAssociate()
      .setRegistrantId(registrantId)
      .setDeviceKey(deviceKey)
      .setNonce(challenge.nonce)
      .setAttestation(makeDeviceAttestation())
      .setSignatureOrCallback(sign)

    await builder.commit()
    let threw = false
    try {
      await builder.commit()
    } catch (err) {
      threw = err instanceof BuilderAlreadyCommittedError
    }
    expect(threw, 'expected the second commit() to throw BuilderAlreadyCommittedError').to.be.true
  })

  it('round-trips a draft via toJSON()/fromJSON() (minus the non-serializable signature callback)', async () => {
    const { registrantId, engine } = await setupAssociationTest()
    const deviceKey = nextDeviceKey()
    const attestation = makeDeviceAttestation()
    const builder = engine
      .buildAssociate()
      .setRegistrantId(registrantId)
      .setDeviceKey(deviceKey)
      .setNonce('some-nonce')
      .setAttestation(attestation)

    const json = builder.toJSON()
    expect(json.kind).to.equal('association.associate')
    expect(json.version).to.equal(1)

    const restored = AssociationAssociateBuilder.fromJSON(json, engine)
    const input = restored.toEngineInput()
    expect(input.registrantId).to.equal(registrantId)
    expect(input.deviceKey).to.equal(deviceKey)
    expect(input.attestation.deviceId).to.equal(attestation.deviceId)
  })
})

// ===========================================================================
// Association trust boundaries (Task 3)
// ===========================================================================

describe('Association trust boundaries', () => {
  it('T-42-01: a forged/altered field on the Association insert is rejected by InsertValid re-derivation — no row lands', async () => {
    const { auth, registrantId, sign } = await setupAssociationTest()
    const deviceKey = nextDeviceKey()
    const honestDeviceHash = 'honest-hash-value'
    const forgedDeviceHash = 'forged-hash-value'
    const expiration = new Date(Date.now() + 3_600_000).toISOString()

    // Real row-level signature over the HONEST field set (SignatureValid's own digest formula).
    const rowDigestRow = await auth.ctx.db
      .prepare('select Digest(:registrantId, :deviceKey, :deviceHash, :attestationCid, :expiration) as d')
      .get({ registrantId, deviceKey, deviceHash: honestDeviceHash, attestationCid: null, expiration })
    const realSig = await sign(digestToBytes(rowDigestRow!.d))

    // Seed the 'vrg' AdminSigning ceremony's digest around the HONEST DeviceHash.
    const tid = Date.now() + Math.floor(Math.random() * 100_000)
    const digestExpr = 'select Digest(:tid, :registrantId, :deviceKey, :deviceHash, :attestationCid, :expiration, :rowSignorKey, :rowSignature) as d'
    const digestParams = {
      tid,
      registrantId,
      deviceKey,
      deviceHash: honestDeviceHash,
      attestationCid: null,
      expiration,
      rowSignorKey: realSig.signerKey,
      rowSignature: realSig.signature
    }
    const { nonce } = await seedSignedMutationFixture(auth.ctx, auth.authority.id, 'vrg', tid, digestExpr, digestParams, auth.user)

    let caught: unknown
    try {
      // Attempt the insert with a FORGED DeviceHash — the stored AdminSigning.Digest
      // (computed above with the honest value) will not match InsertValid's re-derivation.
      await auth.ctx.db.exec(
        `insert into Association (RegistrantId, DeviceKey, DeviceHash, AttestationCid, Expiration, SignorKey, Signature)
         with context SigningNonce = :nonce, Tid = ${tid}, now = :now
         values (:registrantId, :deviceKey, :deviceHash, null, :expiration, :signorKey, :signature)`,
        {
          registrantId,
          deviceKey,
          deviceHash: forgedDeviceHash,
          expiration,
          signorKey: realSig.signerKey,
          signature: realSig.signature,
          nonce,
          now: nowCanonicalDatetime()
        }
      )
    } catch (err) {
      caught = err
    }
    expect(caught, 'expected the forged-field insert to be rejected').to.be.instanceOf(Error)

    const row = await auth.ctx.db
      .prepare('select count(*) as n from Association where RegistrantId = :registrantId and DeviceKey = :deviceKey')
      .get({ registrantId, deviceKey })
    expect(Number(row?.n)).to.equal(0)
  })

  it('T-42-02: a challenge nonce cannot be redirected to a different (RegistrantId, DeviceKey) pair', async () => {
    const { registrantId, engine, sign } = await setupAssociationTest()
    const deviceKeyA = nextDeviceKey()
    const deviceKeyB = nextDeviceKey()
    const challenge = await engine.issueAttestationChallenge(registrantId, deviceKeyA, FUTURE_CHALLENGE_EXPIRATION, sign)

    let threw = false
    try {
      // Attempt to answer the SAME nonce for a DIFFERENT deviceKey — the engine's
      // (nonce, registrantId, deviceKey) lookup must fail to find a bound challenge.
      await engine.associate({ registrantId, deviceKey: deviceKeyB, nonce: challenge.nonce, attestation: makeDeviceAttestation() }, sign)
    } catch {
      threw = true
    }
    expect(threw, 'expected the redirected nonce to be rejected').to.be.true
  })

  it('T-42-03: the public Association read surface exposes at most DeviceHash — never AssociationPrivate.DeviceId', async () => {
    const { registrantId, engine, sign } = await setupAssociationTest()
    const deviceKey = nextDeviceKey()
    const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, FUTURE_CHALLENGE_EXPIRATION, sign)
    const attestation = makeDeviceAttestation()
    const deviceHash = sha256Hex(attestation.deviceId)

    await engine.associate({ registrantId, deviceKey, deviceHash, nonce: challenge.nonce, attestation }, sign)

    const association = await engine.getAssociation(registrantId, deviceKey)
    expect(association).to.not.be.undefined
    expect(association).to.not.have.property('deviceId')
    expect(Object.keys(association!).sort()).to.deep.equal(
      ['attestationCid', 'deviceHash', 'deviceKey', 'expiration', 'registrantId', 'signature', 'signorKey'].sort()
    )
    expect(association!.deviceHash).to.equal(deviceHash)
    expect(association!.deviceHash).to.not.equal(attestation.deviceId)
  })

  it('T-42-04: without a PollingDevice waiver, a second registrant reusing a DeviceId is rejected (explicit re-assertion)', async () => {
    const { auth, registrantId: registrantA, engine, sign } = await setupAssociationTest()
    const registrationEngine = new RegistrationEngine(auth.ctx)
    const registrantB = nextRegistrantId()
    await registrationEngine.createRegistrant(
      { id: registrantB, authorityId: auth.authority.id, privateCid: 'assoc-test-private-cid-t42-04', expiration: FUTURE_REGISTRANT_EXPIRATION },
      sign
    )
    const sharedDeviceId = `shared-device-t42-04-${Date.now()}`
    const deviceKeyA = nextDeviceKey()
    const challengeA = await engine.issueAttestationChallenge(registrantA, deviceKeyA, FUTURE_CHALLENGE_EXPIRATION, sign)
    await engine.associate({ registrantId: registrantA, deviceKey: deviceKeyA, nonce: challengeA.nonce, attestation: makeDeviceAttestation({ deviceId: sharedDeviceId }) }, sign)

    const deviceKeyB = nextDeviceKey()
    const challengeB = await engine.issueAttestationChallenge(registrantB, deviceKeyB, FUTURE_CHALLENGE_EXPIRATION, sign)
    let threw = false
    try {
      await engine.associate({ registrantId: registrantB, deviceKey: deviceKeyB, nonce: challengeB.nonce, attestation: makeDeviceAttestation({ deviceId: sharedDeviceId }) }, sign)
    } catch {
      threw = true
    }
    expect(threw, 'expected device-uniqueness to reject the unwaived reuse').to.be.true
  })
})
