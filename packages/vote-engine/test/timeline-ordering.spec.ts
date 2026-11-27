/**
 * Phase 59 plan 59-01 — ordering-guard and enum-shape regression spec.
 *
 * Pins D-09's derived member order, D-11's negative keyholder-event
 * constraint, and the four new adjacent-pair TIMELINE_ORDER checks across
 * all three builders (ElectionsCreateElectionBuilder,
 * ElectionsAdjustElectionBuilder, ElectionProposeRevisionBuilder).
 *
 * Fixtures are built locally in this file (not imported from the shared
 * test-context helpers) so this spec cannot be invalidated by an unrelated
 * fixture edit.
 */
import {
  ElectionEvent,
  ElectionType
} from '@votetorrent/vote-core'
import type {
  ElectionInit,
  ElectionRevisionInit,
  IElectionEngine,
  IElectionsEngine
} from '@votetorrent/vote-core'
import { expect } from 'chai'
import { ElectionsCreateElectionBuilder } from '../src/elections/builders/elections-create-election-builder.js'
import { ElectionsAdjustElectionBuilder } from '../src/elections/builders/elections-adjust-election-builder.js'
import { ElectionProposeRevisionBuilder } from '../src/election/builders/election-propose-revision-builder.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** All ten D-09-order members, strictly increasing by one day each. */
function makeWellOrderedTimeline (now: number): Record<ElectionEvent, number> {
  return {
    [ElectionEvent.registrationEnds]: now + 1 * 86_400_000,
    [ElectionEvent.ballotsFinal]: now + 2 * 86_400_000,
    [ElectionEvent.votingStarts]: now + 3 * 86_400_000,
    [ElectionEvent.accruingVotes]: now + 4 * 86_400_000,
    [ElectionEvent.hashingVotes]: now + 5 * 86_400_000,
    [ElectionEvent.releasingKeys]: now + 6 * 86_400_000,
    [ElectionEvent.tallyingStarts]: now + 7 * 86_400_000,
    [ElectionEvent.validation]: now + 8 * 86_400_000,
    [ElectionEvent.certificationStarts]: now + 9 * 86_400_000,
    [ElectionEvent.closed]: now + 10 * 86_400_000
  }
}

/** The same timeline with the three D-08 keys absent — a pre-D-08 legacy row. */
function makeSevenKeyTimeline (now: number): Record<ElectionEvent, number> {
  const full = makeWellOrderedTimeline(now)
  const seven = { ...full } as Partial<Record<ElectionEvent, number>>
  delete seven[ElectionEvent.accruingVotes]
  delete seven[ElectionEvent.hashingVotes]
  delete seven[ElectionEvent.releasingKeys]
  return seven as Record<ElectionEvent, number>
}

function makeElectionInit (timeline: Record<ElectionEvent, number>): ElectionInit {
  const now = Date.now()
  return {
    election: {
      id: 'election-timeline-order-1',
      authorityId: 'authority-timeline-order-1',
      title: 'Timeline Order Test Election',
      date: now + 20 * 86_400_000,
      revisionDeadline: now + 1 * 86_400_000,
      ballotDeadline: now + 2 * 86_400_000,
      type: ElectionType.official
    },
    revision: {
      electionId: 'election-timeline-order-1',
      revision: 0,
      revisionTimestamp: now,
      tags: ['test'],
      instructions: '# Timeline Order Test',
      keyholders: [],
      timeline,
      keyholderThreshold: 0
    }
  }
}

function makeElectionRevisionInit (timeline: Record<ElectionEvent, number>): ElectionRevisionInit {
  const now = Date.now()
  return {
    electionId: 'election-timeline-order-1',
    revision: 1,
    revisionTimestamp: now,
    tags: ['test'],
    instructions: '# Timeline Order Revision Test',
    keyholders: [],
    timeline,
    keyholderThreshold: 0
  }
}

// Minimal stubs, cast through `as unknown as` per plan instruction — do NOT
// copy elections.spec.ts's makeStubElectionsEngine literal (it omits
// seedElectionSigning / seedElectionRevisionSigning / peekNextTid and is one
// of the 150 pre-existing tsconfig.test.json errors).
const stubElectionsEngine = {} as unknown as IElectionsEngine
const stubElectionEngine = {} as unknown as IElectionEngine

type Pair = readonly [ElectionEvent, ElectionEvent]

const NEW_PAIRS: Pair[] = [
  [ElectionEvent.votingStarts, ElectionEvent.accruingVotes],
  [ElectionEvent.accruingVotes, ElectionEvent.hashingVotes],
  [ElectionEvent.hashingVotes, ElectionEvent.releasingKeys],
  [ElectionEvent.releasingKeys, ElectionEvent.tallyingStarts]
]

/** Inverts exactly one [before, after] pair in an otherwise well-ordered timeline. */
function invertPair (
  timeline: Record<ElectionEvent, number>,
  [before, after]: Pair
): Record<ElectionEvent, number> {
  const inverted = { ...timeline }
  const beforeVal = inverted[before]
  const afterVal = inverted[after]
  inverted[before] = afterVal
  inverted[after] = beforeVal
  // guarantee strict inversion even if the swap alone doesn't already violate it
  inverted[before] = inverted[after] + 1
  return inverted
}

interface BuilderCase {
  name: string
  timelineOrderErrors: (timeline: Record<ElectionEvent, number>) => readonly { code: string; kind: string }[]
}

const BUILDER_CASES: BuilderCase[] = [
  {
    name: 'ElectionsCreateElectionBuilder',
    timelineOrderErrors: (timeline) => {
      const b = new ElectionsCreateElectionBuilder(stubElectionsEngine)
        .fromPayload(makeElectionInit(timeline))
      return b.errors().filter((e) => e.code === 'TIMELINE_ORDER')
    }
  },
  {
    name: 'ElectionsAdjustElectionBuilder',
    timelineOrderErrors: (timeline) => {
      const b = new ElectionsAdjustElectionBuilder(stubElectionsEngine)
        .fromPayload(makeElectionInit(timeline))
      return b.errors().filter((e) => e.code === 'TIMELINE_ORDER')
    }
  },
  {
    name: 'ElectionProposeRevisionBuilder',
    timelineOrderErrors: (timeline) => {
      const b = new ElectionProposeRevisionBuilder(stubElectionEngine)
        .fromPayload(makeElectionRevisionInit(timeline))
      return b.errors().filter((e) => e.code === 'TIMELINE_ORDER')
    }
  }
]

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

describe('timeline ordering — D-08/D-09/D-11 regression', () => {
  it('D-09: ElectionEvent has exactly the ten D-09-ordered members', () => {
    expect(Object.values(ElectionEvent)).to.deep.equal([
      'registrationEnds',
      'ballotsFinal',
      'votingStarts',
      'accruingVotes',
      'hashingVotes',
      'releasingKeys',
      'tallyingStarts',
      'validation',
      'certificationStarts',
      'closed'
    ])
  })

  it('D-11: no ElectionEvent member is a keyholder-lifecycle event', () => {
    const keyholderLifecycleNamed = Object.values(ElectionEvent).filter((name) =>
      /keyholder|invite|accept|revoke/i.test(name)
    )
    expect(keyholderLifecycleNamed).to.deep.equal([])
  })

  for (const { name, timelineOrderErrors } of BUILDER_CASES) {
    describe(name, () => {
      it('negative control: a well-ordered ten-key timeline surfaces zero TIMELINE_ORDER errors', () => {
        const now = Date.now()
        const errs = timelineOrderErrors(makeWellOrderedTimeline(now))
        expect(errs.length).to.equal(0)
      })

      it('pre-D-08 tolerance: a seven-key timeline (three new keys absent) surfaces zero TIMELINE_ORDER errors', () => {
        const now = Date.now()
        const errs = timelineOrderErrors(makeSevenKeyTimeline(now))
        expect(errs.length).to.equal(0)
      })

      for (const pair of NEW_PAIRS) {
        const [before, after] = pair
        it(`inverting ${before}→${after} surfaces a TIMELINE_ORDER, cross-field error`, () => {
          const now = Date.now()
          const timeline = invertPair(makeWellOrderedTimeline(now), pair)
          const errs = timelineOrderErrors(timeline)
          expect(errs.length).to.be.greaterThan(0)
          expect(errs.every((e) => e.code === 'TIMELINE_ORDER' && e.kind === 'cross-field')).to.equal(true)
        })
      }
    })
  }
})
