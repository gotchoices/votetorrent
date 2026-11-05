/**
 * D-05/D-06 shared predicate builder anti-drift proof (Task 2) + D-04/D-07
 * `MockRegistrationEngine` roster-read parity (Task 3). The builder spec is
 * pure/DB-free; the mock spec is pure in-memory — neither needs a real DB
 * fixture, unlike the rest of `test/registration.spec.ts`.
 */

import { expect } from 'chai'
import type { Signature } from '@votetorrent/vote-core'
import {
  REGISTRANT_LIST_DEFAULT_PAGE_SIZE,
  REGISTRANT_LIST_MAX_PAGE_SIZE,
  REGISTRANT_PUBLIC_CURRENCY_JOIN,
  buildRegistrantListCountSql,
  buildRegistrantListFragment,
  buildRegistrantListPageSql,
  clampPageSize
} from '../src/registration/registrant-list-query.js'
import { MockRegistrationEngine } from '../src/registration/mock-registration-engine.js'

describe('registrant-list-query (D-05/D-06 shared predicate builder)', () => {
  const allDimensionsFilter = {
    authorityId: 'authority-1',
    status: 'a' as const,
    expiringBefore: '2030-01-01T00:00:00.000Z',
    expiringAfter: '2020-01-01T00:00:00.000Z',
    district: 'ZZ-SENTINEL-DISTRICT',
    electionId: 'election-1',
    name: 'Smith'
  }

  it('the no-filter page SQL contains REGISTRANT_PUBLIC_CURRENCY_JOIN verbatim', () => {
    const { sql } = buildRegistrantListPageSql(undefined, undefined, 50)
    expect(sql).to.include(REGISTRANT_PUBLIC_CURRENCY_JOIN)
  })

  it('the no-filter count SQL contains REGISTRANT_PUBLIC_CURRENCY_JOIN verbatim', () => {
    const { sql } = buildRegistrantListCountSql(undefined)
    expect(sql).to.include(REGISTRANT_PUBLIC_CURRENCY_JOIN)
  })

  it('an all-dimensions page SQL contains REGISTRANT_PUBLIC_CURRENCY_JOIN verbatim', () => {
    const { sql } = buildRegistrantListPageSql(allDimensionsFilter, 'cursor-1', 50)
    expect(sql).to.include(REGISTRANT_PUBLIC_CURRENCY_JOIN)
  })

  it('an all-dimensions count SQL contains REGISTRANT_PUBLIC_CURRENCY_JOIN verbatim', () => {
    const { sql } = buildRegistrantListCountSql(allDimensionsFilter)
    expect(sql).to.include(REGISTRANT_PUBLIC_CURRENCY_JOIN)
  })

  it('anti-drift lock: the page WHERE and count WHERE are string-identical apart from the cursor clause, and params deep-equal apart from cursor', () => {
    const pageFragment = buildRegistrantListFragment(allDimensionsFilter)
    const page = buildRegistrantListPageSql(allDimensionsFilter, 'cursor-1', 50)
    const count = buildRegistrantListCountSql(allDimensionsFilter)

    // Extract the WHERE substring from each assembled SQL string using the
    // fragment's own where text as the anchor.
    const pageWhereIdx = page.sql.indexOf(pageFragment.where)
    const countWhereIdx = count.sql.indexOf(pageFragment.where)
    expect(pageWhereIdx).to.be.greaterThan(-1)
    expect(countWhereIdx).to.be.greaterThan(-1)

    const pageOrderByIdx = page.sql.indexOf(' order by R.Id asc limit')
    expect(pageOrderByIdx).to.be.greaterThan(-1)
    const pageWhereAndAfter = page.sql.slice(pageWhereIdx, pageOrderByIdx)
    const countWhereAndAfter = count.sql.slice(countWhereIdx, count.sql.indexOf(') as RegistrantMatch'))

    expect(pageWhereAndAfter).to.equal(countWhereAndAfter + ' and R.Id > :cursor')

    const { cursor, ...pageParamsSansCursor } = page.params
    expect(pageParamsSansCursor).to.deep.equal(count.params)
    expect(cursor).to.equal('cursor-1')
  })

  it('the count SQL contains neither order by, nor limit, nor :cursor', () => {
    const { sql } = buildRegistrantListCountSql(allDimensionsFilter)
    expect(sql).to.not.include('order by')
    expect(sql).to.not.include('limit')
    expect(sql).to.not.include(':cursor')
  })

  it('the page SQL contains " order by R.Id asc limit " and, with no cursor, no :cursor', () => {
    const { sql } = buildRegistrantListPageSql(undefined, undefined, 50)
    expect(sql).to.include(' order by R.Id asc limit ')
    expect(sql).to.not.include(':cursor')
  })

  it('electionId adds an inner join ElectionRegistrant to BOTH queries and binds :electionId', () => {
    const page = buildRegistrantListPageSql({ electionId: 'election-1' }, undefined, 50)
    const count = buildRegistrantListCountSql({ electionId: 'election-1' })
    expect(page.sql).to.include('inner join ElectionRegistrant')
    expect(page.sql).to.include(':electionId')
    expect(page.params.electionId).to.equal('election-1')
    expect(count.sql).to.include('inner join ElectionRegistrant')
    expect(count.sql).to.include(':electionId')
    expect(count.params.electionId).to.equal('election-1')
  })

  describe('clampPageSize', () => {
    it('undefined -> default (50)', () => {
      expect(clampPageSize(undefined)).to.equal(REGISTRANT_LIST_DEFAULT_PAGE_SIZE)
      expect(clampPageSize(undefined)).to.equal(50)
    })
    it('0 -> 1', () => {
      expect(clampPageSize(0)).to.equal(1)
    })
    it('-5 -> 1', () => {
      expect(clampPageSize(-5)).to.equal(1)
    })
    it('10.9 -> 10 (truncated)', () => {
      expect(clampPageSize(10.9)).to.equal(10)
    })
    it('9999 -> 200 (max)', () => {
      expect(clampPageSize(9999)).to.equal(REGISTRANT_LIST_MAX_PAGE_SIZE)
      expect(clampPageSize(9999)).to.equal(200)
    })
    it('NaN -> default (50)', () => {
      expect(clampPageSize(NaN)).to.equal(50)
    })
  })

  it('the name filter binds nameQuery to %...% and emits no escape keyword', () => {
    const { sql, params } = buildRegistrantListPageSql({ name: 'Smith' }, undefined, 50)
    expect(params.nameQuery).to.equal('%Smith%')
    expect(sql.toLowerCase()).to.not.include('escape')
  })

  it('injection guard: no filter VALUE appears anywhere in either emitted sql string', () => {
    const filter = { district: 'ZZ-SENTINEL-DISTRICT' }
    const page = buildRegistrantListPageSql(filter, undefined, 50)
    const count = buildRegistrantListCountSql(filter)
    expect(page.sql).to.not.include('ZZ-SENTINEL-DISTRICT')
    expect(count.sql).to.not.include('ZZ-SENTINEL-DISTRICT')
  })

  it('buildRegistrantListFragment is called at least once by definition plus once by each builder (grep-verifiable, exercised here at runtime)', () => {
    // Runtime companion to the plan's static grep gate: exercise both builders
    // and confirm they both produce fragment-derived text (see anti-drift lock
    // test above for the byte-level proof).
    const page = buildRegistrantListPageSql(undefined, undefined, 50)
    const count = buildRegistrantListCountSql(undefined)
    expect(page.sql).to.include('from Registrant R')
    expect(count.sql).to.include('from Registrant R')
  })
})

describe('MockRegistrationEngine roster reads (D-04/D-07 parity)', () => {
  const dummySign = async (): Promise<Signature> => ({ signerUserId: 'u', signerKey: 'k', signature: 's' })
  const FUTURE_EXPIRATION = Date.now() + 365 * 86_400_000

  async function seedRegistrant (
    mock: MockRegistrationEngine,
    opts: { id: string; authorityId?: string; lastName?: string; firstName?: string; district?: string }
  ): Promise<void> {
    await mock.register(
      {
        registrant: { id: opts.id, authorityId: opts.authorityId ?? 'authority-1', expiration: FUTURE_EXPIRATION },
        public: { lastName: opts.lastName, firstName: opts.firstName, district: opts.district },
        private: { expiration: FUTURE_EXPIRATION, details: [] }
      },
      dummySign
    )
  }

  it('filters by status after changeStatus', async () => {
    const mock = new MockRegistrationEngine()
    await seedRegistrant(mock, { id: 'r-status-1' })
    await seedRegistrant(mock, { id: 'r-status-2' })
    await mock.changeStatus('r-status-2', 's', dummySign)

    const result = await mock.listRegistrants({ status: 'a' })
    expect(result.rows.map((r) => r.registrantId)).to.deep.equal(['r-status-1'])
  })

  it('filters by district', async () => {
    const mock = new MockRegistrationEngine()
    await seedRegistrant(mock, { id: 'r-district-1', district: 'North' })
    await seedRegistrant(mock, { id: 'r-district-2', district: 'South' })

    const result = await mock.listRegistrants({ district: 'North' })
    expect(result.rows.map((r) => r.registrantId)).to.deep.equal(['r-district-1'])
  })

  it('filters by name, mixed-case query, case-insensitive substring', async () => {
    const mock = new MockRegistrationEngine()
    await seedRegistrant(mock, { id: 'r-name-1', lastName: 'Smith', firstName: 'John' })
    await seedRegistrant(mock, { id: 'r-name-2', lastName: 'Jones', firstName: 'Alice' })

    const result = await mock.listRegistrants({ name: 'sMi' })
    expect(result.rows.map((r) => r.registrantId)).to.deep.equal(['r-name-1'])
  })

  it('filters by electionId after enrollElectionRegistrant', async () => {
    const mock = new MockRegistrationEngine()
    await seedRegistrant(mock, { id: 'r-elec-1' })
    await seedRegistrant(mock, { id: 'r-elec-2' })
    await mock.enrollElectionRegistrant('election-A', 'r-elec-1', dummySign)

    const result = await mock.listRegistrants({ electionId: 'election-A' })
    expect(result.rows.map((r) => r.registrantId)).to.deep.equal(['r-elec-1'])
  })

  it('ANDs two dimensions together (status + district)', async () => {
    const mock = new MockRegistrationEngine()
    await seedRegistrant(mock, { id: 'r-and-1', district: 'North' })
    await seedRegistrant(mock, { id: 'r-and-2', district: 'North' })
    await mock.changeStatus('r-and-2', 's', dummySign)

    const result = await mock.listRegistrants({ status: 'a', district: 'North' })
    expect(result.rows.map((r) => r.registrantId)).to.deep.equal(['r-and-1'])
  })

  it('keyset pages with pageSize:2 walk the full set with no repeats and no skips', async () => {
    const mock = new MockRegistrationEngine()
    const ids = ['r-page-1', 'r-page-2', 'r-page-3', 'r-page-4', 'r-page-5']
    for (const id of ids) {
      await seedRegistrant(mock, { id })
    }

    const seen: string[] = []
    let cursor: string | undefined
    let guard = 0
    while (guard++ < 20) {
      const page = await mock.listRegistrants({}, { cursor, pageSize: 2 })
      seen.push(...page.rows.map((r) => r.registrantId))
      if (page.nextCursor === undefined) break
      cursor = page.nextCursor
    }

    const expected = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    expect(seen).to.deep.equal(expected)
    expect(new Set(seen).size).to.equal(seen.length)
  })

  it('total is present on the first page and undefined on a cursored page', async () => {
    const mock = new MockRegistrationEngine()
    await seedRegistrant(mock, { id: 'r-total-1' })
    await seedRegistrant(mock, { id: 'r-total-2' })
    await seedRegistrant(mock, { id: 'r-total-3' })

    const first = await mock.listRegistrants({}, { pageSize: 2 })
    expect(first.total).to.equal(3)
    expect(first.nextCursor).to.not.equal(undefined)

    const second = await mock.listRegistrants({}, { cursor: first.nextCursor, pageSize: 2 })
    expect(second.total).to.equal(undefined)
  })

  it('getElectionRegistrants returns the enrolled pairs, not always []', async () => {
    const mock = new MockRegistrationEngine()
    await seedRegistrant(mock, { id: 'r-roster-1' })
    await seedRegistrant(mock, { id: 'r-roster-2' })
    await mock.enrollElectionRegistrant('election-B', 'r-roster-1', dummySign)
    await mock.enrollElectionRegistrant('election-B', 'r-roster-2', dummySign)

    const result = await mock.getElectionRegistrants('election-B')
    expect(result).to.have.length(2)
    expect(result.map((r) => r.registrantId).sort()).to.deep.equal(['r-roster-1', 'r-roster-2'])
  })

  it('getElectionRegistrants returns an empty array for an election with no enrollments', async () => {
    const mock = new MockRegistrationEngine()
    const result = await mock.getElectionRegistrants('election-empty')
    expect(result).to.deep.equal([])
  })
})
