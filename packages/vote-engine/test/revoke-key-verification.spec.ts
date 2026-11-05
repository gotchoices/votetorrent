// revoke-key-verification.spec.ts — 49-01 Wave 0 scaffolding for D-20
// (revokeKey real-signature verification).
//
// Un-skipped in 49-05 (D-20): `UserEngine.revokeKey` now computes the
// canonical revoke digest engine-side (`getRevokeKeyDigest`) and binds a
// real, curve-dispatched verification result instead of hardcoding
// `IsSignatureValid = true`; `UserKey.DeleteValid`
// (packages/vote-core/schema/votetorrent.qsql) now also calls
// `SignatureValid`/`SignatureValidP256` over `Digest(old.UserId, old.PubKey)`
// as a third AND'd clause (49-03's `extend-DeleteValid` verdict), alongside
// the pre-existing "signer non-expired" and "not the last key" clauses. A
// forged signature is now rejected at both the engine layer and the schema
// layer.
//
// `packages/vote-engine/test/user.spec.ts` was migrated separately (49-05
// Task 1) off its three ad-hoc-digest revoke cases onto the same canonical
// `Digest(UserId, PubKey)` formula.

import { expect } from 'chai'
import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { UserEngine } from '../src/user/user-engine.js'
import { bytesToBase64url } from '../src/utils.js'
import { createTestNetwork, signTestDigest, makeTestSignCallback } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { UserKeyType } from '@votetorrent/vote-core'

describe('revokeKey — forged/canonical signature verification (D-20)', () => {
  it('case 1: revokeKey with a well-formed-but-wrong signature over unrelated bytes is REJECTED and the row survives', async () => {
    const net = await createTestNetwork()
    const userEngine = new UserEngine(net.user, net.ctx)

    // Add a second key so the "last key" clause is not the reason for rejection.
    const secondKey = randomTestKeyPair()
    await userEngine.addKey(
      { key: secondKey.publicHex, type: UserKeyType.mobile, expiration: Date.now() + 86_400_000 },
      makeTestSignCallback(net.user)
    )

    // A well-formed (correct length/hex) signature, real cryptographic
    // signature by the user's real active key, but over UNRELATED bytes —
    // not the digest DeleteValid will ultimately require.
    const unrelatedDigest = bytesToBase64url(sha256(utf8ToBytes('not-the-real-digest')))
    const forgedSignature = signTestDigest(net.user, unrelatedDigest)

    let threw = false
    try {
      await userEngine.revokeKey(secondKey.publicHex, forgedSignature)
    } catch {
      threw = true
    }
    expect(threw, 'revokeKey with a forged signature must reject').to.be.true

    const row = await net.ctx.db
      .prepare('select count(*) as n from UserKey where UserId = :userId and PubKey = :pubKey')
      .get({ userId: net.user.id, pubKey: secondKey.publicHex })
    expect(Number(row?.n), 'the target UserKey row must still exist after a rejected revoke').to.equal(1)
  })

  it('case 2: revokeKey with a real signature over the canonical Digest(UserId, PubKey), signed by a registered sibling key, SUCCEEDS', async () => {
    const net = await createTestNetwork()
    const userEngine = new UserEngine(net.user, net.ctx)

    const secondKey = randomTestKeyPair()
    await userEngine.addKey(
      { key: secondKey.publicHex, type: UserKeyType.mobile, expiration: Date.now() + 86_400_000 },
      makeTestSignCallback(net.user)
    )

    // Canonical D-20 digest formula: Digest(UserId, PubKey) — signed by the
    // registered, unexpired FIRST (sibling) key.
    const digestRow = await net.ctx.db
      .prepare('select Digest(:userId, :pubKey) as d')
      .get({ userId: net.user.id, pubKey: secondKey.publicHex })
    if (!digestRow || digestRow.d == null) throw new Error('case 2: Digest() returned null')
    const realSignature = signTestDigest(net.user, digestRow.d as string)

    await userEngine.revokeKey(secondKey.publicHex, realSignature)

    const row = await net.ctx.db
      .prepare('select count(*) as n from UserKey where UserId = :userId and PubKey = :pubKey')
      .get({ userId: net.user.id, pubKey: secondKey.publicHex })
    expect(Number(row?.n), 'the revoked UserKey row must be gone').to.equal(0)
  })

  it('case 3: revokeKey of the user\'s LAST remaining key is REJECTED (DeleteValid "not the last key" clause)', async () => {
    const net = await createTestNetwork()
    const userEngine = new UserEngine(net.user, net.ctx)
    const onlyKey = net.user.activeKeys[0]!.key

    const digestRow = await net.ctx.db
      .prepare('select Digest(:userId, :pubKey) as d')
      .get({ userId: net.user.id, pubKey: onlyKey })
    if (!digestRow || digestRow.d == null) throw new Error('case 3: Digest() returned null')
    const realSignature = signTestDigest(net.user, digestRow.d as string)

    let threw = false
    try {
      await userEngine.revokeKey(onlyKey, realSignature)
    } catch {
      threw = true
    }
    expect(threw, 'revoking the last remaining key must reject').to.be.true

    const row = await net.ctx.db
      .prepare('select count(*) as n from UserKey where UserId = :userId and PubKey = :pubKey')
      .get({ userId: net.user.id, pubKey: onlyKey })
    expect(Number(row?.n)).to.equal(1)
  })
})
