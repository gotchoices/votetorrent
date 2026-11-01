// pool-agent.ts — one voter's side of doc/election.md "Pool Merging" (present / merge / inform /
// form), as built and measured in spike 102, with the decisions taken after it:
//
//   * Votes are encrypted to the election key BEFORE they join a pool (user decision): the voter
//     who forms a block holds ciphertexts only. It still learns which member handed it which
//     ciphertext, so it can read the link once the key is released — accepted.
//   * Every message goes through the authority's rendezvous as a sealed envelope (user decision):
//     voters only dial out, so a voter that nobody can dial still pools. The rendezvous reads no
//     body (pool-envelope.ts).
//   * A block never forms below `minSize` (user decision: 3). A pool still too small keeps
//     presenting and merging; the vote stays on the phone, not sent, until a pool forms or voting
//     closes (`deadlineAt`).
//   * "No ack" is not "drop" on the first miss (spike 102 finding 4): an inform is retried
//     `informAttempts` times before the member is dropped from the pool.
//   * A member signs only after checkFormedPoolBlock passes; one refusal or silence drops that
//     member and the rest carry on (the doc reverts the whole merge; spike 102's deviation kept).
//   * A member the commit names as already voted is dropped and the rest re-form (or keep
//     presenting below the minimum); it is not a whole-pool revert to solo.
//   * An `already-voted` outcome from a coordinator is a HINT, never a verdict (CR-01): the member
//     waits a bounded time for its own strand read to show the row. A recorded cid means sent;
//     otherwise it refuses that coordinator from now on and keeps pooling alone.
//   * A member re-parents only to its current coordinator, or to the one that coordinator handed
//     it over to (`handover`, sent when the coordinator itself merges away). Knowing a member's
//     vote ciphertext (every co-member of a formation sees it) is not enough.
//   * Discovery goes through a `PoolDiscovery` (the Authority rendezvous by default). A coordinator
//     climbs from a 2-bit and a 1-bit pool-hash bucket topic to the plain topic, per doc/election.md
//     "Pool Merging". That is client-side only: the server keys opaque topics. The plain topic is
//     reached within min(15 s, quietMs) and before the deadline's form lead, and a pool forms on the
//     quiet rule only after one quiet window on the plain topic. The parameters are ASSUMED (D-23).
//   * Pools order strictly by (size desc, peer id asc), so two coordinators never merge into each
//     other at once.
//   * D-90: a member that signed stays a member until the former's sign window ends; it never
//     reverts to solo in the middle of a long sign wait.
//   * D-91: a drop at formation or commit re-confirms the survivors by request; a survivor that
//     refuses or stays silent is dropped too, so the former never keeps a stale entry.
//   * D-92: a merge refused as "a voter is already in this pool" starts one re-confirm, after which
//     the same sender's next merge is accepted.
//   * D-93: after 3 consecutive refusals from the best target, a coordinator tries the next-best
//     target that is still strictly better than its own pool.
//   * D-94: a member waits for its own consent at most signTimeoutMs - replyTimeoutMs after the
//     form arrives, so it answers (refuses) before the former gives up on it.
//   * D-95: two drops at formation exclude the pool identity (peer id) only; the registrant id is
//     excluded only for an invalid signature or a commit duplicate.
//   * D-114: a consent that is abandoned (the D-94 bound, or the agent stopping) is aborted through the
//     `ConsentCallControl` handed to `signConsent`; the consent queue then cancels the prompt on
//     screen before it starts the next one. The engine stays platform-free: the cancel is injected.
//   * D-115: a consent's deadline is the former's reply deadline (`signTimeoutMs - replyTimeoutMs`),
//     counted from the LOCAL arrival of the form, never from a message field. The queue serves
//     deadlines earliest first and refuses a prompt with too little window left.
//   * D-116: a member whose consent timed out aborts it and clears it, so a re-form of the same block
//     raises exactly one new prompt; a still-live consent for the same coordinator and digest is reused.
//   * D-117: the former's own consent has the same deadline and abort. Unanswered is not declined:
//     the pool is released with the reason 'the former did not answer in time' and the former keeps
//     pooling; only an explicit decline stops it ('aborted').
//   * WR-01 (round 2): the run's stop signal is bound to every live consent. Stopping the agent while
//     the former's own prompt (or a member's prompt) is showing aborts that consent at once, so the
//     queue cancels the prompt; a former stopped mid-formation releases the pool with 'aborted' and
//     never commits, even when every signature is already in hand.
//   * IN-03: a re-sent form for a consent that is still queued (its prompt not yet shown) moves that
//     consent's deadline to the new form's reply deadline. A consent whose prompt is already showing
//     keeps its first deadline: the queue fixed it when the prompt started, and answering (or
//     refusing) early is safe, since the former waits at least that long.
//
// The agent owns no database and no device key: `signConsent` (the device key, a biometric prompt
// on Android) and `commit` (one transaction, pool-block.ts `commitPoolBlock`) are handed in.

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { verifySigP256 } from '../database/initialize.js'
import { isConsentAbandonedError, type ConsentCallControl } from './consent-queue.js'
import { openPoolEnvelope, sealPoolEnvelope, ed25519PublicKeyFromPeerId, type PoolIdentity } from './pool-envelope.js'
import { poolRequests, type PoolRendezvousClient, type CoordinatorListing, type RendezvousReply } from './pool-rendezvous.js'
import {
  checkFormedPoolBlock,
  consentDigest,
  formPoolBlock,
  poolTopic,
  type ConsentSignature,
  type FormedPoolBlock,
  type PoolBallot,
  type PoolCommitResult,
  type PoolContribution
} from './pool-block.js'
import {
  rendezvousDiscovery,
  ladderTopic,
  POOL_LADDER_RUNG_BITS,
  POOL_LADDER_DWELL_PRESENTS,
  POOL_LADDER_MAX_MS,
  type PoolDiscovery
} from './pool-discovery.js'

export const POOL_MIN_BLOCK_SIZE = 3
/** how long a former waits for a member's signature (covers a biometric prompt) */
export const POOL_SIGN_TIMEOUT_MS = 120_000
/** consecutive refusals from one merge target before the next-best target is tried (D-93) */
const MERGE_REFUSALS_BEFORE_FALLBACK = 3

export interface PoolAgentOptions {
  identity: PoolIdentity
  rendezvous: PoolRendezvousClient
  ballot: PoolBallot
  /** this voter's sealed vote and signed voter entry; `member` must be `identity.peerId` */
  contribution: PoolContribution
  /**
   * Sign a consent digest with the voting key (Association.DeviceKey); returns compact low-S hex. The
   * optional `ctl` carries an abort signal, the local deadline and an onStart hook, so a consent queue
   * can cancel an unanswered prompt (D-114); a one-argument implementation may ignore it.
   */
  signConsent: (digest: string, ctl?: ConsentCallControl) => Promise<string>
  /** write the block and its voter rows in one transaction */
  commit: (block: FormedPoolBlock, signatures: ConsentSignature[]) => Promise<PoolCommitResult>
  /**
   * The cid of the block this voter's vote is already recorded in (its replicated VoteBlockVoter
   * row), or null. Checked before pooling and again whenever this voter has signed a block, so a
   * vote whose `committed` outcome was lost is never pooled twice.
   */
  findRecordedVote?: () => Promise<string | null>
  /** smallest block this agent will form (never below POOL_MIN_BLOCK_SIZE) */
  minSize?: number
  /** a pool this big forms at once */
  capacity?: number
  /** a pool at or above minSize forms after this long without growing */
  quietMs?: number
  /** how often a coordinator re-presents and looks for a bigger pool */
  presentIntervalMs?: number
  /** wait for one reply (merged / ack) */
  replyTimeoutMs?: number
  /** inform attempts before a member counts as silent */
  informAttempts?: number
  /** wait for a member's signature (covers a biometric prompt) */
  signTimeoutMs?: number
  /** a member that hears nothing from its coordinator for this long goes back to pooling alone */
  memberTimeoutMs?: number
  /** held-poll length at the rendezvous */
  pollWaitMs?: number
  /** voting closes: stop (vote unsent) at this time; a pool at minSize forms `formLeadMs` before */
  deadlineAt?: number
  formLeadMs?: number
  /** how this coordinator finds others; default `rendezvousDiscovery(rendezvous, identity)`. `rendezvous` still carries the mailbox. */
  discovery?: PoolDiscovery
  /** the specific-then-general topic ladder (doc/election.md "Pool Merging"); default true. false presents only on the plain topic. */
  ladder?: boolean
  /** successful presents per rung before widening is considered (default POOL_LADDER_DWELL_PRESENTS) */
  rungDwellTicks?: number
  /** the plain topic is reached at most this long after run() starts (default min(POOL_LADDER_MAX_MS, quietMs), clamped to POOL_LADDER_MAX_MS) */
  ladderMaxMs?: number
  now?: () => number
  log?: (event: string, detail?: Record<string, unknown>) => void
  onStatus?: (status: PoolAgentStatus) => void
}

export type PoolAgentStatus =
  | { phase: 'pooling', size: number }
  | { phase: 'member', coordinator: string, size: number }
  | { phase: 'signing' }
  | { phase: 'committing', size: number }
  | { phase: 'done', outcome: PoolOutcome }

export type PoolOutcome =
  | { status: 'committed', cid: string, blockId: string, size: number, formedByMe: boolean }
  | { status: 'stopped', reason: 'deadline' | 'aborted' | 'already-voted' }

type PoolMessage =
  | { t: 'merge', id: string, topic: string, contributions: PoolContribution[] }
  | { t: 'merged', re: string, size: number }
  | { t: 'refuse', re: string, reason: string }
  | { t: 'inform', id: string, topic: string, size: number, hold: string, dropped?: string[] }
  | { t: 'ack', re: string }
  | { t: 'form', id: string, topic: string, block: FormedPoolBlock }
  | { t: 'sign', re: string, signature: ConsentSignature }
  | { t: 'outcome', topic: string, committed: boolean, cid?: string, reason?: string, code?: 'already-voted' }
  /** the sender (this member's coordinator) merged into `to`: accept `to`'s inform from now on */
  | { t: 'handover', topic: string, to: string }

/** A member's consent for one coordinator's block, shared by re-sent forms of that block (D-116). */
interface MemberConsent {
  from: string
  digest: string
  signature: Promise<string>
  controller: AbortController
  /** the control handed to signConsent; a queue reads `deadlineAt` from it until the prompt starts (IN-03) */
  ctl: ConsentCallControl & { deadlineAt: number }
  /** started: the prompt is on screen (onStart fired); waiters: form handlers waiting on it now */
  state: { started: boolean, waiters: number }
}

const holdOf = (voteCiphertext: string): string => bytesToHex(sha256(utf8ToBytes(voteCiphertext)))
const better = (a: { size: number, peerId: string }, b: { size: number, peerId: string }): boolean =>
  a.size > b.size || (a.size === b.size && a.peerId < b.peerId)

function isContribution (c: unknown): c is PoolContribution {
  const x = c as PoolContribution
  if (x === null || typeof x !== 'object' || typeof x.member !== 'string' || typeof x.voteCiphertext !== 'string') return false
  if (x.voterEntry === null || typeof x.voterEntry !== 'object' || typeof x.voterEntry.registrantId !== 'string' || typeof x.voterEntry.deviceKey !== 'string') return false
  try { ed25519PublicKeyFromPeerId(x.member) } catch { return false }
  return true
}

export class PoolAgent {
  private readonly o: Required<Omit<PoolAgentOptions, 'deadlineAt' | 'log' | 'onStatus' | 'discovery'>> & Pick<PoolAgentOptions, 'deadlineAt' | 'log' | 'onStatus' | 'discovery'>
  private readonly me: string
  private readonly topic: string
  private readonly myHold: string
  private readonly discovery: PoolDiscovery
  /** index into POOL_LADDER_RUNG_BITS; POOL_LADDER_RUNG_BITS.length means the plain topic. Only ever grows. */
  private rungIndex = 0
  private rungPresents = 0
  private runStartedAt: number
  /** when this pool first became visible on the plain topic; null until then (always set with the ladder off) */
  private plainAt: number | null
  private readonly presentedTopics = new Set<string>()
  private lastPresentTopic: string | null = null
  private role: 'coordinator' | 'member' | 'done' = 'coordinator'
  private pool: PoolContribution[]
  private coordinator: string | null = null
  private busy = false
  private pendingInforms = 0
  private lastGrowthAt: number
  private lastHeardAt = 0
  private lastMergeAttempt: { target: string, at: number, size: number } | null = null
  /** consecutive `refuse` replies per merge target; cleared by any `merged` reply (D-93) */
  private readonly mergeRefusals = new Map<string, number>()
  private signedCid: string | null = null
  private everSigned = false
  /** members (peer id and registrant id) this coordinator refuses from now on: an invalid signature, or dropped at formation twice */
  private readonly excluded = new Set<string>()
  private readonly formationDrops = new Map<string, number>()
  /** members that acknowledged an inform since they joined this pool: only a fully confirmed pool forms */
  private readonly confirmed = new Set<string>()
  private outcome: PoolOutcome | null = null
  private stopped = false
  private seq = 0
  private readonly pending = new Map<string, { from: string, resolve: (m: PoolMessage | null) => void, timer: ReturnType<typeof setTimeout> }>()
  /** the coordinator this member's current coordinator handed it over to, if any */
  private handover: { from: string, to: string } | null = null
  private readonly handoverWaiters = new Set<() => void>()
  /** an `already-voted` claim is being checked against the strand */
  private checkingClaim = false
  /** the consent given (or being given) for the last form: one prompt per coordinator and block */
  private consent: MemberConsent | null = null
  /** the signal handed to run(): every live consent is aborted when it aborts (WR-01) */
  private runSignal: AbortSignal | undefined
  /** observability: message counts by type, sent and received */
  readonly counts: Record<string, number> = {}

  constructor (options: PoolAgentOptions) {
    if (options.contribution.member !== options.identity.peerId) throw new Error('PoolAgent: the contribution must name this agent\'s peer id')
    // Defaults per field with `??`, AFTER the spread (IN-01): an explicit `undefined` takes the
    // default, and nothing in `options` can lower minSize below POOL_MIN_BLOCK_SIZE.
    const quietMs = options.quietMs ?? 20_000
    const dwell = options.rungDwellTicks ?? POOL_LADDER_DWELL_PRESENTS
    this.o = {
      ...options,
      minSize: Math.max(POOL_MIN_BLOCK_SIZE, options.minSize ?? POOL_MIN_BLOCK_SIZE),
      capacity: options.capacity ?? 16,
      quietMs,
      presentIntervalMs: options.presentIntervalMs ?? 1_000,
      replyTimeoutMs: options.replyTimeoutMs ?? 5_000,
      informAttempts: options.informAttempts ?? 3,
      signTimeoutMs: options.signTimeoutMs ?? POOL_SIGN_TIMEOUT_MS,
      memberTimeoutMs: options.memberTimeoutMs ?? 60_000,
      pollWaitMs: options.pollWaitMs ?? 2_000,
      formLeadMs: options.formLeadMs ?? 60_000,
      now: options.now ?? (() => Date.now()),
      ladder: options.ladder ?? true,
      rungDwellTicks: Number.isFinite(dwell) ? Math.max(1, Math.floor(dwell)) : POOL_LADDER_DWELL_PRESENTS,
      ladderMaxMs: Math.min(POOL_LADDER_MAX_MS, options.ladderMaxMs ?? quietMs)
    } as PoolAgent['o']
    this.discovery = options.discovery ?? rendezvousDiscovery(options.rendezvous, options.identity)
    if (this.o.capacity < this.o.minSize) this.o.capacity = this.o.minSize
    this.me = options.identity.peerId
    this.topic = poolTopic(options.ballot)
    this.myHold = holdOf(options.contribution.voteCiphertext)
    this.pool = [options.contribution]
    this.lastGrowthAt = this.o.now()
    this.runStartedAt = this.lastGrowthAt
    if (!this.o.ladder) this.rungIndex = POOL_LADDER_RUNG_BITS.length
    this.plainAt = this.o.ladder ? null : this.lastGrowthAt
  }

  /** Pool until this vote is in a committed block, voting closes, or `signal` aborts. */
  async run (signal?: AbortSignal): Promise<PoolOutcome> {
    this.runStartedAt = this.o.now()
    this.runSignal = signal
    const polling = this.pollLoop()
    try {
      this.status()
      while (this.outcome === null) {
        if (signal?.aborted === true) { await this.abandon('aborted'); break }
        if (this.o.deadlineAt !== undefined && this.o.now() >= this.o.deadlineAt) { await this.abandon('deadline'); break }
        try {
          await this.tick()
        } catch (err) {
          this.log('tick-error', { message: err instanceof Error ? err.message : String(err) })
        }
        if (this.outcome !== null) break
        await sleep(this.o.presentIntervalMs * (0.75 + Math.random() * 0.5))
      }
    } finally {
      this.stopped = true
      // D-114: no orphan prompt once the agent stops (a settled consent is unaffected). This catches a
      // member's consent when the run ends without its signal aborting (the voting deadline: a
      // member's tick returns at once). The former's own consent needs no line here: form() is
      // always awaited before this point, and it binds that consent to the run signal and to the
      // voting close itself (WR-01, review WR-04).
      this.consent?.controller.abort()
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.resolve(null) }
      this.pending.clear()
      for (const wake of [...this.handoverWaiters]) wake()
      await this.withdraw()
      await polling
    }
    return this.outcome!
  }

  // -------------------------------------------------------------------------------------------
  // the loop

  private async tick (): Promise<void> {
    if ((this.everSigned || this.seq === 0) && this.o.findRecordedVote !== undefined && this.role !== 'done') {
      const recorded = await this.o.findRecordedVote().catch(() => null)
      if (recorded !== null) {
        this.finish({ status: 'committed', cid: recorded, blockId: '', size: 0, formedByMe: false })
        return
      }
    }
    if (this.role === 'member') {
      if (this.o.now() - this.lastHeardAt > this.o.memberTimeoutMs) this.revertToSolo('coordinator went silent')
      return
    }
    if (this.role !== 'coordinator' || this.busy) return
    if (this.shouldForm()) { await this.form(); return }
    let list: CoordinatorListing[]
    const presentAt = this.o.now()
    if (!this.onPlain() && (presentAt - this.runStartedAt >= this.o.ladderMaxMs ||
      (this.o.deadlineAt !== undefined && presentAt >= this.o.deadlineAt - 2 * this.o.formLeadMs))) {
      const why = presentAt - this.runStartedAt >= this.o.ladderMaxMs ? 'cap' : 'deadline'
      this.rungIndex = POOL_LADDER_RUNG_BITS.length
      this.rungPresents = 0
      this.log('ladder-widen', { to: 'plain', why })
    }
    const topic = this.presentTopic()
    if (this.lastPresentTopic !== null && this.lastPresentTopic !== topic) {
      const old = this.lastPresentTopic
      this.presentedTopics.delete(old)
      void this.discovery.withdraw(old, presentAt).catch(() => undefined)
    }
    try {
      // Record the topic before the call: a present that fails after reaching the server must still be withdrawn.
      this.presentedTopics.add(topic)
      this.lastPresentTopic = topic
      list = await this.discovery.present(topic, this.pool.length, presentAt)
      this.count('present')
      // This agent became a member while the present was on its way (IN-06): the withdraw that
      // becomeMemberOf sent may have reached the rendezvous first, leaving it listed. Withdraw again.
      if (this.role !== 'coordinator') {
        void this.discovery.withdraw(topic, this.o.now()).catch(() => undefined)
        return
      }
      if (this.onPlain()) {
        if (this.plainAt === null) this.plainAt = this.o.now()
      } else {
        this.rungPresents++
        const seen = list.reduce((n, c) => n + c.size, 0) + this.pool.length
        if (this.rungPresents >= this.o.rungDwellTicks && seen < this.o.minSize) {
          this.rungIndex++
          this.rungPresents = 0
          this.log('ladder-widen', { to: this.onPlain() ? 'plain' : POOL_LADDER_RUNG_BITS[this.rungIndex], why: 'few' })
        }
      }
    } catch (err) {
      this.log('present-failed', { message: err instanceof Error ? err.message : String(err) })
      return
    }
    if (this.role !== 'coordinator' || this.busy) return
    const mine = { size: this.pool.length, peerId: this.me }
    const candidates = list
      .filter(c => !this.excluded.has(c.peerId) && better(c, mine) && c.size + this.pool.length <= this.o.capacity)
      .sort((a, b) => (better(a, b) ? -1 : 1))
    // D-93: a best target that keeps refusing is skipped for the next-best one that is still strictly better.
    const best = candidates.find(c => (this.mergeRefusals.get(c.peerId) ?? 0) < MERGE_REFUSALS_BEFORE_FALLBACK) ?? candidates[0]
    if (best !== undefined) await this.mergeInto(best.peerId)
  }

  private onPlain (): boolean {
    return this.rungIndex >= POOL_LADDER_RUNG_BITS.length
  }

  /**
   * The topic to present on. A rung topic is for present/withdraw ONLY: protocol messages carry the
   * plain poolTopic, or a cross-rung merge would be refused as "not pooling this ballot".
   */
  private presentTopic (): string {
    if (this.onPlain()) return this.topic
    return ladderTopic(this.topic, POOL_LADDER_RUNG_BITS[this.rungIndex]!, this.pool.map(c => holdOf(c.voteCiphertext)))
  }

  private shouldForm (): boolean {
    if (this.pool.length < this.o.minSize || this.pendingInforms > 0) return false
    // doc/election.md: inform, ack, then form. A member merged a moment ago has not heard from this
    // coordinator yet and would refuse the form as "not my coordinator" (measured, run product-2).
    if (!this.pool.every(c => c.member === this.me || this.confirmed.has(c.member))) return false
    const now = this.o.now()
    // The quiet rule also needs one full quiet window on the PLAIN topic: otherwise a trio sharing a
    // bucket forms on its rung while voters in other buckets are still waiting on plain.
    return this.pool.length >= this.o.capacity ||
      (this.plainAt !== null && now - Math.max(this.lastGrowthAt, this.plainAt) >= this.o.quietMs) ||
      (this.o.deadlineAt !== undefined && now >= this.o.deadlineAt - this.o.formLeadMs)
  }

  private async mergeInto (target: string): Promise<void> {
    this.busy = true
    this.lastMergeAttempt = { target, at: this.o.now(), size: this.pool.length }
    try {
      const reply = await this.request(target, { t: 'merge', id: this.nextId(), topic: this.topic, contributions: this.pool }, this.o.replyTimeoutMs)
      if (reply?.t === 'refuse') this.mergeRefusals.set(target, (this.mergeRefusals.get(target) ?? 0) + 1)
      if (reply?.t === 'merged') this.mergeRefusals.clear()
      if (reply?.t === 'merged' && this.role === 'coordinator') this.becomeMemberOf(target)
    } finally {
      this.busy = false
    }
  }

  private becomeMemberOf (coordinator: string): void {
    // The members of the pool given away learn who holds them now; nobody else can re-parent them.
    const handed = this.pool.filter(c => c.member !== this.me)
    this.confirmed.clear()
    this.role = 'member'
    this.coordinator = coordinator
    this.handover = null
    this.pool = []
    for (const c of handed) void this.post(c.member, { t: 'handover', topic: this.topic, to: coordinator })
    this.lastHeardAt = this.o.now()
    void this.withdraw()
    this.log('member-of', { coordinator: coordinator.slice(-6) })
    this.status()
  }

  /**
   * A member's live consent belongs to the pool it was asked for. When that pool is gone (the former
   * released it, this voter went solo, or it was handed to another former) the consent is aborted so
   * the queue cancels a prompt that is still showing, instead of leaving it up until its bound.
   * A consent that already settled is unaffected (aborting it is a no-op in the queue).
   */
  private releaseMemberConsent (why: string): void {
    const c = this.consent
    if (c === null) return
    this.consent = null
    if (!c.controller.signal.aborted) {
      this.log('consent-released', { why, started: c.state.started })
      c.controller.abort()
    }
  }

  private revertToSolo (why: string): void {
    this.releaseMemberConsent(why)
    this.confirmed.clear()
    this.role = 'coordinator'
    this.coordinator = null
    this.handover = null
    this.pool = [this.o.contribution]
    this.lastGrowthAt = this.o.now()
    this.busy = false
    this.signedCid = null
    this.log('solo', { why })
    this.status()
  }

  private async informAll (): Promise<void> {
    this.pendingInforms++
    try {
      const others = this.pool.filter(c => c.member !== this.me)
      const acked = await Promise.all(others.map(async (c) => {
        for (let attempt = 0; attempt < this.o.informAttempts; attempt++) {
          if (this.stopped) return false
          const reply = await this.request(c.member, { t: 'inform', id: this.nextId(), topic: this.topic, size: this.pool.length, hold: holdOf(c.voteCiphertext) }, this.o.replyTimeoutMs)
          if (reply?.t === 'ack') { this.confirmed.add(c.member); return true }
          if (reply?.t === 'refuse') return false
        }
        return false
      }))
      const silent = others.filter((_, i) => !acked[i]).map(c => c.member)
      if (silent.length > 0 && this.role === 'coordinator') {
        // Revert: drop every member that did not acknowledge, then tell the rest who was dropped.
        this.pool = this.pool.filter(c => !silent.includes(c.member))
        for (const m of silent) this.confirmed.delete(m)
        this.log('dropped', { members: silent.map(s => s.slice(-6)), size: this.pool.length })
        for (const c of this.pool) {
          if (c.member === this.me) continue
          void this.post(c.member, { t: 'inform', id: this.nextId(), topic: this.topic, size: this.pool.length, hold: holdOf(c.voteCiphertext), dropped: silent })
        }
        for (const s of silent) void this.post(s, { t: 'inform', id: this.nextId(), topic: this.topic, size: this.pool.length, hold: '', dropped: [s] })
        this.status()
      }
    } finally {
      this.pendingInforms--
    }
  }

  private async form (): Promise<void> {
    this.busy = true
    try {
      let block: FormedPoolBlock
      try {
        block = formPoolBlock(this.pool, this.o.ballot)
      } catch (err) {
        this.log('form-refused', { message: err instanceof Error ? err.message : String(err) })
        this.revertToSolo('pool could not form a block')
        return
      }
      this.log('forming', { size: this.pool.length, cid: block.cid.slice(-8) })
      this.o.onStatus?.({ phase: 'signing' })
      const others = this.pool.filter(c => c.member !== this.me)
      const mine = this.o.contribution
      // D-117: the former's own consent has the same deadline as a member's, and an abort.
      const formAt = this.o.now()
      // A confirmation the voter gives after the voting close can never land (the schema refuses the
      // commit), so no consent deadline outlives the close.
      const closeAt = this.o.deadlineAt ?? Infinity
      const ownDeadline = Math.min(formAt + this.o.signTimeoutMs - this.o.replyTimeoutMs, closeAt)
      const ownController = new AbortController()
      // WR-01: stopping the run aborts the own consent at once (the queue cancels the prompt) and
      // stops waiting for the members; the pool is then released with 'aborted' below, never committed.
      // The voting close does the same and ends the run with 'deadline'.
      let unbindStop = (): void => {}
      let closeTimer: ReturnType<typeof setTimeout> | undefined
      let closed = false
      const runStopped = new Promise<'stopped'>((resolve) => {
        unbindStop = this.onRunStop(() => { ownController.abort(); resolve('stopped') })
        if (Number.isFinite(closeAt)) {
          closeTimer = setTimeout(() => { closed = true; ownController.abort(); resolve('stopped') }, Math.max(0, closeAt - this.o.now()))
        }
      })
      let ownTimer: ReturnType<typeof setTimeout> | undefined
      const ownDigest = consentDigest(block, this.o.ballot, mine.voterEntry.registrantId, mine.voterEntry.deviceKey)
      const own = async (): Promise<{ kind: 'sig', signature: string } | { kind: 'abandoned' } | { kind: 'declined' }> => {
        const bound = new Promise<{ kind: 'abandoned' }>((resolve) => {
          ownTimer = setTimeout(() => { ownController.abort(); resolve({ kind: 'abandoned' }) }, Math.max(0, ownDeadline - this.o.now()))
        })
        const answer = (async () => {
          try {
            const signature = await this.o.signConsent(ownDigest, { signal: ownController.signal, deadlineAt: ownDeadline, onStart: () => this.log('own-consent-start', { digest: ownDigest.slice(0, 8) }) })
            return { kind: 'sig' as const, signature }
          } catch (err) {
            return isConsentAbandonedError(err) ? { kind: 'abandoned' as const } : { kind: 'declined' as const }
          }
        })()
        try {
          return await Promise.race([answer, bound, runStopped.then(() => ({ kind: 'abandoned' as const }))])
        } finally {
          if (ownTimer !== undefined) clearTimeout(ownTimer)
        }
      }
      let ownResult: Awaited<ReturnType<typeof own>>
      let replies: Array<PoolMessage | null>
      try {
        [ownResult, ...replies] = await Promise.all([
          own(),
          ...others.map(async c => await Promise.race([
            this.request(c.member, { t: 'form', id: this.nextId(), topic: this.topic, block }, this.o.signTimeoutMs),
            runStopped.then(() => null)
          ]))
        ])
      } finally {
        unbindStop()
        if (closeTimer !== undefined) clearTimeout(closeTimer)
      }
      if (closed && this.runSignal?.aborted !== true) {
        this.log('form-closed', { waitedMs: this.o.now() - formAt })
        await this.abandon('deadline')
        return
      }
      if (this.runSignal?.aborted === true) {
        // WR-01: the agent was stopped while this block was being signed. Release the pool; an answer
        // that came in anyway (own or members') must not commit a send the voter left.
        this.log('form-stopped', { waitedMs: this.o.now() - formAt })
        await this.abandon('aborted')
        return
      }
      if (ownResult.kind === 'abandoned') {
        // Unanswered is not declined (D-117): release the pool with the reason and keep pooling.
        for (const c of others) void this.post(c.member, { t: 'outcome', topic: this.topic, committed: false, reason: 'the former did not answer in time' })
        this.log('own-consent-timeout', { waitedMs: this.o.now() - formAt })
        this.revertToSolo('the former did not answer in time')
        return
      }
      if (ownResult.kind === 'declined') {
        // This voter declined its own consent: release the pool rather than hold it hostage.
        for (const c of others) void this.post(c.member, { t: 'outcome', topic: this.topic, committed: false, reason: 'the former declined to sign' })
        await this.abandon('aborted')
        return
      }
      const ownSignature = ownResult.signature
      // A signature that the schema's SignatureValid CHECK would refuse fails the whole commit, so
      // check each one here and drop only its signer.
      const signedOk = (c: PoolContribution, r: PoolMessage | null): boolean =>
        r?.t === 'sign' && r.signature.registrantId === c.voterEntry.registrantId && r.signature.deviceKey === c.voterEntry.deviceKey &&
        verifySigP256(consentDigest(block, this.o.ballot, c.voterEntry.registrantId, c.voterEntry.deviceKey), r.signature.signature, c.voterEntry.deviceKey)
      const refusers = others.filter((c, i) => !signedOk(c, replies[i] ?? null))
      if (refusers.length > 0) {
        const reasons = refusers.map((c) => {
          const r = replies[others.indexOf(c)]
          return r?.t === 'refuse' ? r.reason : r?.t === 'sign' ? 'invalid signature' : 'no answer'
        })
        this.log('form-refused-by', { members: refusers.map(c => c.member.slice(-6)), reasons })
        // doc/election.md's open question on repeat offenders: a member dropped here would otherwise
        // merge straight back in and stall the pool again. An invalid signature is refused from now
        // on; any other refusal or silence (a slow fingerprint, a state mismatch) gets one more try.
        refusers.forEach((c, k) => {
          const drops = (this.formationDrops.get(c.member) ?? 0) + 1
          this.formationDrops.set(c.member, drops)
          // D-95: the pool identity only; a re-pooling voter under a new identity is the restart path.
          if (reasons[k] === 'invalid signature') { this.excluded.add(c.member); this.excluded.add(c.voterEntry.registrantId) }
          else if (drops >= 2) this.excluded.add(c.member)
        })
        this.dropMembers(refusers, { reason: 'dropped at formation' })
        return
      }
      const signatures: ConsentSignature[] = [
        { registrantId: mine.voterEntry.registrantId, deviceKey: mine.voterEntry.deviceKey, signature: ownSignature },
        ...replies.map(r => (r as Extract<PoolMessage, { t: 'sign' }>).signature)
      ]
      this.o.onStatus?.({ phase: 'committing', size: this.pool.length })
      const result = await this.o.commit(block, signatures)
      if (result.ok) {
        for (const c of others) void this.post(c.member, { t: 'outcome', topic: this.topic, committed: true, cid: block.cid })
        this.finish({ status: 'committed', cid: block.cid, blockId: block.blockId, size: this.pool.length, formedByMe: true })
        return
      }
      this.log('commit-failed', { reason: result.reason })
      // Only identified pool members may be dropped: the list is input from the commit.
      const named = new Set(result.duplicateRegistrants ?? [])
      const dup = this.pool.filter(c => named.has(c.voterEntry.registrantId))
      if (dup.length === 0) {
        for (const c of others) void this.post(c.member, { t: 'outcome', topic: this.topic, committed: false, reason: 'the block did not commit' })
        this.revertToSolo('commit failed')
        return
      }
      if (dup.some(c => c.member === this.me)) {
        // The former is itself the duplicate: tell everyone, then stop (or report its recorded cid).
        await Promise.all(others.map(async c => await this.post(c.member, dup.includes(c)
          ? { t: 'outcome', topic: this.topic, committed: false, reason: 'already voted', code: 'already-voted' }
          : { t: 'outcome', topic: this.topic, committed: false, reason: 'the former already voted' })))
        const recorded = (await this.o.findRecordedVote?.().catch(() => null)) ?? null
        if (recorded !== null) this.finish({ status: 'committed', cid: recorded, blockId: '', size: 0, formedByMe: false })
        else this.finish({ status: 'stopped', reason: 'already-voted' })
        return
      }
      // Never let a registrant that already voted merge back in and stall the pool again.
      for (const c of dup) { this.excluded.add(c.member); this.excluded.add(c.voterEntry.registrantId) }
      this.log('commit-duplicate', { count: dup.length, size: this.pool.length - dup.length })
      this.dropMembers(dup, { reason: 'already voted', code: 'already-voted' })
    } finally {
      if (this.role !== 'done') this.busy = false
    }
  }

  /**
   * Remove `gone` from the pool: tell the survivors who was dropped, tell the dropped through an
   * `outcome`, and restart the quiet window. The pool re-forms once it is at least `minSize` again.
   */
  private dropMembers (gone: PoolContribution[], outcome: { reason: string, code?: 'already-voted' }): void {
    const goneIds = gone.map(c => c.member)
    for (const c of gone) this.confirmed.delete(c.member)
    this.pool = this.pool.filter(c => !goneIds.includes(c.member))
    // D-91: re-confirm the survivors by request; one that refuses or stays silent is dropped as well.
    if (this.pool.some(c => c.member !== this.me)) void this.informAll()
    for (const g of goneIds) {
      void this.post(g, outcome.code === undefined
        ? { t: 'outcome', topic: this.topic, committed: false, reason: outcome.reason }
        : { t: 'outcome', topic: this.topic, committed: false, reason: outcome.reason, code: outcome.code })
    }
    this.lastGrowthAt = this.o.now()
    this.status()
  }

  private async abandon (reason: 'deadline' | 'aborted'): Promise<void> {
    if (this.role === 'coordinator') {
      for (const c of this.pool) {
        if (c.member !== this.me) await this.post(c.member, { t: 'outcome', topic: this.topic, committed: false, reason })
      }
    }
    this.finish({ status: 'stopped', reason })
  }

  private finish (outcome: PoolOutcome): void {
    this.outcome = outcome
    this.role = 'done'
    this.o.onStatus?.({ phase: 'done', outcome })
    this.log('done', outcome as unknown as Record<string, unknown>)
  }

  // -------------------------------------------------------------------------------------------
  // inbound

  private async withdraw (): Promise<void> {
    // Clear before awaiting, so a present that lands meanwhile is not lost. Every rung presented on is withdrawn.
    const topics = [...this.presentedTopics]
    this.presentedTopics.clear()
    this.lastPresentTopic = null
    // best effort: the rendezvous expires stale coordinators anyway
    await Promise.all(topics.map(async (t) => await this.discovery.withdraw(t, this.o.now()).catch(() => undefined)))
  }

  private async pollLoop (): Promise<void> {
    while (!this.stopped) {
      const startedAt = Date.now()
      let envelopes
      try {
        const reply: RendezvousReply = await this.o.rendezvous.call(poolRequests.poll(this.o.identity, this.o.pollWaitMs, this.o.now()), this.o.pollWaitMs)
        if (reply.t !== 'envelopes') throw new Error(reply.t === 'error' ? reply.reason : 'unexpected reply')
        envelopes = reply.list
      } catch {
        await sleep(500)
        continue
      }
      // A poll released empty at once (a second poll for this identity, a rendezvous restarting)
      // must not spin: back off so timers and other work still run.
      if (envelopes.length === 0 && Date.now() - startedAt < 50) await sleep(200)
      for (const envelope of envelopes) {
        let opened
        try {
          opened = openPoolEnvelope<PoolMessage>(this.o.identity, envelope, this.o.now())
        } catch (err) {
          this.log('envelope-refused', { message: err instanceof Error ? err.message : String(err) })
          continue
        }
        this.count(`in:${opened.body?.t}`)
        void this.onMessage(opened.from, opened.body).catch((err) => this.log('handler-error', { message: err instanceof Error ? err.message : String(err) }))
      }
    }
  }

  private async onMessage (from: string, m: PoolMessage): Promise<unknown> {
    if (m === null || typeof m !== 'object') return
    if ('re' in m && typeof m.re === 'string') {
      const p = this.pending.get(m.re)
      if (p !== undefined && p.from === from) {
        this.pending.delete(m.re)
        clearTimeout(p.timer)
        p.resolve(m)
      }
      return
    }
    if (!('topic' in m) || m.topic !== this.topic || this.role === 'done') {
      if ('id' in m && typeof m.id === 'string') await this.post(from, { t: 'refuse', re: m.id, reason: 'not pooling this ballot' })
      return
    }
    switch (m.t) {
      case 'merge': await this.onMerge(from, m); return
      case 'inform': await this.onInform(from, m); return
      case 'form': await this.onForm(from, m); return
      case 'outcome': await this.onOutcome(from, m); return
      case 'handover': this.onHandover(from, m)
    }
  }

  private async onMerge (from: string, m: Extract<PoolMessage, { t: 'merge' }>): Promise<unknown> {
    const refuse = (reason: string) => this.post(from, { t: 'refuse', re: m.id, reason })
    if (this.role !== 'coordinator' || this.busy) return await refuse('not coordinating')
    if (!Array.isArray(m.contributions) || m.contributions.length === 0 || !m.contributions.every(isContribution)) return await refuse('bad contributions')
    if (better({ size: m.contributions.length, peerId: from }, { size: this.pool.length, peerId: this.me })) return await refuse('your pool is bigger')
    if (this.pool.length + m.contributions.length > this.o.capacity) return await refuse('full')
    if (m.contributions.some(c => this.excluded.has(c.member) || this.excluded.has(c.voterEntry.registrantId))) return await refuse('a member of your pool was dropped here before')
    const ids = new Set(this.pool.map(c => c.voterEntry.registrantId))
    const cts = new Set(this.pool.map(c => c.voteCiphertext))
    const fresh = m.contributions.filter(c => !ids.has(c.voterEntry.registrantId) && !cts.has(c.voteCiphertext))
    if (fresh.length !== m.contributions.length) {
      await refuse('a voter is already in this pool')
      // D-92: the entry may be stale (its owner reverted to solo); re-confirm once so it is dropped
      // and the sender's next merge is accepted. A live member acks and stays.
      if (!this.busy && this.pendingInforms === 0 && this.pool.some(c => c.member !== this.me)) {
        this.log('reconfirm-on-collision', { from: from.slice(-6) })
        void this.informAll()
      }
      return
    }
    this.pool.push(...fresh)
    this.lastGrowthAt = this.o.now()
    await this.post(from, { t: 'merged', re: m.id, size: this.pool.length })
    this.log('merged', { from: from.slice(-6), size: this.pool.length })
    this.status()
    void this.informAll()
  }

  private async onInform (from: string, m: Extract<PoolMessage, { t: 'inform' }>): Promise<unknown> {
    if (Array.isArray(m.dropped) && m.dropped.includes(this.me)) {
      if (this.role === 'member' && this.coordinator === from) this.revertToSolo('dropped by the coordinator')
      return
    }
    if (this.excluded.has(from)) return await this.post(from, { t: 'refuse', re: m.id, reason: 'refused here before' })
    // The sender must hold MY contribution (a digest of my vote ciphertext). That alone is not
    // enough (CR-01): every co-member of a formation has seen my ciphertext.
    if (m.hold !== this.myHold) return await this.post(from, { t: 'refuse', re: m.id, reason: 'you do not hold my vote' })
    if (this.role === 'member') {
      // Only my coordinator, or the one it handed me over to. The handover usually arrives just
      // after the new coordinator's first inform, so wait a little for it; an inform nobody handed
      // over gets no answer (the honest sender retries, a hijacker learns nothing).
      if (from !== this.coordinator && !(await this.handedOverTo(from))) {
        this.log('inform-not-handed-over', { from: from.slice(-6) })
        return
      }
      if (!this.isMember()) return
      // Handed over: a consent the old coordinator asked for belongs to a pool that is gone.
      if (from !== this.coordinator) this.releaseMemberConsent('handed over')
      this.coordinator = from
      this.handover = null
      this.lastHeardAt = this.o.now()
      this.status()
      return await this.post(from, { t: 'ack', re: m.id })
    }
    // A coordinator accepts only the pool it just tried to merge into (its merge reply may have been
    // lost), and only if nobody has joined it since.
    const recent = this.lastMergeAttempt
    const joinedIt = recent !== null && recent.target === from && this.o.now() - recent.at < 3 * this.o.replyTimeoutMs && this.pool.length === recent.size
    if (this.role === 'coordinator' && joinedIt) {
      this.becomeMemberOf(from)
      return await this.post(from, { t: 'ack', re: m.id })
    }
    await this.post(from, { t: 'refuse', re: m.id, reason: 'already coordinating a pool' })
  }

  private async onForm (from: string, m: Extract<PoolMessage, { t: 'form' }>): Promise<unknown> {
    if (this.role !== 'member' || this.coordinator !== from) return await this.post(from, { t: 'refuse', re: m.id, reason: 'not my coordinator' })
    // A stopped run never prompts: refuse before the consent is requested, not after (review WR-01).
    if (this.stopped || this.runSignal?.aborted === true) return await this.post(from, { t: 'refuse', re: m.id, reason: 'the voter stopped pooling' })
    const formAt = this.o.now()
    this.lastHeardAt = formAt + this.o.signTimeoutMs
    const check = checkFormedPoolBlock(m.block, this.o.contribution, this.o.ballot)
    if (!check.ok) {
      this.log('refused-block', { reason: check.reason })
      this.lastHeardAt = this.o.now()
      return await this.post(from, { t: 'refuse', re: m.id, reason: check.reason })
    }
    const mine = this.o.contribution.voterEntry
    const digest = consentDigest(m.block, this.o.ballot, mine.registrantId, mine.deviceKey)
    // The same form from the same coordinator (a failover resend, a retried request) reuses the one
    // consent this voter gave or is giving, never a second prompt (WR-01). The digest binds the
    // block's cid and id, so another block always prompts.
    // D-114/D-115: the consent's deadline is the former's reply deadline, from the LOCAL arrival time.
    const deadlineAt = Math.min(formAt + this.o.signTimeoutMs - this.o.replyTimeoutMs, this.o.deadlineAt ?? Infinity)
    if (this.consent === null || this.consent.from !== from || this.consent.digest !== digest || this.consent.controller.signal.aborted) {
      this.o.onStatus?.({ phase: 'signing' })
      const controller = new AbortController()
      // A queue may call onStart synchronously inside signConsent, so the state exists first.
      const state = { started: false, waiters: 0 }
      const ctl = { signal: controller.signal, deadlineAt, onStart: () => { state.started = true; this.log('consent-start', { digest: digest.slice(0, 8) }) } }
      const signature = this.o.signConsent(digest, ctl)
      this.consent = { from, digest, signature, controller, ctl, state }
    } else if (!this.consent.state.started && deadlineAt > this.consent.ctl.deadlineAt) {
      // IN-03: the former's reply deadline comes from THIS form. A consent still queued takes the new
      // deadline (the queue reads it until the prompt starts); a prompt already showing keeps its own.
      this.consent.ctl.deadlineAt = deadlineAt
    }
    const record = this.consent
    record.state.waiters++
    // D-94: wait for the consent at most until just before the former's request times out.
    const consentSignature = record.signature
    consentSignature.catch(() => undefined) // a late rejection after the bound is nobody's concern
    const waitMs = Math.max(0, deadlineAt - this.o.now())
    let timer: ReturnType<typeof setTimeout> | undefined
    // D-114/D-116: at the bound the consent is aborted (the queue cancels the prompt) and cleared, so
    // a re-form prompts exactly once; a consent that settles after this is never sent.
    const giveUp = (): void => {
      record.controller.abort()
      if (this.consent === record) this.consent = null
    }
    let stopped = false
    let resolveExpired: (v: null) => void = () => {}
    const expired = new Promise<null>((resolve) => {
      resolveExpired = resolve
      // IN-03: a later form of the same block may still be waiting on this consent with a later bound;
      // only the last waiter aborts it.
      timer = setTimeout(() => { if (record.state.waiters <= 1) giveUp(); resolve(null) }, waitMs)
    })
    // WR-01: stopping the run aborts this consent at once (the queue cancels the prompt).
    const unbindStop = this.onRunStop(() => { stopped = true; giveUp(); resolveExpired(null) })
    let signature: string | null
    let abandonedWhy: string | null = null
    try {
      signature = await Promise.race([consentSignature, expired])
    } catch (err) {
      if (!isConsentAbandonedError(err)) {
        this.lastHeardAt = this.o.now()
        return await this.post(from, { t: 'refuse', re: m.id, reason: 'the voter declined to sign' })
      }
      // the queue expired it, had no time for it, or it was aborted: the same path as the bound
      giveUp()
      abandonedWhy = err.reason
      signature = null
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      unbindStop()
      record.state.waiters--
    }
    if (stopped) {
      this.lastHeardAt = this.o.now()
      this.log('consent-stopped', { waitedMs: this.o.now() - formAt })
      return await this.post(from, { t: 'refuse', re: m.id, reason: 'the voter stopped pooling' })
    }
    if (signature === null) {
      this.lastHeardAt = this.o.now()
      this.log('consent-timeout', { waitedMs: this.o.now() - formAt, ...(abandonedWhy !== null ? { reason: abandonedWhy } : {}) })
      return await this.post(from, { t: 'refuse', re: m.id, reason: 'no answer in time' })
    }
    this.signedCid = m.block.cid
    this.everSigned = true
    // D-90: a member that signed stays a member until the former's sign window ends.
    this.lastHeardAt = Math.max(this.o.now(), formAt + this.o.signTimeoutMs)
    await this.post(from, { t: 'sign', re: m.id, signature: { registrantId: mine.registrantId, deviceKey: mine.deviceKey, signature } })
    this.status()
  }

  private async onOutcome (from: string, m: Extract<PoolMessage, { t: 'outcome' }>): Promise<void> {
    if (this.role !== 'member' || this.coordinator !== from) return
    if (m.committed && typeof m.cid === 'string' && m.cid === this.signedCid) {
      this.finish({ status: 'committed', cid: m.cid, blockId: '', size: 0, formedByMe: false })
      return
    }
    if (m.code === 'already-voted') { await this.checkAlreadyVotedClaim(from); return }
    this.revertToSolo(`formation failed: ${m.reason ?? 'unknown'}`)
  }

  /**
   * `already-voted` is a hint (CR-01): any former, honest or not, can send it. Only this voter's own
   * strand read is proof. Poll it for a bounded time (replication of an earlier vote may lag); a
   * recorded cid means sent. Otherwise refuse the claimant from now on and keep pooling alone.
   */
  private async checkAlreadyVotedClaim (from: string): Promise<void> {
    if (this.checkingClaim) return
    this.checkingClaim = true
    try {
      let recorded: string | null = null
      const find = this.o.findRecordedVote
      if (find !== undefined) {
        const until = Date.now() + 4 * this.o.replyTimeoutMs
        for (;;) {
          recorded = await find().catch(() => null)
          if (recorded !== null || this.stopped || this.isDone()) break
          const left = until - Date.now()
          if (left <= 0) break
          await sleep(Math.min(ALREADY_VOTED_POLL_MS, left))
        }
      }
      if (this.stopped || this.isDone()) return
      if (recorded !== null) {
        this.finish({ status: 'committed', cid: recorded, blockId: '', size: 0, formedByMe: false })
        return
      }
      this.excluded.add(from)
      this.log('already-voted-unconfirmed', { from: from.slice(-6) })
      if (this.isMember() && this.coordinator === from) this.revertToSolo('already-voted claim not confirmed by the strand')
    } finally {
      this.checkingClaim = false
    }
  }

  private onHandover (from: string, m: Extract<PoolMessage, { t: 'handover' }>): void {
    if (!this.isMember() || this.coordinator !== from || typeof m.to !== 'string' || m.to === this.me || this.excluded.has(m.to)) return
    this.handover = { from, to: m.to }
    this.lastHeardAt = this.o.now()
    for (const wake of [...this.handoverWaiters]) wake()
  }

  /** Wait (briefly) until my current coordinator has handed me over to `to`. */
  private async handedOverTo (to: string): Promise<boolean> {
    const until = Date.now() + this.o.replyTimeoutMs * 0.75
    for (;;) {
      if (!this.isMember() || this.stopped) return false
      if (this.handover !== null && this.handover.from === this.coordinator && this.handover.to === to) return true
      const left = until - Date.now()
      if (left <= 0) return false
      await new Promise<void>((resolve) => {
        const wake = (): void => { clearTimeout(timer); this.handoverWaiters.delete(wake); resolve() }
        const timer = setTimeout(wake, left)
        this.handoverWaiters.add(wake)
      })
    }
  }

  /**
   * Call `fn` once when the run signal aborts (at once if it already has); returns the unbind. A run
   * without a signal never calls it.
   */
  private onRunStop (fn: () => void): () => void {
    const signal = this.runSignal
    if (signal === undefined) return () => {}
    if (signal.aborted) { fn(); return () => {} }
    signal.addEventListener('abort', fn, { once: true })
    return () => signal.removeEventListener('abort', fn)
  }

  // Role reads through methods: TS would otherwise keep a narrowing across an await.
  private isMember (): boolean { return this.role === 'member' }
  private isDone (): boolean { return this.role === 'done' }

  // -------------------------------------------------------------------------------------------
  // outbound

  private nextId (): string {
    this.seq++
    return `${this.me.slice(-8)}-${this.seq}-${Math.random().toString(36).slice(2, 8)}`
  }

  private async post (to: string, body: PoolMessage): Promise<boolean> {
    try {
      const reply = await this.o.rendezvous.call(poolRequests.send(sealPoolEnvelope(this.o.identity, to, body, this.o.now())))
      if (reply.t === 'error') throw new Error(reply.reason)
      this.count(`out:${body.t}`)
      return true
    } catch (err) {
      this.log('send-failed', { to: to.slice(-6), t: body.t, message: err instanceof Error ? err.message : String(err) })
      return false
    }
  }

  /** Send `body` (which carries an `id`) and wait for the reply naming it, or null on timeout. */
  private async request (to: string, body: Extract<PoolMessage, { id: string }>, timeoutMs: number): Promise<PoolMessage | null> {
    const reply = new Promise<PoolMessage | null>((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(body.id); resolve(null) }, timeoutMs)
      this.pending.set(body.id, { from: to, resolve, timer })
    })
    if (!(await this.post(to, body))) {
      const p = this.pending.get(body.id)
      if (p !== undefined) { clearTimeout(p.timer); this.pending.delete(body.id) }
      return null
    }
    return await reply
  }

  private count (key: string): void { this.counts[key] = (this.counts[key] ?? 0) + 1 }
  private log (event: string, detail?: Record<string, unknown>): void { this.o.log?.(event, detail) }
  private status (): void {
    if (this.role === 'coordinator') this.o.onStatus?.({ phase: 'pooling', size: this.pool.length })
    else if (this.role === 'member' && this.coordinator !== null) this.o.onStatus?.({ phase: 'member', coordinator: this.coordinator, size: 0 })
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
/** how often an `already-voted` claim is re-checked against the strand while it is unconfirmed */
const ALREADY_VOTED_POLL_MS = 500
