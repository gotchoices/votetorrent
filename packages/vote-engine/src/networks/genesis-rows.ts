// src/networks/genesis-rows.ts — the six founding rows, read and replayed
// verbatim (D-35, D-38, D-39; 62-16).
//
// WHY GENESIS-ONLY: no data row in this schema persists its own Tid (a Tid
// lives only inside an `AdminSigning.Digest`), so a later SIGNED revision can
// never be replayed with its original Tid from storage — only the genesis
// generation (User, UserKey, Authority, Admin, Officer, Network) can be
// replayed at all, because its founding CHECK branches are the only ones that
// read neither `context.Tid` nor a stored signature (see
// `votetorrent.qsql` `User.InsertValid`, `UserKey.InsertValid`/
// `SignatureValid` first-key branch, `Authority.InsertValid`,
// `Admin.MutationValid` branch 1, `Officer.InsertValid` branch 1, and the
// `Network` insert CHECKs — none of them reference `context.Tid`). D-48
// (62-03) restricted the Admin/Officer founding branches to admit only the
// genuine founding row (an own-table `count(*) <= 1` correlated subquery),
// so this replay commits under that same restricted branch, not a widened
// one.
//
// SINGLE-PRODUCER RULE (D-38): only `NetworksEngine.importFoundingBundle`
// (networks-engine.ts) may call `replayGenesisRows` on a target database,
// and only AFTER `verifyFoundingBundle` has passed and a scratch dry run has
// proven the replay passes every tier-1 CHECK. `replayGenesisRows` binds the
// D-38 import flag (the 62-02 `UserKey.ExpirationFuture` replay-mode hook)
// on the UserKey insert ONLY, as the integer `1` — the one sanctioned
// producer line in the repository. Refer to the flag only in this prose
// form; its literal schema token must not appear in any other `src` file,
// not even in a comment (see `founding-bundle-guards.spec.ts` G-1) — this
// file's own code line below is the repo's single producer and the ONLY
// place outside the schema where the literal token may appear.
//
// NO TID ALLOCATION: this module MUST NOT import or name the shared Tid
// allocator or its persistence table, not even in a comment. The six
// founding CHECK branches never read `context.Tid` (proven by 62-03's
// `admin-founding-branch.spec.ts` G6 and this plan's own R-2), so a replay
// binds a constant placeholder value instead of allocating a fresh one.
//
// TID RULE (D-38 "never allocate a fresh Tid"): every founding table's
// `with context (...)` clause declares `Tid int` WITHOUT a `null` marker
// (votetorrent.qsql: User, Authority, Admin, Officer, Network, and UserKey's
// own `Tid int`), so omitting the `Tid = ...` clause entirely is a hard
// bind-time error (62-02-SUMMARY Probe 2, confirmed again here against the
// same installed Quereus version) — NOT a silent legal omission. The shipped
// rule therefore binds the exported constant `GENESIS_REPLAY_TID` (0) on
// every one of the six replay statements. The founding branches never read
// it (none of them references `context.Tid`), and it is never written to
// the Tid high-water table — this module performs no allocator call at all.
// 62-03's own `admin-founding-branch.spec.ts` G6 case replays the same six
// rows with an explicit constant Tid (0) for exactly this reason.

import type { Database } from '@quereus/quereus'
import type { FoundingBundleRow, FoundingBundleRows, FoundingBundleTable } from '@votetorrent/vote-core'
import { nowCanonicalDatetime } from '../utils.js'

/**
 * The genesis-row replay never allocates a Tid — see the header comment.
 * Bound verbatim (as the SQL literal, not a parameter — matching 62-03's
 * G6 shape) on all six replay statements.
 */
export const GENESIS_REPLAY_TID = 0

/** The six founding tables' columns, in `NetworksEngine.create()`'s own insert order. */
export const GENESIS_COLUMNS: Readonly<Record<FoundingBundleTable, readonly string[]>> = Object.freeze({
  User: ['Id', 'Name', 'ImageRef'],
  UserKey: ['UserId', 'Type', 'PubKey', 'Expiration'],
  Authority: ['Id', 'Name', 'DomainName', 'ImageRef'],
  Admin: ['AuthorityId', 'EffectiveAt', 'ThresholdPolicies'],
  Officer: ['AuthorityId', 'AdminEffectiveAt', 'UserId', 'Title', 'Scopes'],
  Network: [
    'Id',
    'Hash',
    'PrimaryAuthorityId',
    'Name',
    'ImageRef',
    'Relays',
    'TimestampAuthorities',
    'NumberRequiredTSAs',
    'ElectionType'
  ]
})

export const FOUNDING_BUNDLE_TABLE_ORDER: readonly FoundingBundleTable[] = Object.freeze([
  'User',
  'UserKey',
  'Authority',
  'Admin',
  'Officer',
  'Network'
])

/**
 * Normalize a raw Quereus column value into the frozen
 * `FoundingBundleValue` union (string | number | null). A `bigint` is
 * converted to a `number` only when it is a JS-safe integer (Number
 * .isSafeInteger) — anything else (object, boolean, Uint8Array, an unsafe
 * bigint) throws an Error naming the COLUMN only, never the value (the
 * same detail-string discipline `founding-bundle.ts` uses).
 */
export function normalizeGenesisValue (value: unknown, columnName: string): string | number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number') return value
  if (typeof value === 'bigint') {
    if (value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER) return Number(value)
    throw new Error(`normalizeGenesisValue: unsafe bigint in column ${columnName}`)
  }
  throw new Error(`normalizeGenesisValue: unsupported value type in column ${columnName}`)
}

export interface GenesisRowKeys {
  readonly userId: string
  readonly signerKey: string
  readonly authorityId: string
  readonly adminEffectiveAt: string
}

/**
 * PK point lookups only — never a full scan (the LevelDB/strand vtab aborts
 * scans under concurrent mutation; see tid-allocator.ts's header). Returns
 * zero or one normalized row per table, selecting exactly `GENESIS_COLUMNS`
 * in order.
 */
export async function readGenesisRows (db: Database, keys: GenesisRowKeys): Promise<FoundingBundleRows> {
  const normalizeRow = (table: FoundingBundleTable, row: Record<string, unknown> | undefined): FoundingBundleRow[] => {
    if (!row) return []
    const columns = GENESIS_COLUMNS[table]
    const out: Record<string, string | number | null> = {}
    for (const col of columns) out[col] = normalizeGenesisValue(row[col], `${table}.${col}`)
    return [out]
  }

  const userCols = GENESIS_COLUMNS.User.join(', ')
  const userRow = await db.prepare(`select ${userCols} from User where Id = :userId`).get({ userId: keys.userId })

  const userKeyCols = GENESIS_COLUMNS.UserKey.join(', ')
  const userKeyRow = await db
    .prepare(`select ${userKeyCols} from UserKey where UserId = :userId and PubKey = :signerKey`)
    .get({ userId: keys.userId, signerKey: keys.signerKey })

  const authorityCols = GENESIS_COLUMNS.Authority.join(', ')
  const authorityRow = await db
    .prepare(`select ${authorityCols} from Authority where Id = :authorityId`)
    .get({ authorityId: keys.authorityId })

  const adminCols = GENESIS_COLUMNS.Admin.join(', ')
  const adminRow = await db
    .prepare(`select ${adminCols} from Admin where AuthorityId = :authorityId and EffectiveAt = :adminEffectiveAt`)
    .get({ authorityId: keys.authorityId, adminEffectiveAt: keys.adminEffectiveAt })

  const officerCols = GENESIS_COLUMNS.Officer.join(', ')
  const officerRow = await db
    .prepare(
      `select ${officerCols} from Officer where AuthorityId = :authorityId and AdminEffectiveAt = :adminEffectiveAt and UserId = :userId`
    )
    .get({ authorityId: keys.authorityId, adminEffectiveAt: keys.adminEffectiveAt, userId: keys.userId })

  const networkCols = GENESIS_COLUMNS.Network.join(', ')
  const networkRow = await db.prepare(`select ${networkCols} from Network`).get({})

  return {
    User: normalizeRow('User', userRow as Record<string, unknown> | undefined),
    UserKey: normalizeRow('UserKey', userKeyRow as Record<string, unknown> | undefined),
    Authority: normalizeRow('Authority', authorityRow as Record<string, unknown> | undefined),
    Admin: normalizeRow('Admin', adminRow as Record<string, unknown> | undefined),
    Officer: normalizeRow('Officer', officerRow as Record<string, unknown> | undefined),
    Network: normalizeRow('Network', networkRow as Record<string, unknown> | undefined)
  }
}

function firstRow (rows: FoundingBundleRows, table: FoundingBundleTable): FoundingBundleRow {
  const row = rows[table][0]
  if (!row) throw new Error(`replayGenesisRows: missing ${table} row`)
  return row
}

/**
 * Replay the six founding rows into `db`, using `NetworksEngine.create()`'s
 * EXACT statement text, contexts and three-exec batching (batch 1: User,
 * UserKey, Authority, Admin; batch 2: Officer; batch 3: Network — the same
 * shape 62-03's `admin-founding-branch.spec.ts` G6 case replays under D-48's
 * restricted founding branch). Binds every column from the row values
 * verbatim, `now` to the caller-supplied `now` (the caller's real
 * `nowCanonicalDatetime()` — never a fabricated clock, per D-38), and
 * `Tid` to the constant `GENESIS_REPLAY_TID` on all six statements (see the
 * header comment's Tid rule).
 *
 * The D-38 import flag is bound (as the integer `1`) on the UserKey insert
 * ONLY — the single sanctioned producer line in the repository, in the
 * statement body below.
 */
export async function replayGenesisRows (
  db: Database,
  rows: FoundingBundleRows,
  now: string = nowCanonicalDatetime()
): Promise<void> {
  const user = firstRow(rows, 'User')
  const userKey = firstRow(rows, 'UserKey')
  const authority = firstRow(rows, 'Authority')
  const admin = firstRow(rows, 'Admin')
  const officer = firstRow(rows, 'Officer')
  const network = firstRow(rows, 'Network')

  const tid = GENESIS_REPLAY_TID

  // noUncheckedIndexedAccess widens every `row[col]` / `row.Col` read to
  // `FoundingBundleValue | undefined` — `col()` narrows back to the frozen
  // `FoundingBundleValue` union (string | number | null) a bind parameter
  // accepts, never silently passing `undefined` to `db.exec`.
  const col = (row: FoundingBundleRow, name: string): string | number | null => (row[name] ?? null) as string | number | null

  const params = {
    userId: col(user, 'Id'),
    userName: col(user, 'Name'),
    userImageRef: col(user, 'ImageRef'),
    keyType: col(userKey, 'Type'),
    pubKey: col(userKey, 'PubKey'),
    expiration: col(userKey, 'Expiration'),
    now,
    authorityId: col(authority, 'Id'),
    authorityName: col(authority, 'Name'),
    authorityDomain: col(authority, 'DomainName'),
    authorityImageRef: col(authority, 'ImageRef'),
    adminEffectiveAt: col(admin, 'EffectiveAt'),
    thresholdPolicies: col(admin, 'ThresholdPolicies'),
    title: col(officer, 'Title'),
    scopes: col(officer, 'Scopes'),
    networkId: col(network, 'Id'),
    networkHash: col(network, 'Hash'),
    primaryAuthorityId: col(network, 'PrimaryAuthorityId'),
    networkName: col(network, 'Name'),
    networkImageRef: col(network, 'ImageRef'),
    relays: col(network, 'Relays'),
    timestampAuthorities: col(network, 'TimestampAuthorities'),
    numberRequiredTSAs: col(network, 'NumberRequiredTSAs'),
    electionType: col(network, 'ElectionType')
  }

  // Batch 1: User + UserKey + Authority + Admin (no cross-table forward deps).
  await db.exec(
    `
    insert into User (
      Id,
      Name,
      ImageRef
    )
    with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${tid}
    values (:userId, :userName, :userImageRef);

    insert into UserKey (
      UserId,
      Type,
      PubKey,
      Expiration
    )
    with context UserKey = null, Signature = null, Tid = ${tid}, now = :now, IsSignatureValid = true, IsImportReplay = 1
    values (:userId, :keyType, :pubKey, :expiration);

    insert into Authority (
      Id,
      Name,
      DomainName,
      ImageRef
    )
    with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${tid}
    values (:authorityId, :authorityName, :authorityDomain, :authorityImageRef);

    insert into Admin (
      AuthorityId,
      EffectiveAt,
      ThresholdPolicies
    )
    with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${tid}
    values (:authorityId, :adminEffectiveAt, :thresholdPolicies);
    `,
    params
  )

  // Batch 2: Officer (depends on Admin existing — committed in batch 1).
  await db.exec(
    `
    insert into Officer (
      AuthorityId,
      AdminEffectiveAt,
      UserId,
      Title,
      Scopes
    )
    with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${tid}
    values (:authorityId, :adminEffectiveAt, :userId, :title, :scopes);
    `,
    params
  )

  // Batch 3: Network (depends on Authority existing — committed in batch 1).
  await db.exec(
    `
    insert into Network (
      Id,
      Hash,
      PrimaryAuthorityId,
      Name,
      ImageRef,
      Relays,
      TimestampAuthorities,
      NumberRequiredTSAs,
      ElectionType
    )
    with context SigningNonce = null, Tid = ${tid}
    values (
      :networkId,
      :networkHash,
      :primaryAuthorityId,
      :networkName,
      :networkImageRef,
      :relays,
      :timestampAuthorities,
      :numberRequiredTSAs,
      :electionType
    );
    `,
    params
  )
}
