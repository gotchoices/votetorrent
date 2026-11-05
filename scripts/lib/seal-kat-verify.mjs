#!/usr/bin/env node
//
// scripts/lib/seal-kat-verify.mjs
//
// Purpose : the HOST half of the Phase 52 [seal-kat] device gate (D-05).
//           Takes the sealed wrapper that `@noble/ciphers` produced under Hermes
//           on a real Android device and decrypts it here with `node:crypto`.
//
//           That cross-implementation decrypt is the load-bearing assertion of
//           the whole gate. "The app didn't crash" proves only that the module
//           evaluated; this proves the BYTES agree — which is the single
//           property D-05 was chosen for (one implementation, one set of test
//           vectors, RN-to-browser parity).
//
// Modes   : node scripts/lib/seal-kat-verify.mjs --wrapper '<json>' --lookup-id '<base64url>'
//               Verify a wrapper the device emitted. Exit 0 only when it
//               decrypts to exactly the pinned plaintext.
//
//           node scripts/lib/seal-kat-verify.mjs --selftest
//               The verifier's own positive AND negative control: seal with
//               node:crypto, verify it, then flip one ciphertext byte and
//               require a REJECT. A verifier that accepts everything cannot
//               pass this.
//
// Deps    : none. `node:crypto` only, so this can never disagree with the
//           implementation under test by sharing code with it.
//
// Exit    : 0 — every check passed
//           1 — a named check failed (the failing check is printed)
//
// ---------------------------------------------------------------------------
// The derivation, and the single easiest way to get it wrong
// ---------------------------------------------------------------------------
//
//   contentKey = HMAC-SHA256(key = 'bootstrap-content', msg = secret)
//   lookupId   = base64url(HMAC-SHA256(key = 'bootstrap-lookup', msg = secret))
//
// The LABEL occupies HMAC's KEY slot and the SECRET is the MESSAGE. Swapping
// them still yields 32 plausible bytes and a verifier that can never agree with
// the device — a failure that would look exactly like a Hermes byte mismatch and
// would wrongly reopen D-05. Do not swap them.
//
// `lookupId` is bound as GCM additional authenticated data as its UTF-8 STRING
// bytes, not as its decoded value.

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'

// --- locked vectors (52-07 <locked_construction>) ---------------------------

/** The fixed 20-byte test secret the device proof also uses. All 0x2a. */
const KAT_SECRET = Buffer.alloc(20, 0x2a)
/** The fixed test plaintext. Also the served-bundle provenance marker. */
const KAT_PLAINTEXT = 'sealed-payload-kat-v1'
const LOOKUP_LABEL = 'bootstrap-lookup'
const CONTENT_LABEL = 'bootstrap-content'
const NONCE_BYTES = 12
const GCM_TAG_BYTES = 16
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

// --- helpers ----------------------------------------------------------------

function die (message) {
  console.error(`[seal-kat-verify] FAIL: ${message}`)
  process.exit(1)
}

function hmacHalf (label) {
  return createHmac('sha256', Buffer.from(label, 'utf8')).update(KAT_SECRET).digest()
}

function deriveKeys () {
  return {
    contentKey: hmacHalf(CONTENT_LABEL),
    lookupId: hmacHalf(LOOKUP_LABEL).toString('base64url')
  }
}

/**
 * Strict unpadded base64url decode. `Buffer.from(s, 'base64url')` is LENIENT —
 * it silently discards characters outside the alphabet, so a truncated or
 * mangled logcat capture would decode to plausible-but-wrong bytes and surface
 * as a confusing crypto failure instead of a named parse failure. Round-tripping
 * the re-encode is what makes the rejection exact.
 */
function strictBase64url (value, what) {
  if (typeof value !== 'string' || value.length === 0) {
    die(`${what} is not a non-empty string`)
  }
  if (!BASE64URL_PATTERN.test(value)) {
    die(`${what} is not unpadded base64url (found a character outside [A-Za-z0-9_-])`)
  }
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.toString('base64url') !== value) {
    die(`${what} did not survive a base64url round trip — it is malformed or truncated`)
  }
  return bytes
}

/** Seal with node:crypto. Used only by --selftest, never on the verify path. */
function sealWithNodeCrypto (plaintext, keys, nonce) {
  const cipher = createCipheriv('aes-256-gcm', keys.contentKey, nonce)
  cipher.setAAD(Buffer.from(keys.lookupId, 'utf8'))
  const sealed = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final(),
    cipher.getAuthTag()
  ])
  return {
    v: 1,
    nonce: nonce.toString('base64url'),
    ciphertext: sealed.toString('base64url')
  }
}

/**
 * The verify path. Returns the recovered plaintext, or `null` when authenticated
 * decryption refused. Structural problems `die()` with a named check instead of
 * returning, because a malformed wrapper is a harness defect, not a crypto
 * verdict, and the two must never be confused.
 */
function verifyWrapper (wrapper, suppliedLookupId, { expectReject = false } = {}) {
  const keys = deriveKeys()

  // --- check 1: structure ---------------------------------------------------
  if (wrapper === null || typeof wrapper !== 'object' || Array.isArray(wrapper)) {
    die('wrapper is not a JSON object')
  }
  const members = Object.keys(wrapper).sort().join(',')
  if (members !== 'ciphertext,nonce,v') {
    die(`wrapper members are '${members}' (expected exactly 'ciphertext,nonce,v')`)
  }
  if (wrapper.v !== 1) {
    die(`wrapper.v is ${JSON.stringify(wrapper.v)} (expected 1)`)
  }

  // --- check 2: the lookupId the device reported is the one WE derive -------
  // Independently re-derived, never trusted. If these disagree, the device is
  // running a different secret or a different KDF and nothing below would mean
  // what it appears to mean.
  if (suppliedLookupId !== keys.lookupId) {
    die(
      'the supplied lookupId does not match the one re-derived from the fixed test secret ' +
      `(supplied ${suppliedLookupId.length} chars, expected ${keys.lookupId.length}). ` +
      'The device is not running the locked KAT secret, or the KDF disagrees.'
    )
  }

  // --- check 3: decode, with named length failures --------------------------
  const nonce = strictBase64url(wrapper.nonce, 'wrapper.nonce')
  if (nonce.length !== NONCE_BYTES) {
    die(`wrapper.nonce decoded to ${nonce.length} bytes (expected ${NONCE_BYTES})`)
  }
  const sealed = strictBase64url(wrapper.ciphertext, 'wrapper.ciphertext')
  if (sealed.length < GCM_TAG_BYTES + 1) {
    die(
      `wrapper.ciphertext decoded to ${sealed.length} bytes — shorter than the ` +
      `${GCM_TAG_BYTES}-byte GCM tag plus one byte of payload`
    )
  }

  // --- check 4: authenticated decryption ------------------------------------
  const body = sealed.subarray(0, sealed.length - GCM_TAG_BYTES)
  const tag = sealed.subarray(sealed.length - GCM_TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', keys.contentKey, nonce)
  decipher.setAAD(Buffer.from(keys.lookupId, 'utf8'))
  decipher.setAuthTag(tag)

  let plaintext
  try {
    plaintext = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  } catch {
    if (expectReject) return null
    die(
      'authenticated decryption REJECTED the wrapper. node:crypto and the device do not agree ' +
      'on the AES-256-GCM bytes (or the tag/AAD binding differs). This is the KAT-byte-mismatch ' +
      'classification — it is the only evidence that reopens D-05.'
    )
  }
  if (expectReject) {
    die('a tampered ciphertext was ACCEPTED — this verifier is not authenticating anything')
  }

  // --- check 5: the plaintext is exactly the pinned literal -----------------
  if (plaintext !== KAT_PLAINTEXT) {
    die(
      `decryption succeeded but recovered ${plaintext.length} characters that are not the ` +
      'pinned KAT plaintext'
    )
  }
  return plaintext
}

// --- modes ------------------------------------------------------------------

function selftest () {
  const keys = deriveKeys()
  console.log(`[seal-kat-verify] selftest: lookupId re-derived (${keys.lookupId.length} chars)`)

  // Positive: a fresh nonce every run, so the selftest is not pinned to one vector.
  const wrapper = sealWithNodeCrypto(KAT_PLAINTEXT, keys, randomBytes(NONCE_BYTES))
  const recovered = verifyWrapper(wrapper, keys.lookupId)
  if (recovered !== KAT_PLAINTEXT) {
    die('selftest positive control did not recover the pinned plaintext')
  }
  console.log('[seal-kat-verify] selftest POSITIVE: a node:crypto-sealed wrapper verified and decrypted')

  // Negative: flip one ciphertext byte and require a refusal.
  const sealed = Buffer.from(wrapper.ciphertext, 'base64url')
  const flipped = Buffer.from(sealed)
  flipped[0] ^= 0x01
  const tampered = { v: wrapper.v, nonce: wrapper.nonce, ciphertext: flipped.toString('base64url') }
  const rejected = verifyWrapper(tampered, keys.lookupId, { expectReject: true })
  if (rejected !== null) {
    die('selftest negative control did not reject a one-byte-flipped ciphertext')
  }
  console.log('[seal-kat-verify] selftest NEGATIVE: a one-byte-flipped ciphertext was REJECTED')
  console.log('[seal-kat-verify] selftest OK (positive + negative)')
}

function usage () {
  console.error('Usage:')
  console.error("  node scripts/lib/seal-kat-verify.mjs --wrapper '<json>' --lookup-id '<base64url>'")
  console.error('  node scripts/lib/seal-kat-verify.mjs --selftest')
  process.exit(1)
}

function main () {
  const argv = process.argv.slice(2)
  if (argv.includes('--selftest')) {
    selftest()
    return
  }

  let wrapperJson
  let lookupId
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--wrapper') wrapperJson = argv[++i]
    else if (argv[i] === '--lookup-id') lookupId = argv[++i]
    else if (argv[i] === '--help' || argv[i] === '-h') usage()
    else die(`unrecognised argument '${argv[i]}'`)
  }
  if (wrapperJson === undefined || lookupId === undefined) usage()

  let wrapper
  try {
    wrapper = JSON.parse(wrapperJson)
  } catch {
    die('--wrapper is not parseable JSON (was the logcat line truncated or split?)')
  }

  verifyWrapper(wrapper, lookupId)
  console.log(
    '[seal-kat-verify] OK: the wrapper decrypted under node:crypto to the pinned KAT plaintext ' +
    '— device (Hermes/@noble/ciphers) and host (node:crypto) agree byte for byte'
  )
}

main()
