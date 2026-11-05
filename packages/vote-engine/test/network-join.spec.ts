/**
 * network-join.spec.ts — spike 100: a voter joins an authority's network from a join code.
 *
 *   JC — join-code.ts: round trip, tolerance of pasted whitespace, strict refusal of everything else.
 *   FA — NetworksEngine.getFoundingAnchor: the same digest/fingerprint a founding bundle carries.
 *   JS — NetworksEngine.joinFromStrand: accepts replicated founding rows that hash to the code's
 *        digest; never replays them; never opens anything with no peer connected.
 *   JN — joinNetwork orchestration over a fake cadre node and a fake engine.
 */
import { expect } from 'chai'
import { Database } from '@quereus/quereus'
import type { JoinFromStrandOptions, JoinFromStrandResult, LocalStorage, NetworkJoinAnchor, User } from '@votetorrent/vote-core'
import { NetworksEngine } from '../src/networks/networks-engine.js'
import { prepareDb } from '../src/database/initialize.js'
import { foundingBundleFingerprint } from '../src/networks/founding-bundle.js'
import { FOUNDING_BUNDLE_TABLE_ORDER } from '../src/networks/genesis-rows.js'
import { decodeNetworkJoinCode, encodeNetworkJoinCode, NETWORK_JOIN_CODE_PREFIX, type NetworkJoinCode } from '../src/networks/join-code.js'
import { joinNetwork, type NetworkJoinOptions, type NetworkJoinStep } from '../src/networks/network-join.js'
import type { DbFactory } from '../src/types.js'
import { createTestNetwork, makeTestSignCallback } from './fixtures/test-context.js'
import { mintInvitation, randomCadreInvitation, randomJoinAnchor } from './fixtures/join-code-fixtures.js'

function makeDeviceLocalStorage (): LocalStorage {
  const store = new Map<string, unknown>()
  return {
    async getItem<T> (key: string): Promise<T | undefined> { return store.has(key) ? (store.get(key) as T) : undefined },
    async setItem<T> (key: string, value: T): Promise<void> { store.set(key, value) },
    async removeItem (key: string): Promise<void> { store.delete(key) },
    async clear (): Promise<void> { store.clear() }
  }
}

/** A base64url digest of 32 bytes, distinct per seed. */
function fakeDigest (seed: number): string {
  let s = ''
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  for (let i = 0; i < 43; i++) s += alphabet[(i * 7 + seed) % 64]
  return s
}

function sampleCode (overrides: Partial<NetworkJoinCode> = {}): NetworkJoinCode {
  return {
    v: 1,
    invitation: 'eyJ2IjoxfQ',
    networkHash: 'a1b2c3d4e5f60718',
    name: 'Utah County Elections',
    genesis: { userId: 'user-1', signerKey: '02abcdef', authorityId: 'auth-1', adminEffectiveAt: '2026-10-12T10:00:00' },
    digest: fakeDigest(1),
    ...overrides
  }
}

/** Encode an arbitrary object as a join code, bypassing the encoder's own shape. */
function rawCode (obj: unknown): string {
  const json = JSON.stringify(obj)
  return NETWORK_JOIN_CODE_PREFIX + btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

describe('spike 100: network join code (JC)', () => {
  it('JC-1 round-trips, and reports the founding fingerprint of the digest', () => {
    const code = sampleCode()
    const text = encodeNetworkJoinCode(code)
    expect(text.startsWith(NETWORK_JOIN_CODE_PREFIX)).to.equal(true)
    expect(text).to.match(/^vtjoin1\.[A-Za-z0-9_-]+$/)
    const decoded = decodeNetworkJoinCode(text)
    expect(decoded).to.deep.equal({ ok: true, code, fingerprint: foundingBundleFingerprint(code.digest) })
  })

  it('JC-2 a non-ASCII network name survives (the wire form stays pure ASCII)', () => {
    const code = sampleCode({ name: 'Élections — Zürich 選挙 🗳' })
    const decoded = decodeNetworkJoinCode(encodeNetworkJoinCode(code))
    expect(decoded.ok && decoded.code.name).to.equal(code.name)
  })

  it('JC-3 tolerates surrounding whitespace and line breaks a chat app may insert', () => {
    const text = encodeNetworkJoinCode(sampleCode())
    const mangled = `  \n${text.slice(0, 40)}\n${text.slice(40, 90)} \r\n${text.slice(90)}\t `
    expect(decodeNetworkJoinCode(mangled).ok).to.equal(true)
  })

  it('JC-4 refuses anything but the encoder\'s exact shape as malformed', () => {
    const good = sampleCode()
    const cases: Array<[string, unknown]> = [
      ['not a string', 42],
      ['v2 prefix over a v1 body', 'vtjoin2.' + encodeNetworkJoinCode(good).slice(NETWORK_JOIN_CODE_PREFIX.length)],
      ['bad alphabet', NETWORK_JOIN_CODE_PREFIX + 'abc$def'],
      ['not JSON', rawCode('x').replace(/.$/, '') + '!'],
      ['an array', rawCode([1, 2])],
      ['extra key', rawCode({ ...good, extra: 1 })],
      ['missing digest', rawCode({ ...good, digest: undefined })],
      ['empty invitation', rawCode({ ...good, invitation: '' })],
      ['genesis key missing', rawCode({ ...good, genesis: { ...good.genesis, signerKey: undefined } })],
      ['genesis extra key', rawCode({ ...good, genesis: { ...good.genesis, x: 'y' } })],
      ['digest too short to fingerprint', rawCode({ ...good, digest: 'AAAA' })],
      ['name too long', rawCode({ ...good, name: 'n'.repeat(300) })],
      ['v missing', rawCode({ ...good, v: undefined })],
      ['huge input', NETWORK_JOIN_CODE_PREFIX + 'A'.repeat(20_000)]
    ]
    for (const [label, input] of cases) {
      expect(decodeNetworkJoinCode(input), label).to.deep.equal({ ok: false, reason: 'malformed' })
    }
  })

  it('JC-5 a code from a newer encoder is unsupported-version, not malformed', () => {
    expect(decodeNetworkJoinCode(rawCode({ ...sampleCode(), v: 2 }))).to.deep.equal({ ok: false, reason: 'unsupported-version' })
  })

  it('JC-6 text that is not a join code is not-join-code', () => {
    const noPrefix = encodeNetworkJoinCode(sampleCode()).slice(NETWORK_JOIN_CODE_PREFIX.length)
    for (const input of [noPrefix, '', 'hello']) {
      expect(decodeNetworkJoinCode(input)).to.deep.equal({ ok: false, reason: 'not-join-code' })
    }
  })

  it('JC-7 vtjoin<N>. with N not 1 or 2 is unsupported-version', () => {
    const v1Body = encodeNetworkJoinCode(sampleCode()).slice(NETWORK_JOIN_CODE_PREFIX.length)
    for (const input of ['vtjoin3.' + v1Body, 'vtjoin10.abc']) {
      expect(decodeNetworkJoinCode(input)).to.deep.equal({ ok: false, reason: 'unsupported-version' })
    }
  })
})

describe('spike 100: NetworksEngine.getFoundingAnchor (FA)', () => {
  it('FA-1 matches the digest and fingerprint exportFoundingBundle produces for the same network', async () => {
    const net = await createTestNetwork()
    const founder = { userId: net.user.id, signerKey: net.user.activeKeys[0]!.key }
    const anchor = await net.networksEngine.getFoundingAnchor(net.ref.hash, founder)
    const exported = await net.networksEngine.exportFoundingBundle(net.ref.hash, { ...founder, sign: makeTestSignCallback(net.user) })
    expect(anchor.digest).to.equal(exported.bundle.digest)
    expect(anchor.fingerprint).to.equal(exported.fingerprint)
    expect(anchor.networkHash).to.equal(net.ref.hash)
    expect(anchor.name).to.equal(exported.bundle.descriptor.name)
    expect(anchor.genesis).to.deep.equal({
      userId: String(exported.bundle.rows.User[0]!.Id),
      signerKey: String(exported.bundle.rows.UserKey[0]!.PubKey),
      authorityId: String(exported.bundle.rows.Authority[0]!.Id),
      adminEffectiveAt: String(exported.bundle.rows.Admin[0]!.EffectiveAt)
    })
  })

  it('FA-2 refuses a network this engine has not opened (network-not-open)', async () => {
    const net = await createTestNetwork()
    let caught: unknown
    try {
      await net.networksEngine.getFoundingAnchor('0000000000000000', { userId: net.user.id, signerKey: net.user.activeKeys[0]!.key })
    } catch (e) { caught = e }
    expect((caught as { code?: string })?.code).to.equal('network-not-open')
  })

  it('FA-3 refuses a user who is not the founding officer (not-founding-officer)', async () => {
    const net = await createTestNetwork()
    let caught: unknown
    try {
      await net.networksEngine.getFoundingAnchor(net.ref.hash, { userId: 'someone-else', signerKey: net.user.activeKeys[0]!.key })
    } catch (e) { caught = e }
    expect((caught as { code?: string })?.code).to.equal('not-founding-officer')
  })
})

describe('spike 100: NetworksEngine.joinFromStrand (JS)', () => {
  /** The authority's network, and a database standing in for the voter's replicated strand copy. */
  async function authorityAndReplica () {
    const net = await createTestNetwork()
    const founder = { userId: net.user.id, signerKey: net.user.activeKeys[0]!.key }
    const anchor = await net.networksEngine.getFoundingAnchor(net.ref.hash, founder)
    // "Replication": a second device imports the founding rows; its database is what the
    // voter's strand would hold once synced. (Import replays; joinFromStrand never does.)
    const exported = await net.networksEngine.exportFoundingBundle(net.ref.hash, { ...founder, sign: makeTestSignCallback(net.user) })
    const replicaFactoryDbs: Database[] = []
    const replicaEngine = new NetworksEngine(makeDeviceLocalStorage(), async () => {
      const db = new Database(); replicaFactoryDbs.push(db); return db
    })
    const imported = await replicaEngine.importFoundingBundle(exported.text, undefined, { expectedFingerprint: exported.fingerprint })
    if (!imported.ok) throw new Error('fixture: replica import failed')
    return { net, anchor, replicaDb: replicaFactoryDbs[0]! }
  }

  function recordingFactory (db: () => Promise<Database>) {
    const calls: string[] = []
    const factory: DbFactory = async (hash: string) => { calls.push(hash); return db() }
    return { factory, calls }
  }

  const peers = (n: number): JoinFromStrandOptions => ({ getPeerCount: () => n, timeoutMs: 1_000, pollMs: 20 })

  it('JS-1 replicated founding rows that hash to the digest: joined, recorded as recent, opened', async () => {
    const { anchor, replicaDb } = await authorityAndReplica()
    const { factory, calls } = recordingFactory(async () => replicaDb)
    const storage = makeDeviceLocalStorage()
    const voter = new NetworksEngine(storage, factory)
    let verifying = 0
    const result = await voter.joinFromStrand(anchor, undefined, { ...peers(1), onVerifying: () => { verifying++ } })
    expect(result.ok, JSON.stringify(result)).to.equal(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.outcome).to.equal('joined')
    expect(result.fingerprint).to.equal(anchor.fingerprint)
    expect(result.networkRef.hash).to.equal(anchor.networkHash)
    expect(result.networkRef.name).to.equal(anchor.name)
    expect(calls).to.deep.equal([anchor.networkHash])
    expect(verifying).to.equal(1)
    expect((await voter.getRecentNetworks()).map(r => r.hash)).to.deep.equal([anchor.networkHash])
    expect(voter.getEstablishedContext(anchor.networkHash)).to.not.equal(undefined)
  })

  it('JS-2 a second call is already-joined and opens nothing', async () => {
    const { anchor, replicaDb } = await authorityAndReplica()
    const { factory, calls } = recordingFactory(async () => replicaDb)
    const voter = new NetworksEngine(makeDeviceLocalStorage(), factory)
    expect((await voter.joinFromStrand(anchor, undefined, peers(1))).ok).to.equal(true)
    const again = await voter.joinFromStrand(anchor, undefined, peers(1))
    expect(again.ok && again.outcome).to.equal('already-joined')
    expect(calls).to.have.lengthOf(1)
  })

  it('JS-3 no peer connected: no-peers (retryable) BEFORE any DbFactory call', async () => {
    const { anchor, replicaDb } = await authorityAndReplica()
    const { factory, calls } = recordingFactory(async () => replicaDb)
    const voter = new NetworksEngine(makeDeviceLocalStorage(), factory)
    const result = await voter.joinFromStrand(anchor, undefined, peers(0))
    expect(result).to.deep.include({ ok: false, reason: 'no-peers', retryable: true })
    expect(calls).to.deep.equal([])
    expect(await voter.getRecentNetworks()).to.deep.equal([])
  })

  it('JS-4 rows not replicated yet: not-synced (retryable) and NOTHING is written — no founding row, no recent network', async () => {
    const { anchor } = await authorityAndReplica()
    const empty = new Database()
    await prepareDb(empty)
    // The engine owns (and closes) a non-strand handle it declines; keep this one readable.
    let closed = 0
    ;(empty as unknown as { close: () => Promise<void> }).close = async () => { closed++ }
    const { factory } = recordingFactory(async () => empty)
    const voter = new NetworksEngine(makeDeviceLocalStorage(), factory)
    const started = Date.now()
    const result = await voter.joinFromStrand(anchor, undefined, { getPeerCount: () => 1, timeoutMs: 300, pollMs: 20 })
    expect(result).to.deep.include({ ok: false, reason: 'not-synced', retryable: true })
    expect(Date.now() - started).to.be.at.least(250)
    for (const table of FOUNDING_BUNDLE_TABLE_ORDER) {
      const row = await empty.prepare(`select count(*) as n from ${table}`).get({})
      expect(Number((row as { n: unknown }).n), `${table} rows`).to.equal(0)
    }
    expect(await voter.getRecentNetworks()).to.deep.equal([])
    expect(voter.getEstablishedContext(anchor.networkHash)).to.equal(undefined)
    expect(closed, 'the declined handle is released').to.equal(1)
  })

  it('JS-7 (UAT 65 F1) a strand open that never settles ends at the call\'s deadline as not-synced (retryable)', async () => {
    const { anchor } = await authorityAndReplica()
    const { factory, calls } = recordingFactory(() => new Promise<Database>(() => undefined))
    const voter = new NetworksEngine(makeDeviceLocalStorage(), factory)
    const started = Date.now()
    const result = await voter.joinFromStrand(anchor, undefined, { getPeerCount: () => 1, timeoutMs: 150, pollMs: 20 })
    expect(result).to.deep.include({ ok: false, reason: 'not-synced', retryable: true })
    expect(Date.now() - started).to.be.within(140, 2_000)
    expect(calls).to.deep.equal([anchor.networkHash])
    expect(await voter.getRecentNetworks()).to.deep.equal([])
  })

  it('JS-5 the code names a different digest: digest-mismatch (not retryable), nothing recorded', async () => {
    const { anchor, replicaDb } = await authorityAndReplica()
    const { factory } = recordingFactory(async () => replicaDb)
    const voter = new NetworksEngine(makeDeviceLocalStorage(), factory)
    const forged: NetworkJoinAnchor = { ...anchor, digest: fakeDigest(9) }
    const result = await voter.joinFromStrand(forged, undefined, peers(1))
    expect(result).to.deep.include({ ok: false, reason: 'digest-mismatch', retryable: false })
    expect(await voter.getRecentNetworks()).to.deep.equal([])
  })

  it('JS-6 a malformed digest is refused before any open', async () => {
    const { anchor, replicaDb } = await authorityAndReplica()
    const { factory, calls } = recordingFactory(async () => replicaDb)
    const voter = new NetworksEngine(makeDeviceLocalStorage(), factory)
    const result = await voter.joinFromStrand({ ...anchor, digest: 'x' }, undefined, peers(1))
    expect(result).to.deep.include({ ok: false, reason: 'digest-mismatch', retryable: false })
    expect(calls).to.deep.equal([])
  })
})

describe('spike 100: joinNetwork orchestration (JN)', () => {
  const NET_REF = { hash: 'a1b2c3d4e5f60718', relays: [], name: 'Utah County Elections', primaryAuthorityDomainName: 'example.org' }

  function harness (opts: {
    redeem?: () => Promise<unknown>
    admittedAfterMs?: number | null
    joinResults?: JoinFromStrandResult[]
    alreadyAdmitted?: boolean
    expiresAtMs?: number | null
    decodeThrows?: boolean
    decodeThrowsWith?: unknown
    code?: NetworkJoinCode
    joinFailureDetail?: string
    /** UAT 65 F1: what belongsToOtherCadre answers (a function to throw from it) */
    otherCadre?: boolean | (() => Promise<boolean>)
    /** UAT 65 F1: joinFromStrand never settles */
    joinNeverSettles?: boolean
    syncBudgetMs?: number
    budgetGraceMs?: number
  } = {}) {
    let clock = 1_000_000
    const steps: NetworkJoinStep[] = []
    const calls = { redeem: 0, fallback: 0, remember: 0, join: 0, admittedChecks: 0, decode: 0, otherCadreChecks: 0, abandoned: 0 }
    const joinResults = [...(opts.joinResults ?? [{ ok: true, outcome: 'joined', networkRef: NET_REF, fingerprint: 'abcd abcd abcd abcd' } as JoinFromStrandResult])]
    let redeemedAt: number | null = null
    const options: NetworkJoinOptions = {
      node: {
        async redeemCadreInvitation () {
          calls.redeem++
          redeemedAt = clock
          if (opts.redeem) return opts.redeem()
          return { peerId: 'member' }
        }
      },
      networksEngine: {
        async joinFromStrand (_anchor: NetworkJoinAnchor, _user: User | undefined, o: JoinFromStrandOptions) {
          calls.join++
          if (opts.joinNeverSettles) return new Promise<JoinFromStrandResult>(() => undefined)
          const next = joinResults.length > 1 ? joinResults.shift()! : joinResults[0]!
          if (next.ok) o.onVerifying?.()
          return next
        }
      },
      user: undefined,
      code: opts.code ?? sampleCode(),
      decodeInvitation: (encoded: string) => {
        calls.decode++
        if (opts.decodeThrowsWith !== undefined) throw opts.decodeThrowsWith
        if (opts.decodeThrows) throw new Error('bad invitation')
        return { encoded }
      },
      invitationExpiresAtMs: () => opts.expiresAtMs ?? null,
      isSelfAdmitted: async () => {
        calls.admittedChecks++
        if (opts.alreadyAdmitted) return true
        if (opts.admittedAfterMs === undefined || opts.admittedAfterMs === null || redeemedAt === null) return false
        return clock - redeemedAt >= opts.admittedAfterMs
      },
      ...(opts.otherCadre === undefined
        ? {}
        : {
            belongsToOtherCadre: async () => {
              calls.otherCadreChecks++
              return typeof opts.otherCadre === 'function' ? opts.otherCadre() : opts.otherCadre!
            }
          }),
      onSyncAbandoned: () => { calls.abandoned++ },
      afterFallbackAdmission: async () => { calls.fallback++ },
      rememberBootstrap: async () => { calls.remember++ },
      getPeerCount: () => 1,
      onStep: (s) => steps.push(s),
      now: () => clock,
      sleep: async (ms) => { clock += ms },
      admissionTimeoutMs: 20_000,
      syncBudgetMs: opts.syncBudgetMs ?? 10_000,
      retryDelayMs: 1_000,
      ...(opts.budgetGraceMs === undefined ? {} : { budgetGraceMs: opts.budgetGraceMs })
    }
    return { options, calls, steps, clock: () => clock, redeemedAtMs: () => redeemedAt }
  }

  it('JN-1 redeem succeeds: admitted by redemption, joined, every step reported in order', async () => {
    const h = harness()
    const result = await joinNetwork(h.options)
    expect(result).to.deep.include({ ok: true, outcome: 'joined', admittedVia: 'redeemed' })
    expect(h.calls).to.deep.include({ redeem: 1, fallback: 0, remember: 1, join: 1 })
    expect(h.steps).to.deep.equal(['admitting', 'syncing', 'verifying', 'done'])
  })

  it('JN-2 redeem THROWS but the member seated this node: admitted by self-admission, post-steps run', async () => {
    const h = harness({ redeem: async () => { throw new Error('StreamStateError: closed') }, admittedAfterMs: 2_000 })
    const result = await joinNetwork(h.options)
    expect(result).to.deep.include({ ok: true, admittedVia: 'self-admission' })
    expect(h.calls.fallback).to.equal(1)
  })

  it('JN-3 redeem throws and no admission arrives within the budget: not-admitted, nothing opened', async () => {
    const h = harness({ redeem: async () => { throw new Error('CadreInviteRejectedError: exhausted') } })
    const result = await joinNetwork(h.options)
    expect(result).to.deep.include({ ok: false, reason: 'not-admitted', detail: 'Error' })
    expect(h.calls.join).to.equal(0)
    expect(h.calls.remember).to.equal(0)
  })

  it('JN-4 already a member (a retry after a later step failed): no second redemption', async () => {
    const h = harness({ alreadyAdmitted: true })
    const result = await joinNetwork(h.options)
    expect(result).to.deep.include({ ok: true, admittedVia: 'already-member' })
    expect(h.calls.redeem).to.equal(0)
  })

  it('JN-5 an expired invitation is refused before any dial', async () => {
    const h = harness({ expiresAtMs: 999_000 })
    const result = await joinNetwork(h.options)
    expect(result).to.deep.include({ ok: false, reason: 'invitation-expired', detail: 'invitation-expired' })
    expect(h.calls.redeem).to.equal(0)
  })

  it('JN-6 a malformed invitation inside a well-formed code: invitation-malformed', async () => {
    const h = harness({ decodeThrows: true })
    const result = await joinNetwork(h.options)
    expect(result).to.deep.include({ ok: false, reason: 'invitation-malformed', detail: 'Error' })
    expect(h.calls.redeem).to.equal(0)
  })

  it('JN-7 no-peers then not-synced are retried within the budget, then joined', async () => {
    const h = harness({
      joinResults: [
        { ok: false, reason: 'no-peers', retryable: true, detail: '' },
        { ok: false, reason: 'not-synced', retryable: true, detail: '' },
        { ok: true, outcome: 'joined', networkRef: NET_REF, fingerprint: 'f' }
      ]
    })
    const result = await joinNetwork(h.options)
    expect(result.ok).to.equal(true)
    expect(h.calls.join).to.equal(3)
  })

  it('JN-8 digest-mismatch is final: one attempt, no retry', async () => {
    const h = harness({ joinResults: [{ ok: false, reason: 'digest-mismatch', retryable: false, detail: 'x' }] })
    const result = await joinNetwork(h.options)
    expect(result).to.deep.include({ ok: false, reason: 'digest-mismatch', detail: 'digest-mismatch' })
    expect(h.calls.join).to.equal(1)
    expect(h.calls.abandoned, 'a final refusal is not a lack of time').to.equal(0)
  })

  it('JN-9 a retryable failure that outlasts the budget ends as that failure (not-synced)', async () => {
    const h = harness({ joinResults: [{ ok: false, reason: 'not-synced', retryable: true, detail: '' }] })
    const result = await joinNetwork(h.options)
    expect(result).to.deep.include({ ok: false, reason: 'not-synced' })
    expect(h.calls.join).to.be.within(2, 11)
    // UAT 65 F1: the timed-out calls' strand waits are released when the budget runs out.
    expect(h.calls.abandoned).to.equal(1)
  })

  it('JN-10 target-open-failed surfaces as open-failed', async () => {
    const h = harness({ joinResults: [{ ok: false, reason: 'target-open-failed', retryable: false, detail: '' }] })
    expect(await joinNetwork(h.options)).to.deep.include({ ok: false, reason: 'open-failed' })
  })

  it('JN-18 (UAT 65 F1) a node in another cadre is refused first: no admission check, redemption or open', async () => {
    const h = harness({ otherCadre: true })
    expect(await joinNetwork(h.options)).to.deep.equal({ ok: false, reason: 'other-cadre', detail: 'other-cadre' })
    expect(h.calls).to.deep.include({ otherCadreChecks: 1, admittedChecks: 0, redeem: 0, join: 0, remember: 0 })
    expect(h.steps).to.deep.equal(['admitting'])
  })

  it('JN-19 (UAT 65 F1) the same cadre, or a check that throws, joins as before', async () => {
    expect(await joinNetwork(harness({ otherCadre: false }).options)).to.deep.include({ ok: true, admittedVia: 'redeemed' })
    const h = harness({ otherCadre: async () => { throw new Error('control database closed') } })
    expect(await joinNetwork(h.options)).to.deep.include({ ok: true, admittedVia: 'redeemed' })
    expect(h.calls.otherCadreChecks).to.equal(1)
  })

  it('JN-20 (UAT 65 F1) a joinFromStrand call that never settles ends at the budget as not-synced, and is abandoned once', async () => {
    const h = harness({ joinNeverSettles: true, syncBudgetMs: 40, budgetGraceMs: 10 })
    const started = Date.now()
    const result = await joinNetwork(h.options)
    expect(result).to.deep.equal({ ok: false, reason: 'not-synced', detail: 'sync-budget-expired' })
    expect(Date.now() - started).to.be.within(40, 2_000)
    expect(h.calls).to.deep.include({ join: 1, abandoned: 1 })
    expect(h.steps).to.deep.equal(['admitting', 'syncing'])
  })

  const DETAIL_TOKEN = /^(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*|(?:[A-Z][A-Za-z0-9]{0,58})?Error|unknown)$/
  const rejection = (code: string | undefined, message: string) =>
    Object.assign(new Error(message), { name: 'CadreInviteRejectedError', ...(code === undefined ? {} : { code }), retryable: false })

  it('JN-11 invite-spent after the bounded wait ends as invitation-used-up', async () => {
    const h = harness({ redeem: async () => { throw rejection('invite-spent', 'spent') } })
    const result = await joinNetwork(h.options)
    expect(result).to.deep.equal({ ok: false, reason: 'invitation-used-up', detail: 'invite-spent' })
    expect(h.clock() - h.redeemedAtMs()!).to.be.at.least(20_000)
    expect(h.calls.admittedChecks).to.be.greaterThan(2)
    expect(h.calls).to.deep.include({ join: 0, remember: 0, fallback: 0 })
  })

  it('JN-12 invite-spent but the self-admission row appears: the wait wins over the code', async () => {
    const h = harness({ redeem: async () => { throw rejection('invite-spent', 'spent') }, admittedAfterMs: 2_000 })
    expect(await joinNetwork(h.options)).to.deep.include({ ok: true, admittedVia: 'self-admission' })
  })

  it('JN-13 other typed codes end as not-admitted with the code as detail', async () => {
    for (const code of ['invite-invalid', 'busy', 'unrecognized']) {
      const h = harness({ redeem: async () => { throw rejection(code, 'x') } })
      expect(await joinNetwork(h.options), code).to.deep.equal({ ok: false, reason: 'not-admitted', detail: code })
    }
  })

  it('JN-14 message text alone never produces invitation-used-up', async () => {
    const h = harness({ redeem: async () => { throw rejection(undefined, 'invite-spent') } })
    expect(await joinNetwork(h.options)).to.deep.equal({ ok: false, reason: 'not-admitted', detail: 'CadreInviteRejectedError' })
  })

  it('JN-15 a 1.14-era no-prefix invitation is invitation-older-version before any decode or dial', async () => {
    const old = btoa('{"v":1,"partyId":"votetorrent"}').replace(/=+$/, '')
    const h = harness({ code: sampleCode({ invitation: old }) })
    expect(await joinNetwork(h.options)).to.deep.equal({ ok: false, reason: 'invitation-older-version', detail: 'invitation-older-version' })
    expect(h.calls).to.deep.include({ decode: 0, redeem: 0, join: 0 })
    expect(h.steps).to.deep.equal([])
  })

  it('JN-16 (D-06) detail is a closed token and never carries message text or code slices', async () => {
    const text = encodeNetworkJoinCode({ v: 2, invitation: mintInvitation(randomCadreInvitation({ members: 1 })), ...randomJoinAnchor() })
    const clean = (detail: string) => {
      for (let i = 0; i + 16 <= text.length; i += 7) expect(detail.includes(text.slice(i, i + 16))).to.equal(false)
    }
    const a = await joinNetwork(harness({ decodeThrowsWith: new Error(text) }).options)
    expect(a).to.deep.include({ ok: false, reason: 'invitation-malformed', detail: 'Error' })
    const b = await joinNetwork(harness({ redeem: async () => { throw text } }).options)
    expect(b).to.deep.include({ ok: false, reason: 'not-admitted', detail: 'unknown' })
    const c = await joinNetwork(harness({ redeem: async () => { throw Object.assign(new Error(text), { code: 'Not A Token!', name: 'weird name' }) } }).options)
    expect(c).to.deep.include({ ok: false, reason: 'not-admitted', detail: 'unknown' })
    const d = await joinNetwork(harness({ expiresAtMs: 999_000 }).options)
    expect(d).to.deep.include({ ok: false, reason: 'invitation-expired', detail: 'invitation-expired' })
    const e = await joinNetwork(harness({ joinResults: [{ ok: false, reason: 'digest-mismatch', retryable: false, detail: 'join: RAW ENGINE TEXT' }] }).options)
    expect(e).to.deep.include({ ok: false, reason: 'digest-mismatch', detail: 'digest-mismatch' })
    for (const r of [a, b, c, d, e]) if (!r.ok) clean(r.detail)
  })

  it('JN-17 every failure detail matches the closed-token shape', async () => {
    const results = [
      await joinNetwork(harness({ redeem: async () => { throw new Error('CadreInviteRejectedError: exhausted') } }).options),
      await joinNetwork(harness({ expiresAtMs: 999_000 }).options),
      await joinNetwork(harness({ decodeThrows: true }).options),
      await joinNetwork(harness({ joinResults: [{ ok: false, reason: 'digest-mismatch', retryable: false, detail: 'x y z' }] }).options),
      await joinNetwork(harness({ joinResults: [{ ok: false, reason: 'target-open-failed', retryable: false, detail: 'open: boom' }] }).options),
      await joinNetwork(harness({ redeem: async () => { throw rejection('invite-spent', 'm') } }).options),
      await joinNetwork(harness({ code: sampleCode({ invitation: btoa('{"v":1,"partyId":"p"}') }) }).options),
      await joinNetwork(harness({ otherCadre: true }).options),
      await joinNetwork(harness({ joinNeverSettles: true, syncBudgetMs: 20, budgetGraceMs: 0 }).options)
    ]
    for (const r of results) {
      expect(r.ok).to.equal(false)
      if (!r.ok) expect(r.detail).to.match(DETAIL_TOKEN)
    }
  })
})
