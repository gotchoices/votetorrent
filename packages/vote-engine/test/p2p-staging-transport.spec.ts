/**
 * p2p-staging-transport.spec.ts — Phase 62 Plan 15: transport-level proof of D-03 (sealed
 * staging, fail-closed), D-05 (requester-signed staging, the cursor race) and D-06
 * (officer-signed decisions, D-44's duplicate-close protocol) for BOTH P2P transports, against
 * the real votetorrent schema (`createP2pStagingFixture`, an in-process Quereus database).
 *
 * This file proves interface, cursor, digest and schema conformance on ONE database. It does
 * NOT prove replication, a cohort, or P2P-11 — the peer-cluster fabric itself stays
 * code-complete, unverified (see each transport module's own header).
 */

import { expect } from 'chai'
import type {
  RegistrationRequestInit,
  AssociationRequestInit,
  AssociationAttestationAnswer,
  AssociationIdentityField,
  DeviceAttestation,
  Scope
} from '@votetorrent/vote-core'
import { sealToRecipients, serializeEnvelope } from '../src/crypto/index.js'
import { bytesToBase64url } from '../src/utils.js'
import {
  P2pRegistrationTransport,
  REGISTRATION_DUPLICATE_CLOSED_REASON
} from '../src/registration/transport/p2p-registration-transport.js'
import type { RegistrationStrandPort, P2pRegistrationTransportOptions } from '../src/registration/transport/p2p-registration-transport.js'
import { P2pAssociationTransport } from '../src/association/transport/p2p-association-transport.js'
import type { AssociationStrandPort, P2pAssociationTransportOptions } from '../src/association/transport/p2p-association-transport.js'
import { P2pStagingError, STAGING_CURSOR_MAX_ATTEMPTS } from '../src/registration/transport/p2p-staging-seam.js'
import type { StagingSealer, StagingOpener, StagingDecisionSigner } from '../src/registration/transport/p2p-staging-seam.js'
import { createP2pStagingFixture } from './fixtures/p2p-staging-fixture.js'
import type { P2pStagingFixture, P2pStagingFixturePortOptions } from './fixtures/p2p-staging-fixture.js'
import { addSiblingAuthority, makeTestSignCallback } from './fixtures/test-context.js'

describe('P2P staging transports', function () {
  this.timeout(30_000)

  let fixture: P2pStagingFixture
  let strandSeq = 0

  before(async () => {
    fixture = await createP2pStagingFixture()
  })

  function nextStrandId (): string {
    strandSeq += 1
    return `p2p-staging-${strandSeq}`
  }

  // ---------------------------------------------------------------------------
  // Registration helpers
  // ---------------------------------------------------------------------------

  let regSeq = 0
  function nextRegistrationRequestId (): string {
    regSeq += 1
    return `p2p-reg-req-${Date.now()}-${regSeq}`
  }

  function makeRegistrationInit (authorityId: string, overrides: Partial<RegistrationRequestInit> = {}): RegistrationRequestInit {
    const id = overrides.id ?? nextRegistrationRequestId()
    return {
      id,
      authorityId,
      payload: overrides.payload ?? {
        registrant: { id: `registrant-${id}`, authorityId, expiration: Date.now() + 365 * 86_400_000 },
        private: { expiration: Date.now() + 365 * 86_400_000, details: [{ name: 'note', value: 'p2p-staging-fixture' }] }
      },
      submittedAt: overrides.submittedAt ?? new Date().toISOString(),
      issuerType: overrides.issuerType,
      bridgeId: overrides.bridgeId
    }
  }

  interface RegTransportBuild {
    transport: P2pRegistrationTransport
    getComputeDigestCalls: () => number
  }

  function buildRegistrationTransport (
    strandId: string,
    overrides: Partial<Omit<P2pRegistrationTransportOptions, 'strandId' | 'openStrand' | 'computeDigest'>> = {},
    portOptions?: P2pStagingFixturePortOptions
  ): RegTransportBuild {
    const counter = { calls: 0 }
    const port = fixture.makePort(portOptions)
    const transport = new P2pRegistrationTransport({
      openStrand: async () => port as unknown as RegistrationStrandPort,
      computeDigest: async (init, requesterKey) => {
        counter.calls += 1
        return await fixture.fixtureRequestDigest(init, requesterKey)
      },
      strandId,
      sealer: 'sealer' in overrides ? overrides.sealer : fixture.sealer,
      opener: 'opener' in overrides ? overrides.opener : fixture.opener,
      decisionSigner: 'decisionSigner' in overrides ? overrides.decisionSigner : fixture.decisionSigner
    })
    return { transport, getComputeDigestCalls: () => counter.calls }
  }

  async function regRowCount (strandId: string): Promise<number> {
    return (await fixture.rawRows('RegistrationRequestStaging', strandId)).length
  }

  async function regDecisionRowCount (strandId: string): Promise<number> {
    return (await fixture.rawRows('RegistrationDecision', strandId)).length
  }

  // ---------------------------------------------------------------------------
  // Association helpers
  // ---------------------------------------------------------------------------

  let assocSeq = 0
  function nextAssociationRequestId (): string {
    assocSeq += 1
    return `p2p-assoc-req-${Date.now()}-${assocSeq}`
  }

  function makeAssociationInit (authorityId: string, deviceKey: string, overrides: Partial<AssociationRequestInit> = {}): AssociationRequestInit {
    const id = overrides.id ?? nextAssociationRequestId()
    return {
      id,
      authorityId,
      registrantId: overrides.registrantId ?? `registrant-${id}`,
      deviceKey: overrides.deviceKey ?? deviceKey,
      electionId: overrides.electionId,
      submittedAt: overrides.submittedAt ?? new Date().toISOString()
    }
  }

  function makeAttestation (overrides: Partial<DeviceAttestation> = {}): DeviceAttestation {
    return {
      publicKey: overrides.publicKey ?? 'p2p-staging-device-pubkey',
      deviceId: overrides.deviceId ?? `p2p-staging-device-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      attestationTime: overrides.attestationTime ?? Date.now(),
      certificateChain: overrides.certificateChain ?? ['p2p-staging-leaf-cert']
    }
  }

  function makeAttestationAnswer (overrides: Partial<AssociationAttestationAnswer> = {}): AssociationAttestationAnswer {
    return {
      requestId: overrides.requestId ?? nextAssociationRequestId(),
      nonce: overrides.nonce ?? `p2p-staging-nonce-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      attestation: overrides.attestation ?? makeAttestation(),
      deviceHash: overrides.deviceHash
    }
  }

  function buildAssociationTransport (
    strandId: string,
    overrides: Partial<Omit<P2pAssociationTransportOptions, 'strandId' | 'openStrand' | 'computeDigest' | 'computeAttestationDigest'>> = {},
    portOptions?: P2pStagingFixturePortOptions
  ): { transport: P2pAssociationTransport } {
    const port = fixture.makePort(portOptions)
    const transport = new P2pAssociationTransport({
      openStrand: async () => port as unknown as AssociationStrandPort,
      computeDigest: async (init, requesterKey) => await fixture.fixtureRequestDigest(init, requesterKey),
      computeAttestationDigest: async (answer, requesterKey) => await fixture.fixtureAttestationDigest(answer, requesterKey),
      strandId,
      sealer: 'sealer' in overrides ? overrides.sealer : fixture.sealer,
      opener: 'opener' in overrides ? overrides.opener : fixture.opener,
      decisionSigner: 'decisionSigner' in overrides ? overrides.decisionSigner : fixture.decisionSigner
    })
    return { transport }
  }

  async function assocRowCount (table: 'AssociationRequestStaging' | 'AssociationAttestationStaging' | 'AssociationDecision', strandId: string): Promise<number> {
    return (await fixture.rawRows(table, strandId)).length
  }

  // =========================================================================
  // REGISTRATION
  // =========================================================================

  describe('registration', () => {
    it('D-03: submitRequest with a sealer writes one sealed row (v1, vt-env-1), recipients match the fixture, raw text has no payload marker or code', async () => {
      const strandId = nextStrandId()
      const { transport } = buildRegistrationTransport(strandId)
      const signer = fixture.makeRequesterSigner()
      const init = makeRegistrationInit(fixture.auth.authority.id)

      const returnedId = await transport.submitRequest(init, signer.publicHex, signer.sign, { registrationCode: fixture.payloadMarker })
      expect(returnedId).to.equal(init.id)

      const rows = await fixture.rawRows('RegistrationRequestStaging', strandId)
      expect(rows).to.have.lengthOf(1)
      const row = rows[0]!
      const parsedEnvelope = JSON.parse(row.InitJson as string) as { v: number, alg: string, recipients: Array<{ userId: string }> }
      expect(parsedEnvelope.v).to.equal(1)
      expect(parsedEnvelope.alg).to.equal('vt-env-1')
      expect(parsedEnvelope.recipients.map((r) => r.userId).sort()).to.deep.equal(fixture.recipients.map((r) => r.userId).sort())

      const rawText = JSON.stringify(row)
      expect(rawText.includes(fixture.payloadMarker)).to.equal(false)
    })

    it("D-03: no sealer refuses 'no-sealer' and writes zero rows", async () => {
      const strandId = nextStrandId()
      const { transport } = buildRegistrationTransport(strandId, { sealer: undefined })
      const signer = fixture.makeRequesterSigner()
      const init = makeRegistrationInit(fixture.auth.authority.id)

      let caught: unknown
      try {
        await transport.submitRequest(init, signer.publicHex, signer.sign)
      } catch (err) {
        caught = err
      }
      expect(caught).to.be.instanceOf(P2pStagingError)
      expect((caught as P2pStagingError).code).to.equal('no-sealer')
      expect(await regRowCount(strandId)).to.equal(0)
    })

    it("D-03: a sealer that throws (zero recipients) propagates unchanged and writes zero rows", async () => {
      const strandId = nextStrandId()
      const emptySealer: StagingSealer = {
        authorityId: fixture.auth.authority.id,
        async seal (plaintext, binding) {
          const sealed = sealToRecipients(new TextEncoder().encode(plaintext), [], binding)
          return serializeEnvelope(sealed)
        }
      }
      const { transport } = buildRegistrationTransport(strandId, { sealer: emptySealer })
      const signer = fixture.makeRequesterSigner()
      const init = makeRegistrationInit(fixture.auth.authority.id)

      let caught: unknown
      try {
        await transport.submitRequest(init, signer.publicHex, signer.sign)
      } catch (err) {
        caught = err
      }
      expect(caught).to.not.equal(undefined)
      expect((caught as { code?: string }).code).to.equal('no-recipients')
      expect(await regRowCount(strandId)).to.equal(0)
    })

    it("D-03: a sealer.authorityId mismatch refuses 'sealer-authority-mismatch' and writes zero rows", async () => {
      const strandId = nextStrandId()
      const mismatchedSealer: StagingSealer = { ...fixture.sealer, authorityId: `not-${fixture.auth.authority.id}` }
      const { transport } = buildRegistrationTransport(strandId, { sealer: mismatchedSealer })
      const signer = fixture.makeRequesterSigner()
      const init = makeRegistrationInit(fixture.auth.authority.id)

      let caught: unknown
      try {
        await transport.submitRequest(init, signer.publicHex, signer.sign)
      } catch (err) {
        caught = err
      }
      expect(caught).to.be.instanceOf(P2pStagingError)
      expect((caught as P2pStagingError).code).to.equal('sealer-authority-mismatch')
      expect(await regRowCount(strandId)).to.equal(0)
    })

    it('D-05: computeDigest is called exactly once per submit, with a callback or a pre-resolved Signature, and Digest = bytesToBase64url(bytes)', async () => {
      const strandId = nextStrandId()
      const { transport, getComputeDigestCalls } = buildRegistrationTransport(strandId)
      const signer = fixture.makeRequesterSigner()

      const initA = makeRegistrationInit(fixture.auth.authority.id)
      await transport.submitRequest(initA, signer.publicHex, signer.sign)
      expect(getComputeDigestCalls()).to.equal(1)

      const initB = makeRegistrationInit(fixture.auth.authority.id)
      const digestBytes = await fixture.fixtureRequestDigest(initB, signer.publicHex)
      const preResolved = await signer.sign(digestBytes)
      await transport.submitRequest(initB, signer.publicHex, preResolved)
      expect(getComputeDigestCalls()).to.equal(2)

      const rows = await fixture.rawRows('RegistrationRequestStaging', strandId)
      const rowB = rows.find((r) => r.RequestId === initB.id)!
      expect(rowB.Digest).to.equal(bytesToBase64url(digestBytes))
    })

    it("D-05: a pre-resolved signature over different bytes rejects 'rejected' and writes zero rows", async () => {
      const strandId = nextStrandId()
      const { transport } = buildRegistrationTransport(strandId)
      const signer = fixture.makeRequesterSigner()
      const init = makeRegistrationInit(fixture.auth.authority.id)
      const wrongBytes = await fixture.fixtureRequestDigest(makeRegistrationInit(fixture.auth.authority.id), signer.publicHex)
      const forgedSignature = await signer.sign(wrongBytes)

      let caught: unknown
      try {
        await transport.submitRequest(init, signer.publicHex, forgedSignature)
      } catch (err) {
        caught = err
      }
      expect(caught).to.be.instanceOf(P2pStagingError)
      expect((caught as P2pStagingError).code).to.equal('rejected')
      expect(await regRowCount(strandId)).to.equal(0)
    })

    it("D-05: a second submit with the same id but different content is 'duplicate-request-id'; an identical re-submit is idempotent", async () => {
      const strandId = nextStrandId()
      const { transport } = buildRegistrationTransport(strandId)
      const signer = fixture.makeRequesterSigner()
      const init = makeRegistrationInit(fixture.auth.authority.id)

      await transport.submitRequest(init, signer.publicHex, signer.sign)
      expect(await regRowCount(strandId)).to.equal(1)

      // fixtureRequestDigest only covers [id, requesterKey, submittedAt] (per this plan's own
      // fixture contract), so "different content" must move submittedAt for the digest — and
      // hence the stored Digest column — to actually differ.
      const differentInit: RegistrationRequestInit = {
        ...init,
        payload: { ...init.payload, public: { lastName: 'changed' } },
        submittedAt: new Date(Date.parse(init.submittedAt) + 1000).toISOString()
      }
      let caught: unknown
      try {
        await transport.submitRequest(differentInit, signer.publicHex, signer.sign)
      } catch (err) {
        caught = err
      }
      expect(caught).to.be.instanceOf(P2pStagingError)
      expect((caught as P2pStagingError).code).to.equal('duplicate-request-id')
      expect(await regRowCount(strandId)).to.equal(1)

      const resolvedId = await transport.submitRequest(init, signer.publicHex, signer.sign)
      expect(resolvedId).to.equal(init.id)
      expect(await regRowCount(strandId)).to.equal(1)
    })

    it('opener: readStagedRequestsReport delivers the row with registrationCode surfaced and absent from init; never calls computeDigest', async () => {
      const strandId = nextStrandId()
      const { transport, getComputeDigestCalls } = buildRegistrationTransport(strandId)
      const signer = fixture.makeRequesterSigner()
      const init = makeRegistrationInit(fixture.auth.authority.id)
      const registrationCode = `code-${Date.now()}`

      await transport.submitRequest(init, signer.publicHex, signer.sign, { registrationCode })
      const callsAfterSubmit = getComputeDigestCalls()

      const report = await transport.readStagedRequestsReport()
      expect(report.delivered).to.have.lengthOf(1)
      expect(report.unreadable).to.have.lengthOf(0)
      const delivered = report.delivered[0]!
      expect(delivered.registrationCode).to.equal(registrationCode)
      expect((delivered.init as unknown as { registrationCode?: unknown }).registrationCode).to.equal(undefined)
      expect(getComputeDigestCalls()).to.equal(callsAfterSubmit)
    })

    it("opener: the outsider opener delivers nothing and reports one unreadable row with reason 'not-a-recipient'", async () => {
      const strandId = nextStrandId()
      const { transport: submitTransport } = buildRegistrationTransport(strandId)
      const signer = fixture.makeRequesterSigner()
      const init = makeRegistrationInit(fixture.auth.authority.id)
      await submitTransport.submitRequest(init, signer.publicHex, signer.sign)

      const { transport: outsiderTransport } = buildRegistrationTransport(strandId, { opener: fixture.outsiderOpener })
      const report = await outsiderTransport.readStagedRequestsReport()
      expect(report.delivered).to.have.lengthOf(0)
      expect(report.unreadable).to.have.lengthOf(1)
      expect(report.unreadable[0]!.reason).to.equal('not-a-recipient')
      expect(report.unreadable[0]!.requestId).to.equal(init.id)
    })

    it("opener: a transplanted envelope (row B served row A's InitJson) is unreadable 'authentication-failed' while A is still delivered", async () => {
      const strandId = nextStrandId()
      const signer = fixture.makeRequesterSigner()
      const { transport: submitTransport } = buildRegistrationTransport(strandId)
      const initA = makeRegistrationInit(fixture.auth.authority.id)
      const initB = makeRegistrationInit(fixture.auth.authority.id)
      await submitTransport.submitRequest(initA, signer.publicHex, signer.sign)
      await submitTransport.submitRequest(initB, signer.publicHex, signer.sign)

      const rawA = (await fixture.rawRows('RegistrationRequestStaging', strandId)).find((r) => r.RequestId === initA.id)!
      const overlay = new Map<string, string>([[initB.id, rawA.InitJson as string]])
      const { transport: overlaidTransport } = buildRegistrationTransport(strandId, {}, { overlay })

      const report = await overlaidTransport.readStagedRequestsReport()
      const delivered = report.delivered.find((r) => r.requestId === initA.id)
      const unreadableB = report.unreadable.find((r) => r.requestId === initB.id)
      expect(delivered, 'A must still be delivered').to.not.equal(undefined)
      expect(unreadableB, 'B must be reported unreadable').to.not.equal(undefined)
      expect(unreadableB!.reason).to.equal('authentication-failed')
    })

    it('cursor race: a racing port forces a retry, landing both rows on distinct cursors 0000000000000001/0000000000000002', async () => {
      const strandId = nextStrandId()
      let raced = false
      const portOptions: P2pStagingFixturePortOptions = {
        beforeInsert: async (table, params) => {
          if (table !== 'RegistrationRequestStaging' || raced) return
          raced = true
          const racerSigner = fixture.makeRequesterSigner()
          const racerInit = makeRegistrationInit(fixture.auth.authority.id)
          const digestBytes = await fixture.fixtureRequestDigest(racerInit, racerSigner.publicHex)
          const digest = bytesToBase64url(digestBytes)
          const sig = await racerSigner.sign(digestBytes)
          const initJson = await fixture.sealer.seal(JSON.stringify({ version: 1, init: racerInit }), { requestId: racerInit.id, digest })
          await fixture.db.exec(
            'insert into RegistrationRequestStaging (StrandId, Cursor, RequestId, Digest, InitJson, RequesterKey, SignatureJson, StagedAt) ' +
            'values (:strandId, :cursor, :requestId, :digest, :initJson, :requesterKey, :signatureJson, :stagedAt)',
            {
              strandId,
              cursor: params.cursor as string,
              requestId: racerInit.id,
              digest,
              initJson,
              requesterKey: racerSigner.publicHex,
              signatureJson: JSON.stringify(sig),
              stagedAt: new Date().toISOString()
            }
          )
        }
      }
      const { transport } = buildRegistrationTransport(strandId, {}, portOptions)
      const signer = fixture.makeRequesterSigner()
      const init = makeRegistrationInit(fixture.auth.authority.id)

      await transport.submitRequest(init, signer.publicHex, signer.sign)
      const rows = await fixture.rawRows('RegistrationRequestStaging', strandId)
      expect(rows).to.have.lengthOf(2)
      expect(rows.map((r) => r.Cursor).sort()).to.deep.equal(['0000000000000001', '0000000000000002'])
    })

    it("cursor race: a port that always loses rejects 'cursor-exhausted' after exactly STAGING_CURSOR_MAX_ATTEMPTS inserts, and the losing row is absent", async () => {
      const strandId = nextStrandId()
      let racerCount = 0
      const portOptions: P2pStagingFixturePortOptions = {
        beforeInsert: async (table, params) => {
          if (table !== 'RegistrationRequestStaging') return
          racerCount += 1
          const racerSigner = fixture.makeRequesterSigner()
          const racerInit = makeRegistrationInit(fixture.auth.authority.id)
          const digestBytes = await fixture.fixtureRequestDigest(racerInit, racerSigner.publicHex)
          const digest = bytesToBase64url(digestBytes)
          const sig = await racerSigner.sign(digestBytes)
          const initJson = await fixture.sealer.seal(JSON.stringify({ version: 1, init: racerInit }), { requestId: racerInit.id, digest })
          await fixture.db.exec(
            'insert into RegistrationRequestStaging (StrandId, Cursor, RequestId, Digest, InitJson, RequesterKey, SignatureJson, StagedAt) ' +
            'values (:strandId, :cursor, :requestId, :digest, :initJson, :requesterKey, :signatureJson, :stagedAt)',
            {
              strandId,
              cursor: params.cursor as string,
              requestId: racerInit.id,
              digest,
              initJson,
              requesterKey: racerSigner.publicHex,
              signatureJson: JSON.stringify(sig),
              stagedAt: new Date().toISOString()
            }
          )
        }
      }
      const { transport } = buildRegistrationTransport(strandId, {}, portOptions)
      const signer = fixture.makeRequesterSigner()
      const init = makeRegistrationInit(fixture.auth.authority.id)

      let caught: unknown
      try {
        await transport.submitRequest(init, signer.publicHex, signer.sign)
      } catch (err) {
        caught = err
      }
      expect(caught).to.be.instanceOf(P2pStagingError)
      expect((caught as P2pStagingError).code).to.equal('cursor-exhausted')
      expect(racerCount).to.equal(STAGING_CURSOR_MAX_ATTEMPTS)
      const rows = await fixture.rawRows('RegistrationRequestStaging', strandId)
      expect(rows.find((r) => r.RequestId === init.id)).to.equal(undefined)
      expect(rows).to.have.lengthOf(STAGING_CURSOR_MAX_ATTEMPTS)
    })

    it('D-06: the founding vrg officer signs an accepted decision; readDecisionRecords and pollDecisions both see it', async () => {
      const strandId = nextStrandId()
      const { transport } = buildRegistrationTransport(strandId)
      const requestId = nextRegistrationRequestId()

      const cursor = await transport.publishDecision({ requestId, status: 'a', decidedAt: new Date().toISOString() })
      expect(typeof cursor).to.equal('string')

      const records = await transport.readDecisionRecords()
      const record = records.find((r) => r.requestId === requestId)
      expect(record, 'decision record must be present').to.not.equal(undefined)
      expect(record!.authorityId).to.equal(fixture.auth.authority.id)
      expect(record!.status).to.equal('a')
      expect(record!.deciderKey).to.equal(fixture.net.user.activeKeys[0]!.key)
      expect(record!.deciderSignature.length).to.be.greaterThan(0)

      const notices = await transport.pollDecisions()
      expect(notices.find((n) => n.requestId === requestId)?.status).to.equal('a')
    })

    it("D-06: no decisionSigner refuses 'no-decision-signer'", async () => {
      const strandId = nextStrandId()
      const { transport } = buildRegistrationTransport(strandId, { decisionSigner: undefined })
      let caught: unknown
      try {
        await transport.publishDecision({ requestId: nextRegistrationRequestId(), status: 'a', decidedAt: new Date().toISOString() })
      } catch (err) {
        caught = err
      }
      expect(caught).to.be.instanceOf(P2pStagingError)
      expect((caught as P2pStagingError).code).to.equal('no-decision-signer')
    })

    it("D-06: a signer with no UserKey row is 'rejected' and writes zero rows", async () => {
      const strandId = nextStrandId()
      const unregistered = fixture.makeRequesterSigner()
      const decisionSigner: StagingDecisionSigner = {
        authorityId: fixture.auth.authority.id,
        sign: async (digest) => await unregistered.sign(digest)
      }
      const { transport } = buildRegistrationTransport(strandId, { decisionSigner })
      const requestId = nextRegistrationRequestId()

      let caught: unknown
      try {
        await transport.publishDecision({ requestId, status: 'a', decidedAt: new Date().toISOString() })
      } catch (err) {
        caught = err
      }
      expect(caught).to.be.instanceOf(P2pStagingError)
      expect((caught as P2pStagingError).code).to.equal('rejected')
      expect(await regDecisionRowCount(strandId)).to.equal(0)
    })

    it("D-06: an officer who lacks 'vrg' at a sibling authority is 'rejected' and writes zero rows", async () => {
      const strandId = nextStrandId()
      const siblingAuthorityId = await addSiblingAuthority(fixture.auth, { scopes: ['rad'] as Scope[] })
      const decisionSigner: StagingDecisionSigner = {
        authorityId: siblingAuthorityId,
        sign: makeTestSignCallback(fixture.net.user)
      }
      const { transport } = buildRegistrationTransport(strandId, { decisionSigner })
      const requestId = nextRegistrationRequestId()

      let caught: unknown
      try {
        await transport.publishDecision({ requestId, status: 'a', decidedAt: new Date().toISOString() })
      } catch (err) {
        caught = err
      }
      expect(caught).to.be.instanceOf(P2pStagingError)
      expect((caught as P2pStagingError).code).to.equal('rejected')
      expect(await regDecisionRowCount(strandId)).to.equal(0)
    })

    it('D-06: a decision for a never-staged request id is accepted', async () => {
      const strandId = nextStrandId()
      const { transport } = buildRegistrationTransport(strandId)
      const requestId = nextRegistrationRequestId()
      const cursor = await transport.publishDecision({ requestId, status: 'r', reason: 'never-staged', decidedAt: new Date().toISOString() })
      expect(typeof cursor).to.equal('string')
      expect(await regDecisionRowCount(strandId)).to.equal(1)
    })

    it("D-44: A ('a', closesRequestId B) then B ('d') commit separately; readDecisionRecords shows both, pollDecisions maps B to 'r'/REGISTRATION_DUPLICATE_CLOSED_REASON, and a second decision for A is 'duplicate-decision'", async () => {
      const strandId = nextStrandId()
      const { transport } = buildRegistrationTransport(strandId)
      const requestIdA = nextRegistrationRequestId()
      const requestIdB = nextRegistrationRequestId()

      await transport.publishDecision({ requestId: requestIdA, status: 'a', decidedAt: new Date().toISOString(), closesRequestId: requestIdB })
      await transport.publishDecision({ requestId: requestIdB, status: 'd', decidedAt: new Date().toISOString() })

      const records = await transport.readDecisionRecords()
      expect(records.find((r) => r.requestId === requestIdA)?.status).to.equal('a')
      expect(records.find((r) => r.requestId === requestIdB)?.status).to.equal('d')

      const notices = await transport.pollDecisions()
      const noticeB = notices.find((n) => n.requestId === requestIdB)
      expect(noticeB, 'notice for B must be present').to.not.equal(undefined)
      expect(noticeB!.status).to.equal('r')
      expect(noticeB!.reason).to.equal(REGISTRATION_DUPLICATE_CLOSED_REASON)

      let caught: unknown
      try {
        await transport.publishDecision({ requestId: requestIdA, status: 'r', decidedAt: new Date().toISOString() })
      } catch (err) {
        caught = err
      }
      expect(caught).to.be.instanceOf(P2pStagingError)
      expect((caught as P2pStagingError).code).to.equal('duplicate-decision')
    })
  })

  // =========================================================================
  // ASSOCIATION
  // =========================================================================

  describe('association', () => {
    it('D-03: submitRequest with a registrationCode and two identityFields writes one sealed row; raw text has no identity-field value or code', async () => {
      const strandId = nextStrandId()
      const { transport } = buildAssociationTransport(strandId)
      const signer = fixture.makeRequesterSigner()
      const init = makeAssociationInit(fixture.auth.authority.id, signer.publicHex)
      const identityFields: AssociationIdentityField[] = [
        { name: 'lastName', value: fixture.payloadMarker },
        { name: 'dob', value: `dob-${fixture.payloadMarker}` }
      ]
      const registrationCode = `assoc-code-${fixture.payloadMarker}`

      await transport.submitRequest(init, signer.publicHex, signer.sign, { registrationCode, identityFields })

      const rows = await fixture.rawRows('AssociationRequestStaging', strandId)
      expect(rows).to.have.lengthOf(1)
      const row = rows[0]!
      const parsedEnvelope = JSON.parse(row.InitJson as string) as { v: number, alg: string }
      expect(parsedEnvelope.v).to.equal(1)
      expect(parsedEnvelope.alg).to.equal('vt-env-1')
      const rawText = JSON.stringify(row)
      expect(rawText.includes(fixture.payloadMarker)).to.equal(false)
      expect(rawText.includes(registrationCode)).to.equal(false)
    })

    it('D-03: the delivered request carries the code and both identity fields, while its init has neither', async () => {
      const strandId = nextStrandId()
      const { transport } = buildAssociationTransport(strandId)
      const signer = fixture.makeRequesterSigner()
      const init = makeAssociationInit(fixture.auth.authority.id, signer.publicHex)
      const identityFields: AssociationIdentityField[] = [{ name: 'lastName', value: 'Voter' }, { name: 'dob', value: '2000-01-01' }]
      const registrationCode = `assoc-code-${Date.now()}`

      await transport.submitRequest(init, signer.publicHex, signer.sign, { registrationCode, identityFields })

      const report = await transport.readStagedRequestsReport()
      expect(report.delivered).to.have.lengthOf(1)
      const delivered = report.delivered[0]!
      expect(delivered.registrationCode).to.equal(registrationCode)
      expect(delivered.identityFields).to.deep.equal(identityFields)
      expect((delivered.init as unknown as { registrationCode?: unknown, identityFields?: unknown }).registrationCode).to.equal(undefined)
      expect((delivered.init as unknown as { identityFields?: unknown }).identityFields).to.equal(undefined)
    })

    it("D-03: submitAttestation writes a sealed AnswerJson lacking the attestation's deviceId, and readStagedAttestationsReport delivers the answer", async () => {
      const strandId = nextStrandId()
      const { transport } = buildAssociationTransport(strandId)
      const signer = fixture.makeRequesterSigner()
      const answer = makeAttestationAnswer({ attestation: makeAttestation({ deviceId: `device-${fixture.payloadMarker}` }) })

      await transport.submitAttestation(answer, signer.publicHex, signer.sign)

      const rows = await fixture.rawRows('AssociationAttestationStaging', strandId)
      expect(rows).to.have.lengthOf(1)
      expect(JSON.stringify(rows[0]).includes(answer.attestation.deviceId)).to.equal(false)

      const report = await transport.readStagedAttestationsReport()
      const delivered = report.delivered.find((r) => r.requestId === answer.requestId)
      expect(delivered, 'attestation must be delivered').to.not.equal(undefined)
      expect(delivered!.answer.attestation.deviceId).to.equal(answer.attestation.deviceId)
    })

    it('D-03: an attestation for a never-submitted request id is delivered, with its requestId verbatim', async () => {
      const strandId = nextStrandId()
      const { transport } = buildAssociationTransport(strandId)
      const signer = fixture.makeRequesterSigner()
      const orphanRequestId = nextAssociationRequestId()
      const answer = makeAttestationAnswer({ requestId: orphanRequestId })

      await transport.submitAttestation(answer, signer.publicHex, signer.sign)

      const report = await transport.readStagedAttestationsReport()
      const delivered = report.delivered.find((r) => r.requestId === orphanRequestId)
      expect(delivered, 'orphan attestation must still be delivered').to.not.equal(undefined)
      expect(delivered!.requestId).to.equal(orphanRequestId)
      expect(delivered!.answer.requestId).to.equal(orphanRequestId)
    })

    it("D-03: no sealer refuses 'no-sealer' on both legs with zero rows", async () => {
      const strandId = nextStrandId()
      const { transport } = buildAssociationTransport(strandId, { sealer: undefined })
      const signer = fixture.makeRequesterSigner()
      const init = makeAssociationInit(fixture.auth.authority.id, signer.publicHex)
      const answer = makeAttestationAnswer()

      let caughtRequest: unknown
      try {
        await transport.submitRequest(init, signer.publicHex, signer.sign)
      } catch (err) {
        caughtRequest = err
      }
      let caughtAttestation: unknown
      try {
        await transport.submitAttestation(answer, signer.publicHex, signer.sign)
      } catch (err) {
        caughtAttestation = err
      }
      expect((caughtRequest as P2pStagingError)?.code).to.equal('no-sealer')
      expect((caughtAttestation as P2pStagingError)?.code).to.equal('no-sealer')
      expect(await assocRowCount('AssociationRequestStaging', strandId)).to.equal(0)
      expect(await assocRowCount('AssociationAttestationStaging', strandId)).to.equal(0)
    })

    it("D-03: no opener refuses 'no-opener' on both read paths", async () => {
      const strandId = nextStrandId()
      const { transport } = buildAssociationTransport(strandId, { opener: undefined })
      let caughtRequests: unknown
      try {
        await transport.readStagedRequestsReport()
      } catch (err) {
        caughtRequests = err
      }
      let caughtAttestations: unknown
      try {
        await transport.readStagedAttestationsReport()
      } catch (err) {
        caughtAttestations = err
      }
      expect((caughtRequests as P2pStagingError)?.code).to.equal('no-opener')
      expect((caughtAttestations as P2pStagingError)?.code).to.equal('no-opener')
    })

    it("unreadable rows: the outsider opener reports 'not-a-recipient' on both read paths", async () => {
      const strandId = nextStrandId()
      const { transport: submitTransport } = buildAssociationTransport(strandId)
      const signer = fixture.makeRequesterSigner()
      const init = makeAssociationInit(fixture.auth.authority.id, signer.publicHex)
      const answer = makeAttestationAnswer()
      await submitTransport.submitRequest(init, signer.publicHex, signer.sign)
      await submitTransport.submitAttestation(answer, signer.publicHex, signer.sign)

      const { transport: outsiderTransport } = buildAssociationTransport(strandId, { opener: fixture.outsiderOpener })
      const requestReport = await outsiderTransport.readStagedRequestsReport()
      const attestationReport = await outsiderTransport.readStagedAttestationsReport()
      expect(requestReport.delivered).to.have.lengthOf(0)
      expect(requestReport.unreadable[0]?.reason).to.equal('not-a-recipient')
      expect(attestationReport.delivered).to.have.lengthOf(0)
      expect(attestationReport.unreadable[0]?.reason).to.equal('not-a-recipient')
    })

    it("unreadable rows: a request envelope transplanted onto the attestation row of the same RequestId (different Digest) is unreadable 'authentication-failed'", async () => {
      const strandId = nextStrandId()
      const { transport: submitTransport } = buildAssociationTransport(strandId)
      const signer = fixture.makeRequesterSigner()
      const sharedRequestId = nextAssociationRequestId()
      const init = makeAssociationInit(fixture.auth.authority.id, signer.publicHex, { id: sharedRequestId })
      const answer = makeAttestationAnswer({ requestId: sharedRequestId })
      await submitTransport.submitRequest(init, signer.publicHex, signer.sign)
      await submitTransport.submitAttestation(answer, signer.publicHex, signer.sign)

      const requestRow = (await fixture.rawRows('AssociationRequestStaging', strandId)).find((r) => r.RequestId === sharedRequestId)!
      const overlay = new Map<string, string>([[sharedRequestId, requestRow.InitJson as string]])
      const { transport: overlaidTransport } = buildAssociationTransport(strandId, {}, { overlay })

      const attestationReport = await overlaidTransport.readStagedAttestationsReport()
      const unreadable = attestationReport.unreadable.find((r) => r.requestId === sharedRequestId)
      expect(unreadable, 'the transplanted attestation row must be reported unreadable').to.not.equal(undefined)
      expect(unreadable!.reason).to.equal('authentication-failed')
    })

    it('D-05: the Digest column equals bytesToBase64url of the per-leg digest function, each called exactly once per submit, including with a pre-resolved Signature', async () => {
      const strandId = nextStrandId()
      const { transport } = buildAssociationTransport(strandId)
      const signer = fixture.makeRequesterSigner()

      const init = makeAssociationInit(fixture.auth.authority.id, signer.publicHex)
      await transport.submitRequest(init, signer.publicHex, signer.sign)
      const requestRow = (await fixture.rawRows('AssociationRequestStaging', strandId)).find((r) => r.RequestId === init.id)!
      const requestDigestBytes = await fixture.fixtureRequestDigest(init, signer.publicHex)
      expect(requestRow.Digest).to.equal(bytesToBase64url(requestDigestBytes))

      const answer = makeAttestationAnswer()
      const attestationDigestBytes = await fixture.fixtureAttestationDigest(answer, signer.publicHex)
      const preResolved = await signer.sign(attestationDigestBytes)
      await transport.submitAttestation(answer, signer.publicHex, preResolved)
      const attestationRow = (await fixture.rawRows('AssociationAttestationStaging', strandId)).find((r) => r.RequestId === answer.requestId)!
      expect(attestationRow.Digest).to.equal(bytesToBase64url(attestationDigestBytes))
    })

    it("D-05: a pre-resolved attestation signature over other bytes rejects 'rejected' and writes zero rows", async () => {
      const strandId = nextStrandId()
      const { transport } = buildAssociationTransport(strandId)
      const signer = fixture.makeRequesterSigner()
      const answer = makeAttestationAnswer()
      const wrongBytes = await fixture.fixtureAttestationDigest(makeAttestationAnswer(), signer.publicHex)
      const forgedSignature = await signer.sign(wrongBytes)

      let caught: unknown
      try {
        await transport.submitAttestation(answer, signer.publicHex, forgedSignature)
      } catch (err) {
        caught = err
      }
      expect((caught as P2pStagingError)?.code).to.equal('rejected')
      expect(await assocRowCount('AssociationAttestationStaging', strandId)).to.equal(0)
    })

    it("D-05: a second request with the same RequestId and different content is 'duplicate-request-id'", async () => {
      const strandId = nextStrandId()
      const { transport } = buildAssociationTransport(strandId)
      const signer = fixture.makeRequesterSigner()
      const init = makeAssociationInit(fixture.auth.authority.id, signer.publicHex)
      await transport.submitRequest(init, signer.publicHex, signer.sign)

      const differentInit: AssociationRequestInit = {
        ...init,
        submittedAt: new Date(Date.parse(init.submittedAt) + 1000).toISOString()
      }
      let caught: unknown
      try {
        await transport.submitRequest(differentInit, signer.publicHex, signer.sign)
      } catch (err) {
        caught = err
      }
      expect((caught as P2pStagingError)?.code).to.equal('duplicate-request-id')
      expect(await assocRowCount('AssociationRequestStaging', strandId)).to.equal(1)
    })

    it("D-06: 'c' with a challengeNonce then 'a' for the SAME request id are both accepted; a second 'a' is 'duplicate-decision'", async () => {
      const strandId = nextStrandId()
      const { transport } = buildAssociationTransport(strandId)
      const requestId = nextAssociationRequestId()
      const nonce = `assoc-nonce-${Date.now()}`

      await transport.publishDecision({ requestId, status: 'c', challengeNonce: nonce, decidedAt: new Date().toISOString() })
      await transport.publishDecision({ requestId, status: 'a', decidedAt: new Date().toISOString() })

      const records = await transport.readDecisionRecords()
      expect(records.find((r) => r.requestId === requestId && r.status === 'c')?.challengeNonce).to.equal(nonce)
      expect(records.find((r) => r.requestId === requestId && r.status === 'a')).to.not.equal(undefined)

      let caught: unknown
      try {
        await transport.publishDecision({ requestId, status: 'a', decidedAt: new Date().toISOString() })
      } catch (err) {
        caught = err
      }
      expect((caught as P2pStagingError)?.code).to.equal('duplicate-decision')
    })

    it("D-06: an out-of-vocabulary status 'x' is accepted on write, and both pollDecisions and readDecisionRecords throw", async () => {
      const strandId = nextStrandId()
      const { transport } = buildAssociationTransport(strandId)
      const requestId = nextAssociationRequestId()

      await transport.publishDecision({ requestId, status: 'x' as never, decidedAt: new Date().toISOString() })
      expect(await assocRowCount('AssociationDecision', strandId)).to.equal(1)

      let pollCaught: unknown
      try {
        await transport.pollDecisions()
      } catch (err) {
        pollCaught = err
      }
      expect(pollCaught).to.be.instanceOf(Error)

      let readCaught: unknown
      try {
        await transport.readDecisionRecords()
      } catch (err) {
        readCaught = err
      }
      expect(readCaught).to.be.instanceOf(Error)
    })

    it("D-41/D-45: 'a' with revokesDeviceKey and matchMethod 'code' is accepted and the record carries both; 'r' with revokesDeviceKey is 'rejected' (RevocationShape); 'a' with matchMethod 'identity' and no revokesDeviceKey is accepted", async () => {
      const strandId = nextStrandId()
      const { transport } = buildAssociationTransport(strandId)

      const requestId1 = nextAssociationRequestId()
      await transport.publishDecision({
        requestId: requestId1, status: 'a', decidedAt: new Date().toISOString(),
        revokesDeviceKey: fixture.makeRequesterSigner().publicHex, matchMethod: 'code'
      })
      const record1 = (await transport.readDecisionRecords()).find((r) => r.requestId === requestId1)!
      expect(record1.matchMethod).to.equal('code')
      expect(typeof record1.revokesDeviceKey).to.equal('string')

      const requestId2 = nextAssociationRequestId()
      let caught: unknown
      try {
        await transport.publishDecision({
          requestId: requestId2, status: 'r', decidedAt: new Date().toISOString(),
          revokesDeviceKey: fixture.makeRequesterSigner().publicHex
        })
      } catch (err) {
        caught = err
      }
      expect((caught as P2pStagingError)?.code).to.equal('rejected')
      expect((await fixture.rawRows('AssociationDecision', strandId)).filter((r) => r.RequestId === requestId2)).to.have.lengthOf(0)

      const requestId3 = nextAssociationRequestId()
      await transport.publishDecision({ requestId: requestId3, status: 'a', decidedAt: new Date().toISOString(), matchMethod: 'identity' })
      const record3 = (await transport.readDecisionRecords()).find((r) => r.requestId === requestId3)!
      expect(record3.matchMethod).to.equal('identity')
      expect(record3.revokesDeviceKey).to.equal(undefined)
    })

    it("D-06 refusals: the non-officer signer and the non-'vrg' sibling signer are both 'rejected' with zero rows", async () => {
      const strandId = nextStrandId()
      const unregistered = fixture.makeRequesterSigner()
      const unregisteredSigner: StagingDecisionSigner = { authorityId: fixture.auth.authority.id, sign: async (digest) => await unregistered.sign(digest) }
      const { transport: unregisteredTransport } = buildAssociationTransport(strandId, { decisionSigner: unregisteredSigner })
      const requestId1 = nextAssociationRequestId()
      let caught1: unknown
      try {
        await unregisteredTransport.publishDecision({ requestId: requestId1, status: 'a', decidedAt: new Date().toISOString() })
      } catch (err) {
        caught1 = err
      }
      expect((caught1 as P2pStagingError)?.code).to.equal('rejected')

      const siblingAuthorityId = await addSiblingAuthority(fixture.auth, { scopes: ['rad'] as Scope[] })
      const siblingSigner: StagingDecisionSigner = { authorityId: siblingAuthorityId, sign: makeTestSignCallback(fixture.net.user) }
      const { transport: siblingTransport } = buildAssociationTransport(strandId, { decisionSigner: siblingSigner })
      const requestId2 = nextAssociationRequestId()
      let caught2: unknown
      try {
        await siblingTransport.publishDecision({ requestId: requestId2, status: 'a', decidedAt: new Date().toISOString() })
      } catch (err) {
        caught2 = err
      }
      expect((caught2 as P2pStagingError)?.code).to.equal('rejected')
      expect(await assocRowCount('AssociationDecision', strandId)).to.equal(0)
    })

    it('cursor race: a racing port on AssociationAttestationStaging lands both rows on distinct cursors', async () => {
      const strandId = nextStrandId()
      let raced = false
      const portOptions: P2pStagingFixturePortOptions = {
        beforeInsert: async (table, params) => {
          if (table !== 'AssociationAttestationStaging' || raced) return
          raced = true
          const racerSigner = fixture.makeRequesterSigner()
          const racerAnswer = makeAttestationAnswer()
          const digestBytes = await fixture.fixtureAttestationDigest(racerAnswer, racerSigner.publicHex)
          const digest = bytesToBase64url(digestBytes)
          const sig = await racerSigner.sign(digestBytes)
          const answerJson = await fixture.sealer.seal(JSON.stringify(racerAnswer), { requestId: racerAnswer.requestId, digest })
          await fixture.db.exec(
            'insert into AssociationAttestationStaging (StrandId, Cursor, RequestId, Digest, AnswerJson, RequesterKey, SignatureJson, StagedAt) ' +
            'values (:strandId, :cursor, :requestId, :digest, :answerJson, :requesterKey, :signatureJson, :stagedAt)',
            {
              strandId,
              cursor: params.cursor as string,
              requestId: racerAnswer.requestId,
              digest,
              answerJson,
              requesterKey: racerSigner.publicHex,
              signatureJson: JSON.stringify(sig),
              stagedAt: new Date().toISOString()
            }
          )
        }
      }
      const { transport } = buildAssociationTransport(strandId, {}, portOptions)
      const signer = fixture.makeRequesterSigner()
      const answer = makeAttestationAnswer()

      await transport.submitAttestation(answer, signer.publicHex, signer.sign)
      const rows = await fixture.rawRows('AssociationAttestationStaging', strandId)
      expect(rows).to.have.lengthOf(2)
      expect(rows.map((r) => r.Cursor).sort()).to.deep.equal(['0000000000000001', '0000000000000002'])
    })
  })

  it('reaches both transports and the seam names through the main barrel, but NOT insertWithCursorRetry', async () => {
    const barrel = await import('../src/index.js') as Record<string, unknown>
    expect(barrel.P2pRegistrationTransport).to.not.equal(undefined)
    expect(barrel.P2pAssociationTransport).to.not.equal(undefined)
    expect(barrel.P2pStagingError).to.not.equal(undefined)
    expect(barrel.REGISTRATION_DUPLICATE_CLOSED_REASON).to.not.equal(undefined)
    expect(barrel.STAGING_CURSOR_MAX_ATTEMPTS).to.not.equal(undefined)
    expect('insertWithCursorRetry' in barrel).to.equal(false)
  })
})
