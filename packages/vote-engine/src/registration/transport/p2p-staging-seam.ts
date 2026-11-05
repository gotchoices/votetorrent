import type { EnvelopeBinding } from '../../crypto/index.js'
import type { Signature } from '@votetorrent/vote-core'

/**
 * p2p-staging-seam.ts — the shared D-03/D-05/D-06 sealing, opening, decision-signing and
 * cursor-retry seam BOTH P2P transports (`p2p-registration-transport.ts`,
 * `p2p-association-transport.ts`) build on.
 *
 * ============================================================================
 * D-03: NO PLAINTEXT FALLBACK, EVER.
 * ============================================================================
 * Every staged payload this seam's callers write onto a strand goes on as a 62-04 sealed
 * envelope, never as plaintext. A transport given no sealer refuses to stage at all
 * (`P2pStagingError 'no-sealer'`) before any I/O; a sealer that throws (e.g. a zero-recipient
 * seal) propagates that error unchanged and the caller writes zero rows. There is no code path
 * in this module, or in either transport that imports it, that writes an un-sealed payload
 * column.
 *
 * Every `P2pStagingError` message carries only a code and a call-site label — never a payload
 * value, a plaintext fragment, a registration code or an identity-field value. The opener's own
 * `detail` string (62-04/62-14's structural-only detail) is deliberately DROPPED wherever this
 * seam surfaces an opener failure — only the `reason` code crosses into a `StagingUnreadableRow`.
 *
 * ============================================================================
 * WHAT THIS MODULE DOES NOT IMPORT
 * ============================================================================
 * No P2P package (cadre-core, db-p2p, libp2p) and no filesystem module —
 * only `import type` reaches `../../crypto/index.js` (62-04's envelope types) and
 * `@votetorrent/vote-core` (`Signature`). The two transports supply their own `StagingSqlPort`
 * implementation (a `RegistrationStrandPort`/`AssociationStrandPort`, which is structurally wider
 * but satisfies this narrower shape); this module never opens a strand itself.
 */

/** Zero-padded cursor width, matching the filesystem/REST bindings' own `SEQ_WIDTH` convention
 * and the schema's `CursorWidth` CHECK (`length(new.Cursor) = 16`). */
export const STAGING_CURSOR_WIDTH = 16

/** Bounded retry limit for the D-05 client-side max+1 cursor race (`insertWithCursorRetry`). */
export const STAGING_CURSOR_MAX_ATTEMPTS = 5

/** The largest cursor the schema's `CursorWellFormed` CHECK admits: 2^53 - 1, the largest exact
 * integer, as 16 digits (V-4). */
export const STAGING_CURSOR_MAX_TEXT = '9007199254740991'

/** How far above the strand's row count a cursor may sit and still count as in sequence (V-4).
 * Honest allocation is dense (max + 1, with race retries and no gaps), so an honest cursor never
 * exceeds the row count; the slack only absorbs a replica that has not yet seen every row. */
export const STAGING_CURSOR_MAX_STEP = 1000

const STAGING_CURSOR_CAP = BigInt(STAGING_CURSOR_MAX_TEXT)
const STAGING_CURSOR_PATTERN = /^[0-9]{16}$/

/**
 * True only for exactly 16 ASCII digits whose value is within 1..9007199254740991. Never throws;
 * every non-string input is non-conforming (V-4).
 */
export function isConformingStagingCursor (value: unknown): value is string {
  if (typeof value !== 'string' || !STAGING_CURSOR_PATTERN.test(value)) return false
  const n = BigInt(value)
  return n >= BigInt(1) && n <= STAGING_CURSOR_CAP
}

/**
 * The highest cursor that counts as IN SEQUENCE on a strand: its row count plus
 * `STAGING_CURSOR_MAX_STEP`, clamped to the cap and padded to 16 digits (V-4). It is engine-side
 * on purpose: the same rule as a schema CHECK would be a self-referential subquery, which Quereus
 * defers and mis-evaluates when batched.
 *
 * What the ceiling does and does not do:
 *  (a) It bounds where ALLOCATION starts (the greatest conforming cursor at or below it) and which
 *      cursor may become a staging report's high-water mark (`inSequenceHighWater`). It never
 *      blocks allocation: `insertWithCursorRetry` walks past every occupied slot above it.
 *  (b) The staging report readers (`readConformingRows`) deliver EVERY conforming row, so a forged
 *      high cursor is re-reported on every read (consumers are idempotent, D-05) and never
 *      advances the high-water mark; an honest row that had to land above the ceiling is still
 *      delivered.
 *  (c) The decision readers (`readDecisionRows`) also deliver EVERY conforming row (WR-01); the
 *      ceiling only picks the forward cursor. Consumers forward their notice cursors between
 *      polls (62-38, T-62-38-05), so the `cursor` a notice carries is a resume cursor: the row's
 *      own cursor when in sequence, otherwise the last in-sequence cursor of the read. A forged
 *      high decision is therefore re-delivered on every poll and never adopted as a forward
 *      cursor, and an honest decision walked above the ceiling is delivered at once.
 *  (d) A non-conforming `sinceCursor` is treated as absent, so the caller re-reads from the start
 *      and may see rows it already processed.
 */
export async function stagingCursorCeiling (port: StagingSqlPort, table: StagingCursorTable, strandId: string): Promise<string> {
  return (await stagingCursorBounds(port, table, strandId)).ceiling
}

/** One count query, two uses: the in-sequence ceiling and the strand's row count (the walk bound). */
async function stagingCursorBounds (port: StagingSqlPort, table: StagingCursorTable, strandId: string): Promise<{ ceiling: string, rowCount: bigint }> {
  const rows = await port.query<{ RowCount: number | string | bigint | null }>(
    `select count(*) as RowCount from ${table} where StrandId = :strandId`,
    { strandId }
  )
  // An EMPTY result (no row, or a null/undefined RowCount) honestly means 0 rows: real Quereus
  // `count(*)` always returns one row, so `[]` and null come only from port doubles and adapters
  // over an empty strand. A value that is PRESENT but is not a non-negative integer is a loud
  // 'count-unreadable' error, never a silent 0 (a silent 0 would mis-bound the walk and the ceiling).
  const raw = rows[0]?.RowCount
  let count = BigInt(0)
  if (raw !== null && raw !== undefined) {
    let parsed: bigint | undefined
    if (typeof raw === 'bigint') parsed = raw
    else if (typeof raw === 'number') parsed = Number.isSafeInteger(raw) ? BigInt(raw) : undefined
    else if (typeof raw === 'string' && /^[0-9]+$/.test(raw)) parsed = BigInt(raw)
    if (parsed === undefined || parsed < BigInt(0)) {
      throw new P2pStagingError('count-unreadable', `staging cursor bounds (${table}): the strand row count was not a non-negative integer`)
    }
    count = parsed
  }
  let ceiling = count + BigInt(STAGING_CURSOR_MAX_STEP)
  if (ceiling > STAGING_CURSOR_CAP) ceiling = STAGING_CURSOR_CAP
  return { ceiling: ceiling.toString().padStart(STAGING_CURSOR_WIDTH, '0'), rowCount: count }
}

/**
 * Orders cursor text by Unicode code point, exactly like Quereus BINARY collation. It mirrors
 * `@quereus/quereus` `compareCodePoints` (4.20.0, `dist/src/util/comparison.js`). SQL
 * `order by Cursor` and `Cursor > :x` use that order, whereas JS `<` / `>` on strings use UTF-16
 * code-unit order, which disagrees when one string has a supplementary-plane character and the
 * other a BMP character in U+E000-U+FFFF (CR-01). It is local rather than imported to keep this
 * seam free of a new runtime import; the CP0 spec pins parity with Quereus's own function. Any
 * comparison of SQL-ordered, possibly non-conforming cursor text must go through it.
 */
export function compareStagingCursorText (a: string, b: string): number {
  if (a === b) return 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const ua = a.charCodeAt(i)
    const ub = b.charCodeAt(i)
    if (ua === ub) continue
    // Lift high surrogates above the BMP range U+E000-U+FFFF, as a code-point order would.
    const ra = ua >= 0xD800 && ua <= 0xDBFF ? ua + 0x2800 : ua
    const rb = ub >= 0xD800 && ub <= 0xDBFF ? ub + 0x2800 : ub
    return ra < rb ? -1 : 1
  }
  return a.length < b.length ? -1 : 1
}

/**
 * Staging report reader front end (CR-01, IN-03): runs `selectSql` (which must bind `:strandId`
 * and `:sinceCursor` and order by Cursor asc) and returns EVERY row whose Cursor conforms, with
 * NO ceiling filter, plus the in-sequence ceiling so the caller can gate its high-water mark with
 * `inSequenceHighWater`. A non-conforming `sinceCursor` is bound as null.
 */
export async function readConformingRows<T extends { Cursor: string }> (
  port: StagingSqlPort,
  table: StagingCursorTable,
  strandId: string,
  selectSql: string,
  sinceCursor: string | undefined
): Promise<{ rows: T[], ceiling: string }> {
  const since = sinceCursor !== undefined && isConformingStagingCursor(sinceCursor) ? sinceCursor : null
  const ceiling = await stagingCursorCeiling(port, table, strandId)
  const rows = await port.query<T>(selectSql, { strandId, sinceCursor: since })
  return { rows: rows.filter((row) => isConformingStagingCursor(row.Cursor)), ceiling }
}

/**
 * The `sinceCursor` a consumer forwards to re-read from the very start: 16 characters but
 * deliberately NON-conforming (`isConformingStagingCursor` requires a value of at least 1), so
 * every P2P reader treats it as an absent `sinceCursor` (WR-01).
 */
export const STAGING_CURSOR_REREAD = '0000000000000000'

/**
 * Decision reader front end (V-4, WR-01): `readConformingRows`, then pairs EVERY conforming row
 * (none is dropped for sitting above the ceiling) with a forward-safe RESUME cursor. A row at or
 * below the ceiling carries its own cursor; a row above it carries the greatest in-sequence
 * cursor of this read, else the caller's conforming `sinceCursor`, else `STAGING_CURSOR_REREAD`.
 * Consumers forward the last notice's cursor between polls (62-38, T-62-38-05), so a forged
 * far-high decision is re-delivered on every poll and never adopted as a forward cursor, while an
 * honest decision walked above the ceiling is delivered at once.
 */
export async function readDecisionRows<T extends { Cursor: string }> (
  port: StagingSqlPort,
  table: StagingCursorTable,
  strandId: string,
  selectSql: string,
  sinceCursor: string | undefined
): Promise<Array<{ row: T, resumeCursor: string }>> {
  const { rows, ceiling } = await readConformingRows<T>(port, table, strandId, selectSql, sinceCursor)
  const since = sinceCursor !== undefined && isConformingStagingCursor(sinceCursor) ? sinceCursor : undefined
  let highWater: string | undefined
  return rows.map((row) => {
    highWater = inSequenceHighWater(highWater, row.Cursor, ceiling)
    return { row, resumeCursor: highWater ?? since ?? STAGING_CURSOR_REREAD }
  })
}

/**
 * The next high-water mark: `cursor` only when it is conforming, at or below the ceiling and
 * greater than `current`; otherwise `current`. A forged or out-of-sequence high cursor is
 * therefore never adopted as a high-water mark. It compares only conforming 16-digit ASCII
 * values, for which JS order equals code-point order.
 */
export function inSequenceHighWater (current: string | undefined, cursor: string, ceiling: string): string | undefined {
  if (!isConformingStagingCursor(cursor) || cursor > ceiling) return current
  return current === undefined || cursor > current ? cursor : current
}

/**
 * Requester side (D-03/D-04). `plaintext` is the JSON string this transport builds (the encoded
 * `RegistrationStagingPlaintext` / `AssociationStagingPlaintext` / `AssociationAttestationAnswer`
 * body — see each transport's own module header for the exact shape). `seal()` returns the
 * `serializeEnvelope(...)` string stored VERBATIM in `InitJson` / `AnswerJson`. It THROWS
 * (62-14's production factory: `IntakeError 'no-recipients'`; this plan's own tests: 62-04's
 * `EnvelopeSealError 'no-recipients'`) rather than ever returning plaintext.
 *
 * `authorityId`, when present, must equal the request's `init.authorityId` — a transport checks
 * this BEFORE sealing (the `'sealer-authority-mismatch'` guard) so a sealer wired to the wrong
 * authority's recipient list can never silently mis-seal a row onto another authority's strand.
 * 62-14's `IntakeSealer` always sets it; a test sealer may leave it `undefined` to opt out of the
 * guard.
 */
export interface StagingSealer {
  readonly authorityId?: string
  seal(plaintext: string, binding: EnvelopeBinding): Promise<string>
}

/** Authority side. Shape fixed by the orchestrator's 62-14 note — 62-14's `IntakeOpenResult` is
 * structurally assignable to this type. */
export type StagingOpenResult =
  | { readonly ok: true, readonly plaintext: string }
  | { readonly ok: false, readonly reason: string, readonly detail: string }

/**
 * Authority side. `open()` is expected never to reject (62-14's opener reports every vault
 * problem as `reason: 'vault-error'`); if a host opener rejects anyway, the whole read rejects
 * with that error unchanged — this seam does not swallow a rejected promise into a fabricated
 * unreadable row.
 */
export interface StagingOpener {
  open(sealed: string, binding: EnvelopeBinding): Promise<StagingOpenResult>
}

/** Authority side (D-06). A transport binds `DeciderKey := signature.signerKey` and
 * `DeciderSignature := signature.signature` from the returned `Signature`. */
export interface StagingDecisionSigner {
  readonly authorityId: string
  sign(digest: Uint8Array): Promise<Signature>
}

export type P2pStagingErrorCode =
  | 'no-sealer' | 'no-opener' | 'no-decision-signer' | 'sealer-authority-mismatch'
  | 'duplicate-request-id' | 'duplicate-decision' | 'cursor-exhausted' | 'rejected' | 'digest-unavailable'
  | 'code-binding-requires-signer' | 'count-unreadable'

/**
 * Every message is built from a code and a call-site label only — never a payload, plaintext,
 * registration code or identity value. The underlying strand rejection (if any) is kept ONLY as
 * `cause`, never interpolated into `message`, so a caller that logs `error.message` cannot leak
 * driver-level detail that might itself echo bound parameters.
 */
export class P2pStagingError extends Error {
  readonly code: P2pStagingErrorCode

  constructor (code: P2pStagingErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'P2pStagingError'
    this.code = code
  }
}

/**
 * The opener's own reason string, passed through verbatim: 62-04's `EnvelopeOpenFailureReason`
 * (`'invalid-argument' | 'malformed-envelope' | 'unsupported-version' | 'not-a-recipient' |
 * 'authentication-failed'`), 62-14 additionally reports `'no-local-key' | 'vault-error'`, or one
 * of this seam's own two read-path reasons: `'invalid-plaintext'` (the opened plaintext failed
 * this transport's own shape/version/id checks) and `'malformed-row'` (the row's `SignatureJson`
 * itself did not parse — the opener was never even called).
 */
export type StagingUnreadableReason = string

export interface StagingUnreadableRow {
  readonly requestId: string
  readonly cursor: string
  readonly requesterKey: string
  readonly stagedAt: string
  readonly reason: StagingUnreadableReason
}

export interface StagingReadReport<T> {
  /** Opened rows, in cursor order. */
  readonly delivered: T[]
  readonly unreadable: StagingUnreadableRow[]
  /** The greatest CONFORMING cursor at or below the in-sequence ceiling among every row read this
   * call, delivered or unreadable — so a caller can advance its own `sinceCursor` past an
   * unreadable row instead of re-reading it forever. Rows above the ceiling are still delivered
   * or reported but never count here (V-4, `inSequenceHighWater`), so a forged high cursor is
   * re-reported on every read and never adopted. */
  readonly highWaterCursor?: string
}

/** Structural SQL port both transports' `StrandPort` types satisfy (each additionally declares
 * `close()`, which this narrower shape does not require). */
export interface StagingSqlPort {
  query<T>(sql: string, params: Record<string, unknown>): Promise<T[]>
  mutate(sql: string, params: Record<string, unknown>): Promise<void>
}

/** The five staging/decision tables `insertWithCursorRetry` may target. Deliberately a closed
 * union: a table name is NEVER interpolated from external input, only from this fixed list. */
export type StagingCursorTable =
  | 'RegistrationRequestStaging' | 'RegistrationDecision'
  | 'AssociationRequestStaging' | 'AssociationAttestationStaging' | 'AssociationDecision'

/**
 * Bounded cursor retry — closes the D-05 client-side max+1 race
 * (`p2p-registration-transport.ts:287-297`, pre-this-plan). Internal to the two transports — NOT
 * re-exported to either barrel (`p2p-registration-transport.ts` exports every other seam name
 * explicitly; this one is left out on purpose).
 *
 * For attempt 1..`STAGING_CURSOR_MAX_ATTEMPTS`:
 *   1. Allocate the cursor (V-4): the greatest CONFORMING, IN-SEQUENCE cursor (at or below
 *      `stagingCursorCeiling`: row count + `STAGING_CURSOR_MAX_STEP`) is `base`; the candidate is
 *      max(`base`, `floor`) + 1, then WALKED upward past every occupied slot (ascending pages of
 *      64 rows), because the strand's (StrandId, Cursor) unique index refuses an occupied slot
 *      and re-deriving the same candidate would wedge allocation (CR-01). The walk pages by the
 *      last row seen (not by the candidate), so a page holding only non-conforming rows still
 *      advances; it is bounded to `STAGING_CURSOR_MAX_TEXT`, so above-cap rows are never paged,
 *      while non-digit and wrong-width rows that sort at or below the cap ARE paged and skipped.
 *      The progress guard compares cursors by code point (`compareStagingCursorText`) because SQL
 *      orders by code point (CR-01). The walk is bounded by `rowCount / 64 + 2` pages; a page that
 *      does not advance, or a walk past that bound, throws `cursor-exhausted`; cost grows by one
 *      query per 64 planted in-range rows (IN-05).
 *      `floor` is the slot a genuine race just took. Static occupied slots, however many a
 *      forger planted, never consume an attempt; only real concurrent inserts do. A malformed
 *      cursor is skipped. If the free slot is above the cap it throws `cursor-exhausted` without
 *      calling `mutate`. The bound is engine-side, not a schema CHECK: a self-referential CHECK
 *      is deferred and Quereus mis-evaluates batched deferred CHECKs.
 *   2. `port.mutate(insertSql, { ...params, cursor })`. On success, return
 *      `{ cursor, idempotent: false }`.
 *   3. On any rejection, first run the identity read (`args.identity`). If it returns rows, call
 *      `onIdentityConflict`: an `'idempotent'` result returns the EXISTING row's own cursor with
 *      `idempotent: true`; otherwise the returned `P2pStagingError` is thrown.
 *   4. Otherwise probe whether the allocated cursor is now taken
 *      (`select Cursor from <table> where StrandId = :strandId and Cursor = :cursor`). If taken,
 *      raise `floor` to it and continue to the next attempt (re-allocate past it).
 *   5. Otherwise the rejection is some OTHER schema refusal (a forged signature, a CHECK the row
 *      fails on its own merits) — throw `P2pStagingError('rejected', ...)` immediately, with the
 *      underlying error as `cause`.
 * After the loop (every attempt hit a genuine cursor race), throw
 * `P2pStagingError('cursor-exhausted', ...)`.
 *
 * No sleep and no randomness — the retry is deterministic, driven only by what the port reports.
 */
export async function insertWithCursorRetry (port: StagingSqlPort, args: {
  table: StagingCursorTable
  strandId: string
  /** Binds `:cursor` plus every member of `params`. */
  insertSql: string
  /** Everything the insert needs except `cursor`. */
  params: Record<string, unknown>
  /** Reads back the row this insert would duplicate. */
  identity: { sql: string, params: Record<string, unknown> }
  onIdentityConflict: (existing: Array<Record<string, unknown>>) => 'idempotent' | P2pStagingError
  /** e.g. `'P2pRegistrationTransport.submitRequest'` — named in every thrown error. */
  where: string
}): Promise<{ cursor: string, idempotent: boolean }> {
  const { table, strandId, insertSql, params, identity, onIdentityConflict, where } = args
  const cursorProbeSql = `select Cursor from ${table} where StrandId = :strandId and Cursor = :cursor`
  const topPageSql = `select Cursor from ${table} where StrandId = :strandId and Cursor <= :ceiling order by Cursor desc limit 64`
  const nextPageSql = `select Cursor from ${table} where StrandId = :strandId and Cursor <= :ceiling and Cursor < :beforeCursor order by Cursor desc limit 64`
  const walkPageSql = `select Cursor from ${table} where StrandId = :strandId and Cursor > :afterCursor and Cursor <= :capCursor order by Cursor asc limit 64`

  let lastError: unknown
  let floor = BigInt(0)
  let overranAtCount: bigint | undefined

  attemptLoop: for (let attempt = 1; attempt <= STAGING_CURSOR_MAX_ATTEMPTS; attempt++) {
    const { ceiling, rowCount } = await stagingCursorBounds(port, table, strandId)
    // A previous attempt overran its bound. Retrying with an unchanged count would give the same
    // bound and the same overrun, so it is only worth another attempt when the count GREW; otherwise
    // surface the overrun now (bounded work against a strand that really never ends).
    if (overranAtCount !== undefined && rowCount <= overranAtCount) throw lastError
    const maxWalkPages = rowCount / BigInt(64) + BigInt(2)
    let walkPages = BigInt(0)
    // Greatest CONFORMING cursor at or below the ceiling; non-conforming rows are skipped.
    let maxConforming = BigInt(0)
    let before: string | undefined
    for (;;) {
      const page = await port.query<{ Cursor: unknown }>(
        before === undefined ? topPageSql : nextPageSql,
        before === undefined ? { strandId, ceiling } : { strandId, ceiling, beforeCursor: before }
      )
      const hit = page.find((row) => isConformingStagingCursor(row.Cursor))
      if (hit !== undefined) {
        maxConforming = BigInt(hit.Cursor as string)
        break
      }
      const last = page[page.length - 1]?.Cursor
      if (page.length < 64 || typeof last !== 'string') break
      before = last
    }
    let nextValue = (maxConforming > floor ? maxConforming : floor) + BigInt(1)
    // Walk past every occupied slot. The walk pages by the LAST ROW SEEN (never by the
    // candidate, which does not move across a page of non-conforming rows) and is bounded to the
    // conforming range (`Cursor <= STAGING_CURSOR_MAX_TEXT`), so above-cap rows are never paged
    // (non-digit and wrong-width rows at or below the cap ARE paged and skipped) and every query
    // starts strictly after the previous page. The progress guard compares by code point, as SQL
    // orders (CR-01). A page that fails to advance throws `cursor-exhausted` at once; a walk past
    // `rowCount / 64 + 2` pages is retried within the same call (count re-read), and throws
    // `cursor-exhausted` only when every attempt overruns. Cost: one query per 64 planted in-range rows (IN-05).
    let afterCursor = (nextValue - BigInt(1)).toString().padStart(STAGING_CURSOR_WIDTH, '0')
    for (; nextValue <= STAGING_CURSOR_CAP;) {
      walkPages += BigInt(1)
      if (walkPages > maxWalkPages) {
        // The strand grew past the count this attempt read: retry within the same call (the next
        // attempt re-reads the count; rows are never deleted, so the bound only grows).
        lastError = new P2pStagingError(
          'cursor-exhausted',
          `${where}: the cursor walk read more pages than the strand holds rows`,
          { cause: lastError }
        )
        overranAtCount = rowCount
        continue attemptLoop
      }
      const page = await port.query<{ Cursor: unknown }>(walkPageSql, { strandId, afterCursor, capCursor: STAGING_CURSOR_MAX_TEXT })
      let free = false
      for (const row of page) {
        if (!isConformingStagingCursor(row.Cursor)) continue
        const rowValue = BigInt(row.Cursor)
        if (rowValue === nextValue) nextValue += BigInt(1)
        else if (rowValue > nextValue) { free = true; break }
      }
      if (free || page.length < 64 || nextValue > STAGING_CURSOR_CAP) break
      const last = page[page.length - 1]?.Cursor
      if (typeof last !== 'string' || compareStagingCursorText(last, afterCursor) <= 0) {
        throw new P2pStagingError(
          'cursor-exhausted',
          `${where}: the strand returned a cursor page that does not advance`,
          { cause: lastError }
        )
      }
      afterCursor = last
    }
    if (nextValue > STAGING_CURSOR_CAP) {
      throw new P2pStagingError(
        'cursor-exhausted',
        `${where}: the staging cursor space is exhausted`,
        { cause: lastError }
      )
    }
    const cursor = nextValue.toString().padStart(STAGING_CURSOR_WIDTH, '0')

    try {
      await port.mutate(insertSql, { ...params, cursor })
      return { cursor, idempotent: false }
    } catch (err) {
      lastError = err

      const existing = await port.query<Record<string, unknown>>(identity.sql, identity.params)
      if (existing.length > 0) {
        const outcome = onIdentityConflict(existing)
        if (outcome === 'idempotent') {
          const existingCursor = existing[0]?.Cursor
          if (typeof existingCursor !== 'string') {
            throw new P2pStagingError(
              'rejected',
              `${where}: an identity conflict resolved as idempotent, but the existing row carried no readable Cursor`,
              { cause: err }
            )
          }
          return { cursor: existingCursor, idempotent: true }
        }
        throw outcome
      }

      const cursorProbe = await port.query<{ Cursor: string }>(cursorProbeSql, { strandId, cursor })
      if (cursorProbe.length > 0) {
        // Genuine cursor race: someone else landed this exact cursor between our SELECT and our
        // INSERT. Retry past it: the floor keeps the next candidate above the collided slot.
        floor = nextValue
        continue
      }

      // Neither an identity conflict nor a cursor race: the strand refused the row on its own
      // merits (a forged signature, some other CHECK) — surface immediately, never retried.
      throw new P2pStagingError('rejected', `${where}: the strand refused the row`, { cause: err })
    }
  }

  throw new P2pStagingError(
    'cursor-exhausted',
    `${where}: exhausted ${STAGING_CURSOR_MAX_ATTEMPTS} cursor allocation attempts`,
    { cause: lastError }
  )
}

/** The seal/open seam is string-based (orchestrator note: 62-14 works on strings only), so
 * neither transport ever encodes or decodes bytes directly — only JSON text. */
export function encodeStagingPlaintext (value: unknown): string {
  return JSON.stringify(value)
}

/** `undefined` on any parse failure — never throws. The caller treats `undefined` as
 * `'invalid-plaintext'`. */
export function decodeStagingPlaintext (text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
