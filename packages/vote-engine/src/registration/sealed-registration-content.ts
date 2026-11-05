// src/registration/sealed-registration-content.ts — Phase 62 Plan 31 (D-49, T-62-01-10)
//
// The single seal/open module for registration content. Before this plan, intake wrote the
// decrypted `RegisterInit` JSON straight into `RegistrationRequest.Payload`, and `register()` wrote
// `JSON.stringify(details)` straight into `RegistrantPrivate.PrivateDetails` — both plain, both
// replicated to every strand member, voters included (62-RESEARCH-INTAKE-SEALING.md Q3). 62-03
// already dropped the one schema CHECK that forced plaintext (`RegistrationRequest.PayloadCidValid`,
// D-49 schema half). This module makes the engine store a 62-04 sealed envelope (D-04: one content
// key wrapped per current officer, resolved through 62-14's `createIntakeSealer`) in both columns,
// opens it only in memory, and — because the dropped CHECK is no longer there to do it — RE-VERIFIES
// the Payload-to-PayloadCid binding at every open (the tier-2 recheck below). `RegistrantPrivate` has
// no analogous recheck: its own `CidValid`/`RegistrantCidMatch`/`InsertValid` CHECKs already hash
// whatever bytes are stored (the sealed envelope text, now), so the stored text is self-certifying —
// no column analogous to PayloadCid exists for it.
//
// Opened plaintext lives in memory only: it is never logged, never placed in a `detail` string, and
// never returned beyond the parsed object this module hands back. Legacy rows (written before this
// plan) stay unsealed forever (D-07 — nothing is migrated, re-signed, redacted or deleted); readers
// recognise them by `isSealedRegistrationContent` returning false and still apply the tier-2 recheck.
// D-51 accepts the residual this plan's sealing creates: an officer whose encryption key was not a
// recipient when a row was sealed (joined later, or had not enabled encrypted intake) reads that row
// as `'not-a-recipient'` — there is no re-wrap ceremony. See `62-31-SECURITY-REVIEW.md`.

// D-52 (62-36, T-62-31-13): `RegistrantSelective.SelectiveDetails` is sealed the same way as the
// private tier. Difference: its Cid is cid(set_commit(PLAINTEXT leaves)) — recipients verify
// disclosures against that root with `setVerify` — so the Cid is computed BEFORE sealing and the
// envelope binding includes it (`registrantSelectiveBinding`). The schema `CidValid` that recomputed
// it from the stored column was dropped by 62-33, so `openRegistrantSelectiveDetails` re-checks
// `cid(set_commit(plaintext)) === Cid` at every open, sealed or legacy, failing closed as 'tampered'.
// Plaintext leaves and salts live in memory only. Legacy plaintext rows read 'unsealed' (D-07); an
// officer who was not a recipient at write time reads 'not-a-recipient' (D-51, no re-wrap).

import type { Database } from '@quereus/quereus'
import type { PrivateDetail, RegisterInit, RegistrationContentAccess } from '@votetorrent/vote-core'
import type { SelectiveLeaf } from '@votetorrent/vote-core'
import { envelopeRecipientUserIds } from '../crypto/index.js'
import type { EnvelopeBinding } from '../crypto/index.js'
import { intakeQueryPortFromDb } from '../intake/query-port.js'
import { createIntakeSealer } from '../intake/sealing.js'
import type { IntakeOpener } from '../intake/types.js'

/** The domain-separation label for `RegistrantPrivate`'s envelope binding (distinct from a
 * `RegistrationRequest`'s own `{ requestId, digest: payloadCid }` binding, so a sealed private-tier
 * envelope can never be replayed as a sealed request payload or vice versa — see
 * `registrantPrivateBinding`). */
export const REGISTRANT_PRIVATE_BINDING_LABEL = 'vt-registrant-private-1'

/** `RegistrantPrivate.PrivateDetails` stored value for an empty `details` list — never sealed (no
 * recipient is needed to disclose "there is no private tier"; see `sealRegistrantPrivateDetails`). */
export const REGISTRANT_PRIVATE_EMPTY_DETAILS = '[]'

/** True iff `stored` is a string holding a structurally valid vt-env-1 envelope. Never throws — a
 * malformed or non-string value is simply not sealed (it is read as unsealed/legacy content). */
export function isSealedRegistrationContent (stored: unknown): boolean {
  if (typeof stored !== 'string' || stored.length === 0) return false
  return envelopeRecipientUserIds(stored) !== null
}

/**
 * `RegistrantPrivate`'s envelope binding: `{ requestId: registrantId, digest: Digest(bindingLabel,
 * registrantId) }`, computed in the DB (never JS-side) so it uses the same crypto-plugin digest
 * domain every other binding in this codebase uses. Deliberately NOT datetime-bound — a read-back
 * `Expiration` is Temporal-coerced on the way out and would not reproduce the exact string that was
 * sealed in.
 */
export async function registrantPrivateBinding (db: Database, registrantId: string): Promise<EnvelopeBinding> {
  const row = await db
    .prepare('select Digest(:bindingLabel, :registrantId) as d')
    .get({ bindingLabel: REGISTRANT_PRIVATE_BINDING_LABEL, registrantId })
  if (!row || row.d == null) {
    throw new Error('registrantPrivateBinding: Digest() returned null — crypto plugin not registered?')
  }
  return { requestId: registrantId, digest: row.d as string }
}

/**
 * Seals the exact plaintext `RegisterInit` JSON whose Digest is `payloadCid`, binding
 * `{ requestId, digest: payloadCid }`, to the current officers of `authorityId` (62-14
 * `createIntakeSealer` over `intakeQueryPortFromDb(db)`, resolved fresh on every call). Throws
 * `IntakeError` unchanged — `'no-recipients'` on zero recipients, with no plaintext fallback.
 */
export async function sealRegistrationPayload (db: Database, args: {
  authorityId: string
  requestId: string
  payloadCid: string
  plaintext: string
}): Promise<string> {
  const sealer = createIntakeSealer({ port: intakeQueryPortFromDb(db), authorityId: args.authorityId })
  return sealer.seal(args.plaintext, { requestId: args.requestId, digest: args.payloadCid })
}

/**
 * `details.length === 0` -> `REGISTRANT_PRIVATE_EMPTY_DETAILS` (no seal, no recipient needed — an
 * empty private tier discloses only that it is empty, and field policy already makes that fact
 * public). Otherwise seals `JSON.stringify(details)` under `registrantPrivateBinding` to the current
 * officers of `authorityId`. Throws `IntakeError` unchanged.
 */
export async function sealRegistrantPrivateDetails (db: Database, args: {
  authorityId: string
  registrantId: string
  details: readonly PrivateDetail[]
}): Promise<string> {
  if (args.details.length === 0) return REGISTRANT_PRIVATE_EMPTY_DETAILS
  const binding = await registrantPrivateBinding(db, args.registrantId)
  const sealer = createIntakeSealer({ port: intakeQueryPortFromDb(db), authorityId: args.authorityId })
  return sealer.seal(JSON.stringify(args.details), binding)
}

/** Maps an `IntakeOpener.open` failure reason to the subset of `RegistrationContentAccess` an
 * unreadable sealed row can report. Any reason not explicitly listed fails closed as 'unreadable' —
 * this includes every `EnvelopeOpenFailureReason` other than `'not-a-recipient'`
 * (`'invalid-argument'`, `'malformed-envelope'`, `'unsupported-version'`, `'authentication-failed'`)
 * and `IntakeOpenFailureReason`'s own `'vault-error'`. */
function mapOpenFailure (reason: string): 'no-opener' | 'not-a-recipient' | 'unreadable' {
  if (reason === 'not-a-recipient') return 'not-a-recipient'
  if (reason === 'no-local-key') return 'no-opener'
  return 'unreadable'
}

export type RegistrationPayloadRead =
  | { readonly access: 'opened' | 'unsealed'; readonly payload: RegisterInit }
  | { readonly access: 'no-opener' | 'not-a-recipient' | 'unreadable' | 'tampered'; readonly payload: undefined }

/**
 * Never throws for content (a missing crypto plugin — `Digest()` returning null — is the one
 * programmer-error exception, matching this codebase's existing discipline throughout). Order:
 *   1. `row.stored` is not a string -> `'unreadable'`
 *   2. sealed (`isSealedRegistrationContent`) and no `opener` -> `'no-opener'`
 *   3. sealed: `opener.open(stored, { requestId, digest: payloadCid })` — a failure maps through
 *      `mapOpenFailure`
 *   4. unsealed: `plaintext = stored` as-is (a pre-D-49 legacy row, D-07 — never migrated)
 *   5. TIER-2 RECHECK (replaces the CHECK 62-03 dropped): `select Digest(:plaintextPayload) as d`;
 *      `d !== payloadCid` -> `'tampered'` — for BOTH sealed-and-opened and unsealed rows
 *   6. `JSON.parse` to a non-null, non-array object, else `'unreadable'`
 */
export async function openRegistrationPayload (db: Database, opener: IntakeOpener | undefined, row: {
  requestId: string
  payloadCid: string
  stored: unknown
}): Promise<RegistrationPayloadRead> {
  if (typeof row.stored !== 'string') return { access: 'unreadable', payload: undefined }

  const sealed = isSealedRegistrationContent(row.stored)
  let plaintext: string
  if (sealed) {
    if (opener === undefined) return { access: 'no-opener', payload: undefined }
    const result = await opener.open(row.stored, { requestId: row.requestId, digest: row.payloadCid })
    if (!result.ok) return { access: mapOpenFailure(result.reason), payload: undefined }
    plaintext = result.plaintext
  } else {
    plaintext = row.stored
  }

  // TIER-2 RECHECK — the exact binding `PayloadCidValid` used to enforce at the schema layer,
  // re-derived here because that CHECK is gone (62-03, D-49). `:plaintextPayload` is not a reserved
  // bind name (unlike `:limit`/`:desc`/`:group`/`:order`/`:type`).
  const recheckRow = await db.prepare('select Digest(:plaintextPayload) as d').get({ plaintextPayload: plaintext })
  if (!recheckRow || recheckRow.d == null) {
    throw new Error('openRegistrationPayload: Digest() returned null — crypto plugin not registered?')
  }
  if ((recheckRow.d as string) !== row.payloadCid) return { access: 'tampered', payload: undefined }

  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    return { access: 'unreadable', payload: undefined }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { access: 'unreadable', payload: undefined }
  }
  return { access: sealed ? 'opened' : 'unsealed', payload: parsed as RegisterInit }
}

export type RegistrantPrivateRead =
  | { readonly access: 'opened' | 'unsealed'; readonly details: PrivateDetail[] }
  | { readonly access: 'no-opener' | 'not-a-recipient' | 'unreadable'; readonly details: undefined }

/**
 * `null` stored -> `{ 'unsealed', [] }` (no `RegistrantPrivate` row read, or a legacy row whose
 * `PrivateDetails` column is genuinely null). Sealed -> open under `registrantPrivateBinding` (same
 * failure mapping as `openRegistrationPayload`). Unsealed or opened text must parse to an array,
 * else `'unreadable'`. Never throws for content.
 */
export async function openRegistrantPrivateDetails (db: Database, opener: IntakeOpener | undefined, row: {
  registrantId: string
  stored: unknown
}): Promise<RegistrantPrivateRead> {
  if (row.stored === null) return { access: 'unsealed', details: [] }
  if (typeof row.stored !== 'string') return { access: 'unreadable', details: undefined }

  const sealed = isSealedRegistrationContent(row.stored)
  let plaintext: string
  if (sealed) {
    if (opener === undefined) return { access: 'no-opener', details: undefined }
    const binding = await registrantPrivateBinding(db, row.registrantId)
    const result = await opener.open(row.stored, binding)
    if (!result.ok) return { access: mapOpenFailure(result.reason), details: undefined }
    plaintext = result.plaintext
  } else {
    plaintext = row.stored
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    return { access: 'unreadable', details: undefined }
  }
  if (!Array.isArray(parsed)) return { access: 'unreadable', details: undefined }
  return { access: sealed ? 'opened' : 'unsealed', details: parsed as PrivateDetail[] }
}

export const REGISTRANT_SELECTIVE_BINDING_LABEL = 'vt-registrant-selective-1'

/** `RegistrantSelective`'s envelope binding: `{ requestId: registrantId, digest: Digest(label,
 * registrantId, cid) }`, computed in the DB. Including the Cid means an envelope moved to another
 * registrant or row fails authentication. */
export async function registrantSelectiveBinding (db: Database, registrantId: string, cid: string): Promise<EnvelopeBinding> {
  const row = await db
    .prepare('select Digest(:bindingLabel, :registrantId, :cid) as d')
    .get({ bindingLabel: REGISTRANT_SELECTIVE_BINDING_LABEL, registrantId, cid })
  if (!row || row.d == null) {
    throw new Error('registrantSelectiveBinding: Digest() returned null — crypto plugin not registered?')
  }
  return { requestId: registrantId, digest: row.d as string }
}

/**
 * Seals `JSON.stringify(leaves)` under `registrantSelectiveBinding` to the current officers of
 * `authorityId`. The caller guarantees `leaves` is non-empty and that `cid` is
 * cid(set_commit(leaves)) computed BEFORE sealing. Throws `IntakeError` unchanged ('no-recipients').
 */
export async function sealRegistrantSelectiveDetails (db: Database, args: {
  authorityId: string
  registrantId: string
  cid: string
  leaves: readonly SelectiveLeaf[]
}): Promise<string> {
  const binding = await registrantSelectiveBinding(db, args.registrantId, args.cid)
  const sealer = createIntakeSealer({ port: intakeQueryPortFromDb(db), authorityId: args.authorityId })
  return sealer.seal(JSON.stringify(args.leaves), binding)
}

export type RegistrantSelectiveRead =
  | { readonly access: 'opened' | 'unsealed'; readonly leaves: SelectiveLeaf[] }
  | { readonly access: 'no-opener' | 'not-a-recipient' | 'unreadable' | 'tampered'; readonly leaves: undefined }

/**
 * Never throws for content. Order: (1) non-string -> 'unreadable'; (2) sealed: no opener ->
 * 'no-opener', else open under the binding (failures via `mapOpenFailure`); (3) unsealed: plaintext
 * = stored; (4) parse to an array of objects with string `name` and `salt`, else
 * 'unreadable' (WR-02: an unsealed empty set is the pre-D-52 "no selective fields" constant and
 * passes the same Cid recheck; a sealed empty set is never written by the engine and stays unreadable); (5) TIER-2 RECHECK: `cid(set_commit(plaintext)) !== cid` -> 'tampered', for sealed
 * and unsealed rows alike.
 */
export async function openRegistrantSelectiveDetails (db: Database, opener: IntakeOpener | undefined, row: {
  registrantId: string
  cid: string
  stored: unknown
}): Promise<RegistrantSelectiveRead> {
  if (typeof row.stored !== 'string') return { access: 'unreadable', leaves: undefined }

  const sealed = isSealedRegistrationContent(row.stored)
  let plaintext: string
  if (sealed) {
    if (opener === undefined) return { access: 'no-opener', leaves: undefined }
    const binding = await registrantSelectiveBinding(db, row.registrantId, row.cid)
    const result = await opener.open(row.stored, binding)
    if (!result.ok) return { access: mapOpenFailure(result.reason), leaves: undefined }
    plaintext = result.plaintext
  } else {
    plaintext = row.stored
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    return { access: 'unreadable', leaves: undefined }
  }
  if (!Array.isArray(parsed)) return { access: 'unreadable', leaves: undefined }
  // WR-02: an unsealed '[]' is the pre-D-52 "no selective fields" constant and falls through to the Cid recheck.
  if (parsed.length === 0 && sealed) return { access: 'unreadable', leaves: undefined }
  for (const leaf of parsed) {
    if (leaf === null || typeof leaf !== 'object' || typeof (leaf as { name?: unknown }).name !== 'string' || typeof (leaf as { salt?: unknown }).salt !== 'string') {
      return { access: 'unreadable', leaves: undefined }
    }
  }

  // TIER-2 RECHECK — replaces the RegistrantSelective.CidValid CHECK 62-33 dropped.
  const recheck = await db.prepare('select cid(set_commit(:plaintextLeaves)) as c').get({ plaintextLeaves: plaintext })
  if (!recheck || recheck.c == null) {
    throw new Error('openRegistrantSelectiveDetails: cid(set_commit(...)) returned null — crypto plugin not registered?')
  }
  if ((recheck.c as string) !== row.cid) return { access: 'tampered', leaves: undefined }

  return { access: sealed ? 'opened' : 'unsealed', leaves: parsed as SelectiveLeaf[] }
}

// Re-exported type-only so a caller can annotate a destructured `access` field without a second
// import from vote-core — the module's own public surface already names it throughout.
export type { RegistrationContentAccess }
