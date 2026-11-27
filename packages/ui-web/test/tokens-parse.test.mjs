/**
 * tokens-parse.test.mjs — unit test for `scripts/lib/tokens.mjs` (D-23).
 *
 * Positive-control-first per the repo's house style: a parser that cannot
 * detect a planted defect proves nothing. Every case below either exercises
 * the REAL `packages/ui-web/src/tokens.css`, or a small inline fixture that
 * plants exactly the shape a guard exists to catch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseTokensCss, normaliseTokenValue, compareToken, hexToRgb, BASE_RULE_CHECKS } from '../scripts/lib/tokens.mjs';

const REAL_TOKENS_CSS_URL = new URL('../src/tokens.css', import.meta.url);
const realSource = readFileSync(REAL_TOKENS_CSS_URL, 'utf8');

test('(1) the real tokens.css: tokens.size > 0, equals rootDeclarationLineCount, and hasRegisteredProperty is false', () => {
	const { tokens, rootDeclarationLineCount, hasRegisteredProperty } = parseTokensCss(realSource);
	assert.ok(tokens.size > 0, 'must parse at least one token out of the real file');
	assert.equal(tokens.size, rootDeclarationLineCount, 'the two independent counts must agree on the real file');
	assert.equal(hasRegisteredProperty, false);
});

test('(2) group comments inside :root, and the leading file-header comment, are not parsed as declarations', () => {
	const fixture = `
/* file header talks about --not-a-token: 10px; right here */
:root {
	/* group comment: --also-not-a-token: 5px; */
	--real-token: 1px;
}
`;
	const { tokens } = parseTokensCss(fixture);
	assert.equal(tokens.size, 1);
	assert.equal(tokens.get('--real-token'), '1px');
	assert.equal(tokens.has('--not-a-token'), false);
	assert.equal(tokens.has('--also-not-a-token'), false);
});

test('(3) --font-family\'s value round-trips with its quoted family name and commas intact', () => {
	const { tokens } = parseTokensCss(realSource);
	const family = tokens.get('--font-family');
	assert.ok(family, '--font-family must be present');
	assert.match(family, /"Segoe UI"/);
	assert.ok(family.includes(','), 'the comma-separated font stack must survive verbatim');
});

test('(4) compareToken returns passed:false for a missing value (\'\' against a declared value) — the "token missing" half', () => {
	const { passed } = compareToken('#0d0f14', '');
	assert.equal(passed, false);
});

test('(5) compareToken returns passed:false for a one-character difference in a declared hex value — the "token resolving to something else" half', () => {
	const { passed } = compareToken('#0d0f14', '#0d0f15');
	assert.equal(passed, false);
});

test('(6) compareToken returns passed:true across a pure whitespace difference, proving the normaliser does what it claims and nothing more', () => {
	const { passed } = compareToken('-apple-system,  BlinkMacSystemFont', '-apple-system, BlinkMacSystemFont');
	assert.equal(passed, true);
});

test('(6b) normaliseTokenValue cannot make an absent token equal a non-empty one, or a differing hex equal another', () => {
	assert.notEqual(normaliseTokenValue(''), normaliseTokenValue('#0d0f14'));
	assert.notEqual(normaliseTokenValue('#0d0f14'), normaliseTokenValue('#0d0f15'));
});

test('(7) a fixture source with an empty :root parses to tokens.size === 0 (feeds guard (a))', () => {
	const fixture = `:root {\n}\n`;
	const { tokens } = parseTokensCss(fixture);
	assert.equal(tokens.size, 0);
});

test('(8) a fixture whose :root declares three tokens but whose independent line count is forced to disagree (two declarations sharing one line) is detected by guard (b)', () => {
	const fixture = `
:root {
	--a: 1px;
	--b: 2px; --c: 3px;
}
`;
	const { tokens, rootDeclarationLineCount } = parseTokensCss(fixture);
	assert.equal(tokens.size, 3, 'the declaration regex must still find all three values');
	assert.notEqual(
		rootDeclarationLineCount,
		tokens.size,
		'the independent line-count regex must disagree when two declarations share one line',
	);
});

test('(9) hexToRgb(\'#0d0f14\') is \'rgb(13, 15, 20)\' and hexToRgb(\'rebeccapurple\') throws', () => {
	assert.equal(hexToRgb('#0d0f14'), 'rgb(13, 15, 20)');
	assert.throws(() => hexToRgb('rebeccapurple'));
});

test('(9b) hexToRgb expands the 3-digit shorthand form', () => {
	assert.equal(hexToRgb('#0f0'), 'rgb(0, 255, 0)');
});

test('(10) every BASE_RULE_CHECKS entry\'s token exists in the real tokens.css', () => {
	const { tokens } = parseTokensCss(realSource);
	for (const check of BASE_RULE_CHECKS) {
		assert.ok(
			tokens.has(check.token),
			`BASE_RULE_CHECKS entry "${check.id}" names token "${check.token}", which is not declared in the real tokens.css`,
		);
	}
});

test('(11) the real tokens.css\'s body rule is captured separately from :root, and is not itself mistaken for :root', () => {
	const { bodyRule } = parseTokensCss(realSource);
	assert.equal(bodyRule.get('background'), 'var(--bg)');
	assert.equal(bodyRule.get('color'), 'var(--text)');
});

test('(12) hasRegisteredProperty is true when the source contains an @property at-rule', () => {
	const fixture = `
@property --foo {
	syntax: '<color>';
	inherits: true;
	initial-value: #000;
}
:root {
	--bar: 1px;
}
`;
	const { hasRegisteredProperty } = parseTokensCss(fixture);
	assert.equal(hasRegisteredProperty, true);
});
