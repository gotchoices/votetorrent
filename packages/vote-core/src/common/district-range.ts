/**
 * district-range.ts — pure contiguous-range helper (BAL-02, D-14).
 * No React/RN/engine imports — importable from the vote-engine Mocha suite.
 */

/**
 * Returns a new array containing all existing districts plus numeric codes
 * from `from` through `to` (inclusive), skipping codes already present.
 *
 * Guards:
 * - If `from` or `to` are non-numeric, returns `districts` unchanged.
 * - If `start > end`, returns `districts` unchanged.
 */
export function computeRange(districts: string[], from: string, to: string): string[] {
  const start = parseInt(from.trim(), 10);
  const end = parseInt(to.trim(), 10);
  if (isNaN(start) || isNaN(end) || start > end) return districts;
  const next = [...districts];
  for (let i = start; i <= end; i++) {
    const code = String(i);
    if (!next.includes(code)) next.push(code);
  }
  return next;
}
