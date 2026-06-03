import type { Proposal, Signature } from '../common'
import type {
  AuthorityDetails,
  AdminDetails,
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
  getDetails(): Promise<AuthorityDetails>
  proposeAdmin(admin: Proposal<AdminInit>, signature: Signature): Promise<void>
  saveInviteWithSigning(
    invite: AuthorityInvite | OfficerInvite,
    scope: Scope,
    signature: Signature
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

export interface IAuthoritySaveInviteWithSigningBuilder extends IBuilder<{ invite: AuthorityInvite | OfficerInvite; scope: Scope; signature: Signature }, void> {
  fromPayload(payload: { invite: AuthorityInvite | OfficerInvite; scope: Scope; signature: Signature }): this
}
