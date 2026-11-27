/**
 * app-css-split.test.mjs — tier-1 proof that the dashboard's own `app.css` (D-15) is
 * token-free after the 53-03 split: it declares no custom property and no `:root`
 * block, it still carries its own layout primitives, and it opens with the canonical
 * `@import '@votetorrent/ui-web/tokens.css';` in the position a CSS `@import` requires
 * to actually take effect.
 *
 * This file merely READS the source tree (D-25), so it stays with the dashboard and
 * is repointed through the 53-01 resolver rather than re-deriving its own root.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dashboardSrc } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';

const APP_CSS_PATH = dashboardSrc('app.css');
const RAW = readFileSync(APP_CSS_PATH, 'utf8');

/** Matches a tab-indented custom-property DECLARATION only — never a `var(--x)`
 * reference, which `app.css` legitimately still contains inside `.layout` and
 * `.panel-grid`. A matcher that could not tell a declaration from a reference would
 * false-fail this whole file.
 * @type {RegExp} */
const DECLARATION_RE = /^\t--[a-z0-9-]+: .+;$/gm;

const STRIPPED = stripComments(RAW);

// --- Case 1: positive control + benign control -------------------------------------

test('positive control: the declaration matcher fires on a planted :root block with a declaration', () => {
	const fixture = ':root {\n\t--x: 1px;\n}\n';
	assert.match(fixture, /:root\s*\{/);
	const hits = [...fixture.matchAll(DECLARATION_RE)];
	assert.equal(hits.length, 1);
});

test('benign control: the declaration matcher does NOT fire on a rule that only REFERENCES a token via var(--...)', () => {
	// This is the exact shape .layout/.panel-grid legitimately keep after the split —
	// a matcher blind to the reference/declaration distinction would false-fail app.css.
	const fixture = '.layout {\n\tgap: var(--space-md);\n\tpadding: var(--space-md);\n}\n';
	const hits = [...fixture.matchAll(DECLARATION_RE)];
	assert.equal(hits.length, 0);
});

// --- Case 2: no declarations left behind ---------------------------------------------

test('app.css contains zero :root blocks after the split', () => {
	assert.doesNotMatch(STRIPPED, /:root\s*\{/);
});

test('app.css contains zero custom-property DECLARATIONS after the split (references via var(--...) are expected and must pass)', () => {
	const hits = [...STRIPPED.matchAll(DECLARATION_RE)];
	assert.equal(hits.length, 0);
	// Positive proof this file still legitimately REFERENCES tokens (the split moved
	// declarations, not usage) — a file with zero var(--...) references at all would
	// mean the layout rules themselves went missing, which case 4 below also guards.
	assert.match(STRIPPED, /var\(--space-md\)/);
});

// --- Case 3: the canonical import, and its position -----------------------------------

/** The first line whose comment-stripped form is non-blank, read back from the
 * ORIGINAL (unstripped) source at the same line index -- `stripComments`
 * preserves line count and position, so this never needs its own line-opening
 * classification.
 * @param {string} source @returns {string | undefined} */
function firstContentLineOf(source) {
	const original = source.split('\n');
	const stripped = stripComments(source).split('\n');
	for (let i = 0; i < stripped.length; i += 1) {
		if (stripped[i].trim() !== '') return original[i].trim();
	}
	return undefined;
}

test('the first non-comment, non-blank line of app.css is exactly the canonical @import', () => {
	assert.equal(firstContentLineOf(RAW), "@import '@votetorrent/ui-web/tokens.css';");
});

test('control: the @import position check would fail if the import were absent entirely', () => {
	const fixtureWithoutImport = '/* header */\n\n.layout {\n\tdisplay: grid;\n}\n';
	assert.notEqual(firstContentLineOf(fixtureWithoutImport), "@import '@votetorrent/ui-web/tokens.css';");
});

// --- Case 4: layout stayed --------------------------------------------------------------

test('app.css still contains .layout, the 900px collapse, and .panel-grid', () => {
	assert.match(STRIPPED, /\.layout\s*\{/);
	assert.match(STRIPPED, /@media\s*\(max-width:\s*900px\)/);
	assert.match(STRIPPED, /\.panel-grid\s*\{/);
});
