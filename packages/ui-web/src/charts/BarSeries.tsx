/**
 * BarSeries.tsx — C1 (Registrant status breakdown: one vertical bar per
 * status, always three, mandatory direct labels per D-16) and the
 * horizontal single-hue form 60-06's C7 (public roll composition by
 * district) needs.
 *
 * D-16 is implemented structurally, not by hoping a label fits: the status
 * name rides the category axis tick and the count rides a `<LabelList>`
 * positioned OUTSIDE the bar's data end, so neither label can ever be
 * clipped by a mark and no rule anywhere hides content that spills past one.
 */
import { Bar, BarChart, CartesianGrid, Cell, LabelList, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartFrame, ChartTooltip, tickCountFor, useContainerWidth } from './chart-frame.js';
import {
	BAR_SERIES_HEIGHT_PX,
	CHART_SERIES_1,
	CHART_SERIES_2,
	DATA_END_RADIUS_PX,
	MAX_BAR_THICKNESS_PX,
	TONE_FAIL,
	TONE_OK,
	TONE_WARN,
	zeroSafeDataMax,
} from './chart-contracts.js';
import type { ChartDatum, ChartTone } from './chart-contracts.js';

const BAR_CLASS_BY_TONE: Readonly<Record<ChartTone, string>> = Object.freeze({
	'series-1': 'vt-chart__bar--series-1',
	'series-2': 'vt-chart__bar--series-2',
	ok: 'vt-chart__bar--ok',
	warn: 'vt-chart__bar--warn',
	fail: 'vt-chart__bar--fail',
});

const BAR_FILL_BY_TONE: Readonly<Record<ChartTone, string>> = Object.freeze({
	'series-1': CHART_SERIES_1,
	'series-2': CHART_SERIES_2,
	ok: TONE_OK,
	warn: TONE_WARN,
	fail: TONE_FAIL,
});

export interface BarSeriesProps {
	data: ChartDatum[];
	orientation?: 'vertical' | 'horizontal';
	height?: number;
	defaultTone?: ChartTone;
	showValueLabels?: boolean;
	categoryAxisWidth?: number;
	emptyCopyKey?: string;
}

export function BarSeries({
	data,
	orientation = 'vertical',
	height = BAR_SERIES_HEIGHT_PX,
	defaultTone = 'series-1',
	showValueLabels = true,
	categoryAxisWidth,
	emptyCopyKey,
}: BarSeriesProps) {
	// For C1 the caller always passes all three statuses, including zeroes —
	// a zero-height bar is the correct state, not an empty one — so this
	// branch exists only for a caller that genuinely has no rows at all.
	// `ChartFrame` itself renders the frame with no copy when no key is given.
	const isEmpty = data.length === 0;
	const isHorizontal = orientation === 'horizontal';
	const margin = isHorizontal ? { top: 8, right: 48, bottom: 8, left: 8 } : { top: 24, right: 8, bottom: 8, left: 8 };
	// The NUMERIC axis honours the same narrow-container tick bound
	// `TimeSeries` does. Left unwired, Recharts' own default heuristic lands
	// on 5 ticks at any width, which overruns the bound below 400px.
	const { ref, width } = useContainerWidth();

	return (
		<div ref={ref}>
			<ChartFrame variantClassName="vt-chart--bar" height={height} isEmpty={isEmpty} emptyCopyKey={emptyCopyKey}>
				{/* Recharts' `layout` names the CATEGORY axis: the horizontal-bar form is layout="vertical" with the numeric axis on X. */}
				<BarChart data={data} layout={isHorizontal ? 'vertical' : 'horizontal'} margin={margin}>
					<CartesianGrid className="vt-chart__grid" vertical={false} />
					{isHorizontal ? (
						<>
							<XAxis
								type="number"
								// This axis counts people: Recharts subdivides below 1
								// whenever the data maximum is small (60-13, closing
								// 60-UAT test 11 -- the public roll chart showed "0.7
								// registrants" as a gridline label). `domain` is pinned
								// to the real data maximum too: `allowDecimals` alone
								// stops the FRACTIONAL overshoot, but Recharts' own
								// "nice tick" algorithm still rounds an auto domain UP
								// to the next whole number (a max-2 fixture measured a
								// tick of 3) -- the same "runs past the real maximum"
								// defect the UAT reported, by a different mechanism.
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
							<YAxis
								type="category"
								dataKey="label"
								width={categoryAxisWidth}
								// Every category gets its tick. Recharts' default collision
								// heuristic silently DROPS a tick's text node entirely when
								// rows are tight -- a horizontal bar whose own name has
								// vanished reads as a missing category, not a cramped one.
								// Forcing all ticks turns that silent omission into visible
								// overlap, which a geometry rung can actually see.
								//
								// NOT load-bearing for the C7 rung as it stands: measured
								// inert once the caller reserves enough per-row height, and
								// that height fix alone turns the rung green. It guards the
								// case the current fixture does not reach -- a caller whose
								// row count exceeds its own height cap, where per-row space
								// compresses again and the drop returns. Kept deliberately,
								// with that limit stated rather than assumed away.
								interval={0}
								tick={{ className: 'vt-chart__axis' }}
								axisLine={{ className: 'vt-chart__grid' }}
								tickLine={false}
							/>
						</>
					) : (
						<>
							<XAxis type="category" dataKey="label" tick={{ className: 'vt-chart__axis' }} axisLine={{ className: 'vt-chart__grid' }} tickLine={false} />
							<YAxis
								type="number"
								// This axis counts people: Recharts subdivides below 1
								// whenever the data maximum is small (60-13, closing
								// 60-UAT test 11 -- the public roll chart showed "0.7
								// registrants" as a gridline label). `domain` pins the
								// upper bound to the real data maximum too -- Recharts'
								// "nice tick" algorithm still rounds an auto domain UP
								// to the next whole number even with allowDecimals off.
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
						</>
					)}
					<Tooltip cursor={false} content={ChartTooltip} />
					<Bar
						dataKey="value"
						className="vt-chart__bar"
						maxBarSize={MAX_BAR_THICKNESS_PX}
						radius={[DATA_END_RADIUS_PX, DATA_END_RADIUS_PX, 0, 0]}
						isAnimationActive={false}
					>
						{data.map((datum) => {
							const tone = datum.tone ?? defaultTone;
							return <Cell key={datum.key} className={BAR_CLASS_BY_TONE[tone]} fill={BAR_FILL_BY_TONE[tone]} />;
						})}
						{showValueLabels ? <LabelList dataKey="value" position={isHorizontal ? 'right' : 'top'} className="vt-chart__label" /> : null}
					</Bar>
				</BarChart>
			</ChartFrame>
		</div>
	);
}

export default BarSeries;
