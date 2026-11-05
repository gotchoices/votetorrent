/**
 * Phase 47-13 (D-14) — the access-trail VISIT accumulator and the AppState
 * flush predicate. All the decision logic for D-14 lives here, in a pure,
 * synchronous, React-free, AppState-free, engine-free module, so a plain
 * Jest unit test can drive every rule with no render harness at all.
 *
 * D-01 FRAMING, STATED PLAINLY: `RegistrantAccessEvent` records
 * app-mediated reveals only. The officer holds the device and the local
 * Quereus/LevelDB file; reading it directly writes no row. It exists for
 * accountability, deterrence and regulatory posture, and is
 * not a security control.
 *
 * VISIT DEFINITION: mount to unmount is one visit. A re-render of the
 * still-mounted screen -- including one driven by a React Navigation focus
 * after a child screen pops back -- is NOT a new visit and does not reset
 * the accumulator, because the screen never left the component tree
 * (`47-RESEARCH.md` Open Question 1, resolved this way here).
 *
 * THE ACCEPTED RISK, STATED AS AN ACCEPTANCE AND NOT AS A PROBLEM TO BE
 * SOLVED: a crash or force-quit between the last reveal and the flush drops
 * that visit's row. That is acceptable loss. There is no retry queue, no
 * persistence before the flush, and no re-queue after a failed write. A
 * durable queue would add a second, longer-lived record of who-looked-at-
 * whom on the officer's own device, and would give delivery guarantees to a
 * record that D-01 deliberately keeps advisory and bypassable. A future
 * reader who thinks this is an oversight should find the reasoning here
 * rather than a gap.
 *
 * VALUES RULE: this module handles field NAMES only. Its sole input is one
 * string per reveal, it stores no value, holds no registrant or viewer
 * identity, and performs no serialization. The structural names-only
 * guarantee is 47-07's engine-side `sanitizeAccessTrailFields`, which
 * intersects against the registrant's own `RegistrantPrivate` vocabulary --
 * do not add a second sanitizer here; a weaker duplicate would invite a
 * future reader to trust the wrong one.
 */

/**
 * Restates React Native's `AppStateStatus` union locally rather than
 * importing it, so this module keeps zero `react-native` imports and stays
 * drivable by a plain unit test with no RN preset involvement. Task 2's
 * hook is where the real `AppStateStatus` meets it.
 */
export type AppLifecycleState = 'active' | 'background' | 'inactive' | 'unknown' | 'extension'

/** Takes field NAMES only -- never a registrant id, a viewer id, or a value. */
export type AccessTrailRecorder = (fieldNames: string[]) => Promise<void> | void

/** The D-14 visit accumulator and flush surface for one mount-to-unmount screen-visit. */
export interface AccessTrailVisit {
  noteRevealed(fieldName: string): void
  revealedFieldNames(): string[]
  pendingFieldNames(): string[]
  flush(): Promise<void>
}

/**
 * Returns `true` iff `next === 'background'` and `previous !== 'background'`.
 *
 * `'inactive'` does NOT trigger a flush. On iOS `'inactive'` fires for
 * transient interruptions (the control-centre pull, an incoming-call
 * banner, the app switcher preview), so flushing on it would scatter a
 * single visit across several rows for events in which the officer never
 * left the screen. `'background'` is the durable signal and is the state a
 * termination follows. This app's device proofs run on Android (Pixel_8
 * AVD), which does not emit `'inactive'` at all.
 *
 * The `previous !== 'background'` guard makes a repeated `'background'`
 * emission a no-op at the predicate level. It is belt-and-braces: the delta
 * semantics in `createAccessTrailVisit` already make a duplicate flush
 * harmless.
 */
export function shouldFlushForAppState (previous: AppLifecycleState, next: AppLifecycleState): boolean {
  return next === 'background' && previous !== 'background'
}

function sortNames (names: Iterable<string>): string[] {
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * Creates one D-14 visit: a closure over two `Set<string>`s, `revealed`
 * (everything noted during this visit) and `handedOff` (everything already
 * passed to `record`).
 */
export function createAccessTrailVisit (record: AccessTrailRecorder): AccessTrailVisit {
  const revealed = new Set<string>()
  const handedOff = new Set<string>()

  return {
    // `PrivateFieldRow` (47-12) re-emits `onReveal(name)` on EVERY
    // masked-to-revealed edge, so a field revealed, re-masked and revealed
    // again arrives three times and must contribute its name exactly once
    // -- which is exactly what a `Set` gives us for free.
    noteRevealed (fieldName: string): void {
      const trimmed = typeof fieldName === 'string' ? fieldName.trim() : ''
      // A whitespace-only or empty name carries no accountability
      // information and would produce a meaningless row, so it is dropped
      // silently here rather than handed downstream.
      if (trimmed.length === 0) return
      revealed.add(trimmed)
    },

    // Fresh, sorted snapshot array. Never exposes the internal `Set`, so a
    // caller mutating the returned array cannot affect a later call.
    revealedFieldNames (): string[] {
      return sortNames(revealed)
    },

    // `revealed` minus `handedOff` -- what a flush right now would send.
    pendingFieldNames (): string[] {
      const pending = new Set<string>()
      for (const name of revealed) {
        if (!handedOff.has(name)) pending.add(name)
      }
      return sortNames(pending)
    },

    async flush (): Promise<void> {
      const pending: string[] = []
      for (const name of revealed) {
        if (!handedOff.has(name)) pending.push(name)
      }
      // D-14: an empty accumulator flushes nothing -- and after a
      // background flush with no further reveals, the unmount flush is
      // correctly silent. Also makes a re-entrant call safe: a second
      // call while the first is still in flight sees nothing pending.
      if (pending.length === 0) return

      const sorted = sortNames(pending)

      // Marking BEFORE the await is what makes "no retry" structural
      // rather than a convention. If names were marked on resolution, a
      // rejected write would leave them pending and the next flush would
      // re-send them -- a retry queue built by accident, which is exactly
      // what D-14's accepted-loss posture rules out. Because names are
      // marked at hand-off, a background flush followed later by an
      // unmount flush sends each revealed name at most once across the
      // whole visit: the normal shape (reveal, navigate away) is a single
      // flush and therefore a single row -- D-14's "one row per
      // screen-visit". A visit interrupted by a backgrounding may produce
      // two rows, each carrying a disjoint set of names. The honest
      // invariant is: no name is recorded twice and no revealed name is
      // dropped by the split -- not an unconditional one-row claim.
      for (const name of sorted) handedOff.add(name)

      try {
        await record(sorted)
      } catch {
        // Deliberately empty. A recorder rejection is swallowed: the
        // flush fires from an unmount cleanup and from an AppState
        // listener, and an escaping rejection there would take down a
        // screen teardown or surface as an unhandled rejection. This
        // catch binds no variable it formats and writes nothing to the
        // debug console -- the rejected call's argument list is a set of
        // field names, and nothing on this path gets logged. This is
        // acceptable loss (D-14), not a defect: there is no retry and the
        // names stay marked as handed off.
      }
    }
  }
}
