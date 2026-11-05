/**
 * reassociation-identity-fields.spec.ts — Phase 62 Plan 113 Task 1 (initial/G1 WR-01, D-45, D-46).
 *
 * One strand writer staging junk `identityFields` must never break the officer's pending
 * re-association list. Two layers are pinned: the staged-read sanitizer (I-1..I-3) and the
 * per-row isolation in the driver (I-4, with the sanitizer bypassed through a hand-built intake).
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { REASSOCIATION_UNRESOLVED_REGISTRANT_ID } from '@votetorrent/vote-core'
import type { AssociationIdentityField, AssociationRequestInit, ReassociationIntake, Signature } from '@votetorrent/vote-core'
import { AssociationEngine } from '../src/association/association-engine.js'
import { P2pAssociationTransport } from '../src/association/transport/p2p-association-transport.js'
import type { AssociationStrandPort } from '../src/association/transport/p2p-association-transport.js'
import { computeAssociationAttestationDigest, computeAssociationRequestDigest } from '../src/association/transport/association-request-digest.js'
import {
  MAX_IDENTITY_FIELDS,
  MAX_IDENTITY_FIELD_TEXT_LENGTH,
  sanitizeIdentityFields
} from '../src/association/reassociation/identity-fields.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'
import { digestToBytes } from '../src/utils.js'
import { createP2pStagingFixture } from './fixtures/p2p-staging-fixture.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import type { TestKeyPair } from './fixtures/keys.js'

function makeCallbackSigner (keyPair: TestKeyPair): (digest: Uint8Array) => Promise<Signature> {
  const privBytes = hexToBytes(keyPair.privateHex)
  return async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes)
    return { signature: bytesToHex(sig), signerKey: keyPair.publicHex, signerUserId: '' }
  }
}

describe('re-association identity fields — junk cannot jam the officer list (62-113 Task 1, WR-01)', function () {
  this.timeout(60_000)

  async function makeWorld () {
    const fixture = await createP2pStagingFixture()
    const ctx = fixture.auth.ctx
    const authorityId = fixture.auth.authority.id
    const engine = new AssociationEngine(ctx)
    const port = fixture.makePort()
    const transport = new P2pAssociationTransport({
      openStrand: async () => port as unknown as AssociationStrandPort,
      computeDigest: async (init, requesterKey) => digestToBytes(computeAssociationRequestDigest(init, requesterKey)),
      computeAttestationDigest: async (answer) => digestToBytes(computeAssociationAttestationDigest(answer)),
      strandId: `identity-fields-strand-${crypto.randomUUID()}`,
      sealer: fixture.sealer,
      opener: fixture.opener,
      decisionSigner: fixture.decisionSigner
    })

    /** Stages one sentinel request with the given RAW identityFields and mirrors it into AssociationRequest. */
    async function stage (identityFields: unknown): Promise<string> {
      const device = randomTestKeyPair()
      const requestId = crypto.randomUUID()
      const init: AssociationRequestInit = {
        id: requestId,
        authorityId,
        registrantId: REASSOCIATION_UNRESOLVED_REGISTRANT_ID,
        deviceKey: device.publicHex,
        submittedAt: toIsoZDatetime(Date.now())
      }
      await transport.submitRequest(init, device.publicHex, makeCallbackSigner(device), {
        identityFields: identityFields as readonly AssociationIdentityField[]
      })
      const staged = await transport.readStagedRequests()
      const doc = staged.find((d) => d.requestId === requestId)
      if (doc === undefined) throw new Error('staged sentinel not found')
      await engine.submitAssociationRequest(doc.init, doc.requesterKey, doc.signature)
      return requestId
    }

    return { fixture, ctx, authorityId, engine, transport, stage }
  }

  it('I-1: junk elements (null, numbers, partial objects, strings) do not reject the list; the junk row reads evidence none', async () => {
    const w = await makeWorld()
    const junkId = await w.stage([null, { name: 1, value: 'x' }, { name: 'firstName' }, 'str'])
    const goodId = await w.stage([{ name: 'firstName', value: 'Ana' }])

    const list = await w.engine.listPendingReassociations(w.authorityId, w.transport, w.fixture.opener)
    expect(list.map((r) => r.requestId).sort()).to.deep.equal([junkId, goodId].sort())
    const junk = list.find((r) => r.requestId === junkId)!
    const good = list.find((r) => r.requestId === goodId)!
    expect(junk.evidence).to.deep.equal({ kind: 'none' })
    expect(junk.candidates).to.deep.equal([])
    expect(good.evidence).to.deep.equal({ kind: 'identity', fields: [{ name: 'firstName', value: 'Ana' }] })
  })

  it('I-2: a junk element next to a valid field keeps exactly the valid field', async () => {
    const w = await makeWorld()
    const id = await w.stage([null, { name: 'firstName', value: 'Ana' }])
    const review = await w.engine.getReassociationReview(id, w.transport, w.fixture.opener)
    expect(review!.evidence).to.deep.equal({ kind: 'identity', fields: [{ name: 'firstName', value: 'Ana' }] })
  })

  it('I-3: sanitizeIdentityFields bounds count and text length and refuses non-arrays', () => {
    const many = Array.from({ length: MAX_IDENTITY_FIELDS + 10 }, (_, i) => ({ name: `n${i}`, value: `v${i}` }))
    const kept = sanitizeIdentityFields(many)!
    expect(kept).to.have.lengthOf(MAX_IDENTITY_FIELDS)
    expect(kept[0]).to.deep.equal({ name: 'n0', value: 'v0' })

    const longValue = 'x'.repeat(MAX_IDENTITY_FIELD_TEXT_LENGTH + 1)
    const longName = 'y'.repeat(MAX_IDENTITY_FIELD_TEXT_LENGTH + 1)
    const edge = 'z'.repeat(MAX_IDENTITY_FIELD_TEXT_LENGTH)
    expect(sanitizeIdentityFields([
      { name: 'a', value: longValue },
      { name: longName, value: 'b' },
      { name: 'ok', value: edge },
      { name: '', value: 'empty-name' }
    ])).to.deep.equal([{ name: 'ok', value: edge }])

    expect(sanitizeIdentityFields(undefined)).to.equal(undefined)
    expect(sanitizeIdentityFields('nope')).to.equal(undefined)
    expect(sanitizeIdentityFields({ 0: { name: 'a', value: 'b' } })).to.equal(undefined)
    expect(sanitizeIdentityFields([])).to.deep.equal([])
  })

  it('I-4: with the sanitizer bypassed, one junk row still cannot reject the list or the review (per-row isolation)', async () => {
    const w = await makeWorld()
    const junkId = await w.stage(undefined)
    const goodId = await w.stage([{ name: 'firstName', value: 'Ana' }])

    // A non-P2P intake handing the driver a row whose identityFields blow up on first touch (a
    // hostile/buggy intake the sanitizer never saw): only the driver's own per-row catch saves the list.
    const exploding = new Proxy([], { get () { throw new TypeError('hostile identityFields') } })
    const hostile: ReassociationIntake = {
      readStagedRequests: async () => {
        const real = await w.transport.readStagedRequests()
        return real.map((r) => r.requestId === junkId
          ? { ...r, identityFields: exploding as unknown as readonly AssociationIdentityField[] }
          : r)
      },
      readStagedAttestations: async () => await w.transport.readStagedAttestations(),
      publishDecision: async (d) => await w.transport.publishDecision(d)
    }

    const list = await w.engine.listPendingReassociations(w.authorityId, hostile, w.fixture.opener)
    expect(list.map((r) => r.requestId).sort()).to.deep.equal([junkId, goodId].sort())
    expect(list.find((r) => r.requestId === junkId)!.evidence).to.deep.equal({ kind: 'none' })
    expect(list.find((r) => r.requestId === goodId)!.evidence.kind).to.equal('identity')

    const review = await w.engine.getReassociationReview(junkId, hostile, w.fixture.opener)
    expect(review).to.not.equal(undefined)
    expect(review!.evidence).to.deep.equal({ kind: 'none' })
  })
})
