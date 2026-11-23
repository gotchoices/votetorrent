/**
 * dashboard-edge-exclusion.harness.spec.ts — a paired officer dashboard (edge member C) is never offered to joiners
 * as a member and is never in a CONTROL write cohort, so an unresponsive browser cannot hold the network's control
 * writes or a voter's join. RUN_P2P_HARNESS=1 like every *.harness.spec.ts; pending in the default suite.
 *
 * Defect (2026-11-13, lean rig over the real relay): with a browser paired, a voter code listed 4 members instead
 * of 3 (the browser among them) and a host voter's join timed out. On the host (this spec's first runs, before the
 * fix) the same shapes reproduced on real loopback CadreNodes:
 *   - A's `createCadreInvitation` named C (members `A,C,B`: connected members come first);
 *   - C was in 16/16 of A's sampled control cohorts (the control cohort is every member, ≤ 16);
 *   - with C unresponsive (every protocol handler hangs, connections stay up: a throttled or frozen tab), each
 *     control write on A took 84-105 s (61 ms with C responsive) and a joiner's redemption at A failed.
 * Strand writes stayed fast: 66-28's strand refusal already kept C out of strand cohorts.
 *
 * Fix under test: the VoteTorrent cadre-core patch declares the edge-reader marker on the dashboard's CONTROL node
 * and adds `controlCohortRefusal` (the tracker's `control` refusal, which the Authority provider and this harness
 * pass); vote-engine `excludeEdgeReaderMembers` drops identified edge readers from a minted invitation.
 *
 *   EX-1  the minted invitation, through the product filter, never names C; cadre-core's raw selection does (cause)
 *   EX-2  C is in none of A's control cohorts; dropping A's refusal puts it back (the refusal is what excludes it)
 *   EX-3  with C unresponsive: control writes on A and strand writes still finish fast, and a joiner redeems the
 *         filtered code and syncs the strand
 */
import { expect } from 'chai'
import {
  describeP2PHarness, startTwoNodeHarness, pollUntil, seedPairingOfficers, startHarnessEdgeMember,
  attachHarnessEdgeStrand, HARNESS_SAPP_ID, VOTETORRENT_INNER_DDL,
  type TwoNodeHarness, type HarnessPairingNetwork, type HarnessEdgeMember
} from './harness/two-node-strand.js'
import { revokeDashboardPairing } from '../src/pairing/pairing-revocation.js'
import { bytesToBase64url } from '../src/utils.js'
import { excludeEdgeReaderMembers, memberAddressPeerId } from '../src/network/edge-reader-members.js'
import { EDGE_READER_CONTROL_KEY, EDGE_READER_PROTOCOL } from '../src/network/edge-reader-refusal.js'
import { VOTETORRENT_SCHEMA_VERSION } from '../src/database/schema-version.js'

const SCALE = Number(process.env.P2P_HARNESS_TIMEOUT_SCALE ?? 1)
const ms = (n: number): number => Math.round(n * SCALE)
const sleep = async (n: number): Promise<void> => { await new Promise<void>((resolve) => setTimeout(resolve, n)) }
/** Before the fix a control write with C unresponsive took 84-105 s; with it, tens of milliseconds. */
const CONTROL_WRITE_BOUND_MS = ms(15_000)
const SAMPLE_KEYS = 16

describeP2PHarness('a paired dashboard is never an invitation member or a control cohort member (edge exclusion)', function () {
  this.timeout(ms(900_000))
  let cadre: any
  let harness: TwoNodeHarness | undefined
  let pn: HarnessPairingNetwork
  let c: HarnessEdgeMember | undefined
  let cId = ''
  let cStrandNode: any
  const extra: any[] = []

  before(async function () {
    this.timeout(ms(300_000))
    cadre = await import('@serfab/cadre-core')
    harness = await startTwoNodeHarness({ clusterSize: 4, extraConfig: { strandReactivity: { enabled: true } }, cohortRefusal: true })
    pn = await seedPairingOfficers(harness)
    const pairing = await harness.nodeA.node.createCadreInvitation({ uses: 1, expiresInMs: 15 * 60_000 })
    c = await startHarnessEdgeMember({ label: 'node-C', storageId: `ex-${harness.runId}`, strandId: pn.hash, clusterSize: 4, strandReactivity: { edgeHost: true }, listenAddrs: ['/ip4/127.0.0.1/tcp/0/ws'] })
    cId = await c.identityPeerId()
    await c.edge.joinCadre(cadre.decodeCadreInvitation(pairing.encoded), { relayAddrs: [], signal: AbortSignal.timeout(ms(120_000)) })
    await pollUntil(async () => await harness!.nodeA.node.isAuthorizedMember(cId), (v) => v === true, { timeoutMs: ms(60_000), label: 'A sees C as a member' })
    cStrandNode = (await attachHarnessEdgeStrand(c, pn.hash)).strandNode
    // C's signed CadrePeer record (the address the invitation would name) and its control identify reach A.
    await pollUntil(async () => harness!.nodeA.cohortRefusal?.has(EDGE_READER_CONTROL_KEY, cId) === true, (v) => v, { timeoutMs: ms(30_000), label: 'A\'s control refusal learned C' })
    await pollUntil(async () => {
      const m = await harness!.nodeA.node.createCadreInvitation({ uses: 1, expiresInMs: 60_000 })
      return (m.invitation.members as string[]).some((a) => memberAddressPeerId(a) === cId)
    }, (v) => v, { timeoutMs: ms(60_000), intervalMs: 1000, label: 'C\'s record is published (cadre-core would name it)' })
  })

  after(async function () {
    this.timeout(ms(120_000))
    for (const n of extra) { try { await n.stop() } catch { /* idempotent */ } }
    try { await c?.stop() } catch { /* idempotent */ }
    try { await harness?.stop() } catch { /* idempotent */ }
  })

  async function mintVoterCode (): Promise<{ raw: string[], kept: string[], encoded: string }> {
    const minted = await harness!.nodeA.node.createCadreInvitation({ uses: 1000, expiresInMs: 30 * 86_400_000 })
    const out = await excludeEdgeReaderMembers(minted, harness!.nodeA.node.getControlNode(), (i: unknown) => cadre.encodeCadreInvitation(i))
    return { raw: minted.invitation.members, kept: cadre.decodeCadreInvitation(out.encoded).members, encoded: out.encoded }
  }

  async function controlCohortHits (): Promise<number> {
    const kn = harness!.nodeA.node.getControlNode()?.keyNetwork
    let hits = 0
    for (let i = 0; i < SAMPLE_KEYS; i++) {
      const cluster = Object.keys(await kn.findCluster(new TextEncoder().encode(`ex-key-${i}`)))
      if (cluster.includes(cId)) hits++
    }
    return hits
  }

  it('EX-1 a minted voter code never names the dashboard; cadre-core\'s own member selection does', async function () {
    const rec: any = await harness!.nodeA.node.getControlNode().peerStore.get(c!.edge.node.getControlNode().peerId)
    expect(rec.protocols, 'C\'s control identify names the edge-reader marker').to.include(EDGE_READER_PROTOCOL)
    const { raw, kept } = await mintVoterCode()
    const ids = (l: string[]): string[] => l.map((a) => memberAddressPeerId(a) ?? '')
    console.log(`[ex-1] raw members ${ids(raw).map((p) => p.slice(-6)).join(',')} kept ${ids(kept).map((p) => p.slice(-6)).join(',')}`)
    expect(ids(raw), 'cadre-core names C (the cause)').to.include(cId)
    expect(ids(kept), 'the code names no edge reader').to.not.include(cId)
    expect(ids(kept)[0], 'the minting machine is still first').to.equal(harness!.nodeA.peerId)
    expect(ids(kept), 'the serving phone B is still named').to.include(harness!.nodeB.peerId)
  })

  it('EX-2 the dashboard is in none of A\'s control cohorts, and A\'s refusal is what keeps it out', async function () {
    const hits = await controlCohortHits()
    const bHits = await (async () => {
      const kn = harness!.nodeA.node.getControlNode().keyNetwork
      let n = 0
      for (let i = 0; i < SAMPLE_KEYS; i++) if (Object.keys(await kn.findCluster(new TextEncoder().encode(`ex-key-${i}`))).includes(harness!.nodeB.peerId)) n++
      return n
    })()
    const node = harness!.nodeA.node
    const saved = node.controlCohortRefusal
    node.controlCohortRefusal = null
    let without = -1
    try { without = await controlCohortHits() } finally { node.controlCohortRefusal = saved }
    console.log(`[ex-2] control cohort hits for C ${hits}/${SAMPLE_KEYS} (B ${bHits}/${SAMPLE_KEYS}); with A's refusal dropped ${without}/${SAMPLE_KEYS}`)
    expect(hits, 'C is in no control cohort').to.equal(0)
    expect(bHits, 'B still is').to.equal(SAMPLE_KEYS)
    expect(without, 'negative control: without the refusal C is back in the cohorts').to.equal(SAMPLE_KEYS)
    expect(node.hasReachableControlSibling(), 'B still counts as a reachable sibling').to.equal(true)
  })

  it('EX-3 with the dashboard unresponsive, control and strand writes on A stay fast and a joiner redeems and syncs', async function () {
    // Unresponsive, not gone: every handler on C's control and strand nodes accepts a stream and never answers, and
    // the connections stay up (a throttled background tab, a frozen IndexedDB transaction).
    let frozen = 0
    for (const node of [c!.edge.node.getControlNode(), cStrandNode]) {
      for (const p of [...node.getProtocols()]) {
        if (/\/ipfs\/(id|ping)|circuit/.test(p)) continue
        try { await node.unhandle(p) } catch { /* not handled */ }
        await node.handle(p, () => { /* never answers */ }, { force: true })
        frozen++
      }
    }
    expect(frozen).to.be.greaterThan(10)
    const { makeTestSignCallback } = await import('./fixtures/test-context.js')
    const control: number[] = []
    const strand: number[] = []
    for (let i = 0; i < 3; i++) {
      let t0 = Date.now()
      await harness!.nodeA.node.createCadreInvitation({ uses: 1, expiresInMs: 60_000 })
      control.push(Date.now() - t0)
      t0 = Date.now()
      await revokeDashboardPairing(pn.ctxA, {
        userId: pn.founder.id,
        nonce: bytesToBase64url(crypto.getRandomValues(new Uint8Array(16))),
        signer: { userId: pn.founder.id, signingPublicKey: pn.founder.activeKeys[0]!.key, sign: makeTestSignCallback(pn.founder) } as any
      })
      strand.push(Date.now() - t0)
    }
    console.log(`[ex-3] C frozen: control writes ${control.join(',')} ms; strand writes ${strand.join(',')} ms`)
    for (const v of control) expect(v, 'a control write does not wait on the frozen dashboard').to.be.below(CONTROL_WRITE_BOUND_MS)

    // A voter-like joiner (transaction profile, the Voter app's strand refusal) redeems the filtered code.
    const { CadreNode } = await import('@serfab/cadre-core')
    const { MemoryRawStorage } = await import('@optimystic/db-p2p')
    const { webSockets } = await import('@libp2p/websockets')
    const { generateKeyPair } = await import('@libp2p/crypto/keys')
    const { createEdgeReaderRefusal } = await import('../src/network/edge-reader-refusal.js')
    const storage = new MemoryRawStorage()
    const d: any = new CadreNode({
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
      strandCohortRefusal: createEdgeReaderRefusal().hook
    } as any)
    extra.push(d)
    await d.start()
    const code = await mintVoterCode()
    const t0 = Date.now()
    await d.redeemCadreInvitation(cadre.decodeCadreInvitation(code.encoded))
    const redeemMs = Date.now() - t0
    const t1 = Date.now()
    await d.addStrand({
      strandRow: { Id: pn.hash, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null, FounderPeerId: null },
      sAppConfig: { id: HARNESS_SAPP_ID, version: '1.0.0', schema: VOTETORRENT_INNER_DDL, schemaVersion: VOTETORRENT_SCHEMA_VERSION, latencyHint: 'interactive' },
      founder: false,
      awaitFirstSync: false
    })
    await d.whenStrandWritable(pn.hash, { timeoutMs: ms(120_000) })
    const db = d.getStrand(pn.hash).database.getDatabase()
    db.setSchemaPath(['App', 'main'])
    await pollUntil(async () => (await db.prepare('select Id from Network').get({}))?.Id ?? null, (v) => typeof v === 'string', { timeoutMs: ms(120_000), label: 'the joiner reads the Network row' })
    const syncMs = Date.now() - t1
    console.log(`[ex-3] joiner with C frozen: redeem ${redeemMs} ms, strand sync ${syncMs} ms`)
    expect(redeemMs, 'the admission write does not wait on the frozen dashboard').to.be.below(CONTROL_WRITE_BOUND_MS)
    await sleep(0)
  })
})
