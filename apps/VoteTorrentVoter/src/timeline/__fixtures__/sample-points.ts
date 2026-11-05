/**
 * sample-points.ts -- Phase 59 plan 59-06, Task 3.
 *
 * The 41-point sample-set generator (`59-06-PLAN.md` <contracts> / `59-VALIDATION.md`, carried
 * from the Phase 54 lesson: "`voting` is 8 of 1000 slider steps on a realistic timeline, so any
 * gate sampling hand-picked instants will silently never test it. Derive sample points from the
 * timeline."). Given ten sorted instants `e1 < ... < e10`:
 *
 *   - for each event `e_i`: push `e_i - 1`, `e_i`, `e_i + 1` (30 points)
 *   - for each adjacent pair: push `floor((e_i + e_i+1) / 2)` (9 points)
 *   - push `e1 - 86_400_000` (all-future) and `e10 + 86_400_000` (all-past)
 *   = 41 points.
 *
 * Contains NO literal date -- it is a pure function of whatever timeline it is given. Does not
 * sort, dedupe or filter its output: a dedupe would silently shrink coverage.
 */
import type {TimelineStageId} from '../stages';

export const EXPECTED_SAMPLE_POINT_COUNT = 41;

/**
 * Generate the 41 `<contracts>`-rule sample points from a fixture's own ten instants (in
 * `TimelineStageId` D-09 order, as `CANONICAL_TIMELINE`'s own key order already is).
 */
export function generateSamplePoints(timeline: Record<TimelineStageId, number>, order: readonly TimelineStageId[]): number[] {
	const instants = order.map(id => timeline[id]);
	const points: number[] = [];

	for (const e of instants) {
		points.push(e - 1, e, e + 1);
	}

	for (let i = 0; i < instants.length - 1; i++) {
		points.push(Math.floor((instants[i] + instants[i + 1]) / 2));
	}

	points.push(instants[0] - 86_400_000);
	points.push(instants[instants.length - 1] + 86_400_000);

	return points;
}
