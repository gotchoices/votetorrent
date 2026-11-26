// Per-peer results identity for CLI-06: a canonical projection of a results reply (never an option code),
// a 12-hex sha256 tag over that projection, and the RESULTS-* key names written into results.json.keys.
// The projection carries 67-30's `agreementSha256` (sha256 over AGREEMENT_FIELDS: tally and block roots,
// per-ballot counts, the opened set and the publication flags), so equal tags mean every field agrees.
// The reply's `counts` is 67-30's sorted multiset of per-option counts, with no option code.

import { createHash } from 'node:crypto'

export interface CanonicalResults {
  status: string
  valid: number
  invalid: number
  excluded: number
  /** The sorted multiset of per-option integer counts; no option codes. */
  counts: number[]
  /** 64 hex: the daemon's hash over every agreement field. */
  agreementSha256: string
}

const count = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new TypeError('results-identity: bad-count')
  return value
}

const SHA256_RE = /^[0-9a-f]{64}$/

/** Keeps only status / valid / invalid / excluded / counts / agreementSha256; each is required. */
export function canonicalResults (result: Record<string, unknown>): CanonicalResults {
  const raw = result.counts
  if (!Array.isArray(raw)) throw new TypeError('results-identity: counts-required')
  const counts = raw.map(count)
  const agreement = result.agreementSha256
  if (typeof agreement !== 'string' || !SHA256_RE.test(agreement)) throw new TypeError('results-identity: agreement-required')
  return {
    status: String(result.status ?? ''),
    valid: count(result.valid),
    invalid: count(result.invalid),
    excluded: count(result.excluded),
    counts,
    agreementSha256: agreement
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
