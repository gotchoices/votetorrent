// src/bootstrap/snapshot-types.ts — the frozen BootstrapSnapshot envelope
// contract (D-07, D-12, D-13; Phase 50 Plan 02).
//
// Types and literal constants only. No logic, no imports of runtime code.
// This is the single source of truth for the envelope shape the producer
// (50-07, the RN authority app) and the consumers (50-08 first bootstrap,
// 50-09 refresh) exchange — neither side may redefine a field name, a
// failure reason, or the digest's scope; they import from here instead.
//
// Three load-bearing facts a reader must not get wrong:
//
// 1. The `digest` member covers the `tables` member only — not
//    `networkHash`, not `manifest`, not `generatedAt`. Nothing outside the
//    `tables` member is hashed, ever.
//
// 2. The envelope-carried `digest` is a corruption/truncation check, not
//    authentication: an attacker who controls the payload controls the
//    `digest` field too. Authentication comes from
//    `VerifySnapshotOptions.expectedDigest`, supplied out-of-band by the
//    redemption code — that is what makes the digest a trust anchor rather
//    than the endpoint's `https://`.
//
// 3. `detail` strings are for operators and logs and must never contain a
//    row value or a column value — the snapshot carries registrant PII.
//    Table names, column names and integer counts only.

/** The literal format version for this phase. Never widened to `number`. */
export const SNAPSHOT_FORMAT_VERSION: 1 = 1

/**
 * The only object form a snapshot cell value may take. Exists so a genuine
 * BLOB column survives the envelope without the codec silently coercing it;
 * every other object shape is malformed. `$bytes` is base64url.
 */
export interface SnapshotBlobValue {
  readonly $bytes: string
}

/** A single cell value carried by the envelope. */
export type SnapshotValue = string | number | boolean | null | SnapshotBlobValue

/** A single row: column name to cell value. */
export type SnapshotRow = Readonly<Record<string, SnapshotValue>>

/** Every table's rows, keyed by table name. */
export type SnapshotTables = Readonly<Record<string, readonly SnapshotRow[]>>

/** Row count for every table present in `tables` — see `buildManifest`. */
export type SnapshotManifest = Readonly<Record<string, number>>

/**
 * The frozen snapshot envelope. A JSON document, Hermes-safe and
 * browser-safe: no `Buffer`, no `node:crypto`, no `node:*` import of any
 * kind anywhere in the modules that produce or consume it.
 */
export interface BootstrapSnapshot {
  /** `SNAPSHOT_FORMAT_VERSION`, the literal `1` for this phase. */
  readonly formatVersion: number
  /** The network this snapshot belongs to. One IndexedDB database IS one network (D-07/D-08). */
  readonly networkHash: string
  /** base64url SHA-256 over `VOTETORRENT_SCHEMA_SQL`. */
  readonly schemaHash: string
  /** 19-character canonical datetime, no `Z` suffix. */
  readonly generatedAt: string
  /** Row count for every table present in `tables`. */
  readonly manifest: SnapshotManifest
  /** base64url SHA-256 over the canonically key-ordered UTF-8 serialization of the `tables` member only. */
  readonly digest: string
  /** The whole local database verbatim (D-07). */
  readonly tables: SnapshotTables
}

/**
 * Every way `verifySnapshot` can refuse an envelope, in check order. This
 * order is part of the contract — see `snapshot-manifest.ts`'s
 * `verifySnapshot` for the load-bearing sequence.
 */
export type SnapshotVerifyFailureReason =
  | 'malformed-envelope'
  | 'format-version-mismatch'
  | 'non-canonical-generated-at'
  | 'network-hash-mismatch'
  | 'schema-hash-mismatch'
  | 'manifest-mismatch'
  | 'digest-mismatch'

/** The fail-closed, reason-returning result of `verifySnapshot`. */
export type SnapshotVerifyResult =
  | { readonly ok: true }
  | { readonly ok: false, readonly reason: SnapshotVerifyFailureReason, readonly detail: string }

/** The non-throwing result of `parseSnapshot`. */
export type SnapshotParseResult =
  | { readonly ok: true, readonly envelope: BootstrapSnapshot }
  | { readonly ok: false, readonly reason: 'malformed-envelope', readonly detail: string }

/**
 * Out-of-band anchors a caller may supply to `verifySnapshot`, sourced
 * independently of the envelope itself (e.g. the D-05 redemption code).
 * Without these, `verifySnapshot` proves only internal self-consistency —
 * see fact 2 above.
 */
export interface VerifySnapshotOptions {
  readonly expectedDigest?: string
  readonly expectedNetworkHash?: string
  readonly expectedSchemaHash?: string
}
