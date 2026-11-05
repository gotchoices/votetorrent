/**
 * three-bucket-absent.test.mjs — D-07's zero-occurrence scan: the function
 * spike 086 used to map the four-phase model back onto this repo's old
 * three-bucket vocabulary has zero occurrences of its own name anywhere in
 * product code under `apps/` and `packages/`, while surviving exactly once
 * in comment form (its audit trail) in `election-phase.js`'s header. THIS
 * FILE NEVER SPELLS THAT NAME OUT LITERALLY EITHER -- see below.
 *
 * The hunted identifier is never written as a literal ANYWHERE in this
 * file — it is assembled at runtime by joining two fragments and matched
 * with a `\b`-anchored `RegExp` built from that value. This is not
 * decoration: this file lives under one of the two roots it scans, and the
 * failure it exists to prevent — a checker whose own source contains the
 * pattern it greps for, and which is therefore PERMANENTLY GREEN — has
 * recurred three times in this repo (Phase 53). Case 6 below asserts this
 * file's own source contains zero occurrences of the assembled identifier,
 * structurally, not merely by convention.
 *
 * Scan roots: `workspacePath('apps')` and `workspacePath('packages')`,
 * skipping `node_modules`/`dist`/`dist-gate`/`build`/`coverage`/`.git` and
 * any `test`/`__tests__` directory. Test files legitimately NAME this
 * identifier in matchers (`election-shell.test.mjs`'s `PHASE_54_FORBIDDEN_RE`
 * still does, until 54-10 retires it) — scanning them would make this check
 * permanently red for the wrong reason. D-07's claim is about PRODUCT CODE,
 * and the exclusion is what makes the claim precise rather than what makes
 * it pass.
 *
 * Comment stripping reads source through `scripts/lib/strip-comments.mjs`'s
 * shared, character-level, quote-state-tracking `stripComments` (54-23) —
 * the same implementation every other migrated scan in this group now uses.
 * It strips block comments, whole comment LINES, AND a trailing same-line
 * `//` comment, while correctly preserving a `//` sequence inside a string
 * or URL literal (proven by its own per-form controls in
 * `strip-comments.test.mjs`). This file's PRIOR local implementation
 * deliberately left a trailing `//` comment unstripped, reasoning that a
 * naive (non-quote-aware) trailing-comment stripper risked deleting real
 * code inside a string. The shared stripper does not carry that risk — it
 * tracks quote state per line — so that risk no longer applies here.
 * Over-reporting is still the correct failure direction for a
 * zero-occurrence scan; the shared stripper does not change that, it only
 * changes which lines are recognised as comment in the first place. See
 * 54-23-SUMMARY.md for the measured before/after receipt.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { workspacePath, uiWebRoot, uiWebSrc } from '../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../scripts/lib/strip-comments.mjs';

/**
 * The hunted identifier, assembled at runtime from two fragments — never a
 * literal in this file's own source (see this file's header).
 * @type {string}
 */
const HUNTED_IDENTIFIER = ['three', 'Bucket'].join('');

/** `\b`-anchored matcher built from the runtime-assembled identifier. @type {RegExp} */
const HUNTED_RE = new RegExp(`\\b${HUNTED_IDENTIFIER}\\b`);

const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', 'dist-gate', 'build', 'coverage', '.git', 'test', '__tests__']);

/** Extensions this scan reads. @type {ReadonlySet<string>} */
const SCANNED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']);

/**
 * Walk `dir`, skipping `SKIP_DIR_NAMES` directories, returning every file
 * whose extension is in `SCANNED_EXTENSIONS`.
 * @param {string} dir
 * @returns {string[]}
 */
function walkScannable(dir) {
	/** @type {string[]} */
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (SKIP_DIR_NAMES.has(entry.name)) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkScannable(full));
		} else if (SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
			out.push(full);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// 1. The real check.
// ---------------------------------------------------------------------------

test('the D-07-dropped identifier has zero occurrences under apps/ and packages/ (product code only, test/__tests__ excluded), visiting more than 200 files including election-phase.js', () => {
	const roots = [workspacePath('apps'), workspacePath('packages')];
	/** @type {string[]} */
	const visited = [];
	/** @type {string[]} */
	const offenders = [];
	for (const root of roots) {
		for (const file of walkScannable(root)) {
			visited.push(file);
			const stripped = stripComments(readFileSync(file, 'utf8'));
			if (HUNTED_RE.test(stripped)) offenders.push(file);
		}
	}

	assert.deepEqual(offenders, [], `these files still reach the identifier D-07 requires dropped: ${offenders.join(', ')}`);

	// Anti-vacuity: a walker that reaches no file passes a zero-occurrence
	// check silently. Both roots are real and the walk is not trivially empty.
	assert.ok(visited.length > 200, `expected to visit more than 200 files, visited ${visited.length}`);
	assert.ok(
		visited.includes(uiWebSrc('lifecycle', 'election-phase.js')),
		'expected the real check to visit election-phase.js -- the single file 086 was lifted into, and therefore the one place a carried occurrence of the dropped identifier would most plausibly have landed',
	);
});

// ---------------------------------------------------------------------------
// 2. Matcher control.
// ---------------------------------------------------------------------------

test('matcher control: the runtime-assembled matcher fires on a planted occurrence', () => {
	const planted = `export function ${HUNTED_IDENTIFIER}(phase) {\n\treturn phase;\n}`;
	assert.match(planted, HUNTED_RE);
});

// ---------------------------------------------------------------------------
// 3. Walker control, on disk.
// ---------------------------------------------------------------------------

test('walker control: a planted on-disk occurrence is found by the same walk-and-match routine (a regex-only control cannot prove the walker reaches files at all)', () => {
	const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'three-bucket-walker-control-'));
	try {
		const plantedFile = path.join(tmpDir, 'Planted.js');
		writeFileSync(plantedFile, `export function ${HUNTED_IDENTIFIER}(phase) {\n\treturn phase;\n}`);
		writeFileSync(path.join(tmpDir, 'Clean.js'), 'export function clean(phase) {\n\treturn phase;\n}');

		/** @type {string[]} */
		const offenders = [];
		for (const file of walkScannable(tmpDir)) {
			const stripped = stripComments(readFileSync(file, 'utf8'));
			if (HUNTED_RE.test(stripped)) offenders.push(file);
		}
		assert.deepEqual(offenders, [plantedFile], `expected exactly the one planted file to be reported, got: ${offenders.join(', ')}`);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// 4. Comment-stripping control, in both directions.
// ---------------------------------------------------------------------------

test('comment-stripping control: an occurrence confined to comments is NOT reported, and an occurrence on a bare code line IS (the anti-vacuity half)', () => {
	const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'three-bucket-comment-control-'));
	try {
		const commentOnlyFile = path.join(tmpDir, 'CommentOnly.js');
		writeFileSync(
			commentOnlyFile,
			`// this file discusses ${HUNTED_IDENTIFIER}() only in prose\n` +
				`/* ${HUNTED_IDENTIFIER}() was dropped -- see D-07 */\n` +
				`export function clean(phase) {\n\treturn phase;\n}\n`,
		);
		const codeLineFile = path.join(tmpDir, 'CodeLine.js');
		writeFileSync(codeLineFile, `export function ${HUNTED_IDENTIFIER}(phase) {\n\treturn phase;\n}`);

		/** @type {string[]} */
		const offenders = [];
		for (const file of walkScannable(tmpDir)) {
			const stripped = stripComments(readFileSync(file, 'utf8'));
			if (HUNTED_RE.test(stripped)) offenders.push(file);
		}
		assert.deepEqual(offenders, [codeLineFile], `expected only the bare-code-line file to be reported, got: ${offenders.join(', ')}`);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// 5. The audit trail survives (contract C5).
// ---------------------------------------------------------------------------

test('the audit trail survives: election-phase.js contains the identifier at least once RAW (in its D-07 deviation-(a) audit-trail paragraph), and zero times after comment-stripping (D-07\'s audit trail, not the code)', () => {
	// Contract C5 (54-05-PLAN.md) states 54-02 keeps "one mention". The
	// landed header's deviation-(a) paragraph in fact names the identifier
	// TWICE within that single coherent explanation (once naming the
	// function, once naming the bare word two sentences later) -- read off
	// the landed file per C5's own instruction rather than hard-pinned to
	// the plan's assumed count, since what matters for D-07 is that the
	// audit trail EXISTS (raw >= 1) and that the CODE itself carries none of
	// it (stripped === 0).
	const electionPhasePath = uiWebSrc('lifecycle', 'election-phase.js');
	const raw = readFileSync(electionPhasePath, 'utf8');
	const rawMatches = raw.match(new RegExp(HUNTED_IDENTIFIER, 'g')) ?? [];
	const strippedMatches = stripComments(raw).match(new RegExp(HUNTED_IDENTIFIER, 'g')) ?? [];

	assert.ok(
		rawMatches.length >= 1,
		'the header sentence(s) explaining why the identifier was dropped are D-07\'s audit trail and must not be deleted to make this scan pass -- ' +
			'deleting them is what would let someone re-add the function unnoticed. ' +
			`(54-07 edited this same file to delete the one-wave bridge alias; this case is the standing guard that the audit trail was not carried away with it, and it held.) got ${rawMatches.length} raw occurrence(s)`,
	);
	assert.equal(strippedMatches.length, 0, `expected zero occurrences once comments are stripped (the code itself must not carry the identifier), got ${strippedMatches.length}`);
});

// ---------------------------------------------------------------------------
// 6. Self-trip guard.
// ---------------------------------------------------------------------------

test('self-trip guard: this file\'s own source contains zero occurrences of the assembled identifier', () => {
	const ownSource = readFileSync(uiWebRoot('test', 'three-bucket-absent.test.mjs'), 'utf8');
	const matches = ownSource.match(new RegExp(HUNTED_IDENTIFIER, 'g')) ?? [];
	assert.equal(matches.length, 0, `this checker's own source must never contain the literal identifier it hunts, found ${matches.length} occurrence(s)`);
});
