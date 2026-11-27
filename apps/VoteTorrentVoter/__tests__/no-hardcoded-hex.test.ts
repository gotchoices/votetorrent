/**
 * @format
 *
 * Phase 59 plan 59-07, Task 3 -- source-scan gate for the standing project rule (Phase 7 D-13,
 * restated in `59-UI-SPEC.md` §Color): theme tokens only, no hardcoded color literal anywhere in
 * the Timeline surface (`TimelineRail.tsx`/`TimelineRow.tsx` today; `src/screens/timeline/` once
 * 59-08 lands it).
 *
 * Three describe blocks:
 *   1. THE REAL SCAN -- non-vacuity (the scanned file list provably contains both Timeline
 *      component files) THEN the zero-offenders assertion.
 *   2. THE MUTATION PROOF -- the identical `detect` scan run over synthetic, planted fixture
 *      files (never real source) in a `mkdtempSync` temp directory, mirroring
 *      `no-vrg-ceremony.gate.test.ts`'s idiom. A gate that has never been seen to fail is not a
 *      gate. Planted literals are built by runtime string concatenation so this file's OWN
 *      source never contains a color literal to trip over.
 *   3. THE SELF-SCAN -- this repo's thrice-repeated self-matching-checker lesson: a checker whose
 *      own comment quotes the pattern it greps for is permanently green. This file's comments
 *      describe the pattern in WORDS ONLY ("a CSS color literal", "the three-digit form") and
 *      never write an example color value -- enforced mechanically below.
 */
import {existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import * as path from 'path';

// The ONE real-code declaration of the color-literal pattern in this file: a `#` followed by
// exactly three or six hexadecimal digits at a word boundary (the CSS short/long hex-color
// shapes). Every comment in this file that refers to it does so in prose only -- Test 3 below
// enforces that mechanically.
const HEX_COLOR_PATTERN = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/;

/**
 * Strips block (`/* ... *\/`) and line (`//...`) comments before matching -- load-bearing: a doc
 * comment legitimately naming a RESOLVED token value in prose must not cry wolf on the
 * component's own documentation. Two-step regex shape, matching
 * `no-inline-mock-imports.test.ts:26-28`.
 */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

interface HexOffense {
	line: number;
	text: string;
}

/** Runs the comment-stripped source through the pattern, line by line, so an offense reports its
 * own line number. */
function detect(source: string): HexOffense[] {
	const stripped = stripComments(source);
	const offenses: HexOffense[] = [];
	stripped.split('\n').forEach((lineText, index) => {
		if (HEX_COLOR_PATTERN.test(lineText)) {
			offenses.push({line: index + 1, text: lineText.trim()});
		}
	});
	return offenses;
}

/** Mirrors `no-inline-mock-imports.test.ts:15-24`'s walk, skipping `node_modules`, `__tests__`
 * and `__fixtures__` -- fixture/test files are not the shipped Timeline surface. Missing
 * directories (the not-yet-created `src/screens/timeline`) contribute nothing rather than
 * throwing, so this gate automatically starts covering 59-08's/59-10's files the moment they
 * land. */
function walk(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === '__fixtures__') return [];
			return walk(full);
		}
		return /\.tsx$/.test(entry.name) ? [full] : [];
	});
}

const componentsRoot = path.resolve(__dirname, '../src/components');
const screensTimelineRoot = path.resolve(__dirname, '../src/screens/timeline');

const timelineComponentFiles = walk(componentsRoot).filter(f => /^Timeline.*\.tsx$/.test(path.basename(f)));
const timelineScreenFiles = walk(screensTimelineRoot);
const scannedFiles = [...timelineComponentFiles, ...timelineScreenFiles];

// ---------------------------------------------------------------------------
// 1. THE REAL SCAN
// ---------------------------------------------------------------------------

describe('no-hardcoded-hex real scan (Timeline surface, Phase 7 D-13 / 59-UI-SPEC.md §Color)', () => {
	test('non-vacuity: the scan roots provably include both TimelineRail.tsx and TimelineRow.tsx', () => {
		const basenames = scannedFiles.map(f => path.basename(f));
		expect(basenames).toEqual(expect.arrayContaining(['TimelineRail.tsx', 'TimelineRow.tsx']));
	});

	test('no Timeline surface file contains a hardcoded color literal', () => {
		const offenders: string[] = [];
		for (const file of scannedFiles) {
			const text = readFileSync(file, 'utf8');
			for (const offense of detect(text)) {
				offenders.push(`${path.relative(componentsRoot, file)}:${offense.line}: ${offense.text}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 2. THE MUTATION PROOF -- synthetic fixture files, never real source
// ---------------------------------------------------------------------------

describe('no-hardcoded-hex mutation proof (the gate can tell code from prose)', () => {
	let fixtureDir: string;

	beforeAll(() => {
		fixtureDir = mkdtempSync(join(tmpdir(), 'no-hardcoded-hex-'));
	});

	afterAll(() => {
		rmSync(fixtureDir, {recursive: true, force: true});
	});

	// Built by runtime string concatenation -- this file's OWN source contains no color literal
	// for any scan (this file's own, or a future one) to trip over.
	const HASH = '#';
	const sixDigitLiteral = HASH + '2196f3';
	const threeDigitLiteral = HASH + 'fff';

	test('FLAGS a six-digit hex literal planted in a real style object', () => {
		const file = join(fixtureDir, 'six-digit.ts');
		writeFileSync(
			file,
			['const styles = {', `  card: {backgroundColor: '${sixDigitLiteral}'},`, '};', 'export default styles;'].join('\n'),
		);

		const offenses = detect(readFileSync(file, 'utf8'));
		expect(offenses.length).toBeGreaterThan(0);
	});

	test('FLAGS a three-digit hex literal planted in a real style object (short form is not a blind spot)', () => {
		const file = join(fixtureDir, 'three-digit.ts');
		writeFileSync(
			file,
			['const styles = {', `  border: {borderColor: '${threeDigitLiteral}'},`, '};', 'export default styles;'].join('\n'),
		);

		const offenses = detect(readFileSync(file, 'utf8'));
		expect(offenses.length).toBeGreaterThan(0);
	});

	test('REPORTS NOTHING when the identical literals sit only inside a line comment and a block comment', () => {
		const file = join(fixtureDir, 'comment-only.ts');
		writeFileSync(
			file,
			[
				`// a literal like ${sixDigitLiteral} only ever appears here, in a line comment`,
				'/**',
				` * ...or here, describing the resolved value of a token: ${threeDigitLiteral}`,
				' */',
				'export const NOTE = "no color literal in real code on this file";',
			].join('\n'),
		);

		const offenses = detect(readFileSync(file, 'utf8'));
		expect(offenses).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 3. THE SELF-SCAN -- this repo's thrice-repeated self-matching-checker lesson
// ---------------------------------------------------------------------------

describe('no-hardcoded-hex self-scan (this gate cannot disarm itself via its own prose)', () => {
	test("this file's own comment regions contain no color-literal-shaped text, and the pattern is declared exactly once in real code", () => {
		const selfSource = readFileSync(__filename, 'utf8');

		// The inverse of stripComments(): collect ONLY the comment regions.
		const blockComments = selfSource.match(/\/\*[\s\S]*?\*\//g) ?? [];
		const lineComments = selfSource.match(/\/\/.*$/gm) ?? [];
		const commentText = [...blockComments, ...lineComments].join('\n');

		expect(HEX_COLOR_PATTERN.test(commentText)).toBe(false);

		const strippedSelf = stripComments(selfSource);
		const declarationCount = (strippedSelf.match(/const HEX_COLOR_PATTERN = \/#/g) ?? []).length;
		expect(declarationCount).toBe(1);
	});
});
