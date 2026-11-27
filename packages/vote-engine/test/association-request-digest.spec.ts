/**
 * association-request-digest.spec.ts — CR-03 (51-REVIEW) parity gate.
 *
 * `RestAssociationTransport` refuses to sign a handshake digest that does not equal a LOCALLY
 * recomputed one. That check is only as good as the recomputation: if
 * `association-request-digest.ts` drifted from the schema's `Digest()`, the binding would
 * reject every HONEST endpoint (a fail-closed but total outage of the D-17 ceremony), and if it
 * were a loose reimplementation it would not actually pin the bytes.
 *
 * So this suite asserts EXACT equality against a LIVE `select Digest(...)` from a real
 * `Database` with the real plugin registration — the same oracle
 * `scripts/device-proof/association-rest-bridge.mjs` serves the ceremony from, and the same
 * pattern `digest-parity.spec.ts` uses for the cross-runtime vectors. It is deliberately NOT a
 * comparison against a hard-coded expected string: a hard-coded vector would keep passing while
 * the SQL side moved underneath it, which is the exact failure this gate exists to prevent.
 *
 * Both tuples are covered, in both their present and absent optional-field forms
 * (`electionId` on leg 1, `deviceHash` on leg 2), because NULL and `''` are injective under the
 * canonical field encoding and coercing one to the other is the obvious way to get this wrong.
 */

import { Database } from '@quereus/quereus'
import { expect } from 'chai'
import type { AssociationAttestationAnswer, AssociationRequestInit, DeviceAttestation } from '@votetorrent/vote-core'
import { prepareDb } from '../src/database/initialize.js'
import {
  computeAssociationAttestationDigest,
  computeAssociationRequestDigest
} from '../src/association/transport/association-request-digest.js'

const REQUESTER_KEY = '02aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899'

function makeInit (overrides: Partial<AssociationRequestInit> = {}): AssociationRequestInit {
  return {
    id: 'assoc-req-0001',
    authorityId: 'authority-sid-0001',
    registrantId: 'registrant-0001',
    deviceKey: REQUESTER_KEY,
    electionId: 'election-0001',
    submittedAt: '2026-08-28T00:00:00.000Z',
    ...overrides
  } as AssociationRequestInit
}

function makeAnswer (overrides: Partial<AssociationAttestationAnswer> = {}): AssociationAttestationAnswer {
  const attestation = {
    type: 'ios',
    deviceId: 'app-attest-key-id-0001',
    attestationTime: '2026-08-28T00:00:00.000Z',
    // A nested object and an array, so a serializer that flattened or re-ordered would diverge.
    details: { environment: 'development', counters: [1, 2, 3] }
  } as unknown as DeviceAttestation
  return {
    requestId: 'assoc-req-0001',
    nonce: 'nonce-0001',
    attestation,
    deviceHash: 'a'.repeat(64),
    ...overrides
  } as AssociationAttestationAnswer
}

describe('association request digest parity with the schema Digest() (CR-03, 51-REVIEW)', () => {
  let db: Database

  before(async () => {
    db = new Database()
    await prepareDb(db)
  })

  // Quereus binding-key convention: placeholders are ':name' in SQL, keys are 'name' in the
  // binding object (no colon) — see digest-parity.spec.ts.
  async function sqlDigest (sql: string, bindings: Record<string, string | null>): Promise<string> {
    const row = (await db.prepare(sql).get(bindings)) as { d: unknown } | undefined
    expect(row?.d, 'Digest() returned null — crypto plugin not registered?').to.be.a('string')
    return row!.d as string
  }

  const LEG1_SQL = 'select Digest(:id, :authorityId, :registrantId, :deviceKey, :electionId, :submittedAt) as d'
  const LEG2_SQL = 'select Digest(:requestId, :nonce, :attestationJson, :deviceHash) as d'

  it('leg 1 matches Digest(Id, AuthorityId, RegistrantId, DeviceKey, ElectionId, SubmittedAt)', async () => {
    const init = makeInit()
    const expected = await sqlDigest(LEG1_SQL, {
      id: init.id,
      authorityId: init.authorityId,
      registrantId: init.registrantId,
      deviceKey: REQUESTER_KEY,
      electionId: init.electionId ?? null,
      submittedAt: init.submittedAt
    })
    expect(computeAssociationRequestDigest(init, REQUESTER_KEY)).to.equal(expected)
  })

  it('leg 1 binds an absent electionId as SQL NULL, not as an empty string', async () => {
    const init = makeInit({ electionId: undefined })
    const expected = await sqlDigest(LEG1_SQL, {
      id: init.id,
      authorityId: init.authorityId,
      registrantId: init.registrantId,
      deviceKey: REQUESTER_KEY,
      electionId: null,
      submittedAt: init.submittedAt
    })
    expect(computeAssociationRequestDigest(init, REQUESTER_KEY)).to.equal(expected)

    // And the NULL form must NOT collide with the empty-string form, or the "?? null" above
    // would be an unobservable detail rather than a load-bearing one.
    const emptyStringForm = await sqlDigest(LEG1_SQL, {
      id: init.id,
      authorityId: init.authorityId,
      registrantId: init.registrantId,
      deviceKey: REQUESTER_KEY,
      electionId: '',
      submittedAt: init.submittedAt
    })
    expect(expected).to.not.equal(emptyStringForm)
  })

  it('leg 1 binds requesterKey (not init.deviceKey) into the DeviceKey position', async () => {
    // The engine binds `const deviceKey = requesterKey`. Prove this helper follows the engine
    // and not the init field, by feeding it an init whose deviceKey disagrees.
    const init = makeInit({ deviceKey: 'a-different-key' })
    const expected = await sqlDigest(LEG1_SQL, {
      id: init.id,
      authorityId: init.authorityId,
      registrantId: init.registrantId,
      deviceKey: REQUESTER_KEY,
      electionId: init.electionId ?? null,
      submittedAt: init.submittedAt
    })
    expect(computeAssociationRequestDigest(init, REQUESTER_KEY)).to.equal(expected)
  })

  it('leg 2 matches Digest(RequestId, Nonce, AttestationJson, DeviceHash)', async () => {
    const answer = makeAnswer()
    const expected = await sqlDigest(LEG2_SQL, {
      requestId: answer.requestId,
      nonce: answer.nonce,
      attestationJson: JSON.stringify(answer.attestation),
      deviceHash: answer.deviceHash ?? null
    })
    expect(computeAssociationAttestationDigest(answer)).to.equal(expected)
  })

  it('leg 2 binds an absent deviceHash as SQL NULL, not as an empty string', async () => {
    const answer = makeAnswer({ deviceHash: undefined })
    const expected = await sqlDigest(LEG2_SQL, {
      requestId: answer.requestId,
      nonce: answer.nonce,
      attestationJson: JSON.stringify(answer.attestation),
      deviceHash: null
    })
    expect(computeAssociationAttestationDigest(answer)).to.equal(expected)
  })

  it('leg 2 survives a JSON round-trip of the attestation (the wire form the endpoint sees)', async () => {
    // The bridge re-stringifies the object it parsed out of the POST body. Key order survives
    // JSON.parse(JSON.stringify(x)), so both sides must land on the same digest — if this ever
    // stops holding, the client-side CR-03 check would reject every honest endpoint.
    const answer = makeAnswer()
    const roundTripped = JSON.parse(JSON.stringify(answer)) as AssociationAttestationAnswer
    expect(computeAssociationAttestationDigest(roundTripped)).to.equal(computeAssociationAttestationDigest(answer))
  })
})
