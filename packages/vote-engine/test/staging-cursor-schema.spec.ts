/**
 * staging-cursor-schema.spec.ts — 62-33 Task 1 (V-4, D-19, D-24, D-52 schema half).
 *
 * The three staging tables must refuse every Cursor that is not exactly 16 ASCII digits within
 * 0000000000000001..9007199254740991 (constraint CursorWellFormed). Every rejection asserts the
 * write THREW and that the message names the constraint; acceptance cases read the row back.
 */

import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { digestToBytes, nowCanonicalDatetime } from '../src/utils.js'
import { VOTETORRENT_SCHEMA_SQL } from '../src/database/schema-sql.js'
import { legacyCursorSchemaReplacements } from './fixtures/legacy-cursor-schema.js'
import { createP2pStagingFixture } from './fixtures/p2p-staging-fixture.js'
import type { P2pStagingFixture } from './fixtures/p2p-staging-fixture.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { createTestNetwork } from './fixtures/test-context.js'
import type { EngineContext } from '../src/types.js'

type StagingTable = 'RegistrationRequestStaging' | 'AssociationRequestStaging' | 'AssociationAttestationStaging'

const TABLES: Array<[StagingTable, 'InitJson' | 'AnswerJson']> = [
  ['RegistrationRequestStaging', 'InitJson'],
  ['AssociationRequestStaging', 'InitJson'],
  ['AssociationAttestationStaging', 'AnswerJson']
]

const MALFORMED: Array<[string, string]> = [
  ['letters', 'zzzzzzzzzzzzzzzz'],
  ['all nines (above the cap)', '9999999999999999'],
  ['exponent shape', '1e15000000000000'],
  ['hex shape', '0x00000000000001'],
  ['trailing letter', '000000000000000a'],
  ['leading space', ' 000000000000001'],
  ['zero', '0000000000000000'],
  ['cap plus one', '9007199254740992']
]

async function arbitraryDigest (ctx: EngineContext, salt: string): Promise<string> {
  const row = await ctx.db.prepare('select Digest(:salt, :nonce) as d').get({ salt, nonce: crypto.randomUUID() })
  if (!row || row.d == null) throw new Error('Digest() returned null')
  return row.d as string
}

async function signedInsert (ctx: EngineContext, table: StagingTable, col: 'InitJson' | 'AnswerJson', cursor: string): Promise<void> {
  const { privateHex, publicHex } = randomTestKeyPair()
  const digest = await arbitraryDigest(ctx, table)
  const signature = bytesToHex(secp256k1.sign(digestToBytes(digest), hexToBytes(privateHex)))
  await ctx.db.exec(
    `insert into ${table} (StrandId, Cursor, RequestId, Digest, ${col}, RequesterKey, SignatureJson, StagedAt)
     values (:strandId, :cursor, :requestId, :digest, :payload, :requesterKey, :signatureJson, :stagedAt)`,
    {
      strandId: `strand-${crypto.randomUUID()}`,
      cursor,
      requestId: crypto.randomUUID(),
      digest,
      payload: JSON.stringify({ version: 1, sealed: 'placeholder' }),
      requesterKey: publicHex,
      signatureJson: JSON.stringify({ signature, signerKey: publicHex }),
      stagedAt: toIsoZDatetime(Date.now())
    }
  )
}

type DecisionTable = 'RegistrationDecision' | 'AssociationDecision'

const P = '00000000000000'
// CR-01 collation shapes: all are 16 UTF-16 units, so they pass a length-only CHECK.
const CR01_SHAPES: Array<[string, string]> = [
  ['supplementary-plane (astral)', P + '\u{1F600}'],
  ['U+FFFD pivot', P + '\uFFFDa'],
  ['U+FFFE BMP high', P + '\uFFFEA'],
  ['ASCII-letter filler', P + 'xA']
]

/** Officer-signed raw decision insert (local copy of the wedge spec's forgeDecision, cursor chosen by caller). */
async function forgeDecision (fixture: P2pStagingFixture, table: DecisionTable, strandId: string, cursor: string): Promise<void> {
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

describe('decision cursor well-formedness (62-46, V-4, CR-01 schema half)', function () {
  this.timeout(240_000)
  let fixture: P2pStagingFixture
  before(async () => {
    fixture = await createP2pStagingFixture()
  })

  for (const table of ['RegistrationDecision', 'AssociationDecision'] as DecisionTable[]) {
    describe(table, () => {
      const shapes: Array<[string, string]> = [...MALFORMED, ...CR01_SHAPES]
      for (const [label, cursor] of shapes) {
        it(`K6: refuses ${label} (${JSON.stringify(cursor)})`, async () => {
          expect(cursor.length, 'shape must be 16 UTF-16 units').to.equal(16)
          let caught: unknown
          try {
            await forgeDecision(fixture, table, `k6-${crypto.randomUUID()}`, cursor)
          } catch (err) {
            caught = err
          }
          expect(caught, `${JSON.stringify(cursor)} must be refused`).to.be.instanceOf(Error)
          expect(String((caught as Error).message)).to.match(/CursorWellFormed/)
        })
      }

      for (const cursor of ['0000000000000001', '9007199254740991']) {
        it(`K7: accepts '${cursor}'`, async () => {
          const strandId = `k7-${crypto.randomUUID()}`
          await forgeDecision(fixture, table, strandId, cursor)
          const row = await fixture.db.prepare(`select count(*) as c from ${table} where StrandId = :strandId and Cursor = :cursor`).get({ strandId, cursor })
          expect(Number(row?.c ?? 0)).to.equal(1)
        })
      }
    })
  }

  it('K8: the legacy-cursor fixture replaces all five CursorWellFormed blocks', () => {
    expect(legacyCursorSchemaReplacements(VOTETORRENT_SCHEMA_SQL)).to.equal(5)
  })
})

describe('staging cursor well-formedness (62-33, V-4)', () => {
  let net: Awaited<ReturnType<typeof createTestNetwork>>
  beforeEach(async () => {
    net = await createTestNetwork()
  })

  for (const [table, col] of TABLES) {
    describe(table, () => {
      for (const [label, cursor] of MALFORMED) {
        it(`K1: refuses ${label} ('${cursor}')`, async () => {
          let caught: unknown
          try {
            await signedInsert(net.ctx, table, col, cursor)
          } catch (err) {
            caught = err
          }
          expect(caught, `'${cursor}' must be refused`).to.be.instanceOf(Error)
          expect(String((caught as Error).message)).to.match(/CursorWellFormed/)
        })
      }

      for (const cursor of ['0000000000000001', '9007199254740991']) {
        it(`K2: accepts '${cursor}'`, async () => {
          await signedInsert(net.ctx, table, col, cursor)
          const row = await net.ctx.db.prepare(`select count(*) as c from ${table} where Cursor = :cursor`).get({ cursor })
          expect(Number(row?.c ?? 0)).to.be.greaterThan(0)
        })
      }
    })
  }

  it("K3: replace() exists and chains (select replace(replace('a1b','1',''),'a','') = 'b')", async () => {
    const row = await net.ctx.db.prepare(`select replace(replace('a1b', '1', ''), 'a', '') as r`).get({})
    expect(row?.r).to.equal('b')
  })

  describe('schema text', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const qsql = readFileSync(resolve(here, '../../vote-core/schema/votetorrent.qsql'), 'utf8')

    it('K4: RegistrantSelective has no CidValid but keeps RegistrantCidMatch and InsertValid', () => {
      const start = qsql.indexOf('table RegistrantSelective (')
      expect(start).to.be.greaterThan(-1)
      const end = qsql.indexOf('with context', start)
      const block = qsql
        .slice(start, end)
        .split('\n')
        .filter(l => !/^\s*--/.test(l))
        .join('\n')
      expect(block).to.not.contain('constraint CidValid')
      expect(block).to.contain('constraint RegistrantCidMatch')
      expect(block).to.contain('constraint InsertValid')
    })

    it('K5: all five staging and decision tables declare CursorWellFormed and none declares CursorWidth', () => {
      const code = qsql.split('\n').filter(l => !/^\s*--/.test(l)).join('\n')
      expect(code.split('constraint CursorWidth check').length - 1).to.equal(0)
      expect(code.split('constraint CursorWellFormed check').length - 1).to.equal(5)
    })
  })
})
