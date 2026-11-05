/**
 * dashboard-cohort-refusal.harness.spec.ts — a storage-withdrawn edge reader (the officer dashboard's strand node)
 * stays out of strand write cohorts on REAL loopback nodes. RUN_P2P_HARNESS=1 like every *.harness.spec.ts;
 * pending in the default suite.
 *
 * Two enrolled storage CadreNodes A (owner) and B (officer B's phone) share a VoteTorrent strand. Edge member C
 * (cadre-core `createEdgeNode`, `strandReactivity.edgeHost`, the dashboard's posture: it handles the edge-reader
 * marker, withdraws its storage protocols, pushes identify at once and withholds its strand addresses) joins
 * through an owner invitation and attaches the strand.
 *
 *   CR-0  hook off (control): once C's own stream puts the cluster protocol back into its record on A and B, the
 *         writer counts C as a write-cohort member or coordinator; insert outcomes are logged (R-G5)
 *   CR-1  hook on: C is in no sampled cluster or coordinator choice from attach through the 20 s re-entry window
 *         and after the same re-merge; every insert lands; both trackers hold C's strand peer id; C still reads
 *         the revocation row through its own strand database and still wakes on a commit on A
 *   CR-1b removing C leaves the refusal harmless: officer inserts still land
 *   CR-2  hook on, B's strand rebuilt (fresh refusal set) while C is attached: C is not in B's bootstrap seed,
 *         C advertises no strand address, B never reports awaiting-bootstrap, and B's inserts land
 *   CR-2c control for CR-2: C with `withholdStrandAddrs: false` IS in B's seed and holds B in awaiting-bootstrap
 *
 * Instruments read db-p2p internals (`keyNetwork.findCluster`, `findCoordinator`, `bootstrap.contact.peerIds`,
 * `awaitingBootstrapContact`) for observation only. Timers appear only in the samplers. No invitation text or key
 * is logged.
 */

import { expect } from 'chai'
import { createHash } from 'node:crypto'
import {
  describeP2PHarness, startTwoNodeHarness, pollUntil, seedPairingOfficers, startHarnessEdgeMember,
  attachHarnessEdgeStrand, restartHarnessNodeB,
  type TwoNodeHarness, type HarnessPairingNetwork, type HarnessEdgeMember, type HarnessPairingOfficer
} from './harness/two-node-strand.js'
import { revokeDashboardPairing, isPairingRevoked } from '../src/pairing/pairing-revocation.js'
import { bytesToBase64url } from '../src/utils.js'
import { signDigestP256 } from './fixtures/p256-signer.js'

const SCALE = Number(process.env.P2P_HARNESS_TIMEOUT_SCALE ?? 1)
const CLUSTER_SIZE = 2
const SAMPLE_INTERVAL_MS = 250
const MIN_SAMPLES = 80

function ms (n: number): number {
  return Math.round(n * SCALE)
}

async function sleep (n: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, n))
}

function freshNonce (): string {
  return bytesToBase64url(crypto.getRandomValues(new Uint8Array(16)))
}

/** 32 fixed, seeded 32-byte keys (the same every run). */
const SEEDED_KEYS: Uint8Array[] = Array.from({ length: 32 }, (_v, i) =>
  new Uint8Array(createHash('sha256').update(`cr-seeded-key-${i}`).digest()))

interface InsertResult { ok: boolean, name?: string, shortfall?: boolean, ms?: number }

function causeChain (err: unknown): unknown[] {
  const out: unknown[] = []
  const seen = new Set<unknown>()
  const queue: unknown[] = [err]
  while (queue.length > 0 && out.length < 32) {
    const e = queue.shift()
    if (e === null || e === undefined || seen.has(e)) continue
    seen.add(e)
    out.push(e)
    const anyE = e as { cause?: unknown, errors?: unknown[] }
    if (anyE.cause !== undefined) queue.push(anyE.cause)
    if (Array.isArray(anyE.errors)) queue.push(...anyE.errors)
  }
  return out
}

function isShortfall (err: unknown): boolean {
  return causeChain(err).some((e) => (e as Error)?.name === 'PromiseShortfallError' || /super-majority/.test(String((e as Error)?.message ?? '')))
}

function p256Signer (o: HarnessPairingOfficer): any {
  return {
    userId: o.user.id,
    signingPublicKey: o.keyPub,
    sign: async (d: Uint8Array) => ({ signature: signDigestP256(bytesToBase64url(d), o.privBytes), signerKey: o.keyPub, signerUserId: o.user.id })
  }
}

function collectionIdOf (db: any, table: string): string {
  const mod: any = db.schemaManager.getModule('optimystic')?.module
  const id = mod?.tables?.get('app.' + table.toLowerCase())?.collection?.collection?.id
  if (typeof id !== 'string') throw new Error(`no collection id for ${table}`)
  return id
}

/** Public's tail-reader composition from vote-engine's own optimystic packages (a copy of DM's joinerTails). */
function edgeTails (libs: { dbCore: any, dbP2p: any }, strandNode: any, networkName: string): any {
  const { NetworkTransactor } = libs.dbCore
  const { RepoClient, stateHoldingsOnReads, committedTailReader, resolveLinkDeadlines } = libs.dbP2p
  const { keyNetwork, coordinatedRepo } = strandNode
  const protocolPrefix = `/optimystic/${networkName}`
  const selfId = strandNode.peerId.toString()
  const localStore = strandNode.storageRepo
  const getRepo = (peerId: any): any => {
    if (peerId.toString() === selfId) return coordinatedRepo
    const remote = RepoClient.create(peerId, keyNetwork, protocolPrefix)
    return localStore ? stateHoldingsOnReads(remote, localStore) : remote
  }
  const { dialTimeoutMs, transactionTimeoutMs, retryBackoffBaseMs } = strandNode.linkDeadlines ?? resolveLinkDeadlines()
  const transactor = new NetworkTransactor({
    timeoutMs: transactionTimeoutMs,
    abortOrCancelTimeoutMs: Math.max(5000, dialTimeoutMs),
    dialTimeoutMs,
    retryBackoffBaseMs,
    keyNetwork,
    getRepo,
    localChangeNotifier: strandNode.blockChangeNotifier,
    localPeerId: strandNode.peerId,
    clock: strandNode.hlcClock
  })
  return committedTailReader(transactor)
}

interface Leg {
  label: string
  harness: TwoNodeHarness
  pn: HarnessPairingNetwork
  c: HarnessEdgeMember
  cIdentity: string
  cStrandNode: any
  cStrandPeer: string
  cDb: any
  tAttachStart: number
  tAttached: number
  revColl: string
  tidColl: string
  latency: { A?: number, B?: number }
  /** Samples taken on A and B WHILE C attached (from attach start until both refusals landed, or attach returned). */
  attachObs: { samples: number, hits: number }
  ctxB: any
  lastNonce: string
}

describeP2PHarness('an attached edge reader stays out of strand write cohorts (cohort refusal)', function () {
  this.timeout(ms(1_800_000))

  let cadre: any
  let libs: { dbCore: any, dbP2p: any }
  const open: Leg[] = []

  before(async function () {
    cadre = await import('@serfab/cadre-core')
    libs = { dbCore: await import('@optimystic/db-core'), dbP2p: await import('@optimystic/db-p2p') }
  })

  after(async function () {
    this.timeout(120_000)
    for (const leg of open) await teardown(leg)
  })

  async function teardown (leg: Leg): Promise<void> {
    const i = open.indexOf(leg)
    if (i >= 0) open.splice(i, 1)
    try { await leg.c.stop() } catch { /* idempotent */ }
    try { await leg.harness.stop() } catch { /* idempotent */ }
  }

  function strandOf (leg: Leg, which: 'A' | 'B'): any {
    const node = which === 'A' ? leg.harness.nodeA.node : leg.harness.nodeB.node
    return node.getStrand(leg.pn.hash)?.libp2pNode
  }

  /** Builds a harness, joins C through an owner invitation and attaches it; records each tracker's refusal latency. */
  async function setupLeg (label: string, opts: { cohortRefusal: boolean, withholdStrandAddrs?: boolean, listenAddrs?: string[] }): Promise<Leg> {
    const harness = await startTwoNodeHarness({
      clusterSize: CLUSTER_SIZE,
      extraConfig: { strandReactivity: { enabled: true } },
      ...(opts.cohortRefusal ? { cohortRefusal: true } : {})
    })
    let c: HarnessEdgeMember | undefined
    try {
      const pn = await seedPairingOfficers(harness)
      const minted = await harness.nodeA.node.createCadreInvitation({ uses: 1, expiresInMs: 15 * 60_000 })
      c = await startHarnessEdgeMember({
        label: `node-C-${label}`,
        storageId: `cr-${label}-${harness.runId}`,
        strandId: pn.hash,
        clusterSize: CLUSTER_SIZE,
        strandReactivity: { edgeHost: true },
        ...(opts.withholdStrandAddrs === false ? { withholdStrandAddrs: false } : {}),
        ...(opts.listenAddrs !== undefined ? { listenAddrs: opts.listenAddrs } : {})
      })
      const cIdentity = await c.identityPeerId()
      await c.edge.joinCadre(cadre.decodeCadreInvitation(minted.encoded), { relayAddrs: [], signal: AbortSignal.timeout(ms(120_000)) })
      await pollUntil(async () => await harness.nodeA.node.isAuthorizedMember(cIdentity), (v) => v === true,
        { timeoutMs: ms(60_000), label: `${label}: node-A sees C as a member` })

      const latency: { A?: number, B?: number } = {}
      const revColl = collectionIdOf(pn.dbB, 'DashboardPairingRevocation')
      const tidColl = collectionIdOf(pn.dbA, 'TidHighWater')
      const tAttachStart = Date.now()
      // R-G4: the attach window itself is sampled, from the moment C's strand node exists.
      const attachObs = { samples: 0, hits: 0 }
      let attaching = true
      const attachSampler = (async () => {
        while (attaching) {
          const sp = c!.edge.node?.getStrand(pn.hash)?.libp2pNode?.peerId?.toString() as string | undefined
          if (sp !== undefined) {
            const s = await sampleOnce({ harness, pn, cStrandPeer: sp, revColl, tidColl } as unknown as Leg)
            attachObs.samples++
            if (s.A || s.B) attachObs.hits++
          }
          await sleep(50)
        }
      })()
      let cStrandPeerSeen: string | undefined
      let watching = opts.cohortRefusal
      const watcher = (async () => {
        while (watching) {
          const sp = cStrandPeerSeen ?? (c!.edge.node?.getStrand(pn.hash)?.libp2pNode?.peerId?.toString() as string | undefined)
          if (sp !== undefined) {
            cStrandPeerSeen = sp
            if (latency.A === undefined && harness.nodeA.cohortRefusal?.has(pn.hash, sp) === true) latency.A = Date.now() - tAttachStart
            if (latency.B === undefined && harness.nodeB.cohortRefusal?.has(pn.hash, sp) === true) latency.B = Date.now() - tAttachStart
            if (latency.A !== undefined && latency.B !== undefined) break
          }
          if (Date.now() - tAttachStart > ms(60_000)) break
          await sleep(20)
        }
      })()
      const attached = await attachHarnessEdgeStrand(c, pn.hash)
      const tAttached = Date.now()
      if (opts.cohortRefusal) {
        await watcher
      } else {
        watching = false
        await watcher
      }
      attaching = false
      await attachSampler
      const leg: Leg = {
        label,
        harness,
        pn,
        c,
        cIdentity,
        cStrandNode: attached.strandNode,
        cStrandPeer: attached.strandPeerId,
        cDb: attached.db,
        tAttachStart,
        tAttached,
        revColl,
        tidColl,
        latency,
        attachObs,
        ctxB: pn.ctxB,
        lastNonce: ''
      }
      open.push(leg)
      expect(leg.cStrandPeer, 'the strand peer id is not the identity peer id').to.not.equal(cIdentity)
      expect(leg.cStrandPeer, 'the strand peer id is not the strand id').to.not.equal(pn.hash)
      console.log(`[cr-obs] ${label} attached ${tAttached - tAttachStart} ms; refusal latency A=${latency.A ?? 'n/a'} B=${latency.B ?? 'n/a'}; attach-window samples ${attachObs.samples} hits ${attachObs.hits}`)
      return leg
    } catch (err) {
      try { await c?.stop() } catch { /* idempotent */ }
      try { await harness.stop() } catch { /* idempotent */ }
      throw err
    }
  }

  /** One sample on A and B: is C's STRAND peer id in any sampled cluster or coordinator choice? */
  async function sampleOnce (leg: Leg): Promise<{ A: boolean, B: boolean, errors: number, clusterHits: number, coordHits: number, revCollHit: boolean, revCollOn: { A: boolean, B: boolean } }> {
    const enc = new TextEncoder()
    const keys: Uint8Array[] = [enc.encode(leg.revColl), enc.encode(leg.tidColl), ...SEEDED_KEYS]
    const out = { A: false, B: false, errors: 0, clusterHits: 0, coordHits: 0, revCollHit: false, revCollOn: { A: false, B: false } }
    for (const which of ['A', 'B'] as const) {
      const kn = strandOf(leg, which)?.keyNetwork
      if (kn === undefined) { out.errors++; continue }
      for (let k = 0; k < keys.length; k++) {
        const key = keys[k]!
        try {
          const cluster = Object.keys(await kn.findCluster(key))
          if (cluster.includes(leg.cStrandPeer)) {
            out[which] = true
            out.clusterHits++
            if (k === 0) {
              out.revCollHit = true
              out.revCollOn[which] = true
            }
          }
        } catch { out.errors++ }
        try {
          const coord = String(await kn.findCoordinator(key, {}))
          if (coord === leg.cStrandPeer) {
            out[which] = true
            out.coordHits++
          }
        } catch { out.errors++ }
      }
    }
    return out
  }

  /** C's strand node opens (and aborts) a stream on `protocol` to each target, then the target's record for C must list it. */
  async function remerge (leg: Leg, protocol: 'cluster' | 'repo', targets: Array<'A' | 'B'>): Promise<void> {
    const proto = `/optimystic/strand-${leg.pn.hash}/${protocol}/1.0.0`
    for (const which of targets) {
      const target = strandOf(leg, which)
      const addrs = target.getMultiaddrs()
      const stream: any = await leg.cStrandNode.dialProtocol(addrs, proto, { signal: AbortSignal.timeout(ms(20_000)) })
      try { stream.abort(new Error('cohort-refusal remerge')) } catch { /* already closed */ }
      await pollUntil(
        async () => {
          const rec: any = await target.peerStore.get(leg.cStrandNode.peerId)
          return (rec?.protocols ?? []) as string[]
        },
        (p) => p.includes(proto),
        { timeoutMs: ms(10_000), intervalMs: 50, label: `${leg.label}: node-${which}'s record for C lists ${protocol} (merge not throttled)` }
      )
      console.log(`[cr-obs] ${leg.label} remerge ${protocol} on node-${which} confirmed`)
    }
  }

  /**
   * A signed revocation insert with a fresh nonce: officer B's on node-B (default), or the founding officer's on
   * node-A. Both writers are exercised because a write's cohort is assembled by its coordinator, and the shortfall
   * 66-09 recorded (pm-diag/bisect1.log) was a node-A write.
   */
  async function insert (leg: Leg, writer: 'A' | 'B' = 'B'): Promise<InsertResult> {
    const nonce = freshNonce()
    const t0 = Date.now()
    try {
      if (writer === 'B') {
        await revokeDashboardPairing(leg.ctxB, { userId: leg.pn.officerB.user.id, nonce, signer: p256Signer(leg.pn.officerB) })
        leg.lastNonce = nonce
      } else {
        const { makeTestSignCallback } = await import('./fixtures/test-context.js')
        const founder = leg.pn.founder
        await revokeDashboardPairing(leg.pn.ctxA, {
          userId: founder.id,
          nonce,
          signer: { userId: founder.id, signingPublicKey: founder.activeKeys[0]!.key, sign: makeTestSignCallback(founder) } as any
        })
      }
      return { ok: true, ms: Date.now() - t0 }
    } catch (err) {
      return { ok: false, name: (err as Error)?.name ?? 'Error', shortfall: isShortfall(err), ms: Date.now() - t0 }
    }
  }

  /** The writer of the i-th insert in CR-0 and CR-1: B, A, B, A, ... */
  const writerOf = (i: number): 'A' | 'B' => (i % 2 === 0 ? 'B' : 'A')

  function bootstrapPeers (leg: Leg, which: 'A' | 'B'): string[] {
    const ids = strandOf(leg, which)?.keyNetwork?.bootstrap?.contact?.peerIds
    return Array.isArray(ids) ? ids.map(String) : []
  }

  function fmt (r: InsertResult): string {
    return r.ok ? 'ok' : `${r.name}${r.shortfall === true ? '(shortfall)' : ''}`
  }

  it('CR-0 hook off (control): after a stream re-merge the edge reader is counted as a write-cohort member or coordinator on the writer\'s side', async function () {
    this.timeout(ms(600_000))
    // R-G5 (user ruling): the control asserts what reproduces every time. With no hook, once C's own stream puts
    // the cluster protocol back into its record on the writer (node-B, officer B's phone), the writer counts C as a
    // write-cohort member or coordinator. Whether a given insert then falls short depends on which node
    // coordinates it and on that node's own view, which C's next identify resets (cr-diag4/5), so the insert
    // outcome is logged as an observation only. The shortfall itself is evidenced by cr-diag3 and cr-diag4
    // build 4 (`PromiseShortfallError` with C in the writer's cohort) and by 66-09's G-66-W3a FINDING (pm-diag).
    const leg = await setupLeg('cr0', { cohortRefusal: false })
    try {
      expect(leg.harness.nodeA.cohortRefusal, 'no tracker on node-A').to.equal(undefined)
      expect(leg.harness.nodeB.cohortRefusal, 'no tracker on node-B').to.equal(undefined)
      // Observation: before the re-merge C has never listed a storage protocol (R-G4), so it should be in no view.
      const pre = await sampleOnce(leg)
      await remerge(leg, 'cluster', ['A', 'B'])
      let writerHits = 0
      let anyHits = 0
      let errors = 0
      let clusterHits = 0
      let coordHits = 0
      for (let i = 0; i < 20; i++) {
        const s = await sampleOnce(leg)
        if (s.B) writerHits++
        if (s.A || s.B) anyHits++
        errors += s.errors
        clusterHits += s.clusterHits
        coordHits += s.coordHits
        await sleep(SAMPLE_INTERVAL_MS)
      }
      console.log(`[cr-0] pre-remerge in-view A=${pre.A} B=${pre.B}; after re-merge samples 20: writer (node-B) hits ${writerHits}, any-node hits ${anyHits} (cluster-key hits ${clusterHits}, coordinator hits ${coordHits}) errors ${errors}`)
      expect(writerHits, 'the writer counts C as a write-cohort member or coordinator after the re-merge').to.be.at.least(1)

      // Observation only (R-G5): officer B's inserts with the hook off. Each is bounded: with C silent in its cohort
      // a write can keep retrying for minutes (cr-g4-2 ran past the 600 s leg timeout), and an observation must not
      // hold the leg or leak its harness into the next one. A write still running at teardown fails there.
      const OBSERVE_INSERT_MS = ms(60_000)
      const results: InsertResult[] = []
      for (let i = 0; i < 6; i++) {
        let bound: ReturnType<typeof setTimeout> | undefined
        const r = await Promise.race([
          insert(leg, 'B'),
          new Promise<InsertResult>((resolve) => { bound = setTimeout(() => resolve({ ok: false, name: 'ObservationTimeout', ms: OBSERVE_INSERT_MS }), OBSERVE_INSERT_MS) })
        ])
        clearTimeout(bound)
        results.push(r)
        if (!r.ok) break
      }
      const shortfalls = results.filter((r) => !r.ok && r.shortfall === true).length
      console.log(`[cr-0] observation: inserts ${results.map(fmt).join(' ')} durations ${results.map((x) => x.ms).join(',')} ms; shortfalls ${shortfalls}`)
    } finally {
      await teardown(leg)
    }
  })

  let leg1: Leg | undefined

  it('CR-1 hook on: the edge reader is never a cohort member or coordinator through the re-entry window, and still reads and wakes', async function () {
    this.timeout(ms(600_000))
    const leg = await setupLeg('cr1', { cohortRefusal: true })
    leg1 = leg
    const trackerA = leg.harness.nodeA.cohortRefusal
    const trackerB = leg.harness.nodeB.cohortRefusal
    expect(trackerA !== undefined && trackerB !== undefined, 'each node has its own tracker').to.equal(true)
    expect(trackerA).to.not.equal(trackerB)

    let wakes = 0
    const watch = leg.cStrandNode.reactivityWatch.watch({
      collectionId: leg.revColl,
      tails: edgeTails(libs, leg.cStrandNode, `strand-${leg.pn.hash}`),
      onChange: () => { wakes++ }
    })
    try {
      const samples = { A: 0, B: 0 }
      let hits = 0
      let errors = 0
      const results: InsertResult[] = []
      const pending: Array<Promise<void>> = []
      const scheduleS = [1, 8, 15, 21, 24]
      let next = 0
      const windowMs = ms(25_000)
      const hardStop = leg.tAttached + ms(180_000)
      for (;;) {
        const elapsed = Date.now() - leg.tAttached
        while (next < scheduleS.length && elapsed >= ms(scheduleS[next]! * 1000)) {
          next++
          const writer = writerOf(next - 1)
          pending.push(insert(leg, writer).then((r) => { results.push(r) }))
        }
        const s = await sampleOnce(leg)
        samples.A++
        samples.B++
        if (s.A || s.B) hits++
        errors += s.errors
        if (Date.now() - leg.tAttached >= windowMs && next >= scheduleS.length && samples.A >= MIN_SAMPLES) break
        if (Date.now() > hardStop) break
        await sleep(SAMPLE_INTERVAL_MS)
      }
      await Promise.all(pending)
      const windowSamples = samples.A
      await remerge(leg, 'cluster', ['A', 'B'])
      for (let i = 0; i < 20; i++) {
        const s = await sampleOnce(leg)
        samples.A++
        samples.B++
        if (s.A || s.B) hits++
        errors += s.errors
        await sleep(SAMPLE_INTERVAL_MS)
      }
      results.push(await insert(leg))
      console.log(`[cr-1] samples A=${samples.A} B=${samples.B} (window ${windowSamples}, ${Date.now() - leg.tAttached} ms) hits ${hits} errors ${errors}; inserts ${results.map(fmt).join(' ')} durations ${results.map((x) => x.ms).join(',')} ms; refusal latency A=${leg.latency.A ?? 'n/a'} B=${leg.latency.B ?? 'n/a'}; tracker sizes A=${trackerA!.size()} B=${trackerB!.size()}`)

      expect(windowSamples, 'at least 80 window samples per node').to.be.at.least(MIN_SAMPLES)
      expect(leg.attachObs.samples, 'the attach window was sampled').to.be.at.least(1)
      expect(leg.attachObs.hits, 'C is in no cluster or coordinator choice during the attach window either (R-G4)').to.equal(0)
      expect(hits, 'C is in no sampled cluster or coordinator choice').to.equal(0)
      expect(results.length).to.equal(6)
      expect(results.map(fmt), 'every insert lands').to.deep.equal(['ok', 'ok', 'ok', 'ok', 'ok', 'ok'])
      expect(trackerA!.has(leg.pn.hash, leg.cStrandPeer), 'node-A refuses C\'s strand peer').to.equal(true)
      expect(trackerB!.has(leg.pn.hash, leg.cStrandPeer), 'node-B refuses C\'s strand peer').to.equal(true)
      const aStrand = strandOf(leg, 'A').peerId.toString()
      const bStrand = strandOf(leg, 'B').peerId.toString()
      for (const t of [trackerA!, trackerB!]) {
        expect(t.has(leg.pn.hash, aStrand), 'no tracker holds node-A\'s strand peer').to.equal(false)
        expect(t.has(leg.pn.hash, bStrand), 'no tracker holds node-B\'s strand peer').to.equal(false)
        expect(t.has(leg.pn.hash, leg.cIdentity), 'trackers hold the strand peer id, not the identity peer id').to.equal(false)
      }

      // Reads are unaffected: C reads the last revocation through its own strand database.
      const userId = leg.pn.officerB.user.id
      const nonce = leg.lastNonce
      await pollUntil(async () => await isPairingRevoked(leg.cDb, { userId, nonce }), (v) => v === true,
        { timeoutMs: ms(90_000), label: 'C reads the last revocation row' })

      // And C still wakes on a commit made on node-A (the founder's own revocation insert).
      const { makeTestSignCallback } = await import('./fixtures/test-context.js')
      await pollUntil(async () => wakes, (n) => n >= 1, { timeoutMs: ms(90_000), label: 'C\'s watch has woken at least once' })
      const base = wakes
      const t0 = Date.now()
      const founder = leg.pn.founder
      await revokeDashboardPairing(leg.pn.ctxA, {
        userId: founder.id,
        nonce: freshNonce(),
        signer: { userId: founder.id, signingPublicKey: founder.activeKeys[0]!.key, sign: makeTestSignCallback(founder) } as any
      })
      await pollUntil(async () => wakes, (n) => n > base, { timeoutMs: ms(90_000), label: 'a commit on node-A wakes C' })
      console.log(`[cr-1] wake after node-A commit ${Date.now() - t0} ms; wakes ${wakes}`)
    } finally {
      await watch.close()
    }
  })

  it('CR-1b removing the browser leaves the refusal harmless', async function () {
    this.timeout(ms(300_000))
    const leg = leg1
    if (leg === undefined) throw new Error('CR-1b needs CR-1\'s harness')
    try {
      await leg.harness.nodeA.node.removeMachine(leg.cIdentity)
      await pollUntil(async () => leg.c.removed.length, (n) => n >= 1, { timeoutMs: ms(60_000), label: 'C receives cadre:removed' })
      const results = [await insert(leg), await insert(leg)]
      console.log(`[cr-1b] inserts after removal ${results.map(fmt).join(' ')}`)
      expect(results.map(fmt)).to.deep.equal(['ok', 'ok'])
      expect(leg.harness.nodeA.cohortRefusal!.has(leg.pn.hash, leg.cStrandPeer)).to.equal(true)
      expect(leg.harness.nodeB.cohortRefusal!.has(leg.pn.hash, leg.cStrandPeer)).to.equal(true)
    } finally {
      await teardown(leg)
      leg1 = undefined
    }
  })

  /** Restart node-B with a fresh tracker while C is attached, then read B's seed and its bootstrap wait. */
  async function rebuiltStrandLeg (label: string, withhold: boolean): Promise<{ leg: Leg, inSeed: boolean, awaitingSeen: number, awaitingSamples: number, results: InsertResult[] }> {
    // A loopback listener stands in for a deployed dashboard's relay reservation, so C HAS a dialable strand
    // address to withhold (a dial-only harness member advertises nothing either way).
    const leg = await setupLeg(label, { cohortRefusal: true, withholdStrandAddrs: withhold, listenAddrs: ['/ip4/127.0.0.1/tcp/0/ws'] })
    // Scenario set-up: node-B's CONTROL node holds an open connection to C, so C is a connected sibling.
    await pollUntil(
      async () => (leg.harness.nodeB.node.getControlNode()?.getConnections() ?? []).some((cn: any) => cn.remotePeer.toString() === leg.cIdentity),
      (v) => v === true,
      { timeoutMs: ms(60_000), label: `${label}: node-B control is connected to C` }
    )
    const advertised = leg.c.edge.node.advertisedStrandMultiaddrs(leg.pn.hash)
    const actual = leg.c.edge.node.getStrandMultiaddrs(leg.pn.hash)
    console.log(`[${label}] C advertised ${advertised.length} actual ${actual.length}`)
    if (withhold) {
      expect(advertised, 'C advertises no strand address').to.deep.equal([])
      expect(actual.length, 'C does have strand addresses').to.be.greaterThan(0)
    } else {
      expect(advertised.length, 'without withholding C advertises its strand addresses').to.be.greaterThan(0)
    }
    const oldTracker = leg.harness.nodeB.cohortRefusal
    const tRestart = Date.now()
    const controlConnectedTo = (peer: string): boolean =>
      (leg.harness.nodeB.node.getControlNode()?.getConnections() ?? []).some((cn: any) => cn.remotePeer.toString() === peer)
    await restartHarnessNodeB(leg.harness, {
      cohortRefusal: true,
      // As a phone's app re-claims its strand once the control mesh is back: wait until node-B's control node is
      // connected to node-A and to C again, so both are connected siblings when the seed is resolved.
      beforeReopen: async () => {
        await pollUntil(async () => controlConnectedTo(leg.harness.nodeA.peerId) && controlConnectedTo(leg.cIdentity), (v) => v === true,
          { timeoutMs: ms(90_000), label: `${label}: restarted node-B control connected to node-A and C` })
      }
    })
    expect(leg.harness.nodeB.cohortRefusal, 'node-B got a fresh tracker').to.not.equal(oldTracker)
    leg.ctxB = { db: await leg.harness.nodeB.openStrand(leg.pn.hash), user: leg.pn.officerB.user }
    const seed = bootstrapPeers(leg, 'B')
    const inSeed = seed.includes(leg.cStrandPeer)
    const aInSeed = seed.includes(strandOf(leg, 'A').peerId.toString())
    console.log(`[${label}] node-B restarted ${Date.now() - tRestart} ms; seed size ${seed.length}; node-A strand peer in seed ${aInSeed}; C strand peer in seed ${inSeed}`)
    expect(aInSeed, 'the rebuilt seed holds node-A (it was resolved from connected siblings)').to.equal(true)

    let wakes = 0
    const watch = leg.cStrandNode.reactivityWatch.watch({
      collectionId: leg.revColl,
      tails: edgeTails(libs, leg.cStrandNode, `strand-${leg.pn.hash}`),
      onChange: () => { wakes++ }
    })
    try {
      await remerge(leg, 'repo', ['B'])
      const tRemerge = Date.now()
      let awaitingSeen = 0
      let awaitingSamples = 0
      let firstAwaitingAt: number | undefined
      const windowMs = withhold ? ms(25_000) : ms(10_000)
      for (;;) {
        const kn = strandOf(leg, 'B')?.keyNetwork
        const awaiting = await kn.awaitingBootstrapContact()
        awaitingSamples++
        if (awaiting === true) {
          awaitingSeen++
          firstAwaitingAt ??= Date.now() - tRemerge
          if (!withhold) break
        }
        if (Date.now() - tRemerge >= windowMs && (awaitingSamples >= MIN_SAMPLES || !withhold)) break
        await sleep(SAMPLE_INTERVAL_MS)
      }
      const results = withhold ? [await insert(leg), await insert(leg)] : []
      console.log(`[${label}] awaiting-bootstrap samples ${awaitingSamples} true ${awaitingSeen} first ${firstAwaitingAt ?? 'never'} ms; inserts ${results.map(fmt).join(' ') || 'n/a'}; wakes ${wakes}; tracker B size ${leg.harness.nodeB.cohortRefusal?.size() ?? 'n/a'}`)
      return { leg, inSeed, awaitingSeen, awaitingSamples, results }
    } finally {
      await watch.close()
    }
  }

  it('CR-2 a strand rebuilt while the reader is attached never waits on it', async function () {
    this.timeout(ms(600_000))
    const r = await rebuiltStrandLeg('cr-2', true)
    try {
      expect(r.inSeed, 'C\'s strand peer is not in node-B\'s bootstrap seed').to.equal(false)
      expect(r.awaitingSamples, 'at least 80 awaiting-bootstrap samples').to.be.at.least(MIN_SAMPLES)
      expect(r.awaitingSeen, 'node-B never reports awaiting-bootstrap').to.equal(0)
      expect(r.results.map(fmt), 'officer inserts after the restart land').to.deep.equal(['ok', 'ok'])
    } finally {
      await teardown(r.leg)
    }
  })

  it('CR-2c bootstrap control: a reader that does NOT withhold its address is seeded and holds node-B in awaiting-bootstrap', async function () {
    this.timeout(ms(600_000))
    const r = await rebuiltStrandLeg('cr-2c', false)
    try {
      expect(r.inSeed, 'C\'s strand peer IS in node-B\'s bootstrap seed').to.equal(true)
      expect(r.awaitingSeen, 'awaiting-bootstrap is true at least once within 10 s of the re-merge').to.be.at.least(1)
    } finally {
      await teardown(r.leg)
    }
  })
})
