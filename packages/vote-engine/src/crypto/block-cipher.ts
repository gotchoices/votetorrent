// src/crypto/block-cipher.ts — the D-18 block-content cipher under the DKG
// joint public key Y.
//
// This is the encryption leg of the D-13 key loop. `doc/encryption-formats.md`
// section 3 is the normative specification this module implements verbatim.
//
// IMPORTANT: the vote/voter-record block producer does not exist anywhere in
// this repository today (research Finding 6, Open Q5). This module is only
// the D-18 cipher API that 62-20 integrates with `reconstructElectionKey`.
// Because the cipher cannot distinguish a wrong-but-valid scalar from
// tampering (both derive a KEK that fails the GCM tag, both collapse to
// 'authentication-failed'), **62-20 must assert `getPublicKey(s) == Y`
// before calling `decryptBlockContent`** — this module does not and cannot
// make that assertion itself, since it is never handed `Y` on the decrypt
// path, only `s`.
//
// Purity rules (see `encoding.ts`'s header for the full list): no
// `node:` import, no `../` import, no `console`, no `TextDecoder`, no
// reference to Node's byte-buffer type even in a comment.

import { secp256k1 } from '@noble/curves/secp256k1.js'
import { gcm } from '@noble/ciphers/aes.js'
import { equalBytes } from '@noble/ciphers/utils.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { base64urlToBytes, bytesToBase64url, ecdhX, encodeLengthPrefixed, hexToBytesStrict, isCompressedPublicKeyHex } from './encoding.js'

// ---------------------------------------------------------------------------
// Locked constants
// ---------------------------------------------------------------------------

export const BLOCK_CIPHER_FORMAT_VERSION: 1 = 1
export const BLOCK_CIPHER_ALG = 'vt-block-1' as const

const NONCE_BYTES = 12
const KDF_LENGTH = 64
const KC_BYTES = 32
const CONTENT_LABEL = 'vt-block-1/content'
const KEY_LABEL = 'vt-block-1/key'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BlockCipherBinding {
  readonly electionId: string
  readonly revision: number
  readonly blockId: string
}

export interface BlockCiphertext {
  readonly v: 1
  readonly alg: 'vt-block-1'
  readonly eph: string
  readonly nonce: string
  readonly kc: string
  readonly ct: string
}

export type BlockCipherErrorCode = 'invalid-joint-key' | 'invalid-binding' | 'invalid-plaintext'

export class BlockCipherError extends Error {
  readonly code: BlockCipherErrorCode

  constructor (code: BlockCipherErrorCode, message: string) {
    super(message)
    this.name = 'BlockCipherError'
    this.code = code
  }
}

export type BlockDecryptFailureReason =
  | 'invalid-argument'
  | 'malformed-ciphertext'
  | 'unsupported-version'
  | 'authentication-failed'

export type BlockDecryptResult =
  | { readonly ok: true, readonly plaintext: Uint8Array }
  | { readonly ok: false, readonly reason: BlockDecryptFailureReason, readonly detail: string }

export interface BlockCipherRandomness {
  readonly ephemeralSecretKey: Uint8Array
  readonly nonce: Uint8Array
}

// ---------------------------------------------------------------------------
// Encryption — input validation
// ---------------------------------------------------------------------------

function assertJointPublicKey (jointPublicKey: unknown, where: string): asserts jointPublicKey is string {
  if (typeof jointPublicKey !== 'string' || !isCompressedPublicKeyHex(jointPublicKey)) {
    throw new BlockCipherError(
      'invalid-joint-key',
      `${where}: jointPublicKey must be a valid compressed secp256k1 public key hex`
    )
  }
}

function assertPlaintext (plaintext: unknown, where: string): asserts plaintext is Uint8Array {
  if (!(plaintext instanceof Uint8Array)) {
    throw new BlockCipherError(
      'invalid-plaintext',
      `${where}: plaintext must be a Uint8Array (got ${plaintext === null ? 'null' : typeof plaintext})`
    )
  }
}

function assertBinding (binding: unknown, where: string): asserts binding is BlockCipherBinding {
  if (binding === null || typeof binding !== 'object') {
    throw new BlockCipherError('invalid-binding', `${where}: binding must be a BlockCipherBinding object`)
  }
  const b = binding as Record<string, unknown>
  if (typeof b.electionId !== 'string' || b.electionId.length === 0) {
    throw new BlockCipherError('invalid-binding', `${where}: binding.electionId must be a non-empty string`)
  }
  if (typeof b.blockId !== 'string' || b.blockId.length === 0) {
    throw new BlockCipherError('invalid-binding', `${where}: binding.blockId must be a non-empty string`)
  }
  if (typeof b.revision !== 'number' || !Number.isInteger(b.revision) || b.revision < 0 || !Number.isSafeInteger(b.revision)) {
    throw new BlockCipherError('invalid-binding', `${where}: binding.revision must be a non-negative safe integer`)
  }
}

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

/**
 * Encrypt block content under the joint election public key Y (D-18).
 * Throws `BlockCipherError` on bad input. `jointPublicKey` is Y as 66-char
 * hex; 62-20 converts noble's 33-byte Y with `bytesToHex`.
 */
export function encryptBlockContent (
  jointPublicKey: string,
  plaintext: Uint8Array,
  binding: BlockCipherBinding
): BlockCiphertext {
  assertJointPublicKey(jointPublicKey, 'encryptBlockContent')
  assertPlaintext(plaintext, 'encryptBlockContent')
  assertBinding(binding, 'encryptBlockContent')

  const randomness: BlockCipherRandomness = {
    ephemeralSecretKey: secp256k1.utils.randomSecretKey(),
    nonce: randomBytes(NONCE_BYTES)
  }
  return encryptBlockContentWithRandomness(jointPublicKey, plaintext, binding, randomness)
}

/**
 * Deterministic encrypt. **TEST AND KNOWN-ANSWER-VECTOR USE ONLY.** A
 * repeated ephemeral scalar or nonce is catastrophic in the same way a
 * repeated AES-GCM nonce always is (see `envelope.ts`'s equivalent warning).
 * Production code must call `encryptBlockContent`.
 *
 * One production caller, by design: `key-release/election-block.ts`'s pool-block pair
 * (`encryptPoolBlock` draws FRESH CSPRNG randomness and discloses it in the pool's `form`
 * message; `reencryptElectionBlock` lets each member re-derive the stored ciphertext from it
 * before signing — spike 102). Neither ever reuses randomness across blocks.
 *
 * This function is deliberately NOT re-exported from `src/crypto/index.ts`.
 */
export function encryptBlockContentWithRandomness (
  jointPublicKey: string,
  plaintext: Uint8Array,
  binding: BlockCipherBinding,
  randomness: BlockCipherRandomness
): BlockCiphertext {
  assertJointPublicKey(jointPublicKey, 'encryptBlockContentWithRandomness')
  assertPlaintext(plaintext, 'encryptBlockContentWithRandomness')
  assertBinding(binding, 'encryptBlockContentWithRandomness')
  if (!(randomness.ephemeralSecretKey instanceof Uint8Array) || !secp256k1.utils.isValidSecretKey(randomness.ephemeralSecretKey)) {
    throw new TypeError('encryptBlockContentWithRandomness: randomness.ephemeralSecretKey is not a valid scalar')
  }
  if (!(randomness.nonce instanceof Uint8Array) || randomness.nonce.length !== NONCE_BYTES) {
    throw new TypeError(`encryptBlockContentWithRandomness: randomness.nonce must be ${NONCE_BYTES} bytes`)
  }

  const yBytes = hexToBytesStrict(jointPublicKey, 33)!
  const ephPublicKeyBytes = secp256k1.getPublicKey(randomness.ephemeralSecretKey, true)
  const z = ecdhX(randomness.ephemeralSecretKey, yBytes)
  const salt = concatBytes(ephPublicKeyBytes, yBytes)
  const kdfOut = hkdf(sha256, z, salt, utf8ToBytes(KEY_LABEL), KDF_LENGTH)
  const k = kdfOut.slice(0, 32)
  const kc = kdfOut.slice(32, KDF_LENGTH)
  const aad = encodeLengthPrefixed([CONTENT_LABEL, binding.electionId, String(binding.revision), binding.blockId])
  const ct = gcm(k, randomness.nonce, aad).encrypt(plaintext)
  k.fill(0)

  return {
    v: BLOCK_CIPHER_FORMAT_VERSION,
    alg: BLOCK_CIPHER_ALG,
    eph: bytesToHex(ephPublicKeyBytes),
    nonce: bytesToBase64url(randomness.nonce),
    kc: bytesToBase64url(kc),
    ct: bytesToBase64url(ct)
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** Fixed member order v, alg, eph, nonce, kc, ct. */
export function serializeBlockCiphertext (ciphertext: BlockCiphertext): string {
  return JSON.stringify({
    v: ciphertext.v,
    alg: ciphertext.alg,
    eph: ciphertext.eph,
    nonce: ciphertext.nonce,
    kc: ciphertext.kc,
    ct: ciphertext.ct
  })
}

// ---------------------------------------------------------------------------
// Decryption
// ---------------------------------------------------------------------------

function fail (reason: BlockDecryptFailureReason, detail: string): BlockDecryptResult {
  return { ok: false, reason, detail }
}

/**
 * Decrypt block content with the joint election secret key s. **Never
 * throws.** `input` may come from a public block store that anyone may
 * submit to, so it is attacker-influenceable and fails closed with a
 * reason.
 *
 * Check order (normative, `doc/encryption-formats.md` section 3):
 *   1. local args (valid scalar, binding valid)        -> 'invalid-argument'
 *   2. parse + structural check (eph a valid point)     -> 'malformed-ciphertext'
 *   3. version/alg                                      -> 'unsupported-version'
 *   4. decode lengths (nonce 12, kc 32, ct >= 16)        -> 'malformed-ciphertext'
 *   5. ECDH, derive, compare kc, GCM decrypt — one try,
 *      every failure collapses to the SAME reason        -> 'authentication-failed'
 */
export function decryptBlockContent (
  jointSecretKey: Uint8Array,
  input: unknown,
  binding: BlockCipherBinding
): BlockDecryptResult {
  // --- 1. local args ---------------------------------------------------------
  if (!(jointSecretKey instanceof Uint8Array) || !secp256k1.utils.isValidSecretKey(jointSecretKey)) {
    return fail('invalid-argument', 'decryptBlockContent: jointSecretKey must be a valid 32-byte secp256k1 scalar')
  }
  if (binding === null || typeof binding !== 'object' ||
      typeof binding.electionId !== 'string' || binding.electionId.length === 0 ||
      typeof binding.blockId !== 'string' || binding.blockId.length === 0 ||
      typeof binding.revision !== 'number' || !Number.isInteger(binding.revision) ||
      binding.revision < 0 || !Number.isSafeInteger(binding.revision)) {
    return fail(
      'invalid-argument',
      'decryptBlockContent: binding must carry a non-empty electionId/blockId and a non-negative safe-integer revision'
    )
  }

  // --- 2. parse + structural check --------------------------------------------
  let candidate: unknown = input
  if (typeof input === 'string') {
    try {
      candidate = JSON.parse(input)
    } catch {
      return fail('malformed-ciphertext', 'decryptBlockContent: input string is not valid JSON')
    }
  }
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return fail('malformed-ciphertext', 'decryptBlockContent: input is not an object')
  }
  const obj = candidate as Record<string, unknown>
  for (const member of ['v', 'alg', 'eph', 'nonce', 'kc', 'ct']) {
    if (!(member in obj)) return fail('malformed-ciphertext', `decryptBlockContent: input is missing member '${member}'`)
  }
  if (typeof obj.eph !== 'string') return fail('malformed-ciphertext', "decryptBlockContent: member 'eph' is not a string")
  if (typeof obj.nonce !== 'string') return fail('malformed-ciphertext', "decryptBlockContent: member 'nonce' is not a string")
  if (typeof obj.kc !== 'string') return fail('malformed-ciphertext', "decryptBlockContent: member 'kc' is not a string")
  if (typeof obj.ct !== 'string') return fail('malformed-ciphertext', "decryptBlockContent: member 'ct' is not a string")
  if (!isCompressedPublicKeyHex(obj.eph)) {
    return fail('malformed-ciphertext', "decryptBlockContent: member 'eph' is not a valid compressed point")
  }

  // --- 3. version/alg, BEFORE any decryption -----------------------------------
  if (obj.v !== BLOCK_CIPHER_FORMAT_VERSION || obj.alg !== BLOCK_CIPHER_ALG) {
    return fail(
      'unsupported-version',
      `decryptBlockContent: unsupported version/alg (v=${JSON.stringify(obj.v)}, alg=${JSON.stringify(obj.alg)})`
    )
  }

  // --- 4. decode lengths --------------------------------------------------------
  const ephBytes = hexToBytesStrict(obj.eph, 33)!
  const nonce = base64urlToBytes(obj.nonce)
  if (nonce === null || nonce.length !== NONCE_BYTES) {
    return fail('malformed-ciphertext', `decryptBlockContent: member 'nonce' did not decode to ${NONCE_BYTES} bytes`)
  }
  const kc = base64urlToBytes(obj.kc)
  if (kc === null || kc.length !== KC_BYTES) {
    return fail('malformed-ciphertext', `decryptBlockContent: member 'kc' did not decode to ${KC_BYTES} bytes`)
  }
  const ct = base64urlToBytes(obj.ct)
  if (ct === null || ct.length < 16) {
    return fail('malformed-ciphertext', "decryptBlockContent: member 'ct' did not decode to at least 16 bytes")
  }

  // --- 5. ECDH, derive, compare kc, decrypt — one try ---------------------------
  try {
    const z = ecdhX(jointSecretKey, ephBytes)
    const yBytes = secp256k1.getPublicKey(jointSecretKey, true)
    const salt = concatBytes(ephBytes, yBytes)
    const kdfOut = hkdf(sha256, z, salt, utf8ToBytes(KEY_LABEL), KDF_LENGTH)
    const k = kdfOut.slice(0, 32)
    const kcPrime = kdfOut.slice(32, KDF_LENGTH)
    if (!equalBytes(kcPrime, kc)) {
      throw new Error('key commitment mismatch')
    }
    const aad = encodeLengthPrefixed([CONTENT_LABEL, binding.electionId, String(binding.revision), binding.blockId])
    const plaintext = gcm(k, nonce, aad).decrypt(ct)
    k.fill(0)
    return { ok: true, plaintext }
  } catch {
    return fail('authentication-failed', `decryptBlockContent: authenticated decryption failed over ${ct.length} ciphertext bytes`)
  }
}
