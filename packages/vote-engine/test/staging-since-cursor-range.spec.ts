/**
 * Spike 110: a staging/decision poll WITH a cursor runs `Cursor > :sinceCursor` (an index range
 * on the (StrandId, Cursor) unique index) instead of `(:sinceCursor is null or Cursor > :sinceCursor)`,
 * which Quereus can only satisfy by walking every row of the strand. The rewrite is exact: with a
 * non-null cursor bound, the two predicates select the same rows.
 */
import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { SINCE_CURSOR_PREDICATE, sinceCursorRangeSql } from '../src/registration/transport/p2p-staging-seam.js'

const here = dirname(fileURLToPath(import.meta.url))
const SQL = `select RequestId, Cursor from X where StrandId = :strandId and ${SINCE_CURSOR_PREDICATE} order by Cursor asc`

describe('sinceCursorRangeSql (spike 110)', () => {
  it('with a cursor, runs the plain range', () => {
    expect(sinceCursorRangeSql(SQL, '0000000000000042')).to.equal(
      'select RequestId, Cursor from X where StrandId = :strandId and Cursor > :sinceCursor order by Cursor asc'
    )
  })

  it('without a cursor, leaves the SQL as written (every row is read either way)', () => {
    expect(sinceCursorRangeSql(SQL, null)).to.equal(SQL)
  })

  it('leaves SQL without the predicate unchanged', () => {
    const other = 'select Cursor from X where StrandId = :strandId and Cursor = :cursor'
    expect(sinceCursorRangeSql(other, '0000000000000042')).to.equal(other)
  })

  it('every P2P reader writes the predicate exactly as the rewrite expects, so no poll silently falls back to the full walk', () => {
    for (const file of ['../src/registration/transport/p2p-registration-transport.ts', '../src/association/transport/p2p-association-transport.ts']) {
      const source = readFileSync(join(here, file), 'utf8')
      const loose = source.match(/sinceCursor is null/g) ?? []
      expect(loose.length, `${file} has readers`).to.be.greaterThan(0)
      expect(source.split(SINCE_CURSOR_PREDICATE).length - 1, `${file}: every optional-cursor predicate is the exact form`).to.equal(loose.length)
    }
  })
})
