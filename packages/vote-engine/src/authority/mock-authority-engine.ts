import {
  MOCK_SHARED_ADMINISTRATION_DETAILS
} from '../mock-data.js'
import type {
  Admin,
  AdminDetails,
  AdminInit,
  Authority,
  AuthorityDetails,
  AuthorityInit,
  AuthorityInvite,
  AuthorityInviteShare,
  IAuthorityEngine,
  IAuthorityCreateOfficerInviteBuilder,
  IAuthorityCreateAuthorityInviteBuilder,
  IAuthorityProposeAdminBuilder,
  IAuthoritySaveInviteWithSigningBuilder,
  InviteStatus,
  OfficerInit,
  OfficerInvite,
  OfficerInviteShare,
  Proposal,
  Scope,
  SentAuthorityInvite,
  Signature
} from '@votetorrent/vote-core'
import {
  AuthorityCreateOfficerInviteBuilder,
  AuthorityCreateAuthorityInviteBuilder,
  AuthorityProposeAdminBuilder,
  AuthoritySaveInviteWithSigningBuilder
} from './builders/index.js'

// Local mock data definitions (MOCK_ADMINISTRATORS, MOCK_THRESHOLD_POLICIES, etc.) are removed.

export class MockAuthorityEngine implements IAuthorityEngine {
  private readonly admin: Admin
  private proposedAdmin?: Proposal<AdminInit> // Can be undefined if not SLCO or no proposal made
  private readonly proposedAuthority?: Proposal<AuthorityInit> // Unused by current mock methods but part of interface/state
  // private isSlcoAuthority: boolean = false; // No longer needed

  constructor (private readonly authority: Authority) {
    // Always initialize using the shared administration template
    const detailsCopy = JSON.parse(
      JSON.stringify(MOCK_SHARED_ADMINISTRATION_DETAILS)
    )

    this.admin = detailsCopy.admin
    // **Important**: Set the correct authorityId for this specific instance
    this.admin.authorityId = this.authority.id

    this.proposedAdmin = detailsCopy.proposed
  }

  createOfficerInvite (init: OfficerInit): OfficerInviteShare {
    throw new Error('Method not implemented.')
  }

  createAuthorityInvite (name: string): AuthorityInviteShare {
    throw new Error('Method not implemented.')
  }

  async getAuthorityInvites (): Promise<Array<InviteStatus<SentAuthorityInvite>>> {
    throw new Error('Method not implemented.')
  }

  async saveInviteWithSigning (invite: AuthorityInvite | OfficerInvite, scope: Scope, signature: Signature): Promise<void> {
    throw new Error('Method not implemented.')
  }

  async getAdminDetails (): Promise<AdminDetails> {
    // Return the instance-specific administration details
    return {
      admin: this.admin,
      proposed: this.proposedAdmin
    }
  }

  async getDetails (): Promise<AuthorityDetails> {
    return {
      authority: this.authority,
      proposed: this.proposedAuthority // This remains settable by proposeAuthority if implemented
    }
  }

  async proposeAdmin (adminProposal: Proposal<AdminInit>, _signature: Signature): Promise<void> {
    // Update the instance's proposed administration directly
    this.proposedAdmin = JSON.parse(JSON.stringify(adminProposal))
    console.log(
			`MockAuthorityEngine: Admin proposed for ${this.authority.name}.`
    )
  }

  // ---- builder factories (BUILD-AUTH-01 / FACT-04) ----

  buildCreateOfficerInvite (): IAuthorityCreateOfficerInviteBuilder {
    return new AuthorityCreateOfficerInviteBuilder(this)
  }

  buildCreateAuthorityInvite (): IAuthorityCreateAuthorityInviteBuilder {
    return new AuthorityCreateAuthorityInviteBuilder(this)
  }

  buildProposeAdmin (): IAuthorityProposeAdminBuilder {
    return new AuthorityProposeAdminBuilder(this)
  }

  buildSaveInviteWithSigning (): IAuthoritySaveInviteWithSigningBuilder {
    return new AuthoritySaveInviteWithSigningBuilder(this)
  }
}
