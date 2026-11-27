/**
 * evidence.ts — 62-18 Task 3 (D-45), migrated onto D-49 sealing by 62-31.
 *
 * Pure reads plus opener calls — no writes, no logging. A re-association's registration code or
 * identity fields are matched OFFICER-SIDE, after decrypt, never by a SQL query over ciphertext
 * (research's own "don't hand-roll a SQL-visible match" ruling). Performance is one envelope open
 * per approved registration per call — a documented residual, not a cache across calls: `cache`
 * is created fresh by every PUBLIC entry point in `driver.ts` and dropped at the end of that call,
 * so an opened plaintext never outlives the request that needed it.
 *
 * V-3 (62-35): a registration code is read only through `openRegistrationCode`, which accepts a code
 * solely when the requester's binding signature over (RequestId, code) verifies against the
 * approved request's own `RequesterKey`; legacy binding-less codes read `unverifiable` (D-54).
 *
 * D-49 (62-31): `RegistrationRequest.Payload` may now hold a sealed D-49 envelope. `opener` here is
 * a `ReassociationOpener` (structurally identical to 62-14's `IntakeOpener` — `.open(sealed,
 * binding)`, same result shape — but declared without `IntakeOpener`'s `userId` field, since
 * `IReassociationEngine`'s own vote-core contract never needed it). The cast below is the same
 * structural-fit gap `engine-factory.ts`'s own `ctx.db as unknown as StrandSqlDatabase` documents —
 * `openRegistrationPayload`/`openRegistrantPrivateDetails` only ever call `opener.open(...)`.
 */

import type { Database } from '@quereus/quereus'
import { REASSOCIATION_MAX_CANDIDATES, registrationCodesEqual } from '@votetorrent/vote-core'
import type { AssociationIdentityField, PrivateDetail, ReassociationCandidate, ReassociationOpener, RegisterInit } from '@votetorrent/vote-core'
import { decodeStagingPlaintext } from '../../registration/transport/p2p-staging-seam.js'
import { openRegistrationPayload } from '../../registration/sealed-registration-content.js'
import type { IntakeOpener } from '../../intake/types.js'
import { asText } from '../../utils.js'
import { verifyRegistrationCodeBinding } from './registration-code.js'

/** One approved registration, resolved to its ALREADY-active registrant. */
export interface ApprovedRegistration {
  readonly requestId: string
  readonly registrantId: string
  readonly payload: RegisterInit
}

/**
 * D-49: the result of scanning every approved registration of one authority. `unreadCount` is the
 * number of approved rows whose Payload could not be opened AT ALL (so no registrantId could even
 * be resolved from it) — distinct from a row that opened fine but failed the OLD malformed-payload
 * skip (still silently excluded, as before this plan). Callers combine `unreadCount > 0` with a
 * zero-match search result to report 'unverifiable' rather than a false 'unmatched' (P13).
 */
export interface ApprovedRegistrationsRead {
  readonly registrations: readonly ApprovedRegistration[]
  readonly unreadCount: number
}

/** `openRegistrationCode`'s own tiny result union — never re-exports the code itself beyond this
 * module's own return value; callers compare via `registrationCodesEqual`, never read it raw. */
export type OpenedCode =
  | { readonly status: 'code'; readonly code: string }
  | { readonly status: 'unverifiable' }
  /** The registration provably holds NO code: no staging row at all (bridge/import), or every staging
   * row opened and decoded and none carried a code. It can never be the registration a code belongs to. */
  | { readonly status: 'no-evidence' }
  /** Code(s) are present but none has a verified requester binding (legacy, pre-binding, or forged
   * rows). `codes` lets a caller tell "could be this one's" from "cannot be this one's". Never a match. */
  | { readonly status: 'unbound'; readonly codes: readonly string[] }

/**
 * Every `RegistrationRequest` of `authorityId` that is approved (`Status = 'a'`) AND whose
 * (opened) `Payload.registrant.id` still names a currently-active `Registrant` row. `opener` is
 * REQUIRED to resolve a registrantId from a sealed row at all — when omitted (e.g.
 * `getRegistrationCodeHolderKey`, which `IReassociationEngine` declares with no opener parameter),
 * every sealed row counts toward `unreadCount` and contributes no registration. Three passes: the
 * first collects raw (requestId, payloadCid, stored) rows from one `db.eval` cursor; the second
 * opens each — never nested inside the still-open eval cursor (this codebase's own established
 * discipline); the third probes each resolved registrant's current status via its own
 * `db.prepare(...).get(...)` call.
 */
export async function listApprovedRegistrations (db: Database, authorityId: string, opener?: ReassociationOpener): Promise<ApprovedRegistrationsRead> {
  const rawRows: Array<{ requestId: string; payloadCid: string; stored: unknown }> = []
  for await (const row of db.eval(
    "select Id, Payload, PayloadCid from RegistrationRequest where AuthorityId = :rowAuthorityId and Status = 'a'",
    { rowAuthorityId: authorityId }
  )) {
    rawRows.push({
      requestId: asText(row.Id, 'RegistrationRequest.Id'),
      payloadCid: asText(row.PayloadCid, 'RegistrationRequest.PayloadCid'),
      stored: row.Payload
    })
  }

  const candidates: Array<{ requestId: string; registrantId: string; payload: RegisterInit }> = []
  let unreadCount = 0
  for (const row of rawRows) {
    const read = await openRegistrationPayload(db, opener as unknown as IntakeOpener | undefined, {
      requestId: row.requestId,
      payloadCid: row.payloadCid,
      stored: row.stored
    })
    if (read.access !== 'opened' && read.access !== 'unsealed') {
      unreadCount++
      continue
    }
    const payload = read.payload
    const registrantId = payload.registrant?.id
    if (typeof registrantId !== 'string' || registrantId.length === 0) continue
    candidates.push({ requestId: row.requestId, registrantId, payload })
  }

  const registrations: ApprovedRegistration[] = []
  for (const candidate of candidates) {
    const activeRow = await db
      .prepare("select 1 as x from Registrant where Id = :registrantId and Status = 'a'")
      .get({ registrantId: candidate.registrantId })
    if (!activeRow) continue
    registrations.push(candidate)
  }
  return { registrations, unreadCount }
}

/**
 * Reads `requestId`'s registration code from its staging rows — and ONLY a code the requester
 * itself signed (V-3, D-41, D-45).
 *
 * Why `RequesterKey` equality is not enough: a staging row's key, Digest and signature are
 * cleartext, so any strand writer can replay a victim's and seal its own code under them. The
 * requester's signature over (RequestId, code) is therefore carried INSIDE the sealed plaintext,
 * and a candidate counts only when that binding verifies against the APPROVED
 * `RegistrationRequest.RequesterKey`. Every staging row for the RequestId (any StrandId) is
 * examined; rows that fail to open, decode or verify are ignored (a peer can always add junk rows,
 * which must not block an honest code).
 *
 * Distinct verified codes (D-55): byte-identical verified codes (a replay of the victim's own row
 * onto another strand) collapse to ONE candidate, because only the victim's key can produce a
 * verified row and a registrant has one deterministic code — counting a harmless replay as an
 * ambiguity would let any peer downgrade a victim to manual review for free. Exactly one distinct
 * code is `{ status: 'code' }`; two or more distinct is `'unverifiable'`; none is `'no-evidence'`,
 * `'unbound'` or (when a row could not be read) `'unverifiable'`, as described below.
 *
 * D-54: a code with no verifiable binding (a registration staged before the binding existed — no
 * `registrationCodeSignature` — or a forged/replayed row) is NEVER a match and never the automatic
 * route; the request falls back to identity-field matching under manual review (D-45/D-46). It reads
 * `{ status: 'unbound', codes }` so a caller can tell whether a presented code COULD be this
 * registration's (it equals one of `codes`: unverifiable) or cannot be (a miss).
 *
 * gap1/WR-03 (62-113): a registration with NO staging row at all (bridge/import) or whose staging
 * rows carry no code at all reads `{ status: 'no-evidence' }` — it can never hold any code, so it
 * cannot make a miss ambiguous and a wrong code reads 'unmatched', not 'unverifiable'. Content the
 * officer cannot read (an opener that refuses, a plaintext that fails the version/id/shape checks)
 * stays `'unverifiable'`: unknown content is conservative.
 */
export async function openRegistrationCode (db: Database, opener: ReassociationOpener, requestId: string): Promise<OpenedCode> {
  const keyRow = await db
    .prepare("select RequesterKey from RegistrationRequest where Id = :requestId and Status = 'a'")
    .get({ requestId })
  if (!keyRow) return { status: 'unverifiable' }
  const requesterKey = asText(keyRow.RequesterKey, 'RegistrationRequest.RequesterKey')

  // Collect first, open after: never nest an opener/verifier call inside a live eval cursor.
  const rows: Array<{ digest: string; initJson: string }> = []
  for await (const row of db.eval(
    'select StrandId, Digest, InitJson from RegistrationRequestStaging where RequestId = :requestId',
    { requestId }
  )) {
    rows.push({
      digest: asText(row.Digest, 'RegistrationRequestStaging.Digest'),
      initJson: asText(row.InitJson, 'RegistrationRequestStaging.InitJson')
    })
  }

  if (rows.length === 0) return { status: 'no-evidence' }

  const verifiedCodes: string[] = []
  const unboundCodes: string[] = []
  let sawUnreadable = false
  for (const row of rows) {
    const opened = await opener.open(row.initJson, { requestId, digest: row.digest })
    if (!opened.ok) { sawUnreadable = true; continue }

    const decoded = decodeStagingPlaintext(opened.plaintext) as
      {
        readonly version?: unknown
        readonly init?: { readonly id?: unknown }
        readonly registrationCode?: unknown
        readonly registrationCodeSignature?: { readonly signature?: unknown }
      } | undefined
    if (
      decoded === undefined || decoded === null || typeof decoded !== 'object' ||
      decoded.version !== 1 ||
      decoded.init === null || typeof decoded.init !== 'object' ||
      (decoded.init as { id?: unknown }).id !== requestId
    ) { sawUnreadable = true; continue }
    if (typeof decoded.registrationCode !== 'string') continue // a well-formed row with no code

    const binding = decoded.registrationCodeSignature
    if (binding === null || typeof binding !== 'object' || typeof binding.signature !== 'string') {
      unboundCodes.push(decoded.registrationCode)
      continue
    }
    const verified = await verifyRegistrationCodeBinding(db, {
      requestId,
      code: decoded.registrationCode,
      signature: binding.signature,
      requesterKey
    })
    if (verified) verifiedCodes.push(decoded.registrationCode)
    else unboundCodes.push(decoded.registrationCode)
  }

  const distinct: string[] = []
  for (const code of verifiedCodes) {
    if (!distinct.some((seen) => registrationCodesEqual(seen, code))) distinct.push(code)
  }
  if (distinct.length > 1) return { status: 'unverifiable' }
  if (distinct.length === 1) return { status: 'code', code: distinct[0]! }
  // No verified code: unreadable rows keep it conservative; otherwise tell "has codes, none bound"
  // from "provably no code".
  if (sawUnreadable) return { status: 'unverifiable' }
  if (unboundCodes.length > 0) return { status: 'unbound', codes: unboundCodes }
  return { status: 'no-evidence' }
}

async function openCached (db: Database, opener: ReassociationOpener, requestId: string, cache: Map<string, OpenedCode>): Promise<OpenedCode> {
  const cached = cache.get(requestId)
  if (cached !== undefined) return cached
  const opened = await openRegistrationCode(db, opener, requestId)
  cache.set(requestId, opened)
  return opened
}

/** Verifies `presented` against ONE registrant's own approved-registration code — 'unverifiable'
 * when that registrant has no resolvable registration in `approved.registrations` (including when
 * its own RegistrationRequest.Payload could not be opened, D-49), or its staging row cannot be
 * opened/decoded. */
export async function verifyRegistrationCode (
  db: Database,
  opener: ReassociationOpener,
  presented: string,
  registrantId: string,
  approved: ApprovedRegistrationsRead,
  cache: Map<string, OpenedCode>
): Promise<'matched' | 'unmatched' | 'unverifiable'> {
  const reg = approved.registrations.find((a) => a.registrantId === registrantId)
  if (reg === undefined) return 'unverifiable'
  const opened = await openCached(db, opener, reg.requestId, cache)
  // Single-registrant semantics unchanged: without a verified code there is nothing to match against.
  if (opened.status !== 'code') return 'unverifiable'
  return registrationCodesEqual(presented, opened.code) ? 'matched' : 'unmatched'
}

/**
 * Scans every approved registration for one whose own code equals `presented`. Exactly one match
 * is `{outcome:'matched', registrantId}`. Zero matches while at least one row could not be
 * read (its staging envelope) or holds an UNBOUND code equal to `presented` (62-113: rows that
 * provably hold no code never count), or at least one approved row's REGISTRATION PAYLOAD itself
 * could not be opened (D-49 — `approved.unreadCount > 0`, so it was never even a candidate), or
 * MORE than one match (an officer-visible ambiguity, D-45's guessing-oracle note), is
 * `{outcome:'unverifiable'}` — never auto-approved. Otherwise `{outcome:'unmatched'}`.
 */
export async function resolveRegistrantByCode (
  db: Database,
  opener: ReassociationOpener,
  presented: string,
  approved: ApprovedRegistrationsRead,
  cache: Map<string, OpenedCode>
): Promise<{ readonly outcome: 'matched'; readonly registrantId: string } | { readonly outcome: 'unmatched' | 'unverifiable' }> {
  let matchedRegistrantId: string | undefined
  let matchCount = 0
  let sawUnverifiable = approved.unreadCount > 0

  for (const reg of approved.registrations) {
    const opened = await openCached(db, opener, reg.requestId, cache)
    if (opened.status === 'no-evidence') continue // can never hold any code (gap1/WR-03)
    if (opened.status === 'unbound') {
      // Could be THIS registration's code, just unverifiable (D-54): ambiguity only if it equals one.
      if (opened.codes.some((c) => registrationCodesEqual(presented, c))) sawUnverifiable = true
      continue
    }
    if (opened.status === 'unverifiable') {
      sawUnverifiable = true
      continue
    }
    if (registrationCodesEqual(presented, opened.code)) {
      matchedRegistrantId = reg.registrantId
      matchCount++
    }
  }

  if (matchCount === 1 && matchedRegistrantId !== undefined) return { outcome: 'matched', registrantId: matchedRegistrantId }
  if (matchCount > 1) return { outcome: 'unverifiable' }
  if (sawUnverifiable) return { outcome: 'unverifiable' }
  return { outcome: 'unmatched' }
}

function flattenPrivateDetails (details: readonly PrivateDetail[] | undefined, out: AssociationIdentityField[]): void {
  if (details === undefined) return
  for (const detail of details) {
    if (Array.isArray(detail.value)) {
      flattenPrivateDetails(detail.value, out)
    } else {
      out.push({ name: detail.name, value: String(detail.value) })
    }
  }
}

/** Flattens `public.firstName/lastName/district`, string-valued `public.extraFields`, and the
 * recursive `private.details` tree into one flat `{ name, value }[]` — an officer's side-by-side
 * comparison record, and the candidate-ranking input. Never includes a `selective`-tier value
 * (that tier commits salted leaves, not plain name/value pairs). */
export function identityRecordOf (payload: RegisterInit): AssociationIdentityField[] {
  const fields: AssociationIdentityField[] = []
  if (payload.public?.firstName !== undefined) fields.push({ name: 'firstName', value: payload.public.firstName })
  if (payload.public?.lastName !== undefined) fields.push({ name: 'lastName', value: payload.public.lastName })
  if (payload.public?.district !== undefined) fields.push({ name: 'district', value: payload.public.district })

  const extraFields = payload.public?.extraFields
  if (extraFields !== undefined && extraFields !== null && typeof extraFields === 'object') {
    for (const [name, value] of Object.entries(extraFields)) {
      if (typeof value === 'string') fields.push({ name, value })
    }
  }

  flattenPrivateDetails(payload.private?.details, fields)
  return fields
}

function normalizeFieldName (name: string): string {
  return name.trim().toLowerCase()
}

/** NFKC-normalizes, trims, collapses internal whitespace, and case-folds — so "José " and "jose"
 * (differently-composed accents, trailing space, case) compare equal. */
function normalizeFieldValue (value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Ranks every approved registrant by how many (name, value) pairs its own `identityRecordOf`
 * record shares with `fields` (the submitted identity evidence), keeps only registrants with at
 * least one match, sorts by match count descending then `registrantId` ascending (deterministic,
 * never an iteration-order artifact), and caps the result at `REASSOCIATION_MAX_CANDIDATES`.
 * Returns field NAMES only (never values) plus a best-effort `displayName` — an officer still has
 * to open `registrantRecord` (the full record) to actually compare values.
 */
export function rankIdentityCandidates (
  fields: readonly AssociationIdentityField[],
  approved: ApprovedRegistrationsRead
): ReassociationCandidate[] {
  const submitted = new Map<string, string>()
  for (const field of fields) {
    // Belt and braces: the transport and the driver sanitize first, but a field that is not a
    // well-formed string pair must never throw out of the officer's list.
    if (field === null || typeof field !== 'object' || typeof field.name !== 'string' || typeof field.value !== 'string') continue
    submitted.set(normalizeFieldName(field.name), normalizeFieldValue(field.value))
  }

  // D-49: an unread row is simply absent from `approved.registrations` — it was never a candidate
  // (it cannot be ranked; its identity is unknown). No special-casing needed here.
  const scored: Array<{ registrantId: string; count: number; matchedFieldNames: string[]; displayName?: string }> = []
  for (const reg of approved.registrations) {
    const record = identityRecordOf(reg.payload)
    const matchedFieldNames: string[] = []
    for (const field of record) {
      const submittedValue = submitted.get(normalizeFieldName(field.name))
      if (submittedValue !== undefined && submittedValue === normalizeFieldValue(field.value)) {
        matchedFieldNames.push(field.name)
      }
    }
    if (matchedFieldNames.length === 0) continue
    const nameParts = [reg.payload.public?.firstName, reg.payload.public?.lastName].filter((x): x is string => typeof x === 'string')
    scored.push({
      registrantId: reg.registrantId,
      count: matchedFieldNames.length,
      matchedFieldNames,
      displayName: nameParts.length > 0 ? nameParts.join(' ') : undefined
    })
  }

  scored.sort((a, b) => (b.count !== a.count ? b.count - a.count : (a.registrantId < b.registrantId ? -1 : a.registrantId > b.registrantId ? 1 : 0)))

  return scored.slice(0, REASSOCIATION_MAX_CANDIDATES).map((s) => ({
    registrantId: s.registrantId,
    matchedFieldNames: s.matchedFieldNames,
    displayName: s.displayName
  }))
}
