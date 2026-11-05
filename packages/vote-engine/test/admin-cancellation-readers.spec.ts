/**
 * admin-cancellation-readers.spec.ts — a cancelled administration change is never current anywhere (66.1-06, D-13).
 *
 * The file proves D-13 in two halves.
 *
 * First half, a structural drift scan (C5). Every place that picks "the administration in effect now" uses the same
 * selector: the latest Admin generation at or before now. Each copy must also skip a generation that was cancelled,
 * and that skip must sit on the same line as the time comparison. The scan covers `votetorrent.qsql` (with whole
 * `--` comment lines removed) and every `.ts` file under `packages/vote-engine/src` (with comments removed). It
 * deliberately does not cover `test/`: the 66.1-01 probe spec keeps the old text on purpose (planning note R-02).
 * `src/database/schema-sql.ts` is skipped because it is the one-line generated copy of the qsql whose byte identity
 * another spec pins; this file compares its count of the exclusion with the qsql's instead. The scanner's tokens are
 * built from fragments so this file never contains the selector it hunts, and positive controls prove the scanner
 * can see a missing exclusion, an unaliased selector, an exclusion on the wrong line and a commented-out copy.
 */

import { expect } from 'chai'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VOTETORRENT_SCHEMA_SQL } from '../src/database/schema-sql.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = join(HERE, '..', 'src')
const QSQL_FILE = join(HERE, '..', '..', 'vote-core', 'schema', 'votetorrent.qsql')

// ---------------------------------------------------------------------------
// Scanner constants, built from fragments.
// ---------------------------------------------------------------------------

const SEL_HEAD = ['ma', 'x('].join('')
/** The aliased selector every site must use. */
const SELECTOR_ALIASED = [SEL_HEAD, 'A.', 'EffectiveAt)'].join('')
/** The selector with any alias or none. A fresh global regex per call (lastIndex is stateful). */
const selectorRe = (): RegExp => new RegExp(['ma', 'x\\(\\s*(?:\\w+\\.)?', 'Effective', 'At\\s*\\)'].join(''), 'g')
const COMPARISON = 'A.EffectiveAt <='
const EXCLUSION =
  'and not exists (select 1 from AdminCancellation C where C.AuthorityId = A.AuthorityId and C.AdminEffectiveAt = A.EffectiveAt)'
/**
 * 66.1-04 SUMMARY, `### Branch taken`: "SELF_REFERENCE | present | A2 = PASS". CancellerIsRadOfficer carries the
 * exclusion, so no site is allow-listed.
 */
const SELF_REFERENCE_SHIPPED = true

type Reason = 'ok' | 'unaliased' | 'no-comparison' | 'no-exclusion'
interface Site { name: string, reason: Reason }

/** Drop whole lines whose first non-space characters are `--` (the rule 66.1-04's acceptance greps use). */
function stripSql (text: string): string {
  return text.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
}

/** Remove block and line comments (the intake-source-gates idiom). */
function stripTs (text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

function countOf (text: string, needle: string): number {
  return text.split(needle).length - 1
}

function scanSites (stripped: string, kind: 'sql' | 'ts'): Site[] {
  const nameRe = kind === 'sql' ? /\b(?:constraint|view)\s+(\w+)/g : /\bfunction\s+(\w+)/g
  const sites: Site[] = []
  for (const m of stripped.matchAll(selectorRe())) {
    const at = m.index ?? 0
    const before = stripped.slice(0, at)
    const names = [...before.matchAll(nameRe)]
    const name = names.length > 0 ? names[names.length - 1]![1]! : '(none)'
    let reason: Reason
    if (m[0] !== SELECTOR_ALIASED) {
      reason = 'unaliased'
    } else {
      const after = at + m[0].length
      const window = stripped.slice(after, after + 400)
      const cmp = window.indexOf(COMPARISON)
      if (cmp < 0) {
        reason = 'no-comparison'
      } else {
        const lineStart = after + cmp
        const lineEnd = stripped.indexOf('\n', lineStart)
        const rest = stripped.slice(lineStart, lineEnd < 0 ? undefined : lineEnd)
        reason = rest.includes(EXCLUSION) ? 'ok' : 'no-exclusion'
      }
    }
    sites.push({ name, reason })
  }
  return sites
}

function engineSourceFiles (): string[] {
  return (readdirSync(SRC_DIR, { recursive: true }) as string[])
    .map((f) => f.split('\\').join('/'))
    .filter((f) => f.endsWith('.ts') && f !== 'database/schema-sql.ts')
    .sort()
}

describe('cancellation exclusion drift scan (C5)', () => {
  describe('real files', () => {
    it('votetorrent.qsql has exactly the five current-generation sites, each carrying the exclusion', () => {
      const stripped = stripSql(readFileSync(QSQL_FILE, 'utf8'))
      const sites = scanSites(stripped, 'sql')
      expect(sites.map((s) => s.name).sort(), 'a new current-generation reader must carry the cancellation exclusion, then update this pin')
        .to.deep.equal(['CancellerIsRadOfficer', 'CurrentAdmin', 'DeciderIsOfficerWithScope', 'DeciderIsOfficerWithScope', 'PublisherIsOfficer'])
      if (SELF_REFERENCE_SHIPPED) {
        expect(sites.filter((s) => s.reason !== 'ok')).to.deep.equal([])
        expect(countOf(stripped, EXCLUSION)).to.equal(5)
      } else {
        // 66.1-01 A2 = FAIL branch (planning note R-22): the one allow-listed site.
        expect(sites.filter((s) => s.reason !== 'ok')).to.deep.equal([{ name: 'CancellerIsRadOfficer', reason: 'no-exclusion' }])
        expect(countOf(stripped, EXCLUSION)).to.equal(4)
      }
    })

    it('the engine source has exactly one current-generation site, isCurrentPairingOfficer, carrying the exclusion', () => {
      const found: Array<Site & { file: string }> = []
      for (const rel of engineSourceFiles()) {
        const stripped = stripTs(readFileSync(join(SRC_DIR, rel), 'utf8'))
        for (const s of scanSites(stripped, 'ts')) found.push({ ...s, file: rel })
      }
      expect(found, 'a new current-generation reader must carry the cancellation exclusion, then update this pin')
        .to.deep.equal([{ name: 'isCurrentPairingOfficer', reason: 'ok', file: 'pairing/pairing-statement.ts' }])
    })

    it('the generated schema copy holds the exclusion as many times as the qsql file', () => {
      const raw = readFileSync(QSQL_FILE, 'utf8')
      expect(countOf(VOTETORRENT_SCHEMA_SQL, EXCLUSION)).to.equal(countOf(raw, EXCLUSION))
      expect(countOf(raw, EXCLUSION)).to.equal(SELF_REFERENCE_SHIPPED ? 5 : 4)
    })
  })

  describe('positive controls', () => {
    const checkWith = (tail: string): string => [
      '\ttable T (',
      '\t\tconstraint SomeOfficerCheck check on insert (',
      '\t\t\texists (select 1 from Officer O where O.AdminEffectiveAt = (',
      `\t\t\t\tselect ${SELECTOR_ALIASED} from Admin A where A.AuthorityId = O.AuthorityId and A.EffectiveAt <= context.now${tail}`,
      '\t\t\t))',
      '\t\t)',
      '\t)'
    ].join('\n')

    it('a CHECK whose comparison line lacks the exclusion is one no-exclusion site named after its constraint', () => {
      expect(scanSites(stripSql(checkWith('')), 'sql')).to.deep.equal([{ name: 'SomeOfficerCheck', reason: 'no-exclusion' }])
    })

    it('the same CHECK with the exclusion is ok', () => {
      expect(scanSites(stripSql(checkWith(` ${EXCLUSION}`)), 'sql')).to.deep.equal([{ name: 'SomeOfficerCheck', reason: 'ok' }])
    })

    it('a view whose exclusion sits on the line after the comparison is no-exclusion (same-line rule)', () => {
      const view = [
        '\tview SomeView as',
        `\t\tselect A.AuthorityId, ${SELECTOR_ALIASED} as EffectiveAt`,
        '\t\t\tfrom Admin A',
        "\t\t\twhere A.EffectiveAt <= datetime('now')",
        `\t\t\t\t${EXCLUSION}`,
        '\t\t\tgroup by A.AuthorityId;'
      ].join('\n')
      expect(scanSites(stripSql(view), 'sql')).to.deep.equal([{ name: 'SomeView', reason: 'no-exclusion' }])
    })

    it('an unaliased selector is reported as unaliased', () => {
      const view = [
        '\tview OldView as',
        `\t\tselect AuthorityId, ${SEL_HEAD}EffectiveAt) as EffectiveAt from Admin where EffectiveAt <= datetime('now') group by AuthorityId;`
      ].join('\n')
      expect(scanSites(stripSql(view), 'sql')).to.deep.equal([{ name: 'OldView', reason: 'unaliased' }])
    })

    it('a selector with no time comparison after it is reported as no-comparison', () => {
      const view = `\tview LatestEver as\n\t\tselect ${SELECTOR_ALIASED} as E from Admin A;`
      expect(scanSites(stripSql(view), 'sql')).to.deep.equal([{ name: 'LatestEver', reason: 'no-comparison' }])
    })

    it('a violating CHECK only on -- comment lines yields zero sites', () => {
      const commented = checkWith('').split('\n').map((l) => `\t-- ${l.trim()}`).join('\n')
      expect(scanSites(commented, 'sql').length, 'unstripped text is seen (control is not vacuous)').to.be.greaterThan(0)
      expect(scanSites(stripSql(commented), 'sql')).to.deep.equal([])
    })

    const tsWith = (tail: string): string => [
      'export async function someOfficerTest (db: Database): Promise<boolean> {',
      `  const row = await db.prepare('select 1 as x from Officer O where O.AdminEffectiveAt = (select ${SELECTOR_ALIASED} from Admin A where A.AuthorityId = O.AuthorityId and A.EffectiveAt <= :nowAt${tail})').get({})`,
      '  return row != null',
      '}'
    ].join('\n')

    it('a TypeScript prepare string without the exclusion is one no-exclusion site named after its function', () => {
      expect(scanSites(stripTs(tsWith('')), 'ts')).to.deep.equal([{ name: 'someOfficerTest', reason: 'no-exclusion' }])
      expect(scanSites(stripTs(tsWith(` ${EXCLUSION}`)), 'ts')).to.deep.equal([{ name: 'someOfficerTest', reason: 'ok' }])
    })

    it('the same TypeScript inside a line comment or a block comment yields zero sites', () => {
      const lineCommented = tsWith('').split('\n').map((l) => `// ${l}`).join('\n')
      const blockCommented = `/*\n${tsWith('')}\n*/`
      expect(scanSites(lineCommented, 'ts').length, 'unstripped text is seen (control is not vacuous)').to.equal(1)
      expect(scanSites(stripTs(lineCommented), 'ts')).to.deep.equal([])
      expect(scanSites(stripTs(blockCommented), 'ts')).to.deep.equal([])
    })

    it('the REAL qsql text with every exclusion removed reports five non-ok sites', () => {
      const stripped = stripSql(readFileSync(QSQL_FILE, 'utf8'))
      const mutated = stripped.split(EXCLUSION).join('')
      expect(mutated).to.not.equal(stripped)
      const sites = scanSites(mutated, 'sql')
      expect(sites).to.have.length(5)
      expect(sites.every((s) => s.reason === 'no-exclusion')).to.equal(true)
    })
  })
})
