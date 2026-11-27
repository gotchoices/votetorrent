/**
 * registration-at-rest-sealing.harness.spec.ts — Phase 62 Plan 31 Task 4 (D-49, T-62-31-01/02).
 *
 * Two-node leg: node-A (the founder officer) writes a sealed RegistrationRequest and a sealed
 * RegistrantPrivate; node-B is a NON-officer peer (no user, no opener) that replicates both rows
 * and must see only ciphertext. 62-24's harness cannot carry this: its node-B acts as the same
 * officer. NODE evidence only: device delivery stays P2P-11 proof debt (62-30).
 *
 * Opt-in through RUN_P2P_HARNESS=1; otherwise pending and no P2P package is loaded.
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { RegisterInit, RegistrationRequestInit, Signature } from '@votetorrent/vote-core'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { isSealedRegistrationContent } from '../src/registration/sealed-registration-content.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'
import type { EngineContext } from '../src/types.js'
import {
  startTwoNodeHarness,
  describeP2PHarness,
  pollUntil,
  HARNESS_TIMEOUTS
} from './harness/two-node-strand.js'
import type { TwoNodeHarness } from './harness/two-node-strand.js'
import {
  addTestAuthority,
  createTestNetwork,
  makeTestOutsiderOpener,
  makeTestSignCallback,
  provisionTestIntakeRecipient
} from './fixtures/test-context.js'
import type { TestAuthorityContext } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'

describeP2PHarness('D-49 two-node: a peer with no officer key sees no plaintext', function () {
  const marker = `MARKER-D49-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
  const privMarker = `${marker}-PRIV`
  let harness: TwoNodeHarness | undefined
  let auth: TestAuthorityContext
  let ctxB: EngineContext
  let requestId: string
  let registrantId: string
  let mutateMark: number

  before(async function () {
    this.timeout(HARNESS_TIMEOUTS.suiteMs)
    harness = await startTwoNodeHarness()
    const net = await createTestNetwork({ dbFactory: harness.nodeA.dbFactory })
    auth = await addTestAuthority(net)
    await provisionTestIntakeRecipient(net.ctx, auth.authority.id)

    const dbB = await harness.nodeB.openStrand(net.ref.hash)
    ctxB = { db: dbB }
    mutateMark = harness.nodeB.stats.mutateCount

    const engineA = new RegistrationEngine(auth.ctx)
    const requester = randomTestKeyPair()
    const privBytes = hexToBytes(requester.privateHex)
    const requesterSign = async (digest: Uint8Array): Promise<Signature> => ({
      signature: bytesToHex(secp256k1.sign(digest, privBytes)),
      signerKey: requester.publicHex,
      signerUserId: ''
    })
    const exp = toIsoZDatetime(Date.now() + 365 * 86_400_000)
    const payload: RegisterInit = {
      registrant: { id: crypto.randomUUID(), authorityId: auth.authority.id, expiration: exp },
      public: { lastName: marker, firstName: 'Jane' },
      private: { expiration: exp, details: [{ name: 'note', value: privMarker }] }
    }
    const init: RegistrationRequestInit = {
      id: crypto.randomUUID(),
      authorityId: auth.authority.id,
      payload,
      submittedAt: toIsoZDatetime(Date.now())
    }
    requestId = init.id
    await engineA.submitRegistrationRequest(init, requester.publicHex, requesterSign)

    registrantId = crypto.randomUUID()
    await engineA.register(
      {
        registrant: { id: registrantId, authorityId: auth.authority.id, expiration: exp },
        private: { expiration: exp, details: [{ name: 'note', value: privMarker }] }
      },
      makeTestSignCallback(auth.user)
    )

    await pollUntil(
      async () => ({
        req: await dbB.prepare('select Id from RegistrationRequest where Id = :id').get({ id: requestId }),
        priv: await dbB.prepare('select RegistrantId from RegistrantPrivate where RegistrantId = :id').get({ id: registrantId })
      }),
      (v) => v.req != null && v.priv != null,
      { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: 'D-49: sealed rows reach the non-officer node-B' }
    )
  })

  after(async function () {
    this.timeout(HARNESS_TIMEOUTS.startMs)
    await harness?.stop()
  })

  it('node-B raw columns hold only sealed envelopes (no marker, no "lastName")', async function () {
    const req = await ctxB.db.prepare('select Payload from RegistrationRequest where Id = :id').get({ id: requestId })
    const priv = await ctxB.db.prepare('select PrivateDetails from RegistrantPrivate where RegistrantId = :id').get({ id: registrantId })
    const payload = String(req!.Payload)
    const details = String(priv!.PrivateDetails)
    expect(payload).to.not.include(marker)
    expect(payload).to.not.include('"lastName"')
    expect(details).to.not.include(privMarker)
    expect(isSealedRegistrationContent(payload)).to.equal(true)
    expect(isSealedRegistrationContent(details)).to.equal(true)
  })

  it('node-B with no opener reads no-opener and leaks nothing; with an outsider opener, not-a-recipient', async function () {
    const noOpener = new RegistrationEngine(ctxB)
    const read = await noOpener.getRegistrationRequest(requestId)
    expect(read!.payloadAccess).to.equal('no-opener')
    expect(read!.payload).to.deep.equal({})
    const priv = await noOpener.getRegistrantPrivate(registrantId)
    expect(priv!.detailsAccess).to.equal('no-opener')
    expect(priv!.privateDetails).to.deep.equal([])

    const { opener } = await makeTestOutsiderOpener()
    const outsider = new RegistrationEngine({ ...ctxB, intakeOpener: opener })
    expect((await outsider.getRegistrationRequest(requestId))!.payloadAccess).to.equal('not-a-recipient')
    expect((await outsider.getRegistrantPrivate(registrantId))!.detailsAccess).to.equal('not-a-recipient')

    // The reader wrote nothing through node-B, so these rows are foreign, never an own orphan.
    expect(harness!.nodeB.stats.mutateCount).to.equal(mutateMark)
  })

  it('positive control: node-A (officer, opener) reads the marker', async function () {
    const engineA = new RegistrationEngine(auth.ctx)
    const read = await engineA.getRegistrationRequest(requestId)
    expect(read!.payloadAccess).to.equal('opened')
    expect(read!.payload.public?.lastName).to.equal(marker)
    const priv = await engineA.getRegistrantPrivate(registrantId)
    expect(priv!.detailsAccess).to.equal('opened')
    expect(priv!.privateDetails).to.deep.equal([{ name: 'note', value: privMarker }])
  })
})
