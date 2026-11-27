/**
 * reassociation-code-evidence.spec.ts — Phase 62 Plan 113 Task 3 (gap1/WR-03 engine half, D-54, D-55).
 *
 * `resolveRegistrantByCode` used to read 'unverifiable' for ANY approved row whose code could not be
 * opened, including bridge/import rows that never had a staging row, so every wrong or mistyped
 * code looked ambiguous. A registration that provably holds no code cannot make a miss ambiguous;
 * unknown content (an unreadable envelope, a code that could be its own but is unbound) still does.
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { REASSOCIATION_UNRESOLVED_REGISTRANT_ID } from '@votetorrent/vote-core'
import type {
  AssociationRequestInit,
  RegistrantSignatureTask,
  RegistrationRequestInit,
  RegistrationVerificationChecklistItem,
  RegisterInit,
  ReassociationOpener,
  Signature
} from '@votetorrent/vote-core'
import { AssociationEngine } from '../src/association/association-engine.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine.js'
import { P2pRegistrationTransport } from '../src/registration/transport/p2p-registration-transport.js'
import type { RegistrationStrandPort } from '../src/registration/transport/p2p-registration-transport.js'
import { P2pAssociationTransport } from '../src/association/transport/p2p-association-transport.js'
import type { AssociationStrandPort } from '../src/association/transport/p2p-association-transport.js'
import { computeAssociationAttestationDigest, computeAssociationRequestDigest } from '../src/association/transport/association-request-digest.js'
import { deriveRegistrationCodeWith } from '../src/association/reassociation/registration-code.js'
import { listApprovedRegistrations, verifyRegistrationCode } from '../src/association/reassociation/evidence.js'
import type { OpenedCode } from '../src/association/reassociation/evidence.js'
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

describe('re-association code evidence — a miss is not an unknown (62-113 Task 3, gap1/WR-03)', function () {
  this.timeout(60_000)

  const STAGING_INSERT =
    'insert into RegistrationRequestStaging (StrandId, Cursor, RequestId, Digest, InitJson, RequesterKey, SignatureJson, StagedAt) ' +
    'values (:strandId, :cursor, :requestId, :digest, :initJson, :requesterKey, :signatureJson, :stagedAt)'

  async function makeWorld () {
    const fixture = await createP2pStagingFixture()
    const ctx = fixture.auth.ctx
    const authorityId = fixture.auth.authority.id
    const officerSign = makeTestSignCallback(fixture.auth.user)
    const vault = new InMemoryTestKeyVault()
    await vault.putSecret(officerEncryptionKeyAlias(fixture.net.user.id), fixture.recipients[0].secretKey, OFFICER_ENCRYPTION_KEY_POLICY)
    await provisionTestIntakeRecipient(ctx, authorityId, { vault })
    const engine = new AssociationEngine(ctx)

    const regPort = fixture.makePort()
    const regTransport = new P2pRegistrationTransport({
      openStrand: async () => regPort as unknown as RegistrationStrandPort,
      computeDigest: async (init, requesterKey) => await fixture.fixtureRequestDigest(init, requesterKey),
      strandId: 'evidence-reg-strand',
      sealer: fixture.sealer,
      opener: fixture.opener,
      decisionSigner: fixture.decisionSigner
    })
    const assocPort = fixture.makePort()
    const transport = new P2pAssociationTransport({
      openStrand: async () => assocPort as unknown as AssociationStrandPort,
      computeDigest: async (init, requesterKey) => digestToBytes(computeAssociationRequestDigest(init, requesterKey)),
      computeAttestationDigest: async (answer) => digestToBytes(computeAssociationAttestationDigest(answer)),
      strandId: `evidence-assoc-strand-${crypto.randomUUID()}`,
      sealer: fixture.sealer,
      opener: fixture.opener,
      decisionSigner: fixture.decisionSigner
    })

    /** Registers + officer-approves a registrant. `staged` = stage its bound code first (P2P shape); else bridge/import shape. */
    async function approve (opts: { staged: boolean }) {
      const voter = randomTestKeyPair()
      const voterSign = makeCallbackSigner(voter)
      const registrantId = `evidence-registrant-${crypto.randomUUID()}`
      const requestId = crypto.randomUUID()
      const payload: RegisterInit = {
        registrant: { id: registrantId, authorityId, expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000) },
        public: { firstName: 'Evidence', lastName: 'Tester', district: 'D1' },
        private: { expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000), details: [] }
      }
      const init: RegistrationRequestInit = { id: requestId, authorityId, payload, submittedAt: toIsoZDatetime(Date.now()) }
      const code = await deriveRegistrationCodeWith(registrantId, voterSign)
      if (opts.staged) await regTransport.submitRequest(init, voter.publicHex, voterSign, { registrationCode: code })
      await new RegistrationEngine(ctx).submitRegistrationRequest(init, voter.publicHex, voterSign)
      const tasksEngine = new SignatureTasksEngine(
        { hash: 'evidence-test-network-hash', name: 'Evidence Test Network', relays: [], primaryAuthorityDomainName: 'evidence-test.example' },
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
      return { registrantId, requestId, voter, voterSign, init, code }
    }

    /** A code of valid format that no registration here holds. */
    async function strangerCode (): Promise<string> {
      return await deriveRegistrationCodeWith(`stranger-${crypto.randomUUID()}`, makeCallbackSigner(randomTestKeyPair()))
    }

    async function insertStaging (strandId: string, row: { requestId: string; digest: string; initJson: string; requesterKey: string; signatureJson: string }): Promise<void> {
      await ctx.db.exec(STAGING_INSERT, { strandId, cursor: '0000000000000001', stagedAt: new Date().toISOString(), ...row })
    }

    /** A pre-binding (legacy) staging row for `victim`: valid signature, carries `code`, no registrationCodeSignature. */
    async function stageLegacy (victim: Awaited<ReturnType<typeof approve>>, code: string): Promise<void> {
      const digestBytes = await fixture.fixtureRequestDigest(victim.init, victim.voter.publicHex)
      const digest = Buffer.from(digestBytes).toString('base64url')
      const signature = await victim.voterSign(digestBytes)
      const initJson = await fixture.sealer.seal(JSON.stringify({ version: 1, init: victim.init, registrationCode: code }), { requestId: victim.requestId, digest })
      await insertStaging('legacy-strand', { requestId: victim.requestId, digest, initJson, requesterKey: victim.voter.publicHex, signatureJson: JSON.stringify(signature) })
    }

    /** A staging row the opener can open whose plaintext fails the version check. */
    async function stageMalformed (victim: Awaited<ReturnType<typeof approve>>): Promise<void> {
      const digestBytes = await fixture.fixtureRequestDigest(victim.init, victim.voter.publicHex)
      const digest = Buffer.from(digestBytes).toString('base64url')
      const signature = await victim.voterSign(digestBytes)
      const initJson = await fixture.sealer.seal(JSON.stringify({ version: 2, init: victim.init }), { requestId: victim.requestId, digest })
      await insertStaging('malformed-strand', { requestId: victim.requestId, digest, initJson, requesterKey: victim.voter.publicHex, signatureJson: JSON.stringify(signature) })
    }

    async function review (code: string, opener: ReassociationOpener = fixture.opener) {
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
      const doc = (await transport.readStagedRequests()).find((d) => d.requestId === requestId)
      if (doc === undefined) throw new Error('staged sentinel not found')
      await engine.submitAssociationRequest(doc.init, doc.requesterKey, doc.signature)
      const result = await engine.getReassociationReview(requestId, transport, opener)
      if (result === undefined) throw new Error('no review')
      return result
    }

    return { fixture, ctx, authorityId, engine, approve, strangerCode, stageLegacy, stageMalformed, insertStaging, review }
  }

  it('E-1: with a bridge-shaped registration and a P2P one, a WRONG code reads unmatched (not unverifiable)', async () => {
    const w = await makeWorld()
    await w.approve({ staged: false })
    await w.approve({ staged: true })
    expect((await w.review(await w.strangerCode())).evidence).to.deep.equal({ kind: 'code', outcome: 'unmatched' })
  })

  it('E-2: the P2P registration\'s own code still matches it (D-55 unchanged), also when its row is replayed byte-identical', async () => {
    const w = await makeWorld()
    await w.approve({ staged: false })
    const p2p = await w.approve({ staged: true })
    const matched = await w.review(p2p.code)
    expect(matched.evidence).to.deep.equal({ kind: 'code', outcome: 'matched' })
    expect(matched.resolvedRegistrantId).to.equal(p2p.registrantId)

    const [row] = await w.fixture.rawRows('RegistrationRequestStaging', 'evidence-reg-strand')
    await w.insertStaging('evidence-replay-strand', {
      requestId: row!.RequestId as string,
      digest: row!.Digest as string,
      initJson: row!.InitJson as string,
      requesterKey: row!.RequesterKey as string,
      signatureJson: row!.SignatureJson as string
    })
    expect((await w.review(p2p.code)).evidence).to.deep.equal({ kind: 'code', outcome: 'matched' })
  })

  it('E-3: a legacy unbound code reads unverifiable only for THAT code; any other code is a plain miss', async () => {
    const w = await makeWorld()
    const legacy = await w.approve({ staged: false })
    await w.stageLegacy(legacy, legacy.code)
    expect((await w.review(legacy.code)).evidence, 'could be theirs, cannot be verified: manual review (D-54)').to.deep.equal({ kind: 'code', outcome: 'unverifiable' })
    const other = await w.review(await w.strangerCode())
    expect(other.evidence).to.deep.equal({ kind: 'code', outcome: 'unmatched' })
    expect(other.route).to.equal('manual')
  })

  it('E-4: unknown content stays conservative: an unopenable row, a malformed plaintext and an unreadable payload all keep a miss unverifiable', async () => {
    const w = await makeWorld()
    const victim = await w.approve({ staged: false })
    const digestBytes = await w.fixture.fixtureRequestDigest(victim.init, victim.voter.publicHex)
    await w.insertStaging('garbage-strand', {
      requestId: victim.requestId, digest: Buffer.from(digestBytes).toString('base64url'), initJson: 'not-an-envelope',
      requesterKey: victim.voter.publicHex, signatureJson: JSON.stringify(await victim.voterSign(digestBytes))
    })
    expect((await w.review(await w.strangerCode())).evidence, 'opener refuses the row').to.deep.equal({ kind: 'code', outcome: 'unverifiable' })

    const w2 = await makeWorld()
    const victim2 = await w2.approve({ staged: false })
    await w2.stageMalformed(victim2)
    expect((await w2.review(await w2.strangerCode())).evidence, 'plaintext fails decode').to.deep.equal({ kind: 'code', outcome: 'unverifiable' })

    const w3 = await makeWorld()
    await w3.approve({ staged: true })
    const refuseAll: ReassociationOpener = { open: async () => ({ ok: false, reason: 'not-a-recipient', detail: 'test' }) }
    expect((await w3.review(await w3.strangerCode(), refuseAll)).evidence, 'approved payloads unreadable (unreadCount > 0)').to.deep.equal({ kind: 'code', outcome: 'unverifiable' })
  })

  it('E-5: verifyRegistrationCode for a single registrant with no code evidence is unverifiable, never matched', async () => {
    const w = await makeWorld()
    const bridgeShape = await w.approve({ staged: false })
    const approved = await listApprovedRegistrations(w.ctx.db, w.authorityId, w.fixture.opener)
    const cache = new Map<string, OpenedCode>()
    expect(await verifyRegistrationCode(w.ctx.db, w.fixture.opener, bridgeShape.code, bridgeShape.registrantId, approved, cache)).to.equal('unverifiable')
    expect(cache.get(bridgeShape.requestId)).to.deep.equal({ status: 'no-evidence' })
  })
})
