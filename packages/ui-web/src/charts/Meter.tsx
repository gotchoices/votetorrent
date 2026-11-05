/**
 * Meter.tsx — C5 (Keyholders: enrolled vs. threshold) and C6 (public
 * key-release progress). Deliberately NOT a Recharts chart: a fill-and-track
 * meter is two boxes, and a plain DOM meter gives 60-07/60-08's
 * `getBoundingClientRect` fill-width/track-width ratio proof exactly what it
 * needs without instantiating a chart library's internal store for a shape
 * that has no axis.
 *
 * The fill's inline `width` is the one inline style this directory permits —
 * a clamped 0–100 percentage of `value / total` — because it is data-driven
 * geometry no class can express; it carries no colour.
 *
 * `useResponsiveContainer={false}` (60-07, found while building the first
 * geometry gate this project has ever had): `ChartFrame`'s shared
 * `ResponsiveContainer` wrapper never re-injects a measured pixel width onto
 * a plain-DOM child the way it does for an SVG chart child, so without this
 * flag every meter measures ZERO width in `getBoundingClientRect()` — a
 * real, previously-undetected rendering defect, not a gate artefact. See
 * `chart-frame.tsx`'s own `useResponsiveContainer` doc for the full
 * mechanism.
 */
import { ChartFrame } from './chart-frame.js';
import { METER_COMPACT_HEIGHT_PX, METER_HEIGHT_PX } from './chart-contracts.js';

export interface MeterProps {
	value: number;
	total: number | null;
	valueLabel?: string;
	variant?: 'panel' | 'compact';
	emptyCopyKey: string;
}

export function Meter({ value, total, valueLabel, variant = 'panel', emptyCopyKey }: MeterProps) {
	const isEmpty = total == null || total <= 0;
	const height = variant === 'compact' ? METER_COMPACT_HEIGHT_PX : METER_HEIGHT_PX;
	const ratio = isEmpty ? 0 : Math.max(0, Math.min(1, value / (total as number)));
	const meterModifier = variant === 'compact' ? 'vt-chart__meter--compact' : 'vt-chart__meter--panel';
	const meterClassName = ['vt-chart__meter', meterModifier].join(' ');

	return (
		<ChartFrame variantClassName="vt-chart--meter" height={height} isEmpty={isEmpty} emptyCopyKey={emptyCopyKey} useResponsiveContainer={false}>
			<div className={meterClassName}>
				<div className="vt-chart__meter-track">
					<div className="vt-chart__meter-fill" style={{ width: `${ratio * 100}%` }} />
				</div>
				{valueLabel ? <span className="vt-chart__meter-value">{valueLabel}</span> : null}
			</div>
		</ChartFrame>
	);
}

export default Meter;
