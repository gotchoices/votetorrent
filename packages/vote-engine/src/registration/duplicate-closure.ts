import type { Database } from '@quereus/quereus'
import type { RegistrationDuplicateClosure, RegistrationDuplicateClosureState } from '@votetorrent/vote-core'
import { reZuluDatetime } from '../signing/ceremony-helpers.js'

/**
 * duplicate-closure.ts — Phase 62 Plan 19 (D-44): the ONE SQL definition of "closed or closing as
 * a duplicate", shared by `RegistrationEngine` (the reject guard, the inbox list, the
 * transparency stats), the inbox query builder (`registration-request-query.ts`), and
 * `SignatureTasksEngine` (the registrant seed pass and the approval gate). A second,
 * independently-worded copy of this predicate anywhere is exactly how one of those five
 * call sites would silently disagree with the other four about which requests are decidable.
 *
 * This module deliberately never filters on `StrandId`: the authority's own local database is one
 * strand (62-01), and the decider-to-authority binding is already enforced by
 * `RegistrationDecision.DeciderIsOfficerWithScope` at write time — adding a `StrandId` filter here
 * would just be a second, redundant place that binding could drift out of.
 */

const ALIAS_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/

/**
 * Returns a boolean SQL fragment — safe to splice into a `where` clause after `and` — that is
 * TRUE exactly when the row aliased `alias` (a `RegistrationRequest` row; must expose `.Id` and
 * `.AuthorityId`) is NEITHER closed (a `'d'` `RegistrationDecision` row names it as `RequestId`)
 * NOR closing (another decision of the same authority names it in `ClosesRequestId`, with no
 * `'d'` row for it yet). `alias` is validated against a strict identifier pattern and the
 * function throws a `TypeError` on anything else — this value is spliced into SQL text, so it is
 * a correctness boundary, not a convenience.
 */
export function registrationRequestNotClosedSql (alias: string): string {
  if (!ALIAS_PATTERN.test(alias)) {
    throw new TypeError(`registrationRequestNotClosedSql: alias must match ${ALIAS_PATTERN} — got ${JSON.stringify(alias)}`)
  }
  return (
    `not exists (select 1 from RegistrationDecision DCd where DCd.AuthorityId = ${alias}.AuthorityId and DCd.RequestId = ${alias}.Id and DCd.Status = 'd') ` +
    `and not exists (select 1 from RegistrationDecision DCn where DCn.AuthorityId = ${alias}.AuthorityId and DCn.ClosesRequestId = ${alias}.Id)`
  )
}

/**
 * Point-reads the closure state of ONE request. Two point reads, never a join: (1) does a `'d'`
 * row exist for `requestId` itself, and (2) what is the earliest decision (by `DecidedAt`, then
 * `RequestId`) of the same authority that names `requestId` in `ClosesRequestId`. A `'d'` row
 * makes the state `'closed'` (`closedByRequestId` is the naming decision's own `RequestId`, or
 * `null` in the schema's own `DuplicateCloseValid` fallback case — a `'d'` row with no naming
 * decision — see 62-01-SUMMARY.md). A naming decision with no `'d'` row yet makes the state
 * `'closing'`. Neither present resolves `undefined`.
 */
export async function readDuplicateClosure (db: Database, requestId: string, authorityId: string): Promise<RegistrationDuplicateClosure | undefined> {
  const dRow = await db
    .prepare(
      `select DecidedAt from RegistrationDecision where RequestId = :requestId and AuthorityId = :rowAuthorityId and Status = 'd'`
    )
    .get({ requestId, rowAuthorityId: authorityId })

  const namingRow = await db
    .prepare(
      `select D.RequestId as ClosedBy from RegistrationDecision D
         where D.ClosesRequestId = :requestId and D.AuthorityId = :rowAuthorityId
         order by D.DecidedAt, D.RequestId`
    )
    .get({ requestId, rowAuthorityId: authorityId })

  if (dRow) {
    return {
      requestId,
      state: 'closed',
      closedByRequestId: namingRow ? (namingRow.ClosedBy as string) : null,
      closedAt: reZuluDatetime(dRow.DecidedAt as string)
    }
  }
  if (namingRow) {
    return {
      requestId,
      state: 'closing',
      closedByRequestId: namingRow.ClosedBy as string
    }
  }
  return undefined
}

/**
 * Bulk form of `readDuplicateClosure`, over every request of an authority (or the whole local
 * database when `authorityId` is omitted) — two grouped queries, never a per-row point read.
 * `'closed'` always wins over `'closing'` for the same request id (a request cannot legitimately
 * be both, but a `'closed'` reading is the more complete one if the two ever disagree transiently
 * mid-resume).
 */
export async function readDuplicateClosureStates (db: Database, authorityId?: string): Promise<Map<string, RegistrationDuplicateClosureState>> {
  const out = new Map<string, RegistrationDuplicateClosureState>()

  const closingSql =
    `select D.ClosesRequestId as Target from RegistrationDecision D
       where D.ClosesRequestId is not null
         and not exists (
           select 1 from RegistrationDecision X
             where X.RequestId = D.ClosesRequestId and X.AuthorityId = D.AuthorityId and X.Status = 'd'
         )` + (authorityId === undefined ? '' : ' and D.AuthorityId = :rowAuthorityId')
  for await (const row of db.eval(closingSql, authorityId === undefined ? {} : { rowAuthorityId: authorityId })) {
    const target = row.Target as string
    if (!out.has(target)) out.set(target, 'closing')
  }

  const closedSql =
    `select RequestId from RegistrationDecision where Status = 'd'` +
    (authorityId === undefined ? '' : ' and AuthorityId = :rowAuthorityId')
  for await (const row of db.eval(closedSql, authorityId === undefined ? {} : { rowAuthorityId: authorityId })) {
    out.set(row.RequestId as string, 'closed')
  }

  return out
}
