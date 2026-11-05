/**
 * staging-walk-bound-retry.spec.ts (review finding gap4/IN-02).
 *
 *  W-1   a PRESENT but unreadable count is a loud 'count-unreadable', never a silent 0.
 *  W-1b  an EMPTY count result (no row, null, undefined) still means 0 rows.
 *  W-2   a walk that outgrows the (stale) count is retried with a re-read count, not failed.
 *  W-3   a non-advancing page still throws 'cursor-exhausted' at once.
 */

import { expect } from 'chai'
import { compareCodePoints } from '@quereus/quereus'
import {
  insertWithCursorRetry,
  P2pStagingError,
  stagingCursorCeiling,
  STAGING_CURSOR_MAX_ATTEMPTS
} from '../src/registration/transport/p2p-staging-seam.js'
import type { StagingSqlPort } from '../src/registration/transport/p2p-staging-seam.js'

const pad = (n: number): string => String(n).padStart(16, '0')

class ScriptedPort implements StagingSqlPort {
  mutates = 0
  countReads = 0
  constructor (
    readonly cursors: string[],
    /** Returns the count result for the nth (1-based) count read. */
    private readonly countFor: (n: number, actual: number) => unknown[]
  ) {}

  async query<T> (sql: string, params: Record<string, unknown>): Promise<T[]> {
    if (/count\(\*\)/.test(sql)) {
      this.countReads += 1
      return this.countFor(this.countReads, this.cursors.length) as T[]
    }
    const sorted = [...this.cursors].sort((a, b) => compareCodePoints(a, b))
    if (/order by Cursor asc limit 64/.test(sql)) {
      const after = params.afterCursor as string
      const cap = params.capCursor as string
      return sorted.filter((c) => compareCodePoints(c, after) > 0 && compareCodePoints(c, cap) <= 0).slice(0, 64).map((c) => ({ Cursor: c }) as unknown as T)
    }
    if (/order by Cursor desc limit 64/.test(sql)) {
      const ceiling = params.ceiling as string
      const before = params.beforeCursor as string | undefined
      return sorted.filter((c) => compareCodePoints(c, ceiling) <= 0 && (before === undefined || compareCodePoints(c, before) < 0))
        .reverse().slice(0, 64).map((c) => ({ Cursor: c }) as unknown as T)
    }
    if (/Cursor = :cursor/.test(sql)) return this.cursors.filter((c) => c === params.cursor).map((c) => ({ Cursor: c }) as unknown as T)
    throw new Error(`ScriptedPort: unexpected query ${sql}`)
  }

  async mutate (_sql: string, params: Record<string, unknown>): Promise<void> {
    this.mutates += 1
    const cursor = params.cursor as string
    if (this.cursors.includes(cursor)) throw new Error('UNIQUE constraint failed')
    this.cursors.push(cursor)
  }

  async close (): Promise<void> {}
  describe (): string { return 'scripted' }
}

const insertArgs = {
  table: 'RegistrationRequestStaging' as const,
  strandId: 'strand-1',
  insertSql: 'insert into RegistrationRequestStaging (Cursor) values (:cursor)',
  params: {},
  identity: { sql: 'select Cursor from RegistrationRequestStaging where 1 = 0', params: {} },
  onIdentityConflict: () => 'idempotent' as const,
  where: 'test'
}

describe('staging-walk-bound-retry.spec: count handling and walk overrun', function () {
  for (const bad of ['abc', -1, 1.5, Number.NaN, '-3', '']) {
    it(`W-1: RowCount ${JSON.stringify(bad)} (${String(bad)}) is count-unreadable for insert and ceiling`, async () => {
      const port = new ScriptedPort([], () => [{ RowCount: bad }])
      for (const run of [
        async () => await insertWithCursorRetry(port, insertArgs),
        async () => await stagingCursorCeiling(port, 'RegistrationRequestStaging', 'strand-1')
      ]) {
        let caught: unknown
        try { await run() } catch (err) { caught = err }
        expect(caught).to.be.instanceOf(P2pStagingError)
        expect((caught as P2pStagingError).code).to.equal('count-unreadable')
      }
    })
  }

  for (const [label, result] of [['no row', []], ['null', [{ RowCount: null }]], ['undefined', [{ RowCount: undefined }]]] as Array<[string, unknown[]]>) {
    it(`W-1b: an empty count result (${label}) means 0 rows`, async () => {
      const port = new ScriptedPort([], () => result)
      expect(await stagingCursorCeiling(port, 'RegistrationRequestStaging', 'strand-1')).to.equal(pad(1000))
      const out = await insertWithCursorRetry(port, insertArgs)
      expect(out).to.deep.equal({ cursor: pad(1), idempotent: false })
    })
  }

  it('W-2: a walk that outgrows a stale count is retried with a re-read count', async () => {
    const cursors = Array.from({ length: 1200 }, (_, i) => pad(i + 1))
    // First read claims 0 rows (bound 2 pages); every later read is truthful (bound 20 pages).
    const port = new ScriptedPort(cursors, (n, actual) => [{ RowCount: n === 1 ? 0 : actual }])
    const out = await insertWithCursorRetry(port, insertArgs)
    expect(out.cursor).to.equal(pad(1201))
    expect(port.countReads).to.be.greaterThan(1)
  })

  it('W-2b: when every attempt overruns, the insert finally throws cursor-exhausted', async () => {
    const cursors = Array.from({ length: 1200 }, (_, i) => pad(i + 1))
    // The count grows on every read but never enough to cover the 20 pages the walk needs.
    const port = new ScriptedPort(cursors, (n) => [{ RowCount: n }])
    let caught: unknown
    try { await insertWithCursorRetry(port, insertArgs) } catch (err) { caught = err }
    expect(caught).to.be.instanceOf(P2pStagingError)
    expect((caught as P2pStagingError).code).to.equal('cursor-exhausted')
    expect(port.countReads).to.equal(STAGING_CURSOR_MAX_ATTEMPTS)
  })

  it('W-2c: an overrun against an UNCHANGED count is surfaced at once (no pointless retries)', async () => {
    const cursors = Array.from({ length: 1200 }, (_, i) => pad(i + 1))
    const port = new ScriptedPort(cursors, () => [{ RowCount: 0 }])
    let caught: unknown
    try { await insertWithCursorRetry(port, insertArgs) } catch (err) { caught = err }
    expect((caught as P2pStagingError).code).to.equal('cursor-exhausted')
    expect(port.countReads).to.equal(2)
  })

  it('W-3: a non-advancing page still throws cursor-exhausted immediately', async () => {
    const cursors = [...Array.from({ length: 1000 }, (_, i) => pad(i + 1)), ...Array.from({ length: 70 }, (_, i) => `${'0'.repeat(14)}x${String.fromCharCode(0x41 + i)}`)]
    class Stuck extends ScriptedPort {
      override async query<T> (sql: string, params: Record<string, unknown>): Promise<T[]> {
        if (/order by Cursor asc limit 64/.test(sql)) return Array.from({ length: 64 }, () => ({ Cursor: pad(1001) }) as unknown as T)
        return await super.query<T>(sql, params)
      }
    }
    const port = new Stuck(cursors, (_n, actual) => [{ RowCount: actual }])
    let caught: unknown
    try { await insertWithCursorRetry(port, insertArgs) } catch (err) { caught = err }
    expect((caught as P2pStagingError).code).to.equal('cursor-exhausted')
    expect(port.countReads).to.equal(1)
  })
})
