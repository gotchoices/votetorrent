import type { RegistrantListFilter } from '@votetorrent/vote-core'

/**
 * D-05/D-06: the SINGLE shared predicate builder feeding BOTH
 * `buildRegistrantListPageSql` and `buildRegistrantListCountSql`. Both derive
 * their FROM and WHERE text from `buildRegistrantListFragment` and neither
 * may ever assemble either clause independently — a drifted count predicate
 * would report a total for a different filter than the page it accompanies
 * (D-05/T-47-09), and a drifted currency predicate would silently serve
 * stale registrant data (D-06/T-47-08). This module is pure, DB-free, and
 * ctx-free — a plain SQL-construction utility.
 */

/**
 * D-06 currency predicate. `RegistrantPublic` is `InsertOnly` with PK
 * `(RegistrantId, Cid)`, so a registrant accumulates one row per public-tier
 * revision and only the one whose Cid column equals the parent's PublicCid
 * column is current; the second join condition below carries that equality
 * and must never be reduced to just the RegistrantId equality alone — a join
 * missing that second condition still runs, still renders, and still passes
 * a single-row fixture while silently serving stale district/name data.
 *
 * This constant, together with the three POINT-READ constants below, is the
 * exhaustive set of places that predicate is written out in
 * `packages/vote-engine/src` (excluding the generated `schema-sql.ts`).
 *
 * It is a `left join` (not `inner`) so a registrant with no public tier —
 * `Registrant.PublicCid` is nullable — still appears in the roster with
 * `lastName`/`firstName`/`district` undefined, which 47-11 renders via its
 * truncated-`Registrant.Id` fallback.
 */
export const REGISTRANT_PUBLIC_CURRENCY_JOIN =
  'left join RegistrantPublic RP on RP.RegistrantId = R.Id and RP.Cid = R.PublicCid'

/**
 * The same D-06 currency predicate, expressed for a single-registrant POINT
 * READ rather than for the roster.
 *
 * The roster join above drives from `Registrant R` and reaches out to the
 * tier; a point read drives from the TIER table and reaches back to
 * `Registrant`, so the join text is genuinely different and cannot be shared
 * with the roster constant. All three below alias the tier table `T` and the
 * parent `Registrant R`, so a caller's `from <Tier> T` / `where T.RegistrantId
 * = :registrantId` composes directly.
 *
 * `join`, not `left join`, and that is the point: a point read that finds no
 * CURRENT tier row must return "no current tier" (undefined), never a
 * superseded revision. `RegistrantPublic`/`RegistrantPrivate`/
 * `RegistrantSelective` are all `InsertOnly` with PK `(RegistrantId, Cid)`, so
 * without these joins a `.get()` returns whichever revision the storage layer
 * happens to yield first — which on the private tier means the detail screen
 * could display a superseded SSN/DOB and `recordRegistrantAccessEvent` could
 * derive its name allowlist from a superseded revision.
 *
 * DEVICE-PROVEN 2026-08-05 (47-REVIEW WR-03 — was UNPROVEN ON DEVICE).
 * These three constants turned five hot single-registrant reads
 * (`getRegistrantPublic`, `getRegistrantPrivate`, `getRegistrantSelective`,
 * `getDisclosedSelective`, and the allowlist read inside
 * `recordRegistrantAccessEvent`, i.e. every access-trail write) from
 * PK point lookups into joins. The CORRECTNESS argument above was already
 * verified; the EXECUTION argument — whether Quereus's planner pushes
 * `T.RegistrantId = :registrantId` down into the tier PK prefix rather than
 * scanning `Registrant`, given that `tid-allocator.ts` is explicit that the
 * Optimystic/LevelDB vtab ABORTS full table scans under concurrent mutation —
 * had only ever been exercised against the Node/in-memory harness.
 *
 * It has now been exercised on device (Pixel_8 AVD, Hermes, debug build, D-15
 * walkthrough fixture, 5 seeded registrants). All five reads returned data with
 * no aborted scan and no error:
 *   - public tier rendered (lastName/firstName/district)
 *   - selective tier rendered (Party/BirthYear)
 *   - `getDisclosedSelective` rendered its per-audience "Not disclosed to this
 *     audience" annotations under the SAME-DISTRICT audience
 *   - private tier rendered masked, and a reveal produced plaintext
 *   - the reveal's access-trail row landed and read back in Access History
 *     ("SSN — Device User — 2026-08-05 11:39 UTC"), which is the allowlist read
 *     plus the sanitize-and-insert path end to end
 * The feared scan abort did not materialize on any of the five.
 *
 * SCOPE OF THE EVIDENCE: one registrant, ~5-row tables, no concurrent mutation.
 * That exercises the PLAN SHAPE — the thing genuinely in doubt — but says
 * nothing about behavior at roster scale or under the concurrent writes that
 * `tid-allocator.ts`'s abort actually keys on. Treat a scan at scale as still
 * possible.
 *
 * If a device leg ever DOES show a scan, the fallback keeps both lookups on
 * their PKs without giving up currency — read the parent's Cid first, then
 * point-read the tier by `(RegistrantId, Cid)`:
 *
 *   select PrivateCid from Registrant where Id = :registrantId
 *   select ... from RegistrantPrivate where RegistrantId = :registrantId and Cid = :cid
 */
export const REGISTRANT_PUBLIC_POINT_CURRENCY_JOIN =
  'join Registrant R on R.Id = T.RegistrantId and R.PublicCid = T.Cid'

/** Point-read D-06 currency join for `RegistrantPrivate` — see the constant above. */
export const REGISTRANT_PRIVATE_POINT_CURRENCY_JOIN =
  'join Registrant R on R.Id = T.RegistrantId and R.PrivateCid = T.Cid'

/** Point-read D-06 currency join for `RegistrantSelective` — see the constant above. */
export const REGISTRANT_SELECTIVE_POINT_CURRENCY_JOIN =
  'join Registrant R on R.Id = T.RegistrantId and R.SelectiveCid = T.Cid'

export const REGISTRANT_LIST_DEFAULT_PAGE_SIZE = 50
export const REGISTRANT_LIST_MAX_PAGE_SIZE = 200

/**
 * Clamp a caller-supplied page size to a bounded integer. Its return value is
 * interpolated directly into the `limit` clause, so this is a security
 * boundary, not a convenience: it must always yield a bounded integer.
 */
export function clampPageSize (requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return REGISTRANT_LIST_DEFAULT_PAGE_SIZE
  }
  return Math.min(REGISTRANT_LIST_MAX_PAGE_SIZE, Math.max(1, Math.trunc(requested)))
}

export interface RegistrantListSqlFragment {
  from: string
  where: string
  params: Record<string, unknown>
}

/**
 * The single shared predicate builder. Emits NO cursor predicate, NO
 * `order by`, NO `limit`, and NO select list — those are assembled by
 * `buildRegistrantListPageSql`/`buildRegistrantListCountSql` around this
 * fragment's `from`/`where` text.
 */
export function buildRegistrantListFragment (filter?: RegistrantListFilter): RegistrantListSqlFragment {
  const params: Record<string, unknown> = {}

  let from = `from Registrant R ${REGISTRANT_PUBLIC_CURRENCY_JOIN}`
  if (filter?.electionId !== undefined) {
    // Inner (not left) because the join exists solely to narrow membership (D-07).
    from += ' inner join ElectionRegistrant ER on ER.RegistrantId = R.Id and ER.ElectionId = :electionId'
    params.electionId = filter.electionId
  }

  let where = 'where 1 = 1'
  if (filter?.authorityId !== undefined) {
    where += ' and R.AuthorityId = :authorityId'
    params.authorityId = filter.authorityId
  }
  if (filter?.status !== undefined) {
    where += ' and R.Status = :status'
    params.status = filter.status
  }
  if (filter?.expiringBefore !== undefined) {
    where += ' and R.Expiration < :expiringBefore'
    params.expiringBefore = filter.expiringBefore
  }
  if (filter?.expiringAfter !== undefined) {
    where += ' and R.Expiration > :expiringAfter'
    params.expiringAfter = filter.expiringAfter
  }
  if (filter?.district !== undefined) {
    where += ' and RP.District = :district'
    params.district = filter.district
  }
  if (filter?.name !== undefined) {
    // D-04/RESEARCH-Open-Question-2: no `escape` clause — a documented omission.
    where += ' and (RP.LastName like :nameQuery or RP.FirstName like :nameQuery)'
    params.nameQuery = `%${filter.name}%`
  }

  return { from, where, params }
}

/**
 * The page query. Keyset cursor rides `Registrant.Id`, the table's PK
 * (D-05), so the scan is an ordered PK range, not a full table scan.
 */
export function buildRegistrantListPageSql (
  filter: RegistrantListFilter | undefined,
  cursor: string | undefined,
  pageSize: number
): { sql: string; params: Record<string, unknown> } {
  const fragment = buildRegistrantListFragment(filter)
  const selectList =
    'select R.Id, R.AuthorityId, R.Status, R.Expiration, R.PrivateCid, R.PublicCid, R.SelectiveCid, RP.LastName, RP.FirstName, RP.District '
  let sql = selectList + fragment.from + ' ' + fragment.where
  const params: Record<string, unknown> = { ...fragment.params }
  if (cursor !== undefined) {
    sql += ' and R.Id > :cursor'
    params.cursor = cursor
  }
  sql += ` order by R.Id asc limit ${clampPageSize(pageSize)}`
  return { sql, params }
}

/**
 * The count query. No cursor, no `order by`, no `limit`. Uses a derived-table
 * form — `from (select R.Id …) as RegistrantMatch` — which is provably
 * equivalent to a flat `select count(*) … from Registrant R …` here because
 * both joins match at most one row per registrant (`RegistrantPublic` PK
 * `(RegistrantId, Cid)` against a single `R.PublicCid` value;
 * `ElectionRegistrant` PK `(ElectionId, RegistrantId)` against a single
 * `:electionId`), so no row multiplication is possible.
 */
export function buildRegistrantListCountSql (filter?: RegistrantListFilter): { sql: string; params: Record<string, unknown> } {
  const fragment = buildRegistrantListFragment(filter)
  const sql = `select count(*) as n from (select R.Id ${fragment.from} ${fragment.where}) as RegistrantMatch`
  return { sql, params: fragment.params }
}
