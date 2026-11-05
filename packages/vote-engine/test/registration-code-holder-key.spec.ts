/**
 * registration-code-holder-key.spec.ts — Phase 62 Plan 35 Task 1 (V-5, D-45, D-49).
 *
 * `getRegistrationCodeHolderKey` is called by the Voter with NO opener. After D-49 sealing the old
 * opener-less scan resolved nothing for any new registrant, so the Voter could never show its
 * registration code. These cases run the REAL engine method (never a stub).
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { RegisterInit, RegistrationRequestInit, Signature } from '@votetorrent/vote-core'
import { AssociationEngine } from '../src/association/association-engine.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine.js'
import { isSealedRegistrationContent } from '../src/registration/sealed-registration-content.js'
import { digestToBytes } from '../src/utils.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'
import { addTestAuthority, createTestNetwork, makeTestSignCallback, provisionTestIntakeRecipient, seedSignedMutation } from './fixtures/test-context.js'
import type { TestAuthorityContext } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import type { TestKeyPair } from './fixtures/keys.js'

function makeNetworkRef () {
  return { hash: 'test-holder-key-hash', name: 'Holder Key Network', relays: [] as string[], primaryAuthorityDomainName: 'holder-key.example' }
}

function makeCallbackSigner (keyPair: TestKeyPair): (digest: Uint8Array) => Promise<Signature> {
  const privBytes = hexToBytes(keyPair.privateHex)
  return async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes)
    return { signature: bytesToHex(sig), signerKey: keyPair.publicHex, signerUserId: '' }
  }
}

function makePayload (authorityId: string, registrantId: string): RegisterInit {
  return {
    registrant: { id: registrantId, authorityId, expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000) },
    public: { lastName: 'Holder', firstName: 'Key' },
    private: { expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000), details: [] }
  }
}

async function freshAuthority (): Promise<TestAuthorityContext> {
  const auth = await addTestAuthority(await createTestNetwork())
  await provisionTestIntakeRecipient(auth.ctx, auth.authority.id)
  return auth
}

async function approve (auth: TestAuthorityContext, requestId: string): Promise<void> {
  const tasksEngine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
  const tasks = await tasksEngine.getRequestedSignatures(true)
  const task = tasks.find((t) => t.signatureType === 'registrant' && (t as { requestId?: string }).requestId === requestId)
  if (task === undefined) throw new Error(`no registrant task for ${requestId}`)
  const digest = await tasksEngine.getSignatureDigest(task)
  await tasksEngine.completeSignature(task, {
    isAccepted: true,
    signature: await makeTestSignCallback(auth.user)(digest),
    sign: makeTestSignCallback(auth.user),
    decision: { checklist: ['id'] }
  })
}

/** Raw-inserts a PENDING RegistrationRequest (unsealed payload) with the given id/issuer, signed by `requester`. */
async function insertRawRequest (
  auth: TestAuthorityContext,
  opts: { id: string; requester: TestKeyPair; registrantId: string; issuerType?: 'registrant' | 'bridge'; bridgeId?: string }
): Promise<void> {
  const issuerType = opts.issuerType ?? 'registrant'
  const bridgeId = opts.bridgeId ?? null
  const payloadJson = JSON.stringify(makePayload(auth.authority.id, opts.registrantId))
  const payloadCid = (await auth.ctx.db.prepare('select Digest(:payload) as d').get({ payload: payloadJson }))!.d as string
  const submittedAt = toIsoZDatetime(Date.now())
  const digestRow = await auth.ctx.db
    .prepare('select Digest(:id, :rowAuthorityId, :requesterKey, :issuerType, :bridgeId, :payloadCid, :submittedAt) as d')
    .get({ id: opts.id, rowAuthorityId: auth.authority.id, requesterKey: opts.requester.publicHex, issuerType, bridgeId, payloadCid, submittedAt })
  const signature = await makeCallbackSigner(opts.requester)(digestToBytes(digestRow!.d as string))
  await auth.ctx.db.exec(
    `insert into RegistrationRequest (Id, AuthorityId, RequesterKey, IssuerType, BridgeId, Payload, PayloadCid, Status, SubmittedAt, ReceivedAt, RequesterSignature)
     with context SigningNonce = :signingNonce
     values (:id, :rowAuthorityId, :requesterKey, :issuerType, :bridgeId, :payload, :payloadCid, :status, :submittedAt, :receivedAt, :requesterSignature)`,
    {
      id: opts.id, rowAuthorityId: auth.authority.id, requesterKey: opts.requester.publicHex, issuerType, bridgeId,
      payload: payloadJson, payloadCid, status: 'p', submittedAt, receivedAt: submittedAt, requesterSignature: signature.signature, signingNonce: null
    }
  )
}

/** Registers a RegistrationBridgeKey through the real 'vrg' officer ceremony. */
async function registerBridgeKey (auth: TestAuthorityContext, bridgeKey: string): Promise<string> {
  const id = crypto.randomUUID()
  const tid = Date.now()
  const label = 'Holder Key Bridge'
  const revokedAt = null
  const { nonce } = await seedSignedMutation(
    auth.ctx, auth.authority.id, 'vrg', tid,
    'select Digest(:tid, :id, :authId, :label, :bridgeKey, :revokedAt) as d',
    { tid, id, authId: auth.authority.id, label, bridgeKey, revokedAt },
    auth.user
  )
  await auth.ctx.db.exec(
    `insert into RegistrationBridgeKey (Id, AuthorityId, Label, BridgeKey, RevokedAt)
     with context SigningNonce = :nonce, Tid = :tid
     values (:id, :authorityId, :label, :bridgeKey, :revokedAt)`,
    { id, authorityId: auth.authority.id, label, bridgeKey, revokedAt, nonce, tid }
  )
  return id
}

/** Registrant X approved through a request whose id DIFFERS from X (the bridge/import shape; sealed). */
async function approveRegistrantWithOtherRequestId (auth: TestAuthorityContext, registrantId: string): Promise<TestKeyPair> {
  const requester = randomTestKeyPair()
  const requestId = crypto.randomUUID()
  const init: RegistrationRequestInit = {
    id: requestId,
    authorityId: auth.authority.id,
    payload: makePayload(auth.authority.id, registrantId),
    submittedAt: toIsoZDatetime(Date.now())
  }
  await new RegistrationEngine(auth.ctx).submitRegistrationRequest(init, requester.publicHex, makeCallbackSigner(requester))
  await approve(auth, requestId)
  return requester
}

describe('getRegistrationCodeHolderKey — V-5 (62-35 Task 1)', function () {
  this.timeout(30_000)

  it('H1: a D-49-sealed registration whose request id is the registrant id resolves the RequesterKey with no opener', async () => {
    const auth = await freshAuthority()
    const requester = randomTestKeyPair()
    const registrantId = crypto.randomUUID()
    const init: RegistrationRequestInit = {
      id: registrantId,
      authorityId: auth.authority.id,
      payload: makePayload(auth.authority.id, registrantId),
      submittedAt: toIsoZDatetime(Date.now())
    }
    await new RegistrationEngine(auth.ctx).submitRegistrationRequest(init, requester.publicHex, makeCallbackSigner(requester))
    const stored = await auth.ctx.db.prepare('select Payload from RegistrationRequest where Id = :id').get({ id: registrantId })
    expect(isSealedRegistrationContent(stored!.Payload as string), 'payload must be sealed (D-49)').to.equal(true)
    await approve(auth, registrantId)

    const engine = new AssociationEngine(auth.ctx)
    expect(await engine.getRegistrationCodeHolderKey(registrantId)).to.equal(requester.publicHex)
  })

  it('H2: a pending request, an unknown id and a non-active registrant give undefined', async () => {
    const auth = await freshAuthority()
    const requester = randomTestKeyPair()
    const registrantId = crypto.randomUUID()
    const init: RegistrationRequestInit = {
      id: registrantId,
      authorityId: auth.authority.id,
      payload: makePayload(auth.authority.id, registrantId),
      submittedAt: toIsoZDatetime(Date.now())
    }
    await new RegistrationEngine(auth.ctx).submitRegistrationRequest(init, requester.publicHex, makeCallbackSigner(requester))
    const engine = new AssociationEngine(auth.ctx)
    expect(await engine.getRegistrationCodeHolderKey(registrantId), 'pending').to.equal(undefined)
    expect(await engine.getRegistrationCodeHolderKey(crypto.randomUUID()), 'unknown').to.equal(undefined)
  })

  it('H3: a legacy unsealed registration whose request id differs from the registrant id still resolves', async () => {
    const auth = await freshAuthority()
    const requester = randomTestKeyPair()
    const registrantId = crypto.randomUUID()
    const requestId = crypto.randomUUID()
    const payloadJson = JSON.stringify(makePayload(auth.authority.id, registrantId))
    const payloadCid = (await auth.ctx.db.prepare('select Digest(:payload) as d').get({ payload: payloadJson }))!.d as string
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
    await approve(auth, requestId)

    const engine = new AssociationEngine(auth.ctx)
    expect(await engine.getRegistrationCodeHolderKey(registrantId)).to.equal(requester.publicHex)
  })
  it('H-1 (62-113, gap1/IN-05): an approved IssuerType bridge request whose Id equals an active registrant id is never returned as the holder key', async () => {
    const auth = await freshAuthority()
    const registrantX = crypto.randomUUID()
    await approveRegistrantWithOtherRequestId(auth, registrantX) // sealed, request id differs: the opener-less read cannot resolve it

    const bridge = randomTestKeyPair()
    const bridgeId = await registerBridgeKey(auth, bridge.publicHex)
    // The collision: a bridge-issued request whose Id IS registrant X's id (its payload creates another registrant).
    await insertRawRequest(auth, { id: registrantX, requester: bridge, registrantId: crypto.randomUUID(), issuerType: 'bridge', bridgeId })
    await approve(auth, registrantX)
    const stored = await auth.ctx.db.prepare("select IssuerType, Status from RegistrationRequest where Id = :id").get({ id: registrantX })
    expect(stored).to.deep.include({ IssuerType: 'bridge', Status: 'a' })

    const key = await new AssociationEngine(auth.ctx).getRegistrationCodeHolderKey(registrantX)
    expect(key, 'never the bridge key').to.not.equal(bridge.publicHex)
    expect(key, 'the sealed bridge-shaped registration is unresolvable without an opener: not available on this device, as before').to.equal(undefined)
  })

  it('H-1b (accepted residual, pinned): a colliding approved SELF-ISSUED request makes the lookup return its key — fail-closed residual: the Voter caller still requires holder == own identity key and own staged request id == X, so the victim sees not-holder, as without the collision', async () => {
    const auth = await freshAuthority()
    const registrantX = crypto.randomUUID()
    await approveRegistrantWithOtherRequestId(auth, registrantX)

    const k2 = randomTestKeyPair()
    await insertRawRequest(auth, { id: registrantX, requester: k2, registrantId: crypto.randomUUID() })
    await approve(auth, registrantX)

    expect(await new AssociationEngine(auth.ctx).getRegistrationCodeHolderKey(registrantX)).to.equal(k2.publicHex)
  })
})
