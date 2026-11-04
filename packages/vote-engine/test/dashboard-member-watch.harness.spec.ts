/**
 * dashboard-member-watch.harness.spec.ts — research assumption A1 of phase 66 on REAL loopback nodes.
 * RUN_P2P_HARNESS=1 like every *.harness.spec.ts.
 *
 * Two real enrolled CadreNodes (node-A the owner, node-B a non-owner member; strandReactivity on, the real
 * votetorrent schema) share an open strand. A third node is built the way the officer dashboard will build
 * its own: cadre-core `createEdgeNode` (transaction profile, joined origin, in-memory platform, default
 * transports), admitted by an untargeted single-use invitation whose key was born AFTER the code. It claims
 * the strand with `addStrand`, withdraws its storage services, and watches through `node.reactivityWatch`.
 *
 *   DM-1 a key created after the code is admitted; the joiner holds no owner key and writes no VoteTorrent row
 *   DM-2 reader, not replica: the joiner reaches a strand peer, and no strand node counts it in the root group
 *   DM-3 a commit on node-A wakes the joiner's reactivityWatch (asserted as "it wakes", never as a notification)
 *   DM-4 owner removeMachine reaches the joiner as cadre:removed, and the edge node status becomes removed
 *   DM-5 single use: a second key is refused invite-spent; the admitted key's retry leaves one usage row
 *   DM-6 inviteKey -> CadreInviteUsage.peerId -> listMachines().lastPublishedAt, on the owner and a non-owner
 *   DM-7 (66-06, D-24) a second joiner built with `strandReactivity.edgeHost: true` (the patched cadre-core
 *        option) has an edge cohort-topic host with no willing tier, no engine on either strand node ever
 *        records it as willing, and it still wakes on a commit; strand nodes A and B and the first joiner
 *        (no flag) keep the core profile
 *   DM-7a (not harness-gated) the option's truth table against the installed, patched cadre-core
 *
 * Declared order in the file: DM-1, DM-5, DM-6, DM-2, DM-3, DM-7, DM-4 (DM-7 uses the first joiner as its
 * negative control, and DM-4 removes that joiner, so DM-4 runs last).
 *
 * Stop rule: a red DM-1 or DM-3 is reported as a blocker; no leg is weakened or bypassed to make it green.
 *
 * NOT proven here: a browser, IndexedDB, the browser connection gater, the relay circuit (the later device
 * plans), and officer-table reads.
 *
 * Module-local helpers other plans extend: memoryEdgePlatform, startJoiner, Joiner, attachJoinerStrand, joinerTails.
 */

import { expect } from 'chai'
import type { KeyStore } from '@serfab/cadre-core'
import type { CadreRemoval } from '@serfab/cadre-core'
import {
  describeP2PHarness, startTwoNodeHarness, pollUntil,
  VOTETORRENT_INNER_DDL, HARNESS_SAPP_ID, type TwoNodeHarness
} from './harness/two-node-strand.js'

const SCALE = Number(process.env.P2P_HARNESS_TIMEOUT_SCALE ?? 1)
const CLUSTER_SIZE = 2

function ms (n: number): number {
  return Math.round(n * SCALE)
}

// The './edge-node' subpath is an exports-map entry that this package's `moduleResolution: node` cannot type,
// so the two edge types are named loosely here; the runtime import below is the real module.
type EdgeNode = any
type EdgeNodePlatform = any

export interface Joiner {
  label: string
  edge: EdgeNode
  keyStore: KeyStore
  destroyedScopes: string[]
  removed: CadreRemoval[]
  strandStarted: string[]
  withdrawn: string[]
  stop(): Promise<void>
}

/** The platform the dashboard runs on, with memory for storage and the key store handed in. */
export function memoryEdgePlatform (opts: {
  storageId: string
  keyStore: KeyStore
  strandId: string
  clusterSize: number
  strandReactivity?: Record<string, unknown>
}): { platform: EdgeNodePlatform, destroyedScopes: string[] } {
  const destroyedScopes: string[] = []
  const scopes = new Map<string, any>()
  const local = new Map<string, string>()
  const platform: EdgeNodePlatform = {
    keyStore: opts.keyStore,
    storage: {
      id: opts.storageId,
      rawStorage (scope: string) {
        let s = scopes.get(scope)
        if (s === undefined) {
          if (storageCtor === undefined) throw new Error('memoryEdgePlatform: MemoryRawStorage not loaded')
          s = new storageCtor()
          scopes.set(scope, s)
        }
        return s
      },
      async destroyScope (scope: string) {
        scopes.delete(scope)
        destroyedScopes.push(scope)
      },
      nodeLocal () {
        return {
          get: async (key: string) => local.get(key),
          set: async (key: string, value: string) => { local.set(key, value) },
          flush: async () => undefined,
          delete: async (key: string) => { local.delete(key) }
        }
      },
      async close () { return undefined }
    },
    configure: (cfg: any) => ({
      ...cfg,
      requireSignedSchemas: false,
      strandFilter: { mode: 'strandId', strandId: opts.strandId },
      strandClusterSize: opts.clusterSize,
      strandReactivity: { enabled: true, strandIds: [opts.strandId], ...(opts.strandReactivity ?? {}) }
    })
  }
  return { platform, destroyedScopes }
}

/** Set by the suite's before(): the dynamically imported MemoryRawStorage class. */
let storageCtor: any
/** Set by the suite's before(): the strand every joiner is filtered to. */
let suiteStrandId = ''
/** Set by the suite's before(): the dynamically imported optimystic packages joinerTails composes. */
let tailLibs: { dbCore: any, dbP2p: any } | undefined

/** Create the edge node only. It does not join. */
export async function startJoiner (opts: {
  label: string
  storageId: string
  keyStore?: KeyStore
  strandReactivity?: Record<string, unknown>
}): Promise<Joiner> {
  const { InMemoryKeyStore } = await import('@serfab/cadre-core')
  // @ts-ignore -- exports-map subpath; resolves at runtime
  const { createEdgeNode } = await import('@serfab/cadre-core/edge-node')
  const keyStore: KeyStore = opts.keyStore ?? new InMemoryKeyStore()
  const { platform, destroyedScopes } = memoryEdgePlatform({
    storageId: opts.storageId,
    keyStore,
    strandId: suiteStrandId,
    clusterSize: CLUSTER_SIZE,
    strandReactivity: opts.strandReactivity
  })
  const edge = createEdgeNode(platform)
  const removed: CadreRemoval[] = []
  const strandStarted: string[] = []
  const withdrawn: string[] = []
  const protocolRecord = new Map<string, { before: string[], after: string[] }>()
  ;(edge as any).__protocolRecord = protocolRecord
  edge.on('strand:started', ({ strandId }: { strandId: string }) => {
    strandStarted.push(strandId)
    try {
      const strandNode: any = (edge.node as any)?.getStrand(strandId)?.libp2pNode
      if (strandNode === undefined) throw new Error('no strand node at strand:started')
      const before: string[] = strandNode.getProtocols()
      strandNode.unhandle([`/optimystic/strand-${strandId}/cluster/1.0.0`, `/optimystic/strand-${strandId}/repo/1.0.0`])
      const after: string[] = strandNode.getProtocols()
      protocolRecord.set(strandId, { before, after })
      withdrawn.push(strandId)
    } catch (err) {
      console.log(`[${opts.label}] storage withdrawal failed: ${(err as Error).name}`)
    }
  })
  edge.on('cadre:removed', (removal: CadreRemoval) => { removed.push(removal) })
  const joiner: Joiner = {
    label: opts.label,
    edge,
    keyStore,
    destroyedScopes,
    removed,
    strandStarted,
    withdrawn,
    async stop () {
      try {
        if (edge.status.state !== 'removed') await edge.stop()
      } catch { /* idempotent teardown */ }
    }
  }
  return joiner
}

/** Claim the strand on the joiner (a transaction-profile edge node hosts no unclaimed strand). */
export async function attachJoinerStrand (joiner: Joiner, strandId: string): Promise<{ strandNode: any, strandPeerId: string, protocolsBefore: string[], protocolsAfter: string[] }> {
  const node: any = joiner.edge.node
  if (node === null) throw new Error('attachJoinerStrand: the joiner has no running node')
  try {
    await node.addStrand({
      strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null, FounderPeerId: null },
      sAppConfig: { id: HARNESS_SAPP_ID, version: '1.0.0', schema: VOTETORRENT_INNER_DDL, latencyHint: 'interactive' },
      awaitFirstSync: false
    })
  } catch (err) {
    console.log(`[dm-2] addStrand rejected (${(err as Error).name}); continuing with getStrand`)
  }
  await pollUntil(
    async () => joiner.strandStarted.includes(strandId) && joiner.withdrawn.includes(strandId),
    (v) => v === true,
    { timeoutMs: ms(60_000), label: 'joiner strand started and storage withdrawn' }
  )
  const strandNode = node.getStrand(strandId).libp2pNode
  const record = (joiner.edge as any).__protocolRecord.get(strandId) as { before: string[], after: string[] }
  return { strandNode, strandPeerId: strandNode.peerId.toString(), protocolsBefore: record.before, protocolsAfter: record.after }
}

/** Public's `createPageTailReader` composition, built from vote-engine's own optimystic packages. */
export function joinerTails (strandNode: any, networkName: string): any {
  if (tailLibs === undefined) throw new Error('joinerTails: the optimystic packages are not loaded')
  const libs = tailLibs
  const { NetworkTransactor } = libs.dbCore
  const { RepoClient, stateHoldingsOnReads, committedTailReader, resolveLinkDeadlines } = libs.dbP2p
  const { keyNetwork, coordinatedRepo } = strandNode
  if (!keyNetwork) throw new Error('joinerTails: the strand node carries no keyNetwork attachment')
  if (!coordinatedRepo) throw new Error('joinerTails: the strand node carries no coordinatedRepo attachment')
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

const BASELINE_TABLES = ['User', 'UserKey', 'Officer', 'OfficerSignature', 'AdminSignature'] as const
type BaselineTable = typeof BASELINE_TABLES[number]

async function countRows (db: any, table: BaselineTable): Promise<number> {
  // table is one of the fixed literals above, never input.
  const row = (await db.prepare(`select count(*) as n from ${table}`).get()) as { n: number } | undefined
  return Number(row?.n ?? 0)
}

async function countAll (db: any): Promise<Record<BaselineTable, number>> {
  const out: any = {}
  for (const t of BASELINE_TABLES) out[t] = await countRows(db, t)
  return out
}

describeP2PHarness('a joined member node (the dashboard\'s shape) on real strand nodes', function () {
  this.timeout(600_000)
  let harness: TwoNodeHarness
  let strandId: string
  let shared: Awaited<ReturnType<TwoNodeHarness['openSharedStrand']>>
  let collectionId: string
  let baseline: Record<BaselineTable, number>
  let dbCore: any
  let dbP2p: any
  let cadre: any
  const joiners: Joiner[] = []

  // suite-level state shared by the legs
  let minted: any
  let inviteKey: string
  let tMint = 0
  let joiner: Joiner | undefined
  let joinerPeerId = ''
  let strandCtx: { strandNode: any, strandPeerId: string } | undefined

  async function launch (opts: { label: string, storageId: string, keyStore?: KeyStore, strandReactivity?: Record<string, unknown> }): Promise<Joiner> {
    const j = await startJoiner(opts)
    joiners.push(j)
    return j
  }

  async function machineCount (node: any): Promise<number> {
    return (await node.listMachines()).length
  }

  before(async function () {
    this.timeout(300_000)
    harness = await startTwoNodeHarness({ clusterSize: CLUSTER_SIZE, extraConfig: { strandReactivity: { enabled: true } } })
    cadre = await import('@serfab/cadre-core')
    dbCore = await import('@optimystic/db-core')
    dbP2p = await import('@optimystic/db-p2p')
    storageCtor = dbP2p.MemoryRawStorage
    shared = await harness.openSharedStrand()
    strandId = shared.strandId
    suiteStrandId = strandId
    tailLibs = { dbCore, dbP2p }
    await shared.dbA.exec("insert into TidHighWater (Namespace, HighWater) values ('dm-seed', 1)")
    const optimystic: any = (shared.dbA as any).schemaManager.getModule('optimystic')?.module
    collectionId = optimystic?.tables?.get('app.tidhighwater')?.collection?.collection?.id
    expect(collectionId, 'App.TidHighWater collection id on node-A').to.be.a('string')
    baseline = await countAll(shared.dbA)
    console.log(`[dm-obs] before-join machinesA=${await machineCount(harness.nodeA.node)} machinesB=${await machineCount(harness.nodeB.node)} strand=${strandId}`)
  })

  after(async function () {
    this.timeout(60_000)
    for (const j of joiners) await j.stop()
    await harness?.stop()
  })

  it('DM-1 a key created after the code is admitted by an untargeted single-use invitation, and the joiner writes no VoteTorrent row', async function () {
    this.timeout(ms(240_000))
    tMint = Date.now()
    minted = await harness.nodeA.node.createCadreInvitation({ uses: 1, expiresInMs: 15 * 60_000 })
    expect(minted.invitation.invite.peerId, 'untargeted invitation').to.equal(null)
    expect(minted.invitation.invite.totalUses).to.equal(1)
    inviteKey = minted.invitation.invite.key
    console.log(`[dm-1] minted members=${minted.invitation.members?.length} reach=${JSON.stringify(minted.reach)}`)

    const keyStore = new cadre.InMemoryKeyStore()
    expect((await keyStore.list()).length, 'the joiner key does not exist at mint time').to.equal(0)
    const j = await launch({ label: 'joiner', storageId: 'dm-joiner', keyStore })
    joiner = j
    joinerPeerId = await j.edge.identityPeerId()
    const held = await keyStore.list()
    expect(held).to.include(cadre.DEFAULT_IDENTITY_KEY_ID)
    expect(held).to.not.include(cadre.DEFAULT_OWNER_KEY_ID)
    expect(joinerPeerId).to.not.equal(harness.nodeA.peerId)
    expect(joinerPeerId).to.not.equal(harness.nodeB.peerId)
    expect(await harness.nodeA.node.isAuthorizedMember(joinerPeerId), 'not a member before the join').to.equal(false)

    const invitation = cadre.decodeCadreInvitation(minted.encoded)
    const states: string[] = []
    await j.edge.joinCadre(invitation, {
      relayAddrs: [],
      signal: AbortSignal.timeout(ms(120_000)),
      onProgress: (p: any) => { states.push(p.state); console.log(`[dm-1] progress ${p.state}`) }
    })
    expect(j.edge.status.state).to.equal('running')
    expect(j.edge.ownerPublicKey(), 'D-04: no owner key').to.equal(null)
    await pollUntil(
      async () => harness.nodeA.node.isAuthorizedMember(joinerPeerId),
      (v) => v === true,
      { timeoutMs: ms(60_000), label: 'node-A sees the joiner as a member' }
    )
    console.log(`[dm-1] admitted ${Date.now() - tMint} ms after mint; owner status ${(j.edge.status as any).owner?.toString?.() ?? typeof (j.edge.status as any).owner}`)

    expect(await countAll(shared.dbA), 'row counts on node-A unchanged by the join').to.deep.equal(baseline)
    await new Promise((resolve) => setTimeout(resolve, 5_000))
    expect(await countAll(shared.dbB), 'row counts on node-B unchanged by the join').to.deep.equal(baseline)
    console.log(`[dm-obs] after-join machinesA=${await machineCount(harness.nodeA.node)} machinesB=${await machineCount(harness.nodeB.node)}`)
  })

  it('DM-5 single use: a second key is refused invite-spent, and the admitted key\'s retry is answered as a member', async function () {
    this.timeout(ms(180_000))
    if (joiner === undefined) throw new Error('DM-5 needs DM-1 to have admitted the joiner')
    const usagesOn = async (node: any): Promise<any[]> =>
      (await node.getControlDatabase().queryCadreInviteUsages()).filter((r: any) => r.inviteKey === inviteKey)
    await pollUntil(async () => usagesOn(harness.nodeA.node), (rows) => rows.length === 1 && rows[0].peerId === joinerPeerId, { timeoutMs: ms(60_000), label: 'node-A holds the one usage row' })
    await pollUntil(async () => usagesOn(harness.nodeB.node), (rows) => rows.length === 1 && rows[0].peerId === joinerPeerId, { timeoutMs: ms(60_000), label: 'node-B holds the one usage row' })

    const intruder = await launch({ label: 'intruder', storageId: 'dm-intruder' })
    let code: unknown
    let name = ''
    try {
      await intruder.edge.joinCadre(cadre.decodeCadreInvitation(minted.encoded), { relayAddrs: [], signal: AbortSignal.timeout(ms(120_000)) })
      throw new Error('the second key was admitted')
    } catch (err) {
      name = (err as Error).name
      code = (err as any).code
      console.log(`[dm-5] intruder refused: ${name} code=${String(code)}`)
    }
    expect(code, 'refusal code').to.equal('invite-spent')
    expect(await harness.nodeA.node.isAuthorizedMember(await intruder.edge.identityPeerId()), 'intruder is no member').to.equal(false)
    await intruder.stop()

    await joiner.edge.node!.redeemCadreInvitation(cadre.decodeCadreInvitation(minted.encoded))
    expect((await usagesOn(harness.nodeA.node)).length, 'one usage row after the wire retry').to.equal(1)
    const listed = (await harness.nodeA.node.listCadreInvitations()).find((e: any) => e.invite?.key === inviteKey)
    expect(listed, 'the invitation is listed').to.not.equal(undefined)
    expect(listed.usesRecorded).to.equal(1)

    const again = await joiner.edge.joinCadre(cadre.decodeCadreInvitation(minted.encoded), { relayAddrs: [], signal: AbortSignal.timeout(ms(120_000)) })
    console.log(`[dm-5] same-key joinCadre on the running node resolved; fields: ${Object.keys(again ?? {}).join(',')}`)
    expect((await usagesOn(harness.nodeA.node)).length, 'one usage row after the joinCadre retry').to.equal(1)
  })

  it('DM-6 inviteKey -> CadreInviteUsage.peerId -> listMachines().lastPublishedAt, on the owner and on a non-owner member', async function () {
    this.timeout(ms(120_000))
    if (joiner === undefined) throw new Error('DM-6 needs DM-1 to have admitted the joiner')
    for (const [name, node] of [['node-A', harness.nodeA.node], ['node-B', harness.nodeB.node]] as const) {
      const rows = (await node.getControlDatabase().queryCadreInviteUsages()).filter((r: any) => r.inviteKey === inviteKey)
      expect(rows.length, `${name} usage rows`).to.equal(1)
      expect(rows[0].peerId).to.equal(joinerPeerId)
      const machine = await pollUntil(
        async () => (await node.listMachines()).find((m: any) => m.peerId === joinerPeerId),
        (m) => m !== undefined && typeof m.lastPublishedAt === 'number',
        { timeoutMs: ms(60_000), label: `${name} lists the joiner with a lastPublishedAt` }
      )
      const at = machine.lastPublishedAt as number
      expect(at).to.be.at.least(tMint - 5_000)
      expect(at).to.be.at.most(Date.now() + 5_000)
      console.log(`[dm-6] ${name} lastPublishedAt age ${Date.now() - at} ms`)
    }
  })

  it('DM-2 reader, not replica: the joiner withdraws the strand storage services and no strand node counts it in the root group', async function () {
    this.timeout(ms(180_000))
    if (joiner === undefined) throw new Error('DM-2 needs DM-1 to have admitted the joiner')
    const attached = await attachJoinerStrand(joiner, strandId)
    strandCtx = attached
    console.log(`[dm-2] ids identity=${joinerPeerId} strand=${attached.strandPeerId} differ=${joinerPeerId !== attached.strandPeerId}`)
    const cluster = `/optimystic/strand-${strandId}/cluster/1.0.0`
    const repo = `/optimystic/strand-${strandId}/repo/1.0.0`
    expect(attached.protocolsBefore, 'cluster protocol handled before withdrawal').to.include(cluster)
    expect(attached.protocolsBefore, 'repo protocol handled before withdrawal').to.include(repo)
    expect(attached.protocolsAfter).to.not.include(cluster)
    expect(attached.protocolsAfter).to.not.include(repo)

    const t0 = Date.now()
    const strandNode = attached.strandNode
    await pollUntil(async () => strandNode.getConnections().length, (n) => n > 0, { timeoutMs: ms(60_000), label: 'joiner strand node connected' })
    const remotes: string[] = strandNode.getConnections().map((c: any) => c.remotePeer.toString())
    const strandA = harness.nodeA.node.getStrand(strandId).libp2pNode.peerId.toString()
    const strandB = harness.nodeB.node.getStrand(strandId).libp2pNode.peerId.toString()
    expect(remotes.some((r) => r === strandA || r === strandB), `connected to a strand peer (${remotes.length} connections)`).to.equal(true)
    console.log(`[dm-2] strand connected ${Date.now() - t0} ms`)

    const networkName = `strand-${strandId}`
    const tails = joinerTails(strandNode, networkName)
    const tailAnswer: any = await pollUntil(
      async () => (await tails.readTails([{ collectionId }])).get(collectionId),
      (a) => a?.tail?.tailId !== undefined,
      { timeoutMs: ms(60_000), label: 'joiner reads the committed tail' }
    )
    const coord = dbCore.reactivityRootCoord(dbP2p.reactivityTailBytes(tailAnswer.tail.tailId))
    for (const [w, h] of [['A', harness.nodeA], ['B', harness.nodeB]] as const) {
      const raw = h.node.getStrand(strandId).libp2pNode
      const group: string[] = await pollUntil(
        async () => (await raw.keyNetwork.servingCohortAt(coord)) as string[],
        (m) => !m.includes(attached.strandPeerId),
        { timeoutMs: ms(30_000), label: `joiner out of node-${w}'s root group` }
      )
      console.log(`[dm-obs] root-group node-${w} size=${group.length}`)
    }
  })

  it('DM-3 a commit on node-A wakes the joiner\'s reactivityWatch (it wakes; not asserted as a notification)', async function () {
    this.timeout(ms(240_000))
    if (strandCtx === undefined) throw new Error('DM-3 needs DM-2 to have attached the strand')
    const { strandNode } = strandCtx
    expect(strandNode.reactivityWatch, 'joiner strand node reactivityWatch').to.not.equal(undefined)
    let wakes = 0
    const tails = joinerTails(strandNode, `strand-${strandId}`)
    const handle = strandNode.reactivityWatch.watch({ collectionId, tails, onChange: () => { wakes++ } })
    try {
      const t0 = Date.now()
      await pollUntil(async () => wakes, (n) => n >= 1, { timeoutMs: ms(90_000), label: 'first committed-tail read wakes the joiner' })
      console.log(`[dm-3] first wake ${Date.now() - t0} ms`)

      let landings = 0
      let deliveries = 0
      const off = strandNode.storageRepo?.onCollectionChange?.(collectionId, () => { landings++ })
      const subscribers = strandNode.reactivitySubscribers
      const deliver = subscribers?.deliver?.bind(subscribers)
      if (deliver !== undefined) subscribers.deliver = (...args: any[]) => { deliveries++; return deliver(...args) }

      const dbA = await harness.nodeA.openStrand(strandId)
      const base = wakes
      const t1 = Date.now()
      await dbA.exec("insert into TidHighWater (Namespace, HighWater) values ('dm-3', 3)")
      await pollUntil(async () => wakes, (n) => n > base, { timeoutMs: ms(90_000), label: 'node-A commit wakes the joiner' })
      const isAttached = strandNode.reactivityWatch.isAttached?.(collectionId)
      console.log(`[dm-3] commit wake ${Date.now() - t1} ms; attached ${isAttached}; deliveries ${deliveries}; landings ${landings}`)
      off?.()
    } finally {
      await handle.close()
    }
  })

  it('DM-7 an edgeHost joiner subscribes but is never a forwarder; the strand nodes keep the core profile', async function () {
    this.timeout(ms(420_000))
    if (strandCtx === undefined) throw new Error('DM-7 needs DM-2 to have attached the first joiner (its negative control)')

    // A fresh untargeted single-use invitation, as DM-1 mints it.
    const minted7 = await harness.nodeA.node.createCadreInvitation({ uses: 1, expiresInMs: 15 * 60_000 })
    expect(minted7.invitation.invite.peerId, 'untargeted invitation').to.equal(null)
    expect(minted7.invitation.invite.totalUses).to.equal(1)
    const edgeJoiner = await launch({ label: 'edge-joiner', storageId: 'dm-edge-joiner', strandReactivity: { edgeHost: true } })
    const edgePeerId = await edgeJoiner.edge.identityPeerId()
    await edgeJoiner.edge.joinCadre(cadre.decodeCadreInvitation(minted7.encoded), {
      relayAddrs: [],
      signal: AbortSignal.timeout(ms(120_000))
    })
    await pollUntil(
      async () => harness.nodeA.node.isAuthorizedMember(edgePeerId),
      (v) => v === true,
      { timeoutMs: ms(60_000), label: 'node-A sees the edge joiner as a member' }
    )
    const attached = await attachJoinerStrand(edgeJoiner, strandId)
    const edgeStrandNode = attached.strandNode
    const edgeStrandPeerId = attached.strandPeerId

    // Structural: the flag, not the edge-node platform, makes the difference.
    const edgeProfileSeen = edgeStrandNode.cohortTopicHost?.profile
    expect(edgeProfileSeen, 'edge joiner strand node has a cohort-topic host').to.not.equal(undefined)
    expect(edgeProfileSeen.kind, 'edge joiner host kind').to.equal('edge')
    expect(edgeProfileSeen.willingTiers.size, 'edge joiner willing tiers').to.equal(0)
    const strandNodeA = harness.nodeA.node.getStrand(strandId).libp2pNode
    const strandNodeB = harness.nodeB.node.getStrand(strandId).libp2pNode
    for (const [w, n] of [['A', strandNodeA], ['B', strandNodeB]] as const) {
      expect(n.cohortTopicHost?.profile?.kind, `strand node ${w} host kind`).to.equal('core')
      expect(n.cohortTopicHost.profile.willingTiers.size, `strand node ${w} willing tiers`).to.be.greaterThan(0)
    }
    const control = strandCtx.strandNode.cohortTopicHost?.profile
    expect(control?.kind, 'negative control: the first joiner (no flag) keeps the core profile').to.equal('core')
    console.log(`[dm-7] profiles edge-joiner=${edgeProfileSeen.kind}/${edgeProfileSeen.willingTiers.size} A=${strandNodeA.cohortTopicHost.profile.kind}/${strandNodeA.cohortTopicHost.profile.willingTiers.size} B=${strandNodeB.cohortTopicHost.profile.kind}/${strandNodeB.cohortTopicHost.profile.willingTiers.size} first-joiner=${control.kind}`)

    // Behavioural: sample every engine on A and B while the edge joiner watches and wakes on a commit.
    let samples = 0
    let maxEngines = 0
    let enginesSeen = 0
    const willingSightings: string[] = []
    const sample = (): void => {
      let engines = 0
      for (const [w, n] of [['A', strandNodeA], ['B', strandNodeB]] as const) {
        for (const engine of n.cohortTopicHost.registry.all()) {
          engines++
          const view = engine.cohortView()
          for (const id of [edgeStrandPeerId, edgePeerId]) {
            const willingness = view.get(id)?.willingness ?? 0
            if (willingness !== 0) willingSightings.push(`${w}:${willingness}`)
          }
        }
      }
      samples++
      enginesSeen += engines
      maxEngines = Math.max(maxEngines, engines)
    }
    const sampler = setInterval(sample, 1000)

    let wakes = 0
    const tails = joinerTails(edgeStrandNode, `strand-${strandId}`)
    const handle = edgeStrandNode.reactivityWatch.watch({ collectionId, tails, onChange: () => { wakes++ } })
    try {
      sample()
      const t0 = Date.now()
      await pollUntil(async () => wakes, (n) => n >= 1, { timeoutMs: ms(90_000), label: 'first committed-tail read wakes the edge joiner' })
      console.log(`[dm-7] first wake ${Date.now() - t0} ms`)
      const dbA = await harness.nodeA.openStrand(strandId)
      const base = wakes
      const t1 = Date.now()
      await dbA.exec("insert into TidHighWater (Namespace, HighWater) values ('dm-7', 7)")
      await pollUntil(async () => wakes, (n) => n > base, { timeoutMs: ms(2 * 20_000 + 30_000), label: 'node-A commit wakes the edge joiner' })
      console.log(`[dm-7] commit wake ${Date.now() - t1} ms`)
      // At least 10 samples across the window, however fast the wake came.
      await pollUntil(async () => samples, (n) => n >= 10, { timeoutMs: ms(30_000), label: 'ten willingness samples' })
    } finally {
      clearInterval(sampler)
      await handle.close()
    }
    console.log(`[dm-7] willingness samples=${samples} maxEngines=${maxEngines} engineReads=${enginesSeen} willingSightings=${willingSightings.length}`)
    expect(samples, 'willingness samples').to.be.at.least(10)
    expect(maxEngines, 'engines examined on A or B (zero would be vacuous)').to.be.at.least(1)
    expect(willingSightings, 'no engine on A or B records the edge joiner as willing').to.deep.equal([])
    await edgeJoiner.stop()
  })

  it('DM-4 owner removeMachine reaches the joiner as cadre:removed', async function () {
    this.timeout(ms(180_000))
    if (joiner === undefined) throw new Error('DM-4 needs DM-1 to have admitted the joiner')
    console.log(`[dm-obs] before-removal machinesA=${await machineCount(harness.nodeA.node)} machinesB=${await machineCount(harness.nodeB.node)}`)
    const t0 = Date.now()
    const writes = await harness.nodeA.node.removeMachine(joinerPeerId)
    expect(writes.removedPeer).to.equal(true)
    await pollUntil(async () => joiner!.removed.length, (n) => n >= 1, { timeoutMs: ms(60_000), label: 'joiner receives cadre:removed' })
    console.log(`[dm-4] cadre:removed after ${Date.now() - t0} ms; withdrawnInvitations ${writes.withdrawnInvitations?.length}; destroyedScopes ${joiner!.destroyedScopes.length}`)
    expect(joiner!.removed[0]?.partyId).to.equal(harness.partyId)
    await pollUntil(async () => joiner!.edge.status.state, (s) => s === 'removed', { timeoutMs: ms(60_000), label: 'joiner edge status removed' })
    expect(await harness.nodeA.node.isAuthorizedMember(joinerPeerId)).to.equal(false)
    const machines = await harness.nodeA.node.listMachines()
    expect(machines.some((m: any) => m.peerId === joinerPeerId), 'removed machine no longer listed').to.equal(false)
    console.log(`[dm-obs] after-removal machinesA=${machines.length} machinesB=${await machineCount(harness.nodeB.node)}`)
  })
})

// DM-7a runs in the ordinary suite (no RUN_P2P_HARNESS): the patched option's truth table against the
// installed cadre-core copy this package resolves.
describe('DM-7a strandReactivity.edgeHost option (patched cadre-core)', () => {
  let option: (config: unknown, strandId: string) => any

  before(async () => {
    const cadreCore: any = await import('@serfab/cadre-core')
    option = cadreCore.strandCohortTopicOption
  })

  it('DM-7a-1 enabled:true keeps the unpatched slice (no host key)', () => {
    const r = option({ enabled: true }, 'y')
    expect(r).to.deep.equal({ cohortTopic: { enabled: true } })
    expect('host' in r.cohortTopic).to.equal(false)
  })

  it('DM-7a-2 edgeHost:false keeps the unpatched slice (no host key)', () => {
    const r = option({ enabled: true, edgeHost: false }, 'y')
    expect(r).to.deep.equal({ cohortTopic: { enabled: true } })
    expect('host' in r.cohortTopic).to.equal(false)
  })

  it("DM-7a-3 a non-boolean edgeHost ('true') fails closed to the unpatched slice", () => {
    expect(option({ enabled: true, edgeHost: 'true' }, 'y')).to.deep.equal({ cohortTopic: { enabled: true } })
  })

  it('DM-7a-4 enabled:false with edgeHost:true enables nothing', () => {
    expect(option({ enabled: false, edgeHost: true }, 'y')).to.deep.equal({})
  })

  it('DM-7a-5 a strand outside strandIds with edgeHost:true enables nothing', () => {
    expect(option({ enabled: true, strandIds: ['x'], edgeHost: true }, 'y')).to.deep.equal({})
  })

  it('DM-7a-6 edgeHost:true builds an edge host with no willing tier and minSigs 1', () => {
    const host = option({ enabled: true, edgeHost: true }, 'y').cohortTopic.host
    expect(host.profile.kind).to.equal('edge')
    expect(host.profile.willingTiers.size).to.equal(0)
    expect(host.minSigs).to.equal(1)
  })
})
