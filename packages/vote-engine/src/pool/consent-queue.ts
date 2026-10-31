// consent-queue.ts — serializes biometric consent prompts across ballots: Android shows one
// BiometricPrompt at a time, so a second ballot's prompt must wait for the first. One call runs at
// a time, in arrival order; a rejected call does not stop the calls behind it.
//
// D-114: the queue knows which prompt is on screen. A call may carry an abandon `signal`; a call
// abandoned while still queued is rejected and its prompt is never raised (no orphan prompt). A call
// abandoned or expired while its prompt is showing calls the injected `cancel` hook once, rejects its
// caller with ConsentAbandonedError, and the NEXT call starts only after that cancel has settled (or
// after an internal cap), because the platform swallows a second prompt while one is showing. A
// native result that arrives after the abandon reaches nobody. The engine stays platform-free: the
// cancel is injected by the host app.
//
// D-115: a call's `deadlineAt` (in the queue's `now()` clock) is the time its prompt may be held. The
// running call is cancelled at its deadline (reason 'expired'); queued calls start earliest deadline
// first (no deadline last, ties in arrival order); a call that would start with less than
// `minPromptMs` left is rejected 'no-time' without prompting.
//
// `holdMs` bounds how long ONE call WITHOUT a deadline holds the queue (D-94): a prompt nobody
// answers must not block every later prompt for ever. With no cancel hook the queue then moves on
// (the stuck call's own caller still gets that call's result whenever it comes, nobody else ever
// does); with a cancel hook the held prompt is cancelled first, as for a deadline.
//
// With no cancel hook, no signal and no deadline the queue behaves as it always did: one call at a
// time, in arrival order, a rejected call does not stop the calls behind it.
//
// Hermes/browser pure: no Buffer, no node:* import, no console.*; timers via setTimeout only.

/** The shortest prompt window worth opening: a call with less time left than this is refused without prompting (D-115). */
export const POOL_MIN_PROMPT_MS = 10_000

/** how long the queue waits for the cancel hook before it moves on anyway (above the native 2 s cap) */
const CANCEL_WAIT_CAP_MS = 5_000

export type ConsentAbandonReason = 'abandoned' | 'expired' | 'no-time'

export class ConsentAbandonedError extends Error {
  readonly reason: ConsentAbandonReason
  constructor (reason: ConsentAbandonReason) {
    super(`consent abandoned: ${reason}`)
    this.name = 'ConsentAbandonedError'
    this.reason = reason
  }
}

/** True for an instance OR any object named ConsentAbandonedError (a dist copy and a src copy may both exist). */
export function isConsentAbandonedError (err: unknown): err is ConsentAbandonedError {
  return err instanceof ConsentAbandonedError ||
    (err !== null && typeof err === 'object' && (err as { name?: unknown }).name === 'ConsentAbandonedError')
}

export interface ConsentCallControl {
  /** abort to abandon the call: skipped while queued, cancelled while its prompt is showing */
  signal?: AbortSignal
  /** the latest time its prompt may still be held, in the queue's `now()` clock */
  deadlineAt?: number
  /** called synchronously immediately before the prompt function is invoked */
  onStart?: () => void
}

export interface ConsentQueueOptions {
  /** release the queue this long after a call without a deadline started, even if it has not settled */
  holdMs?: number
  /** dismiss the prompt that is showing; the queue waits for it before starting the next call */
  cancel?: () => Promise<unknown>
  /** a call that would start with less time than this before its deadline is rejected 'no-time' (default 0) */
  minPromptMs?: number
  now?: () => number
}

export type ConsentQueue<A extends unknown[], R> = ((...args: A) => Promise<R>) & {
  withControl: (ctl: ConsentCallControl | undefined, ...args: A) => Promise<R>
}

interface Entry<A extends unknown[], R> {
  args: A
  ctl: ConsentCallControl
  arrival: number
  deadlineAt: number | undefined
  resolve: (value: R) => void
  reject: (err: unknown) => void
  settled: boolean
  /** a cancel hook call owns the release of this entry's slot */
  cancelling: boolean
  timer: ReturnType<typeof setTimeout> | undefined
  onAbort: (() => void) | undefined
}

export function createConsentQueue<A extends unknown[], R> (
  fn: (...args: A) => Promise<R>,
  options?: ConsentQueueOptions
): ConsentQueue<A, R> {
  const holdMs = options?.holdMs
  const bounded = typeof holdMs === 'number' && Number.isFinite(holdMs) && holdMs > 0
  const cancel = options?.cancel
  const minPromptMs = options?.minPromptMs ?? 0
  const now = options?.now ?? (() => Date.now())
  let running: Entry<A, R> | null = null
  let waiting: Array<Entry<A, R>> = []
  let arrivals = 0

  const unhook = (e: Entry<A, R>): void => {
    if (e.onAbort !== undefined) { e.ctl.signal?.removeEventListener('abort', e.onAbort); e.onAbort = undefined }
  }
  const clearTimer = (e: Entry<A, R>): void => {
    if (e.timer !== undefined) { clearTimeout(e.timer); e.timer = undefined }
  }
  const reject = (e: Entry<A, R>, reason: ConsentAbandonReason): void => {
    e.settled = true
    unhook(e)
    e.reject(new ConsentAbandonedError(reason))
  }
  const release = (e: Entry<A, R>): void => {
    clearTimer(e)
    if (running === e) { running = null; pump() }
  }

  const abandonRunning = (e: Entry<A, R>, reason: ConsentAbandonReason): void => {
    if (e.settled) return
    reject(e, reason)
    if (cancel !== undefined) {
      clearTimer(e)
      e.cancelling = true
      let done = false
      let cap: ReturnType<typeof setTimeout> | undefined
      const finish = (): void => {
        if (done) return
        done = true
        if (cap !== undefined) clearTimeout(cap)
        release(e)
      }
      cap = setTimeout(finish, CANCEL_WAIT_CAP_MS)
      try {
        Promise.resolve(cancel()).then(finish, finish)
      } catch {
        finish()
      }
    } else if (reason === 'expired') {
      release(e)
    }
    // no cancel hook and 'abandoned': the prompt is still showing, so the slot is held until the
    // prompt function settles or the hold timer fires
  }

  const start = (e: Entry<A, R>): void => {
    running = e
    if (e.deadlineAt !== undefined || bounded) {
      const delay = e.deadlineAt !== undefined ? Math.max(0, e.deadlineAt - now()) : holdMs!
      e.timer = setTimeout(() => {
        e.timer = undefined
        if (!e.settled && (e.deadlineAt !== undefined || cancel !== undefined)) abandonRunning(e, 'expired')
        else release(e)
      }, delay)
    }
    let pending: Promise<R>
    try {
      try { e.ctl.onStart?.() } catch { /* an observer must not stop the prompt */ }
      pending = fn(...e.args)
    } catch (err) {
      pending = Promise.reject(err)
    }
    pending.then((value) => {
      if (!e.settled) { e.settled = true; unhook(e); e.resolve(value) }
      if (!e.cancelling) release(e)
    }, (err) => {
      if (!e.settled) { e.settled = true; unhook(e); e.reject(err) }
      if (!e.cancelling) release(e)
    })
  }

  function pump (): void {
    while (running === null && waiting.length > 0) {
      let best = 0
      for (let i = 1; i < waiting.length; i++) {
        const a = waiting[i]!
        const b = waiting[best]!
        const da = a.deadlineAt ?? Infinity
        const db = b.deadlineAt ?? Infinity
        if (da < db || (da === db && a.arrival < b.arrival)) best = i
      }
      const e = waiting[best]!
      waiting = waiting.filter((_, i) => i !== best)
      if (e.deadlineAt !== undefined) {
        const left = e.deadlineAt - now()
        if (left <= 0 || left < minPromptMs) { reject(e, 'no-time'); continue }
      }
      start(e)
    }
  }

  const withControl = async (ctl: ConsentCallControl | undefined, ...args: A): Promise<R> => {
    const control = ctl ?? {}
    return await new Promise<R>((resolve, rejectCaller) => {
      if (control.signal?.aborted === true) { rejectCaller(new ConsentAbandonedError('abandoned')); return }
      const e: Entry<A, R> = {
        args,
        ctl: control,
        arrival: arrivals++,
        deadlineAt: control.deadlineAt,
        resolve,
        reject: rejectCaller,
        settled: false,
        cancelling: false,
        timer: undefined,
        onAbort: undefined
      }
      if (control.signal !== undefined) {
        e.onAbort = () => {
          if (e.settled) return
          if (running === e) { abandonRunning(e, 'abandoned'); return }
          const at = waiting.indexOf(e)
          if (at >= 0) { waiting = waiting.filter((x) => x !== e); reject(e, 'abandoned') }
        }
        control.signal.addEventListener('abort', e.onAbort)
      }
      waiting.push(e)
      pump()
    })
  }

  const q = ((...args: A) => withControl(undefined, ...args)) as ConsentQueue<A, R>
  q.withControl = withControl
  return q
}
