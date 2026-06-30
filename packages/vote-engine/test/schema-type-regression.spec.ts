/**
 * schema-type-regression.spec.ts — DIG-03-b / D-07: number-column regression lock.
 *
 * Static-analysis regression lock (D-07): scans `votetorrent.qsql` for bare `number`
 * column declarations and FAILS CI if any are found. Current state is clean (all
 * Sequence columns are `integer null`). This test LOCKS that invariant so a future
 * accidental reintroduction of a bare `number` type is caught immediately in CI.
 *
 * Background: On Hermes / Quereus, a `number`-typed column stores a bound JS integer
 * as a blob. A deferred Digest-gated CHECK then recomputes the Digest over the stored
 * blob representation, producing a different hash than the one that was signed.
 * The constraint fails and the insert is rejected, or worse: the hash mismatch is
 * silent. Declaring such columns as `integer` prevents the coercion entirely.
 * See: [[project-quereus-number-column-digest-coercion]] in project memory.
 *
 * One-time audit (current state clean):
 *   - `Question.Sequence integer null` — was the coercion-class column; now integer.
 *   - `Option.Sequence integer null` — same fix.
 *   - All other `number` word appearances are in comments or prose, NOT column types.
 *
 * NOTE: If `votetorrent.qsql` is ever edited, `schema-sql.ts` MUST be regenerated
 * (the Hermes runtime loads the generated string, not the .qsql source directly).
 * Editing the .qsql alone is a silent no-op on Hermes.
 */

import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))

// Path to the canonical schema source (NOT schema-sql.ts — the .qsql is the
// human-readable single source of truth; schema-sql.ts is generated from it).
const QSQL_PATH = join(testDir, '../../vote-core/schema/votetorrent.qsql')

describe('schema number-type regression lock (DIG-03-b / D-07)', () => {
  it('no active column declarations use bare "number" type (Digest coercion class)', () => {
    const qsql = readFileSync(QSQL_PATH, 'utf8')

    // Active lines only — strip full-line comments (lines beginning with
    // optional whitespace then `--`). This ensures prose like "lower numbers
    // are shown first" or "-- Sequence number" cannot false-positive.
    const activeLines = qsql.split('\n').filter(line => !/^\s*--/.test(line))

    // Match column declarations of the form:
    //   <indent> <ColumnName> number <whitespace|comma|EOL>
    // Catches:  `  Sequence number null`, `  Foo number,`, `  Bar number`
    // Does NOT match:
    //   - `-- Sequence number` (stripped above)
    //   - `SomeNumberField integer` (word before type is `integer`, not `number`)
    //   - `NumberRequiredTSAs integer` (column name contains "Number", type is integer)
    //   - `typeof(new.NumberRequiredTSAs) = 'integer'` (not a column declaration)
    const violations = activeLines.filter(line => /^\s+\w+\s+number(\s|,|$)/.test(line))

    expect(
      violations,
      `Found ${violations.length} bare 'number' column declaration(s) — Digest coercion class risk:\n  ${violations.join('\n  ')}`,
    ).to.have.length(0)
  })
})
