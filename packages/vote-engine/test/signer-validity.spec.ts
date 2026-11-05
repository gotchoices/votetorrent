// AdminSigning/OfficerSignature SignerKeyValid + OfficerValid: the engine now computes
// `context.IsSignerKeyValid` / `context.IsOfficerValid` (src/signing/signer-validity.ts)
// instead of binding a literal `true`. These tests prove the schema refuses what the
// stubs used to wave through — an unregistered key, an expired key, a non-officer —
// and still admits the registered officer.

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { AdminDigestArgs, Signature } from '@votetorrent/vote-core'
import { SigningEngine } from '../src/signing/signing-engine.js'
import { isOfficerOfSession, isSignerKeyValid } from '../src/signing/signer-validity.js'
import { digestToBytes, nowCanonicalDatetime } from '../src/utils.js'
import { createTestNetwork, testKeyPairFor, type TestNetworkContext } from './fixtures/test-context.js'
import { randomTestKeyPair, type TestKeyPair } from './fixtures/keys.js'
import type { EngineContext } from '../src/types.js'

const digestArgs: AdminDigestArgs = {
  authorityId: 'test-authority',
  effectiveAt: 'test-effective-at',
  officers: '[]',
  thresholdPolicies: '[]'
}

async function primaryAuthorityId (ctx: EngineContext): Promise<string> {
  const row = await ctx.db.prepare('select Id from Authority limit 1').get({})
  return row!.Id as string
}

/** A real signature over startSigningSession's PATH A digest, by `keys`, claimed for `userId`. */
async function signAdminDigest (
  ctx: EngineContext,
  authorityId: string,
  userId: string,
  keys: TestKeyPair
): Promise<Signature> {
  const row = await ctx.db
    .prepare('select Digest(:authorityId, :effectiveAt, :officers, :thresholdPolicies) as d')
    .get({ ...digestArgs, authorityId })
  const sig = secp256k1.sign(digestToBytes(row!.d as string), hexToBytes(keys.privateHex))
  return { signerUserId: userId, signerKey: keys.publicHex, signature: bytesToHex(sig) }
}

async function captureError (fn: () => Promise<unknown>): Promise<Error | undefined> {
  try {
    await fn()
  } catch (err) {
    return err as Error
  }
  return undefined
}

describe('signer validity (SignerKeyValid / OfficerValid)', () => {
  let net: TestNetworkContext
  let authorityId: string

  beforeEach(async () => {
    net = await createTestNetwork()
    authorityId = await primaryAuthorityId(net.ctx)
  })

  describe('AdminSigning.SignerKeyValid via startSigningSession', () => {
    it('admits a signature by the officer\'s registered key', async () => {
      const sig = await signAdminDigest(net.ctx, authorityId, net.user.id, testKeyPairFor(net.user.id))
      const { nonce } = await new SigningEngine(net.ctx).startSigningSession(authorityId, digestArgs, 'rad', sig)
      const row = await net.ctx.db.prepare('select SignerKey from AdminSigning where Nonce = :nonce').get({ nonce })
      expect(row?.SignerKey).to.equal(sig.signerKey)
    })

    it('refuses a cryptographically valid signature by a key the officer never registered', async () => {
      const sig = await signAdminDigest(net.ctx, authorityId, net.user.id, randomTestKeyPair())
      const err = await captureError(async () =>
        new SigningEngine(net.ctx).startSigningSession(authorityId, digestArgs, 'rad', sig)
      )
      expect(err?.message).to.include('SignerKeyValid')
      // Nothing from the refused attempt persisted.
      const forSigner = await net.ctx.db
        .prepare('select count(*) as n from AdminSigning where SignerKey = :k')
        .get({ k: sig.signerKey })
      expect(Number(forSigner?.n)).to.equal(0)
    })
  })

  describe('isSignerKeyValid', () => {
    it('is true for a registered key before its expiration', async () => {
      const { publicHex } = testKeyPairFor(net.user.id)
      expect(await isSignerKeyValid(net.ctx.db, net.user.id, publicHex, nowCanonicalDatetime())).to.equal(true)
    })

    it('is false once the key has expired', async () => {
      const { publicHex } = testKeyPairFor(net.user.id)
      // Fixture keys expire one day out; evaluate a year later.
      const later = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 19)
      expect(await isSignerKeyValid(net.ctx.db, net.user.id, publicHex, later)).to.equal(false)
    })

    it('is false when the key is registered to a different user id', async () => {
      const { publicHex } = testKeyPairFor(net.user.id)
      expect(await isSignerKeyValid(net.ctx.db, 'someone-else', publicHex, nowCanonicalDatetime())).to.equal(false)
    })
  })

  describe('OfficerSignature.OfficerValid', () => {
    async function openSession (): Promise<string> {
      // A later sign() on an already-reached session still inserts its OfficerSignature
      // (the late-signature path), so the insert under test is always reached.
      const sig = await signAdminDigest(net.ctx, authorityId, net.user.id, testKeyPairFor(net.user.id))
      const { nonce } = await new SigningEngine(net.ctx).startSigningSession(authorityId, digestArgs, 'rad', sig)
      return nonce
    }

    it('isOfficerOfSession is true for the session authority\'s officer', async () => {
      const nonce = await openSession()
      expect(await isOfficerOfSession(net.ctx.db, nonce, net.user.id)).to.equal(true)
    })

    it('isOfficerOfSession is false for a user who is not an officer of that authority', async () => {
      const nonce = await openSession()
      expect(await isOfficerOfSession(net.ctx.db, nonce, 'not-an-officer')).to.equal(false)
    })

    // The outsider holds no UserKey either, so whichever of the two CHECKs Quereus
    // evaluates first refuses the row; isOfficerOfSession above pins OfficerValid alone.
    it('refuses an OfficerSignature from a non-officer', async () => {
      const nonce = await openSession()
      const digestRow = await net.ctx.db.prepare('select Digest from AdminSigning where Nonce = :nonce').get({ nonce })
      const outsider = randomTestKeyPair()
      const sig = secp256k1.sign(digestToBytes(digestRow!.Digest as string), hexToBytes(outsider.privateHex))
      const err = await captureError(async () =>
        new SigningEngine(net.ctx).sign(nonce, {
          signerUserId: 'not-an-officer',
          signerKey: outsider.publicHex,
          signature: bytesToHex(sig)
        })
      )
      expect(err?.message).to.match(/OfficerValid|SignerKeyValid/)
      const row = await net.ctx.db
        .prepare('select 1 as x from OfficerSignature where SigningNonce = :nonce and UserId = :u')
        .get({ nonce, u: 'not-an-officer' })
      expect(row).to.equal(undefined)
    })
  })
})
