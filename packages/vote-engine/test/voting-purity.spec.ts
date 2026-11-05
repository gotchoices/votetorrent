/**
 * voting-purity.spec.ts — Phase 63 Plan 03 (D-23, D-28; R-6)
 *
 * Gates for `src/voting/*`, adapted from crypto-purity.spec.ts:
 *   VP-0 — the scan covers the whole directory (guards a vacuous pass).
 *   P-1  — import allowlist (five bare specifiers + relative ./x.js only).
 *   P-2  — no node specifier, console member access, text decoder or byte-buffer identifier.
 *   P-3  — barrel contract: voting/index.ts, rn-entry.ts and index.ts match the name list;
 *          browser-entry.ts carries nothing voting-related (R-6).
 *   P-4  — runtime surface of the barrel.
 *   P-5  — positive controls proving each scanner can fire.
 */

import { expect } from 'chai'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as voting from '../src/voting/index.js'

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const VOTING_DIR = join(SRC_DIR, 'voting')

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

const bufferIdentifier = ['B', 'uffer'].join('')

function scanTokens (stripped: string): string[] {
  const hits: string[] = []
  if (/node:/.test(stripped)) hits.push('node:')
  if (/console\./.test(stripped)) hits.push('console.')
  if (/TextDecoder/.test(stripped)) hits.push('TextDecoder')
  if (new RegExp(`\\b${bufferIdentifier}\\b`).test(stripped)) hits.push(bufferIdentifier)
  return hits
}

function votingSourceFiles (): string[] {
  return readdirSync(VOTING_DIR).filter((f) => f.endsWith('.ts')).sort()
}

function readVoting (name: string): string {
  return stripComments(readFileSync(join(VOTING_DIR, name), 'utf8'))
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
  '@noble/curves/utils.js'
]

const CONTRACT_VALUES = [
  'VOTE_ENTRY_KEYS', 'VOTER_ENTRY_KEYS', 'ballotTemplateDigest', 'makeVoteNonce', 'buildVoteEntry',
  'voterEntryDigest', 'canonicalJson', 'sortByCanonicalBytes', 'p256KeyToCompressedHex', 'checkVotingKey'
]
const CONTRACT_TYPES = ['VoteAnswer', 'VoteEntry', 'VoterEntryUnsigned', 'VoterEntry', 'TemplateBallot', 'VotingKeyCheck']
const CONTRACT_UNION = [...CONTRACT_VALUES, ...CONTRACT_TYPES].sort()

describe('voting-purity (63-03: D-23, D-28; R-6)', () => {
  it('VP-0 the scan covers every voting source file', () => {
    const files = votingSourceFiles()
    for (const f of ['canonical.ts', 'index.ts', 'vote-entries.ts', 'vote-signing.ts']) {
      expect(files, `missing ${f}`).to.include(f)
    }
  })

  it('P-1a every bare specifier in src/voting is allowlisted', () => {
    const violations: string[] = []
    for (const f of votingSourceFiles()) {
      for (const s of extractFromSpecifiers(readVoting(f))) {
        if (s.startsWith('.')) continue
        if (!ALLOWED_BARE_SPECIFIERS.includes(s)) violations.push(`${f}: ${s}`)
      }
    }
    expect(violations, violations.join('; ')).to.deep.equal([])
  })

  it('P-1b no voting file imports a ../ specifier', () => {
    const violations = votingSourceFiles().filter((f) => /from\s*['"]\.\.\//.test(readVoting(f)))
    expect(violations).to.deep.equal([])
  })

  it('P-2 no forbidden token in comment-stripped src/voting', () => {
    const violations: string[] = []
    for (const f of votingSourceFiles()) {
      for (const t of scanTokens(readVoting(f))) violations.push(`${f}: ${t}`)
    }
    expect(violations, violations.join('; ')).to.deep.equal([])
  })

  it('P-3a voting/index.ts has no export-star and exactly the contract names', () => {
    const stripped = readVoting('index.ts')
    expect(/export\s*\*/.test(stripped)).to.equal(false)
    expect(parseNamedExports(stripped)).to.deep.equal(CONTRACT_UNION)
  })

  it('P-3b rn-entry.ts re-exports exactly the contract names from the voting barrel', () => {
    const stripped = stripComments(readFileSync(join(SRC_DIR, 'rn-entry.ts'), 'utf8'))
    expect(parseNamedExports(stripped, './voting/index.js')).to.deep.equal(CONTRACT_UNION)
    expect(stripped.includes("export * from './voting")).to.equal(false)
  })

  it('P-3c index.ts carries exactly one export-star of the voting barrel', () => {
    const stripped = stripComments(readFileSync(join(SRC_DIR, 'index.ts'), 'utf8'))
    expect(stripped.split("export * from './voting/index.js'").length - 1).to.equal(1)
  })

  it('P-3d (R-6) browser-entry.ts carries no voting text and no nist curves import', () => {
    const stripped = stripComments(readFileSync(join(SRC_DIR, 'browser-entry.ts'), 'utf8'))
    expect(stripped.includes('voting')).to.equal(false)
    expect(stripped.includes('@noble/curves/nist.js')).to.equal(false)
  })

  it('P-4 runtime surface equals the contract values', () => {
    const v = voting as unknown as Record<string, unknown>
    expect(Object.keys(v).sort()).to.deep.equal([...CONTRACT_VALUES].sort())
    for (const n of CONTRACT_VALUES.filter((x) => !x.endsWith('_KEYS'))) {
      expect(typeof v[n], n).to.equal('function')
    }
    expect(voting.VOTE_ENTRY_KEYS.length).to.equal(7)
    expect(voting.VOTER_ENTRY_KEYS.length).to.equal(10)
  })

  describe('P-5 positive controls', () => {
    it('the specifier extractor reports node and vote-core imports, neither allowlisted', () => {
      const specs = extractFromSpecifiers(stripComments(
        "import { x } from 'node:crypto'\nimport { y } from '@votetorrent/vote-core'\n"
      ))
      expect(specs).to.include.members(['node:crypto', '@votetorrent/vote-core'])
      expect(ALLOWED_BARE_SPECIFIERS.includes('node:crypto')).to.equal(false)
      expect(ALLOWED_BARE_SPECIFIERS.includes('@votetorrent/vote-core')).to.equal(false)
    })

    it('the token scan fires on code and stays silent inside both comment styles', () => {
      const lines = `console.log('x')\nconst b = new ${bufferIdentifier}()\n`
      expect(scanTokens(stripComments(lines))).to.include.members(['console.', bufferIdentifier])
      expect(scanTokens(stripComments(lines.split('\n').map((l) => `// ${l}`).join('\n')))).to.deep.equal([])
      expect(scanTokens(stripComments(`/* ${lines} */`))).to.deep.equal([])
    })

    it('parseNamedExports on a barrel missing a name does not equal the contract', () => {
      const synthetic = "export { canonicalJson } from './canonical.js'\n"
      expect(parseNamedExports(synthetic)).to.not.deep.equal(CONTRACT_UNION)
    })
  })
})
