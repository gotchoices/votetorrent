import type { Proposal, Signature } from '../common'
import type {
  AuthorityDetails,
  AdminDetails,
  AdminPromotionResult,
  AuthorityInvite,
  OfficerInvite,
  AdminInit,
  OfficerInit,
  Scope,
  SentAuthorityInvite
} from './models'
import type { AuthorityInviteShare, InviteStatus, OfficerInviteShare } from '../invite/models'
import type { IBuilder } from '../common/builder.js'

export interface IAuthorityEngine {
  createOfficerInvite(init: OfficerInit): OfficerInviteShare
  createAuthorityInvite(name: string): AuthorityInviteShare
  getAdminDetails(): Promise<AdminDetails>
  getAuthorityInvites(): Promise<Array<InviteStatus<SentAuthorityInvite>>>
  /**
   * SURF-03 (D-05/D-06): cancel a pending invitation. NON-signing this phase.
   * Inserts append-only InviteCancellation markers keyed by InviteSlot Cid; the
   * slot itself is never mutated (InviteSlot is InsertOnly). A share is one
   * invitation, so this cancels EVERY row of the share's resend chain (same
   * InviteKey, Type and SigningNonce) atomically, whichever row is passed;
   * rows already cancelled are skipped (idempotent). Pending reads drop a
   * cancelled invitation off the list while the audit trail persists.
   * Rejects with an Error whose `code` is 'invite-already-answered', with no
   * write, when any copy of the invitation has already been answered.
   */
  cancelInvite(slotCid: string): Promise<void>
  /**
   * The officer-reachable pending list (H-5): the Cids of this authority's officer ('of') invitations
   * whose share chain is still live (neither answered, withdrawn nor expired). One Cid per share, the
   * live head.
   */
  getPendingInviteCids(): Promise<string[]>
  /**
   * SURF-03 (D-05/D-07): re-emit a pending invitation as a FRESH InviteSlot.
   * NON-signing this phase — reuses the original slot's already-approved
   * SigningNonce + InviteSignature (A2), so no new signing round is performed.
   * No auto-supersede: each resend is an independent slot, but the pending list
   * shows only the newest copy. Rejects with an Error whose `code` is
   * 'invite-already-answered', with no write, when any copy of the invitation
   * has already been answered. Returns the new slot's Cid.
   */
  resendInvite(slotCid: string): Promise<string>
  getDetails(): Promise<AuthorityDetails>
  proposeAdmin(admin: Proposal<AdminInit>, signatureOrCallback: Signature | ((digest: Uint8Array) => Promise<Signature>)): Promise<void>
  /**
   * 57-07 (D-01 promotion half): promote a threshold-reached 'rad'
   * AdminSigning/AdminSignature session into live Admin + Officer rows.
   *
   * Takes a sign CALLBACK ONLY — never a pre-supplied Signature the way
   * `proposeAdmin` does. This method computes two distinct digests (one
   * for the promoted Admin row, one shared by every promoted Officer row)
   * and mints a fresh AdminSigning session for each; a single pre-supplied
   * Signature could not cover both.
   *
   * `options.ownsTransaction` defaults to true. Pass `false` when composing
   * this call inside a caller's own already-open transaction (57-08).
   *
   * Both triggers are wired (57-08): `AuthorityEngine.proposeAdmin` calls this
   * directly when its own 'rad' session reaches threshold (Trigger A), and
   * `SignatureTasksEngine.completeSignature` calls it inside the composed
   * sign+promote transaction when a co-signer's signature reaches threshold
   * (Trigger B).
   */
  applyAdminProposal(
    nonce: string,
    sign: (digest: Uint8Array) => Promise<Signature>,
    options?: { ownsTransaction?: boolean }
  ): Promise<AdminPromotionResult>
  saveInviteWithSigning(
    invite: AuthorityInvite | OfficerInvite,
    scope: Scope,
    signatureOrCallback: Signature | ((digest: Uint8Array) => Promise<Signature>)
  ): Promise<void>
  buildCreateOfficerInvite(): IAuthorityCreateOfficerInviteBuilder
  buildCreateAuthorityInvite(): IAuthorityCreateAuthorityInviteBuilder
  buildProposeAdmin(): IAuthorityProposeAdminBuilder
  buildSaveInviteWithSigning(): IAuthoritySaveInviteWithSigningBuilder
}

export interface IAuthorityCreateOfficerInviteBuilder extends IBuilder<OfficerInit, OfficerInviteShare> {
  fromPayload(payload: OfficerInit): this
}

export interface IAuthorityCreateAuthorityInviteBuilder extends IBuilder<string, AuthorityInviteShare> {
  fromPayload(payload: string): this
}

export interface IAuthorityProposeAdminBuilder extends IBuilder<{ admin: Proposal<AdminInit>; signature: Signature }, void> {
  fromPayload(payload: { admin: Proposal<AdminInit>; signature: Signature }): this
}

export interface IAuthoritySaveInviteWithSigningBuilder extends IBuilder<{ invite: AuthorityInvite | OfficerInvite; scope: Scope; signature: Signature | ((digest: Uint8Array) => Promise<Signature>) }, void> {
  fromPayload(payload: { invite: AuthorityInvite | OfficerInvite; scope: Scope; signature: Signature | ((digest: Uint8Array) => Promise<Signature>) }): this
}
