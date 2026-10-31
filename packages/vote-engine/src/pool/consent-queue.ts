// consent-queue.ts — serializes biometric consent prompts across ballots: Android shows one
// BiometricPrompt at a time, so a second ballot's prompt must wait for the first. One call runs at
// a time, in arrival order; a rejected call does not stop the calls behind it.
//
// `holdMs` bounds how long ONE prompt holds the queue (D-94): a prompt nobody answers must not
// block every later prompt for ever. When it elapses the queue moves on; the stuck call's own
// caller still gets that call's result whenever it comes, and nobody else ever does.
//
// Hermes/browser pure: no Buffer, no node:* import, no console.*; timers via setTimeout only.

/** The shortest prompt window worth opening: a call with less time left than this is refused without prompting (D-115). */
export const POOL_MIN_PROMPT_MS = 10_000

export type ConsentAbandonReason = 'abandoned' | 'expired' | 'no-time'

export class ConsentAbandonedError extends Error {
  readonly reason: ConsentAbandonReason
  constructor (reason: ConsentAbandonReason) {
    super(`consent abandoned: ${reason}`)
    this.name = 'ConsentAbandonedError'
    this.reason = reason
  }
}

export function isConsentAbandonedError (err: unknown): err is ConsentAbandonedError {
  return err instanceof ConsentAbandonedError ||
    (err !== null && typeof err === 'object' && (err as { name?: unknown }).name === 'ConsentAbandonedError')
}

export interface ConsentCallControl {
  signal?: AbortSignal
  /** in the queue's `now()` clock */
  deadlineAt?: number
  onStart?: () => void
}

export interface ConsentQueueOptions {
  /** release the queue this long after a call started, even if it has not settled */
  holdMs?: number
  cancel?: () => Promise<unknown>
  minPromptMs?: number
  now?: () => number
}

export type ConsentQueue<A extends unknown[], R> = ((...args: A) => Promise<R>) & {
  withControl: (ctl: ConsentCallControl | undefined, ...args: A) => Promise<R>
}

export function createConsentQueue<A extends unknown[], R> (
  fn: (...args: A) => Promise<R>,
  options?: ConsentQueueOptions
): ConsentQueue<A, R> {
  const holdMs = options?.holdMs
  const bounded = typeof holdMs === 'number' && Number.isFinite(holdMs) && holdMs > 0
  let tail: Promise<void> = Promise.resolve()
  const run = async (...args: A): Promise<R> => {
    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    const previous = tail
    tail = released
    await previous
    let timer: ReturnType<typeof setTimeout> | undefined
    if (bounded) timer = setTimeout(release, holdMs)
    try {
      return await fn(...args)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      release()
    }
  }
  const q = ((...args: A) => run(...args)) as ConsentQueue<A, R>
  q.withControl = async (_ctl, ...args) => await run(...args)
  return q
}
