// Real secp256k1 test key generation helpers.
//
// Module pattern mirrors `test/shims/react-native.ts`: top-level named
// exports only, no class wrapper, no default export. Imported directly
// by spec files that need real (rather than literal-string) keys.
//
// The hex contract follows D-05 / D-31: `privateHex` is the 64-char hex
// encoding of a 32-byte secp256k1 private scalar; `publicHex` is the
// 66-char hex encoding of the corresponding 33-byte compressed public
// key.

import { bytesToHex } from '@noble/curves/abstract/utils'
import { secp256k1 } from '@noble/curves/secp256k1'

export interface TestKeyPair {
  /** Hex-encoded secp256k1 private key (64 chars, 32 bytes). */
  privateHex: string
  /** Hex-encoded secp256k1 compressed public key (66 chars, 33 bytes). */
  publicHex: string
}

/**
 * Generate a random secp256k1 key pair suitable for use in tests.
 * Both keys are hex-encoded per the D-01 hex-at-the-API-surface
 * contract. Keys live in process memory only for the lifetime of the
 * test run; nothing is logged or persisted.
 */
export function randomTestKeyPair (): TestKeyPair {
  const privBytes = secp256k1.utils.randomSecretKey()
  return {
    privateHex: bytesToHex(privBytes),
    publicHex: bytesToHex(secp256k1.getPublicKey(privBytes))
  }
}

/**
 * Generate a deterministic secp256k1 key pair from a fixed 64-char hex
 * seed. Useful for snapshot-style tests that need a stable public key.
 *
 * @param seedHex - Exactly 64 hex chars (32 bytes) used directly as the
 *   private scalar. Must be a valid secp256k1 private key; @noble/curves
 *   throws if the scalar is zero or ≥ curve order.
 */
export function deterministicTestKeyPair (seedHex: string): TestKeyPair {
  const pairs = seedHex.match(/.{2}/g)
  if (!pairs || pairs.length !== 32) {
    throw new Error(
      `deterministicTestKeyPair: seedHex must be exactly 64 hex chars (got ${seedHex.length})`
    )
  }
  const privBytes = Uint8Array.from(pairs.map((b) => parseInt(b, 16)))
  return {
    privateHex: seedHex,
    publicHex: bytesToHex(secp256k1.getPublicKey(privBytes))
  }
}
