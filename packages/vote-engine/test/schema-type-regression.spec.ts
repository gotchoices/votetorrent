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
 * Editing the .qsql alone is a silent no-op on Hermes. WR-02 (35-REVIEW): this
 * lock therefore scans BOTH artifacts — the .qsql source AND the generated
 * runtime string — so a stale/un-regenerated or hand-edited schema-sql.ts that
 * carries a bare `number` column is caught even when the .qsql is clean.
 */

import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))

// Path to the canonical schema source (the .qsql is the human-readable single
// source of truth) and to the generated string the Hermes runtime actually loads.
const QSQL_PATH = join(testDir, '../../vote-core/schema/votetorrent.qsql')
const GENERATED_PATH = join(testDir, '../src/database/schema-sql.ts')

// Scan newline-delimited schema text for bare `number` column declarations.
// Active lines only — strip full-line comments (lines beginning with optional
// whitespace then `--`) so prose like "lower numbers are shown first" or
// "-- Sequence number" cannot false-positive. The regex matches a column
// declaration of the form `<indent> <ColumnName> number <ws|comma|)|EOL>`:
//   Catches:  `  Sequence number null`, `  Foo number,`, `  Bar number)`
//   Does NOT match:
//     - `-- Sequence number` (stripped above)
//     - `SomeNumberField integer` (type token is `integer`, not `number`)
//     - `NumberRequiredTSAs integer` (column name contains "Number", type integer)
//     - `typeof(new.NumberRequiredTSAs) = 'integer'` (not a column declaration)
// IN-01 (35-REVIEW): the `)` terminator also flags a trailing `Bar number)`.
function findBareNumberColumns (schemaText: string): string[] {
  return schemaText
    .split('\n')
    .filter(line => !/^\s*--/.test(line))
    .filter(line => /^\s+\w+\s+number(\s|,|\)|$)/.test(line))
}

describe('schema number-type regression lock (DIG-03-b / D-07)', () => {
  it('no active column declarations use bare "number" type in votetorrent.qsql (Digest coercion class)', () => {
    const qsql = readFileSync(QSQL_PATH, 'utf8')
    const violations = findBareNumberColumns(qsql)

    expect(
      violations,
      `Found ${violations.length} bare 'number' column declaration(s) in votetorrent.qsql — Digest coercion class risk:\n  ${violations.join('\n  ')}`,
    ).to.have.length(0)
  })

  it('no bare "number" column in the generated schema-sql.ts (the runtime artifact Hermes loads)', () => {
    // schema-sql.ts is a JSON-escaped single-line string export: real newlines
    // and tabs appear as the literal sequences `\n` / `\t`. Un-escape them so the
    // same line-based scan as the .qsql applies symmetrically.
    const generated = readFileSync(GENERATED_PATH, 'utf8')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
    const violations = findBareNumberColumns(generated)

    expect(
      violations,
      `Found ${violations.length} bare 'number' column declaration(s) in the generated schema-sql.ts — `
      + `regenerate it from votetorrent.qsql (editing the .qsql alone is a silent no-op on Hermes):\n  ${violations.join('\n  ')}`,
    ).to.have.length(0)
  })
})
