#!/usr/bin/env node
/**
 * component-class-names.js — the single enumerated list of every class name
 * a shared `@votetorrent/ui-web` component can render, keyed by the export
 * name each consumer's harness (and any tier-1 CSS class-name coverage
 * checker) mounts.
 *
 * Manually maintained rather than parsed out of each component's own `.tsx`
 * source, because `LifecyclePill`'s phase modifier is constructed at runtime
 * (`` `lifecycle-pill--${phase}` ``, `LifecyclePill.tsx`) from a TypeScript
 * union type, not a literal string a regex could safely enumerate without
 * either missing a modifier or hallucinating one. Phase 54 (D-06/D-10) widens
 * that union to five values, `pre`/`voting`/`settling`/`closed` (the renamed
 * `PHASE_IDS`) plus `indeterminate` -- a non-`PHASE_IDS` fifth value the union
 * carries for D-10's explicit unknown-phase pill. `AdvisoryDisclosure` and
 * `DetailsToggle` render only literal class names, so those two entries
 * ARE mechanically checkable — see `test/component-class-names.test.mjs` for
 * the positive-control proof that every entry below agrees with what its own
 * component source can literally produce.
 *
 * This module is tooling, not public API: it is deliberately NOT in this
 * package's `exports` map. `scripts/lib/css-class-coverage.mjs` (CR-01, the
 * repo's tier-1 dependency-free CSS-coverage check) reads it via a direct
 * `file://` import of this file's own path — never through the
 * `@votetorrent/ui-web` package specifier, so Node's `exports` encapsulation
 * never applies to it.
 *
 * `.dt-toggle` and `.dt-body` are included here (they are, after all, class
 * names `DetailsToggle` renders) even though CR-01 found no styling gap for
 * them in either current consumer — both apps already authored those two
 * rules independently in their own `app.css`. Omitting them here would make
 * the coverage check silently blind to a FUTURE regression (an app that
 * removes its own `.dt-toggle`/`.dt-body` rule while still mounting
 * `DetailsToggle`), which is exactly the class of gap this checker exists to
 * close.
 *
 * 60-03 adds four chart primitives, each under `./charts/` rather than
 * `./components/`. Every chart entry below carries a shared set of names —
 * `vt-chart`, the two `vt-chart__empty*` names, `vt-chart__axis`,
 * `vt-chart__grid` and the tooltip trio (`vt-chart__tooltip`,
 * `vt-chart__tooltip-label`, `vt-chart__tooltip-value`) — that are actually
 * rendered by `chart-frame.tsx` on each primitive's behalf, not by the
 * primitive's own file; they are listed under every export that mounts one,
 * mirroring how `charts-contract.test.mjs`'s lockstep rung reads the two
 * files' comment-stripped sources CONCATENATED, not separately.
 *
 * @type {Readonly<Record<string, ReadonlyArray<string>>>}
 */
export const COMPONENT_CLASS_NAMES = Object.freeze({
	AdvisoryDisclosure: Object.freeze(['pv-disclosure']),
	LifecyclePill: Object.freeze([
		'lifecycle-pill',
		'lifecycle-pill--pre',
		'lifecycle-pill--voting',
		'lifecycle-pill--settling',
		'lifecycle-pill--closed',
		'lifecycle-pill--indeterminate',
	]),
	DetailsToggle: Object.freeze(['dt-toggle-group', 'dt-toggle', 'dt-body']),
	BarSeries: Object.freeze([
		'vt-chart',
		'vt-chart--bar',
		'vt-chart__empty-frame',
		'vt-chart__empty',
		'vt-chart__axis',
		'vt-chart__grid',
		'vt-chart__label',
		'vt-chart__bar',
		'vt-chart__bar--series-1',
		'vt-chart__bar--series-2',
		'vt-chart__bar--ok',
		'vt-chart__bar--warn',
		'vt-chart__bar--fail',
		'vt-chart__tooltip',
		'vt-chart__tooltip-label',
		'vt-chart__tooltip-value',
	]),
	StackedBarSeries: Object.freeze([
		'vt-chart',
		'vt-chart--stacked-bar',
		'vt-chart__empty-frame',
		'vt-chart__empty',
		'vt-chart__axis',
		'vt-chart__grid',
		'vt-chart__segment--series-1',
		'vt-chart__segment--series-2',
		'vt-chart__legend',
		'vt-chart__legend-item',
		'vt-chart__legend-swatch',
		'vt-chart__legend-swatch--series-1',
		'vt-chart__legend-swatch--series-2',
		'vt-chart__legend-label',
		'vt-chart__tooltip',
		'vt-chart__tooltip-label',
		'vt-chart__tooltip-value',
	]),
	TimeSeries: Object.freeze([
		'vt-chart',
		'vt-chart--time-series',
		'vt-chart__empty-frame',
		'vt-chart__empty',
		'vt-chart__axis',
		'vt-chart__grid',
		'vt-chart__line',
		'vt-chart__dot',
		'vt-chart__crosshair',
		'vt-chart__tooltip',
		'vt-chart__tooltip-label',
		'vt-chart__tooltip-value',
	]),
	Meter: Object.freeze([
		'vt-chart',
		'vt-chart--meter',
		'vt-chart__empty-frame',
		'vt-chart__empty',
		'vt-chart__meter',
		'vt-chart__meter--panel',
		'vt-chart__meter--compact',
		'vt-chart__meter-track',
		'vt-chart__meter-fill',
		'vt-chart__meter-value',
	]),
});
