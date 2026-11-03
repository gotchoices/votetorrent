/**
 * two-node-strand.ts — D-24 two-node strand harness.
 *
 * Boots two REAL CadreNodes inside vote-engine (`test/`, never `src/`): node-A, a
 * founder drone, and node-B, a peer it enrols. The bring-up shape (baseConfig +
 * droneOptions, the bring-up order, the enrol() retry loop, the settle gate) is
 * COPIED from `tools/multipeer-gate/lib/topology.mjs` / `ceremony.mjs` /
 * `gate-run.mjs` per D-24. `tools/multipeer-gate` is never imported or extended —
 * this harness is vote-engine's own, independent copy, free to diverge where the
 * 1.9.0 stack requires it (the "Deviations from topology.mjs" section below).
 *
 * Every strand it opens runs the real votetorrent schema
 * (`VOTETORRENT_INNER_DDL`, stripped exactly as `rn-db-factory.ts` strips it) and
 * the real UDFs (`SignatureValid`, `Digest`) via `registerDbPlugins` +
 * `declareViewsInMain` — the same calls production `NetworksEngine.createContext`
 * makes on a strand database.
 *
 * `requireSignedSchemas: false` is a TEST POSTURE, copied verbatim from
 * topology.mjs's `baseConfig`, and is NEVER a production posture — no app config
 * sets it.
 *
 * Relay traversal is explicitly OUT OF SCOPE here: both nodes listen directly on
 * loopback, so nothing in this file exercises circuit-relay addressing. That is
 * P2P-11's concern, not D-24's.
 *
 * Deviations from topology.mjs, re-checked against the installed 1.9.0 stack
 * (D-24 "stack in flux" note):
 *   - `StrandConfig` carries no `mode` field in 1.9.0 (topology.mjs still passes
 *     one; it is silently ignored there). This harness never sets it.
 *   - `initializeSeedBootstrap` is ASYNC in 1.9.0 (handles.mjs's `genesis()` does
 *     not await it) — this harness awaits it.
 *   - Membership is judged from node-A's own `isAuthorizedMember(peerId)` view,
 *     never `listAuthorizedMembers()` filtered for self (that call excludes self
 *     — a documented instrument defect on this stack).
 *
 * P2P packages are reached ONLY through dynamic `import()` inside
 * `startTwoNodeHarness`, so the default (flag-off) suite never loads libp2p.
 */

import type { Database } from '@quereus/quereus'
import { randomUUID } from 'node:crypto'
import { VOTETORRENT_SCHEMA_SQL } from '../../src/database/schema-sql.js'
import { registerDbPlugins, declareViewsInMain } from '../../src/database/initialize.js'
import type { DbFactory } from '../../src/types.js'
import type { User } from '@votetorrent/vote-core'
import type { EngineContext } from '../../src/types.js'

// ---------------------------------------------------------------------------
// Flag, describe wrapper
// ---------------------------------------------------------------------------

/** process.env.RUN_P2P_HARNESS === '1' */
export const P2P_HARNESS_ENABLED: boolean = process.env.RUN_P2P_HARNESS === '1'

/** P2P_HARNESS_ENABLED ? describe : describe.skip — consumers wrap their suites in this. */
export const describeP2PHarness: Mocha.SuiteFunction | Mocha.PendingSuiteFunction =
  P2P_HARNESS_ENABLED ? describe : describe.skip

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

const TIMEOUT_SCALE = Number(process.env.P2P_HARNESS_TIMEOUT_SCALE ?? 1)

function scaled (ms: number): number {
  return Math.round(ms * TIMEOUT_SCALE)
}

/**
 * Measured 2026-10-01 against the sereus 1.9.0 / optimystic 1.8.1 stack on this
 * host (Task 3 of 62-06-PLAN.md tunes these from a >=5-run measurement; see the
 * SUMMARY "Timing" section for the raw numbers). Initial Task 2 defaults, before
 * tuning, are the gate-derived values below. Every value is multiplied by
 * `P2P_HARNESS_TIMEOUT_SCALE` (default 1).
 *
 * Measured 2026-10-01, 8/8 runs passing (8 passing, 0 failing each run), host
 * load (1-min uptime average) ranged 3.47-5.50 across the 8 runs. Per-phase max
 * observed ms across the 8 passing runs: startAMs 153, startBMs 74, meshMs 4014,
 * enrolMs 94, strandOpenMs (addStrand+whenStrandWritable combined) 1964. Applying
 * `max(Task-2 gate-derived default, ceil(3 x observed-max) rounded up to the next
 * 5000ms)` to each phase keeps every value at its Task 2 gate-derived default
 * below (3x the observed max never approaches the conservative gate defaults on
 * a calm host) — the two earlier exploratory runs under host load ~6-16 (8
 * concurrent wave-1 sibling agents) that timed out/flaked at well under these
 * defaults are the evidence the generous defaults are warranted, not evidence to
 * shrink them. No numeric value below changed from the Task 2 defaults.
 */
export const HARNESS_TIMEOUTS: Readonly<{
  startMs: number
  meshMs: number
  enrolMs: number
  addStrandMs: number
  writableMs: number
  replicationMs: number
  pollMs: number
  suiteMs: number
}> = Object.freeze({
  startMs: scaled(45_000),
  meshMs: scaled(30_000),
  enrolMs: scaled(30_000),
  addStrandMs: scaled(60_000),
  writableMs: scaled(60_000),
  replicationMs: scaled(60_000),
  pollMs: scaled(500),
  suiteMs: scaled(300_000)
})

// ---------------------------------------------------------------------------
// Schema / sApp constants
// ---------------------------------------------------------------------------

/**
 * VOTETORRENT_SCHEMA_SQL with the outer `declare schema main { ... } apply
 * schema main;` wrapper stripped — the SAME two regexes `rn-db-factory.ts:30-33`
 * uses. cadre-core's `StrandDatabase.executeSchema()` re-wraps the inner DDL as
 * `declare schema App { ... } apply schema App;`; passing the unstripped string
 * would nest invalidly (`got '}'`).
 */
export const VOTETORRENT_INNER_DDL: string = VOTETORRENT_SCHEMA_SQL
  .replace(/^\s*declare\s+schema\s+\w+\s*\{/, '')
  .replace(/\}\s*apply\s+schema\s+\w+\s*;\s*$/, '')
  .trim()

/** 'org.votetorrent' — the same sApp id rn-db-factory.ts uses. */
export const HARNESS_SAPP_ID = 'org.votetorrent'

// ---------------------------------------------------------------------------
// Public types (LOCKED — see 62-06-PLAN.md <interfaces>)
// ---------------------------------------------------------------------------

/** Structurally identical to RegistrationStrandPort and AssociationStrandPort. */
export interface HarnessStrandPort {
  query<T>(sql: string, params: Record<string, unknown>): Promise<T[]>
  mutate(sql: string, params: Record<string, unknown>): Promise<void>
  close(): Promise<void>
}

export interface HarnessNode {
  readonly name: 'node-A' | 'node-B'
  readonly role: 'founder-drone' | 'peer'
  readonly peerId: string
  /** escape hatch (typed loosely: the instance of the dynamically imported CadreNode) */
  readonly node: any
  /** rn-db-factory semantics: addStrand(strandId = networkHash) + whenStrandWritable + setSchemaPath(['App','main']); NO plugin registration (the engine does that). Memoized per strandId. */
  readonly dbFactory: DbFactory
  /** dbFactory + registerDbPlugins + declareViewsInMain, memoized per strandId — the engine-free handle. */
  openStrand(strandId: string): Promise<Database>
  /** port over openStrand(strandId); every call increments stats */
  strandPort(strandId: string): Promise<HarnessStrandPort>
  /** counts of port calls made THROUGH THIS NODE — the writer-identity tripwire */
  readonly stats: { mutateCount: number; queryCount: number }
}

export interface HarnessTimings {
  startAMs: number
  genesisMs: number
  startBMs: number
  meshMs: number
  enrolMs: number
  strandOpenMs: Record<string, { aMs?: number; bMs?: number }>
}

export interface TwoNodeHarness {
  readonly runId: string
  readonly partyId: string
  readonly nodeA: HarnessNode
  readonly nodeB: HarnessNode
  /** opens strandId on node-A, then on node-B. Default strandId: `vt-harness-${runId}` */
  openSharedStrand (strandId?: string): Promise<{
    strandId: string
    dbA: Database
    dbB: Database
    portA: HarnessStrandPort
    portB: HarnessStrandPort
  }>
  readonly timings: HarnessTimings
  /** O-02: change the explicit `founder` value node-B's NEXT addStrand passes (undefined = pass none). */
  setNodeBFounder (founder: boolean | undefined): void
  /** O-02: dial node-A from a peerless node-B, wait for the mesh to settle, then enrol it (re-uses enrolNodeB). */
  connectAndEnrolNodeB (): Promise<void>
  /** stops node-B then node-A; idempotent; never throws (logs instead) */
  stop (): Promise<void>
}

export interface TwoNodeHarnessOptions {
  partyId?: string
  clusterSize?: number
  log?: (line: string) => void
  /**
   * O-02 instrument (default off). Start node-B with NO bootstrap address to node-A and
   * without enrolment, so it is genuinely peerless (zero control connections). The
   * node-A-before-node-B strand ordering assertion is bypassed for node-B in this mode.
   * Connect and enrol it later with `connectAndEnrolNodeB()`.
   */
  peerlessNodeB?: boolean
  /**
   * O-02 instrument (default undefined = today's behaviour: node-B passes no `founder`
   * flag). When set, node-B's addStrand receives this explicit `founder` value. Can be
   * changed at runtime via `setNodeBFounder()`. node-A always opens with founder:true.
   */
  nodeBFounder?: boolean
  /**
   * Extra CadreNodeConfig keys for BOTH nodes, spread last (default none). Added 2026-11-02 for the
   * reactivity/matchmaking harness (`strandReactivity: { enabled: true }`).
   */
  extraConfig?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// pollUntil
// ---------------------------------------------------------------------------

/**
 * Polls read() every opts.intervalMs (default HARNESS_TIMEOUTS.pollMs) until
 * done(value); throws Error(`${label} timed out after ${timeoutMs}ms;
 * last=${JSON.stringify(last)}`) on timeout.
 *
 * A throw from read() is treated as "not yet done" and retried on the same
 * interval, not as a terminal failure — callers poll specifically because the
 * underlying operation (e.g. a strand open racing a P2P block-fetch) is
 * expected to be transiently unready, and a bare exception is one of the
 * ways "not ready yet" surfaces (fix: debug session founding-bundle-harness-f1,
 * 2026-10-01 — the original version re-threw read()'s first exception
 * immediately, so no caller of pollUntil ever actually retried past a throw,
 * contrary to this function's documented contract and every caller's intent).
 * If the deadline is reached on a throwing attempt, the ORIGINAL error is
 * thrown (more actionable than "last=undefined").
 */
export async function pollUntil<T> (
  read: () => Promise<T>,
  done: (v: T) => boolean,
  opts: { timeoutMs: number; intervalMs?: number; label: string }
): Promise<T> {
  const intervalMs = opts.intervalMs ?? HARNESS_TIMEOUTS.pollMs
  const deadline = Date.now() + opts.timeoutMs
  let last: T
  for (;;) {
    try {
      last = await read()
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error
      }
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
      continue
    }
    if (done(last)) return last
    if (Date.now() >= deadline) {
      throw new Error(`${opts.label} timed out after ${opts.timeoutMs}ms; last=${JSON.stringify(last)}`)
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
  }
}

// ---------------------------------------------------------------------------
// Internal: node bring-up
// ---------------------------------------------------------------------------

/** Pick a loopback websocket address — the gate-run.mjs `loopbackWs` rule. */
function loopbackWs (addrs: string[]): string {
  return addrs.find((a) => a.includes('/ip4/127.0.0.1/') && a.includes('/ws')) ?? addrs[0] ?? ''
}

class MeshTimeoutError extends Error {}

/**
 * One attempt at the full bring-up sequence, at a given pair of listen
 * addresses. Throws MeshTimeoutError if the control mesh never forms within
 * meshMs — the caller decides whether to retry with a different listen address.
 * Any other failure is fatal (both nodes are stopped before the throw).
 */
async function attemptBringUp (
  listenAddrs: string[],
  opts: { partyId: string; clusterSize: number; log: (line: string) => void; peerlessNodeB?: boolean; extraConfig?: Record<string, unknown> }
): Promise<{
  nodeA: any
  nodeB: any
  timings: HarnessTimings
}> {
  const { partyId, clusterSize, log } = opts

  const { CadreNode, ed25519KeyPairFromLibp2p } = await import('@serfab/cadre-core')
  const { MemoryRawStorage } = await import('@optimystic/db-p2p')
  const { webSockets } = await import('@libp2p/websockets')
  const { generateKeyPair } = await import('@libp2p/crypto/keys')

  const timings: HarnessTimings = {
    startAMs: 0,
    genesisMs: 0,
    startBMs: 0,
    meshMs: 0,
    enrolMs: 0,
    strandOpenMs: {}
  }

  function buildConfig (bootstrapNodes: string[], privateKey: unknown): any {
    const storage = new MemoryRawStorage()
    return {
      privateKey,
      controlNetwork: { partyId, bootstrapNodes },
      // Test posture only (topology.mjs baseConfig) — never a production config.
      requireSignedSchemas: false,
      strandFilter: { mode: 'all' },
      storage: { provider: () => storage },
      strandClusterSize: clusterSize,
      hibernation: { enabled: false },
      profile: 'storage',
      network: { transports: [webSockets()], listenAddrs },
      ...(opts.extraConfig ?? {})
    }
  }

  let nodeA: any
  let nodeB: any

  try {
    // --- 1. Start node-A, bounded by startMs. ---
    const t0 = Date.now()
    const privateKeyA = await generateKeyPair('Ed25519')
    nodeA = new CadreNode(buildConfig([], privateKeyA))
    await withTimeout(nodeA.start(), HARNESS_TIMEOUTS.startMs, 'node-A start')
    timings.startAMs = Date.now() - t0

    // --- 2. Owner genesis on node-A while it is STILL SOLO (handles.mjs genesis()). ---
    const t1 = Date.now()
    // cadre-core 1.18 deleted getIdentityOwnerKey(); derive the same identity owner key here.
    const owner = ed25519KeyPairFromLibp2p(privateKeyA)
    await nodeA.trustOwnerKeys([owner.publicKeyB64], 'operator')
    const controlDb = nodeA.getControlDatabase()
    if (!controlDb) throw new Error('two-node harness: no control database after node-A start()')
    await controlDb.ensureOwnerKey(owner.publicKeyB64)
    // 1.9.0: initializeSeedBootstrap is ASYNC — awaited (D-24 re-checked workaround).
    await nodeA.initializeSeedBootstrap(owner.privateKeyB64)
    timings.genesisMs = Date.now() - t1

    // --- 3. Start node-B, bootstrapped to node-A's loopback websocket address. ---
    const t2 = Date.now()
    const nodeAAddr = loopbackWs((nodeA.getControlNode()?.getMultiaddrs() ?? []).map((m: any) => m.toString()))
    const privateKeyB = await generateKeyPair('Ed25519')
    // O-02 (peerlessNodeB): no bootstrap address, so node-B has zero control connections.
    nodeB = new CadreNode(buildConfig(opts.peerlessNodeB ? [] : [nodeAAddr], privateKeyB))
    await withTimeout(nodeB.start(), HARNESS_TIMEOUTS.startMs, 'node-B start')
    timings.startBMs = Date.now() - t2

    if (opts.peerlessNodeB) {
      // Deliberately no settle and no enrolment: connectAndEnrolNodeB() does both on demand.
      return { nodeA, nodeB, timings }
    }

    // --- 4. Settle: poll until both nodes have >= 1 connection, then grace 3000ms. ---
    const t3 = Date.now()
    const settled = await pollSettle(nodeA, nodeB, HARNESS_TIMEOUTS.meshMs)
    if (!settled) {
      throw new MeshTimeoutError(`control mesh did not settle within ${HARNESS_TIMEOUTS.meshMs}ms on listen ${listenAddrs.join(',')}`)
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 3000))
    timings.meshMs = Date.now() - t3

    // --- 5. Enrol node-B (ceremony.mjs enrol(), up to 5 attempts, linear backoff). ---
    const t4 = Date.now()
    await enrolNodeB(nodeA, nodeB, log)
    const memberNow = await nodeA.isAuthorizedMember(nodeB.peerId.toString())
    if (!memberNow) {
      throw new Error('two-node harness: node-B is not an authorized member after enrolment attempts')
    }
    timings.enrolMs = Date.now() - t4

    return { nodeA, nodeB, timings }
  } catch (error) {
    // Any failure (including MeshTimeoutError) stops whatever nodes started.
    await stopQuietly(nodeB, log)
    await stopQuietly(nodeA, log)
    throw error
  }
}

async function pollSettle (nodeA: any, nodeB: any, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const aConns = (nodeA.getControlNode()?.getConnections() ?? []).length
    const bConns = (nodeB.getControlNode()?.getConnections() ?? []).length
    if (aConns >= 1 && bConns >= 1) return true
    if (Date.now() >= deadline) return false
    await new Promise<void>((resolve) => setTimeout(resolve, 500))
  }
}

async function enrolNodeB (nodeA: any, nodeB: any, log: (line: string) => void): Promise<void> {
  const peerId = nodeB.peerId.toString()
  const attempts = 5
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const before = await nodeA.isAuthorizedMember(peerId)
      if (before === true) { lastErr = null; break }
    } catch (e) {
      log(`membership read before attempt ${attempt} failed: ${(e as Error)?.message ?? e}`)
    }

    try {
      // cadre-core 1.14: one-sided redemption. Node-A mints a cadre invitation targeted at
      // node-B; node-B redeems it at node-A, which seats node-B's CadrePeer row during the
      // redemption (no owner-side accept). A retry mints a fresh invitation, so a seat spent by
      // an attempt whose reply was lost never blocks the next one.
      const { invitation } = await withTimeout<any>(
        nodeA.createCadreInvitation({ peerId }),
        HARNESS_TIMEOUTS.enrolMs,
        'node-A createCadreInvitation'
      )
      await withTimeout(nodeB.redeemCadreInvitation(invitation), HARNESS_TIMEOUTS.enrolMs, 'node-B redeemCadreInvitation')
      log(`enrol ceremony ran (attempt ${attempt})`)
    } catch (e) {
      lastErr = e
      log(`enrol ceremony attempt ${attempt}/${attempts} failed: ${(e as Error)?.message ?? e}`)
    }

    try {
      const settled = await nodeA.isAuthorizedMember(peerId)
      if (settled === true) { lastErr = null; break }
    } catch (e) {
      log(`membership read after attempt ${attempt} failed: ${(e as Error)?.message ?? e}`)
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 2000 * attempt))
  }
  if (lastErr) {
    throw new Error(`two-node harness: node-B did not enrol after ${attempts} attempt(s): ${(lastErr as Error)?.message ?? lastErr}`)
  }
}

async function withTimeout<T> (p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    clearTimeout(timer!)
  }
}

async function stopQuietly (node: any, log: (line: string) => void): Promise<void> {
  if (!node) return
  try {
    await node.stop()
  } catch (e) {
    log(`stop() failed (ignored): ${(e as Error)?.message ?? e}`)
  }
}

// ---------------------------------------------------------------------------
// Internal: strand open / port
// ---------------------------------------------------------------------------

function buildHarnessNode (
  name: 'node-A' | 'node-B',
  role: 'founder-drone' | 'peer',
  node: any,
  isNodeA: boolean,
  openedByA: Set<string>,
  timings: HarnessTimings,
  log: (line: string) => void,
  founderCtl: { nodeB?: boolean; bypassOrdering: boolean }
): HarnessNode {
  const dbFactoryCache = new Map<string, Promise<Database>>()
  const openStrandCache = new Map<string, Promise<Database>>()
  const stats = { mutateCount: 0, queryCount: 0 }

  function assertOrdering (strandId: string): void {
    if (!isNodeA && !founderCtl.bypassOrdering && !openedByA.has(strandId)) {
      throw new Error(`two-node harness: open strand ${strandId} on node-A (founder) before node-B`)
    }
  }

  async function rawOpen (strandId: string): Promise<Database> {
    const started = Date.now()
    const addStrandConfig: any = {
      strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null, FounderPeerId: null },
      sAppConfig: { id: HARNESS_SAPP_ID, version: '1.0.0', schema: VOTETORRENT_INNER_DDL, latencyHint: 'interactive' },
      // awaitFirstSync: false — mirrors topology.mjs strandConfig(): cadre-core >= 1.1.0
      // defaults a JOINER's addStrand to block on first sync; opting out lets the strand
      // launch immediately and this harness awaits whenStrandWritable itself.
      awaitFirstSync: false
    }
    if (isNodeA) addStrandConfig.founder = true
    else if (founderCtl.nodeB !== undefined) addStrandConfig.founder = founderCtl.nodeB

    await withTimeout(node.addStrand(addStrandConfig), HARNESS_TIMEOUTS.addStrandMs, `${name} addStrand(${strandId})`)
    await node.whenStrandWritable(strandId, { timeoutMs: HARNESS_TIMEOUTS.writableMs })
    const strand = node.getStrand(strandId)
    const db: Database = strand.database.getDatabase()
    db.setSchemaPath(['App', 'main'])

    const elapsed = Date.now() - started
    const entry = timings.strandOpenMs[strandId] ?? {}
    if (isNodeA) entry.aMs = elapsed
    else entry.bMs = elapsed
    timings.strandOpenMs[strandId] = entry

    return db
  }

  const dbFactory: DbFactory = async (strandId: string) => {
    assertOrdering(strandId)
    let p = dbFactoryCache.get(strandId)
    if (!p) {
      if (isNodeA) openedByA.add(strandId)
      p = rawOpen(strandId)
      dbFactoryCache.set(strandId, p)
      // Evict a rejected attempt so a LATER caller (e.g. pollUntil retrying a
      // transient P2P block-fetch race) can actually re-attempt rawOpen()
      // instead of forever replaying the same dead promise (fix: debug session
      // founding-bundle-harness-f1, 2026-10-01 — previously one failed
      // addStrand attempt permanently poisoned the strandId for the rest of
      // the run; the guard avoids deleting a newer, already-succeeded entry).
      p.catch(() => {
        if (dbFactoryCache.get(strandId) === p) dbFactoryCache.delete(strandId)
      })
    }
    return p
  }

  async function openStrand (strandId: string): Promise<Database> {
    assertOrdering(strandId)
    let p = openStrandCache.get(strandId)
    if (!p) {
      if (isNodeA) openedByA.add(strandId)
      p = (async () => {
        const db = await dbFactory(strandId)
        await registerDbPlugins(db)
        await declareViewsInMain(db)
        return db
      })()
      openStrandCache.set(strandId, p)
    }
    return p
  }

  async function strandPort (strandId: string): Promise<HarnessStrandPort> {
    const db = await openStrand(strandId)
    return {
      async query<T> (sql: string, params: Record<string, unknown>): Promise<T[]> {
        stats.queryCount++
        const rows: T[] = []
        for await (const row of db.eval(sql, params as any)) {
          rows.push(row as unknown as T)
        }
        return rows
      },
      async mutate (sql: string, params: Record<string, unknown>): Promise<void> {
        stats.mutateCount++
        await db.exec(sql, params as any)
      },
      async close (): Promise<void> {
        // NEVER closes the shared strand — no-op by design.
      }
    }
  }

  return {
    name,
    role,
    peerId: node.peerId.toString(),
    node,
    dbFactory,
    openStrand,
    strandPort,
    stats
  }
}

// ---------------------------------------------------------------------------
// startTwoNodeHarness
// ---------------------------------------------------------------------------

/**
 * Boots node-A, runs owner genesis while A is solo, boots node-B bootstrapped to
 * A, enrols B, waits until nodeA.node.isAuthorizedMember(B.peerId) === true.
 * Opens NO strand. Throws (after stopping both nodes) on any failure.
 */
export async function startTwoNodeHarness (options: TwoNodeHarnessOptions = {}): Promise<TwoNodeHarness> {
  const runId = randomUUID().slice(0, 8)
  const partyId = options.partyId ?? `vote-engine-p2p-harness-${runId}`
  const clusterSize = options.clusterSize ?? 2
  const log = options.log ?? ((line: string) => console.log(`[p2p-harness] ${line}`))

  const peerlessNodeB = options.peerlessNodeB === true
  let built: { nodeA: any; nodeB: any; timings: HarnessTimings }
  try {
    built = await attemptBringUp(['/ip4/127.0.0.1/tcp/0/ws'], { partyId, clusterSize, log, peerlessNodeB, extraConfig: options.extraConfig })
  } catch (error) {
    if (error instanceof MeshTimeoutError) {
      log(`DEVIATION: control mesh did not settle on 127.0.0.1 (${(error as Error).message}); falling back to 0.0.0.0 per topology.mjs`)
      built = await attemptBringUp(['/ip4/0.0.0.0/tcp/0/ws'], { partyId, clusterSize, log, peerlessNodeB, extraConfig: options.extraConfig })
    } else {
      throw error
    }
  }

  const { nodeA, nodeB, timings } = built
  const openedByA = new Set<string>()

  const founderCtl: { nodeB?: boolean; bypassOrdering: boolean } = {
    nodeB: options.nodeBFounder,
    bypassOrdering: peerlessNodeB
  }
  const harnessNodeA = buildHarnessNode('node-A', 'founder-drone', nodeA, true, openedByA, timings, log, founderCtl)
  const harnessNodeB = buildHarnessNode('node-B', 'peer', nodeB, false, openedByA, timings, log, founderCtl)

  let stopped = false

  return {
    runId,
    partyId,
    nodeA: harnessNodeA,
    nodeB: harnessNodeB,
    timings,
    setNodeBFounder (founder: boolean | undefined) {
      founderCtl.nodeB = founder
    },
    async connectAndEnrolNodeB () {
      // A peerless node-B has no route to node-A; redeemCadreInvitation (inside enrolNodeB) dials the invitation members.
      // Settle is checked afterwards, never faked: a failure throws.
      await enrolNodeB(nodeA, nodeB, log)
      const settled = await pollSettle(nodeA, nodeB, HARNESS_TIMEOUTS.meshMs)
      if (!settled) throw new Error('two-node harness: control mesh did not settle after connectAndEnrolNodeB')
      const memberNow = await nodeA.isAuthorizedMember(nodeB.peerId.toString())
      if (!memberNow) throw new Error('two-node harness: node-B is not an authorized member after connectAndEnrolNodeB')
    },
    async openSharedStrand (strandId: string = `vt-harness-${runId}`) {
      const dbA = await harnessNodeA.openStrand(strandId)
      const dbB = await harnessNodeB.openStrand(strandId)
      const portA = await harnessNodeA.strandPort(strandId)
      const portB = await harnessNodeB.strandPort(strandId)
      return { strandId, dbA, dbB, portA, portB }
    },
    async stop () {
      if (stopped) return
      stopped = true
      await stopQuietly(nodeB, log)
      await stopQuietly(nodeA, log)
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 66 plan 09: owner-minted browser pairing helpers (ADDITIVE ONLY)
//
// Everything below is appended for `dashboard-pair-mint.harness.spec.ts`. The edge-member helpers are
// copies of 66-01's module-local helpers in `dashboard-member-watch.harness.spec.ts` (memoryEdgePlatform,
// startJoiner, attachJoinerStrand), which this plan may not import. Every P2P package and every test fixture
// is reached by dynamic `import()` inside the function bodies, so the flag-off suite's import graph does
// not change. Key material in `HarnessPairingOfficer.privBytes` is test-only and is never logged.
// ---------------------------------------------------------------------------

/** A P-256 officer seeded by seedPairingOfficers. `privBytes` is test-only key material: never log it. */
export interface HarnessPairingOfficer {
  user: User
  keyPub: string
  privBytes: Uint8Array
}

export interface HarnessPairingNetwork {
  hash: string
  authorityId: string
  dbA: Database
  dbB: Database
  ctxA: EngineContext
  ctxB: EngineContext
  founder: User
  officerB: HarnessPairingOfficer
  formerOfficerY: HarnessPairingOfficer
  currentAdminEffectiveAt: string
  formerAdminEffectiveAt: string
}

const PAIRING_FOUNDER_SCOPES = ['rn', 'rad', 'vrg', 'iad', 'uai', 'mel', 'ceb']

/** Officer UserId -> the canonical AdminEffectiveAt values its Officer rows carry. */
async function officerGenerations (db: Database, authorityId: string): Promise<Map<string, Set<string>>> {
  const { toCanonicalDatetime } = await import('../../src/utils.js')
  const out = new Map<string, Set<string>>()
  for await (const row of db.eval('select UserId, AdminEffectiveAt from Officer where AuthorityId = :authorityId', { authorityId } as any)) {
    const userId = String((row as any).UserId)
    const gen = toCanonicalDatetime((row as any).AdminEffectiveAt as string | number)
    const set = out.get(userId) ?? new Set<string>()
    set.add(gen)
    out.set(userId, set)
  }
  return out
}

/**
 * Found a VoteTorrent network on node-A (founding administration placed 180 s in the past), add two P-256
 * users B and Y, promote [founder, B, Y] (gen-1, 120 s ago) and then [founder, B] (gen-2, 60 s ago), so B
 * is a current officer and Y has an Officer row only in an earlier administration. Opens the strand on
 * node-B and waits for B's and Y's rows there.
 */
export async function seedPairingOfficers (harness: TwoNodeHarness): Promise<HarnessPairingNetwork> {
  const tc = await import('../fixtures/test-context.js')
  const { makeP256TestKey } = await import('../fixtures/p256-signer.js')
  const { toCanonicalDatetime, nowCanonicalDatetime } = await import('../../src/utils.js')

  const net = await tc.createTestNetwork({
    dbFactory: harness.nodeA.dbFactory,
    network: {
      admin: {
        officers: [{ init: { name: 'Admin A', title: 'Chair', scopes: PAIRING_FOUNDER_SCOPES as any } }],
        effectiveAt: Date.now() - 180_000,
        thresholdPolicies: [{ policy: 'rad' as any, threshold: 1 }]
      }
    } as any
  })
  const auth = await tc.addTestAuthority(net)
  const hash = net.ref.hash
  const authorityId = auth.authority.id
  const dbA = net.ctx.db

  function p256User (name: string): HarnessPairingOfficer {
    const k = makeP256TestKey()
    const user: User = {
      ...tc.makeDistinctTestUser(),
      name,
      activeKeys: [{ key: k.pubHex, type: 'P' as any, expiration: Date.now() + 86_400_000 }]
    }
    return { user, keyPub: k.pubHex, privBytes: k.privBytes }
  }

  // insertFixtureUser's shape (module-local in threshold-authority.ts): invite-bound User insert, then the
  // FIRST UserKey with the key's own type.
  async function insertUser (user: User): Promise<void> {
    const { inviteSlotCid, inviteSignature } = await tc.seedUserInvite(auth, user)
    const tid = Date.now() + Math.floor(Math.random() * 1_000_000)
    await dbA.exec(
      `insert into User (Id, Name, ImageRef)
       with context SigningNonce = null, InviteSlotCid = :inviteSlotCid, InviteSignature = :inviteSignature, Tid = ${tid}
       values (:userId, :userName, :userImageRef)`,
      {
        userId: user.id,
        userName: user.name,
        userImageRef: user.imageRef ? JSON.stringify(user.imageRef) : null,
        inviteSlotCid,
        inviteSignature
      } as any
    )
    const key = user.activeKeys[0]!
    await dbA.exec(
      `insert into UserKey (UserId, Type, PubKey, Expiration)
       with context UserKey = null, Signature = null, Tid = ${tid + 1}, now = :now, IsSignatureValid = true
       values (:userId, :type, :pubKey, :expiration)`,
      {
        userId: user.id,
        type: key.type,
        pubKey: key.key,
        expiration: toCanonicalDatetime(key.expiration),
        now: nowCanonicalDatetime()
      } as any
    )
  }

  const officerB = p256User('Pairing Officer B')
  const formerOfficerY = p256User('Former Officer Y')
  await insertUser(officerB.user)
  await insertUser(formerOfficerY.user)

  const founderSign = tc.makeTestSignCallback(net.user)
  const founderEntry = { existing: { userId: net.user.id, authorityId, title: 'Chair', scopes: PAIRING_FOUNDER_SCOPES } }
  const bEntry = { existing: { userId: officerB.user.id, authorityId, title: 'Officer B', scopes: ['mel'] } }
  const yEntry = { existing: { userId: formerOfficerY.user.id, authorityId, title: 'Officer Y', scopes: ['mel'] } }

  async function promote (label: string, officers: unknown[], effectiveAt: number): Promise<void> {
    await auth.authorityEngine.proposeAdmin({
      proposed: { officers, effectiveAt, thresholdPolicies: [{ policy: 'rad', threshold: 1 }] },
      signers: [net.user.id]
    } as any, founderSign)
    const outcome = (auth.authorityEngine as unknown as { lastPromotionOutcome?: { status?: string } }).lastPromotionOutcome
    if (outcome?.status !== 'promoted') {
      throw new Error(`seedPairingOfficers: ${label} promotion did not complete (status ${String(outcome?.status)})`)
    }
  }

  const gen1At = Date.now() - 120_000
  await promote('gen-1', [founderEntry, bEntry, yEntry], gen1At)
  const gen2At = Date.now() - 60_000
  await promote('gen-2', [founderEntry, bEntry], gen2At)
  const formerAdminEffectiveAt = toCanonicalDatetime(gen1At)
  const currentAdminEffectiveAt = toCanonicalDatetime(gen2At)

  // Read-backs on node-A.
  const current = await dbA.prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId').get({ authorityId } as any)
  if (current == null || toCanonicalDatetime((current as any).EffectiveAt) !== currentAdminEffectiveAt) {
    throw new Error('seedPairingOfficers: CurrentAdmin is not the gen-2 administration on node-A')
  }
  const gensA = await officerGenerations(dbA, authorityId)
  const bGens = gensA.get(officerB.user.id)
  const yGens = gensA.get(formerOfficerY.user.id)
  const fGens = gensA.get(net.user.id)
  if (bGens?.has(currentAdminEffectiveAt) !== true || bGens.has(formerAdminEffectiveAt) !== true) {
    throw new Error('seedPairingOfficers: officer B lacks a gen-1 or gen-2 Officer row on node-A')
  }
  if (fGens?.has(currentAdminEffectiveAt) !== true) {
    throw new Error('seedPairingOfficers: the founder lacks a gen-2 Officer row on node-A')
  }
  if (yGens?.has(formerAdminEffectiveAt) !== true || yGens.has(currentAdminEffectiveAt)) {
    throw new Error('seedPairingOfficers: officer Y is not a gen-1-only officer on node-A')
  }

  // node-B's replica.
  const dbB = await harness.nodeB.openStrand(hash)
  await pollUntil(
    async () => {
      const gens = await officerGenerations(dbB, authorityId)
      const key = await dbB.prepare('select 1 as x from UserKey where UserId = :userId and PubKey = :pubKey')
        .get({ userId: officerB.user.id, pubKey: officerB.keyPub } as any)
      return {
        b: gens.get(officerB.user.id)?.has(currentAdminEffectiveAt) === true,
        y: gens.get(formerOfficerY.user.id)?.has(formerAdminEffectiveAt) === true,
        key: key != null
      }
    },
    (v) => v.b && v.y && v.key,
    { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: 'seedPairingOfficers: officer rows reach node-B' }
  )

  return {
    hash,
    authorityId,
    dbA,
    dbB,
    ctxA: net.ctx,
    ctxB: { db: dbB, user: officerB.user },
    founder: net.user,
    officerB,
    formerOfficerY,
    currentAdminEffectiveAt,
    formerAdminEffectiveAt
  }
}

/** A browser-like cadre-core edge node (the dashboard's shape), created but not joined. */
export interface HarnessEdgeMember {
  label: string
  edge: any
  keyStore: any
  removed: unknown[]
  strandStarted: string[]
  withdrawn: string[]
  destroyedScopes: string[]
  identityPeerId(): Promise<string>
  stop(): Promise<void>
}

/**
 * Create the edge node only (no join), on 66-01's in-memory platform: `requireSignedSchemas: false`, the
 * `strandId` filter, the given cluster size and `strandReactivity` for that one strand. On `strand:started`
 * it withdraws the strand's storage services (cluster and repo protocols), as the dashboard does.
 */
export async function startHarnessEdgeMember (opts: {
  label: string
  storageId: string
  strandId: string
  clusterSize: number
  keyStore?: any
  strandReactivity?: Record<string, unknown>
}): Promise<HarnessEdgeMember> {
  const { InMemoryKeyStore } = await import('@serfab/cadre-core')
  // @ts-ignore -- exports-map subpath this package's moduleResolution cannot type; resolves at runtime
  const { createEdgeNode } = await import('@serfab/cadre-core/edge-node')
  const { MemoryRawStorage } = await import('@optimystic/db-p2p')
  const keyStore = opts.keyStore ?? new InMemoryKeyStore()
  const destroyedScopes: string[] = []
  const scopes = new Map<string, any>()
  const local = new Map<string, string>()
  const platform: any = {
    keyStore,
    storage: {
      id: opts.storageId,
      rawStorage (scope: string) {
        let s = scopes.get(scope)
        if (s === undefined) {
          s = new MemoryRawStorage()
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
  const edge: any = createEdgeNode(platform)
  const removed: unknown[] = []
  const strandStarted: string[] = []
  const withdrawn: string[] = []
  edge.on('strand:started', ({ strandId }: { strandId: string }) => {
    strandStarted.push(strandId)
    try {
      const strandNode: any = edge.node?.getStrand(strandId)?.libp2pNode
      if (strandNode === undefined) throw new Error('no strand node at strand:started')
      strandNode.unhandle([`/optimystic/strand-${strandId}/cluster/1.0.0`, `/optimystic/strand-${strandId}/repo/1.0.0`])
      withdrawn.push(strandId)
    } catch (err) {
      console.log(`[${opts.label}] storage withdrawal failed: ${(err as Error).name}`)
    }
  })
  edge.on('cadre:removed', (removal: unknown) => { removed.push(removal) })
  let stopped = false
  return {
    label: opts.label,
    edge,
    keyStore,
    removed,
    strandStarted,
    withdrawn,
    destroyedScopes,
    async identityPeerId () {
      return await edge.identityPeerId()
    },
    async stop () {
      if (stopped) return
      stopped = true
      try {
        if (edge.status?.state !== 'removed') await edge.stop()
      } catch { /* idempotent teardown */ }
    }
  }
}

/**
 * Claim `strandId` on a joined edge member (a transaction-profile edge node hosts no unclaimed strand): no
 * founder key, `awaitFirstSync: false`, the harness sApp. Waits for `strand:started`, the storage withdrawal
 * and the strand database, and returns the strand libp2p node, ITS OWN peer id (not the identity peer id)
 * and the strand's Quereus database on the `['App','main']` schema path. No crypto plugin is registered.
 */
export async function attachHarnessEdgeStrand (
  member: HarnessEdgeMember,
  strandId: string
): Promise<{ strandNode: any; strandPeerId: string; db: Database }> {
  const node: any = member.edge.node
  if (node === null || node === undefined) throw new Error('attachHarnessEdgeStrand: the member has no running node')
  try {
    await node.addStrand({
      strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null, FounderPeerId: null },
      sAppConfig: { id: HARNESS_SAPP_ID, version: '1.0.0', schema: VOTETORRENT_INNER_DDL, latencyHint: 'interactive' },
      awaitFirstSync: false
    })
  } catch (err) {
    console.log(`[${member.label}] addStrand rejected (${(err as Error).name}); continuing with getStrand`)
  }
  await pollUntil(
    async () => member.strandStarted.includes(strandId) && member.withdrawn.includes(strandId),
    (v) => v === true,
    { timeoutMs: scaled(60_000), label: `${member.label} strand started and storage withdrawn` }
  )
  // cadre-core sets `database` once the strand header arrives, which can trail strand:started.
  const strandDb: any = await pollUntil(
    async () => node.getStrand(strandId)?.database ?? null,
    (v) => v !== null,
    { timeoutMs: scaled(60_000), label: `${member.label} strand database present` }
  )
  const strandNode = node.getStrand(strandId).libp2pNode
  const db: Database = strandDb.getDatabase()
  db.setSchemaPath(['App', 'main'])
  return { strandNode, strandPeerId: strandNode.peerId.toString(), db }
}

/**
 * A CadreNode on the harness party id, bootstrapped to node-A's loopback WebSocket control address and NEVER
 * invited or enrolled: a stranger to the cadre.
 */
export async function startHarnessStranger (
  harness: TwoNodeHarness,
  opts?: { clusterSize?: number }
): Promise<{ node: any; peerId: string; stop(): Promise<void> }> {
  const { CadreNode } = await import('@serfab/cadre-core')
  const { MemoryRawStorage } = await import('@optimystic/db-p2p')
  const { webSockets } = await import('@libp2p/websockets')
  const { generateKeyPair } = await import('@libp2p/crypto/keys')
  const nodeAAddr = loopbackWs((harness.nodeA.node.getControlNode()?.getMultiaddrs() ?? []).map((m: any) => m.toString()))
  const storage = new MemoryRawStorage()
  const node: any = new CadreNode({
    privateKey: await generateKeyPair('Ed25519'),
    controlNetwork: { partyId: harness.partyId, bootstrapNodes: [nodeAAddr] },
    // Test posture only (as buildConfig above) — never a production config.
    requireSignedSchemas: false,
    strandFilter: { mode: 'all' },
    storage: { provider: () => storage },
    strandClusterSize: opts?.clusterSize ?? 2,
    hibernation: { enabled: false },
    profile: 'transaction',
    network: { transports: [webSockets()], listenAddrs: ['/ip4/127.0.0.1/tcp/0/ws'] }
  } as any)
  const quietLog = (line: string): void => { console.log(`[p2p-harness] stranger ${line}`) }
  try {
    await withTimeout(node.start(), HARNESS_TIMEOUTS.startMs, 'stranger start')
  } catch (error) {
    await stopQuietly(node, quietLog)
    throw error
  }
  let stopped = false
  return {
    node,
    peerId: node.peerId.toString(),
    async stop () {
      if (stopped) return
      stopped = true
      await stopQuietly(node, quietLog)
    }
  }
}
