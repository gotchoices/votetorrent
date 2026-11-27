/**
 * useAccessTrailVisit (D-14) — the thin React binding for the access-trail
 * visit accumulator. `access-trail-visit.ts` owns every rule: the Set-based
 * dedup, the delta flush, the AppState transition predicate, and the
 * accepted-loss decision. This hook holds no accumulation logic and makes
 * no flush decision of its own — it owns exactly three things: which visit
 * object exists, when a flush is attempted, and keeping the caller's
 * recorder callback fresh.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { AppState } from 'react-native'
import type { AppStateStatus } from 'react-native'
import { createAccessTrailVisit, shouldFlushForAppState, type AccessTrailRecorder, type AccessTrailVisit, type AppLifecycleState } from './access-trail-visit'

/** Stable handle 47-20 passes down to every `PrivateFieldRow`'s `onReveal`. */
export interface AccessTrailVisitHandle {
  noteRevealed: (fieldName: string) => void
}

export function useAccessTrailVisit (record: AccessTrailRecorder): AccessTrailVisitHandle {
  // Assigned on every render, so a recorder recreated by 47-20 (its
  // identity changes whenever registrantId or getEngine changes) is never
  // stale at flush time. The visit itself must NOT be recreated when the
  // recorder changes -- that indirection is why this ref exists rather
  // than passing `record` straight into `createAccessTrailVisit`: a visit
  // recreated mid-screen would silently start a second visit for the same
  // mount, which is precisely the shape D-14's mount-to-unmount definition
  // rules out.
  const recordRef = useRef(record)
  recordRef.current = record

  // Lazy ref init, deliberately NOT useMemo: useMemo carries no guarantee
  // against re-computation, and this identity must be stable for the life
  // of the mount, so exactly one visit exists per mount and no re-render
  // replaces it.
  const visitRef = useRef<AccessTrailVisit | null>(null)
  if (visitRef.current === null) {
    visitRef.current = createAccessTrailVisit((fieldNames) => recordRef.current(fieldNames))
  }

  // The previous state shouldFlushForAppState compares against.
  // RN 0.87 types currentState as string; its runtime values are still AppStateStatus.
  const appStateRef = useRef<AppStateStatus>((AppState.currentState as AppStateStatus | null | undefined) ?? 'active')

  // Empty dependency array is the D-14 visit definition made structural:
  // the effect runs once on mount and its cleanup runs once on unmount, so
  // a mount-to-unmount cycle is exactly one visit. A re-render -- including
  // one caused by a React Navigation focus after a child screen pops back
  // -- re-runs neither, so it neither starts a new visit nor resets the
  // accumulator (`47-RESEARCH.md` Open Question 1).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      const previous = appStateRef.current
      appStateRef.current = next
      if (shouldFlushForAppState(previous as AppLifecycleState, next as AppLifecycleState)) {
        void visitRef.current?.flush()
      }
    })

    return () => {
      // Removing the subscription BEFORE the unmount flush so a
      // 'background' event arriving during teardown cannot fire a second
      // flush against a torn-down screen. (Even if one did, the visit's
      // delta semantics make it a no-op -- this ordering is
      // belt-and-braces, not the guarantee.)
      sub.remove()
      // Fire-and-forget in both places -- the accepted-loss posture made
      // concrete: a React effect cleanup cannot await, the process may be
      // killed mid-write, and there is deliberately no retry queue and no
      // persistence before the flush.
      void visitRef.current?.flush()
    }
  }, [])

  const noteRevealed = useCallback((fieldName: string) => {
    visitRef.current?.noteRevealed(fieldName)
  }, [])

  return useMemo(() => ({ noteRevealed }), [noteRevealed])
}
