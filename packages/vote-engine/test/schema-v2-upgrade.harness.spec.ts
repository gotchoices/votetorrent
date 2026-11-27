/**
 * schema-v2-upgrade.harness.spec.ts — an EXISTING network strand, founded on App schema version 1,
 * takes schema version 2 (the co-signing change to AuthorityIntakePolicy, Task.ExtensionExists, the
 * SignatureType view and the new AssociationSignatureTaskExtension table).
 *
 * Opt-in (`RUN_P2P_HARNESS=1`), two members of one party on the real strand stack, as the apps run a
 * network. Version 1 is the schema snapshot `fixtures/schema-snapshots/votetorrent-schema-v1.qsql`
 * (votetorrent.qsql as of ee684220, the last schema version 1); version 2 is the shipped schema.
 *
 * What it measures, in order (each leg depends on the one before it):
 *   1  node-A, holding a version-1 policy row written by the version-1 code path, re-opens on version 2:
 *      the strand opens, the apply is recorded, the new columns read, and the old row is unchanged;
 *   2  node-A writes a version-2 proposal row and an 'intake-policy' Task: the new CHECKs accept them
 *      and still refuse a proposal with no signed session;
 *   3  node-B, still RUNNING version 1, has its strand stopped once node-A records version 2 (measured
 *      2026-11-23: a running version-1 member is shut out, it does not keep reading or writing);
 *   4  node-B restarting on version 1 is refused with AppSchemaOutdatedError (the app must update);
 *   5  node-B upgrading to version 2 opens and holds both rows;
 *   6  the effective revision node-A then writes reaches node-B, and node-B's reader moves to it.
 *
 * Negative control: `UPGRADE_CONTROL=1` re-opens node-A on version 1 instead, and leg 1 must FAIL
 * (Strand.AppSchemaVersion stays 1, node-B's strand keeps running), so the legs can tell the cases apart.
 */

import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import type { Database } from '@quereus/quereus'
import type { Scope } from '@votetorrent/vote-core'
import { IntakeEngine } from '../src/intake/intake-engine.js'
import { readIntakePolicyFrom } from '../src/intake/policy.js'
import { intakeQueryPortFromDb } from '../src/intake/query-port.js'
import { seedSignedMutation } from '../src/signing/signed-mutation.js'
import { allocateTid } from '../src/database/tid-allocator.js'
import { VOTETORRENT_SCHEMA_VERSION } from '../src/database/schema-version.js'
import { createThresholdAuthority, type ThresholdAuthorityFixture } from './fixtures/threshold-authority.js'
import {
  startTwoNodeHarness,
  describeP2PHarness,
  pollUntil,
  HARNESS_TIMEOUTS,
  type TwoNodeHarness
} from './harness/two-node-strand.js'

const V1_QSQL = readFileSync(new URL('./fixtures/schema-snapshots/votetorrent-schema-v1.qsql', import.meta.url), 'utf8')
const V1_INNER_DDL = V1_QSQL
  .replace(/^\s*declare\s+schema\s+\w+\s*\{/, '')
  .replace(/\}\s*apply\s+schema\s+\w+\s*;\s*$/, '')
  .trim()
const V1 = { schema: V1_INNER_DDL, schemaVersion: 1 }

async function rows (db: Database, sql: string, params: Record<string, unknown> = {}): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const r of db.eval(sql, params as any)) out.push({ ...r })
  return out
}

function errorChain (err: unknown): string[] {
  const names: string[] = []
  for (let e: any = err; e != null && names.length < 8; e = e.cause) names.push(`${e.name ?? 'Error'}: ${String(e.message ?? e).split('\n')[0]}`)
  return names
}

describeP2PHarness('an existing network strand takes App schema version 2 (co-signing)', function () {
  this.timeout(HARNESS_TIMEOUTS.suiteMs * 2)

  let harness: TwoNodeHarness
  let fx: ThresholdAuthorityFixture
  let hash: string
  let dbA: Database
  let dbB1: Database
  let proposalNonce: string
  let proposalTid: number
  const strandErrors: Array<{ who: string, error: string[] }> = []
  const strandEvents: string[] = []
  const t0 = Date.now()
  const stateOf = (n: any): string => `${n.getStrand(hash)?.status ?? 'none'}/${n.getStrand(hash)?.database?.appSchemaState?.() ?? '-'}`

  before(async function () {
    this.timeout(HARNESS_TIMEOUTS.suiteMs)
    expect(VOTETORRENT_SCHEMA_VERSION, 'the shipped schema is version 2').to.equal(2)
    expect(V1_INNER_DDL).to.not.include('SigningTid')
    harness = await startTwoNodeHarness()
    harness.nodeA.setAppSchema!(V1)
    harness.nodeB.setAppSchema!(V1)
    for (const [who, n] of [['A', harness.nodeA.node], ['B', harness.nodeB.node]] as const) {
      n.on('strand:error', (e: any) => { strandErrors.push({ who, error: errorChain(e?.error) }) })
      for (const ev of ['strand:started', 'strand:stopped', 'strand:app-schema-deferred', 'strand:app-schema-applied']) {
        n.on(ev, (e: any) => { strandEvents.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${who} ${ev}${e?.waitingFor ? ` waitingFor=${JSON.stringify(e.waitingFor)}` : ''}`) })
      }
    }

    // A network founded on version 1, a 'vrg' threshold of 1, and one policy row written by the
    // version-1 code path (the effective-row insert is the same statement in both versions).
    fx = await createThresholdAuthority({
      dbFactory: harness.nodeA.dbFactory,
      holderCount: 2,
      thresholdPolicies: [{ policy: 'rad' as Scope, threshold: 1 }, { policy: 'vrg' as Scope, threshold: 1 }] as any
    })
    hash = (fx.elec as any).ref.hash
    const engine = new IntakeEngine({ db: fx.elec.ctx.db, user: fx.holders[0]!.user })
    const written = await engine.setIntakePolicy({ authorityId: fx.authorityId, restBridgeUrl: 'https://bridge.example' }, fx.holders[0]!.sign)
    expect(written.revision).to.equal(1)

    dbB1 = await harness.nodeB.openStrand(hash)
    await pollUntil(
      async () => (await readIntakePolicyFrom(intakeQueryPortFromDb(dbB1), fx.authorityId)).revision,
      (r) => r === 1,
      { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: 'the version-1 policy row reaches node-B' }
    )
  })

  after(async function () {
    this.timeout(HARNESS_TIMEOUTS.suiteMs)
    console.log('[schema-v2-upgrade] strand:error events', JSON.stringify(strandErrors))
    console.log('[schema-v2-upgrade] strand events\n' + strandEvents.join('\n'))
    await harness?.stop()
  })

  it('1 node-A re-opens on version 2: opens, records version 2, and the version-1 row is unchanged', async () => {
    harness.nodeA.setAppSchema!(process.env.UPGRADE_CONTROL === "1" ? V1 : undefined)
    dbA = await harness.nodeA.reopenStrand!(hash)
    console.log(`[schema-v2-upgrade] leg 1 right after reopen: A ${stateOf(harness.nodeA.node)} B ${stateOf(harness.nodeB.node)}`)
    const state = await pollUntil(
      async () => harness.nodeA.node.getStrand(hash)?.database?.appSchemaState?.(),
      (s) => s === 'applied',
      { timeoutMs: 120_000, label: 'node-A app schema applied' }
    )
    console.log(`[schema-v2-upgrade] leg 1 applied after ${((Date.now() - t0) / 1000).toFixed(1)}s: A ${stateOf(harness.nodeA.node)} B ${stateOf(harness.nodeB.node)}`)
    expect(state, 'node-A app schema state').to.equal('applied')
    const version = await rows(dbA, 'select Version from Strand.AppSchemaVersion')
    expect(Number(version[0]?.Version)).to.equal(2)
    const policy = await rows(dbA, 'select Revision, RestBridgeUrl, SigningNonce, SigningTid from AuthorityIntakePolicy where AuthorityId = :a', { a: fx.authorityId })
    expect(policy).to.have.length(1)
    expect(Number(policy[0]!.Revision)).to.equal(1)
    expect(policy[0]!.RestBridgeUrl).to.equal('https://bridge.example')
    expect(policy[0]!.SigningNonce).to.equal(null)
    expect(policy[0]!.SigningTid).to.equal(null)
    expect(await rows(dbA, 'select TaskId from AssociationSignatureTaskExtension')).to.have.length(0)
  })

  it('2 node-A writes a proposal row and an intake-policy Task; a proposal with no signed session is refused', async () => {
    const ctx = { db: dbA, user: fx.holders[0]!.user }
    proposalTid = await allocateTid(dbA, 'registration-request')
    const setAt = new Date().toISOString()
    const digestExpr = "select Digest(:tid, 'AuthorityIntakePolicy', :rowAuthorityId, :revision, :restBridgeUrl, :reassociationMode, :setAt) as d"
    const digestParams = { tid: proposalTid, rowAuthorityId: fx.authorityId, revision: 2, restBridgeUrl: 'https://bridge2.example', reassociationMode: 'automatic', setAt }
    proposalNonce = await seedSignedMutation(ctx as any, fx.authorityId, 'vrg' as Scope, proposalTid, digestExpr, digestParams, fx.holders[0]!.sign)
    await dbA.exec('BEGIN')
    await dbA.exec(
      `insert into AuthorityIntakePolicy (AuthorityId, Revision, RestBridgeUrl, ReassociationMode, SetAt, SigningNonce, SigningTid)
       with context SigningNonce = null, Tid = null
       values (:a, -2, 'https://bridge2.example', 'automatic', :setAt, :nonce, :tid)`,
      { a: fx.authorityId, setAt, nonce: proposalNonce, tid: proposalTid } as any
    )
    await dbA.exec(
      `insert into Task (Id, UserId, Type, SignatureType, SigningNonce, IsCompleted)
       with context IsMutationValid = true, Tid = :tid
       values (:id, :userId, 'signature', 'intake-policy', :nonce, 0)`,
      { id: crypto.randomUUID(), userId: fx.holders[1]!.user.id, nonce: proposalNonce, tid: proposalTid } as any
    )
    await dbA.exec('COMMIT')

    let refused: unknown
    try {
      await dbA.exec(
        `insert into AuthorityIntakePolicy (AuthorityId, Revision, RestBridgeUrl, ReassociationMode, SetAt, SigningNonce, SigningTid)
         with context SigningNonce = null, Tid = null
         values (:a, -3, null, 'manual', :setAt, 'no-such-session', 1)`,
        { a: fx.authorityId, setAt } as any
      )
    } catch (err) {
      refused = err
    }
    expect(refused, 'a proposal with no signed session').to.be.instanceOf(Error)
    expect((await readIntakePolicyFrom(intakeQueryPortFromDb(dbA), fx.authorityId)).revision).to.equal(1)
  })

  it('3 node-B, still running version 1, has its strand stopped once node-A records version 2', async () => {
    const bStoppedAfterUpgrade = strandEvents.some((line) => / B strand:stopped$/.test(line))
    const bStatus = harness.nodeB.node.getStrand(hash)?.status ?? 'none'
    console.log(`[schema-v2-upgrade] leg 3: B ${stateOf(harness.nodeB.node)}; B strand:stopped seen ${bStoppedAfterUpgrade}`)
    expect(bStoppedAfterUpgrade, 'node-B strand:stopped').to.equal(true)
    expect(['none', 'stopped', 'error']).to.include(bStatus)
    let closed: unknown
    try {
      await rows(dbB1, 'select 1 as x from AuthorityIntakePolicy limit 1')
    } catch (err) {
      closed = err
    }
    expect(closed, 'the version-1 handle on node-B is closed').to.be.instanceOf(Error)
  })

  it('4 node-B restarting on version 1 is refused with AppSchemaOutdatedError', async () => {
    harness.nodeB.setAppSchema!(V1)
    const before = strandErrors.length
    let caught: unknown
    try {
      await harness.nodeB.reopenStrand!(hash)
    } catch (err) {
      caught = err
    }
    const chains = [...(caught ? [errorChain(caught)] : []), ...strandErrors.slice(before).filter((e) => e.who === 'B').map((e) => e.error)]
    console.log('[schema-v2-upgrade] leg 4 errors', JSON.stringify(chains))
    expect(chains.some((chain) => chain.some((line) => line.startsWith('AppSchemaOutdatedError'))), 'an AppSchemaOutdatedError').to.equal(true)
  })

  it('5 node-B upgrading to version 2 opens and holds both rows', async () => {
    harness.nodeB.setAppSchema!(undefined)
    const dbB2 = await harness.nodeB.reopenStrand!(hash)
    const state = await pollUntil(
      async () => harness.nodeB.node.getStrand(hash)?.database?.appSchemaState?.(),
      (s) => s === 'applied',
      { timeoutMs: 120_000, label: 'node-B app schema applied' }
    )
    expect(state, 'node-B app schema state').to.equal('applied')
    const policy = await pollUntil(
      async () => rows(dbB2, 'select Revision, SigningNonce, SigningTid from AuthorityIntakePolicy where AuthorityId = :a order by Revision', { a: fx.authorityId }),
      (r) => r.length === 2,
      { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: 'both rows on node-B (version 2)' }
    )
    expect(Number(policy[0]!.Revision)).to.equal(-2)
    expect(policy[0]!.SigningNonce).to.equal(proposalNonce)
    expect(Number(policy[0]!.SigningTid)).to.equal(proposalTid)
    expect(Number(policy[1]!.Revision)).to.equal(1)
    expect(await rows(dbB2, "select Id from Task where SignatureType = 'intake-policy'")).to.have.length(1)
  })

  it('6 the effective revision node-A writes reaches node-B, whose reader moves to it', async () => {
    const proposal = (await rows(dbA, 'select RestBridgeUrl, ReassociationMode, SetAt from AuthorityIntakePolicy where AuthorityId = :a and Revision = -2', { a: fx.authorityId }))[0]!
    await dbA.exec(
      `insert into AuthorityIntakePolicy (AuthorityId, Revision, RestBridgeUrl, ReassociationMode, SetAt)
       with context SigningNonce = :nonce, Tid = ${proposalTid}
       values (:a, 2, :url, :mode, :setAt)`,
      { a: fx.authorityId, nonce: proposalNonce, url: proposal.RestBridgeUrl, mode: proposal.ReassociationMode, setAt: proposal.SetAt } as any
    )
    const dbB2 = await harness.nodeB.openStrand(hash)
    const view = await pollUntil(
      async () => readIntakePolicyFrom(intakeQueryPortFromDb(dbB2), fx.authorityId),
      (v) => v.revision === 2,
      { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: 'revision 2 on node-B' }
    )
    expect(view.restBridgeUrl).to.equal('https://bridge2.example')
    expect(view.reassociationMode).to.equal('automatic')
  })
})
