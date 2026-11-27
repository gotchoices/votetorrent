/**
 * useNow.ts -- a coarse "now" for live panels, in epoch milliseconds.
 *
 * The Elections lifecycle pill compares an election's deadlines against the
 * current time. A frozen instant would leave the pill on the wrong phase once
 * a deadline passes while the dashboard stays open; this hook re-renders its
 * consumer on a coarse interval so the pill crosses the deadline without a
 * reload.
 *
 * Why coarse: lifecycle deadlines are minute-scale, so the default tick is
 * one minute -- one re-render per minute per mounted consumer. The interval
 * is clamped to 1 s .. 1 h. Background tabs throttle timers, so the hook
 * also takes a fresh reading when the tab becomes visible again.
 *
 * Consumers turn the number into the 19-character canonical form with
 * `toCanonicalDatetime(new Date(nowMs))`, never with an ISO string.
 */
import { useEffect, useState } from 'react';

/** The default tick, one minute. */
export const DEFAULT_NOW_TICK_MS = 60_000;

const MIN_TICK_MS = 1_000;
const MAX_TICK_MS = 3_600_000;

/** Clamp a requested tick to 1 s .. 1 h; anything that is not a finite number gives the default. */
export function normalizeTickInterval(ms: unknown): number {
	if (typeof ms !== 'number' || !Number.isFinite(ms)) return DEFAULT_NOW_TICK_MS;
	if (ms < MIN_TICK_MS) return MIN_TICK_MS;
	if (ms > MAX_TICK_MS) return MAX_TICK_MS;
	return Math.floor(ms);
}

/** The current time in epoch milliseconds, refreshed every `intervalMs` and when the tab becomes visible. */
export function useNow(intervalMs: number = DEFAULT_NOW_TICK_MS): number {
	const tick = normalizeTickInterval(intervalMs);
	const [now, setNow] = useState<number>(() => Date.now());

	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), tick);
		const hasDocument = typeof document !== 'undefined';
		const onVisibility = (): void => {
			if (document.visibilityState === 'visible') setNow(Date.now());
		};
		if (hasDocument) document.addEventListener('visibilitychange', onVisibility);
		return () => {
			clearInterval(timer);
			if (hasDocument) document.removeEventListener('visibilitychange', onVisibility);
		};
	}, [tick]);

	return now;
}
