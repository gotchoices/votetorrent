/**
 * registration-payload-cid-relaxation.spec.ts — 62-03 Task 2 (D-49, T-62-01-10 schema half).
 *
 * `RegistrationRequest.PayloadCidValid` (`PayloadCid = Digest(Payload)`) is DROPPED, so
 * `Payload` can hold a D-04 sealed envelope. `SignatureValid` stays tier 1 byte-for-byte
 * (the requester's signature still pins `PayloadCid`), and `PayloadImmutable` /
 * `PayloadCidImmutable` are unchanged. The Payload-to-PayloadCid link becomes the tier-2
 * recheck `Digest(<opened plaintext>) = PayloadCid` that 62-31 performs at every open — this
 * spec proves only the schema half.
 *
 * Mirrors `registration-request.spec.ts`'s `seedRegistrationRequest` shape locally (never
 * imports that spec file).
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { createTestNetwork, addTestAuthority } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { digestToBytes } from '../src/utils.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'

type TestAuthority = Awaited<ReturnType<typeof addTestAuthority>>

/** Structural stand-in for a D-04 sealed envelope — this spec needs no real crypto; 62-31
 *  proves real envelopes. Deliberately does NOT contain the plaintext marker string. */
const SEALED_SHAPED_PAYLOAD = JSON.stringify({ v: 1, alg: 'vt-env-1', nonce: 'AAAA', kc: 'AAAA', ct: 'AAAA', recipients: [] })

function makeRequesterSigner (): { publicHex: string, signDigest: (digestBase64url: string) => string } {
  const { privateHex, publicHex } = randomTestKeyPair()
  const privBytes = hexToBytes(privateHex)
  return {
    publicHex,
    signDigest: (digestBase64url: string): string => bytesToHex(secp256k1.sign(digestToBytes(digestBase64url), privBytes))
  }
}

function makePlaintextPayload (marker: string): string {
  return JSON.stringify({ registrant: { note: marker } })
}

interface SeedOverrides {
  payload?: string
  payloadCid?: string
  signOverDigestOf?: string /** sign DG-1 over a different PayloadCid than the one stored (R2). */
}

async function seedRaw (auth: TestAuthority, plaintextForCid: string, overrides?: SeedOverrides): Promise<{ id: string, requesterKey: string }> {
  const authorityId = auth.authority.id
  const id = crypto.randomUUID()
  const signer = makeRequesterSigner()
  const requesterKey = signer.publicHex
  const issuerType = 'registrant'
  const bridgeId: string | null = null
  const payload = overrides?.payload ?? plaintextForCid
  const submittedAt = toIsoZDatetime(Date.now())
  const receivedAt = toIsoZDatetime(Date.now())

  let payloadCid = overrides?.payloadCid
  if (payloadCid === undefined) {
    const cidRow = await auth.ctx.db.prepare('select Digest(:plaintext) as d').get({ plaintext: plaintextForCid })
    if (!cidRow || cidRow.d == null) throw new Error('seedRaw: PayloadCid Digest() returned null')
    payloadCid = cidRow.d as string
  }

  const digestOverPlaintext = overrides?.signOverDigestOf ?? plaintextForCid
  const signedCidRow = await auth.ctx.db.prepare('select Digest(:plaintext) as d').get({ plaintext: digestOverPlaintext })
  const signedPayloadCid = signedCidRow!.d as string
  const dg1Row = await auth.ctx.db
    .prepare('select Digest(:id, :rowAuthorityId, :requesterKey, :issuerType, :bridgeId, :payloadCid, :submittedAt) as d')
    .get({ id, rowAuthorityId: authorityId, requesterKey, issuerType, bridgeId, payloadCid: signedPayloadCid, submittedAt })
  const requesterSignature = signer.signDigest(dg1Row!.d as string)

  await auth.ctx.db.exec(
    `insert into RegistrationRequest (
      Id, AuthorityId, RequesterKey, IssuerType, BridgeId, Payload, PayloadCid, SubmittedAt, ReceivedAt, RequesterSignature
    )
    with context SigningNonce = null, Tid = :tid
    values (:id, :authorityId, :requesterKey, :issuerType, :bridgeId, :payload, :payloadCid, :submittedAt, :receivedAt, :requesterSignature)`,
    { id, authorityId, requesterKey, issuerType, bridgeId, payload, payloadCid, submittedAt, receivedAt, requesterSignature, tid: Date.now() }
  )
  return { id, requesterKey }
}

describe('RegistrationRequest.PayloadCidValid drop (D-49 schema half)', () => {
  it('R1: a sealed-shaped Payload with the PLAINTEXT-digest PayloadCid inserts and reads back byte-identical', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const marker = `r1-marker-${crypto.randomUUID()}`
    const plaintext = makePlaintextPayload(marker)

    const { id } = await seedRaw(auth, plaintext, { payload: SEALED_SHAPED_PAYLOAD })
    const row = await auth.ctx.db.prepare('select Payload, PayloadCid from RegistrationRequest where Id = :id').get({ id })
    expect(row?.Payload, 'R1: the sealed-shaped Payload must read back byte-identical').to.equal(SEALED_SHAPED_PAYLOAD)
    expect(row?.Payload, 'R1: the stored Payload must NOT contain the plaintext marker').to.not.include(marker)
  })

  it('R2: SignatureValid still pins PayloadCid at tier 1 — a signature over a DIFFERENT plaintext digest is rejected', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const plaintext = makePlaintextPayload(`r2-marker-${crypto.randomUUID()}`)
    const otherPlaintext = makePlaintextPayload(`r2-other-${crypto.randomUUID()}`)

    let caught: unknown
    try {
      await seedRaw(auth, plaintext, { payload: SEALED_SHAPED_PAYLOAD, signOverDigestOf: otherPlaintext })
    } catch (err) {
      caught = err
    }
    expect(caught, 'R2: a DG-1 signature over a different PayloadCid must be REJECTED').to.be.instanceOf(Error)
    expect((caught as Error).message).to.include('SignatureValid')
    const countRow = await auth.ctx.db.prepare('select count(*) as n from RegistrationRequest').get({})
    expect(Number(countRow?.n), 'R2: the row count must stay 0').to.equal(0)
  })

  it('R3: Payload stays immutable on update, on both a legacy plaintext row and a sealed-shaped row', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const plaintext = makePlaintextPayload(`r3-marker-${crypto.randomUUID()}`)
    const { id: legacyId } = await seedRaw(auth, plaintext) // R5-shaped: Payload = plaintext itself
    const { id: sealedId } = await seedRaw(auth, plaintext, { payload: SEALED_SHAPED_PAYLOAD })

    for (const id of [legacyId, sealedId]) {
      const before = await auth.ctx.db.prepare('select Payload from RegistrationRequest where Id = :id').get({ id })
      let caught: unknown
      try {
        await auth.ctx.db.exec(
          `update RegistrationRequest with context SigningNonce = :nonce, Tid = :tid set Payload = :other where Id = :id`,
          { id, other: 'TAMPERED', nonce: crypto.randomUUID(), tid: Date.now() }
        )
      } catch (err) {
        caught = err
      }
      expect(caught, `R3 (${id}): Payload must stay immutable`).to.be.instanceOf(Error)
      const after = await auth.ctx.db.prepare('select Payload from RegistrationRequest where Id = :id').get({ id })
      expect(after?.Payload, `R3 (${id}): stored Payload must be unchanged`).to.equal(before?.Payload)
    }
  })

  it('R4: PayloadCid stays immutable on update, on both a legacy plaintext row and a sealed-shaped row', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const plaintext = makePlaintextPayload(`r4-marker-${crypto.randomUUID()}`)
    const { id: legacyId } = await seedRaw(auth, plaintext)
    const { id: sealedId } = await seedRaw(auth, plaintext, { payload: SEALED_SHAPED_PAYLOAD })

    for (const id of [legacyId, sealedId]) {
      const before = await auth.ctx.db.prepare('select PayloadCid from RegistrationRequest where Id = :id').get({ id })
      let caught: unknown
      try {
        await auth.ctx.db.exec(
          `update RegistrationRequest with context SigningNonce = :nonce, Tid = :tid set PayloadCid = :other where Id = :id`,
          { id, other: 'a'.repeat(43), nonce: crypto.randomUUID(), tid: Date.now() }
        )
      } catch (err) {
        caught = err
      }
      expect(caught, `R4 (${id}): PayloadCid must stay immutable`).to.be.instanceOf(Error)
      const after = await auth.ctx.db.prepare('select PayloadCid from RegistrationRequest where Id = :id').get({ id })
      expect(after?.PayloadCid, `R4 (${id}): stored PayloadCid must be unchanged`).to.equal(before?.PayloadCid)
    }
  })

  it('R5: a legacy plaintext row (Payload = plaintext, matching PayloadCid) still inserts (no migration, D-07/D-34-style)', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const plaintext = makePlaintextPayload(`r5-marker-${crypto.randomUUID()}`)
    const { id } = await seedRaw(auth, plaintext) // Payload defaults to plaintextForCid itself
    const row = await auth.ctx.db.prepare('select Payload, PayloadCid from RegistrationRequest where Id = :id').get({ id })
    expect(row?.Payload, 'R5: a legacy plaintext row must insert and read back unchanged').to.equal(plaintext)
  })
})
