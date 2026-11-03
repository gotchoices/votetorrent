/**
 * public-edge-watch.harness.spec.ts — the Public page's live-update path on REAL nodes (step 3 of the
 * 2026-11-02 recommended order). RUN_P2P_HARNESS=1 like every *.harness.spec.ts.
 *
 * Two real enrolled CadreNodes (strandReactivity on, the real votetorrent schema, loopback websockets)
 * share an open strand. A third node is built by the Public page's OWN code, from
 * `apps/VoteTorrentPublic/src/peer`: `createEdgeNode` (Edge FRET profile, websockets only, the page's
 * subscriber-only cohort-topic posture) with an ephemeral session key from `identity.js`, and the page's
 * one tail reader from `tail-reader.js`. It holds no cadre membership and dials a strand node directly, as
 * upstream's route for public readers has it (sereus#23: the public link carries a strand node's address;
 * an open strand's node has no member gate). Only its block storage is swapped: memory instead of IndexedDB.
 *
 *   PE-1 the page's node, on the strand's network name, connects to the strand node and carries
 *        `node.reactivityWatch`
 *   PE-2 a watch through the page's tail reader is woken by its first committed-tail read: the page's
 *        node reads the strand's committed tail over the network
 *   PE-3 a commit on node-A wakes the page's watch again; the log line records how long it took and whether
 *        the page's subscription was registered with the cohort (a notification) or not (the watch's tick)
 *   (before) the page's computed collection id (`collection-id.js`) equals the strand node's live one
 *   PE-4 control: the same page node built on the BARE strand id (the network name boot.js used before
 *        2026-11-03) is never woken -- its protocol ids match no strand node
 *
 * NOT proven here: a browser (IndexedDB, the browser connection gater, Vite's bundle), the page's
 * `readRows` and store write, or the gateway. PE-3's watched table is `App.TidHighWater`, not a public one:
 * a public table's insert needs a signed authority chain this harness does not build, and the watch path
 * does not depend on which collection it watches.
 */

import { expect } from 'chai'
import { describeP2PHarness, startTwoNodeHarness, pollUntil, type TwoNodeHarness } from './harness/two-node-strand.js'

const PUBLIC_PEER = new URL('../../../apps/VoteTorrentPublic/src/peer/', import.meta.url)
const PUBLIC_DB_P2P = new URL('../../../apps/VoteTorrentPublic/node_modules/@optimystic/db-p2p/dist/src/index.js', import.meta.url)

interface PageNode {
  node: any
  stop: () => Promise<void>
}

describeP2PHarness('the Public page\'s live-update path on real strand nodes (node.reactivityWatch)', function () {
  this.timeout(300_000)
  let harness: TwoNodeHarness
  let strandId: string
  let strandAddr: string
  let collectionId: string
  const pages: PageNode[] = []

  /** Build a node with the Public page's own code, on `networkName`, dialing the strand node. */
  async function startPageNode (networkName: string): Promise<PageNode> {
    const { createEdgeNode } = await import(new URL('edge-node.js', PUBLIC_PEER).href)
    const { loadOrCreateSessionPeerKey } = await import(new URL('identity.js', PUBLIC_PEER).href)
    const { MemoryRawStorage } = await import(PUBLIC_DB_P2P.href)
    const store = new Map<string, string>()
    const sessionStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) }
    }
    const privateKey = await loadOrCreateSessionPeerKey(sessionStorage)
    const edge = await createEdgeNode(
      { strandId, networkName, bootstrapNodes: [strandAddr], privateKey },
      { openStrandBlockStorage: async () => ({ dbName: `mem-${networkName}`, db: { close: () => undefined }, storage: new MemoryRawStorage() }) }
    )
    const page = { node: edge.node, stop: edge.stop }
    pages.push(page)
    return page
  }

  /** Open a watch on `collectionId` through the page's own tail reader; count its wakes. */
  async function watchFromPage (page: PageNode, networkName: string): Promise<{ wakes: () => number, close: () => Promise<void> }> {
    const { createPageTailReader } = await import(new URL('tail-reader.js', PUBLIC_PEER).href)
    const tails = createPageTailReader(page.node, networkName)
    let wakes = 0
    const handle = page.node.reactivityWatch.watch({ collectionId, tails, onChange: () => { wakes++ } })
    return { wakes: () => wakes, close: () => handle.close() }
  }

  before(async function () {
    this.timeout(300_000)
    harness = await startTwoNodeHarness({ extraConfig: { strandReactivity: { enabled: true } } })
    const shared = await harness.openSharedStrand()
    strandId = shared.strandId
    // Commit once, so the collection has a committed tail before the page watches it.
    await shared.dbA.exec("insert into TidHighWater (Namespace, HighWater) values ('pe-seed', 1)")
    const strandNode = harness.nodeA.node.getStrand(strandId).libp2pNode
    const addrs: string[] = strandNode.getMultiaddrs().map((m: any) => m.toString())
    strandAddr = addrs.find((a) => a.includes('/ip4/127.0.0.1/') && a.includes('/ws')) ?? ''
    expect(strandAddr, `node-A strand node has a loopback ws address (${addrs.join(' ')})`).to.not.equal('')
    const optimystic: any = shared.dbA.schemaManager.getModule('optimystic')?.module
    collectionId = optimystic?.tables?.get('app.tidhighwater')?.collection?.collection?.id
    expect(collectionId, 'App.TidHighWater collection id on node-A').to.be.a('string')
    // The page computes its collection ids (`collection-id.js`); they must be the ids the strand's blocks carry.
    const { collectionIdForTable } = await import(new URL('collection-id.js', PUBLIC_PEER).href)
    expect(collectionIdForTable('TidHighWater'), 'the page\'s computed id equals node-A\'s live collection id').to.equal(collectionId)
    console.log(`[pe] strand=${strandId} collection=${collectionId}`)
  })

  after(async function () {
    this.timeout(60_000)
    for (const page of pages) await page.stop().catch(() => undefined)
    await harness?.stop()
  })

  it('PE-1..3 the page\'s node connects, its first tail read wakes it, and a commit on node-A wakes it again', async function () {
    this.timeout(240_000)
    const networkName = `strand-${strandId}`
    const page = await startPageNode(networkName)
    expect(page.node.reactivityWatch, 'page node reactivityWatch').to.not.equal(undefined)
    await pollUntil(async () => page.node.getConnections().length, (n) => n > 0, { timeoutMs: 30_000, label: 'page node connected' })

    const watch = await watchFromPage(page, networkName)
    try {
      const t0 = Date.now()
      await pollUntil(async () => watch.wakes(), (n) => n >= 1, { timeoutMs: 90_000, label: 'first committed-tail read wakes the page' })
      console.log(`[pe-2] first wake ${Date.now() - t0} ms after the watch opened`)

      // Diagnostics for PE-3: what reaches the page's node when node-A commits. A landing in its own
      // storage means the strand pushed the commit's blocks to an anonymous reader; a delivery means a
      // cohort notification.
      let landings = 0
      let deliveries = 0
      const offLocal = page.node.storageRepo?.onCollectionChange?.(collectionId, () => { landings++ })
      const subscribers = page.node.reactivitySubscribers
      const deliver = subscribers?.deliver?.bind(subscribers)
      if (deliver !== undefined) subscribers.deliver = (...args: any[]) => { deliveries++; return deliver(...args) }

      const dbA = await harness.nodeA.openStrand(strandId)
      const base = watch.wakes()
      const t1 = Date.now()
      await dbA.exec("insert into TidHighWater (Namespace, HighWater) values ('pe-3', 2)")
      await pollUntil(async () => watch.wakes(), (n) => n > base, { timeoutMs: 90_000, label: 'node-A commit wakes the page' })
      const attached = page.node.reactivityWatch.isAttached(collectionId)
      console.log(`[pe-3] page woke ${Date.now() - t1} ms after node-A's commit; subscription registered with the cohort: ${attached}`)
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      console.log(`[pe-3] page node: storage landings for the collection ${landings}, notification deliveries ${deliveries}`)
      offLocal?.()
    } finally {
      await watch.close()
    }
  })

  it('PE-4 control: the page node on the bare strand id (the old network name) is never woken', async function () {
    this.timeout(120_000)
    const networkName = strandId
    const page = await startPageNode(networkName)
    const watch = await watchFromPage(page, networkName)
    try {
      await new Promise((resolve) => setTimeout(resolve, 60_000))
      console.log(`[pe-4] wakes on the bare-id node after 60 s: ${watch.wakes()}`)
      expect(watch.wakes(), 'a node whose protocol ids match no strand node read a committed tail').to.equal(0)
    } finally {
      await watch.close()
    }
  })
})
