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
}
