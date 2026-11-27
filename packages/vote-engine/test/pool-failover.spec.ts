/**
 * pool-failover.spec.ts — R3 (D-30): the failover rendezvous client the Voter wraps around one
 * client per join-bootstrap address. Proves the try order, last-good stickiness, that an `error`
 * REPLY is an answer (not failed over), the stable all-fail message, and the module's purity.
 */

import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFailoverRendezvousClient } from '../src/pool/pool-failover.js'
import { PoolRendezvous, createInMemoryRendezvousClient, poolRequests } from '../src/pool/pool-rendezvous.js'
import type { PoolRendezvousClient, RendezvousReply } from '../src/pool/pool-rendezvous.js'
import { createPoolIdentity } from '../src/pool/pool-envelope.js'

interface FakeClient extends PoolRendezvousClient {
  calls: Array<{ request: unknown, extraWaitMs: number | undefined }>
}

const OK: RendezvousReply = { t: 'ok' }
const request = { t: 'send', envelope: {} } as never

function answering (reply: RendezvousReply = OK): FakeClient {
  const calls: FakeClient['calls'] = []
  return { calls, call: async (r, extraWaitMs) => { calls.push({ request: r, extraWaitMs }); return reply } }
}

function rejecting (reason: unknown): FakeClient {
  const calls: FakeClient['calls'] = []
  return { calls, call: async (r, extraWaitMs) => { calls.push({ request: r, extraWaitMs }); throw reason } }
}

function throwingSync (error: Error): FakeClient {
  const calls: FakeClient['calls'] = []
  return { calls, call: (r, extraWaitMs) => { calls.push({ request: r, extraWaitMs }); throw error } }
}

describe('createFailoverRendezvousClient (R3, D-30)', () => {
  it('F-1 the first client answering is used alone', async () => {
    const a = answering({ t: 'coordinators', list: [] })
    const b = answering()
    const f = createFailoverRendezvousClient([a, b])
    expect(await f.call(request)).to.deep.equal({ t: 'coordinators', list: [] })
    expect(b.calls).to.have.length(0)
    expect(f.lastGood()).to.equal(0)
  })

  it('F-2 fails over on a throw and then sticks to the client that answered', async () => {
    const a = rejecting(new Error('dial failed'))
    const b = answering()
    const f = createFailoverRendezvousClient([a, b])
    expect(f.lastGood()).to.equal(-1)
    expect(await f.call(request)).to.deep.equal(OK)
    expect(f.lastGood()).to.equal(1)
    await f.call(request)
    expect(a.calls).to.have.length(1)
    expect(b.calls).to.have.length(2)
  })

  it('F-3 after the last-good one throws, the rest are tried in index order, skipping it', async () => {
    const order: number[] = []
    const up = [false, false, true]
    const mk = (i: number): PoolRendezvousClient => ({
      call: async () => { order.push(i); if (!up[i]) throw new Error('x'); return OK }
    })
    const f = createFailoverRendezvousClient([mk(0), mk(1), mk(2)])
    await f.call(request)
    expect(f.lastGood()).to.equal(2)
    expect(order).to.deep.equal([0, 1, 2])
    order.length = 0
    up[2] = false
    up[1] = true
    await f.call(request)
    expect(order).to.deep.equal([2, 0, 1])
    expect(f.lastGood()).to.equal(1)
  })

  it('F-4 an error reply is an answer and is not failed over', async () => {
    const rv = new PoolRendezvous({ isAllowed: () => false })
    try {
      const refusing = createInMemoryRendezvousClient(rv, createPoolIdentity().peerId)
      const b = answering()
      const f = createFailoverRendezvousClient([refusing, b])
      const id = createPoolIdentity()
      const reply = await f.call(poolRequests.poll(id, 0, Date.now()))
      expect(reply).to.deep.equal({ t: 'error', reason: 'not allowed' })
      expect(b.calls).to.have.length(0)
      expect(f.lastGood()).to.equal(0)
    } finally {
      rv.close()
    }
  })

  it('F-5 all failing throws one stable message with no raw text', async () => {
    const clients = [
      rejecting(new Error('ECONNREFUSED 10.0.0.1:99')),
      rejecting('plain string reason'),
      throwingSync(new Error('sync boom secret'))
    ]
    const f = createFailoverRendezvousClient(clients)
    let caught: unknown
    try { await f.call(request) } catch (e) { caught = e }
    expect(caught).to.be.instanceOf(Error)
    const err = caught as Error
    expect(err.message).to.equal('rendezvous unreachable')
    expect(err.message).to.not.contain('ECONNREFUSED')
    expect(err.message).to.not.contain('secret')
    expect((err as { cause?: unknown }).cause).to.equal(undefined)
    for (const c of clients) expect((c as FakeClient).calls).to.have.length(1)
  })

  it('F-6 an empty client list rejects with the stable message', async () => {
    const f = createFailoverRendezvousClient([])
    let caught: unknown
    try { await f.call(request) } catch (e) { caught = e }
    expect((caught as Error).message).to.equal('rendezvous unreachable')
  })

  it('F-7 extraWaitMs is passed through to every client tried', async () => {
    const a = rejecting(new Error('x'))
    const b = answering()
    const f = createFailoverRendezvousClient([a, b])
    await f.call(request, 1234)
    expect(a.calls[0]!.extraWaitMs).to.equal(1234)
    expect(b.calls[0]!.extraWaitMs).to.equal(1234)
  })

  it('F-8 a probe poll through a thrower then a real rendezvous returns an empty envelope list', async () => {
    const rv = new PoolRendezvous()
    try {
      const real = createInMemoryRendezvousClient(rv, createPoolIdentity().peerId)
      const f = createFailoverRendezvousClient([rejecting(new Error('down')), real])
      const reply = await f.call(poolRequests.poll(createPoolIdentity(), 0, Date.now()))
      expect(reply).to.deep.equal({ t: 'envelopes', list: [] })
    } finally {
      rv.close()
    }
  })

  it('F-9 copies its input array', async () => {
    const a = rejecting(new Error('x'))
    const b = answering()
    const list: PoolRendezvousClient[] = [a, b]
    const f = createFailoverRendezvousClient(list)
    list.length = 0
    expect(await f.call(request)).to.deep.equal(OK)
    expect(f.lastGood()).to.equal(1)
  })

  it('F-11 a failure AFTER the request was sent is not resent elsewhere; the next call starts on the next address', async () => {
    const sentThenTimedOut = Object.assign(new Error('pool frame read timed out'), { requestSent: true })
    const a = rejecting(sentThenTimedOut)
    const b = answering()
    const f = createFailoverRendezvousClient([a, b])
    let caught: unknown
    try { await f.call(request) } catch (e) { caught = e }
    expect((caught as Error).message).to.equal('rendezvous did not reply')
    expect((caught as Error).message).to.not.contain('timed out')
    expect(b.calls).to.have.length(0)
    // the request is not delivered twice, but a hung address does not keep every later call either
    expect(await f.call(request)).to.deep.equal(OK)
    expect(b.calls).to.have.length(1)
    expect(a.calls).to.have.length(1)
    expect(f.lastGood()).to.equal(1)
  })

  it('F-12 the libp2p client marks a post-send failure (requestSent) and leaves a dial failure unmarked', async () => {
    const { createLibp2pRendezvousClient } = await import('../src/pool/pool-wire.js')
    const failedDial = createLibp2pRendezvousClient({ handle: () => undefined, dialProtocol: async () => { throw new Error('no route') } }, 'x', { requestTimeoutMs: 100 })
    let dialErr: unknown
    try { await failedDial.call(request) } catch (e) { dialErr = e }
    expect((dialErr as { requestSent?: unknown }).requestSent).to.equal(undefined)
    const sent: Uint8Array[] = []
    const silent = {
      send: (b: Uint8Array) => { sent.push(b) },
      close: async () => undefined,
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) })
    }
    const hung = createLibp2pRendezvousClient({ handle: () => undefined, dialProtocol: async () => silent }, 'x', { requestTimeoutMs: 100 })
    let readErr: unknown
    try { await hung.call(request) } catch (e) { readErr = e }
    expect(sent).to.have.length(1)
    expect((readErr as { requestSent?: unknown }).requestSent).to.equal(true)
    // and over a failover pair, the second address is never sent the same request
    const b = answering()
    const f = createFailoverRendezvousClient([hung, b])
    try { await f.call(request) } catch { /* expected */ }
    expect(b.calls).to.have.length(0)
  })

  it('F-10 the module is pure: type-only imports, no Node or Hermes-hostile globals', () => {
    const file = join(dirname(fileURLToPath(import.meta.url)), '../src/pool/pool-failover.ts')
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    expect(code).to.contain('createFailoverRendezvousClient')
    expect(code).to.not.match(/\bBuffer\b|node:|console\.|Date\.now|TextDecoder|TextEncoder/)
    const imports = code.split('\n').filter(l => /^\s*import\b/.test(l))
    for (const l of imports) expect(l).to.match(/^\s*import type /)
  })
})
