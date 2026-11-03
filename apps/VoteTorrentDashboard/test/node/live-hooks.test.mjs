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
	useChangeMarks: moduleUrl(dashboardSrc('live', 'useChangeMarks.ts')),
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

/** Task 2 rows: the change-mark pure cores, the hook's first render, the hidden word. */
const HARNESS_MARKS = [
	'const cm = await import(M.useChangeMarks);',
	'const keyOf = (r) => r.key;',
	'const sigOf = (r) => r.sig;',
	'const view = (s) => ({ nextIndexSize: s.nextIndex.size, marked: s.marked, headerMarked: s.headerMarked, count: s.count });',
	"const base = [{ key: 'a', sig: '1' }, { key: 'b', sig: '1' }, { key: 'c', sig: '1' }];",
	'const idx = new Map(base.map((r) => [r.key, r.sig]));',
	"await row('stepFirst', () => view(cm.computeMarkStep(null, [...base, { key: 'a', sig: '2' }], keyOf, sigOf, true)));",
	"await row('stepIneligible', () => view(cm.computeMarkStep(idx, [{ key: 'a', sig: '1' }, { key: 'b', sig: '2' }, { key: 'd', sig: '1' }], keyOf, sigOf, false)));",
	"await row('stepChanged', () => view(cm.computeMarkStep(idx, [{ key: 'a', sig: '1' }, { key: 'b', sig: '2' }, { key: 'c', sig: '1' }], keyOf, sigOf, true)));",
	"await row('stepNew', () => view(cm.computeMarkStep(idx, [...base, { key: 'd', sig: '1' }], keyOf, sigOf, true)));",
	"const many = Array.from({ length: 26 }, (_, i) => ({ key: 'k' + i, sig: '1' }));",
	'const manyIdx = new Map(many.map((r) => [r.key, r.sig]));',
	"await row('stepCap', () => view(cm.computeMarkStep(manyIdx, many.map((r) => ({ key: r.key, sig: '2' })), keyOf, sigOf, true)));",
	"await row('stepRemoved', () => view(cm.computeMarkStep(idx, [{ key: 'a', sig: '1' }, { key: 'b', sig: '1' }], keyOf, sigOf, true)));",
	"await row('stepRemovedChanged', () => view(cm.computeMarkStep(idx, [{ key: 'a', sig: '1' }, { key: 'b', sig: '2' }], keyOf, sigOf, true)));",
	"await row('stepBadKey', () => {",
	"\ttry { cm.computeMarkStep(null, [{ key: 7, sig: 'registrant-secret-key' }], keyOf, sigOf, true); return { threw: false }; }",
	'\tcatch (err) { return { threw: true, isTypeError: err instanceof TypeError, message: String(err && err.message) }; }',
	'});',
	"await row('announceText', () => ({",
	"\tzero: cm.announceText(0, 'Elections'),",
	"\tone: cm.announceText(1, 'Elections'),",
	"\tthree: cm.announceText(3, 'Elections'),",
	"\toneViaT: ui.t('marks.announceOne', { count: '1', panel: 'Elections' }),",
	'}));',
	"await row('markClassName', () => ['none', 'fresh', 'fading'].map((p) => cm.markClassName(p)));",
	"await row('classConstants', () => [cm.CHANGE_MARK_CLASS, cm.CHANGE_MARK_FADING_CLASS, cm.CHANGE_MARK_WORD_CLASS]);",
	"await row('mergePassMarks', () => {",
	'\tconst p = { version: 1, count: 2, headerMarked: false };',
	'\treturn {',
	'\t\tnullKeepsPost: cm.mergePassMarks(null, p) === p,',
	'\t\tsameVersion: cm.mergePassMarks(p, { version: 1, count: 3, headerMarked: true }),',
	'\t\tnewVersion: cm.mergePassMarks(p, { version: 2, count: 1, headerMarked: false }),',
	'\t\tprevUntouched: p,',
	'\t};',
	'});',
	"await row('mergeAnnouncement', () => {",
	"\tconst a1 = cm.mergeAnnouncement(cm.EMPTY_ANNOUNCEMENT, 'elections', 'E1', 5);",
	"\tconst a2 = cm.mergeAnnouncement(a1, 'registrations', 'R2', 5);",
	"\tconst a3 = cm.mergeAnnouncement(a2, 'elections', 'E3', 5);",
	"\tconst a4 = cm.mergeAnnouncement(a3, 'keyholders', 'K1', 6);",
	'\treturn {',
	'\t\ta1: a1.entries, a2: a2.entries, a3: a3.entries, a3Version: a3.version, a3Text: cm.announcementText(a3),',
	'\t\ta4: a4.entries, a4Version: a4.version,',
	'\t\temptyText: cm.announcementText(cm.EMPTY_ANNOUNCEMENT), emptyFrozen: Object.isFrozen(cm.EMPTY_ANNOUNCEMENT),',
	'\t\temptyEntries: cm.EMPTY_ANNOUNCEMENT.entries.length,',
	'\t};',
	'});',
	'function Probe(props) {',
	'\tconst m = cm.useChangeMarks(props.rows, keyOf, sigOf);',
	"\treturn createElement('span', null, [m.isMarked('a'), m.isMarked('b'), m.headerMarked, String(m.announce), JSON.stringify(m.markClass('a'))].join('|'));",
	'}',
	"await row('hookNoProvider', () => renderToStaticMarkup(createElement(Probe, { rows: base })));",
	"await row('hookRowsNull', () => renderToStaticMarkup(createElement(Probe, { rows: null })));",
	"await row('hookRowsUndefined', () => renderToStaticMarkup(createElement(Probe, { rows: undefined })));",
	"await row('hookEligibleFirstRender', () => renderToStaticMarkup(createElement(dv.DataVersionContext.Provider, { value: { version: 2, changedTables: new Set(), markEligible: true } }, createElement(Probe, { rows: base }))));",
	"await row('changeMarkWord', () => renderToStaticMarkup(createElement(cm.ChangeMarkWord)));",
	"await row('contextNames', () => [cm.PanelMarkContext.displayName, cm.MarkAnnouncerContext.displayName]);",
].join('\n');

const HARNESS = [HARNESS_PRELUDE, HARNESS_FOUNDATION, HARNESS_MARKS, 'process.stdout.write(JSON.stringify(rows));'].join('\n');

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

// --- useChangeMarks: pure cores ---------------------------------------------------

test('computeMarkStep: a first render (no previous index) marks nothing and indexes each unique key once', () => {
	assert.deepEqual(rowOf('stepFirst'), { nextIndexSize: 3, marked: [], headerMarked: false, count: 0 });
});

test('computeMarkStep: an ineligible pass marks nothing and rebuilds the index from the rows', () => {
	assert.deepEqual(rowOf('stepIneligible'), { nextIndexSize: 3, marked: [], headerMarked: false, count: 0 });
});

test('computeMarkStep: one changed signature or one new key marks exactly that row', () => {
	assert.deepEqual(rowOf('stepChanged'), { nextIndexSize: 3, marked: ['b'], headerMarked: false, count: 1 });
	assert.deepEqual(rowOf('stepNew'), { nextIndexSize: 4, marked: ['d'], headerMarked: false, count: 1 });
});

test('computeMarkStep: 26 changed rows mark the header, no rows, and keep the true count', () => {
	assert.deepEqual(rowOf('stepCap'), { nextIndexSize: 26, marked: [], headerMarked: true, count: 26 });
});

test('computeMarkStep: a removed row marks the header; removed plus changed marks the changed row and the header', () => {
	assert.deepEqual(rowOf('stepRemoved'), { nextIndexSize: 2, marked: [], headerMarked: true, count: 1 });
	assert.deepEqual(rowOf('stepRemovedChanged'), { nextIndexSize: 2, marked: ['b'], headerMarked: true, count: 2 });
});

test('computeMarkStep: a non-string key throws a TypeError whose message carries no row value', () => {
	const r = rowOf('stepBadKey');
	assert.equal(r.threw, true);
	assert.equal(r.isTypeError, true);
	assert.ok(!r.message.includes('registrant-secret-key'), `the error message leaked a row value: ${r.message}`);
});

test('announceText: null for zero, the one-item and many-item sentences otherwise (count and title only)', () => {
	const r = rowOf('announceText');
	assert.equal(r.zero, null);
	assert.equal(r.one, r.oneViaT);
	assert.equal(r.one, '1 item updated in Elections');
	assert.equal(r.three, '3 items updated in Elections');
});

test('markClassName and the class constants', () => {
	assert.deepEqual(rowOf('markClassName'), ['', 'change-mark', 'change-mark change-mark--fading']);
	assert.deepEqual(rowOf('classConstants'), ['change-mark', 'change-mark--fading', 'change-mark__word']);
});

test('mergePassMarks: null keeps the post, the same version sums counts and ORs the header, a new version replaces', () => {
	const r = rowOf('mergePassMarks');
	assert.equal(r.nullKeepsPost, true);
	assert.deepEqual(r.sameVersion, { version: 1, count: 5, headerMarked: true });
	assert.deepEqual(r.newVersion, { version: 2, count: 1, headerMarked: false });
	assert.deepEqual(r.prevUntouched, { version: 1, count: 2, headerMarked: false });
});

test('mergeAnnouncement: same version replaces a panel in first-seen order, a new version starts over, inputs never mutate', () => {
	const r = rowOf('mergeAnnouncement');
	assert.deepEqual(r.a1, [['elections', 'E1']]);
	assert.deepEqual(r.a2, [['elections', 'E1'], ['registrations', 'R2']]);
	assert.deepEqual(r.a3, [['elections', 'E3'], ['registrations', 'R2']]);
	assert.equal(r.a3Version, 5);
	assert.equal(r.a3Text, 'E3 R2');
	assert.deepEqual(r.a4, [['keyholders', 'K1']]);
	assert.equal(r.a4Version, 6);
	assert.equal(r.emptyText, '');
	assert.equal(r.emptyFrozen, true);
	assert.equal(r.emptyEntries, 0);
});

// --- useChangeMarks: the hook's first render ------------------------------------------

test('useChangeMarks on first render marks nothing, with or without a provider, and tolerates rows null/undefined', () => {
	const unmarked = '<span>false|false|false|null|&quot;&quot;</span>';
	assert.equal(rowOf('hookNoProvider'), unmarked);
	assert.equal(rowOf('hookRowsNull'), unmarked);
	assert.equal(rowOf('hookRowsUndefined'), unmarked);
	assert.equal(rowOf('hookEligibleFirstRender'), unmarked);
	assert.deepEqual(rowOf('contextNames'), ['PanelMarkContext', 'MarkAnnouncerContext']);
});

test('ChangeMarkWord renders a space and the visually hidden word', () => {
	assert.equal(rowOf('changeMarkWord'), ' <span class="change-mark__word">updated</span>');
});

// --- useChangeMarks: source scans ---------------------------------------------------------

const MARKS_SRC = stripComments(readSrc('live', 'useChangeMarks.ts'));
const MARK_LITERAL_RE = /\b(4_?000|2_?500)\b/;

test('positive control: the lifetime-literal matcher hits a re-typed constant', () => {
	assert.match('setTimeout(done, 4_000);', MARK_LITERAL_RE);
	assert.match('const fade = 2500;', MARK_LITERAL_RE);
});

test('useChangeMarks.ts imports the diff and the lifetime from change-marks.js and re-types no constant', () => {
	assert.match(MARKS_SRC, /import \{[^}]*\bdiffForMarks\b[^}]*\} from '\.\/change-marks\.js'/);
	assert.match(MARKS_SRC, /import \{[^}]*\bMARK_LIFETIME_MS\b[^}]*\} from '\.\/change-marks\.js'/);
	assert.match(MARKS_SRC, /setTimeout\([^;]*MARK_LIFETIME_MS/);
	assert.match(MARKS_SRC, /requestAnimationFrame/);
	assert.doesNotMatch(MARKS_SRC, MARK_LITERAL_RE);
	assert.doesNotMatch(MARKS_SRC, CLOCK_PARSE_RE);
	assert.doesNotMatch(MARKS_SRC, /PanelFrame/);
});

test('useChangeMarks.ts logs only error names', () => {
	const consoleLines = MARKS_SRC.split('\n').filter((line) => line.includes('console.'));
	assert.ok(consoleLines.length >= 1, 'expected the diff-failure log line');
	for (const line of consoleLines) assert.ok(line.includes('.name'), `a console line logs more than a name: ${line.trim()}`);
});

// --- mark CSS -------------------------------------------------------------------------------

/** @param {string} css @returns {{ outside: string, media: string[] }} */
function splitMotionMedia(css) {
	const blocks = cssBlocks(css);
	const media = blocks.filter((b) => /^@media\s*\(prefers-reduced-motion:\s*no-preference\)$/.test(b.prelude)).map((b) => b.body);
	const outside = blocks
		.filter((b) => !/^@media\s*\(prefers-reduced-motion:\s*no-preference\)$/.test(b.prelude))
		.map((b) => `${b.prelude} {${b.body}}`)
		.join('\n');
	return { outside, media };
}

/** @param {string} css @returns {string[]} problems with the mark's motion rules */
function markMotionProblems(css) {
	/** @type {string[]} */
	const problems = [];
	const { outside, media } = splitMotionMedia(css);
	if (/change-mark--fading/.test(outside)) problems.push('fading rule outside the motion media block');
	for (const body of topLevelRules(outside, '.change-mark')) {
		if (/transition/.test(body)) problems.push('transition on .change-mark at top level');
	}
	return problems;
}

test('positive control: the motion checker flags a fading rule outside the media block and a top-level transition', () => {
	assert.deepEqual(markMotionProblems('.change-mark { color: red; }\n.change-mark--fading { background-color: transparent; }'), [
		'fading rule outside the motion media block',
	]);
	assert.deepEqual(markMotionProblems('.change-mark { transition: background-color 1ms; }'), ['transition on .change-mark at top level']);
	assert.deepEqual(markMotionProblems('.change-mark { color: red; }\n@media (prefers-reduced-motion: no-preference) { .change-mark.change-mark--fading { transition: x; } }'), []);
});

test('panels.css: the mark is the inset bar plus the 15% primary tint, with no transition outside the motion block', () => {
	const bodies = topLevelRules(PANELS_CSS, '.change-mark');
	assert.equal(bodies.length, 1, 'expected exactly one top-level .change-mark rule');
	assert.match(bodies[0], /box-shadow:\s*inset 2px 0 0 var\(--primary\)/);
	assert.ok(bodies[0].includes('background-color: color-mix(in srgb, var(--primary) 15%, transparent)'));
	assert.doesNotMatch(bodies[0], /transition/);
	assert.deepEqual(markMotionProblems(PANELS_CSS), []);
});

test('panels.css: the fade lives only in the no-preference motion block and uses the shared fade duration', () => {
	const { media } = splitMotionMedia(PANELS_CSS);
	const fadingBodies = media.flatMap((body) => cssBlocks(body).filter((b) => b.prelude.includes('change-mark--fading')).map((b) => b.body));
	assert.equal(fadingBodies.length, 1, 'expected one fading rule inside the motion media block');
	assert.ok(fadingBodies[0].includes(`transition: background-color ${changeMarks.MARK_FADE_MS}ms`), 'the fade duration must come from MARK_FADE_MS');
	assert.match(fadingBodies[0], /background-color:\s*transparent/);
});

test('panels.css: the hidden word and live region are visually hidden but readable', () => {
	const bodies = topLevelRules(PANELS_CSS, '.change-mark__word,\n.change-mark-live-region');
	assert.equal(bodies.length, 1, 'expected one shared visually-hidden rule');
	for (const decl of ['position: absolute', 'clip-path: inset(50%)', 'width: 1px', 'height: 1px', 'overflow: hidden']) {
		assert.ok(bodies[0].includes(decl), `visually-hidden rule is missing ${decl}`);
	}
});

test('panels.css: no hex colour literal and no border-left bar', () => {
	assert.doesNotMatch(PANELS_CSS, /#[0-9a-fA-F]{3,8}\b/);
	assert.doesNotMatch(PANELS_CSS, /border-left/);
});

// --- threading: PanelGrid, PanelFrame, types.ts ---------------------------------------

const GRID_SRC = stripComments(readSrc('screens', 'PanelGrid.tsx'));
const FRAME_SRC = stripComments(readSrc('screens', 'panels', 'PanelFrame.tsx'));
const TYPES_RAW = readSrc('screens', 'panels', 'types.ts');
const PROVIDER_RE = /DataVersionContext\.Provider value=\{dataVersion \?\? DEFAULT_DATA_VERSION\}/;

test('positive control: the pass-through provider matcher hits the direct form and misses a state-seeded one', () => {
	assert.match('<DataVersionContext.Provider value={dataVersion ?? DEFAULT_DATA_VERSION}>', PROVIDER_RE);
	assert.doesNotMatch('<DataVersionContext.Provider value={state}>', PROVIDER_RE);
});

test('PanelGrid.tsx passes dataVersion straight into the provider and provides the mark announcer', () => {
	assert.match(GRID_SRC, PROVIDER_RE);
	assert.match(GRID_SRC, /MarkAnnouncerContext\.Provider/);
	assert.doesNotMatch(GRID_SRC, /useState(?:<[^>]*>)?\([^)]*dataVersion/, 'no state may be seeded from dataVersion');
	assert.doesNotMatch(GRID_SRC, /useMemo\([^]*?dataVersion[^]*?\]\)/, 'no memo may be derived from dataVersion');
});

test('PanelGrid.tsx renders exactly one polite live region, after the grid, with no status role', () => {
	const live = [...GRID_SRC.matchAll(/aria-live="polite"/g)];
	assert.equal(live.length, 1, 'expected exactly one polite live region');
	assert.match(GRID_SRC, /<div className="change-mark-live-region" aria-live="polite" aria-atomic="true">/);
	assert.doesNotMatch(GRID_SRC, /role="status"/);
	const gridAt = GRID_SRC.indexOf('className="panel-grid"');
	const regionAt = GRID_SRC.indexOf('className="change-mark-live-region"');
	assert.ok(gridAt >= 0 && regionAt > gridAt, 'the live region must come after the panel grid, never inside it as a grid item');
});

test('PanelGrid.tsx still accepts snapshotInstant but forwards it to no panel', () => {
	assert.match(GRID_SRC, /snapshotInstant\?: string \| null/);
	const componentJsx = GRID_SRC.match(/<Component\b[^>]*\/>/g) ?? [];
	assert.equal(componentJsx.length, 1, 'expected the one registry component element');
	assert.doesNotMatch(componentJsx[0], /snapshotInstant/);
	assert.doesNotMatch(GRID_SRC, /snapshotInstant=/);
});

test('PanelFrame.tsx provides the mark sink inside the visible-body guard and renders the header mark', () => {
	const providerAt = FRAME_SRC.indexOf('PanelMarkContext.Provider');
	assert.ok(providerAt >= 0, 'PanelMarkContext.Provider is missing');
	assert.ok(providerAt > FRAME_SRC.lastIndexOf('evaluation.visible ?'), 'the sink must sit inside the body guard');
	assert.ok(providerAt > FRAME_SRC.indexOf('className="panel-body"'), 'the sink must sit inside the panel body');
	for (const needle of ['useMarkLifetime(', 'ChangeMarkWord', 'MarkAnnouncerContext', 'ChartViewProvider', 'className="panel-header"']) {
		assert.ok(FRAME_SRC.includes(needle), `PanelFrame.tsx is missing ${needle}`);
	}
});

test('types.ts keeps snapshotInstant, now marked deprecated', () => {
	assert.ok(TYPES_RAW.includes('snapshotInstant?: string | null'));
	assert.ok(TYPES_RAW.includes('@deprecated'));
});
