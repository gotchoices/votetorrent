// pair-mint-service.ts — the owner phone's policy for a pair-mint request (D-22, D-26, D-28).
//
// A current officer whose phone is not a cadre owner (D-22) asks an owner phone for ONE single-use
// cadre invitation, so a browser can join the cadre (D-26). The owner approves automatically when
// every check passes, writes a visible outcome to the injected mint log and honours an off switch
// (D-28). This file is transport-free: pair-wire.ts puts it on a libp2p node, and every capability
// (membership, the switch, the clock, minting, the store, signature checks) is an injected port, so
// vote-engine keeps its no-cadre-core rule. The service holds no database handle, so it cannot write
// a strand row.
//
// Check order for a mint (the first failing check names the refusal):
//   closed, caller is a member, per-caller throttle, frame shape, switch, expiry window, requester
//   binding, replayed nonce, current officer, signature, live-mint limit, mint, log.
// The requester binding runs BEFORE the replay check, so a mismatched request never burns a nonce.
//
// `fromPeerId` is the caller's IDENTITY peerId: the wire server passes the connection's remote peer,
// and the owner's own local path passes the owner's identity peerId. A statement binds the requesting
// phone's peerId (requesterPeerId), so a leaked statement cannot be replayed from another peer.
//
// Port rules the host must honour:
//   - verifyStatement and verifyRemove must verify against the host's OWN networkHash, never the
//     one in the request, and verifyStatement with the expiry check on.
//   - isCurrentOfficer is bound to isCurrentPairingOfficer on the owner's own strand database. Any
//     throw counts as not current (fail closed).
//   - A port error whose reason is 'not-owner' maps to the not-owner refusal; any other throw maps
//     to not-reachable.
//   - The store must keep every approved entry needed for remove authorization, not only the last
//     few shown in the owner screen.
//
// The invitation text lives only in the reply object. It is never put in the mint log, an error, or
// any console call. If the log write fails after minting, the invitation is not released.

import { fromCanonicalDatetime, toCanonicalDatetime } from '../utils.js'
import type { PairMintHandler, PairMintMintRequest, PairMintRefusalCode, PairMintRemoveRequest, PairMintReply } from './pair-wire.js'
import { parsePairMintRequest } from './pair-wire.js'
import type { PairingVerifyResult } from './pairing-statement.js'

export const PAIR_MINT_WINDOW_MS = 15 * 60_000
export const PAIR_MINT_CLOCK_SKEW_MS = 120_000
export const PAIR_MINT_MAX_LIVE_PER_OFFICER = 3
export const PAIR_MINT_PEER_REQUESTS_PER_MINUTE = 6

const THROTTLE_WINDOW_MS = 60_000

type RefusedOutcome = `refused:${PairMintRefusalCode}`
export type PairMintOutcome = 'approved' | 'unreachable' | RefusedOutcome

export interface PairMintLogEntry {
  nonce: string
  userId: string
  inviteKey: string | null
  /** epoch ms from ports.now() */
  at: number
  expiresAt: string | null
  outcome: PairMintOutcome
}

type MaybePromise<T> = T | Promise<T>

export interface PairMintPorts {
  isAllowed (peerId: string): MaybePromise<boolean>
  isEnabled (): MaybePromise<boolean>
  now (): number
  createInvitation (o: { uses: 1, expiresInMs: number }): Promise<{ encoded: string, inviteKey: string, expiresAt: string }>
  isCurrentOfficer (userId: string, nowCanonical: string): Promise<boolean>
  verifyStatement (req: PairMintMintRequest): Promise<PairingVerifyResult>
  verifyRemove (req: PairMintRemoveRequest): Promise<boolean>
  inviteUsagePeer (inviteKey: string): Promise<string | null>
  removeMachine (peerId: string): Promise<void>
  mintLog: {
    hasNonce (nonce: string): Promise<boolean>
    record (entry: PairMintLogEntry): Promise<void>
    findByNonce (nonce: string): Promise<PairMintLogEntry | null>
    liveMintsFor (userId: string, nowMs: number): Promise<ReadonlyArray<PairMintLogEntry>>
  }
}

export interface PairMintService extends PairMintHandler {}

function refused (code: PairMintRefusalCode): PairMintReply {
  return { t: 'refused', v: 1, code }
}

function isNotOwner (err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { reason?: unknown }).reason === 'not-owner'
}

// A log entry's expiry is the invitation's own string: canonical (UTC, no zone) or a full ISO time.
function toMs (value: string | null): number {
  if (value === null) return NaN
  return /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(value) ? Date.parse(value) : fromCanonicalDatetime(value)
}

export function createPairMintService (ports: PairMintPorts): PairMintService {
  let closed = false
  const seenNonces = new Map<string, number>()
  const callerHits = new Map<string, number[]>()
  let chain: Promise<unknown> = Promise.resolve()

  async function record (entry: PairMintLogEntry): Promise<boolean> {
    try {
      await ports.mintLog.record(entry)
      return true
    } catch {
      return false
    }
  }

  async function refuse (req: PairMintMintRequest, now: number, code: PairMintRefusalCode): Promise<PairMintReply> {
    await record({ nonce: req.nonce, userId: req.userId, inviteKey: null, at: now, expiresAt: null, outcome: `refused:${code}` })
    return refused(code)
  }

  function throttled (from: string, now: number): boolean {
    for (const [peer, hits] of callerHits) {
      const live = hits.filter(t => now - t < THROTTLE_WINDOW_MS)
      if (live.length === 0) callerHits.delete(peer)
      else callerHits.set(peer, live)
    }
    const hits = callerHits.get(from) ?? []
    if (hits.length >= PAIR_MINT_PEER_REQUESTS_PER_MINUTE) return true
    hits.push(now)
    callerHits.set(from, hits)
    return false
  }

  function windowOk (expiresAt: string, now: number): number | null {
    const expMs = fromCanonicalDatetime(expiresAt)
    if (!Number.isFinite(expMs) || expMs <= now) return null
    if (expMs > now + PAIR_MINT_WINDOW_MS + PAIR_MINT_CLOCK_SKEW_MS) return null
    return expMs
  }

  async function mint (from: string, req: PairMintMintRequest): Promise<PairMintReply> {
    let enabled = false
    try { enabled = (await ports.isEnabled()) === true } catch { enabled = false }
    const now = ports.now()
    if (!enabled) return await refuse(req, now, 'switched-off')

    const expMs = windowOk(req.expiresAt, now)
    if (expMs === null) return await refuse(req, now, 'expired')

    if (from !== req.requesterPeerId) return await refuse(req, now, 'requester-mismatch')

    for (const [nonce, until] of seenNonces) if (until <= now) seenNonces.delete(nonce)
    let known = seenNonces.has(req.nonce)
    if (!known) {
      try { known = await ports.mintLog.hasNonce(req.nonce) } catch { return refused('not-reachable') }
    }
    if (known) return refused('replayed')
    seenNonces.set(req.nonce, expMs + PAIR_MINT_CLOCK_SKEW_MS)

    let current = false
    try { current = (await ports.isCurrentOfficer(req.userId, toCanonicalDatetime(now))) === true } catch { current = false }
    if (!current) return await refuse(req, now, 'not-officer')

    let verdict: PairingVerifyResult
    try { verdict = await ports.verifyStatement(req) } catch { verdict = { ok: false, reason: 'bad-signature' } }
    if (!verdict.ok) {
      const code: PairMintRefusalCode = verdict.reason === 'not-officer' || verdict.reason === 'key-not-current'
        ? 'not-officer'
        : verdict.reason
      return await refuse(req, now, code)
    }

    let live: ReadonlyArray<PairMintLogEntry>
    try { live = await ports.mintLog.liveMintsFor(req.userId, now) } catch { return await refuse(req, now, 'not-reachable') }
    let open = 0
    for (const e of live) {
      if (e.outcome !== 'approved' || e.inviteKey === null) continue
      const exp = toMs(e.expiresAt)
      if (!Number.isFinite(exp) || exp <= now) continue
      let redeemedBy: string | null = null
      try { redeemedBy = await ports.inviteUsagePeer(e.inviteKey) } catch { redeemedBy = null }
      if (redeemedBy === null) open++
    }
    if (open >= PAIR_MINT_MAX_LIVE_PER_OFFICER) return await refuse(req, now, 'rate-limited')

    let minted: { encoded: string, inviteKey: string, expiresAt: string }
    try {
      minted = await ports.createInvitation({ uses: 1, expiresInMs: expMs - now })
    } catch (err) {
      if (isNotOwner(err)) return await refuse(req, now, 'not-owner')
      await record({ nonce: req.nonce, userId: req.userId, inviteKey: null, at: now, expiresAt: null, outcome: 'unreachable' })
      return refused('not-reachable')
    }

    // An invitation that cannot be logged is never released; it expires unused.
    const logged = await record({ nonce: req.nonce, userId: req.userId, inviteKey: minted.inviteKey, at: now, expiresAt: minted.expiresAt, outcome: 'approved' })
    if (!logged) return refused('not-reachable')
    return { t: 'minted', v: 1, invitation: minted.encoded, inviteKey: minted.inviteKey, expiresAt: minted.expiresAt }
  }

  async function remove (req: PairMintRemoveRequest): Promise<PairMintReply> {
    const now = ports.now()
    if (windowOk(req.expiresAt, now) === null) return refused('expired')
    let valid = false
    try { valid = (await ports.verifyRemove(req)) === true } catch { valid = false }
    if (!valid) return refused('bad-signature')

    let entry: PairMintLogEntry | null
    try { entry = await ports.mintLog.findByNonce(req.nonce) } catch { return refused('not-reachable') }
    if (entry === null || entry.userId !== req.userId || entry.outcome !== 'approved' || entry.inviteKey === null) {
      return refused('unknown-pairing')
    }
    let usedBy: string | null
    try { usedBy = await ports.inviteUsagePeer(entry.inviteKey) } catch { return refused('not-reachable') }
    if (usedBy === null || usedBy !== req.peerId) return refused('unknown-pairing')

    try {
      await ports.removeMachine(req.peerId)
    } catch (err) {
      return refused(isNotOwner(err) ? 'not-owner' : 'not-reachable')
    }
    return { t: 'removed', v: 1, peerId: req.peerId }
  }

  async function run (fromPeerId: string, body: unknown): Promise<PairMintReply> {
    if (closed) return refused('switched-off')
    if (typeof fromPeerId !== 'string' || fromPeerId.length === 0) return refused('not-officer')
    let allowed = false
    try { allowed = (await ports.isAllowed(fromPeerId)) === true } catch { allowed = false }
    if (!allowed) return refused('not-officer')
    if (throttled(fromPeerId, ports.now())) return refused('rate-limited')
    const req = parsePairMintRequest(body)
    if (req === null) return refused('malformed')
    return req.t === 'mint' ? await mint(fromPeerId, req) : await remove(req)
  }

  return {
    // All requests run through one FIFO chain, so check-then-record is atomic within the process.
    handle (fromPeerId: string, body: unknown): Promise<PairMintReply> {
      const result = chain.then(async () => {
        try {
          return await run(fromPeerId, body)
        } catch {
          return refused('not-reachable')
        }
      })
      chain = result.then(() => undefined, () => undefined)
      return result
    },
    close (): void {
      closed = true
      seenNonces.clear()
      callerHits.clear()
    }
  }
}
