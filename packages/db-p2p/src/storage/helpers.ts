import type { RevisionRange } from "./struct.js";

export function mergeRanges(ranges: RevisionRange[]): RevisionRange[] {
    if (ranges.length <= 1) return ranges;

    ranges.sort((a, b) => a[0] - b[0]);
    const merged: RevisionRange[] = [ranges[0]!];

    for (const range of ranges.slice(1)) {
        const last = merged[merged.length - 1]!;
        // If last range is open-ended, it consumes all following ranges
        if (last[1] === undefined) {
            continue;
        }
        // If this range starts at or before last range's end (exclusive)
        if (range[0] <= last[1]) {
            // If this range is open-ended, make last range open-ended
            if (range[1] === undefined) {
                last[1] = undefined;
            } else {
                last[1] = Math.max(last[1], range[1]);
            }
        } else {
            merged.push(range);
        }
    }

    return merged;
}
