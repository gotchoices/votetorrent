/**
 * dev-seed-registrant-association.spec.ts — Phase 59-03 Task 2 (D-23f) real-engine spec
 * for the engine-side `__DEV__` registered-state fixture.
 *
 * Proves the `registered` state is reachable end-to-end from the device key alone (no
 * cached id), that a second identical call is idempotent (no duplicate row), that an
 * unrelated device key still reads `[]`, and that the seeded row carries the SAME
 * seven-key `ASSOCIATION_KEYS` disclosure shape as every other Association read —
 * the fixture does not widen the T-59-03-01 boundary.
 *
 * File-local helpers mirror `association-reads.spec.ts`'s `setupAssociationTest()`
 * harness, with `dev-seed-fixture-` id prefixes so seeded ids cannot collide with
 * another spec file's rows inside the same mocha process.
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { Signature } from '@votetorrent/vote-core'
import { AssociationEngine } from '../src/association/association-engine.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { seedRegistrantAssociation } from '../src/dev/seed-registrant-association.js'
import { createTestNetwork, addTestAuthority, testKeyPairFor } from './fixtures/test-context.js'
import type { TestAuthorityContext } from './fixtures/test-context.js'

/** Build a real secp256k1 sign callback (@noble/curves v2 defaults — prehash:true). */
function makeRealSigner (userId: string): { sign: (digest: Uint8Array) => Promise<Signature> } {
  const { privateHex, publicHex } = testKeyPairFor(userId)
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
  return `dev-seed-fixture-registrant-${Date.now()}-${registrantSeq}`
}

let deviceSeq = 0
function nextDeviceKey (): string {
  deviceSeq += 1
  return `dev-seed-fixture-device-key-${Date.now()}-${deviceSeq}`
}

/** Seeds a fresh authority context — mirrors association-reads.spec.ts's setupAssociationTest(). */
async function setupFixtureTest (): Promise<{
  auth: TestAuthorityContext
  sign: (digest: Uint8Array) => Promise<Signature>
}> {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  const { sign } = makeRealSigner(auth.user.id)
  return { auth, sign }
}

const ASSOCIATION_KEYS = ['attestationCid', 'deviceHash', 'deviceKey', 'expiration', 'registrantId', 'signature', 'signorKey']

describe('seedRegistrantAssociation (D-23f engine-side registered-state dev fixture)', () => {
  it('makes the registered state reachable end-to-end from the device key alone — one row, status "a", future expiration', async () => {
    const { auth, sign } = await setupFixtureTest()
    const registrantId = nextRegistrantId()
    const deviceKey = nextDeviceKey()

    await seedRegistrantAssociation(auth.ctx, auth.authority.id, { id: registrantId }, deviceKey, sign)

    const associationEngine = new AssociationEngine(auth.ctx)
    const rows = await associationEngine.getAssociationsByDeviceKey(deviceKey)
    expect(rows).to.have.length(1)
    expect(rows[0]!.registrantId).to.equal(registrantId)

    const registrationEngine = new RegistrationEngine(auth.ctx)
    const registrant = await registrationEngine.getRegistrant(rows[0]!.registrantId)
    expect(registrant).to.not.be.undefined
    expect(registrant!.status).to.equal('a')
    expect(new Date(registrant!.expiration as string).getTime()).to.be.greaterThan(Date.now())
  })

  it('is idempotent — a second identical call leaves exactly one row and throws no error', async () => {
    const { auth, sign } = await setupFixtureTest()
    const registrantId = nextRegistrantId()
    const deviceKey = nextDeviceKey()

    await seedRegistrantAssociation(auth.ctx, auth.authority.id, { id: registrantId }, deviceKey, sign)
    // Second, identical call — must be a no-op, not a duplicate-insert error.
    await seedRegistrantAssociation(auth.ctx, auth.authority.id, { id: registrantId }, deviceKey, sign)

    const associationEngine = new AssociationEngine(auth.ctx)
    const rows = await associationEngine.getAssociationsByDeviceKey(deviceKey)
    expect(rows).to.have.length(1)
  })

  it('returns [] for an unrelated device key — not registered', async () => {
    const { auth, sign } = await setupFixtureTest()
    const registrantId = nextRegistrantId()
    const deviceKey = nextDeviceKey()
    const unrelatedDeviceKey = nextDeviceKey()

    await seedRegistrantAssociation(auth.ctx, auth.authority.id, { id: registrantId }, deviceKey, sign)

    const associationEngine = new AssociationEngine(auth.ctx)
    expect(await associationEngine.getAssociationsByDeviceKey(unrelatedDeviceKey)).to.deep.equal([])
  })

  it('T-59-03-01: the seeded row carries the same seven-key ASSOCIATION_KEYS shape — the fixture does not widen the disclosure boundary', async () => {
    const { auth, sign } = await setupFixtureTest()
    const registrantId = nextRegistrantId()
    const deviceKey = nextDeviceKey()

    await seedRegistrantAssociation(auth.ctx, auth.authority.id, { id: registrantId }, deviceKey, sign)

    const associationEngine = new AssociationEngine(auth.ctx)
    const rows = await associationEngine.getAssociationsByDeviceKey(deviceKey)
    expect(rows).to.have.length(1)
    expect(Object.keys(rows[0]!).sort()).to.deep.equal(ASSOCIATION_KEYS.sort())
    expect(rows[0]!).to.not.have.property('deviceId')
  })
})
