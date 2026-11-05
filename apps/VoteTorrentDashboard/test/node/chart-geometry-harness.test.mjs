/**
 * chart-geometry-harness.test.mjs — tier-1 source proof for the D-24
 * chart-geometry gate (60-07): `test/browser/chart-geometry-gate.tsx`,
 * `test/browser/vite.chart-geometry.config.ts`,
 * `test/browser/chart-geometry-fixtures.js` and
 * `test/browser/run-chart-geometry-gate.mjs`'s own contract, keeping each
 * honest without spending a browser run. Modelled file-for-file on
 * `ui-gate-harness.test.mjs`.
 *
 * This file merely READS the source tree (D-25), so it stays with the
 * dashboard and is repointed through the 53-01 resolver rather than
 * re-deriving its own root.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dashboardRoot } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';

const GATE_TSX = readFileSync(dashboardRoot('test', 'browser', 'chart-geometry-gate.tsx'), 'utf8');
const VITE_CONFIG = readFileSync(dashboardRoot('test', 'browser', 'vite.chart-geometry.config.ts'), 'utf8');
const FIXTURES_JS = readFileSync(dashboardRoot('test', 'browser', 'chart-geometry-fixtures.js'), 'utf8');
const DRIVER_MJS = readFileSync(dashboardRoot('test', 'browser', 'run-chart-geometry-gate.mjs'), 'utf8');
const PACKAGE_JSON = JSON.parse(readFileSync(dashboardRoot('package.json'), 'utf8'));

const GATE_TSX_STRIPPED = stripComments(GATE_TSX);
const VITE_CONFIG_STRIPPED = stripComments(VITE_CONFIG);
const FIXTURES_JS_STRIPPED = stripComments(FIXTURES_JS);
const DRIVER_MJS_STRIPPED = stripComments(DRIVER_MJS);

// --- (1) exactly the expected stylesheet import set, nothing else ------------------

test('(1) chart-geometry-gate.tsx imports exactly ../../src/app.css plus the two app-local panel sheets, and nothing else', () => {
	const importLines = [...GATE_TSX_STRIPPED.matchAll(/^import\s+['"]([^'"]+\.css)['"];?$/gm)].map((m) => m[1]);
	const expected = ['../../src/app.css', '../../src/screens/panels/election-ops.css', '../../src/screens/panels/authority-admin.css'];
	assert.deepEqual([...importLines].sort(), [...expected].sort(), `expected exactly ${JSON.stringify(expected)}, found ${JSON.stringify(importLines)}`);
});

test('(1 control) the bare-stylesheet-import matcher DOES fire on a planted package-tokens import line', () => {
	const fixture = "import '@votetorrent/ui-web/tokens.css';\n";
	const found = [...fixture.matchAll(/^import\s+['"]([^'"]+\.css)['"];?$/gm)].map((m) => m[1]);
	assert.ok(found.length > 0, 'matcher must be able to detect a bare stylesheet import line');
});

// --- (2) zero occurrences of the design-token package stylesheet, with a positive control ---

test('(2) chart-geometry-gate.tsx contains zero occurrences of the literal "tokens.css" (comment-stripped)', () => {
	assert.equal((GATE_TSX_STRIPPED.match(/tokens\.css/g) ?? []).length, 0);
});

test('(2 control) the tokens.css matcher DOES fire on a planted @votetorrent/ui-web/tokens.css import', () => {
	const fixture = "import '@votetorrent/ui-web/tokens.css';\n";
	assert.ok((fixture.match(/tokens\.css/g) ?? []).length > 0, 'matcher must be able to detect the real regression shape');
});

// --- (3) real chrome named, zero hand-built visible-evaluation literal -------------

test('(3) chart-geometry-gate.tsx names PanelFrame, usePanelView and evaluate, and contains zero occurrences of a hand-built visible evaluation literal', () => {
	assert.match(GATE_TSX, /\bPanelFrame\b/);
	assert.match(GATE_TSX, /\busePanelView\b/);
	assert.match(GATE_TSX, /\bevaluate\b/);
	assert.equal((GATE_TSX_STRIPPED.match(/visible\s*:\s*true/g) ?? []).length, 0);
});

test('(3 control) the hand-built-evaluation matcher DOES fire on a planted evaluation={{ visible: true }} fixture', () => {
	const fixture = 'evaluation={{ visible: true }}';
	assert.ok((fixture.match(/visible\s*:\s*true/g) ?? []).length > 0, 'matcher must be able to detect a hand-built always-visible evaluation literal');
});

// --- (4) vite.chart-geometry.config.ts imports ../../vite.config and declares no module-resolution override ---

test('(4) vite.chart-geometry.config.ts imports ../../vite.config, and contains zero occurrences of "dedupe", "plugins" or "server" (comment-stripped)', () => {
	assert.match(VITE_CONFIG_STRIPPED, /from ['"]\.\.\/\.\.\/vite\.config['"]/);
	assert.equal((VITE_CONFIG_STRIPPED.match(/dedupe/g) ?? []).length, 0);
	assert.equal((VITE_CONFIG_STRIPPED.match(/plugins/g) ?? []).length, 0);
	assert.equal((VITE_CONFIG_STRIPPED.match(/server/g) ?? []).length, 0);
});

test('(4 control) the module-resolution-override matcher DOES fire on a planted resolve.dedupe fixture', () => {
	const fixture = "resolve: { dedupe: ['react', 'react-dom'] },\n";
	assert.ok((fixture.match(/dedupe/g) ?? []).length > 0, 'matcher must be able to detect a re-declared module-resolution override');
});

// --- (5) outDir/entry/script pins, so the driver, the config and the script agree ---

test("(5) vite.chart-geometry.config.ts's outDir names dist-chart-geometry and its rollupOptions.input names chart-geometry-gate.html; package.json's build:chart-geometry script names that same config path", () => {
	assert.match(VITE_CONFIG_STRIPPED, /outDir:\s*fileURLToPath\(new URL\('\.\.\/\.\.\/dist-chart-geometry'/);
	assert.match(VITE_CONFIG_STRIPPED, /input:\s*fileURLToPath\(new URL\('\.\/chart-geometry-gate\.html'/);
	const scriptValues = Object.values(PACKAGE_JSON.scripts ?? {});
	assert.ok(
		scriptValues.includes('vite build --config test/browser/vite.chart-geometry.config.ts'),
		'expected package.json to declare build:chart-geometry pointing at test/browser/vite.chart-geometry.config.ts',
	);
});

// --- (6) the fixture module names no registrant-data field, and its exports are complete ---

const BANNED_FIELD_NAMES = Object.freeze(['Id', 'FirstName', 'LastName', 'District', 'Payload', 'Signature', 'SignorKey']);
const BANNED_FIELD_RE = new RegExp(`\\b(?:${BANNED_FIELD_NAMES.join('|')})\\s*:|\\bCid\\b`);

test('(6) chart-geometry-fixtures.js contains none of the banned registrant-data field names as a quoted key or property', () => {
	assert.doesNotMatch(FIXTURES_JS_STRIPPED, BANNED_FIELD_RE);
});

test('(6 control) the banned-field matcher DOES fire on a planted { LastName: \'x\' } fixture', () => {
	const fixture = "{ LastName: 'x' }";
	assert.match(fixture, BANNED_FIELD_RE, 'matcher must be able to detect a real registrant-data field name');
});

test('(6b) every fixture name chart-geometry-gate.tsx and run-chart-geometry-gate.mjs import from chart-geometry-fixtures.js is actually exported by it', () => {
	const exportNames = [...FIXTURES_JS.matchAll(/^export const (\w+)/gm)].map((m) => m[1]);
	assert.ok(exportNames.length > 0, 'chart-geometry-fixtures.js must declare at least one export for this echo to mean anything');
	const importPattern = /import\s*{([^}]+)}\s*from\s*'\.\/chart-geometry-fixtures\.js'/g;
	const importedInGate = [...GATE_TSX.matchAll(importPattern)].flatMap((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean));
	const importedInDriver = [...DRIVER_MJS.matchAll(importPattern)].flatMap((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean));
	const imported = [...importedInGate, ...importedInDriver];
	assert.ok(imported.length > 0, 'expected at least one import of chart-geometry-fixtures.js for this echo to mean anything');
	for (const name of imported) {
		assert.ok(exportNames.includes(name), `chart-geometry-fixtures.js does not export "${name}", imported elsewhere`);
	}
});

// --- (7) RUNG_IDS pin, and the flag name appears outside a comment -----------------

const EXPECTED_RUNG_IDS = Object.freeze([
	'c1-status-bars-proportional',
	'c1-status-labels-unclipped',
	'c2-stacked-segments-sum-to-total',
	'c2-legend-swatch-matches-series-fill',
	'c2-tooltip-names-hovered-segment-once',
	'c3-marks-match-buckets-no-gaps',
	'c5-meter-fill-ratio-proportional',
	'panel-body-free-of-controls',
	'view-switch-swaps-representations',
	'numeric-axis-ticks-are-whole-numbers',
]);

test('(7) run-chart-geometry-gate.mjs\'s RUNG_IDS array literal holds exactly the ten expected ids, in order', () => {
	const match = DRIVER_MJS_STRIPPED.match(/RUNG_IDS = Object\.freeze\(\[([\s\S]*?)\]\)/);
	assert.ok(match, 'RUNG_IDS declaration not found');
	const ids = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
	assert.deepEqual(ids, EXPECTED_RUNG_IDS);
});

test('(7 control) the RUNG_IDS-equality assertion DOES fail against a fixture array carrying an eleventh id', () => {
	const fixtureIds = [...EXPECTED_RUNG_IDS, 'an-eleventh-id-that-should-not-exist'];
	assert.throws(() => assert.deepEqual(fixtureIds, EXPECTED_RUNG_IDS), 'the equality assertion must be able to detect an extra id');
});

test('(7b) run-chart-geometry-gate.mjs names "prove-matchers" outside a comment', () => {
	assert.match(DRIVER_MJS_STRIPPED, /prove-matchers/);
});
