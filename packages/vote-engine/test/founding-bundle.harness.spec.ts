/**
 * founding-bundle.harness.spec.ts — 62-16 Task 3 (D-23, D-35, D-39).
 *
 * Opt-in (`RUN_P2P_HARNESS=1`) two-node evidence that device B joins device
 * A's strand (strandId = networkHash) and holds device A's own founding
 * rows, digest-equal, carrying A's key — the D-23 done bar for this
 * workflow on the 62-06 harness. With the flag unset this entire suite is
 * `describe.skip` (pending): the default suite never loads libp2p.
 *
 * NOT exercised here: the genesis-row REPLAY on a real strand backend (B is
 * a joiner on this harness — A's rows arrive by sync first, so B's import
 * always classifies `already-present`). The replay path is proven on two
 * in-memory devices in `founding-bundle.spec.ts` (Task 2, I-1..I-3). Device
 * handoff over the real share sheet, strand import on two PHYSICAL Authority
 * devices, and no-peer fork convergence remain proof debt against P2P-11
 * (recorded in the SUMMARY's "Proof debt" section for 62-30).
 */

import { expect } from 'chai'
import type { Database } from '@quereus/quereus'
import { NetworksEngine } from '../src/networks/networks-engine.js'
import { readGenesisRows } from '../src/networks/genesis-rows.js'
import { computeContentDigest } from '../src/bootstrap/snapshot-manifest.js'
import { serializeFoundingBundle } from '../src/networks/founding-bundle.js'
import { makeTestUser, makeTestNetworkInit, makeTestSignCallback } from './fixtures/test-context.js'
import {
  startTwoNodeHarness,
  describeP2PHarness,
  pollUntil,
  HARNESS_TIMEOUTS,
  type TwoNodeHarness
} from './harness/two-node-strand.js'
import type { FoundingBundle, LocalStorage, User } from '@votetorrent/vote-core'
import type { DbFactory } from '../src/types.js'

// ---------------------------------------------------------------------------
// Per-device helpers — copied from founding-bundle.spec.ts (Task 2), not
// imported: the module-level AsyncStorage shim is shared, so each device
// under test must get its own LocalStorage, and the DbFactory recorder must
// wrap the harness's OWN dbFactory rather than the default in-memory one.
// ---------------------------------------------------------------------------

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

function makeRecordedFactory (base: DbFactory): { factory: DbFactory; calls: string[] } {
  const calls: string[] = []
  const factory: DbFactory = async (hash: string) => {
    calls.push(hash)
    return base(hash)
  }
  return { factory, calls }
}

describeP2PHarness('founding bundle across two nodes (D-23, D-35, D-39)', function () {
  this.timeout(HARNESS_TIMEOUTS.suiteMs)

  let harness: TwoNodeHarness
  let userA: User
  let bundle: FoundingBundle
  let bundleText: string

  before(async function () {
    this.timeout(HARNESS_TIMEOUTS.suiteMs)
    harness = await startTwoNodeHarness()
    userA = makeTestUser({ id: `founder-a-${harness.runId}` })

    const engineA = new NetworksEngine(makeDeviceLocalStorage(), harness.nodeA.dbFactory)
    await engineA.create(makeTestNetworkInit(), userA)
    const recents = await engineA.getRecentNetworks()
    const ref = recents[0]
    if (!ref) throw new Error('founding-bundle.harness: device A has no recent network after create()')

    const exporter = {
      userId: userA.id,
      signerKey: userA.activeKeys[0]!.key,
      sign: makeTestSignCallback(userA)
    }
    const exported = await engineA.exportFoundingBundle(ref.hash, exporter)
    bundle = exported.bundle
    bundleText = exported.text
  })

  after(async function () {
    this.timeout(HARNESS_TIMEOUTS.startMs)
    await harness?.stop()
  })

  let joinedNetwork: Awaited<ReturnType<NetworksEngine['importFoundingBundle']>> | undefined
  let engineB: NetworksEngine

  it('F-1, join (D-23, D-35, D-39): device B sees the replicated Network row, then imports — ok, already-present, strandId = networkHash, digest-equal, carrying A\'s key', async function () {
    this.timeout(HARNESS_TIMEOUTS.addStrandMs + HARNESS_TIMEOUTS.writableMs + HARNESS_TIMEOUTS.replicationMs)
    const hash = bundle.descriptor.networkHash

    // 62-06-SUMMARY's own "Issues Encountered" documents a transient, upstream
    // "Missing block" error inside cadre-core's composeStrand/applyAppSchema
    // when a strand's distributed catalog has not fully settled yet — a
    // stack-internal race, not vote-engine or harness code (debug session
    // founding-bundle-harness-f1, 2026-10-01, reconfirmed this directly: the
    // SAME error, at the SAME internal composeStrand call sites, reproduces on
    // 62-06's own unmodified two-node-strand.harness.spec.ts self-test whenever
    // a CPU-heavy sibling process shares the host — it is not specific to this
    // spec's sequencing). Give the control mesh a short settle grace (mirrors
    // the harness's own post-mesh 3000ms grace in attemptBringUp) before the
    // FIRST attempt.
    await new Promise((resolve) => setTimeout(resolve, 3000))

    // Poll on the raw dbFactory handle (not openStrand): 62-06-SUMMARY records
    // double registerDbPlugins as safe (doubleRegisterSafe=true), and the
    // engine's own createContext registers plugins itself — no plain SELECT
    // here needs a UDF. pollUntil now genuinely retries a thrown addStrand
    // failure (two-node-strand.ts fix, same debug session) instead of
    // propagating the first exception, so a transient block-fetch race gets
    // up to HARNESS_TIMEOUTS.replicationMs to heal before this test gives up.
    await pollUntil(
      async () => {
        const db: Database = await harness.nodeB.dbFactory(hash)
        return db.prepare('select Id, Hash from Network').get({})
      },
      (row) => row?.Id === bundle.descriptor.networkId,
      { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: "B sees A's Network row" }
    )

    const { factory, calls } = makeRecordedFactory(harness.nodeB.dbFactory)
    engineB = new NetworksEngine(makeDeviceLocalStorage(), factory)
    const result = await engineB.importFoundingBundle(bundleText, undefined, { expectedDigest: bundle.digest })
    joinedNetwork = result

    expect(result.ok, `F-1 import must succeed: ${result.ok ? '' : (result as { detail?: string; reason: string }).detail ?? (result as { reason: string }).reason}`).to.equal(true)
    if (!result.ok) throw new Error('unreachable')
    // B is a JOINER here: A's rows already arrived by strand sync before B's
    // import runs, so the classification is already-present, not replayed —
    // the genesis-row REPLAY path is proven on two in-memory devices instead
    // (founding-bundle.spec.ts I-1..I-3).
    expect(result.outcome).to.equal('already-present')
    expect(calls).to.deep.equal([hash])

    const ctxB = engineB.getEstablishedContext(hash)
    if (!ctxB) throw new Error('F-1: device B context not established')
    const genesisKeys = {
      userId: String(bundle.rows.User[0]!.Id),
      signerKey: String(bundle.rows.UserKey[0]!.PubKey),
      authorityId: String(bundle.rows.Authority[0]!.Id),
      adminEffectiveAt: String(bundle.rows.Admin[0]!.EffectiveAt)
    }
    const rowsB = await readGenesisRows(ctxB.db, genesisKeys)
    expect(computeContentDigest(rowsB as unknown as Parameters<typeof computeContentDigest>[0])).to.equal(bundle.digest)

    const networkRowA = await (await harness.nodeA.dbFactory(hash)).prepare('select Id, Hash from Network').get({})
    const networkRowB = await ctxB.db.prepare('select Id, Hash from Network').get({})
    expect(networkRowB?.Id).to.equal(networkRowA?.Id)
    expect(networkRowB?.Hash).to.equal(networkRowA?.Hash)

    // Other-peer-identity proof: B's founding UserKey is A's key, a private
    // half B never held — a node reading its OWN row could never pass this.
    expect(rowsB.UserKey[0]!.PubKey).to.equal(userA.activeKeys[0]!.key)
  })

  it('F-2, usable: result.network.getDetails() on B returns the bundle\'s networkId and primaryAuthorityId', async function () {
    this.timeout(HARNESS_TIMEOUTS.startMs)
    if (!joinedNetwork?.ok) throw new Error('F-2 depends on F-1 having joined')
    const details = await joinedNetwork.network.getDetails()
    expect(details.network.id).to.equal(bundle.descriptor.networkId)
    expect(details.network.primaryAuthorityId).to.equal(bundle.descriptor.primaryAuthorityId)
  })

  it('F-3, tamper on the real stack: a digest-mismatch bundle on a fresh device-B engine opens no strand', async function () {
    this.timeout(HARNESS_TIMEOUTS.addStrandMs + HARNESS_TIMEOUTS.writableMs)
    const tampered: FoundingBundle = { ...bundle, digest: 'not-the-real-digest' }
    const text = serializeFoundingBundle(tampered)

    const { factory, calls } = makeRecordedFactory(harness.nodeB.dbFactory)
    const freshEngineB = new NetworksEngine(makeDeviceLocalStorage(), factory)
    const result = await freshEngineB.importFoundingBundle(text, undefined, { expectedDigest: bundle.digest })

    expect(result.ok).to.equal(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).to.equal('digest-mismatch')
    expect(calls, 'no strand/DbFactory call for an invalid file').to.deep.equal([])
  })

  it('F-4, idempotent: importing again on the F-1 engine returns already-joined', async function () {
    this.timeout(HARNESS_TIMEOUTS.startMs)
    const result = await engineB.importFoundingBundle(bundleText, undefined, { expectedDigest: bundle.digest })
    expect(result.ok).to.equal(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).to.equal('already-joined')
  })
})
