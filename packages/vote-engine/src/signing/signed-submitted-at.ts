import { RequesterSignatureUnverifiableError } from '@votetorrent/vote-core'
import type { EngineContext } from '../types.js'

/**
 * Resolves the EXACT SubmittedAt spelling a requester signed (UAT 62 gap 2).
 *
 * SubmittedAt on RegistrationRequest / AssociationRequest is SUBMITTER-supplied and signed
 * verbatim (L-3), but Quereus stores `datetime` lossily: a plain SELECT returns it Z-stripped at
 * minimal fractional precision. `restoreCanonicalDatetime` (always exactly 3 digits) is correct
 * only for engine-written values such as ReceivedAt; for SubmittedAt it rebinds a spelling the
 * requester never signed, so the unqualified SignatureValid CHECK fails on the decision UPDATE
 * after the officer's signature was spent. Here we enumerate every raw ISO-Z spelling that stores
 * to the same value and pick the one the table's own SignatureValid expression verifies.
 */

export type SignedSubmittedAtTable = 'RegistrationRequest' | 'AssociationRequest'

/** Candidate raw spellings for a stored (Z-stripped, minimal-precision) value; 3-digit form first. */
export function submittedAtCandidates (stored: string): string[] {
  const withoutZ = stored.endsWith('Z') ? stored.slice(0, -1) : stored
  const dot = withoutZ.indexOf('.')
  const base = dot < 0 ? withoutZ : withoutZ.slice(0, dot)
  const f = dot < 0 ? '' : withoutZ.slice(dot + 1)
  const out: string[] = []
  if (f.length === 0) out.push(`${base}Z`)
  for (let len = Math.max(f.length, 1); len <= 9; len++) {
    out.push(`${base}.${f.padEnd(len, '0')}Z`)
  }
  // 3-digit form first (the Voter app's common case costs one evaluation).
  const three = out.findIndex(c => /\.\d{3}Z$/.test(c))
  if (three > 0) out.unshift(...out.splice(three, 1))
  return out
}

// Fixed SQL per table: the table's own SignatureValid CHECK expression with :candidate in place
// of SubmittedAt. No identifier is ever interpolated.
const REGISTRATION_SQL =
  'select SignatureValid(Digest(Id, AuthorityId, RequesterKey, IssuerType, BridgeId, PayloadCid, :candidate), RequesterSignature, RequesterKey) as ok from RegistrationRequest where Id = :requestId'
const ASSOCIATION_SQL =
  'select (SignatureValid(Digest(Id, AuthorityId, RegistrantId, DeviceKey, ElectionId, :candidate), RequesterSignature, DeviceKey) or SignatureValidP256(Digest(Id, AuthorityId, RegistrantId, DeviceKey, ElectionId, :candidate), RequesterSignature, DeviceKey)) as ok from AssociationRequest where Id = :requestId'

export async function resolveSignedSubmittedAt (
  db: EngineContext['db'],
  table: SignedSubmittedAtTable,
  requestId: string,
  stored: string
): Promise<string> {
  const sql = table === 'RegistrationRequest' ? REGISTRATION_SQL : ASSOCIATION_SQL
  const stmt = db.prepare(sql)
  for (const candidate of submittedAtCandidates(stored)) {
    const row = await stmt.get({ candidate, requestId })
    if (!row) throw new Error(`resolveSignedSubmittedAt: ${table} ${requestId} not found`)
    const ok = row.ok
    if (ok === true || ok === 1 || ok === 1n) return candidate
  }
  throw new RequesterSignatureUnverifiableError(table, requestId)
}
