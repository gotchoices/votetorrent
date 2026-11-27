/**
 * component-class-names.test.mjs — proves `src/component-class-names.js`'s
 * manifest agrees with what each component's own source can literally
 * produce (CR-01), so the tier-1 CSS class-name coverage checker
 * (`scripts/lib/css-class-coverage.mjs`) is reading a manifest that is
 * measured against the real components, not merely asserted.
 *
 * 60-03 widens this file to the four chart primitives: each one's manifest
 * entry is checked against the comment-stripped concatenation of that
 * export's own `.tsx` PLUS `chart-frame.tsx` — the shared names (`vt-chart`,
 * the empty pair, the tooltip trio) live there, not in the primitive's own
 * file, and a match built from the wrong file would let a shared rule be
 * satisfied by an unrelated primitive.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { uiWebSrc } from '../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../scripts/lib/strip-comments.mjs';
import { COMPONENT_CLASS_NAMES } from '../src/component-class-names.js';

const ADVISORY_SOURCE = readFileSync(uiWebSrc('components', 'AdvisoryDisclosure.tsx'), 'utf8');
const LIFECYCLE_SOURCE = readFileSync(uiWebSrc('components', 'LifecyclePill.tsx'), 'utf8');
const DETAILS_SOURCE = readFileSync(uiWebSrc('components', 'DetailsToggle.tsx'), 'utf8');

const CHART_FRAME_SOURCE_STRIPPED = stripComments(readFileSync(uiWebSrc('charts', 'chart-frame.tsx'), 'utf8'));
const CHART_EXPORT_FILES = Object.freeze({
	BarSeries: 'BarSeries.tsx',
	StackedBarSeries: 'StackedBarSeries.tsx',
	TimeSeries: 'TimeSeries.tsx',
	Meter: 'Meter.tsx',
});
/** The names `chart-frame.tsx` renders on every chart primitive's behalf. */
const SHARED_CHART_NAMES = Object.freeze([
	'vt-chart',
	'vt-chart__empty-frame',
	'vt-chart__empty',
	'vt-chart__tooltip',
	'vt-chart__tooltip-label',
	'vt-chart__tooltip-value',
]);

/**
 * A class name is "present" only when it appears quote-delimited (single OR
 * double quote) — a bare substring match would let `vt-chart__bar` satisfy
 * `vt-chart__bar--ok`, since the shorter name is a textual prefix of the
 * longer one.
 *
 * @param {string} source comment-stripped
 * @param {string} className
 * @returns {boolean}
 */
function sourceContainsClassLiteral(source, className) {
	const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const re = new RegExp(`['"]${escaped}['"]`);
	return re.test(source);
}

test('manifest declares exactly the three legacy components this package ships (AdvisoryDisclosure, LifecyclePill, DetailsToggle) plus the four 60-03 chart primitives', () => {
	assert.deepEqual(Object.keys(COMPONENT_CLASS_NAMES), [
		'AdvisoryDisclosure',
		'LifecyclePill',
		'DetailsToggle',
		'BarSeries',
		'StackedBarSeries',
		'TimeSeries',
		'Meter',
	]);
});

test('AdvisoryDisclosure.tsx literally contains every class name the manifest declares for it', () => {
	for (const cls of COMPONENT_CLASS_NAMES.AdvisoryDisclosure) {
		assert.ok(ADVISORY_SOURCE.includes(`"${cls}"`), `AdvisoryDisclosure.tsx does not contain "${cls}"`);
	}
});

test('DetailsToggle.tsx literally contains every class name the manifest declares for it', () => {
	for (const cls of COMPONENT_CLASS_NAMES.DetailsToggle) {
		assert.ok(DETAILS_SOURCE.includes(`"${cls}"`), `DetailsToggle.tsx does not contain "${cls}"`);
	}
});

test('LifecyclePill.tsx contains the base class name and the phase-modifier template literal', () => {
	assert.match(LIFECYCLE_SOURCE, /className=\{`lifecycle-pill lifecycle-pill--\$\{phase\}`\}/);
});

test("LifecyclePillProps' phase union names exactly the five modifiers the manifest declares", () => {
	const propsMatch = LIFECYCLE_SOURCE.match(/phase:\s*(.+);/);
	assert.ok(propsMatch, 'expected to find the `phase:` prop type line in LifecyclePill.tsx');
	const unionValues = [...propsMatch[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
	assert.deepEqual(unionValues, ['pre', 'voting', 'settling', 'closed', 'indeterminate']);
	const manifestModifiers = COMPONENT_CLASS_NAMES.LifecyclePill.filter((c) => c !== 'lifecycle-pill').map((c) =>
		c.replace('lifecycle-pill--', ''),
	);
	assert.deepEqual(manifestModifiers, unionValues);
});

test('inertness control: a manifest entry naming a class absent from its component source would be caught', () => {
	const fixtureSource = 'export function Fixture() { return <p className="real-class">x</p>; }';
	assert.ok(!fixtureSource.includes('"phantom-class"'), 'sanity: the fixture must not contain the planted phantom class');
});

// --- 60-03: the four chart primitives ------------------------------------

for (const [exportName, fileName] of Object.entries(CHART_EXPORT_FILES)) {
	test(`${exportName}.tsx (plus chart-frame.tsx) literally contains every class name the manifest declares for it, quote-delimited`, () => {
		const ownSourceStripped = stripComments(readFileSync(uiWebSrc('charts', fileName), 'utf8'));
		const combined = `${ownSourceStripped}\n${CHART_FRAME_SOURCE_STRIPPED}`;
		for (const cls of COMPONENT_CLASS_NAMES[exportName]) {
			assert.ok(
				sourceContainsClassLiteral(combined, cls),
				`${exportName}.tsx + chart-frame.tsx does not quote-delimit-contain "${cls}"`,
			);
		}
	});
}

test('every shared chart name is present in chart-frame.tsx specifically — a shared rule cannot be satisfied by an unrelated primitive', () => {
	for (const cls of SHARED_CHART_NAMES) {
		assert.ok(
			sourceContainsClassLiteral(CHART_FRAME_SOURCE_STRIPPED, cls),
			`chart-frame.tsx does not quote-delimit-contain the shared name "${cls}"`,
		);
	}
});

test('inertness control: a fabricated chart class name (vt-chart__phantom) is reported absent by the same quote-delimited predicate', () => {
	assert.ok(!sourceContainsClassLiteral(CHART_FRAME_SOURCE_STRIPPED, 'vt-chart__phantom'));
	for (const fileName of Object.values(CHART_EXPORT_FILES)) {
		const ownSourceStripped = stripComments(readFileSync(uiWebSrc('charts', fileName), 'utf8'));
		assert.ok(!sourceContainsClassLiteral(ownSourceStripped, 'vt-chart__phantom'));
	}
});

test('quote-delimited control: a bare substring match would wrongly accept "vt-chart__bar" as satisfying "vt-chart__bar--ok" — the real predicate must not', () => {
	const fixture = 'const x = "vt-chart__bar";';
	assert.ok(fixture.includes('vt-chart__bar--ok') === false, 'sanity: the fixture must not contain the longer name at all');
	assert.ok(sourceContainsClassLiteral(fixture, 'vt-chart__bar'), 'the shorter name must still be found on its own');
	assert.ok(!sourceContainsClassLiteral(fixture, 'vt-chart__bar--ok'), 'the longer name must NOT be found inside the shorter one');
});
