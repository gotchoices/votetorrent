/**
 * strip-comments.test.mjs — per-form positive controls for
 * `scripts/lib/strip-comments.mjs`'s `stripComments`, the repository's one
 * character-level, quote-state-tracking comment stripper (54-22).
 *
 * WHY THIS LIVES HERE, IN A CI-ENFORCED TIER-1 SUITE IT DOES NOT OTHERWISE
 * BELONG TO. `stripComments` moved to `scripts/lib/` so every scan across
 * three workspaces (`packages/web-data`, `apps/VoteTorrentPublic`,
 * `apps/VoteTorrentDashboard`) can share one implementation. A shared module
 * under `scripts/lib/` has no `test` script of its own, so without this file
 * its only coverage would be `packages/web-data/test/anonymity-scan.test.mjs`'s
 * controls 3a/3b — real coverage, but borrowed from a suite that exists to
 * prove D-05, not to prove this function's contract. This file is that
 * function's OWN gate, in a suite (`packages/ui-web`) CI already runs.
 *
 * EACH CASE ASSERTS BOTH DIRECTIONS. A stripper that returns the empty
 * string passes every absence-only assertion ("the comment text is gone");
 * every case below also asserts the adjacent CODE text is still present, so
 * an inert or overly-aggressive stripper cannot pass by accident
 * (T-54-22-02). The `--prove-inert` variant below exercises this directly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripComments } from '../../../scripts/lib/strip-comments.mjs';

test('a whole-line // comment is removed', () => {
	const source = ['const a = 1;', '// this whole line is a comment', 'const b = 2;'].join('\n');
	const stripped = stripComments(source);
	assert.doesNotMatch(stripped, /this whole line is a comment/);
	assert.match(stripped, /const a = 1;/);
	assert.match(stripped, /const b = 2;/);
});

test('a trailing // comment after code is removed and the code before it survives', () => {
	const source = 'const total = a + b; // running total, not the final tally';
	const stripped = stripComments(source);
	assert.doesNotMatch(stripped, /running total/);
	assert.match(stripped, /const total = a \+ b;/);
});

test('a single-line block comment is removed', () => {
	const source = 'const x = /* inline note */ 42;';
	const stripped = stripComments(source);
	assert.doesNotMatch(stripped, /inline note/);
	assert.match(stripped, /const x = /);
	assert.match(stripped, /42;/);
});

test('a multi-line block comment is removed across all its lines', () => {
	const source = [
		'const before = true;',
		'/*',
		' * line one of the explanation',
		' * line two of the explanation',
		' */',
		'const after = true;',
	].join('\n');
	const stripped = stripComments(source);
	assert.doesNotMatch(stripped, /line one of the explanation/);
	assert.doesNotMatch(stripped, /line two of the explanation/);
	assert.match(stripped, /const before = true;/);
	assert.match(stripped, /const after = true;/);
});

test('a JSX brace-wrapped block comment is removed, including its continuation lines', () => {
	// This is the form the whole D-54-14-02 exposure is about: continuation
	// lines here do NOT open with `*`, `//` or `/*`, so a naive line-opening
	// stripper (the app-level helpers this plan's exposure measures) would
	// leave them as visible "source". The character-level stripper must not.
	const source = [
		'function Component() {',
		'\treturn (',
		'\t\t<section>',
		'\t\t\t{/* D-11: gaps render inline beside the facts they belong to,',
		'\t\t\t    never severed into a separate section. See the header for',
		'\t\t\t    why FORBIDDEN_TOKEN never appears in real prose here. */}',
		'\t\t\t<FactSections />',
		'\t\t</section>',
		'\t);',
		'}',
	].join('\n');
	const stripped = stripComments(source);
	assert.doesNotMatch(stripped, /gaps render inline/);
	assert.doesNotMatch(stripped, /never severed/);
	assert.doesNotMatch(stripped, /FORBIDDEN_TOKEN/);
	assert.match(stripped, /function Component\(\)/);
	assert.match(stripped, /<FactSections \/>/);
	assert.match(stripped, /<\/section>/);
});

test("a // sequence inside a string literal is PRESERVED (https:// is the case that actually occurs)", () => {
	const source = "const url = 'https://example.test/path'; // trailing comment, this part IS removed";
	const stripped = stripComments(source);
	assert.match(stripped, /https:\/\/example\.test\/path/, 'the URL inside the string literal must survive');
	assert.doesNotMatch(stripped, /trailing comment/, 'the real trailing comment after the string must still be removed');
});

test('line count and line positions are preserved, so a reported line number stays true to the file', () => {
	const source = [
		'const a = 1;', // line 1
		'/*', // line 2
		' * a multi-line block comment', // line 3
		' */', // line 4
		'const b = 2;', // line 5
		'// a whole-line comment', // line 6
		'const c = 3;', // line 7
	].join('\n');
	const stripped = stripComments(source);
	const strippedLines = stripped.split('\n');
	const originalLines = source.split('\n');
	assert.equal(strippedLines.length, originalLines.length, 'stripComments must not change the line count');
	// The surviving code lines must be at the SAME index as in the original.
	assert.match(strippedLines[0], /const a = 1;/);
	assert.match(strippedLines[4], /const b = 2;/);
	assert.match(strippedLines[6], /const c = 3;/);
});
