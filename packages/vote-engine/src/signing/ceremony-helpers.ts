/**
 * Shared signing-ceremony helpers for the Phase 42 registration-domain engines
 * (RegistrationEngine, AssociationEngine, AuthorityConfigEngine).
 *
 * WR-04 (42-REVIEW): these helpers were previously copy-pasted near-verbatim
 * across the three engines, which is exactly how WR-01 arose — one copy of
 * `toIsoZDatetime` diverged from the other and silently lost the bare-ISO
 * (no-`Z`) read-back branch. Consolidating them here means a future
 * datetime-pitfall fix lands ONCE instead of N times. Engines keep thin
 * `private` delegators (`this.requireCtx(...)` / `this.rethrow(...)` /
 * `this.resolveSign(...)`) so their call sites are unchanged; only the logic
 * moved.
 */

import { MisuseError, QuereusError } from '@quereus/quereus'
import type { Signature, Timestamp } from '@votetorrent/vote-core'
import type { EngineContext } from '../types.js'

/** The `Signature | sign-callback` union every registration-domain engine accepts. */
export type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

/** Normalizes the `Signature | callback` union into a single callback shape. */
export function resolveSign (
  signatureOrCallback: SignatureOrCallback
): (digest: Uint8Array) => Promise<Signature> {
  return typeof signatureOrCallback === 'function'
    ? signatureOrCallback
    : async () => signatureOrCallback
}

/**
 * Canonical UTC-`Z` datetime normalizer for the registration-domain
 * `Expiration`/`AttestationTime` columns, whose `ExpirationValid` CHECKs require
 * `isISODatetime(...) and like('%Z', ...)` — a trailing `Z` is MANDATORY.
 *
 * WR-01 (42-REVIEW): the third branch (bare ISO without `Z` → append `Z`
 * directly) is the load-bearing one for a DB read-back. Quereus's canonical
 * stored form for a `datetime` column (what a plain `select` returns) is UTC
 * with the trailing `Z` stripped and fractional seconds at minimal precision.
 * We must append `Z` directly rather than re-parsing through `new Date(...)`,
 * which would misinterpret the bare string as LOCAL time (mirrors utils.ts's
 * `fromCanonicalDatetime` convention) and silently shift the instant by the
 * host's UTC offset. The registration copy of this function was missing this
 * branch — this consolidated version keeps it for every engine.
 */
export function toIsoZDatetime (input: Timestamp | string): string {
  if (typeof input === 'number') return new Date(input).toISOString()
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(input)) return input
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(input)) return `${input}Z`
  const parsed = new Date(input)
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  return input
}

/**
 * T-42-03 (found via TDD): Quereus's DEFERRED CHECK constraints (any CHECK
 * containing a subquery) re-derive `new.*` from a `Temporal.PlainDateTime`-
 * coerced snapshot — for a `datetime` column this drops the trailing `Z` AND
 * serializes fractional seconds at MINIMAL precision (trailing zero digits
 * dropped). The `vrg` AdminSigning ceremony digest for a datetime column MUST
 * use this coerced form; every IMMEDIATE (non-deferred) CHECK sees the RAW
 * Z-suffixed, always-3-digit value instead. See the original doc comment in
 * git history (registration-engine.ts / association-engine.ts) for the full
 * 5000-sample derivation.
 */
export function toDeferredCheckDatetime (input: Timestamp | string): string {
  let s = toIsoZDatetime(input).replace(/Z$/, '')
  if (s.includes('.')) {
    s = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  }
  return s
}

/**
 * T-42-06 (found via TDD): a plain `select` READ of a `datetime` column comes
 * back Z-STRIPPED. Re-stamping an UNCHANGED value read back from the DB must
 * NOT re-parse it through `new Date()` (which treats a Z-less ISO string as
 * LOCAL time, silently shifting the instant by the host's UTC offset) — it
 * must have `Z` appended directly, preserving the exact stored wall-clock
 * digits as UTC.
 */
export function reZuluDatetime (stored: string): string {
  return stored.endsWith('Z') ? stored : `${stored}Z`
}

/**
 * 48-11/48-12: reconstructs (ENGINE-WRITTEN values only; a SUBMITTER-signed SubmittedAt must use `resolveSignedSubmittedAt` in signed-submitted-at.ts — UAT 62 gap 2) the EXACT canonical `toIsoZDatetime` byte form (a trailing 'Z' and
 * fixed 3-digit milliseconds) from a value that has been through a Quereus plain-SELECT
 * round-trip — which strips the trailing 'Z' AND drops trailing zero fractional digits
 * (T-42-06). Engine-written `datetime` columns (e.g. ReceivedAt) go through
 * `toIsoZDatetime`, which (for a numeric `Timestamp`) always emits EXACTLY 3 fractional
 * digits via `Date.prototype.toISOString()` — so Quereus's "minimal precision" stripping only
 * ever REMOVES trailing zeros, never changes a non-zero digit. Padding back up to 3 digits is
 * therefore a byte-exact reconstruction, not a guess.
 *
 * Hoisted here (from a `signature-tasks-engine.ts`-local function, 48-11) because ANY partial
 * `UPDATE RegistrationRequest` — not only `finalizeRegistrantApproval`'s accept path — must
 * explicitly rebind `SubmittedAt`/`ReceivedAt` with this exact reconstruction or Quereus's
 * unqualified `SubmittedAtValid`/`ReceivedAtValid`/`SignatureValid` CHECKs evaluate a
 * Z-stripped, precision-truncated snapshot of the row and fail. `reZuluDatetime` alone is
 * insufficient — it restores the 'Z' but not the dropped precision digits. Shared here so
 * `RegistrationEngine.rejectRegistrationRequest` (48-12) and
 * `SignatureTasksEngine.finalizeRegistrantApproval` (48-11) use ONE copy instead of two
 * independently-drifting ones (the exact WR-01 failure mode this module's header warns about).
 */
export function restoreCanonicalDatetime (stored: string): string {
  const withZ = stored.endsWith('Z') ? stored.slice(0, -1) : stored
  const dot = withZ.indexOf('.')
  if (dot < 0) return `${withZ}.000Z`
  const fraction = withZ.slice(dot + 1)
  const padded = (fraction + '000').slice(0, 3)
  return `${withZ.slice(0, dot)}.${padded}Z`
}

/**
 * Guard that an EngineContext is bound before a DB-backed method runs.
 * `engineName` personalizes the error so a misuse points at the right engine.
 */
export function requireCtx (
  ctx: EngineContext | undefined,
  engineName: string,
  method: string
): void {
  if (!ctx) {
    throw new Error(
      `${engineName}.${method}: no EngineContext bound — construct with (ctx) for DB-backed methods`
    )
  }
}

/**
 * Normalize a thrown error into a stable, engine-labelled Error. Mirrors the
 * per-engine `rethrow` implementations verbatim (only the engine name varied).
 */
export function rethrow (err: unknown, engineName: string, method: string): never {
  if (err instanceof QuereusError) {
    throw new Error(`Quereus error (code ${err.code}): ${err.message}`)
  } else if (err instanceof MisuseError) {
    throw new Error(`API misuse: ${err.message}`)
  } else if (err instanceof Error) {
    const wrapped = new Error(`${engineName}.${method}: ${err.message}`)
    // The app routes engine/signer refusals by `code` (e.g. KEY_INVALIDATED_REASSOCIATE), never by
    // message text — carry it across the boundary, only when the source actually has a string one.
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string') Object.assign(wrapped, { code })
    throw wrapped
  } else {
    throw new Error(`${engineName}.${method}: unknown error: ${String(err)}`)
  }
}
