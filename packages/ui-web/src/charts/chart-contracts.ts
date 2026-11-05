/**
 * chart-contracts.ts — types, colour strings and the hard-coded geometry
 * constants every chart primitive in this directory shares (60-03).
 *
 * No JSX, no React import: this file is the frozen contract wave 3/4
 * consumers build against, not a component.
 *
 * The colour strings below are the SECONDARY colour path described in
 * 60-03-PLAN.md's objective — the `var(--…)` string handed to a Recharts
 * colour prop, which resolves if Recharts forwards it verbatim. The PRIMARY
 * path is a class name on every mark with its rule declared in
 * `components.css` (D-15) — that path wins even when Recharts substitutes
 * its own default fill, so the mechanism survives either behaviour. No hex
 * literal appears anywhere in this file or any sibling under this directory.
 *
 * The geometry constants are hard-coded here and never read from a spacing
 * token, per 60-UI-SPEC's own "Spacing Scale" exceptions list — a bar cap,
 * a stroke width, a surface gap and the two meter heights are mark geometry,
 * not layout spacing.
 */

export const MAX_BAR_THICKNESS_PX = 24;
export const DATA_END_RADIUS_PX = 4;
export const LINE_STROKE_WIDTH_PX = 2;
export const END_DOT_RADIUS_PX = 4;
export const SEGMENT_GAP_PX = 2;
export const GRID_STROKE_WIDTH_PX = 1;
export const BAR_SERIES_HEIGHT_PX = 160;
export const STACKED_BAR_HEIGHT_PX = 180;
export const TIME_SERIES_HEIGHT_PX = 140;
export const METER_HEIGHT_PX = 32;
export const METER_COMPACT_HEIGHT_PX = 20;
export const NARROW_CONTAINER_PX = 400;
export const TICKS_WIDE = 6;
export const TICKS_NARROW = 4;

/** The secondary colour path (see this file's header) — every value is a `var(--…)` reference, never a hex literal. */
export const CHART_SERIES_1 = 'var(--chart-series-1)';
export const CHART_SERIES_2 = 'var(--chart-series-2)';
export const TONE_OK = 'var(--ok)';
export const TONE_WARN = 'var(--warn)';
export const TONE_FAIL = 'var(--fail)';
export const AXIS_TEXT = 'var(--muted)';
export const GRID_LINE = 'var(--border)';
export const SURFACE_GAP = 'var(--surface)';

/**
 * Every chart datum carries its own already-formatted strings. The
 * primitives in this directory author zero English of their own — exactly
 * as `DetailsToggle` does — so they add zero copy keys beyond the
 * `emptyCopyKey` each resolves through `t()`.
 */
export type ChartTone = 'series-1' | 'series-2' | 'ok' | 'warn' | 'fail';

/**
 * Upper bound for every count axis, and the reason none of them pass
 * `'dataMax'` directly any more.
 *
 * 60-13 pinned `domain={[0, 'dataMax']}` so Recharts' own "nice tick"
 * algorithm could not round an axis up past the real data maximum. That is
 * still right for every non-zero dataset — but when EVERY value is 0 the pin
 * collapses the scale to a degenerate `[0, 0]`. Measured on the real build
 * (`test/browser/gap-probe.tsx`): `BarSeries` and `StackedBarSeries` then emit
 * NO bar rectangles at all, and `TimeSeries` draws its line across the plot
 * area's vertical MIDPOINT — which reads as a genuine mid-range constant, not
 * as zero. Neither is caught by the `data.length === 0` empty guard, because
 * all-zero rows are not an empty array, so the D-21 empty frame never shows
 * either. Silent, and reachable by any freshly-opened election.
 *
 * Flooring the upper bound at 1 keeps an all-zero dataset on a real 0..1
 * scale: marks render at the baseline (a zero-height bar is the correct state
 * for C1 — see `BarSeries.tsx`'s own header), and with `allowDecimals={false}`
 * the ticks read `0`/`1`, never a fraction. Non-zero data is untouched, so
 * 60-13's over-maximum fix still holds exactly as measured.
 */
export function zeroSafeDataMax(dataMax: number): number {
	return dataMax > 0 ? dataMax : 1;
}

export interface ChartDatum {
	key: string;
	label: string;
	value: number;
	tone?: ChartTone;
	tooltip?: string;
}

export interface StackedSegment {
	seriesKey: string;
	value: number;
	tooltip?: string;
}

export interface StackedDatum {
	key: string;
	label: string;
	segments: StackedSegment[];
}

export interface ChartSeries {
	key: string;
	label: string;
	tone: ChartTone;
}
