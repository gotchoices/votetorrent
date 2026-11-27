/**
 * local-keyholders-removed.guard.test.ts — D-27 guard.
 *
 * `src/engines/local-keyholders.ts` is REMOVED, not merely bypassed. This guard fails if the file
 * returns, or if any non-test source imports it / references its exports.
 */

import * as fs from 'fs'
import * as path from 'path'

const SRC_ROOT = path.join(__dirname, '..', '..')
const REMOVED_FILE = path.join(SRC_ROOT, 'engines', 'local-keyholders.ts')
const MIN_SCANNED_FILES = 50

function listSourceFiles(dir: string): string[] {
	const files: string[] = []
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === '__tests__' || entry.name === 'node_modules') continue
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			files.push(...listSourceFiles(full))
		} else if (/\.(ts|tsx|js|jsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
			files.push(full)
		}
	}
	return files
}

const FORBIDDEN = /local-keyholders|saveLocalKeyholders|getLocalKeyholders/

describe('D-27 guard: local-keyholders.ts is removed, not bypassed', () => {
	it('the file src/engines/local-keyholders.ts does not exist (any extension)', () => {
		for (const ext of ['ts', 'tsx', 'js', 'jsx']) {
			expect(fs.existsSync(path.join(SRC_ROOT, 'engines', `local-keyholders.${ext}`))).toBe(false)
		}
		expect(fs.existsSync(REMOVED_FILE)).toBe(false)
	})

	it('no non-test source imports local-keyholders or references save/getLocalKeyholders', () => {
		expect(fs.existsSync(SRC_ROOT)).toBe(true)
		const files = listSourceFiles(SRC_ROOT)
		// Non-vacuity: a wrong root or over-eager filter would scan nothing.
		expect(files.length).toBeGreaterThan(MIN_SCANNED_FILES)
		const offenders = files
			.filter((f) => FORBIDDEN.test(fs.readFileSync(f, 'utf8')))
			.map((f) => path.relative(SRC_ROOT, f))
		expect(offenders).toEqual([])
	})
})
