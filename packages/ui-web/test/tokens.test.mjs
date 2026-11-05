/**
 * tokens.test.mjs — tier-1 proof that `packages/ui-web/src/tokens.css` (D-15) is both
 * correct (34 declarations: the 31 moved verbatim, in order, with their exact
 * values, plus the done tone's colour token added by 54-09, plus the two
 * chart series tokens added by 60-01/D-14) and
 * machine-enumerable (D-23's probe reads names AND values straight out of this one
 * file, so there must be no second list anywhere to drift against it).
 *
 * Every matcher below is positive-control-first: shown firing on a planted fixture
 * and NOT firing on a benign fixture, before it is trusted against the real file.
 * Two vacuous checks were caught during this phase's spikes, one of which passed on
 * a completely dead page — this discipline is not optional here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { uiWebSrc } from '../../../scripts/lib/source-paths.mjs';

const TOKENS_CSS_PATH = uiWebSrc('tokens.css');
const RAW = readFileSync(TOKENS_CSS_PATH, 'utf8');

/** Matches exactly one tab-indented custom-property declaration per line — the shape
 * the interface_contract requires of every line inside the :root block.
 * @type {RegExp} */
const DECLARATION_RE = /^\t--[a-z0-9-]+: .+;$/gm;

/** Line-based comment stripper, same shape as `election-ops-panels.test.mjs`'s
 * `stripComments` idiom: drop any line whose trimmed form starts a `/*`, `*` or `//`
 * comment marker.
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
	return source
		.split('\n')
		.filter((line) => {
			const trimmed = line.trim();
			return !(trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('//'));
		})
		.join('\n');
}

const STRIPPED = stripComments(RAW);

/** Removes every full `/* ... *\/` region (across lines), unlike the line-based
 * `stripComments` above which only drops a line whose OWN trimmed form opens a
 * comment marker. Case 4 needs this block-aware form: a "commented-out" declaration
 * sitting on an unprefixed line inside a `/* ... *\/` block (no leading `*` of its
 * own) is invisible to the line-based stripper — it never starts with a marker — so
 * comparing raw-vs-line-stripped counts could never catch it. Block removal is what
 * makes the "no second list to drift" comparison meaningful rather than vacuously
 * true.
 * @param {string} source
 * @returns {string}
 */
function stripBlockComments(source) {
	return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

const EXPECTED_NAMES = [
	'--bg',
	'--surface',
	'--surface2',
	'--border',
	'--text',
	'--muted',
	'--primary',
	'--ok',
	'--warn',
	'--fail',
	'--done',
	'--chart-series-1',
	'--chart-series-2',
	'--radius',
	'--space-xs',
	'--space-sm',
	'--space-md',
	'--space-lg',
	'--space-xl',
	'--space-2xl',
	'--space-3xl',
	'--font-body-size',
	'--font-body-weight',
	'--font-body-line-height',
	'--font-label-size',
	'--font-label-weight',
	'--font-label-line-height',
	'--font-heading-size',
	'--font-heading-weight',
	'--font-heading-line-height',
	'--font-display-size',
	'--font-display-weight',
	'--font-display-line-height',
	'--font-family',
];

/** @type {Record<string, string>} */
const EXPECTED_VALUES = {
	'--bg': '#0d0f14',
	'--surface': '#151922',
	'--surface2': '#1b202b',
	'--border': '#2a3040',
	'--text': '#e9ecf2',
	'--muted': '#8d97a8',
	'--primary': '#3b82f6',
	'--ok': '#22c55e',
	'--warn': '#f59e0b',
	'--fail': '#ef4444',
	'--done': '#64748b',
	'--chart-series-1': '#3987e5',
	'--chart-series-2': '#d95926',
	'--radius': '10px',
	'--space-xs': '4px',
	'--space-sm': '8px',
	'--space-md': '16px',
	'--space-lg': '24px',
	'--space-xl': '32px',
	'--space-2xl': '48px',
	'--space-3xl': '64px',
	'--font-body-size': '14px',
	'--font-body-weight': '400',
	'--font-body-line-height': '1.5',
	'--font-label-size': '12px',
	'--font-label-weight': '400',
	'--font-label-line-height': '1.4',
	'--font-heading-size': '16px',
	'--font-heading-weight': '600',
	'--font-heading-line-height': '1.2',
	'--font-display-size': '20px',
	'--font-display-weight': '600',
	'--font-display-line-height': '1.2',
	'--font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
};

/** @param {string} source @returns {Array<{ name: string, value: string }>} */
function extractDeclarations(source) {
	const matches = [...source.matchAll(/^\t(--[a-z0-9-]+): (.+);$/gm)];
	return matches.map((m) => ({ name: m[1], value: m[2] }));
}

// --- Case 1: positive control + benign control ------------------------------------

test('positive control: the declaration matcher fires on a planted tab-indented declaration', () => {
	const fixture = ':root {\n\t--fixture-token: 1px;\n}\n';
	const hits = [...fixture.matchAll(DECLARATION_RE)];
	assert.equal(hits.length, 1);
	assert.equal(hits[0][0], '\t--fixture-token: 1px;');
});

test('benign control: the declaration matcher does not fire on a rule with no custom property', () => {
	const fixture = '.layout {\n\tdisplay: grid;\n\tgap: var(--space-md);\n}\n';
	const hits = [...fixture.matchAll(DECLARATION_RE)];
	assert.equal(hits.length, 0);
});

// --- Case 2: total enumeration (order AND totality) --------------------------------

test('tokens.css declares exactly the 34 expected names, in the expected order', () => {
	const names = extractDeclarations(RAW).map((d) => d.name);
	assert.deepEqual(names, EXPECTED_NAMES);
});

// --- Case 3: verbatim values --------------------------------------------------------

test('every one of the 34 name/value pairs matches the literal expected map exactly', () => {
	const declarations = extractDeclarations(RAW);
	assert.equal(declarations.length, 34);
	for (const { name, value } of declarations) {
		assert.equal(value, EXPECTED_VALUES[name], `unexpected value for ${name}`);
	}
	// The font stack is the one value with commas, spaces and a quoted segment —
	// pinned in full so no naive split(',') enumerator could silently pass here.
	assert.equal(
		EXPECTED_VALUES['--font-family'],
		'-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
	);
});

// --- Case 4: no second list to drift -------------------------------------------------

test('the declaration matcher hit count on the raw file equals the count on the block-comment-stripped file, both 34', () => {
	const rawCount = [...RAW.matchAll(DECLARATION_RE)].length;
	const strippedCount = [...stripBlockComments(RAW).matchAll(DECLARATION_RE)].length;
	assert.equal(rawCount, 34);
	assert.equal(strippedCount, 34);
	assert.equal(rawCount, strippedCount);
});

test('control: a fixture with a declaration-shaped line INSIDE an unprefixed comment block makes the raw/stripped counts differ', () => {
	// A "commented-out" declaration on its own line, with no leading `*` of its own,
	// is exactly the class of drift a naive per-line stripper would miss (it never
	// starts with a comment marker after trim). Full block removal is what catches it.
	const fixture = ':root {\n\t--real-token: 1px;\n}\n/*\n\t--phantom-token: 2px;\n*/\n';
	const rawCount = [...fixture.matchAll(DECLARATION_RE)].length;
	const strippedCount = [...stripBlockComments(fixture).matchAll(DECLARATION_RE)].length;
	assert.equal(rawCount, 2);
	assert.equal(strippedCount, 1);
	assert.notEqual(rawCount, strippedCount, 'expected the paired count to differ on this planted fixture');
});

// --- Case 5: no comment inside :root -------------------------------------------------

test(':root block contains zero `/*` occurrences', () => {
	const match = RAW.match(/:root \{([\s\S]*?)\n\}/);
	assert.ok(match, 'expected to find a :root { ... } block');
	assert.doesNotMatch(match[1], /\/\*/);
});

test('control: the same slicing logic DOES find `/*` in a fixture that has one', () => {
	const fixture = ':root {\n\t/* a comment */\n\t--x: 1px;\n}\n';
	const match = fixture.match(/:root \{([\s\S]*?)\n\}/);
	assert.ok(match);
	assert.match(match[1], /\/\*/);
});

// --- Case 6: base/reset present -------------------------------------------------------

test('the comment-stripped file carries the four base/reset selectors', () => {
	assert.match(STRIPPED, /#root/);
	assert.match(STRIPPED, /^body\s*\{/m);
	assert.match(STRIPPED, /:focus-visible/);
	assert.match(STRIPPED, /a\[role="button"\]/);
});
