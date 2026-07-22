/**
 * authority-transport.spec.ts — Phase 43-05 (D-11, D-03) end-to-end
 * round-trip: issueAttestationChallenge -> synthetic producer builds a
 * DeviceAttestation -> LocalAuthorityTransport.submitAssociate -> the REAL
 * PlayIntegrityVerifier (Wave 4) verifies -> AssociationEngine.associate
 * writes Association + AssociationPrivate.
 *
 * Proves D-03 (verifier + associate round-trip run in-process within the
 * authority peer, via LocalAuthorityTransport — NOT a dedicated backend
 * service) and D-11 (the transport seam is fully decoupled from any live
 * P2P substrate) entirely on Node.
 */

import 'reflect-metadata'
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { Signature } from '@votetorrent/vote-core'
import { SecurityLevel } from '@peculiar/asn1-android'
import { AssociationEngine } from '../src/association/association-engine.js'
import { PlayIntegrityVerifier } from '../src/association/play-integrity-verifier.js'
import type { IIntegrityKeyProvider } from '../src/association/key-provider.js'
import { LocalAuthorityTransport } from '../src/association/transport/local-authority-transport.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { createTestNetwork, addTestAuthority } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { generateSyntheticJweKeyMaterial } from './fixtures/attestation/synthetic-jwe.js'
import { generateTestRootCa } from './fixtures/attestation/test-root-ca.js'
import { buildSyntheticDeviceAttestation } from './fixtures/attestation/synthetic-device-attestation.js'

/** Build a real secp256k1 sign callback (@noble/curves v2 defaults — prehash:true). Mirrors association.spec.ts's helper. */
function makeRealSigner (userId: string): { sign: (digest: Uint8Array) => Promise<Signature> } {
  const { privateHex, publicHex } = randomTestKeyPair()
  const privBytes = hexToBytes(privateHex)
  const sign = async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes)
    return { signerUserId: userId, signerKey: publicHex, signature: bytesToHex(sig) }
  }
  return { sign }
}

let registrantSeq = 0
function nextRegistrantId (): string {
  registrantSeq += 1
  return `authtransport-registrant-${Date.now()}-${registrantSeq}`
}

let deviceSeq = 0
function nextDeviceKey (): string {
  deviceSeq += 1
  return `authtransport-device-key-${Date.now()}-${deviceSeq}`
}

const FUTURE_REGISTRANT_EXPIRATION = Date.now() + 365 * 86_400_000
const FUTURE_CHALLENGE_EXPIRATION = new Date(Date.now() + 10 * 60_000).toISOString()

describe('authority-transport (D-11/D-03): full round-trip against the real PlayIntegrityVerifier, no P2P', () => {
  it('accepting synthetic DeviceAttestation: transport.submitAssociate succeeds and writes Association + AssociationPrivate', async () => {
    // ---- Authority/engine/verifier/transport setup, entirely in-process (D-03) ----
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const { sign } = makeRealSigner(auth.user.id)

    const registrationEngine = new RegistrationEngine(auth.ctx)
    const registrantId = nextRegistrantId()
    await registrationEngine.createRegistrant(
      { id: registrantId, authorityId: auth.authority.id, privateCid: 'authtransport-test-private-cid', expiration: FUTURE_REGISTRANT_EXPIRATION },
      sign
    )

    const jweKeys = await generateSyntheticJweKeyMaterial()
    const testRoot = await generateTestRootCa()
    const keyProvider: IIntegrityKeyProvider = {
      getDecryptionKey: async () => jweKeys.decryptionKey,
      getVerificationKey: async () => jweKeys.verificationPublicKey
    }
    const verifier = new PlayIntegrityVerifier(keyProvider, [new Uint8Array(testRoot.cert.rawData)])
    const engine = new AssociationEngine(auth.ctx, verifier)
    const transport = new LocalAuthorityTransport(engine)

    const deviceKey = nextDeviceKey()
    const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, FUTURE_CHALLENGE_EXPIRATION, sign)
    await transport.sendChallenge(challenge) // documented no-op (D-03)

    const attestation = await buildSyntheticDeviceAttestation({ challenge, jweKeys, testRoot })

    await transport.submitAssociate({ registrantId, deviceKey, nonce: challenge.nonce, attestation }, sign)

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

  it('rejecting variant (failed device-integrity verdict): submitAssociate throws "attestation verification failed" and writes NO rows', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const { sign } = makeRealSigner(auth.user.id)

    const registrationEngine = new RegistrationEngine(auth.ctx)
    const registrantId = nextRegistrantId()
    await registrationEngine.createRegistrant(
      { id: registrantId, authorityId: auth.authority.id, privateCid: 'authtransport-test-private-cid-reject-1', expiration: FUTURE_REGISTRANT_EXPIRATION },
      sign
    )

    const jweKeys = await generateSyntheticJweKeyMaterial()
    const testRoot = await generateTestRootCa()
    const keyProvider: IIntegrityKeyProvider = {
      getDecryptionKey: async () => jweKeys.decryptionKey,
      getVerificationKey: async () => jweKeys.verificationPublicKey
    }
    const verifier = new PlayIntegrityVerifier(keyProvider, [new Uint8Array(testRoot.cert.rawData)])
    const engine = new AssociationEngine(auth.ctx, verifier)
    const transport = new LocalAuthorityTransport(engine)

    const deviceKey = nextDeviceKey()
    const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, FUTURE_CHALLENGE_EXPIRATION, sign)

    const attestation = await buildSyntheticDeviceAttestation({
      challenge,
      jweKeys,
      testRoot,
      overrides: { payload: { deviceRecognitionVerdict: ['FAILS_DEVICE_INTEGRITY'] } }
    })

    let thrown: unknown
    try {
      await transport.submitAssociate({ registrantId, deviceKey, nonce: challenge.nonce, attestation }, sign)
    } catch (err) {
      thrown = err
    }
    expect(thrown, 'expected submitAssociate to throw on a failed device-integrity verdict').to.be.instanceOf(Error)
    expect((thrown as Error).message).to.match(/attestation verification failed/)

    const associationCount = await auth.ctx.db
      .prepare('select count(*) as n from Association where RegistrantId = :registrantId and DeviceKey = :deviceKey')
      .get({ registrantId, deviceKey })
    expect(Number(associationCount?.n)).to.equal(0)
    const privateCount = await auth.ctx.db
      .prepare('select count(*) as n from AssociationPrivate where RegistrantId = :registrantId and DeviceKey = :deviceKey')
      .get({ registrantId, deviceKey })
    expect(Number(privateCount?.n)).to.equal(0)
  })

  it('rejecting variant (wrong nonce binding, D-06 relay attempt): submitAssociate throws and writes NO rows', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const { sign } = makeRealSigner(auth.user.id)

    const registrationEngine = new RegistrationEngine(auth.ctx)
    const registrantId = nextRegistrantId()
    await registrationEngine.createRegistrant(
      { id: registrantId, authorityId: auth.authority.id, privateCid: 'authtransport-test-private-cid-reject-2', expiration: FUTURE_REGISTRANT_EXPIRATION },
      sign
    )

    const jweKeys = await generateSyntheticJweKeyMaterial()
    const testRoot = await generateTestRootCa()
    const keyProvider: IIntegrityKeyProvider = {
      getDecryptionKey: async () => jweKeys.decryptionKey,
      getVerificationKey: async () => jweKeys.verificationPublicKey
    }
    const verifier = new PlayIntegrityVerifier(keyProvider, [new Uint8Array(testRoot.cert.rawData)])
    const engine = new AssociationEngine(auth.ctx, verifier)
    const transport = new LocalAuthorityTransport(engine)

    const deviceKey = nextDeviceKey()
    const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, FUTURE_CHALLENGE_EXPIRATION, sign)

    const attestation = await buildSyntheticDeviceAttestation({
      challenge,
      jweKeys,
      testRoot,
      overrides: { payloadNonce: 'this-is-not-the-bound-digest' }
    })

    let thrown: unknown
    try {
      await transport.submitAssociate({ registrantId, deviceKey, nonce: challenge.nonce, attestation }, sign)
    } catch (err) {
      thrown = err
    }
    expect(thrown, 'expected submitAssociate to throw on a wrong-nonce relay attempt').to.be.instanceOf(Error)
    expect((thrown as Error).message).to.match(/attestation verification failed/)

    const associationCount = await auth.ctx.db
      .prepare('select count(*) as n from Association where RegistrantId = :registrantId and DeviceKey = :deviceKey')
      .get({ registrantId, deviceKey })
    expect(Number(associationCount?.n)).to.equal(0)
    const privateCount = await auth.ctx.db
      .prepare('select count(*) as n from AssociationPrivate where RegistrantId = :registrantId and DeviceKey = :deviceKey')
      .get({ registrantId, deviceKey })
    expect(Number(privateCount?.n)).to.equal(0)
  })

  it('rejecting variant (Software-only key attestation, D-02): submitAssociate throws and writes NO rows', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const { sign } = makeRealSigner(auth.user.id)

    const registrationEngine = new RegistrationEngine(auth.ctx)
    const registrantId = nextRegistrantId()
    await registrationEngine.createRegistrant(
      { id: registrantId, authorityId: auth.authority.id, privateCid: 'authtransport-test-private-cid-reject-3', expiration: FUTURE_REGISTRANT_EXPIRATION },
      sign
    )

    const jweKeys = await generateSyntheticJweKeyMaterial()
    const testRoot = await generateTestRootCa()
    const keyProvider: IIntegrityKeyProvider = {
      getDecryptionKey: async () => jweKeys.decryptionKey,
      getVerificationKey: async () => jweKeys.verificationPublicKey
    }
    const verifier = new PlayIntegrityVerifier(keyProvider, [new Uint8Array(testRoot.cert.rawData)])
    const engine = new AssociationEngine(auth.ctx, verifier)
    const transport = new LocalAuthorityTransport(engine)

    const deviceKey = nextDeviceKey()
    const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, FUTURE_CHALLENGE_EXPIRATION, sign)

    const attestation = await buildSyntheticDeviceAttestation({
      challenge,
      jweKeys,
      testRoot,
      overrides: { securityLevel: SecurityLevel.software }
    })

    let thrown: unknown
    try {
      await transport.submitAssociate({ registrantId, deviceKey, nonce: challenge.nonce, attestation }, sign)
    } catch (err) {
      thrown = err
    }
    expect(thrown, 'expected submitAssociate to throw on a Software-only key attestation').to.be.instanceOf(Error)
    expect((thrown as Error).message).to.match(/attestation verification failed/)

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
