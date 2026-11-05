/**
 * chart-frame.tsx — the internal scaffolding every chart primitive in this
 * directory shares (60-03): the D-21 empty-frame branch, the shared
 * tooltip/legend `content` renderers (so Recharts' own tooltip/legend DOM
 * never renders inside a panel body — D-11/D-12), and the one hook in this
 * directory, `useContainerWidth`, which resolves 60-UI-SPEC's tick-density
 * rule (at most 6 ticks at or above 400px, at most 4 below it).
 *
 * NOT exported from `../components.js` — the barrel re-exports only the
 * four public primitives (`BarSeries`, `StackedBarSeries`, `TimeSeries`,
 * `Meter`); this module is their shared internal.
 *
 * `ChartTooltip`/`ChartLegend` render only the caller-supplied `label` /
 * `tooltip` strings a hovered payload already carries (in `--muted`/`--text`,
 * never the series hue — "text never wears the data colour") — this file
 * authors no English of its own either.
 *
 * `ChartTooltip` maps EVERY payload entry to its own resolved tooltip text —
 * no entry is ever chosen by array position (60-12, closing 60-UAT test 14 /
 * 60-REVIEW WR-01). `payload[payload.length - 1]` reported a FIXED series
 * regardless of which stacked segment the pointer was over; this file has
 * now shipped that defect once and does not repeat the pattern. Each
 * resolved entry renders its own `.vt-chart__tooltip-value` line and NO
 * `.vt-chart__tooltip-label` span: all four copy templates in `copy.js`
 * already OPEN with that same category label, so rendering it a second time
 * is the verbatim duplication the UAT observed on C7. The label span
 * survives only as the no-template fallback, so a caller that supplies no
 * tooltip string still gets a non-empty box.
 *
 * `ChartLegend`'s swatch hue comes from the payload entry's OWN matched
 * `ChartSeries.tone`, never from its position in Recharts' legend payload
 * array — that payload's order is Recharts' own `itemSorter` (default
 * alphabetical-by-label), not declaration order (60-11).
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ResponsiveContainer } from 'recharts';
import { t } from '../copy.js';
import { NARROW_CONTAINER_PX, TICKS_NARROW, TICKS_WIDE } from './chart-contracts.js';
import type { ChartSeries, ChartTone, StackedSegment } from './chart-contracts.js';

/**
 * Only `series-1`/`series-2` carry a swatch rule (`components.css`) — `ok`/
 * `warn`/`fail` are single-hue status marks, never legend-bearing, so
 * inventing a swatch class for them here is out of scope.
 *
 * That was always the intent; it is now ENFORCED, in two ways. The map used to
 * be `Partial<Record<ChartTone, string>>`, which meant a series toned `warn`
 * type-checked, found no class, and rendered a bare `.vt-chart__legend-swatch`
 * — a generic grey `var(--muted)` (measured: `rgb(141, 151, 168)`). That reads
 * as "this swatch has no data behind it" rather than as the contract violation
 * it is, and it is strictly harder to catch in review than the mis-colour
 * 60-11 fixed, because nothing looks wrong. Keying the map on `LegendTone`
 * makes it TOTAL, so adding a legend-bearing tone without a swatch rule is a
 * compile error rather than a silent grey square.
 */
export type LegendTone = Extract<ChartTone, 'series-1' | 'series-2'>;

const LEGEND_SWATCH_CLASS_BY_TONE: Readonly<Record<LegendTone, string>> = Object.freeze({
	'series-1': 'vt-chart__legend-swatch--series-1',
	'series-2': 'vt-chart__legend-swatch--series-2',
});

function isLegendTone(tone: ChartTone): tone is LegendTone {
	return tone === 'series-1' || tone === 'series-2';
}

export interface ChartFrameProps {
	variantClassName: string;
	height: number;
	isEmpty: boolean;
	emptyCopyKey?: string;
	children: ReactNode;
	/**
	 * 60-07's D-24 geometry gate found (and `Meter.tsx`'s own header already
	 * states the reason): `ResponsiveContainer` measures its OUTER container
	 * via `ResizeObserver` and then re-injects that measured pixel width onto
	 * an SVG CHART child it recognises (`<BarChart>`/`<LineChart>`, which use
	 * the `width`/`height` PROPS it clones in to render their own internal
	 * wrapper with an explicit `style="width:Npx"`). A plain `<div>` child —
	 * Meter's whole shape — has no such internal wiring: React renders
	 * `width`/`height` as literal (invalid, inert) HTML attributes instead of
	 * a CSS style, so the div's own `width` stays `auto`, computed against
	 * `ResponsiveContainer`'s own permanently-0px internal sizing div. The
	 * result: `getBoundingClientRect()` on the meter's fill/track measures
	 * ZERO width in every real render, not only in a gate — this was
	 * undetected before this plan because no prior tier measured geometry.
	 * `false` skips `ResponsiveContainer` for a plain-DOM child, which then
	 * inherits real width from THIS component's own `width: 100%` rule
	 * (`components.css`'s `.vt-chart--meter` rule) against its REAL ancestor
	 * instead. Every SVG-chart caller keeps the default `true`.
	 */
	useResponsiveContainer?: boolean;
}

/**
 * D-21: an empty chart renders its own frame plus explicit copy, never a
 * blank region — an officer must be able to tell an empty chart from a
 * broken one.
 */
export function ChartFrame({ variantClassName, height, isEmpty, emptyCopyKey, children, useResponsiveContainer = true }: ChartFrameProps) {
	const rootClassName = ['vt-chart', variantClassName].join(' ');
	return (
		<div className={rootClassName}>
			{isEmpty ? (
				<div className="vt-chart__empty-frame" style={{ height }}>
					{emptyCopyKey ? <p className="vt-chart__empty">{t(emptyCopyKey)}</p> : null}
				</div>
			) : useResponsiveContainer ? (
				<ResponsiveContainer width="100%" height={height}>
					{children}
				</ResponsiveContainer>
			) : (
				children
			)}
		</div>
	);
}

/** `dataKey` mirrors Recharts' own `DataKey<any>` union (string | number | accessor function) — widened here only so this content renderer accepts whatever shape Recharts hands it, never narrowed back down by this file. */
interface ChartTooltipPayloadEntry {
	dataKey?: string | number | ((obj: any) => unknown);
	payload?: {
		label?: string;
		tooltip?: string;
		segments?: ReadonlyArray<StackedSegment>;
	};
}

export interface ChartTooltipProps {
	active?: boolean;
	label?: string | number;
	payload?: ReadonlyArray<ChartTooltipPayloadEntry>;
}

/**
 * The shared `content` renderer for every `<Tooltip>` in this directory.
 * Supplying `content` is deliberate and load-bearing twice: it keeps
 * tooltip text off the series hue, and it means Recharts' own default
 * tooltip DOM never renders inside a panel body (D-11/D-12).
 */
export function ChartTooltip(props: ChartTooltipProps) {
	const { active, payload, label } = props;
	if (!active || !payload || payload.length === 0) return null;
	const resolvedTexts = payload
		.map((entry) => {
			const datum = entry?.payload;
			const segmentTooltip = datum?.segments?.find((segment) => segment.seriesKey === entry?.dataKey)?.tooltip;
			return segmentTooltip ?? datum?.tooltip ?? '';
		})
		.filter((text) => text !== '');
	if (resolvedTexts.length > 0) {
		return (
			<div className="vt-chart__tooltip">
				{resolvedTexts.map((text, index) => (
					<span className="vt-chart__tooltip-value" key={index}>
						{text}
					</span>
				))}
			</div>
		);
	}
	const labelText = payload[0]?.payload?.label ?? label ?? '';
	return (
		<div className="vt-chart__tooltip">
			<span className="vt-chart__tooltip-label">{labelText}</span>
		</div>
	);
}

export interface ChartLegendProps {
	series: ReadonlyArray<ChartSeries>;
	payload?: ReadonlyArray<{ value?: string; dataKey?: string | number | ((obj: any) => unknown) }>;
}

/**
 * The shared `content` renderer for every `<Legend>` in this directory
 * (StackedBarSeries only, today). No clickable element and no navigation
 * target, no handler — the swatch is a styled `<span>`, so no legend-
 * filtering affordance exists (D-11).
 *
 * Each payload entry resolves its OWN swatch hue from its own `ChartSeries`
 * (matched by `dataKey`, falling back to the series `label`), never from its
 * position in `payload` — Recharts' `Legend.itemSorter` defaults to `'value'`
 * (alphabetical by label), so payload order is not declaration order and an
 * index-derived colour would silently mispair a swatch with the wrong
 * series (60-11, closing 60-UAT test 3 / 60-REVIEW WR-02).
 */
export function ChartLegend(props: ChartLegendProps) {
	const { series, payload } = props;
	const items = payload ?? [];
	return (
		<ul className="vt-chart__legend">
			{items.map((item, index) => {
				const matchedSeries =
					typeof item.dataKey === 'string' ? series.find((s) => s.key === item.dataKey) : series.find((s) => s.label === item.value);
				// Both misses below used to fall through to a bare swatch class,
				// i.e. a silent grey square. They now throw, matching this
				// package's own fail-loud discipline (`copy.js`'s `t()` throws on
				// an unknown key rather than rendering a blank) and `ChartFrame`'s
				// D-21 rule that a broken chart must never be mistakable for an
				// empty one.
				if (!matchedSeries) {
					throw new Error(
						`ChartLegend: no ChartSeries matches legend entry ${JSON.stringify(String(item.dataKey ?? item.value ?? ''))} — ` +
							`the \`series\` prop and the chart's own dataKeys disagree. Declared series: ${series.map((s) => s.key).join(', ') || '(none)'}.`,
					);
				}
				if (!isLegendTone(matchedSeries.tone)) {
					throw new Error(
						`ChartLegend: series ${JSON.stringify(matchedSeries.key)} carries tone ${JSON.stringify(matchedSeries.tone)}, which has no legend swatch rule. ` +
							`Legend-bearing series must be toned 'series-1' or 'series-2'; 'ok'/'warn'/'fail' are single-hue status marks.`,
					);
				}
				const swatchClassName = ['vt-chart__legend-swatch', LEGEND_SWATCH_CLASS_BY_TONE[matchedSeries.tone]].join(' ');
				return (
					<li className="vt-chart__legend-item" key={String(item.dataKey ?? item.value ?? index)}>
						<span className={swatchClassName} />
						<span className="vt-chart__legend-label">{item.value}</span>
					</li>
				);
			})}
		</ul>
	);
}

/**
 * `tickCountFor` — 60-UI-SPEC's hard narrow-viewport constraint: at most 6
 * ticks at or above 400px, at most 4 below it.
 */
export function tickCountFor(width: number): number {
	return width < NARROW_CONTAINER_PX ? TICKS_NARROW : TICKS_WIDE;
}

/**
 * The one hook in this directory. Reports the wrapper element's own px
 * width via a `ResizeObserver`, disconnecting on cleanup. Falls back to the
 * wide branch (the default state below is already `>= NARROW_CONTAINER_PX`)
 * when `ResizeObserver` is unavailable.
 */
export function useContainerWidth() {
	const ref = useRef<HTMLDivElement | null>(null);
	const [width, setWidth] = useState(NARROW_CONTAINER_PX);

	useEffect(() => {
		const el = ref.current;
		if (el == null) return undefined;
		if (typeof ResizeObserver === 'undefined') {
			setWidth(el.getBoundingClientRect().width || NARROW_CONTAINER_PX);
			return undefined;
		}
		const observer = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (entry) setWidth(entry.contentRect.width);
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	return { ref, width };
}
