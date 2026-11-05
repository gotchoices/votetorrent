/**
 * crypto-purity.spec.ts — Phase 62 Plan 04 (D-25)
 *
 * Purity gates for `src/crypto/*`, mirroring the comment-stripping approach
 * of `browser-entry-purity.spec.ts`:
 *
 *   P-1 — every import specifier in comment-stripped `src/crypto/*.ts` is a
 *         relative `./x.js` or one of the six allowed `@noble/*` subpaths.
 *   P-2 — zero occurrences of `node:`, `console.`, `TextDecoder` or the
 *         byte-buffer identifier in comment-stripped `src/crypto/*.ts`.
 *   P-3 — the comment-stripped `src/crypto/index.ts`, `src/index.ts` and
 *         `src/rn-entry.ts` contain none of the deterministic/test-only
 *         entry points or the encoding module's deep import.
 *   P-4 — positive controls proving the extractor and the name scan can
 *         actually detect a violation, not just fail to find one.
 */

import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const CRYPTO_DIR = join(SRC_DIR, 'crypto')

/** Best-effort stripper — same idiom as browser-entry-purity.spec.ts. */
function stripComments (src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/**
 * Scoped to exactly this plan's own files. `src/crypto/dkg.ts` lives in the
 * same directory but is owned by a sibling plan (62-05) with its own purity
 * discipline and its own `@noble/curves/abstract/frost.js` type-only import
 * that is out of scope for THIS plan's allowlist — scanning it here would
 * make this gate fail on a file this plan does not own and must not touch.
 */
function cryptoSourceFiles (): string[] {
  return ['encoding.ts', 'envelope.ts', 'block-cipher.ts', 'vault.ts', 'index.ts'].map((name) => join(CRYPTO_DIR, name))
}

/** Extract bare `from '...'` specifiers only (relative specifiers start with '.'). */
function extractFromSpecifiers (strippedSrc: string): string[] {
  const specifiers: string[] = []
  for (const match of strippedSrc.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
    specifiers.push(match[1]!)
  }
  return specifiers
}

const ALLOWED_BARE_SPECIFIERS = [
  '@noble/curves/secp256k1.js',
  '@noble/hashes/hkdf.js',
  '@noble/hashes/sha2.js',
  '@noble/hashes/utils.js',
  '@noble/ciphers/aes.js',
  '@noble/ciphers/utils.js'
]

describe('crypto-purity (62-04, D-25)', () => {
  describe('P-1 — import specifiers are relative ./x.js or the six allowed @noble/* subpaths', () => {
    it('every import specifier in comment-stripped src/crypto/*.ts is allowed', () => {
      const violations: string[] = []
      for (const file of cryptoSourceFiles()) {
        const stripped = stripComments(readFileSync(file, 'utf8'))
        for (const specifier of extractFromSpecifiers(stripped)) {
          if (specifier.startsWith('.')) {
            if (specifier.startsWith('..')) {
              violations.push(`${file}: relative parent-import '${specifier}'`)
            }
            continue
          }
          if (!ALLOWED_BARE_SPECIFIERS.includes(specifier)) {
            violations.push(`${file}: disallowed bare specifier '${specifier}'`)
          }
        }
      }
      expect(violations, violations.join('; ')).to.deep.equal([])
    })

    it('no file under src/crypto imports a relative ../ specifier', () => {
      const violations: string[] = []
      for (const file of cryptoSourceFiles()) {
        const stripped = stripComments(readFileSync(file, 'utf8'))
        if (/from\s*['"]\.\.\//.test(stripped)) violations.push(file)
      }
      expect(violations).to.deep.equal([])
    })
  })

  describe('P-2 — zero forbidden tokens in comment-stripped src/crypto/*.ts', () => {
    it("no 'node:' specifier, no 'console.', no 'TextDecoder', no byte-buffer identifier", () => {
      const bufferIdentifier = ['B', 'uffer'].join('')
      const violations: string[] = []
      for (const file of cryptoSourceFiles()) {
        const stripped = stripComments(readFileSync(file, 'utf8'))
        if (/node:/.test(stripped)) violations.push(`${file}: node: specifier`)
        if (/console\./.test(stripped)) violations.push(`${file}: console.`)
        if (/TextDecoder/.test(stripped)) violations.push(`${file}: TextDecoder`)
        if (new RegExp(`\\b${bufferIdentifier}\\b`).test(stripped)) violations.push(`${file}: ${bufferIdentifier} identifier`)
      }
      expect(violations, violations.join('; ')).to.deep.equal([])
    })
  })

  describe('P-3 — the barrels never mention the deterministic/test-only entry points or the encoding deep import', () => {
    const forbiddenNames = [
      ['sealToRecipients', 'WithRandomness'].join(''),
      ['encryptBlockContent', 'WithRandomness'].join(''),
      ['InMemory', 'TestKeyVault'].join(''),
      './encoding.js'
    ]

    const scannedFiles = [join(CRYPTO_DIR, 'index.ts'), join(SRC_DIR, 'index.ts'), join(SRC_DIR, 'rn-entry.ts')]

    for (const file of scannedFiles) {
      it(`${file.includes('crypto') ? 'src/crypto/index.ts' : file.endsWith('rn-entry.ts') ? 'src/rn-entry.ts' : 'src/index.ts'} contains none of the forbidden names`, () => {
        const stripped = stripComments(readFileSync(file, 'utf8'))
        for (const name of forbiddenNames) {
          expect(stripped.includes(name), `${file} must not mention '${name}'`).to.equal(false)
        }
      })
    }
  })

  describe('P-4 — positive controls', () => {
    it("the extractor DOES report a synthetic 'node:crypto' import", () => {
      const synthetic = stripComments("import { createHash } from 'node:crypto'\nexport const x = 1\n")
      const specifiers = extractFromSpecifiers(synthetic)
      expect(specifiers).to.include('node:crypto')
      expect(ALLOWED_BARE_SPECIFIERS.includes('node:crypto')).to.equal(false)
    })

    it('the name scan DOES find sealToRecipientsWithRandomness in envelope.ts', () => {
      const forbidden = ['sealToRecipients', 'WithRandomness'].join('')
      const stripped = stripComments(readFileSync(join(CRYPTO_DIR, 'envelope.ts'), 'utf8'))
      expect(stripped.includes(forbidden), 'envelope.ts legitimately exports the deterministic variant for tests').to.equal(true)
    })
  })
})
