/**
 * keyholder-replication.harness.spec.ts — Phase 62 Plan 24 (D-13, D-19, D-23): cross-node
 * keyholder accept, DKG, ElectionKey and key release across two real CadreNodes.
 *
 * ============================================================================
 * NODE TWO-NODE EVIDENCE — CODE-COMPLETE, UNVERIFIED ON DEVICES.
 * ============================================================================
 * The native keyholder vault and device delivery are P2P-11 proof debt, recorded by 62-30 — this
 * spec runs entirely over `InMemoryTestKeyVault` and the 62-06 Node harness. Block ciphertext
 * (D-1/D-2) is passed in memory only — this phase builds no block producer or table (62-20 note),
 * so the strand carries the DKG, the key and the share rows, not blocks.
 */

import { expect } from 'chai'
import { bytesToHex } from '@noble/curves/utils.js'
import {
  startTwoNodeHarness,
  describeP2PHarness,
  pollUntil,
  HARNESS_TIMEOUTS
} from './harness/two-node-strand.js'
import type { TwoNodeHarness } from './harness/two-node-strand.js'
import { bootHarnessNetwork, legMark, assertReaderSilent, assertForeignOrigin } from './fixtures/harness-workflows.js'
import type { HarnessWorkflowNetwork } from './fixtures/harness-workflows.js'
import { seedHarnessDkgElection, runDkgAcrossNodes } from './fixtures/harness-keyholders.js'
import type { HarnessDkgParticipant } from './fixtures/harness-keyholders.js'
import { KeyholderDkgEngine } from '../src/keyholder/index.js'
import { keyholderDkgRoundSecretAlias } from '../src/keyholder/dkg-vault.js'
import { dkgIdentifierForUser, validateReleasedShare } from '../src/crypto/index.js'
import { InMemoryTestKeyVault, keyholderDkgShareAlias } from '../src/crypto/vault.js'
import { KeyReleaseEngine, KeyReleaseError, encryptElectionBlock, releasingKeysAt } from '../src/key-release/index.js'
import { KeysTasksEngine } from '../src/tasks/keys-tasks-engine.js'
import type { EngineContext } from '../src/types.js'
import type { ElectionBlockInput } from '@votetorrent/vote-core'

describeP2PHarness('two-node keyholder DKG and key release (D-13, D-19, D-23)', function () {
  let harness: TwoNodeHarness | undefined
  let network: HarnessWorkflowNetwork
  let electionId: string
  let revision: number
  let participants: HarnessDkgParticipant[]
  let k1: HarnessDkgParticipant
  let k2: HarnessDkgParticipant
  let k3: HarnessDkgParticipant
  const runId = { current: '' }
  const legTimings: Record<string, number> = {}
  let passesTaken = 0

  function timed<T> (label: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now()
    return fn().finally(() => { legTimings[label] = Date.now() - start })
  }

  before(async function () {
    this.timeout(HARNESS_TIMEOUTS.suiteMs)
    harness = await startTwoNodeHarness()
    network = await bootHarnessNetwork(harness)
    runId.current = harness.runId

    const seeded = await seedHarnessDkgElection(network, { placement: ['node-A', 'node-A', 'node-B'], threshold: 2 })
    electionId = seeded.electionId
    revision = seeded.revision
    participants = seeded.participants
    k1 = participants[0]!
    k2 = participants[1]!
    k3 = participants[2]!
  })

  after(async function () {
    this.timeout(HARNESS_TIMEOUTS.startMs)
    await harness?.stop()
  })

  it('C-1 keyholder accepted on node-B reaches node-A (D-19, D-21/D-26 rows)', async function () {
    this.timeout(HARNESS_TIMEOUTS.replicationMs + 15_000)
    await timed('C-1', async () => {
      await pollUntil(
        async () => {
          const kh = await network.dbA.prepare('select UserId from Keyholder where ElectionId = :e and UserId = :u').get({ e: electionId, u: k3.userId })
          const binding = await network.dbA.prepare('select UserId from KeyholderDkgBinding where ElectionId = :e and UserId = :u').get({ e: electionId, u: k3.userId })
          return { kh, binding }
        },
        (v) => v.kh != null && v.binding != null,
        { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: 'C-1: K3 Keyholder/KeyholderDkgBinding reach node-A' }
      )
      await assertForeignOrigin(network, { table: 'Keyholder', keyColumn: 'UserId', keyValue: k3.userId, reader: 'node-A', writer: 'node-B' })
      await assertForeignOrigin(network, { table: 'KeyholderDkgBinding', keyColumn: 'UserId', keyValue: k3.userId, reader: 'node-A', writer: 'node-B' })

      const khOnB = await network.dbB.prepare('select UserId from Keyholder where ElectionId = :e and UserId = :u').get({ e: electionId, u: k1.userId })
      expect(khOnB).to.not.equal(undefined)
      await assertForeignOrigin(network, { table: 'Keyholder', keyColumn: 'UserId', keyValue: k1.userId, reader: 'node-B', writer: 'node-A' })
    })
  })

  it('C-2 node-A round-0 rows verify on node-B before node-B writes any DKG row', async function () {
    this.timeout(HARNESS_TIMEOUTS.replicationMs + 15_000)
    await timed('C-2', async () => {
      const mark = legMark(network)

      const r1 = await k1.engine.advanceDkg(electionId, k1.signer)
      const r2 = await k2.engine.advanceDkg(electionId, k2.signer)
      expect(r1.actions).to.include('posted-round-0')
      expect(r2.actions).to.include('posted-round-0')

      await pollUntil(
        async () => {
          const rows: Array<{ SenderUserId: string }> = []
          for await (const row of network.dbB.eval(
            'select SenderUserId from KeyholderDkgMessage where ElectionId = :e and DkgRound = 0',
            { e: electionId } as any
          )) {
            rows.push(row as unknown as { SenderUserId: string })
          }
          return rows
        },
        (rows) => rows.length === 2 && new Set(rows.map((r) => r.SenderUserId)).size === 2,
        { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: 'C-2: both round-0 rows reach node-B' }
      )

      const verifier = new KeyholderDkgEngine(network.ctxB, { vault: new InMemoryTestKeyVault() })
      const verdict = await verifier.verifyDkgTranscript(electionId)
      expect(verdict.rowCount).to.equal(2)
      expect(verdict.invalidRows).to.deep.equal([])

      await assertForeignOrigin(network, { table: 'KeyholderDkgMessage', keyColumn: 'SenderUserId', keyValue: k1.userId, reader: 'node-B', writer: 'node-A' })
      assertReaderSilent(network, mark, 'node-B')
    })
  })

  it('C-3 DKG completes across nodes with one replicated ElectionKey (D-19, D-13)', async function () {
    this.timeout(HARNESS_TIMEOUTS.suiteMs)
    await timed('C-3', async () => {
      await runDkgAcrossNodes(network, participants, electionId, { maxPasses: 30 })
      passesTaken = 1

      for (const [label, db] of [['node-A', network.dbA], ['node-B', network.dbB]] as const) {
        const countRow = await db.prepare('select count(*) as n from KeyholderDkgMessage where ElectionId = :e').get({ e: electionId })
        expect(countRow?.n, `${label} KeyholderDkgMessage count`).to.equal(15)
        const ekRow = await db.prepare('select Attempt, Threshold, Participants, JointPublicKey from ElectionKey where ElectionId = :e').get({ e: electionId })
        expect(ekRow, `${label} ElectionKey row`).to.not.equal(undefined)
        expect(ekRow!.Attempt).to.equal(1)
        expect(ekRow!.Threshold).to.equal(2)
        expect(ekRow!.Participants).to.equal(3)
      }

      const ekA = await network.dbA.prepare('select JointPublicKey, PublisherUserId from ElectionKey where ElectionId = :e').get({ e: electionId })
      const ekB = await network.dbB.prepare('select JointPublicKey from ElectionKey where ElectionId = :e').get({ e: electionId })
      expect(ekA?.JointPublicKey).to.equal(ekB?.JointPublicKey)

      for (const [label, ctx] of [['node-A', network.ctxA], ['node-B', network.ctxB]] as const) {
        const verifier = new KeyholderDkgEngine(ctx, { vault: new InMemoryTestKeyVault() })
        const verdict = await verifier.verifyDkgTranscript(electionId)
        expect(verdict.invalidRows, `${label} invalidRows`).to.deep.equal([])
        expect(verdict.electionKeyConsistent, `${label} electionKeyConsistent`).to.equal(true)
        expect(verdict.rowCount, `${label} rowCount`).to.equal(15)
      }

      expect(network.ledgerA.wroteRowWith('KeyholderDkgMessage', k3.userId)).to.equal(false)
      expect(network.ledgerB.wroteRowWith('KeyholderDkgMessage', k3.userId)).to.equal(true)
      expect(network.ledgerB.wroteRowWith('KeyholderDkgMessage', k1.userId)).to.equal(false)
      expect(network.ledgerA.wroteRowWith('KeyholderDkgMessage', k1.userId)).to.equal(true)
      expect(network.ledgerB.wroteRowWith('KeyholderDkgMessage', k2.userId)).to.equal(false)
      expect(network.ledgerA.wroteRowWith('KeyholderDkgMessage', k2.userId)).to.equal(true)

      const publisherNode = ekA?.PublisherUserId === k3.userId ? 'node-B' : 'node-A'
      const otherNode = publisherNode === 'node-A' ? 'node-B' : 'node-A'
      await assertForeignOrigin(network, { table: 'ElectionKey', keyColumn: 'ElectionId', keyValue: electionId, reader: otherNode, writer: publisherNode })

      const shareBytes = await k3.vault.getSecret(keyholderDkgShareAlias(electionId, revision, k3.userId))
      expect(shareBytes, 'K3 vault holds its DKG share').to.not.equal(null)
      const groupCommitments = (await network.dbB.prepare('select GroupCommitments from ElectionKey where ElectionId = :e').get({ e: electionId }))!.GroupCommitments as string
      const commitments = JSON.parse(groupCommitments) as string[]
      const signingShareHex = bytesToHex(shareBytes!)
      const ok = validateReleasedShare(2, 3, commitments, { identifier: dkgIdentifierForUser(k3.userId), signingShare: signingShareHex })
      expect(ok, 'K3 share validates against the replicated group commitments').to.equal(true)

      for (const p of participants) {
        for (const step of [1, 2] as const) {
          const alias = keyholderDkgRoundSecretAlias(electionId, revision, 1, step, p.userId)
          expect(await p.vault.hasSecret(alias), `${p.name} step-${step} round secret swept`).to.equal(false)
        }
      }
    })
  })

  let blockInput: ElectionBlockInput
  let nowFn: () => number
  let payload: { v: 1, votes: unknown[], voterRecords: unknown[] }

  it('D-1 one released share is not enough on node-B', async function () {
    this.timeout(HARNESS_TIMEOUTS.replicationMs + 15_000)
    await timed('D-1', async () => {
      const nodeAPeerId = network.harness.nodeA.peerId
      const ekFromA = await k1.engine.getElectionKey(electionId)
      expect(ekFromA).to.not.equal(null)
      payload = { v: 1, votes: [{ marker: `origin:${nodeAPeerId}` }], voterRecords: [{ marker: `origin:${nodeAPeerId}` }] }
      const ciphertext = encryptElectionBlock(ekFromA!, 'harness-block-1', payload)
      blockInput = { blockId: 'harness-block-1', ciphertext }

      const timelineRow = await network.dbA.prepare('select Timeline from ElectionRevision where ElectionId = :e').get({ e: electionId })
      const timeline = JSON.parse(timelineRow!.Timeline as string) as unknown
      const at = releasingKeysAt(timeline)
      expect(at).to.not.equal(null)
      nowFn = () => at!

      const releaseA = new KeysTasksEngine(network.net.ref, network.ctxA, { vault: k1.vault, now: nowFn })
      const tasks = await releaseA.getKeysToRelease(true)
      const task1 = tasks.find((t) => t.userId === k1.userId)
      expect(task1, 'K1 has a release-key task on node-A').to.not.equal(undefined)
      await releaseA.completeKeyRelease(task1!, k1.signer)

      const mark = legMark(network)
      const readerB = new KeyReleaseEngine({ db: network.dbB } as EngineContext, { now: nowFn })

      await pollUntil(
        async () => readerB.getKeyReleaseStatus(electionId),
        (status) => status.releasedCount === 1,
        { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: 'D-1: K1 release reaches node-B' }
      )
      const status1 = await readerB.getKeyReleaseStatus(electionId)
      expect(status1.releasedUserIds).to.deep.equal([k1.userId])

      let reconstructErr: unknown
      try {
        await readerB.reconstructElectionKey(electionId)
      } catch (err) {
        reconstructErr = err
      }
      expect(reconstructErr).to.be.instanceOf(KeyReleaseError)
      expect((reconstructErr as InstanceType<typeof KeyReleaseError>).code).to.equal('insufficient-shares')

      const decryptResults = await readerB.decryptElectionBlocks(electionId, [blockInput])
      expect(decryptResults[0]).to.deep.include({ ok: false, reason: 'not-reconstructable' })

      await assertForeignOrigin(network, { table: 'KeyholderShareRelease', keyColumn: 'UserId', keyValue: k1.userId, reader: 'node-B', writer: 'node-A' })
      assertReaderSilent(network, mark, 'node-B')
    })
  })

  it('D-2 node-B reconstructs from node-A\'s shares and decrypts (D-13 full loop)', async function () {
    this.timeout(HARNESS_TIMEOUTS.replicationMs + 15_000)
    await timed('D-2', async () => {
      const releaseA = new KeysTasksEngine(network.net.ref, network.ctxA, { vault: k2.vault, now: nowFn })
      const tasks = await releaseA.getKeysToRelease(true)
      const task2 = tasks.find((t) => t.userId === k2.userId)
      expect(task2, 'K2 has a release-key task on node-A').to.not.equal(undefined)
      await releaseA.completeKeyRelease(task2!, k2.signer)

      const readerB = new KeyReleaseEngine({ db: network.dbB } as EngineContext, { now: nowFn })
      await pollUntil(
        async () => readerB.getKeyReleaseStatus(electionId),
        (status) => status.releasedCount === 2,
        { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: 'D-2: K2 release reaches node-B' }
      )
      const status2 = await readerB.getKeyReleaseStatus(electionId)
      expect(status2.phase).to.equal('reconstructable')
      expect(status2.rejectedReleases).to.deep.equal([])

      const reconstructed = await readerB.reconstructElectionKey(electionId)
      const ekRowB = await network.dbB.prepare('select JointPublicKey from ElectionKey where ElectionId = :e').get({ e: electionId })
      expect(reconstructed.jointPublicKey).to.equal(ekRowB!.JointPublicKey)
      expect(reconstructed.usedUserIds).to.have.lengthOf(2)
      for (const id of reconstructed.usedUserIds) expect([k1.userId, k2.userId]).to.include(id)

      const decryptResults = await readerB.decryptElectionBlocks(electionId, [blockInput])
      expect(decryptResults[0]?.ok).to.equal(true)
      if (decryptResults[0]?.ok) {
        expect(decryptResults[0].payload).to.deep.equal(payload)
      }

      await assertForeignOrigin(network, { table: 'KeyholderShareRelease', keyColumn: 'UserId', keyValue: k2.userId, reader: 'node-B', writer: 'node-A' })
    })
  })

  it('D-3 a share released on node-B is read on node-A', async function () {
    this.timeout(HARNESS_TIMEOUTS.replicationMs + 15_000)
    await timed('D-3', async () => {
      const releaseB = new KeysTasksEngine(network.net.ref, network.ctxB, { vault: k3.vault, now: nowFn })
      const tasks = await releaseB.getKeysToRelease(true)
      const task3 = tasks.find((t) => t.userId === k3.userId)
      expect(task3, 'K3 has a release-key task on node-B').to.not.equal(undefined)
      await releaseB.completeKeyRelease(task3!, k3.signer)

      const readerA = new KeyReleaseEngine({ db: network.dbA } as EngineContext, { now: nowFn })
      await pollUntil(
        async () => readerA.getKeyReleaseStatus(electionId),
        (status) => status.releasedUserIds.length === 3,
        { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: 'D-3: K3 release reaches node-A' }
      )
      const statusA = await readerA.getKeyReleaseStatus(electionId)
      expect(statusA.releasedUserIds).to.deep.equal([k1.userId, k2.userId, k3.userId].sort())

      await assertForeignOrigin(network, { table: 'KeyholderShareRelease', keyColumn: 'UserId', keyValue: k3.userId, reader: 'node-A', writer: 'node-B' })
      expect(network.ledgerA.writesTo('KeyholderShareRelease')).to.equal(2)
    })
  })

  it('T-2 leg timing', function () {
    const loadavg = (globalThis as any).process?.loadavg?.() ?? []
    console.log('P2P_LEG_TIMING ' + JSON.stringify({ spec: 'keyholder-replication', runId: runId.current, legs: legTimings, passes: passesTaken, loadavg }))
  })
})
