import type { RegisterInit, RegistrationDuplicateMatchSignal } from '@votetorrent/vote-core'

/**
 * duplicate-detection.ts — Phase 62 Plan 19 (D-43/D-44): the ONE pure, Hermes-safe
 * implementation of "do these two pending registration requests look like the same person,
 * restarted on a new device?"
 *
 * This is deliberately an EXACT match after normalization — no fuzzy, phonetic, or edit-distance
 * matching (62-RESEARCH-CONTINUITY.md A4, Claude's discretion) — so a flag the officer sees is
 * always explainable by naming the fields that agreed. `name`/`dob`/`email`/`phone` are each
 * folded through the SAME normalization (`foldIdentityText`), and `email`/`phone` are NEVER
 * enough to flag a pair on their own: a shared family email or phone number is common and would
 * otherwise produce false positives between strangers.
 *
 * This module is pure (no I/O, no DB) and Hermes-safe: no Node import, no Unicode property escape
 * (the `p`-prefixed brace syntax is not reliably supported on a Hermes build without ICU — use the
 * explicit combining-mark range below instead), and every `String.prototype.normalize` call is
 * wrapped in its own `try` so a Hermes build that lacks ICU degrades to an un-decomposed compare
 * rather than throwing.
 *
 * It must NEVER persist or log anything it computes (T-62-01-10): the identity values it reads
 * come from the authority's own already-decrypted `RegistrationRequest.Payload` (today's
 * pre-existing plaintext-at-rest finding, not widened by this module), and the ONLY things that
 * leave this module are request ids, timestamps, public display names already visible on the
 * inbox row, and signal NAMES (never a date of birth, email, or phone VALUE).
 */

/** D-44: the signal vocabulary, in the fixed display/ordering order every caller uses. */
export const DUPLICATE_MATCH_SIGNAL_ORDER: readonly RegistrationDuplicateMatchSignal[] =
  ['requester-key', 'name', 'dob', 'email', 'phone']

/** The `PrivateDetail.name` values (case-insensitively matched) `extractRegistrationIdentity`
 *  reads out of `payload.private.details`. */
export const DUPLICATE_IDENTITY_DETAIL_NAMES: { readonly dob: 'dob'; readonly email: 'email'; readonly phone: 'phone' } = {
  dob: 'dob',
  email: 'email',
  phone: 'phone'
}

/** A phone value folded to fewer digits than this is treated as unusable (too short to be a real
 *  phone number, and too likely to produce an accidental digit-substring match). */
export const DUPLICATE_PHONE_MIN_DIGITS = 7

/** The normalized identity signals extracted from one pending request's payload. Every field is
 *  absent, never an empty string — an absent field can never equal another absent field. */
export interface RegistrationIdentityKey {
  readonly name?: string
  readonly dob?: string
  readonly email?: string
  readonly phone?: string
}

/** The minimal per-request shape `findLikelyDuplicates`/`matchRegistrationIdentities` compare —
 *  built by the caller (`RegistrationEngine.readPendingComparables`) from a `RegistrationRequest`
 *  row, never from this module. */
export interface DuplicateComparable {
  readonly requestId: string
  readonly authorityId: string
  readonly requesterKey: string
  readonly receivedAt: string
  readonly identity: RegistrationIdentityKey
}

const COMBINING_MARKS = /[̀-ͯ҃-҉֑-ֽ]/g

/**
 * Step 1/2/3 of every identity-field fold: a finite number becomes its decimal string, a string
 * is used as-is, anything else (object, array, boolean, null, undefined) is rejected outright —
 * then NFKD-decompose (wrapped — Hermes without ICU either lacks `normalize` or throws on it, and
 * either way the un-decomposed string is still a safe, honest fallback), strip combining marks,
 * lowercase, and trim. An empty result folds to `undefined`, never `''` — an empty string would
 * equal another empty string and manufacture a false match between two requests that both simply
 * omitted the field.
 */
export function foldIdentityText (value: unknown): string | undefined {
  let s: string
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined
    s = String(value)
  } else if (typeof value === 'string') {
    s = value
  } else {
    return undefined
  }

  try {
    s = s.normalize('NFKD')
  } catch {
    // Hermes without ICU: keep the un-decomposed string.
  }
  s = s.replace(COMBINING_MARKS, '').toLowerCase().trim()
  return s.length === 0 ? undefined : s
}

/**
 * The name-specific fold layered on top of `foldIdentityText`: hyphens/underscores become spaces
 * (so "Pérez-Gómez" and "Perez Gomez" fold identically), a small set of apostrophe/quote/comma
 * marks are dropped outright (so "O'Brien" folds to "obrien"), and internal whitespace runs
 * collapse to one space.
 */
export function normalizeNamePart (value: unknown): string | undefined {
  const folded = foldIdentityText(value)
  if (folded === undefined) return undefined
  const s = folded
    .replace(/[-_]/g, ' ')
    .replace(/['‘’.,`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return s.length === 0 ? undefined : s
}

function foldDob (value: unknown): string | undefined {
  const folded = foldIdentityText(value)
  if (folded === undefined) return undefined
  const s = folded.replace(/[^0-9a-z]/g, '')
  return s.length === 0 ? undefined : s
}

function foldEmail (value: unknown): string | undefined {
  const folded = foldIdentityText(value)
  if (folded === undefined) return undefined
  const s = folded.replace(/\s+/g, '')
  const at = s.indexOf('@')
  if (at <= 0 || at === s.length - 1) return undefined
  if (s.indexOf('@', at + 1) !== -1) return undefined
  return s
}

function foldPhone (value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  if (typeof value === 'number' && !Number.isFinite(value)) return undefined
  const digits = String(value).replace(/\D/g, '')
  return digits.length >= DUPLICATE_PHONE_MIN_DIGITS ? digits : undefined
}

/**
 * Reads `payload.public.firstName`/`lastName` and the FIRST top-level `payload.private.details`
 * entry (case-insensitive name match) for each of `dob`/`email`/`phone` — only a scalar
 * `string | number` value counts; an array or object value (a nested detail group) is ignored for
 * that field. Never throws: a missing `public`, a missing/non-array `private.details`, or an
 * `undefined` payload all yield an identity with every field absent.
 */
export function extractRegistrationIdentity (payload: RegisterInit | undefined): RegistrationIdentityKey {
  const first = normalizeNamePart(payload?.public?.firstName)
  const last = normalizeNamePart(payload?.public?.lastName)
  const name = first !== undefined && last !== undefined ? `${first}|${last}` : undefined

  let dob: string | undefined
  let email: string | undefined
  let phone: string | undefined

  const details = payload?.private?.details
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) continue
      const detailName = (detail as { name?: unknown }).name
      if (typeof detailName !== 'string') continue
      const value = (detail as { value?: unknown }).value
      if (typeof value !== 'string' && typeof value !== 'number') continue
      const lowerName = detailName.toLowerCase()
      if (dob === undefined && lowerName === DUPLICATE_IDENTITY_DETAIL_NAMES.dob) {
        dob = foldDob(value)
      } else if (email === undefined && lowerName === DUPLICATE_IDENTITY_DETAIL_NAMES.email) {
        email = foldEmail(value)
      } else if (phone === undefined && lowerName === DUPLICATE_IDENTITY_DETAIL_NAMES.phone) {
        phone = foldPhone(value)
      }
    }
  }

  return { name, dob, email, phone }
}

/**
 * The D-44 match rule, implemented exactly once. Returns the matched signals (in
 * `DUPLICATE_MATCH_SIGNAL_ORDER`) when the pair is FLAGGED, else `undefined`.
 *
 * Not a pair at all (returns `undefined` immediately, no signals computed) when the request ids
 * are equal or the authority ids differ.
 *
 * Flagged when (`name` matched AND NOT a dob conflict) OR (`requester-key` matched AND NOT a name
 * conflict AND NOT a dob conflict). `email`/`phone` are reported as SUPPORTING signals when they
 * also match, but never flag a pair on their own — a shared family email or phone is common and
 * must not manufacture a false positive between two different people.
 */
export function matchRegistrationIdentities (a: DuplicateComparable, b: DuplicateComparable): RegistrationDuplicateMatchSignal[] | undefined {
  if (a.requestId === b.requestId || a.authorityId !== b.authorityId) return undefined

  const nameMatch = a.identity.name !== undefined && a.identity.name === b.identity.name
  const nameConflict = a.identity.name !== undefined && b.identity.name !== undefined && a.identity.name !== b.identity.name
  const dobMatch = a.identity.dob !== undefined && a.identity.dob === b.identity.dob
  const dobConflict = a.identity.dob !== undefined && b.identity.dob !== undefined && a.identity.dob !== b.identity.dob
  const requesterKeyMatch = a.requesterKey === b.requesterKey
  const emailMatch = a.identity.email !== undefined && a.identity.email === b.identity.email
  const phoneMatch = a.identity.phone !== undefined && a.identity.phone === b.identity.phone

  const flagged =
    (nameMatch && !dobConflict) ||
    (requesterKeyMatch && !nameConflict && !dobConflict)
  if (!flagged) return undefined

  const signals: RegistrationDuplicateMatchSignal[] = []
  if (requesterKeyMatch) signals.push('requester-key')
  if (nameMatch) signals.push('name')
  if (dobMatch) signals.push('dob')
  if (emailMatch) signals.push('email')
  if (phoneMatch) signals.push('phone')
  return signals
}

/**
 * Compares `target` against every entry of `others`, skipping `target`'s own id, and returns the
 * flagged candidates sorted oldest-`receivedAt`-first (then `requestId` ascending as a tiebreak),
 * with an unparseable `receivedAt` sorted last.
 */
export function findLikelyDuplicates (
  target: DuplicateComparable,
  others: readonly DuplicateComparable[]
): Array<{ readonly comparable: DuplicateComparable; readonly matchedOn: RegistrationDuplicateMatchSignal[] }> {
  const out: Array<{ comparable: DuplicateComparable; matchedOn: RegistrationDuplicateMatchSignal[] }> = []
  for (const other of others) {
    if (other.requestId === target.requestId) continue
    const matchedOn = matchRegistrationIdentities(target, other)
    if (matchedOn !== undefined) out.push({ comparable: other, matchedOn })
  }

  out.sort((x, y) => {
    const xMs = Date.parse(x.comparable.receivedAt)
    const yMs = Date.parse(y.comparable.receivedAt)
    const xValid = !Number.isNaN(xMs)
    const yValid = !Number.isNaN(yMs)
    if (xValid && yValid && xMs !== yMs) return xMs - yMs
    if (xValid !== yValid) return xValid ? -1 : 1
    return x.comparable.requestId < y.comparable.requestId ? -1 : x.comparable.requestId > y.comparable.requestId ? 1 : 0
  })
  return out
}
