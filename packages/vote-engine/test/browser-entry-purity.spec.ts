/**
 * browser-entry-purity.spec.ts
 *
 * Phase 50 (D-01/D-02/D-19) — the `./browser` subpath (backed by
 * `src/browser-entry.ts`) is the ONLY mechanism by which the new
 * `apps/VoteTorrentDashboard` Vite workspace reaches `@votetorrent/vote-engine`.
 * Nothing reachable from that subpath may import React Native, a Node builtin,
 * or `buffer` — all three are simply absent in a browser bundle.
 *
 * This spec walks the transitive SOURCE import graph (relative `./x.js`
 * specifiers resolved to `./x.ts`, comments stripped) rooted at
 * `src/browser-entry.ts` and asserts:
 *
 *   BROWSER-PURITY-a — zero forbidden (RN / Node-builtin / buffer) specifiers
 *                       reachable from the ./browser graph.
 *   BROWSER-PURITY-b — the graph's bare (non-relative) specifiers are EXACTLY
 *                       the 7-entry allowlist below — two-directional
 *                       set-equality, so a new dependency fails loudly rather
 *                       than silently widening the bundle.
 *   BROWSER-PURITY-c — the walker actually reaches a non-trivial graph
 *                       (>= 12 files) — guards (a)/(b) against a broken
 *                       resolver that walks almost nothing and passes
 *                       vacuously.
 *   BROWSER-PURITY-d — POSITIVE CONTROL: the identical walker, run over
 *                       `src/rn-entry.ts`, DOES report the async-storage and
 *                       buffer violations it is supposed to catch. Proves the
 *                       walker can actually detect a violation, not just fail
 *                       to find one.
 *   D-02-a            — no file under `src/` imports bare `'crypto'` (the one
 *                       open half of D-02 this plan closes).
 *   BROWSER-PAIRING-a — (Phase 66, C-1) the ./browser graph reaches the pairing
 *                       code, statement and revocation modules and the join
 *                       code, and never pair-wire.ts or pair-mint-service.ts.
 *   BROWSER-PAIRING-b — POSITIVE CONTROL: the same walker from rn-entry.ts DOES
 *                       reach pair-wire.ts and pair-mint-service.ts.
 *   BROWSER-PAIRING-c — browser-entry's names from './pairing/*' are exactly
 *                       the pinned decode/verify set (set equality), and no
 *                       owner-side or signing name appears among its exports.
 *   PAIRING-BARREL-a  — src/pairing/index.ts has no export-star and re-exports
 *                       exactly the five modules' declared names.
 *   PAIRING-RN-a      — rn-entry re-exports exactly the barrel's names from
 *                       './pairing/index.js', and none from another specifier.
 *   D-02-b            — POSITIVE CONTROL: `networks-engine.ts` still calls
 *                       `crypto.randomUUID()` at both surviving call sites —
 *                       proves the D-02-a fix removed only the dead import,
 *                       not a call site.
 *
 * Comment-stripping is MANDATORY, not optional: `src/utils.ts` contains the
 * literal word `Buffer` inside a comment, and `src/user/user-engine.ts`
 * contains English prose ("user lacks the scope.") that a naive multi-line
 * `[\s\S]*?` import regex misparses as an import specifier. Both were
 * observed with an unstripped scanner while developing this walker.
 */

import { expect } from 'chai'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Exact bare specifiers that are never browser-safe. */
const FORBIDDEN_EXACT = [
  'react-native',
  '@react-native-async-storage/async-storage',
  'crypto',
  'fs',
  'fs/promises',
  'path',
  'os',
  'buffer',
  'child_process',
  'url',
  'stream',
  'util',
  'events'
]

/** Bare specifier prefixes that are never browser-safe. */
const FORBIDDEN_PREFIX = [
  'node:',
  'react-native/',
  '@react-native-community/',
  '@react-native-async-storage/'
]

/**
 * The exact 7-entry allowlist of bare specifiers reachable from
 * `src/browser-entry.ts` (measured 2026-08-25 by walking the transitive
 * source import graph — see 50-01-PLAN.md `<measured_facts>`).
 *
 * Each entry's "why browser-safe" rationale is recorded here so a future
 * widener has to argue against a stated reason, not just add a string:
 *
 *   - '@quereus/quereus'                          — ran in headless Chrome
 *     unchanged in spikes 075/076.
 *   - '@votetorrent/vote-core'                     — grep-verified zero
 *     react-native/async-storage/node:/crypto/buffer imports under
 *     packages/vote-core/src/.
 *   - '@noble/curves/utils.js'                     — pure-JS crypto, no Node
 *     builtins.
 *   - '@noble/hashes/sha2.js'                       — pure-JS crypto.
 *   - '@noble/hashes/utils.js'                      — pure-JS crypto.
 *   - '@optimystic/quereus-plugin-crypto'           — registered in-browser
 *     by spikes 075/076.
 *   - '@optimystic/quereus-plugin-crypto/plugin'    — same package, `exports`
 *     subpath (carries a pre-existing `@ts-ignore TS2307` at the import
 *     site in database/initialize.ts — leave it).
 */
const BROWSER_ALLOWLIST = [
  '@quereus/quereus',
  '@votetorrent/vote-core',
  '@noble/curves/utils.js',
  '@noble/hashes/sha2.js',
  '@noble/hashes/utils.js',
  '@optimystic/quereus-plugin-crypto',
  '@optimystic/quereus-plugin-crypto/plugin'
]

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** Locate packages/vote-engine/src from this spec's own location. */
function findSrcDir (): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // this spec lives at packages/vote-engine/test/browser-entry-purity.spec.ts
  return join(here, '..', 'src')
}

const SRC_DIR = findSrcDir()

// ---------------------------------------------------------------------------
// Comment stripping + import extraction
// ---------------------------------------------------------------------------

/**
 * Strip `/* ... *\/` block comments then `// ...` line comments from TS
 * source. MANDATORY before regex-scanning for imports — see file header.
 *
 * This is a best-effort stripper (does not special-case comment-looking
 * substrings inside string literals), which is acceptable here because the
 * walker's own throw-on-unresolvable-specifier behavior (see
 * `resolveRelative`) surfaces any resulting misparse loudly rather than
 * silently.
 */
function stripComments (src: string): string {
  const noBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, '')
  return noBlockComments.replace(/\/\/.*$/gm, '')
}

/**
 * Declaration keywords that, immediately following `import`/`export`
 * (+ optional `type`), mark the statement as NOT a from-clause import/export
 * (e.g. `export const X = ...`, `export function f() {}`, `export default
 * class {}`) — these must never trigger the from-clause accumulator below.
 */
const DECLARATION_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'class', 'interface', 'enum',
  'namespace', 'abstract', 'declare', 'default'
])

/**
 * Extract every import/export-from specifier (plus bare side-effect imports)
 * from stripped source.
 *
 * This is a bracket-depth-aware line accumulator, NOT a single `[\s\S]*?`
 * regex spanning arbitrary text (that shape is exactly what this plan's
 * `<read_first>` warns against — it can walk clean past unrelated code
 * hunting for a distant `from`). Instead: identify each line that begins a
 * genuine `import`/`export` statement, accumulate forward ONLY while braces
 * are unbalanced (bounded to 30 lines), then look for a `from '...'` clause
 * in the accumulated buffer. A statement with balanced/absent braces and no
 * `from` on the same accumulated buffer (e.g. a bare `export { A, B }`
 * re-export, or `export type Foo = { a: string }`) is correctly recorded as
 * having no specifier — matching real language semantics, not a heuristic
 * guess.
 *
 * `export type Foo = ...` (a type ALIAS, no specifier) is deliberately
 * distinguished from `export type { Foo } from '...'` (a type RE-EXPORT):
 * both start `export type `, but only the second's next token is `{`/`*`.
 * A naive regex without this line-shape discrimination misclassifies
 * `export type DbFactory = (h: string) => Promise<Database>`
 * (`packages/vote-engine/src/types.ts`) as an unterminated from-clause hunt.
 */
function extractSpecifiers (strippedSrc: string): string[] {
  const lines = strippedSrc.split('\n')
  const specifiers: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const startMatch = line.match(/^\s*(import|export)\s+(type\s+)?(\S)/)
    if (!startMatch) { i++; continue }

    const keyword = startMatch[1]
    const nextChar = startMatch[3]

    if (nextChar !== '{' && nextChar !== '*' && nextChar !== "'" && nextChar !== '"') {
      // Next token is a bare identifier (not `{`, `*`, or a quote). Either a
      // declaration keyword (`const`/`function`/...) or, for `export`, any
      // other bare identifier (`export type Foo = ...`, `export Foo` is not
      // valid syntax outside `export default`) — neither is a from-clause
      // statement. `import Foo from '...'` (default import) is the one
      // legitimate bare-identifier case and falls through below.
      const wordMatch = line.match(/^\s*(?:import|export)\s+(?:type\s+)?([A-Za-z_$][\w$]*)/)
      const word = wordMatch ? wordMatch[1] : ''
      if (DECLARATION_KEYWORDS.has(word) || keyword === 'export') {
        i++
        continue
      }
    }

    if (nextChar === "'" || nextChar === '"') {
      const sideMatch = line.match(/^\s*import\s*['"]([^'"]+)['"]/)
      if (sideMatch) {
        specifiers.push(sideMatch[1])
        i++
        continue
      }
    }

    // From-clause candidate (named/star/default import, or a from-reexport).
    // Accumulate forward only while braces are unbalanced, bounded to 30
    // lines so a genuinely malformed/unresolvable statement fails fast
    // rather than silently consuming the rest of the file.
    let buffer = line
    let depth = (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
    let j = i
    const maxLines = 30
    while (depth > 0 && j - i < maxLines && j + 1 < lines.length) {
      j++
      buffer += '\n' + lines[j]
      depth += (lines[j].match(/\{/g) ?? []).length - (lines[j].match(/\}/g) ?? []).length
    }

    let m = buffer.match(/\bfrom\s*['"]([^'"]+)['"]/)
    if (!m && j + 1 < lines.length && /^\s*from\s*['"]/.test(lines[j + 1])) {
      // Rare style: `from '...'` on its own line after the closing brace.
      j++
      buffer += '\n' + lines[j]
      m = buffer.match(/\bfrom\s*['"]([^'"]+)['"]/)
    }

    if (m) specifiers.push(m[1])
    i = j + 1
  }

  return specifiers
}

// ---------------------------------------------------------------------------
// The walker
// ---------------------------------------------------------------------------

/**
 * Resolve a relative specifier (as imported from `fromFile`) to an absolute
 * .ts path. Tries, in order: literal path with a trailing `.js` rewritten to
 * `.ts`; literal path plus `.ts`; literal path plus `/index.ts`.
 *
 * Throws if none exist — a walker that silently drops an edge is a walker
 * that passes vacuously.
 */
function resolveRelative (fromFile: string, specifier: string): string {
  const baseDir = dirname(fromFile)
  const literal = join(baseDir, specifier)

  const candidates: string[] = []
  if (specifier.endsWith('.js')) {
    candidates.push(literal.slice(0, -3) + '.ts')
  }
  candidates.push(literal + '.ts')
  candidates.push(join(literal, 'index.ts'))
  // Also allow an already-resolved .ts literal (defensive; not expected in this codebase).
  candidates.push(literal)

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  throw new Error(
    `browser-entry-purity walker: cannot resolve relative specifier '${specifier}' imported from '${fromFile}'. ` +
    `Tried: ${candidates.join(', ')}`
  )
}

interface GraphResult {
  /** Absolute paths of every file reached (including the entry file itself). */
  files: string[]
  /** Bare specifier -> relative (to src/) file paths that import it. */
  bare: Map<string, string[]>
}

/**
 * Walk the transitive import graph starting at `entryAbsPath`.
 *
 * Relative specifiers are recursed into; every non-relative (bare) specifier
 * is recorded in `bare`, attributed to the importing file (relative to
 * SRC_DIR for readable assertion messages).
 */
function collectGraph (entryAbsPath: string): GraphResult {
  const visited = new Set<string>()
  const bare = new Map<string, string[]>()
  const queue: string[] = [entryAbsPath]

  while (queue.length > 0) {
    const file = queue.shift() as string
    if (visited.has(file)) continue
    visited.add(file)

    const src = readFileSync(file, 'utf8')
    const stripped = stripComments(src)
    const specifiers = extractSpecifiers(stripped)

    for (const spec of specifiers) {
      if (spec.startsWith('.')) {
        const resolved = resolveRelative(file, spec)
        if (!visited.has(resolved)) queue.push(resolved)
      } else {
        const relFile = file.startsWith(SRC_DIR) ? file.slice(SRC_DIR.length + 1) : file
        const existing = bare.get(spec)
        if (existing) {
          existing.push(relFile)
        } else {
          bare.set(spec, [relFile])
        }
      }
    }
  }

  return { files: [...visited], bare }
}

/** A single forbidden-specifier violation: <specifier> <- <relative file>. */
interface Violation {
  specifier: string
  importedBy: string
}

/** Reduce a collected graph's bare-specifier map to the forbidden subset. */
function findForbiddenViolations (bare: Map<string, string[]>): Violation[] {
  const violations: Violation[] = []
  for (const [specifier, importers] of bare) {
    const isForbidden =
      FORBIDDEN_EXACT.includes(specifier) ||
      FORBIDDEN_PREFIX.some((prefix) => specifier.startsWith(prefix))
    if (!isForbidden) continue
    for (const importedBy of importers) {
      violations.push({ specifier, importedBy })
    }
  }
  return violations
}

function formatViolations (violations: Violation[]): string {
  return violations.map((v) => `${v.specifier} <- ${v.importedBy}`).join('; ')
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

describe('browser-entry-purity (Phase 50 D-01/D-02/D-19)', () => {
  const browserEntryPath = join(SRC_DIR, 'browser-entry.ts')
  const rnEntryPath = join(SRC_DIR, 'rn-entry.ts')

  it('BROWSER-PURITY-a: the ./browser import graph contains zero React Native / Node-builtin / buffer specifiers', () => {
    const graph = collectGraph(browserEntryPath)
    const violations = findForbiddenViolations(graph.bare)
    expect(
      violations.length,
      `Expected zero forbidden specifiers reachable from browser-entry.ts, found: ${formatViolations(violations)}`
    ).to.equal(0)
  })

  it("BROWSER-PURITY-b: the ./browser graph's bare specifiers are exactly the 7-entry allowlist", () => {
    const graph = collectGraph(browserEntryPath)
    const actual = new Set(graph.bare.keys())
    const expected = new Set(BROWSER_ALLOWLIST)

    const unexpectedExtras = [...actual].filter((s) => !expected.has(s))
    const missingExpected = [...expected].filter((s) => !actual.has(s))

    expect(
      unexpectedExtras.length,
      `Unexpected bare specifiers reachable from browser-entry.ts (not in the allowlist): ${unexpectedExtras.join(', ')}`
    ).to.equal(0)
    expect(
      missingExpected.length,
      `Allowlisted specifiers NOT reachable from browser-entry.ts (allowlist has drifted from reality): ${missingExpected.join(', ')}`
    ).to.equal(0)
  })

  it('BROWSER-PURITY-c: the walker reaches a non-trivial graph (>= 12 files) from browser-entry.ts', () => {
    const graph = collectGraph(browserEntryPath)
    expect(
      graph.files.length,
      `Expected >= 12 files reached from browser-entry.ts, found ${graph.files.length} — the resolver may be walking almost nothing`
    ).to.be.at.least(12)
  })

  it('BROWSER-PURITY-d (positive control): the same walker reports async-storage and buffer violations for rn-entry.ts', () => {
    // Deliberately do NOT assert on bare 'crypto' here — Task 2 deletes that
    // import from networks-engine.ts, which is also reachable from
    // rn-entry.ts. A control keyed on 'crypto' would flip from green to red
    // partway through this plan; async-storage and buffer are permanent
    // rn-entry.ts violations that never go away.
    const graph = collectGraph(rnEntryPath)
    const violations = findForbiddenViolations(graph.bare)

    const hasAsyncStorage = violations.some(
      (v) => v.specifier === '@react-native-async-storage/async-storage' && v.importedBy.includes('local-storage-react.ts')
    )
    const hasBuffer = violations.some(
      (v) => v.specifier === 'buffer' && v.importedBy.includes('association/key-provider.ts')
    )

    expect(
      hasAsyncStorage,
      `Expected the walker to detect @react-native-async-storage/async-storage imported by local-storage-react.ts via rn-entry.ts, found violations: ${formatViolations(violations)}`
    ).to.equal(true)
    expect(
      hasBuffer,
      `Expected the walker to detect buffer imported by association/key-provider.ts via rn-entry.ts, found violations: ${formatViolations(violations)}`
    ).to.equal(true)
  })

  it("D-02-a: no file under src/ imports bare 'crypto'", () => {
    // Scope this to bare 'crypto' only: src/association/verifiers/key-attestation.ts
    // legitimately imports 'node:crypto' (device-side, barrel-excluded) — asserting
    // against 'node:crypto' tree-wide would be a false failure.
    const offenders: string[] = []

    function walkDir (dir: string): string[] {
      const out: string[] = []
      for (const entry of readdirSync(dir)) {
        const abs = join(dir, entry)
        const st = statSync(abs)
        if (st.isDirectory()) {
          out.push(...walkDir(abs))
        } else if (entry.endsWith('.ts')) {
          out.push(abs)
        }
      }
      return out
    }

    const allFiles = walkDir(SRC_DIR)
    for (const file of allFiles) {
      const stripped = stripComments(readFileSync(file, 'utf8'))
      const specifiers = extractSpecifiers(stripped)
      if (specifiers.includes('crypto')) {
        offenders.push(file.startsWith(SRC_DIR) ? file.slice(SRC_DIR.length + 1) : file)
      }
    }

    expect(
      offenders.length,
      `Expected zero files under src/ to import bare 'crypto', found: ${offenders.join(', ')}`
    ).to.equal(0)
  })

  it('D-02-b (positive control): networks-engine.ts still calls crypto.randomUUID() at both surviving call sites', () => {
    const file = join(SRC_DIR, 'networks', 'networks-engine.ts')
    const stripped = stripComments(readFileSync(file, 'utf8'))
    const matches = stripped.match(/crypto\.randomUUID\(\)/g) ?? []
    expect(
      matches.length,
      `Expected exactly 2 occurrences of crypto.randomUUID() in networks-engine.ts, found ${matches.length} — the D-02 crypto-import deletion must remove only the dead import, not a call site`
    ).to.equal(2)
  })
})

// ---------------------------------------------------------------------------
// Phase 66 (C-1): the pairing exports
// ---------------------------------------------------------------------------

interface PairingExportSets { values: string[], types: string[] }

const uniqSortedNames = (xs: string[]): string[] => [...new Set(xs)].sort()

/** Names in `export {..}` / `export type {..}` lists, optionally only those from one specifier. */
function namedExportsByKind (stripped: string, fromSpecifier?: (spec: string) => boolean): PairingExportSets {
  const values: string[] = []
  const types: string[] = []
  for (const match of stripped.matchAll(/export\s+(type\s+)?\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/g)) {
    if (fromSpecifier !== undefined && (match[3] === undefined || !fromSpecifier(match[3]))) continue
    for (const part of match[2]!.split(',')) {
      let name = part.trim()
      if (name === '') continue
      let isType = match[1] !== undefined
      if (/^type\s+/.test(name)) { isType = true; name = name.replace(/^type\s+/, '') }
      const asMatch = /\bas\s+([A-Za-z0-9_$]+)$/.exec(name)
      if (asMatch !== null) name = asMatch[1]!
      ;(isType ? types : values).push(name)
    }
  }
  return { values: uniqSortedNames(values), types: uniqSortedNames(types) }
}

/** Every declared export of a module source (comment-stripped): declarations plus export lists. */
function moduleDeclaredExports (stripped: string): PairingExportSets {
  if (/export\s*\*/.test(stripped)) throw new Error('export-star found in module')
  const values: string[] = []
  const types: string[] = []
  for (const m of stripped.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)/gm)) values.push(m[1]!)
  for (const m of stripped.matchAll(/^export\s+(?:declare\s+)?(?:const|let|var|class|enum)\s+([A-Za-z0-9_$]+)/gm)) values.push(m[1]!)
  for (const m of stripped.matchAll(/^export\s+(?:declare\s+)?interface\s+([A-Za-z0-9_$]+)/gm)) types.push(m[1]!)
  for (const m of stripped.matchAll(/^export\s+(?:declare\s+)?type\s+([A-Za-z0-9_$]+)/gm)) types.push(m[1]!)
  const lists = namedExportsByKind(stripped)
  return { values: uniqSortedNames([...values, ...lists.values]), types: uniqSortedNames([...types, ...lists.types]) }
}

/** Every from-specifier on an `export ... from` line. */
function exportFromSpecifiers (stripped: string): string[] {
  return [...stripped.matchAll(/export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!)
}

// The owner-phone modules, spelled from fragments so this spec's own text never names a path the
// scans below look for.
const PAIR_WIRE_FILE = ['pair', 'wire.ts'].join('-')
const PAIR_MINT_SERVICE_FILE = ['pair', 'mint', 'service.ts'].join('-')
const PAIRING_MODULE_FILES = ['pairing-code.ts', 'pairing-statement.ts', PAIR_WIRE_FILE, PAIR_MINT_SERVICE_FILE, 'pairing-revocation.ts']
const PAIRING_DIR = join(SRC_DIR, 'pairing')

/** The pinned browser value names from './pairing/*' (C-1 plus PAIRING_CODE_MAX_CHARS / PAIRING_QR_BYTE_BUDGET for 66-22). */
const BROWSER_PAIRING_VALUES = [
  'PAIRING_CODE_PREFIX',
  'PAIRING_CODE_MAX_CHARS',
  'PAIRING_QR_BYTE_BUDGET',
  'decodePairingCode',
  'PairingCodeError',
  'PAIRING_DIGEST_TAG',
  'PAIRING_REMOVE_DIGEST_TAG',
  'verifyPairingStatement',
  'PAIRING_REVOKE_DIGEST_TAG',
  'isPairingRevoked'
]
const BROWSER_PAIRING_TYPES = [
  'PairingStatement',
  'DecodedPairingCode',
  'PairingCodeFailure',
  'VerifiablePairingStatement',
  'PairingVerifyFailure',
  'PairingVerifyResult'
]
/** Owner-side, minting and signing names the browser must never carry. */
const BROWSER_PAIRING_FORBIDDEN = [
  ['encode', 'PairingCode'].join(''),
  ['verify', 'PairingRemove'].join(''),
  ['isCurrent', 'PairingOfficer'].join(''),
  ['pairing', 'StatementDigest'].join(''),
  ['pairing', 'RemoveDigest'].join(''),
  ['pairing', 'RevokeDigest'].join(''),
  ['revoke', 'DashboardPairing'].join(''),
  ['Pairing', 'RevocationError'].join(''),
  ['Pairing', 'RevocationSigner'].join('')
]

function readStripped (absPath: string): string {
  return stripComments(readFileSync(absPath, 'utf8'))
}

function pairingModuleUnion (): PairingExportSets {
  const values: string[] = []
  const types: string[] = []
  for (const f of PAIRING_MODULE_FILES) {
    const d = moduleDeclaredExports(readStripped(join(PAIRING_DIR, f)))
    values.push(...d.values)
    types.push(...d.types)
  }
  return { values: uniqSortedNames(values), types: uniqSortedNames(types) }
}

/** BROWSER-PAIRING-c checker over a stripped browser-entry source. */
function browserPairingProblems (browser: string): string[] {
  const problems: string[] = []
  const got = namedExportsByKind(browser, (spec) => spec.startsWith('./pairing/'))
  if (JSON.stringify(got.values) !== JSON.stringify(uniqSortedNames(BROWSER_PAIRING_VALUES))) problems.push(`values differ: ${got.values.join(',')}`)
  if (JSON.stringify(got.types) !== JSON.stringify(uniqSortedNames(BROWSER_PAIRING_TYPES))) problems.push(`types differ: ${got.types.join(',')}`)
  for (const spec of exportFromSpecifiers(browser)) {
    if (spec === './pairing/index.js' || spec.endsWith(PAIR_WIRE_FILE.replace(/\.ts$/, '.js')) || spec.endsWith(PAIR_MINT_SERVICE_FILE.replace(/\.ts$/, '.js'))) {
      problems.push(`bad specifier ${spec}`)
    }
  }
  const all = namedExportsByKind(browser)
  for (const name of [...all.values, ...all.types]) if (BROWSER_PAIRING_FORBIDDEN.includes(name)) problems.push(`owner-side name ${name}`)
  return problems
}

/** PAIRING-BARREL-a checker over a stripped barrel source. */
function pairingBarrelProblems (barrel: string, union: PairingExportSets): string[] {
  const problems: string[] = []
  if (/export\s*\*/.test(barrel)) problems.push('export-star in barrel')
  for (const spec of exportFromSpecifiers(barrel)) {
    const m = /^\.\/([A-Za-z0-9_-]+)\.js$/.exec(spec)
    if (m === null || !PAIRING_MODULE_FILES.includes(`${m[1]}.ts`)) problems.push(`bad from-specifier ${spec}`)
  }
  const got = namedExportsByKind(barrel)
  if (JSON.stringify(got.values) !== JSON.stringify(union.values)) problems.push(`values ${got.values.join(',')} != ${union.values.join(',')}`)
  if (JSON.stringify(got.types) !== JSON.stringify(union.types)) problems.push(`types ${got.types.join(',')} != ${union.types.join(',')}`)
  return problems
}

describe('browser-entry pairing exports (Phase 66, C-1)', () => {
  const browserEntryPath = join(SRC_DIR, 'browser-entry.ts')
  const rnEntryPath = join(SRC_DIR, 'rn-entry.ts')
  const rel = (abs: string): string => abs.slice(SRC_DIR.length + 1)

  it('BROWSER-PAIRING-a: the ./browser graph reaches the pairing code, statement, revocation and join-code modules, and neither owner-phone module', () => {
    const reached = new Set(collectGraph(browserEntryPath).files.map(rel))
    for (const f of ['pairing/pairing-code.ts', 'pairing/pairing-statement.ts', 'pairing/pairing-revocation.ts', 'networks/join-code.ts']) {
      expect(reached.has(f), `browser-entry.ts must reach ${f}`).to.equal(true)
    }
    for (const f of [`pairing/${PAIR_WIRE_FILE}`, `pairing/${PAIR_MINT_SERVICE_FILE}`]) {
      expect(reached.has(f), `browser-entry.ts must NOT reach ${f}`).to.equal(false)
    }
  })

  it('BROWSER-PAIRING-b (positive control): the same walker from rn-entry.ts reaches both owner-phone modules', () => {
    const reached = new Set(collectGraph(rnEntryPath).files.map(rel))
    expect(reached.has(`pairing/${PAIR_WIRE_FILE}`)).to.equal(true)
    expect(reached.has(`pairing/${PAIR_MINT_SERVICE_FILE}`)).to.equal(true)
  })

  it("BROWSER-PAIRING-c: browser-entry's './pairing/*' names equal the pinned decode/verify set, with no owner-side name", () => {
    expect(browserPairingProblems(readStripped(browserEntryPath))).to.deep.equal([])
  })

  it('BROWSER-PAIRING-c (positive control): the checker flags a planted encoder, a barrel import and an owner-side name', () => {
    const base = readStripped(browserEntryPath)
    const plantedEncoder = `${base}\nexport { ${BROWSER_PAIRING_FORBIDDEN[0]} } from './pairing/pairing-code.js'\n`
    expect(browserPairingProblems(plantedEncoder).join(';')).to.match(/values differ/)
    const plantedBarrel = `${base}\nexport { attachPairMint } from './pairing/index.js'\n`
    expect(browserPairingProblems(plantedBarrel).join(';')).to.match(/bad specifier/)
    const plantedOwner = `${base}\nexport { ${BROWSER_PAIRING_FORBIDDEN[6]} } from './somewhere-else.js'\n`
    expect(browserPairingProblems(plantedOwner).join(';')).to.match(/owner-side name/)
  })

  it('PAIRING-BARREL-a: src/pairing/index.ts has no export-star and names exactly the five modules\' exports', () => {
    const union = pairingModuleUnion()
    expect(union.values.length, 'the module scan must find values').to.be.greaterThan(20)
    expect(union.types.length, 'the module scan must find types').to.be.greaterThan(10)
    expect(pairingBarrelProblems(readStripped(join(PAIRING_DIR, 'index.ts')), union)).to.deep.equal([])
  })

  it('PAIRING-BARREL-a (positive control): the checker flags an export-star and a missing name', () => {
    const union = pairingModuleUnion()
    const barrel = readStripped(join(PAIRING_DIR, 'index.ts'))
    expect(pairingBarrelProblems(`${barrel}\nexport * from './pairing-code.js'\n`, union).join(';')).to.match(/export-star/)
    expect(pairingBarrelProblems(barrel.replace('isPairingRevoked,', ''), union).join(';')).to.match(/values/)
  })

  it("PAIRING-RN-a: rn-entry re-exports exactly the barrel's names from './pairing/index.js', and none from another specifier", () => {
    const rn = readStripped(rnEntryPath)
    const barrel = namedExportsByKind(readStripped(join(PAIRING_DIR, 'index.ts')))
    const got = namedExportsByKind(rn, (spec) => spec === './pairing/index.js')
    expect(got).to.deep.equal(barrel)
    expect(exportFromSpecifiers(rn).filter((spec) => spec.startsWith('./pairing/') && spec !== './pairing/index.js')).to.deep.equal([])
    expect(/export\s*\*\s*from\s*['"]\.\/pairing/.test(rn)).to.equal(false)
    const all = new Set([...barrel.values, ...barrel.types])
    const clashes: string[] = []
    for (const spec of new Set(exportFromSpecifiers(rn))) {
      if (spec === './pairing/index.js') continue
      const n = namedExportsByKind(rn, (s) => s === spec)
      for (const name of [...n.values, ...n.types]) if (all.has(name)) clashes.push(`${name} from ${spec}`)
    }
    expect(clashes, clashes.join('; ')).to.deep.equal([])
  })
})
