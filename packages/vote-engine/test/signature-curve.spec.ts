// signature-curve.spec.ts — 49-01 Wave 0 scaffolding for D-02/D-03 (curve
// dispatch inside verifySig / UserKey.SignatureValid).
//
// Two independent things live in this file:
//
//   1. `describe('p256 fixture', ...)` — an ACTIVE (non-skipped) self-test
//      that proves `fixtures/p256-signer.ts` is byte-correct against the
//      REAL, already-registered `@optimystic/quereus-plugin-crypto`
//      `verify()` — independent of any Phase-49 production change. This is
//      the threat register's T-49-DER mitigation: a wrong fixture would
//      make a wrong implementation look correct, so the fixture is proven
//      first.
//   2. `describe('verifySig — UserKey P-256 curve dispatch ...')` — the
//      D-02/D-03 curve branch. 49-02 curve-branched `UserKey.SignatureValid`
//      (packages/vote-core/schema/votetorrent.qsql) and registered
//      `SignatureValidP256` (packages/vote-engine/src/database/initialize.ts),
//      so a P-256 signature over a `Type='P'` UserKey row now verifies. These
//      three cases assert that behavior: P-256 acceptance, wrong-curve
//      rejection, and the pre-existing secp256k1 path unregressed.

import { expect } from 'chai'
import { verify as cryptoVerify } from '@optimystic/quereus-plugin-crypto'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/curves/utils.js'
import { UserKeyType } from '@votetorrent/vote-core'
import { digestToBytes, toCanonicalDatetime, nowCanonicalDatetime } from '../src/utils.js'
import { makeP256TestKey, signDigestP256 } from './fixtures/p256-signer.js'
import { createTestNetwork, signTestDigest } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'

// ---------------------------------------------------------------------------
// 1. Active self-test: the P-256 fixture is correct, independent of any
//    Phase-49 production change (T-49-DER mitigation).
// ---------------------------------------------------------------------------

describe('p256 fixture', () => {
  it('self-test: makeP256TestKey/signDigestP256 round-trip verifies via the crypto plugin p256 verify()', async () => {
    const { privBytes, pubHex } = makeP256TestKey()
    expect(pubHex, '33-byte compressed SEC1 point, hex-encoded').to.have.length(66)

    // Need a real Digest() output (base64url) to sign — spin up a fresh
    // network context so the crypto plugin is registered on a real db.
    const net = await createTestNetwork()
    const digestRow = await net.ctx.db
      .prepare("select Digest('p256-fixture-self-test', :nonce) as d")
      .get({ nonce: 'fixture-round-trip' })
    if (!digestRow || digestRow.d == null) throw new Error('p256 fixture self-test: Digest() returned null')
    const digestBase64url = digestRow.d as string

    const sigHex = signDigestP256(digestBase64url, privBytes)
    expect(sigHex, '64-byte compact signature, hex-encoded').to.have.length(128)

    const verified = cryptoVerify(digestBase64url, sigHex, pubHex, 'p256', 'base64url', 'hex', 'hex')
    expect(verified, 'fixture signature must verify against the real crypto plugin p256.verify()').to.be.true
  })
})

// ---------------------------------------------------------------------------
// 2. verifySig — UserKey P-256 curve dispatch (D-02/D-03)
// ---------------------------------------------------------------------------

describe('verifySig — UserKey P-256 curve dispatch (D-02/D-03)', () => {
  it('case 1: a Type=\'P\' second UserKey signed (by an existing P-256 key) with a real P-256 signature is ACCEPTED', async () => {
    // The existing (first, bootstrap) active key must itself be P-256 —
    // UserKey.SignatureValid's subsequent-key branch requires the SECOND
    // key's signature to have been produced by the EXISTING signer
    // (context.UserKey), and once 49-02 dispatches on `new.Type`, the
    // verification curve must match the curve that actually produced the
    // signature bytes.
    const existingKey = makeP256TestKey()
    const net = await createTestNetwork({
      user: {
        activeKeys: [
          {
            key: existingKey.pubHex,
            type: 'P' as UserKeyType,
            expiration: Date.now() + 86_400_000
          }
        ]
      }
    })

    const newKey = makeP256TestKey()
    const expiration = toCanonicalDatetime(Date.now() + 86_400_000)
    const digestRow = await net.ctx.db
      .prepare('select Digest(:userId, :pubKey, :type, :expiration) as d')
      .get({ userId: net.user.id, pubKey: newKey.pubHex, type: 'P', expiration })
    if (!digestRow || digestRow.d == null) throw new Error('case 1: Digest() returned null')
    const sigHex = signDigestP256(digestRow.d as string, existingKey.privBytes)

    await net.ctx.db.exec(
      `insert into UserKey (UserId, Type, PubKey, Expiration)
       with context UserKey = :userKey, Signature = :signature, Tid = 1, now = :now, IsSignatureValid = false
       values (:userId, 'P', :pubKey, :expiration)`,
      {
        userId: net.user.id,
        pubKey: newKey.pubHex,
        expiration,
        userKey: existingKey.pubHex,
        signature: sigHex,
        now: nowCanonicalDatetime()
      }
    )

    const row = await net.ctx.db
      .prepare('select count(*) as n from UserKey where UserId = :userId and PubKey = :pubKey')
      .get({ userId: net.user.id, pubKey: newKey.pubHex })
    expect(Number(row?.n)).to.equal(1)
  })

  it('case 2: a Type=\'P\' second UserKey signed with a secp256k1 (wrong-curve) signature is REJECTED', async () => {
    // Proves the branch actually dispatches on curve rather than accepting
    // any well-formed 64-byte signature regardless of which curve produced it.
    const existingKey = makeP256TestKey()
    const net = await createTestNetwork({
      user: {
        activeKeys: [
          {
            key: existingKey.pubHex,
            type: 'P' as UserKeyType,
            expiration: Date.now() + 86_400_000
          }
        ]
      }
    })

    const newKey = makeP256TestKey()
    const expiration = toCanonicalDatetime(Date.now() + 86_400_000)
    const digestRow = await net.ctx.db
      .prepare('select Digest(:userId, :pubKey, :type, :expiration) as d')
      .get({ userId: net.user.id, pubKey: newKey.pubHex, type: 'P', expiration })
    if (!digestRow || digestRow.d == null) throw new Error('case 2: Digest() returned null')
    const digestBytes = digestToBytes(digestRow.d as string)
    // Wrong-curve signature: sign the SAME digest bytes with secp256k1 using
    // the existing key's raw scalar (both curves accept an arbitrary 32-byte
    // scalar — the point is a well-formed-but-wrong-curve signature, not a
    // garbage one).
    const wrongCurveSigHex = bytesToHex(secp256k1.sign(digestBytes, existingKey.privBytes))

    let threw = false
    try {
      await net.ctx.db.exec(
        `insert into UserKey (UserId, Type, PubKey, Expiration)
         with context UserKey = :userKey, Signature = :signature, Tid = 1, now = :now, IsSignatureValid = false
         values (:userId, 'P', :pubKey, :expiration)`,
        {
          userId: net.user.id,
          pubKey: newKey.pubHex,
          expiration,
          userKey: existingKey.pubHex,
          signature: wrongCurveSigHex,
          now: nowCanonicalDatetime()
        }
      )
    } catch {
      threw = true
    }
    expect(threw, 'a secp256k1 signature over a Type=\'P\' insert must be rejected').to.be.true

    const row = await net.ctx.db
      .prepare('select count(*) as n from UserKey where UserId = :userId and PubKey = :pubKey')
      .get({ userId: net.user.id, pubKey: newKey.pubHex })
    expect(Number(row?.n)).to.equal(0)
  })

  it('regression case 3: a secp256k1 Type=\'M\' second UserKey insert still SUCCEEDS (D-02 did not disturb the existing curve)', async () => {
    const net = await createTestNetwork()
    const existingPub = net.user.activeKeys[0]!.key

    const { publicHex: newPub } = randomTestKeyPair()
    const expiration = toCanonicalDatetime(Date.now() + 86_400_000)
    const digestRow = await net.ctx.db
      .prepare('select Digest(:userId, :pubKey, :type, :expiration) as d')
      .get({ userId: net.user.id, pubKey: newPub, type: 'M', expiration })
    if (!digestRow || digestRow.d == null) throw new Error('case 3: Digest() returned null')
    const sig = signTestDigest(net.user, digestRow.d as string)

    await net.ctx.db.exec(
      `insert into UserKey (UserId, Type, PubKey, Expiration)
       with context UserKey = :userKey, Signature = :signature, Tid = 1, now = :now, IsSignatureValid = false
       values (:userId, 'M', :pubKey, :expiration)`,
      {
        userId: net.user.id,
        pubKey: newPub,
        expiration,
        userKey: existingPub,
        signature: sig.signature,
        now: nowCanonicalDatetime()
      }
    )

    const row = await net.ctx.db
      .prepare('select count(*) as n from UserKey where UserId = :userId and PubKey = :pubKey')
      .get({ userId: net.user.id, pubKey: newPub })
    expect(Number(row?.n)).to.equal(1)
  })
})
