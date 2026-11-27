/**
 * WR-02 (59-REVIEW-2) — the ordering guard `CreateElectionScreen` and
 * `EditElectionScreen` share, and the FIRST executable coverage it has ever
 * had. Before this file, the guard existed only as two hand-typed inline
 * comparison chains with no test of any kind: CR-02 found that every one of
 * the five ordering sites in the repo had silently dropped `validation`,
 * letting an officer sign an out-of-order, IMMUTABLE timeline, and the fix
 * was verified on these two screens by diff-reading alone.
 *
 * WHY THE PAIR LOOP, NOT A HAND-WRITTEN CASE PER EVENT: an accept-only test
 * (or a test that only inverts one arbitrary pair) cannot catch a dropped
 * comparison — that is precisely the shape of the CR-02 defect. The loop
 * below derives its cases from `TIMELINE_STRICT_CHAIN` itself, so removing
 * any comparison from the guard turns exactly one case RED, and adding an
 * eleventh `ElectionEvent` grows the case list with no edit here.
 *
 * Plain Jest over pure functions: no render harness, no mocks, no wall clock.
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { ElectionEvent } from '@votetorrent/vote-core'
import {
  TIMELINE_STRICT_CHAIN,
  findTimelineOrderViolation,
} from '../resolve-election-timeline'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = new Date('2026-01-01T00:00:00.000Z').getTime()

/**
 * A timeline that satisfies the whole chain with a full day between every
 * adjacent pair — built FROM the chain so an inverted pair below is the only
 * thing separating a passing fixture from a failing one.
 */
function orderedTimeline(): Record<ElectionEvent, number> {
  const timeline = {} as Record<ElectionEvent, number>
  timeline[ElectionEvent.registrationEnds] = NOW + 2 * DAY_MS
  timeline[ElectionEvent.ballotsFinal] = NOW + 5 * DAY_MS
  TIMELINE_STRICT_CHAIN.forEach((event, index) => {
    timeline[event] = NOW + (10 + index) * DAY_MS
  })
  return timeline
}

describe('TIMELINE_STRICT_CHAIN', () => {
  it('is the eight strictly-increasing events in D-09 order, preparation events excluded', () => {
    expect(TIMELINE_STRICT_CHAIN).toEqual([
      ElectionEvent.votingStarts,
      ElectionEvent.accruingVotes,
      ElectionEvent.hashingVotes,
      ElectionEvent.releasingKeys,
      ElectionEvent.tallyingStarts,
      ElectionEvent.validation,
      ElectionEvent.certificationStarts,
      ElectionEvent.closed,
    ])
    expect(TIMELINE_STRICT_CHAIN).not.toContain(ElectionEvent.registrationEnds)
    expect(TIMELINE_STRICT_CHAIN).not.toContain(ElectionEvent.ballotsFinal)
  })

  it('is frozen, so no caller can mutate the chain the guard iterates', () => {
    expect(Object.isFrozen(TIMELINE_STRICT_CHAIN)).toBe(true)
  })

  /**
   * Cross-package parity. The voter rail and the public view enforce their own
   * copy of this chain in `packages/ui-web/src/lifecycle/timeline-core.js`, a
   * package the Authority app does not (and should not) depend on — so the two
   * lists can only be kept in agreement by reading one against the other. If
   * they drift, the Authority signs a timeline the voter then flags
   * `OUT_OF_ORDER`, collapsing the rail into the D-03 indeterminate state.
   * The parse is asserted non-empty first: a rename or a moved file must fail
   * this test, never silently compare against nothing.
   */
  it('matches ui-web timeline-core.js, the voter/public source of truth, verbatim', () => {
    const sourcePath = resolve(
      __dirname,
      '../../../../../../packages/ui-web/src/lifecycle/timeline-core.js'
    )
    const source = readFileSync(sourcePath, 'utf8')
    const block = /export const STRICT_CHAIN = Object\.freeze\(\[([^\]]*)\]\)/.exec(source)
    expect(block).not.toBeNull()

    const upstream = Array.from(block![1]!.matchAll(/'([A-Za-z]+)'/g)).map((m) => m[1])
    expect(upstream.length).toBe(8)
    expect(upstream).toEqual([...TIMELINE_STRICT_CHAIN])
  })
})

describe('findTimelineOrderViolation', () => {
  it('returns null for a fully ordered timeline', () => {
    expect(findTimelineOrderViolation(orderedTimeline())).toBeNull()
  })

  it('returns null when only the preparation events are out of order (they are not chained)', () => {
    const timeline = orderedTimeline()
    // ballotsFinal deliberately AFTER votingStarts — legitimate, not a violation.
    timeline[ElectionEvent.ballotsFinal] = timeline[ElectionEvent.closed] + DAY_MS
    timeline[ElectionEvent.registrationEnds] = timeline[ElectionEvent.closed] + 2 * DAY_MS
    expect(findTimelineOrderViolation(timeline)).toBeNull()
  })

  // One case per adjacent pair, derived from the chain: a guard missing ANY
  // single comparison fails exactly the case for that pair.
  for (let i = 0; i < TIMELINE_STRICT_CHAIN.length - 1; i += 1) {
    const before = TIMELINE_STRICT_CHAIN[i]!
    const after = TIMELINE_STRICT_CHAIN[i + 1]!

    it(`rejects ${after} set BEFORE ${before}`, () => {
      const timeline = orderedTimeline()
      timeline[after] = timeline[before] - DAY_MS
      expect(findTimelineOrderViolation(timeline)).toEqual({ before, after })
    })

    it(`rejects ${after} set EQUAL to ${before} (>= semantics, not >)`, () => {
      const timeline = orderedTimeline()
      timeline[after] = timeline[before]
      expect(findTimelineOrderViolation(timeline)).toEqual({ before, after })
    })
  }

  // The two members CR-02 proved were unguarded, named explicitly so the
  // regression is legible in the test report and not only as a loop index.
  it('CR-02: rejects an out-of-order validation (tallyingStarts >= validation)', () => {
    const timeline = orderedTimeline()
    timeline[ElectionEvent.validation] =
      timeline[ElectionEvent.tallyingStarts] - DAY_MS
    expect(findTimelineOrderViolation(timeline)).toEqual({
      before: ElectionEvent.tallyingStarts,
      after: ElectionEvent.validation,
    })
  })

  it('CR-02: rejects an out-of-order closed (certificationStarts >= closed)', () => {
    const timeline = orderedTimeline()
    timeline[ElectionEvent.closed] =
      timeline[ElectionEvent.certificationStarts] - DAY_MS
    expect(findTimelineOrderViolation(timeline)).toEqual({
      before: ElectionEvent.certificationStarts,
      after: ElectionEvent.closed,
    })
  })

  it('reports the FIRST violating pair when several are out of order', () => {
    const timeline = orderedTimeline()
    timeline[ElectionEvent.hashingVotes] = timeline[ElectionEvent.accruingVotes] - DAY_MS
    timeline[ElectionEvent.closed] = timeline[ElectionEvent.certificationStarts] - DAY_MS
    expect(findTimelineOrderViolation(timeline)).toEqual({
      before: ElectionEvent.accruingVotes,
      after: ElectionEvent.hashingVotes,
    })
  })
})
