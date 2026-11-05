/**
 * o02-peerless-import-founder.harness.spec.ts — 62-93 (O-02 falsification instrument).
 *
 * Opt-in (`RUN_P2P_HARNESS=1`; pending otherwise, libp2p never loaded). Two arms:
 *   Arm J (control): node-B connected + enrolled, imports a founding bundle with the
 *     strand opened `founder:false` (what rn-db-factory computes with peers).
 *   Arm F (O-02): node-B PEERLESS, imports with the strand opened `founder:true` (what
 *     rn-db-factory computes with zero control connections), THEN connects + enrols.
 * Arm order from env `O02_ARM_ORDER` ("JF" default, or "FJ"); run label from `O02_RUN`.
 *
 * Each arm boots its own harness (own node-A, own network, own exported bundle): a
 * bundle only makes sense against the node-A that founded it, so a single shared bundle
 * across two independent node-A instances is not possible.
 *
 * Only unconditional facts are asserted (the import succeeded, the arm ran, the
 * measurements were taken, and Arm J converges, as founding-bundle.harness F-1 already
 * shows). Arm F's outcome is LOGGED as `[o02] arm=F run=<n> sha=<head> imported=<bool>
 * openA=<bool> openB=<bool> headerEqual=<bool> aToB=<bool> bToA=<bool> errors=<tokens>`,
 * never asserted. Each arm stops its own harness at ARM_BUDGET_MS (below mocha's timeout), so
 * two arms never run on loopback at once (WR-R2-02).
 *
 * CR-R2-01: the import carries the exporter's fingerprint as its out-of-band anchor. Before
 * that, 62-102's anchor-required refusal made both arms import nothing (vacuous at HEAD); the
 * runs recorded in RESULTS.md were made at 7e90c388, before 62-102, and stand for that SHA. Prediction: 62-gap-repros/o02-peerless-import-founder/RESULTS.md.
 * NO product source is touched; measured runs belong to 62-98.
 */

import { expect } from 'chai'
import { execSync } from 'node:child_process'
import type { Database } from '@quereus/quereus'
import { NetworksEngine } from '../src/networks/networks-engine.js'
import { makeTestUser, makeTestNetworkInit, makeTestSignCallback } from './fixtures/test-context.js'
import {
  startTwoNodeHarness,
  describeP2PHarness,
  pollUntil,
  HARNESS_TIMEOUTS,
  type TwoNodeHarness
} from './harness/two-node-strand.js'
import type { FoundingBundle, LocalStorage } from '@votetorrent/vote-core'

function makeDeviceLocalStorage (): LocalStorage {
  const store = new Map<string, unknown>()
  return {
    async getItem<TValue> (key: string): Promise<TValue | undefined> {
      return store.has(key) ? (store.get(key) as TValue) : undefined
    },
    async setItem<TValue> (key: string, value: TValue): Promise<void> {
      store.set(key, value)
    },
    async removeItem (key: string): Promise<void> {
      store.delete(key)
    },
    async clear (): Promise<void> {
      store.clear()
    }
  }
}

const RUN = process.env.O02_RUN ?? '0'
const ARM_ORDER = (process.env.O02_ARM_ORDER ?? 'JF').toUpperCase() === 'FJ' ? ['F', 'J'] : ['J', 'F']
const SHA = (() => {
  try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim() } catch { return 'unknown' }
})()

const ERROR_TOKENS = ['Missing block', 'cohort-unreachable', 'BlockUnavailable'] as const

interface ArmResult {
  arm: 'J' | 'F'
  ran: boolean
  /** CR-R2-01: the founding import actually succeeded; an arm whose import was refused measured nothing. */
  imported: boolean
  /** WR-R2-02: each strand open is a measured leg, never an arm failure. */
  openA: boolean
  openB: boolean
  headerEqual: boolean
  aToB: boolean
  bToA: boolean
  errors: string[]
}

function tokensIn (error: unknown, into: Set<string>): void {
  const text = `${(error as Error)?.message ?? error}`
  for (const t of ERROR_TOKENS) if (text.includes(t)) into.add(t)
}

/**
 * WR-R2-01: every failed leg also records its own truncated message, so a failure that carries
 * none of ERROR_TOKENS (a pollUntil timeout, a write refusal, a constraint error) is never logged
 * as `errors=none`. The tokens stay as a classification on top. Commas are replaced because the
 * log line joins errors with ','.
 */
function recordLeg (leg: string, error: unknown, into: Set<string>): void {
  tokensIn(error, into)
  const message = String((error as Error)?.message ?? error).slice(0, 160).replace(/\s+/g, ' ').replace(/,/g, ';')
  into.add(`${leg}:${message}`)
}

async function readAll (db: Database, sql: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = []
  for await (const row of db.eval(sql)) rows.push(row as Record<string, unknown>)
  return rows
}

/** Strand bootstrap rows: the singleton Header (open strand; Member/Manager are closed-only). */
async function readBootstrapRows (db: Database): Promise<string> {
  const header = await readAll(db, 'select Id, Type, sAppId, sAppVersion, Engine, EngineVersion from Strand.Header order by Id')
  return JSON.stringify(header)
}

/**
 * WR-R2-02: each arm's own budget, below mocha's per-test timeout (`suiteMs`). When it runs out
 * the arm stops its OWN harness and returns, so mocha never abandons a live pair of nodes on
 * loopback while the next arm boots a second pair. The margin covers `harness.stop()`.
 */
const ARM_BUDGET_MS = Math.max(HARNESS_TIMEOUTS.replicationMs, HARNESS_TIMEOUTS.suiteMs - 2 * HARNESS_TIMEOUTS.meshMs)

async function runArm (arm: 'J' | 'F'): Promise<ArmResult> {
  const startedAt = Date.now()
  const errors = new Set<string>()
  const result: ArmResult = { arm, ran: false, imported: false, openA: false, openB: false, headerEqual: false, aToB: false, bToA: false, errors: [] }
  const peerless = arm === 'F'
  const harness: TwoNodeHarness = await startTwoNodeHarness({
    peerlessNodeB: peerless,
    // J: explicit founder:false (connected joiner); F: explicit founder:true (peerless importer).
    nodeBFounder: peerless
  })
  let overBudget = false

  const measure = async (): Promise<void> => {
    const user = makeTestUser({ id: `o02-${arm}-${harness.runId}` })
    const engineA = new NetworksEngine(makeDeviceLocalStorage(), harness.nodeA.dbFactory)
    await engineA.create(makeTestNetworkInit(), user)
    const ref = (await engineA.getRecentNetworks())[0]
    if (!ref) throw new Error(`o02 arm ${arm}: node-A has no recent network after create()`)
    const exported = await engineA.exportFoundingBundle(ref.hash, {
      userId: user.id,
      signerKey: user.activeKeys[0]!.key,
      sign: makeTestSignCallback(user)
    })
    const bundle: FoundingBundle = exported.bundle
    const hash = bundle.descriptor.networkHash

    if (!peerless) {
      // Control: same settle grace as founding-bundle.harness F-1, and wait for A's Network row.
      await new Promise((resolve) => setTimeout(resolve, 3000))
      await pollUntil(
        async () => (await harness.nodeB.dbFactory(hash)).prepare('select Id from Network').get({}),
        (row) => row?.Id === bundle.descriptor.networkId,
        { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: "o02 J: B sees A's Network row" }
      )
    }

    const engineB = new NetworksEngine(makeDeviceLocalStorage(), harness.nodeB.dbFactory)
    // CR-R2-01: since 62-102 an import with no out-of-band anchor is refused ('anchor-required')
    // before any DbFactory call, so the arm would import nothing and arm F would never open B's
    // strand while peerless. Pass the exporter's fingerprint, as the importing officer types it.
    const imported = await engineB.importFoundingBundle(exported.text, undefined, { expectedFingerprint: exported.fingerprint })
    result.imported = imported.ok
    if (!imported.ok) errors.add(`import:${(imported as { reason: string }).reason}`)

    if (peerless) await harness.connectAndEnrolNodeB()
    if (overBudget) return

    // (0) WR-R2-02: opening each strand is a measured leg. Each open can block for up to
    // addStrandMs + writableMs; a strand that never becomes writable is a plausible O-02 outcome,
    // so it is logged (openA/openB) instead of failing the arm before it reaches its measurements.
    let dbA: Database | undefined
    let dbB: Database | undefined
    try {
      dbA = await harness.nodeA.dbFactory(hash)
      result.openA = true
    } catch (e) { recordLeg('openA', e, errors) }
    if (overBudget) return
    try {
      dbB = await harness.nodeB.dbFactory(hash)
      result.openB = true
    } catch (e) { recordLeg('openB', e, errors) }
    const ns = `o02-${arm}-${harness.runId}`

    if (dbA !== undefined && dbB !== undefined) {
      const a = dbA
      const b = dbB
      // (1) bootstrap rows identical on both nodes (polled: settle may take a while).
      if (overBudget) return
      try {
        await pollUntil(
          async () => [await readBootstrapRows(a), await readBootstrapRows(b)] as const,
          ([ra, rb]) => ra === rb && ra !== '[]',
          { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: `o02 ${arm}: bootstrap rows equal` }
        )
        result.headerEqual = true
      } catch (e) { recordLeg('headerEqual', e, errors) }

      // (2) A writes after the import; does B read it?
      if (overBudget) return
      try {
        await a.exec('insert into TidHighWater (Namespace, HighWater) values (:ns, :hw)', { ns: `${ns}-a`, hw: 1 } as any)
        await pollUntil(
          async () => b.prepare('select HighWater from TidHighWater where Namespace = :ns').get({ ns: `${ns}-a` } as any),
          (row) => row?.HighWater === 1,
          { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: `o02 ${arm}: A->B` }
        )
        result.aToB = true
      } catch (e) { recordLeg('aToB', e, errors) }

      // (3) B writes; does A read it?
      if (overBudget) return
      try {
        await b.exec('insert into TidHighWater (Namespace, HighWater) values (:ns, :hw)', { ns: `${ns}-b`, hw: 2 } as any)
        await pollUntil(
          async () => a.prepare('select HighWater from TidHighWater where Namespace = :ns').get({ ns: `${ns}-b` } as any),
          (row) => row?.HighWater === 2,
          { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: `o02 ${arm}: B->A` }
        )
        result.bToA = true
      } catch (e) { recordLeg('bToA', e, errors) }
    }

    if (!overBudget) result.ran = true
  }

  let budgetTimer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise<'over-budget'>((resolve) => {
    budgetTimer = setTimeout(() => resolve('over-budget'), Math.max(0, ARM_BUDGET_MS - (Date.now() - startedAt)))
  })
  // The measurement keeps running in the background after a budget stop (its in-flight poll ends
  // on its own timeout against stopped nodes); it starts no new leg and never sets `ran`.
  const measured = measure().then(
    () => 'done' as const,
    (e: unknown) => { recordLeg('arm-error', e, errors); return 'done' as const }
  )
  try {
    if ((await Promise.race([measured, budget])) === 'over-budget') {
      overBudget = true
      errors.add(`budget:arm exceeded ${ARM_BUDGET_MS}ms; harness stopped by the arm`)
    }
  } finally {
    if (budgetTimer !== undefined) clearTimeout(budgetTimer)
    await harness.stop()
  }
  result.errors = [...errors]
  // (4) one log line per arm (shape is what 62-98 parses).
  console.log(
    `[o02] arm=${arm} run=${RUN} sha=${SHA} imported=${result.imported} openA=${result.openA} openB=${result.openB} headerEqual=${result.headerEqual} aToB=${result.aToB} bToA=${result.bToA} errors=${result.errors.join(',') || 'none'}`
  )
  return { ...result }
}

describeP2PHarness('O-02: peerless founder:true import vs connected joiner (62-93 instrument)', function () {
  this.timeout(HARNESS_TIMEOUTS.suiteMs)

  const results = new Map<'J' | 'F', ArmResult>()

  for (const arm of ARM_ORDER as ('J' | 'F')[]) {
    it(`arm ${arm}: imported, ran and measured (${arm === 'J' ? 'control, asserts convergence' : 'O-02, outcome logged only'})`, async function () {
      this.timeout(HARNESS_TIMEOUTS.suiteMs)
      const r = await runArm(arm)
      results.set(arm, r)
      // Unconditional: the arm reached its measurements within its budget. Arm F's OUTCOME
      // (openB, headerEqual, aToB, bToA) is never asserted.
      expect(r.ran, `arm ${arm} must reach its measurements (errors=${r.errors.join(',')})`).to.equal(true)
      // CR-R2-01: both arms must actually have imported, or the arm measured nothing.
      expect(r.imported, `arm ${arm} import must succeed (errors=${r.errors.join(',')})`).to.equal(true)
      if (arm === 'J') {
        expect(r.openB, 'control: B opened the strand').to.equal(true)
        expect(r.headerEqual, 'control: bootstrap rows equal').to.equal(true)
        expect(r.aToB, 'control: A->B').to.equal(true)
        expect(r.bToA, 'control: B->A').to.equal(true)
      }
    })
  }
})
