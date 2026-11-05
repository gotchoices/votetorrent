/**
 * founding-bundle-guards.spec.ts — 62-16.
 *
 * Always-on structural guards (D-37, D-38, D-39), each with a positive
 * control. Mirrors `src-p2p-import-guard.spec.ts`'s walker/comment-stripping
 * pattern (62-06). Scans `src` trees only, never `test/` — this file's own
 * header may name the forbidden tokens freely.
 */

import { expect } from 'chai'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function findRepoRoot (): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'yarn.lock'))) return dir
    dir = dirname(dir)
  }
  throw new Error('founding-bundle-guards: could not locate yarn.lock walking up from the spec')
}

const REPO_ROOT = findRepoRoot()
const VOTE_ENGINE_SRC = join(REPO_ROOT, 'packages/vote-engine/src')
const VOTER_SRC = join(REPO_ROOT, 'apps/VoteTorrentVoter/src')

// ---------------------------------------------------------------------------
// Comment stripping (mirrors src-p2p-import-guard.spec.ts)
// ---------------------------------------------------------------------------

function stripComments (src: string): string {
  const noBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, '')
  return noBlockComments.replace(/\/\/.*$/gm, '')
}

// ---------------------------------------------------------------------------
// Walker — packages/*/src and apps/*/src, .ts/.tsx/.js/.mjs, skipping
// node_modules, dist and schema-sql.ts (the generated schema string embeds
// the schema's own context-variable declaration text, which is not a code
// producer).
// ---------------------------------------------------------------------------

function walkSourceFiles (dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      walkSourceFiles(full, out)
    } else if (st.isFile() && /\.(ts|tsx|js|mjs)$/.test(entry) && entry !== 'schema-sql.ts') {
      out.push(full)
    }
  }
  return out
}

function listPackagesAndAppsSrcDirs (): string[] {
  const dirs: string[] = []
  for (const group of ['packages', 'apps']) {
    const groupDir = join(REPO_ROOT, group)
    if (!existsSync(groupDir)) continue
    for (const entry of readdirSync(groupDir)) {
      const srcDir = join(groupDir, entry, 'src')
      if (existsSync(srcDir)) dirs.push(srcDir)
    }
  }
  return dirs
}

const ALL_SRC_FILES = listPackagesAndAppsSrcDirs().flatMap((dir) => walkSourceFiles(dir))

// ---------------------------------------------------------------------------
// Matchers (shared between the real scan and G-6's positive control)
// ---------------------------------------------------------------------------

const IMPORT_FLAG_RE = /IsImportReplay\s*=\s*1\b/
const ALLOCATOR_TOKENS = ['allocateTid', 'peekTid', 'TidHighWater']

function findImportFlagLines (strippedText: string): string[] {
  return strippedText.split('\n').filter((line) => IMPORT_FLAG_RE.test(line))
}

function findAllocatorTokens (strippedText: string): string[] {
  return ALLOCATOR_TOKENS.filter((token) => strippedText.includes(token))
}

function findFoundingBundleApiRefs (strippedText: string): string[] {
  const re = /FoundingBundle|importFoundingBundle|exportFoundingBundle/g
  return strippedText.match(re) ?? []
}

// G-5 as amended in Phase 66 (user-approved checkpoint item D): the ./browser entry may name the
// genesis-row and founding-bundle modules ONLY in these two exact read-only re-export lines, so a
// paired browser can re-derive the founding digest from its own replica (66-14). The replay WRITE
// path (replayGenesisRows) stays barred from every barrel; index.ts, rn-entry.ts and
// networks/index.ts stay fully barred.
const BROWSER_FOUNDING_EXPORT_LINES = [
  "export { readGenesisRows, FOUNDING_BUNDLE_TABLE_ORDER } from './networks/genesis-rows.js'",
  "export { deriveFoundingDescriptor } from './networks/founding-bundle.js'"
]

function browserEntryFoundingProblems (strippedText: string): string[] {
  const problems: string[] = []
  if (/replayGenesisRows/.test(strippedText)) problems.push('names replayGenesisRows')
  let rest = strippedText
  for (const line of BROWSER_FOUNDING_EXPORT_LINES) {
    const count = rest.split(line).length - 1
    if (count > 1) problems.push(`repeats ${line}`)
    rest = rest.split(line).join('')
  }
  if (/genesis-rows/.test(rest)) problems.push('names genesis-rows outside the allowed export line')
  if (/founding-bundle/.test(rest)) problems.push('names founding-bundle outside the allowed export line')
  return problems
}

function findRawExecNearFoundingBundle (strippedText: string): boolean {
  const mentionsFoundingBundle = /FoundingBundle/.test(strippedText)
  if (!mentionsFoundingBundle) return false
  return /insert into|\.exec\(/.test(strippedText)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('founding-bundle guards (D-37, D-38, D-39)', () => {
  it('G-1: single producer — exactly one non-comment line across packages/*/src and apps/*/src binds the D-38 import flag', () => {
    const hits: Array<{ file: string; line: string }> = []
    for (const file of ALL_SRC_FILES) {
      const raw = readFileSync(file, 'utf8')
      const stripped = stripComments(raw)
      for (const line of findImportFlagLines(stripped)) {
        hits.push({ file, line })
      }
    }
    expect(hits, `expected exactly one producer line, found: ${JSON.stringify(hits)}`).to.have.lengthOf(1)
    const expectedPath = join(VOTE_ENGINE_SRC, 'networks/genesis-rows.ts')
    expect(hits[0]!.file).to.equal(expectedPath)
    expect(hits[0]!.line).to.match(IMPORT_FLAG_RE)

    // The nearest preceding "insert into" in that file must be "insert into UserKey".
    const fileText = stripComments(readFileSync(expectedPath, 'utf8'))
    const flagIndex = fileText.search(IMPORT_FLAG_RE)
    expect(flagIndex).to.be.greaterThan(-1)
    const before = fileText.slice(0, flagIndex)
    const insertMatches = [...before.matchAll(/insert into (\w+)/g)]
    expect(insertMatches.length, 'at least one preceding insert statement').to.be.greaterThan(0)
    expect(insertMatches[insertMatches.length - 1]![1]).to.equal('UserKey')
  })

  it('G-2: genesis-rows.ts and founding-bundle.ts name none of the Tid allocator\'s identifiers', () => {
    for (const relPath of ['networks/genesis-rows.ts', 'networks/founding-bundle.ts']) {
      const full = join(VOTE_ENGINE_SRC, relPath)
      const text = readFileSync(full, 'utf8')
      const tokens = findAllocatorTokens(text)
      expect(tokens, `${relPath} must not name: ${tokens.join(', ')}`).to.have.lengthOf(0)
    }
  })

  it('G-3: D-37 — no file under apps/VoteTorrentVoter/src names the founding-bundle API, and at least one non-test file references seedDevNetwork', () => {
    const voterFiles = walkSourceFiles(VOTER_SRC)
    expect(voterFiles.length, 'vacuous-pass guard').to.be.greaterThan(10)

    const violations: string[] = []
    let seedDevNetworkRefs = 0
    for (const file of voterFiles) {
      const raw = readFileSync(file, 'utf8')
      const stripped = stripComments(raw)
      if (findFoundingBundleApiRefs(stripped).length > 0) {
        violations.push(file)
      }
      if (stripped.includes('seedDevNetwork')) {
        seedDevNetworkRefs++
      }
    }
    expect(violations, `apps/VoteTorrentVoter/src must never reference the founding-bundle API: ${violations.join(', ')}`).to.have.lengthOf(0)
    expect(seedDevNetworkRefs, 'the Voter must still reference seedDevNetwork').to.be.greaterThan(0)
  })

  it('G-4: no raw replay in apps — no app file mentioning FoundingBundle contains an insert or .exec( call', () => {
    const violations: string[] = []
    for (const group of ['apps']) {
      const groupDir = join(REPO_ROOT, group)
      if (!existsSync(groupDir)) continue
      for (const entry of readdirSync(groupDir)) {
        const srcDir = join(groupDir, entry, 'src')
        for (const file of walkSourceFiles(srcDir)) {
          const stripped = stripComments(readFileSync(file, 'utf8'))
          if (findRawExecNearFoundingBundle(stripped)) {
            violations.push(file)
          }
        }
      }
    }
    expect(violations, `app files mentioning FoundingBundle must not contain a raw insert/.exec(: ${violations.join(', ')}`).to.have.lengthOf(0)
  })

  it('G-5: genesis-rows is imported only by networks-engine.ts, founding-bundle.ts and (two read-only names) browser-entry.ts; replayGenesisRows is called only from its own definition and networks-engine.ts; no other barrel re-exports either module', () => {
    const importers: string[] = []
    const callers: string[] = []
    for (const file of ALL_SRC_FILES) {
      if (!file.startsWith(VOTE_ENGINE_SRC)) continue
      const stripped = stripComments(readFileSync(file, 'utf8'))
      const relFile = relative(VOTE_ENGINE_SRC, file)
      if (relFile !== 'networks/genesis-rows.ts' && /from ['"].*genesis-rows(\.js)?['"]/.test(stripped)) {
        importers.push(relFile)
      }
      if (/replayGenesisRows\s*\(/.test(stripped)) {
        callers.push(relFile)
      }
    }
    expect(importers.sort()).to.deep.equal(['browser-entry.ts', 'networks/founding-bundle.ts', 'networks/networks-engine.ts'].sort())
    expect(callers.sort()).to.deep.equal(['networks/genesis-rows.ts', 'networks/networks-engine.ts'].sort())

    for (const barrel of ['index.ts', 'rn-entry.ts', 'networks/index.ts']) {
      const full = join(VOTE_ENGINE_SRC, barrel)
      if (!existsSync(full)) continue
      const stripped = stripComments(readFileSync(full, 'utf8'))
      expect(stripped, `${barrel} must not re-export genesis-rows`).to.not.match(/genesis-rows/)
      expect(stripped, `${barrel} must not re-export founding-bundle`).to.not.match(/founding-bundle/)
      expect(stripped, `${barrel} must not name replayGenesisRows`).to.not.match(/replayGenesisRows/)
    }

    const browserEntry = stripComments(readFileSync(join(VOTE_ENGINE_SRC, 'browser-entry.ts'), 'utf8'))
    expect(browserEntryFoundingProblems(browserEntry)).to.deep.equal([])
  })

  it('G-5b (positive control): the browser-entry matcher accepts only the two exact read-only lines and flags a planted replayGenesisRows, a widened line, an export-star and a foreign mention', () => {
    expect(browserEntryFoundingProblems(BROWSER_FOUNDING_EXPORT_LINES.join('\n'))).to.deep.equal([])
    expect(browserEntryFoundingProblems(stripComments(`// export { replayGenesisRows } from './networks/genesis-rows.js'`))).to.deep.equal([])

    const replayName = ['replay', 'GenesisRows'].join('')
    const plantedReplay = `export { ${replayName} } from './networks/genesis-rows.js'`
    expect(browserEntryFoundingProblems(stripComments(plantedReplay))).to.include('names replayGenesisRows')
    const plantedWidened = `export { readGenesisRows, FOUNDING_BUNDLE_TABLE_ORDER, ${replayName} } from './networks/genesis-rows.js'`
    expect(browserEntryFoundingProblems(stripComments(plantedWidened))).to.include('names replayGenesisRows')
    const plantedStar = `export * from './networks/genesis-rows.js'`
    expect(browserEntryFoundingProblems(stripComments(plantedStar))).to.include('names genesis-rows outside the allowed export line')
    const plantedBundle = `export { verifyFoundingBundle } from './networks/founding-bundle.js'`
    expect(browserEntryFoundingProblems(stripComments(plantedBundle))).to.include('names founding-bundle outside the allowed export line')
  })

  it('G-6 (positive control): the same matcher functions flag a planted second producer line, a planted allocator call, a planted Voter importFoundingBundle, and a planted app insert next to FoundingBundle — and ignore each planted inside a comment', () => {
    const plantedFlag = `  with context IsImportReplay = 1\n`
    expect(findImportFlagLines(stripComments(plantedFlag))).to.have.lengthOf(1)
    expect(findImportFlagLines(stripComments(`// with context IsImportReplay = 1\n`))).to.have.lengthOf(0)

    const plantedAllocator = `import { allocateTid } from './tid-allocator.js'`
    expect(findAllocatorTokens(stripComments(plantedAllocator))).to.include('allocateTid')
    expect(findAllocatorTokens(stripComments(`// import { allocateTid } from './tid-allocator.js'`))).to.have.lengthOf(0)

    const plantedVoterImport = `import { importFoundingBundle } from '@votetorrent/vote-engine'`
    expect(findFoundingBundleApiRefs(stripComments(plantedVoterImport)).length).to.be.greaterThan(0)
    expect(findFoundingBundleApiRefs(stripComments(`// import { importFoundingBundle } from '@votetorrent/vote-engine'`)).length).to.equal(0)

    const plantedAppExec = `import type { FoundingBundle } from '@votetorrent/vote-core'\nawait db.exec('insert into Network (...) values (...)')`
    expect(findRawExecNearFoundingBundle(stripComments(plantedAppExec))).to.equal(true)
    const plantedAppExecFullyCommented = `// import type { FoundingBundle } from '@votetorrent/vote-core'\n// await db.exec('insert into Network (...) values (...)')`
    expect(findRawExecNearFoundingBundle(stripComments(plantedAppExecFullyCommented))).to.equal(false)
  })
})
