/**
 * staging-cursor-ordering-db.spec.ts — 62-45 (WR-01, CR-01, V-4, D-05, D-06, D-19, D-24).
 *
 * Real-strand legs for every ORDERING-DEPENDENT mock case. A mock case is ordering-dependent when
 * its cursor set holds any value that is not 16 ASCII digits (only then can a port's ordering or
 * range filter disagree with Quereus BINARY). A case is EXEMPT only when its outcome depends on a
 * port behaviour a real strand cannot exhibit. Legacy (pre-V-4) rows are planted on the
 * legacy-cursor-schema fixture, where the CursorWellFormed CHECK is replaced by a width-only CHECK.
 *
 * COVERAGE MAP (mock case -> real-strand case)
 *   H1 -> D7
 *   H2 -> D7
 *   H3 -> D8
 *   H4 -> R1
 *   H6 -> R1
 *   H7 EXEMPT: NonAdvancingPort returns a page whose last cursor does not advance, which a real strand never does
 *   H8 -> D9a, D9b, R2
 *   H9 -> D9c
 *   H10 EXEMPT: EndlessPort fabricates ever-advancing pages beyond the strand's row count, which a real strand cannot
 *   H0b EXEMPT: instrument self-test of the mock port's ordering (tests the mock itself)
 *   W0b EXEMPT: instrument self-test of MockPort's ordering (tests the mock itself)
 *   V0 EXEMPT: instrument self-test of DecisionPort's ordering (tests the mock itself)
 *   W1 -> R1
 *   W2 -> R3
 *   W6 -> D6, R4
 *   W6b -> R4
 *   W13 -> D6, R4
 *   W14 -> D9b, R2
 *   W15 -> V7-db
 *   V7 -> V7-db
 *   W6 (decision readers) -> V7-db
 *   W6b (decision readers) -> V7-db
 *   W13 (the above-ceiling high-water facet) EXEMPT: rowCountOverride makes count(*) disagree with the rows held, which a real strand cannot do
 *   W4 / W12 EXEMPT: rowCountOverride / synthetic max(Cursor) branch, which a real strand cannot exhibit
 *   W10 / W11 EXEMPT: RacingPort lands competitor rows on every mutate, which a single-writer real strand cannot exhibit
 *   Cases whose cursors are all 16 ASCII digits (W3, W5, W8, W9, V1-V6) are not ordering-dependent.
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { RegistrationRequestInit } from '@votetorrent/vote-core'
import { P2pRegistrationTransport } from '../src/registration/transport/p2p-registration-transport.js'
import type { RegistrationStrandPort } from '../src/registration/transport/p2p-registration-transport.js'
import type { StagingSqlPort } from '../src/registration/transport/p2p-staging-seam.js'
import { digestToBytes } from '../src/utils.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { createLegacyCursorStagingFixture } from './fixtures/legacy-cursor-schema.js'
import type { P2pStagingFixture } from './fixtures/p2p-staging-fixture.js'

const pad = (n: number): string => String(n).padStart(16, '0')
const PREFIX = '00000000000000'

/** 63 ASCII fillers, a U+FFFD pivot, then 64 astral cursors (all 16 UTF-16 units). */
function collationShape (): string[] {
  const fillers = Array.from({ length: 63 }, (_, i) => `${PREFIX}x${String.fromCharCode(0x41 + i)}`)
  const pivot = `${PREFIX}${String.fromCharCode(0xFFFD)}a`
  const tail = Array.from({ length: 64 }, (_, i) => `${PREFIX}${String.fromCodePoint(0x1F600 + i)}`)
  return [...fillers, pivot, ...tail]
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

describe('staging cursor ordering on a real strand with legacy rows (62-45, WR-01)', function () {
  this.timeout(600_000)

  let fixture: P2pStagingFixture
  before(async function () {
    this.timeout(600_000)
    fixture = await createLegacyCursorStagingFixture()
  })

  const freshStrand = (): string => `ordering-db-${crypto.randomUUID()}`

  /** A correctly signed raw RegistrationRequestStaging insert at an arbitrary cursor. */
  async function forgeRow (strandId: string, cursor: string): Promise<string> {
    const { privateHex, publicHex } = randomTestKeyPair()
    const digestRow = await fixture.db.prepare('select Digest(:s, :n) as d').get({ s: 'forged', n: crypto.randomUUID() })
    const digest = digestRow?.d as string
    const signature = bytesToHex(secp256k1.sign(digestToBytes(digest), hexToBytes(privateHex)))
    const requestId = `forged-${crypto.randomUUID()}`
    await fixture.db.exec(
      `insert into RegistrationRequestStaging (StrandId, Cursor, RequestId, Digest, InitJson, RequesterKey, SignatureJson, StagedAt)
       values (:strandId, :cursor, :requestId, :digest, :payload, :requesterKey, :signatureJson, :stagedAt)`,
      {
        strandId, cursor, requestId, digest, payload: '{}', requesterKey: publicHex,
        signatureJson: JSON.stringify({ signature, signerKey: publicHex }), stagedAt: toIsoZDatetime(Date.now())
      }
    )
    return requestId
  }

  function transportOn (strandId: string, port: StagingSqlPort = fixture.makePort()): P2pRegistrationTransport {
    return new P2pRegistrationTransport({
      openStrand: async () => port as unknown as RegistrationStrandPort,
      computeDigest: async (init, key) => await fixture.fixtureRequestDigest(init, key),
      strandId,
      sealer: fixture.sealer,
      opener: fixture.opener
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
        private: { expiration: Date.now() + 365 * 86_400_000, details: [{ name: 'note', value: 'ordering' }] }
      },
      submittedAt: new Date().toISOString()
    }
    await transport.submitRequest(init, signer.publicHex, signer.sign)
    return id
  }

  async function cursorOf (strandId: string, requestId: string): Promise<string | undefined> {
    const rows = await fixture.rawRows('RegistrationRequestStaging', strandId)
    return rows.find((r) => r.RequestId === requestId)?.Cursor as string | undefined
  }

  it('R1: 70 legacy in-range non-conforming cursors do not displace the third honest slot', async () => {
    const strandId = freshStrand()
    const transport = transportOn(strandId)
    const first = await honestRegistration(transport)
    const second = await honestRegistration(transport)
    expect(await cursorOf(strandId, first)).to.equal(pad(1))
    expect(await cursorOf(strandId, second)).to.equal(pad(2))
    for (let i = 0; i < 70; i++) await forgeRow(strandId, `000000000000${String(i).padStart(3, '0')}x`)
    const third = await honestRegistration(transport)
    expect(await cursorOf(strandId, third)).to.equal('0000000000000003')
  })

  it('R2: the CR-01 128-row non-BMP shape on staging does not wedge submitRequest', async () => {
    const strandId = freshStrand()
    for (const c of collationShape()) {
      expect(c.length).to.equal(16)
      await forgeRow(strandId, c)
    }
    const wrapped = budgeted(fixture.makePort(), 2000)
    const id = await honestRegistration(transportOn(strandId, wrapped))
    expect(await cursorOf(strandId, id)).to.equal('0000000000000001')
  })

  it('R3: a legacy 16-nines row does not push allocation past 16 characters', async () => {
    const strandId = freshStrand()
    await forgeRow(strandId, '9999999999999999')
    const id = await honestRegistration(transportOn(strandId))
    const cursor = await cursorOf(strandId, id)
    expect(cursor).to.equal('0000000000000001')
    expect(cursor?.length).to.equal(16)
  })

  it('R4: the staging report delivers only the honest row and never adopts a non-conforming high-water mark', async () => {
    const strandId = freshStrand()
    for (const c of collationShape()) await forgeRow(strandId, c)
    const transport = transportOn(strandId)
    const id = await honestRegistration(transport)
    const honestCursor = await cursorOf(strandId, id)
    expect(honestCursor).to.equal('0000000000000001')
    const report = await transport.readStagedRequestsReport()
    expect(report.delivered.map((d) => d.requestId)).to.deep.equal([id])
    expect(report.unreadable, 'planted non-conforming rows are dropped, not reported unreadable').to.deep.equal([])
    expect(report.highWaterCursor).to.equal(honestCursor)
  })
})
