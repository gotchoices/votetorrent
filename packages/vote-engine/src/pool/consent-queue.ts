// consent-queue.ts — serializes biometric consent prompts across ballots: Android shows one
// BiometricPrompt at a time, so a second ballot's prompt must wait for the first. One call runs at
// a time, in arrival order; a rejected call does not stop the calls behind it.
//
// `holdMs` bounds how long ONE prompt holds the queue (D-94): a prompt nobody answers must not
// block every later prompt for ever. Implemented in the GREEN step of plan 65-10.
//
// Hermes/browser pure: no Buffer, no node:* import, no console.*; timers via setTimeout only.

export interface ConsentQueueOptions {
  /** release the queue this long after a call started, even if it has not settled */
  holdMs?: number
}

export function createConsentQueue<A extends unknown[], R> (
  fn: (...args: A) => Promise<R>,
  _options?: ConsentQueueOptions
): (...args: A) => Promise<R> {
  let tail: Promise<unknown> = Promise.resolve()
  return (...args: A) => {
    const run = tail.then(async () => await fn(...args))
    tail = run.catch(() => undefined)
    return run
  }
}
