/**
 * reassociation.spec.ts — 62-18 (D-40, D-41, D-45, D-46).
 *
 * Task 1: the pure vote-core registration-code format helpers, the vote-engine PRF derivation,
 * and the `ReassociationError` shape. Tasks 2/3 (association-removal.spec.ts and this file's
 * later describe blocks) extend this file with the compound write, the driver and the full
 * code/identity/automatic/manual flows.
 */

import { expect } from 'chai'
import {
  encodeRegistrationCodeBits,
  formatRegistrationCode,
  normalizeRegistrationCode,
  registrationCodesEqual,
  REASSOCIATION_NOT_APPROVED_REASON,
  REASSOCIATION_UNRESOLVED_REGISTRANT_ID,
  REGISTRANT_HAS_ACTIVE_DEVICE_REASON,
  REGISTRATION_CODE_ALPHABET,
  REGISTRATION_CODE_FORMATTED_LENGTH,
  REGISTRATION_CODE_LENGTH,
  ReassociationError
} from '@votetorrent/vote-core'
import type {
  AssociationIdentityField,
  AssociationRequestInit,
  DeviceAttestation,
  IReassociationEngine,
  ReassociationDecisionSource,
  ReassociationIntake,
  ReassociationOpener
} from '@votetorrent/vote-core'
import { deterministicTestKeyPair, randomTestKeyPair } from './fixtures/keys.js'
import type { TestKeyPair } from './fixtures/keys.js'
import { deriveRegistrationCodeWith } from '../src/association/reassociation/registration-code.js'
import type { Signature } from '@votetorrent/vote-core'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { AssociationEngine } from '../src/association/association-engine.js'
import { MockAssociationEngine } from '../src/association/mock-association-engine.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine.js'
import { IntakeEngine } from '../src/intake/index.js'
import { P2pRegistrationTransport } from '../src/registration/transport/p2p-registration-transport.js'
import type { RegistrationStrandPort } from '../src/registration/transport/p2p-registration-transport.js'
import { P2pAssociationTransport } from '../src/association/transport/p2p-association-transport.js'
import type { AssociationStrandPort } from '../src/association/transport/p2p-association-transport.js'
import { computeAssociationAttestationDigest, computeAssociationRequestDigest } from '../src/association/transport/association-request-digest.js'
import { createP2pStagingFixture } from './fixtures/p2p-staging-fixture.js'
import type { P2pStagingFixture } from './fixtures/p2p-staging-fixture.js'
import { makeTestSignCallback, provisionTestIntakeRecipient } from './fixtures/test-context.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'
import { digestToBytes } from '../src/utils.js'
import { createThresholdAuthority } from './fixtures/threshold-authority.js'
import { addSiblingAuthority } from './fixtures/test-context.js'
import { InMemoryTestKeyVault } from '../src/crypto/vault.js'
import { OFFICER_ENCRYPTION_KEY_POLICY, officerEncryptionKeyAlias } from '../src/crypto/index.js'
import type { RegistrantSignatureTask, RegisterInit, RegistrationRequestInit, RegistrationVerificationChecklistItem } from '@votetorrent/vote-core'

/** Deterministic callback signer — @noble/curves v2 defaults (prehash:true, no extraEntropy), so
 * two signs over the identical digest produce byte-identical signatures. */
function makeDeterministicSigner (privateHex: string, publicHex: string): (digest: Uint8Array) => Promise<Signature> {
  const privBytes = hexToBytes(privateHex)
  return async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes)
    return { signature: bytesToHex(sig), signerKey: publicHex, signerUserId: '' }
  }
}

/** A hedged signer: `extraEntropy: true` makes @noble/curves randomize `k`, so two signs over the
 * SAME digest produce DIFFERENT signature bytes — the non-determinism `deriveRegistrationCodeWith`
 * must reject. */
function makeHedgedSigner (privateHex: string, publicHex: string): (digest: Uint8Array) => Promise<Signature> {
  const privBytes = hexToBytes(privateHex)
  return async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes, { extraEntropy: true })
    return { signature: bytesToHex(sig), signerKey: publicHex, signerUserId: '' }
  }
}

describe('registration code (D-45)', () => {
  describe('encodeRegistrationCodeBits', () => {
    it('all-zero 7 bytes encodes to all-zero-character code', () => {
      expect(encodeRegistrationCodeBits(new Uint8Array(7))).to.equal('0000000000')
    })

    it('all-0xff 7 bytes encodes to all-Z code', () => {
      expect(encodeRegistrationCodeBits(new Uint8Array(7).fill(0xff))).to.equal('ZZZZZZZZZZ')
    })

    it('throws TypeError on fewer than 7 bytes', () => {
      expect(() => encodeRegistrationCodeBits(new Uint8Array(6))).to.throw(TypeError)
    })

    it('output is always 10 characters, every one in the alphabet', () => {
      const out = encodeRegistrationCodeBits(new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]))
      expect(out).to.have.lengthOf(REGISTRATION_CODE_LENGTH)
      for (const ch of out) expect(REGISTRATION_CODE_ALPHABET.includes(ch), `char ${ch} in alphabet`).to.equal(true)
    })
  })

  describe('normalizeRegistrationCode', () => {
    it('strips spaces/hyphens and uppercases', () => {
      expect(normalizeRegistrationCode(' abcde-fghjk ')).to.equal('ABCDEFGHJK')
    })

    it('maps O->0 and I/L->1', () => {
      expect(normalizeRegistrationCode('O0IL1ABCDE')).to.equal('00111ABCDE')
    })

    it('returns undefined for a 9-char input', () => {
      expect(normalizeRegistrationCode('ABCDEFGHJ')).to.equal(undefined)
    })

    it('returns undefined for an 11-char input', () => {
      expect(normalizeRegistrationCode('ABCDEFGHJKM')).to.equal(undefined)
    })

    it('returns undefined for an input containing U', () => {
      expect(normalizeRegistrationCode('ABCDEFGHJU')).to.equal(undefined)
    })
  })

  describe('formatRegistrationCode', () => {
    it('formats a normalized 10-char code as XXXXX-XXXXX', () => {
      const formatted = formatRegistrationCode('ABCDEFGHJK')
      expect(formatted).to.equal('ABCDE-FGHJK')
      expect(formatted).to.have.lengthOf(REGISTRATION_CODE_FORMATTED_LENGTH)
    })

    it('throws TypeError for an invalid code', () => {
      expect(() => formatRegistrationCode('too-short')).to.throw(TypeError)
    })
  })

  describe('registrationCodesEqual', () => {
    it('is true for the same code in different casing/separator form', () => {
      expect(registrationCodesEqual('abcde-fghjk', 'ABCDEFGHJK')).to.equal(true)
    })

    it('is false for codes differing in one character', () => {
      expect(registrationCodesEqual('ABCDEFGHJK', 'ABCDEFGHJM')).to.equal(false)
    })

    it('is false, never throws, when either side is invalid', () => {
      expect(registrationCodesEqual('ABCDEFGHJK', 'too-short')).to.equal(false)
      expect(registrationCodesEqual('nope', 'ABCDEFGHJK')).to.equal(false)
    })
  })

  describe('ReassociationError', () => {
    it('is instanceof Error, carries name and code', () => {
      const err = new ReassociationError('invalid-argument', 'test message')
      expect(err).to.be.instanceOf(Error)
      expect(err.name).to.equal('ReassociationError')
      expect(err.code).to.equal('invalid-argument')
      expect(err.message).to.equal('test message')
    })
  })

  describe('deriveRegistrationCodeWith (vote-engine)', () => {
    it('is deterministic: same registrantId + same signer -> same code on two calls', async () => {
      const key = deterministicTestKeyPair('1'.repeat(64))
      const sign = makeDeterministicSigner(key.privateHex, key.publicHex)
      const codeA = await deriveRegistrationCodeWith('registrant-det-1', sign)
      const codeB = await deriveRegistrationCodeWith('registrant-det-1', sign)
      expect(codeA).to.equal(codeB)
    })

    it('different registrantIds give different codes under the same signer', async () => {
      const key = deterministicTestKeyPair('2'.repeat(64))
      const sign = makeDeterministicSigner(key.privateHex, key.publicHex)
      const codeA = await deriveRegistrationCodeWith('registrant-diff-a', sign)
      const codeB = await deriveRegistrationCodeWith('registrant-diff-b', sign)
      expect(codeA).to.not.equal(codeB)
    })

    // Pinned regression vector (KAT): a fixed test private key + a fixed registrantId must
    // always reproduce this exact code. If this ever fails, either the digest/domain/derivation
    // changed (a breaking change to every already-issued code) or something upstream (the signer,
    // the hash) silently changed behavior.
    it('pinned regression vector: fixed key + registrantId reassoc-kat-registrant', async () => {
      const KAT_PRIVATE_HEX = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'
      const key = deterministicTestKeyPair(KAT_PRIVATE_HEX)
      const sign = makeDeterministicSigner(key.privateHex, key.publicHex)
      const code = await deriveRegistrationCodeWith('reassoc-kat-registrant', sign)
      expect(code).to.equal('AQ6CH4P12J')
    })

    it('rejects a non-deterministic (hedged) signer with non-deterministic-signer', async () => {
      const key = deterministicTestKeyPair('3'.repeat(64))
      const sign = makeHedgedSigner(key.privateHex, key.publicHex)
      try {
        await deriveRegistrationCodeWith('registrant-hedged', sign)
        expect.fail('expected deriveRegistrationCodeWith to throw')
      } catch (err) {
        expect(err).to.be.instanceOf(ReassociationError)
        expect((err as ReassociationError).code).to.equal('non-deterministic-signer')
      }
    })

    it('rejects an empty registrantId with invalid-argument', async () => {
      const key = deterministicTestKeyPair('4'.repeat(64))
      const sign = makeDeterministicSigner(key.privateHex, key.publicHex)
      try {
        await deriveRegistrationCodeWith('', sign)
        expect.fail('expected deriveRegistrationCodeWith to throw')
      } catch (err) {
        expect(err).to.be.instanceOf(ReassociationError)
        expect((err as ReassociationError).code).to.equal('invalid-argument')
      }
    })

    it('rejects REASSOCIATION_UNRESOLVED_REGISTRANT_ID with invalid-argument', async () => {
      const key = deterministicTestKeyPair('5'.repeat(64))
      const sign = makeDeterministicSigner(key.privateHex, key.publicHex)
      try {
        await deriveRegistrationCodeWith(REASSOCIATION_UNRESOLVED_REGISTRANT_ID, sign)
        expect.fail('expected deriveRegistrationCodeWith to throw')
      } catch (err) {
        expect(err).to.be.instanceOf(ReassociationError)
        expect((err as ReassociationError).code).to.equal('invalid-argument')
      }
    })

    it('accepts no key material — the only key input is the signing callback', () => {
      // Structural proof, not a runtime one: the function's own declared arity is 2
      // (registrantId, sign) — no third "key" parameter exists on the signature at all.
      expect(deriveRegistrationCodeWith.length).to.equal(2)
    })
  })
})

// =============================================================================================
// Task 3 — resolution, D-46 routing, the driver, officer approve/reject, retirement, the mock.
// =============================================================================================

describe('re-association driver (62-18 Task 3, D-40/D-41/D-45/D-46)', function () {
  this.timeout(30_000)

  let fixture: P2pStagingFixture
  let registrationTransport: P2pRegistrationTransport
  let associationEngine: AssociationEngine
  let officerSign: (digest: Uint8Array) => Promise<Signature>

  before(async () => {
    fixture = await createP2pStagingFixture()
    registrationTransport = buildRegistrationTransport(fixture, 'reassoc-reg-strand')
    associationEngine = new AssociationEngine(fixture.auth.ctx)
    officerSign = makeTestSignCallback(fixture.auth.user)
    // D-49 (62-31): approveRegistration below drives the real (now-sealed) submitRegistrationRequest
    // and register(). `fixture.opener` (passed throughout this file as the re-association opener)
    // is built DIRECTLY on 62-04's openEnvelope over `fixture.recipients[0]`'s OWN in-memory secret —
    // a test stand-in independent of the real `UserEncryptionKey` table 62-14's IntakeEngine reads.
    // For `fixture.opener` to also open a D-49-sealed RegistrationRequest.Payload/RegistrantPrivate
    // (evidence.ts's listApprovedRegistrations), the REAL published UserEncryptionKey for
    // `fixture.net.user.id` must wrap that SAME secret — pre-seed the vault with it before
    // registering, so IntakeEngine reuses it (its own 'already has this alias' branch) instead of
    // minting an unrelated keypair.
    const matchingVault = new InMemoryTestKeyVault()
    await matchingVault.putSecret(
      officerEncryptionKeyAlias(fixture.net.user.id),
      fixture.recipients[0].secretKey,
      OFFICER_ENCRYPTION_KEY_POLICY
    )
    await provisionTestIntakeRecipient(fixture.auth.ctx, fixture.auth.authority.id, { vault: matchingVault })
  })

  // -----------------------------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------------------------

  function makeCallbackSigner (keyPair: TestKeyPair): (digest: Uint8Array) => Promise<Signature> {
    const privBytes = hexToBytes(keyPair.privateHex)
    return async (digest: Uint8Array): Promise<Signature> => {
      const sig = secp256k1.sign(digest, privBytes)
      return { signature: bytesToHex(sig), signerKey: keyPair.publicHex, signerUserId: '' }
    }
  }

  function buildRegistrationTransport (fx: P2pStagingFixture, strandId: string): P2pRegistrationTransport {
    const port = fx.makePort()
    return new P2pRegistrationTransport({
      openStrand: async () => port as unknown as RegistrationStrandPort,
      computeDigest: async (init, requesterKey) => await fx.fixtureRequestDigest(init, requesterKey),
      strandId,
      sealer: fx.sealer,
      opener: fx.opener,
      decisionSigner: fx.decisionSigner
    })
  }

  let associationStrandSeq = 0
  function buildAssociationTransport (fx: P2pStagingFixture, opts?: { opener?: ReassociationOpener }): P2pAssociationTransport {
    associationStrandSeq += 1
    const port = fx.makePort()
    return new P2pAssociationTransport({
      openStrand: async () => port as unknown as AssociationStrandPort,
      // D-03/D-05: the REAL canonical digests (association-request-digest.ts), NOT the fixture's
      // fake one — the staged signature must also satisfy `AssociationRequest.SignatureValid`
      // when it is reused, unchanged, by `AssociationEngine.submitAssociationRequest` below.
      computeDigest: async (init, requesterKey) => digestToBytes(computeAssociationRequestDigest(init, requesterKey)),
      computeAttestationDigest: async (answer) => digestToBytes(computeAssociationAttestationDigest(answer)),
      strandId: `reassoc-assoc-strand-${associationStrandSeq}`,
      sealer: fx.sealer,
      opener: (opts?.opener as typeof fx.opener | undefined) ?? fx.opener,
      decisionSigner: fx.decisionSigner
    })
  }

  function makeRegistrationPayload (authorityId: string, registrantId: string, publicOverrides?: Partial<NonNullable<RegisterInit['public']>>): RegisterInit {
    return {
      registrant: { id: registrantId, authorityId, expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000) },
      public: { firstName: 'Reassoc', lastName: 'Tester', district: 'D1', ...publicOverrides },
      private: { expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000), details: [{ name: 'note', value: 'reassoc-test-detail' }] }
    }
  }

  async function getRegistrantTask (engine: SignatureTasksEngine, requestId: string): Promise<RegistrantSignatureTask> {
    const tasks = await engine.getRequestedSignatures(true)
    const found = tasks.find(
      (t) => t.signatureType === 'registrant' && (t as RegistrantSignatureTask).requestId === requestId
    ) as RegistrantSignatureTask | undefined
    if (found === undefined) throw new Error(`getRegistrantTask: no task found for requestId=${requestId}`)
    return found
  }

  /** Runs a full registration -> officer-approval ceremony and returns a registrant R approved
   * under `fixture.auth.authority.id`, whose own `RegistrationRequestStaging` row carries the
   * D-45 registration code. */
  async function approveRegistration (
    publicOverrides?: Partial<NonNullable<RegisterInit['public']>>
  ): Promise<{ registrantId: string; requestId: string; voterSign: (digest: Uint8Array) => Promise<Signature>; voterPublicHex: string; code: string }> {
    const voter = randomTestKeyPair()
    const voterSign = makeCallbackSigner(voter)
    const registrantId = `reassoc-registrant-${crypto.randomUUID()}`
    const requestId = crypto.randomUUID()
    const payload = makeRegistrationPayload(fixture.auth.authority.id, registrantId, publicOverrides)
    const init: RegistrationRequestInit = {
      id: requestId,
      authorityId: fixture.auth.authority.id,
      payload,
      submittedAt: toIsoZDatetime(Date.now())
    }
    const code = await deriveRegistrationCodeWith(registrantId, voterSign)

    await registrationTransport.submitRequest(init, voter.publicHex, voterSign, { registrationCode: code })

    const registrationEngine = new RegistrationEngine(fixture.auth.ctx)
    await registrationEngine.submitRegistrationRequest(init, voter.publicHex, voterSign)

    const tasksEngine = new SignatureTasksEngine(
      { hash: 'reassoc-test-network-hash', name: 'Reassoc Test Network', relays: [], primaryAuthorityDomainName: 'reassoc-test.example' },
      fixture.auth.ctx
    )
    const task = await getRegistrantTask(tasksEngine, requestId)
    const digestBytes = await tasksEngine.getSignatureDigest(task)
    const headerSignature = await officerSign(digestBytes)
    await tasksEngine.completeSignature(task, {
      isAccepted: true,
      signature: headerSignature,
      sign: officerSign,
      decision: { checklist: ['id'] as RegistrationVerificationChecklistItem[] }
    })

    return { registrantId, requestId, voterSign, voterPublicHex: voter.publicHex, code }
  }

  let deviceAttestationSeq = 0
  function makeDeviceAttestation (overrides?: Partial<DeviceAttestation>): DeviceAttestation {
    deviceAttestationSeq += 1
    return {
      publicKey: `reassoc-device-pubkey-${deviceAttestationSeq}`,
      deviceId: `reassoc-device-id-${Date.now()}-${deviceAttestationSeq}`,
      attestationTime: Date.now(),
      certificateChain: ['reassoc-cert-a', 'reassoc-cert-b'],
      ...overrides
    }
  }

  /** Stages a sentinel AssociationRequest over `transport`, then inserts the real 'p' row via the
   * SAME staged `(init, requesterKey, signature)` — the test-harness intake step 62-18's own plan
   * text describes (the engine's `AssociationRequest.SignatureValid` CHECK re-verifies against the
   * REAL digest, which is why `buildAssociationTransport` injects the real one, not the fixture's). */
  async function submitSentinelRequest (
    transport: P2pAssociationTransport,
    deviceKeyPair: TestKeyPair,
    extras?: { registrationCode?: string; identityFields?: AssociationIdentityField[] }
  ): Promise<string> {
    const requestId = crypto.randomUUID()
    const init: AssociationRequestInit = {
      id: requestId,
      authorityId: fixture.auth.authority.id,
      registrantId: REASSOCIATION_UNRESOLVED_REGISTRANT_ID,
      deviceKey: deviceKeyPair.publicHex,
      submittedAt: toIsoZDatetime(Date.now())
    }
    const sign = makeCallbackSigner(deviceKeyPair)
    await transport.submitRequest(init, deviceKeyPair.publicHex, sign, extras)
    const staged = await transport.readStagedRequests()
    const doc = staged.find((d) => d.requestId === requestId)
    if (doc === undefined) throw new Error('submitSentinelRequest: staged row not found immediately after submit')
    await associationEngine.submitAssociationRequest(doc.init, doc.requesterKey, doc.signature)
    return requestId
  }

  async function readChallengeNonce (requestId: string): Promise<string> {
    const row = await fixture.auth.ctx.db.prepare('select ChallengeNonce from AssociationRequest where Id = :id').get({ id: requestId })
    const nonce = row?.ChallengeNonce as string | undefined
    if (!nonce) throw new Error(`readChallengeNonce: no ChallengeNonce for requestId=${requestId}`)
    return nonce
  }

  async function stageSentinelAttestation (
    transport: P2pAssociationTransport,
    requestId: string,
    deviceKeyPair: TestKeyPair,
    attestation: DeviceAttestation
  ): Promise<void> {
    const nonce = await readChallengeNonce(requestId)
    const answer = { requestId, nonce, attestation }
    await transport.submitAttestation(answer, deviceKeyPair.publicHex, makeCallbackSigner(deviceKeyPair))
  }

  async function countVrgAdminSigning (): Promise<number> {
    const row = await fixture.auth.ctx.db.prepare("select count(*) as n from AdminSigning where Scope = 'vrg'").get({})
    return Number(row?.n ?? 0)
  }

  // -----------------------------------------------------------------------------------------
  // Code, default manual (D-45, D-46)
  // -----------------------------------------------------------------------------------------

  describe('code match, default manual review (D-45, D-46)', () => {
    it('a sentinel request staged with the registration code (normalized and lower-case-hyphenated) resolves to the registrant, stays p with no policy row, and surfaces as a manual review', async () => {
      const { registrantId, code } = await approveRegistration()
      const transport = buildAssociationTransport(fixture)
      const deviceB = randomTestKeyPair()
      const requestId = await submitSentinelRequest(transport, deviceB, { registrationCode: formatRegistrationCode(code).toLowerCase() })

      const summary = await associationEngine.processPendingReassociations(fixture.auth.authority.id, officerSign, transport, fixture.opener)
      expect(summary.awaitingReview, 'no policy row -> manual, awaiting review').to.equal(1)
      expect(summary.challengesIssued).to.equal(0)

      const reviews = await associationEngine.listPendingReassociations(fixture.auth.authority.id, transport, fixture.opener)
      const review = reviews.find((r) => r.requestId === requestId)
      expect(review, 'the pending review is listed').to.not.equal(undefined)
      expect(review!.evidence).to.deep.equal({ kind: 'code', outcome: 'matched' })
      expect(review!.resolvedRegistrantId).to.equal(registrantId)
      expect(review!.matchMethod).to.equal('code')
      expect(review!.route).to.equal('manual')
      expect(review!.existingDevices).to.have.lengthOf(0)
    })
  })

  // -----------------------------------------------------------------------------------------
  // Officer approval completes a code-matched request (D-41)
  // -----------------------------------------------------------------------------------------

  describe('officer approval completes a code-matched request (D-41)', () => {
    it('approveReassociation issues a challenge, publishes c, and completing the answer associates exactly one device, publishing a with revokesDeviceKey + matchMethod', async () => {
      const { registrantId, code } = await approveRegistration()
      const transport = buildAssociationTransport(fixture)

      // Device A — the registrant's existing (first) device.
      const deviceA = randomTestKeyPair()
      const challengeA = await associationEngine.issueAttestationChallenge(registrantId, deviceA.publicHex, officerSign)
      await associationEngine.associate(
        { registrantId, deviceKey: deviceA.publicHex, nonce: challengeA.nonce, attestation: makeDeviceAttestation() },
        officerSign
      )

      // Device B — the re-association request.
      const deviceB = randomTestKeyPair()
      const requestId = await submitSentinelRequest(transport, deviceB, { registrationCode: code })

      const approval = await associationEngine.approveReassociation(requestId, { registrantId }, officerSign, transport, fixture.opener)
      expect(approval.outcome).to.equal('awaiting-device-attestation')
      expect(approval.matchMethod).to.equal('code')
      expect(approval.devicesToRetire).to.deep.equal([deviceA.publicHex])

      const cRow = await fixture.auth.ctx.db.prepare('select Status, ChallengeNonce from AssociationRequest where Id = :id').get({ id: requestId })
      expect(cRow?.Status).to.equal('c')
      expect(cRow?.ChallengeNonce).to.equal(approval.challengeNonce)

      await stageSentinelAttestation(transport, requestId, deviceB, makeDeviceAttestation())
      const summary = await associationEngine.processPendingReassociations(fixture.auth.authority.id, officerSign, transport, fixture.opener)
      expect(summary.associated).to.equal(1)

      const associations = await associationEngine.getAssociations(registrantId)
      expect(associations).to.have.lengthOf(1)
      expect(associations[0]!.deviceKey).to.equal(deviceB.publicHex)

      const decisionRecords = await transport.readDecisionRecords()
      const aDecision = decisionRecords.find((d) => d.requestId === requestId && d.status === 'a')
      expect(aDecision, 'an a decision was published').to.not.equal(undefined)
      expect(aDecision!.revokesDeviceKey).to.equal(deviceA.publicHex)
      expect(aDecision!.matchMethod).to.equal('code')

      const retirementViaDb = await associationEngine.getDeviceRetirement(deviceA.publicHex)
      expect(retirementViaDb?.requestId).to.equal(requestId)
      const retirementViaTransport = await associationEngine.getDeviceRetirement(deviceA.publicHex, transport)
      expect(retirementViaTransport?.requestId).to.equal(requestId)
      const retirementForB = await associationEngine.getDeviceRetirement(deviceB.publicHex)
      expect(retirementForB, 'the NEW device is never reported retired').to.equal(undefined)
    })
  })

  // -----------------------------------------------------------------------------------------
  // Rejection (D-41: the old device is untouched)
  // -----------------------------------------------------------------------------------------

  describe('officer rejection (D-41)', () => {
    it('rejectReassociation ends the row r with REASSOCIATION_NOT_APPROVED_REASON, publishes r with no revokesDeviceKey, mints no challenge, and leaves the existing device untouched', async () => {
      const { registrantId, code } = await approveRegistration()
      const transport = buildAssociationTransport(fixture)

      const deviceA = randomTestKeyPair()
      const challengeA = await associationEngine.issueAttestationChallenge(registrantId, deviceA.publicHex, officerSign)
      await associationEngine.associate(
        { registrantId, deviceKey: deviceA.publicHex, nonce: challengeA.nonce, attestation: makeDeviceAttestation() },
        officerSign
      )

      const deviceB = randomTestKeyPair()
      const requestId = await submitSentinelRequest(transport, deviceB, { registrationCode: code })

      const challengeCountBefore = await countAttestationChallenges(deviceB.publicHex)
      const result = await associationEngine.rejectReassociation(requestId, officerSign, transport)
      expect(result.reason).to.equal(REASSOCIATION_NOT_APPROVED_REASON)

      const row = await fixture.auth.ctx.db.prepare('select Status, RejectionReason from AssociationRequest where Id = :id').get({ id: requestId })
      expect(row?.Status).to.equal('r')
      expect(row?.RejectionReason).to.equal(REASSOCIATION_NOT_APPROVED_REASON)

      const challengeCountAfter = await countAttestationChallenges(deviceB.publicHex)
      expect(challengeCountAfter).to.equal(challengeCountBefore)

      const decisionRecords = await transport.readDecisionRecords()
      const rDecision = decisionRecords.find((d) => d.requestId === requestId && d.status === 'r')
      expect(rDecision?.reason).to.equal(REASSOCIATION_NOT_APPROVED_REASON)
      expect(rDecision?.revokesDeviceKey).to.equal(undefined)

      const associations = await associationEngine.getAssociations(registrantId)
      expect(associations.map((a) => a.deviceKey)).to.deep.equal([deviceA.publicHex])
    })
  })

  async function countAttestationChallenges (deviceKey: string): Promise<number> {
    const row = await fixture.auth.ctx.db.prepare('select count(*) as n from AttestationChallenge where DeviceKey = :deviceKey').get({ deviceKey })
    return Number(row?.n ?? 0)
  }

  // -----------------------------------------------------------------------------------------
  // Attestation failure at completion
  // -----------------------------------------------------------------------------------------

  describe('attestation failure at completion', () => {
    it("after approval, a failing attestation ends the row r with 'attestation-verification-failed', and the existing device remains the only Association", async () => {
      const { registrantId, code } = await approveRegistration()
      const transport = buildAssociationTransport(fixture)

      const deviceA = randomTestKeyPair()
      const challengeA = await associationEngine.issueAttestationChallenge(registrantId, deviceA.publicHex, officerSign)
      await associationEngine.associate(
        { registrantId, deviceKey: deviceA.publicHex, nonce: challengeA.nonce, attestation: makeDeviceAttestation() },
        officerSign
      )

      const rejectingEngine = new AssociationEngine(fixture.auth.ctx, { async verify () { return { ok: false, reason: 'simulated 62-18 completion failure' } } })

      const deviceB = randomTestKeyPair()
      const requestId = await submitSentinelRequest(transport, deviceB, { registrationCode: code })
      await associationEngine.approveReassociation(requestId, { registrantId }, officerSign, transport, fixture.opener)
      await stageSentinelAttestation(transport, requestId, deviceB, makeDeviceAttestation())

      const summary = await rejectingEngine.processPendingReassociations(fixture.auth.authority.id, officerSign, transport, fixture.opener)
      expect(summary.rejected).to.equal(1)

      const row = await fixture.auth.ctx.db.prepare('select Status, RejectionReason from AssociationRequest where Id = :id').get({ id: requestId })
      expect(row?.Status).to.equal('r')
      expect(row?.RejectionReason).to.equal('attestation-verification-failed')

      const associations = await associationEngine.getAssociations(registrantId)
      expect(associations.map((a) => a.deviceKey)).to.deep.equal([deviceA.publicHex])
    })
  })

  // -----------------------------------------------------------------------------------------
  // Automatic (D-46) + identity fallback always manual + unmatched/unverifiable never auto-approve
  // -----------------------------------------------------------------------------------------

  describe('automatic policy (D-46)', () => {
    before(async () => {
      await new IntakeEngine(fixture.auth.ctx).setIntakePolicy({ authorityId: fixture.auth.authority.id, reassociationMode: 'automatic' }, officerSign)
    })

    it('a code-matched sentinel request reaches c in the same processPendingReassociations call with no officer call', async () => {
      const { registrantId, code } = await approveRegistration()
      const transport = buildAssociationTransport(fixture)
      const deviceB = randomTestKeyPair()
      const requestId = await submitSentinelRequest(transport, deviceB, { registrationCode: code })

      const summary = await associationEngine.processPendingReassociations(fixture.auth.authority.id, officerSign, transport, fixture.opener)
      expect(summary.challengesIssued).to.equal(1)
      const row = await fixture.auth.ctx.db.prepare('select Status from AssociationRequest where Id = :id').get({ id: requestId })
      expect(row?.Status).to.equal('c')

      await stageSentinelAttestation(transport, requestId, deviceB, makeDeviceAttestation())
      const secondRun = await associationEngine.processPendingReassociations(fixture.auth.authority.id, officerSign, transport, fixture.opener)
      expect(secondRun.associated).to.equal(1)
      const associations = await associationEngine.getAssociations(registrantId)
      expect(associations.map((a) => a.deviceKey)).to.deep.equal([deviceB.publicHex])
    })

    it('identity evidence under the automatic policy still stays p (always manual, D-45/D-46) with ranked candidates', async () => {
      const r1 = await approveRegistration({ firstName: 'Primary', lastName: 'Match', district: 'D9' })
      const r2 = await approveRegistration({ firstName: 'Other', lastName: 'Match', district: 'D10' })
      const transport = buildAssociationTransport(fixture)
      const deviceB = randomTestKeyPair()
      const identityFields: AssociationIdentityField[] = [
        { name: 'firstName', value: 'Primary' },
        { name: 'lastName', value: 'Match' },
        { name: 'district', value: 'D9' }
      ]
      const requestId = await submitSentinelRequest(transport, deviceB, { identityFields })

      const summary = await associationEngine.processPendingReassociations(fixture.auth.authority.id, officerSign, transport, fixture.opener)
      expect(summary.awaitingReview).to.be.greaterThan(0)
      const row = await fixture.auth.ctx.db.prepare('select Status from AssociationRequest where Id = :id').get({ id: requestId })
      expect(row?.Status).to.equal('p')

      const review = await associationEngine.getReassociationReview(requestId, transport, fixture.opener, { registrantId: r1.registrantId })
      expect(review).to.not.equal(undefined)
      expect(review!.evidence.kind).to.equal('identity')
      expect(review!.matchMethod).to.equal('identity')
      expect(review!.route).to.equal('manual')
      expect(review!.candidates.length).to.be.greaterThan(0)
      expect(review!.candidates[0]!.registrantId).to.equal(r1.registrantId)
      expect(review!.candidates[0]!.matchedFieldNames.length).to.equal(3)
      const r2Candidate = review!.candidates.find((c) => c.registrantId === r2.registrantId)
      expect(r2Candidate, 'the weaker (lastName-only) match is still ranked, below the primary one').to.not.equal(undefined)
      expect(r2Candidate!.matchedFieldNames).to.deep.equal(['lastName'])
      expect(review!.registrantRecord, 'resolved via options.registrantId -> registrantRecord is filled').to.not.equal(undefined)
      expect(review!.registrantName).to.equal('Primary Match')
      expect(review!.existingDevices).to.have.lengthOf(0)
    })

    it('a wrong code under the automatic policy gives outcome unmatched and route manual; approving it anyway still works via explicit officer choice', async () => {
      const { registrantId } = await approveRegistration()
      const transport = buildAssociationTransport(fixture)
      const deviceB = randomTestKeyPair()
      const requestId = await submitSentinelRequest(transport, deviceB, { registrationCode: 'ZZZZZ-ZZZZZ' })

      const summary = await associationEngine.processPendingReassociations(fixture.auth.authority.id, officerSign, transport, fixture.opener)
      expect(summary.challengesIssued).to.equal(0)
      // NOTE: this describe block shares ONE authority/fixture across sibling tests, so
      // awaitingReview is cumulative across every still-'p' sentinel row at this authority (a
      // prior test's own manual-review row is still pending) — assert "at least this one", not
      // an exact count that would depend on sibling-test execution order.
      expect(summary.awaitingReview).to.be.greaterThan(0)

      const review = await associationEngine.getReassociationReview(requestId, transport, fixture.opener)
      expect(review!.evidence).to.deep.equal({ kind: 'code', outcome: 'unmatched' })
      expect(review!.route).to.equal('manual')

      const approval = await associationEngine.approveReassociation(requestId, { registrantId }, officerSign, transport, fixture.opener)
      expect(approval).to.include({ matchMethod: 'identity' })
    })

    it("the fixture's outsider opener cannot open the registration staging row, so the code outcome is unverifiable and the route is manual", async () => {
      const { registrantId, code } = await approveRegistration()
      // Staging/intake uses the fixture's NORMAL opener (the row must actually be readable to get
      // inserted as a real 'p' row at all) — only the REVIEW step below uses the outsider opener,
      // exactly as the production API shape separates `intake` (transport) from `opener`.
      const transport = buildAssociationTransport(fixture)
      const deviceB = randomTestKeyPair()
      const requestId = await submitSentinelRequest(transport, deviceB, { registrationCode: code })

      const review = await associationEngine.getReassociationReview(requestId, transport, fixture.outsiderOpener)
      expect(review!.evidence).to.deep.equal({ kind: 'code', outcome: 'unverifiable' })
      expect(review!.route).to.equal('manual')
      void registrantId
    })

    it('a request with neither a code nor identity fields gives evidence kind none', async () => {
      const transport = buildAssociationTransport(fixture)
      const deviceB = randomTestKeyPair()
      const requestId = await submitSentinelRequest(transport, deviceB)

      const review = await associationEngine.getReassociationReview(requestId, transport, fixture.opener)
      expect(review!.evidence).to.deep.equal({ kind: 'none' })
      expect(review!.route).to.equal('manual')
    })
  })

  // -----------------------------------------------------------------------------------------
  // Approval refusals — each leaving zero new AdminSigning rows
  // -----------------------------------------------------------------------------------------

  describe('approval refusals (zero new AdminSigning rows on every refusal)', () => {
    it('an unknown requestId gives not-found', async () => {
      const transport = buildAssociationTransport(fixture)
      const before = await countVrgAdminSigning()
      let caught: ReassociationError | undefined
      try {
        await associationEngine.approveReassociation('reassoc-nonexistent-request', { registrantId: 'reassoc-nonexistent-registrant' }, officerSign, transport, fixture.opener)
      } catch (err) {
        caught = err as ReassociationError
      }
      expect(caught).to.be.instanceOf(ReassociationError)
      expect(caught!.code).to.equal('not-found')
      expect(await countVrgAdminSigning()).to.equal(before)
    })

    it('a non-sentinel (normal first-association) row gives not-a-reassociation', async () => {
      const { registrantId } = await approveRegistration()
      const normalDevice = randomTestKeyPair()
      const requestId = crypto.randomUUID()
      const init: AssociationRequestInit = {
        id: requestId,
        authorityId: fixture.auth.authority.id,
        registrantId,
        deviceKey: normalDevice.publicHex,
        submittedAt: toIsoZDatetime(Date.now())
      }
      await associationEngine.submitAssociationRequest(init, normalDevice.publicHex, makeCallbackSigner(normalDevice))

      const transport = buildAssociationTransport(fixture)
      const before = await countVrgAdminSigning()
      let caught: ReassociationError | undefined
      try {
        await associationEngine.approveReassociation(requestId, { registrantId }, officerSign, transport, fixture.opener)
      } catch (err) {
        caught = err as ReassociationError
      }
      expect(caught).to.be.instanceOf(ReassociationError)
      expect(caught!.code).to.equal('not-a-reassociation')
      expect(await countVrgAdminSigning()).to.equal(before)
    })

    it('a c row (already approved once) gives not-pending', async () => {
      const { registrantId, code } = await approveRegistration()
      const transport = buildAssociationTransport(fixture)
      const deviceB = randomTestKeyPair()
      const requestId = await submitSentinelRequest(transport, deviceB, { registrationCode: code })
      await associationEngine.approveReassociation(requestId, { registrantId }, officerSign, transport, fixture.opener)

      const before = await countVrgAdminSigning()
      let caught: ReassociationError | undefined
      try {
        await associationEngine.approveReassociation(requestId, { registrantId }, officerSign, transport, fixture.opener)
      } catch (err) {
        caught = err as ReassociationError
      }
      expect(caught).to.be.instanceOf(ReassociationError)
      expect(caught!.code).to.equal('not-pending')
      expect(await countVrgAdminSigning()).to.equal(before)
    })

    it('a code-matched request approved for a DIFFERENT registrant gives code-registrant-mismatch', async () => {
      const r1 = await approveRegistration()
      const r2 = await approveRegistration()
      const transport = buildAssociationTransport(fixture)
      const deviceB = randomTestKeyPair()
      const requestId = await submitSentinelRequest(transport, deviceB, { registrationCode: r1.code })

      const before = await countVrgAdminSigning()
      let caught: ReassociationError | undefined
      try {
        await associationEngine.approveReassociation(requestId, { registrantId: r2.registrantId }, officerSign, transport, fixture.opener)
      } catch (err) {
        caught = err as ReassociationError
      }
      expect(caught).to.be.instanceOf(ReassociationError)
      expect(caught!.code).to.equal('code-registrant-mismatch')
      expect(await countVrgAdminSigning()).to.equal(before)
    })

    it('an unknown/inactive registrantId gives registrant-not-active', async () => {
      const transport = buildAssociationTransport(fixture)
      const deviceB = randomTestKeyPair()
      const requestId = await submitSentinelRequest(transport, deviceB)

      const before = await countVrgAdminSigning()
      let caught: ReassociationError | undefined
      try {
        await associationEngine.approveReassociation(requestId, { registrantId: 'reassoc-never-registered' }, officerSign, transport, fixture.opener)
      } catch (err) {
        caught = err as ReassociationError
      }
      expect(caught).to.be.instanceOf(ReassociationError)
      expect(caught!.code).to.equal('registrant-not-active')
      expect(await countVrgAdminSigning()).to.equal(before)
    })

    it('a registrant of a SIBLING authority gives registrant-authority-mismatch', async () => {
      const siblingAuthorityId = await addSiblingAuthority(fixture.auth)
      const siblingRegistrantId = `reassoc-sibling-registrant-${crypto.randomUUID()}`
      await new RegistrationEngine(fixture.auth.ctx).createRegistrant(
        { id: siblingRegistrantId, authorityId: siblingAuthorityId, privateCid: 'reassoc-sibling-private-cid', expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000) },
        makeTestSignCallback(fixture.auth.user)
      )

      const transport = buildAssociationTransport(fixture)
      const deviceB = randomTestKeyPair()
      const requestId = await submitSentinelRequest(transport, deviceB)

      const before = await countVrgAdminSigning()
      let caught: ReassociationError | undefined
      try {
        await associationEngine.approveReassociation(requestId, { registrantId: siblingRegistrantId }, officerSign, transport, fixture.opener)
      } catch (err) {
        caught = err as ReassociationError
      }
      expect(caught).to.be.instanceOf(ReassociationError)
      expect(caught!.code).to.equal('registrant-authority-mismatch')
      expect(await countVrgAdminSigning()).to.equal(before)
    })
  })

  // -----------------------------------------------------------------------------------------
  // Threshold refusal (self-contained — a SEPARATE vrg-threshold-2 authority)
  // -----------------------------------------------------------------------------------------

  describe('threshold gate (vrg > 1)', () => {
    it("approveReassociation and rejectReassociation both refuse threshold-requires-co-sign before any write", async () => {
      const threshAuth = await createThresholdAuthority()
      const authorityId = threshAuth.authorityId
      const ctx = threshAuth.elec.ctx
      await provisionTestIntakeRecipient(ctx, authorityId)

      // Get a REAL active registrant under this vrg:2 authority through the full co-sign flow
      // (createRegistrant's own single-signer ceremony is threshold-1-only and cannot be used
      // directly against a vrg:2 roster — see threshold-vrg.spec.ts's identical pattern).
      const voter = randomTestKeyPair()
      const registrantId = `reassoc-thresh-registrant-${crypto.randomUUID()}`
      const regInit: RegistrationRequestInit = {
        id: crypto.randomUUID(),
        authorityId,
        payload: {
          registrant: { id: registrantId, authorityId, expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000) },
          private: { expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000), details: [] }
        },
        submittedAt: toIsoZDatetime(Date.now())
      }
      await new RegistrationEngine(ctx).submitRegistrationRequest(regInit, voter.publicHex, makeCallbackSigner(voter))
      const threshNetworkRef = { hash: 'reassoc-thresh-hash', name: 'Reassoc Thresh Network', relays: [], primaryAuthorityDomainName: 'reassoc-thresh.example' }
      for (const holder of [threshAuth.holders[0]!, threshAuth.holders[1]!]) {
        // D-49 (62-31): every holder reads through the SAME provisioned opener (ctx.intakeOpener,
        // set by provisionTestIntakeRecipient against the founder above) — this test is not about
        // D-49, it needs a real RegistrantSignatureTask (with requestId) to find and sign.
        const tasksEngine = new SignatureTasksEngine(threshNetworkRef, { db: ctx.db, user: holder.user, intakeOpener: ctx.intakeOpener })
        const tasks = await tasksEngine.getRequestedSignatures(true)
        const task = tasks.find((t) => t.signatureType === 'registrant' && (t as RegistrantSignatureTask).requestId === regInit.id) as RegistrantSignatureTask | undefined
        if (task === undefined) throw new Error(`threshold gate test: no pending registrant task for holder=${holder.user.id}`)
        const digest = await tasksEngine.getSignatureDigest(task)
        await tasksEngine.completeSignature(task, { isAccepted: true, signature: await holder.sign(digest), sign: holder.sign, decision: { checklist: ['id'] as RegistrationVerificationChecklistItem[] } })
      }
      const registrantRow = await ctx.db.prepare('select Status from Registrant where Id = :id').get({ id: registrantId })
      expect(registrantRow?.Status, 'the registrant must be real and active before the threshold gate is even reached').to.equal('a')

      const engine = new AssociationEngine(ctx)
      const deviceKeyPair = randomTestKeyPair()
      const requestId = crypto.randomUUID()
      const init: AssociationRequestInit = {
        id: requestId,
        authorityId,
        registrantId: REASSOCIATION_UNRESOLVED_REGISTRANT_ID,
        deviceKey: deviceKeyPair.publicHex,
        submittedAt: toIsoZDatetime(Date.now())
      }
      await engine.submitAssociationRequest(init, deviceKeyPair.publicHex, makeCallbackSigner(deviceKeyPair))

      const fakeIntake: ReassociationIntake = {
        async readStagedRequests () { return [] },
        async readStagedAttestations () { return [] },
        async publishDecision () { throw new Error('fakeIntake.publishDecision must never be called for a threshold-refused approval') }
      }
      const fakeOpener: ReassociationOpener = {
        async open () { return { ok: false, reason: 'not-a-recipient', detail: 'fakeOpener never opens' } }
      }

      const before = await (async () => {
        const row = await ctx.db.prepare("select count(*) as n from AdminSigning where Scope = 'vrg'").get({})
        return Number(row?.n ?? 0)
      })()

      let approveErr: ReassociationError | undefined
      try {
        await engine.approveReassociation(requestId, { registrantId }, threshAuth.holders[0]!.sign, fakeIntake, fakeOpener)
      } catch (err) {
        approveErr = err as ReassociationError
      }
      expect(approveErr).to.be.instanceOf(ReassociationError)
      expect(approveErr!.code).to.equal('threshold-requires-co-sign')

      let rejectErr: ReassociationError | undefined
      try {
        await engine.rejectReassociation(requestId, threshAuth.holders[0]!.sign, fakeIntake)
      } catch (err) {
        rejectErr = err as ReassociationError
      }
      expect(rejectErr).to.be.instanceOf(ReassociationError)
      expect(rejectErr!.code).to.equal('threshold-requires-co-sign')

      const after = await (async () => {
        const row = await ctx.db.prepare("select count(*) as n from AdminSigning where Scope = 'vrg'").get({})
        return Number(row?.n ?? 0)
      })()
      expect(after).to.equal(before)
    })
  })

  // -----------------------------------------------------------------------------------------
  // Structural ports compile
  // -----------------------------------------------------------------------------------------

  describe('structural ports', () => {
    it('a P2pAssociationTransport satisfies ReassociationIntake, and the fixture opener satisfies ReassociationOpener, under tsconfig.test.json', async () => {
      const transport = buildAssociationTransport(fixture)
      const asIntake: ReassociationIntake = transport
      const asOpener: ReassociationOpener = fixture.opener
      expect(typeof asIntake.readStagedRequests).to.equal('function')
      expect(typeof asIntake.readStagedAttestations).to.equal('function')
      expect(typeof asIntake.publishDecision).to.equal('function')
      expect(typeof asOpener.open).to.equal('function')
      const asDecisionSource: ReassociationDecisionSource = transport
      expect(typeof asDecisionSource.readDecisionRecords).to.equal('function')
    })
  })

  // -----------------------------------------------------------------------------------------
  // Plaintext gates (T-62-01-10)
  // -----------------------------------------------------------------------------------------

  describe('plaintext gates (T-62-01-10)', () => {
    it('after the code and identity flows, raw rows across every table this flow writes contain neither the code nor the identity marker; the source files write no SQL and log nothing', async () => {
      const { registrantId, code } = await approveRegistration({ firstName: 'PlaintextProbe', lastName: fixture.payloadMarker, district: 'D1' })
      const transport = buildAssociationTransport(fixture)

      const deviceCode = randomTestKeyPair()
      await submitSentinelRequest(transport, deviceCode, { registrationCode: code })

      const deviceIdentity = randomTestKeyPair()
      await submitSentinelRequest(transport, deviceIdentity, { identityFields: [{ name: 'lastName', value: fixture.payloadMarker }] })

      const originalWarn = console.warn
      const originalLog = console.log
      const captured: string[] = []
      console.warn = (...args: unknown[]) => { captured.push(args.map(String).join(' ')) }
      console.log = (...args: unknown[]) => { captured.push(args.map(String).join(' ')) }
      try {
        await associationEngine.processPendingReassociations(fixture.auth.authority.id, officerSign, transport, fixture.opener)
        await associationEngine.listPendingReassociations(fixture.auth.authority.id, transport, fixture.opener)
      } finally {
        console.warn = originalWarn
        console.log = originalLog
      }

      const tablesToScan = ['AssociationRequest', 'AssociationDecision', 'AttestationChallenge', 'AdminSigning', 'Association', 'AssociationPrivate', 'AttestationVerdict']
      for (const table of tablesToScan) {
        const rows: Array<Record<string, unknown>> = []
        for await (const row of fixture.auth.ctx.db.eval(`select * from ${table}`, {})) rows.push(row as Record<string, unknown>)
        const rawText = JSON.stringify(rows)
        expect(rawText.includes(code), `${table} must not carry the raw registration code`).to.equal(false)
        expect(rawText.includes(fixture.payloadMarker), `${table} must not carry the identity marker value`).to.equal(false)
      }

      const capturedText = captured.join('\n')
      expect(capturedText.includes(code), 'console output must not carry the raw code').to.equal(false)
      expect(capturedText.includes(fixture.payloadMarker), 'console output must not carry the identity marker').to.equal(false)

      void registrantId
    })

    it('src/association/reassociation/*.ts contains no insert into, update <Table>, .exec( or console. (comments stripped)', async () => {
      const { readFile, readdir } = await import('node:fs/promises')
      const { fileURLToPath } = await import('node:url')
      const dir = fileURLToPath(new URL('../src/association/reassociation/', import.meta.url))
      const files = (await readdir(dir)).filter((f) => f.endsWith('.ts'))
      expect(files.length).to.be.greaterThan(0)
      for (const file of files) {
        const text = await readFile(`${dir}${file}`, 'utf8')
        const stripped = text.replace(/\/\/.*$/gm, '')
        expect(/insert into/i.test(stripped), `${file}: no insert into`).to.equal(false)
        expect(/update [A-Z]/.test(stripped), `${file}: no update <Table>`).to.equal(false)
        expect(stripped.includes('.exec('), `${file}: no .exec(`).to.equal(false)
        expect(stripped.includes('console.'), `${file}: no console.`).to.equal(false)
      }
    })
  })
})

// =============================================================================================
// MockAssociationEngine — IReassociationEngine parity
// =============================================================================================

describe('MockAssociationEngine — IReassociationEngine parity', () => {
  it('implements every IReassociationEngine method: seeded reviews list and approve, a rejection is recorded, a seeded retirement is returned, deriveRegistrationCode returns a valid 10-char code', async () => {
    const mock: IReassociationEngine = new MockAssociationEngine()
    const fakeIntake: ReassociationIntake = {
      async readStagedRequests () { return [] },
      async readStagedAttestations () { return [] },
      async publishDecision () { return 'mock-cursor' }
    }
    const fakeOpener: ReassociationOpener = {
      async open () { return { ok: false, reason: 'not-a-recipient', detail: 'mock opener' } }
    }

    const review: Parameters<MockAssociationEngine['seedReassociationReview']>[0] = {
      requestId: 'mock-reassoc-request',
      authorityId: 'mock-authority',
      status: 'p',
      newDeviceKey: 'mock-device-key',
      submittedAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      evidence: { kind: 'code', outcome: 'matched' },
      resolvedRegistrantId: 'mock-registrant',
      candidates: [],
      existingDevices: [],
      matchMethod: 'code',
      route: 'manual'
    }
    ;(mock as MockAssociationEngine).seedReassociationReview(review)
    const listed = await mock.listPendingReassociations('mock-authority', fakeIntake, fakeOpener)
    expect(listed).to.have.lengthOf(1)
    expect(listed[0]!.requestId).to.equal('mock-reassoc-request')

    const gotten = await mock.getReassociationReview('mock-reassoc-request', fakeIntake, fakeOpener)
    expect(gotten?.requestId).to.equal('mock-reassoc-request')

    const approval = await mock.approveReassociation('mock-reassoc-request', { registrantId: 'mock-registrant' }, async () => ({ signature: '', signerKey: '', signerUserId: '' }), fakeIntake, fakeOpener)
    expect(approval.outcome).to.equal('awaiting-device-attestation')
    expect((mock as MockAssociationEngine).approvedReassociations).to.deep.equal([{ requestId: 'mock-reassoc-request', registrantId: 'mock-registrant' }])

    const rejection = await mock.rejectReassociation('mock-reassoc-request-2', async () => ({ signature: '', signerKey: '', signerUserId: '' }), fakeIntake)
    expect(rejection.reason).to.equal(REASSOCIATION_NOT_APPROVED_REASON)
    expect((mock as MockAssociationEngine).rejectedReassociations).to.deep.equal(['mock-reassoc-request-2'])

    const retirement = { deviceKey: 'mock-old-device', requestId: 'mock-reassoc-request', decidedAt: new Date().toISOString() }
    ;(mock as MockAssociationEngine).seedDeviceRetirement(retirement)
    const gottenRetirement = await mock.getDeviceRetirement('mock-old-device')
    expect(gottenRetirement).to.deep.equal(retirement)
    expect(await mock.getDeviceRetirement('mock-unseeded-device')).to.equal(undefined)

    const code = await mock.deriveRegistrationCode('mock-registrant', async () => ({ signature: '', signerKey: '', signerUserId: '' }))
    expect(code).to.have.lengthOf(REGISTRATION_CODE_LENGTH)
    for (const ch of code) expect(REGISTRATION_CODE_ALPHABET.includes(ch)).to.equal(true)

    const summary = await mock.processPendingReassociations('mock-authority', async () => ({ signature: '', signerKey: '', signerUserId: '' }), fakeIntake, fakeOpener)
    expect(summary.awaitingReview).to.equal(1)
    void REGISTRANT_HAS_ACTIVE_DEVICE_REASON
  })
})
