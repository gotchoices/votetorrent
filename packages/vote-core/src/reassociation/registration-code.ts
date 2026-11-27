/**
 * 62-18 (D-45) — pure, dependency-free registration-code format helpers. Imports nothing (not
 * even a sibling vote-core module): `deriveRegistrationCode` (vote-engine, which DOES hold crypto
 * imports) is the only place that turns an identity-key signature into code bits; everything here
 * is a pure string/byte transform so it can run identically on the registering device (encode),
 * the re-associating device (normalize/format) and the authority (constant-time compare).
 *
 * The code is 50 bits (Crockford base32, 10 characters) — deliberately short enough to be
 * copy-typed by a voter, long enough that online guessing is infeasible: every guess is a signed,
 * replicated, officer-visible `AssociationRequestStaging` row (D-45), and an unmatched code never
 * auto-approves (D-46) — there is no silent oracle a guesser can probe faster than the authority
 * can see the attempt.
 */

/** Crockford base32 — digits 0-9 plus the 22 letters that are not easily confused with a digit or
 * each other (no I, L, O, U). */
export const REGISTRATION_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** 10 characters * 5 bits/char = 50 bits. */
export const REGISTRATION_CODE_LENGTH = 10

/** `'XXXXX-XXXXX'` — the 62-28 geometry fixture's `'WWWWW-WWWWW'` sizes against this constant. */
export const REGISTRATION_CODE_FORMATTED_LENGTH = 11

/** Domain-separation label for the PRF `deriveRegistrationCode` (vote-engine) computes the code
 * from — never published, never transmitted; only its derivation uses this string. */
export const REGISTRATION_CODE_DOMAIN = 'votetorrent/registration-code/v1'

/** Domain tag of the requester's signature over `sha256(domain + '\n' + requestId + '\n' + code)`
 * carried inside the sealed staging plaintext (V-3, D-45); verified officer-side against the
 * approved `RegistrationRequest.RequesterKey`. */
export const REGISTRATION_CODE_BINDING_DOMAIN = 'votetorrent/registration-code-binding/v1'

/**
 * Reads the first 50 bits of `bytes`, MSB-first, 5 bits per output character — a bit accumulator
 * over BYTES only (never a >8-bit shift, and never an arbitrary-precision integer type: Hermes
 * does not need either here). Throws
 * `TypeError` when fewer than 7 bytes (56 bits, >= the 50 needed) are supplied. Output is always
 * exactly `REGISTRATION_CODE_LENGTH` characters, each a member of `REGISTRATION_CODE_ALPHABET`.
 */
export function encodeRegistrationCodeBits (bytes: Uint8Array): string {
  if (bytes.length < 7) {
    throw new TypeError('encodeRegistrationCodeBits: requires at least 7 bytes (50 bits) of input')
  }

  const totalBits = REGISTRATION_CODE_LENGTH * 5
  const bits: number[] = []
  for (let byteIndex = 0; byteIndex < bytes.length && bits.length < totalBits; byteIndex++) {
    const byte = bytes[byteIndex]!
    for (let bitIndex = 7; bitIndex >= 0 && bits.length < totalBits; bitIndex--) {
      bits.push((byte >> bitIndex) & 1)
    }
  }

  let out = ''
  for (let i = 0; i < totalBits; i += 5) {
    let value = 0
    for (let j = 0; j < 5; j++) {
      value = (value << 1) | bits[i + j]!
    }
    out += REGISTRATION_CODE_ALPHABET[value]
  }
  return out
}

const AMBIGUOUS_CHAR_MAP: Record<string, string> = { O: '0', I: '1', L: '1' }

/**
 * Strips spaces and hyphens, uppercases, maps the three characters Crockford base32 treats as
 * ambiguous with a digit (`O` -> `0`, `I`/`L` -> `1`), and requires the result to be EXACTLY
 * `REGISTRATION_CODE_LENGTH` characters, every one a member of `REGISTRATION_CODE_ALPHABET`.
 * Returns `undefined` — never throws — for any input that fails any of those checks (wrong
 * length, or a character with no place in the alphabet, e.g. `U`).
 */
export function normalizeRegistrationCode (input: string): string | undefined {
  if (typeof input !== 'string') return undefined
  const stripped = input.replace(/[\s-]/g, '').toUpperCase()
  if (stripped.length !== REGISTRATION_CODE_LENGTH) return undefined

  let out = ''
  for (const ch of stripped) {
    const mapped = AMBIGUOUS_CHAR_MAP[ch] ?? ch
    if (!REGISTRATION_CODE_ALPHABET.includes(mapped)) return undefined
    out += mapped
  }
  return out
}

/** Normalizes `code` and inserts a hyphen at the midpoint (`'XXXXX-XXXXX'`). Throws `TypeError`
 * when `code` does not normalize (mirrors `encodeRegistrationCodeBits`'s throw-on-invalid-input
 * discipline — a formatter has nothing sensible to return for a code that was never valid). */
export function formatRegistrationCode (code: string): string {
  const normalized = normalizeRegistrationCode(code)
  if (normalized === undefined) {
    throw new TypeError('formatRegistrationCode: not a valid registration code')
  }
  return `${normalized.slice(0, 5)}-${normalized.slice(5, REGISTRATION_CODE_LENGTH)}`
}

/**
 * Normalizes both sides first; `false` whenever either side fails to normalize (never throws).
 * Otherwise folds the XOR of every character code with NO early exit (best-effort constant time
 * in JS — V8 may still short-circuit at the engine level, but this function itself never branches
 * on a partial mismatch), and returns `diff === 0`.
 */
export function registrationCodesEqual (a: string, b: string): boolean {
  const na = normalizeRegistrationCode(a)
  const nb = normalizeRegistrationCode(b)
  if (na === undefined || nb === undefined) return false

  let diff = 0
  for (let i = 0; i < REGISTRATION_CODE_LENGTH; i++) {
    diff |= na.charCodeAt(i) ^ nb.charCodeAt(i)
  }
  return diff === 0
}
