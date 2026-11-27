/**
 * device-identity-inspection.spec.ts - Phase 62 Plan 122 Task 3 (O-06 engine half)
 *
 * `UserEngine.inspectDeviceIdentity(localUserId, pubKey)` tells the repair flow whether the local id
 * is a network User and which CURRENT officers hold the device's key as an active UserKey. Every
 * UserKey read is a point lookup on its `UserId` primary-key prefix.
 */

import { expect } from 'chai'
import { UserKeyType } from '@votetorrent/vote-core'
import type { User } from '@votetorrent/vote-core'
import { UserEngine } from '../src/user/user-engine.js'
import { createThresholdAuthority, type ThresholdAuthorityFixture } from './fixtures/threshold-authority.js'
import { testKeyPairFor } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import type { EngineContext } from '../src/types.js'

type Inspecting = { inspectDeviceIdentity: (localUserId: string, pubKey: string) => Promise<{ localIsNetworkUser: boolean, officerUserIdsHoldingKey: string[] }> }

function inspector (ctx: EngineContext, user: User): Inspecting {
  return new UserEngine(user, ctx) as unknown as Inspecting
}

/** Give `user` an additional active UserKey `pubKey` (signed by the user's existing key). */
async function giveKey (ctx: EngineContext, user: User, pubKey: string, expiration = Date.now() + 86_400_000): Promise<void> {
  const priv = hexToBytes(testKeyPairFor(user.id).privateHex)
  await new UserEngine({ ...user, activeKeys: [user.activeKeys[0]!] }, ctx).addKey(
    { key: pubKey, type: UserKeyType.mobile, expiration },
    async (digest) => ({ signature: bytesToHex(secp256k1.sign(digest, priv)), signerKey: user.activeKeys[0]!.key, signerUserId: user.id })
  )
}

describe('O-06 - UserEngine.inspectDeviceIdentity', () => {
  let fx: ThresholdAuthorityFixture
  let ctx: EngineContext

  beforeEach(async () => {
    fx = await createThresholdAuthority({
      holderCount: 2,
      thresholdPolicies: [{ policy: 'rad', threshold: 1 }, { policy: 'vrg', threshold: 1 }]
    })
    ctx = fx.elec.ctx
  })

  it('I1 forked: a random local id with an officer\'s key -> not a network user, that officer listed', async () => {
    const x = fx.holders[0]!.user
    const result = await inspector(ctx, x).inspectDeviceIdentity('R-random', x.activeKeys[0]!.key)
    expect(result).to.deep.equal({ localIsNetworkUser: false, officerUserIdsHoldingKey: [x.id] })
  })

  it('I2 not forked: the officer\'s own id is a network user', async () => {
    const x = fx.holders[0]!.user
    const result = await inspector(ctx, x).inspectDeviceIdentity(x.id, x.activeKeys[0]!.key)
    expect(result.localIsNetworkUser).to.equal(true)
    expect(result.officerUserIdsHoldingKey).to.deep.equal([x.id])
  })

  it('I3 ambiguous: two current officers listing the same key -> both ids, sorted', async () => {
    const a = fx.holders[0]!.user
    const b = fx.holders[1]!.user
    await giveKey(ctx, b, a.activeKeys[0]!.key)
    const result = await inspector(ctx, a).inspectDeviceIdentity('R-random', a.activeKeys[0]!.key)
    expect(result.officerUserIdsHoldingKey).to.deep.equal([a.id, b.id].sort())
  })

  it('I4 non-officer: a user holding the key who is not a current officer is not a candidate', async () => {
    const outsider = fx.outsider
    const pair = randomTestKeyPair()
    // the outsider is a real network User without an officer seat
    const outsiderKey = outsider.activeKeys[0]!.key
    const result = await inspector(ctx, outsider).inspectDeviceIdentity('R-random', outsiderKey)
    expect(result.officerUserIdsHoldingKey).to.deep.equal([])
    expect(await inspector(ctx, outsider).inspectDeviceIdentity('R-random', pair.publicHex)).to.deep.equal({
      localIsNetworkUser: false,
      officerUserIdsHoldingKey: []
    })
  })

  it('I5 expired key: not listed', async function () {
    // WR-R2-08: a 10 s window, then poll until it lapses. The old 1.5 s window had to cover a
    // signed insert (schema check Expiration > now) AND the first inspection, which a loaded host
    // can miss; datetimes here are second-precision, so the window must be several seconds.
    this.timeout(40_000)
    const x = fx.holders[0]!.user
    const pair = randomTestKeyPair()
    const expiresAt = Date.now() + 10_000
    await giveKey(ctx, x, pair.publicHex, expiresAt)
    expect((await inspector(ctx, x).inspectDeviceIdentity('R-random', pair.publicHex)).officerUserIdsHoldingKey).to.deep.equal([x.id])
    const deadline = expiresAt + 20_000
    let listed: string[] = [x.id]
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      listed = (await inspector(ctx, x).inspectDeviceIdentity('R-random', pair.publicHex)).officerUserIdsHoldingKey
      if (listed.length === 0) break
    }
    expect(Date.now(), 'the key was never listed as expired before its expiration').to.be.at.least(expiresAt - 1000)
    expect(listed, 'the expired key is no longer listed').to.deep.equal([])
  })

  it('I6 shape: no UserKey query without a UserId = predicate, and bad arguments are refused', async () => {
    const x = fx.holders[0]!.user
    const seen: string[] = []
    const realDb = ctx.db
    // WR-R2-05: methods run with `this` = the proxy, so the prepare that Database.get()/eval()/exec()
    // issue internally is recorded too (binding to the raw target let those reads bypass the spy).
    const spyDb = new Proxy(realDb, {
      get (target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if ((prop === 'prepare' || prop === 'eval' || prop === 'exec') && typeof value === 'function') {
          return (sql: string, ...rest: unknown[]) => {
            seen.push(sql)
            return (value as (...a: unknown[]) => unknown).call(receiver, sql, ...rest)
          }
        }
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(receiver) : value
      }
    })
    // Negative control: a read through db.get (whose prepare is internal) is seen.
    await spyDb.get("select count(*) as c from UserKey where UserId = :uid", { uid: x.id })
    expect(seen.some((sql) => /from UserKey where UserId = :uid/.test(sql)), 'db.get reaches the spy').to.equal(true)
    seen.length = 0
    const spied = inspector({ ...ctx, db: spyDb } as EngineContext, x)
    await spied.inspectDeviceIdentity('R-random', x.activeKeys[0]!.key)
    const userKeySql = seen.filter((sql) => /UserKey/.test(sql))
    expect(userKeySql.length).to.be.greaterThan(0)
    for (const sql of userKeySql) expect(sql, sql).to.match(/UserId\s*=\s*:/)

    for (const bad of [['', 'k'], ['id', ''], [undefined, 'k'], ['id', 5]] as Array<[unknown, unknown]>) {
      let caught: unknown
      try {
        await inspector(ctx, x).inspectDeviceIdentity(bad[0] as string, bad[1] as string)
      } catch (err) {
        caught = err
      }
      expect(caught, JSON.stringify(bad)).to.be.instanceOf(Error)
    }
  })
})
