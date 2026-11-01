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

// ---------------------------------------------------------------------------------------------
// agent

const electionSecret = secp256k1.utils.randomSecretKey()
const mkBallot = (id: string): PoolBallot => ({
  electionKey: { electionId: 'e-abandon', revision: 1, jointPublicKey: bytesToHex(secp256k1.getPublicKey(electionSecret, true)) },
  ballotId: id,
  templateDigest: 'td'
})
const ballot: PoolBallot = mkBallot('b-abandon')

interface TV { identity: PoolIdentity, contribution: PoolContribution, priv: Uint8Array, name: string, pub: string }

/** a voter on one ballot; `p256` shares one device key across ballots, `rawKey` fixes the pool identity */
function mk (name: string, b: PoolBallot = ballot, rawKey?: Uint8Array, p256?: { privBytes: Uint8Array, pubHex: string }): TV {
  const identity = poolIdentityFromRawKey(rawKey ?? ed25519.utils.randomSecretKey())
  const { privBytes, pubHex } = p256 ?? makeP256TestKey()
  const voteJson = JSON.stringify({ v: 1, ballotId: b.ballotId, answers: [], nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(32))) })
  const voterEntry: VoterEntry = {
    v: 1, electionId: b.electionKey.electionId, electionRevision: 1, registrantId: `reg-${name}`,
    privateCid: `p-${name}`, publicCid: null, deviceKey: pubHex, attestationCid: null,
    ballots: [{ ballotId: b.ballotId, templateDigest: b.templateDigest }], signature: 'ab'.repeat(32)
  }
  return { identity, priv: privBytes, pub: pubHex, name, contribution: { member: identity.peerId, voteCiphertext: encryptVoteEntry(b.electionKey, b.ballotId, voteJson), voterEntry } }
}

/** voters with peer ids sorted so that voters[0] is the lowest and becomes the former */
function sortedVoters (names: string[]): TV[] {
  const raw = names.map(() => ed25519.utils.randomSecretKey())
  const order = raw.map(k => poolIdentityFromRawKey(k)).map((id, i) => ({ id, i })).sort((a, b) => (a.id.peerId < b.id.peerId ? -1 : 1))
  return order.map((o, k) => mk(names[k]!, ballot, raw[o.i]))
}

/** a fake native prompt layer: counts starts, can be cancelled, records whether a start carried an aborted signal */
function fakeNative (answerAfterMs: (n: number) => number | null, priv: () => Uint8Array, opts: { cancelSettlesPrompt?: boolean } = {}) {
  const starts: Array<{ at: number, aborted: boolean, n: number }> = []
  const pending = new Set<{ reject: (e: unknown) => void }>()
  const late: Array<(sig: string) => void> = []
  let active = 0
  let maxActive = 0
  let cancels = 0
  const t0 = Date.now()
  const prompt = async (digest: string, signal?: AbortSignal): Promise<string> => {
    const n = starts.length + 1
    starts.push({ at: Date.now() - t0, aborted: signal?.aborted === true, n })
    active++
    maxActive = Math.max(maxActive, active)
    const wait = answerAfterMs(n)
    try {
      return await new Promise<string>((resolve, reject) => {
        const entry = { reject }
        pending.add(entry)
        late.push((sig) => resolve(sig))
        if (wait !== null) setTimeout(() => { pending.delete(entry); resolve(signDigestP256(digest, priv())) }, wait)
      })
    } finally {
      active--
    }
  }
  const cancel = async (): Promise<void> => {
    cancels++
    await sleep(10)
    if (opts.cancelSettlesPrompt !== false) {
      for (const p of pending) p.reject(new Error('CANCELED'))
      pending.clear()
    }
  }
  return { prompt, cancel, starts, late, stats: () => ({ maxActive, cancels, active }) }
}

interface Inbound { from: string, body: { t: string, id?: string, re?: string, [k: string]: any } }
function scriptedPeer (rv: PoolRendezvous, name: string) {
  const identity = createPoolIdentity()
  const client = createInMemoryRendezvousClient(rv, name)
  const inbox: Inbound[] = []
  const peer = {
    identity,
    inbox,
    async present (topic: string, size: number) { return await client.call(poolRequests.present(identity, topic, size, Date.now())) },
    async send (to: string, body: unknown) { await client.call(poolRequests.send(sealPoolEnvelope(identity, to, body))) },
    async drain (waitMs: number) {
      const r = await client.call(poolRequests.poll(identity, waitMs, Date.now()))
      if (r.t === 'envelopes') for (const e of r.list) inbox.push(openPoolEnvelope(identity, e) as Inbound)
    },
    async next (pred: (m: Inbound) => boolean, timeoutMs = 5_000): Promise<Inbound | null> {
      const until = Date.now() + timeoutMs
      for (;;) {
        const i = inbox.findIndex(pred)
        if (i >= 0) return inbox.splice(i, 1)[0]!
        const left = until - Date.now()
        if (left <= 0) return null
        await peer.drain(Math.min(100, left))
      }
    }
  }
  return peer
}
const holdOfVoter = (v: TV): string => bytesToHex(sha256(utf8ToBytes(v.contribution.voteCiphertext)))

describe('pool agent: a member aborts an unanswered consent at the bound (D-114, D-116)', function () {
  this.timeout(30_000)

  async function memberHarness (native: ReturnType<typeof fakeNative>, a: TV, overrides: Partial<PoolAgentOptions> = {}) {
    const rv = new PoolRendezvous()
    const c = scriptedPeer(rv, 'transport-c')
    const topic = poolTopic(ballot)
    await c.present(topic, 4)
    const q = createConsentQueue(async (digest: string, signal?: AbortSignal) => await native.prompt(digest, signal), { cancel: native.cancel, minPromptMs: 200 })
    const controller = new AbortController()
    const agent = new PoolAgent({
      identity: a.identity,
      rendezvous: createInMemoryRendezvousClient(rv, 'transport-a'),
      ballot,
      contribution: a.contribution,
      signConsent: async (digest, ctl) => await q.withControl(ctl, digest, ctl?.signal),
      commit: async () => ({ ok: true }),
      ladder: false,
      quietMs: 60_000,
      presentIntervalMs: 60,
      replyTimeoutMs: 400,
      informAttempts: 2,
      signTimeoutMs: 1_500,
      memberTimeoutMs: 30_000,
      pollWaitMs: 200,
      formLeadMs: 0,
      deadlineAt: Date.now() + 25_000,
      ...overrides
    })
    const running = agent.run(controller.signal)
    const merge = await c.next(m => m.body.t === 'merge')
    if (merge === null) throw new Error('the agent never merged into the scripted coordinator')
    await c.send(a.identity.peerId, { t: 'merged', re: merge.body.id, size: 5 })
    await c.send(a.identity.peerId, { t: 'inform', id: 'c-inform-1', topic, size: 5, hold: holdOfVoter(a) })
    if (await c.next(m => m.body.t === 'ack' && m.body.re === 'c-inform-1') === null) throw new Error('no ack')
    const stop = async (): Promise<PoolOutcome> => { controller.abort(); const o = await running; rv.close(); return o }
    return { rv, c, topic, stop, q, controller, running }
  }

  it('the first prompt is cancelled at the bound, a refusal goes out, and a re-form raises exactly one new prompt', async () => {
    const a = mk('a')
    const native = fakeNative((n) => (n === 1 ? null : 0), () => a.priv)
    const h = await memberHarness(native, a)
    try {
      const block = formPoolBlock([a.contribution, mk('x').contribution, mk('y').contribution], ballot)
      const sentAt = Date.now()
      await h.c.send(a.identity.peerId, { t: 'form', id: 'f-1', topic: h.topic, block })
      const refused = await h.c.next(m => m.body.re === 'f-1', 6_000)
      const took = Date.now() - sentAt
      expect(refused?.body.t).to.equal('refuse')
      expect(refused?.body.reason).to.equal('no answer in time')
      expect(took).to.be.within(900, 3_000)
      expect(native.stats().cancels, 'cancel calls').to.equal(1)
      await h.c.send(a.identity.peerId, { t: 'form', id: 'f-2', topic: h.topic, block })
      const second = await h.c.next(m => m.body.re === 'f-2', 4_000)
      expect(second?.body.t).to.equal('sign')
      const sig = second!.body.signature
      expect(verifySigP256(consentDigest(block, ballot, a.contribution.voterEntry.registrantId, a.contribution.voterEntry.deviceKey), sig.signature, a.pub)).to.equal(true)
      expect(native.starts, 'native prompt starts').to.have.length(2)
      expect(await h.c.next(m => m.body.re === 'f-1', 200), 'no second reply to f-1').to.equal(null)
    } finally {
      await h.stop()
    }
  })

  it('a native result that arrives after the refusal reaches nobody', async () => {
    const a = mk('a')
    const native = fakeNative(() => null, () => a.priv, { cancelSettlesPrompt: false })
    const h = await memberHarness(native, a)
    try {
      const block = formPoolBlock([a.contribution, mk('x').contribution, mk('y').contribution], ballot)
      await h.c.send(a.identity.peerId, { t: 'form', id: 'f-1', topic: h.topic, block })
      const refused = await h.c.next(m => m.body.re === 'f-1', 6_000)
      expect(refused?.body.t).to.equal('refuse')
      expect(native.stats().cancels).to.equal(1)
      native.late[0]!(signDigestP256(consentDigest(block, ballot, a.contribution.voterEntry.registrantId, a.contribution.voterEntry.deviceKey), a.priv))
      await sleep(400)
      await h.c.drain(100)
      expect(h.c.inbox.some(m => m.body.t === 'sign'), 'no sign ever sent').to.equal(false)
    } finally {
      await h.stop()
    }
  })

  it('WR-01: stopping the run while a member\'s prompt is showing cancels it at once, not at the run loop\'s next turn or the bound', async () => {
    // The run loop sleeps presentIntervalMs between turns (>= 3.75 s here) and the consent bound is
    // ~19.6 s away, so a cancel within 1 s can only come from the run signal itself.
    const a = mk('a')
    const native = fakeNative(() => null, () => a.priv)
    const h = await memberHarness(native, a, { presentIntervalMs: 5_000, signTimeoutMs: 20_000 })
    try {
      const block = formPoolBlock([a.contribution, mk('x').contribution, mk('y').contribution], ballot)
      await h.c.send(a.identity.peerId, { t: 'form', id: 'f-1', topic: h.topic, block })
      expect(await until(() => native.starts.length === 1, 3_000), 'the member prompt is showing').to.equal(true)
      const abortAt = Date.now()
      h.controller.abort()
      expect(await until(() => native.stats().cancels === 1, 3_000), 'cancel called').to.equal(true)
      const cancelledAfter = Date.now() - abortAt
      expect(cancelledAfter, 'cancel after the stop (ms)').to.be.below(1_000)
      const reply = await h.c.next(m => m.body.re === 'f-1', 2_000)
      expect(reply?.body.t).to.equal('refuse')
      expect(reply?.body.reason).to.equal('the voter stopped pooling')
      expect(native.starts, 'one prompt only').to.have.length(1)
      expect(h.c.inbox.some(m => m.body.t === 'sign'), 'no sign sent').to.equal(false)
    } finally {
      await h.stop()
    }
  })

  it('a former that releases the pool while the member\'s prompt is showing gets that prompt cancelled at once', async () => {
    // The consent bound is ~19.6 s away, so a cancel within 1 s of the outcome can only come from the
    // release itself. The member then pools alone, and the next form prompts exactly once more.
    const a = mk('a')
    const native = fakeNative((n) => (n === 1 ? null : 0), () => a.priv)
    const h = await memberHarness(native, a, { signTimeoutMs: 20_000 })
    try {
      const block = formPoolBlock([a.contribution, mk('x').contribution, mk('y').contribution], ballot)
      await h.c.send(a.identity.peerId, { t: 'form', id: 'f-1', topic: h.topic, block })
      expect(await until(() => native.starts.length === 1, 3_000), 'the member prompt is showing').to.equal(true)
      const releasedAt = Date.now()
      await h.c.send(a.identity.peerId, { t: 'outcome', topic: h.topic, committed: false, reason: 'the former did not answer in time' })
      expect(await until(() => native.stats().cancels === 1, 3_000), 'cancel called').to.equal(true)
      expect(Date.now() - releasedAt, 'cancel after the release (ms)').to.be.below(1_000)
      expect(h.c.inbox.some(m => m.body.t === 'sign'), 'no sign sent').to.equal(false)
      expect(native.starts, 'one prompt only').to.have.length(1)
    } finally {
      await h.stop()
    }
  })

  it('a member that cannot prompt (app in the background) refuses a form at once and never prompts', async () => {
    // It joined in the foreground (a phone in the background holds back and joins nobody), then left it.
    const a = mk('a')
    const native = fakeNative(() => 0, () => a.priv)
    let foreground = true
    const h = await memberHarness(native, a, { canPrompt: () => foreground })
    foreground = false
    try {
      const block = formPoolBlock([a.contribution, mk('x').contribution, mk('y').contribution], ballot)
      const sentAt = Date.now()
      await h.c.send(a.identity.peerId, { t: 'form', id: 'f-1', topic: h.topic, block })
      const reply = await h.c.next(m => m.body.re === 'f-1', 2_000)
      expect(reply?.body.t).to.equal('refuse')
      expect(reply?.body.reason).to.equal('the voter cannot confirm right now')
      expect(Date.now() - sentAt, 'refused without waiting (ms)').to.be.below(1_000)
      expect(native.starts, 'no prompt').to.have.length(0)
      foreground = true
      await h.c.send(a.identity.peerId, { t: 'form', id: 'f-2', topic: h.topic, block })
      const signed = await h.c.next(m => m.body.re === 'f-2', 3_000)
      expect(signed?.body.t, 'back in the foreground it signs').to.equal('sign')
      expect(native.starts, 'one prompt').to.have.length(1)
    } finally {
      await h.stop()
    }
  })

  it('IN-03: a re-sent form refreshes a still-queued consent to the new form\'s deadline; the first form is refused at its own bound', async () => {
    // The phone's queue is held by another prompt past f-1's bound, and released before f-2's. One
    // shared consent: f-1 is refused at its bound, the consent stays queued, then prompts and signs f-2.
    const a = mk('a')
    const native = fakeNative((n) => (n === 1 ? null : 0), () => a.priv)
    const h = await memberHarness(native, a, { signTimeoutMs: 4_000 })
    try {
      const other = h.q.withControl(undefined, 'other-ballot', undefined)
      other.catch(() => undefined)
      expect(await until(() => native.starts.length === 1, 1_000), 'the other prompt holds the queue').to.equal(true)
      const block = formPoolBlock([a.contribution, mk('x').contribution, mk('y').contribution], ballot)
      await h.c.send(a.identity.peerId, { t: 'form', id: 'f-1', topic: h.topic, block })
      await sleep(2_000)
      await h.c.send(a.identity.peerId, { t: 'form', id: 'f-2', topic: h.topic, block })
      const first = await h.c.next(m => m.body.re === 'f-1', 6_000)
      expect(first?.body.t).to.equal('refuse')
      expect(first?.body.reason).to.equal('no answer in time')
      await sleep(300)
      native.late[0]!('other-signature')
      expect(await other).to.equal('other-signature')
      const second = await h.c.next(m => m.body.re === 'f-2', 4_000)
      expect(second?.body.t, `f-2 reply ${JSON.stringify(second?.body)}`).to.equal('sign')
      expect(verifySigP256(consentDigest(block, ballot, a.contribution.voterEntry.registrantId, a.contribution.voterEntry.deviceKey), second!.body.signature.signature, a.pub)).to.equal(true)
      expect(native.starts, 'the other prompt and one consent prompt').to.have.length(2)
      expect(native.stats().cancels, 'nothing cancelled').to.equal(0)
    } finally {
      await h.stop()
    }
  })
})

describe('pool agent: stopping the run cancels the former\'s own prompt at once (WR-01)', function () {
  this.timeout(60_000)

  it('the own prompt is cancelled well before ownDeadline, the pool is released with aborted, nothing commits', async () => {
    // signTimeoutMs 9.6 s, replyTimeoutMs 0.6 s: ownDeadline is ~9 s after the form, against a 1.5 s limit.
    const rendezvous = new PoolRendezvous({ coordinatorTtlMs: 5_000, envelopeTtlMs: 20_000, maxPollWaitMs: 100 })
    const [F, M, X] = sortedVoters(['F', 'M', 'X'])
    const fStop = new AbortController()
    const restStop = new AbortController()
    const commits: string[][] = []
    const events: Record<string, Array<{ e: string, d: any }>> = { F: [], M: [], X: [] }
    let fOutcome: PoolOutcome | undefined
    let fEndedAt: number | null = null
    let cancels = 0
    let cancelAt: number | null = null
    const fQueue = createConsentQueue(async (_digest: string, signal?: AbortSignal) =>
      await new Promise<string>((_resolve, reject) => { signal?.addEventListener('abort', () => reject(new Error('CANCELED'))) }),
    { cancel: async () => { cancels++; cancelAt ??= Date.now(); await sleep(5) } })
    const runs = [F!, M!, X!].map(async (v) => {
      const outcome = await new PoolAgent({
        quietMs: 300, presentIntervalMs: 40, replyTimeoutMs: 600, informAttempts: 2,
        signTimeoutMs: 9_600, memberTimeoutMs: 2_400, pollWaitMs: 50, formLeadMs: 5_000, ladder: false,
        identity: v.identity,
        rendezvous: createInMemoryRendezvousClient(rendezvous, `t-${v.name}`),
        ballot,
        contribution: v.contribution,
        signConsent: v.name === 'F'
          ? async (d, ctl) => await fQueue.withControl(ctl, d, ctl?.signal)
          : async (d) => signDigestP256(d, v.priv),
        commit: async (_b, sigs) => { commits.push(sigs.map(s => s.registrantId)); return { ok: true } },
        findRecordedVote: async () => null,
        deadlineAt: Date.now() + 50_000,
        log: (e, d) => { events[v.name]!.push({ e, d }) }
      }).run(v.name === 'F' ? fStop.signal : restStop.signal)
      if (v.name === 'F') { fOutcome = outcome; fEndedAt = Date.now() }
      return outcome
    })
    try {
      expect(await until(() => events.F!.some(x => x.e === 'own-consent-start'), 30_000), 'the former\'s own prompt is showing').to.equal(true)
      const abortAt = Date.now()
      fStop.abort()
      expect(await until(() => fOutcome !== undefined, 8_000), 'the former\'s run ended').to.equal(true)
      expect(cancels, 'cancel called once').to.equal(1)
      expect(cancelAt! - abortAt, 'cancel after the stop (ms)').to.be.below(1_500)
      expect(fEndedAt! - abortAt, 'run ended after the stop (ms)').to.be.below(3_000)
      expect(fOutcome).to.deep.equal({ status: 'stopped', reason: 'aborted' })
      expect(events.F!.some(x => x.e === 'form-stopped'), 'former logged form-stopped').to.equal(true)
      expect(events.F!.some(x => x.e === 'own-consent-timeout'), 'not reported as a timeout').to.equal(false)
      expect(await until(() => ['M', 'X'].every(n => events[n]!.some(x => x.e === 'solo' && String(x.d?.why).includes('aborted'))), 5_000), 'members released with aborted').to.equal(true)
      expect(commits, 'nothing committed').to.have.length(0)
    } finally {
      fStop.abort()
      restStop.abort()
      await Promise.all(runs)
      rendezvous.close()
    }
    expect(commits, 'nothing committed after the stop').to.have.length(0)
  })
})

describe('pool agent: no consent prompt outlives the voting close (review WR-04)', function () {
  this.timeout(60_000)

  it('the former\'s own prompt is cancelled at the close, not at ownDeadline; the run ends deadline and nothing commits', async () => {
    // signTimeoutMs 9.6 s puts the uncapped ownDeadline ~9 s after the form; the close is ~6 s after the
    // start, so a cancel near the close can only come from the close bound.
    const rendezvous = new PoolRendezvous({ coordinatorTtlMs: 5_000, envelopeTtlMs: 20_000, maxPollWaitMs: 100 })
    const [F, M, X] = sortedVoters(['F', 'M', 'X'])
    const stop = new AbortController()
    const commits: string[][] = []
    const events: Record<string, Array<{ e: string, d: any }>> = { F: [], M: [], X: [] }
    let fOutcome: PoolOutcome | undefined
    let cancelAt: number | null = null
    let ownStartAt: number | null = null
    const closeAt = Date.now() + 6_000
    const fQueue = createConsentQueue(async (_digest: string, signal?: AbortSignal) =>
      await new Promise<string>((_resolve, reject) => { signal?.addEventListener('abort', () => reject(new Error('CANCELED'))) }),
    { cancel: async () => { cancelAt ??= Date.now(); await sleep(5) } })
    const runs = [F!, M!, X!].map(async (v) => {
      const outcome = await new PoolAgent({
        quietMs: 300, presentIntervalMs: 40, replyTimeoutMs: 600, informAttempts: 2,
        signTimeoutMs: 9_600, memberTimeoutMs: 2_400, pollWaitMs: 50, formLeadMs: 5_500, ladder: false,
        identity: v.identity,
        rendezvous: createInMemoryRendezvousClient(rendezvous, `t-${v.name}`),
        ballot,
        contribution: v.contribution,
        signConsent: v.name === 'F'
          ? async (d, ctl) => await fQueue.withControl(ctl, d, ctl?.signal)
          : async (d) => signDigestP256(d, v.priv),
        commit: async (_b, sigs) => { commits.push(sigs.map(s => s.registrantId)); return { ok: true } },
        findRecordedVote: async () => null,
        deadlineAt: closeAt,
        log: (e, d) => { if (v.name === 'F' && e === 'own-consent-start') ownStartAt ??= Date.now(); events[v.name]!.push({ e, d }) }
      }).run(stop.signal)
      if (v.name === 'F') fOutcome = outcome
      return outcome
    })
    try {
      expect(await until(() => fOutcome !== undefined, 15_000), 'the former\'s run ended').to.equal(true)
      expect(ownStartAt, 'the own prompt showed').to.not.equal(null)
      expect(ownStartAt!, 'the own prompt showed before the close').to.be.below(closeAt)
      expect(cancelAt, 'the own prompt was cancelled').to.not.equal(null)
      expect(cancelAt! - closeAt, 'cancelled at the close (ms after it)').to.be.within(-50, 1_500)
      expect(cancelAt!, 'well before the uncapped ownDeadline').to.be.below(ownStartAt! + 8_000)
      expect(fOutcome).to.deep.equal({ status: 'stopped', reason: 'deadline' })
      expect(events.F!.some(x => x.e === 'own-consent-timeout'), 'not reported as a timeout that re-pools').to.equal(false)
      expect(commits, 'nothing committed').to.have.length(0)
    } finally {
      stop.abort()
      await Promise.all(runs)
      rendezvous.close()
    }
    expect(commits, 'nothing committed after the close').to.have.length(0)
  })
})

describe('pool agent: a phone that cannot prompt holds no pool (review round 4 CR-01)', function () {
  this.timeout(60_000)

  it('the lowest-id phone in the background is held back: the others form and commit without it, and nobody is prompted for it', async () => {
    const rendezvous = new PoolRendezvous({ coordinatorTtlMs: 5_000, envelopeTtlMs: 20_000, maxPollWaitMs: 100 })
    const [F, M, X, Y] = sortedVoters(['F', 'M', 'X', 'Y'])
    const stop = new AbortController()
    const commits: string[][] = []
    const fEvents: Array<{ e: string, d: any }> = []
    let fPrompts = 0
    const runs = [F!, M!, X!, Y!].map(async (v) => await new PoolAgent({
      quietMs: 300, presentIntervalMs: 40, replyTimeoutMs: 600, informAttempts: 2,
      signTimeoutMs: 4_000, memberTimeoutMs: 2_400, pollWaitMs: 50, formLeadMs: 0, ladder: false,
      identity: v.identity,
      rendezvous: createInMemoryRendezvousClient(rendezvous, `t-${v.name}`),
      ballot,
      contribution: v.contribution,
      signConsent: async (d) => { if (v.name === 'F') fPrompts++; return signDigestP256(d, v.priv) },
      commit: async (_b, sigs) => { commits.push(sigs.map(s => s.registrantId)); return { ok: true } },
      findRecordedVote: async () => null,
      deadlineAt: Date.now() + 50_000,
      ...(v.name === 'F' ? { canPrompt: () => false, log: (e: string, d?: Record<string, unknown>) => { fEvents.push({ e, d }) } } : {})
    }).run(stop.signal))
    try {
      expect(await until(() => commits.length === 1, 20_000), 'the three foreground phones commit').to.equal(true)
      expect(commits[0]!, 'a block of 3').to.have.length(3)
      expect(commits[0]!, 'without the backgrounded phone').to.not.include(F!.contribution.voterEntry.registrantId)
      expect(fEvents.some(x => x.e === 'held-back'), 'the backgrounded phone held back').to.equal(true)
      expect(fEvents.filter(x => x.e === 'held-back'), 'logged once per spell').to.have.length(1)
      expect(fEvents.some(x => x.e === 'forming'), 'it never formed').to.equal(false)
      expect(fPrompts, 'it was never prompted').to.equal(0)
    } finally {
      stop.abort()
      await Promise.all(runs)
      rendezvous.close()
    }
  })

  it('a coordinator holding members releases them when it can no longer prompt, and forms once it can again', async () => {
    const rendezvous = new PoolRendezvous({ coordinatorTtlMs: 5_000, envelopeTtlMs: 20_000, maxPollWaitMs: 100 })
    const [F, M, X] = sortedVoters(['F', 'M', 'X'])
    const stop = new AbortController()
    const commits: string[][] = []
    const memberEvents: Array<{ e: string, d: any }> = []
    let foreground = true
    let holding = false
    const runs = [F!, M!, X!].map(async (v) => await new PoolAgent({
      // a long quiet window: F gathers M and X, then goes to the background before it would form
      quietMs: 4_000, presentIntervalMs: 40, replyTimeoutMs: 600, informAttempts: 2,
      signTimeoutMs: 4_000, memberTimeoutMs: 10_000, pollWaitMs: 50, formLeadMs: 0, ladder: false,
      identity: v.identity,
      rendezvous: createInMemoryRendezvousClient(rendezvous, `t-${v.name}`),
      ballot,
      contribution: v.contribution,
      signConsent: async (d) => signDigestP256(d, v.priv),
      commit: async (_b, sigs) => { commits.push(sigs.map(s => s.registrantId)); return { ok: true } },
      findRecordedVote: async () => null,
      deadlineAt: Date.now() + 50_000,
      ...(v.name === 'F'
        ? { canPrompt: () => foreground, onStatus: (st: any) => { if (st.phase === 'pooling' && st.size === 3) holding = true } }
        : { log: (e: string, d?: Record<string, unknown>) => { memberEvents.push({ e, d }) } })
    }).run(stop.signal))
    try {
      expect(await until(() => holding, 15_000), 'F holds a pool of 3').to.equal(true)
      foreground = false
      expect(await until(() => memberEvents.filter(x => x.e === 'solo' && String(x.d?.why).includes('cannot confirm right now')).length === 2, 5_000), 'both members released with the reason').to.equal(true)
      expect(commits, 'nothing formed while F was in the background').to.have.length(0)
      foreground = true
      expect(await until(() => commits.length === 1, 20_000), 'formed and committed once F was back').to.equal(true)
      expect(commits[0]!, 'a block of 3').to.have.length(3)
    } finally {
      stop.abort()
      await Promise.all(runs)
      rendezvous.close()
    }
  })
})

describe('pool agent: the former\'s own consent is bounded (D-117)', function () {
  this.timeout(90_000)
  const SLOW: Partial<PoolAgentOptions> = {
    quietMs: 300, presentIntervalMs: 40, replyTimeoutMs: 600, informAttempts: 2,
    signTimeoutMs: 9_600, memberTimeoutMs: 2_400, pollWaitMs: 50, formLeadMs: 5_000, ladder: false
  }

  async function trial (ownConsent: 'never' | 'declined') {
    const rendezvous = new PoolRendezvous({ coordinatorTtlMs: 5_000, envelopeTtlMs: 20_000, maxPollWaitMs: 100 })
    const [F, M, X] = sortedVoters(['F', 'M', 'X'])
    const controller = new AbortController()
    const commits: string[][] = []
    const events: Record<string, Array<{ e: string, d: any }>> = { F: [], M: [], X: [] }
    const outcomes: Record<string, PoolOutcome | undefined> = {}
    let fCalls = 0
    let fCancels = 0
    const native = fakeNative(() => 0, () => F!.priv)
    const fQueue = createConsentQueue(async (digest: string, signal?: AbortSignal) => {
      fCalls++
      if (fCalls === 1) {
        if (ownConsent === 'declined') throw new Error('declined')
        return await new Promise<string>((_resolve, reject) => { signal?.addEventListener('abort', () => reject(new Error('CANCELED'))) })
      }
      return await native.prompt(digest, signal)
    }, { cancel: async () => { fCancels++; await sleep(5) } })
    const runs = [F!, M!, X!].map(async (v) => {
      const outcome = await new PoolAgent({
        ...SLOW,
        identity: v.identity,
        rendezvous: createInMemoryRendezvousClient(rendezvous, `t-${v.name}`),
        ballot,
        contribution: v.contribution,
        signConsent: v.name === 'F'
          ? async (d, ctl) => await fQueue.withControl(ctl, d, ctl?.signal)
          : async (d) => signDigestP256(d, v.priv),
        commit: async (_b, sigs) => { commits.push(sigs.map(s => s.registrantId)); return { ok: true } },
        findRecordedVote: async () => null,
        deadlineAt: Date.now() + 80_000,
        log: (e, d) => { events[v.name]!.push({ e, d }); }
      }).run(controller.signal)
      outcomes[v.name] = outcome
      return outcome
    })
    return { rendezvous, controller, commits, events, runs, outcomes, fCancels: () => fCancels }
  }

  it('an unanswered own consent releases the pool with a reason, the former keeps pooling and commits later', async () => {
    const t = await trial('never')
    try {
      expect(await until(() => t.commits.length > 0, 70_000), 'a block committed').to.equal(true)
      const f = t.events.F!
      expect(f.filter(x => x.e === 'own-consent-timeout'), 'former logged the timeout once').to.have.length(1)
      for (const n of ['M', 'X']) {
        expect(t.events[n]!.some(x => x.e === 'solo' && String(x.d?.why).includes('the former did not answer in time')), `${n} reverted with the reason`).to.equal(true)
      }
      expect(f.some(x => x.e === 'done' && x.d?.reason === 'aborted'), 'former never stopped with aborted').to.equal(false)
      expect(t.fCancels(), 'cancel called once on the former queue').to.equal(1)
      expect(t.commits).to.have.length(1)
      expect(t.commits[0]).to.have.length(3)
      expect(t.commits[0]).to.include('reg-F')
    } finally {
      t.controller.abort()
      await Promise.all(t.runs)
      t.rendezvous.close()
    }
  })

  it('control: a plain decline of the former\'s own consent still stops it with aborted and members hear why', async () => {
    const t = await trial('declined')
    try {
      expect(await until(() => t.outcomes.F !== undefined, 40_000), 'former ended').to.equal(true)
      expect(t.outcomes.F).to.deep.equal({ status: 'stopped', reason: 'aborted' })
      expect(await until(() => ['M', 'X'].every(n => t.events[n]!.some(x => x.e === 'solo' && String(x.d?.why).includes('the former declined to sign'))), 10_000)).to.equal(true)
    } finally {
      t.controller.abort()
      await Promise.all(t.runs)
      t.rendezvous.close()
    }
  })
})

describe('pool: three ballots through one slow phone prompt queue (WR-02)', function () {
  this.timeout(120_000)
  const S = 1 / 40
  const ms = (x: number): number => Math.round(x * S)
  const signTimeoutMs = ms(120_000)
  const replyTimeoutMs = ms(5_000)

  it('all three ballots commit, one prompt at a time, none for an abandoned consent, no identity dropped twice', async () => {
    const rendezvous = new PoolRendezvous({ coordinatorTtlMs: ms(30_000), envelopeTtlMs: ms(120_000), maxPollWaitMs: ms(10_000) })
    const ballots = ['b1', 'b2', 'b3'].map(mkBallot)
    const phoneP256 = makeP256TestKey()
    const hostP256 = [makeP256TestKey(), makeP256TestKey()]
    const promptMs = Math.round(0.4 * (signTimeoutMs - replyTimeoutMs))
    const native = fakeNative(() => promptMs, () => phoneP256.privBytes)
    const queue = createConsentQueue(async (digest: string, signal?: AbortSignal) => await native.prompt(digest, signal), { cancel: native.cancel, minPromptMs: ms(POOL_MIN_PROMPT_MS) })
    const controller = new AbortController()
    const t0 = Date.now()
    const trace: string[] = []
    const at = (): string => `${((Date.now() - t0) / S / 1000).toFixed(1).padStart(6)}s`
    const commits: Array<{ ballot: string, registrants: string[] }> = []
    const dropped: string[] = []
    const runs: Array<Promise<unknown>> = []
    for (const b of ballots) {
      const roster: Array<{ v: TV, phone: boolean }> = [
        { v: mk('phone', b, undefined, phoneP256), phone: true },
        { v: mk('hostA', b, undefined, hostP256[0]), phone: false },
        { v: mk('hostB', b, undefined, hostP256[1]), phone: false }
      ]
      for (const { v, phone } of roster) {
        runs.push(new PoolAgent({
          identity: v.identity,
          rendezvous: createInMemoryRendezvousClient(rendezvous, `t-${b.ballotId}-${v.name}`),
          ballot: b,
          contribution: v.contribution,
          signConsent: phone
            ? async (d, ctl) => await queue.withControl(ctl, d, ctl?.signal)
            : async (d) => signDigestP256(d, v.priv),
          commit: async (_block, sigs) => { commits.push({ ballot: b.ballotId, registrants: sigs.map(s => s.registrantId) }); trace.push(`${at()} COMMIT ${b.ballotId}`); return { ok: true } },
          findRecordedVote: async () => null,
          quietMs: ms(20_000),
          presentIntervalMs: ms(1_000),
          replyTimeoutMs,
          signTimeoutMs,
          memberTimeoutMs: ms(60_000),
          pollWaitMs: ms(2_000),
          formLeadMs: ms(60_000),
          ladderMaxMs: ms(15_000),
          deadlineAt: Date.now() + ms(900_000),
          log: (e, d) => {
            if (e === 'form-refused-by') dropped.push(...(d?.members as string[]))
            if (e !== 'ladder-widen') trace.push(`${at()} ${b.ballotId}/${v.name} ${e} ${JSON.stringify(d ?? {})}`)
          }
        }).run(controller.signal))
      }
    }
    const watch = setInterval(() => { if (commits.length >= 3 || Date.now() - t0 > 100_000) controller.abort() }, 20)
    await Promise.all(runs)
    clearInterval(watch)
    rendezvous.close()
    const diag = `${trace.join('\n')}\nprompt starts ${JSON.stringify(native.starts)}\nstats ${JSON.stringify(native.stats())}\ndropped ${JSON.stringify(dropped)}`
    try {
      expect(commits.map(c => c.ballot).sort(), 'one commit per ballot').to.deep.equal(['b1', 'b2', 'b3'])
      for (const c of commits) {
        expect(c.registrants, `${c.ballot} registrants`).to.have.length(3)
        expect(c.registrants).to.include('reg-phone')
      }
      expect(native.stats().maxActive, 'max active prompts').to.equal(1)
      expect(native.starts.filter(s => s.aborted), 'prompt starts with an aborted signal').to.have.length(0)
      expect(new Set(dropped).size, 'no pool identity dropped twice').to.equal(dropped.length)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(diag)
      throw err
    }
  })
})
