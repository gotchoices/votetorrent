// pool-rendezvous.ts — the authority-run meeting point for vote pools (spike 102, user decision:
// "through the rendezvous"). Voters only dial OUT to it; it keeps
//   * per topic, the live pool coordinators and their pool sizes (`present` / `withdraw`), and
//   * per pool identity, a mailbox of sealed envelopes (`send` / `poll`).
// It never sees a message body: envelopes are sealed end to end (pool-envelope.ts). What it does
// see is which pool identities pool together and when — the committed VoteBlockVoter rows publish
// who voted in which block anyway.
//
// Everything is keyed by POOL identity (a throwaway Ed25519 key per pooling run), never by the
// caller's libp2p peer id: `present`, `withdraw` and `poll` are signed with the pool identity's
// key, so only its holder can present as it or drain its mailbox. The transport's authenticated
// peer id is used for one thing only, the optional admission check (cadre membership).
//
// This file is transport-free. `attachPoolRendezvous` / `createLibp2pRendezvousClient`
// (pool-wire.ts) put it on a libp2p node; `createInMemoryRendezvousClient` serves tests.

import {
  POOL_REQUEST_MAX_SKEW_MS,
  signPoolRequest,
  verifyPoolRequest,
  type PoolIdentity,
  type SealedPoolEnvelope
} from './pool-envelope.js'

export interface CoordinatorListing { peerId: string, size: number }

/** A signed request: `as` is the pool identity, `ts` its clock, `sig` over the request's fields. */
export type RendezvousRequest =
  | { t: 'present', topic: string, size: number, as: string, ts: number, sig: string }
  | { t: 'withdraw', topic: string, as: string, ts: number, sig: string }
  | { t: 'send', envelope: SealedPoolEnvelope }
  | { t: 'poll', waitMs: number, as: string, ts: number, sig: string }

export type RendezvousReply =
  | { t: 'coordinators', list: CoordinatorListing[] }
  | { t: 'ok' }
  | { t: 'envelopes', list: SealedPoolEnvelope[] }
  | { t: 'error', reason: string }

/** A transport to one rendezvous: send a request, get its reply (an `error` reply is returned, not thrown). */
export interface PoolRendezvousClient {
  /**
   * Send one request and return its reply. A transport that throws AFTER the request went out sets
   * `requestSent: true` on the error, so a failover never delivers it twice (pool-failover.ts).
   */
  call (request: RendezvousRequest, extraWaitMs?: number): Promise<RendezvousReply>
}

/** The fields each signed request kind signs, in order. */
export function signedFields (r: Exclude<RendezvousRequest, { t: 'send' }>): unknown[] {
  switch (r.t) {
    case 'present': return ['present', r.as, r.ts, r.topic, r.size]
    case 'withdraw': return ['withdraw', r.as, r.ts, r.topic]
    case 'poll': return ['poll', r.as, r.ts, r.waitMs]
  }
}

/** Build the signed requests a pool member sends. */
export const poolRequests = {
  present (identity: PoolIdentity, topic: string, size: number, now: number): RendezvousRequest {
    const r = { t: 'present' as const, topic, size, as: identity.peerId, ts: now, sig: '' }
    return { ...r, sig: signPoolRequest(identity, signedFields(r)) }
  },
  withdraw (identity: PoolIdentity, topic: string, now: number): RendezvousRequest {
    const r = { t: 'withdraw' as const, topic, as: identity.peerId, ts: now, sig: '' }
    return { ...r, sig: signPoolRequest(identity, signedFields(r)) }
  },
  poll (identity: PoolIdentity, waitMs: number, now: number): RendezvousRequest {
    const r = { t: 'poll' as const, waitMs, as: identity.peerId, ts: now, sig: '' }
    return { ...r, sig: signPoolRequest(identity, signedFields(r)) }
  },
  send (envelope: SealedPoolEnvelope): RendezvousRequest {
    return { t: 'send', envelope }
  }
}

export interface PoolRendezvousOptions {
  now?: () => number
  /** a coordinator that has not re-presented for this long is dropped from its topic */
  coordinatorTtlMs?: number
  /** an undelivered envelope is dropped after this long */
  envelopeTtlMs?: number
  /** per-recipient mailbox bound */
  maxQueue?: number
  /** largest accepted envelope, in JSON characters */
  maxEnvelopeChars?: number
  /** longest a poll is held open waiting for mail */
  maxPollWaitMs?: number
  /** optional admission check on the transport's authenticated peer id, e.g. cadre membership */
  isAllowed?: (transportPeerId: string) => boolean | Promise<boolean>
}

const DEFAULTS = {
  coordinatorTtlMs: 30_000,
  envelopeTtlMs: 120_000,
  maxQueue: 256,
  maxEnvelopeChars: 512 * 1024,
  maxPollWaitMs: 10_000
}

interface Queued { envelope: SealedPoolEnvelope, at: number }
interface Waiter { resolve: (list: SealedPoolEnvelope[]) => void, timer: ReturnType<typeof setTimeout> }

export class PoolRendezvous {
  private readonly topics = new Map<string, Map<string, { size: number, at: number }>>()
  private readonly mailboxes = new Map<string, Queued[]>()
  private readonly waiters = new Map<string, Waiter>()
  private readonly opts: Required<Omit<PoolRendezvousOptions, 'isAllowed'>> & Pick<PoolRendezvousOptions, 'isAllowed'>
  /** counters for observability (no message content is ever recorded) */
  readonly stats = { present: 0, withdraw: 0, send: 0, poll: 0, refused: 0, badSignature: 0, dropped: 0 }

  constructor (options: PoolRendezvousOptions = {}) {
    this.opts = { ...DEFAULTS, now: () => Date.now(), ...options }
  }

  /** Serve one request arriving from the transport peer `transportPeerId`. Never throws. */
  async handle (transportPeerId: string, request: RendezvousRequest): Promise<RendezvousReply> {
    try {
      if (this.opts.isAllowed !== undefined && !(await this.opts.isAllowed(transportPeerId))) {
        this.stats.refused++
        return { t: 'error', reason: 'not allowed' }
      }
      if (request?.t === 'send') return this.send(request.envelope)
      if (request?.t !== 'present' && request?.t !== 'withdraw' && request?.t !== 'poll') return { t: 'error', reason: 'unknown request' }
      if (typeof request.as !== 'string' || typeof request.ts !== 'number' ||
        Math.abs(this.opts.now() - request.ts) > POOL_REQUEST_MAX_SKEW_MS ||
        !verifyPoolRequest(request.as, signedFields(request), request.sig)) {
        this.stats.badSignature++
        return { t: 'error', reason: 'bad signature' }
      }
      switch (request.t) {
        case 'present': return this.present(request.as, request.topic, request.size)
        case 'withdraw': return this.withdraw(request.as, request.topic)
        case 'poll': return await this.poll(request.as, request.waitMs)
      }
    } catch {
      return { t: 'error', reason: 'request failed' }
    }
  }

  /** Release every held poll (call on shutdown). */
  close (): void {
    for (const [, w] of this.waiters) { clearTimeout(w.timer); w.resolve([]) }
    this.waiters.clear()
  }

  private present (as: string, topic: string, size: number): RendezvousReply {
    if (typeof topic !== 'string' || topic.length === 0 || topic.length > 512 || !Number.isInteger(size) || size < 1) {
      return { t: 'error', reason: 'bad present' }
    }
    this.stats.present++
    const now = this.opts.now()
    const table = this.topics.get(topic) ?? new Map<string, { size: number, at: number }>()
    this.topics.set(topic, table)
    table.set(as, { size, at: now })
    const list: CoordinatorListing[] = []
    for (const [peerId, entry] of table) {
      if (now - entry.at > this.opts.coordinatorTtlMs) { table.delete(peerId); continue }
      if (peerId !== as) list.push({ peerId, size: entry.size })
    }
    return { t: 'coordinators', list }
  }

  private withdraw (as: string, topic: string): RendezvousReply {
    this.stats.withdraw++
    const table = this.topics.get(topic)
    table?.delete(as)
    if (table !== undefined && table.size === 0) this.topics.delete(topic)
    return { t: 'ok' }
  }

  private send (envelope: SealedPoolEnvelope): RendezvousReply {
    if (envelope === null || typeof envelope !== 'object' || envelope.v !== 1 || typeof envelope.to !== 'string' || envelope.to.length === 0) {
      return { t: 'error', reason: 'bad envelope' }
    }
    if (JSON.stringify(envelope).length > this.opts.maxEnvelopeChars) return { t: 'error', reason: 'envelope too large' }
    this.stats.send++
    const waiter = this.waiters.get(envelope.to)
    if (waiter !== undefined) {
      this.waiters.delete(envelope.to)
      clearTimeout(waiter.timer)
      waiter.resolve([envelope])
      return { t: 'ok' }
    }
    const now = this.opts.now()
    const queue = (this.mailboxes.get(envelope.to) ?? []).filter(q => now - q.at <= this.opts.envelopeTtlMs)
    if (queue.length >= this.opts.maxQueue) {
      this.stats.dropped++
      return { t: 'error', reason: 'mailbox full' }
    }
    queue.push({ envelope, at: now })
    this.mailboxes.set(envelope.to, queue)
    return { t: 'ok' }
  }

  private async poll (as: string, waitMs: number): Promise<RendezvousReply> {
    this.stats.poll++
    const now = this.opts.now()
    const queue = (this.mailboxes.get(as) ?? []).filter(q => now - q.at <= this.opts.envelopeTtlMs)
    this.mailboxes.delete(as)
    if (queue.length > 0 || !(waitMs > 0)) return { t: 'envelopes', list: queue.map(q => q.envelope) }
    // Hold the poll open until mail arrives (send() hands it straight over) or the wait ends.
    // One held poll per pool identity: a newer one releases the older empty.
    const previous = this.waiters.get(as)
    if (previous !== undefined) { clearTimeout(previous.timer); previous.resolve([]) }
    const list = await new Promise<SealedPoolEnvelope[]>((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiters.get(as)?.timer === timer) this.waiters.delete(as)
        resolve([])
      }, Math.min(waitMs, this.opts.maxPollWaitMs))
      this.waiters.set(as, { resolve, timer })
    })
    return { t: 'envelopes', list }
  }
}

/**
 * A client bound to one in-process rendezvous, for tests and single-process harnesses.
 * `transportPeerId` stands in for the libp2p peer id the real transport would authenticate.
 */
export function createInMemoryRendezvousClient (rendezvous: PoolRendezvous, transportPeerId: string): PoolRendezvousClient {
  return { call: async (request) => await rendezvous.handle(transportPeerId, request) }
}
