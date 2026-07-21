import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { verifySig } from './database/initialize.js'
import type { InviteStatus, SentKeyholderInvite } from '@votetorrent/vote-core'

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

/**
 * 39-02 D-04 Gap 2 — parse a persisted `ElectionRevision(.Keyholders)` /
 * `ProposedElectionRevision(.Keyholders)` JSON column into the
 * `ElectionRevision.keyholders: Array<InviteStatus<SentKeyholderInvite>>`
 * projection shape. The column stores whatever `KeyholderInvite[]`-shaped
 * (or bare `SentKeyholderInvite[]`) array the create path serialized —
 * either way every element carries at least a `name` field, which is all
 * this projection needs. These are pending (unresolved) create-time
 * invitees, so `result` is always omitted — acceptance flows through the
 * separate signed `inviteKeyholder` -> `Keyholder` path, not this column.
 */
export const parseKeyholdersAsInviteStatus = (
  value: unknown,
  field: string
): Array<InviteStatus<SentKeyholderInvite>> => {
  const raw = parseJsonOr<Array<{ name?: string }>>(value, [], field)
  return raw.map((kh) => ({ invite: { name: kh.name ?? '' } }))
}

/**
 * Parse a PostgreSQL-style integer-pair range stored in the DB as `{min, max}`.
 *
 * The `Question.OptionRange` and `Question.ScoreRange` columns use the
 * schema default `'{1, 1}'` (PostgreSQL set/range notation). This is NOT
 * JSON — JSON arrays use square brackets. This helper converts the stored
 * `{a, b}` string to `{ min: number, max: number }`, returning `undefined`
 * for null/undefined inputs so callers get the right optional-field type.
 *
 * Parsing rules:
 *   - `null` / `undefined`  → `undefined`
 *   - `{min, max}`          → `{ min: number, max: number }`
 *   - anything else         → throws (field name included for diagnostics)
 */
export const parsePgRange = (
  value: unknown,
  field: string
): { min: number; max: number } | undefined => {
  if (value === null || value === undefined) return undefined
  const s = value.toString().trim()
  const m = /^\{(\s*-?\d+)\s*,\s*(-?\d+\s*)\}$/.exec(s)
  if (!m) throw new Error(`${field} has invalid range format: ${s}`)
  return { min: Number(m[1]), max: Number(m[2]) }
}

/**
 * Format an integer-pair range into the PostgreSQL-style `{min, max}` notation
 * the DB stores for `Question.OptionRange` / `Question.ScoreRange`.
 *
 * This is the inverse of `parsePgRange`: the two MUST agree on the wire format
 * so a value written by the engine can be read back by `parsePgRange` without
 * throwing. Do NOT use `JSON.stringify` here — JSON arrays/objects use square
 * brackets / quoted keys, which `parsePgRange` (and the DB default `'{1, 1}'`)
 * reject. Output matches the DB default spacing (`{1, 1}`).
 */
export const formatPgRange = (range: { min: number; max: number }): string =>
  `{${range.min}, ${range.max}}`

/**
 * Convert `Digest()` output to bytes for the app-layer sign callback (WR-01, 17-REVIEW).
 *
 * Discriminates hex vs base64url by SHAPE (exact length + alphabet), NOT by
 * alphabet alone: every hex character is also in the base64url alphabet, so an
 * alphabet-only test silently mis-decodes a 64-char hex digest through the
 * base64url branch, producing wrong bytes that would then be signed.
 *
 * Accepted shapes (all encode a 32-byte SHA-256 digest):
 *   - Uint8Array          — legacy device path before the node-crypto polyfill fix
 *   - 43-char base64url   — Node/Quereus 3.x and post-fix device (unpadded)
 *   - 64-char hex         — defensive fallback for a future format change
 * Anything else throws loudly instead of signing garbage.
 *
 * Do NOT use Buffer.isBuffer() — Buffer is not available on Hermes.
 *
 * Promoted from elections-engine.ts to a shared internal util (WR-01 single source of truth).
 * Both user-engine.ts and elections-engine.ts import this implementation.
 */
export function digestToBytes (d: unknown): Uint8Array {
  if (d instanceof Uint8Array) return d
  if (typeof d !== 'string') {
    throw new Error(`digestToBytes: unrecognized Digest() output type: ${typeof d}`)
  }
  if (d.length === 64 && /^[0-9a-fA-F]+$/.test(d)) return hexToBytes(d)
  if (d.length === 43 && /^[A-Za-z0-9_-]+$/.test(d)) {
    // base64url — decode with standard base64 after restoring padding (43 → 44 chars).
    const b64 = d.replace(/-/g, '+').replace(/_/g, '/').padEnd(44, '=')
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  }
  throw new Error(`digestToBytes: unrecognized Digest() output shape: len=${d.length}`)
}

/**
 * Inverse of `digestToBytes`'s base64url branch — encode raw bytes as
 * unpadded base64url. Used to feed a locally-computed sha256 hash into
 * `verifySig()`, which (matching the SQL `SignatureValid` UDF's contract)
 * expects its `digest` argument as base64url.
 *
 * 999.1 D-11/D-12: added for the InviteSlot/InviteResult engine-side
 * verifySig carve-out (R-03) — the FIRST base64url encoder in vote-engine
 * (all prior digest handling was decode-only, since `Digest()` output came
 * from SQL).
 */
export function bytesToBase64url (bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  const b64 = btoa(binary)
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Reproduce `AuthorityEngine.createAuthorityInvite`'s exact signed-bytes
 * domain (999.1 R-03 carve-out — an ad-hoc pipe-joined `TextEncoder` byte
 * string, NOT the canonical SQL `Digest()`). Field order MUST match the
 * producer verbatim: `[type, name, expiration].join('|')`.
 */
export function authorityInviteSignedBytes (fields: { type: string; name: string; expiration: string }): Uint8Array {
  return new TextEncoder().encode([fields.type, fields.name, fields.expiration].join('|'))
}

/**
 * Reproduce `AuthorityEngine.createOfficerInvite`'s exact signed-bytes
 * domain (999.1 R-03 carve-out). Field order MUST match the producer
 * verbatim: `[name, title, JSON.stringify(scopes), type, expiration,
 * inviteKey].join('|')`.
 */
export function officerInviteSignedBytes (fields: {
  name: string
  title: string
  scopes: unknown
  type: string
  expiration: string
  inviteKey: string
}): Uint8Array {
  return new TextEncoder().encode(
    [fields.name, fields.title, JSON.stringify(fields.scopes), fields.type, fields.expiration, fields.inviteKey].join('|')
  )
}

/**
 * Reproduce `InvitationEngine.respondToInvite`'s A1 LOCKED ENCODING
 * signed-bytes domain for `InviteResult.InviteSignature`:
 * `[slotCid, digestToken, String(accept)].join('|')`, where `digestToken`
 * is the value being written to `InviteResult.Digest` coerced to a string
 * (or the literal `'null'` for a decline, whose `Digest` column is null).
 */
export function inviteResultSignedBytes (fields: { slotCid: string; digestToken: string; accept: boolean }): Uint8Array {
  return new TextEncoder().encode([fields.slotCid, fields.digestToken, String(fields.accept)].join('|'))
}

/**
 * Verify a secp256k1 signature over an ad-hoc (non-canonical-`Digest()`)
 * byte domain — the InviteSlot/InviteResult 999.1 R-03 engine-side carve-out
 * (D-11/D-12's original "engine-side" approach, scoped to just these two
 * signature sites). Hashes `signedBytes` once (matching the producer's
 * `secp256k1.sign(sha256(signedBytes), invitePrivateBytes)` call — noble v2's
 * `prehash:true` default applies the SECOND sha256 inside both `sign()` and
 * `verify()`), base64url-encodes the result, and delegates to the shared
 * `verifySig()` primitive (same encoding contract as the in-schema
 * `SignatureValid` UDF: digest base64url, signature/key hex — Pitfall 6, a
 * mismatch here silently fails closed).
 */
export function verifyAdHocInviteSignature (
  signedBytes: Uint8Array,
  signatureHex: string | null | undefined,
  signerKeyHex: string | null | undefined
): boolean {
  if (!signatureHex || !signerKeyHex) return false
  const digestB64url = bytesToBase64url(sha256(signedBytes))
  return verifySig(digestB64url, signatureHex, signerKeyHex)
}

// H16 hash function
export function H16 (input: string): string {
  // noble/hashes v2 requires bytes (v1 accepted strings and applied utf8ToBytes
  // internally); sha256(utf8ToBytes(input)) is byte-identical to the v1 result.
  const hash = sha256(utf8ToBytes(input))
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
