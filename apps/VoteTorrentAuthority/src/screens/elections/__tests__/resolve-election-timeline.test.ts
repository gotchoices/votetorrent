/**
 * Behavioral pin for `resolveElectionTimeline` — the single, shared timeline
 * construction site both `CreateElectionScreen` and `EditElectionScreen`
 * build their signed `ElectionRevision.Timeline` through (D-16, Phase 59
 * plan 04).
 *
 * Includes the R2 regression pin: an officer-entered `releasingKeys` date
 * (previously silently discarded on Create and blanked on Edit) must appear
 * in the resolver's output under its own key — the same pin extends to
 * `accruingVotes` and `hashingVotes`, the two members this plan gives a
 * producer to for the first time.
 *
 * Plain Jest unit test over a pure function: no render harness, no mocking
 * of any kind, no `Date.now()` — `now` is always the fixed constant below.
 */

import { ElectionEvent } from '@votetorrent/vote-core'
import {
  CREATE_FALLBACK_DAYS,
  EDIT_FALLBACK_DAYS,
  TIMELINE_FIELD_ORDER,
  resolveElectionTimeline,
  type TimelineFormDates,
} from '../resolve-election-timeline'

// Fixed reference instant — never Date.now() — 2026-01-01T00:00:00.000Z.
const NOW = new Date('2026-01-01T00:00:00.000Z').getTime()

const BLANK_FORM: TimelineFormDates = {
  registrationEnds: '',
  ballotsFinal: '',
  votingStarts: '',
  accruingVotes: '',
  hashingVotes: '',
  releasingKeys: '',
  tallyingStarts: '',
  validation: '',
  certificationStarts: '',
  closed: '',
}

const FULL_FORM: TimelineFormDates = {
  registrationEnds: '2026-02-01T00:00:00.000Z',
  ballotsFinal: '2026-02-05T00:00:00.000Z',
  votingStarts: '2026-03-20T00:00:00.000Z',
  accruingVotes: '2026-03-21T00:00:00.000Z',
  hashingVotes: '2026-03-22T00:00:00.000Z',
  releasingKeys: '2026-03-23T00:00:00.000Z',
  tallyingStarts: '2026-03-24T00:00:00.000Z',
  validation: '2026-03-25T00:00:00.000Z',
  certificationStarts: '2026-03-26T00:00:00.000Z',
  closed: '2026-03-27T00:00:00.000Z',
}

describe('resolveElectionTimeline', () => {
  it('emits exactly the ten ElectionEvent keys, each equal to the parsed form date, when all ten are set', () => {
    const result = resolveElectionTimeline(FULL_FORM, NOW, CREATE_FALLBACK_DAYS)

    expect(Object.keys(result).sort()).toEqual(Object.values(ElectionEvent).slice().sort())
    for (const key of TIMELINE_FIELD_ORDER) {
      expect(result[key]).toBe(new Date(FULL_FORM[key as keyof TimelineFormDates]).getTime())
    }
  })

  it('R2 regression pin: a releasingKeys date entered by an officer appears under the releasingKeys key', () => {
    const form: TimelineFormDates = { ...BLANK_FORM, releasingKeys: '2026-03-23T00:00:00.000Z' }
    const result = resolveElectionTimeline(form, NOW, CREATE_FALLBACK_DAYS)

    expect(result[ElectionEvent.releasingKeys]).toBe(new Date('2026-03-23T00:00:00.000Z').getTime())
  })

  it('R2 regression pin: an officer-entered accruingVotes date appears under the accruingVotes key', () => {
    const form: TimelineFormDates = { ...BLANK_FORM, accruingVotes: '2026-03-21T00:00:00.000Z' }
    const result = resolveElectionTimeline(form, NOW, CREATE_FALLBACK_DAYS)

    expect(result[ElectionEvent.accruingVotes]).toBe(new Date('2026-03-21T00:00:00.000Z').getTime())
  })

  it('R2 regression pin: an officer-entered hashingVotes date appears under the hashingVotes key', () => {
    const form: TimelineFormDates = { ...BLANK_FORM, hashingVotes: '2026-03-22T00:00:00.000Z' }
    const result = resolveElectionTimeline(form, NOW, CREATE_FALLBACK_DAYS)

    expect(result[ElectionEvent.hashingVotes]).toBe(new Date('2026-03-22T00:00:00.000Z').getTime())
  })

  it('a completely blank form yields a strictly increasing ten-event timeline under the Create offsets', () => {
    const result = resolveElectionTimeline(BLANK_FORM, NOW, CREATE_FALLBACK_DAYS)

    for (let i = 1; i < TIMELINE_FIELD_ORDER.length; i++) {
      const prevKey = TIMELINE_FIELD_ORDER[i - 1]
      const key = TIMELINE_FIELD_ORDER[i]
      expect(result[key]).toBeGreaterThan(result[prevKey])
    }
  })

  it('a completely blank form yields a strictly increasing ten-event timeline under the Edit offsets', () => {
    const result = resolveElectionTimeline(BLANK_FORM, NOW, EDIT_FALLBACK_DAYS)

    for (let i = 1; i < TIMELINE_FIELD_ORDER.length; i++) {
      const prevKey = TIMELINE_FIELD_ORDER[i - 1]
      const key = TIMELINE_FIELD_ORDER[i]
      expect(result[key]).toBeGreaterThan(result[prevKey])
    }
  })

  it('is deterministic: two calls with the same now produce a deeply-equal result', () => {
    const a = resolveElectionTimeline(FULL_FORM, NOW, CREATE_FALLBACK_DAYS)
    const b = resolveElectionTimeline(FULL_FORM, NOW, CREATE_FALLBACK_DAYS)

    expect(a).toEqual(b)
  })

  it('an unparseable date string falls back to the offset default', () => {
    const form: TimelineFormDates = { ...BLANK_FORM, registrationEnds: 'not a date' }
    const result = resolveElectionTimeline(form, NOW, CREATE_FALLBACK_DAYS)
    const fallback = resolveElectionTimeline(BLANK_FORM, NOW, CREATE_FALLBACK_DAYS)

    expect(result[ElectionEvent.registrationEnds]).toBe(fallback[ElectionEvent.registrationEnds])
  })

  it('a whitespace-only date string falls back to the offset default', () => {
    const form: TimelineFormDates = { ...BLANK_FORM, ballotsFinal: '   ' }
    const result = resolveElectionTimeline(form, NOW, CREATE_FALLBACK_DAYS)
    const fallback = resolveElectionTimeline(BLANK_FORM, NOW, CREATE_FALLBACK_DAYS)

    expect(result[ElectionEvent.ballotsFinal]).toBe(fallback[ElectionEvent.ballotsFinal])
  })

  it('a parsed value of 0 (Unix epoch) falls back to the offset default, because 0 is falsy', () => {
    // "1970-01-01T00:00:00.000Z" parses to getTime() === 0, which is falsy,
    // so `new Date(s).getTime() || fallbackMs` takes the fallback branch —
    // preserving today's exact semantics, not "improving" them.
    const form: TimelineFormDates = { ...BLANK_FORM, registrationEnds: '1970-01-01T00:00:00.000Z' }
    const result = resolveElectionTimeline(form, NOW, CREATE_FALLBACK_DAYS)
    const fallback = resolveElectionTimeline(BLANK_FORM, NOW, CREATE_FALLBACK_DAYS)

    expect(result[ElectionEvent.registrationEnds]).toBe(fallback[ElectionEvent.registrationEnds])
  })

  it('TIMELINE_FIELD_ORDER deep-equals Object.values(ElectionEvent)', () => {
    expect(TIMELINE_FIELD_ORDER).toEqual(Object.values(ElectionEvent))
  })
})
