import type { Database } from '@quereus/quereus'
import type { Scope, SigningStatus } from '@votetorrent/vote-core'

/**
 * 62-07 (D-08..D-12): pure read-only threshold/holder derivation helpers shared by
 * SigningEngine and the fan-out helper (fan-out.ts). Nothing here writes to the DB.
 */

/**
 * Read the signing threshold for `nonce`'s scope from the session's CurrentAdmin row.
 * Moved verbatim out of SigningEngine.sign() (same :nonce/:scope binds, the same
 * coalesce(..., 1) default, and the same `Number(x) || 1` fallback).
 */
export async function readSessionThreshold (db: Database, nonce: string, scope: Scope): Promise<number> {
  const thresholdRes = await db
    .prepare(
      `select
				coalesce(
					cast(
						json_extract(
							-- get the first policy object whose 'policy' field matches the session scope; fallback to 1 if not found
							(
							  select value
							  from json_each(ThresholdPolicies)
							  where json_extract(value, '$.policy') = :scope
							  limit 1
							), '$.threshold'
						) as integer
					), 1
				) as threshold
		from AdminSigning ADS
		join Admin A
			on ADS.AuthorityId = A.AuthorityId
			and ADS.AdminEffectiveAt = A.EffectiveAt
		where ADS.Nonce = :nonce`
    )
    .get({ nonce, scope })

  return Number(thresholdRes?.threshold) || 1
}

/**
 * Distinct UserIds of every officer who CURRENTLY (per CurrentAdmin) holds `scope` at
 * `authorityId`, ascending by UserId.
 */
export async function listCurrentScopeHolders (db: Database, authorityId: string, scope: Scope): Promise<string[]> {
  const rows: string[] = []
  for await (const row of db.eval(
    `select distinct O.UserId
			from Officer O
			join CurrentAdmin CA on CA.AuthorityId = O.AuthorityId and CA.EffectiveAt = O.AdminEffectiveAt
			where O.AuthorityId = :authorityId
				and exists (select 1 from json_each(O.Scopes) where value = :scope)
			order by O.UserId`,
    { authorityId, scope }
  )) {
    rows.push(row.UserId as string)
  }
  return rows
}

/**
 * Count the OfficerSignature rows for `nonce` that qualify toward `threshold`.
 *
 * At threshold <= 1 this stays the LEGACY unfiltered `count(*)` — tier 2, exactly like the
 * pre-62-07 threshold boolean. This is deliberate, not an oversight: voter-run `vrg`
 * ceremonies (AssociationEngine.associate(), the voter side of register()) sign their own
 * threshold-1 'vrg' session with the VOTER's own key, who is never a current scope-holder —
 * holder-filtering a threshold-1 count would silently lock every one of those ceremonies out.
 * Placeholder derived rows (signDerived's header-inherited AdminSignature) are system-derived
 * and also carry no holder-eligible signer. Restricting the count to holders ONLY kicks in
 * once a policy genuinely asks for more than one signer (D-08/D-12, Pitfall 5).
 */
export async function countQualifyingSignatures (
  db: Database,
  nonce: string,
  authorityId: string,
  scope: Scope,
  threshold: number
): Promise<number> {
  if (threshold <= 1) {
    const legacyRes = await db
      .prepare('select count(*) as signatureCount from OfficerSignature where SigningNonce = :nonce')
      .get({ nonce })
    return Number(legacyRes?.signatureCount) || 0
  }

  const signerRows: string[] = []
  for await (const row of db.eval(
    'select UserId from OfficerSignature where SigningNonce = :nonce',
    { nonce }
  )) {
    signerRows.push(row.UserId as string)
  }
  const holders = new Set(await listCurrentScopeHolders(db, authorityId, scope))
  let count = 0
  const seen = new Set<string>()
  for (const signerId of signerRows) {
    if (seen.has(signerId)) continue
    seen.add(signerId)
    if (holders.has(signerId)) count++
  }
  return count
}

/**
 * D-11: derive a signing session's status from Task, OfficerSignature and AdminSignature rows.
 * No veto — a rejection (a completed Task with no OfficerSignature) only ever reduces the
 * remaining possible approvals; it never resolves the session to a terminal rejected state.
 * A deleted (withdrawn) Task simply stops counting as open — no terminal state is ever
 * persisted by this function.
 */
export async function computeSigningStatus (db: Database, nonce: string): Promise<SigningStatus | null> {
  const sessionRow = await db
    .prepare('select Scope, AuthorityId from AdminSigning where Nonce = :nonce')
    .get({ nonce })
  if (!sessionRow) return null

  const scope = sessionRow.Scope as Scope
  const authorityId = sessionRow.AuthorityId as string

  const threshold = await readSessionThreshold(db, nonce, scope)
  const signatures = await countQualifyingSignatures(db, nonce, authorityId, scope, threshold)

  const reachedRow = await db
    .prepare('select 1 as x from AdminSignature where SigningNonce = :nonce')
    .get({ nonce })
  const reached = !!reachedRow

  const holders = threshold > 1 ? new Set(await listCurrentScopeHolders(db, authorityId, scope)) : null

  const openRows: string[] = []
  for await (const row of db.eval(
    `select distinct T.UserId
			from Task T
			where T.SigningNonce = :nonce and T.IsCompleted = 0
				and not exists (select 1 from OfficerSignature S where S.SigningNonce = T.SigningNonce and S.UserId = T.UserId)`,
    { nonce }
  )) {
    openRows.push(row.UserId as string)
  }
  const openTasks = (holders ? openRows.filter(u => holders.has(u)) : openRows).length

  const rejectedRows: string[] = []
  for await (const row of db.eval(
    `select distinct T.UserId
			from Task T
			where T.SigningNonce = :nonce and T.IsCompleted = 1
				and not exists (select 1 from OfficerSignature S where S.SigningNonce = T.SigningNonce and S.UserId = T.UserId)`,
    { nonce }
  )) {
    rejectedRows.push(row.UserId as string)
  }
  const rejected = rejectedRows.length

  const unreachable = !reached && (signatures + openTasks) < threshold

  return { nonce, scope, threshold, signatures, openTasks, rejected, reached, unreachable }
}

/**
 * 62-11 (D-08): the PRE-SESSION form of {@link readSessionThreshold} — reads an authority's
 * threshold for `scope` directly off its CURRENT `Admin` row, for decisions that must be made
 * BEFORE any `AdminSigning` session exists (e.g. whether `submitBallotForConfirmation` must
 * collect the proposer's signature before writing anything). Same
 * `coalesce(cast(json_extract(...) as integer), 1)` formula and the same `Number(x) || 1`
 * fallback as `readSessionThreshold` — the two stay byte-identical in intent, differing only in
 * where they join from (`CurrentAdmin` directly here, vs. an existing `AdminSigning.Nonce`
 * there). Returns 1 when the authority has no `CurrentAdmin` row.
 */
export async function readAuthorityThreshold (db: Database, authorityId: string, scope: Scope): Promise<number> {
  const thresholdRes = await db
    .prepare(
      `select
				coalesce(
					cast(
						json_extract(
							(
							  select value
							  from json_each(ThresholdPolicies)
							  where json_extract(value, '$.policy') = :scope
							  limit 1
							), '$.threshold'
						) as integer
					), 1
				) as threshold
		from CurrentAdmin CA
		join Admin A
			on A.AuthorityId = CA.AuthorityId
			and A.EffectiveAt = CA.EffectiveAt
		where CA.AuthorityId = :authorityId`
    )
    .get({ authorityId, scope })

  return Number(thresholdRes?.threshold) || 1
}

export type DerivedSigningErrorReason =
  | 'session-not-found'
  | 'header-not-found'
  | 'header-not-reached'
  | 'scope-mismatch'
  | 'authority-mismatch'

/** Thrown by SigningEngine.signDerived() before any write (Finding 4.1). */
export class DerivedSigningError extends Error {
  readonly reason: DerivedSigningErrorReason

  constructor (reason: DerivedSigningErrorReason, message?: string) {
    super(message ?? `DerivedSigningError: ${reason}`)
    this.name = 'DerivedSigningError'
    this.reason = reason
  }
}
