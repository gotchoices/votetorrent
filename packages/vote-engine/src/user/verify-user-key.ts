import type { EngineContext } from '../types.js'
import { nowCanonicalDatetime } from '../utils.js'

/**
 * Shared user/key membership predicate — D-21's "one implementation, many
 * call sites" helper, the `verify-user-key.ts` analog of
 * `signing/signed-mutation.ts`'s `seedSignedMutation` (the established
 * cross-cutting-verification precedent in this codebase).
 *
 * Scope, deliberately narrow: this answers **membership and non-expiry
 * only** — "does this UserId/UserKey pair name a currently-registered,
 * unexpired `UserKey` row?" It is NOT a signature check.
 *
 * - **Class A** call sites (a real `Signature` is already computed and bound
 *   — today, exactly `authority-engine.ts`'s `proposeAdmin`) additionally
 *   call `verifySig`/`verifySigP256` (`database/initialize.ts`) themselves
 *   over the canonical digest. For them, this helper is one conjunct of two.
 * - **Class B** call sites (the calling method's own public signature has no
 *   `Signature` parameter, so no signature bytes are structurally available
 *   — six sites across `network-engine.ts`/`election-engine.ts`/
 *   `elections-engine.ts`, deferred to 49-09) CANNOT additionally verify a
 *   signature. For them, this helper's result is the WHOLE of "real
 *   `IsUserValid`" — do not mistake a Class B site for an incomplete Class A
 *   one; the gap is structural, not an oversight.
 *
 * Do not duplicate `verifySig`'s verification logic here — call it, don't
 * reimplement it (49-RESEARCH.md §Don't Hand-Roll).
 */
export async function verifyUserKeyMembership (
  ctx: EngineContext,
  userId: string | null | undefined,
  userKey: string | null | undefined
): Promise<{ valid: boolean; keyType: string | null }> {
  if (!userId || !userKey) {
    return { valid: false, keyType: null }
  }
  const row = await ctx.db
    .prepare(
      'select Type from UserKey where UserId = :userId and PubKey = :userKey and Expiration > :now'
    )
    .get({ userId, userKey, now: nowCanonicalDatetime() })
  if (!row) {
    return { valid: false, keyType: null }
  }
  return { valid: true, keyType: row.Type as string }
}
