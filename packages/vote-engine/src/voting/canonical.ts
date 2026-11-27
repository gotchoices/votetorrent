// canonical.ts — canonical JSON and the D-28 ordering rule for block-payload arrays.
//
// Each block-payload array is sorted by its own canonical bytes, NEVER by submission order:
// submission order linked 25/25 votes to voters by position in spike 098.
//
// The contract is UTF-8 BYTE order, not UTF-16 string order. The future SQL/block side compares
// bytes, and the two orders disagree for characters above the BMP (a surrogate pair sorts before
// U+FF01 as a JS string but after it as UTF-8).

import { utf8ToBytes } from '@noble/hashes/utils.js'

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Canonical bytes for at-rest storage and for the block payload (key order fixed). */
export function canonicalJson (value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj).sort(byString).filter(k => obj[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function compareBytes (a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const d = a[i]! - b[i]!
    if (d !== 0) return d
  }
  // A shorter key that is a prefix of a longer one sorts first.
  return a.length - b.length
}

/**
 * D-28: order items by the UTF-8 bytes of `canonicalJson(item)`. The result is the same for every
 * permutation of the input. Returns a new array; the input is never mutated.
 */
export function sortByCanonicalBytes<T> (items: readonly T[]): T[] {
  const decorated = items.map(item => ({ item, key: utf8ToBytes(canonicalJson(item)) }))
  decorated.sort((a, b) => compareBytes(a.key, b.key))
  return decorated.map(d => d.item)
}
