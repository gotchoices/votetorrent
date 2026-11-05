#!/usr/bin/env node
/**
 * zero-state-legend-gate.mjs — D-21/D-14 regression gate over `gap-probe.tsx`.
 *
 * Began life as `measure-gap-probe.mjs`, a measure-only harness for the two
 * Nyquist gaps phase 60's second validation pass escalated (G8/G9, i.e.
 * `deferred-items.md`'s WR-01/WR-02). Both are now FIXED, so this file is a
 * gate: it pins the fixed behaviour so neither defect can return silently.
 *
 * WHAT WAS MEASURED, BEFORE AND AFTER (same probes, same selectors, the
 * before column re-measured against HEAD by reverting the fix, rebuilding and
 * re-running — not quoted from the original escalation):
 *
 *   probe              | before (degenerate)        | after (fixed)
 *   -------------------|----------------------------|---------------------------
 *   all-zero-bar       | yTicks ['0']               | yTicks ['0', '1']
 *   all-zero-stacked   | yTicks ['0']               | yTicks ['0', '1']
 *   all-zero-time      | ['0'], line y=55 MIDPOINT  | ['0','1'], line y=102 BASELINE
 *   legend-mismatch    | silent grey rgb(141,151,168) | throws, naming the tone
 *
 * `domain={[0, 'dataMax']}` collapsed to `[0, 0]` on an all-zero dataset; the
 * `TimeSeries` midpoint line was the worst of it, reading as a real mid-range
 * constant rather than as zero. `zeroSafeDataMax` (chart-contracts.ts) floors
 * the upper bound at 1. Separately, `ChartLegend` now throws on a series whose
 * tone has no swatch rule instead of rendering a grey square.
 *
 * TWO TRAPS THIS FILE CLOSES BY CONSTRUCTION:
 *  1. It BUILDS `dist-gap-probe/` itself. The measure-only predecessor served
 *     an already-built dist, so a run after editing src but before rebuilding
 *     was inert — it reported the pre-fix numbers against fixed source, which
 *     reads exactly like "the fix does not work".
 *  2. Its tick selectors match the ones the real gates use
 *     (`.recharts-<axis>-tick-labels .vt-chart__axis`). The predecessor used
 *     only a generic selector, reported an empty tick list for every probe,
 *     and so could not have seen the degenerate axis at all.
 *
 * Modes: default runs the rungs; `--dump` prints the raw measurement JSON;
 * `--prove-matchers` proves every comparator can fail without a browser.
 */
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveDist } from '../../../../packages/ui-web/scripts/lib/serve-dist.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..', '..');
const DIST = path.join(APP_DIR, 'dist-gap-probe');
const PORT = 5299;


/**
 * Sub-pixel slack for the copy-fits-its-frame comparison. 1px absorbs layout
 * rounding without admitting a real clip: the mutation that motivated this
 * check overflowed by ~17px.
 */
const CLIP_TOLERANCE_PX = 1;

const RUNG_IDS = Object.freeze([
	'all-zero-axis-is-not-degenerate',
	'legend-rejects-non-legend-tone',
	'empty-chart-frame-renders-copy',
]);

/**
 * D-21: an empty chart renders its own frame plus explicit copy, never a blank
 * region. 60-UAT round 2 measured ZERO `.vt-chart__empty` nodes across all four
 * served harnesses, and found the only test naming the class asserts it appears
 * in a registry LIST -- a presence check standing in for a render check, which
 * is exactly how a blank-box regression would survive.
 *
 * Four properties, because a blank box can arise four different ways and only
 * the first is caught by asking "does the element exist":
 *  - the empty frame exists AND has a real measured box (a collapsed 0-height
 *    region is the blank D-21 forbids, and it still satisfies a node query);
 *  - it carries copy text that is non-empty after trimming;
 *  - that text is NOT the copy key itself -- `t()` echoing an unresolved key
 *    renders "panels.registrations.intakeChart.empty" to an officer, which is
 *    a blank box with extra steps;
 *  - no chart surface rendered inside it, so we know we measured the empty
 *    branch and not a populated chart that happens to contain the class.
 * Anti-vacuity first: too few probes, or a probe missing entirely, fails loudly
 * rather than passing an empty loop.
 *
 * @param {Record<string, { framePresent?: boolean, frameBox?: { width: number, height: number, top: number, bottom: number } | null, copyText?: string | null, copyBox?: { width: number, height: number, top: number, bottom: number } | null, copyKey?: string | null, chartSurfaces?: number } | null | undefined>} probes
 * @returns {{ passed: boolean, detail: string }}
 */
export function evaluateEmptyFrame(probes) {
	/** @type {string[]} */
	const problems = [];
	const entries = Object.entries(probes ?? {});
	if (entries.length < 2) {
		problems.push(
			`only ${entries.length} empty probe(s) supplied (want >= 2) -- too few to cover both reachable primitives (StackedBarSeries, TimeSeries)`,
		);
	}
	for (const [id, probe] of entries) {
		if (!probe) {
			problems.push(`probe "${id}" is missing entirely`);
			continue;
		}
		if (!probe.framePresent) {
			problems.push(`probe "${id}" rendered NO .vt-chart__empty-frame -- an empty dataset produced a blank region (D-21)`);
			continue;
		}
		const box = probe.frameBox;
		if (!box || !(box.height > 0) || !(box.width > 0)) {
			problems.push(
				`probe "${id}" empty frame measured ${box ? `${box.width}x${box.height}` : 'no box'} -- a collapsed frame is still a blank to a reader`,
			);
		}
		const text = String(probe.copyText ?? '').trim();
		if (text === '') {
			problems.push(`probe "${id}" empty frame carries no copy -- a framed blank is still a blank (D-21)`);
			continue;
		}
		const key = String(probe.copyKey ?? '').trim();
		if (key !== '' && text === key) {
			problems.push(
				`probe "${id}" empty copy rendered the raw key ${JSON.stringify(key)} -- t() did not resolve it, so an officer reads a dotted identifier`,
			);
		}
		// Presence of text is NOT visibility of text. Measure the copy's own box
		// and require it to FIT the frame: a frame collapsed to its borders keeps
		// textContent intact while painting nothing.
		const copyBox = probe.copyBox;
		if (!copyBox || !(copyBox.height > 0) || !(copyBox.width > 0)) {
			problems.push(
				`probe "${id}" empty copy has no painted box (${copyBox ? `${copyBox.width}x${copyBox.height}` : 'none'}) -- the text exists in the DOM but renders nothing`,
			);
		} else if (box && Number.isFinite(box.bottom) && Number.isFinite(copyBox.bottom)) {
			const overflowPx = Math.max(copyBox.bottom - box.bottom, box.top - copyBox.top);
			if (overflowPx > CLIP_TOLERANCE_PX) {
				problems.push(
					`probe "${id}" empty copy overflows its frame by ${overflowPx.toFixed(1)}px (frame ${box.height.toFixed(0)}px tall, copy ${copyBox.height.toFixed(0)}px) -- clipped out of sight`,
				);
			}
		}
		if (Number(probe.chartSurfaces ?? 0) > 0) {
			problems.push(
				`probe "${id}" rendered ${probe.chartSurfaces} chart surface(s) inside its empty frame -- this probe is not measuring the isEmpty branch`,
			);
		}
	}
	return {
		passed: problems.length === 0,
		detail: problems.length === 0
			? `${entries.length} empty probe(s), each a real measured frame carrying resolved copy, no chart surface`
			: problems.join('; '),
	};
}

/**
 * An all-zero dataset must still produce a USABLE scale. Two properties, both
 * of which the pre-fix build failed:
 *  - at least two distinct numeric ticks (a lone '0' is the degenerate
 *    `[0, 0]` signature), all whole numbers;
 *  - for the line probe, the flat line sits on the BASELINE, not the plot
 *    area's midpoint. This is the property that actually matters to a reader:
 *    a midpoint line reads as a real mid-range value.
 * Anti-vacuity first — a probe that published no ticks at all would otherwise
 * sail through the "all whole" check.
 *
 * @param {Record<string, { yTicks?: ReadonlyArray<string|null>, lineD?: string|null, plotArea?: { top: number, bottom: number }|null } | null | undefined>} probes
 * @returns {{ passed: boolean, detail: string }}
 */
export function evaluateZeroState(probes) {
	/** @type {string[]} */
	const problems = [];
	const entries = Object.entries(probes ?? {});
	if (entries.length < 3) {
		problems.push(`only ${entries.length} probe(s) supplied (want >= 3) -- too few to cover all three primitives`);
	}
	for (const [id, probe] of entries) {
		if (!probe) {
			problems.push(`probe "${id}" is missing entirely`);
			continue;
		}
		const ticks = (probe.yTicks ?? []).map((t) => String(t ?? '').trim()).filter((t) => t !== '');
		if (ticks.length === 0) {
			problems.push(`probe "${id}" published NO numeric ticks -- this rung would be vacuous`);
			continue;
		}
		const distinct = new Set(ticks);
		if (distinct.size < 2) {
			problems.push(
				`probe "${id}" numeric axis collapsed to ${distinct.size} distinct tick ${JSON.stringify([...distinct])} -- the degenerate [0, 0] domain signature`,
			);
		}
		for (const tick of ticks) {
			if (!/^-?\d+$/.test(tick.replace(/[\s,]/g, ''))) {
				problems.push(`probe "${id}" tick ${JSON.stringify(tick)} is not a whole number`);
			}
		}
		if (probe.lineD) {
			const ys = [...String(probe.lineD).matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map((m) => Number(m[2]));
			if (ys.length === 0) {
				problems.push(`probe "${id}" has a line path with no parseable vertices`);
			} else if (probe.plotArea && Number.isFinite(probe.plotArea.top) && Number.isFinite(probe.plotArea.bottom)) {
				const { top, bottom } = probe.plotArea;
				const baseline = bottom;
				const midpoint = (top + bottom) / 2;
				const worst = Math.min(...ys.map((y) => Math.abs(y - baseline)));
				const toMid = Math.min(...ys.map((y) => Math.abs(y - midpoint)));
				if (worst > 2 && toMid <= worst) {
					problems.push(
						`probe "${id}" all-zero line sits ${worst.toFixed(1)}px from the baseline (${baseline}) but only ${toMid.toFixed(1)}px from the midpoint (${midpoint}) -- the misleading mid-height signature`,
					);
				}
			}
		}
	}
	return {
		passed: problems.length === 0,
		detail: problems.length === 0
			? `${entries.length} all-zero probe(s), each on a real multi-tick whole-number scale, lines on the baseline`
			: problems.join('; '),
	};
}

/**
 * A legend-bearing series whose tone has no swatch rule must FAIL LOUDLY. The
 * pre-fix build rendered a silent grey swatch, which is why this rung asserts
 * a throw whose message names the offending tone -- a bare "it threw" would
 * pass against any unrelated crash.
 *
 * @param {Record<string, string>} throwsById
 * @param {string} probeId
 * @param {string} tone
 * @returns {{ passed: boolean, detail: string }}
 */
export function evaluateLegendContract(throwsById, probeId, tone) {
	const message = (throwsById ?? {})[probeId];
	if (typeof message !== 'string' || message.trim() === '') {
		return {
			passed: false,
			detail: `probe "${probeId}" did not throw -- ChartLegend accepted a series toned "${tone}" and rendered a swatch for it (the silent-grey-swatch defect is back)`,
		};
	}
	const problems = [];
	if (!message.includes(tone)) problems.push(`the thrown message does not name the offending tone "${tone}": ${JSON.stringify(message)}`);
	if (!/ChartLegend/.test(message)) problems.push(`the thrown message does not identify ChartLegend as the source: ${JSON.stringify(message)}`);
	return {
		passed: problems.length === 0,
		detail: problems.length === 0 ? `ChartLegend threw, naming tone "${tone}"` : problems.join('; '),
	};
}

function proveMatchers() {
	const plotArea = { top: 8, bottom: 102 };
	const healthyProbes = {
		'all-zero-bar': { yTicks: ['0', '1'], lineD: null, plotArea },
		'all-zero-stacked': { yTicks: ['0', '1'], lineD: null, plotArea },
		'all-zero-time': { yTicks: ['0', '1'], lineD: 'M68,102L180,102', plotArea },
	};
	// Shaped from the real measured readout, not invented: see the gate run's
	// own `--dump` output for the live values these mirror.
	const healthyEmpty = {
		'empty-stacked': {
			framePresent: true,
			frameBox: { width: 420, height: 182, top: 0, bottom: 182 },
			copyText: 'No requests recorded yet.',
			copyBox: { width: 180, height: 17, top: 82, bottom: 99 },
			copyKey: 'panels.registrations.requestChart.empty',
			chartSurfaces: 0,
		},
		'empty-time': {
			framePresent: true,
			frameBox: { width: 420, height: 142, top: 0, bottom: 142 },
			copyText: 'No requests received in this window.',
			copyBox: { width: 240, height: 17, top: 62, bottom: 79 },
			copyKey: 'panels.registrations.intakeChart.empty',
			chartSurfaces: 0,
		},
	};
	/** @type {ReadonlyArray<[string, () => { passed: boolean, detail: string }, boolean]>} */
	const cases = [
		['evaluateZeroState vs. a healthy all-zero readout (current fixed build)', () => evaluateZeroState(healthyProbes), true],
		[
			'evaluateZeroState vs. a single "0" tick (the measured degenerate [0,0] domain)',
			() => evaluateZeroState({ ...healthyProbes, 'all-zero-bar': { yTicks: ['0'], lineD: null, plotArea } }),
			false,
		],
		[
			'evaluateZeroState vs. a line at the plot-area midpoint (the measured misleading shape)',
			() => evaluateZeroState({ ...healthyProbes, 'all-zero-time': { yTicks: ['0', '1'], lineD: 'M68,55L180,55', plotArea } }),
			false,
		],
		[
			'evaluateZeroState vs. a probe publishing no ticks (would be vacuous)',
			() => evaluateZeroState({ ...healthyProbes, 'all-zero-bar': { yTicks: [], lineD: null, plotArea } }),
			false,
		],
		['evaluateZeroState vs. too few probes supplied', () => evaluateZeroState({ 'all-zero-bar': healthyProbes['all-zero-bar'] }), false],
		[
			'evaluateZeroState vs. a fractional tick',
			() => evaluateZeroState({ ...healthyProbes, 'all-zero-bar': { yTicks: ['0', '0.5'], lineD: null, plotArea } }),
			false,
		],
		['evaluateLegendContract vs. a real throw naming the tone (current fixed build)', () => evaluateLegendContract({ 'legend-mismatch': 'ChartLegend: series "flagged" carries tone "warn", which has no legend swatch rule.' }, 'legend-mismatch', 'warn'), true],
		['evaluateLegendContract vs. no throw at all (the silent grey swatch defect)', () => evaluateLegendContract({}, 'legend-mismatch', 'warn'), false],
		['evaluateLegendContract vs. an unrelated crash that does not name the tone', () => evaluateLegendContract({ 'legend-mismatch': 'ChartLegend: something else went wrong' }, 'legend-mismatch', 'warn'), false],
		['evaluateEmptyFrame vs. a healthy empty readout (current build)', () => evaluateEmptyFrame(healthyEmpty), true],
		[
			'evaluateEmptyFrame vs. no frame at all (the blank-region defect D-21 forbids)',
			() => evaluateEmptyFrame({ ...healthyEmpty, 'empty-time': { ...healthyEmpty['empty-time'], framePresent: false } }),
			false,
		],
		[
			'evaluateEmptyFrame vs. a frame collapsed to 0 height (answers a node query, still a blank)',
			() => evaluateEmptyFrame({ ...healthyEmpty, 'empty-time': { ...healthyEmpty['empty-time'], frameBox: { width: 420, height: 0, top: 0, bottom: 0 } } }),
			false,
		],
		[
			'evaluateEmptyFrame vs. a framed blank carrying no copy',
			() => evaluateEmptyFrame({ ...healthyEmpty, 'empty-stacked': { ...healthyEmpty['empty-stacked'], copyText: '   ' } }),
			false,
		],
		[
			'evaluateEmptyFrame vs. copy that is the raw unresolved t() key',
			() => evaluateEmptyFrame({
				...healthyEmpty,
				'empty-time': { ...healthyEmpty['empty-time'], copyText: 'panels.registrations.intakeChart.empty' },
			}),
			false,
		],
		[
			'evaluateEmptyFrame vs. a chart surface inside the frame (probe not measuring isEmpty)',
			() => evaluateEmptyFrame({ ...healthyEmpty, 'empty-stacked': { ...healthyEmpty['empty-stacked'], chartSurfaces: 1 } }),
			false,
		],
		['evaluateEmptyFrame vs. too few probes supplied', () => evaluateEmptyFrame({ 'empty-time': healthyEmpty['empty-time'] }), false],
		['evaluateEmptyFrame vs. a probe missing entirely', () => evaluateEmptyFrame({ ...healthyEmpty, 'empty-stacked': null }), false],
		[
			'evaluateEmptyFrame vs. copy with no painted box (present in the DOM, renders nothing)',
			() => evaluateEmptyFrame({
				...healthyEmpty,
				'empty-time': { ...healthyEmpty['empty-time'], copyBox: { width: 0, height: 0, top: 0, bottom: 0 } },
			}),
			false,
		],
		[
			'evaluateEmptyFrame vs. copy clipped out of a collapsed frame (the MEASURED overflow:hidden mutation)',
			() => evaluateEmptyFrame({
				...healthyEmpty,
				'empty-stacked': {
					...healthyEmpty['empty-stacked'],
					frameBox: { width: 420, height: 2, top: 0, bottom: 2 },
					copyBox: { width: 180, height: 17, top: -7.4, bottom: 9.4 },
				},
			}),
			false,
		],
		[
			'evaluateEmptyFrame vs. a 1px layout-rounding overhang (must NOT trip the clip check)',
			() => evaluateEmptyFrame({
				...healthyEmpty,
				'empty-time': { ...healthyEmpty['empty-time'], copyBox: { width: 240, height: 17, top: 62, bottom: 142.9 } },
			}),
			true,
		],
	];
	let bad = 0;
	for (const [name, run, want] of cases) {
		const got = run().passed;
		const ok = got === want;
		if (!ok) bad += 1;
		process.stdout.write(`[zero-state-legend-gate] ${ok ? 'OK' : 'BROKEN'}  ${name} -> passed=${got} (want ${want})\n`);
	}
	if (bad > 0) {
		process.stdout.write(`[zero-state-legend-gate] ${bad} comparator case(s) did not behave as specified\n`);
		process.exit(1);
	}
	process.stdout.write(`[zero-state-legend-gate] --prove-matchers: all ${cases.length} case(s) discriminating\n`);
}

function buildGapProbe() {
	// Always build before measuring. See trap (1) in this file's header.
	const res = spawnSync('npx', ['vite', 'build', '--config', 'test/browser/vite.gap-probe.config.ts'], {
		cwd: APP_DIR,
		encoding: 'utf8',
	});
	if (res.status !== 0) {
		throw new Error(`zero-state-legend-gate: gap-probe build failed\n${res.stdout ?? ''}${res.stderr ?? ''}`);
	}
}

async function main() {
	buildGapProbe();
	const { url, close } = await serveDist(DIST, PORT);
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		/** @type {string[]} */
		const consoleMessages = [];
		page.on('console', (msg) => consoleMessages.push(`${msg.type()}: ${msg.text()}`));
		/** @type {string[]} */
		const pageErrors = [];
		page.on('pageerror', (err) => pageErrors.push(String(err)));

		await page.goto(`${url}/test/browser/gap-probe.html`, { waitUntil: 'load' });
		await page.waitForFunction(() => /** @type {any} */ (window).__GAP_PROBE_DONE__ === true, { timeout: 10_000 });

		const renderError = await page.evaluate(() => /** @type {any} */ (window).__GAP_PROBE_ERROR__ ?? null);
		// Probes that threw on purpose. `legend-mismatch` is EXPECTED here once
		// ChartLegend enforces its tone contract; its absence means the guard
		// stopped firing and the silent-grey-swatch defect is back.
		const probeThrows = await page.evaluate(() => /** @type {any} */ (window).__GAP_PROBE_THROWS__ ?? {});

		const measured = await page.evaluate(() => {
			/** @param {string} name */
			function probe(name) {
				return document.querySelector(`[data-gap-probe="${name}"]`);
			}

			/** @param {Element | null} root */
			function measureAxes(root) {
				if (!root) return null;
				const svg = root.querySelector('svg');
				const svgBox = svg ? svg.getBoundingClientRect() : null;
				// Match the selector the REAL gates use (`.recharts-<axis>-tick-labels
				// .vt-chart__axis`, set via each axis's `tick={{ className }}`) and
				// keep the generic one as a fallback -- an earlier version of this
				// script used only the generic form and reported an empty tick list
				// for every probe, which read as "the axis renders no ticks" when it
				// was really the selector missing.
				const xTicks = [
					...root.querySelectorAll('.recharts-xAxis-tick-labels .vt-chart__axis, .recharts-xAxis .recharts-cartesian-axis-tick text, .recharts-xAxis text'),
				].map((el) => el.textContent);
				const yTicks = [
					...root.querySelectorAll('.recharts-yAxis-tick-labels .vt-chart__axis, .recharts-yAxis .recharts-cartesian-axis-tick text, .recharts-yAxis text'),
				].map((el) => el.textContent);
				// Read the rect's own geometry ATTRIBUTES as well as its painted box: a
				// zero-VALUE bar is supposed to exist as a zero-HEIGHT rect, and the
				// two are only distinguishable by looking at the attribute.
				const bars = [
					...root.querySelectorAll('.recharts-bar-rectangle path, .recharts-bar-rectangle rect, .recharts-bar-rectangles path, .recharts-bar-rectangles rect'),
				].map((el) => {
					const box = el.getBoundingClientRect();
					return {
						height: box.height,
						width: box.width,
						attrHeight: el.getAttribute('height'),
						attrY: el.getAttribute('y'),
						tag: el.tagName,
					};
				});
				const line = root.querySelector('.recharts-line-curve, path.vt-chart__line');
				const lineD = line ? line.getAttribute('d') : null;
				// The grid lines' y1/y2 are in the SVG's OWN user units -- the same
				// space `lineD` is expressed in. Reading the painted
				// getBoundingClientRect() here instead would compare a page-pixel
				// baseline against an SVG-unit path and silently never match.
				const gridYs = [...root.querySelectorAll('.recharts-cartesian-grid-horizontal line')]
					.map((el) => Number(el.getAttribute('y1')))
					.filter((n) => Number.isFinite(n));
				const plotArea = gridYs.length > 0 ? { top: Math.min(...gridYs), bottom: Math.max(...gridYs) } : null;
				return {
					svgBox: svgBox ? { width: svgBox.width, height: svgBox.height, top: svgBox.top, bottom: svgBox.bottom } : null,
					plotArea,
					xTicks,
					yTicks,
					bars,
					lineD,
					innerHTMLLength: root.innerHTML.length,
					hasNaNInSvg: svg ? /NaN/.test(svg.outerHTML) : null,
				};
			}

			const allZeroBar = measureAxes(probe('all-zero-bar'));
			const allZeroStacked = measureAxes(probe('all-zero-stacked'));
			const allZeroTime = measureAxes(probe('all-zero-time'));

			// D-21 empty frame. Measures the frame's REAL box rather than its
			// presence: a collapsed 0-height frame still answers a node query,
			// and it is the blank the contract forbids.
			/** @param {string} name @param {string} copyKey */
			function measureEmptyFrame(name, copyKey) {
				const root = probe(name);
				if (!root) return null;
				const frame = root.querySelector('.vt-chart__empty-frame');
				const copy = root.querySelector('.vt-chart__empty');
				const box = frame ? frame.getBoundingClientRect() : null;
				// The copy's OWN painted box, not just its textContent. A frame
				// collapsed by `overflow: hidden` still yields perfectly readable
				// textContent while showing the reader nothing -- mutation-proved,
				// see this rung's header.
				const copyBox = copy ? copy.getBoundingClientRect() : null;
				return {
					framePresent: frame !== null,
					frameBox: box ? { width: box.width, height: box.height, top: box.top, bottom: box.bottom } : null,
					copyText: copy ? copy.textContent : null,
					copyBox: copyBox ? { width: copyBox.width, height: copyBox.height, top: copyBox.top, bottom: copyBox.bottom } : null,
					copyKey,
					chartSurfaces: root.querySelectorAll('svg.recharts-surface').length,
				};
			}
			const emptyStacked = measureEmptyFrame('empty-stacked', 'panels.registrations.requestChart.empty');
			const emptyTime = measureEmptyFrame('empty-time', 'panels.registrations.intakeChart.empty');

			// legend-mismatch: read the legend swatch's real computed background
			// colour for BOTH series, plus the base (no-modifier) swatch colour
			// measured off a synthetic control span for comparison.
			const legendRoot = probe('legend-mismatch');
			const legendItems = legendRoot
				? [...legendRoot.querySelectorAll('.vt-chart__legend-item')].map((item) => {
						const label = item.querySelector('.vt-chart__legend-label')?.textContent ?? null;
						const swatch = item.querySelector('.vt-chart__legend-swatch');
						const swatchClassName = swatch ? swatch.className : null;
						const swatchColor = swatch ? getComputedStyle(swatch).backgroundColor : null;
						return { label, swatchClassName, swatchColor };
					})
				: null;

			// tall-label-bar: measure the top LabelList count text's box vs the
			// chart's own SVG box AND vs the plot area's own top (y=0 gridline).
			const tallRoot = probe('tall-label-bar');
			let tallLabel = null;
			if (tallRoot) {
				const svg = tallRoot.querySelector('svg');
				const svgBox = svg ? svg.getBoundingClientRect() : null;
				const labelTexts = [...tallRoot.querySelectorAll('.vt-chart__label')].map((el) => {
					const box = el.getBoundingClientRect();
					return { text: el.textContent, box: { top: box.top, bottom: box.bottom, left: box.left, right: box.right, height: box.height } };
				});
				// The first (top) horizontal gridline drawn by CartesianGrid marks
				// the plot area's own y=0 line -- read directly rather than assumed.
				const gridLines = [...tallRoot.querySelectorAll('.recharts-cartesian-grid-horizontal line')].map((el) => el.getBoundingClientRect().top);
				const plotAreaTop = gridLines.length > 0 ? Math.min(...gridLines) : null;
				tallLabel = {
					svgBox: svgBox ? { top: svgBox.top, bottom: svgBox.bottom, height: svgBox.height } : null,
					labelTexts,
					plotAreaTop,
				};
			}

			return { allZeroBar, allZeroStacked, allZeroTime, legendItems, tallLabel, emptyStacked, emptyTime };
		});

		if (process.argv.includes('--dump')) {
			process.stdout.write(JSON.stringify({ renderError, probeThrows, consoleMessages, pageErrors, measured }, null, 2) + '\n');
			return;
		}

		if (renderError) {
			throw new Error(`zero-state-legend-gate: the probe page failed to render: ${renderError}`);
		}

		/** @type {ReadonlyArray<[string, { passed: boolean, detail: string }]>} */
		const results = [
			[
				RUNG_IDS[0],
				evaluateZeroState({
					'all-zero-bar': measured.allZeroBar,
					'all-zero-stacked': measured.allZeroStacked,
					'all-zero-time': measured.allZeroTime,
				}),
			],
			[RUNG_IDS[1], evaluateLegendContract(probeThrows, 'legend-mismatch', 'warn')],
			[
				RUNG_IDS[2],
				evaluateEmptyFrame({
					'empty-stacked': measured.emptyStacked,
					'empty-time': measured.emptyTime,
				}),
			],
		];

		let passed = 0;
		for (const [id, result] of results) {
			process.stdout.write(`[zero-state-legend-gate] ${result.passed ? 'PASS' : 'FAIL'} ${id}: ${result.detail}\n`);
			if (result.passed) passed += 1;
		}
		const verdict = passed === results.length ? 'PASS' : 'FAIL';
		process.stdout.write(`[zero-state-legend-gate] ZERO STATE + LEGEND GATE: ${verdict} (${passed}/${results.length} rungs)\n`);
		if (verdict !== 'PASS') process.exitCode = 1;

	} finally {
		await browser.close();
		await close();
	}
}

if (process.argv.includes('--prove-matchers')) {
	proveMatchers();
	process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
	process.stderr.write(`zero-state-legend-gate: ${err?.stack ?? err}\n`);
	process.exit(1);
});
