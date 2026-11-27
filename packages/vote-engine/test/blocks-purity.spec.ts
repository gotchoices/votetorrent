/**
 * blocks-purity.spec.ts — Phase 65 Plan 05 (D-50..D-52; R5-R8 purity)
 *
 * Gates for `src/blocks/*`, cloned from voting-purity.spec.ts:
 *   VP-0 — the scan list is built from readdir (so files 65-06/07/08 add later are scanned
 *          automatically) and is not vacuous.
 *   P-1a — every bare specifier is allowlisted (voting's five plus @votetorrent/vote-core, which P-1c
 *          restricts to type imports). The list is wide enough for the R6-R8 modules that land here, so
 *          those plans do not need to edit this spec.
 *   P-1b — every relative specifier is ./<name>.js resolving to an existing src/blocks file, or one of
 *          ALLOWED_RELATIVE (all already in the rn-entry graph, Hermes-proven).
 *   P-1c — @votetorrent/vote-core appears only in `import type`.
 *   P-1d — D-52 browser readiness: block-tree.ts reaches only the browser allowlist.
 *   P-2  — no forbidden token (node:, console., TextDecoder, TextEncoder, Date.now, Math.random, the
 *          byte-buffer identifier) in comment-stripped src/blocks.
 *   P-3a — blocks/index.ts has no export-star, and per module its `export {}` / `export type {}` lines
 *          equal that module's declared value / type exports. The expected names are DERIVED from the
 *          module sources (readdir + declared-export parsing), so a later module or export flows through
 *          and cannot drift silently. A from-specifier other than ./<module>.js is refused.
 *   P-3a-floor — non-vacuity: the derived sets contain the known R5-R8 modules and names.
 *   P-3b — (D-61) rn-entry re-exports exactly the barrel's value and type names, by name, from
 *          './blocks/index.js'; never an export-star of the blocks folder.
 *   P-3c — src/index.ts carries exactly one export-star of the blocks barrel.
 *   P-3d — (D-52) browser-entry exposes exactly block-tree.ts's names from './blocks/block-tree.js' and
 *          nothing from the R6-R8 modules or the barrel. BROWSER_EXPOSES_R5 records the D-52 outcome.
 *   P-3e — no barrel name is also re-exported by rn-entry from another specifier (an ESM load-time clash).
 *   P-4  — runtime surface of the barrel equals the derived value union.
 *   P-5  — positive controls proving each scanner and checker can fire.
 */

import { expect } from 'chai'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as blocks from '../src/blocks/index.js'

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const BLOCKS_DIR = join(SRC_DIR, 'blocks')

function stripComments (src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

function extractFromSpecifiers (strippedSrc: string): string[] {
  const specifiers: string[] = []
  for (const match of strippedSrc.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
    specifiers.push(match[1]!)
  }
  return specifiers
}

// Built with a join so this spec cannot trip its own scanner.
const bufferIdentifier = ['B', 'uffer'].join('')

function scanTokens (stripped: string): string[] {
  const hits: string[] = []
  if (/node:/.test(stripped)) hits.push('node:')
  if (/console\./.test(stripped)) hits.push('console.')
  if (/TextDecoder/.test(stripped)) hits.push('TextDecoder')
  if (/TextEncoder/.test(stripped)) hits.push('TextEncoder')
  if (/Date\.now/.test(stripped)) hits.push('Date.now')
  if (/Math\.random/.test(stripped)) hits.push('Math.random')
  if (new RegExp(`\\b${bufferIdentifier}\\b`).test(stripped)) hits.push(bufferIdentifier)
  return hits
}

function blocksSourceFiles (): string[] {
  return readdirSync(BLOCKS_DIR).filter((f) => f.endsWith('.ts')).sort()
}

function readBlocks (name: string): string {
  return stripComments(readFileSync(join(BLOCKS_DIR, name), 'utf8'))
}

/** Collect identifiers inside `export {...}` / `export type {...}` braces, optionally for one `from`. */
function parseNamedExports (stripped: string, fromSpecifier?: string): string[] {
  const names: string[] = []
  for (const match of stripped.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    if (fromSpecifier !== undefined && match[2] !== fromSpecifier) continue
    for (const part of match[1]!.split(',')) {
      const name = part.trim()
      if (name !== '') names.push(name)
    }
  }
  return names.sort()
}

const ALLOWED_BARE_SPECIFIERS = [
  '@optimystic/quereus-plugin-crypto',
  '@noble/hashes/sha2.js',
  '@noble/hashes/utils.js',
  '@noble/curves/nist.js',
  '@noble/curves/utils.js',
  // Restricted to `import type` by P-1c.
  '@votetorrent/vote-core'
]

// Already in the rn-entry graph (Hermes-proven). What each serves for R6-R8:
//   ../voting/canonical.js        canonicalJson, sortByCanonicalBytes
//   ../voting/vote-entries.js     voterEntryDigest, ballotTemplateDigest
//   ../voting/index.js            the voting barrel (same names)
//   ../pool/pool-block.js         poolBlockId, poolBlockCid, consentDigest
//   ../key-release/election-block.js  openElectionBlock, openVoteEntries
//   ../database/initialize.js     verifySigP256
//   ../crypto/index.js            serializeBlockCiphertext
const ALLOWED_RELATIVE = [
  '../voting/canonical.js',
  '../voting/vote-entries.js',
  '../voting/index.js',
  '../pool/pool-block.js',
  '../key-release/election-block.js',
  '../database/initialize.js',
  '../crypto/index.js'
]

/** Returns the relative specifiers that are neither a sibling ./<name>.js that exists nor allowlisted. */
function badRelativeSpecifiers (specifiers: string[], siblingExists: (name: string) => boolean): string[] {
  return specifiers.filter((s) => {
    if (!s.startsWith('.')) return false
    if (ALLOWED_RELATIVE.includes(s)) return false
    const sibling = /^\.\/([A-Za-z0-9_-]+)\.js$/.exec(s)
    return !(sibling !== null && siblingExists(sibling[1]!))
  })
}

/** Value (non-`import type`) imports of vote-core. */
function voteCoreValueImports (stripped: string): string[] {
  const hits: string[] = []
  for (const match of stripped.matchAll(/import\s+(type\s+)?([^'";]*?)\s*from\s*['"]@votetorrent\/vote-core['"]/g)) {
    if (match[1] === undefined) hits.push(match[0])
  }
  return hits
}

// T-65-05-03: block-tree authenticates rows that share a Cid (consent digest + P-256 verify, the template digest),
// so it reaches the crypto plugin (the very digestFields and verify that pool-block's consentDigest and
// verifySigP256 call; already on browser-entry's allowlist through database/initialize.ts) and
// ../voting/vote-entries.js (ballotTemplateDigest; itself only the plugin and noble hashes, pinned below).
// browser-entry-purity's set-equality allowlist is unchanged by this.
const BLOCK_TREE_ALLOWED = [
  '@noble/hashes/sha2.js', '@noble/hashes/utils.js', '@optimystic/quereus-plugin-crypto',
  '../voting/canonical.js', '../voting/vote-entries.js'
]
const CANONICAL_ALLOWED = ['@noble/hashes/utils.js']
const VOTE_ENTRIES_ALLOWED = ['@optimystic/quereus-plugin-crypto', '@noble/hashes/sha2.js', '@noble/hashes/utils.js', '@votetorrent/vote-core']

const R5_VALUES = [
  'BLOCK_TREE_DOMAIN', 'BLOCK_TREE_EMPTY_ROOT', 'blockLeafData', 'blockLeafHash', 'blockNodeHash',
  'buildBlockTree', 'verifyInclusion', 'blockTreeStatus', 'finalBlockTree'
]

// D-52 outcome: true when browser-entry carries the R5 block tree from './blocks/block-tree.js'.
const BROWSER_EXPOSES_R5 = true

interface ExportSets { values: string[], types: string[] }

const uniqSorted = (xs: string[]): string[] => [...new Set(xs)].sort()

/** Names listed in `export {..}` / `export type {..}` braces (optionally only for one from-specifier). */
function parseNamedExportsByKind (stripped: string, fromSpecifier?: string): ExportSets {
  const values: string[] = []
  const types: string[] = []
  for (const match of stripped.matchAll(/export\s+(type\s+)?\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/g)) {
    if (fromSpecifier !== undefined && match[3] !== fromSpecifier) continue
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
  return { values: uniqSorted(values), types: uniqSorted(types) }
}

/** Every declared export of a module source (comment-stripped): declarations plus export lists. */
function declaredExports (stripped: string): ExportSets {
  if (/export\s*\*/.test(stripped)) throw new Error('export-star found in module')
  if (/export\s+default\b/.test(stripped)) throw new Error('export default found in module')
  const values: string[] = []
  const types: string[] = []
  for (const m of stripped.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)/gm)) values.push(m[1]!)
  for (const m of stripped.matchAll(/^export\s+(?:declare\s+)?(?:const|let|var|class|enum)\s+([A-Za-z0-9_$]+)/gm)) values.push(m[1]!)
  for (const m of stripped.matchAll(/^export\s+(?:declare\s+)?interface\s+([A-Za-z0-9_$]+)/gm)) types.push(m[1]!)
  for (const m of stripped.matchAll(/^export\s+(?:declare\s+)?type\s+([A-Za-z0-9_$]+)/gm)) types.push(m[1]!)
  const lists = parseNamedExportsByKind(stripped)
  return { values: uniqSorted([...values, ...lists.values]), types: uniqSorted([...types, ...lists.types]) }
}

/** Every from-specifier on an `export ... from` line. */
function fromSpecifiers (stripped: string): string[] {
  return [...stripped.matchAll(/export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!)
}

function blockModules (): string[] {
  return blocksSourceFiles().filter((f) => f !== 'index.ts')
}

function derivedSets (): ExportSets {
  const values: string[] = []
  const types: string[] = []
  for (const f of blockModules()) {
    const d = declaredExports(readBlocks(f))
    values.push(...d.values)
    types.push(...d.types)
  }
  return { values: uniqSorted(values), types: uniqSorted(types) }
}

/** P-3a comparator: returns problems with a barrel source against the module sources. */
function barrelProblems (barrel: string, modules: Record<string, string>): string[] {
  const problems: string[] = []
  if (/export\s*\*/.test(barrel)) problems.push('export-star in barrel')
  const names = Object.keys(modules)
  for (const spec of fromSpecifiers(barrel)) {
    const m = /^\.\/([A-Za-z0-9_-]+)\.js$/.exec(spec)
    if (m === null || !names.includes(`${m[1]}.ts`)) problems.push(`bad from-specifier ${spec}`)
  }
  for (const f of names) {
    const want = declaredExports(modules[f]!)
    const got = parseNamedExportsByKind(barrel, `./${f.replace(/\.ts$/, '.js')}`)
    if (JSON.stringify(got.values) !== JSON.stringify(want.values)) problems.push(`${f}: values ${got.values.join(',')} != ${want.values.join(',')}`)
    if (JSON.stringify(got.types) !== JSON.stringify(want.types)) problems.push(`${f}: types ${got.types.join(',')} != ${want.types.join(',')}`)
  }
  return problems
}

/** P-3b checker: rn-entry vs the barrel's names. */
function rnEntryProblems (rn: string, want: ExportSets): string[] {
  const problems: string[] = []
  if (/export\s*\*\s*from\s*['"]\.\/blocks/.test(rn)) problems.push('export-star of blocks')
  for (const spec of fromSpecifiers(rn)) {
    if (spec.startsWith('./blocks/') && spec !== './blocks/index.js') problems.push(`bad blocks specifier ${spec}`)
  }
  const got = parseNamedExportsByKind(rn, './blocks/index.js')
  if (JSON.stringify(got.values) !== JSON.stringify(want.values)) problems.push(`values differ: ${got.values.join(',')}`)
  if (JSON.stringify(got.types) !== JSON.stringify(want.types)) problems.push(`types differ: ${got.types.join(',')}`)
  return problems
}

const R6_R8_TEXT = ['./blocks/index.js', 'slice-checks', 'open-committed-block', 'validate-blocks', 'answer-checks', 'tally-tree']

/** P-3d checker: browser-entry vs block-tree's names. */
function browserEntryProblems (browser: string, tree: ExportSets, exposesR5: boolean): string[] {
  const problems: string[] = []
  for (const t of R6_R8_TEXT) if (browser.includes(t)) problems.push(`names ${t}`)
  if (exposesR5) {
    const got = parseNamedExportsByKind(browser, './blocks/block-tree.js')
    if (JSON.stringify(got.values) !== JSON.stringify(tree.values)) problems.push(`values differ: ${got.values.join(',')}`)
    if (JSON.stringify(got.types) !== JSON.stringify(tree.types)) problems.push(`types differ: ${got.types.join(',')}`)
  } else if (browser.includes('./blocks/')) {
    problems.push('names ./blocks/')
  }
  return problems
}

describe('blocks-purity (65-05: D-50..D-52)', () => {
  it('VP-0 the scan covers every blocks source file and none is empty', () => {
    const files = blocksSourceFiles()
    for (const f of ['block-tree.ts', 'index.ts']) expect(files, `missing ${f}`).to.include(f)
    for (const f of files) expect(readBlocks(f).trim().length, `${f} is empty`).to.be.greaterThan(0)
  })

  it('P-1a every bare specifier in src/blocks is allowlisted', () => {
    const violations: string[] = []
    for (const f of blocksSourceFiles()) {
      for (const s of extractFromSpecifiers(readBlocks(f))) {
        if (s.startsWith('.')) continue
        if (!ALLOWED_BARE_SPECIFIERS.includes(s)) violations.push(`${f}: ${s}`)
      }
    }
    expect(violations, violations.join('; ')).to.deep.equal([])
  })

  it('P-1b every relative specifier is a sibling or allowlisted', () => {
    const violations: string[] = []
    for (const f of blocksSourceFiles()) {
      for (const s of badRelativeSpecifiers(extractFromSpecifiers(readBlocks(f)), (n) => existsSync(join(BLOCKS_DIR, `${n}.ts`)))) {
        violations.push(`${f}: ${s}`)
      }
    }
    expect(violations, violations.join('; ')).to.deep.equal([])
  })

  it('P-1c @votetorrent/vote-core appears only in import type', () => {
    const violations: string[] = []
    for (const f of blocksSourceFiles()) {
      for (const hit of voteCoreValueImports(readBlocks(f))) violations.push(`${f}: ${hit}`)
    }
    expect(violations, violations.join('; ')).to.deep.equal([])
  })

  it('P-1d (D-52) block-tree.ts reaches only the browser-entry allowlist', () => {
    const tree = extractFromSpecifiers(readBlocks('block-tree.ts'))
    expect(tree.filter((s) => !BLOCK_TREE_ALLOWED.includes(s))).to.deep.equal([])
    const canonical = extractFromSpecifiers(stripComments(readFileSync(join(SRC_DIR, 'voting', 'canonical.ts'), 'utf8')))
    expect(canonical.filter((s) => !CANONICAL_ALLOWED.includes(s))).to.deep.equal([])
    const voteEntriesSrc = stripComments(readFileSync(join(SRC_DIR, 'voting', 'vote-entries.ts'), 'utf8'))
    expect(extractFromSpecifiers(voteEntriesSrc).filter((s) => !VOTE_ENTRIES_ALLOWED.includes(s))).to.deep.equal([])
    expect(voteCoreValueImports(voteEntriesSrc)).to.deep.equal([])
  })

  it('P-2 no forbidden token in comment-stripped src/blocks', () => {
    const violations: string[] = []
    for (const f of blocksSourceFiles()) {
      for (const t of scanTokens(readBlocks(f))) violations.push(`${f}: ${t}`)
    }
    expect(violations, violations.join('; ')).to.deep.equal([])
  })

  it('P-3a every barrel export line equals its module\'s declared exports (derived)', () => {
    const modules: Record<string, string> = {}
    for (const f of blockModules()) modules[f] = readBlocks(f)
    expect(barrelProblems(readBlocks('index.ts'), modules)).to.deep.equal([])
  })

  it('P-3a-floor the derived sets are not vacuous', () => {
    const mods = blockModules()
    for (const f of ['block-tree.ts', 'open-committed-block.ts', 'slice-checks.ts', 'answer-checks.ts', 'validate-blocks.ts', 'tally-tree.ts']) {
      expect(mods, `missing ${f}`).to.include(f)
    }
    const d = derivedSets()
    expect(d.values).to.include.members([...R5_VALUES, 'checkElectionSecret', 'openCommittedBlock', 'sliceChecks', 'validateVoteEntryAgainstBallot', 'validateElectionBlocks'])
    expect(declaredExports(readBlocks('tally-tree.ts')).values.length).to.be.greaterThan(0)
    expect(d.types.length).to.be.greaterThan(14)
  })

  it('P-3b (D-61) rn-entry re-exports exactly the barrel names from ./blocks/index.js', () => {
    const rn = stripComments(readFileSync(join(SRC_DIR, 'rn-entry.ts'), 'utf8'))
    expect(rnEntryProblems(rn, derivedSets())).to.deep.equal([])
  })

  it('P-3c index.ts carries exactly one export-star of the blocks barrel', () => {
    const stripped = stripComments(readFileSync(join(SRC_DIR, 'index.ts'), 'utf8'))
    expect(stripped.split("export * from './blocks/index.js'").length - 1).to.equal(1)
  })

  it('P-3d (D-52) browser-entry carries only block-tree.ts names, from the module file', () => {
    const browser = stripComments(readFileSync(join(SRC_DIR, 'browser-entry.ts'), 'utf8'))
    const tree = declaredExports(readBlocks('block-tree.ts'))
    expect(browserEntryProblems(browser, tree, BROWSER_EXPOSES_R5)).to.deep.equal([])
  })

  it('P-3e no barrel name is re-exported by rn-entry from another specifier', () => {
    const rn = stripComments(readFileSync(join(SRC_DIR, 'rn-entry.ts'), 'utf8'))
    const d = derivedSets()
    const all = new Set([...d.values, ...d.types])
    const clashes: string[] = []
    for (const spec of new Set(fromSpecifiers(rn))) {
      if (spec === './blocks/index.js') continue
      const n = parseNamedExportsByKind(rn, spec)
      for (const name of [...n.values, ...n.types]) if (all.has(name)) clashes.push(`${name} from ${spec}`)
    }
    expect(clashes, clashes.join('; ')).to.deep.equal([])
  })

  it('P-4 runtime surface equals the derived value union', () => {
    const b = blocks as unknown as Record<string, unknown>
    const d = derivedSets()
    expect(Object.keys(b).sort()).to.deep.equal(d.values)
    for (const f of blockModules()) {
      const src = readBlocks(f)
      for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)/gm)) {
        expect(typeof b[m[1]!], m[1]).to.equal('function')
      }
    }
    for (const n of d.values) expect(b[n], n).to.not.equal(undefined)
    expect(blocks.BLOCK_TREE_DOMAIN).to.equal('vt-block-tree/1')
    expect(blocks.BLOCK_TREE_EMPTY_ROOT).to.match(/^[0-9a-f]{64}$/)
  })

  describe('P-5 positive controls', () => {
    it('the specifier extractor reports node and vote-core imports; the P-1c checker flags the value import', () => {
      const src = "import { x } from 'node:crypto'\nimport { y } from '@votetorrent/vote-core'\nimport type { Z } from '@votetorrent/vote-core'\n"
      const stripped = stripComments(src)
      expect(extractFromSpecifiers(stripped)).to.include.members(['node:crypto', '@votetorrent/vote-core'])
      expect(ALLOWED_BARE_SPECIFIERS.includes('node:crypto')).to.equal(false)
      const hits = voteCoreValueImports(stripped)
      expect(hits).to.have.length(1)
      expect(hits[0]).to.contain('{ y }')
    })

    it('the token scan fires on code and stays silent inside both comment styles', () => {
      const lines = `console.log('x')\nconst b = new ${bufferIdentifier}()\nconst t = Date.now()\nconst r = Math.random()\n`
      expect(scanTokens(stripComments(lines))).to.include.members(['console.', bufferIdentifier, 'Date.now', 'Math.random'])
      expect(scanTokens(stripComments(lines.split('\n').map((l) => `// ${l}`).join('\n')))).to.deep.equal([])
      expect(scanTokens(stripComments(`/* ${lines} */`))).to.deep.equal([])
    })

    it('declaredExports reads declarations, lists, aliases and inline type modifiers; refuses star and default', () => {
      const src = [
        'export function f () {}', 'export async function g () {}', "export const C = 1", 'export class K {}', 'export enum E { A }',
        'export interface I {}', 'export type T = string', 'const a = 1', 'const x = 2', 'export { a as b, type X }',
        '// export function hidden () {}', '/* export const Hidden = 1 */'
      ].join('\n')
      const d = declaredExports(stripComments(src))
      expect(d.values).to.deep.equal(['C', 'E', 'K', 'b', 'f', 'g'])
      expect(d.types).to.deep.equal(['I', 'T', 'X'])
      expect(() => declaredExports("export * from './x.js'")).to.throw()
      expect(() => declaredExports('export default 1')).to.throw()
    })

    it('the P-3a comparator flags a barrel missing a name or naming a foreign module', () => {
      const modules = { 'm.ts': 'export function one () {}\nexport function two () {}\nexport interface Ty {}\n' }
      const good = "export { one, two } from './m.js'\nexport type { Ty } from './m.js'\n"
      expect(barrelProblems(good, modules)).to.deep.equal([])
      expect(barrelProblems("export { one } from './m.js'\nexport type { Ty } from './m.js'\n", modules)).to.not.deep.equal([])
      expect(barrelProblems(good + "export { poolThing } from '../pool/pool-block.js'\n", modules)).to.not.deep.equal([])
    })

    it('the P-3b checker flags an export-star of the blocks barrel', () => {
      const want = { values: ['a'], types: [] }
      expect(rnEntryProblems("export { a } from './blocks/index.js'\n", want)).to.deep.equal([])
      expect(rnEntryProblems("export * from './blocks/index.js'\n", want)).to.not.deep.equal([])
    })

    it('the P-3d checker flags an R6-R8 name on browser-entry', () => {
      const tree = { values: ['buildBlockTree'], types: [] }
      expect(browserEntryProblems("export { buildBlockTree } from './blocks/block-tree.js'\n", tree, true)).to.deep.equal([])
      expect(browserEntryProblems("export { sliceChecks } from './blocks/index.js'\n", tree, true)).to.not.deep.equal([])
      expect(browserEntryProblems("export { x } from './blocks/block-tree.js'\n", tree, false)).to.not.deep.equal([])
    })

    it('the P-1b checker rejects a pool-agent import and accepts a real sibling', () => {
      const exists = (n: string): boolean => n === 'block-tree'
      expect(badRelativeSpecifiers(['../pool/pool-agent.js'], exists)).to.deep.equal(['../pool/pool-agent.js'])
      expect(badRelativeSpecifiers(['./block-tree.js', '../voting/canonical.js'], exists)).to.deep.equal([])
      expect(badRelativeSpecifiers(['./missing.js'], exists)).to.deep.equal(['./missing.js'])
    })
  })
})
