/**
 * chart-geometry-gate.tsx — the dashboard's D-24 geometry harness (60-07):
 * the surface `run-chart-geometry-gate.mjs` measures with real
 * `getBoundingClientRect()` boxes, not node presence.
 *
 * Its ONLY package stylesheet path is `../../src/app.css` — the app's own
 * stylesheet, never the shared design-token package export imported
 * directly. That is deliberate, for the same reason `ui-gate.tsx` gives:
 * importing the token layer here would make this probe render correctly
 * even on a build where `app.css` had lost its own `@import` of that layer
 * — the probe would then pass on the one failure it exists to catch.
 * Observing the app's own wiring, not re-declaring it, is what makes this
 * harness a genuine test of the app. `chart-geometry-harness.test.mjs`
 * asserts this file names no other package stylesheet, comments included.
 *
 * The two app-local panel stylesheets (`election-ops.css`,
 * `authority-admin.css`) are imported directly below, exactly as
 * `RegistrationsPanel.tsx` and `KeyholdersPanel.tsx` import them for
 * themselves — they are the app's own sheets OBSERVED here, not a second
 * path to the token layer, and they arrive a second time (harmlessly)
 * through `PanelFrame`'s own `panels.css` import.
 *
 * PRODUCTION SHAPE, on purpose. This harness mounts the REAL `PanelFrame`
 * twice (never a hand-built, always-visible evaluation literal — that would
 * also fake away the denied-body guard the frame exists to carry), against the REAL
 * `evaluate()`, and reads the REAL `usePanelView()`. The panel-body-free-
 * of-controls rung's whole force comes from that scoping being real, and
 * the view-switch rung's force comes from the whole storage → frame state →
 * provider → hook chain being production code end to end. The panel
 * BODIES below are fixture-fed reproductions of `60-05`/`60-10`'s Chart/Grid
 * ternary shape — this harness does not prove `RegistrationsPanel` or
 * `KeyholdersPanel` issue their own reads (see `run-chart-geometry-gate.mjs`'s
 * own header for the fully-stated boundary).
 *
 * Chart and grid are never mounted at the same time in either body — under
 * `60-10`'s unmounting (a ternary, never `display:none`), there is exactly
 * one live subtree per aggregate, matching the shape this harness
 * reproduces. C3 (the intake time series) has no table equivalent (`60-10`
 * deferred that todo) and renders unswitched in both arms.
 */
import { StrictMode, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/app.css';
import '../../src/screens/panels/election-ops.css';
import '../../src/screens/panels/authority-admin.css';
import { t } from '@votetorrent/ui-web';
import { BarSeries, StackedBarSeries, TimeSeries, Meter } from '@votetorrent/ui-web/components';
import { PanelFrame } from '../../src/screens/panels/PanelFrame.js';
import { usePanelView } from '../../src/screens/panels/ChartViewContext.js';
import { panelViewStorageKey } from '../../src/screens/panels/panel-view-storage.js';
import { CAPABILITIES } from '../../src/auth/capabilities.js';
import type { Capability } from '../../src/auth/capabilities.js';
import { evaluate } from '../../src/auth/gate.js';
import {
	STATUS_FIXTURE,
	REQUEST_FIXTURE,
	REQUEST_SERIES,
	INTAKE_FIXTURE,
	METER_FIXTURES,
	FIXTURE_META,
	TOOLTIP_COPY_KEYS,
	SMALL_COUNT_BAR_FIXTURE,
	SMALL_COUNT_STACKED_FIXTURE,
	SMALL_COUNT_TIME_FIXTURE,
} from './chart-geometry-fixtures.js';

const win = window as unknown as Record<string, unknown>;

/** Frame budget for the settle poll below — generous, still bounded. Mirrors `ui-gate.tsx`'s `SETTLE_FRAMES`. */
const SETTLE_FRAMES = 60;

function settle(maxFrames: number): Promise<void> {
	return new Promise((resolve) => {
		let frames = 0;
		function tick() {
			frames += 1;
			if (frames >= maxFrames) {
				resolve();
				return;
			}
			requestAnimationFrame(tick);
		}
		requestAnimationFrame(tick);
	});
}

/** @returns the real `Capability` record for `id`, or throws — a missing capability is a harness bug, not a degradeable state. */
function requireCapability(id: string): Capability {
	const found = CAPABILITIES.find((c) => c.id === id);
	if (!found) throw new Error(`chart-geometry-gate.tsx: no capability record for id "${id}"`);
	return found;
}

const registrationsCapability = requireCapability(FIXTURE_META.registrationsCapabilityId);
const keyholdersCapability = requireCapability(FIXTURE_META.keyholdersCapabilityId);

/**
 * The registrations panel body — a fixture-fed reproduction of
 * `60-05`/`60-10`'s Chart/Grid ternary, reading the REAL `usePanelView()`.
 * C1 (`data-chart-geometry="c1"`) and C2 (`data-chart-geometry="c2"`) switch
 * with the flag; C3 (`data-chart-geometry="c3"`) renders unswitched in both
 * arms, matching `60-10`'s deferral of an intake table equivalent.
 *
 * C1's and C2's data are fed the SAME `t()`-composed tooltip strings the real
 * panel composes (`RegistrationsPanel.tsx`'s `toStatusData`/`toRequestData`,
 * mirrored here via `TOOLTIP_COPY_KEYS`) — a fixture-supplied English literal
 * would let a tooltip content rung pass against text the real panel never
 * produces (60-12, closing the WR-01 fixed-series-tooltip defect).
 */
function RegistrationsBodyHarness() {
	const view = usePanelView();

	return (
		<>
			{view === 'chart' ? (
				<section className="eo-section" data-chart-geometry="c1">
					<h4 className="eo-heading">{t('panels.registrations.statusHeading')}</h4>
					<BarSeries
						data={STATUS_FIXTURE.map((d) => ({
							...d,
							tooltip: t(TOOLTIP_COPY_KEYS.statusChart, { status: d.label, count: String(d.value) }),
						}))}
					/>
				</section>
			) : (
				<section className="eo-section" data-chart-geometry="c1-grid">
					<h4 className="eo-heading">{t('panels.registrations.statusHeading')}</h4>
					<div className="eo-count-grid">
						{STATUS_FIXTURE.map((row) => (
							<div key={row.key}>
								<span className="eo-datum">{row.label}</span>
								<span>{row.value}</span>
							</div>
						))}
					</div>
				</section>
			)}

			{view === 'chart' ? (
				<section className="eo-section" data-chart-geometry="c2">
					<h4 className="eo-heading">{t('panels.registrations.requestsHeading')}</h4>
					<StackedBarSeries
						data={REQUEST_FIXTURE.map((datum) => ({
							...datum,
							segments: datum.segments.map((segment) => ({
								...segment,
								tooltip: t(TOOLTIP_COPY_KEYS.requestChart, {
									status: datum.label,
									issuer: REQUEST_SERIES.find((s) => s.key === segment.seriesKey)?.label ?? segment.seriesKey,
									count: String(segment.value),
								}),
							})),
						}))}
						series={[...REQUEST_SERIES]}
						emptyCopyKey="panels.registrations.requestChart.empty"
					/>
				</section>
			) : (
				<section className="eo-section" data-chart-geometry="c2-grid">
					<h4 className="eo-heading">{t('panels.registrations.requestsHeading')}</h4>
					<div className="eo-count-grid">
						{REQUEST_FIXTURE.flatMap((category) =>
							category.segments.map((segment) => {
								const seriesLabel = REQUEST_SERIES.find((s) => s.key === segment.seriesKey)?.label ?? segment.seriesKey;
								const label = `${category.label} / ${seriesLabel}`;
								return (
									<div key={`${category.key}-${segment.seriesKey}`}>
										<span className="eo-datum">{label}</span>
										<span>{segment.value}</span>
									</div>
								);
							}),
						)}
					</div>
				</section>
			)}

			<section className="eo-section" data-chart-geometry="c3">
				<TimeSeries data={[...INTAKE_FIXTURE]} emptyCopyKey="panels.registrations.intakeChart.empty" />
			</section>
		</>
	);
}

/**
 * The keyholders panel body — a fixture-fed reproduction of `60-04`'s
 * Chart/Grid ternary, reading its OWN real `usePanelView()`. This frame's
 * storage key is never written by the driver in any pass, so it stays on
 * the D-18 chart-first default throughout — the chain rung's proof of
 * D-17's own named example: an officer charts registrations while keeping
 * keyholders as numbers.
 */
function KeyholdersBodyHarness() {
	const view = usePanelView();

	if (view === 'chart') {
		return (
			<>
				{METER_FIXTURES.map((meter) => (
					<div className="aa-meter" data-chart-geometry-meter={meter.id} key={meter.id}>
						<Meter
							value={meter.value}
							total={meter.total}
							// Through the copy key, exactly as KeyholdersPanel does. A
							// hardcoded numeral here would make the D-24 screenshot
							// evidence about this harness rather than about the product.
							valueLabel={t('panels.keyholders.meter.value', { count: meter.value, total: meter.total })}
							variant="panel"
							emptyCopyKey="panels.keyholders.meter.empty"
						/>
					</div>
				))}
			</>
		);
	}

	return (
		<>
			{METER_FIXTURES.map((meter) => (
				<div className="aa-row" key={meter.id}>
					<dl className="aa-kv">
						<dt>UserId</dt>
						<dd className="aa-mono">{meter.id}</dd>
						<dt>KeyholderThreshold</dt>
						<dd>{meter.total}</dd>
					</dl>
				</div>
			))}
		</>
	);
}

/**
 * The planted control probe (60-VALIDATION), mounted OUTSIDE both
 * `PanelFrame`s — the proof that `panel-body-free-of-controls`'s DOM query
 * fires on every term of its selector. One of each: `input`, `select` (one
 * option), `textarea`, an element carrying a literal HTML attribute set
 * IMPERATIVELY after mount via `setAttribute` (React never emits that
 * attribute from a prop), and an anchor carrying `href`. D-13's real header
 * switch buttons are NOT part of this probe — they belong to `PanelFrame`
 * and are counted separately.
 */
function ControlProbe() {
	const wrapperRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const target = wrapperRef.current?.querySelector<HTMLElement>('[data-chart-geometry-probe-target]');
		target?.setAttribute('onclick', 'void 0');
	}, []);

	return (
		<div className="chart-geometry-control-probe" ref={wrapperRef}>
			<input type="text" defaultValue="probe" />
			<select defaultValue="probe-option">
				<option value="probe-option">probe</option>
			</select>
			<textarea defaultValue="probe" />
			<span data-chart-geometry-probe-target>probe</span>
			<a href="https://example.invalid/chart-geometry-probe">probe</a>
		</div>
	);
}

/**
 * The small-count numeric-axis probe (60-13). Mounted OUTSIDE both
 * `PanelFrame`s, beside `ControlProbe` — never inside a `.panel-body`, which
 * would put three more chart subtrees inside the scope
 * `panel-body-free-of-controls` and `view-switch-swaps-representations`
 * measure. Fixed at `FIXTURE_META.panelColumnWidthPx` (420px) so the tick
 * branch is deterministic and matches the width the rest of the harness
 * renders at. Covers the three officer-side numeric axes Task 1's public-side
 * fix (BarSeries's horizontal XAxis, exercised by C7) does not: BarSeries's
 * VERTICAL YAxis, StackedBarSeries's YAxis and TimeSeries's YAxis.
 */
function SmallCountTicksProbe() {
	return (
		<div className="chart-geometry-small-count-probe" style={{ width: `${FIXTURE_META.panelColumnWidthPx}px` }}>
			<div data-chart-geometry="ticks-vertical-bar">
				<BarSeries data={[...SMALL_COUNT_BAR_FIXTURE]} />
			</div>
			<div data-chart-geometry="ticks-stacked-bar">
				<StackedBarSeries data={[...SMALL_COUNT_STACKED_FIXTURE]} series={[...REQUEST_SERIES]} emptyCopyKey="panels.registrations.requestChart.empty" />
			</div>
			<div data-chart-geometry="ticks-time-series">
				<TimeSeries data={[...SMALL_COUNT_TIME_FIXTURE]} emptyCopyKey="panels.registrations.intakeChart.empty" />
			</div>
		</div>
	);
}

function ChartGeometryHarness() {
	const registrationsEvaluation = evaluate(registrationsCapability, [registrationsCapability.scope]);
	const keyholdersEvaluation = evaluate(keyholdersCapability, [keyholdersCapability.scope]);

	return (
		<div className="chart-geometry-harness" style={{ width: `${FIXTURE_META.panelColumnWidthPx}px` }}>
			<PanelFrame capability={registrationsCapability} evaluation={registrationsEvaluation}>
				<RegistrationsBodyHarness />
			</PanelFrame>
			<PanelFrame capability={keyholdersCapability} evaluation={keyholdersEvaluation}>
				<KeyholdersBodyHarness />
			</PanelFrame>
			<ControlProbe />
			<SmallCountTicksProbe />
		</div>
	);
}

async function main() {
	const container = document.getElementById('root');
	let renderError: string | null = null;

	if (container) {
		try {
			const root = createRoot(container);
			root.render(
				<StrictMode>
					<ChartGeometryHarness />
				</StrictMode>,
			);
		} catch (err) {
			renderError = String((err as { message?: unknown })?.message ?? err);
		}
	} else {
		renderError = 'chart-geometry-gate.html is missing #root';
	}

	await settle(SETTLE_FRAMES);

	const mounted = [...document.querySelectorAll('[data-chart-geometry]')]
		.map((el) => el.getAttribute('data-chart-geometry'))
		.filter((name): name is string => name != null);

	let storedRegistrations: string | null = null;
	let storedKeyholders: string | null = null;
	try {
		storedRegistrations = window.localStorage.getItem(panelViewStorageKey(registrationsCapability.id));
		storedKeyholders = window.localStorage.getItem(panelViewStorageKey(keyholdersCapability.id));
	} catch {
		// Swallowed on purpose, mirroring panel-view-storage.js's own
		// silent-degrade discipline — a storage read failure here degrades
		// the readout to nulls rather than throwing the harness itself over.
	}

	win.__CHART_GEOMETRY_GATE__ = Object.freeze({
		fixtureMeta: FIXTURE_META,
		mounted,
		storedViews: Object.freeze({ registrations: storedRegistrations, keyholders: storedKeyholders }),
		error: renderError,
	});
	win.__CHART_GEOMETRY_GATE_DONE__ = true;
}

main();
