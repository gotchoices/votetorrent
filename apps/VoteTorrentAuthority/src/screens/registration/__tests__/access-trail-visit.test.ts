/**
 * Behavioral pin for `createAccessTrailVisit` / `shouldFlushForAppState`
 * (D-14 visit accumulator, D-01 accountability framing).
 *
 * Plain Jest unit test over a pure module: no render harness, no mocking of
 * any kind -- the subject needs none of it.
 *
 * The accepted-loss decision this suite pins: a rejected or thrown
 * recorder call is swallowed and its names are NOT re-sent later. That is
 * D-14's deliberate choice, not a defect -- see test 7 and test 8 below.
 *
 * No test in this file asserts that the trail restricts, blocks or
 * protects anything -- there is no such behavior. It only observes
 * app-mediated reveals after the fact.
 */

import { createAccessTrailVisit, shouldFlushForAppState } from '../access-trail-visit'
import type { AppLifecycleState } from '../access-trail-visit'

function makeRecorder (): { record: (fieldNames: string[]) => Promise<void>, calls: string[][] } {
  const calls: string[][] = []
  const record = async (fieldNames: string[]): Promise<void> => {
    calls.push([...fieldNames])
  }
  return { record, calls }
}

describe('createAccessTrailVisit — D-14 accumulator and delta flush', () => {
  it('a name revealed three times contributes exactly once (D-14 Set semantics)', async () => {
    const { record, calls } = makeRecorder()
    const visit = createAccessTrailVisit(record)

    visit.noteRevealed('ssn')
    visit.noteRevealed('ssn')
    visit.noteRevealed('ssn')
    await visit.flush()

    expect(calls).toEqual([['ssn']])
  })

  it('names are sorted ascending with a plain relational comparison', async () => {
    const { record, calls } = makeRecorder()
    const visit = createAccessTrailVisit(record)

    visit.noteRevealed('ssn')
    visit.noteRevealed('dob')
    visit.noteRevealed('phone')
    await visit.flush()

    expect(calls).toEqual([['dob', 'phone', 'ssn']])
  })

  it('an empty accumulator flushes nothing', async () => {
    const { record, calls } = makeRecorder()
    const visit = createAccessTrailVisit(record)

    await expect(visit.flush()).resolves.toBeUndefined()
    expect(calls).toEqual([])
  })

  it('a whitespace-only or empty name is ignored and does not by itself cause a flush', async () => {
    const { record, calls } = makeRecorder()
    const visit = createAccessTrailVisit(record)

    visit.noteRevealed('')
    visit.noteRevealed('   ')
    await visit.flush()
    expect(calls).toEqual([])

    visit.noteRevealed(' dob ')
    await visit.flush()
    expect(calls).toEqual([['dob']])
  })

  it('a second flush with no new reveals sends nothing', async () => {
    const { record, calls } = makeRecorder()
    const visit = createAccessTrailVisit(record)

    visit.noteRevealed('ssn')
    await visit.flush()
    await visit.flush()

    expect(calls).toEqual([['ssn']])
  })

  it('a background flush followed by an unmount flush sends each name at most once (the delta contract)', async () => {
    const { record, calls } = makeRecorder()
    const visit = createAccessTrailVisit(record)

    // This is the shape a backgrounded-then-closed visit produces: two
    // rows, disjoint names, nothing duplicated and nothing dropped.
    visit.noteRevealed('ssn')
    await visit.flush()

    visit.noteRevealed('dob')
    await visit.flush()

    expect(calls).toEqual([['ssn'], ['dob']])
  })

  it('a rejected recorder is swallowed and its names are NOT re-sent by a later flush (accepted loss, no retry)', async () => {
    let call = 0
    const calls: string[][] = []
    const record = async (fieldNames: string[]): Promise<void> => {
      call += 1
      if (call === 1) {
        throw new Error('recorder rejected')
      }
      calls.push([...fieldNames])
    }
    const visit = createAccessTrailVisit(record)

    visit.noteRevealed('ssn')
    await expect(visit.flush()).resolves.toBeUndefined()

    // This is the accepted loss being asserted, not a defect --
    // re-sending 'ssn' here would be a retry queue, which D-14 rules out.
    visit.noteRevealed('dob')
    await visit.flush()

    expect(calls).toEqual([['dob']])
  })

  it('a thrown (synchronous) recorder is swallowed on the same terms', async () => {
    let call = 0
    const calls: string[][] = []
    const record = (fieldNames: string[]): void => {
      call += 1
      if (call === 1) {
        throw new Error('synchronous recorder failure')
      }
      calls.push([...fieldNames])
    }
    const visit = createAccessTrailVisit(record)

    visit.noteRevealed('ssn')
    await expect(visit.flush()).resolves.toBeUndefined()

    visit.noteRevealed('dob')
    await visit.flush()

    expect(calls).toEqual([['dob']])
  })

  it('revealedFieldNames keeps everything; pendingFieldNames empties on flush', async () => {
    const { record } = makeRecorder()
    const visit = createAccessTrailVisit(record)

    visit.noteRevealed('ssn')
    visit.noteRevealed('dob')

    expect(visit.revealedFieldNames()).toEqual(['dob', 'ssn'])
    expect(visit.pendingFieldNames()).toEqual(['dob', 'ssn'])

    const snapshot = visit.revealedFieldNames()
    snapshot.push('mutated')
    expect(visit.revealedFieldNames()).toEqual(['dob', 'ssn'])

    await visit.flush()

    expect(visit.revealedFieldNames()).toEqual(['dob', 'ssn'])
    expect(visit.pendingFieldNames()).toEqual([])
  })

  it('shouldFlushForAppState fires only on the transition into background', () => {
    const cases: Array<[AppLifecycleState, AppLifecycleState, boolean]> = [
      ['active', 'background', true],
      ['inactive', 'background', true],
      ['background', 'background', false],
      ['active', 'inactive', false],
      ['background', 'active', false],
      ['active', 'active', false]
    ]

    for (const [previous, next, expected] of cases) {
      expect(shouldFlushForAppState(previous, next)).toBe(expected)
    }
  })

  it('the recorder never receives anything but the names it was given', async () => {
    const { record, calls } = makeRecorder()
    const visit = createAccessTrailVisit(record)

    // Sentinel VALUE strings, never handed to the accumulator here -- this
    // assertion pins that the module invents nothing and carries nothing
    // else through.
    const sentinelSsnValue = '123-45-6789'
    const sentinelDobValue = '1980-01-01'

    visit.noteRevealed('ssn')
    visit.noteRevealed('dob')
    await visit.flush()

    const serialized = JSON.stringify(calls)
    expect(serialized).not.toContain(sentinelSsnValue)
    expect(serialized).not.toContain(sentinelDobValue)
  })
})
