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
    throw new Error(`${engineName}.${method}: ${err.message}`)
  } else {
    throw new Error(`${engineName}.${method}: unknown error: ${String(err)}`)
  }
}
