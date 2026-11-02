/**
 * reactivity-matchmaking.harness.spec.ts — the 2026-11-02 reactivity + matchmaking wiring on two REAL enrolled
 * CadreNodes built with `strandReactivity: { enabled: true }` (cadre-core 1.20 / optimystic 1.24), the real
 * votetorrent schema, loopback only. RUN_P2P_HARNESS=1 like every *.harness.spec.ts.
 *
 *   RM-1 the strand nodes carry the cohort-topic substrate (reactivityWatch, cohortTopicHost)
 *   RM-2 a commit on node-A wakes a cadre `watchTables` subscription on node-B (what useStrandChanges uses)
 *   RM-3 the upstream matchmaking calls the Voter's pool-matchmaking-ports.ts makes. MEASURED 2026-11-02 on
 *        optimystic 1.24: a provider registration needs a cohort threshold signature of DEFAULT_MIN_SIGS (14) of
 *        wantK (16) members, so on two nodes it is refused with CohortBackoffError ("no willing primary") for as
 *        long as we retried (2 min). This test pins that refusal (flip-on-fix): if it starts passing a
 *        registration, the cohort minimum changed and the find-each-other leg below should be enabled.
 */

import { expect } from 'chai'
import { describeP2PHarness, startTwoNodeHarness, pollUntil, type TwoNodeHarness } from './harness/two-node-strand.js'
import { poolMatchTopic } from '../src/pool/pool-matchmaking.js'

describeP2PHarness('reactivity + matchmaking on two real strand nodes (strandReactivity on)', function () {
  this.timeout(240_000)
  let harness: TwoNodeHarness
  let strandId: string

  before(async function () {
    this.timeout(240_000)
    harness = await startTwoNodeHarness({ extraConfig: { strandReactivity: { enabled: true } } })
    const shared = await harness.openSharedStrand()
    strandId = shared.strandId
  })

  after(async function () {
    this.timeout(60_000)
    await harness?.stop()
  })

  const strandNode = (which: 'A' | 'B'): any => (which === 'A' ? harness.nodeA : harness.nodeB).node.getStrand(strandId)

  it('RM-1 both strand nodes carry the cohort-topic substrate', () => {
    for (const w of ['A', 'B'] as const) {
      const raw = strandNode(w).libp2pNode
      expect(raw?.reactivityWatch, `node-${w} reactivityWatch`).to.not.equal(undefined)
      expect(raw?.cohortTopicHost?.service, `node-${w} cohortTopicHost.service`).to.not.equal(undefined)
      expect(raw?.peerPrivateKey, `node-${w} peerPrivateKey`).to.not.equal(undefined)
    }
  })

  it('RM-2 a commit on node-A wakes a watchTables subscription on node-B', async function () {
    this.timeout(90_000)
    const dbA = await harness.nodeA.openStrand(strandId)
    let wakes = 0
    const watch = strandNode('B').database.watchTables(['App.TidHighWater'], async () => { wakes++ }, { label: 'harness-rm2', coalesceMs: 20 })
    try {
      // the start run may wake once; count from here
      await new Promise((r) => setTimeout(r, 500))
      const base = wakes
      const t0 = Date.now()
      await dbA.exec("insert into TidHighWater (Namespace, HighWater) values ('rm2', 2)")
      await pollUntil(async () => wakes, (n) => n > base, { timeoutMs: 60_000, label: 'node-B watch wake' })
      console.log(`[rm-2] node-B woke ${Date.now() - t0} ms after node-A's commit`)
    } finally {
      watch.dispose()
    }
  })

  it('RM-3 matchmaking on a 2-node cohort: a registration is refused, CohortBackoffError (needs 14 of 16 signers); flip-on-fix to the find-each-other leg', async function () {
    this.timeout(180_000)
    const p2p: any = await import('@optimystic/db-p2p')
    const dbc: any = await import('@optimystic/db-core')
    const topic = poolMatchTopic(`harness-${strandId}`)
    const ports = (w: 'A' | 'B') => {
      const raw = strandNode(w).libp2pNode
      const host = raw.cohortTopicHost
      const key = raw.peerPrivateKey
      const selfPeerId = raw.peerId.toString()
      const anchor = dbc.createMatchTopicAnchor()
      const sign = async (payload: Uint8Array) => dbc.bytesToB64url(await p2p.signPeer(key, payload))
      const serveOwn = p2p.createMatchmakingQueryHandler({ registry: host.registry, addressing: dbc.createTierAddressing(dbc.createRingHash()), sign })
      const transport = p2p.createLibp2pMatchmakingTransport({
        node: raw, fret: raw.services.fret, selfPeerId, key, wantK: 16,
        selfServe: { query: async (q: any) => { const f = await serveOwn(dbc.encodeQueryV1(q), raw.peerId); return f === undefined ? undefined : dbc.decodeQueryReplyV1(f) } }
      })
      const topicId = anchor.topicId(topic.kind, topic.label)
      return {
        selfPeerId,
        session: new p2p.MatchmakingProviderSession({ service: host.service, sign, anchor }),
        query: async () => {
          const reply = await transport.queryCohort({ v: 1, topicId: dbc.bytesToB64url(topicId), includeProviders: true, includeSeekers: false, limit: 32, requesterId: selfPeerId, timestamp: Date.now(), signature: 'AA' })
          return (reply.providers ?? []).map((e: any) => ({ id: e.participantId, caps: e.capabilities, verified: dbc.verifyProviderEntry(topicId, e, transport.verifyEntry) }))
        }
      }
    }
    const a = ports('A')
    const b = ports('B')
    const register = async (p: ReturnType<typeof ports>, cap: string): Promise<number> => {
      let attempts = 0
      await pollUntil(async () => {
        attempts++
        await p.session.register(topic, { capabilities: [cap], capacityBudget: 1, contactHint: p.selfPeerId })
        return true
      }, (ok) => ok, { timeoutMs: 120_000, intervalMs: 1_500, label: `register ${p.selfPeerId.slice(-6)}` })
      return attempts
    }
    // Flip-on-fix: today every registration on a 2-node cohort is refused (see header).
    let refusal: unknown
    try {
      await a.session.register(topic, { capabilities: ['vtpool1:from-A'], capacityBudget: 1, contactHint: a.selfPeerId })
    } catch (err) {
      refusal = err
    }
    expect((refusal as Error | undefined)?.name, 'a 2-node cohort refuses a matchmaking registration (needs 14 signers)').to.equal('CohortBackoffError')
    if (refusal !== undefined) return
    const attemptsA = await register(a, 'vtpool1:from-A')
    const attemptsB = await register(b, 'vtpool1:from-B')
    console.log(`[rm-3] register attempts A=${attemptsA} B=${attemptsB}`)
    const seenFromA = await pollUntil(async () => await a.query(), (l: any[]) => l.some((e) => e.id === b.selfPeerId), { timeoutMs: 60_000, intervalMs: 1_000, label: 'A sees B' })
    const seenFromB = await pollUntil(async () => await b.query(), (l: any[]) => l.some((e) => e.id === a.selfPeerId), { timeoutMs: 60_000, intervalMs: 1_000, label: 'B sees A' })
    expect(seenFromA.find((e: any) => e.id === b.selfPeerId)).to.include({ verified: true })
    expect(seenFromA.find((e: any) => e.id === b.selfPeerId).caps).to.deep.equal(['vtpool1:from-B'])
    expect(seenFromB.find((e: any) => e.id === a.selfPeerId)).to.include({ verified: true })
    await b.session.withdraw()
    await pollUntil(async () => await a.query(), (l: any[]) => !l.some((e) => e.id === b.selfPeerId), { timeoutMs: 60_000, intervalMs: 1_000, label: 'B withdrawn' })
  })
})
