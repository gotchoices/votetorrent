/**
 * signing-proof-runner.ts — Phase 28 dev-only boot runner (D-07 / SIGN-04)
 *
 * Fire-and-forget from index.js after AppRegistry.registerComponent.
 * No-op when SIGNING_PROOF_ENABLED is false or __DEV__ is false.
 * Never throws — any failure is logged as [spike013] FATAL so the app still boots.
 *
 * Toggle off by setting SIGNING_PROOF_ENABLED to false (leave wired for repeat runs).
 * Everything is logged to logcat under the [spike013] tag.
 */

import { runSigningProof } from './signing-proof'
// Static import only — dynamic require() breaks Metro (Phase 16-07 lesson).
import { SIGNING_PROOF_ENABLED } from './proof-flags.generated'

/**
 * Boot entry point. Fire-and-forget from index.js after the app registers.
 * Never throws — any failure is logged as [spike013] FATAL so the app still boots.
 * No-op unless __DEV__ && SIGNING_PROOF_ENABLED.
 */
export async function runSigningProofRunner(): Promise<void> {
  if (!(__DEV__ && SIGNING_PROOF_ENABLED)) {
    return
  }
  try {
    await runSigningProof()
  } catch (err) {
    console.error('[spike013] FATAL —', err)
    console.info('[spike013] ========== SIGNING VERDICT: FAIL ==========')
  }
}
