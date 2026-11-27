/**
 * ui-gate.tsx — the dashboard's ONE new D-24 styled harness entry, and the
 * subject of the D-19 shared runner's `harness-readout` and
 * `shared-components-mounted` rungs.
 *
 * Its ONLY stylesheet import is `../../src/app.css` — the app's own
 * stylesheet, never `@votetorrent/ui-web/tokens.css` directly. That is
 * deliberate, and it is the whole reason this file's D-23 token probe can
 * catch anything: if this harness imported the tokens itself, it would
 * render correctly even on a build where the app FORGOT its own
 * `@import '@votetorrent/ui-web/tokens.css';` — the probe would then pass on
 * the one failure it exists to catch. Observing the app's own wiring, not
 * re-declaring it, is what makes this harness a genuine test of the app.
 *
 * Mounts every named export of `@votetorrent/ui-web/components` inside a
 * wrapper carrying `data-ui-gate="<ExportName>"`, driving props so each
 * renders non-empty output:
 *   - `AdvisoryDisclosure` receives `variant="authority"` — the dashboard's
 *     own voice (D-07).
 *   - `LifecyclePill` receives the determinate phase `"voting"` — it
 *     returns `null` for a `null` phase, and a rung that accepted an empty
 *     container would be inert. (`"voting"` is 54-02's rename of the retired
 *     mid-election id; this harness was not updated with it, which left the
 *     dashboard workspace typecheck red for two waves — the browser gate
 *     could not see it because Vite's esbuild transform strips types without
 *     checking them. Logged as DEF-54-01, closed here by 54-07.)
 *   - `DetailsToggle` — 53-05's designated hook-calling component — is
 *     mounted in its interactive form. `DetailsToggle`'s own props (summary,
 *     children, defaultOpen) carry no room for an extra DOM attribute on its
 *     internal button, so this harness sets `data-ui-gate-action` on that
 *     button IMPERATIVELY, once, right after mount — the button itself is
 *     never re-rendered by that call, and 53-09's browser gate is left to
 *     read (never set) the state this exposes: this plan only guarantees
 *     the component is genuinely mounted and interactive.
 *
 * After `createRoot(...).render(...)`, a bounded `requestAnimationFrame`
 * poll (never a fixed sleep) waits for the DOM to settle, then builds
 * `mounted` from the `[data-ui-gate]` attribute values ACTUALLY FOUND IN THE
 * DOCUMENT — never from this file's own static render list, so a component
 * that threw during render is reported ABSENT rather than asserted present.
 *
 * 53-09 ADDITION — the D-19 React-identity rung's subject. A SEPARATE
 * `[data-ui-gate="hook-root"]` region is mounted in its OWN React root (a
 * container `appendChild`-ed to `document.body`, never nested under `#root`)
 * so a hook-dispatcher render throw in that region cannot unmount or blank
 * the token-probe/presentational region above — the structural half of the
 * measured 19/19 → 8/12 PARTIAL failure signature (the runner-side half is
 * `run-ui-gates.mjs`'s per-rung `try`/`catch`). It mounts `DetailsToggle` a
 * SECOND time, independent of `DetailsToggleHarness` above (unchanged, still
 * the `shared-components-mounted` rung's subject): its one `.dt-toggle`
 * button is what the identity rung clicks, and its body — rendered only
 * while open — is what makes that click change `[data-ui-gate="hook-root"]`'s
 * own `textContent`, the real state transition the rung asserts rather than
 * a mere mount. `computeReactIdentity()` compares this app's own `react`
 * import against `@votetorrent/ui-web/components`'s `packageReactIdentity()`
 * and is published as `window.__UI_GATE__.identity`.
 *
 * 60-03 ADDITION — the chart colour-mechanism region, `run-ui-gates.mjs`'s
 * `resolved-component-styles` rung's four new entries. Mounts all four chart
 * primitives (`BarSeries`, `StackedBarSeries`, `TimeSeries`, `Meter`), each
 * inside its own `[data-ui-gate="ExportName"]` wrapper, fed a tiny static
 * fixture chosen to exercise every colour selector the runner reads: three
 * statuses (ok/warn/fail, at least one non-zero), two stacked series (both
 * non-zero), three time buckets (one zero-valued, so the interior-zero case
 * is exercised here too), and a meter with a value strictly between zero and
 * a non-null total. Mounted in its OWN React root, on its own container
 * `appendChild`-ed to `document.body` — never nested under `#root` — for the
 * same two reasons the hook-root region above is: a chart render throw must
 * not blank the token-probe/presentational region and take
 * `harness-readout`/`shared-components-mounted` down with it, and it must
 * not prevent `__UI_GATE__` from publishing. Recharts 3.x carries its own
 * `react-redux`/`@reduxjs/toolkit` store and is hook-heavy — mounting it here
 * answers 60-RESEARCH's open question 2 (whether that reproduces this repo's
 * duplicate-React dispatcher defect) with this run's own identity rungs,
 * rather than leaving it untested.
 */
import { StrictMode, useEffect, useRef, useState } from 'react';
import * as AppReact from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/app.css';
import {
	AdvisoryDisclosure,
	LifecyclePill,
	DetailsToggle,
	packageReactIdentity,
	BarSeries,
	StackedBarSeries,
	TimeSeries,
	Meter,
} from '@votetorrent/ui-web/components';

const win = window as unknown as Record<string, unknown>;

/** Frame budget for the settle poll below — generous, still bounded. */
const SETTLE_FRAMES = 60;

/**
 * React 19's client-internals holder property name — the dispatcher holder
 * a real hook call reads through. See
 * `packages/ui-web/src/react-identity.js`'s own header for the measured
 * reason comparing THIS (not the version string, not a namespace-object
 * identity) is the sound measure.
 */
const CLIENT_INTERNALS_KEY = '__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE';

/**
 * `sameUseState`/`sameInternals` are the two SOUND measures; the version
 * string and the namespace-object equality are DECOYS, computed and
 * published only so the runner's run log can show them true even when
 * identity reads false — see `react-identity.js`'s own header for the
 * measured reasons neither may ever gate a verdict.
 */
function computeReactIdentity() {
	const pkg = packageReactIdentity();
	let appInternals: unknown = null;
	try {
		appInternals = (AppReact as unknown as Record<string, unknown>)[CLIENT_INTERNALS_KEY] ?? null;
	} catch {
		appInternals = null;
	}
	return {
		sameUseState: AppReact.useState === pkg.useState,
		sameInternals: appInternals != null && pkg.internals != null && appInternals === pkg.internals,
		versionsMatch: AppReact.version === pkg.version,
		sameNamespace: (AppReact as unknown) === pkg.reactNamespace,
	};
}

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

function DetailsToggleHarness() {
	const wrapperRef = useRef<HTMLDivElement>(null);
	const [mountedOnce, setMountedOnce] = useState(false);

	useEffect(() => {
		if (mountedOnce) return;
		const button = wrapperRef.current?.querySelector<HTMLButtonElement>('button.dt-toggle');
		button?.setAttribute('data-ui-gate-action', 'DetailsToggle-toggle');
		setMountedOnce(true);
	}, [mountedOnce]);

	return (
		<div data-ui-gate="DetailsToggle" ref={wrapperRef}>
			<DetailsToggle summary={<span>ui-gate harness details</span>}>
				<p>Harness body content for the D-19 hook-identity gate.</p>
			</DetailsToggle>
		</div>
	);
}

function UiGateHarness() {
	return (
		<div className="ui-gate-harness">
			<div data-ui-gate="AdvisoryDisclosure">
				<AdvisoryDisclosure variant="authority" />
			</div>
			<div data-ui-gate="LifecyclePill">
				<LifecyclePill phase="voting" />
			</div>
			<DetailsToggleHarness />
		</div>
	);
}

// --- 60-03 chart region fixtures ------------------------------------------
// Production-length-adjacent, real prose fixtures — never a short one that
// could hide a real clipping/zero-bucket defect (60-UI-SPEC's own rule).

const CHART_GATE_BAR_DATA = [
	{ key: 'a', label: 'Active', value: 42, tone: 'ok' as const, tooltip: 'Active: 42 registrant(s)' },
	{ key: 's', label: 'Suspended', value: 7, tone: 'warn' as const, tooltip: 'Suspended: 7 registrant(s)' },
	{ key: 'r', label: 'Revoked', value: 3, tone: 'fail' as const, tooltip: 'Revoked: 3 registrant(s)' },
];

const CHART_GATE_SERIES = [
	{ key: 'registrant', label: 'Registrant', tone: 'series-1' as const },
	{ key: 'bridge', label: 'Bridge', tone: 'series-2' as const },
];

const CHART_GATE_STACKED_DATA = [
	{
		key: 'submitted',
		label: 'Submitted',
		segments: [
			{ seriesKey: 'registrant', value: 12, tooltip: 'Submitted · Registrant: 12 request(s)' },
			{ seriesKey: 'bridge', value: 5, tooltip: 'Submitted · Bridge: 5 request(s)' },
		],
	},
	{
		key: 'approved',
		label: 'Approved',
		segments: [
			{ seriesKey: 'registrant', value: 9, tooltip: 'Approved · Registrant: 9 request(s)' },
			{ seriesKey: 'bridge', value: 2, tooltip: 'Approved · Bridge: 2 request(s)' },
		],
	},
];

const CHART_GATE_TIME_SERIES_DATA = [
	{ key: '2026-09-10', label: '09/10', value: 4, tooltip: '09/10: 4 received' },
	{ key: '2026-09-11', label: '09/11', value: 0, tooltip: '09/11: 0 received' },
	{ key: '2026-09-12', label: '09/12', value: 6, tooltip: '09/12: 6 received' },
];

/**
 * The chart colour-mechanism region (60-03, D-10/D-15). Mounted in ITS OWN
 * root (see this file's header) so a chart render throw cannot unmount or
 * blank the token-probe/presentational region above. A fixed pixel width on
 * the wrapping element makes `ResponsiveContainer`'s percentage width
 * resolve deterministically, independent of the document's own layout.
 */
function ChartGateHarness() {
	return (
		<div className="ui-gate-chart-harness" style={{ width: '600px' }}>
			<div data-ui-gate="BarSeries">
				<BarSeries data={CHART_GATE_BAR_DATA} />
			</div>
			<div data-ui-gate="StackedBarSeries">
				<StackedBarSeries
					data={CHART_GATE_STACKED_DATA}
					series={CHART_GATE_SERIES}
					emptyCopyKey="panels.registrations.requestChart.empty"
				/>
			</div>
			<div data-ui-gate="TimeSeries">
				<TimeSeries data={CHART_GATE_TIME_SERIES_DATA} emptyCopyKey="panels.registrations.intakeChart.empty" />
			</div>
			<div data-ui-gate="Meter">
				<Meter value={3} total={5} valueLabel="3 of 5" variant="panel" emptyCopyKey="panels.keyholders.meter.empty" />
			</div>
		</div>
	);
}

/**
 * The hook-root region (53-09, D-19) — mounted in ITS OWN root, separate
 * from `UiGateHarness`'s (see this file's header). Renders `DetailsToggle`
 * a second time: its single `.dt-toggle` button is the "exactly one button"
 * the identity rung clicks, and its body — rendered only while open — is
 * what makes that click change `[data-ui-gate="hook-root"]`'s own
 * `textContent`.
 */
function HookRootHarness() {
	return (
		<div data-ui-gate="hook-root">
			<DetailsToggle summary={<span>hook-root toggle</span>}>
				<p>hook-root body content for the D-19 identity gate&apos;s click assertion.</p>
			</DetailsToggle>
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
					<UiGateHarness />
				</StrictMode>,
			);
		} catch (err) {
			renderError = String((err as { message?: unknown })?.message ?? err);
		}
	} else {
		renderError = 'ui-gate.html is missing #root';
	}

	// The hook-root region's own SEPARATE root and container — appended to
	// document.body, never nested under #root, so a render throw here cannot
	// unmount or blank the region above (this file's header). A throw here
	// is deliberately swallowed: identity:hook-mounted reads the DOM
	// directly and reports this region ABSENT rather than asserting it
	// present, and the readout below must still publish either way.
	const hookRootContainer = document.createElement('div');
	document.body.appendChild(hookRootContainer);
	try {
		createRoot(hookRootContainer).render(
			<StrictMode>
				<HookRootHarness />
			</StrictMode>,
		);
	} catch {
		// intentionally swallowed — see comment above.
	}

	// The chart region's own SEPARATE root and container (60-03) — appended to
	// document.body, never nested under #root, mirroring the hook-root
	// region's own discipline immediately above. A throw here is deliberately
	// swallowed for the same reason: the readout below must still publish
	// either way, and shared-components-mounted must not go down with it.
	const chartRegionContainer = document.createElement('div');
	document.body.appendChild(chartRegionContainer);
	try {
		createRoot(chartRegionContainer).render(
			<StrictMode>
				<ChartGateHarness />
			</StrictMode>,
		);
	} catch {
		// intentionally swallowed — see comment above.
	}

	await settle(SETTLE_FRAMES);

	const mounted = [...document.querySelectorAll('[data-ui-gate]')]
		.map((el) => el.getAttribute('data-ui-gate'))
		.filter((name): name is string => name != null);

	const detailsButton = document.querySelector<HTMLButtonElement>('[data-ui-gate="DetailsToggle"] button.dt-toggle');

	win.__UI_GATE__ = Object.freeze({
		mounted,
		hook: {
			component: 'DetailsToggle',
			initial: detailsButton?.getAttribute('aria-expanded') === 'true',
		},
		identity: computeReactIdentity(),
		error: renderError,
	});
	win.__UI_GATE_DONE__ = true;
}

main();
