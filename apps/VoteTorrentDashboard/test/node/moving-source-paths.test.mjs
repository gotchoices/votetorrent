/**
 * moving-source-paths.test.mjs — pre-move derivation-discipline scan (D-03,
 * 54-01 Task 3).
 *
 * Proves that after this plan's Task 1 (the resolver pair named ahead of the
 * directory's creation) and Task 2 (the one governed-directory entry
 * repointed at the resolver), no dashboard tier-1 test and no repo-root
 * script hand-derives a filesystem path through either of the two
 * directories D-03 relocates into packages/web-data. That is what makes the
 * eventual move a call-argument flip rather than a hunt for a hand-derived
 * path.
 *
 * This file touches no IndexedDB, so like source-paths.test.mjs it does not
 * import `fake-indexeddb/auto` — doing so would imply a persistence claim
 * this tier cannot make. Same header note, same deliberate omission.
 *
 * Self-tripping-checker defence. A checker whose own comment quotes the
 * pattern it greps for is permanently green — this exact failure mode has
 * recurred three times in this repo's Phase 53 planning history. The two
 * moving-directory names are therefore never written as a contiguous
 * literal anywhere in this file — not in code, not in a fixture, not in a
 * comment, not in a test name. They are assembled from single-word
 * fragments at module scope, the matcher is built from those fragments with
 * `new RegExp(...)`, and this file is NOT excluded from the walk it drives
 * — it scans itself, deliberately, as the stronger proof.
 *
 * Scope boundary (binding — do not widen this scan into 54-03's half; see
 * 54-ISSUES.md I-08). Two families of line are excluded as LEGITIMATE, not
 * missed:
 *
 *   1. ESM import-specifier lines (`from '...'`, `from "..."`, `import(`,
 *      `new URL(`) — the real relative-specifier imports in reads.test.mjs,
 *      db.test.mjs, db-delete.test.mjs and the other node tests that import
 *      a dashboard module by relative path.
 *      Those are real and legitimate today; rewriting the specifier SHAPE
 *      (relative → bare @votetorrent/web-data specifier) is 54-03's
 *      semantic territory, one wave later, not this plan's. A future reader
 *      must not "tighten" this scan to also flag those — that would reach
 *      into 54-03's half and break wave ordering.
 *   2. The quoted DESCRIPTION argument of a `test(...)` declaration —
 *      measured occurrences today: election-ops-panels.test.mjs (the
 *      panel-owned-queries test name), reads.test.mjs (two test names), and
 *      preview-control.test.mjs (the confinement-walk test name). A test's
 *      own description string is prose describing what the test checks, not
 *      code that resolves a filesystem path. Only the quoted description is
 *      blanked before matching — the REST of the line (and every other
 *      line, including the rest of these same files) stays fully scanned,
 *      so a real derivation placed anywhere else is still caught.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { repoRoot, dashboardRoot } from '../../../../scripts/lib/source-paths.mjs';

// --- Fragment assembly (self-tripping-checker defence) ----------------------

const SRC_FRAG = 'src';
const SLASH = '/';
const DB_FRAG = 'db';
const READS_FRAG = 'reads';
const DB_DIR_PATH = SRC_FRAG + SLASH + DB_FRAG;
const READS_DIR_PATH = SRC_FRAG + SLASH + READS_FRAG;
const MOVING_DIR_RE = new RegExp(`(?:${DB_DIR_PATH}|${READS_DIR_PATH})(?![A-Za-z0-9_-])`);

// --- Scan set -----------------------------------------------------------------

const TEST_NODE_DIR = dashboardRoot('test', 'node');
const SCRIPTS_DIR = path.join(repoRoot, 'scripts');

/**
 * Top-level (non-recursive) file listing — `scripts/lib/` is deliberately
 * NOT walked; the resolver module itself legitimately contains
 * workspace-relative strings and is the one module allowed to.
 *
 * @param {string} dir
 * @param {(name: string) => boolean} nameFilter
 * @returns {string[]}
 */
function listTopLevelFiles(dir, nameFilter) {
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && nameFilter(entry.name))
		.map((entry) => path.join(dir, entry.name));
}

const TEST_NODE_FILES = listTopLevelFiles(TEST_NODE_DIR, (name) => name.endsWith('.test.mjs'));
const SCRIPTS_FILES = listTopLevelFiles(SCRIPTS_DIR, (name) => name.endsWith('.mjs'));
const SCAN_FILES = [...TEST_NODE_FILES, ...SCRIPTS_FILES];

// --- Comment stripping (line-count-preserving) ---------------------------------

/**
 * Strips block comments and line comments, keeping every line break so a
 * stripped line's 1-based index still matches the original file's line
 * number. The line-comment strip is guarded against a preceding `:` so it
 * does not eat the comment marker inside a URL such as `https://example.com`.
 *
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
	const noBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''));
	return noBlockComments
		.split('\n')
		.map((line) => {
			for (let i = 0; i < line.length - 1; i++) {
				if (line[i] === '/' && line[i + 1] === '/' && line[i - 1] !== ':') {
					return line.slice(0, i);
				}
			}
			return line;
		})
		.join('\n');
}

// --- Legitimate-occurrence exclusions -------------------------------------------

/** @param {string} line @returns {boolean} */
function isEsmSpecifierLine(line) {
	return /\bfrom\s+['"]/.test(line) || /\bimport\(/.test(line) || /\bnew URL\(/.test(line);
}

/**
 * Blanks the quoted description argument of a `test(...)` declaration,
 * leaving the rest of the line untouched — a real derivation elsewhere on
 * the same line would still be caught; only the description prose is
 * exempted.
 *
 * @param {string} line
 * @returns {string}
 */
function blankTestDescription(line) {
	const m = line.match(/^(\s*test\(\s*)(['"`])((?:\\.|(?!\2).)*)\2/);
	if (!m) return line;
	return line.slice(0, m[1].length) + m[2] + m[2] + line.slice(m[0].length);
}

/** @param {string} line @returns {boolean} */
function lineNamesMovingDir(line) {
	const candidate = blankTestDescription(line);
	if (!MOVING_DIR_RE.test(candidate)) return false;
	if (isEsmSpecifierLine(candidate)) return false;
	return true;
}

// --- Real scan ------------------------------------------------------------------

test('real scan: no dashboard tier-1 test or repo-root script hand-derives a path through either moving directory', () => {
	/** @type {string[]} */
	const offenders = [];
	for (const file of SCAN_FILES) {
		const strippedLines = stripComments(readFileSync(file, 'utf8')).split('\n');
		strippedLines.forEach((line, idx) => {
			if (lineNamesMovingDir(line)) {
				offenders.push(`${path.relative(repoRoot, file)}:${idx + 1}`);
			}
		});
	}
	assert.deepEqual(offenders, [], `hand-derived moving-directory path(s) found: ${offenders.join(', ')}`);
});

// --- Positive control -------------------------------------------------------------

test('positive control: the matcher fires on a synthetic fragment-assembled path.join(APP_ROOT, ...) line, never written to disk', () => {
	const dbFixture = path.join(dashboardRoot(), SRC_FRAG, DB_FRAG, '__moving-source-paths-positive-control__.js');
	const readsFixture = path.join(dashboardRoot(), SRC_FRAG, READS_FRAG, '__moving-source-paths-positive-control__.js');
	assert.match(dbFixture, MOVING_DIR_RE, 'positive control failed: the DB-directory fixture must match');
	assert.match(readsFixture, MOVING_DIR_RE, 'positive control failed: the reads-directory fixture must match');
	assert.equal(existsSync(dbFixture), false, 'the control fixture must never be written to disk');
	assert.equal(existsSync(readsFixture), false, 'the control fixture must never be written to disk');
});

// --- Inertness control -------------------------------------------------------------

test('inertness control: the matcher does not flag a benign derivation, a legitimate import specifier, or a test description', () => {
	const benignLine = "readFileSync(dashboardSrc('transport', 'tx.js'))";
	assert.doesNotMatch(benignLine, MOVING_DIR_RE, 'matcher is indiscriminate: it flagged a benign transport derivation');

	const syntheticImportLine = `import { openDb } from '../../${DB_DIR_PATH}/open-db.js';`;
	assert.ok(
		MOVING_DIR_RE.test(syntheticImportLine),
		'matcher precondition failed: the raw matcher must see the fragment before the exclusion is applied',
	);
	assert.equal(
		lineNamesMovingDir(syntheticImportLine),
		false,
		'the ESM-specifier exclusion failed to suppress a legitimate import line -- the matcher is blind, not discriminating',
	);

	const syntheticTestNameLine = `test('no module outside panels imports from ${READS_DIR_PATH}/', () => {`;
	assert.ok(
		MOVING_DIR_RE.test(syntheticTestNameLine),
		'matcher precondition failed: the raw matcher must see the fragment before the exclusion is applied',
	);
	assert.equal(
		lineNamesMovingDir(syntheticTestNameLine),
		false,
		'the test-description exclusion failed to suppress a legitimate test name -- the matcher is blind, not discriminating',
	);
});

// --- Reachability -------------------------------------------------------------------

test('reachability: the walk reaches at least 25 .mjs files across both roots', () => {
	assert.ok(
		SCAN_FILES.length >= 25,
		`the walk reached only ${SCAN_FILES.length} files -- a scan that reaches nothing proves nothing about either root`,
	);
});
