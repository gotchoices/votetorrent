/**
 * staging-replication.harness.spec.ts — Phase 62 Plan 24 (D-23, D-24): registration, association
 * and D-32 intake rows crossing two real CadreNodes.
 *
 * ============================================================================
 * NODE TWO-NODE EVIDENCE — CODE-COMPLETE, UNVERIFIED ON DEVICES.
 * ============================================================================
 * Every leg below proves cross-peer replication on the 62-06 two-node Node harness (real
 * CadreNodes, the real votetorrent schema and UDFs, the patched stack the apps resolve). It is
 * NOT device proof — device delivery is P2P-11 proof debt, recorded by 62-30. The founding
 * officer identity (`net.user`) acts on node-B as a SECOND DEVICE OF THE SAME OFFICER (there is
 * only one officer seeded by `addTestAuthority`), so writer identity in every leg below is proven
 * by the write ledger and peerId markers (`harness-workflows.ts`'s `assertForeignOrigin`), never
 * by a difference in signing key — the officer's key is identical on both "devices" by
 * construction, exactly as two devices of one real officer would share one signing identity.
 *
 * Opt-in only (`RUN_P2P_HARNESS=1`, `describeP2PHarness`) — the default suite shows every leg
 * below as pending and never loads a P2P package.
 */

import { expect } from 'chai'
import {
  startTwoNodeHarness,
  describeP2PHarness,
  pollUntil,
  HARNESS_TIMEOUTS
} from './harness/two-node-strand.js'
import type { TwoNodeHarness } from './harness/two-node-strand.js'
import {
  bootHarnessNetwork,
  legMark,
  assertReaderSilent,
  assertForeignOrigin,
  regMakeInit,
  regDigest,
  assocMakeInit,
  assocRequestDigest,
  assocAttestationDigest,
  assocMakeAttestationAnswer,
  makeRequesterSigner
} from './fixtures/harness-workflows.js'
import type { HarnessWorkflowNetwork } from './fixtures/harness-workflows.js'
import { P2pRegistrationTransport } from '../src/registration/transport/p2p-registration-transport.js'
import { P2pAssociationTransport } from '../src/association/transport/p2p-association-transport.js'
import {
  IntakeEngine,
  IntakeError,
  createIntakeSealer,
  intakeQueryPortFromDb,
  resolveIntakeRecipients,
  readIntakePolicyFrom
} from '../src/intake/index.js'
import { InMemoryTestKeyVault } from '../src/crypto/vault.js'
import { makeTestSignCallback } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'

const REG_DECISION_CHECK_SQL =
  "select (SignatureValid(Digest('RegistrationDecision', StrandId, RequestId, AuthorityId, Status, Reason, ClosesRequestId, DecidedAt), DeciderSignature, DeciderKey) " +
  "or SignatureValidP256(Digest('RegistrationDecision', StrandId, RequestId, AuthorityId, Status, Reason, ClosesRequestId, DecidedAt), DeciderSignature, DeciderKey)) as ok " +
  'from RegistrationDecision where RequestId = :requestId'

const REG_STAGING_CHECK_SQL =
  "select (SignatureValid(Digest, json_extract(SignatureJson, '$.signature'), RequesterKey) " +
  "or SignatureValidP256(Digest, json_extract(SignatureJson, '$.signature'), RequesterKey)) as ok " +
  'from RegistrationRequestStaging where RequestId = :requestId'

describeP2PHarness('two-node staging, decision and intake replication (D-23)', function () {
  let harness: TwoNodeHarness | undefined
  let network: HarnessWorkflowNetwork
  let authorityId: string
  const runId = { current: '' }
  const legTimings: Record<string, number> = {}

  function timed<T> (label: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now()
    return fn().finally(() => { legTimings[label] = Date.now() - start })
  }

  before(async function () {
    this.timeout(HARNESS_TIMEOUTS.suiteMs)
    harness = await startTwoNodeHarness()
    network = await bootHarnessNetwork(harness)
    authorityId = network.auth.authority.id
    runId.current = harness.runId
  })

  after(async function () {
    this.timeout(HARNESS_TIMEOUTS.startMs)
    await harness?.stop()
  })

  it('N-0 instrument controls (own-orphan negative control)', async function () {
    this.timeout(HARNESS_TIMEOUTS.replicationMs + 15_000)
    await timed('N-0', async () => {
      const ns = `harness-n0:${runId.current}:${network.harness.nodeB.peerId}`
      const portB = await network.portB()
      await portB.mutate('insert into TidHighWater (Namespace, HighWater) values (:ns, :hw)', { ns, hw: 1 })

      expect(network.ledgerB.wroteRowWith('TidHighWater', ns)).to.equal(true)
      expect(network.ledgerA.wroteRowWith('TidHighWater', ns)).to.equal(false)

      let threw: Error | undefined
      try {
        await assertForeignOrigin(network, { table: 'TidHighWater', keyColumn: 'Namespace', keyValue: ns, reader: 'node-B', writer: 'node-A' })
      } catch (err) {
        threw = err as Error
      }
      expect(threw, 'assertForeignOrigin must throw on an own-orphan row').to.not.equal(undefined)
      expect(threw!.message.startsWith('own-orphan')).to.equal(true)

      await pollUntil(
        async () => {
          const rows: Array<Record<string, unknown>> = []
          for await (const row of network.dbA.eval('select Namespace from TidHighWater where Namespace = :ns', { ns } as any)) {
            rows.push(row as unknown as Record<string, unknown>)
          }
          return rows
        },
        (rows) => rows.length > 0,
        { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: 'N-0: TidHighWater row reaches node-A' }
      )

      await assertForeignOrigin(network, { table: 'TidHighWater', keyColumn: 'Namespace', keyValue: ns, reader: 'node-A', writer: 'node-B' })
    })
  })

  it('E-1 no recipients, no plaintext (D-32 fail-closed)', async function () {
    this.timeout(15_000)
    await timed('E-1', async () => {
      const sealer = createIntakeSealer({ port: intakeQueryPortFromDb(network.dbA), authorityId })
      let threw: unknown
      try {
        await sealer.seal('probe', { requestId: 'e1', digest: 'AA' })
      } catch (err) {
        threw = err
      }
      expect(threw).to.be.instanceOf(IntakeError)
      expect((threw as InstanceType<typeof IntakeError>).code).to.equal('no-recipients')
    })
  })

  let vaultB: InMemoryTestKeyVault
  let officerPublicKey: string

  it('E-2 officer encryption key registered on node-B is node-A\'s recipient (D-32 evidence)', async function () {
    this.timeout(HARNESS_TIMEOUTS.replicationMs + 15_000)
    await timed('E-2', async () => {
      const mark = legMark(network)
      vaultB = new InMemoryTestKeyVault()
      const reg = await new IntakeEngine(network.ctxB).registerOfficerEncryptionKey(
        authorityId, vaultB, makeTestSignCallback(network.net.user)
      )
      expect(reg.status).to.equal('registered')
      officerPublicKey = reg.publicKey

      await pollUntil(
        async () => resolveIntakeRecipients(intakeQueryPortFromDb(network.dbA), authorityId),
        (set) => set.recipients.length === 1,
        { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: 'E-2: recipient reaches node-A' }
      )
      const recipientSet = await resolveIntakeRecipients(intakeQueryPortFromDb(network.dbA), authorityId)
      expect(recipientSet.recipients).to.have.lengthOf(1)
      expect(recipientSet.recipients[0]!.userId).to.equal(network.net.user.id)
      expect(recipientSet.recipients[0]!.publicKey).to.equal(reg.publicKey)
      expect(recipientSet.officersWithoutKey).to.deep.equal([])

      await assertForeignOrigin(network, { table: 'UserEncryptionKey', keyColumn: 'PubKey', keyValue: reg.publicKey, reader: 'node-A', writer: 'node-B' })
      assertReaderSilent(network, mark, 'node-A')
    })
  })

  let r1Id: string
  let r2Id: string
  let requesterSigner: ReturnType<typeof makeRequesterSigner>
  let transportBReg: P2pRegistrationTransport
  let transportBAssoc: P2pAssociationTransport

  it('A-1 registration staged on node-A is opened on node-B', async function () {
    this.timeout(HARNESS_TIMEOUTS.replicationMs + 15_000)
    await timed('A-1', async () => {
      const mark = legMark(network)
      const transportA = new P2pRegistrationTransport({
        openStrand: network.portA,
        computeDigest: regDigest,
        strandId: network.hash,
        sealer: createIntakeSealer({ port: intakeQueryPortFromDb(network.dbA), authorityId })
      })
      requesterSigner = makeRequesterSigner()
      const nodeAPeerId = network.harness.nodeA.peerId
      const marker = (id: string) => `origin:${nodeAPeerId}:${runId.current}:${id}`

      function markedInit (id: string) {
        const base = regMakeInit(authorityId, { id })
        return {
          ...base,
          payload: {
            ...base.payload,
            private: { ...base.payload.private, details: [{ name: 'origin', value: marker(id) }] }
          }
        }
      }

      r1Id = 'harness-a1-r1'
      r2Id = 'harness-a1-r2'
      const init1 = markedInit(r1Id)
      const init2 = markedInit(r2Id)
      await transportA.submitRequest(init1, requesterSigner.publicHex, requesterSigner.sign)
      await transportA.submitRequest(init2, requesterSigner.publicHex, requesterSigner.sign)

      const transportB = new P2pRegistrationTransport({
        openStrand: network.portB,
        computeDigest: regDigest,
        strandId: network.hash,
        opener: new IntakeEngine(network.ctxB).createOpener(vaultB),
        decisionSigner: { authorityId, sign: makeTestSignCallback(network.net.user) }
      })
      transportBReg = transportB

      const report = await pollUntil(
        async () => transportB.readStagedRequestsReport(),
        (r) => r.delivered.length >= 2,
        { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: 'A-1: both staged requests reach node-B' }
      )
      expect(report.unreadable).to.deep.equal([])
      for (const delivered of report.delivered) {
        expect(delivered.requesterKey).to.equal(requesterSigner.publicHex)
        const id = delivered.requestId
        expect(delivered.init.payload.private.details[0]!.value).to.include(nodeAPeerId)

        const rawRow = await network.dbB
          .prepare('select InitJson, Digest, RequesterKey from RegistrationRequestStaging where RequestId = :id')
          .get({ id })
        expect(rawRow).to.not.equal(undefined)
        expect(String(rawRow!.InitJson)).to.not.include(marker(id))

        const checkRow = await network.dbB.prepare(REG_STAGING_CHECK_SQL).get({ requestId: id })
        expect(checkRow?.ok).to.equal(true)

        await assertForeignOrigin(network, { table: 'RegistrationRequestStaging', keyColumn: 'RequestId', keyValue: id, reader: 'node-B', writer: 'node-A' })
      }
      assertReaderSilent(network, mark, 'node-B')
    })
  })

  it('A-2 officer decision published on node-B is read on node-A', async function () {
    this.timeout(HARNESS_TIMEOUTS.replicationMs + 15_000)
    await timed('A-2', async () => {
      const mark = legMark(network)
      const transportB = transportBReg
      const nodeBPeerId = network.harness.nodeB.peerId
      await transportB.publishDecision({ requestId: r1Id, status: 'a', decidedAt: new Date().toISOString() })
      await transportB.publishDecision({ requestId: r2Id, status: 'r', reason: `decided-on:${nodeBPeerId}`, decidedAt: new Date().toISOString() })

      const transportA = new P2pRegistrationTransport({
        openStrand: network.portA,
        computeDigest: regDigest,
        strandId: network.hash
      })

      const records = await pollUntil(
        async () => transportA.readDecisionRecords(),
        (rs) => rs.length >= 2,
        { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: 'A-2: both decisions reach node-A' }
      )
      const officerKey = network.net.user.activeKeys[0]!.key
      for (const record of records) {
        expect(record.deciderKey).to.equal(officerKey)
      }
      const r2record = records.find((r) => r.requestId === r2Id)
      expect(r2record?.reason).to.include(nodeBPeerId)

      const polled = await transportA.pollDecisions()
      const polledR1 = polled.find((p) => p.requestId === r1Id)
      const polledR2 = polled.find((p) => p.requestId === r2Id)
      expect(polledR1?.status).to.equal('a')
      expect(polledR2?.status).to.equal('r')

      for (const id of [r1Id, r2Id]) {
        const checkRow = await network.dbA.prepare(REG_DECISION_CHECK_SQL).get({ requestId: id })
        expect(checkRow?.ok).to.equal(true)
        await assertForeignOrigin(network, { table: 'RegistrationDecision', keyColumn: 'RequestId', keyValue: id, reader: 'node-A', writer: 'node-B' })
      }
      assertReaderSilent(network, mark, 'node-A')
    })
  })

  let assocReqId: string

  it('B-1 association request and attestation staged on node-A are opened on node-B', async function () {
    this.timeout(HARNESS_TIMEOUTS.replicationMs + 15_000)
    await timed('B-1', async () => {
      const mark = legMark(network)
      const transportA = new P2pAssociationTransport({
        openStrand: network.portA,
        computeDigest: assocRequestDigest,
        computeAttestationDigest: assocAttestationDigest,
        strandId: network.hash,
        sealer: createIntakeSealer({ port: intakeQueryPortFromDb(network.dbA), authorityId })
      })
      const signer = makeRequesterSigner()
      const nodeAPeerId = network.harness.nodeA.peerId
      const init = assocMakeInit(signer.publicHex, authorityId)
      assocReqId = init.id

      await transportA.submitRequest(init, signer.publicHex, signer.sign, {
        registrationCode: 'HARNESS-CODE-1',
        identityFields: [{ name: 'origin', value: `origin:${nodeAPeerId}` }]
      })
      const answer = assocMakeAttestationAnswer({ requestId: assocReqId })
      await transportA.submitAttestation(answer, signer.publicHex, signer.sign)

      const transportB = new P2pAssociationTransport({
        openStrand: network.portB,
        computeDigest: assocRequestDigest,
        computeAttestationDigest: assocAttestationDigest,
        strandId: network.hash,
        opener: new IntakeEngine(network.ctxB).createOpener(vaultB),
        decisionSigner: { authorityId, sign: makeTestSignCallback(network.net.user) }
      })
      transportBAssoc = transportB

      const reqReport = await pollUntil(
        async () => transportB.readStagedRequestsReport(),
        (r) => r.delivered.length >= 1,
        { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: 'B-1: association request reaches node-B' }
      )
      expect(reqReport.unreadable).to.deep.equal([])
      const deliveredReq = reqReport.delivered.find((r) => r.requestId === assocReqId)
      expect(deliveredReq).to.not.equal(undefined)
      expect(deliveredReq!.identityFields?.[0]?.value).to.include(nodeAPeerId)

      const attReport = await pollUntil(
        async () => transportB.readStagedAttestationsReport(),
        (r) => r.delivered.length >= 1,
        { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: 'B-1: attestation reaches node-B' }
      )
      expect(attReport.unreadable).to.deep.equal([])

      const rawReqRow = await network.dbB
        .prepare('select InitJson from AssociationRequestStaging where RequestId = :id')
        .get({ id: assocReqId })
      expect(rawReqRow).to.not.equal(undefined)
      expect(String(rawReqRow!.InitJson)).to.not.include('HARNESS-CODE-1')
      expect(String(rawReqRow!.InitJson)).to.not.include(`origin:${nodeAPeerId}`)

      await assertForeignOrigin(network, { table: 'AssociationRequestStaging', keyColumn: 'RequestId', keyValue: assocReqId, reader: 'node-B', writer: 'node-A' })
      await assertForeignOrigin(network, { table: 'AssociationAttestationStaging', keyColumn: 'RequestId', keyValue: assocReqId, reader: 'node-B', writer: 'node-A' })
      assertReaderSilent(network, mark, 'node-B')
    })
  })

  it('B-2 association decisions published on node-B are read on node-A', async function () {
    this.timeout(HARNESS_TIMEOUTS.replicationMs + 15_000)
    await timed('B-2', async () => {
      const mark = legMark(network)
      const transportB = transportBAssoc
      const revokesDeviceKey = randomTestKeyPair().publicHex

      await transportB.publishDecision({
        requestId: assocReqId, status: 'c', challengeNonce: `harness-nonce-${runId.current}`, decidedAt: new Date().toISOString()
      })
      await transportB.publishDecision({
        requestId: assocReqId, status: 'a', revokesDeviceKey, matchMethod: 'code', decidedAt: new Date().toISOString()
      })

      const transportA = new P2pAssociationTransport({
        openStrand: network.portA,
        computeDigest: assocRequestDigest,
        computeAttestationDigest: assocAttestationDigest,
        strandId: network.hash
      })

      const records = await pollUntil(
        async () => transportA.readDecisionRecords(),
        (rs) => rs.filter((r) => r.requestId === assocReqId).length >= 2,
        { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: 'B-2: both decisions reach node-A' }
      )
      const own = records.filter((r) => r.requestId === assocReqId)
      const cRecord = own.find((r) => r.status === 'c')
      const aRecord = own.find((r) => r.status === 'a')
      expect(cRecord?.challengeNonce).to.equal(`harness-nonce-${runId.current}`)
      expect(aRecord?.revokesDeviceKey).to.equal(revokesDeviceKey)
      expect(aRecord?.matchMethod).to.equal('code')

      const polled = await transportA.pollDecisions()
      const ownPolled = polled.filter((p) => p.requestId === assocReqId)
      expect(ownPolled.map((p) => p.status)).to.deep.equal(['c', 'a'])

      await assertForeignOrigin(network, { table: 'AssociationDecision', keyColumn: 'RequestId', keyValue: assocReqId, reader: 'node-A', writer: 'node-B' })
      assertReaderSilent(network, mark, 'node-A')
    })
  })

  it('E-3 intake policy set on node-B is read on node-A', async function () {
    this.timeout(HARNESS_TIMEOUTS.replicationMs + 15_000)
    await timed('E-3', async () => {
      const mark = legMark(network)
      const nodeBPeerId = network.harness.nodeB.peerId
      const view = await new IntakeEngine(network.ctxB).setIntakePolicy(
        { authorityId, restBridgeUrl: `https://bridge.harness.test/${nodeBPeerId}`, reassociationMode: 'automatic' },
        makeTestSignCallback(network.net.user)
      )
      expect(view.revision).to.equal(1)

      const read = await pollUntil(
        async () => readIntakePolicyFrom(intakeQueryPortFromDb(network.dbA), authorityId),
        (v) => v.revision === 1,
        { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: 'E-3: intake policy reaches node-A' }
      )
      expect(read.restBridgeUrl).to.include(nodeBPeerId)
      expect(read.reassociationMode).to.equal('automatic')
      expect(read.isDefault).to.equal(false)

      await assertForeignOrigin(network, { table: 'AuthorityIntakePolicy', keyColumn: 'AuthorityId', keyValue: authorityId, reader: 'node-A', writer: 'node-B' })
      assertReaderSilent(network, mark, 'node-A')
    })
  })

  it('T-1 leg timing', function () {
    const loadavg = (globalThis as any).process?.loadavg?.() ?? []
    console.log('P2P_LEG_TIMING ' + JSON.stringify({ spec: 'staging-replication', runId: runId.current, legs: legTimings, loadavg }))
  })
})
