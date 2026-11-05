/**
 * network-join-anchor.spec.ts — ruling R-C (D-22): NetworksEngine.getJoinAnchor.
 *
 *   JA-1 equals getFoundingAnchor on an unrevised network.
 *   JA-2 survives an Admin revision unchanged, while getFoundingAnchor keeps
 *        the D-38 admin-revised refusal.
 *   JA-3 network-not-open for a network this engine has not opened.
 *   JA-4 genesis-unreadable when the open context's Network row does not match.
 *   JA-5 deterministic with a second founder key, and its digest re-derives from
 *        the rows its genesis keys select.
 */

import { expect } from 'chai'
import { UserKeyType } from '@votetorrent/vote-core'
import type { AdminInit, FoundingAnchor, Proposal, Scope } from '@votetorrent/vote-core'
import { FoundingBundleExportError } from '../src/networks/founding-bundle.js'
import { readGenesisRows } from '../src/networks/genesis-rows.js'
import { computeContentDigest } from '../src/bootstrap/snapshot-manifest.js'
import type { SnapshotTables } from '../src/bootstrap/snapshot-types.js'
import { UserEngine } from '../src/user/user-engine.js'
import type { EngineContext } from '../src/types.js'
import { createTestNetwork, addTestAuthority, makeTestSignCallback } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'

async function rejectionOf (p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (err) {
    return err
  }
  return undefined
}

describe('R-C: NetworksEngine.getJoinAnchor (JA)', function () {
  // Each leg opens one or two in-memory networks; JA-2 also runs a signed promotion.
  this.timeout(30_000)

  it('JA-1 equals getFoundingAnchor on an unrevised network (digest, fingerprint, genesis, name, hash)', async () => {
    const net = await createTestNetwork()
    const joinAnchor = await net.networksEngine.getJoinAnchor(net.ref.hash)
    const foundingAnchor = await net.networksEngine.getFoundingAnchor(net.ref.hash, {
      userId: net.user.id,
      signerKey: net.user.activeKeys[0]!.key
    })
    expect(joinAnchor).to.deep.equal(foundingAnchor)
    expect(joinAnchor.genesis.userId).to.equal(net.user.id)
    expect(joinAnchor.networkHash).to.equal(net.ref.hash)
  })

  it('JA-2 is unchanged by a second Admin generation, while getFoundingAnchor still refuses admin-revised', async () => {
    const net = await createTestNetwork()
    const before: FoundingAnchor = await net.networksEngine.getJoinAnchor(net.ref.hash)

    // The E-2d promotion: a real, signed proposeAdmin that completes.
    const auth = await addTestAuthority(net)
    const proposal: Proposal<AdminInit> = {
      proposed: {
        officers: [{ existing: { userId: auth.user.id, authorityId: auth.authority.id, title: 'Chair', scopes: ['rad'] as Scope[] } }],
        effectiveAt: Date.now() + 60_000,
        thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
      },
      signers: [auth.user.id]
    }
    await auth.authorityEngine.proposeAdmin(proposal, makeTestSignCallback(auth.user))
    const outcome = (auth.authorityEngine as unknown as { lastPromotionOutcome?: { status: string } }).lastPromotionOutcome
    expect(outcome?.status, 'JA-2 setup: the promotion must actually complete').to.equal('promoted')

    const adminRows: Array<{ EffectiveAt: unknown }> = []
    for await (const row of auth.ctx.db.eval('select EffectiveAt from Admin where AuthorityId = :authorityId', { authorityId: auth.authority.id })) {
      adminRows.push(row as { EffectiveAt: unknown })
    }
    expect(adminRows.length, 'JA-2 setup: two Admin rows must now exist').to.equal(2)
    const earliest = adminRows
      .map((row) => String(row.EffectiveAt))
      .sort((a, b) => new Date(a + 'Z').getTime() - new Date(b + 'Z').getTime())[0]

    const refused = await rejectionOf(
      net.networksEngine.getFoundingAnchor(net.ref.hash, { userId: net.user.id, signerKey: net.user.activeKeys[0]!.key })
    )
    expect(refused).to.be.instanceOf(FoundingBundleExportError)
    expect((refused as FoundingBundleExportError).code).to.equal('admin-revised')

    const after = await net.networksEngine.getJoinAnchor(net.ref.hash)
    expect(after).to.deep.equal(before)
    expect(after.genesis.adminEffectiveAt).to.equal(earliest)
  })

  it('JA-3 refuses a network this engine has not opened (network-not-open)', async () => {
    const net = await createTestNetwork()
    const caught = await rejectionOf(net.networksEngine.getJoinAnchor('0000000000000000'))
    expect(caught).to.be.instanceOf(FoundingBundleExportError)
    expect((caught as FoundingBundleExportError).code).to.equal('network-not-open')
  })

  it('JA-4 refuses with genesis-unreadable when the open context holds another network', async () => {
    const first = await createTestNetwork()
    const second = await createTestNetwork({ network: { name: 'Second Test Network' } })
    expect(second.ref.hash).to.not.equal(first.ref.hash)
    const contexts = (first.networksEngine as unknown as { contexts: Map<string, EngineContext> }).contexts
    contexts.set(first.ref.hash, second.ctx)
    const caught = await rejectionOf(first.networksEngine.getJoinAnchor(first.ref.hash))
    expect(caught).to.be.instanceOf(FoundingBundleExportError)
    expect((caught as FoundingBundleExportError).code).to.equal('genesis-unreadable')
  })

  it('JA-5 is deterministic with a second founder key, keeps the earliest-expiring key, and re-derives its digest', async () => {
    const net = await createTestNetwork()
    const userEngine = new UserEngine(net.user, net.ctx)
    const { publicHex } = randomTestKeyPair()
    await userEngine.addKey(
      { key: publicHex, type: UserKeyType.yubico, expiration: Date.now() + 2 * 86_400_000 },
      makeTestSignCallback(net.user)
    )
    const keyCount = await net.ctx.db
      .prepare('select count(*) as n from UserKey where UserId = :userId')
      .get({ userId: net.user.id })
    expect(Number(keyCount?.n), 'JA-5 setup: the founder must now hold two keys').to.equal(2)

    const one = await net.networksEngine.getJoinAnchor(net.ref.hash)
    const two = await net.networksEngine.getJoinAnchor(net.ref.hash)
    expect(two).to.deep.equal(one)
    // The founding key expires first (one day versus two), so the rule keeps it.
    expect(one.genesis.signerKey).to.equal(net.user.activeKeys[0]!.key)

    const rows = await readGenesisRows(net.ctx.db, one.genesis)
    expect(computeContentDigest(rows as unknown as SnapshotTables)).to.equal(one.digest)
  })
})
