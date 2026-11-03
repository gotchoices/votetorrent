/**
 * live-hooks.test.mjs -- tier-1 rows for the live-panel foundation in
 * `src/live/` (data-version context, coarse clock, action note, change
 * marks) and the panel chrome that threads it.
 *
 * Behaviour runs the REAL `.ts` modules in ONE child process: Node's
 * built-in type stripping plus a tiny resolve hook that maps a relative
 * `./x.js` import from a `.ts` file to its `.ts` sibling (the same mapping
 * the bundler does). Hooks render through `react-dom/server`, which runs no
 * effects, so these rows prove first-render and no-provider behaviour; the
 * pure cores carry the rest. Nothing is installed for this: no DOM
 * emulation, no testing library.
 *
 * Structure runs as comment-stripped source and CSS scans, each matcher
 * proven against a synthetic fixture first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dashboardRoot, dashboardSrc, moduleUrl } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';
import { stripCssComments } from '../../../../scripts/lib/css-class-coverage.mjs';
import { COPY } from '@votetorrent/ui-web';

/** @type {any} */
const changeMarks = await import(moduleUrl(dashboardSrc('live', 'change-marks.js')));

/** Module URLs the child process imports. */
const MODULE_URLS = {
	dataVersion: moduleUrl(dashboardSrc('live', 'DataVersionContext.ts')),
	useNow: moduleUrl(dashboardSrc('live', 'useNow.ts')),
};

// --- behaviour harness --------------------------------------------------------

/** Maps `./x.js` imported from a `.ts` file to `./x.ts` when only the `.ts` exists. */
const LOADER = [
	"import { existsSync } from 'node:fs';",
	"import { fileURLToPath } from 'node:url';",
	'export async function resolve(specifier, context, next) {',
	"\tconst relative = specifier.startsWith('./') || specifier.startsWith('../');",
	"\tconst fromTs = typeof context.parentURL === 'string' && context.parentURL.endsWith('.ts');",
	"\tif (relative && fromTs && specifier.endsWith('.js')) {",
	'\t\tconst jsUrl = new URL(specifier, context.parentURL);',
	'\t\tif (!existsSync(fileURLToPath(jsUrl))) {',
	"\t\t\tconst tsUrl = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);",
	'\t\t\tif (existsSync(fileURLToPath(tsUrl))) return next(tsUrl.href, context);',
	'\t\t}',
	'\t}',
	'\treturn next(specifier, context);',
	'}',
].join('\n');

const REGISTER = [
	"import { register } from 'node:module';",
	`register(${JSON.stringify('data:text/javascript,' + encodeURIComponent(LOADER))});`,
].join('\n');

/** Shared prelude: imports, the row recorder, and the module map. */
const HARNESS_PRELUDE = [
	`const M = ${JSON.stringify(MODULE_URLS)};`,
	'const rows = {};',
	'async function row(name, fn) {',
	'\ttry { rows[name] = await fn(); }',
	"\tcatch (err) { rows[name] = { thrown: { name: (err && err.name) || 'Error', message: String((err && err.message) || '') } }; }",
	'}',
	"const { createElement, useContext } = await import('react');",
	"const { renderToStaticMarkup } = await import('react-dom/server');",
	"const ui = await import('@votetorrent/ui-web');",
	'const sorted = (s) => [...s].sort();',
].join('\n');

/** Task 1 rows: data version, touchesTables, the clock. */
const HARNESS_FOUNDATION = [
	'const dv = await import(M.dataVersion);',
	'const nowMod = await import(M.useNow);',
	"await row('defaultVersion', () => ({",
	'\tfrozen: Object.isFrozen(dv.DEFAULT_DATA_VERSION),',
	'\tversion: dv.DEFAULT_DATA_VERSION.version,',
	'\tisSet: dv.DEFAULT_DATA_VERSION.changedTables instanceof Set,',
	'\ttables: sorted(dv.DEFAULT_DATA_VERSION.changedTables),',
	'\tmarkEligible: dv.DEFAULT_DATA_VERSION.markEligible,',
	'\tkeys: Object.keys(dv.DEFAULT_DATA_VERSION).sort(),',
	"\tdisplayName: dv.DataVersionContext.displayName,",
	'}));',
	'function Reader() {',
	'\tconst v = useContext(dv.DataVersionContext);',
	'\tconst h = dv.useDataVersion();',
	"\treturn createElement('span', null, [v.version, v.changedTables.size, v.markEligible, h === v].join('/'));",
	'}',
	"await row('consumerNoProvider', () => renderToStaticMarkup(createElement(Reader)));",
	"await row('consumerWithProvider', () => renderToStaticMarkup(createElement(dv.DataVersionContext.Provider, { value: { version: 3, changedTables: new Set(['Election']), markEligible: true } }, createElement(Reader))));",
	"await row('touchesTables', () => [",
	"\tdv.touchesTables(new Set(), ['A']),",
	"\tdv.touchesTables(new Set(['A']), ['A', 'B']),",
	"\tdv.touchesTables(new Set(['C']), ['A']),",
	"\tdv.touchesTables(new Set(['A']), []),",
	']);',
	"await row('normalizeTickInterval', () => [undefined, 60000, NaN, Infinity, '5000', 999, -5, 5000000, 1500.7].map((v) => nowMod.normalizeTickInterval(v)));",
	"await row('defaultTick', () => nowMod.DEFAULT_NOW_TICK_MS);",
	'function Clock() {',
	"\treturn createElement('span', null, String(nowMod.useNow()));",
	'}',
	"await row('useNow', () => {",
	'\tconst before = Date.now();',
	'\tconst html = renderToStaticMarkup(createElement(Clock));',
	'\tconst after = Date.now();',
	"\treturn { before, after, value: Number(html.replace(/<[^>]*>/g, '')) };",
	'});',
].join('\n');

const HARNESS = [HARNESS_PRELUDE, HARNESS_FOUNDATION, 'process.stdout.write(JSON.stringify(rows));'].join('\n');

const child = spawnSync(
	process.execPath,
	[
		'--experimental-strip-types',
		'--no-warnings',
		'--import',
		'data:text/javascript,' + encodeURIComponent(REGISTER),
		'--input-type=module',
		'-e',
		HARNESS,
	],
	{ cwd: dashboardRoot(), encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } },
);

/** @type {Record<string, any>} */
let ROWS = {};
try {
	ROWS = JSON.parse(child.stdout || '{}');
} catch {
	ROWS = {};
}

/** @param {string} name @returns {any} */
function rowOf(name) {
	assert.ok(name in ROWS, `harness produced no row "${name}"`);
	const value = ROWS[name];
	if (value && typeof value === 'object' && 'thrown' in value && !Array.isArray(value)) {
		assert.fail(`harness row "${name}" threw ${value.thrown.name}: ${value.thrown.message}`);
	}
	return value;
}

test('harness: the child process ran the real .ts modules and exited 0', () => {
	assert.equal(child.status, 0, `child exited ${child.status}; stderr:\n${child.stderr}`);
	assert.ok(Object.keys(ROWS).length > 0, `child wrote no rows; stdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
});

// --- preconditions (read back, never inferred) --------------------------------

test('precondition: change-marks.js exports diffForMarks and the cap, lifetime and fade constants', () => {
	assert.equal(typeof changeMarks.diffForMarks, 'function');
	assert.equal(changeMarks.ROW_MARK_CAP, 25);
	assert.equal(changeMarks.MARK_LIFETIME_MS, 4000);
	assert.equal(changeMarks.MARK_FADE_MS, 2500);
});

test('precondition: the copy table holds the mark and action-note keys', () => {
	for (const key of ['marks.updated', 'marks.announceOne', 'marks.announceMany', 'panel.readOnly.short', 'panel.readOnly.long']) {
		assert.equal(typeof COPY[/** @type {keyof typeof COPY} */ (key)], 'string', `COPY is missing ${key}`);
	}
});

// --- DataVersionContext ---------------------------------------------------------

test('DEFAULT_DATA_VERSION is frozen and is { version: 0, changedTables: empty Set, markEligible: false }', () => {
	const r = rowOf('defaultVersion');
	assert.equal(r.frozen, true);
	assert.equal(r.version, 0);
	assert.equal(r.isSet, true);
	assert.deepEqual(r.tables, []);
	assert.equal(r.markEligible, false);
	assert.deepEqual(r.keys, ['changedTables', 'markEligible', 'version']);
	assert.equal(r.displayName, 'DataVersionContext');
});

test('a consumer with no provider reads version 0, no tables, not eligible', () => {
	assert.equal(rowOf('consumerNoProvider'), '<span>0/0/false/true</span>');
});

test('a consumer under a provider reads the provided version, tables and eligibility', () => {
	assert.equal(rowOf('consumerWithProvider'), '<span>3/1/true/true</span>');
});

test('touchesTables: empty changed set touches everything, a shared name touches, a disjoint set or an empty table list does not', () => {
	assert.deepEqual(rowOf('touchesTables'), [true, true, false, false]);
});

// --- useNow -----------------------------------------------------------------------

test('normalizeTickInterval clamps to 1 s .. 1 h and gives the default for anything not a finite number', () => {
	assert.deepEqual(rowOf('normalizeTickInterval'), [60000, 60000, 60000, 60000, 60000, 1000, 1000, 3600000, 1500]);
	assert.equal(rowOf('defaultTick'), 60000);
});

test('useNow renders the current epoch milliseconds', () => {
	const r = rowOf('useNow');
	assert.ok(Number.isFinite(r.value), `useNow rendered ${r.value}`);
	assert.ok(r.value >= r.before && r.value <= r.after, `useNow ${r.value} is outside [${r.before}, ${r.after}]`);
});

// --- source scans -----------------------------------------------------------------

/** @param {...string} segs @returns {string} */
function readSrc(...segs) {
	return readFileSync(dashboardSrc(...segs), 'utf8');
}

const DATA_VERSION_SRC = stripComments(readSrc('live', 'DataVersionContext.ts'));
const USE_NOW_SRC = stripComments(readSrc('live', 'useNow.ts'));
const NOTE_RAW = readSrc('live', 'ReadOnlyNote.tsx');
const NOTE_SRC = stripComments(NOTE_RAW);
const PANELS_CSS = stripCssComments(readSrc('screens', 'panels', 'panels.css'));

/** Files this plan creates under src/live/ (scanned for clock-parsing calls). */
const LIVE_FILES = [
	['DataVersionContext.ts', DATA_VERSION_SRC],
	['useNow.ts', USE_NOW_SRC],
	['ReadOnlyNote.tsx', NOTE_SRC],
];

test('DataVersionContext.ts creates the context with the default value', () => {
	assert.ok(DATA_VERSION_SRC.includes('createContext<DataVersion>(DEFAULT_DATA_VERSION)'));
});

test('useNow.ts starts and clears its interval and adds and removes its visibility listener', () => {
	for (const needle of ['setInterval(', 'clearInterval(', "addEventListener('visibilitychange'", "removeEventListener('visibilitychange'"]) {
		assert.ok(USE_NOW_SRC.includes(needle), `useNow.ts is missing ${needle}`);
	}
});

const CLOCK_PARSE_RE = /Date\.parse|toISOString/;

test('positive control: the clock-parsing matcher hits a synthetic fixture', () => {
	assert.match('const at = new Date(x).toISOString();', CLOCK_PARSE_RE);
	assert.match('const ms = Date.parse(s);', CLOCK_PARSE_RE);
});

test('no live module this plan creates parses or formats dates through Date.parse or toISOString', () => {
	for (const [name, source] of LIVE_FILES) {
		assert.doesNotMatch(source, CLOCK_PARSE_RE, `${name} parses or formats a date`);
	}
});

const INTERACTIVE_RE = /<button|<a[\s>]|onClick|href=|role=|tabIndex|title=|aria-label|cursor/;

test('positive control: the interactive-element matcher hits a synthetic button', () => {
	assert.match('<button onClick={go}>x</button>', INTERACTIVE_RE);
	assert.match('<a href="/x">x</a>', INTERACTIVE_RE);
	assert.doesNotMatch('<p className="panel-readonly-note">{t(k)}</p>', INTERACTIVE_RE);
});

test('ReadOnlyNote.tsx is text only: both literal copy keys, the note class, no interactive attribute', () => {
	assert.ok(NOTE_SRC.includes("t('panel.readOnly.short')"), 'missing the short key');
	assert.ok(NOTE_SRC.includes("t('panel.readOnly.long')"), 'missing the long key');
	assert.ok(NOTE_SRC.includes('className="panel-readonly-note"'), 'missing the static note class');
	assert.ok(NOTE_SRC.includes('className="panel-readonly-note panel-readonly-note--long"'), 'missing the long note class');
	assert.doesNotMatch(NOTE_SRC, INTERACTIVE_RE);
});

test('ReadOnlyNote.tsx never writes the hyphenated banned word, comments included', () => {
	assert.doesNotMatch(NOTE_RAW, new RegExp('read' + '-only', 'i'));
});

// --- CSS scans ----------------------------------------------------------------------

/**
 * Split comment-stripped CSS into its top-level blocks. An at-rule's body is
 * returned as text, so the caller can parse it again.
 * @param {string} css
 * @returns {Array<{ prelude: string, body: string }>}
 */
function cssBlocks(css) {
	/** @type {Array<{ prelude: string, body: string }>} */
	const blocks = [];
	let depth = 0;
	let start = 0;
	let prelude = '';
	for (let i = 0; i < css.length; i += 1) {
		const c = css[i];
		if (c === '{') {
			if (depth === 0) {
				prelude = css.slice(start, i).trim();
				start = i + 1;
			}
			depth += 1;
		} else if (c === '}') {
			depth -= 1;
			if (depth === 0) {
				blocks.push({ prelude, body: css.slice(start, i) });
				start = i + 1;
			}
		}
	}
	return blocks;
}

/** @param {string} css @param {string} selector @returns {string[]} bodies of top-level rules with exactly this selector */
function topLevelRules(css, selector) {
	return cssBlocks(css)
		.filter((b) => b.prelude === selector)
		.map((b) => b.body);
}

test('positive control: the rule finder returns a top-level rule body, and the pointer matcher hits it', () => {
	const fixture = '.x { cursor: pointer; }\n@media (hover: hover) { .x { color: red; } }';
	const bodies = topLevelRules(fixture, '.x');
	assert.equal(bodies.length, 1);
	assert.match(bodies[0], /cursor/);
});

test('panels.css: the action note is muted text with no pointer and no hover rule', () => {
	const bodies = topLevelRules(PANELS_CSS, '.panel-readonly-note');
	assert.equal(bodies.length, 1, 'expected exactly one .panel-readonly-note rule');
	assert.match(bodies[0], /color:\s*var\(--muted\)/);
	assert.doesNotMatch(bodies[0], /cursor/);
	assert.equal(topLevelRules(PANELS_CSS, '.panel-readonly-note--long').length, 1, 'expected one long-note rule');
	assert.doesNotMatch(PANELS_CSS, /\.panel-readonly-note[\w-]*:hover/);
	for (const body of topLevelRules(PANELS_CSS, '.panel-readonly-note--long')) assert.doesNotMatch(body, /cursor/);
});
