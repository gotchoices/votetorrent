/**
 * two-node-strand.harness.spec.ts — D-24 two-node strand harness self-test.
 *
 * Opt-in through RUN_P2P_HARNESS=1 (`yarn workspace @votetorrent/vote-engine
 * test:p2p-harness`). With the flag unset this entire suite is `describe.skip`
 * (pending), so the default suite never loads libp2p or cadre-core.
 *
 * Boots a real founder drone (node-A) and a real peer (node-B) on the patched
 * sereus/optimystic stack, opens a shared strand running the real votetorrent
 * schema and UDFs, and proves D-23's writer-identity requirement: a row
 * node-A wrote is readable on node-B while node-B performed zero writes.
 *
 * Also answers the probe questions 62-15/62-16/62-21/62-22/62-24 consume:
 * does cadre-core register SignatureValid itself, is double-registration safe,
 * does plain :param SQL bind correctly on a strand database, and what happens
 * on a second addStrand call for the same strandId.
 */

import { expect } from 'chai'
import * as os from 'node:os'
import { sign as pluginSign } from '@optimystic/quereus-plugin-crypto'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { NetworksEngine } from '../src/networks/networks-engine.js'
import { registerDbPlugins } from '../src/database/initialize.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { AsyncStorage } from './shims/react-native.js'
import type { NetworkInit, User, Scope } from '@votetorrent/vote-core'
import { ElectionType, UserKeyType } from '@votetorrent/vote-core'
import {
  startTwoNodeHarness,
  describeP2PHarness,
  pollUntil,
  HARNESS_TIMEOUTS,
  VOTETORRENT_INNER_DDL,
  type TwoNodeHarness
} from './harness/two-node-strand.js'
import { VOTETORRENT_SCHEMA_SQL } from '../src/database/schema-sql.js'

/** Mirrors networks.spec.ts's makeNetworkInit — copied, not imported (62-06-PLAN.md Part B). */
function makeNetworkInit (pubKeyHex: string): NetworkInit {
  return {
    name: 'P2P-harness Network',
    imageUrl: 'https://cdn.example.com/logo.png',
    relays: ['/dns4/relay.example.com/tcp/443/wss'],
    primaryAuthority: {
      name: 'Primary Authority',
      domainName: 'authority.example.com'
    },
    admin: {
      officers: [
        {
          init: {
            name: 'Admin A',
            title: 'Chair',
            scopes: ['rn', 'mel'] as Scope[]
          }
        }
      ],
      effectiveAt: Date.now(),
      thresholdPolicies: [{ policy: 'rn', threshold: 1 }]
    },
    policies: {
      timestampAuthorities: [{ url: 'https://tsa.example.com' }],
      numberRequiredTSAs: 1,
      electionType: ElectionType.adhoc
    }
  }
}

/** Mirrors networks.spec.ts's makeUser — copied, not imported. */
function makeUser (pubKeyHex: string): User {
  return {
    id: 'p2p-harness-user-1',
    name: 'P2P Harness User',
    imageRef: { url: 'https://img.local/user.png' },
    activeKeys: [
      {
        key: pubKeyHex,
        type: UserKeyType.mobile,
        expiration: Date.now() + 60_000
      }
    ]
  }
}

describeP2PHarness('D-24 two-node strand harness', function () {
  this.timeout(HARNESS_TIMEOUTS.suiteMs)

  let harness: TwoNodeHarness

  before(async function () {
    this.timeout(HARNESS_TIMEOUTS.suiteMs)
    harness = await startTwoNodeHarness()
  })

  after(async function () {
    this.timeout(HARNESS_TIMEOUTS.startMs)
    await harness?.stop()
  })

  it('H-01 boots and enrols', function () {
    this.timeout(HARNESS_TIMEOUTS.startMs)
    expect(harness.nodeA.peerId).to.be.a('string').and.have.length.greaterThan(0)
    expect(harness.nodeB.peerId).to.be.a('string').and.have.length.greaterThan(0)
    expect(harness.nodeA.peerId).to.not.equal(harness.nodeB.peerId)
    expect(VOTETORRENT_INNER_DDL).to.not.match(/^\s*declare\s+schema/)
    expect(VOTETORRENT_INNER_DDL.length).to.be.lessThan(VOTETORRENT_SCHEMA_SQL.length)
  })

  it('H-02 shared strand with the real schema', async function () {
    this.timeout(HARNESS_TIMEOUTS.addStrandMs + HARNESS_TIMEOUTS.writableMs)
    const { dbA, dbB } = await harness.openSharedStrand()

    // Use prepare().get() (a single bounded statement execution), not a partially-drained
    // db.eval() async generator — an un-exhausted eval() iterator can hold the database's
    // read machinery open and stall every later query on the same handle.
    const rowA = (await dbA.prepare('select count(*) as n from Network').get()) as { n: number } | undefined
    expect(rowA?.n).to.equal(0)
    const rowB = (await dbB.prepare('select count(*) as n from Network').get()) as { n: number } | undefined
    expect(rowB?.n).to.equal(0)

    expect(dbA.declaredSchemaManager.hasDeclaredSchema('App')).to.equal(true)
    expect(dbB.declaredSchemaManager.hasDeclaredSchema('App')).to.equal(true)
  })

  it('P-UDF probe (A3)', async function () {
    this.timeout(HARNESS_TIMEOUTS.addStrandMs + HARNESS_TIMEOUTS.writableMs)

    // Before any registerDbPlugins, on a fresh strand, record (never assert) whether
    // SignatureValid is already callable.
    const udfStrandId = `vt-harness-udf-${harness.runId}`
    const dbRaw = await harness.nodeA.dbFactory(udfStrandId)
    let udfBeforeRegister: 'threw' | 'ok' = 'ok'
    let udfBeforeRegisterMessage = ''
    try {
      await dbRaw.prepare('select SignatureValid(:d, :s, :k) as v').get({ d: 'x', s: 'y', k: 'z' })
    } catch (error) {
      udfBeforeRegister = 'threw'
      udfBeforeRegisterMessage = (error as Error)?.message ?? String(error)
    }
    console.log(`P2P_HARNESS_PROBE udfBeforeRegister=${udfBeforeRegister} ${udfBeforeRegisterMessage}`)

    const { portA, portB, dbA } = await harness.openSharedStrand()

    const { privateHex, publicHex } = randomTestKeyPair()
    const digestRowsA = await portA.query<{ d: string }>('select Digest(:a0) as d', { a0: 'p2p-harness-udf' })
    const digest = digestRowsA[0]?.d
    expect(digest, 'Digest must return a value on the strand db').to.be.a('string').and.have.length.greaterThan(0)

    const signatureHex = pluginSign(digest!, privateHex, 'secp256k1', 'base64url', 'hex', 'hex')
    const validRowsA = await portA.query<{ v: unknown }>('select SignatureValid(:d, :s, :k) as v', { d: digest!, s: signatureHex, k: publicHex })
    expect(validRowsA[0]?.v, 'valid triple must verify true on node-A').to.equal(true)
    const validRowsB = await portB.query<{ v: unknown }>('select SignatureValid(:d, :s, :k) as v', { d: digest!, s: signatureHex, k: publicHex })
    expect(validRowsB[0]?.v, 'valid triple must verify true on node-B').to.equal(true)

    const tamperedHex = signatureHex.slice(0, -1) + (signatureHex.slice(-1) === '0' ? '1' : '0')
    const tamperedRowsA = await portA.query<{ v: unknown }>('select SignatureValid(:d, :s, :k) as v', { d: digest!, s: tamperedHex, k: publicHex })
    expect(tamperedRowsA[0]?.v, 'tampered signature must verify false').to.equal(false)

    let doubleRegister: 'ok' | 'threw' = 'ok'
    try {
      await registerDbPlugins(dbA)
      const revalidated = await portA.query<{ v: unknown }>('select SignatureValid(:d, :s, :k) as v', { d: digest!, s: signatureHex, k: publicHex })
      expect(revalidated[0]?.v, 'valid triple must still verify true after a second registerDbPlugins').to.equal(true)
    } catch (error) {
      doubleRegister = 'threw'
    }
    console.log(`P2P_HARNESS_PROBE doubleRegister=${doubleRegister}`)
    expect(secp256k1, 'noble/curves import is live').to.not.equal(undefined)
  })

  it('P-PARAM probe (A2)', async function () {
    this.timeout(HARNESS_TIMEOUTS.addStrandMs + HARNESS_TIMEOUTS.writableMs)
    const { portA } = await harness.openSharedStrand()

    const paramRows = await portA.query<{ A: string; B: string }>('select :a as A, :b as B', { a: 'x', b: 'y' })
    expect(paramRows).to.deep.equal([{ A: 'x', B: 'y' }])
    console.log('P2P_HARNESS_PROBE paramExecBinding=ok')

    const ns = `harness-probe:${harness.runId}:${harness.nodeA.peerId}`
    await portA.mutate('insert into TidHighWater (Namespace, HighWater) values (:ns, :hw)', { ns, hw: 41 })

    const readBack = await portA.query<{ HighWater: number }>('select HighWater from TidHighWater where Namespace = :ns', { ns })
    expect(readBack[0]?.HighWater).to.equal(41)
  })

  it('R-1 foreign row reaches node-B (D-23 writer identity)', async function () {
    this.timeout(HARNESS_TIMEOUTS.addStrandMs + HARNESS_TIMEOUTS.writableMs + HARNESS_TIMEOUTS.replicationMs)
    const { portA, portB } = await harness.openSharedStrand()
    const ns = `harness-probe:${harness.runId}:${harness.nodeA.peerId}`

    // The row was already written by P-PARAM on node-A (same shared strand).
    // Guarantee it exists even if P-PARAM is skipped/reordered.
    await portA.mutate(
      'insert into TidHighWater (Namespace, HighWater) values (:ns, :hw) on conflict (Namespace) do update set HighWater = :hw',
      { ns, hw: 41 }
    )

    expect(harness.nodeB.stats.mutateCount, 'precondition: node-B has written nothing yet').to.equal(0)

    const rows = await pollUntil(
      async () => portB.query<{ Namespace: string; HighWater: number }>(
        'select Namespace, HighWater from TidHighWater where Namespace = :ns', { ns }
      ),
      (v) => v.length === 1,
      { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: 'R-1 replication of foreign TidHighWater row' }
    )

    expect(rows).to.have.lengthOf(1)
    expect(rows[0]?.Namespace.endsWith(harness.nodeA.peerId)).to.equal(true)
    expect(rows[0]?.HighWater).to.equal(41)
    expect(harness.nodeB.stats.mutateCount, 'node-B must still have written nothing').to.equal(0)
  })

  it('R-2 NetworksEngine founding rows replicate (D-23 on the real signed schema)', async function () {
    this.timeout(HARNESS_TIMEOUTS.addStrandMs + HARNESS_TIMEOUTS.writableMs + HARNESS_TIMEOUTS.replicationMs)

    await AsyncStorage.setItem('recentNetworks', [])
    const { publicHex } = randomTestKeyPair()
    const engine = new NetworksEngine(AsyncStorage, harness.nodeA.dbFactory)
    const user = makeUser(publicHex)
    await engine.create(makeNetworkInit(publicHex), user)

    const recents = (await AsyncStorage.getItem<Array<{ hash: string }>>('recentNetworks')) ?? []
    const hash = recents[0]?.hash
    expect(hash, 'NetworksEngine.create must record a recentNetworks hash').to.be.a('string').and.have.length.greaterThan(0)

    const mutateCountBefore = harness.nodeB.stats.mutateCount

    const dbB = await harness.nodeB.openStrand(hash!)
    await pollUntil(
      async () => {
        const rows: Array<{ Hash: string }> = []
        for await (const row of dbB.eval('select Hash from Network')) rows.push(row as { Hash: string })
        return rows
      },
      (rows) => rows.some((r) => r.Hash === hash),
      { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: 'R-2 Network row replication' }
    )

    const userRows: Array<{ Id: string }> = []
    for await (const row of dbB.eval('select Id from User where Id = :userId', { userId: user.id })) {
      userRows.push(row as { Id: string })
    }
    expect(userRows, 'founding User row must replicate to node-B').to.have.lengthOf(1)

    expect(harness.nodeB.stats.mutateCount, 'node-B ran no NetworksEngine mutate in this leg').to.equal(mutateCountBefore)
  })

  it('P-ADDSTRAND probe (open question 3)', async function () {
    this.timeout(HARNESS_TIMEOUTS.addStrandMs + HARNESS_TIMEOUTS.writableMs)
    const { strandId, portA } = await harness.openSharedStrand()

    let addStrandTwice = 'new-instance'
    try {
      const first = harness.nodeA.node.getStrand(strandId)
      const second = await harness.nodeA.node.addStrand({
        strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null, FounderPeerId: null },
        sAppConfig: { id: 'org.votetorrent', version: '1.0.0', schema: VOTETORRENT_INNER_DDL, latencyHint: 'interactive' },
        founder: true,
        awaitFirstSync: false
      })
      addStrandTwice = second === first ? 'same-instance' : 'new-instance'
    } catch (error) {
      addStrandTwice = `threw:${(error as Error)?.name ?? 'Error'}`
    }
    console.log(`P2P_HARNESS_PROBE addStrandTwice=${addStrandTwice}`)

    const ns = `harness-probe:${harness.runId}:${harness.nodeA.peerId}`
    const stillThere = await portA.query<{ HighWater: number }>('select HighWater from TidHighWater where Namespace = :ns', { ns })
    expect(stillThere[0]?.HighWater, 'the second addStrand call must not wipe the strand db').to.equal(41)
  })

  it('T-01 timing line', function () {
    this.timeout(HARNESS_TIMEOUTS.startMs)
    console.log('P2P_HARNESS_TIMING ' + JSON.stringify({ runId: harness.runId, ...harness.timings, loadavg: os.loadavg()[0] }))
    expect(harness.timings.startAMs).to.be.greaterThan(0)
  })
})
