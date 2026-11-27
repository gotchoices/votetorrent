/**
 * ui-gate-harness.test.mjs — tier-1 source proof for the D-19/D-24 styled
 * harness: `test/browser/ui-gate.tsx`, `test/browser/vite.gate.config.ts`
 * and the app's own `gate:ui` script/`app.css`/`index.html` wiring, keeping
 * each honest without spending a browser run. The L1-L5 section pins the
 * live gate harness (`test/browser/live-gate.tsx`, 66-25) the same way.
 *
 * This file merely READS the source tree (D-25), so it stays with the
 * dashboard and is repointed through the 53-01 resolver rather than
 * re-deriving its own root.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { dashboardRoot, dashboardSrc, uiWebSrc } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';

const UI_GATE_TSX = readFileSync(dashboardRoot('test', 'browser', 'ui-gate.tsx'), 'utf8');
const VITE_GATE_CONFIG = readFileSync(dashboardRoot('test', 'browser', 'vite.gate.config.ts'), 'utf8');
const PACKAGE_JSON = JSON.parse(readFileSync(dashboardRoot('package.json'), 'utf8'));
const APP_CSS = readFileSync(dashboardSrc('app.css'), 'utf8');
const INDEX_HTML = readFileSync(dashboardRoot('index.html'), 'utf8');
const COMPONENTS_JS = readFileSync(uiWebSrc('components.js'), 'utf8');

const UI_GATE_TSX_STRIPPED = stripComments(UI_GATE_TSX);
const LIVE_GATE_TSX = readFileSync(dashboardRoot('test', 'browser', 'live-gate.tsx'), 'utf8');
const LIVE_GATE_HTML = readFileSync(dashboardRoot('test', 'browser', 'live-gate.html'), 'utf8');
const COMPOSE_GATE_HTML = readFileSync(dashboardRoot('test', 'browser', 'compose-gate.html'), 'utf8');
const SHELL_GATE_HTML = readFileSync(dashboardRoot('test', 'browser', 'shell-gate.html'), 'utf8');
const LIVE_GATE_TSX_STRIPPED = stripComments(LIVE_GATE_TSX);
const VITE_GATE_CONFIG_STRIPPED = stripComments(VITE_GATE_CONFIG);

// --- (1) exactly one stylesheet import, and it is ../../src/app.css -----------------

test('(1) ui-gate.tsx contains exactly one stylesheet import, and it is ../../src/app.css', () => {
	const importLines = [...UI_GATE_TSX_STRIPPED.matchAll(/^import\s+['"]([^'"]+\.css)['"];?$/gm)];
	assert.equal(importLines.length, 1, `expected exactly one bare stylesheet import, found ${importLines.length}`);
	assert.equal(importLines[0][1], '../../src/app.css');
});

// --- (2) zero occurrences of tokens.css, with a positive control --------------------

test('(2) ui-gate.tsx contains zero occurrences of tokens.css (comment-stripped)', () => {
	assert.equal((UI_GATE_TSX_STRIPPED.match(/tokens\.css/g) ?? []).length, 0);
});

test('(2 control) the tokens.css matcher DOES fire on a planted @votetorrent/ui-web/tokens.css import', () => {
	const fixture = "import '@votetorrent/ui-web/tokens.css';\n";
	assert.ok((fixture.match(/tokens\.css/g) ?? []).length > 0, 'matcher must be able to detect the real regression shape');
});

// --- (3) vite.gate.config.ts imports ../../vite.config and declares no dedupe ------

test('(3) vite.gate.config.ts imports ../../vite.config, and contains zero occurrences of dedupe (comment-stripped)', () => {
	assert.match(VITE_GATE_CONFIG_STRIPPED, /from ['"]\.\.\/\.\.\/vite\.config['"]/);
	assert.equal((VITE_GATE_CONFIG_STRIPPED.match(/dedupe/g) ?? []).length, 0);
});

test('(3 control) the dedupe matcher DOES fire on a planted resolve.dedupe — keeps 53-11\'s inversion control non-inert', () => {
	const fixture = "resolve: { dedupe: ['react', 'react-dom'] },\n";
	assert.ok((fixture.match(/dedupe/g) ?? []).length > 0, 'matcher must be able to detect a re-declared dedupe');
});

// --- (4) outDir names test/browser/dist, input names ui-gate.html ------------------

test('(4) vite.gate.config.ts\'s build.outDir names test/browser/dist and its build.rollupOptions.input names ui-gate.html', () => {
	assert.match(VITE_GATE_CONFIG_STRIPPED, /outDir:\s*fileURLToPath\(new URL\('\.\/dist'/);
	assert.match(VITE_GATE_CONFIG_STRIPPED, /input:\s*fileURLToPath\(new URL\('\.\/ui-gate\.html'/);
});

// --- (5) package.json scripts contain an entry invoking run-ui-gates.mjs -----------

test('(5) package.json scripts contain an entry invoking run-ui-gates.mjs', () => {
	const scriptValues = Object.values(PACKAGE_JSON.scripts ?? {});
	assert.ok(
		scriptValues.some((v) => typeof v === 'string' && v.includes('run-ui-gates.mjs')),
		'expected at least one script invoking run-ui-gates.mjs (the entry D-21/53-12 will require of every consumer)',
	);
});

// --- (6) the canonical token form, asserted rather than assumed --------------------

test('(6) app.css contains the @votetorrent/ui-web/tokens.css @import, and index.html contains no tokens.css reference', () => {
	assert.match(stripComments(APP_CSS), /@import\s+['"]@votetorrent\/ui-web\/tokens\.css['"];/);
	assert.equal((INDEX_HTML.match(/tokens\.css/g) ?? []).length, 0);
});

// --- (7) every named export of components.js appears in ui-gate.tsx ---------------

test('(7) every named export of packages/ui-web/src/components.js appears in ui-gate.tsx — a cheap tier-1 echo of the runner\'s shared-components-mounted rung', () => {
	const exportNames = [...COMPONENTS_JS.matchAll(/^export \{ (\w+) \} from '\.\/components\/\1\.js';$/gm)].map((m) => m[1]);
	assert.ok(exportNames.length > 0, 'components.js must declare at least one export for this echo to mean anything');
	for (const name of exportNames) {
		assert.ok(
			new RegExp(`\\b${name}\\b`).test(UI_GATE_TSX),
			`ui-gate.tsx does not reference "${name}" — the D-19 shared-components-mounted rung would fail against this build`,
		);
	}
});

// --- (8) the harness's stylesheet graph is representative of the shipped page (CR-01) --

test('(8) app.css also contains the @votetorrent/ui-web/components.css @import — CR-01\'s harness-representativeness fix: without it, the runner\'s resolved-component-styles rung would pass on a page where the shared components have no CSS rule at all', () => {
	assert.match(stripComments(APP_CSS), /@import\s+['"]@votetorrent\/ui-web\/components\.css['"];/);
});

test('(8 control) the components.css-absence matcher would fire on a fixture app.css missing that import', () => {
	const fixture = "@import '@votetorrent/ui-web/tokens.css';\n.layout { display: grid; }\n";
	assert.doesNotMatch(fixture, /@import\s+['"]@votetorrent\/ui-web\/components\.css['"];/, 'sanity: this fixture must not contain the import, or the control proves nothing');
});

// --- 66-25: the live gate harness (test/browser/live-gate.tsx), pinned at tier 1 ----

// --- (L1) live-gate.tsx: exactly one stylesheet import, ../../src/app.css -------------

test('(L1) live-gate.tsx contains exactly one stylesheet import, and it is ../../src/app.css', () => {
	const importLines = [...LIVE_GATE_TSX_STRIPPED.matchAll(/^import\s+['"]([^'"]+\.css)['"];?$/gm)];
	assert.equal(importLines.length, 1, `expected exactly one bare stylesheet import, found ${importLines.length}`);
	assert.equal(importLines[0][1], '../../src/app.css');
});

test('(L1 control) the stylesheet-import matcher counts a planted second sheet', () => {
	const fixture = "import '../../src/app.css';\nimport './extra.css';\n";
	assert.equal([...fixture.matchAll(/^import\s+['"]([^'"]+\.css)['"];?$/gm)].length, 2);
});

// --- (L2) the real shell and pairing screen, with the two seams -------------------------

test('(L2) live-gate.tsx renders the real DashboardShell and Pairing from ../../src/screens/ and passes bootDeps and loadPairing', () => {
	assert.match(LIVE_GATE_TSX_STRIPPED, /import \{ DashboardShell \} from '\.\.\/\.\.\/src\/screens\/DashboardShell\.js';/);
	assert.match(LIVE_GATE_TSX_STRIPPED, /import \{ Pairing, routeFromRegistry \} from '\.\.\/\.\.\/src\/screens\/Pairing\.js';/);
	assert.match(LIVE_GATE_TSX_STRIPPED, /<DashboardShell[\s\S]*?bootDeps=\{bootDeps\}/);
	assert.match(LIVE_GATE_TSX_STRIPPED, /<Pairing[\s\S]*?loadPairing=\{loadPairing\}/);
});

test('(L2 control) the seam matcher does not fire on a shell mounted without bootDeps', () => {
	const fixture = '<DashboardShell key={route.mount} initialNetworkHash={h} onPairAnother={a} onUnpaired={b} onNoNetworks={c} />';
	assert.doesNotMatch(fixture, /<DashboardShell[^>]*bootDeps=\{bootDeps\}/);
});

// --- (L3) nothing under src/ imports test/browser ------------------------------------

/** @param {string} dir @returns {string[]} */
function walk(dir) {
	/** @type {string[]} */
	const out = [];
	for (const name of readdirSync(dir)) {
		const full = path.join(dir, name);
		if (statSync(full).isDirectory()) out.push(...walk(full));
		else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(full);
	}
	return out;
}
const TEST_BROWSER_IMPORT = /(?:from\s+|import\s*\(\s*|import\s+)['"][^'"]*test\/browser[^'"]*['"]/;

test('(L3) no file under src/ imports anything from test/browser (comment-stripped)', () => {
	const offenders = walk(dashboardSrc()).filter((file) => TEST_BROWSER_IMPORT.test(stripComments(readFileSync(file, 'utf8'))));
	assert.deepEqual(offenders, []);
});

test('(L3 control) a planted import line is detected', () => {
	assert.ok(TEST_BROWSER_IMPORT.test("import { GateApp } from '../../test/browser/live-gate.js';"));
	assert.ok(TEST_BROWSER_IMPORT.test("const m = await import('../test/browser/live-gate.js');"));
});

// --- (L4) the two package scripts ------------------------------------------------------

test('(L4) package.json carries gate:live and gate:prove-live-matchers naming run-live-gate.mjs', () => {
	assert.equal(PACKAGE_JSON.scripts['gate:live'], 'node test/browser/run-live-gate.mjs');
	assert.equal(PACKAGE_JSON.scripts['gate:prove-live-matchers'], 'node test/browser/run-live-gate.mjs --prove-matchers');
});

// --- (L5) only live-gate.html runs the driver -------------------------------------------

const DATA_GATE = /data-gate=["']live-gate["']/;

test('(L5) live-gate.html sets data-gate="live-gate"; compose-gate.html and shell-gate.html do not', () => {
	assert.match(LIVE_GATE_HTML, DATA_GATE);
	assert.doesNotMatch(COMPOSE_GATE_HTML, DATA_GATE);
	assert.doesNotMatch(SHELL_GATE_HTML, DATA_GATE);
	assert.match(LIVE_GATE_TSX_STRIPPED, /dataset\.gate === 'live-gate'/);
});

test('(L5 control) the data-gate matcher fires on a planted attribute', () => {
	assert.match('<html lang="en" data-gate="live-gate">', DATA_GATE);
});
