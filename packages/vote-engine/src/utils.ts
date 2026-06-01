import { bytesToHex } from '@noble/curves/abstract/utils'
import { sha256 } from '@noble/hashes/sha2'

// sql data validation helpers
export const asText = (value: unknown, field: string): string => {
  if (value === null || value === undefined) {
    throw new Error(`${field} is null or undefined`)
  }
  return value.toString()
}

export const asNumberOr = (
  value: unknown,
  defaultValue: number,
  field: string
): number => {
  if (value === null || value === undefined) return defaultValue
  const n = Number(value)
  if (Number.isNaN(n)) {
    throw new Error(`${field} is not a number`)
  }
  return n
}

export const parseJsonOr = <T>(
  value: unknown,
  defaultValue: T,
  field: string
): T => {
  if (value === null || value === undefined) return defaultValue
  try {
    return JSON.parse(value.toString()) as T
  } catch {
    throw new Error(`${field} has invalid JSON`)
  }
}

// H16 hash function
export function H16 (input: string): string {
  const hash = sha256(input)
  // Take first 16 bytes (128 bits) and convert to hex string
  return Array.from(hash.slice(0, 16))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Normalize a key parameter to its hex-string representation.
 *
 * Per the hex-at-the-API-surface contract (D-01/D-03), every engine
 * method entry point that accepts a secp256k1 key must run the value
 * through this helper. `Uint8Array` inputs go through `bytesToHex` from
 * `@noble/curves/abstract/utils`; hex strings pass through unchanged so
 * the helper is a no-op for callers that already conform.
 *
 * Downstream code (and the persisted schema) only ever sees the hex
 * form; the raw byte representation is confined to the immediate
 * neighbourhood of `secp256k1.utils.randomSecretKey()` /
 * `secp256k1.getPublicKey()` / `secp256k1.sign()`.
 */
export function toHexKey (value: string | Uint8Array): string {
  return value instanceof Uint8Array ? bytesToHex(value) : value
}

/**
 * Quereus canonical datetime form: `YYYY-MM-DDTHH:MM:SS` (no fractional
 * seconds, no `Z` suffix). This matches the post-coercion canonical
 * representation that quereus emits when it normalizes numeric epoch
 * timestamps for `datetime` columns.
 *
 * Passing values in this exact form at insert time bypasses the deferred
 * CHECK coercion bug (see
 * `.planning/quick/260522-001-quereus-bug-repros/issues/bug-D-deferred-check-datetime-coercion.md`):
 * because no coercion is needed, `new.*` values seen by deferred
 * subqueries match the stored values in referenced tables.
 */
export function toCanonicalDatetime (input: number | string | Date): string {
  // WR-06 (12.4-REVIEW): accept canonical-datetime strings as a passthrough.
  // AdminInit.effectiveAt was widened to `Timestamp | string` so callers
  // can hand the engine a `nowCanonicalDatetime()`-shaped value directly
  // without an `as never` cast. The string fast-path preserves the exact
  // 19-char canonical form expected by the schema; non-canonical strings
  // fall through to the Date parser below.
  if (typeof input === 'string') {
    // Already-canonical (e.g. '2026-01-01T00:00:00') — return as-is.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(input)) return input
    const parsed = new Date(input)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 19)
    return input
  }
  const d = typeof input === 'number' ? new Date(input) : input
  // Defer invalid-input rejection to the database layer: passing the raw
  // string through lets the datetime column type or downstream CHECK
  // constraint surface a descriptive error instead of a JS RangeError.
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return String(input)
  return d.toISOString().slice(0, 19)
}

/** Current time in {@link toCanonicalDatetime} form. */
export function nowCanonicalDatetime (): string {
  return new Date().toISOString().slice(0, 19)
}

/**
 * Inverse of {@link toCanonicalDatetime}. Quereus stores canonical
 * datetime values without a `Z` suffix, but they semantically represent
 * UTC. Appending `Z` before parsing is required because JavaScript's
 * `Date` constructor treats ISO strings without a timezone designator as
 * local time, while strings with `Z` are treated as UTC.
 *
 * Accepts numeric epoch-ms inputs as a pass-through to tolerate callers
 * that may receive pre-coerced values from older code paths.
 */
export function fromCanonicalDatetime (value: string | number): number {
  if (typeof value === 'number') return value
  return new Date(value + 'Z').getTime()
}
