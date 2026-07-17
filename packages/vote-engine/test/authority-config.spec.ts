/**
 * authority-config.spec.ts — Phase 42-05 real-engine spec for
 * AuthorityConfigEngine + MockAuthorityConfigEngine.
 *
 * Covers (per 42-05-PLAN.md):
 *   - addAuthorityPeer/removeAuthorityPeer drive a cap-scoped seedSignedMutation
 *     ceremony; row-state transitions (insert -> count=1, delete -> count=0)
 *   - addPollingDevice/removePollingDevice drive a vrg-scoped ceremony (NOT
 *     cap — the cap != vrg distinction is asserted explicitly)
 *   - A wrong-scope negative case: a PollingDevice ceremony signed under 'cap'
 *     (instead of 'vrg') and an AuthorityPeer ceremony signed under 'vrg'
 *     (instead of 'cap') are both rejected by the schema's own InsertValid
 *     CHECK — no app-layer-only gate
 *   - MockAuthorityConfigEngine parity (in-memory, no DB, no ceremony)
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { Signature } from '@votetorrent/vote-core'
import { AuthorityConfigEngine } from '../src/authority-config/authority-config-engine.js'
import { MockAuthorityConfigEngine } from '../src/authority-config/mock-authority-config-engine.js'
import { createTestNetwork, addTestAuthority, seedSignedMutation as seedSignedMutationFixture } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import type { TestAuthorityContext } from './fixtures/test-context.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a real secp256k1 sign callback (@noble/curves v2 defaults — prehash:true). */
function makeRealSigner (userId: string): (digest: Uint8Array) => Promise<Signature> {
  const { privateHex, publicHex } = randomTestKeyPair()
  const privBytes = hexToBytes(privateHex)
  return async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes) // v2 default: prehash:true
    return { signerUserId: userId, signerKey: publicHex, signature: bytesToHex(sig) }
  }
}

let peerSeq = 0
function nextPeerId (): string {
  peerSeq += 1
  return `peer-${Date.now()}-${peerSeq}`
}

let deviceSeq = 0
function nextDeviceHash (): string {
  deviceSeq += 1
  return `device-hash-${Date.now()}-${deviceSeq}`
}

async function setup (): Promise<{
  auth: TestAuthorityContext
  engine: AuthorityConfigEngine
  sign: (digest: Uint8Array) => Promise<Signature>
}> {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  const sign = makeRealSigner(auth.user.id)
  const engine = new AuthorityConfigEngine(auth.ctx)
  return { auth, engine, sign }
}

// ===========================================================================
// AuthorityConfigEngine — cap-scoped AuthorityPeer ceremony
// ===========================================================================

describe('AuthorityConfigEngine', () => {
  describe('addAuthorityPeer / removeAuthorityPeer (cap scope)', () => {
    it('inserts an AuthorityPeer row and drives a cap-scoped AdminSigning ceremony', async () => {
      const { auth, engine, sign } = await setup()
      const peerId = nextPeerId()

      await engine.addAuthorityPeer(auth.authority.id, peerId, sign)

      const row = await auth.ctx.db
        .prepare('select count(*) as n from AuthorityPeer where AuthorityId = :id and PeerId = :peerId')
        .get({ id: auth.authority.id, peerId })
      expect(Number(row?.n)).to.equal(1)

      const signingRow = await auth.ctx.db
        .prepare(`select Scope from AdminSigning where AuthorityId = :id and Scope = 'cap' order by Nonce desc limit 1`)
        .get({ id: auth.authority.id })
      expect(signingRow?.Scope).to.equal('cap')
    })

    it('removeAuthorityPeer deletes the row (count back to 0)', async () => {
      const { auth, engine, sign } = await setup()
      const peerId = nextPeerId()
      await engine.addAuthorityPeer(auth.authority.id, peerId, sign)

      await engine.removeAuthorityPeer(auth.authority.id, peerId, sign)

      const row = await auth.ctx.db
        .prepare('select count(*) as n from AuthorityPeer where AuthorityId = :id and PeerId = :peerId')
        .get({ id: auth.authority.id, peerId })
      expect(Number(row?.n)).to.equal(0)
    })

    it('getAuthorityPeers returns the current rows for the authority', async () => {
      const { auth, engine, sign } = await setup()
      const peerId1 = nextPeerId()
      const peerId2 = nextPeerId()
      await engine.addAuthorityPeer(auth.authority.id, peerId1, sign)
      await engine.addAuthorityPeer(auth.authority.id, peerId2, sign)

      const peers = await engine.getAuthorityPeers(auth.authority.id)
      expect(peers.map((p) => p.peerId).sort()).to.deep.equal([peerId1, peerId2].sort())
    })
  })

  // =========================================================================
  // AuthorityConfigEngine — vrg-scoped PollingDevice ceremony (cap != vrg)
  // =========================================================================

  describe('addPollingDevice / removePollingDevice (vrg scope)', () => {
    it('inserts a PollingDevice row (with Label) and drives a vrg-scoped AdminSigning ceremony (explicit cap != vrg guard)', async () => {
      const { auth, engine, sign } = await setup()
      const deviceHash = nextDeviceHash()

      await engine.addPollingDevice(auth.authority.id, deviceHash, 'Precinct 4 Tablet', sign)

      const row = await auth.ctx.db
        .prepare('select count(*) as n from PollingDevice where AuthorityId = :id and DeviceHash = :deviceHash and Label = :label')
        .get({ id: auth.authority.id, deviceHash, label: 'Precinct 4 Tablet' })
      expect(Number(row?.n)).to.equal(1)

      const signingRow = await auth.ctx.db
        .prepare(`select Scope from AdminSigning where AuthorityId = :id and Scope = 'vrg' order by Nonce desc limit 1`)
        .get({ id: auth.authority.id })
      expect(signingRow?.Scope).to.equal('vrg')
      expect(signingRow?.Scope).to.not.equal('cap')
    })

    it('addPollingDevice tolerates an absent Label (nullable)', async () => {
      const { auth, engine, sign } = await setup()
      const deviceHash = nextDeviceHash()

      await engine.addPollingDevice(auth.authority.id, deviceHash, undefined, sign)

      const row = await auth.ctx.db
        .prepare('select Label from PollingDevice where AuthorityId = :id and DeviceHash = :deviceHash')
        .get({ id: auth.authority.id, deviceHash })
      expect(row?.Label ?? null).to.equal(null)
    })

    it('removePollingDevice deletes the row (count back to 0)', async () => {
      const { auth, engine, sign } = await setup()
      const deviceHash = nextDeviceHash()
      await engine.addPollingDevice(auth.authority.id, deviceHash, undefined, sign)

      await engine.removePollingDevice(auth.authority.id, deviceHash, sign)

      const row = await auth.ctx.db
        .prepare('select count(*) as n from PollingDevice where AuthorityId = :id and DeviceHash = :deviceHash')
        .get({ id: auth.authority.id, deviceHash })
      expect(Number(row?.n)).to.equal(0)
    })

    it('getPollingDevices returns the current rows for the authority', async () => {
      const { auth, engine, sign } = await setup()
      const deviceHash1 = nextDeviceHash()
      const deviceHash2 = nextDeviceHash()
      await engine.addPollingDevice(auth.authority.id, deviceHash1, 'Tablet A', sign)
      await engine.addPollingDevice(auth.authority.id, deviceHash2, undefined, sign)

      const devices = await engine.getPollingDevices(auth.authority.id)
      expect(devices.map((d) => d.deviceHash).sort()).to.deep.equal([deviceHash1, deviceHash2].sort())
      const labeled = devices.find((d) => d.deviceHash === deviceHash1)
      expect(labeled?.label).to.equal('Tablet A')
    })
  })

  // =========================================================================
  // Wrong-scope rejection — the schema CHECK gates, not an app-layer-only check
  // =========================================================================

  describe('wrong-scope rejection (schema CHECK, not app-layer-only)', () => {
    it('rejects a PollingDevice insert whose ceremony was signed under cap instead of vrg', async () => {
      const { auth } = await setup()
      const deviceHash = nextDeviceHash()
      const tid = Date.now() + Math.floor(Math.random() * 100_000)
      const digestExpr = 'select Digest(:tid, :authorityId, :deviceHash, :label) as d'
      const digestParams = { tid, authorityId: auth.authority.id, deviceHash, label: null }
      // Sign the ceremony under 'cap' (wrong scope for PollingDevice, which
      // requires 'vrg') instead of the correct 'vrg'.
      const { nonce } = await seedSignedMutationFixture(auth.ctx, auth.authority.id, 'cap', tid, digestExpr, digestParams, auth.user)

      let caught: unknown
      try {
        await auth.ctx.db.exec(
          `insert into PollingDevice (AuthorityId, DeviceHash, Label)
           with context SigningNonce = :nonce, Tid = ${tid}
           values (:authorityId, :deviceHash, :label)`,
          { authorityId: auth.authority.id, deviceHash, label: null, nonce }
        )
      } catch (err) {
        caught = err
      }
      expect(caught, 'expected the cap-scoped ceremony to be rejected by PollingDevice.InsertValid (requires vrg)').to.be.instanceOf(Error)

      const row = await auth.ctx.db
        .prepare('select count(*) as n from PollingDevice where AuthorityId = :id and DeviceHash = :deviceHash')
        .get({ id: auth.authority.id, deviceHash })
      expect(Number(row?.n)).to.equal(0)
    })

    it('rejects an AuthorityPeer insert whose ceremony was signed under vrg instead of cap', async () => {
      const { auth } = await setup()
      const peerId = nextPeerId()
      const tid = Date.now() + Math.floor(Math.random() * 100_000)
      const digestExpr = 'select Digest(:tid, :authorityId, :peerId) as d'
      const digestParams = { tid, authorityId: auth.authority.id, peerId }
      // Sign the ceremony under 'vrg' (wrong scope for AuthorityPeer, which
      // requires 'cap') instead of the correct 'cap'.
      const { nonce } = await seedSignedMutationFixture(auth.ctx, auth.authority.id, 'vrg', tid, digestExpr, digestParams, auth.user)

      let caught: unknown
      try {
        await auth.ctx.db.exec(
          `insert into AuthorityPeer (AuthorityId, PeerId)
           with context SigningNonce = :nonce, Tid = ${tid}
           values (:authorityId, :peerId)`,
          { authorityId: auth.authority.id, peerId, nonce }
        )
      } catch (err) {
        caught = err
      }
      expect(caught, 'expected the vrg-scoped ceremony to be rejected by AuthorityPeer.InsertValid (requires cap)').to.be.instanceOf(Error)

      const row = await auth.ctx.db
        .prepare('select count(*) as n from AuthorityPeer where AuthorityId = :id and PeerId = :peerId')
        .get({ id: auth.authority.id, peerId })
      expect(Number(row?.n)).to.equal(0)
    })
  })

  // =========================================================================
  // MockAuthorityConfigEngine parity
  // =========================================================================

  describe('MockAuthorityConfigEngine parity', () => {
    it('mutates in-memory maps and reads reflect them (no DB, no ceremony)', async () => {
      const mock = new MockAuthorityConfigEngine()
      const authorityId = 'mock-authority-1'
      const peerId = nextPeerId()
      const deviceHash = nextDeviceHash()
      const dummySign = async (): Promise<Signature> => ({ signerUserId: 'u', signerKey: 'k', signature: 's' })

      await mock.addAuthorityPeer(authorityId, peerId, dummySign)
      expect((await mock.getAuthorityPeers(authorityId)).map((p) => p.peerId)).to.deep.equal([peerId])

      await mock.removeAuthorityPeer(authorityId, peerId, dummySign)
      expect(await mock.getAuthorityPeers(authorityId)).to.deep.equal([])

      await mock.addPollingDevice(authorityId, deviceHash, 'Label X', dummySign)
      const devices = await mock.getPollingDevices(authorityId)
      expect(devices).to.have.length(1)
      expect(devices[0]?.label).to.equal('Label X')

      await mock.removePollingDevice(authorityId, deviceHash, dummySign)
      expect(await mock.getPollingDevices(authorityId)).to.deep.equal([])
    })
  })
})
