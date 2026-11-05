import type { InviteSlotResolution } from '@votetorrent/vote-core'
import type { EngineContext } from '../types.js'
import { fromCanonicalDatetime } from '../utils.js'

/** One chain row as the reader saw it: its Cid and whether an InviteCancellation marker exists for it. */
export interface InviteChainRow { cid: string, cancelled: boolean }

export interface InviteChainDetail {
  resolution: InviteSlotResolution
  rows: InviteChainRow[]
}

/**
 * The ONE copy of the share-liveness rule. Callers: InvitationEngine.resolveInviteSlot,
 * InvitationEngine.respondToInvite (via assertSlotIsLiveHead) and AuthorityEngine (pending list,
 * cancelInvite, resendInvite).
 *
 * Chain = every InviteSlot with the same (InviteKey, Type) that belongs to one signing nonce.
 *  - Nonce-scoped read (the caller names a slot, so it knows the nonce; gap7/WR-07 option a): one
 *    INDEXED read `WHERE SigningNonce = :nonce` (InviteSlotSigningNonce), then InviteKey and Type are
 *    matched in TypeScript. The InviteKey scan is never issued.
 *  - Unscoped read (the share only): reads by InviteKey, a scan until an InviteKey index exists
 *    (option b, deferred D-1). If the rows hold more than one signing nonce the result is `ambiguous`,
 *    decided BEFORE any answer is considered (gap7/WR-06): a planted copy under another nonce, answered
 *    or not, cannot make the victim's share read `answered`.
 * Per-row facts are read with separate PK-keyed single-row reads (never one compound WHERE: the Quereus
 * AND+IN/OR zero-row trap would make a silently empty read look like a refusal). All slot rows are
 * collected before the first per-row prepare (the exec-mutex rule).
 * Not exported from the package index.
 */
export async function readInviteChain (db: EngineContext['db'], inviteKey: string, slotType: string, now: string, onlyNonce?: string): Promise<InviteSlotResolution> {
  return (await readInviteChainDetailed(db, inviteKey, slotType, now, onlyNonce)).resolution
}

/** `readInviteChain` plus the chain's rows and cancellation markers, so callers need no second scan. */
export async function readInviteChainDetailed (db: EngineContext['db'], inviteKey: string, slotType: string, now: string, onlyNonce?: string): Promise<InviteChainDetail> {
  const rows: Array<{ cid: string, nonce: string, salt: string | null }> = []
  if (onlyNonce !== undefined) {
    for await (const row of db.eval(
      'SELECT Cid, InviteKey, Type, SigningNonce, ResendSalt FROM InviteSlot WHERE SigningNonce = :nonce',
      { nonce: onlyNonce }
    )) {
      if (row.InviteKey !== inviteKey || row.Type !== slotType) continue
      rows.push({ cid: row.Cid as string, nonce: row.SigningNonce as string, salt: (row.ResendSalt as string | null) ?? null })
    }
  } else {
    for await (const row of db.eval(
      'SELECT Cid, SigningNonce, ResendSalt FROM InviteSlot WHERE InviteKey = :inviteKey AND Type = :slotType',
      { inviteKey, slotType }
    )) {
      rows.push({ cid: row.Cid as string, nonce: row.SigningNonce as string, salt: (row.ResendSalt as string | null) ?? null })
    }
  }
  if (rows.length === 0) return { resolution: { status: 'not-found' }, rows: [] }

  // Per-row facts.
  const cancelledAt = new Map<string, string | number>()
  const answeredCids: string[] = []
  for (const r of rows) {
    const result = await db
      .prepare('SELECT 1 AS x FROM InviteResult WHERE SlotCid = :slotCid')
      .get({ slotCid: r.cid })
    if (result) answeredCids.push(r.cid)
    const cancel = await db
      .prepare('SELECT CancelledAt FROM InviteCancellation WHERE SlotCid = :slotCid')
      .get({ slotCid: r.cid })
    if (cancel) cancelledAt.set(r.cid, cancel.CancelledAt as string | number)
  }
  const detailRows: InviteChainRow[] = rows.map(r => ({ cid: r.cid, cancelled: cancelledAt.has(r.cid) }))
  const resolution = await decide(db, rows, cancelledAt, answeredCids, now)
  return { resolution, rows: detailRows }
}

async function decide (
  db: EngineContext['db'],
  rows: Array<{ cid: string, nonce: string, salt: string | null }>,
  cancelledAt: Map<string, string | number>,
  answeredCids: string[],
  now: string,
): Promise<InviteSlotResolution> {
  // Fail closed on structure FIRST (WR-06): more than one signing nonce under one share is ambiguous
  // whatever the answers say, so a planted answered copy cannot close the victim's share.
  if (new Set(rows.map(r => r.nonce)).size > 1) return { status: 'ambiguous' }
  const answeredCid = answeredCids[0]
  if (answeredCid !== undefined) return { status: 'answered', cid: answeredCid }

  // One original, parseable salts, distinct order keys.
  if (rows.filter(r => r.salt === null).length > 1) return { status: 'ambiguous' }
  const ordered: Array<{ cid: string, tid: number, nowMs: number }> = []
  for (const r of rows) {
    if (r.salt === null) {
      ordered.push({ cid: r.cid, tid: -1, nowMs: 0 })
      continue
    }
    const parts = r.salt.split('|')
    const tid = Number(parts[1])
    const nowMs = fromCanonicalDatetime(parts[2] ?? '')
    if (parts.length !== 3 || parts[0] !== 'resend' || !Number.isInteger(tid) || Number.isNaN(nowMs)) {
      return { status: 'ambiguous' }
    }
    ordered.push({ cid: r.cid, tid, nowMs })
  }
  ordered.sort((a, b) => a.tid - b.tid || a.nowMs - b.nowMs)
  for (let i = 1; i < ordered.length; i++) {
    const cur = ordered[i]
    const prev = ordered[i - 1]
    if (cur && prev && cur.tid === prev.tid && cur.nowMs === prev.nowMs) return { status: 'ambiguous' }
  }
  const head = ordered[ordered.length - 1]
  if (!head) return { status: 'not-found' }

  // Backstop: a non-head cancellation strictly later than the head's resend time.
  let backstopClosed = false
  for (const o of ordered.slice(0, -1)) {
    const at = cancelledAt.get(o.cid)
    if (at === undefined) continue
    const atMs = fromCanonicalDatetime(at)
    if (Number.isNaN(atMs)) return { status: 'ambiguous' }
    if (atMs > head.nowMs) backstopClosed = true
  }

  if (cancelledAt.has(head.cid) || backstopClosed) return { status: 'no-longer-valid' }
  const unexpired = await db
    .prepare('SELECT 1 AS x FROM InviteSlot WHERE Cid = :slotCid AND Expiration > :now')
    .get({ slotCid: head.cid, now })
  if (!unexpired) return { status: 'no-longer-valid' }
  return { status: 'live', cid: head.cid }
}
