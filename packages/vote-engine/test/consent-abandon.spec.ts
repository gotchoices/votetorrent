/**
 * consent-abandon.spec.ts — UAT 65 gap 1, review warnings WR-01 and WR-02 (decisions D-114..D-117).
 *
 * The consent queue now knows which prompt is on screen. A call can carry an abandon signal and a
 * deadline; when the signal aborts or the deadline passes, the queue asks the injected cancel hook to
 * dismiss the prompt and only then starts the next one, so a platform that swallows a second prompt
 * while one is showing never sees two. Queued calls start earliest deadline first, a call with too
 * little time left is refused without prompting, and a native result that arrives after the abandon
 * reaches nobody. The pool agent aborts its member consent at the reply bound (a re-form prompts once)
 * and bounds the former's own consent the same way. Timings are real defaults scaled down with wide
 * ratios; ordering is asserted by event order, never by tight clocks.
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/curves/utils.js'
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { encryptVoteEntry } from '../src/key-release/index.js'
import {
  PoolAgent,
  PoolRendezvous,
  createConsentQueue,
  ConsentAbandonedError,
  isConsentAbandonedError,
  POOL_MIN_PROMPT_MS,
  consentDigest,
  formPoolBlock,
  createPoolIdentity,
  createInMemoryRendezvousClient,
  openPoolEnvelope,
  poolIdentityFromRawKey,
  poolRequests,
  poolTopic,
  type PoolBallot,
  type PoolContribution,
  type PoolIdentity,
  type PoolAgentOptions,
  type PoolOutcome,
  type RendezvousRequest,
  type ConsentCallControl
} from '../src/pool/index.js'
import { sealPoolEnvelope } from '../src/pool/pool-envelope.js'
import { verifySigP256 } from '../src/database/initialize.js'
import type { VoterEntry } from '../src/voting/index.js'
import { makeP256TestKey, signDigestP256 } from './fixtures/p256-signer.js'

const sleep = async (ms: number): Promise<void> => await new Promise(resolve => setTimeout(resolve, ms))

async function until (cond: () => boolean, limitMs: number): Promise<boolean> {
  const end = Date.now() + limitMs
  while (Date.now() < end) {
    if (cond()) return true
    await sleep(10)
  }
  return cond()
}

interface Deferred<T> { promise: Promise<T>, resolve: (v: T) => void, reject: (e: unknown) => void }
function deferred<T> (): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function caught (p: Promise<unknown>): Promise<unknown> {
  try { await p } catch (e) { return e }
  return undefined
}

// ---------------------------------------------------------------------------------------------
// queue

describe('consent queue: abandon, cancel, deadline (D-114, D-115)', function () {
  this.timeout(30_000)

  /** a prompt function whose calls the test settles by hand, recording every start and end */
  function harness (cancelImpl?: () => Promise<unknown>, extra: { minPromptMs?: number, now?: () => number, holdMs?: number } = {}) {
    const events: string[] = []
    const prompts = new Map<string, Deferred<string>>()
    const cancels: string[] = []
    const q = createConsentQueue(async (name: string) => {
      events.push(`start ${name}`)
      const d = deferred<string>()
      prompts.set(name, d)
      try { return await d.promise } finally { events.push(`end ${name}`) }
    }, {
      ...extra,
      cancel: cancelImpl === undefined ? undefined : async () => { events.push('cancel-called'); cancels.push('c'); try { return await cancelImpl() } finally { events.push('cancel-settled') } }
    })
    return { q, events, prompts, cancels }
  }

  it('(a) a call abandoned while queued is rejected and its prompt never runs', async () => {
    const h = harness()
    const a = h.q.withControl(undefined, 'A')
    const ac = new AbortController()
    const b = h.q.withControl({ signal: ac.signal }, 'B')
    await sleep(20)
    ac.abort()
    const err = await caught(b)
    expect(isConsentAbandonedError(err)).to.equal(true)
    expect((err as ConsentAbandonedError).reason).to.equal('abandoned')
    h.prompts.get('A')!.resolve('a')
    expect(await a).to.equal('a')
    await sleep(30)
    expect(h.events).to.not.include('start B')
    // already aborted at enqueue
    const pre = new AbortController()
    pre.abort()
    const err2 = await caught(h.q.withControl({ signal: pre.signal }, 'C'))
    expect(isConsentAbandonedError(err2)).to.equal(true)
    expect((err2 as ConsentAbandonedError).reason).to.equal('abandoned')
    expect(h.events).to.not.include('start C')
  })

  it('(b) abort while running with a cancel hook: cancel once, next call waits for it, late result reaches nobody', async () => {
    const cancelGate = deferred<void>()
    const h = harness(async () => await cancelGate.promise)
    const ac = new AbortController()
    const a = h.q.withControl({ signal: ac.signal }, 'A')
    const b = h.q.withControl(undefined, 'B')
    await until(() => h.events.includes('start A'), 1_000)
    ac.abort()
    const err = await caught(a)
    expect(isConsentAbandonedError(err)).to.equal(true)
    expect((err as ConsentAbandonedError).reason).to.equal('abandoned')
    await sleep(100)
    expect(h.cancels).to.have.length(1)
    expect(h.events).to.not.include('start B')
    cancelGate.resolve()
    await until(() => h.events.includes('start B'), 1_000)
    h.prompts.get('B')!.resolve('b-value')
    expect(await b).to.equal('b-value')
    h.prompts.get('A')!.resolve('late-A')
    await sleep(30)
    const c = h.q.withControl(undefined, 'C')
    await until(() => h.events.includes('start C'), 1_000)
    h.prompts.get('C')!.resolve('c-value')
    expect(await c).to.equal('c-value')
    expect(h.cancels).to.have.length(1)
  })

  it('(b2) abort while running with NO cancel hook: caller rejects at once, slot held until the prompt settles', async () => {
    const h = harness()
    const ac = new AbortController()
    const a = h.q.withControl({ signal: ac.signal }, 'A')
    const b = h.q.withControl(undefined, 'B')
    await until(() => h.events.includes('start A'), 1_000)
    ac.abort()
    const err = await caught(a)
    expect(isConsentAbandonedError(err)).to.equal(true)
    await sleep(100)
    expect(h.events).to.not.include('start B')
    h.prompts.get('A')!.resolve('late')
    await until(() => h.events.includes('start B'), 1_000)
    h.prompts.get('B')!.resolve('b')
    expect(await b).to.equal('b')
  })

  it('(c) deadline expiry cancels the running prompt; the next starts only after the cancel settled', async () => {
    const h = harness(async () => await sleep(50))
    const t0 = Date.now()
    const a = h.q.withControl({ deadlineAt: Date.now() + 150 }, 'A')
    const b = h.q.withControl(undefined, 'B')
    const err = await caught(a)
    const took = Date.now() - t0
    expect(isConsentAbandonedError(err)).to.equal(true)
    expect((err as ConsentAbandonedError).reason).to.equal('expired')
    expect(took).to.be.within(100, 2_000)
    await until(() => h.events.includes('start B'), 2_000)
    h.prompts.get('B')!.resolve('b')
    expect(await b).to.equal('b')
    expect(h.cancels).to.have.length(1)
    const order = h.events.filter(e => ['cancel-called', 'cancel-settled', 'start B'].includes(e))
    expect(order).to.deep.equal(['cancel-called', 'cancel-settled', 'start B'])
  })

  it('(d) queued calls start earliest deadline first, no deadline last, ties in arrival order', async () => {
    let clock = 0
    const h = harness(undefined, { now: () => clock })
    const a = h.q.withControl(undefined, 'A')
    await until(() => h.events.includes('start A'), 1_000)
    const b = h.q.withControl({ deadlineAt: 5000 }, 'B')
    const c = h.q.withControl(undefined, 'C')
    const d = h.q.withControl({ deadlineAt: 3000 }, 'D')
    const e = h.q.withControl({ deadlineAt: 3000 }, 'E')
    h.prompts.get('A')!.resolve('a')
    for (const name of ['D', 'E', 'B', 'C']) {
      await until(() => h.prompts.has(name), 1_000)
      h.prompts.get(name)!.resolve(name)
    }
    await Promise.all([a, b, c, d, e])
    expect(h.events.filter(x => x.startsWith('start '))).to.deep.equal(['start A', 'start D', 'start E', 'start B', 'start C'])
  })

  it('(e) a call that would start with too little time left is refused without prompting', async () => {
    let clock = 0
    const h = harness(undefined, { now: () => clock, minPromptMs: 1000 })
    const a = h.q.withControl(undefined, 'A')
    await until(() => h.events.includes('start A'), 1_000)
    const b = h.q.withControl({ deadlineAt: 1200 }, 'B')
    const c = h.q.withControl({ deadlineAt: 5000 }, 'C')
    clock = 600
    h.prompts.get('A')!.resolve('a')
    const err = await caught(b)
    expect(isConsentAbandonedError(err)).to.equal(true)
    expect((err as ConsentAbandonedError).reason).to.equal('no-time')
    await until(() => h.prompts.has('C'), 1_000)
    h.prompts.get('C')!.resolve('c')
    expect(await c).to.equal('c')
    await a
    expect(h.events).to.not.include('start B')
    // already at or before now
    const err2 = await caught(h.q.withControl({ deadlineAt: 600 }, 'D'))
    expect((err2 as ConsentAbandonedError).reason).to.equal('no-time')
    expect(h.events).to.not.include('start D')
  })

  it('(f) onStart fires once per started call, directly before the prompt, never for a skipped call', async () => {
    let clock = 0
    const h = harness(undefined, { now: () => clock, minPromptMs: 1000 })
    const log = (e: string): void => { h.events.push(e) }
    const a = h.q.withControl({ onStart: () => log('onStart A') }, 'A')
    await until(() => h.events.includes('start A'), 1_000)
    const ac = new AbortController()
    const b = h.q.withControl({ signal: ac.signal, onStart: () => log('onStart B') }, 'B')
    const c = h.q.withControl({ deadlineAt: 100, onStart: () => log('onStart C') }, 'C')
    const d = h.q.withControl({ onStart: () => log('onStart D') }, 'D')
    ac.abort()
    h.prompts.get('A')!.resolve('a')
    await until(() => h.prompts.has('D'), 1_000)
    h.prompts.get('D')!.resolve('d')
    await Promise.all([a, d])
    expect(isConsentAbandonedError(await caught(b))).to.equal(true)
    expect(isConsentAbandonedError(await caught(c))).to.equal(true)
    expect(h.events.filter(e => e.startsWith('onStart'))).to.deep.equal(['onStart A', 'onStart D'])
    expect(h.events.indexOf('onStart A') + 1).to.equal(h.events.indexOf('start A'))
    expect(h.events.indexOf('onStart D') + 1).to.equal(h.events.indexOf('start D'))
  })

  it('(h) a cancel that never settles still releases the queue after the internal cap', async function () {
    this.timeout(30_000)
    const h = harness(async () => await new Promise(() => {}))
    const ac = new AbortController()
    const a = h.q.withControl({ signal: ac.signal }, 'A')
    const b = h.q.withControl(undefined, 'B')
    await until(() => h.events.includes('start A'), 1_000)
    const t0 = Date.now()
    ac.abort()
    expect(isConsentAbandonedError(await caught(a))).to.equal(true)
    await until(() => h.events.includes('start B'), 12_000)
    const waited = Date.now() - t0
    expect(waited).to.be.within(4_500, 9_000)
    h.prompts.get('B')!.resolve('b')
    expect(await b).to.equal('b')
  })

  it('(h) a cancel that rejects or throws releases at once and the caller still gets the abandon error', async () => {
    for (const mode of ['reject', 'throw'] as const) {
      const h = harness(mode === 'reject' ? async () => { throw new Error('boom') } : (() => { throw new Error('boom') }) as unknown as () => Promise<unknown>)
      const ac = new AbortController()
      const a = h.q.withControl({ signal: ac.signal }, 'A')
      const b = h.q.withControl(undefined, 'B')
      await until(() => h.events.includes('start A'), 1_000)
      ac.abort()
      expect(isConsentAbandonedError(await caught(a)), mode).to.equal(true)
      expect(await until(() => h.events.includes('start B'), 1_500), `${mode}: B started`).to.equal(true)
      h.prompts.get('B')!.resolve('b')
      expect(await b).to.equal('b')
    }
  })

  it('exposes the exact exported names', () => {
    expect(POOL_MIN_PROMPT_MS).to.equal(10_000)
    const e = new ConsentAbandonedError('expired')
    expect(e.name).to.equal('ConsentAbandonedError')
    expect(e.reason).to.equal('expired')
    expect(isConsentAbandonedError({ name: 'ConsentAbandonedError' })).to.equal(true)
    expect(isConsentAbandonedError(new Error('x'))).to.equal(false)
  })
})
