/**
 * strandIdNetworkHash.guard.test.ts — D-39 always-on guard (62-23).
 *
 * Every strand is opened solely by the networks engine's DbFactory, keyed on
 * `strandId = networkHash` (`rn-engines/rn-db-factory.ts`'s `createStrandDbFactory`). No screen
 * file may call `addStrand` directly — NetworksScreen's pasted-bootstrap Connect path only
 * DIALS a peer on the control node (D-39).
 *
 * This guard deliberately does NOT police `src/engines/`: 62-21 (same wave) may add a strand
 * adapter there, and it owns its own networkHash proof. It polices `src/screens/` only, plus a
 * direct source assertion on `rn-db-factory.ts` proving the real factory is unchanged (G-3).
 *
 * positive control: G-4 proves the comment-stripping matcher actually fires on a planted
 * `addStrand(` call, and correctly ignores one hidden inside a `//` line comment and one inside
 * a `/* ... *\/` block comment — without this, a matcher silently broken (comment-stripped to
 * nothing, or a path typo) would let G-1/G-2 pass vacuously forever.
 */

import * as fs from 'fs'
import * as path from 'path'

const SRC_ROOT = path.join(__dirname, '..', '..', '..')
const SCREENS_ROOT = path.join(SRC_ROOT, 'screens')
const NETWORKS_SCREEN_PATH = path.join(SRC_ROOT, 'screens', 'networks', 'NetworksScreen.tsx')
const RN_DB_FACTORY_PATH = path.join(SRC_ROOT, 'engines', 'rn-db-factory.ts')

/** Strips `//` line comments and `/* ... *\/` block comments, mirroring the project's other
 * source-shape guards (e.g. `deviceSigningRollout.coverage.test.ts`'s `stripComments`). */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('\n')
		.map((line) => line.replace(/\/\/.*$/, ''))
		.join('\n')
}

function listSourceFiles(dir: string): string[] {
	const entries = fs.readdirSync(dir, { withFileTypes: true })
	const files: string[] = []
	for (const entry of entries) {
		if (entry.name === '__tests__') continue
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			files.push(...listSourceFiles(full))
		} else if (/\.(ts|tsx)$/.test(entry.name)) {
			files.push(full)
		}
	}
	return files
}

describe('D-39 guard: every strand is opened only by the DbFactory, keyed on networkHash', () => {
	it('G-1: comment-stripped NetworksScreen.tsx contains neither addStrand nor strandRow', () => {
		const source = fs.readFileSync(NETWORKS_SCREEN_PATH, 'utf8')
		const stripped = stripComments(source)
		expect(stripped).not.toMatch(/addStrand/)
		expect(stripped).not.toMatch(/strandRow/)
	})

	it('G-2: no non-test file under src/screens/ contains addStrand(', () => {
		const files = listSourceFiles(SCREENS_ROOT)
		const offenders: string[] = []
		for (const file of files) {
			const stripped = stripComments(fs.readFileSync(file, 'utf8'))
			if (/addStrand\(/.test(stripped)) {
				offenders.push(path.relative(SRC_ROOT, file))
			}
		}
		expect(offenders).toEqual([])
	})

	it('G-3: src/engines/rn-db-factory.ts still derives strandId from networkHash (the real factory, unchanged)', () => {
		const source = fs.readFileSync(RN_DB_FACTORY_PATH, 'utf8')
		expect(source).toContain('const strandId = networkHash')
		expect(source).toContain('Id: strandId')
	})

	it('G-4 (positive control): the matcher flags a planted addStrand( call, and ignores one in a // comment and one in a block comment', () => {
		const plantedFlagged = "node.addStrand({ strandRow: { Id: 'x' } })"
		const plantedLineComment = "// node.addStrand({ strandRow: { Id: 'x' } })"
		const plantedBlockComment = "/* node.addStrand({ strandRow: { Id: 'x' } }) */"

		expect(/addStrand\(/.test(stripComments(plantedFlagged))).toBe(true)
		expect(/addStrand\(/.test(stripComments(plantedLineComment))).toBe(false)
		expect(/addStrand\(/.test(stripComments(plantedBlockComment))).toBe(false)
	})
})
