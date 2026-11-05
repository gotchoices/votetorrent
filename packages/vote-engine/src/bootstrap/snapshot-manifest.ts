// src/bootstrap/snapshot-manifest.ts — manifest, content digest, schema
// hash, and the fail-closed `verifySnapshot` gate (D-07, D-12, D-13;
// Phase 50 Plan 02).
//
// `verifySnapshot` is the single gate every Phase 50 consumer runs before a
// byte reaches IndexedDB. Its eight checks fall into two families the UI
// (50-08) renders differently:
//
//   - Checks 1-3 and 5 (structural sanity, format version, the canonical
//     `generatedAt` shape, and the schema hash) are the "wrong version"
//     family — the honest failure mode is that the producing authority app
//     and the consuming dashboard disagree on the envelope shape or the
//     schema underneath it. Rendered as "This authority app is running a
//     different version."
//   - Checks 6-8 (manifest agreement, the content digest, and an optional
//     out-of-band expected digest) are the "checksum" family — the envelope
//     parses and claims the right shape/schema, but its content did not
//     survive transport intact, or does not match what the redemption code
//     promised. Rendered as "Couldn't verify the new snapshot."
//
// `verifySnapshot` returning anything other than `{ ok: true }` means NO
// row from this envelope may reach IndexedDB, and NO existing local copy
// may be discarded (D-12: replace, verifying before discarding; never
// merge). The check order below is itself part of the contract — reordering
// it changes which reason an operator sees for the same underlying fault.

import { digest } from '@optimystic/quereus-plugin-crypto'
import { VOTETORRENT_SCHEMA_SQL } from '../database/schema-sql.js'
import { nowCanonicalDatetime } from '../utils.js'
import { canonicalizeTables } from './snapshot-codec.js'
import { SNAPSHOT_FORMAT_VERSION } from './snapshot-types.js'
import type {
  BootstrapSnapshot,
  SnapshotManifest,
  SnapshotTables,
  SnapshotVerifyResult,
  VerifySnapshotOptions
} from './snapshot-types.js'

const GENERATED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/

/**
 * One entry per table present in `tables`, value = row count. A zero-row
 * table is INCLUDED with count `0`, never omitted — omission is exactly how
 * a dropped-and-recreated table would hide from `verifySnapshot`'s manifest
 * check.
 */
export function buildManifest (tables: SnapshotTables): SnapshotManifest {
  const manifest: Record<string, number> = {}
  for (const [tableName, rows] of Object.entries(tables)) {
    manifest[tableName] = rows.length
  }
  return manifest
}

/**
 * The content digest: base64url SHA-256 over the canonically key-ordered
 * serialization of `tables` (see `canonicalizeTables`). This is the
 * FRAMED digest from `@optimystic/quereus-plugin-crypto` — one field, one
 * string — deliberately NOT a bare `sha256` of the preimage, so nobody
 * later "verifies" it by re-hashing the preimage with a different
 * primitive and is baffled when the two disagree.
 */
export function computeContentDigest (tables: SnapshotTables): string {
  return digest([canonicalizeTables(tables)], 'sha256', 'base64url') as string
}

/**
 * Same framed-digest primitive, applied to the schema DDL string instead of
 * table content. The `schemaSql` parameter exists solely so the spec can
 * produce a genuinely different hash without mutating the generated
 * `schema-sql.ts` module; production callers always take the default.
 */
export function computeSchemaHash (schemaSql: string = VOTETORRENT_SCHEMA_SQL): string {
  return digest([schemaSql], 'sha256', 'base64url') as string
}

/**
 * Assemble the frozen envelope. This is the single entry point 50-07 (the
 * producer, in `apps/VoteTorrentAuthority`) calls.
 */
export function buildSnapshot (input: {
  readonly networkHash: string
  readonly tables: SnapshotTables
  readonly generatedAt?: string
}): BootstrapSnapshot {
  return {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    networkHash: input.networkHash,
    schemaHash: computeSchemaHash(),
    generatedAt: input.generatedAt ?? nowCanonicalDatetime(),
    manifest: buildManifest(input.tables),
    digest: computeContentDigest(input.tables),
    tables: input.tables
  }
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
 * Structural sanity check (`verifySnapshot` step 1). Defensive even though
 * the caller's static type is `BootstrapSnapshot`, because a caller may
 * construct one by hand (tests do exactly this to prove the negative
 * cases) rather than only ever receiving one from `parseSnapshot`.
 */
function structuralFault (envelope: unknown): string | null {
  if (!isPlainObject(envelope)) return 'snapshot: envelope is not an object'
  for (const member of REQUIRED_MEMBERS) {
    if (!(member in envelope)) return `snapshot: envelope missing member ${member}`
  }
  if (typeof envelope.formatVersion !== 'number') {
    return 'snapshot: envelope member formatVersion has wrong type'
  }
  for (const member of STRING_MEMBERS) {
    if (typeof envelope[member] !== 'string') {
      return `snapshot: envelope member ${member} has wrong type`
    }
  }
  const manifest = envelope.manifest
  if (!isPlainObject(manifest)) return 'snapshot: envelope member manifest has wrong type'
  for (const [name, count] of Object.entries(manifest)) {
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      return `snapshot: manifest entry ${name} is not a non-negative integer`
    }
  }
  const tables = envelope.tables
  if (!isPlainObject(tables)) return 'snapshot: envelope member tables has wrong type'
  for (const [name, rows] of Object.entries(tables)) {
    if (!Array.isArray(rows)) return `snapshot: tables entry ${name} is not an array`
  }
  return null
}

/**
 * Fail-closed, reason-returning verification. Returns the FIRST failure.
 * The check order is load-bearing and part of the contract:
 *
 *   1. Structural sanity                          -> malformed-envelope
 *   2. formatVersion === SNAPSHOT_FORMAT_VERSION   -> format-version-mismatch
 *   3. generatedAt matches the 19-char canonical form (no `Z`) -> non-canonical-generated-at
 *   4. options.expectedNetworkHash (if supplied)   -> network-hash-mismatch
 *   5. schemaHash === (expectedSchemaHash ?? computeSchemaHash()) -> schema-hash-mismatch
 *   6. manifest agreement (key sets + per-table counts) -> manifest-mismatch
 *   7. digest === computeContentDigest(tables)     -> digest-mismatch
 *   8. options.expectedDigest (if supplied)        -> digest-mismatch
 *
 * Step 6 MUST precede step 7: a truncated payload changes both the row
 * counts and the digest, and the reason an operator needs is the row-count
 * one (which table, how many rows expected vs. actual) — not an opaque
 * checksum mismatch that gives no hint where to look.
 */
export function verifySnapshot (
  envelope: BootstrapSnapshot,
  options: VerifySnapshotOptions = {}
): SnapshotVerifyResult {
  const fault = structuralFault(envelope)
  if (fault !== null) {
    return { ok: false, reason: 'malformed-envelope', detail: fault }
  }

  if (envelope.formatVersion !== SNAPSHOT_FORMAT_VERSION) {
    return {
      ok: false,
      reason: 'format-version-mismatch',
      detail: `snapshot: expected formatVersion ${SNAPSHOT_FORMAT_VERSION}, got ${envelope.formatVersion}`
    }
  }

  if (!GENERATED_AT_PATTERN.test(envelope.generatedAt)) {
    return {
      ok: false,
      reason: 'non-canonical-generated-at',
      detail: `snapshot: generatedAt has invalid form (length=${envelope.generatedAt.length}, expected 19 with no Z suffix)`
    }
  }

  if (options.expectedNetworkHash !== undefined && envelope.networkHash !== options.expectedNetworkHash) {
    return {
      ok: false,
      reason: 'network-hash-mismatch',
      detail: 'snapshot: networkHash does not match the expected network'
    }
  }

  const expectedSchemaHash = options.expectedSchemaHash ?? computeSchemaHash()
  if (envelope.schemaHash !== expectedSchemaHash) {
    return {
      ok: false,
      reason: 'schema-hash-mismatch',
      detail: 'snapshot: schemaHash does not match the expected schema'
    }
  }

  const manifestNames = new Set(Object.keys(envelope.manifest))
  const tableNames = new Set(Object.keys(envelope.tables))
  for (const name of manifestNames) {
    if (!tableNames.has(name)) {
      return {
        ok: false,
        reason: 'manifest-mismatch',
        detail: `snapshot: table ${name} present in manifest but absent from tables`
      }
    }
  }
  for (const name of tableNames) {
    if (!manifestNames.has(name)) {
      return {
        ok: false,
        reason: 'manifest-mismatch',
        detail: `snapshot: table ${name} present in tables but absent from manifest`
      }
    }
  }
  for (const name of tableNames) {
    const expected = envelope.manifest[name]!
    const actual = envelope.tables[name]!.length
    if (expected !== actual) {
      return {
        ok: false,
        reason: 'manifest-mismatch',
        detail: `snapshot: table ${name} row count mismatch (manifest=${expected}, tables=${actual})`
      }
    }
  }

  if (envelope.digest !== computeContentDigest(envelope.tables)) {
    return {
      ok: false,
      reason: 'digest-mismatch',
      detail: 'snapshot: digest does not match the recomputed content digest'
    }
  }

  if (options.expectedDigest !== undefined && envelope.digest !== options.expectedDigest) {
    return {
      ok: false,
      reason: 'digest-mismatch',
      detail: 'snapshot: out-of-band expected digest did not match'
    }
  }

  return { ok: true }
}
