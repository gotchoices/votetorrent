// pair-mint-service.spec.ts — the owner-side mint policy over fake ports: every refusal code, the
// check order, concurrency, remove authorization and bearer hygiene.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'chai'
import {
  PAIR_MINT_CLOCK_SKEW_MS,
  PAIR_MINT_MAX_LIVE_PER_OFFICER,
  PAIR_MINT_PEER_REQUESTS_PER_MINUTE,
  PAIR_MINT_WINDOW_MS,
  createPairMintService,
  type PairMintLogEntry,
  type PairMintPorts
} from '../src/pairing/pair-mint-service.js'
import type { PairMintMintRequest, PairMintRemoveRequest, PairMintReply } from '../src/pairing/pair-wire.js'
import { toCanonicalDatetime } from '../src/utils.js'

const START = Date.UTC(2030, 0, 1, 12, 0, 0)
const PRE_REPLAY_REFUSALS = new Set(['refused:switched-off', 'refused:expired', 'refused:requester-mismatch'])
const allLogs: PairMintLogEntry[][] = []
let consoleCalls = 0

/** Run fn with console stubbed, counting any call. */
async function quiet<T> (fn: () => Promise<T>): Promise<T> {
  const names = ['log', 'info', 'warn', 'error', 'debug'] as const
  const saved = names.map(n => console[n])
  for (const n of names) console[n] = (() => { consoleCalls++ }) as never
  try { return await fn() } finally { names.forEach((n, i) => { console[n] = saved[i] as never }) }
}

let counter = 0
function nonce (): string { counter++; return `Nonce${String(counter).padStart(8, '0')}xxxx` }

interface Rig {
  ports: PairMintPorts
  clock: { t: number }
  log: PairMintLogEntry[]
  usage: Map<string, string>
  calls: Record<string, number>
  state: { enabled: boolean, allowed: Set<string>, current: boolean, verdict: Awaited<ReturnType<PairMintPorts['verifyStatement']>>, removeOk: boolean }
  seenCurrentArgs: Array<[string, string]>
  removed: string[]
  invitations: number
}

function makeRig (over: Partial<PairMintPorts> = {}): Rig {
  const clock = { t: START }
  const log: PairMintLogEntry[] = []
  allLogs.push(log)
  const usage = new Map<string, string>()
  const calls: Record<string, number> = {}
  const bump = (k: string): void => { calls[k] = (calls[k] ?? 0) + 1 }
  const rig = {
    clock,
    log,
    usage,
    calls,
    state: { enabled: true, allowed: new Set(['peerA', 'peerB']), current: true, verdict: { ok: true } as never, removeOk: true },
    seenCurrentArgs: [] as Array<[string, string]>,
    removed: [] as string[],
    invitations: 0
  } as unknown as Rig
  rig.ports = {
    isAllowed: (p) => { bump('isAllowed'); return rig.state.allowed.has(p) },
    isEnabled: () => { bump('isEnabled'); return rig.state.enabled },
    now: () => clock.t,
    createInvitation: async (o) => {
      bump('createInvitation')
      rig.invitations++
      return {
        encoded: `sereus-invite:1.SECRETMARK-${rig.invitations}`,
        inviteKey: `ik-${rig.invitations}`,
        expiresAt: toCanonicalDatetime(clock.t + o.expiresInMs)
      }
    },
    isCurrentOfficer: async (u, n) => { bump('isCurrentOfficer'); rig.seenCurrentArgs.push([u, n]); return rig.state.current },
    verifyStatement: async () => { bump('verifyStatement'); return rig.state.verdict },
    verifyRemove: async () => { bump('verifyRemove'); return rig.state.removeOk },
    inviteUsagePeer: async (k) => { bump('inviteUsagePeer'); return usage.get(k) ?? null },
    removeMachine: async (p) => { bump('removeMachine'); rig.removed.push(p) },
    mintLog: {
      hasNonce: async (n) => { bump('hasNonce'); return log.some(e => e.nonce === n && !PRE_REPLAY_REFUSALS.has(e.outcome)) },
      record: async (e) => { bump('record'); log.push(e) },
      findByNonce: async (n) => log.find(e => e.nonce === n && e.outcome === 'approved') ?? log.find(e => e.nonce === n) ?? null,
      liveMintsFor: async (u, nowMs) => log.filter(e => e.userId === u && e.outcome === 'approved' && Date.parse(String(e.expiresAt) + 'Z') > nowMs)
    },
    ...over
  }
  return rig
}

function mintReq (rig: Rig, over: Partial<PairMintMintRequest> = {}): PairMintMintRequest {
  return {
    t: 'mint',
    v: 1,
    networkHash: 'a'.repeat(64),
    userId: 'user-1',
    nonce: nonce(),
    expiresAt: toCanonicalDatetime(rig.clock.t + 10 * 60_000),
    requesterPeerId: 'peerA',
    keyPub: '02' + 'ab'.repeat(32),
    sig: 'cd'.repeat(64),
    ...over
  }
}

function removeReq (rig: Rig, over: Partial<PairMintRemoveRequest> = {}): PairMintRemoveRequest {
  return {
    t: 'remove',
    v: 1,
    networkHash: 'a'.repeat(64),
    userId: 'user-1',
    nonce: 'RemoveNonce000000',
    peerId: 'peerM',
    expiresAt: toCanonicalDatetime(rig.clock.t + 10 * 60_000),
    keyPub: '02' + 'ab'.repeat(32),
    sig: 'cd'.repeat(64),
    ...over
  }
}

const svcOf = (rig: Rig): ReturnType<typeof createPairMintService> => createPairMintService(rig.ports)
async function send (svc: ReturnType<typeof createPairMintService>, from: string, body: unknown): Promise<PairMintReply> {
  return await quiet(async () => await svc.handle(from, body))
}
const code = (r: PairMintReply): string => r.t === 'refused' ? r.code : r.t

function seedApproved (rig: Rig, over: Partial<PairMintLogEntry> = {}): PairMintLogEntry {
  const e: PairMintLogEntry = {
    nonce: 'RemoveNonce000000',
    userId: 'user-1',
    inviteKey: 'ik-r',
    at: rig.clock.t,
    expiresAt: toCanonicalDatetime(rig.clock.t + 5 * 60_000),
    outcome: 'approved',
    ...over
  }
  rig.log.push(e)
  return e
}

describe('pair-mint-service', function () {
  it('constants are the documented values', () => {
    expect(PAIR_MINT_WINDOW_MS).to.equal(15 * 60_000)
    expect(PAIR_MINT_CLOCK_SKEW_MS).to.equal(120_000)
    expect(PAIR_MINT_MAX_LIVE_PER_OFFICER).to.equal(3)
    expect(PAIR_MINT_PEER_REQUESTS_PER_MINUTE).to.equal(6)
  })

  it('V-1 a valid mint is approved once, logged, and the invitation dies with the statement', async () => {
    const rig = makeRig()
    const req = mintReq(rig)
    const reply = await send(svcOf(rig), 'peerA', req)
    expect(reply.t).to.equal('minted')
    if (reply.t !== 'minted') return
    expect(reply.invitation).to.contain('SECRETMARK')
    expect(rig.calls.createInvitation).to.equal(1)
    expect(rig.log).to.have.length(1)
    expect(rig.log[0]).to.deep.include({ outcome: 'approved', inviteKey: reply.inviteKey, at: START, expiresAt: reply.expiresAt, nonce: req.nonce })
    const expiresInMs = Date.parse(reply.expiresAt + 'Z') - START
    expect(expiresInMs).to.be.greaterThan(0)
    expect(expiresInMs).to.be.at.most(PAIR_MINT_WINDOW_MS + PAIR_MINT_CLOCK_SKEW_MS)
  })

  it('V-2 a non-member and an empty caller are refused not-officer and not recorded; a key problem is recorded', async () => {
    const rig = makeRig()
    const svc = svcOf(rig)
    expect(code(await send(svc, 'stranger', mintReq(rig)))).to.equal('not-officer')
    expect(code(await send(svc, '', mintReq(rig)))).to.equal('not-officer')
    expect(rig.log).to.have.length(0)
    expect(rig.calls.isEnabled).to.equal(undefined)
    expect(rig.calls.verifyStatement).to.equal(undefined)

    for (const reason of ['not-officer', 'key-not-current'] as const) {
      rig.state.verdict = { ok: false, reason }
      expect(code(await send(svc, 'peerA', mintReq(rig)))).to.equal('not-officer')
    }
    expect(rig.log.map(e => e.outcome)).to.deep.equal(['refused:not-officer', 'refused:not-officer'])
    expect(rig.calls.createInvitation).to.equal(undefined)
  })

  it('V-2b a former officer (port false, or throwing) is refused not-officer before any signature work; remove is not gated', async () => {
    const rig = makeRig()
    rig.state.current = false
    const svc = svcOf(rig)
    expect(code(await send(svc, 'peerA', mintReq(rig)))).to.equal('not-officer')
    expect(rig.log.map(e => e.outcome)).to.deep.equal(['refused:not-officer'])
    expect(rig.calls.verifyStatement).to.equal(undefined)
    expect(rig.calls.createInvitation).to.equal(undefined)
    expect(rig.seenCurrentArgs[0]).to.deep.equal(['user-1', toCanonicalDatetime(START)])

    const throwing = makeRig({ isCurrentOfficer: async () => { throw new Error('store down') } })
    expect(code(await send(svcOf(throwing), 'peerA', mintReq(throwing)))).to.equal('not-officer')
    expect(throwing.calls.verifyStatement).to.equal(undefined)

    // removal is not gated on current membership (the port stays false here)
    seedApproved(rig)
    rig.usage.set('ik-r', 'peerM')
    expect((await send(svc, 'peerA', removeReq(rig))).t).to.equal('removed')
  })

  it('V-17 a statement sent from another peer is requester-mismatch, burns no nonce and cannot be replayed away', async () => {
    const rig = makeRig()
    const svc = svcOf(rig)
    const req = mintReq(rig, { requesterPeerId: 'peerA' })
    expect(code(await send(svc, 'peerB', req))).to.equal('requester-mismatch')
    expect(rig.log.map(e => e.outcome)).to.deep.equal(['refused:requester-mismatch'])
    expect(rig.calls.hasNonce).to.equal(undefined)
    expect(rig.calls.isCurrentOfficer).to.equal(undefined)
    expect(rig.calls.verifyStatement).to.equal(undefined)
    expect(rig.calls.createInvitation).to.equal(undefined)
    // the same request from its own requester is minted: the mismatch spent nothing
    expect((await send(svc, 'peerA', req)).t).to.equal('minted')
    // and replayed from the other peer it is a mismatch, never a second invitation
    expect(code(await send(svc, 'peerB', req))).to.equal('requester-mismatch')
    expect(rig.invitations).to.equal(1)
  })

  it('V-3 a switched-off owner refuses mints, but still honours a remove', async () => {
    const rig = makeRig()
    rig.state.enabled = false
    const svc = svcOf(rig)
    expect(code(await send(svc, 'peerA', mintReq(rig)))).to.equal('switched-off')
    expect(rig.log.map(e => e.outcome)).to.deep.equal(['refused:switched-off'])
    expect(rig.calls.verifyStatement).to.equal(undefined)
    seedApproved(rig)
    rig.usage.set('ik-r', 'peerM')
    expect((await send(svc, 'peerA', removeReq(rig))).t).to.equal('removed')
  })

  it('V-4 an expired or far-future statement is expired before any signature check', async () => {
    const rig = makeRig()
    const svc = svcOf(rig)
    expect(code(await send(svc, 'peerA', mintReq(rig, { expiresAt: toCanonicalDatetime(START) })))).to.equal('expired')
    expect(code(await send(svc, 'peerA', mintReq(rig, { expiresAt: toCanonicalDatetime(START - 60_000) })))).to.equal('expired')
    const tooFar = START + PAIR_MINT_WINDOW_MS + PAIR_MINT_CLOCK_SKEW_MS + 60_000
    expect(code(await send(svc, 'peerA', mintReq(rig, { expiresAt: toCanonicalDatetime(tooFar) })))).to.equal('expired')
    expect(rig.calls.verifyStatement).to.equal(undefined)
    rig.state.verdict = { ok: false, reason: 'expired' }
    expect(code(await send(svc, 'peerA', mintReq(rig)))).to.equal('expired')
    expect(rig.calls.verifyStatement).to.equal(1)
  })

  it('V-5 a nonce works once; a fresh service over the same log and two concurrent requests agree', async () => {
    const rig = makeRig()
    const svc = svcOf(rig)
    const req = mintReq(rig)
    expect((await send(svc, 'peerA', req)).t).to.equal('minted')
    expect(code(await send(svc, 'peerA', req))).to.equal('replayed')
    expect(rig.calls.createInvitation).to.equal(1)
    expect(rig.log).to.have.length(1)

    expect(code(await send(svcOf(rig), 'peerA', req))).to.equal('replayed')

    const rig2 = makeRig()
    const svc2 = svcOf(rig2)
    const dup = mintReq(rig2)
    const both = await quiet(async () => await Promise.all([svc2.handle('peerA', dup), svc2.handle('peerA', dup)]))
    expect(both.map(code).sort()).to.deep.equal(['minted', 'replayed'])
    expect(rig2.calls.createInvitation).to.equal(1)
  })

  it('V-6 a bad signature is refused for both a mint and a remove', async () => {
    const rig = makeRig()
    rig.state.verdict = { ok: false, reason: 'bad-signature' }
    const svc = svcOf(rig)
    expect(code(await send(svc, 'peerA', mintReq(rig)))).to.equal('bad-signature')
    expect(rig.log.map(e => e.outcome)).to.deep.equal(['refused:bad-signature'])
    rig.state.removeOk = false
    expect(code(await send(svc, 'peerA', removeReq(rig)))).to.equal('bad-signature')
  })

  it('V-7 a fourth live unredeemed mint is rate-limited; a redeemed or expired one frees a slot', async () => {
    const rig = makeRig()
    const svc = svcOf(rig)
    for (let i = 0; i < 3; i++) expect((await send(svc, 'peerA', mintReq(rig))).t).to.equal('minted')
    expect(code(await send(svc, 'peerA', mintReq(rig)))).to.equal('rate-limited')
    expect(rig.log[rig.log.length - 1]!.outcome).to.equal('refused:rate-limited')
    expect(rig.invitations).to.equal(3)

    rig.usage.set('ik-1', 'peerZ')
    expect((await send(svc, 'peerA', mintReq(rig))).t).to.equal('minted')

    const rig2 = makeRig()
    const svc2 = svcOf(rig2)
    expect((await send(svc2, 'peerA', mintReq(rig2, { expiresAt: toCanonicalDatetime(START + 2 * 60_000) }))).t).to.equal('minted')
    expect((await send(svc2, 'peerA', mintReq(rig2))).t).to.equal('minted')
    expect((await send(svc2, 'peerA', mintReq(rig2))).t).to.equal('minted')
    rig2.clock.t = START + 3 * 60_000
    expect((await send(svc2, 'peerA', mintReq(rig2))).t).to.equal('minted')
  })

  it('V-8 a seventh request in a minute from one caller is rate-limited, unrecorded, and calls no further port', async () => {
    const rig = makeRig()
    const svc = svcOf(rig)
    for (let i = 0; i < PAIR_MINT_PEER_REQUESTS_PER_MINUTE; i++) expect(code(await send(svc, 'peerA', { junk: i }))).to.equal('malformed')
    const calls = rig.calls.isAllowed
    expect(code(await send(svc, 'peerA', mintReq(rig)))).to.equal('rate-limited')
    expect(rig.log).to.have.length(0)
    expect(rig.calls.isEnabled).to.equal(undefined)
    expect(rig.calls.isAllowed).to.equal((calls ?? 0) + 1)
    expect(code(await send(svc, 'peerB', { junk: 1 }))).to.equal('malformed')
    rig.clock.t += 61_000
    expect(code(await send(svc, 'peerA', { junk: 1 }))).to.equal('malformed')
  })

  it('V-9 an unreachable mint is recorded unreachable; an unlogged mint is never released', async () => {
    const rig = makeRig({ createInvitation: async () => { throw new Error('node down') } })
    const svc = svcOf(rig)
    expect(code(await send(svc, 'peerA', mintReq(rig)))).to.equal('not-reachable')
    expect(rig.log).to.have.length(1)
    expect(rig.log[0]).to.deep.include({ outcome: 'unreachable', inviteKey: null, expiresAt: null })

    const base = makeRig()
    let n = 0
    const lossy = makeRig({
      createInvitation: base.ports.createInvitation,
      mintLog: { ...base.ports.mintLog, record: async () => { n++; throw new Error('disk full') } }
    })
    const reply = await send(svcOf(lossy), 'peerA', mintReq(lossy))
    expect(reply).to.deep.equal({ t: 'refused', v: 1, code: 'not-reachable' })
    expect('invitation' in reply).to.equal(false)
    expect(n).to.equal(1)
  })

  it('V-10 not-owner from minting or from removing maps to not-owner', async () => {
    const rig = makeRig({ createInvitation: async () => { throw Object.assign(new Error('x'), { reason: 'not-owner' }) } })
    expect(code(await send(svcOf(rig), 'peerA', mintReq(rig)))).to.equal('not-owner')
    expect(rig.log.map(e => e.outcome)).to.deep.equal(['refused:not-owner'])

    const rig2 = makeRig({ removeMachine: async () => { throw Object.assign(new Error('x'), { reason: 'not-owner' }) } })
    seedApproved(rig2)
    rig2.usage.set('ik-r', 'peerM')
    expect(code(await send(svcOf(rig2), 'peerA', removeReq(rig2)))).to.equal('not-owner')

    const rig3 = makeRig({ removeMachine: async () => { throw new Error('boom') } })
    seedApproved(rig3)
    rig3.usage.set('ik-r', 'peerM')
    expect(code(await send(svcOf(rig3), 'peerA', removeReq(rig3)))).to.equal('not-reachable')
  })

  it('V-11 a remove with no matching mint-log and usage trail is unknown-pairing and removes nothing', async () => {
    const cases: Array<(rig: Rig) => void> = [
      () => undefined,
      (rig) => { seedApproved(rig, { userId: 'user-2' }); rig.usage.set('ik-r', 'peerM') },
      (rig) => { seedApproved(rig, { outcome: 'refused:rate-limited', inviteKey: null }); rig.usage.set('ik-r', 'peerM') },
      (rig) => { seedApproved(rig); rig.usage.set('ik-r', 'peerOther') },
      (rig) => { seedApproved(rig) }
    ]
    for (const setup of cases) {
      const rig = makeRig()
      setup(rig)
      expect(code(await send(svcOf(rig), 'peerA', removeReq(rig)))).to.equal('unknown-pairing')
      expect(rig.calls.removeMachine).to.equal(undefined)
    }
  })

  it('V-12 a remove that the log and the usage row both back removes that machine once', async () => {
    const rig = makeRig()
    seedApproved(rig)
    rig.usage.set('ik-r', 'peerM')
    const reply = await send(svcOf(rig), 'peerA', removeReq(rig))
    expect(reply).to.deep.equal({ t: 'removed', v: 1, peerId: 'peerM' })
    expect(rig.removed).to.deep.equal(['peerM'])
    expect(rig.log).to.have.length(1)
  })

  it('V-13 a body that is not a request is malformed and unrecorded', async () => {
    const rig = makeRig()
    const svc = svcOf(rig)
    expect(code(await send(svc, 'peerA', 'junk'))).to.equal('malformed')
    expect(code(await send(svc, 'peerA', { ...mintReq(rig), extra: 1 }))).to.equal('malformed')
    expect(rig.log).to.have.length(0)
  })

  it('V-14 the refusal order is switch, window, requester, replay, current officer, signature', async () => {
    const rig = makeRig()
    const svc = svcOf(rig)
    rig.state.enabled = false
    const lapsed = toCanonicalDatetime(START - 60_000)
    expect(code(await send(svc, 'peerA', mintReq(rig, { expiresAt: lapsed })))).to.equal('switched-off')
    rig.state.enabled = true

    rig.state.verdict = { ok: false, reason: 'bad-signature' }
    expect(code(await send(svc, 'peerA', mintReq(rig, { expiresAt: lapsed })))).to.equal('expired')
    expect(code(await send(svc, 'peerB', mintReq(rig, { expiresAt: lapsed })))).to.equal('expired')
    expect(rig.calls.verifyStatement).to.equal(undefined)

    const mismatched = mintReq(rig, { requesterPeerId: 'peerA' })
    expect(code(await send(svc, 'peerB', mismatched))).to.equal('requester-mismatch')

    rig.state.verdict = { ok: true }
    const first = mintReq(rig)
    expect((await send(svc, 'peerA', first)).t).to.equal('minted')
    rig.state.verdict = { ok: false, reason: 'bad-signature' }
    expect(code(await send(svc, 'peerA', first))).to.equal('replayed')

    rig.state.current = false
    const before = rig.calls.verifyStatement ?? 0
    expect(code(await send(svc, 'peerA', mintReq(rig)))).to.equal('not-officer')
    expect(rig.calls.verifyStatement ?? 0).to.equal(before)
  })

  it('V-15 after close every request is switched-off and no port is called', async () => {
    const rig = makeRig()
    const svc = svcOf(rig)
    await svc.close()
    expect(code(await send(svc, 'peerA', mintReq(rig)))).to.equal('switched-off')
    expect(Object.keys(rig.calls)).to.deep.equal([])
  })

  describe('hygiene', () => {
    it('V-16 nothing logged, nothing in any entry, and the source has no console, driver or store access', () => {
      expect(consoleCalls).to.equal(0)
      expect(JSON.stringify(allLogs)).to.not.contain('SECRETMARK')
      const file = join(dirname(fileURLToPath(import.meta.url)), '../src/pairing/pair-mint-service.ts')
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
      expect(code).to.not.match(/console\.|cadre-core|\.exec\(|\.prepare\(|insert into|\bBuffer\b/)
      expect(code).to.contain('parsePairMintRequest')
    })
  })
})
