#!/usr/bin/env node
/**
 * label-headroom-gate.mjs — closes G10 (phase 60 `deferred-items.md`
 * `60-REVIEW-2 / WR-03`): `domain={[0, 'dataMax']}` (60-13) pins the tallest
 * bar's top to the plot area's own y=0 edge, so the vertical form's top
 * `<LabelList>` count must now fit entirely inside the fixed 24px top
 * `margin` (`BarSeries.tsx:67`, `{ top: 24, right: 8, bottom: 8, left: 8 }`).
 *
 * WHY THIS METRIC, NOT "clearance to the plot area's own gridline": that was
 * this file's FIRST design, and mutation-proof (below) DISPROVED it --
 * `BarSeries.tsx`'s top `<LabelList>` is positioned relative to the BAR's
 * own top y-coordinate, which coincides with the plot area's y=0 edge (the
 * same coincidence 60-13/WR-03 are both about), so the label-to-plot-area-top
 * gap is a Recharts-internal constant (measured ~2px) that moves in lockstep
 * with `margin.top` and is provably insensitive to it -- reducing
 * `margin.top` from 24 to 8 left that gap at exactly 2px in both builds. The
 * metric that margin.top actually controls is the label's clearance from the
 * SVG element's OWN top edge (what "the fixed 24px top margin must
 * accommodate" means literally): `label.top - svgBox.top`. The EXISTING
 * `c1-status-labels-unclipped` rung (`run-chart-geometry-gate.mjs:187-193`)
 * already asserts a version of this, but only at a 0.5px "has it fully
 * escaped" tolerance -- a label rendering with 1px of daylight above the
 * SVG's edge, visually pressed against the chart's own boundary, passes that
 * check. This gate asserts a real BUFFER instead (`MIN_TOP_CLEARANCE_PX`),
 * catching the "cramped, not yet clipped" case WR-03 names, at a size the
 * mutation proof below confirms is neither vacuous nor redundant with the
 * existing rung.
 *
 * MEASURED FIRST (not assumed): against a real 7-digit production-scale
 * count (9,876,543 -- an order of magnitude past any real county roll), the
 * label's box top is 667px, the chart's own SVG box top is 660px -- 7px of
 * real clearance. `MIN_TOP_CLEARANCE_PX` is set to 4px: strictly below the
 * measured 7px (so today's real build passes with margin to spare, not by
 * matching the exact pixel), while catching a `margin.top` erosion well
 * before the label fully escapes the SVG box (that full-escape case is
 * already `c1-status-labels-unclipped`'s job).
 *
 * MUTATION PROOF (BarSeries.tsx:67's vertical-form `margin.top`, restored via
 * `cp` + `diff` after each measurement, never `git checkout`):
 *   - top: 24 (real, unmutated)            -> clearance  7px -> PASS
 *   - top: 20 (a plausible future erosion) -> clearance  3px -> FAIL (this rung)
 *   - top: 8  (the large mutation)         -> clearance -9px -> FAIL (this
 *     rung AND `c1-status-labels-unclipped`'s own escape check, confirmed by
 *     hand against `run-chart-geometry-gate.mjs`'s `evaluateLabelsUnclipped`
 *     logic applied to the same measured numbers)
 * Restored to the original 24 after each pass; final `diff` against the
 * pre-mutation backup is byte-identical.
 *
 * Depends on `gap-probe.tsx`'s `tall-label-bar` probe (the same throwaway
 * harness `measure-gap-probe.mjs` reads for G8/G9's measurement transcript).
 * Build first: `vite build --config test/browser/vite.gap-probe.config.ts`.
 *
 * NOT wired into `run-chart-geometry-gate.mjs`'s `RUNG_IDS` registry and NOT
 * referenced by `web-gates.yml` — a deliberate scope choice: wiring a new
 * rung into that file would require re-pinning `EXPECTED_RUNG_IDS`
 * (`chart-geometry-harness.test.mjs`) and three CI grep pins
 * (`web-gates.yml:1138,1237,1241`), which is plan-sized follow-up work, not
 * an audit-time edit under `BarSeries.tsx`/`chart-geometry-*`'s existing
 * ownership. This script is a complete, independently-runnable gate in its
 * own right in the meantime.
 *
 * FLAGS:
 *   --skip-build       Reuse an existing `dist-gap-probe/` rather than
 *                       rebuilding. Local iteration only.
 *   --prove-matchers   Run the one comparator against a violating input AND
 *                      a healthy one. Needs no browser and no build.
 *   --port <n>         Override the bound port (default 5296).
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveDist } from '../../../../packages/ui-web/scripts/lib/serve-dist.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..', '..');
const DIST = path.join(APP_DIR, 'dist-gap-probe');
const GATE_ENTRY = 'gap-probe.html';
const GATE_CONFIG = 'test/browser/vite.gap-probe.config.ts';
const DEFAULT_PORT = 5296;
const LABEL = 'label-headroom-gate';

export const RUNG_IDS = Object.freeze(['c1-tall-label-clears-svg-top']);

/** MEASURED at 7px against a 7-digit fixture on the real, unmutated build (see header) -- set below the measured value on purpose, not at it. */
export const MIN_TOP_CLEARANCE_PX = 4;

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

/**
 * The one comparator this gate exists for, exported so `--prove-matchers`
 * can exercise it with no browser.
 * @param {number} labelTop the tallest bar's top-positioned count label's measured `getBoundingClientRect().top`
 * @param {number} svgTop the chart's own SVG element's measured `getBoundingClientRect().top` -- what `margin.top` is reserved against
 * @returns {{ passed: boolean, detail: string }}
 */
export function evaluateLabelTopClearance(labelTop, svgTop) {
	const clearance = labelTop - svgTop;
	if (clearance < MIN_TOP_CLEARANCE_PX) {
		return {
			passed: false,
			detail: `label top ${labelTop} leaves only ${clearance.toFixed(2)}px clearance above the chart's own SVG top edge ${svgTop} (want >= ${MIN_TOP_CLEARANCE_PX}px)`,
		};
	}
	return {
		passed: true,
		detail: `label top ${labelTop} clears the chart's own SVG top edge ${svgTop} by ${clearance.toFixed(2)}px (want >= ${MIN_TOP_CLEARANCE_PX}px)`,
	};
}

function proveMatchers() {
	/** @type {Array<{ label: string, args: [number, number], wantPassed: boolean }>} */
	const cases = [
		{ label: 'evaluateLabelTopClearance vs. a label pressed against the SVG top edge (3px, the measured margin:20 erosion shape)', args: [663, 660], wantPassed: false },
		{ label: 'evaluateLabelTopClearance vs. a label that has fully escaped the SVG box (negative clearance, the measured margin:8 shape)', args: [651, 660], wantPassed: false },
		{ label: 'evaluateLabelTopClearance vs. the real measured 7px clearance (healthy, current unmutated build)', args: [667, 660], wantPassed: true },
	];
	let ok = true;
	for (const c of cases) {
		const v = evaluateLabelTopClearance(...c.args);
		const verdict = v.passed === c.wantPassed ? 'OK' : 'MISMATCH';
		if (v.passed !== c.wantPassed) ok = false;
		process.stdout.write(`[${LABEL}] --prove-matchers ${verdict}: ${c.label} -> passed=${v.passed} (want ${c.wantPassed}) :: ${v.detail}\n`);
	}
	if (!ok) fail('--prove-matchers: at least one comparator case did not discriminate as expected');
	process.stdout.write(`[${LABEL}] --prove-matchers: all ${cases.length} case(s) discriminating\n`);
	process.exit(0);
}

/** @param {ReadonlyArray<string>} argv */
function parseArgs(argv) {
	let skipBuild = false;
	let port = DEFAULT_PORT;
	let proveMatchersFlag = false;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--skip-build') {
			skipBuild = true;
		} else if (arg === '--prove-matchers') {
			proveMatchersFlag = true;
		} else if (arg === '--port') {
			i += 1;
			port = Number(argv[i]);
		} else {
			process.stderr.write(`[${LABEL}] unrecognised argument "${arg}"\n`);
			process.exit(2);
		}
	}
	return { skipBuild, port, proveMatchersFlag };
}

/** @param {string} cwd @param {ReadonlyArray<string>} args */
function run(cwd, args) {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn('npx', args, { cwd, stdio: 'inherit', shell: false });
		child.on('exit', (code) => (code === 0 ? resolvePromise(undefined) : rejectPromise(new Error(`${args.join(' ')} exited ${code}`))));
		child.on('error', rejectPromise);
	});
}

async function main() {
	const { skipBuild, port, proveMatchersFlag } = parseArgs(process.argv.slice(2));
	if (proveMatchersFlag) {
		proveMatchers();
		return;
	}

	if (!skipBuild) {
		await run(APP_DIR, ['vite', 'build', '--config', GATE_CONFIG]);
	}

	const { close } = await serveDist(DIST, port);
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		const url = `http://127.0.0.1:${port}/test/browser/${GATE_ENTRY}`;
		await page.goto(url, { waitUntil: 'load' });
		await page.waitForFunction(() => /** @type {any} */ (window).__GAP_PROBE_DONE__ === true, { timeout: 10_000 });

		const renderError = await page.evaluate(() => /** @type {any} */ (window).__GAP_PROBE_ERROR__ ?? null);
		if (renderError) fail(`page reported a render error: ${renderError}`);

		const measured = await page.evaluate(() => {
			const root = document.querySelector('[data-gap-probe="tall-label-bar"]');
			if (!root) return null;
			const svg = root.querySelector('svg');
			const svgTop = svg ? svg.getBoundingClientRect().top : null;
			const labelEls = [...root.querySelectorAll('.vt-chart__label')].map((el) => {
				const box = el.getBoundingClientRect();
				return { text: el.textContent, top: box.top, bottom: box.bottom };
			});
			// The tallest bar's label is the one whose top is numerically smallest (closest to the SVG's own top edge).
			const tallest = labelEls.length > 0 ? labelEls.reduce((a, b) => (a.top < b.top ? a : b)) : null;
			return { labelEls, svgTop, tallest };
		});

		if (!measured || !measured.tallest || measured.svgTop == null) {
			fail(`could not measure the tall-label-bar probe's DOM -- measured=${JSON.stringify(measured)}`);
			return;
		}

		const v = evaluateLabelTopClearance(measured.tallest.top, measured.svgTop);
		record('c1-tall-label-clears-svg-top', v.passed, `label "${measured.tallest.text}": ${v.detail}`);
	} finally {
		await browser.close();
		await close();
	}

	let allPassed = true;
	for (const r of rungs) {
		const status = r.passed ? 'PASS' : 'FAIL';
		process.stdout.write(`[${LABEL}] ${status} ${r.id}: ${r.detail}\n`);
		if (!r.passed) allPassed = false;
	}
	process.stdout.write(`[${LABEL}] LABEL HEADROOM GATE: ${allPassed ? 'PASS' : 'FAIL'} (${rungs.filter((r) => r.passed).length}/${rungs.length} rungs)\n`);
	process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
	process.stderr.write(`[${LABEL}] uncaught error: ${err?.stack ?? err}\n`);
	process.exit(1);
});
