/**
 * reassociation-decision-drain.spec.ts — Phase 62 Plan 113 Task 2 (initial/G1 WR-02, D-41, D-46).
 *
 * Every re-association flow writes the local transition and THEN publishes the decision. A publish
 * that failed used to leave the row past 'p' with no decision and nothing republished, so the
 * waiting voter device polled forever. `processPendingReassociations` now drains those rows.
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { REASSOCIATION_NOT_APPROVED_REASON, REASSOCIATION_UNRESOLVED_REGISTRANT_ID } from '@votetorrent/vote-core'
import type {
  AssociationRequestInit,
  DeviceAttestation,
  ReassociationDecisionInput,
  ReassociationIntake,
  RegisterInit,
  RegistrantSignatureTask,
  RegistrationRequestInit,
  RegistrationVerificationChecklistItem,
  Signature
} from '@votetorrent/vote-core'
import { AssociationEngine } from '../src/association/association-engine.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine.js'
import { IntakeEngine } from '../src/intake/index.js'
import { P2pRegistrationTransport } from '../src/registration/transport/p2p-registration-transport.js'
import type { RegistrationStrandPort } from '../src/registration/transport/p2p-registration-transport.js'
import { P2pStagingError } from '../src/registration/transport/p2p-staging-seam.js'
import { P2pAssociationTransport } from '../src/association/transport/p2p-association-transport.js'
import type { AssociationStrandPort } from '../src/association/transport/p2p-association-transport.js'
import { computeAssociationAttestationDigest, computeAssociationRequestDigest } from '../src/association/transport/association-request-digest.js'
import { deriveRegistrationCodeWith } from '../src/association/reassociation/registration-code.js'
import { InMemoryTestKeyVault } from '../src/crypto/vault.js'
import { OFFICER_ENCRYPTION_KEY_POLICY, officerEncryptionKeyAlias } from '../src/crypto/index.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'
import { digestToBytes } from '../src/utils.js'
import { createP2pStagingFixture } from './fixtures/p2p-staging-fixture.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import type { TestKeyPair } from './fixtures/keys.js'
import { makeTestSignCallback, provisionTestIntakeRecipient } from './fixtures/test-context.js'

function makeCallbackSigner (keyPair: TestKeyPair): (digest: Uint8Array) => Promise<Signature> {
  const privBytes = hexToBytes(keyPair.privateHex)
  return async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes)
    return { signature: bytesToHex(sig), signerKey: keyPair.publicHex, signerUserId: '' }
  }
}

describe('re-association decision republish drain (62-113 Task 2, WR-02)', function () {
  this.timeout(60_000)

  async function makeWorld (mode: 'manual' | 'automatic' = 'manual') {
    const fixture = await createP2pStagingFixture()
    const ctx = fixture.auth.ctx
    const authorityId = fixture.auth.authority.id
    const officerSign = makeTestSignCallback(fixture.auth.user)
    const vault = new InMemoryTestKeyVault()
    await vault.putSecret(officerEncryptionKeyAlias(fixture.net.user.id), fixture.recipients[0].secretKey, OFFICER_ENCRYPTION_KEY_POLICY)
    await provisionTestIntakeRecipient(ctx, authorityId, { vault })
    if (mode === 'automatic') {
      await new IntakeEngine(ctx).setIntakePolicy({ authorityId, reassociationMode: 'automatic' }, officerSign)
    }
    const engine = new AssociationEngine(ctx)

    const regPort = fixture.makePort()
    const regTransport = new P2pRegistrationTransport({
      openStrand: async () => regPort as unknown as RegistrationStrandPort,
      computeDigest: async (init, requesterKey) => await fixture.fixtureRequestDigest(init, requesterKey),
      strandId: 'drain-reg-strand',
      sealer: fixture.sealer,
      opener: fixture.opener,
      decisionSigner: fixture.decisionSigner
    })
    const assocPort = fixture.makePort()
    const transport = new P2pAssociationTransport({
      openStrand: async () => assocPort as unknown as AssociationStrandPort,
      computeDigest: async (init, requesterKey) => digestToBytes(computeAssociationRequestDigest(init, requesterKey)),
      computeAttestationDigest: async (answer) => digestToBytes(computeAssociationAttestationDigest(answer)),
      strandId: `drain-assoc-strand-${crypto.randomUUID()}`,
      sealer: fixture.sealer,
      opener: fixture.opener,
      decisionSigner: fixture.decisionSigner
    })

    /** Wraps the real transport; `shouldFail` decides per call, every call is recorded. */
    const calls: ReassociationDecisionInput[] = []
    let shouldFail: (d: ReassociationDecisionInput) => unknown = () => undefined
    const intake: ReassociationIntake = {
      readStagedRequests: async () => await transport.readStagedRequests(),
      readStagedAttestations: async () => await transport.readStagedAttestations(),
      publishDecision: async (d) => {
        calls.push(d)
        const failure = shouldFail(d)
        if (failure !== undefined) throw failure
        return await transport.publishDecision(d)
      }
    }
    const failWhen = (fn: (d: ReassociationDecisionInput) => unknown): void => { shouldFail = fn }

    let deviceSeq = 0
    function attestation (): DeviceAttestation {
      deviceSeq += 1
      return {
        publicKey: `drain-device-pubkey-${deviceSeq}-${crypto.randomUUID()}`,
        deviceId: `drain-device-id-${deviceSeq}-${crypto.randomUUID()}`,
        attestationTime: Date.now(),
        certificateChain: ['drain-cert-a', 'drain-cert-b']
      }
    }

    async function approveRegistration (): Promise<{ registrantId: string; code: string }> {
      const voter = randomTestKeyPair()
      const voterSign = makeCallbackSigner(voter)
      const registrantId = `drain-registrant-${crypto.randomUUID()}`
      const requestId = crypto.randomUUID()
      const payload: RegisterInit = {
        registrant: { id: registrantId, authorityId, expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000) },
        public: { firstName: 'Drain', lastName: 'Tester', district: 'D1' },
        private: { expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000), details: [] }
      }
      const init: RegistrationRequestInit = { id: requestId, authorityId, payload, submittedAt: toIsoZDatetime(Date.now()) }
      const code = await deriveRegistrationCodeWith(registrantId, voterSign)
      await regTransport.submitRequest(init, voter.publicHex, voterSign, { registrationCode: code })
      await new RegistrationEngine(ctx).submitRegistrationRequest(init, voter.publicHex, voterSign)
      const tasksEngine = new SignatureTasksEngine(
        { hash: 'drain-test-network-hash', name: 'Drain Test Network', relays: [], primaryAuthorityDomainName: 'drain-test.example' },
        ctx
      )
      const tasks = await tasksEngine.getRequestedSignatures(true)
      const task = tasks.find((t) => t.signatureType === 'registrant' && (t as RegistrantSignatureTask).requestId === requestId)
      if (task === undefined) throw new Error('no registrant task')
      const digest = await tasksEngine.getSignatureDigest(task)
      await tasksEngine.completeSignature(task, {
        isAccepted: true,
        signature: await officerSign(digest),
        sign: officerSign,
        decision: { checklist: ['id'] as RegistrationVerificationChecklistItem[] }
      })
      return { registrantId, code }
    }

    async function associateDevice (registrantId: string): Promise<TestKeyPair> {
      const device = randomTestKeyPair()
      const challenge = await engine.issueAttestationChallenge(registrantId, device.publicHex, officerSign)
      await engine.associate({ registrantId, deviceKey: device.publicHex, nonce: challenge.nonce, attestation: attestation() }, officerSign)
      return device
    }

    async function submitSentinel (device: TestKeyPair, code: string): Promise<string> {
      const requestId = crypto.randomUUID()
      const init: AssociationRequestInit = {
        id: requestId,
        authorityId,
        registrantId: REASSOCIATION_UNRESOLVED_REGISTRANT_ID,
        deviceKey: device.publicHex,
        submittedAt: toIsoZDatetime(Date.now())
      }
      await transport.submitRequest(init, device.publicHex, makeCallbackSigner(device), { registrationCode: code })
      const doc = (await transport.readStagedRequests()).find((d) => d.requestId === requestId)
      if (doc === undefined) throw new Error('staged sentinel not found')
      await engine.submitAssociationRequest(doc.init, doc.requesterKey, doc.signature)
      return requestId
    }

    async function stageAttestation (requestId: string, device: TestKeyPair): Promise<void> {
      const row = await ctx.db.prepare('select ChallengeNonce from AssociationRequest where Id = :id').get({ id: requestId })
      await transport.submitAttestation({ requestId, nonce: row!.ChallengeNonce as string, attestation: attestation() }, device.publicHex, makeCallbackSigner(device))
    }

    async function decisionRow (requestId: string, status: string) {
      return await ctx.db
        .prepare('select ChallengeNonce, Reason, RevokesDeviceKey, MatchMethod from AssociationDecision where RequestId = :requestId and Status = :rowStatus')
        .get({ requestId, rowStatus: status })
    }

    const process = async () => await engine.processPendingReassociations(authorityId, officerSign, intake, fixture.opener)

    return {
      fixture, ctx, authorityId, officerSign, engine, transport, intake, calls, failWhen,
      approveRegistration, associateDevice, submitSentinel, stageAttestation, decisionRow, process
    }
  }

  it("D-1: a failed 'c' publish in the automatic run is republished on the next sync with the row's own nonce", async () => {
    const w = await makeWorld('automatic')
    const { code } = await w.approveRegistration()
    const requestId = await w.submitSentinel(randomTestKeyPair(), code)

    let failed = 0
    w.failWhen((d) => (d.status === 'c' && failed++ === 0 ? new Error('transient publish failure') : undefined))
    const first = await w.process()
    expect(first.challengesIssued).to.equal(1)
    expect(first.publishFailures, 'failures are counted, not swallowed').to.equal(1)
    expect(await w.decisionRow(requestId, 'c'), 'no decision yet').to.equal(undefined)

    const second = await w.process()
    const decision = await w.decisionRow(requestId, 'c')
    expect(decision, 'the decision reached the strand').to.not.equal(undefined)
    const row = await w.ctx.db.prepare('select ChallengeNonce from AssociationRequest where Id = :id').get({ id: requestId })
    expect(decision!.ChallengeNonce).to.equal(row!.ChallengeNonce)
    expect(second.republished).to.equal(1)
    expect(second.publishFailures).to.equal(undefined)
  })

  it("D-2: approveReassociation's failed 'c' publish does not fail the approval and is republished by the next processPendingReassociations", async () => {
    const w = await makeWorld()
    const { registrantId, code } = await w.approveRegistration()
    const requestId = await w.submitSentinel(randomTestKeyPair(), code)

    w.failWhen((d) => (d.status === 'c' ? new Error('transient publish failure') : undefined))
    // WR-R1-01: the 'c' transition committed, so the approval reports its outcome instead of
    // throwing (a throw here made the officer's retry fail with 'not-pending').
    const result = await w.engine.approveReassociation(requestId, { registrantId }, w.officerSign, w.intake, w.fixture.opener)
    expect(result.outcome).to.equal('awaiting-device-attestation')
    expect(w.calls.filter((c) => c.requestId === requestId && c.status === 'c'), 'the publish was attempted').to.have.lengthOf(1)
    expect((await w.ctx.db.prepare('select Status from AssociationRequest where Id = :id').get({ id: requestId }))!.Status).to.equal('c')
    expect(await w.decisionRow(requestId, 'c')).to.equal(undefined)

    w.failWhen(() => undefined)
    const summary = await w.process()
    expect(summary.republished).to.equal(1)
    expect(await w.decisionRow(requestId, 'c')).to.not.equal(undefined)
  })

  it("D-3: a failed 'a' publish is republished with matchMethod recomputed and no revokesDeviceKey; the device then reads 'a'", async () => {
    const w = await makeWorld()
    const { registrantId, code } = await w.approveRegistration()
    const deviceA = await w.associateDevice(registrantId)
    const deviceB = randomTestKeyPair()
    const requestId = await w.submitSentinel(deviceB, code)
    await w.engine.approveReassociation(requestId, { registrantId }, w.officerSign, w.intake, w.fixture.opener)
    await w.stageAttestation(requestId, deviceB)

    w.failWhen((d) => (d.status === 'a' ? new Error('transient publish failure') : undefined))
    const first = await w.process()
    expect(first.associated).to.equal(1)
    expect(first.publishFailures).to.equal(1)
    expect(await w.decisionRow(requestId, 'a')).to.equal(undefined)
    expect((await w.engine.getAssociations(registrantId)).map((a) => a.deviceKey)).to.deep.equal([deviceB.publicHex])

    w.failWhen(() => undefined)
    const second = await w.process()
    expect(second.republished).to.equal(1)
    const decision = await w.decisionRow(requestId, 'a')
    expect(decision).to.not.equal(undefined)
    expect(decision!.MatchMethod).to.equal('code')
    expect(decision!.RevokesDeviceKey ?? null, 'the retired key is no longer recomputable (T-62-113-03)').to.equal(null)
    const polled = await w.transport.readDecisionRecords()
    expect(polled.find((r) => r.requestId === requestId && r.status === 'a'), "the waiting device's poll sees 'a'").to.not.equal(undefined)
    void deviceA
  })

  it("D-4 and D-6: an officer rejection whose 'r' publish failed is republished with its reason; no 'c' notice is ever published for its synthetic leg", async () => {
    const w = await makeWorld()
    const { code } = await w.approveRegistration()
    const requestId = await w.submitSentinel(randomTestKeyPair(), code)

    w.failWhen((d) => (d.status === 'r' ? new Error('transient publish failure') : undefined))
    let threw = false
    try { await w.engine.rejectReassociation(requestId, w.officerSign, w.intake) } catch { threw = true }
    expect(threw).to.equal(true)
    expect((await w.ctx.db.prepare('select Status from AssociationRequest where Id = :id').get({ id: requestId }))!.Status).to.equal('r')
    expect(await w.decisionRow(requestId, 'r')).to.equal(undefined)

    w.failWhen(() => undefined)
    const summary = await w.process()
    expect(summary.republished).to.equal(1)
    expect((await w.decisionRow(requestId, 'r'))!.Reason).to.equal(REASSOCIATION_NOT_APPROVED_REASON)
    expect(w.calls.filter((c) => c.requestId === requestId && c.status === 'c'), "no 'c' published for the synthetic leg").to.have.lengthOf(0)
    expect(await w.decisionRow(requestId, 'c')).to.equal(undefined)
  })

  it('D-5: a published row is never republished (no extra signature); duplicate-decision is success; other failures are counted and retried', async () => {
    const w = await makeWorld()
    const { registrantId, code } = await w.approveRegistration()
    const requestId = await w.submitSentinel(randomTestKeyPair(), code)
    await w.engine.approveReassociation(requestId, { registrantId }, w.officerSign, w.intake, w.fixture.opener)
    const before = w.calls.length
    await w.process()
    await w.process()
    expect(w.calls.length, 'the already-published c costs no publish call').to.equal(before)

    // A second request whose 'c' publish failed, then drained into a strand that already holds it.
    const code2 = (await w.approveRegistration())
    const requestId2 = await w.submitSentinel(randomTestKeyPair(), code2.code)
    w.failWhen((d) => (d.status === 'c' ? new Error('transient publish failure') : undefined))
    try { await w.engine.approveReassociation(requestId2, { registrantId: code2.registrantId }, w.officerSign, w.intake, w.fixture.opener) } catch { /* expected */ }

    w.failWhen(() => new P2pStagingError('duplicate-decision', 'already there'))
    const dup = await w.process()
    expect(dup.publishFailures, 'duplicate-decision is success').to.equal(undefined)

    w.failWhen(() => new Error('relay unreachable'))
    const failing = await w.process()
    expect(failing.publishFailures).to.equal(1)
    expect(await w.decisionRow(requestId2, 'c')).to.equal(undefined)

    w.failWhen(() => undefined)
    const retried = await w.process()
    expect(retried.republished).to.equal(1)
    expect(await w.decisionRow(requestId2, 'c')).to.not.equal(undefined)
  })

  it('D-8 (WR-R1-02): an unreadable decision scan costs one counted failure, never the sync; R1 still issues its challenge', async () => {
    const w = await makeWorld('automatic')
    // A row past 'p' so the drain reaches its AssociationDecision scan.
    const { registrantId, code } = await w.approveRegistration()
    const earlier = await w.submitSentinel(randomTestKeyPair(), code)
    await w.engine.approveReassociation(earlier, { registrantId }, w.officerSign, w.intake, w.fixture.opener)
    const pending = await w.submitSentinel(randomTestKeyPair(), (await w.approveRegistration()).code)

    const db = w.ctx.db as unknown as { eval: (...args: unknown[]) => unknown }
    const realEval = db.eval
    let tripped = 0
    db.eval = function (this: unknown, ...args: unknown[]) {
      if (typeof args[0] === 'string' && /from AssociationDecision where AuthorityId/.test(args[0])) {
        tripped++
        throw new Error('Missing block: AssociationDecision header (simulated)')
      }
      return (realEval as (...a: unknown[]) => unknown).apply(this, args)
    }
    try {
      const summary = await w.process()
      expect(tripped, 'the drain reached the stubbed scan').to.equal(1)
      expect(summary.challengesIssued, 'R1 ran despite the drain failure').to.equal(1)
      expect(summary.publishFailures, 'the drain failure is counted').to.equal(1)
      expect((await w.ctx.db.prepare('select Status from AssociationRequest where Id = :id').get({ id: pending }))!.Status).to.equal('c')
    } finally {
      db.eval = realEval
    }
  })

  it('D-7: a quiet run keeps exactly the four-field summary', async () => {
    const w = await makeWorld()
    expect(await w.process()).to.deep.equal({ challengesIssued: 0, associated: 0, rejected: 0, awaitingReview: 0 })
  })
})
