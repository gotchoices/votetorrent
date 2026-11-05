/**
 * registration-at-rest-sealing.spec.ts — Phase 62 Plan 31 Task 3 (D-49, T-62-01-10).
 *
 * The single-DB proof that intake and register() store only sealed content in
 * `RegistrationRequest.Payload`/`RegistrantPrivate.PrivateDetails`, that every reader opens through
 * `sealed-registration-content.ts` with the tier-2 PayloadCid recheck, and that every failure mode
 * (no opener, not a recipient, tampered, zero recipients, legacy unsealed rows, D-51 late officers)
 * fails exactly as the plan's `<interfaces>` block declares. P1, P4, P9 and P10 are RED on the
 * unmodified (pre-Task-3) engine — see the SUMMARY for the recorded RED output.
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { RegisterInit, RegistrationRequestInit, Signature } from '@votetorrent/vote-core'
import { RegistrationContentAccessError, RegistrationDuplicateError } from '@votetorrent/vote-core'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine.js'
import { isSealedRegistrationContent } from '../src/registration/sealed-registration-content.js'
import { digestToBytes } from '../src/utils.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'
import type { EngineContext } from '../src/types.js'
import {
  addTestAuthority,
  createTestNetwork,
  makeTestOutsiderOpener,
  makeTestSignCallback,
  provisionTestIntakeRecipient
} from './fixtures/test-context.js'
import type { TestAuthorityContext } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import type { TestKeyPair } from './fixtures/keys.js'
import { createThresholdAuthority } from './fixtures/threshold-authority.js'
import type { ThresholdAuthorityFixture } from './fixtures/threshold-authority.js'

function makeNetworkRef () {
  return { hash: 'test-at-rest-sealing-hash', name: 'Test Network', relays: [] as string[], primaryAuthorityDomainName: 'test.example' }
}

function makeCallbackSigner (keyPair: TestKeyPair): (digest: Uint8Array) => Promise<Signature> {
  const privBytes = hexToBytes(keyPair.privateHex)
  return async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes)
    return { signature: bytesToHex(sig), signerKey: keyPair.publicHex, signerUserId: '' }
  }
}

function randomMarker (): string {
  return `MARKER-D49-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
}

function makePayload (authorityId: string, overrides?: { lastNameMarker?: string; detailValueMarker?: string; registrantId?: string }): RegisterInit {
  return {
    registrant: { id: overrides?.registrantId ?? crypto.randomUUID(), authorityId, expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000) },
    public: { lastName: overrides?.lastNameMarker ?? 'Doe', firstName: 'Jane' },
    private: {
      expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000),
      details: overrides?.detailValueMarker ? [{ name: 'note', value: overrides.detailValueMarker }] : []
    }
  }
}

function makeRequestInit (authorityId: string, payload: RegisterInit, overrides?: Partial<RegistrationRequestInit>): RegistrationRequestInit {
  return {
    id: crypto.randomUUID(),
    authorityId,
    payload,
    submittedAt: toIsoZDatetime(Date.now()),
    ...overrides
  }
}

async function freshAuthority (): Promise<TestAuthorityContext> {
  return addTestAuthority(await createTestNetwork())
}

// --- C8/P15-style leak tripwire: captured across the WHOLE file. ---
const consoleCalls: string[] = []
const originalConsole = { log: console.log, warn: console.warn, error: console.error }
before(() => {
  console.log = (...args: unknown[]) => { consoleCalls.push(args.map(String).join(' ')); }
  console.warn = (...args: unknown[]) => { consoleCalls.push(args.map(String).join(' ')); }
  console.error = (...args: unknown[]) => { consoleCalls.push(args.map(String).join(' ')); }
})
after(() => {
  console.log = originalConsole.log
  console.warn = originalConsole.warn
  console.error = originalConsole.error
})

describe('registration-at-rest-sealing — D-49 (62-31 Task 3)', function () {
  this.timeout(30_000)

  describe('P1 — intake seals', () => {
    it('raw Payload has no marker/lastName substring; is sealed; recipients equal the founder; PayloadCid equals Digest(plaintext)', async () => {
      const auth = await freshAuthority()
      await provisionTestIntakeRecipient(auth.ctx, auth.authority.id)
      const marker = randomMarker()
      const payload = makePayload(auth.authority.id, { lastNameMarker: marker })
      const requester = randomTestKeyPair()
      const init = makeRequestInit(auth.authority.id, payload)
      const engine = new RegistrationEngine(auth.ctx)

      await engine.submitRegistrationRequest(init, requester.publicHex, makeCallbackSigner(requester))

      const row = await auth.ctx.db.prepare('select Payload, PayloadCid from RegistrationRequest where Id = :id').get({ id: init.id })
      expect(row).to.not.be.undefined
      const storedPayload = row!.Payload as string
      expect(storedPayload).to.not.include(marker)
      expect(storedPayload).to.not.include('"lastName"')
      expect(isSealedRegistrationContent(storedPayload)).to.equal(true)

      const { envelopeRecipientUserIds } = await import('../src/crypto/index.js')
      expect(envelopeRecipientUserIds(storedPayload)).to.have.members([auth.user.id])

      const expectedCidRow = await auth.ctx.db.prepare('select Digest(:payload) as d').get({ payload: JSON.stringify(payload) })
      expect(row!.PayloadCid).to.equal(expectedCidRow!.d)
    })
  })

  describe('P2 — officer reads', () => {
    it('getRegistrationRequest opens; listRegistrationRequests carries marker names and matches search; non-matching search returns 0', async () => {
      const auth = await freshAuthority()
      await provisionTestIntakeRecipient(auth.ctx, auth.authority.id)
      const marker = randomMarker()
      const payload = makePayload(auth.authority.id, { lastNameMarker: marker })
      const requester = randomTestKeyPair()
      const init = makeRequestInit(auth.authority.id, payload)
      const engine = new RegistrationEngine(auth.ctx)
      await engine.submitRegistrationRequest(init, requester.publicHex, makeCallbackSigner(requester))

      const read = await engine.getRegistrationRequest(init.id)
      expect(read!.payloadAccess).to.equal('opened')
      expect(read!.payload).to.deep.equal(payload)

      const list = await engine.listRegistrationRequests({ authorityId: auth.authority.id })
      const row = list.rows.find((r) => r.requestId === init.id)
      expect(row).to.not.be.undefined
      expect(row!.lastName).to.equal(marker)
      expect(row!.payloadAccess).to.equal('opened')

      const found = await engine.listRegistrationRequests({ authorityId: auth.authority.id, name: marker.toLowerCase() })
      expect(found.rows.map((r) => r.requestId)).to.include(init.id)
      expect(found.total).to.equal(1)

      const notFound = await engine.listRegistrationRequests({ authorityId: auth.authority.id, name: 'zzz-no-such-name-zzz' })
      expect(notFound.rows.length).to.equal(0)
      expect(notFound.total).to.equal(0)
    })
  })

  describe('P3 — no opener', () => {
    it('getRegistrationRequest/listRegistrationRequests degrade to no-opener; nothing throws; search returns 0/0', async () => {
      const auth = await freshAuthority()
      await provisionTestIntakeRecipient(auth.ctx, auth.authority.id)
      const marker = randomMarker()
      const payload = makePayload(auth.authority.id, { lastNameMarker: marker })
      const requester = randomTestKeyPair()
      const init = makeRequestInit(auth.authority.id, payload)
      await new RegistrationEngine(auth.ctx).submitRegistrationRequest(init, requester.publicHex, makeCallbackSigner(requester))

      const noOpenerEngine = new RegistrationEngine({ db: auth.ctx.db, user: auth.user })
      const read = await noOpenerEngine.getRegistrationRequest(init.id)
      expect(read!.payloadAccess).to.equal('no-opener')
      expect(read!.payload).to.deep.equal({})
      expect(read!.registrantId).to.equal(undefined)

      const search = await noOpenerEngine.listRegistrationRequests({ authorityId: auth.authority.id, name: marker })
      expect(search.rows.length).to.equal(0)
      expect(search.total).to.equal(0)
    })
  })

  describe('P4 — non-recipient', () => {
    it('an outsider opener gives the same no-opener-shaped degrades as P3 (not-a-recipient)', async () => {
      const auth = await freshAuthority()
      await provisionTestIntakeRecipient(auth.ctx, auth.authority.id)
      const marker = randomMarker()
      const payload = makePayload(auth.authority.id, { lastNameMarker: marker })
      const requester = randomTestKeyPair()
      const init = makeRequestInit(auth.authority.id, payload)
      await new RegistrationEngine(auth.ctx).submitRegistrationRequest(init, requester.publicHex, makeCallbackSigner(requester))

      const { opener: outsiderOpener } = await makeTestOutsiderOpener()
      const outsiderCtx = { db: auth.ctx.db, user: auth.user, intakeOpener: outsiderOpener }
      const outsiderEngine = new RegistrationEngine(outsiderCtx)

      const read = await outsiderEngine.getRegistrationRequest(init.id)
      expect(read!.payloadAccess).to.equal('not-a-recipient')
      expect(read!.payload).to.deep.equal({})
      expect(read!.registrantId).to.equal(undefined)

      const search = await outsiderEngine.listRegistrationRequests({ authorityId: auth.authority.id, name: marker })
      expect(search.rows.length).to.equal(0)
      expect(search.total).to.equal(0)
    })
  })

  describe('P5 — tampered envelope at the approval gate', () => {
    it('a copied PayloadCid sealed to a different payload reads tampered and refuses approval with zero new rows', async () => {
      const auth = await freshAuthority()
      await provisionTestIntakeRecipient(auth.ctx, auth.authority.id)
      const requester = randomTestKeyPair()
      const p1 = makePayload(auth.authority.id)
      const p1Json = JSON.stringify(p1)
      const payloadCidRow = await auth.ctx.db.prepare('select Digest(:payload) as d').get({ payload: p1Json })
      const payloadCid = payloadCidRow!.d as string
      const requestId = crypto.randomUUID()
      const submittedAt = toIsoZDatetime(Date.now())

      const { sealRegistrationPayload } = await import('../src/registration/sealed-registration-content.js')
      const p2 = makePayload(auth.authority.id, { lastNameMarker: 'Someone-Else' })
      const sealedP2UnderP1Cid = await sealRegistrationPayload(auth.ctx.db, {
        authorityId: auth.authority.id, requestId, payloadCid, plaintext: JSON.stringify(p2)
      })

      const digestRow = await auth.ctx.db
        .prepare('select Digest(:id, :rowAuthorityId, :requesterKey, :issuerType, :bridgeId, :payloadCid, :submittedAt) as d')
        .get({ id: requestId, rowAuthorityId: auth.authority.id, requesterKey: requester.publicHex, issuerType: 'registrant', bridgeId: null, payloadCid, submittedAt })
      const signature = await makeCallbackSigner(requester)(digestToBytes(digestRow!.d as string))

      await auth.ctx.db.exec(
        `insert into RegistrationRequest (Id, AuthorityId, RequesterKey, IssuerType, BridgeId, Payload, PayloadCid, Status, SubmittedAt, ReceivedAt, RequesterSignature)
         with context SigningNonce = :signingNonce
         values (:id, :rowAuthorityId, :requesterKey, :issuerType, :bridgeId, :payload, :payloadCid, :status, :submittedAt, :receivedAt, :requesterSignature)`,
        {
          id: requestId, rowAuthorityId: auth.authority.id, requesterKey: requester.publicHex, issuerType: 'registrant', bridgeId: null,
          payload: sealedP2UnderP1Cid, payloadCid, status: 'p', submittedAt, receivedAt: submittedAt, requesterSignature: signature.signature, signingNonce: null
        }
      )

      const engine = new RegistrationEngine(auth.ctx)
      const read = await engine.getRegistrationRequest(requestId)
      expect(read!.payloadAccess).to.equal('tampered')

      const tasksEngine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
      // The seed pass creates the Task/RegistrantSignatureTaskExtension row AND the session's
      // AdminSigning row (seeded unconditionally, independent of whether any accept ever succeeds
      // — WR-19's own documented distinction between "a session exists" and "a signature was
      // spent"). beforeCounts is captured AFTER this seed, so it measures only what the FAILED
      // accept attempt itself does: nothing, since the gate fires before signingEngine.sign().
      await tasksEngine.getRequestedSignatures(true)
      const beforeCounts = await countTripleRows(auth.ctx.db, auth.authority.id)
      // getRequestedSignatures degrades a tampered row to the BASE task shape (no requestId field,
      // the EXISTING missing-extension/unparseable-payload fallback) — fine for the inbox list, but
      // getSignatureDigest/completeSignature's own registrant branch is scoped by task.requestId
      // (L-3, 48-11) and cannot resolve a base task. Build the task directly, the way
      // RegistrantSignatureTask is documented (SignatureTask + requestId/payload/submittedAt/
      // issuerType) — completeSignature's own pre-sign gate is what this test proves fires BEFORE
      // any signature is consumed, regardless of how the caller obtained the task.
      const manualTask = {
        type: 'signature' as const,
        userId: auth.user.id,
        network: makeNetworkRef(),
        signatureType: 'registrant' as const,
        requestId,
        payload: p1,
        submittedAt,
        issuerType: 'registrant' as const
      }

      let caught: unknown
      try {
        const digest = await tasksEngine.getSignatureDigest(manualTask)
        await tasksEngine.completeSignature(manualTask, {
          isAccepted: true,
          signature: await makeTestSignCallback(auth.user)(digest),
          sign: makeTestSignCallback(auth.user),
          decision: { checklist: ['id'] }
        })
      } catch (err) {
        caught = err
      }
      expect(caught).to.be.instanceOf(RegistrationContentAccessError)
      expect((caught as RegistrationContentAccessError).access).to.equal('tampered')

      const afterCounts = await countTripleRows(auth.ctx.db, auth.authority.id)
      expect(afterCounts).to.deep.equal(beforeCounts)
    })
  })

  describe('P5b — no-opener at the approval gate (M6 control)', () => {
    it('a sealed request approved from a context with no opener throws RegistrationContentAccessError(no-opener) and writes nothing', async () => {
      const auth = await freshAuthority()
      await provisionTestIntakeRecipient(auth.ctx, auth.authority.id)
      const requester = randomTestKeyPair()
      const payload = makePayload(auth.authority.id)
      const init = makeRequestInit(auth.authority.id, payload)
      await new RegistrationEngine(auth.ctx).submitRegistrationRequest(init, requester.publicHex, makeCallbackSigner(requester))

      // Seed the registrant task extension with the OPENER-bearing engine; only the approval attempt below is opener-less.
      await new SignatureTasksEngine(makeNetworkRef(), auth.ctx).getRequestedSignatures(true)
      const noOpenerCtx: EngineContext = { db: auth.ctx.db, user: auth.user }
      const tasksEngine = new SignatureTasksEngine(makeNetworkRef(), noOpenerCtx)
      const beforeCounts = await countTripleRows(auth.ctx.db, auth.authority.id)
      const task = {
        type: 'signature' as const,
        userId: auth.user.id,
        network: makeNetworkRef(),
        signatureType: 'registrant' as const,
        requestId: init.id,
        payload,
        submittedAt: init.submittedAt,
        issuerType: 'registrant' as const
      }
      let caught: unknown
      try {
        const digest = await tasksEngine.getSignatureDigest(task)
        await tasksEngine.completeSignature(task, {
          isAccepted: true,
          signature: await makeTestSignCallback(auth.user)(digest),
          sign: makeTestSignCallback(auth.user),
          decision: { checklist: ['id'] }
        })
      } catch (err) {
        caught = err
      }
      expect(caught).to.be.instanceOf(RegistrationContentAccessError)
      expect((caught as RegistrationContentAccessError).access).to.equal('no-opener')
      expect(await countTripleRows(auth.ctx.db, auth.authority.id)).to.deep.equal(beforeCounts)
    })
  })

  describe('P6 — legacy rows', () => {
    it('a raw plaintext row with a correct PayloadCid reads unsealed and approves end to end; a mismatched PayloadCid reads tampered', async () => {
      const auth = await freshAuthority()
      await provisionTestIntakeRecipient(auth.ctx, auth.authority.id)
      const requester = randomTestKeyPair()
      const payload = makePayload(auth.authority.id)
      const payloadJson = JSON.stringify(payload)
      const payloadCidRow = await auth.ctx.db.prepare('select Digest(:payload) as d').get({ payload: payloadJson })
      const payloadCid = payloadCidRow!.d as string
      const requestId = crypto.randomUUID()
      const submittedAt = toIsoZDatetime(Date.now())

      const digestRow = await auth.ctx.db
        .prepare('select Digest(:id, :rowAuthorityId, :requesterKey, :issuerType, :bridgeId, :payloadCid, :submittedAt) as d')
        .get({ id: requestId, rowAuthorityId: auth.authority.id, requesterKey: requester.publicHex, issuerType: 'registrant', bridgeId: null, payloadCid, submittedAt })
      const signature = await makeCallbackSigner(requester)(digestToBytes(digestRow!.d as string))

      await auth.ctx.db.exec(
        `insert into RegistrationRequest (Id, AuthorityId, RequesterKey, IssuerType, BridgeId, Payload, PayloadCid, Status, SubmittedAt, ReceivedAt, RequesterSignature)
         with context SigningNonce = :signingNonce
         values (:id, :rowAuthorityId, :requesterKey, :issuerType, :bridgeId, :payload, :payloadCid, :status, :submittedAt, :receivedAt, :requesterSignature)`,
        {
          id: requestId, rowAuthorityId: auth.authority.id, requesterKey: requester.publicHex, issuerType: 'registrant', bridgeId: null,
          payload: payloadJson, payloadCid, status: 'p', submittedAt, receivedAt: submittedAt, requesterSignature: signature.signature, signingNonce: null
        }
      )

      const engine = new RegistrationEngine(auth.ctx)
      const read = await engine.getRegistrationRequest(requestId)
      expect(read!.payloadAccess).to.equal('unsealed')
      expect(read!.payload).to.deep.equal(payload)

      const tasksEngine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
      const tasks = await tasksEngine.getRequestedSignatures(true)
      const task = tasks.find((t) => t.signatureType === 'registrant' && (t as { requestId?: string }).requestId === requestId)
      const digest = await tasksEngine.getSignatureDigest(task!)
      await tasksEngine.completeSignature(task!, {
        isAccepted: true,
        signature: await makeTestSignCallback(auth.user)(digest),
        sign: makeTestSignCallback(auth.user),
        decision: { checklist: ['id'] }
      })
      const finalRow = await auth.ctx.db.prepare('select Status from RegistrationRequest where Id = :id').get({ id: requestId })
      expect(finalRow!.Status).to.equal('a')

      // Mismatched PayloadCid variant — a different plaintext signed over a DIFFERENT PayloadCid,
      // but the TWO columns disagree with each other (built directly, since SignatureValid binds
      // the signature to the STORED PayloadCid, not to Payload itself).
      const otherPayloadCidRow = await auth.ctx.db.prepare('select Digest(:payload) as d').get({ payload: 'something-else-entirely' })
      const mismatchedCid = otherPayloadCidRow!.d as string
      const requestId2 = crypto.randomUUID()
      const digestRow2 = await auth.ctx.db
        .prepare('select Digest(:id, :rowAuthorityId, :requesterKey, :issuerType, :bridgeId, :payloadCid, :submittedAt) as d')
        .get({ id: requestId2, rowAuthorityId: auth.authority.id, requesterKey: requester.publicHex, issuerType: 'registrant', bridgeId: null, payloadCid: mismatchedCid, submittedAt })
      const signature2 = await makeCallbackSigner(requester)(digestToBytes(digestRow2!.d as string))
      await auth.ctx.db.exec(
        `insert into RegistrationRequest (Id, AuthorityId, RequesterKey, IssuerType, BridgeId, Payload, PayloadCid, Status, SubmittedAt, ReceivedAt, RequesterSignature)
         with context SigningNonce = :signingNonce
         values (:id, :rowAuthorityId, :requesterKey, :issuerType, :bridgeId, :payload, :payloadCid, :status, :submittedAt, :receivedAt, :requesterSignature)`,
        {
          id: requestId2, rowAuthorityId: auth.authority.id, requesterKey: requester.publicHex, issuerType: 'registrant', bridgeId: null,
          payload: payloadJson, payloadCid: mismatchedCid, status: 'p', submittedAt, receivedAt: submittedAt, requesterSignature: signature2.signature, signingNonce: null
        }
      )
      const read2 = await engine.getRegistrationRequest(requestId2)
      expect(read2!.payloadAccess).to.equal('tampered')

      // Neither row's Payload column was ever rewritten by any read.
      const rawAfter1 = await auth.ctx.db.prepare('select Payload from RegistrationRequest where Id = :id').get({ id: requestId })
      const rawAfter2 = await auth.ctx.db.prepare('select Payload from RegistrationRequest where Id = :id').get({ id: requestId2 })
      expect(rawAfter1!.Payload).to.equal(payloadJson)
      expect(rawAfter2!.Payload).to.equal(payloadJson)
    })
  })

  describe('P7 — zero recipients', () => {
    it('submitRegistrationRequest rejects IntakeError no-recipients with a zero-count sign callback and no row written', async () => {
      const auth = await freshAuthority()
      const requester = randomTestKeyPair()
      const payload = makePayload(auth.authority.id)
      const init = makeRequestInit(auth.authority.id, payload)
      let callbackCalls = 0
      const countingSign = async (digest: Uint8Array): Promise<Signature> => {
        callbackCalls++
        return makeCallbackSigner(requester)(digest)
      }

      let caught: unknown
      try {
        await new RegistrationEngine(auth.ctx).submitRegistrationRequest(init, requester.publicHex, countingSign)
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.name).to.equal('IntakeError')
      expect((caught as { code?: string }).code).to.equal('no-recipients')
      expect(callbackCalls).to.equal(0)

      const row = await auth.ctx.db.prepare('select count(*) as n from RegistrationRequest where Id = :id').get({ id: init.id })
      expect(Number(row?.n)).to.equal(0)
    })
  })

  describe('P8 — replayed-signature path', () => {
    it('a pre-made signature over a different payload\'s PayloadCid throws (SignatureValid) and writes nothing', async () => {
      const auth = await freshAuthority()
      await provisionTestIntakeRecipient(auth.ctx, auth.authority.id)
      const requester = randomTestKeyPair()
      const p1 = makePayload(auth.authority.id)
      const pOther = makePayload(auth.authority.id, { lastNameMarker: 'Other-Payload' })
      const id = crypto.randomUUID()
      const submittedAt = toIsoZDatetime(Date.now())

      const otherCidRow = await auth.ctx.db.prepare('select Digest(:payload) as d').get({ payload: JSON.stringify(pOther) })
      const otherPayloadCid = otherCidRow!.d as string
      const digestRow = await auth.ctx.db
        .prepare('select Digest(:id, :rowAuthorityId, :requesterKey, :issuerType, :bridgeId, :payloadCid, :submittedAt) as d')
        .get({ id, rowAuthorityId: auth.authority.id, requesterKey: requester.publicHex, issuerType: 'registrant', bridgeId: null, payloadCid: otherPayloadCid, submittedAt })
      const preMadeSignature = await makeCallbackSigner(requester)(digestToBytes(digestRow!.d as string))

      const init: RegistrationRequestInit = { id, authorityId: auth.authority.id, payload: p1, submittedAt }
      let caught: unknown
      try {
        await new RegistrationEngine(auth.ctx).submitRegistrationRequest(init, requester.publicHex, preMadeSignature)
      } catch (err) {
        caught = err
      }
      expect(caught).to.be.instanceOf(Error)

      const row = await auth.ctx.db.prepare('select count(*) as n from RegistrationRequest where Id = :id').get({ id })
      expect(Number(row?.n)).to.equal(0)
    })
  })

  describe('P9 — private tier sealed', () => {
    it('register() stores a sealed RegistrantPrivate; PrivateCid matches; getRegistrantPrivate opens for the recipient and degrades otherwise', async () => {
      const auth = await freshAuthority()
      await provisionTestIntakeRecipient(auth.ctx, auth.authority.id)
      const marker = randomMarker()
      const registrantId = crypto.randomUUID()
      const sign = makeTestSignCallback(auth.user)
      const init: RegisterInit = {
        registrant: { id: registrantId, authorityId: auth.authority.id, expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000) },
        private: { expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000), details: [{ name: 'note', value: marker }] }
      }
      const engine = new RegistrationEngine(auth.ctx)
      await engine.register(init, sign)

      const raw = await auth.ctx.db.prepare('select PrivateDetails from RegistrantPrivate where RegistrantId = :id').get({ id: registrantId })
      expect(String(raw!.PrivateDetails)).to.not.include(marker)
      expect(isSealedRegistrationContent(raw!.PrivateDetails as string)).to.equal(true)

      const registrantRow = await auth.ctx.db.prepare('select PrivateCid from Registrant where Id = :id').get({ id: registrantId })
      const expectedCidRow = await auth.ctx.db
        .prepare('select cid(Digest(:registrantId, :expiration, :privateDetails)) as c')
        .get({ registrantId, expiration: init.private.expiration, privateDetails: raw!.PrivateDetails as string })
      expect(registrantRow!.PrivateCid).to.equal(expectedCidRow!.c)

      const read = await engine.getRegistrantPrivate(registrantId)
      expect(read!.detailsAccess).to.equal('opened')
      expect(read!.privateDetails).to.deep.equal(init.private.details)

      const noOpenerEngine = new RegistrationEngine({ db: auth.ctx.db, user: auth.user })
      const noOpenerRead = await noOpenerEngine.getRegistrantPrivate(registrantId)
      expect(noOpenerRead!.detailsAccess).to.equal('no-opener')
      expect(noOpenerRead!.privateDetails).to.deep.equal([])

      const { opener: outsiderOpener } = await makeTestOutsiderOpener()
      const outsiderEngine = new RegistrationEngine({ db: auth.ctx.db, user: auth.user, intakeOpener: outsiderOpener })
      const outsiderRead = await outsiderEngine.getRegistrantPrivate(registrantId)
      expect(outsiderRead!.detailsAccess).to.equal('not-a-recipient')
      expect(outsiderRead!.privateDetails).to.deep.equal([])
    })
  })

  describe('P10 — empty details and zero recipients', () => {
    it('empty details succeed and store the literal []; non-empty details reject IntakeError no-recipients, with no Registrant row', async () => {
      const auth = await freshAuthority()
      const sign = makeTestSignCallback(auth.user)

      const emptyRegistrantId = crypto.randomUUID()
      const emptyInit: RegisterInit = {
        registrant: { id: emptyRegistrantId, authorityId: auth.authority.id, expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000) },
        private: { expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000), details: [] }
      }
      const engine = new RegistrationEngine(auth.ctx)
      await engine.register(emptyInit, sign)
      const raw = await auth.ctx.db.prepare('select PrivateDetails from RegistrantPrivate where RegistrantId = :id').get({ id: emptyRegistrantId })
      expect(raw!.PrivateDetails).to.equal('[]')

      const before = await auth.ctx.db.prepare('select count(*) as n from Registrant').get({})
      const nonEmptyRegistrantId = crypto.randomUUID()
      const nonEmptyInit: RegisterInit = {
        registrant: { id: nonEmptyRegistrantId, authorityId: auth.authority.id, expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000) },
        private: { expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000), details: [{ name: 'note', value: 'x' }] }
      }
      let caught: unknown
      try {
        await engine.register(nonEmptyInit, sign)
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.name).to.equal('IntakeError')
      expect((caught as { code?: string }).code).to.equal('no-recipients')
      const after = await auth.ctx.db.prepare('select count(*) as n from Registrant').get({})
      expect(Number(after?.n)).to.equal(Number(before?.n))
    })
  })

  describe('P11 — approval end to end', () => {
    it('Registrant exists, its RegistrantPrivate is freshly sealed to the officers current at approval, and Payload bytes survive byte-identical', async () => {
      const auth = await freshAuthority()
      await provisionTestIntakeRecipient(auth.ctx, auth.authority.id)
      const requester = randomTestKeyPair()
      const registrantId = crypto.randomUUID()
      const payload = makePayload(auth.authority.id, { registrantId, detailValueMarker: 'approval-note' })
      const init = makeRequestInit(auth.authority.id, payload)
      const engine = new RegistrationEngine(auth.ctx)
      await engine.submitRegistrationRequest(init, requester.publicHex, makeCallbackSigner(requester))

      const beforeRow = await auth.ctx.db.prepare('select Payload from RegistrationRequest where Id = :id').get({ id: init.id })

      const tasksEngine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
      const tasks = await tasksEngine.getRequestedSignatures(true)
      const task = tasks.find((t) => t.signatureType === 'registrant' && (t as { requestId?: string }).requestId === init.id)
      const digest = await tasksEngine.getSignatureDigest(task!)
      await tasksEngine.completeSignature(task!, {
        isAccepted: true,
        signature: await makeTestSignCallback(auth.user)(digest),
        sign: makeTestSignCallback(auth.user),
        decision: { checklist: ['id'] }
      })

      const registrant = await engine.getRegistrant(registrantId)
      expect(registrant).to.not.be.undefined
      const privateRead = await engine.getRegistrantPrivate(registrantId)
      expect(privateRead!.detailsAccess).to.equal('opened')
      expect(privateRead!.privateDetails).to.deep.equal(payload.private.details)

      const afterRow = await auth.ctx.db.prepare('select Payload from RegistrationRequest where Id = :id').get({ id: init.id })
      expect(afterRow!.Payload).to.equal(beforeRow!.Payload)
    })
  })

  describe('P12 — D-51 late officer', () => {
    it("holders[1]'s opener reads pre-provisioning rows as not-a-recipient; a request submitted after provisioning opens for both", async () => {
      const fx = await createThresholdAuthority({ thresholdPolicies: [{ policy: 'rad', threshold: 1 }, { policy: 'vrg', threshold: 1 }] })
      await provisionTestIntakeRecipient(fx.elec.ctx, fx.authorityId)

      const requester = randomTestKeyPair()
      const earlyRegistrantId = crypto.randomUUID()
      const earlyPayload = makePayload(fx.authorityId, { registrantId: earlyRegistrantId })
      const earlyRequestInit = makeRequestInit(fx.authorityId, earlyPayload)
      const engine = new RegistrationEngine(fx.elec.ctx)
      await engine.submitRegistrationRequest(earlyRequestInit, requester.publicHex, makeCallbackSigner(requester))
      await engine.register(
        {
          registrant: { id: earlyRegistrantId, authorityId: fx.authorityId, expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000) },
          private: { expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000), details: [{ name: 'note', value: 'pre-provisioning-detail' }] }
        },
        fx.holders[0]!.sign
      )

      // holders[1] joins the intake-recipient set AFTER the above.
      const holder1Ctx: EngineContext = { db: fx.elec.ctx.db, user: fx.holders[1]!.user }
      // (holders[1]'s UserKey is already registered by createThresholdAuthority.)
      await provisionTestIntakeRecipient(holder1Ctx, fx.authorityId)

      const holder1Engine = new RegistrationEngine({ db: fx.elec.ctx.db, user: fx.holders[1]!.user, intakeOpener: holder1Ctx.intakeOpener })
      const earlyRead = await holder1Engine.getRegistrationRequest(earlyRequestInit.id)
      expect(earlyRead!.payloadAccess).to.equal('not-a-recipient')
      const earlyPrivateRead = await holder1Engine.getRegistrantPrivate(earlyRegistrantId)
      expect(earlyPrivateRead!.detailsAccess).to.equal('not-a-recipient')

      // A request submitted AFTER holders[1] provisioned opens for BOTH.
      const lateRegistrantId = crypto.randomUUID()
      const latePayload = makePayload(fx.authorityId, { registrantId: lateRegistrantId })
      const lateRequestInit = makeRequestInit(fx.authorityId, latePayload)
      await engine.submitRegistrationRequest(lateRequestInit, requester.publicHex, makeCallbackSigner(requester))

      const founderRead = await engine.getRegistrationRequest(lateRequestInit.id)
      expect(founderRead!.payloadAccess).to.equal('opened')
      const holder1LateRead = await holder1Engine.getRegistrationRequest(lateRequestInit.id)
      expect(holder1LateRead!.payloadAccess).to.equal('opened')
    })
  })

  describe('P13 — dedup and re-association fail closed', () => {
    it('getLikelyDuplicateRequests flags with an opener and returns [] without one; an unread approved row makes code resolution unverifiable, never unmatched', async () => {
      const auth = await freshAuthority()
      await provisionTestIntakeRecipient(auth.ctx, auth.authority.id)
      const name = randomMarker()
      const engine = new RegistrationEngine(auth.ctx)

      const requesterA = randomTestKeyPair()
      const payloadA = makePayload(auth.authority.id, { lastNameMarker: name })
      const initA = makeRequestInit(auth.authority.id, payloadA)
      await engine.submitRegistrationRequest(initA, requesterA.publicHex, makeCallbackSigner(requesterA))

      const requesterB = randomTestKeyPair()
      const payloadB = makePayload(auth.authority.id, { lastNameMarker: name })
      const initB = makeRequestInit(auth.authority.id, payloadB)
      await engine.submitRegistrationRequest(initB, requesterB.publicHex, makeCallbackSigner(requesterB))

      const withOpener = await engine.getLikelyDuplicateRequests(initA.id)
      expect(withOpener.map((d) => d.requestId)).to.deep.equal([initB.id])

      const noOpenerEngine = new RegistrationEngine({ db: auth.ctx.db, user: auth.user })
      const withoutOpener = await noOpenerEngine.getLikelyDuplicateRequests(initA.id)
      expect(withoutOpener).to.deep.equal([])

      // Re-association: listApprovedRegistrations with the outsider opener reports every approved
      // row as unread, and code resolution over that list is 'unverifiable', never 'unmatched'.
      const tasksEngine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
      const taskA = (await tasksEngine.getRequestedSignatures(true)).find((t) => t.signatureType === 'registrant' && (t as { requestId?: string }).requestId === initA.id)
      const digestA = await tasksEngine.getSignatureDigest(taskA!)
      await tasksEngine.completeSignature(taskA!, {
        isAccepted: true,
        signature: await makeTestSignCallback(auth.user)(digestA),
        sign: makeTestSignCallback(auth.user),
        decision: { checklist: ['id'] }
      })

      const { opener: outsiderOpener } = await makeTestOutsiderOpener()
      const evidence = await import('../src/association/reassociation/evidence.js')
      const approvedRead = await evidence.listApprovedRegistrations(auth.ctx.db, auth.authority.id, outsiderOpener)
      expect(approvedRead.registrations.length).to.equal(0)
      expect(approvedRead.unreadCount).to.be.greaterThan(0)

      const codeCache = new Map()
      const resolved = await evidence.resolveRegistrantByCode(auth.ctx.db, outsiderOpener, 'ABCDE-FGHJK', approvedRead, codeCache)
      expect(resolved.outcome).to.equal('unverifiable')
    })
  })

  describe('P14 — access trail', () => {
    it('recordRegistrantAccessEvent from a ctx with no opener writes no access-trail row', async () => {
      const auth = await freshAuthority()
      await provisionTestIntakeRecipient(auth.ctx, auth.authority.id)
      const registrantId = crypto.randomUUID()
      const sign = makeTestSignCallback(auth.user)
      await new RegistrationEngine(auth.ctx).register(
        {
          registrant: { id: registrantId, authorityId: auth.authority.id, expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000) },
          private: { expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000), details: [{ name: 'ssn', value: '900-86-0001' }] }
        },
        sign
      )

      const noOpenerEngine = new RegistrationEngine({ db: auth.ctx.db, user: auth.user })
      await noOpenerEngine.recordRegistrantAccessEvent(registrantId, auth.user.id, ['ssn'])

      const events = await noOpenerEngine.getRegistrantAccessEvents(registrantId)
      expect(events).to.deep.equal([])
    })
  })

  describe('P15 — no leak', () => {
    it('no console call across P1-P14 captured any marker substring', () => {
      for (const call of consoleCalls) {
        expect(call).to.not.match(/MARKER-D49-/)
      }
    })
  })
})

async function countTripleRows (db: import('@quereus/quereus').Database, authorityId: string): Promise<{ adminSigning: number; adminSignature: number; registrant: number }> {
  const adminSigning = await db.prepare("select count(*) as n from AdminSigning where AuthorityId = :authorityId").get({ authorityId })
  const adminSignature = await db.prepare(
    "select count(*) as n from AdminSignature S join AdminSigning G on G.Nonce = S.SigningNonce where G.AuthorityId = :authorityId"
  ).get({ authorityId })
  const registrant = await db.prepare('select count(*) as n from Registrant where AuthorityId = :authorityId').get({ authorityId })
  return { adminSigning: Number(adminSigning?.n ?? 0), adminSignature: Number(adminSignature?.n ?? 0), registrant: Number(registrant?.n ?? 0) }
}
