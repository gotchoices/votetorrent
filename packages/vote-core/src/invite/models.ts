import type { UserInit } from '../index.js'
import type { SentOfficerInvite, SentAuthorityInvite } from '../authority/models.js'

export interface Invite {
  /** The type of the invitation */
  type: InviteType

  /** The expiration date of the invitation */
  expiration: string

  /** The public key of the invitation */
  inviteKey: string

  /** The private key of the invitation */
  invitePrivate: string

  /** The signature of the invitation */
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
 * Engine surface for invitation read + respond flows (D-10).
 * Mocks-only in v1.1; real implementation lands in a later milestone.
 */
export interface IInvitationEngine {
  /** Pending officer (administrator) invites the current user has sent or received. */
  getPendingOfficerInvites(): Promise<Array<InviteStatus<SentOfficerInvite>>>

  /** Pending authority invites the current user has sent or received. */
  getPendingAuthorityInvites(): Promise<Array<InviteStatus<SentAuthorityInvite>>>

  /** Fetch a single officer invite by id, or undefined if not found. */
  getOfficerInvite(id: string): Promise<InviteStatus<SentOfficerInvite> | undefined>

  /** Fetch a single authority invite by id, or undefined if not found. */
  getAuthorityInvite(id: string): Promise<InviteStatus<SentAuthorityInvite> | undefined>

  /** Respond to an invite — accept (true) or decline (false). */
  respondToInvite(invitationId: string, accept: boolean): Promise<void>
}
