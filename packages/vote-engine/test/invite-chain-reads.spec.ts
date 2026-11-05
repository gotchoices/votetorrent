/**
 * invite-chain-reads.spec.ts - how readInviteChain reads (WR-07 option a), the detailed variant, the
 * respond write's in-transaction liveness re-check (IN-04) and the per-database write serializer.
 */
import { expect } from 'chai'
import { readInviteChain, readInviteChainDetailed } from '../src/invite/read-invite-chain.js'
import { withInviteWriteSerial } from '../src/invite/invite-write-serial.js'
import { InvitationEngine } from '../src/invite/invitation-engine.js'
import type { EngineContext } from '../src/types.js'
import { nowCanonicalDatetime } from '../src/utils.js'
import { makeChainFixture, sendInvite, resultRows, markerRows } from './fixtures/invite-chain.js'
import type { ChainFixture } from './fixtures/invite-chain.js'

type Db = EngineContext['db']

/** A db whose eval/prepare SQL is recorded; everything else is delegated. */
function recordingDb (db: Db, seen: string[]): Db {
  return new Proxy(db as object, {
    get (target, prop, receiver) {
      const value = Reflect.get(target, prop, target)
      if (prop === 'eval') {
        return (sql: string, params?: unknown) => { seen.push(sql); return (value as Function).call(target, sql, params) }
      }
      if (prop === 'prepare') {
        return (sql: string) => { seen.push(sql); return (value as Function).call(target, sql) }
      }
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as Db
}

async function nonceOf (fx: ChainFixture, cid: string): Promise<string> {
  const row = await fx.auth.ctx.db.prepare('select SigningNonce from InviteSlot where Cid = :cid').get({ cid })
  return row!.SigningNonce as string
}

describe('readInviteChain read shape (WR-07 option a)', () => {
  it('R1: a nonce-scoped read never scans by InviteKey and reads InviteSlot by SigningNonce once', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    const nonce = await nonceOf(fx, s.cid)
    const seen: string[] = []
    const res = await readInviteChain(recordingDb(fx.auth.ctx.db, seen), s.inviteKey, 'of', nowCanonicalDatetime(), nonce)
    expect(res).to.deep.equal({ status: 'live', cid: s.cid })
    expect(seen.filter(q => /InviteKey\s*=/.test(q)), seen.join('\n')).to.have.length(0)
    expect(seen.filter(q => /SigningNonce\s*=/.test(q)), seen.join('\n')).to.have.length(1)
  })

  it('R2: the unscoped form still reads by InviteKey (documented scan)', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    const seen: string[] = []
    const res = await readInviteChain(recordingDb(fx.auth.ctx.db, seen), s.inviteKey, 'of', nowCanonicalDatetime())
    expect(res).to.deep.equal({ status: 'live', cid: s.cid })
    expect(seen.filter(q => /InviteKey\s*=/.test(q))).to.have.length(1)
  })

  it('R3: a nonce-scoped read ignores rows of other invitations that share the InviteKey', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    const nonce = await nonceOf(fx, s.cid)
    expect(await readInviteChain(fx.auth.ctx.db, s.inviteKey, 'of', nowCanonicalDatetime(), nonce)).to.deep.equal({ status: 'live', cid: s.cid })
    // A wrong type for the same nonce finds nothing.
    expect(await readInviteChain(fx.auth.ctx.db, s.inviteKey, 'au', nowCanonicalDatetime(), nonce)).to.deep.equal({ status: 'not-found' })
  })

  it('D1: readInviteChainDetailed returns the resolution plus the chain rows and markers', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    const head = await fx.authority.resendInvite(s.cid)
    const nonce = await nonceOf(fx, s.cid)
    const now = nowCanonicalDatetime()
    const live = await readInviteChainDetailed(fx.auth.ctx.db, s.inviteKey, 'of', now, nonce)
    expect(live.resolution).to.deep.equal(await readInviteChain(fx.auth.ctx.db, s.inviteKey, 'of', now, nonce))
    expect(live.resolution).to.deep.equal({ status: 'live', cid: head })
    expect(live.rows.map(r => r.cid).sort()).to.deep.equal([s.cid, head].sort())
    expect(live.rows.every(r => r.cancelled === false)).to.equal(true)

    await fx.authority.cancelInvite(head)
    const closed = await readInviteChainDetailed(fx.auth.ctx.db, s.inviteKey, 'of', nowCanonicalDatetime(), nonce)
    expect(closed.resolution.status).to.equal('no-longer-valid')
    const cancelledCids = closed.rows.filter(r => r.cancelled).map(r => r.cid)
    expect(cancelledCids.length).to.equal(await markerRows(fx, [s.cid, head]))
    expect(cancelledCids).to.include(head)
  })

  it('D2: readInviteChainDetailed on no chain is not-found with no rows', async () => {
    const fx = await makeChainFixture()
    const d = await readInviteChainDetailed(fx.auth.ctx.db, 'ab'.repeat(33), 'of', nowCanonicalDatetime(), 'nonce')
    expect(d).to.deep.equal({ resolution: { status: 'not-found' }, rows: [] })
  })
})

describe('respondToInvite writes in one serialized transaction (IN-04)', () => {
  it('I1: an answer landing between the liveness read and the write is refused, not double-written', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    const raw = fx.auth.ctx.db
    let triggered = 0
    const wrapped = new Proxy(raw as object, {
      get (target, prop) {
        const value = Reflect.get(target, prop, target)
        if (prop === 'exec') {
          return async (sql: string, params?: unknown) => {
            if (/^\s*BEGIN/i.test(sql) && triggered === 0) {
              triggered += 1
              await fx.invitation.respondToInvite(s.cid, true, s.invitePrivate)
            }
            return (value as Function).call(target, sql, params)
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as Db
    const racing = new InvitationEngine({ ...fx.auth.ctx, db: wrapped } as EngineContext)
    let caught: unknown
    try { await racing.respondToInvite(s.cid, true, s.invitePrivate) } catch (err) { caught = err }
    expect(triggered, 'the officer respond must open a transaction').to.equal(1)
    expect(caught).to.be.instanceOf(Error)
    expect((caught as { code?: string }).code).to.equal('invite-already-answered')
    expect(await resultRows(fx, [s.cid])).to.equal(1)
  })
})

describe('withInviteWriteSerial', () => {
  const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

  it('S1: overlapping calls on one db run one after another, in order, even after a rejection', async () => {
    const db = {}
    const log: string[] = []
    const a = withInviteWriteSerial(db, async () => { log.push('a:start'); await delay(30); log.push('a:end'); throw new Error('boom') })
    const b = withInviteWriteSerial(db, async () => { log.push('b:start'); await delay(5); log.push('b:end'); return 'b' })
    const c = withInviteWriteSerial(db, async () => { log.push('c:start'); log.push('c:end'); return 'c' })
    let aErr: unknown
    try { await a } catch (err) { aErr = err }
    expect((aErr as Error).message).to.equal('boom')
    expect(await b).to.equal('b')
    expect(await c).to.equal('c')
    expect(log).to.deep.equal(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end'])
  })

  it('S2: calls on different dbs do not wait for each other', async () => {
    const log: string[] = []
    const slow = withInviteWriteSerial({}, async () => { log.push('slow:start'); await delay(40); log.push('slow:end') })
    const fast = withInviteWriteSerial({}, async () => { log.push('fast:start'); log.push('fast:end') })
    await Promise.all([slow, fast])
    expect(log.indexOf('fast:end')).to.be.lessThan(log.indexOf('slow:end'))
  })
})
