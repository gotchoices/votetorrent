/**
 * election-ops-panels.test.mjs -- source-level assertions over the three
 * Election Operations panel bodies: no mutating affordance, no forbidden
 * column, no dropped panel state, copy-keys-only. `LifecyclePill.tsx`
 * itself moved to packages/ui-web in 53-05 (D-01/D-02) -- its own
 * null-phase-guard assertion moved with it into
 * packages/ui-web/test/shared-components.test.mjs; what remains here is
 * `ElectionsPanel.tsx mounts LifecyclePill`, whose subject is the
 * dashboard's OWN mount site, not the pill's internals.
 * `node --test` cannot import `.tsx`, so this file reads each source as
 * TEXT, in `test/node/registry.test.mjs`'s (50-06) shape.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { dashboardSrc } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';

import { COPY } from '@votetorrent/ui-web';

const PANELS_DIR = dashboardSrc('screens', 'panels');

const FILES = ['RegistrationsPanel.tsx', 'ElectionsPanel.tsx', 'BallotsQuestionsPanel.tsx'];

/** @type {Record<string, string>} */
const RAW = {};
/** @type {Record<string, string>} */
const STRIPPED = {};
for (const file of FILES) {
	RAW[file] = readFileSync(path.join(PANELS_DIR, file), 'utf8');
	STRIPPED[file] = stripComments(RAW[file]);
}

// --- No control of any kind (rule R2) ---------------------------------------

const CONTROL_RE = /<button|<form|<input|<select|<textarea|onClick|onSubmit|onChange|href=/;

test('no <button>, <form>, <input>, <select>, <textarea>, onClick, onSubmit, onChange or href= in any of the four files', () => {
	for (const file of FILES) {
		assert.doesNotMatch(STRIPPED[file], CONTROL_RE, `${file} contains a control affordance`);
	}
});

test('positive control: the control matcher hits a synthetic disabled-button fixture', () => {
	const fixture = `<button className="act" disabled>Review requests</button>`;
	assert.match(fixture, CONTROL_RE, 'matcher is inert -- it must hit its own positive-control fixture');
});

// --- No mutation -------------------------------------------------------------

test('no insert into / delete from / update ... set in any of the four files', () => {
	for (const file of FILES) {
		assert.doesNotMatch(STRIPPED[file], /insert into|delete from|update .* set /i, `${file} contains a mutating statement`);
	}
});

// --- No injection surface (rule R5) -----------------------------------------

test('no dangerouslySetInnerHTML, innerHTML or eval( in any of the four files', () => {
	for (const file of FILES) {
		assert.doesNotMatch(STRIPPED[file], /dangerouslySetInnerHTML|innerHTML|eval\(/, `${file} contains an injection surface`);
	}
});

// --- No forbidden column (rule R3) ------------------------------------------

test('no PrivateDetails, SelectiveDetails, PayloadCid, ExtraFields or .Payload in any of the four files', () => {
	for (const file of FILES) {
		assert.doesNotMatch(
			STRIPPED[file],
			/PrivateDetails|SelectiveDetails|PayloadCid|ExtraFields|\.Payload/,
			`${file} references a forbidden column`,
		);
	}
});

// --- No unreachable panel state (comments included) -------------------------

test('no "read-only", "◐" or "writable" anywhere in the four files, comments included', () => {
	for (const file of FILES) {
		assert.doesNotMatch(RAW[file], /read-only|◐|writable/i, `${file} names the unreachable panel state`);
	}
});

// --- No authored prose (rule R1) --------------------------------------------

/**
 * Extract literal JSX text nodes -- an OPEN TAG immediately followed by
 * plain text (no nested tag, no `{...}` expression) immediately followed by
 * a CLOSING tag start (`</`) -- that contain at least one run of
 * two-or-more Latin letters, i.e. something that reads like a word, not
 * bare punctuation. Requiring the immediate `</` (a real JSX closing tag,
 * never present in a TypeScript `interface { ... }` block) is what keeps
 * this pattern from false-matching this file's own `Awaited<ReturnType<...>>`
 * generic-type syntax, which also contains bare `<`/`>` pairs but never a
 * `</`. A `{...}` expression child (a `t(...)` call or a database value) is
 * never captured, because `{` and `}` are excluded from the text class.
 *
 * @param {string} source
 * @returns {string[]}
 */
function extractWordBearingJsxText(source) {
	const matches = [...source.matchAll(/<[a-zA-Z][\w-]*(?:\s[^>]*)?>([^<>{}]*)<\//g)].map((m) => m[1].trim());
	return matches.filter((text) => /[A-Za-z]{2,}/.test(text));
}

test('no word-bearing literal JSX text node in any of the four files -- every rendered word is a t(...) result or a database value', () => {
	for (const file of FILES) {
		const offenders = extractWordBearingJsxText(STRIPPED[file]);
		assert.deepEqual(offenders, [], `${file} has literal JSX text: ${JSON.stringify(offenders)}`);
	}
});

test('positive control: the authored-prose extractor reports a literal sentence in a synthetic fixture', () => {
	const fixture = `<p>No registrants yet.</p>`;
	const offenders = extractWordBearingJsxText(fixture);
	assert.deepEqual(offenders, ['No registrants yet.']);
});

// --- No new copy key ----------------------------------------------------------

const COPY_KEYS = new Set(Object.keys(COPY));
// The five `lifecycle.*` keys, as they stand in packages/ui-web/src/copy.js
// after 54-02's rename (D-06/D-07) -- `organizing`/`running`/`released`
// became `pre`/`voting`/`settling`/`closed` plus the standing
// `indeterminate` sentinel, not the insertion of a fourth into an unchanged
// set. None of the four panel files below calls any `lifecycle.*` key
// literally today (`LifecyclePill` moved to `packages/ui-web` in 53-05, and
// it -- not a panel -- is what calls `t(phaseCopyKey(phase))`), so these
// entries are listed but currently unexercised by the loop below; the
// `COPY_KEYS.has(key)` half two lines down still catches an allow-listed key
// naming a phase that no longer exists, for the day a panel does call one.
// Grown for D-06/D-22: RegistrationsPanel.tsx's four-arm state split adds
// three literal state keys (its fourth state, `.empty`, keeps resolving
// through the existing `t(capability.emptyKey)` indirection, which is not a
// literal and so is never a member of this set), and its four new section
// headings add one literal key each. Grown again for C1/C2: the status and
// request charts' tooltip strings and C2's empty-frame copy are each a
// literal `t(...)` call in the panel body. Grown again for C3: the intake
// chart's tooltip string is a fourth literal `t(...)` call (its empty-frame
// copy key is a plain string prop, not a `t(...)` call, so it is not matched
// by this allow-list's own scanning regex, but is still recorded here for
// the plan's own bookkeeping).
const ALLOWED_T_KEYS = new Set([
	'panels.registrations.empty',
	'panels.registrations.loading',
	'panels.registrations.unavailable',
	'panels.registrations.readFailed',
	'panels.registrations.statusHeading',
	'panels.registrations.requestsHeading',
	'panels.registrations.rosterHeading',
	'panels.registrations.surfaceCountsHeading',
	'panels.registrations.requestChart.empty',
	'panels.registrations.statusChart.tooltip',
	'panels.registrations.requestChart.tooltip',
	'panels.registrations.intakeChart.empty',
	'panels.registrations.intakeChart.tooltip',
	'panels.elections.empty',
	'panels.ballotsQuestions.empty',
	'lifecycle.pre',
	'lifecycle.voting',
	'lifecycle.settling',
	'lifecycle.closed',
	'lifecycle.indeterminate',
]);

test('every literal t(...) argument across the four files is in the exact allow-list and exists in the frozen COPY table', () => {
	for (const file of FILES) {
		const literalCalls = [...STRIPPED[file].matchAll(/\bt\(\s*'([^']+)'/g)].map((m) => m[1]);
		for (const key of literalCalls) {
			assert.ok(ALLOWED_T_KEYS.has(key), `${file} calls t('${key}'), which is outside the allow-list`);
			assert.ok(COPY_KEYS.has(key), `${file} calls t('${key}'), which does not exist in COPY`);
		}
	}
});

test('positive control: an invented copy key call is detected as outside the allow-list', () => {
	const fixtureKeys = [...`t('panels.registrations.subtitle')`.matchAll(/\bt\(\s*'([^']+)'/g)].map((m) => m[1]);
	assert.deepEqual(fixtureKeys, ['panels.registrations.subtitle']);
	assert.ok(!ALLOWED_T_KEYS.has('panels.registrations.subtitle'));
});

// --- Four section headings (D-06) --------------------------------------------

const REGISTRATIONS_HEADING_KEYS = [
	'panels.registrations.statusHeading',
	'panels.registrations.requestsHeading',
	'panels.registrations.rosterHeading',
	'panels.registrations.surfaceCountsHeading',
];

test('RegistrationsPanel.tsx renders each of the four heading keys exactly once, as a t(...) expression child, never a literal JSX text node', () => {
	const source = STRIPPED['RegistrationsPanel.tsx'];
	for (const key of REGISTRATIONS_HEADING_KEYS) {
		const escaped = key.replace(/\./g, '\\.');
		const occurrences = source.match(new RegExp(`t\\('${escaped}'\\)`, 'g')) ?? [];
		assert.equal(occurrences.length, 1, `${key} does not appear exactly once as a t(...) call in RegistrationsPanel.tsx`);
	}
	assert.deepEqual(extractWordBearingJsxText(source), []);
});

// --- Four distinct panel states (D-22) ---------------------------------------

/**
 * Reads the RegistrationsPanel-shaped literal panel-state `t(...)` calls
 * (loading / unavailable / readFailed) plus the `t(capability.emptyKey)`
 * indirection out of `source`, and resolves every one it finds through the
 * frozen `COPY` table -- so a source naming fewer than four states reports
 * fewer than four resolved strings, and a source whose keys collide onto the
 * same sentence is visible as a `Set` smaller than the list.
 *
 * @param {string} source
 * @returns {string[]}
 */
function namedRegistrationsStateStrings(source) {
	/** @type {string[]} */
	const resolved = [];
	for (const key of ['panels.registrations.loading', 'panels.registrations.unavailable', 'panels.registrations.readFailed']) {
		const escaped = key.replace(/\./g, '\\.');
		if (new RegExp(`t\\('${escaped}'\\)`).test(source)) resolved.push(COPY[key]);
	}
	if (/t\(capability\.emptyKey\)/.test(source)) resolved.push(COPY['panels.registrations.empty']);
	return resolved;
}

test('RegistrationsPanel.tsx names all four panel states, and the four resolved copy strings are pairwise distinct', () => {
	const resolved = namedRegistrationsStateStrings(STRIPPED['RegistrationsPanel.tsx']);
	assert.equal(resolved.length, 4, `RegistrationsPanel.tsx does not name all four panel states: ${JSON.stringify(resolved)}`);
	assert.equal(
		new Set(resolved).size,
		4,
		`the four panel states did not resolve to four distinct strings -- a failed read would be indistinguishable from another state: ${JSON.stringify(resolved)}`,
	);
});

test('positive control: a fixture naming only one of the four state keys is reported as incomplete by the same helper the real rung uses', () => {
	const fixture = `t('panels.registrations.loading')`;
	const resolved = namedRegistrationsStateStrings(fixture);
	assert.equal(resolved.length, 1, 'the helper must report an incomplete fixture as incomplete, or it proves nothing');
});

// --- Chart inventory (C1, C2, C4/D-05) ---------------------------------------

test('RegistrationsPanel.tsx mounts exactly one BarSeries and one StackedBarSeries, zero Meter, and never disables value labels', () => {
	const source = STRIPPED['RegistrationsPanel.tsx'];
	assert.equal((source.match(/<BarSeries/g) ?? []).length, 1, 'expected exactly one <BarSeries mount');
	assert.equal((source.match(/<StackedBarSeries/g) ?? []).length, 1, 'expected exactly one <StackedBarSeries mount');
	assert.equal((source.match(/<Meter/g) ?? []).length, 0, 'the surface-count section (C4/D-05) must stay a table, not a Meter');
	assert.doesNotMatch(source, /showValueLabels/, 'the mandatory C1 count label must be left at its default, never suppressed');
});

// --- Every grid survives (D-20) -----------------------------------------------

test('RegistrationsPanel.tsx keeps all three eo-count-grid blocks and the eo-row roster -- every chart sits beside its grid', () => {
	const source = STRIPPED['RegistrationsPanel.tsx'];
	assert.equal((source.match(/eo-count-grid/g) ?? []).length, 3, 'expected exactly three eo-count-grid occurrences');
	assert.ok(/eo-row/.test(source), 'expected at least one eo-row occurrence (the roster grid)');
});

// --- The status breakdown is never filtered (D-02) ----------------------------

test('RegistrationsPanel.tsx contains no .filter( -- the status breakdown always renders all three statuses, including zero counts -- with a positive control proving the matcher is discriminating', () => {
	assert.doesNotMatch(STRIPPED['RegistrationsPanel.tsx'], /\.filter\(/, 'RegistrationsPanel.tsx must never filter a breakdown read');
	const fixture = `const visible = rows.filter((r) => r.Count > 0);`;
	assert.match(fixture, /\.filter\(/, 'positive control: the matcher must hit a synthetic rows.filter(...) fixture, or it proves nothing');
});

// --- Charts are confined to Registrations and Keyholders (D-01) --------------

const CHART_PRIMITIVE_RE = /<BarSeries|<StackedBarSeries|<TimeSeries|<Meter/;

test('no panel body other than RegistrationsPanel.tsx and KeyholdersPanel.tsx mounts a chart primitive', () => {
	const panelFiles = readdirSync(PANELS_DIR, { withFileTypes: true })
		.filter((entry) => entry.isFile() && /Panel\.tsx$/.test(entry.name))
		.map((entry) => entry.name);
	assert.ok(panelFiles.length > 2, 'the walk must visit more than two panel files, or a green run is vacuous');
	const offenders = [];
	for (const file of panelFiles) {
		if (file === 'RegistrationsPanel.tsx' || file === 'KeyholdersPanel.tsx') continue;
		const source = stripComments(readFileSync(path.join(PANELS_DIR, file), 'utf8'));
		if (CHART_PRIMITIVE_RE.test(source)) offenders.push(file);
	}
	assert.deepEqual(offenders, [], `chart primitive confined to Registrations/Keyholders, but found in: ${JSON.stringify(offenders)}`);
});

// --- C3's bucket label is derived from the value's own length, not from a --
// --- unit the read does not return -----------------------------------------

const EPOCH_STEP_RE = /86400000|604800000/;

test('RegistrationsPanel.tsx declares HOUR_BUCKET_START_LENGTH and derives the intake bucket label from bucketStart.length, never from an epoch-step constant -- with a positive control proving the matcher is discriminating', () => {
	const source = STRIPPED['RegistrationsPanel.tsx'];
	assert.match(source, /HOUR_BUCKET_START_LENGTH/, "RegistrationsPanel.tsx must declare the length constant C3's label derivation is built from");
	assert.doesNotMatch(source, EPOCH_STEP_RE, 'RegistrationsPanel.tsx must not reintroduce epoch-step inference for the C3 bucket label');
	const fixture = `const dayStepMs = 86400000;`;
	assert.match(fixture, EPOCH_STEP_RE, 'positive control: the matcher must hit a synthetic fixture naming one of the banned constants, or it proves nothing');
});

// --- No decision ID or phase number -----------------------------------------

test('no D-NN decision id or "Phase N" reference in any of the four files, comments included', () => {
	for (const file of FILES) {
		assert.doesNotMatch(RAW[file], /\bD-[0-9]{2}\b|Phase [0-9]+/, `${file} names a decision id or phase number`);
	}
});

// --- Registry untouched, still nine ------------------------------------------

test('registry.ts still declares exactly 9 *Panel.tsx files on disk, and neither new file matches that glob', () => {
	const registrySource = readFileSync(path.join(PANELS_DIR, 'registry.ts'), 'utf8');
	const importMatches = [...registrySource.matchAll(/from\s+'\.\/(\w+Panel)'/g)].map((m) => m[1]);
	assert.equal(importMatches.length, 9);
	for (const name of importMatches) {
		assert.ok(existsSync(path.join(PANELS_DIR, `${name}.tsx`)), `${name}.tsx missing`);
	}
	assert.ok(!importMatches.includes('LifecyclePill'));
});

// --- No panel imports PanelFrame or a snapshot-instant context --------------

const FRAME_OR_CONTEXT_RE = /PanelFrame|SnapshotInstantContext/;

test('none of the four files imports PanelFrame or a SnapshotInstantContext', () => {
	for (const file of FILES) {
		assert.doesNotMatch(STRIPPED[file], FRAME_OR_CONTEXT_RE, `${file} imports PanelFrame or a snapshot-instant context`);
	}
});

test('positive control: the PanelFrame-detection matcher hits a synthetic self-wrapping import', () => {
	const fixture = `import PanelFrame from './PanelFrame.tsx';`;
	assert.match(fixture, FRAME_OR_CONTEXT_RE);
});

test('no SnapshotInstantContext.ts file exists under src/screens/panels/ -- this plan creates no React context', () => {
	assert.ok(!existsSync(path.join(PANELS_DIR, 'SnapshotInstantContext.ts')));
});

// --- RegistrationsPanel honours the per-panel chart/grid view switch -------
// (D-13/D-17: the control stays in the shared panel chrome; D-18: chart is
// the default; D-19: this panel writes nothing to storage; D-20: both
// representations survive, the hidden one unmounted rather than CSS-hidden)

const VIEW_DISCRIMINANT = "view === 'chart'";

/** Whether a <section> chunk carries the switch discriminant.
 * @param {string} chunk @returns {boolean} */
function sectionIsSwitched(chunk) {
	return chunk.includes(VIEW_DISCRIMINANT);
}

test('Rung A: RegistrationsPanel.tsx reads the view from the separately-named context module, never from the chrome', () => {
	const source = STRIPPED['RegistrationsPanel.tsx'];
	assert.equal((source.match(/usePanelView\(\)/g) ?? []).length, 1, 'expected exactly one usePanelView() call');
	assert.match(source, /from ['"]\.\/ChartViewContext\.js['"]/, 'expected an import specifier ending in ChartViewContext.js');
	// Asserted over RAW, not merely STRIPPED -- this rung is self-sufficient
	// and does not lean on the sibling matcher above to catch a comment
	// naming the shared panel chrome.
	assert.doesNotMatch(
		RAW['RegistrationsPanel.tsx'],
		FRAME_OR_CONTEXT_RE,
		'RegistrationsPanel.tsx must not import the shared panel chrome module, comments included',
	);
});

test('positive control: an import of the hook from the chrome module (built by concatenation, never as one banned literal token) is hit by FRAME_OR_CONTEXT_RE', () => {
	const bannedModule = 'Panel' + 'Frame';
	const fixture = `import { usePanelView } from './${bannedModule}.js';`;
	assert.match(fixture, FRAME_OR_CONTEXT_RE, 'the RAW half is not discriminating -- it must hit a synthetic import from the chrome module');
});

test('Rung B: usePanelView() runs before the first early return in RegistrationsPanel.tsx', () => {
	const source = STRIPPED['RegistrationsPanel.tsx'];
	const hookIdx = source.indexOf('usePanelView()');
	const firstReturnIdx = source.indexOf('panel-empty');
	assert.ok(hookIdx !== -1, 'usePanelView() call not found in RegistrationsPanel.tsx');
	assert.ok(firstReturnIdx !== -1, "the panel's own empty-paragraph class name, panel-empty, was not found");
	assert.ok(hookIdx < firstReturnIdx, 'usePanelView() must run before the first early return, or a conditionally-called hook violates the rules of hooks');
});

test('positive control: a synthetic fixture with the hook moved after the first early return is reported as inverted', () => {
	const fixture = `if (x) { return <p className="panel-empty">y</p>; } const view = usePanelView();`;
	const hookIdx = fixture.indexOf('usePanelView()');
	const firstReturnIdx = fixture.indexOf('panel-empty');
	assert.ok(hookIdx !== -1 && firstReturnIdx !== -1, 'the control fixture itself must contain both markers, or it proves nothing');
	assert.ok(hookIdx > firstReturnIdx, 'the inverted control fixture must fail the same comparison the real rung applies');
});

test('Rung C: the status and request sections carry the switch discriminant beside their grid (D-20)', () => {
	const source = STRIPPED['RegistrationsPanel.tsx'];
	const sections = source.split('<section className="eo-section">').slice(1);
	assert.equal(sections.length, 5, 'expected exactly five <section className="eo-section"> chunks');

	const statusChunk = sections.find((c) => c.includes('<BarSeries'));
	const requestChunk = sections.find((c) => c.includes('<StackedBarSeries'));
	assert.ok(statusChunk, 'no section mounts BarSeries');
	assert.ok(requestChunk, 'no section mounts StackedBarSeries');

	assert.ok(
		sectionIsSwitched(statusChunk) && statusChunk.includes('eo-count-grid'),
		'the status section must carry both the discriminant and its grid -- both representations present, one selected',
	);
	assert.ok(
		sectionIsSwitched(requestChunk) && requestChunk.includes('eo-count-grid'),
		'the request section must carry both the discriminant and its grid -- both representations present, one selected',
	);
});

test('Rung D: the intake, roster and surface-count sections stay unswitched; the discriminant occurs once in each switched section, twice in the chart-view heading-mark consts before the first section, and four times in the file', () => {
	const source = STRIPPED['RegistrationsPanel.tsx'];
	const sections = source.split('<section className="eo-section">').slice(1);
	assert.equal(sections.length, 5, 'expected exactly five <section className="eo-section"> chunks');

	const statusChunk = sections.find((c) => c.includes('<BarSeries'));
	const requestChunk = sections.find((c) => c.includes('<StackedBarSeries'));
	const intakeChunk = sections.find((c) => c.includes('<TimeSeries'));
	const rosterChunk = sections.find((c) => c.includes('eo-row'));
	assert.ok(intakeChunk, 'no section mounts TimeSeries');
	assert.ok(rosterChunk, 'no section contains eo-row');
	const remaining = sections.find(
		(c) => c !== statusChunk && c !== requestChunk && c !== intakeChunk && c !== rosterChunk,
	);
	assert.ok(remaining, 'expected a fifth, distinct section for the surface counts');

	assert.ok(
		!sectionIsSwitched(intakeChunk),
		// The intake series has no table equivalent -- a recorded user
		// deferral, not an oversight. See the todo file this rung names in
		// its own failure message rather than re-litigating the reasoning:
		// .planning/todos/pending/2026-09-15-c3-intake-series-has-no-table-equivalent.md
		'the intake series must stay chart-only in both views -- its table equivalent is deferred, see .planning/todos/pending/2026-09-15-c3-intake-series-has-no-table-equivalent.md',
	);
	assert.ok(!sectionIsSwitched(rosterChunk), 'the roster is not an aggregate and must not be switched');
	assert.ok(
		!sectionIsSwitched(remaining) && remaining.includes('eo-count-grid') && !CHART_PRIMITIVE_RE.test(remaining),
		'the surface-count section is table-only by D-05 -- it must mount no chart primitive and carry no discriminant',
	);

	assert.ok(statusChunk, 'no section mounts BarSeries');
	assert.ok(requestChunk, 'no section mounts StackedBarSeries');
	/** @param {string} text @returns {number} */
	const discriminantCount = (text) => text.split(VIEW_DISCRIMINANT).length - 1;
	assert.equal(discriminantCount(statusChunk), 1, 'the status section must carry exactly one discriminant (its ternary)');
	assert.equal(discriminantCount(requestChunk), 1, 'the request section must carry exactly one discriminant (its ternary)');
	assert.equal(discriminantCount(intakeChunk), 0, 'the intake section must carry no discriminant');
	assert.equal(discriminantCount(rosterChunk), 0, 'the roster section must carry no discriminant');
	assert.equal(discriminantCount(remaining), 0, 'the surface-count section must carry no discriminant');

	// The two chart-view heading marks: charts take no class, so in chart view a
	// changed status or request count marks its section heading instead.
	const beforeSections = source.split('<section className="eo-section">')[0];
	const headLines = beforeSections.split('\n').filter((line) => line.includes(VIEW_DISCRIMINANT));
	assert.equal(headLines.length, 2, 'expected exactly two discriminant lines before the first section (the heading-mark consts)');
	assert.ok(
		headLines.some((line) => line.includes('sectionMarkClass(marks, statusKeys)')) &&
			headLines.some((line) => line.includes('sectionMarkClass(marks, requestKeys)')),
		'each discriminant before the first section must compute a heading mark',
	);
	assert.equal(discriminantCount(source), 4, 'expected the discriminant literal to occur exactly four times across the file');
});

test('positive control: the section split is non-vacuous (5 > 2), and a synthetic chunk naming a chart primitive beside a grid but carrying no discriminant is reported unswitched', () => {
	const source = STRIPPED['RegistrationsPanel.tsx'];
	const sections = source.split('<section className="eo-section">').slice(1);
	assert.ok(sections.length > 2, 'the walk must classify more than the two switched sections, or a green run over just those two is vacuous');

	const syntheticChunk = '<BarSeries data={x} /><div className="eo-count-grid"></div>';
	assert.ok(
		!sectionIsSwitched(syntheticChunk),
		'sectionIsSwitched must not report a chunk switched merely because it mounts a chart beside a grid -- an "is it switched" check that returns true for everything is not a check',
	);
});

// --- ElectionsPanel compares the pill against a coarse clock -----------------

test('ElectionsPanel.tsx reads the clock through useNow and no longer reads snapshotInstant', () => {
	const source = STRIPPED['ElectionsPanel.tsx'];
	assert.match(source, /const nowMs = useNow\(\)/);
	assert.match(source, /toCanonicalDatetime\(nowMs\)/);
	assert.doesNotMatch(source, /snapshotInstant|resolveComparisonInstant|useContext|useSnapshotInstant/);
	assert.doesNotMatch(source, /setPhase|PHASES\b|data-phase/);
});

test('ElectionsPanel.tsx mounts LifecyclePill', () => {
	assert.match(STRIPPED['ElectionsPanel.tsx'], /LifecyclePill/);
});

// --- Panel-owned queries: only src/screens/panels/ imports the officer -----
// --- READ SURFACE from @votetorrent/web-data/officer (54-03b) --------------
//
// NOTE on scope, discovered while rewriting this walk: 54-03a already moved
// the audience-neutral CONNECTION layer (createNetworkDb, attachNetworkDb,
// etc.) into this same `./officer` barrel, and several non-panel production
// modules (src/lifecycle/*, src/main.tsx, src/screens/DashboardShell.tsx)
// legitimately import THAT from `@votetorrent/web-data/officer` -- that is
// correct, already-shipped 54-03a work, not a violation. A specifier-only
// match (the literal old `.../reads/` shape ported 1:1) would false-positive
// on all of them. The guarantee this walk actually encodes -- "panel-owned
// queries: only a panel reaches the read layer" -- is preserved by checking
// which NAMES a file imports from the barrel, not merely whether it imports
// the barrel at all.

const OFFICER_IMPORT_RE = /from ['"]@votetorrent\/web-data\/officer['"]/;

/** Every name the officer barrel re-exports from the three moved read modules -- the query surface this walk polices. Deliberately excludes the connection-layer names (createNetworkDb, attachNetworkDb, ...) and CAPABILITY_TABLES, which are audience-neutral / metadata, not a query. @type {ReadonlySet<string>} */
const OFFICER_READ_SURFACE_NAMES = new Set([
	'selectActiveElection',
	'readElectionOverview',
	'readElectionPolicies',
	'countElections',
	'ELECTIONS_TABLES_READ',
	'readBallots',
	'readQuestions',
	'countBallotSigningTasks',
	'BALLOTS_TABLES_READ',
	'readRegistrantStatusBreakdown',
	'readRegistrationRequestBreakdown',
	'readRegistrantRoster',
	'readRegistrationSurfaceCounts',
	'readRegistrationIntakeSeries',
	'hasAnyRegistrationData',
	'ROSTER_PAGE_SIZE',
	'REGISTRATIONS_TABLES_READ',
]);

/**
 * The named imports pulled from every `@votetorrent/web-data/officer` import
 * statement in `source` -- resolves `Foo as Bar` to the real exported name
 * `Foo`, since that is the name that decides whether the read surface was
 * reached, not the local alias.
 *
 * @param {string} source
 * @returns {string[]}
 */
function officerNamedImports(source) {
	/** @type {string[]} */
	const names = [];
	for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]@votetorrent\/web-data\/officer['"]/g)) {
		for (const raw of m[1].split(',')) {
			const trimmed = raw.trim();
			if (!trimmed) continue;
			names.push(trimmed.split(/\s+as\s+/)[0].trim());
		}
	}
	return names;
}

/** @param {string} dir @returns {string[]} */
function walkSourceFiles(dir) {
	/** @type {string[]} */
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkSourceFiles(full));
		} else if (/\.(js|ts|tsx)$/.test(entry.name)) {
			out.push(full);
		}
	}
	return out;
}

test('no module outside src/screens/panels/ imports an officer read-surface name (a query function or a TABLES_READ constant) from @votetorrent/web-data/officer', () => {
	const srcDir = dashboardSrc();
	/** @type {string[]} */
	const offenders = [];
	for (const file of walkSourceFiles(srcDir)) {
		if (file.startsWith(PANELS_DIR)) continue;
		const contents = stripComments(readFileSync(file, 'utf8'));
		const imported = officerNamedImports(contents);
		if (imported.some((name) => OFFICER_READ_SURFACE_NAMES.has(name))) {
			offenders.push(path.relative(srcDir, file));
		}
	}
	assert.deepEqual(offenders, []);
});

test('positive control: the read-surface-name matcher fires on a synthetic import of selectActiveElection, so a walk that finds nothing is proven discriminating', () => {
	const fixture = `import { selectActiveElection } from '@votetorrent/web-data/officer';`;
	assert.ok(officerNamedImports(fixture).includes('selectActiveElection'));
});

test('negative control: a synthetic import of ONLY connection-layer names (already legitimate outside panels since 54-03a) does not trip the read-surface matcher', () => {
	const fixture = `import { createNetworkDb, attachNetworkDb, CAPABILITY_TABLES } from '@votetorrent/web-data/officer';`;
	const imported = officerNamedImports(fixture);
	assert.ok(imported.length > 0, 'the parser itself must find names, or this control proves nothing');
	assert.ok(imported.every((name) => !OFFICER_READ_SURFACE_NAMES.has(name)));
});

// --- Styling stays on tokens --------------------------------------------------

test('election-ops.css has zero hex colour literals and declares no .panel/.panel-body/.panel--denied rule', () => {
	const cssPath = path.join(PANELS_DIR, 'election-ops.css');
	const css = readFileSync(cssPath, 'utf8');
	const stripped = stripComments(css);
	assert.doesNotMatch(stripped, /#[0-9a-fA-F]{3,6}/);
	assert.doesNotMatch(stripped, /^\.panel\s*\{/m);
	assert.doesNotMatch(stripped, /^\.panel-body\s*\{/m);
	assert.doesNotMatch(stripped, /^\.panel--denied\s*\{/m);
});

test('election-ops.css has no raw px value outside a var(--space-*) reference', () => {
	const cssPath = path.join(PANELS_DIR, 'election-ops.css');
	const css = readFileSync(cssPath, 'utf8');
	const stripped = stripComments(css);
	// Every numeric px literal must be EITHER a `1px` border-width literal
	// (the same structural constant panels.css's own `.panel`/`.pill`
	// already hardcode -- a border width is not a spacing-scale value) OR
	// inside a minmax(...) grid-template track function (panels.css's own
	// 340px card minimum sets this precedent too). Anything else must
	// reference var(--space-*).
	const pxMatches = [...stripped.matchAll(/(-?\d+(?:\.\d+)?)px/g)];
	for (const m of pxMatches) {
		const value = m[1];
		const context = stripped.slice(Math.max(0, m.index - 20), m.index + 10);
		const isBorderWidth = value === '1';
		const isMinmaxTrack = /minmax\(/.test(context);
		assert.ok(isBorderWidth || isMinmaxTrack, `unexpected raw px outside a border-width or minmax(): ${context}`);
	}
});

// --- Each panel imports its own read module ----------------------------------

test('RegistrationsPanel imports its six registration reads, and selectActiveElection, from @votetorrent/web-data/officer', () => {
	assert.match(STRIPPED['RegistrationsPanel.tsx'], OFFICER_IMPORT_RE);
	// Naming the functions, not just the specifier: the collapse from two
	// relative specifiers to one bare one must not cost this test its ability
	// to say WHICH read surface the panel pulls.
	for (const name of [
		'readRegistrantStatusBreakdown',
		'readRegistrationRequestBreakdown',
		'readRegistrantRoster',
		'readRegistrationSurfaceCounts',
		'readRegistrationIntakeSeries',
		'hasAnyRegistrationData',
		'selectActiveElection',
	]) {
		assert.ok(
			officerNamedImports(STRIPPED['RegistrationsPanel.tsx']).includes(name),
			`RegistrationsPanel.tsx no longer imports ${name} from @votetorrent/web-data/officer`,
		);
	}
});

test('ElectionsPanel imports its four election reads from @votetorrent/web-data/officer', () => {
	assert.match(STRIPPED['ElectionsPanel.tsx'], OFFICER_IMPORT_RE);
	for (const name of ['selectActiveElection', 'readElectionOverview', 'readElectionPolicies', 'countElections']) {
		assert.ok(
			officerNamedImports(STRIPPED['ElectionsPanel.tsx']).includes(name),
			`ElectionsPanel.tsx no longer imports ${name} from @votetorrent/web-data/officer`,
		);
	}
});

test('BallotsQuestionsPanel imports readBallots and readQuestions, and selectActiveElection, from @votetorrent/web-data/officer', () => {
	assert.match(STRIPPED['BallotsQuestionsPanel.tsx'], /readBallots[\s\S]*readQuestions[\s\S]*from ['"]@votetorrent\/web-data\/officer['"]/);
	assert.match(STRIPPED['BallotsQuestionsPanel.tsx'], /selectActiveElection[\s\S]*from ['"]@votetorrent\/web-data\/officer['"]/);
});

// LifecyclePill's own null-phase-guard assertion moved to
// packages/ui-web/test/shared-components.test.mjs in 53-05, alongside the
// component itself.

// --- Live panels ---------------------------------------------------------------
//
// The panels re-read when the replicated data version moves, keep their rows
// on screen while they re-read, mark changed rows and figures through one
// change-mark hook each, show the text-only action note beside items an
// officer decides in the Authority app, and make no visibility decision of
// their own. Every matcher below is first proven able to fire on a synthetic
// fixture. Banned tokens are assembled from fragments so this file never
// trips a scan of its own text.

const LIVE_FILES = ['ElectionsPanel.tsx', 'BallotsQuestionsPanel.tsx', 'RegistrationsPanel.tsx', 'KeyholdersPanel.tsx'];

/** @type {Record<string, string>} */
const LIVE_RAW = {};
/** @type {Record<string, string>} */
const LIVE_STRIPPED = {};
for (const file of LIVE_FILES) {
	LIVE_RAW[file] = readFileSync(path.join(PANELS_DIR, file), 'utf8');
	LIVE_STRIPPED[file] = stripComments(LIVE_RAW[file]);
}

const VERSION_HOOK_RE = /const \{ version \} = useDataVersion\(\)/;
const VERSION_DEPS_RE = /\}, \[db, version\]\);/;

test('live: every live panel reads the data version and lists it in its read effect dependencies', () => {
	for (const file of LIVE_FILES) {
		assert.match(LIVE_STRIPPED[file], VERSION_HOOK_RE, `${file} does not read the data version`);
		assert.match(LIVE_STRIPPED[file], VERSION_DEPS_RE, `${file}'s read effect does not depend on [db, version]`);
	}
});

test('positive control: the deps matcher misses an effect that depends on [db] alone', () => {
	assert.doesNotMatch('\t}, [db]);', VERSION_DEPS_RE);
	assert.match('\t}, [db, version]);', VERSION_DEPS_RE);
});

const LOADING_RESET_RE = /setState\(\{ (loading: true|status: 'loading')/;

/**
 * Lines that reset a panel to its loading state without the db-change guard.
 * @param {string} source @returns {string[]}
 */
function unguardedLoadingResets(source) {
	return source
		.split('\n')
		.filter((line) => LOADING_RESET_RE.test(line))
		.filter((line) => !line.trimStart().startsWith('if (dbChanged) '));
}

test('live: a re-read keeps the rows on screen -- a loading reset happens only when the db handle changed', () => {
	for (const file of LIVE_FILES) {
		const source = LIVE_STRIPPED[file];
		assert.ok(LOADING_RESET_RE.test(source), `${file}: no loading reset found, so the guard check would be vacuous`);
		assert.deepEqual(unguardedLoadingResets(source), [], `${file} resets to loading on every re-read`);
		assert.match(source, /readDbRef/, `${file} does not track which db handle it last read`);
	}
});

test('positive control: an unguarded loading reset is flagged by the same helper', () => {
	const fixture = '\t\tsetState({ loading: true, data: null });\n\t\tif (dbChanged) setState({ status: \'loading\' });';
	assert.deepEqual(unguardedLoadingResets(fixture), ['\t\tsetState({ loading: true, data: null });']);
});

const MARK_HOOK_CALL = 'useChangeMarks(markRows, markKey, markSig)';
const MARK_ROWS_NULL_RE = /const markRows = useMemo\(\(\) => \([^;]*(\? null :|: null\))/;

test('live: one change-mark hook per panel, fed null (never an empty list) while not loaded', () => {
	for (const file of LIVE_FILES) {
		const source = LIVE_STRIPPED[file];
		assert.equal(source.split(MARK_HOOK_CALL).length - 1, 1, `${file} must call ${MARK_HOOK_CALL} exactly once`);
		assert.equal((source.match(/useChangeMarks\(/g) ?? []).length, 1, `${file} must hold exactly one change-mark hook`);
		assert.match(source, MARK_ROWS_NULL_RE, `${file}'s markRows is not null while loading`);
	}
});

test('positive control: the null-while-loading matcher misses a memo that yields an empty list while loading', () => {
	assert.doesNotMatch('const markRows = useMemo(() => (state.loading ? [] : rows), [state]);', MARK_ROWS_NULL_RE);
	assert.match('const markRows = useMemo(() => (state.loading ? null : rows), [state]);', MARK_ROWS_NULL_RE);
});

const CHROME_OWNED_RE = /headerMarked|announce|PanelMarkContext|MarkAnnouncerContext|useMarkLifetime/;
const CHROME_MODULE = 'Panel' + 'Frame';

test('live: marks are applied on elements, and the header mark and announcement stay with the chrome and grid', () => {
	for (const file of LIVE_FILES) {
		const source = LIVE_STRIPPED[file];
		assert.ok(source.includes('marks.markClass('), `${file} applies no mark class`);
		assert.ok(source.includes('<ChangeMarkWord />'), `${file} renders no hidden "updated" word`);
		assert.doesNotMatch(source, CHROME_OWNED_RE, `${file} renders something the chrome or grid owns`);
		assert.ok(!LIVE_RAW[file].includes(CHROME_MODULE), `${file} names the chrome module, comments included`);
	}
});

test('positive control: the chrome-owned matcher fires on a panel rendering the announcement', () => {
	assert.match('<p>{marks.announce}</p>', CHROME_OWNED_RE);
	assert.ok(`import X from './${CHROME_MODULE}.js';`.includes(CHROME_MODULE));
});

const SELF_GATING_RE = /auth\/gate\.js|evaluate\(|grantedScopes|useEffectiveScopes/;

test('live: no panel makes a visibility decision of its own', () => {
	for (const file of LIVE_FILES) {
		assert.doesNotMatch(LIVE_STRIPPED[file], SELF_GATING_RE, `${file} gates itself`);
	}
});

test('positive control: the self-gating matcher fires on a gate import', () => {
	assert.match(`import { evaluate } from '../../auth/gate.js';`, SELF_GATING_RE);
});

const STALE_WORD_RE = new RegExp('snap' + 'shot', 'i');

test('live: no live panel names the retired frozen-instant wording, comments included', () => {
	for (const file of LIVE_FILES) {
		assert.doesNotMatch(LIVE_RAW[file], STALE_WORD_RE, `${file} still names the retired wording`);
	}
});

test('positive control: the stale-wording matcher fires on the retired prop name', () => {
	assert.match(`'${'snap' + 'shot'}Instant'`, STALE_WORD_RE);
});

const AFFORDANCE_EXTRA_RE = /cursor|role=|tabIndex/;

test('live: no live panel holds a control, a cursor, a role or a tab stop', () => {
	for (const file of LIVE_FILES) {
		assert.doesNotMatch(LIVE_STRIPPED[file], CONTROL_RE, `${file} contains a control affordance`);
		assert.doesNotMatch(LIVE_STRIPPED[file], AFFORDANCE_EXTRA_RE, `${file} makes something look interactive`);
	}
});

test('positive control: the affordance matcher fires on a tab stop', () => {
	assert.match('<span tabIndex={0}>x</span>', AFFORDANCE_EXTRA_RE);
});

const NOTE_IDENT = 'Read' + 'OnlyNote';
const NOTE_IMPORT_LINE = `import { ${NOTE_IDENT} } from '../../live/${NOTE_IDENT}.js';`;
const NOTE_ALIAS_RE = new RegExp(`${NOTE_IDENT} as `);

/**
 * How many lines of `source` equal the exact single-name note import.
 * @param {string} source @returns {number}
 */
function exactNoteImportLines(source) {
	return source.split('\n').filter((line) => line.trim() === NOTE_IMPORT_LINE).length;
}

test('live: Ballots/Questions imports the action note alone on its own line and shows the short note beside the pending figure', () => {
	const raw = LIVE_RAW['BallotsQuestionsPanel.tsx'];
	assert.equal(exactNoteImportLines(raw), 1, 'expected exactly one exact note import line');
	assert.match(raw, new RegExp(`<${NOTE_IDENT} variant="short" \\/>`));
	assert.doesNotMatch(raw, NOTE_ALIAS_RE, 'the note must not be imported under an alias');
	assert.match(LIVE_STRIPPED['BallotsQuestionsPanel.tsx'], new RegExp(`pendingSigningTasks > 0 \\? <${NOTE_IDENT} variant="short" \\/> : null`));
});

test('positive control: an aliased note import is flagged and is not an exact import line', () => {
	const fixture = `import { ${NOTE_IDENT} as Note } from '../../live/${NOTE_IDENT}.js';`;
	assert.match(fixture, NOTE_ALIAS_RE);
	assert.equal(exactNoteImportLines(fixture), 0);
});

const CONSOLE_SHAPE_RE = /console\.error\([^)]*\)\?\.name \?\? 'Error'\)/;

test('live: each live panel has exactly one console.error, and it logs the error class only', () => {
	for (const file of LIVE_FILES) {
		const source = LIVE_STRIPPED[file];
		assert.equal(source.split('console.error(').length - 1, 1, `${file} must hold exactly one console.error`);
		assert.match(source, CONSOLE_SHAPE_RE, `${file} logs more than the error class`);
	}
});

test('positive control: the console-shape matcher misses a message log', () => {
	assert.doesNotMatch("console.error('X: a read failed:', err.message);", CONSOLE_SHAPE_RE);
});

test('live: data pills inside panel rows keep the default cursor', () => {
	const css = stripComments(readFileSync(path.join(PANELS_DIR, 'election-ops.css'), 'utf8'));
	const block = css.match(/\.eo-row \.pill\s*\{([^}]*)\}/);
	assert.ok(block, 'election-ops.css declares no .eo-row .pill rule');
	assert.match(block[1], /cursor:\s*default/);
	assert.doesNotMatch(css, /cursor:\s*pointer/);
});

/** Each live panel's officer named imports, pinned: a new table read must be a deliberate edit here. @type {Record<string, string[]>} */
const PINNED_OFFICER_IMPORTS = {
	'ElectionsPanel.tsx': ['countElections', 'readElectionOverview', 'readElectionPolicies', 'selectActiveElection'],
	'BallotsQuestionsPanel.tsx': [
		'countBallotSigningTasks',
		'parseOptionRange',
		'readBallots',
		'readQuestions',
		'selectActiveElection',
	],
	'RegistrationsPanel.tsx': [
		'hasAnyRegistrationData',
		'readRegistrantRoster',
		'readRegistrantStatusBreakdown',
		'readRegistrationIntakeSeries',
		'readRegistrationRequestBreakdown',
		'readRegistrationSurfaceCounts',
		'selectActiveElection',
	],
	'KeyholdersPanel.tsx': [],
};

test('live: no live panel reads a table it did not read before (officer imports pinned)', () => {
	for (const file of LIVE_FILES) {
		assert.ok(file in PINNED_OFFICER_IMPORTS, `${file} has no pinned import list`);
		assert.deepEqual([...officerNamedImports(LIVE_STRIPPED[file])].sort(), PINNED_OFFICER_IMPORTS[file], `${file}'s officer imports changed`);
	}
});

// --- Live panels: Registrations and Keyholders --------------------------------

test('live: Registrations imports the action note alone on its own line and shows it under the requests heading, short with requests and long when empty', () => {
	const raw = LIVE_RAW['RegistrationsPanel.tsx'];
	assert.equal(exactNoteImportLines(raw), 1, 'expected exactly one exact note import line');
	assert.doesNotMatch(raw, NOTE_ALIAS_RE, 'the note must not be imported under an alias');
	const source = LIVE_STRIPPED['RegistrationsPanel.tsx'];
	const shortNote = `<${NOTE_IDENT} variant="short" />`;
	const longNote = `<${NOTE_IDENT} variant="long" />`;
	assert.ok(source.includes(shortNote) && source.includes(longNote), 'expected both note forms');
	const requestChunk = source.split('<section className="eo-section">').find((c) => c.includes('<StackedBarSeries'));
	assert.ok(requestChunk, 'no section mounts StackedBarSeries');
	const headingIdx = requestChunk.indexOf("t('panels.registrations.requestsHeading')");
	assert.ok(headingIdx !== -1, 'the requests heading is not in the request section');
	assert.ok(requestChunk.indexOf(shortNote) > headingIdx, 'the short note must follow the requests heading');
	assert.ok(requestChunk.indexOf(longNote) > headingIdx, 'the long note must follow the requests heading');
	assert.match(requestChunk, new RegExp(`requestBreakdown\\.length > 0 \\? <${NOTE_IDENT} variant="short" \\/> : <${NOTE_IDENT} variant="long" \\/>`));
});

test('live: chart view marks a changed chart at its section heading, its intake wrapper or its meter wrapper', () => {
	const registrations = LIVE_STRIPPED['RegistrationsPanel.tsx'];
	for (const call of ['sectionMarkClass(marks, statusKeys)', 'sectionMarkClass(marks, requestKeys)', 'sectionMarkClass(marks, intakeKeys)']) {
		assert.ok(registrations.includes(call), `RegistrationsPanel.tsx does not compute ${call}`);
	}
	assert.match(registrations, /className=\{withMark\('eo-heading', statusHeadingMark\)\}/);
	assert.match(registrations, /className=\{withMark\('eo-heading', requestHeadingMark\)\}/);
	assert.ok(LIVE_STRIPPED['KeyholdersPanel.tsx'].includes("withMark('aa-meter', sectionMarkClass(marks, "), 'the Keyholders meter wrapper carries no mark');
	for (const file of ['RegistrationsPanel.tsx', 'KeyholdersPanel.tsx']) {
		assert.doesNotMatch(LIVE_STRIPPED[file], /sectionMarkClass[\s\S]{0,200}\.filter\(/, `${file}'s section mark must use .find(, never .filter(`);
	}
});

// Mirrors the Authority Administration scan over this one file, so this
// plan's own gate fails before that scan would. Tokens are assembled.
const KH_STATE_RE = new RegExp(['read' + '-only', 'read' + 'only', 'writ' + 'able', 'dis' + 'abled'].join('|'), 'i');
const KH_NOTE_IMPORT_RE = new RegExp(`^\\s*import\\s*\\{\\s*${NOTE_IDENT}\\s*\\}\\s*from\\s*['"](?:\\.\\./)+live/${NOTE_IDENT}(?:\\.js)?['"];?\\s*$`, 'gm');
const KH_KEY_MATERIAL_RE = new RegExp(['User' + 'Key', 'Pub' + 'Key', 'Signer' + 'Key', 'Sig' + 'nature'].join('|'), 'i');

test('live: Keyholders stays clean against the Authority Administration scan (state words, key material, tier prose, one fetch)', () => {
	const raw = LIVE_RAW['KeyholdersPanel.tsx'];
	const exempted = raw.replace(KH_NOTE_IMPORT_RE, '').replace(new RegExp(`\\b${NOTE_IDENT}\\b`, 'g'), '');
	assert.doesNotMatch(exempted, KH_STATE_RE, 'KeyholdersPanel.tsx names a banned panel-state word, comments included');
	const source = LIVE_STRIPPED['KeyholdersPanel.tsx'];
	assert.doesNotMatch(source, KH_KEY_MATERIAL_RE, 'KeyholdersPanel.tsx names key material');
	assert.doesNotMatch(source, /\btier\b/i, 'KeyholdersPanel.tsx restates the tier as prose');
	assert.equal((source.match(/\bfetchKeyholders\(/g) ?? []).length, 1, 'KeyholdersPanel.tsx must call fetchKeyholders exactly once');
});

test('positive control: the Keyholders hygiene matchers fire on planted fixtures', () => {
	assert.match('const rows: ' + 'Read' + 'onlyArray<X> = [];', KH_STATE_RE);
	assert.match('row.' + 'Sig' + 'nature', KH_KEY_MATERIAL_RE);
	assert.match('a tier 2 panel', /\btier\b/i);
});

test('live: Registrations and Keyholders read no table they did not read before', () => {
	assert.deepEqual([...officerNamedImports(LIVE_STRIPPED['RegistrationsPanel.tsx'])].sort(), [
		'hasAnyRegistrationData',
		'readRegistrantRoster',
		'readRegistrantStatusBreakdown',
		'readRegistrationIntakeSeries',
		'readRegistrationRequestBreakdown',
		'readRegistrationSurfaceCounts',
		'selectActiveElection',
	]);
	const keyholders = LIVE_STRIPPED['KeyholdersPanel.tsx'];
	assert.deepEqual(officerNamedImports(keyholders), [], 'KeyholdersPanel.tsx must not import the officer read surface');
	const queryImports = [...keyholders.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/authority-admin-queries\.js['"]/g)].map((m) => m[1].trim());
	assert.deepEqual(queryImports, ['fetchKeyholders'], 'KeyholdersPanel.tsx must import fetchKeyholders alone from its query module');
});
