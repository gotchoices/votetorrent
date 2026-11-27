// src/networks/network-join.ts — spike 100: a voter's phone joins an authority's network from a
// join code (join-code.ts), in three steps:
//
//   1. admitting — redeem the code's cadre invitation, which makes this phone a non-owner member
//      of the authority's cadre. Skipped when this node is already admitted (a retry after a
//      later step failed must not spend another use of a limited invitation).
//   2. syncing   — open the network's strand once a peer is connected, and wait for its founding
//      rows to replicate (`NetworksEngine.joinFromStrand`, retried within one budget).
//   3. verifying — those rows must hash to the code's digest; only then is the network opened.
//
// A redemption that THROWS may still have seated this phone: spike 100 measured exactly that
// (the member wrote the CadrePeer row, then its reply was lost on a dropped connection — the
// main-event 1.0.4 listener leak, fixed by 1.0.5). So a throw is followed by a bounded wait for
// this node's own admission row, the check `enrolment-smoke.mjs`'s waitForSelfAdmitted makes,
// and, if it verifies, by the post-redemption steps the throw skipped (app-supplied).
//
// D-07: `invitation-used-up` covers cadre-core's typed `invite-spent` refusal, which also means
// withdrawn, or expired on the member's clock. It is chosen only from that typed code, after the
// bounded self-admission wait, never from message text. `invitation-older-version` is a 1.14-era
// invitation caught before any decode or dial.
//
// D-06: the join code is a bearer credential. This file has no console, and `detail` is a closed
// token (see `NetworkJoinResult`).
//
// D-03: vote-engine never imports cadre-core. Every cadre-core call arrives as a dependency;
// the app wires the real ones (CadreNode, decodeCadreInvitation, verifyInvitationAdmission).

import type { INetworksEngine, NetworkReference, User } from '@votetorrent/vote-core'
import { isOlderVersionInvitation, type NetworkJoinCode } from './join-code.js'

export type NetworkJoinStep = 'admitting' | 'syncing' | 'verifying' | 'done'

/** The slice of a cadre-core `CadreNode` this orchestration calls. */
export interface NetworkJoinNode {
  redeemCadreInvitation (invitation: unknown): Promise<unknown>
}

export interface NetworkJoinOptions {
  readonly node: NetworkJoinNode
  readonly networksEngine: Pick<INetworksEngine, 'joinFromStrand'>
  readonly user: User | undefined
  readonly code: NetworkJoinCode
  /** cadre-core `decodeCadreInvitation`. Throws on a malformed invitation. */
  readonly decodeInvitation: (encoded: string) => unknown
  /** The decoded invitation's expiry in epoch ms, or null when it never expires. */
  readonly invitationExpiresAtMs?: (invitation: unknown) => number | null
  /** True once this node's OWN CadrePeer row has replicated with a verified invitation admission. */
  readonly isSelfAdmitted: () => Promise<boolean>
  /**
   * UAT 65 F1: true when this node's control store already belongs to ANOTHER cadre of the same party
   * (it holds owner keys, none of them the invitation's). Checked before anything else in step 1:
   * such a node would otherwise pass `isSelfAdmitted` on the old cadre's rows (or redeem into a
   * store holding another cadre's history) and then wait forever on a strand whose cadre does not
   * know it. Optional; absent means "never".
   */
  readonly belongsToOtherCadre?: (invitation: unknown) => Promise<boolean>
  /**
   * UAT 65 F1: called when the join gives up for want of time (the sync budget ran out, whether a
   * `joinFromStrand` call was still pending or the last one failed retryably), so the app can
   * release the first-sync waits those calls left running.
   */
  readonly onSyncAbandoned?: () => Promise<void> | void
  /** The steps `redeemCadreInvitation` runs after a reply, run here when admission was found instead. */
  readonly afterFallbackAdmission?: () => Promise<void>
  /** Persist the invitation's member addresses as this node's bootstrap for the next launch. */
  readonly rememberBootstrap?: (invitation: unknown) => Promise<void>
  /** Live control-network connection count (see `JoinFromStrandOptions.getPeerCount`). */
  readonly getPeerCount: () => number
  readonly getStrandPeerCount?: () => number
  readonly onStep?: (step: NetworkJoinStep) => void
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  /** How long to wait for a self-admission row after a redemption threw. Default 20 s. */
  readonly admissionTimeoutMs?: number
  /** Overall budget for opening + verifying the strand, across retries. Default 120 s. */
  readonly syncBudgetMs?: number
  /** Delay between joinFromStrand retries. Default 1 s. */
  readonly retryDelayMs?: number
  /** How long past the budget a pending joinFromStrand call may run before it is abandoned. Default 5 s. */
  readonly budgetGraceMs?: number
}

export type NetworkJoinFailureReason =
  | 'invitation-malformed'
  | 'invitation-expired'
  | 'invitation-older-version'
  | 'invitation-used-up'
  | 'not-admitted'
  | 'no-peers'
  | 'not-synced'
  | 'digest-mismatch'
  | 'open-failed'
  | 'other-cadre'

export type NetworkJoinResult =
  | {
      readonly ok: true
      readonly outcome: 'joined' | 'already-joined'
      readonly admittedVia: 'redeemed' | 'self-admission' | 'already-member'
      readonly networkRef: NetworkReference
      readonly fingerprint: string
    }
  | {
      readonly ok: false
      readonly reason: NetworkJoinFailureReason
      /**
       * A closed token for logs only: a typed error code, an `...Error` class name, a reason token
       * or `unknown`. Never message text, input or any slice of the join code (D-06); apps still
       * never log it.
       */
      readonly detail: string
    }

const CODE_TOKEN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const NAME_TOKEN = /^(?:[A-Z][A-Za-z0-9]{0,58})?Error$/

/** A typed kebab `code`, else an `...Error` class name, else `unknown`. Never reads message, cause or stack. */
function closedDetail (error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const { code, name } = error as { code?: unknown, name?: unknown }
    if (typeof code === 'string' && code.length <= 32 && CODE_TOKEN.test(code)) return code
    if (typeof name === 'string' && NAME_TOKEN.test(name)) return name
  }
  return 'unknown'
}

export async function joinNetwork (options: NetworkJoinOptions): Promise<NetworkJoinResult> {
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  if (isOlderVersionInvitation(options.code.invitation)) {
    return { ok: false, reason: 'invitation-older-version', detail: 'invitation-older-version' }
  }

  let invitation: unknown
  try {
    invitation = options.decodeInvitation(options.code.invitation)
  } catch (e) {
    return { ok: false, reason: 'invitation-malformed', detail: closedDetail(e) }
  }

  // ---- 1. admitting
  options.onStep?.('admitting')
  // UAT 65 F1: a store that already belongs to another cadre cannot join this one (same party id, so the
  // same control protocols and the same control store). Refused, never retried.
  if (await options.belongsToOtherCadre?.(invitation).catch(() => false)) {
    return { ok: false, reason: 'other-cadre', detail: 'other-cadre' }
  }
  let admittedVia: 'redeemed' | 'self-admission' | 'already-member'
  if (await options.isSelfAdmitted().catch(() => false)) {
    admittedVia = 'already-member'
  } else {
    const expiresAt = options.invitationExpiresAtMs?.(invitation) ?? null
    if (expiresAt !== null && expiresAt <= now()) {
      return { ok: false, reason: 'invitation-expired', detail: 'invitation-expired' }
    }
    try {
      await options.node.redeemCadreInvitation(invitation)
      admittedVia = 'redeemed'
    } catch (redeemError) {
      const deadline = now() + (options.admissionTimeoutMs ?? 20_000)
      let admitted = false
      while (!admitted && now() < deadline) {
        admitted = await options.isSelfAdmitted().catch(() => false)
        if (!admitted) await sleep(250)
      }
      if (!admitted) {
        const spent = redeemError !== null && typeof redeemError === 'object' && (redeemError as { code?: unknown }).code === 'invite-spent'
        return { ok: false, reason: spent ? 'invitation-used-up' : 'not-admitted', detail: closedDetail(redeemError) }
      }
      // The admission itself is proven; a failed post-step only slows the strand open.
      await options.afterFallbackAdmission?.().catch(() => undefined)
      admittedVia = 'self-admission'
    }
  }
  // Best effort: a failed write costs a restart's dial hints, never the join itself.
  await options.rememberBootstrap?.(invitation).catch(() => undefined)

  // ---- 2./3. syncing, then verifying (inside joinFromStrand)
  options.onStep?.('syncing')
  const budgetEnds = now() + (options.syncBudgetMs ?? 120_000)
  const retryDelayMs = options.retryDelayMs ?? 1_000
  const graceMs = options.budgetGraceMs ?? 5_000
  for (;;) {
    const remaining = budgetEnds - now()
    const call = options.networksEngine.joinFromStrand(options.code, options.user, {
      getPeerCount: options.getPeerCount,
      getStrandPeerCount: options.getStrandPeerCount,
      timeoutMs: Math.max(1_000, Math.min(30_000, remaining)),
      onVerifying: () => options.onStep?.('verifying')
    })
    // UAT 65 F1: the budget is only real if every call settles inside it. joinFromStrand's own awaits
    // (the strand factory above all) can stay pending far longer, so the call is raced here and
    // abandoned at the budget; it never decides the result after that.
    const result = await settleWithin(call, Math.max(0, remaining) + graceMs)
    if (result === TIMED_OUT) {
      await Promise.resolve(options.onSyncAbandoned?.()).catch(() => undefined)
      return { ok: false, reason: 'not-synced', detail: 'sync-budget-expired' }
    }
    if (result.ok) {
      options.onStep?.('done')
      return { ok: true, outcome: result.outcome, admittedVia, networkRef: result.networkRef, fingerprint: result.fingerprint }
    }
    if (!result.retryable || now() + retryDelayMs >= budgetEnds) {
      // UAT 65 F1: the usual way a budget runs out. Each timed-out call left its strand open
      // waiting, so they are released here too, not only when the race above fires.
      if (result.retryable) await Promise.resolve(options.onSyncAbandoned?.()).catch(() => undefined)
      return { ok: false, reason: result.reason === 'target-open-failed' ? 'open-failed' : result.reason, detail: result.reason }
    }
    await sleep(retryDelayMs)
  }
}

const TIMED_OUT: unique symbol = Symbol('network-join.timed-out')

/** `promise`'s value, or TIMED_OUT once `ms` pass first. A rejection after the race is absorbed. */
function settleWithin<T> (promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  promise.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms) })
  return Promise.race([promise, expiry]).finally(() => { if (timer !== undefined) clearTimeout(timer) })
}
