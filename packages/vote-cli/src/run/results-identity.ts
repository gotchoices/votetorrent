// Per-peer results identity for CLI-06: a canonical projection of a results reply (never an option code),
// a 12-hex sha256 tag over that projection, and the RESULTS-* key names written into results.json.keys.

import { createHash } from 'node:crypto'

export interface CanonicalResults {
  status: string
  valid: number
  invalid: number
  excluded: number
  /** Per-option integer counts in option-index order; no option codes. */
  counts: number[]
}

const count = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new TypeError('results-identity: bad-count')
  return value
}

/** Keeps only status / valid / invalid / excluded / counts. Every count is an integer. */
export function canonicalResults (result: Record<string, unknown>): CanonicalResults {
  const raw = result.counts
  if (!Array.isArray(raw)) throw new TypeError('results-identity: counts-required')
  const counts = raw.map(count)
  return {
    status: String(result.status ?? ''),
    valid: count(result.valid),
    invalid: count(result.invalid),
    excluded: count(result.excluded),
    counts
  }
}

/** First 12 hex characters of sha256 over the canonical JSON. */
export function resultsTag (result: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(canonicalResults(result))).digest('hex').slice(0, 12)
}

export function identityKeyName (label: string): string {
  return 'RESULTS-' + label.toUpperCase()
}

export const RESULTS_IDENTICAL_KEY = 'RESULTS-IDENTICAL'
