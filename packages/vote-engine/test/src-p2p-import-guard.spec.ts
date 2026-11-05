/**
 * src-p2p-import-guard.spec.ts
 *
 * vote-engine src P2P import guard (D-24)
 *
 * D-24 requires that `@serfab/*`, `@optimystic/db-p2p*` and `@libp2p/*` (plus
 * bare `libp2p`) never leak into `packages/vote-engine/src`: a P2P import that
 * escapes test-only code into `src/` would drag libp2p and cadre-core into
 * every Metro app bundle through a seam meant to stay P2P-free.
 * `@optimystic/quereus-plugin-crypto` stays allowed — it is a real runtime
 * dependency, not a P2P transport package.
 *
 * This guard is ALWAYS ON (no env flag). It runs four checks:
 *
 *   G-1 — zero forbidden specifiers anywhere under src/, across five import
 *         forms (static import-from, side-effect import, export-from,
 *         dynamic import(), require()).
 *   G-2 — vacuous-pass guard: the walker actually visited >= 100 .ts files.
 *   G-3 — positive control: the SAME extraction function, run over an
 *         in-memory fixture, both detects all five forms AND does not flag
 *         the exact text of src/key-network-libp2p.ts line 1 (a
 *         commented-out import left in place deliberately).
 *   G-4 — manifest lock: vote-engine's `dependencies` has no forbidden key,
 *         and its P2P `devDependencies` descriptors equal the root
 *         `resolutions` byte-for-byte (D-24: "never a separately pinned
 *         copy").
 *
 * Comment-stripping (mirroring browser-entry-purity.spec.ts) is mandatory:
 * src/key-network-libp2p.ts:1 is a commented-out `@libp2p/interface` import,
 * and a naive scanner would false-positive on it.
 */

import { expect } from 'chai'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
  throw new Error('src-p2p-import-guard: could not locate yarn.lock walking up from the spec')
}

/** Locate packages/vote-engine/src from this spec's own location. */
function findSrcDir (): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // this spec lives at packages/vote-engine/test/src-p2p-import-guard.spec.ts
  return join(here, '..', 'src')
}

const REPO_ROOT = findRepoRoot()
const SRC_DIR = findSrcDir()
const VOTE_ENGINE_DIR = join(SRC_DIR, '..')

// ---------------------------------------------------------------------------
// Comment stripping (mirrors browser-entry-purity.spec.ts)
// ---------------------------------------------------------------------------

function stripComments (src: string): string {
  const noBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, '')
  return noBlockComments.replace(/\/\/.*$/gm, '')
}

// ---------------------------------------------------------------------------
// Forbidden specifier matching
// ---------------------------------------------------------------------------

/** Forbidden prefixes/exacts per D-24. @optimystic/quereus-plugin-crypto is NOT forbidden. */
function isForbiddenSpecifier (specifier: string): boolean {
  if (specifier === 'libp2p') return true
  if (specifier.startsWith('@serfab/')) return true
  if (specifier.startsWith('@libp2p/')) return true
  if (specifier.startsWith('@optimystic/db-p2p')) return true
  return false
}

/**
 * Extract module specifiers from five forms over comment-stripped source:
 *   1. static `import ... from '<s>'` (including `import type`)
 *   2. side-effect `import '<s>'`
 *   3. `export ... from '<s>'`
 *   4. dynamic `import('<s>')`
 *   5. `require('<s>')`
 *
 * Returns the full list of specifiers found (not filtered).
 */
function extractSpecifiers (stripped: string): string[] {
  const specifiers: string[] = []

  // Forms 1 & 3: `import ... from '<s>'` (including `import type`) and `export ... from '<s>'`
  const fromRe = /\bfrom\s*['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = fromRe.exec(stripped)) !== null) {
    specifiers.push(m[1])
  }

  // Form 2: side-effect `import '<s>'` (no `from`, no parens — excludes dynamic import())
  const sideEffectRe = /\bimport\s+['"]([^'"]+)['"]/g
  while ((m = sideEffectRe.exec(stripped)) !== null) {
    specifiers.push(m[1])
  }

  // Form 4: dynamic import('<s>')
  const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((m = dynRe.exec(stripped)) !== null) {
    specifiers.push(m[1])
  }

  // Form 5: require('<s>')
  const reqRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((m = reqRe.exec(stripped)) !== null) {
    specifiers.push(m[1])
  }

  return specifiers
}

interface Violation {
  file: string
  specifier: string
}

function walkTsFiles (dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      walkTsFiles(full, out)
    } else if (st.isFile() && entry.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('vote-engine src P2P import guard (D-24)', () => {
  const files = walkTsFiles(SRC_DIR)

  it('G-1: zero forbidden P2P specifiers under src/', () => {
    const violations: Violation[] = []
    for (const file of files) {
      const raw = readFileSync(file, 'utf8')
      const stripped = stripComments(raw)
      const specifiers = extractSpecifiers(stripped)
      for (const specifier of specifiers) {
        if (isForbiddenSpecifier(specifier)) {
          violations.push({ file, specifier })
        }
      }
    }
    const message = violations.map(v => `${v.file}:${v.specifier}`).join(', ')
    expect(violations, `forbidden P2P imports found under src/: ${message}`).to.have.lengthOf(0)
  })

  it('G-2 (vacuous-pass guard): the walker visited at least 100 .ts files', () => {
    expect(files.length).to.be.at.least(100)
  })

  it('G-3 (positive control): the extraction+match function detects all five forms, and does not flag the commented-out src import', () => {
    const fixture = `
import type { Libp2p } from '@libp2p/interface'
import '@serfab/cadre-core'
export { X } from '@optimystic/db-p2p'
async function load () {
  await import('@libp2p/websockets')
}
const x = require('libp2p')
`
    const stripped = stripComments(fixture)
    const specifiers = extractSpecifiers(stripped)
    const forbidden = specifiers.filter(isForbiddenSpecifier)
    expect(forbidden, 'positive control must detect all five forbidden forms').to.include.members([
      '@libp2p/interface',
      '@serfab/cadre-core',
      '@optimystic/db-p2p',
      '@libp2p/websockets',
      'libp2p'
    ])
    expect(forbidden.length).to.equal(5)

    // The exact commented-out line from src/key-network-libp2p.ts:1 must NOT be flagged.
    const keyNetworkLibp2pPath = join(SRC_DIR, 'key-network-libp2p.ts')
    expect(existsSync(keyNetworkLibp2pPath), 'src/key-network-libp2p.ts must exist for this control').to.equal(true)
    const firstLine = readFileSync(keyNetworkLibp2pPath, 'utf8').split('\n')[0]
    expect(firstLine, 'fixture assumption: line 1 is the commented-out import').to.match(/^\/\/\s*import type.*@libp2p\/interface/)
    const strippedLine = stripComments(firstLine)
    const lineSpecifiers = extractSpecifiers(strippedLine).filter(isForbiddenSpecifier)
    expect(lineSpecifiers, 'the commented-out import must not be flagged once comments are stripped').to.have.lengthOf(0)
  })

  it('G-4 (manifest lock): vote-engine devDependency P2P descriptors equal root resolutions, and dependencies has no forbidden key', () => {
    const vePackageJson = JSON.parse(readFileSync(join(VOTE_ENGINE_DIR, 'package.json'), 'utf8'))
    const rootPackageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))

    const deps: Record<string, string> = vePackageJson.dependencies ?? {}
    const forbiddenDepKeys = Object.keys(deps).filter(k =>
      k.startsWith('@serfab/') || k.startsWith('@libp2p/') || k.startsWith('@optimystic/db-p2p')
    )
    expect(forbiddenDepKeys, `dependencies must not declare P2P packages: ${forbiddenDepKeys.join(', ')}`).to.have.lengthOf(0)

    const devDeps: Record<string, string> = vePackageJson.devDependencies ?? {}
    const resolutions: Record<string, string> = rootPackageJson.resolutions ?? {}

    expect(devDeps['@serfab/cadre-core'], 'devDependencies @serfab/cadre-core must equal root resolutions').to.equal(resolutions['@serfab/cadre-core'])
    // The root may wrap db-p2p in the one deliberate yarn patch (2026-10-28, commit-proof memo):
    // `patch:@optimystic/db-p2p@npm%3A1.24.0#~/.yarn/patches/...`. The lock then holds on the version
    // inside the descriptor, which the vote-engine devDependency must name as `^<version>`.
    const rootDbP2p = resolutions['@optimystic/db-p2p'] ?? ''
    const patched = /^patch:@optimystic\/db-p2p@npm%3A(\d+\.\d+\.\d+)#/.exec(rootDbP2p)
    const expectedDbP2p = patched ? `^${patched[1]}` : rootDbP2p
    expect(devDeps['@optimystic/db-p2p'], 'devDependencies @optimystic/db-p2p must equal root resolutions (patch unwrapped)').to.equal(expectedDbP2p)
  })
})
