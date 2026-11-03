/**
 * dashboard-pair-mint.harness.spec.ts — phase 66 plan 09: owner-minted browser pairing on REAL loopback nodes.
 * RUN_P2P_HARNESS=1 like every *.harness.spec.ts; pending in the default suite.
 *
 * Two real enrolled CadreNodes share a VoteTorrent network strand: node-A is the cadre owner and runs the
 * owner-side pair-mint policy (66-03 `createPairMintService`, ports bound by this harness to node-A's
 * cadre-core node and strand database, standing in for the Authority host); node-B is a member that is not an
 * owner and plays officer B's phone (an Officer of the current administration with a P-256 UserKey). B asks A
 * over /votetorrent/pair-mint/1.0.0 for one single-use invitation; browser-like node C (cadre-core
 * `createEdgeNode` with `strandReactivity.edgeHost: true`, the dashboard's shape) redeems it.
 *
 * Decisions: D-22, D-26, D-27, D-28, D-08, and the rulings R-A (requester binding), R-B (current officer at
 * mint time) and R-D (the owner removes the browser when it sees a matching revocation row).
 *
 *   PM-1  a non-owner officer mints one single-use, untargeted invitation from the owner over the wire
 *   PM-2a a stranger (same party, never admitted) is refused by the control-protocol guard before the service
 *   PM-2b forged, cross-network, expired, replayed and switched-off requests are refused with their codes
 *   PM-2c R-B: an officer of an earlier administration only is refused not-officer at mint time
 *   PM-4  node C redeems the PM-1 invitation with a key born after the mint
 *   PM-5  on the non-owner and the owner: inviteKey -> identity peer id -> numeric lastPublishedAt
 *   PM-2d R-A: a statement sent from a different member peer is refused requester-mismatch, burning no nonce
 *   PM-3  no minted key or invitation text appears in any strand row on either replica
 *   PM-7  B's revocation row replicates to C's own strand database; a remove request makes A remove C
 *   PM-7b R-D: a revocation row alone gets a second browser C2 removed by the owner's sweep; rows outside the
 *         owner's mint log remove nothing
 *   PM-6  with the owner stopped, the officer's request fails typed and fast (runs last)
 *
 * NOT proven here: a browser (IndexedDB, the browser gater, a bundle), the relay circuit (PM-8 belongs to
 * 66-26/66-27), the Authority host and client engines (66-10/66-11), the owner-unreachable copy mapping (66-11),
 * and 66-10's own revocation watcher (PM-7b drives a spec-local sweep implementing the same rule).
 *
 * Bearer hygiene: invitation text, its private key, statement signatures and key bytes are never logged and are
 * compared only through boolean expressions.
 */

import { expect } from 'chai'
import {
  describeP2PHarness, startTwoNodeHarness, pollUntil, seedPairingOfficers, startHarnessEdgeMember,
  attachHarnessEdgeStrand, startHarnessStranger, VOTETORRENT_INNER_DDL,
  type TwoNodeHarness, type HarnessPairingNetwork, type HarnessPairingOfficer, type HarnessEdgeMember
} from './harness/two-node-strand.js'
import {
  PAIR_MINT_PROTOCOL, attachPairMint, requestPairMint, PairMintTransportError,
  type PairMintMintRequest, type PairMintRemoveRequest, type PairMintReply, type PairMintRequest
} from '../src/pairing/pair-wire.js'
import { createPairMintService, type PairMintLogEntry, type PairMintPorts } from '../src/pairing/pair-mint-service.js'
import {
  pairingStatementDigest, pairingRemoveDigest, verifyPairingStatement, verifyPairingRemove, isCurrentPairingOfficer
} from '../src/pairing/pairing-statement.js'
import { revokeDashboardPairing, isPairingRevoked } from '../src/pairing/pairing-revocation.js'
import { bytesToBase64url, toCanonicalDatetime, nowCanonicalDatetime, fromCanonicalDatetime } from '../src/utils.js'
import { makeP256TestKey, signDigestP256 } from './fixtures/p256-signer.js'

const SCALE = Number(process.env.P2P_HARNESS_TIMEOUT_SCALE ?? 1)
const CLUSTER_SIZE = 2
/** Mint, remove and malformed requests share this per-caller budget on the owner (66-03). */
const CALLER_BUDGET = 6
const CALLER_WINDOW_MS = 61_000
const PRE_REPLAY_REFUSALS = new Set(['refused:switched-off', 'refused:expired', 'refused:requester-mismatch'])

function ms (n: number): number {
  return Math.round(n * SCALE)
}

async function sleep (n: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, n))
}

function toHex (bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

function freshNonce (): string {
  return bytesToBase64url(crypto.getRandomValues(new Uint8Array(16)))
}

/** The refusal code, or the reply kind for a non-refusal. Never the reply object (it may carry a bearer). */
function codeOf (reply: PairMintReply): string {
  return reply.t === 'refused' ? reply.code : reply.t
}

function logReply (leg: string, label: string, reply: PairMintReply): void {
  if (reply.t === 'refused') console.log(`[${leg}] ${label} ${reply.code}`)
  else if (reply.t === 'minted') console.log(`[${leg}] ${label} minted keyLength=${reply.inviteKey.length}`)
  else console.log(`[${leg}] ${label} ${reply.t}`)
}

/** How a stored invite expiry is written: an observation for the SUMMARY, never the value. */
function expiryFormat (v: unknown): string {
  if (typeof v === 'number') return 'epoch-ms'
  if (typeof v !== 'string') return typeof v
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(v)) return 'canonical-19'
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/.test(v)) return 'utc-ms-23-no-zone'
  if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(v)) return 'iso-zoned'
  return 'other'
}

function expiryMs (v: unknown): number {
  if (typeof v === 'number') return v
  const s = String(v)
  return /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s) ? Date.parse(s) : fromCanonicalDatetime(s)
}

interface HarnessLogEntry extends PairMintLogEntry {
  /** Harness-only R-D mark: an unredeemed pairing that was revoked never counts as a live mint. */
  revoked?: boolean
}

describeP2PHarness('owner-minted browser pairing over /votetorrent/pair-mint/1.0.0 on real nodes', function () {
  this.timeout(ms(1_200_000))

  let harness: TwoNodeHarness
  let pn: HarnessPairingNetwork
  let cadre: any
  let B: HarnessPairingOfficer

  // Owner host binding (the harness's own, standing in for 66-10's host).
  const mintEntries: HarnessLogEntry[] = []
  const mintLog = {
    async hasNonce (nonce: string): Promise<boolean> {
      return mintEntries.some((e) => e.nonce === nonce && !PRE_REPLAY_REFUSALS.has(e.outcome))
    },
    async record (entry: PairMintLogEntry): Promise<void> {
      mintEntries.push({ ...entry })
    },
    async findByNonce (nonce: string): Promise<PairMintLogEntry | null> {
      // The 66-03 V-17/V-5 fake: the approved entry first, else the first entry recorded, else null.
      return mintEntries.find((e) => e.nonce === nonce && e.outcome === 'approved') ??
        mintEntries.find((e) => e.nonce === nonce) ?? null
    },
    async liveMintsFor (userId: string, nowMs: number): Promise<ReadonlyArray<PairMintLogEntry>> {
      return mintEntries.filter((e) => e.userId === userId && e.outcome === 'approved' && e.expiresAt !== null &&
        fromCanonicalDatetime(e.expiresAt) > nowMs && e.revoked !== true)
    },
    /** Harness-only (R-D); not part of the 66-03 port, the service never calls it. */
    markRevoked (nonce: string): boolean {
      const entry = mintEntries.find((e) => e.nonce === nonce && e.outcome === 'approved')
      if (entry === undefined) return false
      entry.revoked = true
      return true
    }
  }
  let switchOn = true
  let createCount = 0
  let lastRemoval: any = null
  let inviteExpiryFormat = 'unseen'
  let ports: PairMintPorts
  const calls: string[] = []
  let detach: (() => Promise<void>) | undefined
  let aTarget: any
  let aAddr: any
  let aControlPeer = ''
  let unclassifiedWarns = 0
  const savedWarn = console.warn

  // Per-caller pacing that respects the owner's throttle instead of tripping it.
  const sentAt = new Map<string, number[]>()
  let paceWaits = 0

  // Suite state shared by the legs.
  let tMint = 0
  let pm1: PairMintMintRequest
  let pm1Reply: Extract<PairMintReply, { t: 'minted' }> | undefined
  let pm1Nonce = ''
  let c: HarnessEdgeMember | undefined
  let cPeerId = ''
  let cStrand: { strandNode: any, strandPeerId: string, db: any } | undefined
  let ra: PairMintMintRequest | undefined
  let raReply: Extract<PairMintReply, { t: 'minted' }> | undefined
  let c2: HarnessEdgeMember | undefined
  let stranger: { node: any, peerId: string, stop(): Promise<void> } | undefined
  let sweepTimer: ReturnType<typeof setInterval> | undefined
  let snapshotRetries = 0

  function entriesFor (nonce: string): HarnessLogEntry[] {
    return mintEntries.filter((e) => e.nonce === nonce)
  }

  async function buildMint (officer: HarnessPairingOfficer, opts: {
    nonce?: string
    expiresAt?: string
    requesterPeerId?: string
    digestHash?: string
    signWith?: Uint8Array
  } = {}): Promise<PairMintMintRequest> {
    const nonce = opts.nonce ?? freshNonce()
    const expiresAt = opts.expiresAt ?? toCanonicalDatetime(Date.now() + 14 * 60_000)
    const requesterPeerId = opts.requesterPeerId ?? harness.nodeB.peerId
    // Computed on the OFFICER's replica, as the phone would.
    const digest = await pairingStatementDigest(pn.dbB, {
      networkHash: opts.digestHash ?? pn.hash, userId: officer.user.id, nonce, expiresAt, requesterPeerId
    })
    const sig = signDigestP256(bytesToBase64url(digest), opts.signWith ?? officer.privBytes)
    return { t: 'mint', v: 1, networkHash: pn.hash, userId: officer.user.id, nonce, expiresAt, requesterPeerId, keyPub: officer.keyPub, sig }
  }

  async function buildRemove (officer: HarnessPairingOfficer, nonce: string, peerId: string): Promise<PairMintRemoveRequest> {
    const expiresAt = toCanonicalDatetime(Date.now() + 10 * 60_000)
    const digest = await pairingRemoveDigest(pn.dbB, { networkHash: pn.hash, userId: officer.user.id, nonce, peerId, expiresAt })
    const sig = signDigestP256(bytesToBase64url(digest), officer.privBytes)
    return { t: 'remove', v: 1, networkHash: pn.hash, userId: officer.user.id, nonce, peerId, expiresAt, keyPub: officer.keyPub, sig }
  }

  async function send (fromLibp2p: any, fromPeerId: string, request: PairMintRequest, timeoutMs = 20_000, target: unknown = aTarget): Promise<PairMintReply> {
    for (;;) {
      const live = (sentAt.get(fromPeerId) ?? []).filter((t) => Date.now() - t < CALLER_WINDOW_MS)
      sentAt.set(fromPeerId, live)
      if (live.length < CALLER_BUDGET) break
      const wait = live[0]! + CALLER_WINDOW_MS - Date.now() + 50
      paceWaits++
      console.log(`[pm-obs] pace wait ${wait}`)
      await sleep(Math.max(wait, 50))
    }
    try {
      return await requestPairMint(fromLibp2p, target, request, { timeoutMs })
    } finally {
      // Stamped after the reply, so the owner's own stamp for this request is never later than ours.
      const list = sentAt.get(fromPeerId) ?? []
      list.push(Date.now())
      sentAt.set(fromPeerId, list)
    }
  }

  function p256Signer (o: HarnessPairingOfficer): any {
    return {
      userId: o.user.id,
      signingPublicKey: o.keyPub,
      sign: async (d: Uint8Array) => ({ signature: signDigestP256(bytesToBase64url(d), o.privBytes), signerKey: o.keyPub, signerUserId: o.user.id })
    }
  }

  async function revokedOn (db: any, userId: string, nonce: string): Promise<boolean> {
    return await isPairingRevoked(db, { userId, nonce })
  }

  // ---- R-D sweep (spec-local; the rule 66-10's planRevocationActions implements) --------------------------
  let sweepRemovals = 0
  let sweepWithdrawals = 0
  let sweepInFlight: Promise<unknown> | null = null
  interface SweepOutcome { label: string, outcome: string, key: string }

  async function sweepRevocationsOnce (): Promise<{ outcomes: SweepOutcome[] }> {
    const outcomes: SweepOutcome[] = []
    const rows: Array<{ userId: string, nonce: string }> = []
    for await (const r of pn.dbA.eval('select UserId, Nonce from DashboardPairingRevocation')) {
      rows.push({ userId: String((r as any).UserId), nonce: String((r as any).Nonce) })
    }
    const machines = new Set<string>(((await harness.nodeA.node.listMachines()) as any[]).map((m) => m.peerId))
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!
      const label = `row-${i}`
      const key = `${row.userId}|${row.nonce}`
      const entry = (await mintLog.findByNonce(row.nonce)) as HarnessLogEntry | null
      // Officer AND pairing must match an approved entry of THIS owner's mint log.
      if (entry === null || entry.outcome !== 'approved' || entry.inviteKey === null || entry.userId !== row.userId) {
        outcomes.push({ label, outcome: 'no-mint-entry', key })
        continue
      }
      const peer = await ports.inviteUsagePeer(entry.inviteKey)
      if (peer === null) {
        // Never redeemed: withdraw the invitation (66-10's rule) and stop counting it as a live mint.
        if (entry.revoked !== true) {
          try {
            const filed = await harness.nodeA.node.withdrawCadreInvitation(entry.inviteKey)
            if (filed === true) sweepWithdrawals++
            mintLog.markRevoked(row.nonce)
          } catch (err) {
            console.log(`[pm-7b] ${label} withdraw failed ${(err as Error).name}`)
            outcomes.push({ label, outcome: 'withdraw-failed', key })
            continue
          }
        }
        outcomes.push({ label, outcome: 'unredeemed-revoked', key })
        continue
      }
      if (!machines.has(peer)) {
        outcomes.push({ label, outcome: 'already-gone', key })
        continue
      }
      sweepRemovals++
      try {
        await harness.nodeA.node.removeMachine(peer)
        machines.delete(peer)
        outcomes.push({ label, outcome: 'removed', key })
      } catch (err) {
        const code = (err as any)?.code
        const outcome = code === 'not-an-owner' || code === 'self' ? `terminal-${String(code)}` : 'remove-failed'
        console.log(`[pm-7b] ${label} ${outcome} ${(err as Error).name}`)
        outcomes.push({ label, outcome, key })
      }
    }
    return { outcomes }
  }

  function outcomeFor (outcomes: SweepOutcome[], userId: string, nonce: string): string[] {
    return outcomes.filter((o) => o.key === `${userId}|${nonce}`).map((o) => o.outcome)
  }

  before(async function () {
    this.timeout(ms(300_000))
    console.warn = (...args: unknown[]) => {
      if (args.some((a) => typeof a === 'string' && a.includes(PAIR_MINT_PROTOCOL))) unclassifiedWarns++
      savedWarn(...(args as any[]))
    }
    harness = await startTwoNodeHarness({ clusterSize: CLUSTER_SIZE, extraConfig: { strandReactivity: { enabled: true } } })
    cadre = await import('@serfab/cadre-core')
    pn = await seedPairingOfficers(harness)
    B = pn.officerB

    // Read-backs that make PM-2c meaningful.
    const nowC = nowCanonicalDatetime()
    expect(await isCurrentPairingOfficer(pn.dbA, { userId: B.user.id, nowCanonical: nowC }), 'B is a current officer').to.equal(true)
    expect(await isCurrentPairingOfficer(pn.dbA, { userId: pn.formerOfficerY.user.id, nowCanonical: nowC }), 'Y is not a current officer').to.equal(false)
    const yProbe = await buildMint(pn.formerOfficerY)
    const yVerdict = await verifyPairingStatement(pn.dbA, {
      networkHash: pn.hash,
      statement: { userId: yProbe.userId, nonce: yProbe.nonce, expiresAt: yProbe.expiresAt, requesterPeerId: yProbe.requesterPeerId, keyPub: yProbe.keyPub, sig: yProbe.sig },
      nowCanonical: nowCanonicalDatetime(),
      checkExpiry: true
    })
    expect(yVerdict.ok, 'Y passes the browser-side statement rule').to.equal(true)

    // D-22 precondition: node-B is a member, not an owner, so it cannot mint itself.
    let bMintErr: unknown = null
    try {
      await harness.nodeB.node.createCadreInvitation({ uses: 1 })
    } catch (err) {
      bMintErr = err
    }
    expect(bMintErr !== null, 'node-B cannot mint a cadre invitation').to.equal(true)
    console.log(`[pm-obs] node-B cannot mint: ${(bMintErr as Error).name}`)

    ports = {
      isAllowed: (p) => harness.nodeA.node.isAuthorizedMember(p),
      isEnabled: () => switchOn,
      now: () => Date.now(),
      async createInvitation ({ uses, expiresInMs }) {
        createCount++
        const minted = await harness.nodeA.node.createCadreInvitation({ uses, expiresInMs })
        inviteExpiryFormat = expiryFormat(minted.invitation.invite.expiresAt)
        // cadre-core stores Quereus datetime() text: UTC with milliseconds and NO zone. Handing that text to
        // toCanonicalDatetime() parses it as LOCAL time, so it goes through epoch ms (read as UTC) first.
        return { encoded: minted.encoded, inviteKey: minted.invitation.invite.key, expiresAt: toCanonicalDatetime(expiryMs(minted.invitation.invite.expiresAt)) }
      },
      isCurrentOfficer: async (u, nowCanonical) => await isCurrentPairingOfficer(pn.dbA, { userId: u, nowCanonical }),
      // The OWN network hash, never the one carried in the request.
      verifyStatement: async (req) => await verifyPairingStatement(pn.dbA, {
        networkHash: pn.hash,
        statement: { userId: req.userId, nonce: req.nonce, expiresAt: req.expiresAt, requesterPeerId: req.requesterPeerId, keyPub: req.keyPub, sig: req.sig },
        nowCanonical: nowCanonicalDatetime(),
        checkExpiry: true
      }),
      async verifyRemove (req) {
        const verdict = await verifyPairingRemove(pn.dbA, {
          networkHash: pn.hash,
          request: { userId: req.userId, nonce: req.nonce, peerId: req.peerId, expiresAt: req.expiresAt, keyPub: req.keyPub, sig: req.sig },
          nowCanonical: nowCanonicalDatetime()
        })
        return verdict.ok
      },
      async inviteUsagePeer (inviteKey) {
        const rows: any[] = await harness.nodeA.node.getControlDatabase().queryCadreInviteUsages()
        return rows.find((r) => r.inviteKey === inviteKey)?.peerId ?? null
      },
      async removeMachine (peerId) {
        lastRemoval = await harness.nodeA.node.removeMachine(peerId)
      },
      mintLog
    }
    const service = createPairMintService(ports)
    const spy = {
      handle (from: string, body: unknown) {
        calls.push(from)
        return service.handle(from, body)
      },
      close () { return service.close() }
    }
    const control = harness.nodeA.node.getControlNode()
    detach = await attachPairMint(control, spy)
    aTarget = control.peerId
    aControlPeer = control.peerId.toString()
    aAddr = (control.getMultiaddrs() as any[]).find((m) => {
      const s = m.toString()
      return s.includes('/ip4/127.0.0.1/') && s.includes('/ws')
    })
    expect(aAddr !== undefined, 'node-A has a loopback websocket control address').to.equal(true)
    console.log(`[pm-obs] control peer equals identity peer on node-A: ${aControlPeer === harness.nodeA.peerId}`)
  })

  after(async function () {
    this.timeout(60_000)
    if (sweepTimer !== undefined) clearInterval(sweepTimer)
    try { await sweepInFlight } catch { /* reported in the leg */ }
    try { await detach?.() } catch { /* node may be stopped */ }
    for (const m of [c, c2]) await m?.stop()
    await stranger?.stop()
    await harness?.stop()
    console.log(`[pm-obs] unclassified-protocol warnings naming pair-mint ${unclassifiedWarns}; pace waits ${paceWaits}; snapshot retries ${snapshotRetries}; invite expiry format ${inviteExpiryFormat}`)
    console.warn = savedWarn
  })

  it('PM-1 a non-owner officer mints one single-use invitation from the owner over the wire', async function () {
    this.timeout(ms(120_000))
    pm1 = await buildMint(B)
    pm1Nonce = pm1.nonce
    tMint = Date.now()
    const reply = await send(harness.nodeB.node.getControlNode(), harness.nodeB.peerId, pm1)
    logReply('pm-1', 'reply', reply)
    expect(codeOf(reply)).to.equal('minted')
    if (reply.t !== 'minted') return
    pm1Reply = reply

    const decoded = cadre.decodeCadreInvitation(reply.invitation)
    expect(decoded.invite.key === reply.inviteKey, 'decoded key equals the reply inviteKey').to.equal(true)
    expect(decoded.invite.totalUses, 'single use').to.equal(1)
    expect(decoded.invite.peerId === null, 'untargeted').to.equal(true)
    const notOutliving = expiryMs(decoded.invite.expiresAt) <= fromCanonicalDatetime(pm1.expiresAt) + 2_000
    expect(notOutliving, 'the invitation does not outlive the signed statement').to.equal(true)
    const replyExpiryMatches = Math.abs(fromCanonicalDatetime(reply.expiresAt) - expiryMs(decoded.invite.expiresAt)) < 2_000
    expect(replyExpiryMatches, 'the reply and log expiry is the invitation expiry, read as UTC').to.equal(true)
    const liveNow = await mintLog.liveMintsFor(B.user.id, Date.now())
    expect(liveNow.some((e) => e.nonce === pm1.nonce), 'the fresh mint counts as live (positive control)').to.equal(true)

    const entries = entriesFor(pm1.nonce)
    expect(entries.length, 'one mint-log entry for the nonce').to.equal(1)
    expect(entries[0]!.outcome).to.equal('approved')
    expect(entries[0]!.inviteKey === reply.inviteKey, 'the entry holds the inviteKey').to.equal(true)
    expect(JSON.stringify(entries[0]).includes(reply.invitation), 'the entry holds no invitation text').to.equal(false)
    expect(createCount, 'createInvitation calls').to.equal(1)

    const listed = ((await harness.nodeA.node.listCadreInvitations()) as any[]).find((s) => s.invite?.key === reply.inviteKey)
    expect(listed !== undefined, 'node-A lists the invitation').to.equal(true)
    expect(listed.usesRecorded).to.equal(0)
    expect(calls.every((p) => p === harness.nodeB.peerId), 'every service call came from node-B\'s identity peer id').to.equal(true)
    console.log(`[pm-1] minted ${Date.now() - tMint} ms; expiry format ${inviteExpiryFormat}`)
  })

  it('PM-2a a stranger is refused by the control-protocol guard before the service runs', async function () {
    this.timeout(ms(120_000))
    stranger = await startHarnessStranger(harness, { clusterSize: CLUSTER_SIZE })
    expect(await harness.nodeA.node.isAuthorizedMember(stranger.peerId), 'the stranger is no member').to.equal(false)
    const callsBefore = calls.length
    const invitesBefore = createCount
    const logBefore = mintEntries.length

    const req = await buildMint(B, { requesterPeerId: stranger.peerId })
    let err: unknown = null
    let answered: PairMintReply | null = null
    try {
      answered = await send(stranger.node.getControlNode(), stranger.peerId, req, 10_000, aAddr)
    } catch (e) {
      err = e
    }
    const strangerCalls = calls.slice(callsBefore).filter((p) => p === stranger!.peerId).length
    if (answered !== null) console.log(`[pm-2a] FINDING the service answered the stranger: ${codeOf(answered)}`)
    expect(strangerCalls, 'the service never ran for the stranger (the guard refused first)').to.equal(0)
    expect(err instanceof PairMintTransportError, 'a transport-level refusal').to.equal(true)
    const te = err as PairMintTransportError
    expect(te.name).to.equal('PairMintTransportError')
    console.log(`[pm-2a] refused ${te.name} reason=${te.reason} requestSent=${te.requestSent}`)
    expect(createCount, 'no invitation created').to.equal(invitesBefore)
    expect(mintEntries.length, 'mint log unchanged').to.equal(logBefore)
    await stranger.stop()
  })

  it('PM-2b forged, cross-network, expired, replayed and switched-off requests are refused with their codes', async function () {
    this.timeout(ms(240_000))
    const bControl = harness.nodeB.node.getControlNode()
    const cases: Array<{ name: string, expected: string, build: () => Promise<PairMintMintRequest>, around?: (fn: () => Promise<PairMintReply>) => Promise<PairMintReply> }> = [
      { name: 'forged', expected: 'bad-signature', build: async () => await buildMint(B, { signWith: makeP256TestKey().privBytes }) },
      { name: 'cross-network', expected: 'bad-signature', build: async () => await buildMint(B, { digestHash: 'other-' + pn.hash }) },
      { name: 'expired', expected: 'expired', build: async () => await buildMint(B, { expiresAt: toCanonicalDatetime(Date.now() - 60_000) }) },
      { name: 'replayed', expected: 'replayed', build: async () => pm1 },
      {
        name: 'switched-off',
        expected: 'switched-off',
        build: async () => await buildMint(B),
        around: async (fn) => {
          switchOn = false
          try { return await fn() } finally { switchOn = true }
        }
      }
    ]
    for (const k of cases) {
      const invitesBefore = createCount
      const req = await k.build()
      const run = async (): Promise<PairMintReply> => await send(bControl, harness.nodeB.peerId, req)
      const reply = k.around !== undefined ? await k.around(run) : await run()
      console.log(`[pm-2b] ${k.name} ${codeOf(reply)}`)
      expect(codeOf(reply), k.name).to.equal(k.expected)
      expect(createCount, `${k.name}: no invitation created`).to.equal(invitesBefore)
    }
  })

  it('PM-2c an officer who is no longer current is refused not-officer at mint time (R-B)', async function () {
    this.timeout(ms(180_000))
    const invitesBefore = createCount
    // Y's userId, keyPub and signature; node-B stands in for Y's phone here.
    const y = await buildMint(pn.formerOfficerY)
    const reply = await send(harness.nodeB.node.getControlNode(), harness.nodeB.peerId, y)
    expect(codeOf(reply)).to.equal('not-officer')
    expect(createCount, 'no invitation created').to.equal(invitesBefore)
    const ys = entriesFor(y.nonce)
    expect(ys.length > 0, 'the refusal is in the mint log').to.equal(true)
    expect(ys[ys.length - 1]!.outcome).to.equal('refused:not-officer')
    const verdict = await verifyPairingStatement(pn.dbA, {
      networkHash: pn.hash,
      statement: { userId: y.userId, nonce: y.nonce, expiresAt: y.expiresAt, requesterPeerId: y.requesterPeerId, keyPub: y.keyPub, sig: y.sig },
      nowCanonical: nowCanonicalDatetime(),
      checkExpiry: true
    })
    expect(verdict.ok, 'the same request passes the browser-side statement rule').to.equal(true)
    console.log('[pm-2c] not-officer')
  })

  it('PM-4 browser-like node C redeems the minted invitation with a key born after the mint', async function () {
    this.timeout(ms(240_000))
    if (pm1Reply === undefined) throw new Error('PM-4 needs PM-1\'s minted reply')
    const keyStore = new cadre.InMemoryKeyStore()
    expect((await keyStore.list()).length, 'the browser key does not exist at mint time').to.equal(0)
    c = await startHarnessEdgeMember({ label: 'node-C', storageId: 'pm-node-c', strandId: pn.hash, clusterSize: CLUSTER_SIZE, keyStore, strandReactivity: { edgeHost: true } })
    cPeerId = await c.identityPeerId()
    expect(cPeerId).to.not.equal(harness.nodeA.peerId)
    expect(cPeerId).to.not.equal(harness.nodeB.peerId)
    expect(await harness.nodeA.node.isAuthorizedMember(cPeerId), 'not a member before the join').to.equal(false)

    await c.edge.joinCadre(cadre.decodeCadreInvitation(pm1Reply.invitation), { relayAddrs: [], signal: AbortSignal.timeout(ms(120_000)) })
    expect(c.edge.ownerPublicKey() === null, 'C holds no owner key').to.equal(true)
    expect(c.edge.status.state).to.equal('running')
    await pollUntil(
      async () => await harness.nodeA.node.isAuthorizedMember(cPeerId),
      (v) => v === true,
      { timeoutMs: ms(60_000), label: 'node-A sees C as a member' }
    )
    const admittedMs = Date.now() - tMint
    cStrand = await attachHarnessEdgeStrand(c, pn.hash)
    const differs = cStrand.strandPeerId !== cPeerId
    console.log(`[pm-4] admitted ${admittedMs} after mint; strand peer differs from identity: ${differs}`)
  })

  it('PM-5 the non-owner resolves inviteKey to the browser\'s identity peer id and its last-seen stamp', async function () {
    this.timeout(ms(120_000))
    if (pm1Reply === undefined || c === undefined) throw new Error('PM-5 needs PM-1 and PM-4')
    const inviteKey = pm1Reply.inviteKey
    // node-B first: the non-owner reading 66-16 relies on.
    for (const [name, node] of [['node-B', harness.nodeB.node], ['node-A', harness.nodeA.node]] as const) {
      const usage: any = await pollUntil(
        async () => ((await node.getControlDatabase().queryCadreInviteUsages()) as any[]).find((r) => r.inviteKey === inviteKey) ?? null,
        (r) => r !== null,
        { timeoutMs: ms(60_000), label: `${name} holds the usage row` }
      )
      expect(usage.peerId, `${name}: usage row names C's IDENTITY peer id`).to.equal(cPeerId)
      const machine: any = await pollUntil(
        async () => ((await node.listMachines()) as any[]).find((m) => m.peerId === cPeerId) ?? null,
        (m) => m !== null && typeof m.lastPublishedAt === 'number',
        { timeoutMs: ms(60_000), label: `${name} lists C with a lastPublishedAt` }
      )
      const at = machine.lastPublishedAt as number
      expect(at).to.be.at.least(tMint - 5_000)
      expect(at).to.be.at.most(Date.now() + 5_000)
      console.log(`[pm-5] ${name} lastPublishedAt age ${Date.now() - at}`)
    }
    const listed = ((await harness.nodeA.node.listCadreInvitations()) as any[]).find((s) => s.invite?.key === inviteKey)
    expect(listed !== undefined, 'node-A lists the invitation').to.equal(true)
    expect(listed.usesRecorded).to.equal(1)
  })

  it('PM-2d R-A: a statement sent from a different peer is refused requester-mismatch and burns no nonce', async function () {
    this.timeout(ms(240_000))
    if (c === undefined) throw new Error('PM-2d needs PM-4\'s member C')
    const invitesBefore = createCount
    ra = await buildMint(B)
    const cControl = c.edge.node.getControlNode()
    let reply: PairMintReply | null = null
    for (let attempt = 0; reply === null; attempt++) {
      const callsBefore = calls.length
      try {
        reply = await send(cControl, cPeerId, ra)
      } catch (err) {
        const reachedService = calls.slice(callsBefore).includes(cPeerId)
        if (!(err instanceof PairMintTransportError) || reachedService || attempt >= 6) throw err
        snapshotRetries++
        console.log(`[pm-obs] snapshot retry ${attempt + 1} reason=${err.reason}`)
        await sleep(5_000)
      }
    }
    expect(codeOf(reply)).to.equal('requester-mismatch')
    expect(calls[calls.length - 1] === cPeerId, 'the service saw C as the caller').to.equal(true)
    expect(createCount, 'no invitation for the mismatch').to.equal(invitesBefore)

    const again = await send(harness.nodeB.node.getControlNode(), harness.nodeB.peerId, ra)
    expect(codeOf(again), 'the same statement from its own peer mints').to.equal('minted')
    if (again.t !== 'minted') return
    raReply = again
    const outcomes = entriesFor(ra.nonce).map((e) => e.outcome)
    expect(outcomes).to.include('refused:requester-mismatch')
    expect(outcomes).to.include('approved')
    const found = await mintLog.findByNonce(ra.nonce)
    expect(found?.outcome).to.equal('approved')
    console.log('[pm-2d] mismatch then minted')
  })

  it('PM-3 no invite key or invitation text appears in any strand row on either replica', async function () {
    this.timeout(ms(180_000))
    if (pm1Reply === undefined || raReply === undefined) throw new Error('PM-3 needs the PM-1 and PM-2d mints')
    // The cadre CONTROL database legitimately holds the CadreInvite row: that is cadre-core's own ledger,
    // not a strand. This leg is about strand rows (D-28).
    const needles: Array<{ label: string, value: string }> = []
    for (const [tag, r] of [['pm1', pm1Reply], ['pm2d', raReply]] as const) {
      const text = r.invitation
      needles.push({ label: `${tag}.inviteKey`, value: r.inviteKey })
      needles.push({ label: `${tag}.invitation`, value: text })
      needles.push({ label: `${tag}.payload`, value: text.slice(text.lastIndexOf('.') + 1) })
      needles.push({ label: `${tag}.privateKey`, value: String(cadre.decodeCadreInvitation(text).invitePrivateKey) })
    }
    expect(needles.every((n) => n.value.length > 0), 'every needle is non-empty').to.equal(true)

    const ctl = 'pm3-ctl-' + toHex(crypto.getRandomValues(new Uint8Array(8)))
    await pn.dbA.exec('insert into TidHighWater (Namespace, HighWater) values (:ns, 1)', { ns: ctl } as any)
    await pollUntil(
      async () => (await pn.dbB.prepare('select 1 as x from TidHighWater where Namespace = :ns').get({ ns: ctl } as any)) != null,
      (v) => v === true,
      { timeoutMs: ms(60_000), label: 'control marker reaches node-B' }
    )

    const tables = [...VOTETORRENT_INNER_DDL.matchAll(/^\s*table\s+(\w+)\s*\(/gm)].map((m) => m[1]!)
    expect(tables.length > 0, 'the strand schema lists tables').to.equal(true)
    expect(tables).to.include('DashboardPairingRevocation')
    expect(tables).to.include('TidHighWater')

    function render (v: unknown): string[] {
      if (v === null || v === undefined) return []
      if (v instanceof Uint8Array) return [toHex(v), bytesToBase64url(v)]
      if (typeof v === 'bigint') return [v.toString()]
      if (typeof v === 'object') {
        try { return [JSON.stringify(v)] } catch { return [String(v)] }
      }
      return [String(v)]
    }

    const rowsScanned: Record<string, number> = {}
    const hits: string[] = []
    const controlFound: Record<string, boolean> = {}
    for (const [name, db] of [['A', pn.dbA], ['B', pn.dbB]] as const) {
      rowsScanned[name] = 0
      controlFound[name] = false
      for (const t of tables) {
        // Table names come only from the schema text above, never from input.
        for await (const row of db.eval('select * from ' + t)) {
          rowsScanned[name] = (rowsScanned[name] ?? 0) + 1
          for (const value of Object.values(row as Record<string, unknown>)) {
            for (const text of render(value)) {
              if (text.includes(ctl)) controlFound[name] = true
              for (const n of needles) {
                if (text.includes(n.value)) hits.push(`${name}:${t}:${n.label}`)
              }
            }
          }
        }
      }
    }
    expect(hits, 'needle hits (table and needle label only)').to.deep.equal([])
    expect(controlFound.A, 'the scanner finds the control marker on node-A').to.equal(true)
    expect(controlFound.B, 'the scanner finds the control marker on node-B').to.equal(true)
    expect(rowsScanned.A! > 0 && rowsScanned.B! > 0, 'rows scanned on both replicas').to.equal(true)
    console.log(`[pm-3] tables ${tables.length} rowsA ${rowsScanned.A} rowsB ${rowsScanned.B} hits 0 control found A,B`)
  })

  it('PM-7 the revocation row replicates to the browser, and a remove request makes the owner removeMachine it', async function () {
    this.timeout(ms(300_000))
    if (c === undefined || cStrand === undefined || ra === undefined) throw new Error('PM-7 needs PM-4 and PM-2d')
    const strandDb = cStrand.db
    const before = await pollUntil(
      async () => await revokedOn(strandDb, B.user.id, pm1Nonce),
      (v) => typeof v === 'boolean',
      { timeoutMs: ms(60_000), label: 'C can read the revocation table' }
    )
    expect(before, 'not revoked yet on C').to.equal(false)

    const t0 = Date.now()
    await revokeDashboardPairing(pn.ctxB, { userId: B.user.id, nonce: pm1Nonce, signer: p256Signer(B) })
    expect(await revokedOn(pn.dbB, B.user.id, pm1Nonce), 'revoked on node-B at once').to.equal(true)
    await pollUntil(async () => await revokedOn(pn.dbA, B.user.id, pm1Nonce), (v) => v === true, { timeoutMs: ms(60_000), label: 'revocation reaches node-A' })
    await pollUntil(async () => await revokedOn(strandDb, B.user.id, pm1Nonce), (v) => v === true, { timeoutMs: ms(90_000), label: 'revocation reaches C' })
    expect(await revokedOn(strandDb, B.user.id, ra.nonce), 'exact-pair lookup: another nonce is not revoked').to.equal(false)
    console.log(`[pm-7] revocation on C after ${Date.now() - t0}`)

    const bControl = harness.nodeB.node.getControlNode()
    const wrong = await send(bControl, harness.nodeB.peerId, await buildRemove(B, pm1Nonce, harness.nodeB.peerId))
    expect(codeOf(wrong), 'a remove naming another machine').to.equal('unknown-pairing')
    expect(await harness.nodeA.node.isAuthorizedMember(harness.nodeB.peerId), 'node-B is still a member').to.equal(true)

    const t1 = Date.now()
    const right = await send(bControl, harness.nodeB.peerId, await buildRemove(B, pm1Nonce, cPeerId))
    expect(codeOf(right)).to.equal('removed')
    expect(right.t === 'removed' && right.peerId === cPeerId, 'the reply names C').to.equal(true)
    expect(lastRemoval?.removedPeer, 'removeMachine removed the CadrePeer row').to.equal(true)
    // node-A's owner-signed tombstone reaches C as the edge node's 'cadre:removed' event (HarnessEdgeMember.removed).
    const member = c
    await pollUntil(async () => member.removed.length, (n) => n >= 1, { timeoutMs: ms(60_000), label: 'C receives cadre:removed' })
    expect((member.removed[0] as any)?.partyId).to.equal(harness.partyId)
    await pollUntil(async () => member.edge.status.state, (s) => s === 'removed', { timeoutMs: ms(60_000), label: 'C edge status removed' })
    expect(await harness.nodeA.node.isAuthorizedMember(cPeerId), 'C is no longer a member').to.equal(false)
    const machines = (await harness.nodeA.node.listMachines()) as any[]
    expect(machines.some((m) => m.peerId === cPeerId), 'C no longer listed').to.equal(false)
    const withdrawnCount = lastRemoval?.withdrawnInvitations?.length ?? 'n/a'
    console.log(`[pm-7] cadre:removed after ${Date.now() - t1}; destroyedScopes ${member.destroyedScopes.length}; withdrawn by removeMachine ${withdrawnCount}`)
  })

  it('PM-7b R-D: a revocation row alone makes the owner remove the browser; rows outside its mint log remove nothing', async function () {
    this.timeout(ms(360_000))
    if (ra === undefined || raReply === undefined) throw new Error('PM-7b needs PM-2d')
    const { makeTestSignCallback } = await import('./fixtures/test-context.js')
    const bControl = harness.nodeB.node.getControlNode()

    // Second browser.
    const b2 = await buildMint(B)
    const mintedB2 = await send(bControl, harness.nodeB.peerId, b2)
    expect(codeOf(mintedB2), 'second mint').to.equal('minted')
    if (mintedB2.t !== 'minted') return
    const pm7bReply = mintedB2
    const pm7bNonce = b2.nonce
    c2 = await startHarnessEdgeMember({ label: 'node-C2', storageId: 'pm-node-c2', strandId: pn.hash, clusterSize: CLUSTER_SIZE, strandReactivity: { edgeHost: true } })
    const c2PeerId = await c2.identityPeerId()
    await c2.edge.joinCadre(cadre.decodeCadreInvitation(pm7bReply.invitation), { relayAddrs: [], signal: AbortSignal.timeout(ms(120_000)) })
    await pollUntil(async () => await harness.nodeA.node.isAuthorizedMember(c2PeerId), (v) => v === true, { timeoutMs: ms(60_000), label: 'node-A sees C2 as a member' })
    const c2Strand = await attachHarnessEdgeStrand(c2, pn.hash)
    await pollUntil(async () => await ports.inviteUsagePeer(pm7bReply.inviteKey), (p) => p === c2PeerId, { timeoutMs: ms(60_000), label: 'node-A maps the C2 inviteKey to C2' })
    const callsAfterMint = calls.length
    const liveBefore = await mintLog.liveMintsFor(B.user.id, Date.now())
    expect(liveBefore.some((e) => e.nonce === ra!.nonce), 'the unredeemed pairing counts as live before its revocation (positive control)').to.equal(true)

    // Negatives first. No remove request is sent in this leg.
    await revokeDashboardPairing(pn.ctxB, { userId: B.user.id, nonce: freshNonce(), signer: p256Signer(B) })
    await revokeDashboardPairing(pn.ctxA, {
      userId: pn.founder.id,
      nonce: pm7bNonce,
      signer: { userId: pn.founder.id, signingPublicKey: pn.founder.activeKeys[0]!.key, sign: makeTestSignCallback(pn.founder) } as any
    })
    await revokeDashboardPairing(pn.ctxB, { userId: B.user.id, nonce: ra.nonce, signer: p256Signer(B) })
    await pollUntil(
      async () => {
        let n = 0
        for await (const _r of pn.dbA.eval('select 1 as x from DashboardPairingRevocation')) n++
        return n
      },
      // The PM-7 row plus the three rows just inserted.
      (n) => n >= 4,
      { timeoutMs: ms(60_000), label: 'the PM-7 row and three new rows on node-A' }
    )
    const first = await sweepRevocationsOnce()
    await sleep(2_000)
    const second = await sweepRevocationsOnce()
    for (const s of [first, second]) {
      console.log(`[pm-obs] sweep ${s.outcomes.map((o) => `${o.label}=${o.outcome}`).join(' ')}`)
      expect(s.outcomes.length, 'four revocation rows swept').to.equal(4)
      expect(outcomeFor(s.outcomes, B.user.id, pm1Nonce), 'the PM-7 pairing is already gone').to.deep.equal(['already-gone'])
      expect(outcomeFor(s.outcomes, pn.founder.id, pm7bNonce), 'a real nonce under another officer').to.deep.equal(['no-mint-entry'])
      expect(outcomeFor(s.outcomes, B.user.id, ra.nonce), 'the unredeemed pairing').to.deep.equal(['unredeemed-revoked'])
      expect(s.outcomes.filter((o) => o.outcome === 'no-mint-entry').length, 'unknown nonce and wrong officer').to.equal(2)
    }
    expect(sweepRemovals, 'no machine removed by the negatives').to.equal(0)
    const live = await mintLog.liveMintsFor(B.user.id, Date.now())
    expect(live.some((e) => e.nonce === ra!.nonce), 'the revoked unredeemed pairing no longer counts as live').to.equal(false)
    const raStatus = ((await harness.nodeA.node.listCadreInvitations()) as any[]).find((s) => s.invite?.key === raReply!.inviteKey)
    expect(raStatus?.withdrawn, 'the unredeemed invitation is withdrawn').to.equal(true)
    expect(await harness.nodeA.node.isAuthorizedMember(harness.nodeB.peerId), 'node-B still a member').to.equal(true)
    expect(await harness.nodeA.node.isAuthorizedMember(c2PeerId), 'C2 still a member').to.equal(true)
    expect(c2.removed.length, 'C2 not removed by the negatives').to.equal(0)
    console.log(`[pm-7b] negatives removals ${sweepRemovals}; withdrawals filed ${sweepWithdrawals}`)

    // Positive: ONLY the revocation row.
    const t0 = Date.now()
    await revokeDashboardPairing(pn.ctxB, { userId: B.user.id, nonce: pm7bNonce, signer: p256Signer(B) })
    expect(await revokedOn(pn.dbB, B.user.id, pm7bNonce), 'revoked on node-B at once').to.equal(true)
    await pollUntil(async () => await revokedOn(c2Strand.db, B.user.id, pm7bNonce), (v) => v === true, { timeoutMs: ms(90_000), label: 'revocation reaches C2' })
    console.log(`[pm-7b] revocation on C2 after ${Date.now() - t0}`)

    const member = c2
    const t1 = Date.now()
    try {
      sweepTimer = setInterval(() => {
        if (sweepInFlight !== null) return
        sweepInFlight = sweepRevocationsOnce()
          .catch((err) => { console.log(`[pm-7b] sweep error ${(err as Error).name}`) })
          .finally(() => { sweepInFlight = null })
      }, 2_000)
      await pollUntil(async () => member.removed.length, (n) => n >= 1, { timeoutMs: ms(90_000), label: 'C2 receives cadre:removed' })
    } finally {
      clearInterval(sweepTimer)
      sweepTimer = undefined
      await sweepInFlight
    }
    expect((member.removed[0] as any)?.partyId).to.equal(harness.partyId)
    await pollUntil(async () => member.edge.status.state, (s) => s === 'removed', { timeoutMs: ms(60_000), label: 'C2 edge status removed' })
    expect(sweepRemovals, 'exactly one sweep removal').to.equal(1)
    expect(calls.length, 'no request of any kind reached the service after the C2 mint').to.equal(callsAfterMint)
    expect(await harness.nodeA.node.isAuthorizedMember(c2PeerId), 'C2 no longer a member').to.equal(false)
    const machines = (await harness.nodeA.node.listMachines()) as any[]
    expect(machines.some((m) => m.peerId === c2PeerId), 'C2 no longer listed').to.equal(false)
    expect(await harness.nodeA.node.isAuthorizedMember(harness.nodeB.peerId), 'node-B still a member').to.equal(true)
    const after = await sweepRevocationsOnce()
    expect(sweepRemovals, 'a later sweep removes nothing more').to.equal(1)
    expect(outcomeFor(after.outcomes, B.user.id, pm7bNonce)).to.deep.equal(['already-gone'])
    console.log(`[pm-7b] cadre:removed by sweep after ${Date.now() - t1}`)
  })

  it('PM-6 with the owner stopped, the officer\'s request fails typed and fast (owner-unreachable input)', async function () {
    this.timeout(ms(120_000))
    // The owner going offline is the case under test, so the service is not detached first.
    await harness.nodeA.node.stop()
    const bControl = harness.nodeB.node.getControlNode()
    await pollUntil(
      async () => (bControl.getConnections() as any[]).filter((conn) => conn.remotePeer.toString() === aControlPeer).length,
      (n) => n === 0,
      { timeoutMs: ms(30_000), label: 'node-B holds no connection to node-A' }
    )
    const req = await buildMint(B)
    const t0 = Date.now()
    let err: unknown = null
    try {
      const reply = await send(bControl, harness.nodeB.peerId, req, 10_000, aAddr)
      console.log(`[pm-6] FINDING a stopped owner answered: ${codeOf(reply)}`)
    } catch (e) {
      err = e
    }
    const elapsed = Date.now() - t0
    expect(err instanceof PairMintTransportError, 'a typed transport failure').to.equal(true)
    const te = err as PairMintTransportError
    expect(['dial-failed', 'timeout']).to.include(te.reason)
    expect(te.requestSent, 'requestSent').to.equal(false)
    expect(elapsed <= 15_000 * SCALE, `within the client timeout plus 5 s (${elapsed} ms)`).to.equal(true)
    console.log(`[pm-6] owner offline ${te.reason} after ${elapsed}`)
  })
})
