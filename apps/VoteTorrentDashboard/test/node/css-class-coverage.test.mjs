/**
 * css-class-coverage.test.mjs — CR-01's tier-1, dependency-free half: every
 * class name this app's own `src/` renders, plus every class name a mounted
 * `@votetorrent/ui-web/components` export renders, must resolve to a real
 * selector somewhere in this app's own reachable CSS (`scripts/lib/
 * css-class-coverage.mjs`'s `checkClassNameCoverage`). See that module's own
 * header for what "reachable" means and why it is scoped the way it is.
 *
 * The dashboard was NOT the app CR-01 found broken (its own `preview-as.css`/
 * `election-ops.css` always declared `.pv-disclosure`/`.lifecycle-pill`), but
 * this check runs here too — a shared checker is only trustworthy if it
 * clears the consumer it was never written against, not just the one that
 * was broken.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dashboardSrc, uiWebRoot, uiWebSrc } from '../../../../scripts/lib/source-paths.mjs';
import {
	checkClassNameCoverage,
	collectMountedPackageComponentClasses,
	collectReachableCssFiles,
	extractDeclaredSelectorTokens,
	stripCssComments,
} from '../../../../scripts/lib/css-class-coverage.mjs';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';

const UI_WEB_ROOT_DIR = uiWebRoot();

const componentClassNamesModule = await import(pathToFileURL(uiWebSrc('component-class-names.js')).href);
/** @type {Readonly<Record<string, ReadonlyArray<string>>>} */
const COMPONENT_CLASS_NAMES = componentClassNamesModule.COMPONENT_CLASS_NAMES;

/**
 * PRE-EXISTING, out-of-scope gaps this checker measured while landing CR-01
 * (53-CR01 gap-closure round) — NOT introduced by this task, NOT one of
 * CR-01's five reviewed selectors, and deliberately NOT fixed here per the
 * SCOPE BOUNDARY rule (only auto-fix issues directly caused by the current
 * task's changes). Logged in this phase's `deferred-items.md`. Each is a
 * genuinely rendered class with zero CSS rule anywhere in the repo:
 *   - `PanelFrame.tsx` renders `pill-scope`/`pill-tier`/`pill-sites` alongside
 *     the base `pill` class, which alone carries every visual rule -- these
 *     three modifiers may be semantic-only hooks with no distinct look, or
 *     may be an unrelated latent gap; undetermined, out of scope to decide
 *     here.
 *   - `PanelGrid.tsx` renders `sh-panel-grid-wrap`, a layout-grouping `<div>`
 *     with no rule of its own (`.panel-grid` inside it is the one styled
 *     child) -- plausibly intentional, undetermined, out of scope here.
 * This list must shrink, never silently grow -- see this constant's own
 * `ignoreClassNames` contract in scripts/lib/css-class-coverage.mjs.
 */
const PRE_EXISTING_UNSTYLED_CLASSES = ['pill-scope', 'pill-tier', 'pill-sites', 'sh-panel-grid-wrap'];

test('real check: every rendered class name in apps/VoteTorrentDashboard/src resolves to a real CSS selector (pre-existing, out-of-scope gaps excepted — see PRE_EXISTING_UNSTYLED_CLASSES above)', () => {
	const { missing, renderedCount, declaredCount } = checkClassNameCoverage({
		appSrcDir: dashboardSrc(),
		uiWebRootDir: UI_WEB_ROOT_DIR,
		componentClassNames: COMPONENT_CLASS_NAMES,
		ignoreClassNames: PRE_EXISTING_UNSTYLED_CLASSES,
	});
	assert.ok(renderedCount > 0, 'sanity: expected at least one rendered class name under src/');
	assert.ok(declaredCount > 0, 'sanity: expected at least one declared CSS selector reachable from src/');
	assert.deepEqual(missing, [], `these rendered class names have no matching CSS selector: ${missing.join(', ')}`);
});

/**
 * The names the sanity probe below asserts are NOT missing. Every one must
 * first be proven REAL by the reality guard in the same test.
 *
 * The guard, on the run that introduced it, found TWO of the four names it
 * inherited to be already vacuous, and both had been passing silently:
 *   - `lifecycle-pill--organizing` -- a phase id 54-02 renamed away;
 *   - `dt-toggle-group` -- `DetailsToggle` is mounted by this app's
 *     `test/browser/ui-gate.tsx` harness, NOT by anything under `src/`, and
 *     `collectMountedPackageComponentClasses` (correctly) only walks `src/`.
 * The first is replaced by `lifecycle-pill--settling`, the modifier the
 * dashboard's four-phase panel now actually reaches. The second is dropped:
 * this app renders no `DetailsToggle` in production, so a dashboard probe on
 * its classes could never have measured anything. `.dt-toggle-group` itself
 * stays covered where it IS rendered, by `packages/ui-web`'s own suite.
 */
const SANITY_PROBE_CLASSES = ['pv-disclosure', 'lifecycle-pill', 'lifecycle-pill--settling'];

/** The union of class names the mounted `@votetorrent/ui-web/components` exports can render. */
const MOUNTED_COMPONENT_CLASSES = collectMountedPackageComponentClasses(dashboardSrc(), COMPONENT_CLASS_NAMES);

test('sanity: the shared-component classes this app mounts are all declared, and every probed name is first proven real (pv-disclosure, lifecycle-pill + the settling modifier)', () => {
	const { missing } = checkClassNameCoverage({
		appSrcDir: dashboardSrc(),
		uiWebRootDir: UI_WEB_ROOT_DIR,
		componentClassNames: COMPONENT_CLASS_NAMES,
		ignoreClassNames: PRE_EXISTING_UNSTYLED_CLASSES,
	});
	for (const cls of SANITY_PROBE_CLASSES) {
		// REALITY GUARD, and it must run BEFORE the not-missing assertion.
		// `missing` is computed as `[...rendered].filter(cls => !declared.has(cls))`,
		// so it can only ever contain names that EXIST in `rendered`. Once a
		// probed class name ceases to exist -- a renamed modifier, a retired
		// phase id -- `!missing.includes(...)` keeps passing while proving
		// nothing at all. That is this repo's signature vacuity failure, caught
		// five separate times in phase 54, and it is silent every time: the
		// probe does not go red, it goes MEANINGLESS.
		assert.ok(
			MOUNTED_COMPONENT_CLASSES.has(cls),
			`"${cls}" is not a class any mounted @votetorrent/ui-web/components export renders -- the not-missing assertion below would pass vacuously`,
		);
		assert.ok(!missing.includes(cls), `${cls} regressed`);
	}
});

test('control: the reality guard bites -- a fabricated modifier is absent from the mounted-component class set', () => {
	assert.ok(
		!MOUNTED_COMPONENT_CLASSES.has('lifecycle-pill--not-a-real-modifier'),
		'the guard is inert if a name nobody renders is reported as mounted',
	);
	assert.ok(MOUNTED_COMPONENT_CLASSES.size > 0, 'sanity: the mounted set must be non-empty for the guard to mean anything');
});

test('the pre-existing allowlist names only classes that are actually otherwise-missing (no stale entries)', () => {
	const { missing } = checkClassNameCoverage({
		appSrcDir: dashboardSrc(),
		uiWebRootDir: UI_WEB_ROOT_DIR,
		componentClassNames: COMPONENT_CLASS_NAMES,
		ignoreClassNames: [],
	});
	for (const cls of PRE_EXISTING_UNSTYLED_CLASSES) {
		assert.ok(missing.includes(cls), `"${cls}" is no longer missing — remove it from PRE_EXISTING_UNSTYLED_CLASSES (it was fixed, this allowlist entry is now stale)`);
	}
});

// ---------------------------------------------------------------------------
// Inertness controls — see apps/VoteTorrentPublic's own copy of this file for
// the full rationale; both apps carry the same controls independently so
// neither app's suite depends on the other's for coverage.
// ---------------------------------------------------------------------------

/**
 * @param {{ tsx?: string, css?: string }} files
 * @returns {string} the fixture app src dir
 */
function makeFixtureAppSrc(files) {
	const root = mkdtempSync(path.join(os.tmpdir(), 'css-class-coverage-fixture-'));
	mkdirSync(root, { recursive: true });
	if (files.tsx !== undefined) writeFileSync(path.join(root, 'Fixture.tsx'), files.tsx);
	if (files.css !== undefined) writeFileSync(path.join(root, 'fixture.css'), files.css);
	return root;
}

test('inertness control: a rendered class with NO matching CSS selector is reported missing', () => {
	const appSrcDir = makeFixtureAppSrc({
		tsx: 'export function Fixture() { return <p className="phantom-fixture-class">x</p>; }',
		css: '.some-other-class { color: red; }',
	});
	try {
		const { missing } = checkClassNameCoverage({
			appSrcDir,
			uiWebRootDir: UI_WEB_ROOT_DIR,
			componentClassNames: COMPONENT_CLASS_NAMES,
		});
		assert.deepEqual(missing, ['phantom-fixture-class']);
	} finally {
		rmSync(appSrcDir, { recursive: true, force: true });
	}
});

test('benign control: a rendered class WITH a matching CSS selector is not reported missing', () => {
	const appSrcDir = makeFixtureAppSrc({
		tsx: 'export function Fixture() { return <p className="real-fixture-class">x</p>; }',
		css: '.real-fixture-class { color: red; }',
	});
	try {
		const { missing } = checkClassNameCoverage({
			appSrcDir,
			uiWebRootDir: UI_WEB_ROOT_DIR,
			componentClassNames: COMPONENT_CLASS_NAMES,
		});
		assert.deepEqual(missing, []);
	} finally {
		rmSync(appSrcDir, { recursive: true, force: true });
	}
});

test('inertness control: a mounted shared component with no CSS import for its class names is reported missing', () => {
	const appSrcDir = makeFixtureAppSrc({
		tsx: "import { AdvisoryDisclosure } from '@votetorrent/ui-web/components';\nexport function Fixture() { return <AdvisoryDisclosure variant=\"authority\" />; }",
		css: '.unrelated { color: red; }',
	});
	try {
		const { missing } = checkClassNameCoverage({
			appSrcDir,
			uiWebRootDir: UI_WEB_ROOT_DIR,
			componentClassNames: COMPONENT_CLASS_NAMES,
		});
		assert.ok(missing.includes('pv-disclosure'), `expected "pv-disclosure" to be reported missing, got: ${missing.join(', ')}`);
	} finally {
		rmSync(appSrcDir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Live change-mark classes.
// ---------------------------------------------------------------------------

/**
 * Classes applied through `markClassName` / `ChangeMarkWord` in
 * `src/live/useChangeMarks.ts`, not through a static `className="..."`
 * attribute, so the static extractor behind the real check above cannot see
 * them. Each must still be a string literal in that file (reality guard) and
 * a declared selector in this app's reachable CSS.
 */
const LIVE_DYNAMIC_CLASSES = ['change-mark', 'change-mark--fading', 'change-mark__word'];

const USE_CHANGE_MARKS_STRIPPED = stripComments(readFileSync(dashboardSrc('live', 'useChangeMarks.ts'), 'utf8'));

/** Every class selector declared in the CSS reachable from the dashboard's src/. */
const REACHABLE_DECLARED = new Set(
	collectReachableCssFiles(dashboardSrc(), UI_WEB_ROOT_DIR).flatMap((file) => [
		...extractDeclaredSelectorTokens(stripCssComments(readFileSync(file, 'utf8'))),
	]),
);

test('reality guard: each live dynamic mark class is a string literal in useChangeMarks.ts', () => {
	for (const cls of LIVE_DYNAMIC_CLASSES) {
		assert.ok(
			USE_CHANGE_MARKS_STRIPPED.includes(`'${cls}'`),
			`"${cls}" is not a string literal in useChangeMarks.ts -- the declared-selector check below would prove nothing`,
		);
	}
});

test('every live dynamic mark class is a declared selector in the reachable CSS', () => {
	for (const cls of LIVE_DYNAMIC_CLASSES) {
		assert.ok(REACHABLE_DECLARED.has(cls), `".${cls}" is applied by useChangeMarks.ts but no reachable CSS declares it`);
	}
});

test('control: a fabricated mark modifier is not declared', () => {
	assert.ok(REACHABLE_DECLARED.size > 0, 'sanity: the reachable declared set must be non-empty');
	assert.ok(!REACHABLE_DECLARED.has('change-mark--bogus'), 'the declared-selector check is inert if a made-up class reads as declared');
});
