// invite-chain.ts - fixtures for the resend-chain / liveness specs (invite-slot-resolution,
// invite-respond-liveness). Builds officer and authority invites inline so the spec holds the share's
// private key, and writes the raw rows the engine itself never writes (an expired slot, a partial
// cancellation marker).
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/curves/utils.js'
import type { InviteType, Scope } from '@votetorrent/vote-core'
import { AuthorityEngine } from '../../src/authority/authority-engine.js'
import { allocateTid } from '../../src/database/tid-allocator.js'
import { inviteeContext } from './invite-keys.js'
import { InvitationEngine } from '../../src/invite/invitation-engine.js'
import { fromCanonicalDatetime, nowCanonicalDatetime } from '../../src/utils.js'
import { createTestNetwork, addTestAuthority, makeTestSignCallback } from './test-context.js'
import type { TestAuthorityContext } from './test-context.js'

export interface ChainFixture {
  auth: TestAuthorityContext
  authority: AuthorityEngine
  invitation: InvitationEngine
  /** Keyholder accepts use this: a device that is not the inviting officer's. */
  inviteeInvitation: InvitationEngine
}

export interface SentShare {
  cid: string
  inviteKey: string
  invitePrivate: string
  type: InviteType
}

export async function makeChainFixture (): Promise<ChainFixture> {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  return {
    auth,
    authority: auth.authorityEngine as unknown as AuthorityEngine,
    invitation: new InvitationEngine(auth.ctx),
    inviteeInvitation: new InvitationEngine(inviteeContext(auth.ctx)),
  }
}

let counter = 0

/** Send an officer ('of') or authority ('au') invite through the real signing pipeline. */
export async function sendInvite (fx: ChainFixture, type: 'of' | 'au', name?: string): Promise<SentShare> {
  counter += 1
  const label = name ?? `Chain ${type} ${counter}`
  const signCallback = makeTestSignCallback(fx.auth.user)
  if (type === 'of') {
    const share = fx.authority.createOfficerInvite({ name: label, title: 'Member', scopes: ['rad'] as Scope[] })
    await fx.authority.saveInviteWithSigning(share, 'rad' as Scope, signCallback)
    return { cid: await cidOf(fx, share.inviteKey, 'of'), inviteKey: share.inviteKey, invitePrivate: share.invitePrivate, type }
  }
  const share = fx.authority.createAuthorityInvite(label)
  await fx.authority.saveInviteWithSigning(share, 'iad' as Scope, signCallback)
  return { cid: await cidOf(fx, share.inviteKey, 'au'), inviteKey: share.inviteKey, invitePrivate: share.invitePrivate, type }
}

async function cidOf (fx: ChainFixture, inviteKey: string, type: string): Promise<string> {
  const row = await fx.auth.ctx.db
    .prepare('select Cid from InviteSlot where InviteKey = :inviteKey and Type = :slotType')
    .get({ inviteKey, slotType: type })
  if (!row) throw new Error('sendInvite: slot not found after save')
  return row.Cid as string
}

export async function countRows (fx: ChainFixture, table: string, column: string, value: string): Promise<number> {
  let n = 0
  for await (const _row of fx.auth.ctx.db.eval(`select 1 as x from ${table} where ${column} = :v`, { v: value })) n += 1
  return n
}

export async function resultRows (fx: ChainFixture, cids: string[]): Promise<number> {
  let n = 0
  for (const cid of cids) n += await countRows(fx, 'InviteResult', 'SlotCid', cid)
  return n
}

export async function markerRows (fx: ChainFixture, cids: string[]): Promise<number> {
  let n = 0
  for (const cid of cids) n += await countRows(fx, 'InviteCancellation', 'SlotCid', cid)
  return n
}

/** The `<now>` segment of a resend row's ResendSalt (`resend|<tid>|<now>`). */
export async function resendTime (fx: ChainFixture, cid: string): Promise<string> {
  const row = await fx.auth.ctx.db.prepare('select ResendSalt from InviteSlot where Cid = :cid').get({ cid })
  const salt = row?.ResendSalt as string
  return salt.split('|')[2]
}

/** A partial marker NOT written by AuthorityEngine.cancelInvite (pre-fix build / replicated marker). */
export async function writeRawMarker (fx: ChainFixture, slotCid: string, cancelledAt: string): Promise<void> {
  const tid = await allocateTid(fx.auth.ctx.db, 'authority')
  await fx.auth.ctx.db.exec(
    `insert into InviteCancellation (SlotCid, CancelledAt)
      with context Tid = ${tid}, now = :now
      values (:slotCid, :cancelledAt)`,
    { slotCid, cancelledAt, now: cancelledAt },
  )
}

/** One day after an epoch-ms-parseable canonical datetime, in canonical form. */
export function dayAfter (canonical: string): string {
  return new Date(fromCanonicalDatetime(canonical) + 86_400_000).toISOString().slice(0, 19)
}

/**
 * Insert an already-expired 'of' InviteSlot directly. ExpirationValid compares against the CONTEXT
 * now (not the wall clock), so the row is inserted under a past context now.
 */
export async function insertExpiredSlot (fx: ChainFixture): Promise<SentShare> {
  const priv = secp256k1.utils.randomSecretKey()
  const inviteKey = bytesToHex(secp256k1.getPublicKey(priv))
  const inviteSignature = bytesToHex(secp256k1.sign(new Uint8Array(32).fill(7), priv))
  const nonce = bytesToHex(secp256k1.utils.randomSecretKey())
  const name = `Expired ${++counter}`
  const expiration = '2000-01-02T00:00:00'
  const db = fx.auth.ctx.db
  const cidRow = await db
    .prepare('select cid(Digest(:expiration, :inviteKey, :inviteSignature, :name, :nonce, :slotType)) as c')
    .get({ expiration, inviteKey, inviteSignature, name, nonce, slotType: 'of' })
  const cid = cidRow!.c as string
  const tid = await allocateTid(db, 'authority')
  await db.exec(
    `insert into InviteSlot (Cid, Type, Name, Expiration, InviteKey, InviteSignature, SigningNonce)
      with context Tid = ${tid}, now = '2000-01-01T00:00:00', IsSignatureValid = true, IsInsertValid = true
      values (:cid, 'of', :name, :expiration, :inviteKey, :inviteSignature, :nonce)`,
    { cid, name, expiration, inviteKey, inviteSignature, nonce },
  )
  return { cid, inviteKey, invitePrivate: bytesToHex(priv), type: 'of' }
}

/**
 * Insert a raw InviteSlot into an existing share's chain (same InviteKey and Type), overriding the
 * ResendSalt and optionally the Name, SigningNonce, Expiration and the context now. The Cid is computed
 * the way resendInvite does (7-field Digest when a salt is given, 6-field otherwise). Returns the new Cid.
 */
export async function insertRawChainRow (
  fx: ChainFixture,
  base: SentShare,
  opts: { resendSalt: string | null, name?: string, nonce?: string, expiration?: string, contextNow?: string },
): Promise<string> {
  const db = fx.auth.ctx.db
  const baseRow = await db
    .prepare('select Type, Name, Expiration, InviteKey, InviteSignature, SigningNonce from InviteSlot where Cid = :cid')
    .get({ cid: base.cid })
  if (!baseRow) throw new Error('insertRawChainRow: base slot not found')
  const slotType = baseRow.Type as string
  const name = opts.name ?? (baseRow.Name as string)
  const expiration = opts.expiration ?? (baseRow.Expiration as string)
  const inviteKey = baseRow.InviteKey as string
  const inviteSignature = baseRow.InviteSignature as string
  const nonce = opts.nonce ?? (baseRow.SigningNonce as string)
  const cidRow = opts.resendSalt === null
    ? await db
      .prepare('select cid(Digest(:expiration, :inviteKey, :inviteSignature, :name, :nonce, :slotType)) as c')
      .get({ expiration, inviteKey, inviteSignature, name, nonce, slotType })
    : await db
      .prepare('select cid(Digest(:expiration, :inviteKey, :inviteSignature, :name, :nonce, :slotType, :resendSalt)) as c')
      .get({ expiration, inviteKey, inviteSignature, name, nonce, slotType, resendSalt: opts.resendSalt })
  const cid = cidRow!.c as string
  const tid = await allocateTid(db, 'authority')
  await db.exec(
    `insert into InviteSlot (Cid, Type, Name, Expiration, InviteKey, InviteSignature, SigningNonce, ResendSalt)
      with context Tid = ${tid}, now = :now, IsSignatureValid = true, IsInsertValid = true
      values (:cid, :slotType, :name, :expiration, :inviteKey, :inviteSignature, :nonce, :resendSalt)`,
    { cid, slotType, name, expiration, inviteKey, inviteSignature, nonce, resendSalt: opts.resendSalt, now: opts.contextNow ?? nowCanonicalDatetime() },
  )
  return cid
}
