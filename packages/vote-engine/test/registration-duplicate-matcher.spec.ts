/**
 * registration-duplicate-matcher.spec.ts — Phase 62 Plan 19 (D-43/D-44)
 *
 * Unit table for the pure identity-fold/normalization helpers and the D-44 match rule
 * (`src/registration/duplicate-detection.ts`), the shared closure SQL fragment
 * (`src/registration/duplicate-closure.ts`), and the `RegistrationDuplicateError` class — plus
 * the Hermes-safety source gates (M8) both new `src/registration/*` modules must pass. No DB is
 * needed except for M6, which proves `registrationRequestNotClosedSql` actually PARSES against
 * the real schema.
 */

import 'reflect-metadata'
import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestNetwork, addTestAuthority } from './fixtures/test-context.js'
import { RegistrationDuplicateError } from '@votetorrent/vote-core'
import {
  DUPLICATE_MATCH_SIGNAL_ORDER,
  DUPLICATE_PHONE_MIN_DIGITS,
  foldIdentityText,
  normalizeNamePart,
  extractRegistrationIdentity,
  matchRegistrationIdentities,
  findLikelyDuplicates
} from '../src/registration/duplicate-detection.js'
import type { DuplicateComparable } from '../src/registration/duplicate-detection.js'
import { registrationRequestNotClosedSql } from '../src/registration/duplicate-closure.js'
import type { RegisterInit } from '@votetorrent/vote-core'

const SRC_REGISTRATION_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'registration')

function comparable (partial: Partial<DuplicateComparable> & { requestId: string }): DuplicateComparable {
  return {
    requestId: partial.requestId,
    authorityId: partial.authorityId ?? 'authority-1',
    requesterKey: partial.requesterKey ?? `requester-${partial.requestId}`,
    receivedAt: partial.receivedAt ?? '2026-01-01T00:00:00.000Z',
    identity: partial.identity ?? {}
  }
}

function payloadWith (opts: {
  firstName?: string
  lastName?: string
  dob?: unknown
  email?: unknown
  phone?: unknown
  detailsOverride?: unknown
}): RegisterInit {
  const details: unknown[] = opts.detailsOverride !== undefined
    ? (opts.detailsOverride as unknown[])
    : [
        ...(opts.dob !== undefined ? [{ name: 'DOB', value: opts.dob }] : []),
        ...(opts.email !== undefined ? [{ name: 'email', value: opts.email }] : []),
        ...(opts.phone !== undefined ? [{ name: 'phone', value: opts.phone }] : [])
      ]
  return {
    registrant: { id: 'r1', authorityId: 'authority-1', expiration: '2027-01-01T00:00:00.000Z' },
    public: { firstName: opts.firstName, lastName: opts.lastName },
    private: { expiration: '2027-01-01T00:00:00.000Z', details: details as RegisterInit['private']['details'] }
  }
}

describe('registration-duplicate-matcher (D-43/D-44)', () => {
  // ---- M1: name fold ----

  it('M1: normalizeNamePart folds accents, case, and hyphenation to the same key', () => {
    expect(normalizeNamePart('  Pérez-Gómez ')).to.equal(normalizeNamePart('PEREZ GOMEZ'))
    expect(normalizeNamePart('  Pérez-Gómez ')).to.equal('perez gomez')
  })

  it("M1: normalizeNamePart(\"O'Brien\") is 'obrien'", () => {
    expect(normalizeNamePart("O'Brien")).to.equal('obrien')
  })

  it('M1: normalizeNamePart of empty/whitespace-only/non-string-or-number is undefined', () => {
    expect(normalizeNamePart('')).to.be.undefined
    expect(normalizeNamePart('   ')).to.be.undefined
    expect(normalizeNamePart({})).to.be.undefined
    expect(normalizeNamePart([1, 2])).to.be.undefined
    expect(normalizeNamePart(null)).to.be.undefined
    expect(normalizeNamePart(undefined)).to.be.undefined
  })

  it('M1: normalizeNamePart(42) is \'42\'', () => {
    expect(normalizeNamePart(42)).to.equal('42')
  })

  // ---- M2: extraction ----

  it('M2: extractRegistrationIdentity reads public names + the private dob/email/phone details', () => {
    const payload = payloadWith({ firstName: 'Ana', lastName: 'Pérez', dob: '1990-02-03', email: ' Ana@Example.com ', phone: '+1 (555) 010-2030' })
    const identity = extractRegistrationIdentity(payload)
    expect(identity.name).to.equal('ana|perez')
    expect(identity.dob).to.equal('19900203')
    expect(identity.email).to.equal('ana@example.com')
    expect(identity.phone).to.equal('15550102030')
  })

  it('M2: only a firstName (no lastName) gives name undefined', () => {
    const payload = payloadWith({ firstName: 'Ana' })
    expect(extractRegistrationIdentity(payload).name).to.be.undefined
  })

  it('M2: an array-valued detail is ignored; a phone under the digit floor and an email with no @ are undefined', () => {
    const arrayDetail = payloadWith({ firstName: 'Ana', lastName: 'Pérez', detailsOverride: [{ name: 'dob', value: [{ name: 'nested', value: '1990' }] }] })
    expect(extractRegistrationIdentity(arrayDetail).dob).to.be.undefined

    const shortPhone = payloadWith({ firstName: 'Ana', lastName: 'Pérez', phone: '12345' })
    expect(extractRegistrationIdentity(shortPhone).phone).to.be.undefined
    expect(DUPLICATE_PHONE_MIN_DIGITS).to.equal(7)

    const badEmail = payloadWith({ firstName: 'Ana', lastName: 'Pérez', email: 'not-an-email' })
    expect(extractRegistrationIdentity(badEmail).email).to.be.undefined
  })

  it('M2: extractRegistrationIdentity never throws on undefined or a payload with no private block', () => {
    expect(() => extractRegistrationIdentity(undefined)).to.not.throw()
    expect(extractRegistrationIdentity(undefined)).to.deep.equal({ name: undefined, dob: undefined, email: undefined, phone: undefined })

    const noPrivate = { registrant: { id: 'r1', authorityId: 'a', expiration: '2027-01-01T00:00:00.000Z' } } as unknown as RegisterInit
    expect(() => extractRegistrationIdentity(noPrivate)).to.not.throw()
  })

  // ---- M3: the match rule ----

  it('M3 positive: the same name with no dob on one side gives [name]; the same name+dob (different separators) gives [name, dob]', () => {
    const a = comparable({ requestId: 'a', identity: { name: 'ana|perez' } })
    const b = comparable({ requestId: 'b', identity: { name: 'ana|perez', dob: '19900203' } })
    expect(matchRegistrationIdentities(a, b)).to.deep.equal(['name'])

    const c = comparable({ requestId: 'c', identity: { name: 'ana|perez', dob: '19900203' } })
    const d = comparable({ requestId: 'd', identity: { name: 'ana|perez', dob: '19900203' } })
    expect(matchRegistrationIdentities(c, d)).to.deep.equal(['name', 'dob'])
  })

  it('M3 negative: the same name with different dobs is not flagged; different names with the same dob/email/phone are not flagged', () => {
    const a = comparable({ requestId: 'a', identity: { name: 'ana|perez', dob: '19900203' } })
    const b = comparable({ requestId: 'b', identity: { name: 'ana|perez', dob: '19910304' } })
    expect(matchRegistrationIdentities(a, b)).to.be.undefined

    const c = comparable({ requestId: 'c', identity: { name: 'ana|perez', dob: '19900203', email: 'x@y.com', phone: '15550000000' } })
    const d = comparable({ requestId: 'd', identity: { name: 'bea|lopez', dob: '19900203', email: 'x@y.com', phone: '15550000000' } })
    expect(matchRegistrationIdentities(c, d)).to.be.undefined
  })

  it('M3 requester key: the same key with both names missing gives [requester-key]; the same key with different names is not flagged', () => {
    const a = comparable({ requestId: 'a', requesterKey: 'k1', identity: {} })
    const b = comparable({ requestId: 'b', requesterKey: 'k1', identity: {} })
    expect(matchRegistrationIdentities(a, b)).to.deep.equal(['requester-key'])

    const c = comparable({ requestId: 'c', requesterKey: 'k1', identity: { name: 'ana|perez' } })
    const d = comparable({ requestId: 'd', requesterKey: 'k1', identity: { name: 'bea|lopez' } })
    expect(matchRegistrationIdentities(c, d)).to.be.undefined
  })

  it('M3 pair: a different authority is never a pair, and a request never matches itself', () => {
    const a = comparable({ requestId: 'a', authorityId: 'authority-1', identity: { name: 'ana|perez' } })
    const b = comparable({ requestId: 'b', authorityId: 'authority-2', identity: { name: 'ana|perez' } })
    expect(matchRegistrationIdentities(a, b)).to.be.undefined

    const same = comparable({ requestId: 'same', identity: { name: 'ana|perez' } })
    expect(matchRegistrationIdentities(same, same)).to.be.undefined
  })

  it('M3 supporting signals: the same name plus the same email and phone gives [name, email, phone], in signal order', () => {
    const a = comparable({ requestId: 'a', identity: { name: 'ana|perez', email: 'ana@example.com', phone: '15550102030' } })
    const b = comparable({ requestId: 'b', identity: { name: 'ana|perez', email: 'ana@example.com', phone: '15550102030' } })
    expect(matchRegistrationIdentities(a, b)).to.deep.equal(['name', 'email', 'phone'])
    expect(DUPLICATE_MATCH_SIGNAL_ORDER).to.deep.equal(['requester-key', 'name', 'dob', 'email', 'phone'])
  })

  // ---- M4: ordering ----

  it('M4: findLikelyDuplicates sorts flagged others oldest-receivedAt-first, then requestId, unparseable last, and skips the target itself', () => {
    const target = comparable({ requestId: 'target', identity: { name: 'ana|perez' } })
    const newer = comparable({ requestId: 'newer', receivedAt: '2026-02-01T00:00:00.000Z', identity: { name: 'ana|perez' } })
    const older = comparable({ requestId: 'older', receivedAt: '2026-01-01T00:00:00.000Z', identity: { name: 'ana|perez' } })
    const sameTimeB = comparable({ requestId: 'tie-b', receivedAt: '2026-01-15T00:00:00.000Z', identity: { name: 'ana|perez' } })
    const sameTimeA = comparable({ requestId: 'tie-a', receivedAt: '2026-01-15T00:00:00.000Z', identity: { name: 'ana|perez' } })
    const unparseable = comparable({ requestId: 'unparseable', receivedAt: 'not-a-date', identity: { name: 'ana|perez' } })
    const nonMatch = comparable({ requestId: 'non-match', identity: { name: 'zed|zed' } })
    const self = comparable({ requestId: 'target', receivedAt: '2020-01-01T00:00:00.000Z', identity: { name: 'ana|perez' } })

    const result = findLikelyDuplicates(target, [newer, older, sameTimeB, sameTimeA, unparseable, nonMatch, self])
    expect(result.map((r) => r.comparable.requestId)).to.deep.equal(['older', 'tie-a', 'tie-b', 'newer', 'unparseable'])
  })

  // ---- M5: Hermes path ----

  it('M5: normalizeNamePart survives a throwing String.prototype.normalize (Hermes without ICU)', () => {
    const original = String.prototype.normalize
    try {
      String.prototype.normalize = function (): string {
        throw new Error('simulated Hermes-without-ICU normalize failure')
      }
      expect(normalizeNamePart('Ana')).to.equal('ana')
    } finally {
      String.prototype.normalize = original
    }
  })

  // ---- M6: closure SQL ----

  it('M6: registrationRequestNotClosedSql returns a two-not-exists fragment and parses against the real schema', async () => {
    const sql = registrationRequestNotClosedSql('R')
    expect(sql).to.include('not exists')
    expect((sql.match(/not exists/g) ?? []).length).to.equal(2)
    expect(sql).to.include('RegistrationDecision')
    expect(sql).to.include('R.Id')
    expect(sql).to.include('R.AuthorityId')

    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const row = await auth.ctx.db
      .prepare(`select count(*) as n from RegistrationRequest R where ${sql}`)
      .get({})
    expect(Number(row?.n ?? -1)).to.equal(0)
  })

  it('M6: registrationRequestNotClosedSql rejects an unsafe alias', () => {
    expect(() => registrationRequestNotClosedSql('R; drop')).to.throw(TypeError)
  })

  // ---- M7: error class ----

  it('M7: RegistrationDuplicateError carries code/requestId/otherRequestId and the right name/instanceof chain', () => {
    const err = new RegistrationDuplicateError('closed-as-duplicate', 'req-1', 'x', 'req-2')
    expect(err).to.be.instanceOf(Error)
    expect(err).to.be.instanceOf(RegistrationDuplicateError)
    expect(err.name).to.equal('RegistrationDuplicateError')
    expect(err.code).to.equal('closed-as-duplicate')
    expect(err.requestId).to.equal('req-1')
    expect(err.otherRequestId).to.equal('req-2')
  })

  // ---- M8: source gates ----

  describe('M8: source gates', () => {
    const detectionSrc = readFileSync(join(SRC_REGISTRATION_DIR, 'duplicate-detection.ts'), 'utf8')
    const closureSrc = readFileSync(join(SRC_REGISTRATION_DIR, 'duplicate-closure.ts'), 'utf8')

    function stripComments (source: string): string {
      return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    }

    it('duplicate-detection.ts has no node: import, no \\p{ Unicode property escape, and no console.*', () => {
      const stripped = stripComments(detectionSrc)
      expect(stripped).to.not.match(/from\s+'node:/)
      expect(stripped).to.not.match(/console\./)
      // Literal, uncommented-source check — mirrors this plan's own acceptance-criteria grep
      // (`grep -cF '\p{'`), which scans the WHOLE file, comments included.
      expect(detectionSrc).to.not.include('\\p{')
    })

    it('every .normalize( call in duplicate-detection.ts sits inside a try block (same line or within 3 preceding lines)', () => {
      const lines = detectionSrc.split('\n')
      const offenders: number[] = []
      lines.forEach((line, i) => {
        if (!line.includes('.normalize(')) return
        const window = lines.slice(Math.max(0, i - 3), i + 1).join('\n')
        if (!window.includes('try')) offenders.push(i + 1)
      })
      expect(offenders, `.normalize( calls not guarded by a nearby try: lines ${offenders.join(', ')}`).to.deep.equal([])
    })

    it('duplicate-detection.ts and duplicate-closure.ts contain no insert/update/delete SQL text and no AsyncStorage', () => {
      for (const src of [detectionSrc, closureSrc]) {
        const stripped = stripComments(src).toLowerCase()
        expect(stripped).to.not.match(/insert into/)
        expect(stripped).to.not.match(/update\s/)
        expect(stripped).to.not.match(/delete from/)
        expect(src).to.not.include('AsyncStorage')
      }
    })
  })
})
