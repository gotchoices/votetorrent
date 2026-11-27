import { toIsoZDatetime } from '../signing/ceremony-helpers.js'
import type { EngineContext } from '../types.js'

/**
 * record-validity.ts — D-12 (Phase 51 Plan 09): authority-owned, per-election record validity for
 * `Registrant` / `Association` / `AssociationPrivate`, replacing 51-05's
 * `INTERIM_ASSOCIATION_VALIDITY_DAYS` placeholder and `ConfirmationScreen.tsx:150`'s `TEN_YEARS_MS`
 * "dev posture" (51-11 owns removing the voter-side constant).
 *
 * A FREE FUNCTION, not a method on `AssociationEngine`, because BOTH `AssociationEngine.associate()`
 * (the Association/AssociationPrivate expiration site) AND
 * `SignatureTasksEngine.finalizeRegistrantApproval` (the Registrant/RegistrantPrivate expiration
 * site) need to read the SAME `ElectionRecordValidityPolicy` row, and `signature-tasks-engine.ts`
 * has no `AssociationEngine` instance of its own to construct one from without adding a needless
 * cross-engine dependency — see 51-09-SUMMARY.md's "chosen mechanism" note for the two options this
 * plan weighed and why this one was chosen. `AssociationEngine.resolveRecordValidity` (private,
 * `association-engine.ts`) is a thin per-instance wrapper around this same function.
 */

/**
 * CONSERVATIVE (shorter) fallback validity windows, used ONLY when no `ElectionRecordValidityPolicy`
 * row exists for the election (or `electionId` is `undefined`) — never the ten-year "dev posture"
 * `ConfirmationScreen.tsx:150`'s `TEN_YEARS_MS` represented, which D-12 exists to retire. `365`
 * mirrors the schema's own column defaults (`RegistrantValidityDays integer default 365`,
 * `AssociationValidityDays integer default 365`, `votetorrent.qsql`'s `ElectionRecordValidityPolicy`
 * table, landed by 51-01) — declared here as named constants, never as a bare inline literal in a
 * computation, so a future change to either bound has one place to move.
 */
export const DEFAULT_REGISTRANT_VALIDITY_DAYS = 365
export const DEFAULT_ASSOCIATION_VALIDITY_DAYS = 365

const MS_PER_DAY = 86400000

export interface RecordValidity {
  registrantExpiration: string
  associationExpiration: string
}

/**
 * WR-10 (51-REVIEW): validate a policy column AT THE READ, so the error names the policy row.
 *
 * `ElectionRecordValidityPolicy` declares both columns `integer default 365` with no `not null`
 * and no range CHECK, and the previous `Number(...)` coercion trusted whatever came back:
 *   - an explicit NULL gave `Number(null) === 0`, so the expiration was NOW and the deferred
 *     `ExpirationFuture check on insert (Expiration > context.now)` on BOTH `Association` and
 *     `AssociationPrivate` failed at COMMIT — every `associate()` for that election dying with an
 *     opaque CHECK-constraint error several layers from its cause;
 *   - a missing/undecodable value gave `NaN`, and `new Date(NaN).toISOString()` throws
 *     `RangeError: Invalid time value` — an unclassified crash rather than a structured rejection;
 *   - a negative value silently produced a PAST expiration with the same opaque CHECK failure.
 *
 * A NULL column is treated as "unset" and falls back to the conservative default (the same
 * outcome as no policy row at all, which is what a NULL honestly means). Anything present but
 * unusable throws HERE, naming the column and the value.
 */
function requirePositiveDays (value: unknown, column: string, fallback: number): number {
  if (value == null) return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(
      `resolveRecordValidity: ElectionRecordValidityPolicy.${column} is ${JSON.stringify(value)} — must be a positive integer number of days`
    )
  }
  return n
}

/**
 * D-12 — resolves per-election record validity from the authority-owned
 * `ElectionRecordValidityPolicy` table. Modeled on `AssociationEngine.associate()`'s EXISTING
 * fail-closed-by-rejection `select AttestationRequired from ElectionAttestationPolicy where
 * ElectionId = :electionId` read: a failure of THIS select itself PROPAGATES (rejects the caller),
 * never silently defaults. The ONLY silent-default case is "no row exists for this election, or
 * `electionId` is `undefined`" — which uses the CONSERVATIVE named constants above, not a permissive
 * window.
 *
 * Returns canonical ISO-Z expirations (via `toIsoZDatetime`) — callers that need the DEFERRED
 * (subquery-CHECK) form must apply `toDeferredCheckDatetime` themselves, exactly as
 * `associate()` already does for its own digest arguments; this function does not guess which form
 * a given caller's digest needs.
 */
export async function resolveRecordValidity (
  ctx: EngineContext,
  electionId: string | undefined
): Promise<RecordValidity> {
  const policyRow = await ctx.db
    .prepare('select RegistrantValidityDays, AssociationValidityDays from ElectionRecordValidityPolicy where ElectionId = :electionId')
    .get({ electionId: electionId ?? null })

  const registrantValidityDays = policyRow == null
    ? DEFAULT_REGISTRANT_VALIDITY_DAYS
    : requirePositiveDays(policyRow.RegistrantValidityDays, 'RegistrantValidityDays', DEFAULT_REGISTRANT_VALIDITY_DAYS)
  const associationValidityDays = policyRow == null
    ? DEFAULT_ASSOCIATION_VALIDITY_DAYS
    : requirePositiveDays(policyRow.AssociationValidityDays, 'AssociationValidityDays', DEFAULT_ASSOCIATION_VALIDITY_DAYS)

  const registrantExpiration = toIsoZDatetime(new Date(Date.now() + registrantValidityDays * MS_PER_DAY).toISOString())
  const associationExpiration = toIsoZDatetime(new Date(Date.now() + associationValidityDays * MS_PER_DAY).toISOString())

  return { registrantExpiration, associationExpiration }
}
