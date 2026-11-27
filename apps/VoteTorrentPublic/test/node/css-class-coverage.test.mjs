/**
 * css-class-coverage.test.mjs — CR-01's tier-1, dependency-free half: every
 * class name this app's own `src/` renders, plus every class name a mounted
 * `@votetorrent/ui-web/components` export renders, must resolve to a real
 * selector somewhere in this app's own reachable CSS (`scripts/lib/
 * css-class-coverage.mjs`'s `checkClassNameCoverage`). See that module's own
 * header for what "reachable" means and why it is scoped the way it is.
 *
 * This is the cheaper, no-browser-needed sibling of
 * `packages/ui-web/scripts/run-ui-gates.mjs`'s new `resolved-component-styles`
 * browser rung — either alone would have caught CR-01's measured defect
 * (`.pv-disclosure`, `.lifecycle-pill` + 3 modifiers, `.election-title`,
 * `.dt-toggle-group` all resolving to zero rules in this app); this one
 * catches it before any browser ever runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { publicSrc, uiWebRoot, uiWebSrc } from '../../../../scripts/lib/source-paths.mjs';
import {
	checkClassNameCoverage,
	collectReachableCssFiles,
	stripCssComments,
	extractDeclaredSelectorTokens,
} from '../../../../scripts/lib/css-class-coverage.mjs';

const UI_WEB_ROOT_DIR = uiWebRoot();

const componentClassNamesModule = await import(pathToFileURL(uiWebSrc('component-class-names.js')).href);
/** @type {Readonly<Record<string, ReadonlyArray<string>>>} */
const COMPONENT_CLASS_NAMES = componentClassNamesModule.COMPONENT_CLASS_NAMES;

/** @param {string} dir @returns {string[]} */
function walkAll(dir) {
	/** @type {string[]} */
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkAll(full));
		} else {
			out.push(full);
		}
	}
	return out;
}

test('real check: every rendered class name in apps/VoteTorrentPublic/src resolves to a real CSS selector', () => {
	const { missing, renderedCount, declaredCount } = checkClassNameCoverage({
		appSrcDir: publicSrc(),
		uiWebRootDir: UI_WEB_ROOT_DIR,
		componentClassNames: COMPONENT_CLASS_NAMES,
	});
	assert.ok(renderedCount > 0, 'sanity: expected at least one rendered class name under src/');
	assert.ok(declaredCount > 0, 'sanity: expected at least one declared CSS selector reachable from src/');
	assert.deepEqual(missing, [], `these rendered class names have no matching CSS selector: ${missing.join(', ')}`);
});

test('sanity: the five CR-01 selectors are all declared and rendered (the specific regression this check exists to catch)', () => {
	const { missing } = checkClassNameCoverage({
		appSrcDir: publicSrc(),
		uiWebRootDir: UI_WEB_ROOT_DIR,
		componentClassNames: COMPONENT_CLASS_NAMES,
	});
	const probes = ['pv-disclosure', 'lifecycle-pill', 'lifecycle-pill--pre', 'election-title', 'dt-toggle-group'];

	// Guard against a stale probe name passing VACUOUSLY (I-14):
	// `missing` can only ever contain names that are both declared and
	// rendered, so once a name like `lifecycle-pill--organizing` stops
	// existing anywhere, it is not in `missing` either -- and
	// `!missing.includes(name)` then passes while proving nothing. This is
	// the repo's standing "a probe that can go stale is a probe that passes
	// vacuously" failure. Every probe name below must be demonstrably real --
	// either declared in COMPONENT_CLASS_NAMES's flattened union, or present
	// as a literal substring in at least one file under publicSrc() -- before
	// it is asserted not-missing. A stale probe name then fails LOUDLY,
	// naming itself, instead of silently proving nothing.
	const declaredUniverse = new Set(Object.values(COMPONENT_CLASS_NAMES).flat());
	for (const cls of probes) {
		const declaredSomewhere = declaredUniverse.has(cls);
		const renderedSomewhere = walkAll(publicSrc()).some((file) => readFileSync(file, 'utf8').includes(cls));
		assert.ok(
			declaredSomewhere || renderedSomewhere,
			`CR-01 probe "${cls}" exists nowhere (not in COMPONENT_CLASS_NAMES, not as a literal under src/) -- ` +
				`this is CR-01's regression probe list, and a name that no longer exists anywhere makes the ` +
				`probe below inert rather than green`,
		);
	}

	for (const cls of probes) {
		assert.ok(!missing.includes(cls), `${cls} regressed — this is exactly CR-01's original defect`);
	}
});

// ---------------------------------------------------------------------------
// Inertness controls — a check that cannot detect a planted violation proves
// nothing about the real app. Built against throwaway fixture directories, so
// these controls never depend on (or risk mutating) real repo state.
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
		tsx: "import { LifecyclePill } from '@votetorrent/ui-web/components';\nexport function Fixture() { return <LifecyclePill phase=\"voting\" />; }",
		css: '.unrelated { color: red; }',
	});
	try {
		const { missing } = checkClassNameCoverage({
			appSrcDir,
			uiWebRootDir: UI_WEB_ROOT_DIR,
			componentClassNames: COMPONENT_CLASS_NAMES,
		});
		assert.ok(missing.includes('lifecycle-pill'), `expected "lifecycle-pill" to be reported missing, got: ${missing.join(', ')}`);
		assert.ok(missing.includes('lifecycle-pill--voting'));
	} finally {
		rmSync(appSrcDir, { recursive: true, force: true });
	}
});

test('a fixture app.css @importing @votetorrent/ui-web/components.css resolves the shared components classes', () => {
	const appSrcDir = makeFixtureAppSrc({
		tsx: "import { AdvisoryDisclosure } from '@votetorrent/ui-web/components';\nexport function Fixture() { return <AdvisoryDisclosure variant=\"public\" />; }",
		css: "@import '@votetorrent/ui-web/components.css';\n",
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

// ===========================================================================
// The DECLARED-SIDE assertion (54-09).
//
// `checkClassNameCoverage` above runs rendered -> declared, which makes it
// structurally blind to CSS that lands BEFORE its markup -- and that is
// exactly this phase's situation: the public election view's rules land in
// wave 3 and the components that mount them land in waves 5 through 8. So
// this adds the reverse direction, scoped to this phase's own inventory:
// every class a later render plan will mount must already resolve to a real
// selector in this app's comment-stripped reachable CSS.
//
// What this deliberately does NOT assert: the reverse-reverse direction,
// declared-but-never-rendered. These rules are three to five waves ahead of
// their markup, so a declared-but-unrendered class is the EXPECTED state
// right now, not a defect. The existing rendered -> declared check above
// brings that direction to bear on each of them automatically as the render
// plans land -- nothing extra is needed here, and asserting it now would
// simply be red for a correct reason at the wrong time.
//
// Comment stripping is load-bearing rather than incidental. `app.css` is a
// heavily commented file and this phase's own comment blocks name these
// classes in prose; without the strip, a class that existed ONLY in a
// comment would satisfy the assertion. The fixture control below is what
// proves the strip is really happening.
// ===========================================================================

/**
 * Every class name this phase's render plans will mount. Frozen and
 * hand-listed because it IS the inventory -- there is nothing to derive it
 * from until the markup exists, which is the whole reason this direction
 * needs its own check.
 *
 * Nineteen, not the twenty the plan's prose says: the plan's own enumeration
 * lists nineteen names and its verification one-liner checks nineteen. The
 * count is measured here rather than adopted.
 * @type {ReadonlyArray<string>}
 */
const PHASE_54_PUBLIC_CLASSES = Object.freeze([
	'status-banner',
	'status-banner__tone',
	'status-banner__headline',
	'status-banner--go',
	'status-banner--wait',
	'status-banner--done',
	'status-banner--bad',
	'fact-section',
	'fact-section__heading',
	'fact-card',
	'fact-card--gap',
	'fact-card__label',
	'fact-card__body',
	'registrant-roll',
	'registrant-roll__note',
	'election-index',
	'election-index__item',
	'public-caveats',
	'public-caveat',
]);

/**
 * The one predicate every assertion below shares -- the real check, the
 * comment-strip control and the inertness control all go through it, so a
 * control that passes really is exercising the same pipeline the real check
 * uses rather than a look-alike written beside it.
 * @param {ReadonlyArray<string>} cssSources
 * @returns {Set<string>}
 */
function declaredTokensFrom(cssSources) {
	/** @type {Set<string>} */
	const tokens = new Set();
	for (const source of cssSources) {
		for (const token of extractDeclaredSelectorTokens(stripCssComments(source))) tokens.add(token);
	}
	return tokens;
}

const REACHABLE_CSS_FILES = collectReachableCssFiles(publicSrc(), UI_WEB_ROOT_DIR);
const REACHABLE_CSS_SOURCES = REACHABLE_CSS_FILES.map((file) => readFileSync(file, 'utf8'));

test('sanity: the reachable CSS set is non-empty and includes this app own app.css (an empty set would make every declared-side assertion below vacuously pass)', () => {
	assert.ok(REACHABLE_CSS_FILES.length > 0, 'expected at least one reachable CSS file');
	assert.ok(
		REACHABLE_CSS_FILES.some((f) => f.endsWith('app.css')),
		`expected app.css among the reachable files, got: ${REACHABLE_CSS_FILES.join(', ')}`,
	);
});

test('the phase-54 public class inventory is 19 names with no duplicates -- asserted on itself so a silent deletion from the list is visible rather than shrinking the check', () => {
	assert.equal(PHASE_54_PUBLIC_CLASSES.length, 19);
	assert.equal(new Set(PHASE_54_PUBLIC_CLASSES).size, 19, 'the inventory contains a duplicate');
});

test('declared-side check: every phase-54 public class resolves to a real selector in the comment-stripped reachable CSS', () => {
	const declared = declaredTokensFrom(REACHABLE_CSS_SOURCES);
	const missing = PHASE_54_PUBLIC_CLASSES.filter((cls) => !declared.has(cls));
	assert.deepEqual(
		missing,
		[],
		`these phase-54 classes have no CSS rule, so the render plan that mounts them would render unstyled markup: ${missing.join(', ')}`,
	);
});

test('comment-strip control: a class token whose ONLY occurrence is inside a CSS comment is NOT reported as declared -- without this, a rule that exists only in prose would satisfy the check above', () => {
	const fixture = '/* .only-in-a-comment-fixture is discussed here and nowhere else */\n.a-real-fixture-rule { color: var(--text); }\n';
	const declared = declaredTokensFrom([fixture]);
	assert.ok(declared.has('a-real-fixture-rule'), 'sanity: the real rule in the fixture must be found');
	assert.ok(
		!declared.has('only-in-a-comment-fixture'),
		'comment stripping is not happening -- a class named only in a comment was reported as declared',
	);
});

test('inertness control: a fabricated class name that is declared nowhere is reported absent by the same predicate the real check uses', () => {
	const declared = declaredTokensFrom(REACHABLE_CSS_SOURCES);
	assert.ok(
		!declared.has('phantom-phase-54-class-that-is-declared-nowhere'),
		'the declared-side predicate reports an undeclared name as present -- it cannot fail, so it proves nothing above',
	);
});

test('the comment strip is load-bearing on the REAL file too: at least one phase-54 class is named in an app.css comment, so a stripless check would have a prose-only path to passing', () => {
	const appCss = REACHABLE_CSS_SOURCES[REACHABLE_CSS_FILES.findIndex((f) => f.endsWith('app.css'))];
	const commentText = (appCss.match(/\/\*[\s\S]*?\*\//g) ?? []).join('\n');
	const namedInProse = PHASE_54_PUBLIC_CLASSES.filter((cls) => commentText.includes(cls));
	assert.ok(
		namedInProse.length > 0,
		'no phase-54 class is mentioned in an app.css comment -- if that is genuinely true the strip is merely defensive here, ' +
			'but this repo has shipped a self-tripping checker several times and the assumption is worth an assertion',
	);
});
