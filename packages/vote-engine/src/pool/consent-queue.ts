// consent-queue.ts — serializes biometric consent prompts across ballots: Android shows one
// BiometricPrompt at a time, so a second ballot's prompt must wait for the first. One call runs at
// a time, in arrival order; a rejected call does not stop the calls behind it.
//
// `holdMs` bounds how long ONE prompt holds the queue (D-94): a prompt nobody answers must not
// block every later prompt for ever. When it elapses the queue moves on; the stuck call's own
// caller still gets that call's result whenever it comes, and nobody else ever does.
//
// Hermes/browser pure: no Buffer, no node:* import, no console.*; timers via setTimeout only.

export interface ConsentQueueOptions {
  /** release the queue this long after a call started, even if it has not settled */
  holdMs?: number
}

export function createConsentQueue<A extends unknown[], R> (
  fn: (...args: A) => Promise<R>,
  options?: ConsentQueueOptions
): (...args: A) => Promise<R> {
  const holdMs = options?.holdMs
  const bounded = typeof holdMs === 'number' && Number.isFinite(holdMs) && holdMs > 0
  // Resolves when the previous call has settled or been released; never rejects.
  let tail: Promise<void> = Promise.resolve()
  return async (...args: A) => {
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
}
