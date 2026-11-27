// src/bootstrap/sealed-payload.ts — the bootstrap rendezvous key split
// (D-04) and the sealed-payload wrapper (D-05; Phase 52 Plan 01).
//
// ---------------------------------------------------------------------------
// Why the key split is FORCED, not preferred
// ---------------------------------------------------------------------------
//
// The rendezvous service's `redeem()` is called with the SECRET ITSELF — that
// is how a redemption proves it holds the code. So the service sees the raw
// secret on every redemption, unavoidably. If the cipher were keyed on that
// same secret, the service would hold the decryption key alongside the
// ciphertext and the whole sealing exercise would be theatre.
//
// D-04 therefore splits the secret into two domain-separated halves:
//
//   lookupId   = HMAC-SHA256(key = 'bootstrap-lookup',  msg = secret)
//                base64url — THIS is what goes to the service. It is also the
//                record identifier the payload is stored under, and 52-03
//                uses it as a filesystem path segment, so it must satisfy
//                `filesystem-bootstrap-transport.ts:43`'s SAFE_IDENTIFIER_PATTERN.
//
//   contentKey = HMAC-SHA256(key = 'bootstrap-content', msg = secret)
//                32 RAW BYTES. **This half has no wire form.** Nothing in
//                this module serializes it, it is never a string, and it must
//                never be placed in the wrapper, a log line, a `detail`
//                string or a URL. It exists only in the phone's process and,
//                after redemption, in the browser's.
//
// Note the HMAC argument order: the LABEL occupies the key slot and the
// SECRET is the message. Swapping them still yields 32 plausible bytes, which
// is exactly why `sealed-payload.spec.ts`'s KAT-1 pins the bytes against an
// independent OpenSSL implementation instead of merely checking a length.
//
// ---------------------------------------------------------------------------
// The wrapper is OUTER — it never modifies the envelope
// ---------------------------------------------------------------------------
//
// `snapshot-types.ts:1-25` is explicit that neither producer nor consumer may
// redefine an envelope field name or the digest's scope. This module wraps a
// serialized `BootstrapSnapshot` whole and returns it whole; `parseSnapshot`
// then `verifySnapshot` run afterwards, unchanged. Sealing adds
// confidentiality against the service and changes nothing about integrity.
//
// ---------------------------------------------------------------------------
// Three-runtime purity (Node / Hermes / browser)
// ---------------------------------------------------------------------------
//
// This module is part of the `./bootstrap` barrel, which is bundled into BOTH
// the browser dashboard and the React Native app. It therefore contains:
//
//   - no `node:` import, no bare 'crypto' / 'fs' / 'path' / 'buffer' import,
//   - no reference to Node's byte-buffer type, and no CommonJS-style
//     dynamic module call,
//   - no import of `../utils.js`, whose transitive `./database/initialize.js`
//     would drag the Quereus layer into a browser bundle. That is the same
//     reason `assertCanonicalBootstrapDatetime` is declared locally in
//     `bootstrap-transport.ts:109` rather than imported. The consequence is
//     that `bytesToBase64url` from `../utils.js` is NOT reusable here, so the
//     base64url helpers below are module-private re-implementations of the
//     `btoa`/`atob` idioms already used by `snapshot-codec.ts:209-229`.
//
// `btoa`/`atob` are globals on Hermes, in browsers and in Node (see
// `device-signer.ts:143`). `crypto.getRandomValues`, which noble's
// `randomBytes` uses, is present on Hermes via `react-native-get-random-values`
// (`polyfills.bootstrap.js:26-31`).
//
// `TextDecoder` is touched only at CALL time, inside `bytesToUtf8` on the
// unseal path. Importing this module is safe everywhere; *calling*
// `unsealPayload` needs `TextDecoder`, which the browser and Node both have.
// That is by design, not an oversight: under D-06 unsealing happens in the
// browser consumer, never on the phone. Recorded here rather than worked
// around.
//
// Why `@noble/ciphers` at all: the phone has no AES today.
// `polyfills.bootstrap.js:51-64` installs a DIGEST-ONLY `crypto.subtle` shim
// whose `importKey`/`encrypt`/`sign` are deliberately throwing stubs.

import { gcm } from '@noble/ciphers/aes.js'
import { bytesToUtf8 } from '@noble/ciphers/utils.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'

// ---------------------------------------------------------------------------
// Locked constants
// ---------------------------------------------------------------------------

/** The literal format version for this phase. Never widened to `number` — mirrors `SNAPSHOT_FORMAT_VERSION` (`snapshot-types.ts:28`). */
export const SEALED_PAYLOAD_FORMAT_VERSION: 1 = 1

/** AES-GCM nonce length in bytes. 12 is the only value this format accepts. */
export const SEALED_PAYLOAD_NONCE_BYTES = 12

/** AES-256 key length in bytes — the width of `contentKey`. */
export const SEALED_PAYLOAD_KEY_BYTES = 32

/** The shortest secret `deriveBootstrapKeys` will accept. The real mint (`dashboard-signin-code.ts:251`) draws 20. */
export const BOOTSTRAP_SECRET_MIN_BYTES = 16

/** HMAC label for the half the rendezvous service sees. */
export const BOOTSTRAP_LOOKUP_LABEL = 'bootstrap-lookup'

/** HMAC label for the half the rendezvous service must never see. */
export const BOOTSTRAP_CONTENT_LABEL = 'bootstrap-content'

/** AES-GCM tag length in bytes. Module-private: it is an invariant of the mode, not a tuning knob. */
const GCM_TAG_BYTES = 16

/** Unpadded base64url, the only encoding this module reads or writes. */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The D-04 split of one bootstrap secret into a public half and a private half. */
export interface BootstrapKeySplit {
  /** base64url, 43 characters. The record identifier handed to the rendezvous service. */
  readonly lookupId: string
  /**
   * 32 raw bytes. **This value never leaves the phone or the browser** —
   * nothing in this module serializes it, logs it, or places it in a wrapper.
   */
  readonly contentKey: Uint8Array
}

/** The sealed wrapper that crosses the wire. Exactly three members, all base64url strings except `v`. */
export interface SealedPayload {
  /** `SEALED_PAYLOAD_FORMAT_VERSION`. */
  readonly v: number
  /** The 12-byte GCM nonce, base64url. */
  readonly nonce: string
  /** Ciphertext with the 16-byte GCM tag already appended, base64url. */
  readonly ciphertext: string
}

/**
 * Why there are only three reasons, and not four or five: wrong key, tampered
 * ciphertext and wrong AAD all collapse into `authentication-failed`.
 */
export type SealedUnsealFailureReason =
  | 'malformed-wrapper'
  | 'unsupported-version'
  | 'authentication-failed'

/**
 * Fail-closed result, mirroring `SnapshotParseResult` (`snapshot-codec.ts:1-30`).
 * `plaintext` is present IF AND ONLY IF `ok` is true — a refusal carries no
 * `plaintext` member at all, so a caller cannot consume a partial artifact.
 */
export type SealedUnsealResult =
  | { readonly ok: true, readonly plaintext: string }
  | { readonly ok: false, readonly reason: SealedUnsealFailureReason, readonly detail: string }

// ---------------------------------------------------------------------------
// Module-private base64url (browser/Hermes-safe: btoa/atob, never a byte buffer type)
// ---------------------------------------------------------------------------

/** Encode bytes as unpadded base64url. Mirrors `bytesToBase64url`'s idiom without importing `../utils.js`. */
function bytesToBase64url (bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Decode unpadded base64url. Returns `null` — never throws, never coerces —
 * for anything outside the URL alphabet, so a `+`, a `/` or an `=` in
 * attacker-influenceable input becomes a structural refusal rather than
 * whatever `atob` happens to do with it.
 */
function base64urlToBytes (value: string): Uint8Array | null {
  if (!BASE64URL_PATTERN.test(value)) return null
  let b64 = value.replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4 !== 0) b64 += '='
  let binary: string
  try {
    binary = atob(b64)
  } catch {
    return null
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// ---------------------------------------------------------------------------
// D-04 — the key split
// ---------------------------------------------------------------------------

/**
 * Split a bootstrap secret into its public `lookupId` and its private
 * `contentKey`. Accepts the raw `Uint8Array` the mint produces
 * (`dashboard-signin-code.ts:251-253`) — 52-06 derives from those bytes
 * directly, never from a hex round trip.
 *
 * Throws (rather than returning a result) because a bad secret here is a
 * PROGRAMMER error on the trusted side of the boundary, not attacker input.
 * The message names the constraint and the OBSERVED LENGTH only — never a
 * byte of the secret (T-52-01-07), the same discipline as
 * `assertKnownBootstrapRedemptionStatus` (`bootstrap-transport.ts:70-86`).
 */
export function deriveBootstrapKeys (secretBytes: Uint8Array): BootstrapKeySplit {
  if (!(secretBytes instanceof Uint8Array)) {
    throw new TypeError(
      `deriveBootstrapKeys: secretBytes must be a Uint8Array (got ${secretBytes === null ? 'null' : typeof secretBytes})`
    )
  }
  if (secretBytes.length < BOOTSTRAP_SECRET_MIN_BYTES) {
    throw new RangeError(
      `deriveBootstrapKeys: secretBytes must be at least ${BOOTSTRAP_SECRET_MIN_BYTES} bytes (got ${secretBytes.length})`
    )
  }

  // Label in HMAC's KEY slot, secret in the MESSAGE slot. Do not swap these.
  const lookupBytes = hmac(sha256, utf8ToBytes(BOOTSTRAP_LOOKUP_LABEL), secretBytes)
  const contentKey = hmac(sha256, utf8ToBytes(BOOTSTRAP_CONTENT_LABEL), secretBytes)

  return { lookupId: bytesToBase64url(lookupBytes), contentKey }
}

// ---------------------------------------------------------------------------
// D-05 — seal
// ---------------------------------------------------------------------------

function assertKeySplit (keys: BootstrapKeySplit, where: string): void {
  if (keys === null || typeof keys !== 'object') {
    throw new TypeError(`${where}: keys must be a BootstrapKeySplit`)
  }
  if (!(keys.contentKey instanceof Uint8Array) || keys.contentKey.length !== SEALED_PAYLOAD_KEY_BYTES) {
    throw new TypeError(
      `${where}: keys.contentKey must be a ${SEALED_PAYLOAD_KEY_BYTES}-byte Uint8Array (got ${
        keys.contentKey instanceof Uint8Array ? `${keys.contentKey.length} bytes` : typeof keys.contentKey
      })`
    )
  }
  if (typeof keys.lookupId !== 'string' || keys.lookupId.length === 0) {
    throw new TypeError(`${where}: keys.lookupId must be a non-empty string`)
  }
}

/**
 * Deterministic seal. **TEST AND KNOWN-ANSWER-VECTOR USE ONLY.**
 *
 * A repeated nonce under one AES-GCM key is catastrophic: it forfeits BOTH
 * confidentiality (the keystream repeats, so XORing two ciphertexts reveals
 * the XOR of the plaintexts) AND authentication (the GHASH authentication key
 * becomes recoverable, letting an attacker forge tags at will). Production
 * code must call `sealPayload`, which always draws a fresh nonce.
 *
 * This function is deliberately NOT re-exported from `src/bootstrap/index.ts`,
 * so it is unreachable through the `@votetorrent/vote-engine/bootstrap`
 * subpath that both apps import — the only import path that reaches it is a
 * deep source path, which nothing but this package's own tests uses.
 */
export function sealPayloadWithNonce (
  plaintextUtf8: string,
  keys: BootstrapKeySplit,
  nonce: Uint8Array
): SealedPayload {
  assertKeySplit(keys, 'sealPayloadWithNonce')
  if (!(nonce instanceof Uint8Array) || nonce.length !== SEALED_PAYLOAD_NONCE_BYTES) {
    throw new TypeError(
      `sealPayloadWithNonce: nonce must be a ${SEALED_PAYLOAD_NONCE_BYTES}-byte Uint8Array (got ${
        nonce instanceof Uint8Array ? `${nonce.length} bytes` : typeof nonce
      })`
    )
  }
  if (typeof plaintextUtf8 !== 'string') {
    throw new TypeError(`sealPayloadWithNonce: plaintextUtf8 must be a string (got ${typeof plaintextUtf8})`)
  }

  // `lookupId` is bound verbatim as GCM additional authenticated data, welding
  // the wrapper to the record identity it was uploaded under.
  //
  // Be honest about what this buys TODAY: because `contentKey` and `lookupId`
  // derive from the same secret, a ciphertext swapped between two records
  // already fails on the wrong key. So the AAD is defence in depth against a
  // future `v` that separates record identity from key derivation — not the
  // primary control. It is not load-bearing yet; it will be.
  const cipher = gcm(keys.contentKey, nonce, utf8ToBytes(keys.lookupId))
  const ciphertext = cipher.encrypt(utf8ToBytes(plaintextUtf8))

  return {
    v: SEALED_PAYLOAD_FORMAT_VERSION,
    nonce: bytesToBase64url(nonce),
    ciphertext: bytesToBase64url(ciphertext)
  }
}

/**
 * Seal a UTF-8 payload under the split's `contentKey`, with the split's
 * `lookupId` bound as AAD. A fresh 12-byte nonce is drawn per call from
 * noble's `randomBytes` (which uses `crypto.getRandomValues`); the nonce is
 * never a caller input on this path, which is what makes nonce reuse
 * unreachable from production code (T-52-01-05).
 */
export function sealPayload (plaintextUtf8: string, keys: BootstrapKeySplit): SealedPayload {
  return sealPayloadWithNonce(plaintextUtf8, keys, randomBytes(SEALED_PAYLOAD_NONCE_BYTES))
}

// ---------------------------------------------------------------------------
// D-05 — unseal
// ---------------------------------------------------------------------------

function fail (reason: SealedUnsealFailureReason, detail: string): SealedUnsealResult {
  return { ok: false, reason, detail }
}

/**
 * Unseal a wrapper. **Never throws.** The wrapper comes back from the
 * rendezvous service, which is attacker-influenceable input, so this fails
 * closed with a reason exactly the way `parseSnapshot` (`snapshot-codec.ts:147`)
 * does.
 *
 * The check ORDER is part of the contract and must not be rearranged:
 *
 *   1. structural validation                       -> 'malformed-wrapper'
 *   2. version equality against the literal        -> 'unsupported-version'
 *   3. base64url decode + nonce length             -> 'malformed-wrapper'
 *   4. authenticated decryption                    -> 'authentication-failed'
 *
 * Step 2 runs BEFORE any decryption is attempted. That ordering is what makes
 * a version mismatch report `unsupported-version` rather than a misleading
 * `authentication-failed`, and NC-4 in `sealed-payload.spec.ts` asserts
 * exactly that (it asserts the reason is NOT `authentication-failed`, which
 * is the only way to prove decryption did not run first).
 *
 * WRONG KEY, TAMPERED CIPHERTEXT AND WRONG AAD ALL RETURN THE SAME
 * `authentication-failed` REASON. This is deliberate and must not be
 * "improved": a reason that distinguished them would be a decryption oracle,
 * telling an attacker which half of their guess was right. A ciphertext
 * shorter than the 16-byte GCM tag is refused on the same path, for the same
 * reason — ciphertext length must not be separately distinguishable either.
 * The spec asserts each of the three cases independently anyway
 * (T-52-01-06, accepted).
 *
 * `detail` strings name STRUCTURE only: a member name, an observed byte
 * length, an observed `v`. Never a byte of ciphertext, key or plaintext.
 */
export function unsealPayload (sealed: unknown, keys: BootstrapKeySplit): SealedUnsealResult {
  // --- 1. structural ------------------------------------------------------
  if (sealed === null) return fail('malformed-wrapper', 'sealed payload: wrapper is null')
  if (Array.isArray(sealed)) return fail('malformed-wrapper', 'sealed payload: wrapper is an array, not an object')
  if (typeof sealed !== 'object') {
    return fail('malformed-wrapper', `sealed payload: wrapper is not an object (got ${typeof sealed})`)
  }

  const wrapper = sealed as Record<string, unknown>

  for (const member of ['v', 'nonce', 'ciphertext']) {
    if (!(member in wrapper)) {
      return fail('malformed-wrapper', `sealed payload: wrapper is missing member '${member}'`)
    }
  }
  if (typeof wrapper.v !== 'number' || !Number.isInteger(wrapper.v)) {
    return fail('malformed-wrapper', `sealed payload: member 'v' is not an integer (got ${typeof wrapper.v})`)
  }
  if (typeof wrapper.nonce !== 'string') {
    return fail('malformed-wrapper', `sealed payload: member 'nonce' is not a string (got ${typeof wrapper.nonce})`)
  }
  if (typeof wrapper.ciphertext !== 'string') {
    return fail('malformed-wrapper', `sealed payload: member 'ciphertext' is not a string (got ${typeof wrapper.ciphertext})`)
  }

  // --- 2. version, BEFORE any decryption ----------------------------------
  if (wrapper.v !== SEALED_PAYLOAD_FORMAT_VERSION) {
    return fail(
      'unsupported-version',
      `sealed payload: unsupported format version ${wrapper.v} (expected ${SEALED_PAYLOAD_FORMAT_VERSION})`
    )
  }

  // --- 3. decode + nonce length -------------------------------------------
  const nonce = base64urlToBytes(wrapper.nonce)
  if (nonce === null) {
    return fail('malformed-wrapper', "sealed payload: member 'nonce' is not unpadded base64url")
  }
  if (nonce.length !== SEALED_PAYLOAD_NONCE_BYTES) {
    return fail(
      'malformed-wrapper',
      `sealed payload: member 'nonce' decoded to ${nonce.length} bytes (expected ${SEALED_PAYLOAD_NONCE_BYTES})`
    )
  }
  const ciphertext = base64urlToBytes(wrapper.ciphertext)
  if (ciphertext === null) {
    return fail('malformed-wrapper', "sealed payload: member 'ciphertext' is not unpadded base64url")
  }

  // --- 4. authenticated decryption ----------------------------------------
  // Everything below is inside the try, including the cipher construction: a
  // malformed local `keys` would otherwise throw out of a function whose
  // contract is that it never throws.
  let plaintextBytes: Uint8Array
  try {
    plaintextBytes = gcm(keys.contentKey, nonce, utf8ToBytes(keys.lookupId)).decrypt(ciphertext)
  } catch {
    // The caught error's message is DISCARDED on purpose. Reporting it would
    // distinguish a wrong key from a tag mismatch from a short ciphertext.
    return fail(
      'authentication-failed',
      `sealed payload: authenticated decryption failed over ${ciphertext.length} ciphertext bytes (tag length ${GCM_TAG_BYTES})`
    )
  }

  let plaintext: string
  try {
    plaintext = bytesToUtf8(plaintextBytes)
  } catch {
    // Unreachable for anything this module sealed, since the input was a
    // JS string. Kept because `unsealPayload` may not throw, ever.
    return fail('malformed-wrapper', 'sealed payload: decrypted bytes are not valid UTF-8')
  }

  return { ok: true, plaintext }
}
