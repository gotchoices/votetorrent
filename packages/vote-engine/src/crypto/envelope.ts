// src/crypto/envelope.ts — the D-03/D-04 per-officer multi-recipient
// envelope.
//
// A staged registration or association payload is sealed ONCE under a
// random content key (CK), and CK is wrapped once per current officer's
// secp256k1 encryption key (`UserEncryptionKey.Alg = ENCRYPTION_KEY_ALG`).
// Every strand peer, including non-officers, sees only `SealedEnvelope`
// ciphertext; an officer opens it with their own secret key, and a
// non-recipient — or a payload moved to a different RequestId/Digest — gets
// a fail-closed refusal, never a partial plaintext.
//
// The wire construction, the open procedure's normative check order, and
// the key-commitment rationale are all specified in
// `doc/encryption-formats.md` section 2; this module implements that
// specification verbatim and must not drift from it independently (a
// mismatch is a bug in one of the two, fixed in code per 62-04 Task 3's
// review, never silently reconciled by relaxing a test).
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
import {
  base64urlToBytes,
  bytesToBase64url,
  ecdhX,
  encodeLengthPrefixed,
  hexToBytesStrict,
  isCompressedPublicKeyHex
} from './encoding.js'

// ---------------------------------------------------------------------------
// Locked constants
// ---------------------------------------------------------------------------

/** The literal format version. Never widened to `number`. */
export const ENVELOPE_FORMAT_VERSION: 1 = 1

/** The envelope's algorithm identifier, carried on the wire. */
export const ENVELOPE_ALG = 'vt-env-1' as const

/**
 * The value 62-14 writes into `UserEncryptionKey.Alg` for every officer
 * encryption key this module can wrap to.
 */
export const ENCRYPTION_KEY_ALG = 'secp256k1-ecdh-hkdf-sha256-aes256gcm' as const

/** Denial-of-service bound: enforced at seal (throws) and at open (malformed). */
export const ENVELOPE_MAX_RECIPIENTS = 64

/** AES-GCM nonce length in bytes — the only value this format accepts. */
const NONCE_BYTES = 12

/** The random content key's length in bytes (AES-256). */
const CONTENT_KEY_BYTES = 32

/** HKDF output length for (Kenc || kc): 32 + 32. */
const CONTENT_KDF_LENGTH = 64

/** HKDF output length for a per-recipient KEK. */
const WRAP_KDF_LENGTH = 32

/** A wrapped content key: 32 plaintext bytes + a 16-byte GCM tag. */
const WRAP_BYTES = 48

/** Key-commitment tag length in bytes. */
const KC_BYTES = 32

const CONTENT_LABEL = 'vt-env-1/content'
const WRAP_LABEL = 'vt-env-1/wrap'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

// EnvelopeRecipient, EnvelopeBinding and EnvelopeOpenFailureReason live in the
// import-free leaf `envelope-types.ts`, so type-only consumers on the
// `./browser` graph (src/types.ts -> intake/types.ts) do not pull @noble in.
import type { EnvelopeBinding, EnvelopeOpenFailureReason, EnvelopeRecipient } from './envelope-types.js'
export type { EnvelopeBinding, EnvelopeOpenFailureReason, EnvelopeRecipient } from './envelope-types.js'

export interface EnvelopeRecipientSecret {
  readonly userId: string
  readonly secretKey: Uint8Array
}

export interface SealedEnvelopeRecipientEntry {
  readonly userId: string
  readonly pub: string
  readonly eph: string
  readonly nonce: string
  readonly wrap: string
}

export interface SealedEnvelope {
  readonly v: 1
  readonly alg: 'vt-env-1'
  readonly nonce: string
  readonly kc: string
  readonly ct: string
  readonly recipients: readonly SealedEnvelopeRecipientEntry[]
}

export type EnvelopeSealErrorCode =
  | 'no-recipients'
  | 'too-many-recipients'
  | 'duplicate-recipient'
  | 'invalid-recipient-key'
  | 'invalid-binding'
  | 'invalid-plaintext'

export class EnvelopeSealError extends Error {
  readonly code: EnvelopeSealErrorCode

  constructor (code: EnvelopeSealErrorCode, message: string) {
    super(message)
    this.name = 'EnvelopeSealError'
    this.code = code
  }
}

export type EnvelopeOpenResult =
  | { readonly ok: true, readonly plaintext: Uint8Array }
  | { readonly ok: false, readonly reason: EnvelopeOpenFailureReason, readonly detail: string }

/** Deep-path randomness shape for `sealToRecipientsWithRandomness`. */
export interface EnvelopeRandomness {
  readonly contentKey: Uint8Array
  readonly contentNonce: Uint8Array
  readonly wraps: readonly { readonly ephemeralSecretKey: Uint8Array, readonly nonce: Uint8Array }[]
}

// ---------------------------------------------------------------------------
// Sealing — input validation
// ---------------------------------------------------------------------------

function assertPlaintext (plaintext: unknown, where: string): asserts plaintext is Uint8Array {
  if (!(plaintext instanceof Uint8Array)) {
    throw new EnvelopeSealError(
      'invalid-plaintext',
      `${where}: plaintext must be a Uint8Array (got ${plaintext === null ? 'null' : typeof plaintext})`
    )
  }
}

function assertBinding (binding: unknown, where: string): asserts binding is EnvelopeBinding {
  if (binding === null || typeof binding !== 'object') {
    throw new EnvelopeSealError('invalid-binding', `${where}: binding must be an EnvelopeBinding object`)
  }
  const b = binding as Record<string, unknown>
  if (typeof b.requestId !== 'string' || b.requestId.length === 0) {
    throw new EnvelopeSealError('invalid-binding', `${where}: binding.requestId must be a non-empty string`)
  }
  if (typeof b.digest !== 'string' || b.digest.length === 0) {
    throw new EnvelopeSealError('invalid-binding', `${where}: binding.digest must be a non-empty string`)
  }
}

function assertRecipients (recipients: unknown, where: string): asserts recipients is readonly EnvelopeRecipient[] {
  const list = Array.isArray(recipients) ? recipients : []
  if (list.length === 0) {
    throw new EnvelopeSealError('no-recipients', `${where}: at least one recipient is required`)
  }
  if (list.length > ENVELOPE_MAX_RECIPIENTS) {
    throw new EnvelopeSealError(
      'too-many-recipients',
      `${where}: at most ${ENVELOPE_MAX_RECIPIENTS} recipients are allowed (got ${list.length})`
    )
  }
  const seenUserIds = new Set<string>()
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') {
      throw new EnvelopeSealError('invalid-recipient-key', `${where}: each recipient must be an object`)
    }
    const r = raw as Record<string, unknown>
    if (typeof r.userId !== 'string' || r.userId.length === 0) {
      throw new EnvelopeSealError('invalid-recipient-key', `${where}: recipient.userId must be a non-empty string`)
    }
    if (typeof r.publicKey !== 'string' || !isCompressedPublicKeyHex(r.publicKey)) {
      throw new EnvelopeSealError(
        'invalid-recipient-key',
        `${where}: recipient.publicKey must be a valid compressed secp256k1 public key hex`
      )
    }
    if (seenUserIds.has(r.userId)) {
      throw new EnvelopeSealError('duplicate-recipient', `${where}: duplicate recipient userId`)
    }
    // Two userIds MAY share a publicKey: a copied key must not evict its owner
    // (initial/G1 WR-03). Each wrap binds its own userId in the AAD, so a
    // claimant without the private key gains nothing. Only userIds are unique.
    seenUserIds.add(r.userId)
  }
}

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

/**
 * Seal `plaintext` to every listed recipient (D-03/D-04). Throws
 * `EnvelopeSealError` on bad input; zero recipients is code `'no-recipients'`
 * — there is no plaintext fallback for that case or any other.
 */
export function sealToRecipients (
  plaintext: Uint8Array,
  recipients: readonly EnvelopeRecipient[],
  binding: EnvelopeBinding
): SealedEnvelope {
  assertPlaintext(plaintext, 'sealToRecipients')
  assertBinding(binding, 'sealToRecipients')
  assertRecipients(recipients, 'sealToRecipients')

  const randomness: EnvelopeRandomness = {
    contentKey: randomBytes(CONTENT_KEY_BYTES),
    contentNonce: randomBytes(NONCE_BYTES),
    wraps: recipients.map(() => ({
      ephemeralSecretKey: secp256k1.utils.randomSecretKey(),
      nonce: randomBytes(NONCE_BYTES)
    }))
  }

  return sealToRecipientsWithRandomness(plaintext, recipients, binding, randomness)
}

/**
 * Deterministic seal. **TEST AND KNOWN-ANSWER-VECTOR USE ONLY.**
 *
 * A repeated nonce or ephemeral scalar under this construction is
 * catastrophic in the same way a repeated AES-GCM nonce always is: it
 * forfeits both confidentiality (keystream reuse reveals the XOR of two
 * plaintexts) and authentication (the GHASH key becomes recoverable,
 * letting an attacker forge tags at will). A reused wrap ephemeral
 * additionally collapses that recipient's ECDH shared secret across calls.
 * Production code must call `sealToRecipients`, which always draws fresh
 * randomness.
 *
 * This function is deliberately NOT re-exported from `src/crypto/index.ts`,
 * so the only import path that reaches it is a deep source path, which
 * nothing but this package's own tests uses.
 */
export function sealToRecipientsWithRandomness (
  plaintext: Uint8Array,
  recipients: readonly EnvelopeRecipient[],
  binding: EnvelopeBinding,
  randomness: EnvelopeRandomness
): SealedEnvelope {
  assertPlaintext(plaintext, 'sealToRecipientsWithRandomness')
  assertBinding(binding, 'sealToRecipientsWithRandomness')
  assertRecipients(recipients, 'sealToRecipientsWithRandomness')

  if (!(randomness.contentKey instanceof Uint8Array) || randomness.contentKey.length !== CONTENT_KEY_BYTES) {
    throw new TypeError(`sealToRecipientsWithRandomness: randomness.contentKey must be ${CONTENT_KEY_BYTES} bytes`)
  }
  if (!(randomness.contentNonce instanceof Uint8Array) || randomness.contentNonce.length !== NONCE_BYTES) {
    throw new TypeError(`sealToRecipientsWithRandomness: randomness.contentNonce must be ${NONCE_BYTES} bytes`)
  }
  if (!Array.isArray(randomness.wraps) || randomness.wraps.length !== recipients.length) {
    throw new TypeError(
      `sealToRecipientsWithRandomness: randomness.wraps.length must equal recipients.length (${recipients.length})`
    )
  }
  for (const [i, wrapRandomness] of randomness.wraps.entries()) {
    if (!(wrapRandomness.ephemeralSecretKey instanceof Uint8Array) ||
        !secp256k1.utils.isValidSecretKey(wrapRandomness.ephemeralSecretKey)) {
      throw new TypeError(`sealToRecipientsWithRandomness: wraps[${i}].ephemeralSecretKey is not a valid scalar`)
    }
    if (!(wrapRandomness.nonce instanceof Uint8Array) || wrapRandomness.nonce.length !== NONCE_BYTES) {
      throw new TypeError(`sealToRecipientsWithRandomness: wraps[${i}].nonce must be ${NONCE_BYTES} bytes`)
    }
  }

  // --- content: CK, (Kenc || kc), ct ---------------------------------------
  const contentKdf = hkdf(sha256, randomness.contentKey, new Uint8Array(0), utf8ToBytes(CONTENT_LABEL), CONTENT_KDF_LENGTH)
  const kEnc = contentKdf.slice(0, 32)
  const kc = contentKdf.slice(32, CONTENT_KDF_LENGTH)
  const contentAad = encodeLengthPrefixed([CONTENT_LABEL, binding.requestId, binding.digest])
  const ct = gcm(kEnc, randomness.contentNonce, contentAad).encrypt(plaintext)
  kEnc.fill(0)

  // --- per-recipient wrap ---------------------------------------------------
  const recipientEntries: SealedEnvelopeRecipientEntry[] = recipients.map((recipient, i) => {
    const wrapRandomness = randomness.wraps[i]!
    const ephPublicKeyBytes = secp256k1.getPublicKey(wrapRandomness.ephemeralSecretKey, true)
    const ephHex = bytesToHex(ephPublicKeyBytes)
    const recipientPublicKeyBytes = hexToBytesStrict(recipient.publicKey, 33)!
    const z = ecdhX(wrapRandomness.ephemeralSecretKey, recipientPublicKeyBytes)
    const salt = concatBytes(ephPublicKeyBytes, recipientPublicKeyBytes)
    const kek = hkdf(sha256, z, salt, utf8ToBytes(WRAP_LABEL), WRAP_KDF_LENGTH)
    const wrapAad = encodeLengthPrefixed([
      WRAP_LABEL,
      recipient.userId,
      recipient.publicKey,
      ephHex,
      binding.requestId,
      binding.digest
    ])
    const wrap = gcm(kek, wrapRandomness.nonce, wrapAad).encrypt(randomness.contentKey)
    kek.fill(0)

    return {
      userId: recipient.userId,
      pub: recipient.publicKey,
      eph: ephHex,
      nonce: bytesToBase64url(wrapRandomness.nonce),
      wrap: bytesToBase64url(wrap)
    }
  })

  return {
    v: ENVELOPE_FORMAT_VERSION,
    alg: ENVELOPE_ALG,
    nonce: bytesToBase64url(randomness.contentNonce),
    kc: bytesToBase64url(kc),
    ct: bytesToBase64url(ct),
    recipients: recipientEntries
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** JSON with the fixed member order v, alg, nonce, kc, ct, recipients (and per-entry userId, pub, eph, nonce, wrap). */
export function serializeEnvelope (envelope: SealedEnvelope): string {
  return JSON.stringify({
    v: envelope.v,
    alg: envelope.alg,
    nonce: envelope.nonce,
    kc: envelope.kc,
    ct: envelope.ct,
    recipients: envelope.recipients.map((r) => ({
      userId: r.userId,
      pub: r.pub,
      eph: r.eph,
      nonce: r.nonce,
      wrap: r.wrap
    }))
  })
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

interface ParsedEnvelope {
  readonly v: unknown
  readonly alg: unknown
  readonly nonce: string
  readonly kc: string
  readonly ct: string
  readonly recipients: ReadonlyArray<{
    readonly userId: string
    readonly pub: string
    readonly eph: string
    readonly nonce: string
    readonly wrap: string
  }>
}

type StructuralResult =
  | { readonly ok: true, readonly envelope: ParsedEnvelope }
  | { readonly ok: false, readonly detail: string }

/**
 * Step 2 of the normative open order: structural validation of every member
 * and every recipient entry (types, recipient count 1..64, unique userIds,
 * every pub and eph a valid compressed point). Shared by `openEnvelope` and
 * `envelopeRecipientUserIds` so both apply exactly the same structural
 * contract.
 */
function parseEnvelopeStructure (candidate: unknown): StructuralResult {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, detail: 'envelope: input is not an object' }
  }
  const obj = candidate as Record<string, unknown>
  for (const member of ['v', 'alg', 'nonce', 'kc', 'ct', 'recipients']) {
    if (!(member in obj)) return { ok: false, detail: `envelope: input is missing member '${member}'` }
  }
  if (typeof obj.nonce !== 'string') return { ok: false, detail: "envelope: member 'nonce' is not a string" }
  if (typeof obj.kc !== 'string') return { ok: false, detail: "envelope: member 'kc' is not a string" }
  if (typeof obj.ct !== 'string') return { ok: false, detail: "envelope: member 'ct' is not a string" }
  if (!Array.isArray(obj.recipients)) return { ok: false, detail: "envelope: member 'recipients' is not an array" }
  if (obj.recipients.length < 1 || obj.recipients.length > ENVELOPE_MAX_RECIPIENTS) {
    return {
      ok: false,
      detail: `envelope: member 'recipients' length ${obj.recipients.length} is out of range (1..${ENVELOPE_MAX_RECIPIENTS})`
    }
  }

  const seenUserIds = new Set<string>()
  const recipients: ParsedEnvelope['recipients'][number][] = []
  for (let i = 0; i < obj.recipients.length; i++) {
    const raw = obj.recipients[i]
    if (raw === null || typeof raw !== 'object') {
      return { ok: false, detail: `envelope: recipients[${i}] is not an object` }
    }
    const r = raw as Record<string, unknown>
    for (const member of ['userId', 'pub', 'eph', 'nonce', 'wrap']) {
      if (typeof r[member] !== 'string') {
        return { ok: false, detail: `envelope: recipients[${i}].${member} is not a string` }
      }
    }
    const userId = r.userId as string
    const pub = r.pub as string
    const eph = r.eph as string
    if (seenUserIds.has(userId)) {
      return { ok: false, detail: `envelope: recipients contains a duplicate userId at index ${i}` }
    }
    seenUserIds.add(userId)
    if (!isCompressedPublicKeyHex(pub)) {
      return { ok: false, detail: `envelope: recipients[${i}].pub is not a valid compressed public key` }
    }
    if (!isCompressedPublicKeyHex(eph)) {
      return { ok: false, detail: `envelope: recipients[${i}].eph is not a valid compressed public key` }
    }
    recipients.push({ userId, pub, eph, nonce: r.nonce as string, wrap: r.wrap as string })
  }

  return {
    ok: true,
    envelope: { v: obj.v, alg: obj.alg, nonce: obj.nonce, kc: obj.kc, ct: obj.ct, recipients }
  }
}

function fail (reason: EnvelopeOpenFailureReason, detail: string): EnvelopeOpenResult {
  return { ok: false, reason, detail }
}

/**
 * Open a sealed envelope. **Never throws.** `input` comes off the strand, so
 * it is attacker-influenceable and fails closed with a reason, exactly as
 * `unsealPayload` (`src/bootstrap/sealed-payload.ts`) does.
 *
 * The check order is normative (`doc/encryption-formats.md` section 2) and
 * asserted by `envelope.spec.ts`'s ordering tests — it must not be
 * rearranged:
 *
 *   1. local arguments                               -> 'invalid-argument'
 *   2. structural validation (every member, every
 *      recipient entry)                              -> 'malformed-envelope'
 *   3. version/alg, BEFORE any decryption             -> 'unsupported-version'
 *   4. decode fixed-length top-level fields           -> 'malformed-envelope'
 *   5. select the caller's recipient entry             -> 'not-a-recipient'
 *   6-8. ECDH, KEK, unwrap, derive, compare kc,
 *        decrypt — one try, every failure collapses
 *        to the SAME reason                           -> 'authentication-failed'
 *
 * Wrong key, tampered ciphertext/wrap/nonce/kc and wrong binding ALL return
 * `'authentication-failed'`. This is deliberate: a reason that distinguished
 * them would be a decryption oracle. `detail` strings never carry a byte of
 * plaintext, key or ciphertext — only member names and observed lengths.
 */
export function openEnvelope (
  input: unknown,
  recipient: EnvelopeRecipientSecret,
  binding: EnvelopeBinding
): EnvelopeOpenResult {
  // --- 1. local arguments ---------------------------------------------------
  if (recipient === null || typeof recipient !== 'object') {
    return fail('invalid-argument', 'openEnvelope: recipient must be an EnvelopeRecipientSecret object')
  }
  if (!(recipient.secretKey instanceof Uint8Array) || !secp256k1.utils.isValidSecretKey(recipient.secretKey)) {
    return fail('invalid-argument', 'openEnvelope: recipient.secretKey must be a valid 32-byte secp256k1 scalar')
  }
  if (typeof recipient.userId !== 'string' || recipient.userId.length === 0) {
    return fail('invalid-argument', 'openEnvelope: recipient.userId must be a non-empty string')
  }
  if (binding === null || typeof binding !== 'object' ||
      typeof binding.requestId !== 'string' || binding.requestId.length === 0 ||
      typeof binding.digest !== 'string' || binding.digest.length === 0) {
    return fail('invalid-argument', 'openEnvelope: binding must carry non-empty requestId and digest strings')
  }

  // --- 2. parse + structural check ------------------------------------------
  let candidate: unknown = input
  if (typeof input === 'string') {
    try {
      candidate = JSON.parse(input)
    } catch {
      return fail('malformed-envelope', 'openEnvelope: input string is not valid JSON')
    }
  }
  const structural = parseEnvelopeStructure(candidate)
  if (!structural.ok) return fail('malformed-envelope', structural.detail)
  const envelope = structural.envelope

  // --- 3. version/alg, BEFORE any decryption ---------------------------------
  if (envelope.v !== ENVELOPE_FORMAT_VERSION || envelope.alg !== ENVELOPE_ALG) {
    return fail(
      'unsupported-version',
      `openEnvelope: unsupported version/alg (v=${JSON.stringify(envelope.v)}, alg=${JSON.stringify(envelope.alg)})`
    )
  }

  // --- 4. decode fixed-length top-level fields -------------------------------
  const nonce = base64urlToBytes(envelope.nonce)
  if (nonce === null || nonce.length !== NONCE_BYTES) {
    return fail('malformed-envelope', `openEnvelope: member 'nonce' did not decode to ${NONCE_BYTES} bytes`)
  }
  const kc = base64urlToBytes(envelope.kc)
  if (kc === null || kc.length !== KC_BYTES) {
    return fail('malformed-envelope', `openEnvelope: member 'kc' did not decode to ${KC_BYTES} bytes`)
  }
  const ct = base64urlToBytes(envelope.ct)
  if (ct === null || ct.length < 16) {
    return fail('malformed-envelope', "openEnvelope: member 'ct' did not decode to at least 16 bytes")
  }

  // --- 5. select the caller's recipient entry --------------------------------
  const callerPublicKeyHex = bytesToHex(secp256k1.getPublicKey(recipient.secretKey, true))
  const entry = envelope.recipients.find((r) => r.userId === recipient.userId && r.pub === callerPublicKeyHex)
  if (entry === undefined) {
    return fail('not-a-recipient', 'openEnvelope: no recipient entry matches the caller userId and public key')
  }
  const wrap = base64urlToBytes(entry.wrap)
  if (wrap === null || wrap.length !== WRAP_BYTES) {
    return fail('malformed-envelope', `openEnvelope: recipient entry 'wrap' did not decode to ${WRAP_BYTES} bytes`)
  }
  const wrapNonce = base64urlToBytes(entry.nonce)
  if (wrapNonce === null || wrapNonce.length !== NONCE_BYTES) {
    return fail('malformed-envelope', `openEnvelope: recipient entry 'nonce' did not decode to ${NONCE_BYTES} bytes`)
  }
  const ephBytes = hexToBytesStrict(entry.eph, 33)!
  const recipientPublicKeyBytes = hexToBytesStrict(entry.pub, 33)!

  // --- 6-8. ECDH, KEK, unwrap, derive, compare kc, decrypt — one try ---------
  try {
    const z = ecdhX(recipient.secretKey, ephBytes)
    const salt = concatBytes(ephBytes, recipientPublicKeyBytes)
    const kek = hkdf(sha256, z, salt, utf8ToBytes(WRAP_LABEL), WRAP_KDF_LENGTH)
    const wrapAad = encodeLengthPrefixed([WRAP_LABEL, entry.userId, entry.pub, entry.eph, binding.requestId, binding.digest])
    const contentKey = gcm(kek, wrapNonce, wrapAad).decrypt(wrap)
    kek.fill(0)

    const contentKdf = hkdf(sha256, contentKey, new Uint8Array(0), utf8ToBytes(CONTENT_LABEL), CONTENT_KDF_LENGTH)
    const kEnc = contentKdf.slice(0, 32)
    const kcPrime = contentKdf.slice(32, CONTENT_KDF_LENGTH)
    if (!equalBytes(kcPrime, kc)) {
      throw new Error('key commitment mismatch')
    }
    const contentAad = encodeLengthPrefixed([CONTENT_LABEL, binding.requestId, binding.digest])
    const plaintext = gcm(kEnc, nonce, contentAad).decrypt(ct)

    // Best-effort zeroization only — NOT a security claim. bigint/JIT copies
    // may still survive outside these arrays (documented in the review,
    // section f).
    contentKey.fill(0)
    kEnc.fill(0)

    return { ok: true, plaintext }
  } catch {
    // The caught error's message is discarded on purpose: reporting it
    // would distinguish a wrong key from a tag mismatch from a tampered
    // AAD, which is exactly the oracle this design collapses away.
    return fail('authentication-failed', `openEnvelope: authenticated decryption failed over ${ct.length} ciphertext bytes`)
  }
}

/**
 * Return the userIds in envelope order, or `null` if `input` is structurally
 * malformed. Never throws. The recipient list is public (it is what
 * `openEnvelope` step 5 selects from), so this is not an oracle.
 */
export function envelopeRecipientUserIds (input: unknown): readonly string[] | null {
  let candidate: unknown = input
  if (typeof input === 'string') {
    try {
      candidate = JSON.parse(input)
    } catch {
      return null
    }
  }
  const structural = parseEnvelopeStructure(candidate)
  if (!structural.ok) return null
  return structural.envelope.recipients.map((r) => r.userId)
}

// ---------------------------------------------------------------------------
// Encryption keypairs
// ---------------------------------------------------------------------------

export function generateEncryptionKeyPair (): { readonly secretKey: Uint8Array, readonly publicKey: string } {
  const secretKey = secp256k1.utils.randomSecretKey()
  return { secretKey, publicKey: bytesToHex(secp256k1.getPublicKey(secretKey, true)) }
}

/** Throws `TypeError` on an invalid scalar. */
export function encryptionPublicKeyFromSecret (secretKey: Uint8Array): string {
  if (!(secretKey instanceof Uint8Array) || !secp256k1.utils.isValidSecretKey(secretKey)) {
    throw new TypeError('encryptionPublicKeyFromSecret: secretKey must be a valid 32-byte secp256k1 scalar')
  }
  return bytesToHex(secp256k1.getPublicKey(secretKey, true))
}

export function isValidEncryptionPublicKey (publicKey: string): boolean {
  return isCompressedPublicKeyHex(publicKey)
}
