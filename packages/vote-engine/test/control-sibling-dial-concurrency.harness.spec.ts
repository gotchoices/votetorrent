/**
 * control-sibling-dial-concurrency.harness.spec.ts — one control sibling that cannot answer must not hold up a
 * joining member's dials to the others. RUN_P2P_HARNESS=1 like every *.harness.spec.ts.
 *
 * Defect (2026-11-16, emulator Voter over the real relay, officer dashboard paired): cadre-core's
 * reconcileControlCohort dialed control siblings one after another, each with a relayed budget of 21.5 s per
 * address. The paired dashboard browser is a control member the phone cannot reach, so every pass stalled ~26-29 s
 * on it, the phone's strand started 38 s after redeeming (6 s without the dashboard), and its first join hit
 * not-synced in 4/4 dashboard runs (0/3 without).
 *
 * Fix under test (VoteTorrent cadre-core patch, control-sibling-dial-concurrency): a pass dials up to
 * `network.controlCohort.dialConcurrency` siblings at once (default 4; 1 = the old serial loop).
 *
 * Setup: A and B (the harness), plus DEAD members: each redeems an invitation while announcing only an address
 * served by a TCP listener that accepts and never answers (a dial there hangs until its budget), publishes its
 * record, and stops. A joining member C then reconciles with A, B and the dead siblings.
 *
 *   SD-1  serial (dialConcurrency 1): C's first reconcile pass with every sibling known takes about
 *         DEAD x the per-sibling budget, the old behaviour (the control)
 *   SD-2  default (4): the same pass takes about one budget, and C is connected to A and B by its end
 *   SD-3  a non-number dialConcurrency (a string from a JSON config) falls back to the default: the pass still dials
 *         every sibling at once (before the guard it started no dial workers, dialed nobody and reported nothing)
 */
import { expect } from 'chai'
import { createServer, type Server, type Socket } from 'node:net'
import { describeP2PHarness, startTwoNodeHarness, pollUntil, type TwoNodeHarness } from './harness/two-node-strand.js'

const SCALE = Number(process.env.P2P_HARNESS_TIMEOUT_SCALE ?? 1)
const ms = (n: number): number => Math.round(n * SCALE)
const DEAD = 3
/** One sibling's whole dial budget in this spec (dialTimeoutMs caps the 4 per-address attempts). */
const BUDGET_MS = 5_000

interface PassRecord { startedAt: number, endedAt: number, siblings: number, dialStarts: Record<string, number> }

describeP2PHarness('one unanswering control sibling does not hold up the others (control sibling dial concurrency)', function () {
  this.timeout(ms(900_000))
  let cadre: any
  let harness: TwoNodeHarness | undefined
  let hang: Server | undefined
  const sockets = new Set<Socket>()
  const deadIds: string[] = []
  const started: any[] = []
  /** C's invitations, minted while every control member is still up: once the dead members have joined, A's
   *  control writes need approvals from them and fail (2/3 approvals), so nothing is minted after they stop. */
  const invites: string[] = []

  before(async function () {
    this.timeout(ms(400_000))
    cadre = await import('@serfab/cadre-core')
    harness = await startTwoNodeHarness({ clusterSize: 4 })
    hang = createServer((socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
    await new Promise<void>((resolve) => hang!.listen(0, '127.0.0.1', resolve))
    const hangPort = (hang.address() as { port: number }).port
    for (let i = 0; i < 3; i++) {
      invites.push((await harness.nodeA.node.createCadreInvitation({ uses: 1, expiresInMs: 60 * 60_000 })).encoded)
    }
    for (let i = 0; i < DEAD; i++) {
      const dead = await makeNode({ announceAddrs: [`/ip4/127.0.0.1/tcp/${hangPort}/ws`] })
      await dead.start()
      const id = dead.peerId.toString()
      await redeem(dead)
      await dead.publishSelfRecord()
      await pollUntil(async () => JSON.stringify(await harness!.nodeA.node.getControlDatabase().queryPeerRecord(id) ?? null),
        (s) => s.includes(String(hangPort)), { timeoutMs: ms(60_000), label: `A holds dead member ${i}'s record with the hanging address` })
      await dead.stop()
      deadIds.push(id)
    }
  })

  after(async function () {
    this.timeout(ms(120_000))
    for (const n of started) { try { await n.stop() } catch { /* idempotent */ } }
    try { await harness?.stop() } catch { /* idempotent */ }
    for (const s of sockets) s.destroy()
    await new Promise<void>((resolve) => hang ? hang.close(() => resolve()) : resolve())
  })

  async function makeNode (network: Record<string, unknown>): Promise<any> {
    const { CadreNode } = cadre
    const { MemoryRawStorage } = await import('@optimystic/db-p2p')
    const { webSockets } = await import('@libp2p/websockets')
    const { generateKeyPair } = await import('@libp2p/crypto/keys')
    const storage = new MemoryRawStorage()
    return new CadreNode({
      privateKey: await generateKeyPair('Ed25519'),
      controlNetwork: { partyId: harness!.partyId, bootstrapNodes: [] },
      requireSignedSchemas: false,
      strandFilter: { mode: 'all' },
      storage: { provider: () => storage },
      hibernation: { enabled: false },
      nodeClass: 'device',
      network: { transports: [webSockets()], listenAddrs: ['/ip4/127.0.0.1/tcp/0/ws'], ...network }
    } as any)
  }

  async function redeem (node: any, preMinted?: string): Promise<void> {
    const id = node.peerId.toString()
    const encoded = preMinted ?? (await harness!.nodeA.node.createCadreInvitation({ uses: 1, expiresInMs: 15 * 60_000 })).encoded
    await node.redeemCadreInvitation(cadre.decodeCadreInvitation(encoded))
    await pollUntil(async () => await harness!.nodeA.node.isAuthorizedMember(id), (v) => v === true,
      { timeoutMs: ms(60_000), label: `A sees ${id.slice(-6)} as a member` })
  }

  /** Start C with `dialConcurrency`, record every reconcile pass and each sibling's dial start, redeem, and
   *  return the first pass that saw all the siblings (A, B and every dead one). */
  async function joinAndTimeFirstFullPass (dialConcurrency: unknown): Promise<{ pass: PassRecord, aMs: number | null, bMs: number | null }> {
    const c = await makeNode({ controlCohort: { dialConcurrency, dialTimeoutMs: BUDGET_MS, perAddressDialTimeoutMs: BUDGET_MS } })
    started.push(c)
    const passes: PassRecord[] = []
    let current: PassRecord | null = null
    const origReconcile = c.reconcileControlCohort.bind(c)
    c.reconcileControlCohort = async (...args: unknown[]) => {
      const rec: PassRecord = { startedAt: Date.now(), endedAt: 0, siblings: 0, dialStarts: {} }
      current = rec
      try {
        const out = await origReconcile(...args)
        return out
      } finally {
        rec.endedAt = Date.now()
        passes.push(rec)
        if (current === rec) current = null
      }
    }
    const origDial = c.dialControlSibling.bind(c)
    c.dialControlSibling = async (sibling: { peerId: string }, resolved: unknown) => {
      const rec = current
      if (rec) { rec.dialStarts[sibling.peerId] = Date.now() - rec.startedAt; rec.siblings++ }
      return origDial(sibling, resolved)
    }
    await c.start()
    const invite = invites.shift()
    if (!invite) throw new Error('no pre-minted invitation left for C')
    await redeem(c, invite)
    const full = await pollUntil(async () => passes.find((p) => deadIds.every((id) => id in p.dialStarts)) ?? null, (p) => p !== null,
      { timeoutMs: ms(240_000), label: `C (dialConcurrency ${dialConcurrency}) completes a pass that dials every dead sibling` })
    const aId = harness!.nodeA.node.peerId.toString()
    const bId = harness!.nodeB.node.peerId.toString()
    const conns = (): string[] => c.getControlNode().getConnections().map((x: any) => x.remotePeer.toString())
    const bAt = conns().includes(bId) ? (full!.dialStarts[bId] ?? 0) : null
    const aAt = conns().includes(aId) ? (full!.dialStarts[aId] ?? 0) : null
    await c.stop()
    return { pass: full!, aMs: aAt, bMs: bAt }
  }

  it('SD-1 serial (dialConcurrency 1): the pass waits out every dead sibling in turn (the old behaviour)', async function () {
    const { pass, bMs } = await joinAndTimeFirstFullPass(1)
    const passMs = pass.endedAt - pass.startedAt
    console.log(`[sd-1] serial pass ${passMs} ms over ${pass.siblings} dial(s); dial starts ${JSON.stringify(Object.values(pass.dialStarts))}; B dial start ${String(bMs)} ms`)
    expect(passMs).to.be.at.least((DEAD - 0.5) * BUDGET_MS)
  })

  it('SD-2 default (4 at once): the pass takes about one budget, and C reaches A and B', async function () {
    const { pass, aMs, bMs } = await joinAndTimeFirstFullPass(4)
    const passMs = pass.endedAt - pass.startedAt
    const starts = Object.values(pass.dialStarts)
    console.log(`[sd-2] concurrent pass ${passMs} ms over ${pass.siblings} dial(s); dial starts ${JSON.stringify(starts)}; A ${String(aMs)} ms, B ${String(bMs)} ms`)
    expect(passMs).to.be.below(2 * BUDGET_MS)
    expect(Math.max(...starts)).to.be.below(BUDGET_MS + 2_000)
    expect(aMs, 'C is connected to A').to.not.equal(null)
    expect(bMs, 'C is connected to B').to.not.equal(null)
  })

  it('SD-3 a non-number dialConcurrency falls back to the default (every sibling is still dialed, at once)', async function () {
    const { pass, aMs, bMs } = await joinAndTimeFirstFullPass('abc')
    const passMs = pass.endedAt - pass.startedAt
    const starts = Object.values(pass.dialStarts)
    console.log(`[sd-3] 'abc' pass ${passMs} ms over ${pass.siblings} dial(s); dial starts ${JSON.stringify(starts)}; A ${String(aMs)} ms, B ${String(bMs)} ms`)
    expect(passMs).to.be.below(2 * BUDGET_MS)
    expect(Math.max(...starts)).to.be.below(BUDGET_MS + 2_000)
  })
})
