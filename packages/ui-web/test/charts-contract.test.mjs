/**
 * charts-contract.test.mjs — the five source-level rungs (plus their
 * controls) that keep the 60-03 chart primitives' frozen contract honest:
 * zero hex, zero controls with a write path (D-11), the `./charts/`
 * barrel/manifest lockstep `package-shape.test.mjs` rung 8's own regex
 * cannot reach (it is scoped to `./components/`), every manifest class
 * having a declared CSS rule, and the two files' geometry constants agreeing
 * with each other so 60-07/60-08 never drift against a stale number.
 *
 * Every matcher below runs against `stripComments()`-ed source — this
 * repo's own self-tripping-checker hazard means a matcher that can be
 * satisfied by a header comment proves nothing about the real file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../../scripts/lib/strip-comments.mjs';
import { COMPONENT_CLASS_NAMES } from '../src/component-class-names.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(HERE, '..');
const CHARTS_DIR = path.join(PACKAGE_ROOT, 'src', 'charts');
const COMPONENTS_JS_PATH = path.join(PACKAGE_ROOT, 'src', 'components.js');
const COMPONENTS_CSS_PATH = path.join(PACKAGE_ROOT, 'src', 'components.css');
const CHART_CONTRACTS_PATH = path.join(CHARTS_DIR, 'chart-contracts.ts');

const CHART_EXPORT_NAMES = Object.freeze(['BarSeries', 'StackedBarSeries', 'TimeSeries', 'Meter']);
const CHART_INTERNAL_FILES = Object.freeze(['chart-frame.tsx', 'chart-contracts.ts']);

/** @returns {string[]} every .tsx/.ts file under src/charts/, basenames only */
function chartFileNames() {
	return readdirSync(CHARTS_DIR).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'));
}

/** @returns {Map<string, string>} filename -> comment-stripped source, for every file under src/charts/ */
function readAllChartSourcesStripped() {
	/** @type {Map<string, string>} */
	const out = new Map();
	for (const name of chartFileNames()) {
		out.set(name, stripComments(readFileSync(path.join(CHARTS_DIR, name), 'utf8')));
	}
	return out;
}

// --- rung 1: zero hex -------------------------------------------------------

test('rung 1: no file under src/charts/ contains a hex colour literal (comment-stripped)', () => {
	const sources = readAllChartSourcesStripped();
	for (const [name, source] of sources) {
		assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}/, `${name} contains a hex colour literal after comment-stripping`);
	}
});

test('rung 1 (control): the hex matcher DOES fire on a planted fixture', () => {
	const fixture = "const oops = '#ff00aa';";
	assert.match(fixture, /#[0-9a-fA-F]{3,8}/);
});

// --- rung 2: control absence (D-11) -----------------------------------------

const CONTROL_RE = /<button|<form|<input|<select|<textarea|onClick|onSubmit|onChange|onMouseDown|href=|dangerouslySetInnerHTML/;

test('rung 2: no file under src/charts/ contains a click/submit/change handler, an anchor href, a form control element, or dangerouslySetInnerHTML (comment-stripped)', () => {
	const sources = readAllChartSourcesStripped();
	for (const [name, source] of sources) {
		assert.doesNotMatch(source, CONTROL_RE, `${name} contains a control-shaped construct after comment-stripping`);
	}
});

test('rung 2 (control): the control matcher DOES fire on a planted handler fixture', () => {
	const fixture = 'return <button onClick={doThing}>go</button>;';
	assert.match(fixture, CONTROL_RE);
});

// --- rung 3: barrel lockstep -------------------------------------------------

test('rung 3: components.js\'s ./charts/ specifiers equal the .tsx files under src/charts/ (minus the two internal modules) equal the four chart keys of COMPONENT_CLASS_NAMES', () => {
	const componentsSrc = readFileSync(COMPONENTS_JS_PATH, 'utf8');
	const specifierRe = /from\s+['"](\.\/charts\/[^'"]+\.js)['"]/g;
	const specifiers = [...componentsSrc.matchAll(specifierRe)].map((m) => m[1]);
	const specifierNames = specifiers.map((s) => path.basename(s, '.js')).sort();

	const tsxOnDisk = chartFileNames()
		.filter((f) => f.endsWith('.tsx') && !CHART_INTERNAL_FILES.includes(f))
		.map((f) => path.basename(f, '.tsx'))
		.sort();

	const manifestChartKeys = [...CHART_EXPORT_NAMES].sort();

	assert.deepEqual(specifierNames, tsxOnDisk, 'components.js ./charts/ specifiers must equal the public .tsx files under src/charts/');
	assert.deepEqual(specifierNames, manifestChartKeys, 'components.js ./charts/ specifiers must equal COMPONENT_CLASS_NAMES\' four chart keys');

	for (const specifier of specifiers) {
		const jsPath = path.join(PACKAGE_ROOT, 'src', specifier);
		const tsxPath = jsPath.replace(/\.js$/, '.tsx');
		assert.ok(
			readdirSync(path.dirname(tsxPath)).includes(path.basename(tsxPath)),
			`expected a sibling .tsx for specifier "${specifier}" at ${tsxPath}`,
		);
		assert.ok(
			!readdirSync(path.dirname(jsPath)).includes(path.basename(jsPath)),
			`specifier "${specifier}" must resolve ONLY via a bundler's .tsx extension probe — a literal .js file at ${jsPath} would defeat the ERR_MODULE_NOT_FOUND proof`,
		);
	}
});

// --- rung 4: every manifest class has a rule --------------------------------

/** @returns {Set<string>} every class-selector token declared in components.css, comment-stripped */
function declaredCssClassTokens() {
	const stripped = readFileSync(COMPONENTS_CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
	const tokens = new Set();
	const re = /\.([A-Za-z][\w-]*)/g;
	let match;
	while ((match = re.exec(stripped)) !== null) tokens.add(match[1]);
	return tokens;
}

test('rung 4: every class name across the four chart manifest entries appears as a declared selector in comment-stripped components.css', () => {
	const declared = declaredCssClassTokens();
	for (const exportName of CHART_EXPORT_NAMES) {
		for (const cls of COMPONENT_CLASS_NAMES[exportName]) {
			assert.ok(declared.has(cls), `components.css declares no selector for "${cls}" (from ${exportName})`);
		}
	}
});

test('rung 4 (control): a fabricated name is reported absent, and a name occurring only inside a CSS comment is not counted', () => {
	const declared = declaredCssClassTokens();
	assert.ok(!declared.has('vt-chart__phantom'), 'fabricated name must be reported absent');

	const commentOnlyCss = '/* .vt-chart__comment-only-phantom { color: red; } */\n.vt-chart__real { color: blue; }';
	const stripped = commentOnlyCss.replace(/\/\*[\s\S]*?\*\//g, '');
	const tokens = new Set();
	const re = /\.([A-Za-z][\w-]*)/g;
	let match;
	while ((match = re.exec(stripped)) !== null) tokens.add(match[1]);
	assert.ok(!tokens.has('vt-chart__comment-only-phantom'), 'a class occurring only inside a CSS comment must not count as declared');
	assert.ok(tokens.has('vt-chart__real'), 'sanity: a real declared selector outside the comment must still be found');
});

// --- rung 5: geometry/CSS agreement -----------------------------------------

/**
 * Reads a `export const NAME = <number>;` declaration out of
 * chart-contracts.ts as text.
 * @param {string} name
 * @returns {number}
 */
function readGeometryConstant(name) {
	const source = readFileSync(CHART_CONTRACTS_PATH, 'utf8');
	const match = source.match(new RegExp(`export const ${name} = (\\d+);`));
	assert.ok(match, `expected to find "export const ${name} = <number>;" in chart-contracts.ts`);
	return Number(match[1]);
}

/**
 * Reads a `height: <number>px;` declaration out of the named selector's rule
 * block in comment-stripped components.css.
 * @param {string} selector
 * @returns {number}
 */
function readDeclaredHeightPx(selector) {
	const stripped = readFileSync(COMPONENTS_CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const blockMatch = stripped.match(new RegExp(`\\.${escaped}\\s*\\{([^}]*)\\}`));
	assert.ok(blockMatch, `expected to find a rule block for "${selector}" in components.css`);
	const heightMatch = blockMatch[1].match(/height:\s*(\d+)px;/);
	assert.ok(heightMatch, `expected a "height: <n>px;" declaration inside "${selector}"'s rule block`);
	return Number(heightMatch[1]);
}

test('rung 5: METER_HEIGHT_PX and METER_COMPACT_HEIGHT_PX (chart-contracts.ts) agree with the px heights declared on .vt-chart__meter--panel / .vt-chart__meter--compact (components.css)', () => {
	assert.equal(readGeometryConstant('METER_HEIGHT_PX'), readDeclaredHeightPx('vt-chart__meter--panel'));
	assert.equal(readGeometryConstant('METER_COMPACT_HEIGHT_PX'), readDeclaredHeightPx('vt-chart__meter--compact'));
});

test('rung 5b: components.css declares no "overflow: hidden" under any vt-chart selector (D-16 — a label is never clipped)', () => {
	assert.equal((readFileSync(COMPONENTS_CSS_PATH, 'utf8').match(/overflow:\s*hidden/g) ?? []).length, 0);
});

test('rung 5b (control): the overflow-hidden matcher DOES fire on a planted fixture', () => {
	const fixture = '.vt-chart__meter-track { overflow: hidden; }';
	assert.match(fixture, /overflow:\s*hidden/);
});

// --- rung 6: every Recharts data-mount disables the default redraw animation (D-23) ----

const ANIMATED_MOUNT_TAG_RE = /<(Bar|Line|Area)\b/g;
const ANIMATION_PROP_RE = /isAnimationActive=\{false\}/;

/**
 * Extracts the full JSX opening-tag text starting at `startIndex` (which must
 * index the tag's leading `<`), tracking `{}` depth and quote state so a `>`
 * nested inside an attribute expression or string literal never terminates
 * the scan early. This mirrors the one character-level source scanner this
 * repo already trusts (`stripComments`) rather than a naive "first `>`"
 * regex, which a future multi-line object/array attribute could defeat.
 * @param {string} source
 * @param {number} startIndex
 * @returns {string}
 */
function extractOpeningTag(source, startIndex) {
	let depth = 0;
	/** @type {string | null} */
	let quote = null;
	let i = startIndex;
	while (i < source.length) {
		const c = source[i];
		if (quote !== null) {
			if (c === '\\') {
				i += 2;
				continue;
			}
			if (c === quote) quote = null;
			i += 1;
			continue;
		}
		if (c === '"' || c === "'" || c === '`') {
			quote = c;
			i += 1;
			continue;
		}
		if (c === '{') {
			depth += 1;
			i += 1;
			continue;
		}
		if (c === '}') {
			depth -= 1;
			i += 1;
			continue;
		}
		if (c === '>' && depth === 0) return source.slice(startIndex, i + 1);
		i += 1;
	}
	return source.slice(startIndex);
}

test('rung 6: every Recharts data-mount (<Bar, <Line, <Area) under src/charts/ disables the default redraw animation (D-23)', () => {
	// A file with no such mount at all (Meter.tsx — a plain div, no Recharts
	// data component) is excluded by this rule's own logic: the inner while
	// loop below simply never finds a match for it, never by a filename skip.
	const sources = readAllChartSourcesStripped();
	let mountsChecked = 0;
	for (const [name, source] of sources) {
		ANIMATED_MOUNT_TAG_RE.lastIndex = 0;
		let match;
		while ((match = ANIMATED_MOUNT_TAG_RE.exec(source)) !== null) {
			const tag = extractOpeningTag(source, match.index);
			mountsChecked += 1;
			assert.match(
				tag,
				ANIMATION_PROP_RE,
				`${name}'s <${match[1]}> mount does not disable Recharts' default redraw animation — every ` +
					`re-render would silently re-enable it (D-23)`,
			);
		}
	}
	// Sanity: the loop body above must have actually run at least once, or
	// every assertion inside it passed vacuously on an empty mount set.
	assert.ok(mountsChecked > 0, 'expected at least one Recharts data-mount under src/charts/ to check');
});

test('rung 6 (control): the mount-tag matcher DOES fire on a planted fixture mount with the animation prop absent', () => {
	const fixture = ['<BarChart data={data}>', '\t<Bar dataKey="value" className="vt-chart__bar" />', '</BarChart>'].join('\n');
	ANIMATED_MOUNT_TAG_RE.lastIndex = 0;
	const match = ANIMATED_MOUNT_TAG_RE.exec(fixture);
	assert.ok(match, 'expected the mount-tag matcher to find the planted <Bar mount, not its <BarChart container');
	assert.equal(match[1], 'Bar');
	const tag = extractOpeningTag(fixture, match.index);
	assert.equal(tag, '<Bar dataKey="value" className="vt-chart__bar" />');
	assert.doesNotMatch(tag, ANIMATION_PROP_RE, 'sanity: the planted fixture genuinely omits the prop this rung hunts for');
});

// --- rung 7: D-16 tick-density boundary semantics (WR-03) --------------------

const CHART_FRAME_PATH = path.join(CHARTS_DIR, 'chart-frame.tsx');

/**
 * Re-derives `tickCountFor`'s semantics purely from chart-contracts.ts's own
 * parsed constants (`readGeometryConstant`, rung 5's technique) — neither
 * chart-frame.tsx nor chart-contracts.ts is importable under plain
 * `node --test` (both are TypeScript), so the boundary is pinned against the
 * SAME numbers the shipped constants hold, never against bare literals alone.
 * @param {number} width
 * @returns {number}
 */
function reDerivedTickCountFor(width) {
	const narrow = readGeometryConstant('NARROW_CONTAINER_PX');
	const ticksNarrow = readGeometryConstant('TICKS_NARROW');
	const ticksWide = readGeometryConstant('TICKS_WIDE');
	return width < narrow ? ticksNarrow : ticksWide;
}

test('rung 7: tickCountFor\'s D-16 boundary — at most 6 ticks at/above 400px, at most 4 below — pins exactly at, above and below NARROW_CONTAINER_PX', () => {
	const narrow = readGeometryConstant('NARROW_CONTAINER_PX');
	const ticksNarrow = readGeometryConstant('TICKS_NARROW');
	const ticksWide = readGeometryConstant('TICKS_WIDE');

	assert.equal(reDerivedTickCountFor(399), 4);
	assert.equal(reDerivedTickCountFor(400), 6);
	assert.equal(reDerivedTickCountFor(401), 6);
	assert.equal(reDerivedTickCountFor(narrow - 1), ticksNarrow, 'one px below NARROW_CONTAINER_PX must resolve to the narrow tick count');
	assert.equal(reDerivedTickCountFor(narrow), ticksWide, 'AT NARROW_CONTAINER_PX itself must resolve to the WIDE tick count — this is the WR-03 edge rung 9 pins the seed against');
});

test('rung 7 (control): the boundary pin would catch a narrow/wide constant swap', () => {
	/**
	 * A deliberately wrong re-derivation with the two tick counts swapped.
	 * @param {number} width
	 * @param {number} narrow
	 * @param {number} ticksNarrow
	 * @param {number} ticksWide
	 */
	function swappedTickCountFor(width, narrow, ticksNarrow, ticksWide) {
		return width < narrow ? ticksWide : ticksNarrow;
	}
	assert.notEqual(swappedTickCountFor(399, 400, 4, 6), 4, 'sanity: the swapped re-derivation must disagree with the real boundary at 399px');
});

/**
 * Reads `tickCountFor`'s single-expression body out of comment-stripped
 * chart-frame.tsx source.
 * @returns {string}
 */
function readTickCountForBody() {
	const source = stripComments(readFileSync(CHART_FRAME_PATH, 'utf8'));
	const match = source.match(/function tickCountFor\(width: number\): number \{\s*return ([^;]+);\s*\}/);
	assert.ok(match, 'expected to find tickCountFor\'s body in chart-frame.tsx');
	return match[1].trim();
}

test('rung 8: tickCountFor\'s source expression in chart-frame.tsx has exactly the width < NARROW_CONTAINER_PX ? TICKS_NARROW : TICKS_WIDE shape', () => {
	assert.equal(readTickCountForBody(), 'width < NARROW_CONTAINER_PX ? TICKS_NARROW : TICKS_WIDE');
});

test('rung 8 (control): the body-shape matcher extracts a DIFFERENT string from a planted fixture with the two branches swapped', () => {
	const fixture = ['function tickCountFor(width: number): number {', '\treturn width < NARROW_CONTAINER_PX ? TICKS_WIDE : TICKS_NARROW;', '}'].join('\n');
	const match = fixture.match(/function tickCountFor\(width: number\): number \{\s*return ([^;]+);\s*\}/);
	assert.ok(match);
	assert.notEqual(match[1].trim(), 'width < NARROW_CONTAINER_PX ? TICKS_NARROW : TICKS_WIDE');
});

/**
 * Reads `useContainerWidth`'s `useState` seed argument out of comment-stripped
 * chart-frame.tsx source.
 * @returns {string}
 */
function readUseContainerWidthSeed() {
	const source = stripComments(readFileSync(CHART_FRAME_PATH, 'utf8'));
	const match = source.match(/const \[width, setWidth\] = useState\(([^)]+)\);/);
	assert.ok(match, 'expected to find useContainerWidth\'s useState seed in chart-frame.tsx');
	return match[1].trim();
}

test('rung 9: useContainerWidth seeds its width state at NARROW_CONTAINER_PX, the WR-03 first-paint edge rung 7 pins', () => {
	// Rung 7 already proves tickCountFor(NARROW_CONTAINER_PX) resolves to the
	// WIDE branch. Seeding useContainerWidth's state AT that exact value means
	// a narrow (<400px) chart's FIRST PAINT — before ResizeObserver reports
	// the real measured width — renders the WIDE tick count, not the narrow
	// one. This is a known, tracked first-paint gap (WR-03), not an
	// oversight: a deliberate change to this seed must re-read this rung and
	// this note before landing.
	assert.equal(readUseContainerWidthSeed(), 'NARROW_CONTAINER_PX');
});

test('rung 9 (control): the seed matcher extracts a DIFFERENT value from a planted fixture seeded at a literal instead', () => {
	const fixture = 'const [width, setWidth] = useState(0);';
	const match = fixture.match(/const \[width, setWidth\] = useState\(([^)]+)\);/);
	assert.ok(match);
	assert.notEqual(match[1].trim(), 'NARROW_CONTAINER_PX');
});
