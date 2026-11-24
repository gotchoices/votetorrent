/**
 * strandIdNetworkHash.guard.test.ts — D-39 always-on guard (62-23).
 *
 * Every strand is opened solely by the networks engine's DbFactory, keyed on
 * `strandId = networkHash` (`createStrandDbFactory` in the shared package's
 * `packages/workflows/src/common/strand-db-factory.ts`, re-exported by `src/engines/rn-db-factory.ts`). No screen
 * file may call `addStrand` directly — NetworksScreen's pasted-bootstrap Connect path only
 * DIALS a peer on the control node (D-39).
 *
 * This guard deliberately does NOT police `src/engines/`: 62-21 (same wave) may add a strand
 * adapter there, and it owns its own networkHash proof. It polices `src/screens/` only, plus a
 * direct source assertion on the shared `strand-db-factory.ts` proving the real factory is unchanged
 * (G-3), plus one on the app binding `engines/rn-db-factory.ts` proving it only re-exports that factory
 * and cannot grow a second one (G-3b).
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
const STRAND_DB_FACTORY_PATH = path.join(SRC_ROOT, '..', '..', '..', 'packages', 'workflows', 'src', 'common', 'strand-db-factory.ts')
const RN_DB_FACTORY_BINDING_PATH = path.join(SRC_ROOT, 'engines', 'rn-db-factory.ts')

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

	it('G-3: packages/workflows common/strand-db-factory.ts still derives strandId from networkHash (the real factory, unchanged)', () => {
		const source = fs.readFileSync(STRAND_DB_FACTORY_PATH, 'utf8')
		expect(source).toContain('const strandId = networkHash')
		expect(source).toContain('Id: strandId')
	})

	it('G-3b: the comment-stripped app binding engines/rn-db-factory.ts re-exports createStrandDbFactory from @votetorrent/workflows and contains no addStrand(', () => {
		const stripped = stripComments(fs.readFileSync(RN_DB_FACTORY_BINDING_PATH, 'utf8'))
		expect(stripped).toMatch(/export \{ createStrandDbFactory \} from '@votetorrent\/workflows'/)
		expect(stripped).not.toMatch(/addStrand\(/)
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
