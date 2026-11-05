/**
 * schema-type-regression.spec.ts — DIG-03-b / D-07: number-column regression lock.
 * Also carries the 37-04 boolean-default-column regression lock (re-attach
 * ALTER-COLUMN coercion class — see below).
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
 *
 * Boolean-default coercion class (37-04 / D-05b, D-15): on Hermes / quereus 4.x,
 * re-attach re-executes the declarative schema to rebind catalogs, and quereus 4.x's
 * declarative differ spuriously diffs `boolean default <literal>` columns, emitting
 * an unsupported `ALTER TABLE ... ALTER COLUMN ... SET DEFAULT` that the LevelDB-backed
 * vtab rejects — breaking the WRITE -> force-stop -> relaunch -> READ persistence
 * proof on both the strand and solo paths. Integer-default columns
 * (e.g. `NumberRequiredTSAs integer default 0`) reconcile cleanly. Declaring such
 * columns `integer default <0|1>` instead of `boolean default <true|false>` avoids
 * the coercion entirely. See: 37-DIAGNOSIS-boolean-default-reattach.md and
 * [[project-quereus-v4-reattach-boolean-default-alter-column]] in project memory.
 *
 * One-time audit (current state clean):
 *   - `Question.Required boolean default true` (×2) -> `integer default 1`.
 *   - `Task.IsCompleted boolean default false` -> `integer default 0`.
 *   - `with context ( ... boolean )` clauses are constraint context params, not
 *     stored columns, and do NOT trigger the re-attach ALTER — intentionally NOT
 *     matched by this lock (no `default` token on those clauses).
 *
 * schema-sql.ts regeneration freshness lock (47-01 / D-16): a THIRD, distinct lock
 * class from the two shape-scanning locks above. Those locks scan votetorrent.qsql
 * and the generated schema-sql.ts independently for forbidden shapes (bare `number`,
 * `boolean default`) — so they pass VACUOUSLY when the .qsql is edited but
 * schema-sql.ts is never regenerated (a whole new table can be missing from the
 * generated file entirely, and neither shape-scanning lock notices, because there
 * is nothing forbidden to find in either file taken alone). This lock instead
 * asserts the two artifacts are byte-identical: schema-sql.ts's generator
 * (see its own header comment) is a whole-file `JSON.stringify` of votetorrent.qsql,
 * so exact string equality between `readFileSync(QSQL_PATH)` and the imported
 * `VOTETORRENT_SCHEMA_SQL` export is the correct invariant — any edit to the .qsql
 * that is not followed by a regen, and any hand-edit of schema-sql.ts itself, both
 * fail this lock immediately instead of silently shipping a stale schema to Hermes
 * (which loads schema-sql.ts, never the .qsql, at runtime).
 */

import { expect } from 'chai'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

// Scan newline-delimited schema text for `boolean default <literal>` column
// declarations — the re-attach ALTER-COLUMN coercion class (37-04 / D-05b, D-15).
// Active lines only — strip full-line comments as above. The regex matches a
// column declaration of the form `<indent> <ColumnName> boolean default ...`:
//   Catches:  `  Required boolean default true,`, `  IsCompleted boolean default false,`
//   Does NOT match:
//     - `-- Required boolean default true` (stripped above)
//     - `with context ( ... SomeFlag boolean, ... )` (no `default` token on the
//       context-param clause itself — these are constraint context params, not
//       stored columns, and do NOT trigger the re-attach ALTER)
//     - a bare `boolean` context param with no default (e.g. `Foo boolean null`)
function findBooleanDefaultColumns (schemaText: string): string[] {
  return schemaText
    .split('\n')
    .filter(line => !/^\s*--/.test(line))
    .filter(line => /^\s+\w+\s+boolean\s+default\b/.test(line))
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

describe('InviteSlot.CidValid static lock (Phase 36 / CID-01, CID-02)', () => {
  // Extract the CidValid constraint's check-expression text from a schema string
  // (raw .qsql or un-escaped generated). Scans forward from the `constraint
  // CidValid check (` anchor and balances parens to find the matching close, so
  // the multi-line/multi-branch body is captured whole regardless of formatting.
  function extractCidValidCheck (schemaText: string): string {
    const anchor = 'constraint CidValid check ('
    const start = schemaText.indexOf(anchor)
    expect(start, 'CidValid constraint anchor not found in schema text').to.be.greaterThan(-1)
    let depth = 1
    let i = start + anchor.length
    for (; i < schemaText.length && depth > 0; i++) {
      if (schemaText[i] === '(') depth++
      else if (schemaText[i] === ')') depth--
    }
    return schemaText.slice(start, i)
  }

  // Built via concatenation (not a literal) so this static-lock file itself
  // does not trip the Phase-36 Task-3 source-wide retired-flag sweep — this
  // describe block asserts the flag's ABSENCE from the schema, it does not
  // use the flag (the sweep greps for the literal token, so spelling it out
  // in a comment would also false-positive).
  const RETIRED_FLAG = 'context.' + 'IsCid' + 'Valid'

  it('votetorrent.qsql: CidValid references cid(Digest(...)), not the retired app-computed flag, and has no cid_decode-only structural branch', () => {
    const qsql = readFileSync(QSQL_PATH, 'utf8')
    const checkText = extractCidValidCheck(qsql)

    expect(checkText, 'CidValid must mint via cid(Digest(...))').to.include('cid(Digest(')
    expect(checkText, 'CidValid must NOT reference the retired app-computed context flag').to.not.include(RETIRED_FLAG)
    expect(checkText, 'CidValid must NOT have a structural-only cid_decode fallback branch on InviteSlot').to.not.include('cid_decode')
  })

  it('generated schema-sql.ts: CidValid references cid(Digest(...)), not the retired app-computed flag, and has no cid_decode-only structural branch', () => {
    const generated = readFileSync(GENERATED_PATH, 'utf8')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
    const checkText = extractCidValidCheck(generated)

    expect(checkText, 'CidValid must mint via cid(Digest(...))').to.include('cid(Digest(')
    expect(checkText, 'CidValid must NOT reference the retired app-computed context flag').to.not.include(RETIRED_FLAG)
    expect(checkText, 'CidValid must NOT have a structural-only cid_decode fallback branch on InviteSlot').to.not.include('cid_decode')
  })
})

describe('schema boolean-default-column regression lock (37-04 / D-05b, D-15)', () => {
  it('no active column declarations use "boolean default <literal>" in votetorrent.qsql (re-attach ALTER-COLUMN coercion class)', () => {
    const qsql = readFileSync(QSQL_PATH, 'utf8')
    const violations = findBooleanDefaultColumns(qsql)

    expect(
      violations,
      `Found ${violations.length} 'boolean default <literal>' column declaration(s) in votetorrent.qsql — `
      + `quereus-4.x re-attach ALTER-COLUMN coercion class risk (see 37-DIAGNOSIS-boolean-default-reattach.md):\n  ${violations.join('\n  ')}`,
    ).to.have.length(0)
  })

  it('no "boolean default <literal>" column in the generated schema-sql.ts (the runtime artifact Hermes loads)', () => {
    const generated = readFileSync(GENERATED_PATH, 'utf8')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
    const violations = findBooleanDefaultColumns(generated)

    expect(
      violations,
      `Found ${violations.length} 'boolean default <literal>' column declaration(s) in the generated schema-sql.ts — `
      + `regenerate it from votetorrent.qsql (editing the .qsql alone is a silent no-op on Hermes):\n  ${violations.join('\n  ')}`,
    ).to.have.length(0)
  })
})

describe('schema-sql.ts regeneration freshness lock (47-01 / D-16)', () => {
  it('the generated VOTETORRENT_SCHEMA_SQL export is byte-identical to votetorrent.qsql', async () => {
    const source = readFileSync(QSQL_PATH, 'utf8')
    const { VOTETORRENT_SCHEMA_SQL } = await import('../src/database/schema-sql.js')

    const isEqual = VOTETORRENT_SCHEMA_SQL === source

    let message = ''
    if (!isEqual) {
      const sourceLines = source.split('\n')
      const generatedLines = VOTETORRENT_SCHEMA_SQL.split('\n')
      let firstDiffLine = -1
      const maxLines = Math.max(sourceLines.length, generatedLines.length)
      for (let i = 0; i < maxLines; i++) {
        if (sourceLines[i] !== generatedLines[i]) {
          firstDiffLine = i + 1
          break
        }
      }
      const truncate = (s: string | undefined): string => (s ?? '<missing>').slice(0, 120)
      message = `schema-sql.ts is stale relative to votetorrent.qsql (first differing line ${firstDiffLine}):\n`
        + `  votetorrent.qsql  (length ${source.length}): ${truncate(sourceLines[firstDiffLine - 1])}\n`
        + `  schema-sql.ts     (length ${VOTETORRENT_SCHEMA_SQL.length}): ${truncate(generatedLines[firstDiffLine - 1])}\n`
        + `Regenerate schema-sql.ts from votetorrent.qsql using the header one-liner in `
        + `packages/vote-engine/src/database/schema-sql.ts.`
    }

    expect(isEqual, message).to.equal(true)
  })

  // Built-package (dist) freshness — 47-01 Task 4.
  //
  // The lock above covers .qsql -> src/database/schema-sql.ts. That is necessary
  // but NOT sufficient: vote-engine's package.json `main`/`exports` both point at
  // dist/, so the React Native app bundles the BUILT package and never reads src/.
  // A src-fresh but dist-stale tree therefore passes every other lock in this file
  // while shipping the OLD schema to Hermes. Observed 2026-08-04: an on-device
  // re-attach proof emitted FULL-CHAIN VERDICT: PASS against a day-stale dist that
  // contained neither table under test — a vacuous pass. `--reset-cache` does not
  // help (the stale input is a file on disk, not Metro's transform cache), and
  // dist/ is gitignored so `git status` stays clean.
  //
  // SKIPS when dist is absent: CI and a clean checkout run this suite from src via
  // ts-node with no build present, and an unbuilt package fails loudly at Metro
  // module resolution rather than being silently served — so an absent dist is not
  // this lock's failure mode. Needs `function` (not an arrow) for `this.skip()`.
  it('the BUILT dist schema matches votetorrent.qsql when a build is present', async function () {
    const distPath = join(testDir, '../dist/database/schema-sql.js')
    if (!existsSync(distPath)) {
      this.skip()
      return
    }

    const source = readFileSync(QSQL_PATH, 'utf8')
    const { VOTETORRENT_SCHEMA_SQL } = await import(pathToFileURL(distPath).href)

    expect(
      VOTETORRENT_SCHEMA_SQL,
      `The built vote-engine schema (dist, length ${String(VOTETORRENT_SCHEMA_SQL?.length)}) does not match `
      + `votetorrent.qsql (length ${source.length}). The app bundles dist/, NOT src/ — so an on-device run `
      + `would silently exercise the OLD schema and report a VACUOUS PASS. `
      + `Rebuild with: yarn --cwd packages/vote-engine build`,
    ).to.equal(source)
  })

  // Wiring lock — the guard is only worth anything if the on-device harness runs
  // it, and runs it BEFORE it commits to a bundle. Assert both the presence of the
  // call and its ordering relative to the flag write, so the ordering guarantee
  // itself is locked rather than just the call's existence.
  it('run-vtest02.sh runs the dist-freshness guard before writing proof flags', () => {
    const harness = readFileSync(join(testDir, '../../../scripts/run-vtest02.sh'), 'utf8')
    const lines = harness.split('\n')

    const guardLine = lines.findIndex(l => l.includes('check-dist-freshness.sh'))
    const flagWriteLine = lines.findIndex(l => l.includes('Writing proof-flags.generated.ts'))

    expect(
      guardLine,
      'run-vtest02.sh does not invoke scripts/check-dist-freshness.sh — a stale built '
      + 'vote-engine would be bundled into the proof, producing a vacuous PASS.',
    ).to.not.equal(-1)

    expect(flagWriteLine, 'could not locate the proof-flags write in run-vtest02.sh').to.not.equal(-1)

    expect(
      guardLine < flagWriteLine,
      `The dist-freshness guard must run BEFORE the proof-flags write (guard at line ${guardLine + 1}, `
      + `flag write at line ${flagWriteLine + 1}) — that is the last point where aborting is still free.`,
    ).to.equal(true)
  })

  // -------------------------------------------------------------------------
  // Proof-flag shape lock (WR-03, 47-REVIEW)
  // -------------------------------------------------------------------------
  //
  // Every run script both OVERWRITES apps/.../proof-flags.generated.ts before
  // bundling and REWRITES a fallback copy of it from a heredoc when the EXIT
  // trap's `git checkout` restore fails. Each of those heredocs is a hand-
  // maintained duplicate of the committed file's shape, and each had drifted:
  // run-vtest02.sh declared six of the eight flags, so a proof run left a
  // generated file that no longer type-checks (engine-factory.ts imports
  // USE_STUB_ATTESTATION_VERIFIER, registrant-dev-seed.ts imports
  // REGISTRANT_SEED_ENABLED), and a failed restore wrote that LOSSY version
  // back into the tree.
  //
  // Today's runtime blast radius happened to be benign — `__DEV__ && undefined`
  // is falsy, so a dropped flag stayed off — but that is luck: a future flag
  // whose safe default is `true` would silently flip closed-to-open. This lock
  // makes the committed file the single source of truth for the SHAPE (the set
  // of exported names), while leaving each script free to choose the VALUES.
  const FLAG_FILE_PATH = join(testDir, '../../../apps/VoteTorrentAuthority/src/engines/proof-flags.generated.ts')
  const FLAG_WRITING_SCRIPTS = [
    'run-vtest02.sh',
    'run-dial-probe.sh',
    'run-signing-proof.sh',
    'run-replication-proof.sh',
    // 49-D26a-LOCAL: added with RECOVERY_BRANCH_PROOF_ENABLED. A new flag-writing script that
    // is NOT listed here would escape this lock entirely and be free to drift — the exact
    // failure mode the lock was written to catch.
    'run-recovery-branch-proof.sh',
    // 52-07 (D-05): added with SEALED_PAYLOAD_PROOF_ENABLED, the on-device [seal-kat]
    // Hermes gate for @noble/ciphers.
    'run-sealed-payload-proof.sh',
  ]

  /** The `export const NAME` identifiers in a source blob, in order of appearance. */
  function exportedFlagNames (source: string): string[] {
    return [...source.matchAll(/^export const (\w+)\s*=/gm)].map(m => m[1]!)
  }

  /** Each `cat > "${FLAG_FILE}" << ...EOF ... EOF` body in a shell script. */
  function flagHeredocBodies (script: string): string[] {
    const bodies: string[] = []
    const lines = script.split('\n')
    let current: string[] | undefined
    for (const line of lines) {
      if (current === undefined) {
        if (/cat > "\$\{FLAG_FILE\}" << '?EOF'?/.test(line)) current = []
        continue
      }
      if (line.trim() === 'EOF') {
        bodies.push(current.join('\n'))
        current = undefined
        continue
      }
      current.push(line)
    }
    return bodies
  }

  it('every run-script heredoc declares EXACTLY the flags the committed proof-flags file declares', () => {
    const committed = exportedFlagNames(readFileSync(FLAG_FILE_PATH, 'utf8'))
    expect(committed.length, 'no flags found in proof-flags.generated.ts — the parser is wrong').to.be.greaterThan(0)

    for (const scriptName of FLAG_WRITING_SCRIPTS) {
      const script = readFileSync(join(testDir, '../../../scripts/', scriptName), 'utf8')
      const bodies = flagHeredocBodies(script)

      expect(
        bodies.length,
        `${scriptName} writes no recognisable "cat > \${FLAG_FILE} << EOF" block — either the script `
        + 'stopped writing the flag file, or the heredoc form changed and this lock can no longer see it.',
      ).to.be.greaterThan(0)

      // Compared as SETS, not as ordered arrays (47-REVIEW IN-02). These are
      // independent `export const`s, so declaration order is not load-bearing
      // — but `deep.equal` on the raw arrays enforced it anyway, which meant
      // inserting a new flag anywhere but the END of the committed file turned
      // all four scripts red while the message still said "a different flag
      // SET", sending the next reader hunting for a missing flag.
      bodies.forEach((body, index) => {
        expect(
          [...exportedFlagNames(body)].sort(),
          `${scriptName} heredoc #${index + 1} declares a different flag SET than the committed `
          + 'proof-flags.generated.ts. Add every new flag to every heredoc (values may differ, names may not, '
          + 'order does not matter) — a missing export makes the generated file fail typecheck mid-run, and '
          + 'makes the fallback restore lossy.',
        ).to.deep.equal([...committed].sort())
      })
    }
  })
})
