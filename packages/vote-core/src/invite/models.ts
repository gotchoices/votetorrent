import type { UserInit } from '../index.js'
import type { AuthorityInvite, OfficerInvite } from '../authority/models.js'

export interface Invite {
  /** The type of the invitation */
  type: InviteType

  /** The expiration date of the invitation */
  expiration: string

  /** Hex-encoded secp256k1 compressed public key (66 chars, 33 bytes). */
  inviteKey: string

  /** Hex-encoded secp256k1 compact signature (128 chars, 64 bytes). */
  inviteSignature: string

  /** The digest of the invitation */
  digest: string
}

export interface InviteStatus<TSentInvite> {
  invite: TSentInvite
  result?: InviteResult
}

// TODO(compat): Legacy shape used by older vote-engine mocks.
// Replace `InvitationStatus` + `InvitationSlot` usage with `InviteStatus<TSentInvite>` once mock data is migrated.
export interface InvitationSlot<TInvite> {
  invite: TInvite
  type: InviteType
  expiration: string | number
}

// TODO(compat): Legacy shape used by older vote-engine mocks.
// `sent` and `result.userId` are inferred from current mock code and are optional for compatibility.
export interface InvitationStatus<TInvite> {
  slot: InvitationSlot<TInvite>
  sent?: {
    key: string
    signatures: Array<{
      signature: string
      signerKey: string
      signerUserId?: string
    }>
  }
  result?: InviteResult & {
    userId?: string
  }
}

export interface InviteResult {
  // /** ID of the user that accepted the invitation */
  // userId: string;

  /** Whether the invitation was accepted */
  isAccepted: boolean

  /** The digest is the invite slot cid, the isAccepted flag, and the digest of whatever is being created.
   * Signed by the private key given in the invitation */
  invitationSignature: string

  /** ID of the result */
  invokedId?: string
}

export interface InviteAction<TInvokes> {
  /** What the invitation is invoking */
  invokes: TInvokes

  /** The user that is being created if this is a new user
   * Use this or userId, not both
   */
  userInit?: UserInit

  /** ID of the user that accepted the invitation if this is an existing user
   * Use this or userInit, not both
   */
  userId?: string

  /** The invite that was accepted */
  invite: Invite

  /** Whether the invitation was accepted */
  isAccepted: boolean

  /** The digest is the invite, the isAccepted flag, and the acceptingId. Signed by the private key given in the invitation */
  inviteSignature: string
}

/** "au" for authority, "of" for officer, "k" for keyholder, "r" for registrant */
export type InviteType = 'au' | 'of' | 'k' | 'r'

/**
 * Officer invite + the one-time invite private key. One-time use only —
 * discard the OfficerInviteShare reference after the share-link / QR
 * moment per Phase 3 D-27. The base `OfficerInvite` type intentionally
 * has no `invitePrivate` field; only this `Share` variant carries it.
 */
export interface OfficerInviteShare extends OfficerInvite {
  /** Hex-encoded secp256k1 private key (64 chars, 32 bytes). One-time use only. */
  invitePrivate: string
}

/**
 * Authority invite + the one-time invite private key. Same lifecycle
 * contract as `OfficerInviteShare` — discard after the share-link / QR
 * moment per Phase 3 D-27.
 */
export interface AuthorityInviteShare extends AuthorityInvite {
  /** Hex-encoded secp256k1 private key (64 chars, 32 bytes). One-time use only. */
  invitePrivate: string
}
