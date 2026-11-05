/**
 * Behavioral pin for `useAccessTrailVisit` (D-14 lifecycle wiring). This
 * suite proves BOTH flush triggers -- unmount and the AppState
 * active-to-background transition -- each fire exactly one recorder call,
 * that a re-render (including the React Navigation focus/blur shape) is
 * NOT a new visit, and that a rejecting recorder never escapes teardown
 * (T-47-17 accepted loss).
 *
 * No test here asserts the trail blocks, restricts or protects anything --
 * there is no such behavior.
 */
import React from 'react'
import renderer from 'react-test-renderer'
import { AppState } from 'react-native'
import type { AppStateStatus } from 'react-native'
import { useAccessTrailVisit } from '../useAccessTrailVisit'
import type { AccessTrailVisitHandle } from '../useAccessTrailVisit'

let capturedType: string | undefined
let capturedHandler: ((state: AppStateStatus) => void) | undefined
let removeSpy: jest.Mock

beforeEach(() => {
  capturedType = undefined
  capturedHandler = undefined
  removeSpy = jest.fn()
  // The RN preset already supplies a working AppState -- a targeted spy
  // keeps the harness small and additionally lets the suite assert the
  // subscription was removed on unmount, which a module-level mock would
  // obscure.
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((type: string, handler: (s: AppStateStatus) => void) => {
    capturedType = type
    capturedHandler = handler
    return { remove: removeSpy } as never
  }) as typeof AppState.addEventListener)
})

afterEach(() => {
  jest.restoreAllMocks()
})

async function flushTicks (): Promise<void> {
  await renderer.act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

// Renders `null` -- this suite needs no theme, no i18n and no navigation
// mocks at all.
function Harness ({ record, onHandle, tag }: { record: (fieldNames: string[]) => Promise<void> | void, onHandle: (handle: AccessTrailVisitHandle) => void, tag?: string }): null {
  const handle = useAccessTrailVisit(record)
  onHandle(handle)
  void tag
  return null
}

describe('useAccessTrailVisit — D-14 lifecycle wiring', () => {
  it('flushes exactly one recorder call with the accumulated names on unmount (D-14)', async () => {
    const recorder = jest.fn(async (_names: string[]) => {})
    let handle!: AccessTrailVisitHandle

    let tr!: renderer.ReactTestRenderer
    renderer.act(() => {
      tr = renderer.create(<Harness record={recorder} onHandle={(h) => { handle = h }} />)
    })

    // Confirms the hook subscribed to the 'change' event (the only event
    // AppState emits), not some other type.
    expect(capturedType).toBe('change')

    handle.noteRevealed('ssn')
    handle.noteRevealed('dob')
    handle.noteRevealed('ssn')

    renderer.act(() => {
      tr.unmount()
    })
    await flushTicks()

    expect(recorder).toHaveBeenCalledTimes(1)
    expect(recorder).toHaveBeenCalledWith(['dob', 'ssn'])
  })

  it('flushes on the AppState background transition, without unmounting (D-14)', async () => {
    const recorder = jest.fn(async (_names: string[]) => {})
    let handle!: AccessTrailVisitHandle

    renderer.act(() => {
      renderer.create(<Harness record={recorder} onHandle={(h) => { handle = h }} />)
    })

    handle.noteRevealed('ssn')

    await renderer.act(async () => {
      capturedHandler?.('background')
      await Promise.resolve()
    })

    expect(recorder).toHaveBeenCalledTimes(1)
    expect(recorder).toHaveBeenCalledWith(['ssn'])
  })

  it('both triggers together produce one call per trigger and never repeat a name', async () => {
    const recorder = jest.fn(async (_names: string[]) => {})
    let handle!: AccessTrailVisitHandle

    let tr!: renderer.ReactTestRenderer
    renderer.act(() => {
      tr = renderer.create(<Harness record={recorder} onHandle={(h) => { handle = h }} />)
    })

    handle.noteRevealed('ssn')
    await renderer.act(async () => {
      capturedHandler?.('background')
      await Promise.resolve()
    })

    handle.noteRevealed('dob')
    renderer.act(() => {
      tr.unmount()
    })
    await flushTicks()

    // Two rows, disjoint names -- the honest consequence of the durability
    // flush splitting one visit, not a duplicate record.
    expect(recorder.mock.calls).toEqual([[['ssn']], [['dob']]])
  })

  it('an empty visit flushes nothing on either trigger', async () => {
    const recorder = jest.fn(async (_names: string[]) => {})

    let tr!: renderer.ReactTestRenderer
    renderer.act(() => {
      tr = renderer.create(<Harness record={recorder} onHandle={() => {}} />)
    })

    await renderer.act(async () => {
      capturedHandler?.('background')
      await Promise.resolve()
    })
    renderer.act(() => {
      tr.unmount()
    })
    await flushTicks()

    expect(recorder).toHaveBeenCalledTimes(0)

    const recorder2 = jest.fn(async (_names: string[]) => {})
    renderer.act(() => {
      renderer.create(<Harness record={recorder2} onHandle={() => {}} />)
    })
    await renderer.act(async () => {
      capturedHandler?.('background')
      await Promise.resolve()
    })
    await renderer.act(async () => {
      capturedHandler?.('active')
      capturedHandler?.('background')
      await Promise.resolve()
    })

    expect(recorder2).toHaveBeenCalledTimes(0)
  })

  it('a transition to inactive does not flush', async () => {
    const recorder = jest.fn(async (_names: string[]) => {})
    let handle!: AccessTrailVisitHandle

    renderer.act(() => {
      renderer.create(<Harness record={recorder} onHandle={(h) => { handle = h }} />)
    })

    handle.noteRevealed('ssn')

    await renderer.act(async () => {
      capturedHandler?.('inactive')
      await Promise.resolve()
    })
    expect(recorder).toHaveBeenCalledTimes(0)

    await renderer.act(async () => {
      capturedHandler?.('background')
      await Promise.resolve()
    })
    expect(recorder).toHaveBeenCalledTimes(1)
  })

  it('a re-render is NOT a new visit — the accumulator survives and no flush fires (Open Question 1)', async () => {
    const recorderA = jest.fn(async (_names: string[]) => {})
    const recorderB = jest.fn(async (_names: string[]) => {})
    let handle!: AccessTrailVisitHandle

    let tr!: renderer.ReactTestRenderer
    renderer.act(() => {
      tr = renderer.create(<Harness record={recorderA} tag="one" onHandle={(h) => { handle = h }} />)
    })

    handle.noteRevealed('ssn')

    // Re-render the same element with a changed unrelated prop AND a
    // newly-identified `record` callback -- proving the recordRef
    // indirection does not recreate the visit. This is the React
    // Navigation focus/blur case: a focused-again screen never left the
    // tree, so it is the same visit.
    renderer.act(() => {
      tr.update(<Harness record={recorderB} tag="two" onHandle={(h) => { handle = h }} />)
    })

    handle.noteRevealed('dob')

    renderer.act(() => {
      tr.unmount()
    })
    await flushTicks()

    expect(recorderA).toHaveBeenCalledTimes(0)
    expect(recorderB).toHaveBeenCalledTimes(1)
    expect(recorderB).toHaveBeenCalledWith(['dob', 'ssn'])
  })

  it('two separate mounts are two visits', async () => {
    const recorder = jest.fn(async (_names: string[]) => {})
    let handle!: AccessTrailVisitHandle

    let tr1!: renderer.ReactTestRenderer
    renderer.act(() => {
      tr1 = renderer.create(<Harness record={recorder} onHandle={(h) => { handle = h }} />)
    })
    handle.noteRevealed('ssn')
    renderer.act(() => {
      tr1.unmount()
    })
    await flushTicks()

    let tr2!: renderer.ReactTestRenderer
    renderer.act(() => {
      tr2 = renderer.create(<Harness record={recorder} onHandle={(h) => { handle = h }} />)
    })
    handle.noteRevealed('dob')
    renderer.act(() => {
      tr2.unmount()
    })
    await flushTicks()

    expect(recorder.mock.calls).toEqual([[['ssn']], [['dob']]])
  })

  it('the AppState subscription is removed on unmount and a later background event flushes nothing', async () => {
    const recorder = jest.fn(async (_names: string[]) => {})
    let handle!: AccessTrailVisitHandle

    let tr!: renderer.ReactTestRenderer
    renderer.act(() => {
      tr = renderer.create(<Harness record={recorder} onHandle={(h) => { handle = h }} />)
    })
    handle.noteRevealed('ssn')

    renderer.act(() => {
      tr.unmount()
    })
    await flushTicks()

    expect(removeSpy).toHaveBeenCalledTimes(1)
    expect(recorder).toHaveBeenCalledTimes(1)

    await renderer.act(async () => {
      capturedHandler?.('background')
      await Promise.resolve()
    })
    expect(recorder).toHaveBeenCalledTimes(1)
  })

  it('a rejecting recorder does not surface an error through unmount (accepted loss)', async () => {
    const recorder = jest.fn(async (_names: string[]) => {
      throw new Error('recorder rejected')
    })
    let handle!: AccessTrailVisitHandle

    let tr!: renderer.ReactTestRenderer
    renderer.act(() => {
      tr = renderer.create(<Harness record={recorder} onHandle={(h) => { handle = h }} />)
    })
    handle.noteRevealed('ssn')

    // The dropped write is accepted loss -- there is no retry queue and no
    // persistence before the flush, per D-14.
    expect(() => {
      renderer.act(() => {
        tr.unmount()
      })
    }).not.toThrow()
    await flushTicks()

    // A subsequent mount still works, proving nothing crashed the process.
    const recorder2 = jest.fn(async (_names: string[]) => {})
    renderer.act(() => {
      renderer.create(<Harness record={recorder2} onHandle={() => {}} />)
    })
    expect(recorder2).toBeDefined()
  })

  it('the handle identity is stable across re-renders', () => {
    const recorder = jest.fn(async (_names: string[]) => {})
    let handleA: AccessTrailVisitHandle | undefined
    let handleB: AccessTrailVisitHandle | undefined

    let tr!: renderer.ReactTestRenderer
    renderer.act(() => {
      tr = renderer.create(<Harness record={recorder} tag="a" onHandle={(h) => { handleA = h }} />)
    })
    renderer.act(() => {
      tr.update(<Harness record={recorder} tag="b" onHandle={(h) => { handleB = h }} />)
    })

    expect(Object.is(handleA, handleB)).toBe(true)
    expect(Object.is(handleA?.noteRevealed, handleB?.noteRevealed)).toBe(true)
  })

  it('T-47-02: the recorder receives only names, never a value', async () => {
    const recorder = jest.fn(async (_names: string[]) => {})
    let handle!: AccessTrailVisitHandle

    const sentinelSsnValue = '123-45-6789'
    const sentinelDobValue = '1980-01-01'

    let tr!: renderer.ReactTestRenderer
    renderer.act(() => {
      tr = renderer.create(<Harness record={recorder} onHandle={(h) => { handle = h }} />)
    })
    handle.noteRevealed('ssn')
    handle.noteRevealed('dob')

    renderer.act(() => {
      tr.unmount()
    })
    await flushTicks()

    const serialized = JSON.stringify(recorder.mock.calls)
    expect(serialized).not.toContain(sentinelSsnValue)
    expect(serialized).not.toContain(sentinelDobValue)
  })

  it('T-47-02: no console method is called across a full reveal / background / unmount cycle', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {})
    const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {})

    const recorder = jest.fn(async (_names: string[]) => {
      throw new Error('recorder rejected')
    })
    let handle!: AccessTrailVisitHandle

    let tr!: renderer.ReactTestRenderer
    renderer.act(() => {
      tr = renderer.create(<Harness record={recorder} onHandle={(h) => { handle = h }} />)
    })

    handle.noteRevealed('ssn')
    await renderer.act(async () => {
      capturedHandler?.('background')
      await Promise.resolve()
    })
    handle.noteRevealed('dob')
    renderer.act(() => {
      tr.unmount()
    })
    await flushTicks()

    for (const spy of [logSpy, warnSpy, errorSpy, infoSpy, debugSpy]) {
      expect(spy).toHaveBeenCalledTimes(0)
      spy.mockRestore()
    }
  })
})
