/**
 * intake-source-gates.spec.ts — Phase 62 Plan 14 Task 3
 *
 * Comment-stripped source-level scans over `src/intake/*.ts` (the
 * crypto-purity.spec.ts extractor approach):
 *
 *   G-1 — no console., no node: specifier, no @serfab/@optimystic/@libp2p
 *         import, no byte-buffer identifier.
 *   G-2 — T-62-01-10: intake writes are limited to UserEncryptionKey and
 *         AuthorityIntakePolicy; no update/delete at all.
 *   G-3 — no test-only crypto entry point reachable from the production path.
 *   G-4 — barrel reachability: src/index.ts, src/rn-entry.ts, src/browser-entry.ts.
 *   G-5 — positive controls proving every scanner above can actually detect
 *         a violation, including one planted only inside a comment.
 */

import { expect } from 'chai'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const INTAKE_DIR = join(SRC_DIR, 'intake')

function stripComments (src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

function intakeSourceFiles (): string[] {
  return readdirSync(INTAKE_DIR).filter((f) => f.endsWith('.ts')).map((f) => join(INTAKE_DIR, f))
}

const BUFFER_IDENTIFIER = ['B', 'uffer'].join('')

// ---------------------------------------------------------------------------
// Scanners (reused by both the real-file tests and the G-5 positive controls)
// ---------------------------------------------------------------------------

function scanG1 (stripped: string): string[] {
  const hits: string[] = []
  if (/console\./.test(stripped)) hits.push('console.')
  if (/\bnode:/.test(stripped)) hits.push('node: specifier')
  if (/from\s*['"]@serfab/.test(stripped)) hits.push('@serfab import')
  if (/from\s*['"]@optimystic/.test(stripped)) hits.push('@optimystic import')
  if (/from\s*['"]@libp2p/.test(stripped)) hits.push('@libp2p import')
  if (new RegExp(`\\b${BUFFER_IDENTIFIER}\\b`).test(stripped)) hits.push(`${BUFFER_IDENTIFIER} identifier`)
  return hits
}

function scanG2InsertTargets (stripped: string): string[] {
  const targets = new Set<string>()
  for (const m of stripped.matchAll(/insert into\s+([A-Za-z0-9_]+)/gi)) targets.add(m[1]!)
  return [...targets].sort()
}

function scanG2Mutations (stripped: string): string[] {
  const hits: string[] = []
  if (/update\s+[A-Za-z0-9_]+\s+set/i.test(stripped)) hits.push('update ... set')
  if (/delete from/i.test(stripped)) hits.push('delete from')
  return hits
}

function scanG3 (stripped: string): string[] {
  const hits: string[] = []
  if (stripped.includes(['sealToRecipients', 'WithRandomness'].join(''))) hits.push('sealToRecipientsWithRandomness')
  if (stripped.includes(['InMemory', 'TestKeyVault'].join(''))) hits.push('InMemoryTestKeyVault')
  if (stripped.includes('./encoding.js')) hits.push('./encoding.js')
  return hits
}

describe('intake-source-gates (62-14)', () => {
  describe('G-1 — no console, no node:, no P2P import, no byte-buffer identifier', () => {
    it('src/intake/*.ts carries none of these', () => {
      const violations: string[] = []
      for (const file of intakeSourceFiles()) {
        const stripped = stripComments(readFileSync(file, 'utf8'))
        for (const hit of scanG1(stripped)) violations.push(`${file}: ${hit}`)
      }
      expect(violations, violations.join('; ')).to.deep.equal([])
    })
  })

  describe('G-2 — T-62-01-10: intake writes are limited to UserEncryptionKey and AuthorityIntakePolicy', () => {
    it('every "insert into <Name>" names only those two tables', () => {
      const violations: string[] = []
      const allowed = new Set(['UserEncryptionKey', 'AuthorityIntakePolicy'])
      for (const file of intakeSourceFiles()) {
        const stripped = stripComments(readFileSync(file, 'utf8'))
        for (const target of scanG2InsertTargets(stripped)) {
          if (!allowed.has(target)) violations.push(`${file}: insert into ${target}`)
        }
      }
      expect(violations, violations.join('; ')).to.deep.equal([])
    })

    it('no "update ... set" and no "delete from" anywhere', () => {
      const violations: string[] = []
      for (const file of intakeSourceFiles()) {
        const stripped = stripComments(readFileSync(file, 'utf8'))
        for (const hit of scanG2Mutations(stripped)) violations.push(`${file}: ${hit}`)
      }
      expect(violations, violations.join('; ')).to.deep.equal([])
    })
  })

  describe('G-3 — no test-only crypto entry point on the production path', () => {
    it('no sealToRecipientsWithRandomness, InMemoryTestKeyVault or ./encoding.js reference', () => {
      const violations: string[] = []
      for (const file of intakeSourceFiles()) {
        const stripped = stripComments(readFileSync(file, 'utf8'))
        for (const hit of scanG3(stripped)) violations.push(`${file}: ${hit}`)
      }
      expect(violations, violations.join('; ')).to.deep.equal([])
    })
  })

  describe('G-4 — barrel reachability', () => {
    it("src/index.ts contains the intake star export exactly once", () => {
      const stripped = stripComments(readFileSync(join(SRC_DIR, 'index.ts'), 'utf8'))
      const count = (stripped.match(/export \* from '\.\/intake\/index\.js'/g) ?? []).length
      expect(count).to.equal(1)
    })

    it('src/rn-entry.ts imports from ./intake/index.js', () => {
      const stripped = stripComments(readFileSync(join(SRC_DIR, 'rn-entry.ts'), 'utf8'))
      expect(stripped.includes("from './intake/index.js'")).to.equal(true)
    })

    it('src/browser-entry.ts contains no "intake" text', () => {
      const stripped = stripComments(readFileSync(join(SRC_DIR, 'browser-entry.ts'), 'utf8'))
      expect(stripped.includes('intake')).to.equal(false)
    })

    it('src/rn-entry.ts carries each P2P transport star export exactly once', () => {
      const stripped = stripComments(readFileSync(join(SRC_DIR, 'rn-entry.ts'), 'utf8'))
      const regCount = (stripped.match(/export \* from '\.\/registration\/transport\/p2p-registration-transport\.js'/g) ?? []).length
      const assocCount = (stripped.match(/export \* from '\.\/association\/transport\/p2p-association-transport\.js'/g) ?? []).length
      expect(regCount).to.equal(1)
      expect(assocCount).to.equal(1)
    })

    it('src/index.ts contains neither p2p-registration-transport nor p2p-association-transport', () => {
      const stripped = stripComments(readFileSync(join(SRC_DIR, 'index.ts'), 'utf8'))
      expect(stripped.includes('p2p-registration-transport')).to.equal(false)
      expect(stripped.includes('p2p-association-transport')).to.equal(false)
    })
  })

  describe('G-5 — positive controls', () => {
    it('G-1 scanner reports a hit for console., node:, each P2P specifier and the buffer identifier', () => {
      expect(scanG1(stripComments("console.log('x')"))).to.include('console.')
      expect(scanG1(stripComments("import { x } from 'node:crypto'"))).to.include('node: specifier')
      expect(scanG1(stripComments("import { x } from '@serfab/cadre-core'"))).to.include('@serfab import')
      expect(scanG1(stripComments("import { x } from '@optimystic/db-p2p'"))).to.include('@optimystic import')
      expect(scanG1(stripComments("import { x } from '@libp2p/interface'"))).to.include('@libp2p import')
      expect(scanG1(stripComments(`const x = new ${BUFFER_IDENTIFIER}()`))).to.include(`${BUFFER_IDENTIFIER} identifier`)
    })

    it('G-2 scanner reports insert into RegistrationRequest as a violation target, and detects update/delete', () => {
      expect(scanG2InsertTargets(stripComments('insert into RegistrationRequest (A) values (1)'))).to.deep.equal(['RegistrationRequest'])
      expect(scanG2Mutations(stripComments('update Foo set Bar = 1'))).to.include('update ... set')
      expect(scanG2Mutations(stripComments('delete from Foo'))).to.include('delete from')
    })

    it('G-3 scanner reports a hit for the deterministic sealer and the test vault', () => {
      expect(scanG3(stripComments(['sealToRecipients', 'WithRandomness(a, b, c, d)'].join('')))).to.include('sealToRecipientsWithRandomness')
      expect(scanG3(stripComments(`new ${['InMemory', 'TestKeyVault'].join('')}()`))).to.include('InMemoryTestKeyVault')
    })

    it('a synthetic string carrying every violation only inside comments reports none', () => {
      const commentOnly = [
        '// console.log("x")',
        "// import { x } from 'node:crypto'",
        "// import { x } from '@serfab/cadre-core'",
        `// const x = new ${BUFFER_IDENTIFIER}()`,
        '// insert into RegistrationRequest (A) values (1)',
        '// update Foo set Bar = 1',
        '// delete from Foo',
        `// ${['sealToRecipients', 'WithRandomness'].join('')}(a, b, c, d)`,
        `// new ${['InMemory', 'TestKeyVault'].join('')}()`
      ].join('\n')
      const stripped = stripComments(commentOnly)
      expect(scanG1(stripped)).to.deep.equal([])
      expect(scanG2InsertTargets(stripped)).to.deep.equal([])
      expect(scanG2Mutations(stripped)).to.deep.equal([])
      expect(scanG3(stripped)).to.deep.equal([])
    })
  })
})
