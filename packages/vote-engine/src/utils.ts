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
