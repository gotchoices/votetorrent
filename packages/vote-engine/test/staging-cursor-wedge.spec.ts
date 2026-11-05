/**
 * staging-cursor-wedge.spec.ts — 62-33 Task 2 (V-4, D-19, D-24).
 *
 * The confirmed V-4 repro as a permanent regression: a forged or legacy malformed staging cursor
 * must not wedge allocation, burn the cursor space, or poison any reader's high-water mark, on
 * the shared seam and on both P2P transports. Mock-port cases model rows that predate the
 * CursorWellFormed CHECK; the real-strand case (W7) uses a conforming forged cap-valued row.
 */

import { expect } from 'chai'
import { compareCodePoints } from '@quereus/quereus'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import {
  insertWithCursorRetry,
  isConformingStagingCursor,
  STAGING_CURSOR_REREAD,
  stagingCursorCeiling,
  P2pStagingError,
  STAGING_CURSOR_MAX_ATTEMPTS,
  STAGING_CURSOR_MAX_TEXT,
  STAGING_CURSOR_MAX_STEP
} from '../src/registration/transport/p2p-staging-seam.js'
import type { StagingSqlPort, StagingCursorTable } from '../src/registration/transport/p2p-staging-seam.js'
import { P2pRegistrationTransport } from '../src/registration/transport/p2p-registration-transport.js'
import type { RegistrationStrandPort } from '../src/registration/transport/p2p-registration-transport.js'
import { P2pAssociationTransport } from '../src/association/transport/p2p-association-transport.js'
import type { AssociationStrandPort } from '../src/association/transport/p2p-association-transport.js'
import { digestToBytes } from '../src/utils.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { createP2pStagingFixture } from './fixtures/p2p-staging-fixture.js'

const GOOD = '0000000000000001'
const FORGED_TEXT = 'zzzzzzzzzzzzzzzz'
const FORGED_NINES = '9999999999999999'
const CAP = STAGING_CURSOR_MAX_TEXT

/** Quereus BINARY order (code point), never JS string order (WR-01). */
const byCodePoint = (a: string, b: string): number => compareCodePoints(a, b)

/** In-memory port that interprets just the statements the seam and transports issue. */
class MockPort implements StagingSqlPort, RegistrationStrandPort, AssociationStrandPort {
  readonly inserted: string[] = []
  mutateCalls = 0
  constructor (protected readonly cursors: string[], private readonly table: string = 'T', private readonly rowCountOverride?: number | string) {}

  private rowFor (cursor: string): Record<string, unknown> {
    return {
      Cursor: cursor,
      RequestId: `req-${cursor}`,
      Digest: 'd',
      InitJson: 'x',
      AnswerJson: 'x',
      RequesterKey: 'k',
      SignatureJson: 'not-json',
      StagedAt: '2026-01-01T00:00:00.000Z',
      AuthorityId: 'a',
      Status: 'a',
      Reason: null,
      ClosesRequestId: null,
      ChallengeNonce: null,
      RevokesDeviceKey: null,
      MatchMethod: null,
      DecidedAt: '2026-01-01T00:00:00.000Z',
      DeciderKey: 'k',
      DeciderSignature: 's'
    }
  }

  async query<T> (sql: string, params: Record<string, unknown>): Promise<T[]> {
    if (/max\(Cursor\)/.test(sql)) return [{ MaxCursor: [...this.cursors].sort(byCodePoint).pop() ?? null } as unknown as T]
    if (/count\(\*\)/.test(sql)) return [{ RowCount: this.rowCountOverride ?? this.cursors.length } as unknown as T]
    if (/order by Cursor asc limit 64/.test(sql)) {
      const after = typeof params.afterCursor === 'string' ? params.afterCursor : undefined
      const cap = typeof params.capCursor === 'string' ? params.capCursor : undefined
      const from = params.fromCursor as string | undefined
      return this.cursors
        .filter((c) => (after !== undefined
          ? compareCodePoints(c, after) > 0 && (cap === undefined || compareCodePoints(c, cap) <= 0)
          : compareCodePoints(c, from as string) >= 0))
        .sort(byCodePoint)
        .slice(0, 64)
        .map((c) => ({ Cursor: c }) as unknown as T)
    }
    if (/order by Cursor desc limit 64/.test(sql)) {
      const ceiling = params.ceiling as string
      const before = params.beforeCursor as string | undefined
      return this.cursors
        .filter((c) => compareCodePoints(c, ceiling) <= 0 && (before === undefined || compareCodePoints(c, before) < 0))
        .sort(byCodePoint)
        .reverse()
        .slice(0, 64)
        .map((c) => ({ Cursor: c }) as unknown as T)
    }
    if (/Cursor = :cursor/.test(sql)) return this.cursors.filter((c) => c === params.cursor).map((c) => ({ Cursor: c }) as unknown as T)
    if (/:sinceCursor/.test(sql)) {
      const since = params.sinceCursor as string | null
      return this.cursors
        .filter((c) => since === null || compareCodePoints(c, since) > 0)
        .sort(byCodePoint)
        .map((c) => this.rowFor(c) as unknown as T)
    }
    if (/where StrandId = :strandId and RequestId/.test(sql)) return []
    throw new Error(`MockPort: unexpected query ${sql}`)
  }

  /** Models the schema's (StrandId, Cursor) unique index: a duplicate cursor is refused. */
  async mutate (_sql: string, params: Record<string, unknown>): Promise<void> {
    this.mutateCalls += 1
    const cursor = params.cursor as string
    if (this.cursors.includes(cursor)) throw new Error('UNIQUE constraint failed: (StrandId, Cursor)')
    this.inserted.push(cursor)
    this.cursors.push(cursor)
  }

  async close (): Promise<void> {}
  describe (): string { return this.table }
}

async function allocate (cursors: string[], table: StagingCursorTable = 'RegistrationRequestStaging'): Promise<{ cursor: string, port: MockPort }> {
  const port = new MockPort(cursors)
  const out = await insertWithCursorRetry(port, {
    table,
    strandId: 's',
    insertSql: 'insert into x',
    params: {},
    identity: { sql: 'select 1 where StrandId = :strandId and RequestId = :requestId', params: { strandId: 's', requestId: 'r' } },
    onIdentityConflict: () => 'idempotent',
    where: 'test'
  })
  return { cursor: out.cursor, port }
}

/** Every mutate (or just the first, when `firstOnly`) lands a competitor row at the requested cursor, then rejects. */
class RacingPort extends MockPort {
  constructor (cursors: string[], private readonly firstOnly: boolean) { super(cursors) }
  override async mutate (_sql: string, params: Record<string, unknown>): Promise<void> {
    this.mutateCalls += 1
    if (this.firstOnly && this.mutateCalls > 1) {
      this.cursors.push(params.cursor as string)
      this.inserted.push(params.cursor as string)
      return
    }
    this.cursors.push(params.cursor as string)
    throw new Error('UNIQUE constraint failed: (StrandId, Cursor)')
  }
}

async function allocateOn (port: MockPort): Promise<string> {
  const out = await insertWithCursorRetry(port, {
    table: 'RegistrationRequestStaging',
    strandId: 's',
    insertSql: 'insert into x',
    params: {},
    identity: { sql: 'select 1 where StrandId = :strandId and RequestId = :requestId', params: { strandId: 's', requestId: 'r' } },
    onIdentityConflict: () => 'idempotent',
    where: 'test'
  })
  return out.cursor
}

const pad16 = (n: number | bigint): string => String(n).padStart(16, '0')

const NB_PREFIX = '00000000000000'
/** The CR-01 shape: 63 ASCII fillers, a U+FFFD pivot, then 64 astral cursors (all 16 UTF-16 units). */
function collationShape (): string[] {
  const fillers = Array.from({ length: 63 }, (_, i) => `${NB_PREFIX}x${String.fromCharCode(0x41 + i)}`)
  const pivot = `${NB_PREFIX}${String.fromCharCode(0xFFFD)}a`
  const tail = Array.from({ length: 64 }, (_, i) => `${NB_PREFIX}${String.fromCodePoint(0x1F600 + i)}`)
  return [...fillers, pivot, ...tail]
}

const unreadableOpener = { open: async () => ({ ok: false as const, reason: 'not-a-recipient', detail: '' }) }

describe('staging cursor wedge (62-33, V-4)', function () {
  this.timeout(60_000)

  describe('allocator', () => {
    it('W1: a legacy non-digit cursor does not wedge allocation', async () => {
      expect((await allocate([GOOD, FORGED_TEXT])).cursor).to.equal('0000000000000002')
    })

    it('W2: a 16-nines cursor does not push allocation to 17 characters', async () => {
      const { cursor, port } = await allocate([GOOD, FORGED_NINES])
      expect(cursor).to.equal('0000000000000002')
      for (const c of port.inserted) expect(c.length).to.equal(16)
    })

    it('W3: a conforming cap-valued cursor above the in-sequence ceiling is ignored', async () => {
      expect((await allocate([GOOD, '0000000000000002', CAP])).cursor).to.equal('0000000000000003')
    })

    it('W4: at the cap the allocator throws cursor-exhausted and never mutates', async () => {
      // Only reachable in-sequence when the ceiling itself clamps to the cap: build the port so the
      // single conforming in-sequence row IS the cap by faking a huge row count.
      const port = new MockPort([CAP])
      const realQuery = port.query.bind(port)
      port.query = (async (sql: string, params: Record<string, unknown>) =>
        /count\(\*\)/.test(sql) ? [{ RowCount: CAP }] : realQuery(sql, params)) as typeof port.query
      let caught: unknown
      try {
        await insertWithCursorRetry(port, {
          table: 'RegistrationRequestStaging',
          strandId: 's',
          insertSql: 'insert into x',
          params: {},
          identity: { sql: 'select 1 where StrandId = :strandId and RequestId = :requestId', params: { strandId: 's', requestId: 'r' } },
          onIdentityConflict: () => 'idempotent',
          where: 'test'
        })
      } catch (err) {
        caught = err
      }
      expect(caught).to.be.instanceOf(P2pStagingError)
      expect((caught as P2pStagingError).code).to.equal('cursor-exhausted')
      expect(port.inserted).to.deep.equal([])
    })

    it('W0: MockPort models the (StrandId, Cursor) unique index', async () => {
      const port = new MockPort([GOOD])
      let caught: unknown
      try {
        await port.mutate('insert into x', { cursor: GOOD })
      } catch (err) {
        caught = err
      }
      expect((caught as Error).message).to.contain('UNIQUE')
      expect(port['cursors']).to.deep.equal([GOOD])
      await port.mutate('insert into x', { cursor: '0000000000000002' })
      expect(port['cursors']).to.deep.equal([GOOD, '0000000000000002'])
    })

    it('W0b: MockPort orders and range-filters by code point (U+FFFE sorts before an astral character)', async () => {
      const P = '00000000000000'
      const astral = `${P}${String.fromCodePoint(0x1F600)}`
      const fffe = `${P}${String.fromCharCode(0xFFFE)}A`
      const port = new MockPort([astral, fffe])
      const asc = await port.query<{ Cursor: string }>('select Cursor from T order by Cursor asc limit 64', { afterCursor: fffe, capCursor: CAP })
      expect(asc.map((r) => r.Cursor)).to.deep.equal([astral])
      const desc = await port.query<{ Cursor: string }>('select Cursor from T order by Cursor desc limit 64', { ceiling: `${P}${String.fromCodePoint(0x10FFFF)}` })
      expect(desc.map((r) => r.Cursor)).to.deep.equal([astral, fffe])
    })

    it('W14: 63 fillers, a U+FFFD pivot and 64 astral cursors allocate 0000000000000001 on AssociationDecision with one mutate (non-BMP, WR-01)', async () => {
      const { cursor, port } = await allocate(collationShape(), 'AssociationDecision')
      expect(cursor).to.equal(GOOD)
      expect(port.mutateCalls).to.equal(1)
    })

    it('W8: two rows at (ceiling, ceiling + 1) allocate the first free slot above them', async () => {
      expect((await allocate([pad16(1002), pad16(1003)])).cursor).to.equal(pad16(1004))
    })

    it('W9: a 70-row run (more than one page) is walked in a single mutate', async () => {
      const cursors: string[] = []
      for (let i = 1070; i < 1140; i++) cursors.push(pad16(i))
      const { cursor, port } = await allocate(cursors)
      expect(cursor).to.equal(pad16(1140))
      expect(port.mutateCalls).to.equal(1)
    })

    it('W10: a genuine race above the ceiling lands past the competitor after two mutates', async () => {
      const port = new RacingPort([pad16(1002), pad16(1003)], true)
      expect(await allocateOn(port)).to.equal(pad16(1005))
      expect(port.mutateCalls).to.equal(2)
    })

    it('W11: repeated genuine races end in cursor-exhausted after exactly STAGING_CURSOR_MAX_ATTEMPTS mutates', async () => {
      const port = new RacingPort([], false)
      let caught: unknown
      try {
        await allocateOn(port)
      } catch (err) {
        caught = err
      }
      expect((caught as P2pStagingError).code).to.equal('cursor-exhausted')
      expect(port.mutateCalls).to.equal(STAGING_CURSOR_MAX_ATTEMPTS)
    })

    it('W12: a static run that walks past the cap throws cursor-exhausted without mutating', async () => {
      const cap = BigInt(CAP)
      const port = new MockPort([pad16(cap - BigInt(2)), pad16(cap - BigInt(1)), CAP], 'T', (cap - BigInt(2) - BigInt(STAGING_CURSOR_MAX_STEP)).toString())
      let caught: unknown
      try {
        await allocateOn(port)
      } catch (err) {
        caught = err
      }
      expect((caught as P2pStagingError).code).to.equal('cursor-exhausted')
      expect(port.mutateCalls).to.equal(0)
    })

    it('an empty strand allocates 0000000000000001', async () => {
      expect((await allocate([])).cursor).to.equal(GOOD)
    })
  })

  describe('helpers', () => {
    it('W5: isConformingStagingCursor', () => {
      for (const ok of [GOOD, CAP]) expect(isConformingStagingCursor(ok), ok).to.equal(true)
      const bad: unknown[] = [
        FORGED_TEXT, FORGED_NINES, '1e15000000000000', '0x00000000000001', '000000000000000a',
        ' 000000000000001', '0000000000000000', '9007199254740992', '123456789012345', '12345678901234567', 5, null, undefined
      ]
      for (const b of bad) expect(isConformingStagingCursor(b), String(b)).to.equal(false)
    })

    it('W5: stagingCursorCeiling is count + max step, padded, clamped to the cap', async () => {
      const port = new MockPort([GOOD, '0000000000000002', '0000000000000003'])
      expect(await stagingCursorCeiling(port, 'RegistrationRequestStaging', 's')).to.equal(String(3 + STAGING_CURSOR_MAX_STEP).padStart(16, '0'))
      const huge = new MockPort([])
      huge.query = (async () => [{ RowCount: CAP }]) as typeof huge.query
      expect(await stagingCursorCeiling(huge, 'RegistrationRequestStaging', 's')).to.equal(CAP)
    })
  })

  describe('readers', () => {
    const ROWS = [GOOD, FORGED_TEXT, CAP]

    function reg (cursors: string[]): P2pRegistrationTransport {
      const port = new MockPort(cursors)
      return new P2pRegistrationTransport({
        openStrand: async () => port, computeDigest: async () => new Uint8Array(32), strandId: 's', opener: unreadableOpener
      })
    }
    function assoc (cursors: string[]): P2pAssociationTransport {
      const port = new MockPort(cursors)
      return new P2pAssociationTransport({
        openStrand: async () => port, computeDigest: async () => new Uint8Array(32), computeAttestationDigest: async () => new Uint8Array(32), strandId: 's', opener: unreadableOpener
      } as never)
    }

    it('W6: registration readStagedRequestsReport delivers forged cursors but never adopts them as high-water', async () => {
      const report = await reg(ROWS).readStagedRequestsReport()
      expect(report.unreadable.map((u) => u.cursor).concat(report.delivered.map((d) => d.cursor))).to.deep.equal([GOOD, CAP])
      expect(report.highWaterCursor).to.equal(GOOD)
    })

    it('W6: a non-conforming sinceCursor is treated as absent (re-delivery, never loss)', async () => {
      const report = await reg(ROWS).readStagedRequestsReport(FORGED_TEXT)
      expect(report.highWaterCursor).to.equal(GOOD)
    })

    it('W6: registration pollDecisions and readDecisionRecords deliver every conforming decision but forward only an in-sequence cursor', async () => {
      const ids = [`req-${GOOD}`, `req-${CAP}`]
      const polled = await reg(ROWS).pollDecisions()
      expect(polled.map((n) => n.requestId)).to.deep.equal(ids)
      expect(polled.map((n) => n.cursor)).to.deep.equal([GOOD, GOOD])
      const records = await reg(ROWS).readDecisionRecords()
      expect(records.map((n) => n.requestId)).to.deep.equal(ids)
      expect(records.map((n) => n.cursor)).to.deep.equal([GOOD, GOOD])
      const forged = await reg(ROWS).pollDecisions(FORGED_TEXT)
      expect(forged.map((n) => n.requestId)).to.deep.equal(ids)
      expect(forged.map((n) => n.cursor)).to.deep.equal([GOOD, GOOD])
    })

    it('W13: a staging report delivers every conforming row but the high-water mark stays at or below the ceiling', async () => {
      const port = new MockPort([GOOD, pad16(1003)], 'T', 2)
      const transport = new P2pRegistrationTransport({
        openStrand: async () => port, computeDigest: async () => new Uint8Array(32), strandId: 's', opener: unreadableOpener
      })
      const report = await transport.readStagedRequestsReport()
      expect(report.unreadable.map((u) => u.cursor).concat(report.delivered.map((d) => d.cursor))).to.deep.equal([GOOD, pad16(1003)])
      expect(report.highWaterCursor).to.equal(GOOD)
    })

    it('W15: non-BMP legacy decision cursors never surface as a delivered request or a non-conforming resume cursor (WR-01)', async () => {
      const rows = [pad16(1), pad16(2), pad16(3), ...collationShape()]
      const honest = [pad16(1), pad16(2), pad16(3)].map((c) => `req-${c}`)
      const nonConforming = new Set(collationShape().map((c) => `req-${c}`))
      const ok = (cursor: string): boolean => isConformingStagingCursor(cursor) || cursor === STAGING_CURSOR_REREAD
      for (const [label, make] of [['registration', reg], ['association', assoc]] as const) {
        const transport = make(rows)
        const lists = [await transport.pollDecisions(), await transport.readDecisionRecords()]
        for (const list of lists) {
          const ids = list.map((n) => n.requestId)
          for (const h of honest) expect(ids, `${label} delivers ${h}`).to.include(h)
          for (const id of ids) expect(nonConforming.has(id), `${label} delivered ${JSON.stringify(id)}`).to.equal(false)
          for (const n of list) expect(ok(n.cursor), `${label} cursor ${JSON.stringify(n.cursor)}`).to.equal(true)
        }
      }
    })

    it('W6b: association requests deliver forged cursors but never adopt them as high-water', async () => {
      const report = await assoc(ROWS).readStagedRequestsReport()
      expect(report.unreadable.map((u) => u.cursor).concat(report.delivered.map((d) => d.cursor))).to.deep.equal([GOOD, CAP])
      expect(report.highWaterCursor).to.equal(GOOD)
      expect((await assoc(ROWS).readStagedRequestsReport(FORGED_TEXT)).highWaterCursor).to.equal(GOOD)
    })

    it('W6b: association attestations deliver forged cursors but never adopt them as high-water', async () => {
      const report = await assoc(ROWS).readStagedAttestationsReport()
      expect(report.unreadable.map((u) => u.cursor).concat(report.delivered.map((d) => d.cursor))).to.deep.equal([GOOD, CAP])
      expect(report.highWaterCursor).to.equal(GOOD)
      expect((await assoc(ROWS).readStagedAttestationsReport(FORGED_TEXT)).highWaterCursor).to.equal(GOOD)
    })

    it('W6b: association pollDecisions and readDecisionRecords deliver every conforming decision but forward only an in-sequence cursor', async () => {
      const ids = [`req-${GOOD}`, `req-${CAP}`]
      for (const since of [undefined, FORGED_TEXT]) {
        const polled = await assoc(ROWS).pollDecisions(since)
        expect(polled.map((n) => n.requestId)).to.deep.equal(ids)
        expect(polled.map((n) => n.cursor)).to.deep.equal([GOOD, GOOD])
        const records = await assoc(ROWS).readDecisionRecords(since)
        expect(records.map((n) => n.requestId)).to.deep.equal(ids)
        expect(records.map((n) => n.cursor)).to.deep.equal([GOOD, GOOD])
      }
    })
  })

  describe('real strand database', () => {
    it('W7: a forged cap-valued row neither burns the cursor space nor poisons the high-water mark', async () => {
      const fixture = await createP2pStagingFixture()
      const strandId = `wedge-${crypto.randomUUID()}`
      const authorityId = fixture.auth.authority.id

      // Forger: a correctly signed row at the conforming cap cursor.
      const { privateHex, publicHex } = randomTestKeyPair()
      const digestRow = await fixture.db.prepare('select Digest(:s, :n) as d').get({ s: 'forged', n: crypto.randomUUID() })
      const digest = digestRow?.d as string
      const signature = bytesToHex(secp256k1.sign(digestToBytes(digest), hexToBytes(privateHex)))
      await fixture.db.exec(
        `insert into RegistrationRequestStaging (StrandId, Cursor, RequestId, Digest, InitJson, RequesterKey, SignatureJson, StagedAt)
         values (:strandId, :cursor, :requestId, :digest, :payload, :requesterKey, :signatureJson, :stagedAt)`,
        {
          strandId, cursor: CAP, requestId: 'forged-request', digest, payload: '{}', requesterKey: publicHex,
          signatureJson: JSON.stringify({ signature, signerKey: publicHex }), stagedAt: toIsoZDatetime(Date.now())
        }
      )

      const transport = new P2pRegistrationTransport({
        openStrand: async () => fixture.makePort() as unknown as RegistrationStrandPort,
        computeDigest: async (init, key) => await fixture.fixtureRequestDigest(init, key),
        strandId,
        sealer: fixture.sealer,
        opener: fixture.opener
      })
      const signer = fixture.makeRequesterSigner()
      const id = `honest-${crypto.randomUUID()}`
      const init = {
        id,
        authorityId,
        payload: {
          registrant: { id: `registrant-${id}`, authorityId, expiration: Date.now() + 365 * 86_400_000 },
          private: { expiration: Date.now() + 365 * 86_400_000, details: [{ name: 'note', value: 'wedge' }] }
        },
        submittedAt: new Date().toISOString()
      }
      await transport.submitRequest(init as never, signer.publicHex, signer.sign)

      const rows = await fixture.rawRows('RegistrationRequestStaging', strandId)
      const honest = rows.find((r) => r.RequestId === id)
      expect(honest?.Cursor).to.equal(GOOD)

      const report = await transport.readStagedRequestsReport()
      expect(report.delivered.map((d) => d.requestId)).to.deep.equal([id])
      expect(report.unreadable.map((u) => u.cursor)).to.deep.equal([CAP])
      expect(report.highWaterCursor).to.equal(GOOD)
    })
  })
})
