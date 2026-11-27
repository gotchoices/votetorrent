// src/crypto/backend.ts — an optional native secp256k1 ECDH for `ecdhX`.
//
// Every ECDH in this package's envelope and block-cipher paths (`encoding.ts`
// `ecdhX`) runs in pure-JS @noble/curves. On Hermes, which has no JIT, one
// `getSharedSecret` costs about 49 ms on a desktop-class emulator, against
// 0.5 ms through react-native-quick-crypto (OpenSSL). An instrumented election
// spent about 7 s of an Authority phone's JS thread in these calls
// (2026-11-12). Node and the browser keep the noble path: nothing installs a
// backend there.
//
// The app installs the native function once, at boot, through
// `setCryptoBackend` (subpath `@votetorrent/vote-engine/crypto-backend`, which
// imports nothing but noble so the boot polyfill can load it before libp2p).
// The shape follows `@optimystic/quereus-plugin-crypto`'s `setCryptoBackend`:
// a self-check against noble before install, a refusal that leaves the
// previous state, and a `Symbol.for` slot on `globalThis` so a second copy of
// this module in one bundle reads the same backend.
//
// Only `encoding.ts` `ecdhX` reads it. `dkg.ts` cannot: it keys its HKDF with
// the 33-byte compressed shared point, and OpenSSL's ECDH returns only the
// x-coordinate, which does not determine the parity byte.
//
// Purity rules are `encoding.ts`'s (see its header): noble imports only, no
// `node:`, no console.

import { secp256k1 } from '@noble/curves/secp256k1.js'

/** Synchronous native implementations; an omitted member keeps @noble. */
export interface CryptoBackend {
  /**
   * The 32-byte x-coordinate of `secretKey * publicKey` on secp256k1 (SEC 1
   * section 3.3.1, OpenSSL's `ECDH_compute_key` output). `secretKey` is a raw
   * 32-byte scalar; `publicKey` is a 33-byte compressed or 65-byte
   * uncompressed SEC 1 point. Must throw for a point that is not on the curve.
   * Must return a freshly allocated array.
   */
  secp256k1EcdhX?(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array
}

type EcdhX = (secretKey: Uint8Array, publicKey: Uint8Array) => Uint8Array

const BACKEND_KEY = Symbol.for('@votetorrent/vote-engine/crypto-backend')
const slot = globalThis as unknown as Record<symbol, Readonly<CryptoBackend> | undefined>

/**
 * Install a backend for this process, or pass undefined to restore @noble.
 * Throws, leaving the previous backend in place, if a supplied member fails
 * its self-check.
 */
export function setCryptoBackend (backend: CryptoBackend | undefined): void {
  if (backend === undefined) {
    delete slot[BACKEND_KEY]
    return
  }
  const ecdh = backend.secp256k1EcdhX?.bind(backend)
  if (ecdh !== undefined) selfCheckEcdhX(ecdh)
  slot[BACKEND_KEY] = Object.freeze({ secp256k1EcdhX: ecdh })
}

/** The installed native ECDH, or undefined. For `encoding.ts` only. */
export function installedEcdhX (): EcdhX | undefined {
  return slot[BACKEND_KEY]?.secp256k1EcdhX
}

/**
 * Whether `ecdhX` may hand these inputs to the native backend: exactly the
 * shapes noble's `getSharedSecret` accepts, so native cannot succeed where
 * noble would throw. OpenSSL also decodes "hybrid" points (prefix 0x06/0x07)
 * and does not range-check the scalar; noble rejects both, so both stay on
 * the noble path, which throws as it always has.
 */
export function nativeEcdhInputsOk (secretKey: Uint8Array, publicKey: Uint8Array): boolean {
  if (!(secretKey instanceof Uint8Array) || !(publicKey instanceof Uint8Array)) return false
  if (!secp256k1.utils.isValidSecretKey(secretKey)) return false
  if (publicKey.length === 33) return publicKey[0] === 0x02 || publicKey[0] === 0x03
  if (publicKey.length === 65) return publicKey[0] === 0x04
  return false
}

// Fixed check inputs: two scalars and the public key of the second.
const CHECK_SECRET = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const PEER_SECRET = Uint8Array.from({ length: 32 }, (_, i) => 0xa0 ^ i)

function selfCheckEcdhX (ecdh: EcdhX): void {
  const compressed = secp256k1.getPublicKey(PEER_SECRET, true)
  const uncompressed = secp256k1.getPublicKey(PEER_SECRET, false)
  const expected = secp256k1.getSharedSecret(CHECK_SECRET, compressed, true).slice(1)
  for (const [label, peer] of [['compressed', compressed], ['uncompressed', uncompressed]] as const) {
    let actual: unknown
    try {
      actual = ecdh(offsetView(CHECK_SECRET), offsetView(peer))
    } catch (cause) {
      throw new Error(`setCryptoBackend: secp256k1EcdhX threw on a valid ${label} point; the backend was not installed`, { cause })
    }
    if (!sameBytes(actual, expected)) {
      throw new Error(`setCryptoBackend: secp256k1EcdhX returned a different x-coordinate than @noble/curves for a ${label} point; the backend was not installed`)
    }
  }
  // An invalid-curve point must be refused, or a hostile peer key could leak
  // bits of the secret (the attack OpenSSL's on-curve check exists to stop).
  // (x, y) = (1, 1): 1^2 != 1^3 + 7.
  const notOnCurve = new Uint8Array(65)
  notOnCurve[0] = 0x04
  notOnCurve[32] = 1
  notOnCurve[64] = 1
  let refused = false
  try {
    ecdh(CHECK_SECRET, notOnCurve)
  } catch {
    refused = true
  }
  if (!refused) {
    throw new Error('setCryptoBackend: secp256k1EcdhX accepted a point that is not on the curve; the backend was not installed')
  }
}

function sameBytes (actual: unknown, expected: Uint8Array): boolean {
  if (!(actual instanceof Uint8Array) || actual.length !== expected.length) return false
  for (let i = 0; i < expected.length; i++) if (actual[i] !== expected[i]) return false
  return true
}

/** A copy of `bytes` that does not start at offset 0 of its buffer, to catch a backend that ignores `byteOffset`. */
function offsetView (bytes: Uint8Array): Uint8Array {
  const buffer = new Uint8Array(bytes.length + 2)
  buffer.set(bytes, 1)
  return buffer.subarray(1, 1 + bytes.length)
}
