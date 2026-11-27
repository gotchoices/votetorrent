/**
 * reassociation-code-binding.spec.ts — Phase 62 Plan 35 (V-3, D-41, D-45, D-46, D-54, D-55).
 *
 * V-3: any strand writer could stage a row for a victim's cleartext RequestId carrying its own
 * registration code, and the officer side matched whatever it found first. The requester's own
 * signature over (RequestId, code) now rides inside the sealed staging plaintext, and the officer
 * side accepts a code only when that signature verifies against the APPROVED request's key.
 *
 * Task 2 (producer): B1-B5. Task 3 (officer side): F1a-F4, appended below.
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type {
  AssociationRequestInit,
  DeviceAttestation,
  RegistrantSignatureTask,
  RegistrationRequestInit,
  RegistrationVerificationChecklistItem,
  RegisterInit,
  Signature
} from '@votetorrent/vote-core'
import { REASSOCIATION_UNRESOLVED_REGISTRANT_ID, ReassociationError } from '@votetorrent/vote-core'
import { P2pRegistrationTransport } from '../src/registration/transport/p2p-registration-transport.js'
import type { RegistrationStrandPort } from '../src/registration/transport/p2p-registration-transport.js'
import { P2pStagingError } from '../src/registration/transport/p2p-staging-seam.js'
import {
  deriveRegistrationCodeWith,
  registrationCodeBindingDigest,
  verifyRegistrationCodeBinding
} from '../src/association/reassociation/registration-code.js'
import { createP2pStagingFixture } from './fixtures/p2p-staging-fixture.js'
import type { P2pStagingFixture } from './fixtures/p2p-staging-fixture.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import type { TestKeyPair } from './fixtures/keys.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'
import { AssociationEngine } from '../src/association/association-engine.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine.js'
import { IntakeEngine } from '../src/intake/index.js'
import { P2pAssociationTransport } from '../src/association/transport/p2p-association-transport.js'
import type { AssociationStrandPort } from '../src/association/transport/p2p-association-transport.js'
import { computeAssociationAttestationDigest, computeAssociationRequestDigest } from '../src/association/transport/association-request-digest.js'
import { digestToBytes } from '../src/utils.js'
import { InMemoryTestKeyVault } from '../src/crypto/vault.js'
import { OFFICER_ENCRYPTION_KEY_POLICY, officerEncryptionKeyAlias } from '../src/crypto/index.js'
import { makeTestSignCallback, provisionTestIntakeRecipient } from './fixtures/test-context.js'

function makeCallbackSigner (keyPair: TestKeyPair): (digest: Uint8Array) => Promise<Signature> {
  const privBytes = hexToBytes(keyPair.privateHex)
  return async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes)
    return { signature: bytesToHex(sig), signerKey: keyPair.publicHex, signerUserId: '' }
  }
}

describe('registration code binding — producer (62-35 Task 2, V-3)', function () {
  this.timeout(30_000)

  let fixture: P2pStagingFixture
  let strandSeq = 0

  before(async () => {
    fixture = await createP2pStagingFixture()
  })

  function buildTransport (strandId: string): P2pRegistrationTransport {
    const port = fixture.makePort()
    return new P2pRegistrationTransport({
      openStrand: async () => port as unknown as RegistrationStrandPort,
      computeDigest: async (init, requesterKey) => await fixture.fixtureRequestDigest(init, requesterKey),
      strandId,
      sealer: fixture.sealer,
      opener: fixture.opener,
      decisionSigner: fixture.decisionSigner
    })
  }

  function nextStrand (): string {
    strandSeq += 1
    return `code-binding-strand-${strandSeq}`
  }

  function makeInit (registrantId = crypto.randomUUID()): RegistrationRequestInit {
    const payload: RegisterInit = {
      registrant: { id: registrantId, authorityId: fixture.auth.authority.id, expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000) },
      public: { firstName: 'Bind', lastName: 'Tester' },
      private: { expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000), details: [] }
    }
    return { id: registrantId, authorityId: fixture.auth.authority.id, payload, submittedAt: toIsoZDatetime(Date.now()) }
  }

  async function openPlaintext (strandId: string): Promise<{ plaintext: Record<string, unknown>; requestId: string }> {
    const rows = await fixture.rawRows('RegistrationRequestStaging', strandId)
    expect(rows).to.have.lengthOf(1)
    const row = rows[0]!
    const requestId = row.RequestId as string
    const opened = await fixture.opener.open(row.InitJson as string, { requestId, digest: row.Digest as string })
    if (!opened.ok) throw new Error('fixture opener refused its own row')
    return { plaintext: JSON.parse(opened.plaintext) as Record<string, unknown>, requestId }
  }

  it('B1: a staged code carries the requester binding signature, which verifies only for (requestId, code, key)', async () => {
    const strandId = nextStrand()
    const transport = buildTransport(strandId)
    const requester = randomTestKeyPair()
    const sign = makeCallbackSigner(requester)
    const init = makeInit()
    const code = await deriveRegistrationCodeWith(init.id, sign)

    await transport.submitRequest(init, requester.publicHex, sign, { registrationCode: code })

    const { plaintext } = await openPlaintext(strandId)
    const bound = plaintext.registrationCodeSignature as Signature | undefined
    expect(bound, 'registrationCodeSignature present').to.not.equal(undefined)
    expect(bound!.signerKey).to.equal(requester.publicHex)

    const ok = await verifyRegistrationCodeBinding(fixture.db, { requestId: init.id, code, signature: bound!.signature, requesterKey: requester.publicHex })
    expect(ok).to.equal(true)
    expect(await verifyRegistrationCodeBinding(fixture.db, { requestId: init.id, code: code + 'X', signature: bound!.signature, requesterKey: requester.publicHex }), 'other code').to.equal(false)
    expect(await verifyRegistrationCodeBinding(fixture.db, { requestId: crypto.randomUUID(), code, signature: bound!.signature, requesterKey: requester.publicHex }), 'other request id').to.equal(false)
    expect(await verifyRegistrationCodeBinding(fixture.db, { requestId: init.id, code, signature: bound!.signature, requesterKey: randomTestKeyPair().publicHex }), 'other key').to.equal(false)
  })

  it("B2: a finished Signature with a code is refused 'code-binding-requires-signer' and writes no row", async () => {
    const strandId = nextStrand()
    const transport = buildTransport(strandId)
    const requester = randomTestKeyPair()
    const init = makeInit()
    const finished = await makeCallbackSigner(requester)(await fixture.fixtureRequestDigest(init, requester.publicHex))

    let caught: unknown
    try {
      await transport.submitRequest(init, requester.publicHex, finished, { registrationCode: 'ABCDE-FGHJK' })
    } catch (err) {
      caught = err
    }
    expect(caught).to.be.instanceOf(P2pStagingError)
    expect((caught as P2pStagingError).code).to.equal('code-binding-requires-signer')
    expect(await fixture.rawRows('RegistrationRequestStaging', strandId)).to.have.lengthOf(0)
  })

  it('B3: without a code the callback runs once and no binding exists; with a code it runs exactly twice', async () => {
    const requester = randomTestKeyPair()
    const inner = makeCallbackSigner(requester)

    let calls = 0
    const counting = async (digest: Uint8Array): Promise<Signature> => { calls += 1; return await inner(digest) }

    const plainStrand = nextStrand()
    await buildTransport(plainStrand).submitRequest(makeInit(), requester.publicHex, counting)
    expect(calls).to.equal(1)
    const plain = await openPlaintext(plainStrand)
    expect(plain.plaintext).to.not.have.property('registrationCodeSignature')

    calls = 0
    const codeStrand = nextStrand()
    await buildTransport(codeStrand).submitRequest(makeInit(), requester.publicHex, counting, { registrationCode: 'ABCDE-FGHJK' })
    expect(calls).to.equal(2)
    const withCode = await openPlaintext(codeStrand)
    expect(withCode.plaintext).to.have.property('registrationCodeSignature')
  })

  it('B3b: a callback that signs as a different key is rejected before any row is written', async () => {
    const strandId = nextStrand()
    const requester = randomTestKeyPair()
    const other = randomTestKeyPair()
    const inner = makeCallbackSigner(requester)
    const otherSign = makeCallbackSigner(other)
    let calls = 0
    const mixed = async (digest: Uint8Array): Promise<Signature> => {
      calls += 1
      return calls === 1 ? await inner(digest) : await otherSign(digest)
    }
    let caught: unknown
    try {
      await buildTransport(strandId).submitRequest(makeInit(), requester.publicHex, mixed, { registrationCode: 'ABCDE-FGHJK' })
    } catch (err) {
      caught = err
    }
    expect(caught).to.be.instanceOf(P2pStagingError)
    expect(await fixture.rawRows('RegistrationRequestStaging', strandId)).to.have.lengthOf(0)
  })

  it('B4: registrationCodeBindingDigest is a deterministic 32-byte digest that changes with every input, and refuses empties', () => {
    const a = registrationCodeBindingDigest('req-1', 'CODE-1')
    expect(a).to.have.lengthOf(32)
    expect(bytesToHex(registrationCodeBindingDigest('req-1', 'CODE-1'))).to.equal(bytesToHex(a))
    expect(bytesToHex(registrationCodeBindingDigest('req-2', 'CODE-1'))).to.not.equal(bytesToHex(a))
    expect(bytesToHex(registrationCodeBindingDigest('req-1', 'CODE-2'))).to.not.equal(bytesToHex(a))
    for (const [id, code] of [['', 'CODE-1'], ['req-1', '']] as const) {
      let caught: unknown
      try { registrationCodeBindingDigest(id, code) } catch (err) { caught = err }
      expect(caught).to.be.instanceOf(ReassociationError)
      expect((caught as ReassociationError).code).to.equal('invalid-argument')
    }
  })

  it('B5: verifyRegistrationCodeBinding never throws; garbage gives false', async () => {
    const key = randomTestKeyPair().publicHex
    const args = { requestId: 'req-1', code: 'CODE-1' }
    expect(await verifyRegistrationCodeBinding(fixture.db, { ...args, signature: 42 as unknown as string, requesterKey: key })).to.equal(false)
    expect(await verifyRegistrationCodeBinding(fixture.db, { ...args, signature: 'ab'.repeat(32), requesterKey: '' })).to.equal(false)
    expect(await verifyRegistrationCodeBinding(fixture.db, { ...args, signature: 'not-a-signature', requesterKey: key })).to.equal(false)
    expect(await verifyRegistrationCodeBinding(fixture.db, { ...args, signature: '', requesterKey: key })).to.equal(false)
  })
})

// =============================================================================================
// Task 3 — officer side (V-3, D-41, D-46, D-54, D-55)
// =============================================================================================

describe('registration code binding — officer side (62-35 Task 3, V-3)', function () {
  this.timeout(60_000)

  const STAGING_INSERT =
    'insert into RegistrationRequestStaging (StrandId, Cursor, RequestId, Digest, InitJson, RequesterKey, SignatureJson, StagedAt) ' +
    'values (:strandId, :cursor, :requestId, :digest, :initJson, :requesterKey, :signatureJson, :stagedAt)'

  interface Approved {
    registrantId: string
    requestId: string
    victim: TestKeyPair
    victimSign: (digest: Uint8Array) => Promise<Signature>
    init: RegistrationRequestInit
    code: string
  }

  /** A fresh authority world under the AUTOMATIC policy (the worst case for a forged match). */
  async function makeWorld () {
    const fixture = await createP2pStagingFixture()
    const ctx = fixture.auth.ctx
    const officerSign = makeTestSignCallback(fixture.auth.user)
    const matchingVault = new InMemoryTestKeyVault()
    await matchingVault.putSecret(officerEncryptionKeyAlias(fixture.net.user.id), fixture.recipients[0].secretKey, OFFICER_ENCRYPTION_KEY_POLICY)
    await provisionTestIntakeRecipient(ctx, fixture.auth.authority.id, { vault: matchingVault })
    await new IntakeEngine(ctx).setIntakePolicy({ authorityId: fixture.auth.authority.id, reassociationMode: 'automatic' }, officerSign)
    const associationEngine = new AssociationEngine(ctx)
    const authorityId = fixture.auth.authority.id

    function regTransport (strandId: string): P2pRegistrationTransport {
      const port = fixture.makePort()
      return new P2pRegistrationTransport({
        openStrand: async () => port as unknown as RegistrationStrandPort,
        computeDigest: async (init, requesterKey) => await fixture.fixtureRequestDigest(init, requesterKey),
        strandId,
        sealer: fixture.sealer,
        opener: fixture.opener,
        decisionSigner: fixture.decisionSigner
      })
    }

    let assocSeq = 0
    function assocTransport (): P2pAssociationTransport {
      assocSeq += 1
      const port = fixture.makePort()
      return new P2pAssociationTransport({
        openStrand: async () => port as unknown as AssociationStrandPort,
        computeDigest: async (init, requesterKey) => digestToBytes(computeAssociationRequestDigest(init, requesterKey)),
        computeAttestationDigest: async (answer) => digestToBytes(computeAssociationAttestationDigest(answer)),
        strandId: `binding-assoc-strand-${assocSeq}`,
        sealer: fixture.sealer,
        opener: fixture.opener,
        decisionSigner: fixture.decisionSigner
      })
    }

    function payloadFor (registrantId: string): RegisterInit {
      return {
        registrant: { id: registrantId, authorityId, expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000) },
        public: { firstName: 'Binding', lastName: 'Victim', district: 'D1' },
        private: { expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000), details: [] }
      }
    }

    /** Registers + officer-approves a victim. `stageOn` undefined = bridge/import shape (no staging row). */
    async function approve (opts: { stageOn?: string } = {}): Promise<Approved> {
      const victim = randomTestKeyPair()
      const victimSign = makeCallbackSigner(victim)
      const registrantId = `binding-registrant-${crypto.randomUUID()}`
      const requestId = crypto.randomUUID()
      const init: RegistrationRequestInit = { id: requestId, authorityId, payload: payloadFor(registrantId), submittedAt: toIsoZDatetime(Date.now()) }
      const code = await deriveRegistrationCodeWith(registrantId, victimSign)
      if (opts.stageOn !== undefined) {
        await regTransport(opts.stageOn).submitRequest(init, victim.publicHex, victimSign, { registrationCode: code })
      }
      await new RegistrationEngine(ctx).submitRegistrationRequest(init, victim.publicHex, victimSign)
      const tasksEngine = new SignatureTasksEngine(
        { hash: 'binding-test-network-hash', name: 'Binding Test Network', relays: [], primaryAuthorityDomainName: 'binding-test.example' },
        ctx
      )
      const tasks = await tasksEngine.getRequestedSignatures(true)
      const task = tasks.find((t) => t.signatureType === 'registrant' && (t as RegistrantSignatureTask).requestId === requestId)
      if (task === undefined) throw new Error('no registrant task')
      const digestBytes = await tasksEngine.getSignatureDigest(task)
      await tasksEngine.completeSignature(task, {
        isAccepted: true,
        signature: await officerSign(digestBytes),
        sign: officerSign,
        decision: { checklist: ['id'] as RegistrationVerificationChecklistItem[] }
      })
      return { registrantId, requestId, victim, victimSign, init, code }
    }

    /** The attacker stages a row for the VICTIM's request id with its OWN key and its OWN code. */
    async function stageForged (strandId: string, victimRequestId: string, attackerCode: string): Promise<TestKeyPair> {
      const attacker = randomTestKeyPair()
      const init: RegistrationRequestInit = {
        id: victimRequestId,
        authorityId,
        payload: payloadFor(`forged-${crypto.randomUUID()}`),
        submittedAt: toIsoZDatetime(Date.now())
      }
      await regTransport(strandId).submitRequest(init, attacker.publicHex, makeCallbackSigner(attacker), { registrationCode: attackerCode })
      return attacker
    }

    /** Raw insert of an already-valid staging row (cursor 1) onto `strandId`. */
    async function insertRaw (strandId: string, row: { requestId: string; digest: string; initJson: string; requesterKey: string; signatureJson: string }): Promise<void> {
      await ctx.db.exec(STAGING_INSERT, { strandId, cursor: '0000000000000001', stagedAt: new Date().toISOString(), ...row })
    }

    let sentinelSeq = 0
    async function presentCode (transport: P2pAssociationTransport, code: string): Promise<{ requestId: string; device: TestKeyPair }> {
      sentinelSeq += 1
      const device = randomTestKeyPair()
      const requestId = crypto.randomUUID()
      const init: AssociationRequestInit = {
        id: requestId,
        authorityId,
        registrantId: REASSOCIATION_UNRESOLVED_REGISTRANT_ID,
        deviceKey: device.publicHex,
        submittedAt: toIsoZDatetime(Date.now())
      }
      await transport.submitRequest(init, device.publicHex, makeCallbackSigner(device), { registrationCode: code })
      const staged = await transport.readStagedRequests()
      const doc = staged.find((d) => d.requestId === requestId)
      if (doc === undefined) throw new Error('staged sentinel not found')
      await associationEngine.submitAssociationRequest(doc.init, doc.requesterKey, doc.signature)
      return { requestId, device }
    }

    async function associateDevice (registrantId: string): Promise<TestKeyPair> {
      const device = randomTestKeyPair()
      const challenge = await associationEngine.issueAttestationChallenge(registrantId, device.publicHex, officerSign)
      const attestation: DeviceAttestation = {
        publicKey: `binding-device-pubkey-${crypto.randomUUID()}`,
        deviceId: `binding-device-id-${crypto.randomUUID()}`,
        attestationTime: Date.now(),
        certificateChain: ['binding-cert-a', 'binding-cert-b']
      }
      await associationEngine.associate({ registrantId, deviceKey: device.publicHex, nonce: challenge.nonce, attestation }, officerSign)
      return device
    }

    return { fixture, ctx, officerSign, associationEngine, authorityId, regTransport, assocTransport, approve, stageForged, insertRaw, presentCode, associateDevice, payloadFor }
  }

  type World = Awaited<ReturnType<typeof makeWorld>>

  async function reviewOf (w: World, transport: P2pAssociationTransport, requestId: string) {
    const review = await w.associationEngine.getReassociationReview(requestId, transport, w.fixture.opener)
    if (review === undefined) throw new Error('no review')
    return review
  }

  async function assertNothingHappened (w: World, requestId: string, registrantId: string, devices: readonly TestKeyPair[]): Promise<void> {
    const row = await w.ctx.db.prepare('select Status, ChallengeNonce from AssociationRequest where Id = :id').get({ id: requestId })
    expect(row?.Status, 'request stays pending').to.equal('p')
    expect(row?.ChallengeNonce ?? null, 'no challenge issued').to.equal(null)
    const associations = await w.associationEngine.getAssociations(registrantId)
    expect(associations.map((a) => a.deviceKey).sort()).to.deep.equal(devices.map((d) => d.publicHex).sort())
  }

  it('F1a: a forged code staged under a bridge victim\'s RequestId never matches, never routes automatic, issues no challenge and retires nothing', async () => {
    const w = await makeWorld()
    const victim = await w.approve() // no staging row (bridge/import shape)
    const deviceA = await w.associateDevice(victim.registrantId)

    const attackerCode = await deriveRegistrationCodeWith('attacker-chosen', makeCallbackSigner(randomTestKeyPair()))
    await w.stageForged('attacker-strand', victim.requestId, attackerCode)

    const transport = w.assocTransport()
    const { requestId } = await w.presentCode(transport, attackerCode)
    const summary = await w.associationEngine.processPendingReassociations(w.authorityId, w.officerSign, transport, w.fixture.opener)
    expect(summary.challengesIssued).to.equal(0)

    const review = await reviewOf(w, transport, requestId)
    expect(review.evidence).to.deep.equal({ kind: 'code', outcome: 'unverifiable' })
    expect(review.route).to.equal('manual')
    await assertNothingHappened(w, requestId, victim.registrantId, [deviceA])
  })

  it('F1b: the attacker row on a StrandId that sorts first never matches; the victim\'s own code still does', async () => {
    const w = await makeWorld()
    const victim = await w.approve({ stageOn: 'zzz-victim' })
    const attackerCode = await deriveRegistrationCodeWith('attacker-chosen', makeCallbackSigner(randomTestKeyPair()))
    await w.stageForged('aaa-attacker', victim.requestId, attackerCode)

    const transport = w.assocTransport()
    const forged = await w.presentCode(transport, attackerCode)
    const forgedReview = await reviewOf(w, transport, forged.requestId)
    expect(forgedReview.evidence.kind).to.equal('code')
    expect((forgedReview.evidence as { outcome: string }).outcome, 'never matched').to.be.oneOf(['unverifiable', 'unmatched'])
    expect(forgedReview.route).to.equal('manual')

    const honest = await w.presentCode(transport, victim.code)
    const honestReview = await reviewOf(w, transport, honest.requestId)
    expect(honestReview.evidence).to.deep.equal({ kind: 'code', outcome: 'matched' })
  })

  it('F2: replaying the victim\'s cleartext key, Digest and signature under an attacker-sealed InitJson never matches', async () => {
    const w = await makeWorld()
    const victim = await w.approve() // bridge shape: the replayable material is the cleartext request row
    const payloadJson = JSON.stringify(victim.init.payload)
    const payloadCid = (await w.ctx.db.prepare('select Digest(:payload) as d').get({ payload: payloadJson }))!.d as string
    const digestRow = await w.ctx.db
      .prepare('select Digest(:id, :rowAuthorityId, :requesterKey, :issuerType, :bridgeId, :payloadCid, :submittedAt) as d')
      .get({ id: victim.requestId, rowAuthorityId: w.authorityId, requesterKey: victim.victim.publicHex, issuerType: 'registrant', bridgeId: null, payloadCid, submittedAt: victim.init.submittedAt })
    const digest = digestRow!.d as string
    const replayedSignature = await victim.victimSign(digestToBytes(digest))

    const attacker = randomTestKeyPair()
    const attackerSign = makeCallbackSigner(attacker)
    const attackerCode = await deriveRegistrationCodeWith('attacker-chosen', attackerSign)
    const bindingSignature = await attackerSign(registrationCodeBindingDigest(victim.requestId, attackerCode))
    const plaintext = JSON.stringify({
      version: 1,
      init: { ...victim.init, payload: w.payloadFor(`forged-${crypto.randomUUID()}`) },
      registrationCode: attackerCode,
      registrationCodeSignature: bindingSignature
    })
    const initJson = await w.fixture.sealer.seal(plaintext, { requestId: victim.requestId, digest })
    await w.insertRaw('replay-strand', {
      requestId: victim.requestId,
      digest,
      initJson,
      requesterKey: victim.victim.publicHex,
      signatureJson: JSON.stringify(replayedSignature)
    })

    const transport = w.assocTransport()
    const { requestId } = await w.presentCode(transport, attackerCode)
    const review = await reviewOf(w, transport, requestId)
    expect(review.evidence).to.deep.equal({ kind: 'code', outcome: 'unverifiable' })
    expect(review.route).to.equal('manual')
  })

  it('F3: two rows verified by the victim key but carrying DIFFERENT codes are unverifiable (D-55)', async () => {
    const w = await makeWorld()
    const victim = await w.approve({ stageOn: 'victim-strand-1' })
    const otherCode = await deriveRegistrationCodeWith('some-other-registrant-id', victim.victimSign)
    expect(otherCode).to.not.equal(victim.code)
    await w.regTransport('victim-strand-2').submitRequest(victim.init, victim.victim.publicHex, victim.victimSign, { registrationCode: otherCode })

    const transport = w.assocTransport()
    const { requestId } = await w.presentCode(transport, victim.code)
    const review = await reviewOf(w, transport, requestId)
    expect(review.evidence).to.deep.equal({ kind: 'code', outcome: 'unverifiable' })
    expect(review.route).to.equal('manual')
  })

  it('F3b: the victim\'s own row replayed byte-identical onto another strand is still matched (D-55)', async () => {
    const w = await makeWorld()
    const victim = await w.approve({ stageOn: 'victim-strand-1' })
    const [row] = await w.fixture.rawRows('RegistrationRequestStaging', 'victim-strand-1')
    await w.insertRaw('victim-strand-replay', {
      requestId: row!.RequestId as string,
      digest: row!.Digest as string,
      initJson: row!.InitJson as string,
      requesterKey: row!.RequesterKey as string,
      signatureJson: row!.SignatureJson as string
    })

    const transport = w.assocTransport()
    const { requestId } = await w.presentCode(transport, victim.code)
    const review = await reviewOf(w, transport, requestId)
    expect(review.evidence).to.deep.equal({ kind: 'code', outcome: 'matched' })
    expect(review.route).to.equal('automatic')
  })

  it('F4: a legacy staged code with no binding signature is unverifiable and never automatic (D-54)', async () => {
    const w = await makeWorld()
    const victim = await w.approve()
    const deviceA = await w.associateDevice(victim.registrantId)
    // A pre-binding staging row, signed validly by the victim key, carrying the victim's REAL code.
    const digestBytes = await w.fixture.fixtureRequestDigest(victim.init, victim.victim.publicHex)
    const digest = bytesToBase64urlLocal(digestBytes)
    const signature = await victim.victimSign(digestBytes)
    const initJson = await w.fixture.sealer.seal(JSON.stringify({ version: 1, init: victim.init, registrationCode: victim.code }), { requestId: victim.requestId, digest })
    await w.insertRaw('legacy-strand', { requestId: victim.requestId, digest, initJson, requesterKey: victim.victim.publicHex, signatureJson: JSON.stringify(signature) })

    const transport = w.assocTransport()
    const { requestId } = await w.presentCode(transport, victim.code)
    const summary = await w.associationEngine.processPendingReassociations(w.authorityId, w.officerSign, transport, w.fixture.opener)
    expect(summary.challengesIssued).to.equal(0)
    const review = await reviewOf(w, transport, requestId)
    expect(review.evidence).to.deep.equal({ kind: 'code', outcome: 'unverifiable' })
    expect(review.route).to.equal('manual')
    await assertNothingHappened(w, requestId, victim.registrantId, [deviceA])
  })
})

function bytesToBase64urlLocal (bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}
