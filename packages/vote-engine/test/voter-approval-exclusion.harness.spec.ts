/**
 * voter-approval-exclusion.harness.spec.ts — a Voter phone approves nothing: it is in none of the authority's
 * control or strand write cohorts, yet it still writes its own registration and self record, reads the officer's
 * decision, and a silent Voter cannot slow the authority's writes. RUN_P2P_HARNESS=1 like every *.harness.spec.ts.
 *
 * Defect (2026-11-13, lean rig over the real relay): with the emulator Voter in the network, release took 298 s and
 * publish 77.6 s (1.5 s / 0.18 s host-only). db-p2p waits on EVERY cohort member, and today's Voter (profile
 * 'transaction', which only sets FRET 'edge') is a member of every control and strand cohort. User decision
 * 2026-11-16: the Voter app is not in any approval group (doc/architecture.md: "Transaction only (mobile)").
 *
 * Candidate fix under test: the Voter's CadreNode sets cadre-core `edgeReaderProtocol` (the dashboard's declaration:
 * the marker on its control and strand nodes, and its strand node withdraws the cluster/repo storage services), so
 * every host's edge-reader refusal keeps it out. Open question this spec answers: a dashboard only READS, so no
 * node in this posture has ever written.
 *
 *   VX-1  today's Voter (no marker) is in the authority's control and strand cohorts (the cause)
 *   VX-2  a declaring Voter is in none of A's or B's control or strand cohorts
 *   VX-3  the declaring Voter's own writes land: a staged registration (strand) reaches B; its self record (control)
 *   VX-4  the declaring Voter reads B's decision on its registration
 *   VX-6  its hot-path strand reads (decision poll, staging count, point read) at a few hundred rows, vs member B
 *   VX-7  a control write by A reaches its control reads (it gets no control commits pushed), vs member B
 *   VX-5  with the declaring Voter silent, A's control and strand writes stay fast
 *   VX-8  (reading only) offline, what it can still read
 */
import { expect } from 'chai'
import { describeP2PHarness, startTwoNodeHarness, pollUntil, HARNESS_SAPP_ID, VOTETORRENT_INNER_DDL, HARNESS_TIMEOUTS, type TwoNodeHarness } from './harness/two-node-strand.js'
import { bootHarnessNetwork, regMakeInit, regDigest, makeRequesterSigner, type HarnessWorkflowNetwork } from './fixtures/harness-workflows.js'
import { P2pRegistrationTransport } from '../src/registration/transport/p2p-registration-transport.js'
import { IntakeEngine, createIntakeSealer, intakeQueryPortFromDb, resolveIntakeRecipients } from '../src/intake/index.js'
import { InMemoryTestKeyVault } from '../src/crypto/vault.js'
import { makeTestSignCallback } from './fixtures/test-context.js'
import { registerDbPlugins, declareViewsInMain } from '../src/database/initialize.js'
import { createEdgeReaderRefusal, EDGE_READER_CONTROL_KEY, EDGE_READER_PROTOCOL } from '../src/network/edge-reader-refusal.js'
import { VOTETORRENT_SCHEMA_VERSION } from '../src/database/schema-version.js'

const SCALE = Number(process.env.P2P_HARNESS_TIMEOUT_SCALE ?? 1)
const ms = (n: number): number => Math.round(n * SCALE)
const SAMPLE_KEYS = 16
/** A write that waits on a silent cohort member costs (3 s dial + 10 s response) x 2 per round; a healthy one, ms. */
const WRITE_BOUND_MS = ms(15_000)

interface Voter {
  node: any
  peerId: string
  /** The voter's strand node has its own peer id (cadre-core StrandPeer), not the control one. */
  strandPeerId: string
  db: any
  port: { query<T>(sql: string, params: Record<string, unknown>): Promise<T[]>, mutate(sql: string, params: Record<string, unknown>): Promise<void>, close(): Promise<void> }
  stop(): Promise<void>
}

describeP2PHarness('a Voter approves nothing yet still writes and reads its own rows (voter approval exclusion)', function () {
  this.timeout(ms(1_200_000))
  let cadre: any
  let harness: TwoNodeHarness | undefined
  let network: HarnessWorkflowNetwork
  let authorityId = ''
  let vaultB: InMemoryTestKeyVault
  let voter: Voter | undefined
  const stopped: Voter[] = []

  before(async function () {
    this.timeout(ms(400_000))
    cadre = await import('@serfab/cadre-core')
    harness = await startTwoNodeHarness({ clusterSize: 4, extraConfig: { strandReactivity: { enabled: true } }, cohortRefusal: true })
    network = await bootHarnessNetwork(harness)
    authorityId = network.auth.authority.id
    // An officer encryption key (registered on B) so a staged registration has a recipient (D-32).
    vaultB = new InMemoryTestKeyVault()
    const reg = await new IntakeEngine(network.ctxB).registerOfficerEncryptionKey(authorityId, vaultB, makeTestSignCallback(network.net.user))
    expect(reg.status).to.equal('registered')
    await pollUntil(async () => resolveIntakeRecipients(intakeQueryPortFromDb(network.dbA), authorityId), (s) => s.recipients.length === 1,
      { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: 'officer encryption key reaches node-A' })
  })

  after(async function () {
    this.timeout(ms(120_000))
    for (const v of [voter, ...stopped]) { try { await v?.stop() } catch { /* idempotent */ } }
    try { await harness?.stop() } catch { /* idempotent */ }
  })

  /** The Voter app's CadreNode shape (CadreNodeProvider.tsx), plus `edgeReaderProtocol` when `declares`. */
  async function startVoter (declares: boolean): Promise<Voter> {
    const { CadreNode } = cadre
    const { MemoryRawStorage } = await import('@optimystic/db-p2p')
    const { webSockets } = await import('@libp2p/websockets')
    const { generateKeyPair } = await import('@libp2p/crypto/keys')
    const storage = new MemoryRawStorage()
    const refusal = createEdgeReaderRefusal()
    const node: any = new CadreNode({
      privateKey: await generateKeyPair('Ed25519'),
      controlNetwork: { partyId: harness!.partyId, bootstrapNodes: [] },
      requireSignedSchemas: false,
      strandFilter: { mode: 'all' },
      storage: { provider: () => storage },
      strandClusterSize: 4,
      hibernation: { enabled: false },
      nodeClass: 'device',
      network: { transports: [webSockets()], listenAddrs: ['/ip4/127.0.0.1/tcp/0/ws'] },
      strandReactivity: { enabled: true },
      strandCohortRefusal: refusal.hook,
      controlCohortRefusal: refusal.control,
      ...(declares ? { edgeReaderProtocol: EDGE_READER_PROTOCOL } : {})
    } as any)
    await node.start()
    const peerId = node.peerId.toString()
    const { encoded } = await harness!.nodeA.node.createCadreInvitation({ uses: 1, expiresInMs: 15 * 60_000 })
    await node.redeemCadreInvitation(cadre.decodeCadreInvitation(encoded))
    await pollUntil(async () => await harness!.nodeA.node.isAuthorizedMember(peerId), (v) => v === true,
      { timeoutMs: ms(60_000), label: `A sees the voter (declares=${String(declares)}) as a member` })
    await node.addStrand({
      strandRow: { Id: network.hash, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null, FounderPeerId: null },
      sAppConfig: { id: HARNESS_SAPP_ID, version: '1.0.0', schema: VOTETORRENT_INNER_DDL, schemaVersion: VOTETORRENT_SCHEMA_VERSION, latencyHint: 'interactive' },
      founder: false,
      awaitFirstSync: false
    })
    await node.whenStrandWritable(network.hash, { timeoutMs: ms(120_000) })
    const db = node.getStrand(network.hash).database.getDatabase()
    db.setSchemaPath(['App', 'main'])
    await registerDbPlugins(db)
    await declareViewsInMain(db)
    await pollUntil(async () => (await db.prepare('select Id from Authority where Id = :id').get({ id: authorityId }))?.Id ?? null,
      (v) => v === authorityId, { timeoutMs: ms(120_000), label: `the voter (declares=${String(declares)}) reads the Authority row` })
    const port = {
      async query<T> (sql: string, params: Record<string, unknown>): Promise<T[]> {
        const rows: T[] = []
        for await (const row of db.eval(sql, params as any)) rows.push(row as unknown as T)
        return rows
      },
      async mutate (sql: string, params: Record<string, unknown>): Promise<void> { await db.exec(sql, params as any) },
      async close (): Promise<void> { /* shared strand */ }
    }
    const strandPeerId = node.getStrand(network.hash).libp2pNode.peerId.toString()
    return { node, peerId, strandPeerId, db, port, stop: async () => { await node.stop() } }
  }

  /** How many of SAMPLE_KEYS sampled cohorts on `kn` name `peerId`. */
  async function hits (kn: any, peerId: string, prefix: string): Promise<number> {
    let n = 0
    for (let i = 0; i < SAMPLE_KEYS; i++) {
      if (Object.keys(await kn.findCluster(new TextEncoder().encode(`${prefix}-${i}`))).includes(peerId)) n++
    }
    return n
  }
  const controlKn = (node: any): any => node.getControlNode()?.keyNetwork
  const strandKn = (node: any): any => node.getStrand(network.hash)?.libp2pNode?.keyNetwork

  /** Every cohort reading of `peerId` from A's and B's side, and from the voter's own side. */
  async function cohortReadings (v: Voter): Promise<Record<string, number>> {
    // Give FRET and identify a moment to see the voter on both rings.
    const out: Record<string, number> = {}
    for (const [name, h] of [['A', harness!.nodeA.node], ['B', harness!.nodeB.node]] as const) {
      out[`${name}.control`] = await hits(controlKn(h), v.peerId, 'vx-c')
      out[`${name}.strand`] = await hits(strandKn(h), v.strandPeerId, 'vx-s')
    }
    out['self.control'] = await hits(controlKn(v.node), v.peerId, 'vx-c')
    out['self.strand'] = await hits(strandKn(v.node), v.strandPeerId, 'vx-s')
    return out
  }

  it('VX-1 today\'s Voter (no edge-reader declaration) is in the authority\'s control and strand cohorts (the cause)', async function () {
    const v0 = await startVoter(false)
    stopped.push(v0)
    // The voter is learned through FRET and identify; wait until A's control cohorts name it.
    await pollUntil(async () => hits(controlKn(harness!.nodeA.node), v0.peerId, 'vx-c'), (n) => n > 0,
      { timeoutMs: ms(60_000), intervalMs: 1000, label: 'A\'s control cohorts name today\'s voter' }).catch(() => 0)
    await pollUntil(async () => hits(strandKn(harness!.nodeA.node), v0.strandPeerId, 'vx-s'), (n) => n > 0,
      { timeoutMs: ms(60_000), intervalMs: 1000, label: 'A\'s strand cohorts name today\'s voter' }).catch(() => 0)
    const r = await cohortReadings(v0)
    console.log(`[vx-1] today's voter ${v0.peerId.slice(-6)} cohort hits /${SAMPLE_KEYS}: ${JSON.stringify(r)}`)
    expect(r['A.control'], 'A puts today\'s voter in its control cohorts').to.equal(SAMPLE_KEYS)
    expect(r['A.strand'], 'A puts today\'s voter in its strand cohorts').to.equal(SAMPLE_KEYS)
    await v0.stop()
  })

  it('VX-2 a declaring Voter is in none of A\'s or B\'s control or strand cohorts', async function () {
    voter = await startVoter(true)
    const vId = voter.peerId
    await pollUntil(async () => harness!.nodeA.cohortRefusal?.has(EDGE_READER_CONTROL_KEY, vId) === true, (v) => v,
      { timeoutMs: ms(30_000), label: 'A\'s control refusal learned the voter' })
    await pollUntil(async () => harness!.nodeA.cohortRefusal?.has(network.hash, voter!.strandPeerId) === true, (v) => v,
      { timeoutMs: ms(30_000), label: 'A\'s strand refusal learned the voter' }).catch(() => false)
    const ctlRec: any = await harness!.nodeA.node.getControlNode().peerStore.get(voter.node.getControlNode().peerId)
    expect(ctlRec.protocols, 'the voter\'s control identify names the marker').to.include(EDGE_READER_PROTOCOL)
    const r = await cohortReadings(voter)
    const bInA = await hits(controlKn(harness!.nodeA.node), harness!.nodeB.peerId, 'vx-c')
    console.log(`[vx-2] declaring voter ${vId.slice(-6)} cohort hits /${SAMPLE_KEYS}: ${JSON.stringify(r)}; B in A's control ${bInA}/${SAMPLE_KEYS}; ` +
      `A strand refusal has voter=${String(harness!.nodeA.cohortRefusal?.has(network.hash, voter.strandPeerId))}`)
    expect(r['A.control'], 'not in A\'s control cohorts').to.equal(0)
    expect(r['B.control'], 'not in B\'s control cohorts').to.equal(0)
    expect(r['A.strand'], 'not in A\'s strand cohorts').to.equal(0)
    expect(r['B.strand'], 'not in B\'s strand cohorts').to.equal(0)
    expect(bInA, 'B still is').to.equal(SAMPLE_KEYS)
  })

  let requestId = ''

  it('VX-3 the declaring Voter\'s own writes land: a staged registration (strand) reaches B, and its self record (control)', async function () {
    const v = voter!
    const transportV = new P2pRegistrationTransport({
      openStrand: async () => v.port,
      computeDigest: regDigest,
      strandId: network.hash,
      sealer: createIntakeSealer({ port: intakeQueryPortFromDb(v.db), authorityId })
    })
    await pollUntil(async () => resolveIntakeRecipients(intakeQueryPortFromDb(v.db), authorityId), (s) => s.recipients.length === 1,
      { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: 'the voter reads the officer encryption key' })
    requestId = `vx3-${harness!.runId}`
    const signer = makeRequesterSigner()
    let t0 = Date.now()
    await transportV.submitRequest(regMakeInit(authorityId, { id: requestId }), signer.publicHex, signer.sign)
    const stageMs = Date.now() - t0
    const transportB = new P2pRegistrationTransport({
      openStrand: network.portB,
      computeDigest: regDigest,
      strandId: network.hash,
      opener: new IntakeEngine(network.ctxB).createOpener(vaultB),
      decisionSigner: { authorityId, sign: makeTestSignCallback(network.net.user) }
    })
    t0 = Date.now()
    const report = await pollUntil(async () => transportB.readStagedRequestsReport(), (r) => r.delivered.some((d) => d.requestId === requestId),
      { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: 'the voter\'s staged registration reaches B' })
    const reachMs = Date.now() - t0
    expect(report.delivered.find((d) => d.requestId === requestId)?.requesterKey).to.equal(signer.publicHex)
    t0 = Date.now()
    const self = await v.node.publishSelfRecord()
    const selfMs = Date.now() - t0
    console.log(`[vx-3] voter staged registration ${stageMs} ms, reached B in ${reachMs} ms; self record ${String(self)} in ${selfMs} ms`)
    expect(stageMs, 'the voter\'s strand write completes promptly').to.be.below(WRITE_BOUND_MS)
    expect(selfMs, 'the voter\'s control write completes promptly').to.be.below(WRITE_BOUND_MS)
    expect(self, 'the self record was written, not skipped').to.not.equal('skipped')
    decisionTransportB = transportB
  })

  let decisionTransportB: P2pRegistrationTransport | undefined

  it('VX-4 the declaring Voter reads B\'s decision on its registration', async function () {
    await decisionTransportB!.publishDecision({ requestId, status: 'a', decidedAt: new Date().toISOString() })
    const transportV = new P2pRegistrationTransport({ openStrand: async () => voter!.port, computeDigest: regDigest, strandId: network.hash })
    const t0 = Date.now()
    const polled = await pollUntil(async () => transportV.pollDecisions(), (ps) => ps.some((p) => p.requestId === requestId),
      { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: 'B\'s decision reaches the voter' })
    console.log(`[vx-4] decision reached the voter in ${Date.now() - t0} ms`)
    expect(polled.find((p) => p.requestId === requestId)?.status).to.equal('a')
  })

  /** Milliseconds per call of `fn`, `n` times in a row. */
  async function timeEach (n: number, fn: () => Promise<unknown>): Promise<number[]> {
    const out: number[] = []
    for (let i = 0; i < n; i++) { const t0 = Date.now(); await fn(); out.push(Date.now() - t0) }
    return out
  }
  const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
  const STAGED_ROWS = Number(process.env.VX_STAGED_ROWS ?? 200)

  it('VX-6 the declaring Voter\'s hot-path strand reads (decision poll, staging count, point read) at a few hundred rows, vs member B', async function () {
    // votetorrent-67 review 2026-11-16: a node that stores nothing may read every block from the network on every poll.
    const transportA = new P2pRegistrationTransport({
      openStrand: network.portA, computeDigest: regDigest, strandId: network.hash,
      sealer: createIntakeSealer({ port: intakeQueryPortFromDb(network.dbA), authorityId })
    })
    const signer = makeRequesterSigner()
    const ids: string[] = []
    let t0 = Date.now()
    for (let i = 0; i < STAGED_ROWS; i++) {
      const id = `vx6-${harness!.runId}-${i}`
      ids.push(id)
      await transportA.submitRequest(regMakeInit(authorityId, { id }), signer.publicHex, signer.sign)
    }
    for (const id of ids.slice(0, Math.floor(STAGED_ROWS / 2))) await decisionTransportB!.publishDecision({ requestId: id, status: 'a', decidedAt: new Date().toISOString() })
    const seedMs = Date.now() - t0
    const countSql = 'select count(*) as n from RegistrationRequestStaging where StrandId = :strandId'
    const want = STAGED_ROWS + 1 // + VX-3's request
    for (const [label, port] of [['voter', voter!.port], ['B', await network.portB()]] as const) {
      await pollUntil(async () => Number((await port.query<{ n: number }>(countSql, { strandId: network.hash }))[0]?.n ?? 0), (n) => n >= want,
        { timeoutMs: ms(180_000), intervalMs: 1000, label: `${label} sees ${want} staged rows` })
    }
    const readings: Record<string, Record<string, number[]>> = {}
    for (const [label, port] of [['voter', voter!.port], ['B', await network.portB()]] as const) {
      const t = new P2pRegistrationTransport({ openStrand: async () => port, computeDigest: regDigest, strandId: network.hash })
      readings[label] = {
        pollDecisions: await timeEach(5, async () => t.pollDecisions()),
        stagingCount: await timeEach(5, async () => port.query(countSql, { strandId: network.hash })),
        pointRead: await timeEach(5, async () => port.query('select RequestId from RegistrationRequestStaging where RequestId = :id', { id: ids[ids.length - 1]! }))
      }
    }
    const summary = Object.fromEntries(Object.entries(readings).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([q, xs]) => [q, `first ${xs[0]} med ${median(xs)} ms`]))]))
    console.log(`[vx-6] seeded ${STAGED_ROWS} staged + ${Math.floor(STAGED_ROWS / 2)} decisions in ${seedMs} ms; reads ${JSON.stringify(summary)}`)
    // The Voter's confirm screen polls decisions every 2 s: a poll slower than that would stack up.
    expect(median(readings.voter!.pollDecisions!), 'the voter\'s decision poll finishes inside its 2 s interval').to.be.below(2000)
  })

  it('VX-7 a control write by A reaches the declaring Voter\'s control reads (vs member B)', async function () {
    // votetorrent-67 review: the refused voter gets no control commits pushed to it, so it relies on remote reads / repair.
    const aId = harness!.nodeA.peerId
    const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? Buffer.from(x).toString('hex') : x)
    await harness!.nodeA.node.publishSelfRecord()
    const fresh = stable(await harness!.nodeA.node.getControlDatabase().queryPeerRecord(aId))
    const seen: Record<string, number> = {}
    const t0 = Date.now()
    for (const [label, node] of [['voter', voter!.node], ['B', harness!.nodeB.node]] as const) {
      await pollUntil(async () => stable(await node.getControlDatabase().queryPeerRecord(aId)), (s) => s === fresh,
        { timeoutMs: ms(60_000), intervalMs: 250, label: `${label} reads A's refreshed self record` })
      seen[label] = Date.now() - t0
    }
    const reads = await timeEach(5, async () => voter!.node.getControlDatabase().queryPeerRecord(aId))
    console.log(`[vx-7] A's refreshed self record seen: voter ${seen.voter} ms, B ${seen.B} ms; voter control point read med ${median(reads)} ms (${reads.join(',')})`)
    expect(seen.voter, 'the voter sees the authority\'s control write within a minute').to.be.below(ms(60_000))
  })

  it('VX-5 with the declaring Voter silent, A\'s control and strand writes stay fast', async function () {
    // Silent, not gone: every handler on the voter's control and strand nodes accepts a stream and never answers,
    // and the connections stay up (a phone asleep or a stalled JS thread).
    let frozen = 0
    for (const node of [voter!.node.getControlNode(), voter!.node.getStrand(network.hash).libp2pNode]) {
      for (const p of [...node.getProtocols()]) {
        if (/\/ipfs\/(id|ping)|circuit/.test(p)) continue
        try { await node.unhandle(p) } catch { /* not handled */ }
        await node.handle(p, () => { /* never answers */ }, { force: true })
        frozen++
      }
    }
    expect(frozen).to.be.greaterThan(5)
    const portA = await network.portA()
    const control: number[] = []
    const strand: number[] = []
    for (let i = 0; i < 3; i++) {
      let t0 = Date.now()
      await harness!.nodeA.node.createCadreInvitation({ uses: 1, expiresInMs: 60_000 })
      control.push(Date.now() - t0)
      t0 = Date.now()
      await portA.mutate('insert into TidHighWater (Namespace, HighWater) values (:ns, :hw)', { ns: `vx5:${harness!.runId}:${i}`, hw: 1 })
      strand.push(Date.now() - t0)
    }
    console.log(`[vx-5] voter silent: A control writes ${control.join(',')} ms; A strand writes ${strand.join(',')} ms`)
    for (const t of control) expect(t, 'a control write does not wait on the silent voter').to.be.below(WRITE_BOUND_MS)
    for (const t of strand) expect(t, 'a strand write does not wait on the silent voter').to.be.below(WRITE_BOUND_MS)
  })

  it('VX-8 (reading only) the declaring Voter offline: can it still read its control and strand data?', async function () {
    // votetorrent-67 review: a refused voter no longer holds a full control copy. Recorded, not asserted.
    const ctl = voter!.node.getControlNode()
    const sn = voter!.node.getStrand(network.hash).libp2pNode
    for (const n of [ctl, sn]) for (const c of [...n.getConnections()]) { try { await c.close() } catch { /* already closed */ } }
    const attempt = async (label: string, fn: () => Promise<unknown>): Promise<string> => {
      const t0 = Date.now()
      try {
        const r = await Promise.race([fn().then(() => 'ok'), new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), ms(15_000)))])
        return `${label} ${r} ${Date.now() - t0} ms`
      } catch (e) { return `${label} threw ${(e as Error)?.name ?? 'Error'}: ${String((e as Error)?.message ?? e).slice(0, 80)} ${Date.now() - t0} ms` }
    }
    const lines = [
      `connections after close: control ${ctl.getConnections().length}, strand ${sn.getConnections().length}`,
      await attempt('control peer-record read', async () => voter!.node.getControlDatabase().queryPeerRecord(harness!.nodeA.peerId)),
      await attempt('strand point read', async () => voter!.port.query('select Id from Authority where Id = :id', { id: authorityId }))
    ]
    console.log(`[vx-8] voter offline: ${lines.join(' | ')}`)
  })
})
