/**
 * StackedBarSeries.tsx — C2 (registration request breakdown): status on the
 * axis, `IssuerType` as the two stacked segments. Colour therefore encodes
 * issuer via each series' own declared `tone`, never via array position
 * (D-03) — two hues, a genuine 2-slot categorical (60-11 closed the latent
 * mis-colour a reordered `series` array would have produced, 60-REVIEW
 * WR-02).
 *
 * The 2px `stroke`/`strokeWidth` on each segment is 60-UI-SPEC's mandated
 * surface-coloured separator between touching segments — explicitly not a
 * border drawn around a mark.
 *
 * `<Tooltip shared={false}>` (60-12, closing 60-UAT test 14 / 60-REVIEW
 * WR-01): Recharts' `BarChart` defaults to an AXIS-scoped tooltip, which
 * hands `ChartTooltip` every series stacked at the hovered category
 * regardless of which segment the pointer is over. `shared={false}` switches
 * this chart to an ITEM-scoped tooltip so the payload carries only the
 * hovered segment — the (a) option the WR-01 todo named, and the one the
 * UI-SPEC's C2 wording ("{status name} · {issuer name}: …", a single issuer)
 * already commits the product to. This is what makes `ChartTooltip`'s
 * per-segment `segmentTooltip` lookup meaningful: without it, an item-scoped
 * lookup would still only ever see the one series Recharts chose to report.
 * `BarSeries.tsx` and `TimeSeries.tsx` are both single-series and are left on
 * the default axis scope; `TimeSeries`'s D-11 crosshair depends on that
 * axis-scoped `cursor`.
 */
import { Bar, BarChart, CartesianGrid, Legend, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartFrame, ChartLegend, ChartTooltip, tickCountFor, useContainerWidth } from './chart-frame.js';
import {
	CHART_SERIES_1,
	CHART_SERIES_2,
	DATA_END_RADIUS_PX,
	MAX_BAR_THICKNESS_PX,
	SEGMENT_GAP_PX,
	STACKED_BAR_HEIGHT_PX,
	SURFACE_GAP,
	zeroSafeDataMax,
} from './chart-contracts.js';
import type { ChartSeries, ChartTone, StackedDatum } from './chart-contracts.js';

const SEGMENT_CLASS_BY_TONE: Readonly<Partial<Record<ChartTone, string>>> = Object.freeze({
	'series-1': 'vt-chart__segment--series-1',
	'series-2': 'vt-chart__segment--series-2',
});

const SEGMENT_FILL_BY_TONE: Readonly<Partial<Record<ChartTone, string>>> = Object.freeze({
	'series-1': CHART_SERIES_1,
	'series-2': CHART_SERIES_2,
});

export interface StackedBarSeriesProps {
	data: StackedDatum[];
	series: ChartSeries[];
	height?: number;
	emptyCopyKey: string;
}

export function StackedBarSeries({ data, series, height = STACKED_BAR_HEIGHT_PX, emptyCopyKey }: StackedBarSeriesProps) {
	const isEmpty = data.length === 0;
	const chartData = data.map((datum) => {
		const row: Record<string, unknown> = { key: datum.key, label: datum.label, segments: datum.segments };
		for (const segment of datum.segments) {
			row[segment.seriesKey] = segment.value;
		}
		return row;
	});
	// The NUMERIC axis honours the same narrow-container tick bound
	// `TimeSeries` does. Left unwired, Recharts' own default heuristic lands
	// on 5 ticks at any width, which overruns the bound below 400px.
	const { ref, width } = useContainerWidth();

	return (
		<div ref={ref}>
			<ChartFrame variantClassName="vt-chart--stacked-bar" height={height} isEmpty={isEmpty} emptyCopyKey={emptyCopyKey}>
				<BarChart data={chartData} margin={{ top: 24, right: 8, bottom: 8, left: 8 }}>
					<CartesianGrid className="vt-chart__grid" vertical={false} />
					<XAxis type="category" dataKey="label" tick={{ className: 'vt-chart__axis' }} axisLine={{ className: 'vt-chart__grid' }} tickLine={false} />
					<YAxis
						type="number"
						// This axis counts people: Recharts subdivides below 1 whenever
						// the data maximum is small (60-13, closing 60-UAT test 11 --
						// the public roll chart showed "0.7 registrants" as a gridline
						// label). `domain` pins the upper bound to the real data
						// maximum too -- Recharts' "nice tick" algorithm still rounds
						// an auto domain UP to the next whole number even with
						// allowDecimals off.
						// `zeroSafeDataMax` floors that upper bound at 1, so an
						// all-zero dataset cannot collapse the scale to a
						// degenerate [0, 0] -- see its docblock for the measured
						// symptoms that floor prevents.
						domain={[0, zeroSafeDataMax]}
						allowDecimals={false}
						tick={{ className: 'vt-chart__axis' }}
						axisLine={{ className: 'vt-chart__grid' }}
						tickLine={false}
						tickCount={tickCountFor(width)}
					/>
					<Tooltip cursor={false} content={ChartTooltip} shared={false} />
					{/* Two or more series always carry a legend — rendered unconditionally. The element form (rather than the component form) is deliberate: Recharts CLONES this element with its own `payload` prop while preserving the author-supplied `series` prop, so ChartLegend can resolve each swatch from its own series rather than from payload position. */}
					<Legend content={<ChartLegend series={series} />} />
					{series.map((s) => {
						const segmentClassName = SEGMENT_CLASS_BY_TONE[s.tone];
						const segmentFill = SEGMENT_FILL_BY_TONE[s.tone];
						return (
							<Bar
								key={s.key}
								dataKey={s.key}
								name={s.label}
								stackId="requests"
								className={segmentClassName}
								fill={segmentFill}
								stroke={SURFACE_GAP}
								strokeWidth={SEGMENT_GAP_PX}
								maxBarSize={MAX_BAR_THICKNESS_PX}
								radius={[DATA_END_RADIUS_PX, DATA_END_RADIUS_PX, 0, 0]}
								isAnimationActive={false}
							/>
						);
					})}
				</BarChart>
			</ChartFrame>
		</div>
	);
}

export default StackedBarSeries;
