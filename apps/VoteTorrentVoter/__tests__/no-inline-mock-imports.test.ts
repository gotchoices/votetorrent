/**
 * @format
 *
 * Phase 39 plan 39-08 (SHELL-03) — automated source-scan gate for D-06's "every screen reads
 * through useVoterApp(), never a direct providers/mockData import" rule. This is the automated
 * Jest form of SHELL-03's source scan (39-VALIDATION.md Wave-0 gap): it fs-walks `src/screens/`
 * the same way `__tests__/i18n-parity.test.ts` walks its scan roots, and runs in the same
 * `yarn jest` gate — not a shell one-liner, so it can't silently rot out of CI.
 */
import * as fs from 'fs';
import * as path from 'path';

const screensDir = path.resolve(__dirname, '../src/screens');

const walk = (dir: string): string[] =>
	fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name === '__tests__') return [];
			return walk(full);
		}
		return /\.tsx$/.test(entry.name) ? [full] : [];
	});

// Strip line (`//...`) and block (`/* ... */`) comments before matching, so a descriptive
// comment referencing mockData (e.g. "no inline mockData import" — every screen carries one)
// can't false-trip the import scan.
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const screenFiles = walk(screensDir);

describe('no inline mockData imports in screens (SHELL-03, D-06)', () => {
	test('no screen file imports providers/mockData', () => {
		// Matches the import FORM (an `import ... from '...mockData'` statement, or a
		// `require('...mockData')` call) rather than a bare substring, so unrelated identifiers
		// containing "mockData" can't false-trip it.
		const importRe =
			/import\s[^;]*?from\s+['"][^'"]*mockData['"]|require\(\s*['"][^'"]*mockData['"]\s*\)/;

		const offenders: string[] = [];
		for (const file of screenFiles) {
			const text = stripComments(fs.readFileSync(file, 'utf8'));
			if (importRe.test(text)) {
				offenders.push(path.relative(screensDir, file));
			}
		}

		expect(offenders).toEqual([]);
	});

	test('every screen file calls useVoterApp(', () => {
		const offenders: string[] = [];
		for (const file of screenFiles) {
			const text = stripComments(fs.readFileSync(file, 'utf8'));
			if (!/\buseVoterApp\(/.test(text)) {
				offenders.push(path.relative(screensDir, file));
			}
		}

		expect(offenders).toEqual([]);
	});
});
