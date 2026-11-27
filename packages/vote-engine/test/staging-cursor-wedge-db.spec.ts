/**
 * staging-cursor-wedge-db.spec.ts — 62-38 (CR-01, V-4, D-19, D-24, D-05, IN-03).
 *
 * 62-33's mock spec could not see CR-01 because its MockPort did not model the schema's
 * (StrandId, Cursor) unique index. These cases run the allocator and the staging report readers
 * on the REAL strand schema: correctly signed forged rows sit at the cursors that used to wedge
 * `insertWithCursorRetry` (it re-derived the same occupied slot on every attempt).
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { AssociationAttestationAnswer, AssociationRequestInit, RegistrationRequestInit } from '@votetorrent/vote-core'
import { P2pRegistrationTransport } from '../src/registration/transport/p2p-registration-transport.js'
import type { RegistrationStrandPort } from '../src/registration/transport/p2p-registration-transport.js'
import { P2pAssociationTransport } from '../src/association/transport/p2p-association-transport.js'
import type { AssociationStrandPort } from '../src/association/transport/p2p-association-transport.js'
import { STAGING_CURSOR_MAX_STEP } from '../src/registration/transport/p2p-staging-seam.js'
import type { StagingSqlPort } from '../src/registration/transport/p2p-staging-seam.js'
import { digestToBytes, nowCanonicalDatetime } from '../src/utils.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { createP2pStagingFixture } from './fixtures/p2p-staging-fixture.js'
import { createLegacyCursorStagingFixture } from './fixtures/legacy-cursor-schema.js'
import type { P2pStagingFixture } from './fixtures/p2p-staging-fixture.js'

type StagingTable = 'RegistrationRequestStaging' | 'AssociationRequestStaging' | 'AssociationAttestationStaging'

const pad = (n: number): string => String(n).padStart(16, '0')

/** A correctly signed raw insert at an arbitrary cursor (what any strand peer can do). */
async function forgeRow (fixture: P2pStagingFixture, table: StagingTable, strandId: string, cursor: string): Promise<void> {
  const col = table === 'AssociationAttestationStaging' ? 'AnswerJson' : 'InitJson'
  const { privateHex, publicHex } = randomTestKeyPair()
  const digestRow = await fixture.db.prepare('select Digest(:s, :n) as d').get({ s: 'forged', n: crypto.randomUUID() })
  const digest = digestRow?.d as string
  const signature = bytesToHex(secp256k1.sign(digestToBytes(digest), hexToBytes(privateHex)))
  await fixture.db.exec(
    `insert into ${table} (StrandId, Cursor, RequestId, Digest, ${col}, RequesterKey, SignatureJson, StagedAt)
     values (:strandId, :cursor, :requestId, :digest, :payload, :requesterKey, :signatureJson, :stagedAt)`,
    {
      strandId,
      cursor,
      requestId: `forged-${crypto.randomUUID()}`,
      digest,
      payload: '{}',
      requesterKey: publicHex,
      signatureJson: JSON.stringify({ signature, signerKey: publicHex }),
      stagedAt: toIsoZDatetime(Date.now())
    }
  )
}

/** The two-row shape: rows at (count + step) and (count + step + 1), count measured after both. */
async function forgeWedgePair (fixture: P2pStagingFixture, table: StagingTable, strandId: string): Promise<[string, string]> {
  const first = pad(2 + STAGING_CURSOR_MAX_STEP)
  const second = pad(2 + STAGING_CURSOR_MAX_STEP + 1)
  await forgeRow(fixture, table, strandId, first)
  await forgeRow(fixture, table, strandId, second)
  return [first, second]
}

/** Wraps a port with a query budget so a regressed (looping) walk ends in a 'HANG' error. */
function budgeted (port: StagingSqlPort, budget: number): StagingSqlPort & { readonly queries: number } {
  let queries = 0
  return {
    get queries () { return queries },
    async query<T> (sql: string, params: Record<string, unknown>): Promise<T[]> {
      queries += 1
      if (queries > budget) throw new Error(`HANG: query budget ${budget} exceeded`)
      return await port.query<T>(sql, params)
    },
    mutate: async (sql, params) => await port.mutate(sql, params),
    close: async () => await port.close(),
    describe: () => port.describe()
  }
}

/** An officer-signed raw decision row at an arbitrary cursor (what any `vrg` officer can write). */
async function forgeDecision (
  fixture: P2pStagingFixture,
  table: 'RegistrationDecision' | 'AssociationDecision',
  strandId: string,
  cursor: string
): Promise<void> {
  const requestId = `forged-${crypto.randomUUID()}`
  const authorityId = fixture.auth.authority.id
  const decidedAt = toIsoZDatetime(Date.now())
  const registration = table === 'RegistrationDecision'
  const digestRow = registration
    ? await fixture.db.prepare("select Digest('RegistrationDecision', :strandId, :requestId, :authorityId, :status, :reason, :closesRequestId, :decidedAt) as d")
      .get({ strandId, requestId, authorityId, status: 'a', reason: null, closesRequestId: null, decidedAt })
    : await fixture.db.prepare("select Digest('AssociationDecision', :strandId, :requestId, :authorityId, :status, :challengeNonce, :reason, :revokesDeviceKey, :matchMethod, :decidedAt) as d")
      .get({ strandId, requestId, authorityId, status: 'a', challengeNonce: null, reason: null, revokesDeviceKey: null, matchMethod: 'code', decidedAt })
  const digest = digestRow?.d as string
  const sig = await fixture.decisionSigner.sign(digestToBytes(digest))
  if (registration) {
    await fixture.db.exec(
      `insert into RegistrationDecision (StrandId, Cursor, RequestId, AuthorityId, Status, Reason, ClosesRequestId, DecidedAt, DeciderKey, DeciderSignature)
       with context now = :now
       values (:strandId, :cursor, :requestId, :authorityId, :status, :reason, :closesRequestId, :decidedAt, :deciderKey, :deciderSignature)`,
      { strandId, cursor, requestId, authorityId, status: 'a', reason: null, closesRequestId: null, decidedAt, deciderKey: sig.signerKey, deciderSignature: sig.signature, now: nowCanonicalDatetime() }
    )
  } else {
    await fixture.db.exec(
      `insert into AssociationDecision (StrandId, Cursor, RequestId, AuthorityId, Status, ChallengeNonce, Reason, RevokesDeviceKey, MatchMethod, DecidedAt, DeciderKey, DeciderSignature)
       with context now = :now
       values (:strandId, :cursor, :requestId, :authorityId, :status, :challengeNonce, :reason, :revokesDeviceKey, :matchMethod, :decidedAt, :deciderKey, :deciderSignature)`,
      { strandId, cursor, requestId, authorityId, status: 'a', challengeNonce: null, reason: null, revokesDeviceKey: null, matchMethod: 'code', decidedAt, deciderKey: sig.signerKey, deciderSignature: sig.signature, now: nowCanonicalDatetime() }
    )
  }
}

describe('staging cursor wedge on a real strand (62-38, CR-01)', function () {
  this.timeout(240_000)

  let fixture: P2pStagingFixture
  before(async () => {
    fixture = await createP2pStagingFixture()
  })

  const freshStrand = (): string => `wedge-db-${crypto.randomUUID()}`

  function regTransport (strandId: string): P2pRegistrationTransport {
    return new P2pRegistrationTransport({
      openStrand: async () => fixture.makePort() as unknown as RegistrationStrandPort,
      computeDigest: async (init, key) => await fixture.fixtureRequestDigest(init, key),
      strandId,
      sealer: fixture.sealer,
      opener: fixture.opener
    })
  }

  function assocTransport (strandId: string): P2pAssociationTransport {
    return new P2pAssociationTransport({
      openStrand: async () => fixture.makePort() as unknown as AssociationStrandPort,
      computeDigest: async (init, key) => await fixture.fixtureRequestDigest(init, key),
      computeAttestationDigest: async (answer, key) => await fixture.fixtureAttestationDigest(answer, key),
      strandId,
      sealer: fixture.sealer,
      opener: fixture.opener,
      decisionSigner: fixture.decisionSigner
    })
  }

  async function honestRegistration (transport: P2pRegistrationTransport): Promise<string> {
    const authorityId = fixture.auth.authority.id
    const signer = fixture.makeRequesterSigner()
    const id = `honest-${crypto.randomUUID()}`
    const init: RegistrationRequestInit = {
      id,
      authorityId,
      payload: {
        registrant: { id: `registrant-${id}`, authorityId, expiration: Date.now() + 365 * 86_400_000 },
        private: { expiration: Date.now() + 365 * 86_400_000, details: [{ name: 'note', value: 'wedge' }] }
      },
      submittedAt: new Date().toISOString()
    }
    await transport.submitRequest(init, signer.publicHex, signer.sign)
    return id
  }

  async function cursorOf (table: StagingTable, strandId: string, requestId: string): Promise<string | undefined> {
    const rows = await fixture.rawRows(table, strandId)
    return rows.find((r) => r.RequestId === requestId)?.Cursor as string | undefined
  }

  it('D1: two forged rows at (ceiling, ceiling + 1) do not wedge RegistrationRequestStaging', async () => {
    const strandId = freshStrand()
    await forgeWedgePair(fixture, 'RegistrationRequestStaging', strandId)
    const id = await honestRegistration(regTransport(strandId))
    expect(await cursorOf('RegistrationRequestStaging', strandId, id)).to.equal('0000000000001004')
  })

  it('D2: 70 forged consecutive rows starting at the ceiling (more than one 64-row page) do not wedge allocation', async () => {
    const strandId = freshStrand()
    const k = 70
    for (let i = 0; i < k; i++) await forgeRow(fixture, 'RegistrationRequestStaging', strandId, pad(k + STAGING_CURSOR_MAX_STEP + i))
    const id = await honestRegistration(regTransport(strandId))
    expect(await cursorOf('RegistrationRequestStaging', strandId, id)).to.equal('0000000000001140')
  })

  it('D3: the two-row shape does not wedge AssociationRequestStaging and the honest row is delivered', async () => {
    const strandId = freshStrand()
    await forgeWedgePair(fixture, 'AssociationRequestStaging', strandId)
    const transport = assocTransport(strandId)
    const signer = fixture.makeRequesterSigner()
    const id = `honest-assoc-${crypto.randomUUID()}`
    const init: AssociationRequestInit = {
      id,
      authorityId: fixture.auth.authority.id,
      registrantId: `registrant-${id}`,
      deviceKey: signer.publicHex,
      submittedAt: new Date().toISOString()
    }
    await transport.submitRequest(init, signer.publicHex, signer.sign)
    expect(await cursorOf('AssociationRequestStaging', strandId, id)).to.equal('0000000000001004')
    const report = await transport.readStagedRequestsReport()
    expect(report.delivered.map((d) => d.requestId)).to.include(id)
  })

  it('D4: the two-row shape does not wedge AssociationAttestationStaging and the honest answer is delivered', async () => {
    const strandId = freshStrand()
    await forgeWedgePair(fixture, 'AssociationAttestationStaging', strandId)
    const transport = assocTransport(strandId)
    const signer = fixture.makeRequesterSigner()
    const requestId = `honest-att-${crypto.randomUUID()}`
    const answer: AssociationAttestationAnswer = {
      requestId,
      nonce: `nonce-${crypto.randomUUID()}`,
      attestation: {
        publicKey: 'wedge-device-pubkey',
        deviceId: `wedge-device-${crypto.randomUUID()}`,
        attestationTime: Date.now(),
        certificateChain: ['wedge-leaf-cert']
      }
    }
    await transport.submitAttestation(answer, signer.publicHex, signer.sign)
    expect(await cursorOf('AssociationAttestationStaging', strandId, requestId)).to.equal('0000000000001004')
    const report = await transport.readStagedAttestationsReport()
    expect(report.delivered.map((d) => d.requestId)).to.include(requestId)
  })

  it('D5: CONTROL, a single forged row at the ceiling does not wedge (green before and after the fix)', async () => {
    const strandId = freshStrand()
    await forgeRow(fixture, 'RegistrationRequestStaging', strandId, pad(1 + STAGING_CURSOR_MAX_STEP))
    const id = await honestRegistration(regTransport(strandId))
    expect(await cursorOf('RegistrationRequestStaging', strandId, id)).to.equal('0000000000001002')
  })

  it('D6: the staging report delivers an honest row above the ceiling and keeps the high-water mark at or below it (IN-03)', async () => {
    const strandId = freshStrand()
    const [first, second] = await forgeWedgePair(fixture, 'RegistrationRequestStaging', strandId)
    const transport = regTransport(strandId)
    const id = await honestRegistration(transport)
    const report = await transport.readStagedRequestsReport()
    expect(report.delivered.map((d) => d.requestId)).to.deep.equal([id])
    expect(report.unreadable.map((u) => u.cursor)).to.deep.equal([first, second])
    expect(report.highWaterCursor).to.equal('0000000000001003')
  })

  describe('legacy decision rows on a legacy-cursor-schema strand (62-44, CR-01)', function () {
    this.timeout(600_000)
    let legacy: P2pStagingFixture
    before(async () => { legacy = await createLegacyCursorStagingFixture() })

    it('D7: 64 officer-signed above-cap RegistrationDecision rows do not stall publishDecision (62-41, CR-01)', async () => {
      const strandId = freshStrand()
      for (let i = 0; i < 64; i++) {
        await forgeDecision(legacy, 'RegistrationDecision', strandId, (BigInt('9999999999999999') - BigInt(i)).toString())
      }
      const wrapped = budgeted(legacy.makePort(), 2000)
      const transport = new P2pRegistrationTransport({
        openStrand: async () => wrapped as unknown as RegistrationStrandPort,
        computeDigest: async (init, key) => await legacy.fixtureRequestDigest(init, key),
        strandId,
        sealer: legacy.sealer,
        opener: legacy.opener,
        decisionSigner: legacy.decisionSigner
      })
      const cursor = await transport.publishDecision({ requestId: `honest-${crypto.randomUUID()}`, status: 'a', decidedAt: new Date().toISOString() })
      expect(cursor).to.equal('0000000000000001')
      expect(wrapped.queries).to.be.at.most(20)
    })

    it('D8: 64 officer-signed non-digit AssociationDecision rows do not stall publishDecision (62-41, CR-01)', async () => {
      const strandId = freshStrand()
      for (let i = 0; i < 64; i++) {
        await forgeDecision(legacy, 'AssociationDecision', strandId, `zzzzzzzzzzzz${String(i).padStart(4, '0')}`)
      }
      const wrapped = budgeted(legacy.makePort(), 2000)
      const transport = new P2pAssociationTransport({
        openStrand: async () => wrapped as unknown as AssociationStrandPort,
        computeDigest: async (init, key) => await legacy.fixtureRequestDigest(init, key),
        computeAttestationDigest: async (answer, key) => await legacy.fixtureAttestationDigest(answer, key),
        strandId,
        sealer: legacy.sealer,
        opener: legacy.opener,
        decisionSigner: legacy.decisionSigner
      })
      const cursor = await transport.publishDecision({ requestId: `honest-${crypto.randomUUID()}`, status: 'a', matchMethod: 'code', decidedAt: new Date().toISOString() })
      expect(cursor).to.equal('0000000000000001')
      expect(wrapped.queries).to.be.at.most(20)
    })

    const PREFIX = '00000000000000'
    function collationShape (page2: 'defect' | 'control'): string[] {
      const fillers = Array.from({ length: 63 }, (_, i) => `${PREFIX}x${String.fromCharCode(0x41 + i)}`)
      const pivot = `${PREFIX}${String.fromCharCode(0xFFFD)}a`
      const tail = Array.from({ length: 64 }, (_, i) => page2 === 'defect'
        ? `${PREFIX}${String.fromCodePoint(0x1F600 + i)}`
        : `${PREFIX}${String.fromCharCode(0xFFFE)}${String.fromCharCode(0x41 + i)}`)
      return [...fillers, pivot, ...tail]
    }

    async function plant (table: 'RegistrationDecision' | 'AssociationDecision', page2: 'defect' | 'control'): Promise<string> {
      const strandId = freshStrand()
      for (const c of collationShape(page2)) {
        expect(c.length, `CursorWidth for ${JSON.stringify(c)}`).to.equal(16)
        await forgeDecision(legacy, table, strandId, c)
      }
      return strandId
    }

    async function publishRegistration (strandId: string): Promise<string> {
      const wrapped = budgeted(legacy.makePort(), 2000)
      const transport = new P2pRegistrationTransport({
        openStrand: async () => wrapped as unknown as RegistrationStrandPort,
        computeDigest: async (init, key) => await legacy.fixtureRequestDigest(init, key),
        strandId,
        sealer: legacy.sealer,
        opener: legacy.opener,
        decisionSigner: legacy.decisionSigner
      })
      try {
        return await transport.publishDecision({ requestId: `honest-${crypto.randomUUID()}`, status: 'a', decidedAt: new Date().toISOString() })
      } catch (e) {
        throw new Error(`publishDecision threw code=${(e as { code?: string }).code} message=${(e as Error).message}`)
      }
    }

    it('D9a: 128 collation-shaped RegistrationDecision rows do not wedge publishDecision (62-44, CR-01)', async function () {
      this.timeout(600_000)
      expect(await publishRegistration(await plant('RegistrationDecision', 'defect'))).to.equal('0000000000000001')
    })

    it('D9b: 128 collation-shaped AssociationDecision rows do not wedge publishDecision (62-44, CR-01)', async function () {
      this.timeout(600_000)
      const strandId = await plant('AssociationDecision', 'defect')
      const wrapped = budgeted(legacy.makePort(), 2000)
      const transport = new P2pAssociationTransport({
        openStrand: async () => wrapped as unknown as AssociationStrandPort,
        computeDigest: async (init, key) => await legacy.fixtureRequestDigest(init, key),
        computeAttestationDigest: async (answer, key) => await legacy.fixtureAttestationDigest(answer, key),
        strandId,
        sealer: legacy.sealer,
        opener: legacy.opener,
        decisionSigner: legacy.decisionSigner
      })
      let cursor: string
      try {
        cursor = await transport.publishDecision({ requestId: `honest-${crypto.randomUUID()}`, status: 'a', matchMethod: 'code', decidedAt: new Date().toISOString() })
      } catch (e) {
        throw new Error(`publishDecision threw code=${(e as { code?: string }).code} message=${(e as Error).message}`)
      }
      expect(cursor).to.equal('0000000000000001')
    })

    it('D9c: CONTROL, the U+FFFE page 2 allocates 0000000000000001 (green before and after)', async function () {
      this.timeout(600_000)
      expect(await publishRegistration(await plant('RegistrationDecision', 'control'))).to.equal('0000000000000001')
    })
  })
})
