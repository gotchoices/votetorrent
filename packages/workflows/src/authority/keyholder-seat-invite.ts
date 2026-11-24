/**
 * keyholder-seat-invite.ts: the keyholder SEAT invitation (the real seat-share builder).
 *
 * Extracted by phase 67 plan 10 from `apps/VoteTorrentAuthority/src/screens/keyholder/KeyholderInvitationScreen.tsx`
 * sendInvitation (lines 160-242, the send path only; accept/decline stay in the screen). Create/Edit
 * Election only write name placeholders; THIS is where a seat's ephemeral key is minted and the signed
 * `InviteSlot` (Type='k') is written through `inviteKeyholder`.
 *
 * Secrecy contract: the share returned here (`share.invitePrivate` above all) is approval-class secret
 * material, the invitee's one-time seat secret. This function never logs it and never serializes it; it
 * hands the share to the caller ONLY, who writes it to a 0600 file (CLI) or a share sheet (app) and never
 * logs it. The officer's signer arrives as a callback factory invoked exactly once; no key crosses in.
 *
 * One deliberate reorder versus the screen: the expiry preset is validated FIRST (it throws RangeError on
 * a non-preset), before any key material exists, so a bad input creates no secret. The screen generated
 * the key first; the difference is unobservable except that no secret is created on bad input.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/curves/utils.js'
import type { IElectionEngine, KeyholderInvite } from '@votetorrent/vote-core'
import type { SignCallback } from '../platform/signer.js'
import { keyholderInviteExpiration } from './keyholder-invite-expiry.js'

/** The fields the share text carries (`serializeInviteShare` in the keyholder group serializes them). */
export interface KeyholderSeatShare {
  invitePrivate: string
  inviteKey: string
  expiration: string
  type: 'k'
  name: string
}

export interface InviteKeyholderSeatParams {
  electionEngine: Pick<IElectionEngine, 'getElectionDetails' | 'inviteKeyholder'>
  /** The invitee's name; a keyholder slot binds to its invitee by name (REVIEW/IN-06). */
  name: string
  /** One of `KEYHOLDER_INVITE_EXPIRY_HOURS`; anything else throws RangeError before any key exists. */
  expiryHours: number
  /** Called exactly once, after the election id is read and before `inviteKeyholder`. */
  createSigner: () => Promise<SignCallback>
  now: number
}

export interface InviteKeyholderSeatResult {
  electionId: string
  share: KeyholderSeatShare
}

/**
 * Mint the ephemeral secp256k1 seat key, write the signed invite slot, return the share to the caller.
 * Order: expiry preset, key, invite object (NO invitePrivate), election id, signer once, inviteKeyholder.
 */
export async function inviteKeyholderSeat(params: InviteKeyholderSeatParams): Promise<InviteKeyholderSeatResult> {
  const { electionEngine, name, expiryHours, createSigner, now } = params

  // O-11: the officer's chosen validity; a non-preset throws here, before any key material exists.
  const expiration = keyholderInviteExpiration(now, expiryHours)

  // AUTH-01 (D-01): hex-encoded secp256k1 key material for this seat; the raw bytes are zeroed once encoded.
  const sk = secp256k1.utils.randomSecretKey()
  const invitePrivate = bytesToHex(sk)
  const inviteKey = bytesToHex(secp256k1.getPublicKey(sk))
  sk.fill(0)

  const type = 'k' as const
  // WR-04: there is NO real keyholder-invite signature yet. The current inviteKeyholder engine impl uses
  // InviteSignature = null SQL-side; a real keyholder-invite signature is produced engine-side by the
  // forthcoming createKeyholderInvite engine method (the same boundary that already mints
  // authority/officer invite signatures). We therefore do NOT fabricate a signature value here: no
  // placeholder is stored or shared. The KeyholderInvite type requires inviteSignature: string, so we
  // pass an empty string (the engine ignores it) rather than a fake 128-char zero string.
  // The invite carries NO invitePrivate: that goes only to the caller through the share.
  const invite: KeyholderInvite = {
    type,
    expiration,
    inviteKey,
    inviteSignature: '',
    name,
  }

  const electionId = (await electionEngine.getElectionDetails()).election.id

  // second-keyholder-invite-unique fix: inviteKeyholder writes a signed InviteSlot (Type='k') and requires
  // the admin's approval signature, the same D-01/D-03/D-04 signer pattern AuthorityInvitationScreen uses
  // for saveInviteWithSigning. The private key never crosses into vote-engine.
  const sign = await createSigner()
  await electionEngine.inviteKeyholder(invite, electionId, sign)

  return { electionId, share: { invitePrivate, inviteKey, expiration, type, name } }
}
