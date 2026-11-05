// src/bootstrap/snapshot-codec.ts — deterministic canonical serialization of
// a `BootstrapSnapshot` (Phase 50 Plan 02).
//
// `canonicalizeTables` builds THE digest preimage: the one string both the
// producer (50-07) and every consumer (50-08/50-09) hash via
// `snapshot-manifest.ts`'s `computeContentDigest`. Its output must be
// byte-identical across machines regardless of source-object key insertion
// order, so every ordering decision here uses an explicit UTF-16
// code-unit comparator — never `Array.prototype.sort()` with no comparator,
// and never a locale-aware string-comparison method, whose result depends
// on the host's ICU data and would make two machines silently disagree on
// a digest.
//
// `parseSnapshot` never throws. A malformed or truncated payload is
// attacker-influenceable input (this module's own trust boundary, see the
// plan's threat model) and must fail closed with a structural `detail` that
// names only member/table/column NAMES — never a value, since the snapshot
// carries registrant PII (T-50-02-05).

import { bytesToBase64url } from '../utils.js'
import type {
  BootstrapSnapshot,
  SnapshotBlobValue,
  SnapshotManifest,
  SnapshotParseResult,
  SnapshotRow,
  SnapshotTables,
  SnapshotValue
} from './snapshot-types.js'

/** Ascending UTF-16 code-unit order. Never a locale-aware comparator (ICU-dependent). */
const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

function throwUnsupportedValue (tableName: string, columnName: string): never {
  throw new TypeError(`snapshot: unsupported value type in ${tableName}.${columnName}`)
}

function isBlobValue (value: unknown): value is SnapshotBlobValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value as Record<string, unknown>)
  return keys.length === 1 && keys[0] === '$bytes' && typeof (value as { $bytes: unknown }).$bytes === 'string'
}

/**
 * Validate a single cell value against the frozen `SnapshotValue` union.
 * Throws a `TypeError` naming the table and column only — the offending
 * value is never interpolated, because the snapshot carries registrant PII.
 */
function assertSupportedValue (value: unknown, tableName: string, columnName: string): SnapshotValue {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throwUnsupportedValue(tableName, columnName)
    return value
  }
  if (isBlobValue(value)) return { $bytes: value.$bytes }
  // undefined, arrays, plain objects other than { $bytes: string }, functions, symbols, bigints.
  throwUnsupportedValue(tableName, columnName)
}

function serializeValue (value: SnapshotValue): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value)
  }
  return `{"$bytes":${JSON.stringify(value.$bytes)}}`
}

/**
 * Build the digest preimage: whitespace-free JSON of `tables`, with table
 * names and, within each row, column names emitted in ascending UTF-16
 * code-unit order at both levels. Row arrays are emitted in the order
 * received and are NEVER re-sorted — the digest covers the payload as it
 * arrived. Throws a `TypeError` on any cell value outside the frozen
 * `SnapshotValue` union (see `assertSupportedValue`).
 */
export function canonicalizeTables (tables: SnapshotTables): string {
  const tableNames = Object.keys(tables).sort(compareKeys)
  const tableParts: string[] = []
  for (const tableName of tableNames) {
    const rows: readonly SnapshotRow[] = tables[tableName] ?? []
    const rowParts: string[] = []
    for (const row of rows) {
      const columnNames = Object.keys(row).sort(compareKeys)
      const cellParts: string[] = []
      for (const columnName of columnNames) {
        const value = assertSupportedValue(row[columnName], tableName, columnName)
        cellParts.push(`${JSON.stringify(columnName)}:${serializeValue(value)}`)
      }
      rowParts.push(`{${cellParts.join(',')}}`)
    }
    tableParts.push(`${JSON.stringify(tableName)}:[${rowParts.join(',')}]`)
  }
  return `{${tableParts.join(',')}}`
}

/**
 * Emit the whole envelope, whitespace-free, with the same canonical key
 * ordering applied at every level, so the transport bytes are reproducible
 * across machines and source key-insertion order. Delegates the `tables`
 * member to `canonicalizeTables` so there is exactly one implementation of
 * the table serialization — the bytes emitted here for `tables` are
 * byte-identical to a direct `canonicalizeTables(envelope.tables)` call.
 */
export function serializeSnapshot (envelope: BootstrapSnapshot): string {
  const manifestNames = Object.keys(envelope.manifest).sort(compareKeys)
  const manifestParts = manifestNames.map(
    (name) => `${JSON.stringify(name)}:${JSON.stringify(envelope.manifest[name])}`
  )
  const manifestJson = `{${manifestParts.join(',')}}`
  const tablesJson = canonicalizeTables(envelope.tables)
  return (
    `{"formatVersion":${JSON.stringify(envelope.formatVersion)},` +
    `"networkHash":${JSON.stringify(envelope.networkHash)},` +
    `"schemaHash":${JSON.stringify(envelope.schemaHash)},` +
    `"generatedAt":${JSON.stringify(envelope.generatedAt)},` +
    `"manifest":${manifestJson},` +
    `"digest":${JSON.stringify(envelope.digest)},` +
    `"tables":${tablesJson}}`
  )
}

const REQUIRED_MEMBERS = [
  'formatVersion',
  'networkHash',
  'schemaHash',
  'generatedAt',
  'manifest',
  'digest',
  'tables'
] as const

const STRING_MEMBERS = ['networkHash', 'schemaHash', 'generatedAt', 'digest'] as const

function isPlainObject (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Parse and structurally validate a serialized snapshot. NEVER throws — any
 * failure (a `JSON.parse` failure, a bare array, a missing member, a
 * wrong-typed member, a non-integer manifest count, a non-array tables
 * entry) returns `{ ok: false, reason: 'malformed-envelope', detail }`
 * where `detail` names only the structural fault and, where relevant, the
 * offending member/table NAME — never a value, never a JSON excerpt, and
 * never the raw `SyntaxError.message` (which embeds payload text).
 */
export function parseSnapshot (text: string): SnapshotParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'malformed-envelope', detail: 'snapshot: payload is not valid JSON' }
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, reason: 'malformed-envelope', detail: 'snapshot: payload is not a JSON object' }
  }

  for (const member of REQUIRED_MEMBERS) {
    if (!(member in parsed)) {
      return { ok: false, reason: 'malformed-envelope', detail: `snapshot: envelope missing member ${member}` }
    }
  }

  if (typeof parsed.formatVersion !== 'number') {
    return { ok: false, reason: 'malformed-envelope', detail: 'snapshot: envelope member formatVersion has wrong type' }
  }

  for (const member of STRING_MEMBERS) {
    if (typeof parsed[member] !== 'string') {
      return { ok: false, reason: 'malformed-envelope', detail: `snapshot: envelope member ${member} has wrong type` }
    }
  }

  const manifest = parsed.manifest
  if (!isPlainObject(manifest)) {
    return { ok: false, reason: 'malformed-envelope', detail: 'snapshot: envelope member manifest has wrong type' }
  }
  for (const [name, count] of Object.entries(manifest)) {
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      return { ok: false, reason: 'malformed-envelope', detail: `snapshot: manifest entry ${name} is not a non-negative integer` }
    }
  }

  const tables = parsed.tables
  if (!isPlainObject(tables)) {
    return { ok: false, reason: 'malformed-envelope', detail: 'snapshot: envelope member tables has wrong type' }
  }
  for (const [name, rows] of Object.entries(tables)) {
    if (!Array.isArray(rows)) {
      return { ok: false, reason: 'malformed-envelope', detail: `snapshot: tables entry ${name} is not an array` }
    }
  }

  return {
    ok: true,
    envelope: {
      formatVersion: parsed.formatVersion,
      networkHash: parsed.networkHash as string,
      schemaHash: parsed.schemaHash as string,
      generatedAt: parsed.generatedAt as string,
      manifest: manifest as SnapshotManifest,
      digest: parsed.digest as string,
      tables: tables as SnapshotTables
    }
  }
}

/**
 * Encode raw bytes as the envelope's one blob cell shape. Reuses
 * `bytesToBase64url` from `../utils.js` — the existing browser-safe
 * base64url encoder (uses the `btoa` global, no `Buffer`) — rather than
 * writing a second encoder.
 */
export function encodeBlobValue (bytes: Uint8Array): SnapshotBlobValue {
  return { $bytes: bytesToBase64url(bytes) }
}

/**
 * Inverse of `encodeBlobValue`. Implemented with the `atob` global — no
 * `Buffer`, no `node:` import — so this module stays browser-clean.
 */
export function decodeBlobValue (value: SnapshotBlobValue): Uint8Array {
  let b64 = value.$bytes.replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4 !== 0) b64 += '='
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
