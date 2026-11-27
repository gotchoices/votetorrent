#!/usr/bin/env node
/**
 * run-chart-geometry-gate.mjs — the D-24 browser-tier proof that a chart
 * "rendered" is a MEASURED claim (a bar's height proportional to its value,
 * stacked segments summing to their column, a meter's fill ratio matching
 * value/total), not a node-presence claim (60-07).
 *
 * Modelled in shape on `apps/VoteTorrentPublic/test/liveness/run-liveness-gate.mjs`:
 * the Playwright import, `chromium.launch({ headless: true })`, `serveDist`,
 * the dist walk that resolves the built entry by SEARCH, the frozen
 * `RUNG_IDS` registry with `record(id, passed, detail)` throwing on any
 * unregistered id, pure exported comparators exercised by `--prove-matchers`
 * against both a violating and a healthy input, and a flag parser that
 * exits 2 on an unrecognised argument.
 *
 * THE BOUNDARY THIS GATE DOES AND DOES NOT CARRY. The panel CHROME is real —
 * `PanelFrame`, its header switch, its denied-body guard, the real
 * `ChartViewProvider` and `usePanelView()` — and the four chart primitives
 * are real. The panel BODIES are fixture-fed reproductions of
 * `60-05`/`60-10`'s Chart/Grid ternary, not `RegistrationsPanel` or
 * `KeyholdersPanel` themselves — this gate does not prove either panel
 * issues its own reads, and it does not re-prove `60-05`/`60-10`'s own
 * source-tier rungs. The fixture path is the only one available for the
 * intake time series: `RegistrationRequest` carries a row-level
 * `SignatureValid` CHECK, so an intake row cannot be seeded without a
 * signing dependency, which a gate may not take.
 *
 * PORT POLICY: this gate takes **5199** — verified free among the ports
 * already bound on this project (5180-5183, 5191-5198). A bound port fails
 * loudly; `serveDist` rejects on `EADDRINUSE` rather than silently choosing
 * another.
 *
 * TWO PAGE LOADS, DELIBERATELY. The view flag is read once, at mount, so a
 * behavioural proof of the switch needs a SECOND, genuinely fresh
 * navigation — never a single-navigation check. Do not add one.
 *
 * FLAGS:
 *   --skip-build       Reuse an existing `dist-chart-geometry/` rather than
 *                       rebuilding. Local iteration only — never in CI.
 *   --prove-matchers   Run every comparator against a violating input AND a
 *                      healthy one, requiring the first to FAIL and the
 *                      second to PASS. Needs no browser and no build.
 *   --port <n>         Override the bound port.
 * Any other argument exits 2 naming it.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync } from 'node:fs';
import { serveDist } from '../../../../packages/ui-web/scripts/lib/serve-dist.mjs';
import { panelViewStorageKey } from '../../src/screens/panels/panel-view-storage.js';
import { STATUS_FIXTURE, REQUEST_FIXTURE, REQUEST_SERIES, INTAKE_FIXTURE, METER_FIXTURES, FIXTURE_META } from './chart-geometry-fixtures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..', '..');
const DIST = path.join(APP_DIR, 'dist-chart-geometry');
const GATE_ENTRY = 'chart-geometry-gate.html';
const GATE_CONFIG = 'test/browser/vite.chart-geometry.config.ts';
const DEFAULT_PORT = 5199;
const LABEL = 'run-chart-geometry-gate';

/** @type {ReadonlyArray<string>} */
export const RUNG_IDS = Object.freeze([
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

/** Bounded wait for `.vt-chart__tooltip` to appear/disappear during a hover read (60-12). */
const TOOLTIP_WAIT_TIMEOUT_MS = 5_000;

/** Relative-tolerance/pixel-tolerance constants, named rather than scattered as magic numbers. */
export const PROPORTIONALITY_TOLERANCE = 0.02;
export const ZERO_EXTENT_TOLERANCE_PX = 0.5;
export const SUM_TOLERANCE_PX = 1.5;
export const RATIO_TOLERANCE = 0.02;
export const BASELINE_TOLERANCE_PX = 1.0;
export const MIN_PRODUCTION_LABEL_CHARS = 8;

/** The six selector terms `panel-body-free-of-controls` queries with, shared by both `*ByTerm` maps. @type {ReadonlyArray<string>} */
const BODY_CHECK_TERMS = Object.freeze(['button', 'input', 'select', 'textarea', '[onclick]', 'a[href]']);
/**
 * The probe deliberately carries no raw `button` — D-13's real header switch
 * (`switchButtons`) is this rung's own proof that the `button` term reaches
 * a real control; re-planting one inside the probe would test nothing the
 * switch does not already prove. React attaches its `onClick` handlers
 * programmatically (never as a literal DOM attribute), so the `[onclick]`
 * term catches only a raw HTML attribute — the element-type terms below
 * carry this rung's real force.
 * @type {ReadonlyArray<string>}
 */
const PROBE_CHECK_TERMS = Object.freeze(['input', 'select', 'textarea', '[onclick]', 'a[href]']);

/** @type {Array<{ id: string, passed: boolean, detail: string }>} */
const rungs = [];

/** @param {string} id @param {boolean} passed @param {string} detail */
function record(id, passed, detail) {
	if (!RUNG_IDS.includes(id)) throw new Error(`record(): "${id}" is not a member of RUNG_IDS`);
	rungs.push({ id, passed, detail });
}

/** @param {string} message */
function fail(message) {
	process.stderr.write(`[${LABEL}] FAIL: ${message}\n`);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// THE COMPARATORS — pure functions over values already measured off the
// page, so `--prove-matchers` can exercise each with no browser at all.
// ---------------------------------------------------------------------------

/** @typedef {{ passed: boolean, detail: string }} Verdict */

/**
 * C1 proportionality (D-16's "does a zero-count status still get a bar" is
 * folded in here too, via the zero-extent check).
 * @param {ReadonlyArray<{ key: string, value: number, height: number }>} bars
 * @returns {Verdict}
 */
export function evaluateBarsProportional(bars) {
	/** @type {string[]} */
	const failures = [];
	if (bars.length < 3) failures.push(`only ${bars.length} bar(s) supplied (want >= 3)`);
	const zeroBars = bars.filter((b) => b.value === 0);
	if (zeroBars.length === 0) failures.push('no bar has value 0 — the planted zero-count control is missing, so this rung would be vacuous');
	const nonZeroBars = bars.filter((b) => b.value !== 0);
	const distinctValues = new Set(nonZeroBars.map((b) => b.value));
	if (distinctValues.size < 2) failures.push(`only ${distinctValues.size} distinct non-zero value(s) — proportionality would be untested`);
	for (const bar of zeroBars) {
		if (bar.height > ZERO_EXTENT_TOLERANCE_PX) failures.push(`bar "${bar.key}" has value 0 but measures ${bar.height}px tall`);
	}
	for (const bar of nonZeroBars) {
		if (!(bar.height > 0)) failures.push(`bar "${bar.key}" has value ${bar.value} but measures ${bar.height}px tall`);
	}
	if (nonZeroBars.length >= 2 && nonZeroBars.every((b) => b.height > 0)) {
		const ratios = nonZeroBars.map((b) => b.height / b.value);
		const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
		nonZeroBars.forEach((bar, i) => {
			const ratio = ratios[i];
			const relDiff = mean === 0 ? Math.abs(ratio) : Math.abs(ratio - mean) / mean;
			if (relDiff > PROPORTIONALITY_TOLERANCE) {
				failures.push(`bar "${bar.key}" height/value ratio ${ratio.toFixed(4)} diverges ${(relDiff * 100).toFixed(1)}% from the mean ${mean.toFixed(4)}`);
			}
		});
	}
	return failures.length === 0
		? { passed: true, detail: `${bars.length} bars, ${zeroBars.length} zero-valued at <= ${ZERO_EXTENT_TOLERANCE_PX}px, non-zero heights proportional within ${PROPORTIONALITY_TOLERANCE * 100}%` }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * C1 label containment (D-16). Each label carries the text a real render
 * produced AND the text the fixture expects, so a mismatch is a rung
 * failure rather than a silent pass on whatever text happened to be there.
 * @param {ReadonlyArray<{ role: string, text: string, expectedText: string, box: { left: number, right: number, top: number, bottom: number, width: number, height: number } }>} labels
 * @param {{ left: number, right: number, top: number, bottom: number }} svgBox
 * @returns {Verdict}
 */
export function evaluateLabelsUnclipped(labels, svgBox) {
	/** @type {string[]} */
	const failures = [];
	// At minimum, the three category axis ticks -- always present regardless
	// of value. A rendered chart primitive OMITS its count-LabelList entry
	// entirely for a zero-valued datum (a real, measured Recharts behaviour
	// found while wiring this gate against the real built DOM, not a bug
	// this rung can fix -- BarSeries.tsx is 60-03's file), so this floor
	// deliberately does not assume a count label for every bar; a genuinely
	// missing axis or count label is still caught below, per-entry, by the
	// zero-box and text-mismatch checks.
	const MIN_EXPECTED_LABELS = 3;
	if (labels.length < MIN_EXPECTED_LABELS) failures.push(`only ${labels.length} label(s) supplied (want >= ${MIN_EXPECTED_LABELS}) — an expected axis label is missing`);
	let longest = 0;
	for (const label of labels) {
		if (label.text !== label.expectedText) failures.push(`label "${label.role}" reads "${label.text}" (want "${label.expectedText}")`);
		if (label.text.length > longest) longest = label.text.length;
		if (!(label.box.width > 0) || !(label.box.height > 0)) failures.push(`label "${label.role}" measures ${label.box.width}x${label.box.height}px`);
		const escapesLeft = svgBox.left - label.box.left > 0.5;
		const escapesRight = label.box.right - svgBox.right > 0.5;
		const escapesTop = svgBox.top - label.box.top > 0.5;
		const escapesBottom = label.box.bottom - svgBox.bottom > 0.5;
		if (escapesLeft || escapesRight || escapesTop || escapesBottom) {
			failures.push(`label "${label.role}" box escapes the chart's own SVG box (label ${JSON.stringify(label.box)}, svg ${JSON.stringify(svgBox)})`);
		}
	}
	if (longest < MIN_PRODUCTION_LABEL_CHARS) failures.push(`the longest supplied label is ${longest} character(s) (want >= ${MIN_PRODUCTION_LABEL_CHARS}) — too short to prove clipping`);
	return failures.length === 0
		? { passed: true, detail: `${labels.length} labels, longest ${longest} chars, all fully contained in the chart's own SVG box` }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * C2 segment sum. Each segment's own measured `strokeWidth` is READ (never
 * hard-coded — `StackedBarSeries` strokes each segment at 2px, a value
 * `getComputedStyle` confirms rather than assumes) but NOT subtracted:
 * measured against the real build (60-07), Chromium's
 * `getBoundingClientRect()` on these rounded-corner `<path>` marks returns
 * the SAME height as the path's own geometric `height` attribute — the
 * stroke does not inflate the reported box for this shape/renderer, so a
 * per-segment subtraction would introduce a systematic error (one
 * `strokeWidth` of drift per segment beyond the category's first) rather
 * than correct one. `strokeWidth` stays in the measured shape for its own
 * sanity value (a segment stroked at an unexpected width is worth seeing in
 * a FAIL detail) and so a future renderer that DOES inflate the box has a
 * measurement already in hand, not a hard-coded assumption to add back.
 * @param {ReadonlyArray<{ key: string, segments: ReadonlyArray<{ seriesKey: string, value: number, height: number, strokeWidth: number }>, columnExtent: number }>} categories
 * @returns {Verdict}
 */
export function evaluateSegmentsSumToTotal(categories) {
	/** @type {string[]} */
	const failures = [];
	let anyZeroSegment = false;
	for (const category of categories) {
		if (category.segments.length === 0) {
			failures.push(`category "${category.key}" has no segments`);
			continue;
		}
		let sum = 0;
		for (const segment of category.segments) {
			sum += segment.height;
			if (segment.value === 0) {
				anyZeroSegment = true;
				if (segment.height > ZERO_EXTENT_TOLERANCE_PX) failures.push(`category "${category.key}" segment "${segment.seriesKey}" is zero-valued but measures ${segment.height}px`);
			} else if (!(segment.height > 0)) {
				failures.push(`category "${category.key}" segment "${segment.seriesKey}" has value ${segment.value} but measures ${segment.height}px`);
			}
		}
		if (Math.abs(sum - category.columnExtent) > SUM_TOLERANCE_PX) {
			failures.push(
				`category "${category.key}" segment sum ${sum.toFixed(2)}px does not match measured column extent ${category.columnExtent.toFixed(2)}px (tolerance ${SUM_TOLERANCE_PX}px)`,
			);
		}
	}
	if (!anyZeroSegment) failures.push('no segment anywhere has value 0 — the planted control is missing, so this rung would be vacuous');
	return failures.length === 0
		? { passed: true, detail: `${categories.length} categories, every segment sum matches its measured column extent within ${SUM_TOLERANCE_PX}px` }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * C2 legend<->series-fill pairing (closes 60-UAT test 3 / 60-REVIEW WR-02).
 * The pairing check alone would only prove that the legend and the bars
 * agree with EACH OTHER; a shared, symmetric bug in the tone lookup both
 * paths read could still make them agree on the WRONG colour. The
 * tone->series anchor below ties the check to DATA (the fixture's own summed
 * values, supplied by the caller) instead, so a swap of the `--series-N`
 * classes on the rendered rects still trips this rung even if it happened to
 * also swap the legend in lockstep.
 * @param {ReadonlyArray<{ label: string, swatchColor: string }>} legend
 * @param {ReadonlyArray<{ key: string, label: string, tone: string, fill: string, markCount: number, totalHeight: number }>} seriesMarks
 * @param {ReadonlyArray<{ label: string, total: number }>} seriesTotals fixture-derived, computed by the driver -- never recomputed in-page
 * @returns {Verdict}
 */
export function evaluateLegendPairsWithSeries(legend, seriesMarks, seriesTotals) {
	/** @type {string[]} */
	const failures = [];

	// --- anti-vacuity, first ---------------------------------------------
	if (legend.length < 2) failures.push(`only ${legend.length} legend item(s) supplied (want >= 2 -- a one-item legend cannot detect a mis-pairing)`);
	if (legend.length !== seriesMarks.length) failures.push(`legend has ${legend.length} item(s) but seriesMarks has ${seriesMarks.length} item(s) -- want one legend item per series`);
	for (const item of legend) {
		if (item.swatchColor === '') failures.push(`legend item "${item.label}" has an empty swatch colour -- the page has likely lost its stylesheet`);
	}
	for (const mark of seriesMarks) {
		if (mark.fill === '') failures.push(`series "${mark.label}" has an empty measured fill -- the page has likely lost its stylesheet`);
	}
	const distinctSwatchColors = new Set(legend.map((item) => item.swatchColor));
	if (distinctSwatchColors.size < legend.length) {
		failures.push(`only ${distinctSwatchColors.size} distinct swatch colour(s) across ${legend.length} legend item(s) -- two identical colours make the pairing unfalsifiable`);
	}
	const distinctFills = new Set(seriesMarks.map((mark) => mark.fill));
	if (distinctFills.size < seriesMarks.length) {
		failures.push(`only ${distinctFills.size} distinct series fill colour(s) across ${seriesMarks.length} series -- two identical colours make the pairing unfalsifiable`);
	}

	// --- the tone->series anchor: height ordering must track the fixture's
	//     own summed values, never the `tone` field under test -----------
	const sortedByTotal = [...seriesTotals].sort((a, b) => b.total - a.total);
	for (let i = 0; i < sortedByTotal.length - 1; i += 1) {
		const higher = sortedByTotal[i];
		const lower = sortedByTotal[i + 1];
		if (higher.total === lower.total) continue;
		const higherMark = seriesMarks.find((m) => m.label === higher.label);
		const lowerMark = seriesMarks.find((m) => m.label === lower.label);
		if (!higherMark || !lowerMark) continue;
		if (!(higherMark.totalHeight > lowerMark.totalHeight)) {
			failures.push(
				`series "${higher.label}" has a larger fixture total (${higher.total}) than "${lower.label}" (${lower.total}) but its summed rect height ${higherMark.totalHeight}px does not exceed "${lower.label}"'s ${lowerMark.totalHeight}px`,
			);
		}
	}
	for (const total of seriesTotals) {
		if (total.total === 0) continue;
		const mark = seriesMarks.find((m) => m.label === total.label);
		if (mark && !(mark.markCount > 0)) failures.push(`series "${total.label}" has a non-zero fixture total (${total.total}) but its measured markCount is ${mark.markCount}`);
	}

	// --- the pairing itself ------------------------------------------------
	for (const item of legend) {
		const matches = seriesMarks.filter((mark) => mark.label === item.label);
		if (matches.length !== 1) {
			failures.push(`legend item "${item.label}" matches ${matches.length} series by exact label (want exactly 1)`);
			continue;
		}
		const series = matches[0];
		if (series.fill !== item.swatchColor) {
			failures.push(`legend item "${item.label}" swatch colour ${item.swatchColor} does not match series "${series.label}"'s measured fill ${series.fill}`);
		}
	}

	return failures.length === 0
		? { passed: true, detail: `${legend.length} legend item(s) paired with their own series; every swatch colour matches that series' measured fill, heights ordered by fixture total` }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * C2 tooltip content, closing 60-UAT test 14 / 60-REVIEW WR-01. Hovering a
 * stacked segment must name THAT segment's own series and count, exactly
 * once — never a fixed series chosen by payload position, and never a
 * doubled category label. Anti-vacuity runs FIRST because the two defects
 * this rung guards (fixed-series selection, doubled label) both manifest as
 * a tooltip that LOOKS present but is silently wrong or silently empty.
 * @param {ReadonlyArray<{ text: string, labelCount: number, valueCount: number }>} readouts one per hovered series, in the SAME order as `expectations`
 * @param {ReadonlyArray<{ seriesLabel: string, otherSeriesLabel: string, categoryLabel: string, value: number }>} expectations fixture-derived, computed by the driver -- never recomputed in-page
 * @returns {Verdict}
 */
export function evaluateTooltipContent(readouts, expectations) {
	/** @type {string[]} */
	const failures = [];

	// --- anti-vacuity, first ---------------------------------------------
	if (readouts.length < 2) failures.push(`only ${readouts.length} hover readout(s) supplied (want >= 2 -- a single hover cannot detect a fixed-series tooltip)`);
	readouts.forEach((readout, i) => {
		if (readout.text === '') failures.push(`readout ${i} has empty text -- the tooltip never rendered, so this rung would be silently vacuous`);
	});
	const seriesLabels = expectations.map((e) => e.seriesLabel);
	if (seriesLabels.some((l) => l === '')) failures.push('an expectation series label is empty');
	if (new Set(seriesLabels).size < seriesLabels.length) failures.push(`expectation series labels are not all distinct: ${seriesLabels.join(', ')}`);
	for (const e of expectations) {
		if (e.seriesLabel !== '' && e.otherSeriesLabel !== '' && (e.seriesLabel.includes(e.otherSeriesLabel) || e.otherSeriesLabel.includes(e.seriesLabel))) {
			failures.push(`series label "${e.seriesLabel}" and "${e.otherSeriesLabel}" are substrings of each other -- the containment checks below would be unfalsifiable`);
		}
	}
	if (readouts.length >= 2 && readouts[0].text !== '' && readouts[0].text === readouts[1].text) {
		failures.push(`both readouts have identical text "${readouts[0].text}" -- the exact signature of a tooltip that reports the same series whichever segment is hovered`);
	}

	// --- series identity, value, and label-occurs-once, per readout -------
	readouts.forEach((readout, i) => {
		const expectation = expectations[i];
		if (!expectation) {
			failures.push(`readout ${i} has no matching expectation`);
			return;
		}
		if (readout.text === '') return; // already flagged above -- nothing further to check meaningfully
		if (!readout.text.includes(expectation.seriesLabel)) {
			failures.push(`readout ${i} text "${readout.text}" does not contain its own series label "${expectation.seriesLabel}"`);
		}
		if (expectation.otherSeriesLabel !== '' && readout.text.includes(expectation.otherSeriesLabel)) {
			failures.push(`readout ${i} text "${readout.text}" contains the OTHER series' label "${expectation.otherSeriesLabel}" -- the fixed-series-selection signature`);
		}
		if (!readout.text.includes(String(expectation.value))) {
			failures.push(`readout ${i} text "${readout.text}" does not contain its own segment's value "${expectation.value}"`);
		}
		const occurrences = expectation.categoryLabel === '' ? 0 : readout.text.split(expectation.categoryLabel).length - 1;
		if (occurrences !== 1) {
			failures.push(`readout ${i} text "${readout.text}" contains category label "${expectation.categoryLabel}" ${occurrences} time(s) (want exactly 1) -- the doubled-label signature`);
		}
		if (readout.labelCount > 1) failures.push(`readout ${i} carries ${readout.labelCount} .vt-chart__tooltip-label span(s) (want at most 1)`);
	});

	return failures.length === 0
		? { passed: true, detail: `${readouts.length} hover(s), each naming its own series and value, category label occurring exactly once, no cross-series leakage` }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * C3 mark-count-equals-bucket-count, no gaps. `path.vertices`/`subpathCount`
 * come from parsing the rendered `<path d="…">`; `expected.values` is the
 * fixture's own bucket-count array (INTAKE_FIXTURE-shaped).
 * @param {{ vertices: ReadonlyArray<{ x: number, y: number }>, subpathCount: number, box: { width: number, height: number } }} path
 * @param {{ values: ReadonlyArray<number> }} expected
 * @returns {Verdict}
 */
export function evaluateMarksMatchBuckets(path, expected) {
	/** @type {string[]} */
	const failures = [];
	if (path.vertices.length !== expected.values.length) {
		failures.push(`${path.vertices.length} vertex(es) on the rendered path, want ${expected.values.length} (one per bucket)`);
	}
	if (path.subpathCount !== 1) {
		failures.push(`${path.subpathCount} subpath(s) on the rendered path (want exactly 1) — a second subpath is what a gap-rendering implementation emits`);
	}
	if (!(path.box.width > 0) || !(path.box.height > 0)) failures.push(`path box measures ${path.box.width}x${path.box.height}px`);
	const interiorZeroIndices = expected.values
		.map((v, i) => (v === 0 && i > 0 && i < expected.values.length - 1 ? i : -1))
		.filter((i) => i !== -1);
	if (interiorZeroIndices.length === 0) failures.push('the expected bucket values contain no INTERIOR zero — the planted control is missing, so this rung would be vacuous');
	if (path.vertices.length === expected.values.length && path.vertices.length > 0) {
		const maxY = Math.max(...path.vertices.map((v) => v.y));
		for (const i of interiorZeroIndices) {
			const vertex = path.vertices[i];
			if (Math.abs(vertex.y - maxY) > BASELINE_TOLERANCE_PX) {
				failures.push(`bucket ${i} (value 0) vertex y=${vertex.y} is not on the baseline (max y=${maxY}, tolerance ${BASELINE_TOLERANCE_PX}px) — a gap-rendering implementation would drop or displace this point`);
			}
		}
		const anyAboveBaseline = path.vertices.some((v) => maxY - v.y > BASELINE_TOLERANCE_PX);
		if (!anyAboveBaseline) failures.push('no vertex sits above the baseline — the line is flat and this rung would pass vacuously');
	}
	return failures.length === 0
		? { passed: true, detail: `${path.vertices.length} vertices in 1 subpath, ${interiorZeroIndices.length} interior zero bucket(s) on the baseline` }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * C5 meter fill ratio, at both extremes and an interior point.
 * @param {ReadonlyArray<{ id: string, value: number, total: number, fillWidth: number, trackWidth: number }>} meters
 * @returns {Verdict}
 */
export function evaluateMeterRatios(meters) {
	/** @type {string[]} */
	const failures = [];
	if (meters.length < 3) failures.push(`only ${meters.length} meter(s) supplied (want >= 3)`);
	const hasZero = meters.some((m) => m.value === 0);
	const hasFull = meters.some((m) => m.value === m.total);
	if (!hasZero) failures.push('no meter has value 0 — the zero extreme is missing');
	if (!hasFull) failures.push('no meter has value === total — the full extreme is missing');
	for (const meter of meters) {
		if (meter.trackWidth === 0) {
			failures.push(`meter "${meter.id}" has trackWidth 0`);
			continue;
		}
		if (meter.fillWidth - meter.trackWidth > ZERO_EXTENT_TOLERANCE_PX) {
			failures.push(`meter "${meter.id}" fillWidth ${meter.fillWidth}px exceeds trackWidth ${meter.trackWidth}px`);
		}
		const actualRatio = meter.fillWidth / meter.trackWidth;
		const expectedRatio = meter.total === 0 ? 0 : meter.value / meter.total;
		if (Math.abs(actualRatio - expectedRatio) > RATIO_TOLERANCE) {
			failures.push(`meter "${meter.id}" fill ratio ${actualRatio.toFixed(4)} (fillWidth/trackWidth) diverges from value/total ${expectedRatio.toFixed(4)} by more than ${RATIO_TOLERANCE}`);
		}
	}
	return failures.length === 0
		? { passed: true, detail: `${meters.length} meters, zero and full extremes present, every fill ratio matches value/total within ${RATIO_TOLERANCE}` }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * D-11/D-12: zero controls inside the real `.panel-body`, the same query
 * demonstrably finding D-13's real header switch and every planted probe
 * term outside it.
 * @param {{ bodyTotal: number, bodyByTerm: Readonly<Record<string, number>>, switchButtons: number, probeByTerm: Readonly<Record<string, number>> }} counts
 * @returns {Verdict}
 */
export function evaluateControlAbsence(counts) {
	/** @type {string[]} */
	const failures = [];
	if (counts.bodyTotal !== 0) {
		const offending = BODY_CHECK_TERMS.filter((term) => (counts.bodyByTerm[term] ?? 0) > 0).map((term) => `${term}=${counts.bodyByTerm[term]}`);
		failures.push(`.panel-body contains ${counts.bodyTotal} control(s): ${offending.join(', ') || 'unattributed'}`);
	}
	if (counts.switchButtons < 2) {
		failures.push(`only ${counts.switchButtons} button(s) found via ".panel-view-switch button" outside any .panel-body (want >= 2 — D-13's real header switch)`);
	}
	for (const term of PROBE_CHECK_TERMS) {
		if ((counts.probeByTerm[term] ?? 0) === 0) {
			failures.push(`probe term "${term}" matched zero elements inside .chart-geometry-control-probe — this selector term is not demonstrably live`);
		}
	}
	return failures.length === 0
		? { passed: true, detail: `0 controls in .panel-body, ${counts.switchButtons} real switch button(s) found outside it, every probe term matched >= 1 planted element` }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * D-13/D-17/D-18/D-19: the stored-flag chain, proven behaviourally across
 * two genuinely fresh navigations. `storedKeyholders` and `meterTrackWidth`
 * held constant in EITHER pass is D-17's own named example — an officer
 * charts registrations while keeping keyholders as numbers.
 * @param {{ storedRegistrations: string | null, storedKeyholders: string | null, barCount: number, gridPresent: boolean, gridHeight: number, meterTrackWidth: number }} defaultPass
 * @param {{ storedRegistrations: string | null, storedKeyholders: string | null, barCount: number, gridPresent: boolean, gridHeight: number, meterTrackWidth: number }} gridPass
 * @returns {Verdict}
 */
export function evaluateViewSwitchSwapsRepresentations(defaultPass, gridPass) {
	/** @type {string[]} */
	const failures = [];
	if (defaultPass.storedRegistrations !== null) {
		failures.push(`default pass: stored registrations view is "${defaultPass.storedRegistrations}" (want null — D-18's chart-first default was never exercised)`);
	}
	if (defaultPass.barCount < 3) failures.push(`default pass: only ${defaultPass.barCount} C1 bar(s) (want >= 3)`);
	if (defaultPass.gridPresent) failures.push('default pass: the grid representation is present (want absent — 60-10 unmounts, never hides, the unselected representation)');
	if (gridPass.storedRegistrations !== 'grid') failures.push(`grid pass: stored registrations view is "${gridPass.storedRegistrations}" (want "grid")`);
	if (gridPass.barCount !== 0) failures.push(`grid pass: ${gridPass.barCount} C1 bar(s) still present (want 0 — unmounted, not merely zero-sized)`);
	if (!gridPass.gridPresent) failures.push('grid pass: the grid representation is absent (want present)');
	if (!(gridPass.gridHeight > 0)) failures.push(`grid pass: grid height is ${gridPass.gridHeight} (want > 0)`);
	for (const [label, pass] of /** @type {const} */ ([['default', defaultPass], ['grid', gridPass]])) {
		if (pass.storedKeyholders !== null) failures.push(`${label} pass: stored keyholders view is "${pass.storedKeyholders}" (want null — this frame's flag must stay unset in every pass)`);
		if (!(pass.meterTrackWidth > 0)) failures.push(`${label} pass: keyholders meter trackWidth is ${pass.meterTrackWidth} (want > 0 — D-17's named example: keyholders stays charted while registrations switches)`);
	}
	return failures.length === 0
		? { passed: true, detail: `default pass: null flag, ${defaultPass.barCount} bars, no grid; grid pass: "grid" flag, 0 bars, grid present (height ${gridPass.gridHeight}px); keyholders untouched in both passes` }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * D-16/60-13: every numeric-axis tick label parses as a whole number, and the
 * largest tick never runs past the fixture's own real maximum.
 *
 * DUPLICATED, NOT IMPORTED, from `apps/VoteTorrentPublic/test/browser/render-fidelity-gate.mjs`'s
 * comparator of the same name -- each gate is self-contained by design (no
 * cross-app import), and both copies are covered by their own
 * `--prove-*-matchers` controls.
 *
 * ANTI-VACUITY FIRST, and the third clause is the one that makes this rung
 * honest rather than merely correct: a fractional tick is only REACHABLE when
 * the axis's own data maximum is small, so `expected.maxValue > 3` must
 * itself be a FAIL -- a rung fed a large-count fixture would otherwise pass
 * on every build, healthy or not.
 * @param {ReadonlyArray<string>} ticks
 * @param {{ maxValue: number, axisName: string }} expected
 * @returns {Verdict}
 */
export function evaluateIntegerTicks(ticks, expected) {
	/** @type {string[]} */
	const failures = [];
	const list = Array.isArray(ticks) ? ticks : [];
	const axisName = expected && typeof expected.axisName === 'string' && expected.axisName !== '' ? expected.axisName : '(unnamed axis)';
	const maxValue = expected ? expected.maxValue : Number.NaN;

	if (list.length < 2) {
		failures.push(
			`${axisName}: only ${list.length} tick(s) rendered -- an axis with fewer than 2 ticks cannot show a fractional subdivision, so this rung would be vacuous`,
		);
	}
	const emptyCount = list.filter((t) => typeof t !== 'string' || t.trim() === '').length;
	if (emptyCount > 0) failures.push(`${axisName}: ${emptyCount} of ${list.length} tick(s) have empty text`);
	if (!Number.isFinite(maxValue) || maxValue > 3) {
		failures.push(
			`${axisName}: the fixture's maximum (${maxValue}) is too large for a fractional tick to be reachable; this rung would be vacuous`,
		);
	}

	/** @type {number[]} */
	const parsed = [];
	for (const raw of list) {
		if (typeof raw !== 'string' || raw.trim() === '') continue;
		const stripped = raw.replace(/,/g, '');
		if (!/^-?\d+$/.test(stripped)) {
			failures.push(`${axisName}: tick "${raw}" is not a whole number`);
			continue;
		}
		parsed.push(Number.parseInt(stripped, 10));
	}

	if (parsed.length > 0 && Number.isFinite(maxValue)) {
		const largest = Math.max(...parsed);
		if (largest > maxValue) failures.push(`${axisName}: largest tick ${largest} exceeds the fixture's real maximum ${maxValue}`);
	}

	return failures.length === 0
		? { passed: true, detail: `${axisName}: ${list.length} tick(s) [${list.join(', ')}], all whole numbers, within the fixture's real maximum ${maxValue}` }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * Runs `evaluateIntegerTicks` once per small-count probe and joins the three
 * verdicts into ONE rung, naming the failing probe id in the detail. Covers
 * the three officer-side numeric axes Task 1's public-side fix does not:
 * `BarSeries`'s vertical YAxis, `StackedBarSeries`'s YAxis and `TimeSeries`'s
 * YAxis.
 *
 * `maxValueByProbeId` carries EACH probe's own real maximum (60-REVIEW-2
 * CR-01) -- either a `{ [probeId]: number }` map, or a single shared number
 * applied to every probe (kept for the vacuity control at the bottom of
 * `matcherControls()`, which deliberately proves a SHARED bound is wrong).
 * The three real probe maxima are NOT the same number (bar/stacked top out
 * at 3, time-series tops out at 2) -- a single shared bound of 3 let a tick
 * of 3 on the time-series probe pass one unit too loosely.
 * @param {ReadonlyArray<{ probeId: string, ticks: ReadonlyArray<string> }>} probes
 * @param {number | Readonly<Record<string, number>>} maxValueByProbeId
 * @returns {Verdict}
 */
export function evaluateNumericAxisTicksAcrossProbes(probes, maxValueByProbeId) {
	/** @type {string[]} */
	const failures = [];
	const list = Array.isArray(probes) ? probes : [];
	if (list.length === 0) failures.push('no probe readout(s) supplied -- this rung would be vacuous');
	for (const probe of list) {
		const maxValue =
			typeof maxValueByProbeId === 'number'
				? maxValueByProbeId
				: maxValueByProbeId
					? maxValueByProbeId[probe.probeId]
					: Number.NaN;
		const v = evaluateIntegerTicks(probe.ticks, { maxValue, axisName: probe.probeId });
		if (!v.passed) failures.push(`probe "${probe.probeId}": ${v.detail}`);
	}
	return failures.length === 0
		? { passed: true, detail: `${list.length} probe(s) [${list.map((p) => p.probeId).join(', ')}], every numeric-axis tick whole and within its own probe's real maximum` }
		: { passed: false, detail: failures.join('; ') };
}

// ---------------------------------------------------------------------------
// PART C — matcher positive/negative controls (`--prove-matchers`). Every
// comparator gets TWO violating cases: a wrong-defect-shape input, and an
// under-specified input missing its own planted anti-vacuity control — plus
// one shared healthy input.
// ---------------------------------------------------------------------------

/** @returns {ReadonlyArray<{ label: string, violating: Verdict, healthy: Verdict }>} */
function matcherControls() {
	const healthyBars = [
		{ key: 'a', value: 1847, height: 147.76 },
		{ key: 's', value: 612, height: 48.96 },
		{ key: 'r', value: 0, height: 0 },
	];
	const healthyLabels = [
		{ role: 'axis:a', text: 'Active', expectedText: 'Active', box: { left: 10, right: 70, top: 140, bottom: 156, width: 60, height: 16 } },
		{ role: 'axis:s', text: 'Suspended', expectedText: 'Suspended', box: { left: 90, right: 170, top: 140, bottom: 156, width: 80, height: 16 } },
		{ role: 'axis:r', text: 'Revoked', expectedText: 'Revoked', box: { left: 190, right: 260, top: 140, bottom: 156, width: 70, height: 16 } },
		{ role: 'count:a', text: '1,847', expectedText: '1,847', box: { left: 20, right: 60, top: 10, bottom: 26, width: 40, height: 16 } },
		{ role: 'count:s', text: '612', expectedText: '612', box: { left: 100, right: 140, top: 100, bottom: 116, width: 40, height: 16 } },
		{ role: 'count:r', text: '0', expectedText: '0', box: { left: 200, right: 240, top: 130, bottom: 146, width: 40, height: 16 } },
	];
	const healthySvgBox = { left: 0, top: 0, right: 600, bottom: 160 };
	const healthyCategories = [
		{ key: 'p', columnExtent: 168.1, segments: [{ seriesKey: 'registrant', value: 1263, height: 126.3, strokeWidth: 2 }, { seriesKey: 'bridge', value: 418, height: 41.8, strokeWidth: 2 }] },
		{ key: 'a', columnExtent: 101.9, segments: [{ seriesKey: 'registrant', value: 902, height: 92.2, strokeWidth: 2 }, { seriesKey: 'bridge', value: 77, height: 9.7, strokeWidth: 2 }] },
		{ key: 'r', columnExtent: 16.5, segments: [{ seriesKey: 'registrant', value: 145, height: 16.5, strokeWidth: 2 }, { seriesKey: 'bridge', value: 0, height: 0, strokeWidth: 0 }] },
	];
	const healthyLegendItemsC2 = [
		{ label: 'Registrant', swatchColor: 'rgb(37, 99, 235)' },
		{ label: 'Bridge', swatchColor: 'rgb(217, 119, 6)' },
	];
	const healthySeriesMarksC2 = [
		{ key: 'registrant', label: 'Registrant', tone: 'series-1', fill: 'rgb(37, 99, 235)', markCount: 3, totalHeight: 235.0 },
		{ key: 'bridge', label: 'Bridge', tone: 'series-2', fill: 'rgb(217, 119, 6)', markCount: 2, totalHeight: 51.5 },
	];
	// Registrant 1263 + 902 + 145 = 2310; Bridge 418 + 77 + 0 = 495 -- REQUEST_FIXTURE's own real values.
	const healthySeriesTotalsC2 = [
		{ label: 'Registrant', total: 2310 },
		{ label: 'Bridge', total: 495 },
	];
	// Both hovers land on the fixture's own "Pending" category (registrant and
	// bridge are both non-zero there), mirroring what a real hover of each
	// series' FIRST rendered rect measures against REQUEST_FIXTURE.
	const healthyTooltipReadoutsC2 = [
		{ text: 'Pending · Registrant: 1263 request(s)', labelCount: 0, valueCount: 1 },
		{ text: 'Pending · Bridge: 418 request(s)', labelCount: 0, valueCount: 1 },
	];
	const healthyTooltipExpectationsC2 = [
		{ seriesLabel: 'Registrant', otherSeriesLabel: 'Bridge', categoryLabel: 'Pending', value: 1263 },
		{ seriesLabel: 'Bridge', otherSeriesLabel: 'Registrant', categoryLabel: 'Pending', value: 418 },
	];
	const healthyPathValues = [37, 52, 0, 64, 91, 128, 73, 46, 0, 19];
	const baselineY = 132;
	const healthyPath = {
		vertices: healthyPathValues.map((v, i) => ({ x: i * 60, y: baselineY - v * 0.6 })),
		subpathCount: 1,
		box: { width: 540, height: 128 * 0.6 },
	};
	const healthyMeters = [
		{ id: 'zero', value: 0, total: 12, fillWidth: 0, trackWidth: 120 },
		{ id: 'partial', value: 7, total: 12, fillWidth: 70, trackWidth: 120 },
		{ id: 'full', value: 12, total: 12, fillWidth: 120, trackWidth: 120 },
	];
	const healthyCounts = {
		bodyTotal: 0,
		bodyByTerm: { button: 0, input: 0, select: 0, textarea: 0, '[onclick]': 0, 'a[href]': 0 },
		switchButtons: 2,
		probeByTerm: { input: 1, select: 1, textarea: 1, '[onclick]': 1, 'a[href]': 1 },
	};
	const healthyDefaultPass = { storedRegistrations: null, storedKeyholders: null, barCount: 3, gridPresent: false, gridHeight: 0, meterTrackWidth: 120 };
	const healthyGridPass = { storedRegistrations: 'grid', storedKeyholders: null, barCount: 0, gridPresent: true, gridHeight: 80, meterTrackWidth: 120 };
	// 60-REVIEW-2 CR-01. Each probe carries its OWN real maximum -- bar and
	// stacked top out at 3, but the time-series probe's real max is 2. A
	// single SHARED bound (the pre-fix `FIXTURE_META.smallCountMax`) let a
	// tick of 3 on the time-series probe pass one unit too loosely.
	const healthyTicksProbes = [
		{ probeId: 'ticks-vertical-bar', ticks: ['0', '1', '2', '3'] },
		{ probeId: 'ticks-stacked-bar', ticks: ['0', '1', '2', '3'] },
		{ probeId: 'ticks-time-series', ticks: ['0', '1', '2'] },
	];
	/** @type {Readonly<Record<string, number>>} */
	const smallCountMaxByProbe = Object.freeze({
		'ticks-vertical-bar': FIXTURE_META.smallCountBarMax,
		'ticks-stacked-bar': FIXTURE_META.smallCountStackedMax,
		'ticks-time-series': FIXTURE_META.smallCountTimeMax,
	});

	return Object.freeze([
		{
			label: 'c1-status-bars-proportional vs. two non-proportional heights',
			violating: evaluateBarsProportional([{ key: 'a', value: 1847, height: 100 }, { key: 's', value: 612, height: 100 }, { key: 'r', value: 0, height: 0 }]),
			healthy: evaluateBarsProportional(healthyBars),
		},
		{
			label: 'c1-status-bars-proportional vs. no zero-valued bar (planted control missing)',
			violating: evaluateBarsProportional([{ key: 'a', value: 1847, height: 147.76 }, { key: 's', value: 612, height: 48.96 }, { key: 'r', value: 5, height: 0.4 }]),
			healthy: evaluateBarsProportional(healthyBars),
		},
		{
			label: 'c1-status-labels-unclipped vs. a label box escaping the SVG on the right',
			violating: evaluateLabelsUnclipped(
				healthyLabels.map((l, i) => (i === 1 ? { ...l, box: { ...l.box, right: 650 } } : l)),
				healthySvgBox,
			),
			healthy: evaluateLabelsUnclipped(healthyLabels, healthySvgBox),
		},
		{
			label: 'c1-status-labels-unclipped vs. labels shorter than MIN_PRODUCTION_LABEL_CHARS (too short to prove clipping)',
			violating: evaluateLabelsUnclipped(
				healthyLabels.map((l) => ({ ...l, text: l.text.slice(0, 1), expectedText: l.text.slice(0, 1) })),
				healthySvgBox,
			),
			healthy: evaluateLabelsUnclipped(healthyLabels, healthySvgBox),
		},
		{
			label: 'c2-stacked-segments-sum-to-total vs. a category 6px short of its column',
			violating: evaluateSegmentsSumToTotal(healthyCategories.map((c) => (c.key === 'p' ? { ...c, columnExtent: c.columnExtent + 6 } : c))),
			healthy: evaluateSegmentsSumToTotal(healthyCategories),
		},
		{
			label: 'c2-stacked-segments-sum-to-total vs. no zero-valued segment anywhere (planted control missing)',
			violating: evaluateSegmentsSumToTotal(
				healthyCategories.map((c) =>
					c.key === 'r'
						? { ...c, columnExtent: 16.8, segments: [c.segments[0], { seriesKey: 'bridge', value: 3, height: 0.3, strokeWidth: 0 }] }
						: c,
				),
			),
			healthy: evaluateSegmentsSumToTotal(healthyCategories),
		},
		{
			label: 'c2-legend-swatch-matches-series-fill vs. swatches paired with the wrong series (the live defect shape)',
			violating: evaluateLegendPairsWithSeries(
				[
					{ label: 'Registrant', swatchColor: 'rgb(217, 119, 6)' },
					{ label: 'Bridge', swatchColor: 'rgb(37, 99, 235)' },
				],
				healthySeriesMarksC2,
				healthySeriesTotalsC2,
			),
			healthy: evaluateLegendPairsWithSeries(healthyLegendItemsC2, healthySeriesMarksC2, healthySeriesTotalsC2),
		},
		{
			label: 'c2-legend-swatch-matches-series-fill vs. both swatches resolving to the same colour (planted control missing)',
			violating: evaluateLegendPairsWithSeries(
				[
					{ label: 'Registrant', swatchColor: 'rgb(37, 99, 235)' },
					{ label: 'Bridge', swatchColor: 'rgb(37, 99, 235)' },
				],
				healthySeriesMarksC2,
				healthySeriesTotalsC2,
			),
			healthy: evaluateLegendPairsWithSeries(healthyLegendItemsC2, healthySeriesMarksC2, healthySeriesTotalsC2),
		},
		{
			label: 'c2-legend-swatch-matches-series-fill vs. a one-item legend (too few items to detect a mis-pairing)',
			violating: evaluateLegendPairsWithSeries([healthyLegendItemsC2[0]], healthySeriesMarksC2, healthySeriesTotalsC2),
			healthy: evaluateLegendPairsWithSeries(healthyLegendItemsC2, healthySeriesMarksC2, healthySeriesTotalsC2),
		},
		{
			label: 'c2-legend-swatch-matches-series-fill vs. series mark heights ordered against their summed fixture values (tone->series anchor broken)',
			violating: evaluateLegendPairsWithSeries(
				healthyLegendItemsC2,
				[
					{ key: 'registrant', label: 'Registrant', tone: 'series-1', fill: 'rgb(37, 99, 235)', markCount: 3, totalHeight: 51.5 },
					{ key: 'bridge', label: 'Bridge', tone: 'series-2', fill: 'rgb(217, 119, 6)', markCount: 2, totalHeight: 235.0 },
				],
				healthySeriesTotalsC2,
			),
			healthy: evaluateLegendPairsWithSeries(healthyLegendItemsC2, healthySeriesMarksC2, healthySeriesTotalsC2),
		},
		{
			label: 'c2-tooltip-names-hovered-segment-once vs. both hovers naming the same series (the fixed-series defect)',
			violating: evaluateTooltipContent(
				[
					{ text: 'Pending · Bridge: 418 request(s)', labelCount: 0, valueCount: 1 },
					{ text: 'Pending · Bridge: 418 request(s)', labelCount: 0, valueCount: 1 },
				],
				healthyTooltipExpectationsC2,
			),
			healthy: evaluateTooltipContent(healthyTooltipReadoutsC2, healthyTooltipExpectationsC2),
		},
		{
			label: 'c2-tooltip-names-hovered-segment-once vs. a readout repeating its own category label (the duplication defect)',
			violating: evaluateTooltipContent(
				[
					{ text: 'Pending Pending · Registrant: 1263 request(s)', labelCount: 1, valueCount: 1 },
					{ text: 'Pending · Bridge: 418 request(s)', labelCount: 0, valueCount: 1 },
				],
				healthyTooltipExpectationsC2,
			),
			healthy: evaluateTooltipContent(healthyTooltipReadoutsC2, healthyTooltipExpectationsC2),
		},
		{
			label: 'c2-tooltip-names-hovered-segment-once vs. a single readout supplied (too few hovers to be non-vacuous)',
			violating: evaluateTooltipContent([healthyTooltipReadoutsC2[0]], healthyTooltipExpectationsC2),
			healthy: evaluateTooltipContent(healthyTooltipReadoutsC2, healthyTooltipExpectationsC2),
		},
		{
			label: 'c2-tooltip-names-hovered-segment-once vs. a readout whose text is empty (the tooltip never rendered)',
			violating: evaluateTooltipContent(
				[
					{ text: '', labelCount: 0, valueCount: 0 },
					{ text: 'Pending · Bridge: 418 request(s)', labelCount: 0, valueCount: 1 },
				],
				healthyTooltipExpectationsC2,
			),
			healthy: evaluateTooltipContent(healthyTooltipReadoutsC2, healthyTooltipExpectationsC2),
		},
		{
			label: 'c3-marks-match-buckets-no-gaps vs. two subpaths and two missing vertices',
			violating: evaluateMarksMatchBuckets(
				{ vertices: healthyPath.vertices.filter((_, i) => i !== 2 && i !== 8), subpathCount: 2, box: healthyPath.box },
				{ values: healthyPathValues },
			),
			healthy: evaluateMarksMatchBuckets(healthyPath, { values: healthyPathValues }),
		},
		{
			label: 'c3-marks-match-buckets-no-gaps vs. no interior zero bucket (planted control missing)',
			violating: evaluateMarksMatchBuckets(
				{
					vertices: [37, 52, 44, 64, 91, 128, 73, 46, 55, 19].map((v, i) => ({ x: i * 60, y: baselineY - v * 0.6 })),
					subpathCount: 1,
					box: healthyPath.box,
				},
				{ values: [37, 52, 44, 64, 91, 128, 73, 46, 55, 19] },
			),
			healthy: evaluateMarksMatchBuckets(healthyPath, { values: healthyPathValues }),
		},
		{
			label: 'c5-meter-fill-ratio-proportional vs. a meter at 50% value with an 80% fill',
			violating: evaluateMeterRatios([{ id: 'zero', value: 0, total: 12, fillWidth: 0, trackWidth: 120 }, { id: 'partial', value: 6, total: 12, fillWidth: 96, trackWidth: 120 }, { id: 'full', value: 12, total: 12, fillWidth: 120, trackWidth: 120 }]),
			healthy: evaluateMeterRatios(healthyMeters),
		},
		{
			label: 'c5-meter-fill-ratio-proportional vs. no meter at the full extreme (planted control missing)',
			violating: evaluateMeterRatios([{ id: 'zero', value: 0, total: 12, fillWidth: 0, trackWidth: 120 }, { id: 'partial', value: 7, total: 12, fillWidth: 70, trackWidth: 120 }, { id: 'other', value: 10, total: 12, fillWidth: 100, trackWidth: 120 }]),
			healthy: evaluateMeterRatios(healthyMeters),
		},
		{
			label: 'panel-body-free-of-controls vs. one textarea planted inside .panel-body',
			violating: evaluateControlAbsence({ bodyTotal: 1, bodyByTerm: { ...healthyCounts.bodyByTerm, textarea: 1 }, switchButtons: 2, probeByTerm: healthyCounts.probeByTerm }),
			healthy: evaluateControlAbsence(healthyCounts),
		},
		{
			label: 'panel-body-free-of-controls vs. a probe term matching zero elements (planted control missing)',
			violating: evaluateControlAbsence({ ...healthyCounts, probeByTerm: { ...healthyCounts.probeByTerm, select: 0 } }),
			healthy: evaluateControlAbsence(healthyCounts),
		},
		{
			label: 'view-switch-swaps-representations vs. a grid pass whose barCount is still 3',
			violating: evaluateViewSwitchSwapsRepresentations(healthyDefaultPass, { ...healthyGridPass, barCount: 3 }),
			healthy: evaluateViewSwitchSwapsRepresentations(healthyDefaultPass, healthyGridPass),
		},
		{
			label: 'view-switch-swaps-representations vs. a pre-seeded default-pass flag (D-18 default never exercised)',
			violating: evaluateViewSwitchSwapsRepresentations({ ...healthyDefaultPass, storedRegistrations: 'chart' }, healthyGridPass),
			healthy: evaluateViewSwitchSwapsRepresentations(healthyDefaultPass, healthyGridPass),
		},
		{
			label: 'numeric-axis-ticks-are-whole-numbers vs. fractional ticks on one probe (the live defect shape)',
			violating: evaluateNumericAxisTicksAcrossProbes(
				healthyTicksProbes.map((p) => (p.probeId === 'ticks-time-series' ? { ...p, ticks: ['0', '0.5', '1', '1.5', '2'] } : p)),
				smallCountMaxByProbe,
			),
			healthy: evaluateNumericAxisTicksAcrossProbes(healthyTicksProbes, smallCountMaxByProbe),
		},
		{
			label: 'numeric-axis-ticks-are-whole-numbers vs. an over-domain largest tick on one probe',
			violating: evaluateNumericAxisTicksAcrossProbes(
				healthyTicksProbes.map((p) => (p.probeId === 'ticks-vertical-bar' ? { ...p, ticks: ['0', '1', '2', '3', '4'] } : p)),
				smallCountMaxByProbe,
			),
			healthy: evaluateNumericAxisTicksAcrossProbes(healthyTicksProbes, smallCountMaxByProbe),
		},
		{
			// 60-REVIEW-2 CR-01. The time-series probe's real maximum is 2 (NOT
			// the shared 3 the other two probes top out at) -- a tick of exactly
			// 3 on THIS probe specifically must FAIL against its own per-probe
			// bound. Before this fix, `evaluateNumericAxisTicksAcrossProbes` took
			// one shared `maxValue` for every probe, so this exact input PASSED
			// (`3 > 3` is false) -- see the driver's own before/after transcript.
			label: 'numeric-axis-ticks-are-whole-numbers vs. a tick of 3 on the time-series probe specifically (real max is 2, not the shared 3)',
			violating: evaluateNumericAxisTicksAcrossProbes(
				healthyTicksProbes.map((p) => (p.probeId === 'ticks-time-series' ? { ...p, ticks: ['0', '1', '2', '3'] } : p)),
				smallCountMaxByProbe,
			),
			healthy: evaluateNumericAxisTicksAcrossProbes(healthyTicksProbes, smallCountMaxByProbe),
		},
		{
			label: 'numeric-axis-ticks-are-whole-numbers vs. a one-tick probe (planted anti-vacuity control missing)',
			violating: evaluateNumericAxisTicksAcrossProbes(
				healthyTicksProbes.map((p) => (p.probeId === 'ticks-stacked-bar' ? { ...p, ticks: ['0'] } : p)),
				smallCountMaxByProbe,
			),
			healthy: evaluateNumericAxisTicksAcrossProbes(healthyTicksProbes, smallCountMaxByProbe),
		},
		{
			label: 'numeric-axis-ticks-are-whole-numbers vs. a shared expected.maxValue of 1847 (would be vacuous against a large-count fixture)',
			violating: evaluateNumericAxisTicksAcrossProbes(healthyTicksProbes, 1847),
			healthy: evaluateNumericAxisTicksAcrossProbes(healthyTicksProbes, smallCountMaxByProbe),
		},
	]);
}

function runProveMatchers() {
	const controls = matcherControls();
	let inert = 0;
	let indiscriminate = 0;
	for (const control of controls) {
		if (control.violating.passed) {
			inert += 1;
			process.stderr.write(`[${LABEL}] matcher is inert — "${control.label}" did not fail its violating input.\n`);
		} else {
			process.stdout.write(`[${LABEL}] CAN-FAIL  ${control.label}\n              -> ${control.violating.detail}\n`);
		}
		if (!control.healthy.passed) {
			indiscriminate += 1;
			process.stderr.write(`[${LABEL}] matcher is indiscriminate — "${control.label}" ALSO failed its healthy input: ${control.healthy.detail}\n`);
		}
	}
	if (inert > 0 || indiscriminate > 0) fail(`${inert} comparator(s) inert, ${indiscriminate} indiscriminate, out of ${controls.length} control(s).`);
	process.stdout.write(`[${LABEL}] OK: all ${controls.length} controls FAIL on a violating input and PASS on a healthy one.\n`);
	process.stdout.write(`RECEIPT chart-geometry-dashboard-matchers-fired comparators=${RUNG_IDS.length} canfail=${controls.length}\n`);
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Build / serve / drive plumbing — the browser half.
// ---------------------------------------------------------------------------

/** @returns {Promise<void>} */
function buildGate() {
	return new Promise((resolvePromise, rejectPromise) => {
		const viteBin = path.join(APP_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
		if (!existsSync(viteBin)) fail(`vite binary not found at ${viteBin} — run \`yarn install\` first.`);
		const child = spawn(process.execPath, [viteBin, 'build', '--config', GATE_CONFIG], { cwd: APP_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
		child.stdout?.on('data', (d) => process.stdout.write(`[vite build] ${d}`));
		child.stderr?.on('data', (d) => process.stderr.write(`[vite build] ${d}`));
		child.on('error', rejectPromise);
		child.on('exit', (code) => (code === 0 ? resolvePromise(undefined) : rejectPromise(new Error(`vite build --config ${GATE_CONFIG} exited ${code}`))));
	});
}

/**
 * Walks `DIST` for exactly one `GATE_ENTRY` — the dist-staleness rule this
 * plan names as a hard constraint: the dashboard serves BUILT output, so a
 * gate run after a `src` edit but before a rebuild must fail loudly rather
 * than silently gating a stale bundle.
 * @returns {string} the entry path, relative to `DIST`, forward-slash-joined
 */
function resolveGateEntry() {
	if (!existsSync(DIST)) fail(`gate dist "${DIST}" does not exist — run \`yarn build:chart-geometry\` or drop --skip-build.`);
	/** @param {string} dir @returns {string[]} */
	function walk(dir) {
		/** @type {string[]} */
		const out = [];
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) out.push(...walk(full));
			else if (entry.name === GATE_ENTRY) out.push(full);
		}
		return out;
	}
	const matches = walk(DIST);
	if (matches.length !== 1) fail(`expected exactly one "${GATE_ENTRY}" under "${DIST}", found ${matches.length}.`);
	return path.relative(DIST, matches[0]).split(path.sep).join('/');
}

/**
 * Navigate `page` to `url` and wait (bounded) for the harness's own readout
 * to publish.
 * @param {import('playwright').Page} page
 * @param {string} url
 * @returns {Promise<void>}
 */
async function gotoAndWait(page, url) {
	await page.goto(url, { waitUntil: 'load' });
	await page.waitForFunction(() => /** @type {any} */ (globalThis).__CHART_GEOMETRY_GATE_DONE__ === true, null, { timeout: 60_000 }).catch(() => {});
}

/**
 * Reads EVERY rung's raw material off the live page in one `evaluate` —
 * plain JSON-safe values only. `fixtures` is the driver's own imported
 * fixture module, handed in as an argument so the in-page function can
 * build its measurements FROM the fixture (never from whatever happens to
 * exist in the DOM): a chart primitive OMITS its rendered mark entirely for
 * a zero-valued datum (measured against the real build while wiring this
 * gate — `BarSeries`/`StackedBarSeries` early-return a null shape for a
 * zero-height rectangle, `TimeSeries` does not, since a line has no height
 * to early-return on), so "missing element for this fixture entry" is
 * treated as "measures zero", exactly the semantics C1/C2's own planted
 * zero controls need.
 * @param {import('playwright').Page} page
 * @param {{ STATUS_FIXTURE: unknown, REQUEST_FIXTURE: unknown, REQUEST_SERIES: unknown, INTAKE_FIXTURE: unknown, METER_FIXTURES: unknown, smallCountProbeIds: ReadonlyArray<string> }} fixtures
 */
function readPage(page, fixtures) {
	return page.evaluate((fx) => {
		/** @param {string} name @returns {string} */
		const tokenOf = (name) => {
			const probe = document.createElement('div');
			probe.style.display = 'none';
			probe.style.color = `var(${name})`;
			document.body.appendChild(probe);
			const resolved = getComputedStyle(probe).color;
			probe.remove();
			return resolved.trim();
		};
		/** @param {DOMRect | null} r */
		const boxOf = (r) => (r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } : { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });

		const readout = /** @type {any} */ (globalThis).__CHART_GEOMETRY_GATE__ ?? null;

		// --- C1 -------------------------------------------------------------
		const c1Section = document.querySelector('[data-chart-geometry="c1"]');
		const c1Svg = c1Section ? c1Section.querySelector('svg') : null;
		const svgBox = boxOf(c1Svg ? c1Svg.getBoundingClientRect() : null);
		const statusFixture = /** @type {ReadonlyArray<{ key: string, label: string, value: number, tone: string }>} */ (fx.STATUS_FIXTURE);
		const bars = statusFixture.map((d) => {
			const el = c1Svg ? c1Svg.querySelector(`.vt-chart__bar--${d.tone}`) : null;
			return { key: d.key, value: d.value, height: el ? el.getBoundingClientRect().height : 0 };
		});
		const axisTickEls = c1Svg ? [...c1Svg.querySelectorAll('.recharts-xAxis-tick-labels .vt-chart__axis')] : [];
		const countLabelEls = c1Svg ? [...c1Svg.querySelectorAll('.vt-chart__label')] : [];
		/** @type {Array<{ role: string, text: string, expectedText: string, box: ReturnType<typeof boxOf> }>} */
		const labels = [];
		statusFixture.forEach((d, i) => {
			const el = axisTickEls[i] ?? null;
			labels.push({ role: `axis:${d.key}`, text: el ? (el.textContent ?? '') : '', expectedText: d.label, box: boxOf(el ? el.getBoundingClientRect() : null) });
		});
		const nonZeroStatuses = statusFixture.filter((d) => d.value !== 0);
		nonZeroStatuses.forEach((d, i) => {
			const el = countLabelEls[i] ?? null;
			labels.push({ role: `count:${d.key}`, text: el ? (el.textContent ?? '') : '', expectedText: String(d.value), box: boxOf(el ? el.getBoundingClientRect() : null) });
		});
		// D-18's chart-first proxy: the three category axis ticks always
		// render regardless of value (unlike the Cell/LabelList marks above),
		// so they are the stable "is the BarChart mounted with 3 categories"
		// signal `view-switch-swaps-representations` needs.
		const barCount = axisTickEls.length;

		// --- C2 ---------------------------------------------------------------
		const c2Section = document.querySelector('[data-chart-geometry="c2"]');
		const requestSeries = /** @type {ReadonlyArray<{ key: string, label: string, tone: string }>} */ (fx.REQUEST_SERIES);
		const requestFixture = /** @type {ReadonlyArray<{ key: string, label: string, segments: ReadonlyArray<{ seriesKey: string, value: number }> }>} */ (fx.REQUEST_FIXTURE);
		/** @param {string} seriesKey */
		const seriesRectEls = (seriesKey) => {
			const tone = requestSeries.find((s) => s.key === seriesKey)?.tone ?? 'series-1';
			return c2Section ? [...c2Section.querySelectorAll(`.recharts-rectangle.vt-chart__segment--${tone}`)] : [];
		};
		/** @type {Record<string, Record<string, { height: number, strokeWidth: number, top: number, bottom: number }>>} */
		const perSeriesMeasured = {};
		for (const series of requestSeries) {
			const rectEls = seriesRectEls(series.key);
			const nonZeroCategories = requestFixture.filter((cat) => (cat.segments.find((s) => s.seriesKey === series.key)?.value ?? 0) !== 0);
			/** @type {Record<string, { height: number, strokeWidth: number, top: number, bottom: number }>} */
			const map = {};
			nonZeroCategories.forEach((cat, i) => {
				const el = rectEls[i];
				if (!el) return;
				const r = el.getBoundingClientRect();
				const strokeWidth = parseFloat(getComputedStyle(el).strokeWidth) || 0;
				map[cat.key] = { height: r.height, strokeWidth, top: r.top, bottom: r.bottom };
			});
			perSeriesMeasured[series.key] = map;
		}
		const categories = requestFixture.map((cat) => {
			const realMeasurements = cat.segments.map((seg) => perSeriesMeasured[seg.seriesKey]?.[cat.key]).filter((m) => m != null);
			const segments = cat.segments.map((seg) => {
				const measured = perSeriesMeasured[seg.seriesKey]?.[cat.key];
				return { seriesKey: seg.seriesKey, value: seg.value, height: measured ? measured.height : 0, strokeWidth: measured ? measured.strokeWidth : 0 };
			});
			let columnExtent = 0;
			if (realMeasurements.length > 0) {
				const minTop = Math.min(...realMeasurements.map((m) => /** @type {any} */ (m).top));
				const maxBottom = Math.max(...realMeasurements.map((m) => /** @type {any} */ (m).bottom));
				columnExtent = maxBottom - minTop;
			}
			return { key: cat.key, segments, columnExtent };
		});
		// The legend and its swatch<->fill pairing (closes 60-UAT test 3):
		// colours are read via getComputedStyle only, never off a class
		// name -- a class-name comparison would be satisfied by the very
		// wiring under test.
		const legend = c2Section
			? [...c2Section.querySelectorAll('.vt-chart__legend-item')].map((item) => {
					const labelEl = item.querySelector('.vt-chart__legend-label');
					const swatchEl = item.querySelector('.vt-chart__legend-swatch');
					return {
						label: labelEl ? (labelEl.textContent ?? '') : '',
						swatchColor: swatchEl ? getComputedStyle(swatchEl).backgroundColor.trim() : '',
					};
				})
			: [];
		const seriesMarks = requestSeries.map((s) => {
			const rectEls = seriesRectEls(s.key);
			const firstRect = rectEls[0] ?? null;
			const totalHeight = rectEls.reduce((sum, el) => sum + el.getBoundingClientRect().height, 0);
			return {
				key: s.key,
				label: s.label,
				tone: s.tone,
				fill: firstRect ? getComputedStyle(firstRect).fill.trim() : '',
				markCount: rectEls.length,
				totalHeight,
			};
		});

		// --- C3 -----------------------------------------------------------
		const c3Section = document.querySelector('[data-chart-geometry="c3"]');
		const linePathEl = c3Section ? c3Section.querySelector('.vt-chart__line path') : null;
		const d = linePathEl ? linePathEl.getAttribute('d') : null;
		const subpathCount = d ? (d.match(/[Mm]/g) ?? []).length : 0;
		const vertices = d ? [...d.matchAll(/[MLml]\s*(-?[\d.]+)[, ]\s*(-?[\d.]+)/g)].map((m) => ({ x: parseFloat(m[1]), y: parseFloat(m[2]) })) : [];
		const linePathBox = boxOf(linePathEl ? linePathEl.getBoundingClientRect() : null);

		// --- C5 -------------------------------------------------------------
		const meterFixtures = /** @type {ReadonlyArray<{ id: string, value: number, total: number }>} */ (fx.METER_FIXTURES);
		const meters = meterFixtures.map((mf) => {
			const wrap = document.querySelector(`[data-chart-geometry-meter="${mf.id}"]`);
			const fill = wrap ? wrap.querySelector('.vt-chart__meter-fill') : null;
			const track = wrap ? wrap.querySelector('.vt-chart__meter-track') : null;
			return { id: mf.id, value: mf.value, total: mf.total, fillWidth: fill ? fill.getBoundingClientRect().width : 0, trackWidth: track ? track.getBoundingClientRect().width : 0 };
		});

		// --- controls (D-11/D-12) -------------------------------------------
		const BODY_TERMS = ['button', 'input', 'select', 'textarea', '[onclick]', 'a[href]'];
		const bodyEls = [...document.querySelectorAll('.panel-body')];
		/** @type {Record<string, number>} */
		const bodyByTerm = {};
		let bodyTotal = 0;
		for (const term of BODY_TERMS) {
			let count = 0;
			for (const body of bodyEls) count += body.querySelectorAll(term).length;
			bodyByTerm[term] = count;
			bodyTotal += count;
		}
		const switchButtons = [...document.querySelectorAll('.panel-view-switch button')].filter((b) => !b.closest('.panel-body')).length;
		const probeEl = document.querySelector('.chart-geometry-control-probe');
		const PROBE_TERMS = ['input', 'select', 'textarea', '[onclick]', 'a[href]'];
		/** @type {Record<string, number>} */
		const probeByTerm = {};
		for (const term of PROBE_TERMS) probeByTerm[term] = probeEl ? probeEl.querySelectorAll(term).length : 0;

		// --- view (D-13/D-17/D-18/D-19) -------------------------------------
		const c1GridSection = document.querySelector('[data-chart-geometry="c1-grid"]');
		const gridPresent = c1GridSection !== null;
		const gridCountGrid = c1GridSection ? c1GridSection.querySelector('.eo-count-grid') : null;
		const gridHeight = gridCountGrid ? gridCountGrid.getBoundingClientRect().height : 0;
		const partialMeterTrack = document.querySelector('[data-chart-geometry-meter="partial"] .vt-chart__meter-track');
		const meterTrackWidth = partialMeterTrack ? partialMeterTrack.getBoundingClientRect().width : 0;
		const mounted = [...document.querySelectorAll('[data-chart-geometry]')].map((el) => el.getAttribute('data-chart-geometry')).filter((n) => n != null);

		// --- 60-13 small-count numeric-axis probes --------------------------
		// The vertical bar/stacked-bar probes are numeric on the Y axis; the
		// time-series probe is also numeric on Y (its X axis is the category
		// axis) -- all three read `.recharts-yAxis-tick-labels .vt-chart__axis`.
		const smallCountProbeIds = /** @type {ReadonlyArray<string>} */ (fx.smallCountProbeIds ?? []);
		const smallCountTicks = smallCountProbeIds.map((probeId) => {
			const root = document.querySelector(`[data-chart-geometry="${probeId}"]`);
			const tickEls = root ? [...root.querySelectorAll('.recharts-yAxis-tick-labels .vt-chart__axis')] : [];
			return { probeId, ticks: tickEls.map((el) => (el.textContent ?? '').trim()) };
		});

		return {
			readout,
			tokens: {
				'chart-series-1': tokenOf('--chart-series-1'),
				'chart-series-2': tokenOf('--chart-series-2'),
				ok: tokenOf('--ok'),
				warn: tokenOf('--warn'),
				fail: tokenOf('--fail'),
				border: tokenOf('--border'),
				muted: tokenOf('--muted'),
			},
			mounted,
			bars,
			labels,
			svgBox,
			segments: categories,
			legend,
			seriesMarks,
			linePath: { vertices, subpathCount, box: linePathBox, present: linePathEl != null },
			meters,
			controls: { bodyTotal, bodyByTerm, switchButtons, probeByTerm },
			smallCountTicks,
			view: {
				barCount,
				gridPresent,
				gridHeight,
				meterTrackWidth,
				storedRegistrations: readout ? readout.storedViews.registrations : null,
				storedKeyholders: readout ? readout.storedViews.keyholders : null,
			},
		};
	}, fixtures);
}

/**
 * Anti-vacuity, before any rung runs. Each check is its own named hard stop.
 * `passLabel` scopes the pass-specific checks: rungs 1-6 measure the
 * DEFAULT pass; rung 7 also uses the GRID pass, whose own C1/C2/C3 sections
 * never mount by design (`60-10`'s unmounting) — a "zero marks" bail would
 * be a false alarm there.
 * @param {any} m the readPage() result
 * @param {'default' | 'grid'} passLabel
 * @returns {string | null} a bail message, or null if clear
 */
function checkVacuity(m, passLabel) {
	if (m.readout === null) return 'the harness never published its readout — the page did not finish.';
	if (m.readout.error !== null) return `the harness recorded a render error: ${m.readout.error}`;
	if (m.readout.fixtureMeta.version !== FIXTURE_META.version) return `readout fixtureMeta.version ${m.readout.fixtureMeta.version} disagrees with the driver's own import (${FIXTURE_META.version})`;
	for (const key of /** @type {const} */ ([
		'statusCount',
		'requestCategoryCount',
		'intakeBucketCount',
		'meterCount',
		'smallCountMax',
		'smallCountBarMax',
		'smallCountStackedMax',
		'smallCountTimeMax',
	])) {
		if (m.readout.fixtureMeta[key] !== FIXTURE_META[key]) return `readout fixtureMeta.${key} (${m.readout.fixtureMeta[key]}) disagrees with the driver's own import (${FIXTURE_META[key]})`;
	}
	for (const [name, value] of Object.entries(m.tokens)) {
		if (!value) return `design token --${name} did not resolve to a computed colour — the page has likely lost its stylesheet.`;
	}
	if (m.tokens['chart-series-1'] === m.tokens['chart-series-2']) return `--chart-series-1 and --chart-series-2 resolve to the same colour (${m.tokens['chart-series-1']}) — the token layer is not distinguishing them.`;

	if (passLabel === 'default') {
		if (!m.mounted.includes('c1') || !m.mounted.includes('c2') || !m.mounted.includes('c3')) return `default pass: mounted=${JSON.stringify(m.mounted)} is missing c1/c2/c3`;
		if (m.bars.every((/** @type {{ height: number }} */ b) => b.height === 0)) return 'default pass: C1 rendered zero marks';
		if (m.segments.every((/** @type {{ segments: { height: number }[] }} */ c) => c.segments.every((s) => s.height === 0))) return 'default pass: C2 rendered zero marks';
		if (m.linePath.vertices.length === 0) return 'default pass: C3 rendered zero marks';
		if (m.meters.every((/** @type {{ trackWidth: number }} */ mt) => mt.trackWidth === 0)) return 'default pass: C5 rendered zero marks';
		if (m.view.storedRegistrations !== null) return `default pass: vt-dashboard-panel-view:registrations is already "${m.view.storedRegistrations}" — D-18's chart-first default was never exercised`;
		// 60-13: a missing probe id, or a probe that mounted but published zero
		// ticks, is a loud bail rather than a silent pass -- either would make
		// `numeric-axis-ticks-are-whole-numbers` meaningless rather than failing.
		for (const probeId of FIXTURE_META.smallCountProbeIds) {
			if (!m.mounted.includes(probeId)) return `default pass: mounted=${JSON.stringify(m.mounted)} is missing small-count probe "${probeId}"`;
		}
		const smallCountTicks = /** @type {ReadonlyArray<{ probeId: string, ticks: ReadonlyArray<string> }>} */ (m.smallCountTicks ?? []);
		for (const probe of smallCountTicks) {
			if (!Array.isArray(probe.ticks) || probe.ticks.length === 0) return `default pass: small-count probe "${probe.probeId}" published zero numeric-axis ticks`;
		}
	} else {
		if (!m.mounted.includes('c1-grid') || !m.mounted.includes('c2-grid') || !m.mounted.includes('c3')) return `grid pass: mounted=${JSON.stringify(m.mounted)} is missing c1-grid/c2-grid/c3`;
		if (m.view.storedRegistrations !== 'grid') return `grid pass: vt-dashboard-panel-view:registrations is "${m.view.storedRegistrations}", not "grid" — the seed did not take`;
	}
	return null;
}

/**
 * Drives a real hover over each series' first non-zero-valued rendered
 * segment inside `[data-chart-geometry="c2"]`, and reads back
 * `.vt-chart__tooltip`'s own text plus its label/value span counts (60-12,
 * closing 60-UAT test 14 / 60-REVIEW WR-01). Must run on `page` BEFORE its
 * context closes -- the interface_contract this driver observes
 * (`defaultContext.close()` runs immediately after `readPage` otherwise).
 * Hovers only segments with a non-zero fixture value: `StackedBarSeries`
 * renders no rect for a zero-valued segment (the C2 planted zero control),
 * so a zero-valued segment has nothing to hover. Moves the pointer off the
 * chart between hovers so the next hover is a genuine re-activation, never a
 * stale render carried over from the previous one.
 * @param {import('playwright').Page} page
 * @param {ReadonlyArray<{ key: string, label: string, tone: string }>} requestSeries
 * @returns {Promise<Array<{ text: string, labelCount: number, valueCount: number }>>}
 */
async function readTooltips(page, requestSeries) {
	/** @type {Array<{ text: string, labelCount: number, valueCount: number }>} */
	const readouts = [];
	for (const series of requestSeries) {
		const rect = page.locator(`[data-chart-geometry="c2"] .recharts-rectangle.vt-chart__segment--${series.tone}`).first();
		if ((await rect.count()) === 0) {
			readouts.push({ text: '', labelCount: 0, valueCount: 0 });
			continue;
		}
		await rect.hover();
		const tooltip = page.locator('.vt-chart__tooltip');
		await tooltip.waitFor({ state: 'visible', timeout: TOOLTIP_WAIT_TIMEOUT_MS }).catch(() => {});
		const tooltipVisible = (await tooltip.count()) > 0;
		const text = tooltipVisible ? ((await tooltip.textContent()) ?? '') : '';
		const labelCount = await page.locator('.vt-chart__tooltip .vt-chart__tooltip-label').count();
		const valueCount = await page.locator('.vt-chart__tooltip .vt-chart__tooltip-value').count();
		readouts.push({ text, labelCount, valueCount });
		await page.mouse.move(0, 0);
		await tooltip.waitFor({ state: 'hidden', timeout: TOOLTIP_WAIT_TIMEOUT_MS }).catch(() => {});
	}
	return readouts;
}

/** @param {number} port @param {boolean} skipBuild @returns {Promise<void>} */
async function runBrowserGate(port, skipBuild) {
	if (!skipBuild) await buildGate();
	const entryRel = resolveGateEntry();

	/** @type {Awaited<ReturnType<typeof serveDist>> | undefined} */
	let server;
	/** @type {import('playwright').Browser | undefined} */
	let browser;
	try {
		server = await serveDist(DIST, port);
		browser = await chromium.launch({ headless: true });
		const fixtures = { STATUS_FIXTURE, REQUEST_FIXTURE, REQUEST_SERIES, INTAKE_FIXTURE, METER_FIXTURES, smallCountProbeIds: FIXTURE_META.smallCountProbeIds };

		// -- Default pass: no storage seeded — D-18's chart-first default ----
		const defaultContext = await browser.newContext();
		const defaultPage = await defaultContext.newPage();
		await gotoAndWait(defaultPage, `${server.url}/${entryRel}`);
		const defaultMeasured = await readPage(defaultPage, fixtures);
		const defaultVacuity = checkVacuity(defaultMeasured, 'default');
		if (defaultVacuity) fail(`default pass: ${defaultVacuity}`);
		const tooltipReadouts = await readTooltips(defaultPage, REQUEST_SERIES);
		await defaultContext.close();

		{
			const v = evaluateBarsProportional(defaultMeasured.bars);
			record('c1-status-bars-proportional', v.passed, v.detail);
		}
		{
			const v = evaluateLabelsUnclipped(defaultMeasured.labels, defaultMeasured.svgBox);
			record('c1-status-labels-unclipped', v.passed, v.detail);
		}
		{
			const v = evaluateSegmentsSumToTotal(defaultMeasured.segments);
			record('c2-stacked-segments-sum-to-total', v.passed, v.detail);
		}
		{
			const seriesTotals = REQUEST_SERIES.map((s) => ({
				label: s.label,
				total: REQUEST_FIXTURE.reduce((sum, cat) => sum + (cat.segments.find((seg) => seg.seriesKey === s.key)?.value ?? 0), 0),
			}));
			const v = evaluateLegendPairsWithSeries(defaultMeasured.legend, defaultMeasured.seriesMarks, seriesTotals);
			record('c2-legend-swatch-matches-series-fill', v.passed, v.detail);
		}
		{
			const expectations = REQUEST_SERIES.map((s) => {
				const category = REQUEST_FIXTURE.find((cat) => (cat.segments.find((seg) => seg.seriesKey === s.key)?.value ?? 0) !== 0);
				const otherSeries = REQUEST_SERIES.find((o) => o.key !== s.key);
				const value = category ? (category.segments.find((seg) => seg.seriesKey === s.key)?.value ?? 0) : 0;
				return {
					seriesLabel: s.label,
					otherSeriesLabel: otherSeries ? otherSeries.label : '',
					categoryLabel: category ? category.label : '',
					value,
				};
			});
			const v = evaluateTooltipContent(tooltipReadouts, expectations);
			record('c2-tooltip-names-hovered-segment-once', v.passed, v.detail);
		}
		{
			const expectedValues = INTAKE_FIXTURE.map((d) => d.value);
			const v = evaluateMarksMatchBuckets(defaultMeasured.linePath, { values: expectedValues });
			record('c3-marks-match-buckets-no-gaps', v.passed, v.detail);
		}
		{
			const v = evaluateMeterRatios(defaultMeasured.meters);
			record('c5-meter-fill-ratio-proportional', v.passed, v.detail);
		}
		{
			const v = evaluateControlAbsence(defaultMeasured.controls);
			record('panel-body-free-of-controls', v.passed, v.detail);
		}
		{
			// 60-REVIEW-2 CR-01: each probe's own real maximum, not one shared
			// bound -- the time-series probe's real max (2) is one unit tighter
			// than the bar/stacked probes' shared max (3).
			const v = evaluateNumericAxisTicksAcrossProbes(defaultMeasured.smallCountTicks, {
				'ticks-vertical-bar': FIXTURE_META.smallCountBarMax,
				'ticks-stacked-bar': FIXTURE_META.smallCountStackedMax,
				'ticks-time-series': FIXTURE_META.smallCountTimeMax,
			});
			record('numeric-axis-ticks-are-whole-numbers', v.passed, v.detail);
		}

		// -- Grid pass: a SECOND, genuinely fresh navigation, the flag seeded
		//    via the app's own panelViewStorageKey BEFORE any document script
		//    runs — proves D-19's persistence, not merely D-18's default. ----
		const gridContext = await browser.newContext();
		await gridContext.addInitScript(
			(/** @type {{ key: string, value: string }} */ seed) => window.localStorage.setItem(seed.key, seed.value),
			{ key: panelViewStorageKey(FIXTURE_META.registrationsCapabilityId), value: 'grid' },
		);
		const gridPage = await gridContext.newPage();
		await gotoAndWait(gridPage, `${server.url}/${entryRel}`);
		const gridMeasured = await readPage(gridPage, fixtures);
		const gridVacuity = checkVacuity(gridMeasured, 'grid');
		if (gridVacuity) fail(`grid pass: ${gridVacuity}`);
		await gridContext.close();

		{
			const v = evaluateViewSwitchSwapsRepresentations(defaultMeasured.view, gridMeasured.view);
			record('view-switch-swaps-representations', v.passed, v.detail);
		}
	} finally {
		await browser?.close();
		await server?.close();
	}

	let failed = 0;
	for (const id of RUNG_IDS) {
		const rung = rungs.find((r) => r.id === id);
		if (!rung) {
			failed += 1;
			process.stdout.write(`FAIL  ${id}\n      -> never ran\n`);
			continue;
		}
		if (!rung.passed) failed += 1;
		process.stdout.write(`${rung.passed ? 'PASS' : 'FAIL'}  ${rung.id}\n      -> ${rung.detail}\n`);
	}
	process.stdout.write(`\nCHART GEOMETRY GATE: ${failed === 0 ? 'PASS' : 'FAIL'} (${RUNG_IDS.length - failed}/${RUNG_IDS.length} rungs)\n`);
	if (failed === 0) process.stdout.write(`RECEIPT chart-geometry-dashboard rungs=${RUNG_IDS.length} passed=${RUNG_IDS.length}\n`);
	process.exitCode = failed === 0 ? 0 : 1;
}

async function main() {
	const argv = process.argv.slice(2);
	let skipBuild = false;
	let port = DEFAULT_PORT;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--skip-build') skipBuild = true;
		else if (arg === '--prove-matchers') return runProveMatchers();
		else if (arg === '--port') {
			i += 1;
			port = Number(argv[i]);
		} else {
			process.stderr.write(`[${LABEL}] unrecognised argument "${arg}" — refusing to run rather than ignoring it into a green result.\n`);
			process.exit(2);
		}
	}
	if (!Number.isInteger(port) || port <= 0) fail(`--port must be a positive integer, got "${port}".`);

	await runBrowserGate(port, skipBuild);
}

await main();
