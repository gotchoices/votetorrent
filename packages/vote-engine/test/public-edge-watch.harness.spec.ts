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
 *   PE-5 the page node is a reader, not a replica: neither strand node counts it into the collection's root
 *        (storage) group, because the page withdraws its storage services (`edge-node.js`)
 *   PE-6 its subscription registers with the cohort, and node-A's commit reaches it as a cohort NOTIFICATION
 *        (the threshold-signed path), with no block pushed into its storage
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
const PUBLIC_DB_CORE = new URL('../../../apps/VoteTorrentPublic/node_modules/@optimystic/db-core/dist/src/index.js', import.meta.url)
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

  /** The page's own tail reader over `page`. */
  async function createPageTails (page: PageNode, networkName: string): Promise<any> {
    const { createPageTailReader } = await import(new URL('tail-reader.js', PUBLIC_PEER).href)
    return createPageTailReader(page.node, networkName)
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

  it('PE-1..3,5,6 the page\'s node connects, stays out of the storage group, registers, and a commit on node-A reaches it as a notification', async function () {
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

      // PE-5: the page is a reader, not a replica: neither strand node counts it into the collection's
      // root group (the group its blocks are stored on and its reactivity root is placed on).
      const dbc: any = await import(PUBLIC_DB_CORE.href)
      const p2p: any = await import(PUBLIC_DB_P2P.href)
      const tailAnswer: any = (await (await createPageTails(page, networkName)).readTails([{ collectionId }])).get(collectionId)
      const coord = dbc.reactivityRootCoord(p2p.reactivityTailBytes(tailAnswer.tail.tailId))
      const pageId = page.node.peerId.toString()
      for (const w of ['A', 'B'] as const) {
        const raw = (w === 'A' ? harness.nodeA : harness.nodeB).node.getStrand(strandId).libp2pNode
        await pollUntil(async () => (await raw.keyNetwork.servingCohortAt(coord)) as string[], (m) => !m.includes(pageId), { timeoutMs: 30_000, label: `page out of node-${w}'s root group` })
      }

      // PE-6: the page's subscription registers with the cohort (within a couple of watch ticks).
      await pollUntil(async () => page.node.reactivityWatch.isAttached(collectionId), (a) => a === true, { timeoutMs: 75_000, label: 'page subscription registered' })

      // What reaches the page's node when node-A commits: a delivery is a cohort notification; a landing in
      // its own storage would mean the strand pushed the commit's blocks to an anonymous reader.
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
      expect(attached, 'the page subscription is still registered').to.equal(true)
      expect(deliveries, 'the commit reached the page as a cohort notification').to.be.greaterThan(0)
      expect(landings, 'no block of the commit was pushed into the page node\'s storage').to.equal(0)
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

describeP2PHarness('the Public page\'s live-update path: the first row of a collection that has never committed', function () {
  this.timeout(300_000)
  let harness: TwoNodeHarness

  after(async function () {
    this.timeout(60_000)
    await harness?.stop()
  })

  // PE-7: in the mesh-read gate the live mutation is the FIRST row of a table (Keyholder: "0 of 0" -> "0 of 1"). A
  // collection with no commit has no tail to place a subscription on. Every schema table that can be written without
  // a signed authority chain (TidHighWater) is already written when a strand opens, so this creates a fresh table on
  // node-A AFTER the page starts watching its collection id, then inserts its first row.
  it('PE-7 the first row of a collection the page was already watching wakes it', async function () {
    this.timeout(240_000)
    harness = await startTwoNodeHarness({ extraConfig: { strandReactivity: { enabled: true } } })
    const shared = await harness.openSharedStrand()
    const strandId = shared.strandId
    const strandNode = harness.nodeA.node.getStrand(strandId).libp2pNode
    const strandAddr = strandNode.getMultiaddrs().map((m: any) => m.toString()).find((a: string) => a.includes('/ip4/127.0.0.1/') && a.includes('/ws')) ?? ''
    const { createEdgeNode } = await import(new URL('edge-node.js', PUBLIC_PEER).href)
    const { loadOrCreateSessionPeerKey } = await import(new URL('identity.js', PUBLIC_PEER).href)
    const { createPageTailReader } = await import(new URL('tail-reader.js', PUBLIC_PEER).href)
    const { collectionIdForTable } = await import(new URL('collection-id.js', PUBLIC_PEER).href)
    const { MemoryRawStorage } = await import(PUBLIC_DB_P2P.href)
    const store = new Map<string, string>()
    const privateKey = await loadOrCreateSessionPeerKey({ getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: () => undefined })
    const networkName = `strand-${strandId}`
    const edge = await createEdgeNode(
      { strandId, networkName, bootstrapNodes: [strandAddr], privateKey },
      { openStrandBlockStorage: async () => ({ dbName: 'mem', db: { close: () => undefined }, storage: new MemoryRawStorage() }) }
    )
    try {
      await pollUntil(async () => edge.node.getConnections().length, (n) => n > 0, { timeoutMs: 30_000, label: 'page node connected' })
      const table = 'PeFirstRow'
      const collectionId = collectionIdForTable(table)
      let wakes = 0
      const handle = edge.node.reactivityWatch.watch({ collectionId, tails: createPageTailReader(edge.node, networkName), onChange: () => { wakes++ } })
      try {
        // Longer than one watch tick, so the page has read "no tail" at least once before the table exists.
        await new Promise((resolve) => setTimeout(resolve, 25_000))
        expect(wakes, 'a collection that has never committed must not wake the page').to.equal(0)
        await shared.dbA.exec(`create table App.${table} (Id text primary key, V integer)`)
        const t0 = Date.now()
        await shared.dbA.exec(`insert into App.${table} (Id, V) values ('first', 1)`)
        const optimystic: any = shared.dbA.schemaManager.getModule('optimystic')?.module
        const liveId = optimystic?.tables?.get(`app.${table.toLowerCase()}`)?.collection?.collection?.id
        expect(liveId, 'the id the page watched is the one node-A committed under').to.equal(collectionId)
        await pollUntil(async () => wakes, (n) => n > 0, { timeoutMs: 90_000, label: 'first row wakes the page' })
        console.log(`[pe-7] first row woke the page after ${Date.now() - t0} ms; attached: ${edge.node.reactivityWatch.isAttached(collectionId)}`)

        // And the next commit. Measured 2026-11-03 over 5 runs: the page's subscription on the new collection
        // registered in 4 (at the first tick after the first row), and the next commit reached the page as a
        // notification (~0.5 s) in 2 of 4, otherwise at the next tick (~20 s) -- so only "it wakes" is asserted.
        const base = wakes
        const t1 = Date.now()
        await shared.dbA.exec(`insert into App.${table} (Id, V) values ('second', 2)`)
        await pollUntil(async () => wakes, (n) => n > base, { timeoutMs: 60_000, label: 'second row wakes the page' })
        console.log(`[pe-7] second row woke the page after ${Date.now() - t1} ms`)
      } finally {
        await handle.close()
      }
    } finally {
      await edge.stop()
    }
  })
})
