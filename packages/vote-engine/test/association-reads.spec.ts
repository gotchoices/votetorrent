/**
 * association-reads.spec.ts — Phase 47-04 (D-11) real-engine spec for
 * `AssociationEngine.getAssociations` / `getAttestationChallenges`, the
 * T-47-05 disclosure-boundary lock, and `MockAssociationEngine` parity.
 *
 * File-local helpers below are copied from `association.spec.ts` (they are
 * not exported there) with `assoc-read-` id prefixes so seeded ids cannot
 * collide with `association.spec.ts`'s rows inside the same mocha process.
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import type { DeviceAttestation, Signature } from '@votetorrent/vote-core'
import { AssociationEngine } from '../src/association/association-engine.js'
import { MockAssociationEngine } from '../src/association/mock-association-engine.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { createTestNetwork, addTestAuthority, addTestElection, testKeyPairFor } from './fixtures/test-context.js'
import type { TestAuthorityContext } from './fixtures/test-context.js'

// ---------------------------------------------------------------------------
// Helpers (copied from association.spec.ts, assoc-read- id prefixes)
// ---------------------------------------------------------------------------

/** Build a real secp256k1 sign callback (@noble/curves v2 defaults — prehash:true). */
function makeRealSigner (userId: string): { sign: (digest: Uint8Array) => Promise<Signature>; publicHex: string; privateHex: string } {
  const { privateHex, publicHex } = testKeyPairFor(userId)
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
  return `assoc-read-registrant-${Date.now()}-${registrantSeq}`
}

let deviceSeq = 0
function nextDeviceKey (): string {
  deviceSeq += 1
  return `assoc-read-device-key-${Date.now()}-${deviceSeq}`
}

const FUTURE_REGISTRANT_EXPIRATION = Date.now() + 365 * 86_400_000

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

/** Seed an active Registrant (Status='a') for the read surface to associate against. */
async function setupAssociationTest (): Promise<{
  auth: TestAuthorityContext
  registrantId: string
  engine: AssociationEngine
  sign: (digest: Uint8Array) => Promise<Signature>
}> {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  const { sign } = makeRealSigner(auth.user.id)
  const registrationEngine = new RegistrationEngine(auth.ctx)
  const registrantId = nextRegistrantId()
  await registrationEngine.createRegistrant(
    { id: registrantId, authorityId: auth.authority.id, privateCid: 'assoc-read-test-private-cid-placeholder', expiration: FUTURE_REGISTRANT_EXPIRATION },
    sign
  )
  const engine = new AssociationEngine(auth.ctx)
  return { auth, registrantId, engine, sign }
}

/** Seed a second registrant under the same already-established authority context. */
async function seedRegistrant (auth: TestAuthorityContext, sign: (digest: Uint8Array) => Promise<Signature>): Promise<string> {
  const registrationEngine = new RegistrationEngine(auth.ctx)
  const registrantId = nextRegistrantId()
  await registrationEngine.createRegistrant(
    { id: registrantId, authorityId: auth.authority.id, privateCid: 'assoc-read-test-private-cid-placeholder-2', expiration: FUTURE_REGISTRANT_EXPIRATION },
    sign
  )
  return registrantId
}

/** Issue a challenge + associate a device for a registrant against the real engine. */
async function associateDevice (
  engine: AssociationEngine,
  registrantId: string,
  sign: (digest: Uint8Array) => Promise<Signature>,
  overrides?: { deviceKey?: string; deviceHash?: string; attestation?: DeviceAttestation }
): Promise<{ deviceKey: string; attestation: DeviceAttestation }> {
  const deviceKey = overrides?.deviceKey ?? nextDeviceKey()
  const attestation = overrides?.attestation ?? makeDeviceAttestation()
  const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, sign)
  await engine.associate({ registrantId, deviceKey, deviceHash: overrides?.deviceHash, nonce: challenge.nonce, attestation }, sign)
  return { deviceKey, attestation }
}

const ASSOCIATION_KEYS = ['attestationCid', 'deviceHash', 'deviceKey', 'expiration', 'registrantId', 'signature', 'signorKey']

// ===========================================================================

describe('AssociationEngine read surface', () => {
  describe('getAssociations', () => {
    it('returns every public Association bound to a registrant, distinct from a sibling registrant', async () => {
      const { auth, registrantId: registrantA, engine, sign } = await setupAssociationTest()
      const registrantB = await seedRegistrant(auth, sign)

      const { deviceKey: deviceKeyA1 } = await associateDevice(engine, registrantA, sign)
      const { deviceKey: deviceKeyA2 } = await associateDevice(engine, registrantA, sign)
      await associateDevice(engine, registrantB, sign)

      const rowsA = await engine.getAssociations(registrantA)
      expect(rowsA).to.have.length(2)
      expect(rowsA.map((r) => r.deviceKey).sort()).to.deep.equal([deviceKeyA1, deviceKeyA2].sort())
      expect(rowsA.every((r) => r.registrantId === registrantA)).to.be.true

      const rowsB = await engine.getAssociations(registrantB)
      expect(rowsB).to.have.length(1)
    })

    it('returns [] for a registrant with zero associations, and [] (not a throw) on an unwired engine', async () => {
      const { registrantId, engine } = await setupAssociationTest()
      expect(await engine.getAssociations(registrantId)).to.deep.equal([])

      const unwired = new AssociationEngine()
      expect(await unwired.getAssociations('any-registrant')).to.deep.equal([])
    })

    it('T-47-05: getAssociations must not widen getAssociation\'s disclosure boundary', async () => {
      const { registrantId, engine, sign } = await setupAssociationTest()
      const attestation = makeDeviceAttestation()
      const deviceHash = sha256Hex(attestation.deviceId)
      const { deviceKey } = await associateDevice(engine, registrantId, sign, { deviceHash, attestation })

      const rows = await engine.getAssociations(registrantId)
      expect(rows).to.have.length(1)

      const boundaryMsg = 'getAssociations must not widen getAssociation\'s disclosure boundary'
      expect(rows[0], boundaryMsg).to.not.have.property('deviceId')
      expect(Object.keys(rows[0]).sort(), boundaryMsg).to.deep.equal(ASSOCIATION_KEYS.sort())

      const pointRead = await engine.getAssociation(registrantId, deviceKey)
      expect(pointRead, boundaryMsg).to.not.be.undefined
      expect(Object.keys(rows[0]).sort(), boundaryMsg).to.deep.equal(Object.keys(pointRead!).sort())

      expect(JSON.stringify(rows), boundaryMsg).to.not.include(attestation.deviceId)
    })

    it('expiration is Z-suffixed and byte-identical to the point read\'s value for the same row', async () => {
      const { registrantId, engine, sign } = await setupAssociationTest()
      const { deviceKey } = await associateDevice(engine, registrantId, sign)

      const rows = await engine.getAssociations(registrantId)
      expect(rows).to.have.length(1)
      expect(rows[0].expiration.endsWith('Z')).to.be.true

      const pointRead = await engine.getAssociation(registrantId, deviceKey)
      expect(rows[0].expiration).to.equal(pointRead!.expiration)
    })
  })

  describe('getAssociationsByDeviceKey', () => {
    it('returns exactly the rows for a device key bound to two different registrants, and a sibling device key\'s row is absent', async () => {
      const { auth, registrantId: registrantA, engine, sign } = await setupAssociationTest()
      const registrantB = await seedRegistrant(auth, sign)
      const sharedDeviceKey = nextDeviceKey()
      const siblingDeviceKey = nextDeviceKey()

      // PK is (RegistrantId, DeviceKey) — the SAME deviceKey bound to two different
      // registrants is a legal pair of rows.
      await associateDevice(engine, registrantA, sign, { deviceKey: sharedDeviceKey })
      await associateDevice(engine, registrantB, sign, { deviceKey: sharedDeviceKey })
      await associateDevice(engine, registrantA, sign, { deviceKey: siblingDeviceKey })

      const rows = await engine.getAssociationsByDeviceKey(sharedDeviceKey)
      expect(rows).to.have.length(2)
      expect(rows.map((r) => r.registrantId).sort()).to.deep.equal([registrantA, registrantB].sort())
      expect(rows.every((r) => r.deviceKey === sharedDeviceKey)).to.be.true
    })

    it('orders results by registrantId ascending, against a deliberately reverse-sorted seeding order', async () => {
      const { auth, registrantId: registrantA, engine, sign } = await setupAssociationTest()
      const registrantB = await seedRegistrant(auth, sign)
      const registrantC = await seedRegistrant(auth, sign)
      const sharedDeviceKey = nextDeviceKey()
      const expectedOrder = [registrantA, registrantB, registrantC].sort()

      // Seed in the REVERSE of registrantId-ascending order so the assertion below
      // cannot pass by insertion accident.
      await associateDevice(engine, registrantC, sign, { deviceKey: sharedDeviceKey })
      await associateDevice(engine, registrantB, sign, { deviceKey: sharedDeviceKey })
      await associateDevice(engine, registrantA, sign, { deviceKey: sharedDeviceKey })

      const rows = await engine.getAssociationsByDeviceKey(sharedDeviceKey)
      expect(rows.map((r) => r.registrantId)).to.deep.equal(expectedOrder)
    })

    it('returns [] for a device key with zero Association rows', async () => {
      const { engine } = await setupAssociationTest()
      expect(await engine.getAssociationsByDeviceKey(nextDeviceKey())).to.deep.equal([])
    })

    it('returns [] (not a throw) on an unwired engine', async () => {
      const unwired = new AssociationEngine()
      expect(await unwired.getAssociationsByDeviceKey('any-device-key')).to.deep.equal([])
    })

    it('T-59-03-01: disclosure boundary matches getAssociation\'s — same 7 keys, no deviceId leak', async () => {
      const { registrantId, engine, sign } = await setupAssociationTest()
      const attestation = makeDeviceAttestation()
      const deviceHash = sha256Hex(attestation.deviceId)
      const { deviceKey } = await associateDevice(engine, registrantId, sign, { deviceHash, attestation })

      const rows = await engine.getAssociationsByDeviceKey(deviceKey)
      expect(rows).to.have.length(1)

      const boundaryMsg = 'getAssociationsByDeviceKey must not widen getAssociation\'s disclosure boundary'
      expect(rows[0], boundaryMsg).to.not.have.property('deviceId')
      expect(Object.keys(rows[0]).sort(), boundaryMsg).to.deep.equal(ASSOCIATION_KEYS.sort())

      const pointRead = await engine.getAssociation(registrantId, deviceKey)
      expect(pointRead, boundaryMsg).to.not.be.undefined
      expect(Object.keys(rows[0]).sort(), boundaryMsg).to.deep.equal(Object.keys(pointRead!).sort())

      expect(JSON.stringify(rows), boundaryMsg).to.not.include(attestation.deviceId)
    })
  })

  describe('getAttestationChallenges', () => {
    it('the no-arg call returns every outstanding challenge; the registrantId call narrows to one registrant', async () => {
      const { auth, registrantId: registrantA, engine, sign } = await setupAssociationTest()
      const registrantB = await seedRegistrant(auth, sign)

      const challengeA = await engine.issueAttestationChallenge(registrantA, nextDeviceKey(), sign)
      const challengeB = await engine.issueAttestationChallenge(registrantB, nextDeviceKey(), sign)

      const all = await engine.getAttestationChallenges()
      expect(all.length).to.be.at.least(2)
      const allNonces = all.map((c) => c.nonce)
      expect(allNonces).to.include(challengeA.nonce)
      expect(allNonces).to.include(challengeB.nonce)

      const narrowed = await engine.getAttestationChallenges(registrantA)
      expect(narrowed).to.have.length(1)
      expect(narrowed[0].nonce).to.equal(challengeA.nonce)
    })

    it('a removed challenge disappears from the read — the D-11 expire half is visible through the inspect half', async () => {
      const { registrantId, engine, sign } = await setupAssociationTest()
      const challenge1 = await engine.issueAttestationChallenge(registrantId, nextDeviceKey(), sign)
      const challenge2 = await engine.issueAttestationChallenge(registrantId, nextDeviceKey(), sign)

      await engine.removeAttestationChallenge(challenge1.nonce, sign)

      const rows = await engine.getAttestationChallenges(registrantId)
      expect(rows).to.have.length(1)
      expect(rows[0].nonce).to.equal(challenge2.nonce)
    })

    it('electionId round-trips as the bound id (5-arg) or undefined, never null (4-arg)', async () => {
      const { auth, registrantId, engine, sign } = await setupAssociationTest()
      // Seed a real election under this authority to bind the 5-arg challenge to.
      const elec = await addTestElection(auth)
      const electionRow = await elec.ctx.db
        .prepare('select Id from Election where AuthorityId = :authorityId limit 1')
        .get({ authorityId: elec.authority.id })
      const electionId = electionRow!.Id as string

      const withElection = await engine.issueAttestationChallenge(registrantId, nextDeviceKey(), sign, electionId)
      const withoutElection = await engine.issueAttestationChallenge(registrantId, nextDeviceKey(), sign)

      const rows = await engine.getAttestationChallenges(registrantId)
      const rowWith = rows.find((r) => r.nonce === withElection.nonce)
      const rowWithout = rows.find((r) => r.nonce === withoutElection.nonce)
      expect(rowWith!.electionId).to.equal(electionId)
      expect(rowWithout!.electionId).to.be.undefined
    })

    it('returns [] for both the no-arg and narrowed call on an unwired engine', async () => {
      const unwired = new AssociationEngine()
      expect(await unwired.getAttestationChallenges()).to.deep.equal([])
      expect(await unwired.getAttestationChallenges('any-registrant')).to.deep.equal([])
    })
  })

  describe('MockAssociationEngine parity', () => {
    it('getAssociations filters by registrant and returns the same 7-key shape as the real engine', async () => {
      const mock = new MockAssociationEngine()
      const registrantA = nextRegistrantId()
      const registrantB = nextRegistrantId()
      const dummySig: Signature = { signature: 'a'.repeat(128), signerKey: 'b'.repeat(66), signerUserId: 'user-1' }

      async function mockAssociate (registrantId: string): Promise<string> {
        const deviceKey = nextDeviceKey()
        const challenge = await mock.issueAttestationChallenge(registrantId, deviceKey, dummySig)
        await mock.associate({ registrantId, deviceKey, nonce: challenge.nonce, attestation: makeDeviceAttestation() }, dummySig)
        return deviceKey
      }

      const deviceKeyA1 = await mockAssociate(registrantA)
      const deviceKeyA2 = await mockAssociate(registrantA)
      await mockAssociate(registrantB)

      const rowsA = await mock.getAssociations(registrantA)
      expect(rowsA).to.have.length(2)
      expect(rowsA.map((r) => r.deviceKey).sort()).to.deep.equal([deviceKeyA1, deviceKeyA2].sort())
      expect(Object.keys(rowsA[0]).sort()).to.deep.equal(ASSOCIATION_KEYS.sort())

      const rowsB = await mock.getAssociations(registrantB)
      expect(rowsB).to.have.length(1)
    })

    it('getAssociationsByDeviceKey: mock filters by device key, matches the real engine\'s 7-key shape, and both agree on registrantId-ascending order against the SAME expected array', async () => {
      const { auth, registrantId: registrantA, engine, sign } = await setupAssociationTest()
      const registrantB = await seedRegistrant(auth, sign)
      const registrantC = await seedRegistrant(auth, sign)
      const sharedDeviceKey = nextDeviceKey()
      // The SAME expected array both engines' ordering is checked against — not two
      // independently-written expectations that could each be wrong the same way.
      const expectedOrder = [registrantA, registrantB, registrantC].sort()

      // Real engine, reverse-seeded.
      await associateDevice(engine, registrantC, sign, { deviceKey: sharedDeviceKey })
      await associateDevice(engine, registrantB, sign, { deviceKey: sharedDeviceKey })
      await associateDevice(engine, registrantA, sign, { deviceKey: sharedDeviceKey })
      const realRows = await engine.getAssociationsByDeviceKey(sharedDeviceKey)
      expect(realRows.map((r) => r.registrantId)).to.deep.equal(expectedOrder)

      // Mock engine, same registrant ids, same reverse-seeding order, same shared key.
      const mock = new MockAssociationEngine()
      const dummySig: Signature = { signature: 'a'.repeat(128), signerKey: 'b'.repeat(66), signerUserId: 'user-1' }
      async function mockAssociateWithKey (registrantId: string): Promise<void> {
        const challenge = await mock.issueAttestationChallenge(registrantId, sharedDeviceKey, dummySig)
        await mock.associate({ registrantId, deviceKey: sharedDeviceKey, nonce: challenge.nonce, attestation: makeDeviceAttestation() }, dummySig)
      }
      await mockAssociateWithKey(registrantC)
      await mockAssociateWithKey(registrantB)
      await mockAssociateWithKey(registrantA)

      const mockRows = await mock.getAssociationsByDeviceKey(sharedDeviceKey)
      expect(mockRows.map((r) => r.registrantId)).to.deep.equal(expectedOrder)
      expect(Object.keys(mockRows[0]).sort()).to.deep.equal(ASSOCIATION_KEYS.sort())
    })

    it('getAttestationChallenges: no-arg returns all issued, registrantId narrows, a removed nonce is absent', async () => {
      const mock = new MockAssociationEngine()
      const registrantA = nextRegistrantId()
      const registrantB = nextRegistrantId()
      const dummySig: Signature = { signature: 'a'.repeat(128), signerKey: 'b'.repeat(66), signerUserId: 'user-1' }

      const challengeA = await mock.issueAttestationChallenge(registrantA, nextDeviceKey(), dummySig)
      const challengeB = await mock.issueAttestationChallenge(registrantB, nextDeviceKey(), dummySig)

      const all = await mock.getAttestationChallenges()
      expect(all.map((c) => c.nonce).sort()).to.deep.equal([challengeA.nonce, challengeB.nonce].sort())

      const narrowed = await mock.getAttestationChallenges(registrantA)
      expect(narrowed).to.have.length(1)
      expect(narrowed[0].nonce).to.equal(challengeA.nonce)

      await mock.removeAttestationChallenge(challengeA.nonce, dummySig)
      const afterRemove = await mock.getAttestationChallenges()
      expect(afterRemove.map((c) => c.nonce)).to.not.include(challengeA.nonce)
      expect(afterRemove.map((c) => c.nonce)).to.include(challengeB.nonce)
    })
  })
})
