import type { Database } from '@quereus/quereus'

/**
 * 62-03 (D-33/D-34): the single source of the 'rad' roster JSON SQL expression, the
 * proposal digest, the promotion digest and the Trigger B co-signer extension inserter.
 *
 * Every one of these mirrors `AuthorityEngine.sortRosterEntries`'s `{proposedName, userId,
 * title, scopes}` key order and `ProposedName asc, UserId asc` sort — verified empirically
 * (62-RESEARCH-SCHEMA.md D-33a/D-33b, probe B0) to be byte-identical to
 * `JSON.stringify(sortRosterEntries(...))` for a non-empty roster. The qsql CHECKs
 * (`AdminSignatureTaskExtension.MutationValid`, `Admin.MutationValid` branch 3,
 * `Officer.InsertValid` branch 3) repeat this SAME expression verbatim, with the bind
 * names replaced by the row's own correlated columns — this module and the schema must
 * never drift apart.
 *
 * D-34: every function here throws a plain, named `Error` when `Digest()` returns null
 * (crypto plugin not registered) — the same discipline `AuthorityEngine.proposeAdmin`
 * already follows for its own inline digest computation.
 *
 * Deliberately NOT added to any barrel (vote-engine's `src/index.ts`, `rn-entry.ts`,
 * `browser-entry.ts`) — internal to vote-engine, consumed directly by
 * `authority-engine.ts` and `elections-engine.ts`.
 */

/**
 * Scalar SQL expression (no leading `select`) yielding the roster JSON text for one
 * proposal. Binds `:authorityId` and `:effectiveAt`.
 *
 * `cast(... as text)` is a CRYPTOGRAPHIC requirement, not a comparison nicety: the
 * `Digest()` UDF tags TEXT and JSON arguments with different hash-domain bytes
 * (62-RESEARCH-SCHEMA.md Security Domain, V6) — an uncast `json_group_array(...)` result
 * passed into `Digest()` would hash under a different tag than the TS side's
 * string-typed bound parameter, producing a digest that can never match, even for
 * byte-identical content.
 */
export const RAD_ROSTER_JSON_SQL = `cast((
	select json_group_array(json_object(
		'proposedName', ProposedName, 'userId', UserId, 'title', Title, 'scopes', Scopes
	))
	from (
		select * from ProposedOfficer
		where AuthorityId = :authorityId and AdminEffectiveAt = :effectiveAt
		order by ProposedName asc, UserId asc
	)
) as text)`

/**
 * `select <RAD_ROSTER_JSON_SQL> as r` — byte-identical to
 * `JSON.stringify(sortRosterEntries(rows))` for a non-empty roster (probe P1). For zero
 * rows, returns whatever probe P2 recorded (passed through unchanged — never coerced).
 */
export async function readProposedRosterJson (
  db: Database,
  authorityId: string,
  effectiveAt: string
): Promise<string | null> {
  const row = await db
    .prepare(`select ${RAD_ROSTER_JSON_SQL} as r`)
    .get({ authorityId, effectiveAt })
  const r = row?.r
  if (r == null) return null
  if (typeof r !== 'string') {
    throw new Error(
      `readProposedRosterJson: expected a string or null roster, got ${typeof r} — the cast(...as text) may be missing`
    )
  }
  return r
}

export interface RadProposalDigestArgs {
  authorityId: string
  effectiveAt: string
  officers: string | null
  thresholdPolicies: string
}

/**
 * 'rad' PROPOSAL digest = `Digest(:authorityId, :effectiveAt, :officers, :thresholdPolicies)`.
 * No `Tid`. This is exactly what `AuthorityEngine.proposeAdmin` signs via
 * `SigningEngine.startSigningSession`, what `applyAdminProposal` Step 3 re-derives to
 * identify a proposal, and what `AdminSignatureTaskExtension.MutationValid` (Trigger B)
 * recomputes to admit a co-signer Task.
 */
export async function computeRadProposalDigest (
  db: Database,
  args: RadProposalDigestArgs
): Promise<string> {
  const row = await db
    .prepare('select Digest(:authorityId, :effectiveAt, :officers, :thresholdPolicies) as d')
    .get({
      authorityId: args.authorityId,
      effectiveAt: args.effectiveAt,
      officers: args.officers,
      thresholdPolicies: args.thresholdPolicies
    })
  if (!row || row.d == null) {
    throw new Error('computeRadProposalDigest: Digest() returned null — crypto plugin not registered?')
  }
  return row.d as string
}

export interface AdminPromotionDigestArgs extends RadProposalDigestArgs {
  tid: number
}

/**
 * 'rad' PROMOTION digest = `Digest(:tid, :authorityId, Digest(:effectiveAt,
 * :thresholdPolicies), :officers)`. Verified by BOTH `Admin.MutationValid` branch 3 and
 * `Officer.InsertValid` branch 3 — a single shared session now covers both inserts
 * (D-33b: the former admin-side/officer-side two-session split collapses into one).
 */
export async function computeAdminPromotionDigest (
  db: Database,
  args: AdminPromotionDigestArgs
): Promise<string> {
  const row = await db
    .prepare(
      'select Digest(:tid, :authorityId, Digest(:effectiveAt, :thresholdPolicies), :officers) as d'
    )
    .get({
      tid: args.tid,
      authorityId: args.authorityId,
      effectiveAt: args.effectiveAt,
      thresholdPolicies: args.thresholdPolicies,
      officers: args.officers
    })
  if (!row || row.d == null) {
    throw new Error('computeAdminPromotionDigest: Digest() returned null — crypto plugin not registered?')
  }
  return row.d as string
}

/**
 * `FanOutSpec.insertExtension`-shaped inserter for Trigger B co-signer tasks. Inserts
 * `AdminSignatureTaskExtension (TaskId, AuthorityId, AdminEffectiveAt = proposedEffectiveAt)`
 * with context `Tid = tid`. Must run inside the caller's OWN open transaction (fan-out
 * opens one) — never opens its own BEGIN/COMMIT. `recipientUserId` is ignored — the
 * `Task` row itself already carries the recipient.
 */
export function adminSignatureTaskExtensionInserter (
  db: Database,
  authorityId: string,
  proposedEffectiveAt: string,
  tid: number
): (taskId: string, recipientUserId: string) => Promise<void> {
  return async (taskId: string): Promise<void> => {
    await db.exec(
      `insert into AdminSignatureTaskExtension (TaskId, AuthorityId, AdminEffectiveAt)
       with context Tid = :tid
       values (:taskId, :authorityId, :adminEffectiveAt)`,
      { taskId, authorityId, adminEffectiveAt: proposedEffectiveAt, tid }
    )
  }
}
