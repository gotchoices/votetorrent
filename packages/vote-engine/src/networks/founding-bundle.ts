// src/networks/founding-bundle.ts — the pure founding-bundle codec (D-35,
// D-38, D-39; 62-16).
//
// No SQL, no database handle, never added to any barrel — imported only by
// `networks-engine.ts`, `genesis-rows.ts` (type-only) and tests. This
// module verifies a bundle's internal self-consistency and its exporter's
// signature WITHOUT touching a database, in a fixed, fail-closed check
// order (Phase 50 D-12/D-13 discipline: verify everything BEFORE anything
// is opened or written). It reuses the Phase 50 envelope helpers
// (`canonicalizeTables`, `buildManifest`, `computeContentDigest`,
// `computeSchemaHash`) rather than re-implementing them — see
// `bootstrap/snapshot-manifest.ts` / `snapshot-codec.ts`.
//
// `detail` strings on every failure carry table, column and constraint
// names and counts only — never a row or column VALUE (the bundle carries
// the founding officer's name, the network's relays and a public key; see
// `snapshot-types.ts` fact 3, the same discipline this module follows).
//
// This module MUST NOT import or name the shared Tid allocator or its
// persistence table, not even in a comment (G-2).

import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { toImageRef } from '@votetorrent/vote-core'
import type {
  FoundingBundle,
  FoundingBundleDescriptor,
  FoundingBundleExportErrorCode,
  FoundingBundleExporterSignature,
  FoundingBundleFailureCategory,
  FoundingBundleFailureReason,
  FoundingBundleRow,
  FoundingBundleRows,
  FoundingBundleTable
} from '@votetorrent/vote-core'
import { buildManifest, computeContentDigest, computeSchemaHash } from '../bootstrap/snapshot-manifest.js'
import { canonicalizeTables } from '../bootstrap/snapshot-codec.js'
import type { SnapshotTables } from '../bootstrap/snapshot-types.js'
import { verifySig, verifySigP256 } from '../database/initialize.js'
import { bytesToBase64url, H16 } from '../utils.js'
import { GENESIS_COLUMNS, FOUNDING_BUNDLE_TABLE_ORDER } from './genesis-rows.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const FOUNDING_BUNDLE_FORMAT = 'votetorrent-founding-bundle' as const
export const FOUNDING_BUNDLE_FORMAT_VERSION = 1 as const
export const FOUNDING_BUNDLE_SIGNING_DOMAIN = 'votetorrent/founding-bundle/v1' as const

/** Replay order — re-exported from `genesis-rows.ts` so there is one list. */
export const FOUNDING_BUNDLE_TABLES: readonly FoundingBundleTable[] = FOUNDING_BUNDLE_TABLE_ORDER

/** Checked before `JSON.parse` in `parseFoundingBundle` (DoS guard, T-62-16-08). */
export const MAX_FOUNDING_BUNDLE_CHARS = 262_144

/** Fixes the reason-to-category map 62-23 renders from (see `<interfaces>` in 62-16-PLAN.md). */
export const FOUNDING_FAILURE_CATEGORY: Readonly<Record<FoundingBundleFailureReason, FoundingBundleFailureCategory>> =
  Object.freeze({
    malformed: 'invalid-bundle',
    'manifest-mismatch': 'invalid-bundle',
    'digest-mismatch': 'invalid-bundle',
    'row-inconsistent': 'invalid-bundle',
    'descriptor-mismatch': 'invalid-bundle',
    'exporter-not-founding-officer': 'invalid-bundle',
    'signature-invalid': 'invalid-bundle',
    'anchor-required': 'invalid-bundle',
    'anchor-mismatch': 'invalid-bundle',
    'replay-rejected': 'invalid-bundle',
    'format-version-mismatch': 'error',
    'schema-hash-mismatch': 'error',
    'target-conflict': 'error',
    'target-open-failed': 'error',
    'target-replay-failed': 'error'
  })

/** Thrown by `NetworksEngine.exportFoundingBundle` on refusal — never a partial bundle. */
export class FoundingBundleExportError extends Error {
  readonly code: FoundingBundleExportErrorCode

  constructor (code: FoundingBundleExportErrorCode, message?: string) {
    super(message ?? `founding bundle export refused: ${code}`)
    this.name = 'FoundingBundleExportError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Descriptor derivation
// ---------------------------------------------------------------------------

function requireRow (rows: FoundingBundleRows, table: FoundingBundleTable): FoundingBundleRow {
  const row = rows[table]?.[0]
  if (!row) throw new Error(`deriveFoundingDescriptor: missing ${table} row`)
  return row
}

/**
 * Derive the human- and UI-facing descriptor from the six founding rows.
 * networkId = Network.Id, networkHash = Network.Hash (D-39), relays =
 * JSON.parse(Network.Relays) (must be a string array — throws otherwise),
 * primaryAuthorityDomainName = Authority.DomainName, imageUrl = the url of the parsed
 * Network.ImageRef (either stored form — see `toImageRef`), omitted when ImageRef is null.
 */
export function deriveFoundingDescriptor (rows: FoundingBundleRows): FoundingBundleDescriptor {
  const network = requireRow(rows, 'Network')
  const authority = requireRow(rows, 'Authority')

  let relays: string[]
  try {
    const parsed: unknown = JSON.parse(String(network.Relays ?? '[]'))
    if (!Array.isArray(parsed) || !parsed.every((r) => typeof r === 'string')) {
      throw new Error('not a string array')
    }
    relays = parsed
  } catch {
    throw new Error('deriveFoundingDescriptor: Network.Relays is not a JSON string array')
  }

  let imageUrl: string | undefined
  if (network.ImageRef !== null && network.ImageRef !== undefined) {
    try {
      // Either stored form (a bare JSON string, or `{ url, cid? }` since media pinning) yields
      // the same descriptor imageUrl, so bundles from either era compare equal.
      imageUrl = toImageRef(JSON.parse(String(network.ImageRef)))?.url
    } catch {
      // Not JSON — omitted.
    }
  }

  return {
    networkId: String(network.Id),
    networkHash: String(network.Hash),
    relays,
    name: String(network.Name),
    primaryAuthorityId: String(network.PrimaryAuthorityId),
    primaryAuthorityDomainName: String(authority.DomainName ?? ''),
    ...(imageUrl !== undefined ? { imageUrl } : {})
  }
}

function descriptorsEqual (a: FoundingBundleDescriptor, b: FoundingBundleDescriptor): boolean {
  if (a.networkId !== b.networkId) return false
  if (a.networkHash !== b.networkHash) return false
  if (a.name !== b.name) return false
  if (a.primaryAuthorityId !== b.primaryAuthorityId) return false
  if (a.primaryAuthorityDomainName !== b.primaryAuthorityDomainName) return false
  if ((a.imageUrl ?? undefined) !== (b.imageUrl ?? undefined)) return false
  if (a.relays.length !== b.relays.length) return false
  for (let i = 0; i < a.relays.length; i++) {
    if (a.relays[i] !== b.relays[i]) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Signing digest
// ---------------------------------------------------------------------------

/**
 * The exporter signing digest: sha256 over the UTF-8 preimage
 * `[FOUNDING_BUNDLE_SIGNING_DOMAIN, networkHash, schemaHash, exportedAt,
 * exporterUserId, signerKey, digest].join('\n')` (domain-separated, so a
 * signature over this preimage can never be replayed as a signature over a
 * different structure, e.g. an AdminSigning digest). `bytes` is handed to
 * the app's sign callback exactly as `seedSignedMutation` hands digest
 * bytes to its callback; `base64url` is what `verifySig`/`verifySigP256`
 * expect as their `digest` argument (the same encoding contract the
 * in-schema `SignatureValid` UDFs use).
 */
export function foundingBundleSigningDigest (fields: {
  readonly networkHash: string
  readonly schemaHash: string
  readonly exportedAt: string
  readonly exporterUserId: string
  readonly signerKey: string
  readonly digest: string
}): { readonly bytes: Uint8Array; readonly base64url: string } {
  const preimage = [
    FOUNDING_BUNDLE_SIGNING_DOMAIN,
    fields.networkHash,
    fields.schemaHash,
    fields.exportedAt,
    fields.exporterUserId,
    fields.signerKey,
    fields.digest
  ].join('\n')
  const bytes = sha256(utf8ToBytes(preimage))
  return { bytes, base64url: bytesToBase64url(bytes) }
}

// ---------------------------------------------------------------------------
// Serialize / parse
// ---------------------------------------------------------------------------

/** Ascending UTF-16 code-unit order — never locale-aware (ICU-dependent), mirrors snapshot-codec.ts. */
const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Whitespace-free, key-sorted-at-every-level serialization. `rows` is
 * delegated to `canonicalizeTables` so there is exactly one implementation
 * of table serialization, byte-identical to a direct
 * `canonicalizeTables(bundle.rows)` call.
 */
export function serializeFoundingBundle (bundle: FoundingBundle): string {
  const manifestNames = (Object.keys(bundle.manifest) as FoundingBundleTable[]).sort(compareKeys)
  const manifestJson = `{${manifestNames.map((name) => `${JSON.stringify(name)}:${JSON.stringify(bundle.manifest[name])}`).join(',')}}`

  const descriptorRecord = bundle.descriptor as unknown as Record<string, unknown>
  const descriptorKeys = Object.keys(descriptorRecord)
    .filter((k) => descriptorRecord[k] !== undefined)
    .sort(compareKeys)
  const descriptorJson = `{${descriptorKeys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(descriptorRecord[k])}`).join(',')}}`

  const exporterRecord = bundle.exporter as unknown as Record<string, unknown>
  const exporterKeys = Object.keys(exporterRecord).sort(compareKeys)
  const exporterJson = `{${exporterKeys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(exporterRecord[k])}`).join(',')}}`

  const rowsJson = canonicalizeTables(bundle.rows as unknown as SnapshotTables)

  return (
    `{"format":${JSON.stringify(bundle.format)},` +
    `"formatVersion":${JSON.stringify(bundle.formatVersion)},` +
    `"descriptor":${descriptorJson},` +
    `"schemaHash":${JSON.stringify(bundle.schemaHash)},` +
    `"exportedAt":${JSON.stringify(bundle.exportedAt)},` +
    `"manifest":${manifestJson},` +
    `"digest":${JSON.stringify(bundle.digest)},` +
    `"rows":${rowsJson},` +
    `"exporter":${exporterJson}}`
  )
}

export type FoundingBundleParseResult =
  | { readonly ok: true; readonly bundle: FoundingBundle }
  | { readonly ok: false; readonly reason: 'malformed'; readonly detail: string }

const REQUIRED_MEMBERS = ['format', 'formatVersion', 'descriptor', 'schemaHash', 'exportedAt', 'manifest', 'digest', 'rows', 'exporter'] as const
const STRING_MEMBERS = ['format', 'schemaHash', 'exportedAt', 'digest'] as const
const DESCRIPTOR_STRING_FIELDS = ['networkId', 'networkHash', 'name', 'primaryAuthorityId', 'primaryAuthorityDomainName'] as const
const DESCRIPTOR_KNOWN_KEYS = new Set<string>([...DESCRIPTOR_STRING_FIELDS, 'relays', 'imageUrl'])
const EXPORTER_STRING_FIELDS = ['userId', 'signerKey', 'signature'] as const

function isPlainObject (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Parse and structurally validate a serialized founding bundle. NEVER
 * throws — see `parseSnapshot`'s doc comment for the same discipline this
 * mirrors. `detail` names only the structural fault and, where relevant,
 * the offending member/table/column NAME — never a value.
 */
export function parseFoundingBundle (text: string): FoundingBundleParseResult {
  if (text.length > MAX_FOUNDING_BUNDLE_CHARS) {
    return { ok: false, reason: 'malformed', detail: `founding bundle: payload exceeds ${MAX_FOUNDING_BUNDLE_CHARS} characters` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'malformed', detail: 'founding bundle: payload is not valid JSON' }
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, reason: 'malformed', detail: 'founding bundle: payload is not a JSON object' }
  }

  for (const member of REQUIRED_MEMBERS) {
    if (!(member in parsed)) {
      return { ok: false, reason: 'malformed', detail: `founding bundle: missing member ${member}` }
    }
  }
  const topKeys = Object.keys(parsed)
  if (topKeys.length !== REQUIRED_MEMBERS.length) {
    return { ok: false, reason: 'malformed', detail: 'founding bundle: unexpected extra top-level member' }
  }

  if (parsed.format !== FOUNDING_BUNDLE_FORMAT) {
    return { ok: false, reason: 'malformed', detail: 'founding bundle: member format has an unrecognized value' }
  }
  if (typeof parsed.formatVersion !== 'number') {
    return { ok: false, reason: 'malformed', detail: 'founding bundle: member formatVersion has wrong type' }
  }
  for (const member of STRING_MEMBERS) {
    if (typeof parsed[member] !== 'string') {
      return { ok: false, reason: 'malformed', detail: `founding bundle: member ${member} has wrong type` }
    }
  }

  const descriptor = parsed.descriptor
  if (!isPlainObject(descriptor)) {
    return { ok: false, reason: 'malformed', detail: 'founding bundle: member descriptor has wrong type' }
  }
  for (const field of DESCRIPTOR_STRING_FIELDS) {
    if (typeof descriptor[field] !== 'string') {
      return { ok: false, reason: 'malformed', detail: `founding bundle: descriptor.${field} has wrong type` }
    }
  }
  if (!Array.isArray(descriptor.relays) || !descriptor.relays.every((r) => typeof r === 'string')) {
    return { ok: false, reason: 'malformed', detail: 'founding bundle: descriptor.relays has wrong type' }
  }
  if ('imageUrl' in descriptor && descriptor.imageUrl !== undefined && typeof descriptor.imageUrl !== 'string') {
    return { ok: false, reason: 'malformed', detail: 'founding bundle: descriptor.imageUrl has wrong type' }
  }
  for (const key of Object.keys(descriptor)) {
    if (!DESCRIPTOR_KNOWN_KEYS.has(key)) {
      return { ok: false, reason: 'malformed', detail: `founding bundle: descriptor has an unexpected member ${key}` }
    }
  }

  const manifest = parsed.manifest
  if (!isPlainObject(manifest)) {
    return { ok: false, reason: 'malformed', detail: 'founding bundle: member manifest has wrong type' }
  }
  for (const [name, count] of Object.entries(manifest)) {
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      return { ok: false, reason: 'malformed', detail: `founding bundle: manifest entry ${name} is not a non-negative integer` }
    }
  }

  const rows = parsed.rows
  if (!isPlainObject(rows)) {
    return { ok: false, reason: 'malformed', detail: 'founding bundle: member rows has wrong type' }
  }
  for (const [tableName, tableRows] of Object.entries(rows)) {
    if (!Array.isArray(tableRows)) {
      return { ok: false, reason: 'malformed', detail: `founding bundle: rows.${tableName} is not an array` }
    }
    for (const row of tableRows) {
      if (!isPlainObject(row)) {
        return { ok: false, reason: 'malformed', detail: `founding bundle: a row in rows.${tableName} is not an object` }
      }
      for (const [col, value] of Object.entries(row)) {
        if (value !== null && typeof value !== 'string' && typeof value !== 'number') {
          return { ok: false, reason: 'malformed', detail: `founding bundle: rows.${tableName}.${col} has an unsupported value type` }
        }
        if (typeof value === 'number' && !Number.isFinite(value)) {
          return { ok: false, reason: 'malformed', detail: `founding bundle: rows.${tableName}.${col} is not a finite number` }
        }
      }
    }
  }

  const exporter = parsed.exporter
  if (!isPlainObject(exporter)) {
    return { ok: false, reason: 'malformed', detail: 'founding bundle: member exporter has wrong type' }
  }
  for (const field of EXPORTER_STRING_FIELDS) {
    if (typeof exporter[field] !== 'string') {
      return { ok: false, reason: 'malformed', detail: `founding bundle: exporter.${field} has wrong type` }
    }
  }

  const bundle: FoundingBundle = {
    format: FOUNDING_BUNDLE_FORMAT,
    // Intentionally NOT coerced to the literal 1 — an attacker-supplied wrong
    // version must survive parsing so verifyFoundingBundle's check order can
    // catch it as format-version-mismatch (check 2), not silently normalize it.
    formatVersion: parsed.formatVersion as 1,
    descriptor: descriptor as unknown as FoundingBundleDescriptor,
    schemaHash: parsed.schemaHash as string,
    exportedAt: parsed.exportedAt as string,
    manifest: manifest as unknown as Readonly<Record<FoundingBundleTable, number>>,
    digest: parsed.digest as string,
    rows: rows as unknown as FoundingBundleRows,
    exporter: exporter as unknown as FoundingBundleExporterSignature
  }
  return { ok: true, bundle }
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

export interface FoundingBundleAnchors {
  readonly expectedNetworkHash?: string
  readonly expectedDigest?: string
  /** The fingerprint an officer typed from the exporter's screen; compared in constant time. */
  readonly expectedFingerprint?: string
}

// ---------------------------------------------------------------------------
// Fingerprint (62-102 C1, D-36 out-of-band confirmation)
// ---------------------------------------------------------------------------

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function decodeBase64url (text: string): Uint8Array {
  const out: number[] = []
  let acc = 0
  let bits = 0
  for (const ch of text) {
    const v = BASE64URL_ALPHABET.indexOf(ch)
    if (v < 0) throw new Error('founding bundle: digest is not base64url')
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((acc >> bits) & 0xff)
      acc &= (1 << bits) - 1
    }
  }
  return Uint8Array.from(out)
}

/**
 * The human-comparable fingerprint of a bundle digest: the first 8 bytes of
 * the base64url-decoded digest as 16 lowercase hex characters in four groups
 * of four separated by single spaces. Throws if the digest decodes to fewer
 * than 8 bytes.
 */
export function foundingBundleFingerprint (digest: string): string {
  const bytes = decodeBase64url(digest)
  if (bytes.length < 8) throw new Error('founding bundle: digest too short to fingerprint')
  let hex = ''
  for (let i = 0; i < 8; i++) hex += bytes[i]!.toString(16).padStart(2, '0')
  return `${hex.slice(0, 4)} ${hex.slice(4, 8)} ${hex.slice(8, 12)} ${hex.slice(12, 16)}`
}

/** Lowercase and strip spaces and dashes from a typed fingerprint. */
export function normalizeFingerprintInput (text: string): string {
  return text.toLowerCase().replace(/[\s-]/g, '')
}

/**
 * Constant-time comparison of a typed fingerprint against the one derived
 * from `digest`: both sides are padded to 16 characters and every character
 * code is XOR-accumulated with no early exit; length and charset problems
 * fold into the accumulator and are tested once at the end.
 */
export function fingerprintsMatch (typed: string, digest: string): boolean {
  let expected: string
  try {
    expected = foundingBundleFingerprint(digest).replace(/ /g, '')
  } catch {
    return false
  }
  const given = normalizeFingerprintInput(typed)
  const width = Math.max(16, given.length)
  let acc = given.length ^ expected.length
  for (let i = 0; i < width; i++) {
    const a = i < given.length ? given.charCodeAt(i) : 0
    const b = i < expected.length ? expected.charCodeAt(i) : 0
    acc |= a ^ b
  }
  return acc === 0
}

export type FoundingBundleVerifyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: FoundingBundleFailureReason; readonly detail: string }

const CANONICAL_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/

/**
 * Verify a parsed bundle's internal self-consistency and exporter
 * signature, in this FIXED order (Phase 50 D-12/D-13 discipline — verify
 * everything before anything is opened or written):
 *
 *   1. format + formatVersion
 *   2. exportedAt is 19-char canonical
 *   3. schemaHash === computeSchemaHash()
 *   4. manifest agreement (exactly one row per table, six tables, no extra)
 *   5. digest === computeContentDigest(rows)
 *   6. row-inconsistent: column sets, Network.Hash = H16(Network.Id) (D-39),
 *      and the cross-table links
 *   7. descriptor deep-equals deriveFoundingDescriptor(rows)
 *   8. exporter identity: userId/signerKey/exportedAt against the rows
 *   9. exporter signature verifies over foundingBundleSigningDigest(...)
 *   10. anchors, when given
 *
 * Never touches a database. Never throws.
 */
export function verifyFoundingBundle (bundle: FoundingBundle, anchors: FoundingBundleAnchors = {}): FoundingBundleVerifyResult {
  // 1. format + formatVersion
  if (bundle.format !== FOUNDING_BUNDLE_FORMAT) {
    return { ok: false, reason: 'malformed', detail: 'founding bundle: unrecognized format' }
  }
  if (bundle.formatVersion !== FOUNDING_BUNDLE_FORMAT_VERSION) {
    return {
      ok: false,
      reason: 'format-version-mismatch',
      detail: `founding bundle: expected formatVersion ${FOUNDING_BUNDLE_FORMAT_VERSION}, got ${String(bundle.formatVersion)}`
    }
  }

  // 2. exportedAt canonical
  if (!CANONICAL_DATETIME_PATTERN.test(bundle.exportedAt)) {
    return { ok: false, reason: 'malformed', detail: 'founding bundle: exportedAt is not a 19-char canonical datetime' }
  }

  // 3. schemaHash
  if (bundle.schemaHash !== computeSchemaHash()) {
    return { ok: false, reason: 'schema-hash-mismatch', detail: 'founding bundle: schemaHash does not match the expected schema' }
  }

  // 4. manifest
  const manifestKeys = Object.keys(bundle.manifest)
  if (manifestKeys.length !== FOUNDING_BUNDLE_TABLE_ORDER.length) {
    return { ok: false, reason: 'manifest-mismatch', detail: 'founding bundle: manifest has an unexpected table' }
  }
  const expectedManifest = buildManifest(bundle.rows as unknown as SnapshotTables)
  for (const table of FOUNDING_BUNDLE_TABLE_ORDER) {
    if (!(table in bundle.manifest)) {
      return { ok: false, reason: 'manifest-mismatch', detail: `founding bundle: manifest missing table ${table}` }
    }
    const manifestCount = bundle.manifest[table]
    const actualCount = expectedManifest[table] ?? 0
    if (manifestCount !== actualCount) {
      return { ok: false, reason: 'manifest-mismatch', detail: `founding bundle: table ${table} row count mismatch` }
    }
    if (manifestCount !== 1) {
      return { ok: false, reason: 'manifest-mismatch', detail: `founding bundle: table ${table} must carry exactly one row` }
    }
  }

  // 5. digest
  if (bundle.digest !== computeContentDigest(bundle.rows as unknown as SnapshotTables)) {
    return { ok: false, reason: 'digest-mismatch', detail: 'founding bundle: digest does not match the recomputed content digest' }
  }

  // 6. row-inconsistent
  for (const table of FOUNDING_BUNDLE_TABLE_ORDER) {
    const row = bundle.rows[table]?.[0]
    if (!row) return { ok: false, reason: 'row-inconsistent', detail: `founding bundle: table ${table} is missing its row` }
    const expectedCols = [...GENESIS_COLUMNS[table]].sort(compareKeys)
    const actualCols = Object.keys(row).sort(compareKeys)
    if (actualCols.length !== expectedCols.length || actualCols.some((c, i) => c !== expectedCols[i])) {
      return { ok: false, reason: 'row-inconsistent', detail: `founding bundle: table ${table} has an unexpected column set` }
    }
  }
  const user = bundle.rows.User[0]!
  const userKey = bundle.rows.UserKey[0]!
  const authority = bundle.rows.Authority[0]!
  const admin = bundle.rows.Admin[0]!
  const officer = bundle.rows.Officer[0]!
  const network = bundle.rows.Network[0]!

  if (String(network.Hash) !== H16(String(network.Id))) {
    return { ok: false, reason: 'row-inconsistent', detail: 'founding bundle: Network.Hash does not equal H16(Network.Id)' }
  }
  if (network.PrimaryAuthorityId !== authority.Id) {
    return { ok: false, reason: 'row-inconsistent', detail: 'founding bundle: Network.PrimaryAuthorityId does not equal Authority.Id' }
  }
  if (authority.Id !== admin.AuthorityId) {
    return { ok: false, reason: 'row-inconsistent', detail: 'founding bundle: Admin.AuthorityId does not equal Authority.Id' }
  }
  if (admin.AuthorityId !== officer.AuthorityId) {
    return { ok: false, reason: 'row-inconsistent', detail: 'founding bundle: Officer.AuthorityId does not equal Admin.AuthorityId' }
  }
  if (officer.AdminEffectiveAt !== admin.EffectiveAt) {
    return { ok: false, reason: 'row-inconsistent', detail: 'founding bundle: Officer.AdminEffectiveAt does not equal Admin.EffectiveAt' }
  }
  if (officer.UserId !== user.Id) {
    return { ok: false, reason: 'row-inconsistent', detail: 'founding bundle: Officer.UserId does not equal User.Id' }
  }
  if (user.Id !== userKey.UserId) {
    return { ok: false, reason: 'row-inconsistent', detail: 'founding bundle: UserKey.UserId does not equal User.Id' }
  }

  // 7. descriptor
  let derivedDescriptor: FoundingBundleDescriptor
  try {
    derivedDescriptor = deriveFoundingDescriptor(bundle.rows)
  } catch {
    return { ok: false, reason: 'row-inconsistent', detail: 'founding bundle: descriptor could not be derived from the rows' }
  }
  if (!descriptorsEqual(derivedDescriptor, bundle.descriptor)) {
    return { ok: false, reason: 'descriptor-mismatch', detail: 'founding bundle: descriptor does not match the rows' }
  }

  // 8. exporter identity
  if (bundle.exporter.userId !== user.Id) {
    return { ok: false, reason: 'exporter-not-founding-officer', detail: 'founding bundle: exporter.userId is not the founding User' }
  }
  if (bundle.exporter.signerKey !== userKey.PubKey) {
    return { ok: false, reason: 'exporter-not-founding-officer', detail: 'founding bundle: exporter.signerKey is not the founding UserKey' }
  }
  if (bundle.exportedAt > String(userKey.Expiration)) {
    return { ok: false, reason: 'exporter-not-founding-officer', detail: 'founding bundle: exportedAt is after the founding key Expiration' }
  }

  // 9. exporter signature
  const signingDigest = foundingBundleSigningDigest({
    networkHash: bundle.descriptor.networkHash,
    schemaHash: bundle.schemaHash,
    exportedAt: bundle.exportedAt,
    exporterUserId: bundle.exporter.userId,
    signerKey: bundle.exporter.signerKey,
    digest: bundle.digest
  })
  const verifier = String(userKey.Type) === 'P' ? verifySigP256 : verifySig
  if (!verifier(signingDigest.base64url, bundle.exporter.signature, bundle.exporter.signerKey)) {
    return { ok: false, reason: 'signature-invalid', detail: 'founding bundle: exporter signature does not verify' }
  }

  // 10. anchors
  if (anchors.expectedNetworkHash !== undefined && bundle.descriptor.networkHash !== anchors.expectedNetworkHash) {
    return { ok: false, reason: 'anchor-mismatch', detail: 'founding bundle: networkHash does not match the expected anchor' }
  }
  if (anchors.expectedDigest !== undefined && bundle.digest !== anchors.expectedDigest) {
    return { ok: false, reason: 'anchor-mismatch', detail: 'founding bundle: digest does not match the expected anchor' }
  }

  if (anchors.expectedFingerprint !== undefined && !fingerprintsMatch(anchors.expectedFingerprint, bundle.digest)) {
    return { ok: false, reason: 'anchor-mismatch', detail: 'founding bundle: fingerprint does not match the expected anchor' }
  }

  return { ok: true }
}
