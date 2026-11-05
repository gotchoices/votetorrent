import {
  MOCK_SHARED_ADMINISTRATION_DETAILS
} from '../mock-data.js'
import { ADMIN_CHANGE_ERROR_CODES, AdminPromotionError } from '@votetorrent/vote-core'
import type {
  Admin,
  AdminDetails,
  AdminInit,
  AdminPromotionResult,
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
  PendingAdminChange,
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
import { nowCanonicalDatetime, toCanonicalDatetime } from '../utils.js'

// Local mock data definitions (MOCK_ADMINISTRATORS, MOCK_THRESHOLD_POLICIES, etc.) are removed.

export class MockAuthorityEngine implements IAuthorityEngine {
  private admin: Admin
  private proposedAdmin?: Proposal<AdminInit> // Can be undefined if not SLCO or no proposal made
  private readonly proposedAuthority?: Proposal<AuthorityInit> // Unused by current mock methods but part of interface/state
  // 66.1 (C2/C3 mirror): the change still waiting for its effective time, the effective times that
  // were cancelled, and a record of every accepted cancel (for specs and preview mode).
  private pendingChange?: PendingAdminChange
  private readonly cancelledEffectiveAts = new Set<string>()
  public readonly cancelCalls: Array<{ effectiveAt: string; userId: string }> = []
  // private isSlcoAuthority: boolean = false; // No longer needed

  // Authorities whose mock keeps a proposed administration. All other seeded
  // authorities return adminDetails.proposed === undefined so the "Revise
  // Administration" button gate (!adminDetails?.proposed) on AuthorityDetails
  // evaluates true. Closes Phase 8 UAT gap 14 (gap-closure plan 08-07 Task 4).
  // Names MUST match packages/vote-engine/src/mock-data.ts MOCK_AUTHORITIES[*].name
  // verbatim (case-sensitive).
  private static readonly AUTHORITIES_WITH_PROPOSAL = new Set<string>([
    'Salt Lake County',
    'State of Utah'
  ])

  constructor (private readonly authority: Authority) {
    // Always initialize using the shared administration template
    const detailsCopy = JSON.parse(
      JSON.stringify(MOCK_SHARED_ADMINISTRATION_DETAILS)
    )

    this.admin = detailsCopy.admin
    // **Important**: Set the correct authorityId for this specific instance
    this.admin.authorityId = this.authority.id

    this.proposedAdmin = MockAuthorityEngine.AUTHORITIES_WITH_PROPOSAL.has(
      this.authority.name
    )
      ? detailsCopy.proposed
      : undefined
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

  // SURF-03 (D-05): compile-time parity counterparts. Trivial — the mock does
  // not back a real Quereus store, so cancel logs + resolves and resend returns
  // a stub Cid. The real behavior lives in AuthorityEngine (vote-engine).
  async cancelInvite (slotCid: string): Promise<void> {
    console.log(`MockAuthorityEngine: cancelInvite(${slotCid}) for ${this.authority.name}.`)
  }

  async getPendingInviteCids (): Promise<string[]> {
    return []
  }

  async resendInvite (slotCid: string): Promise<string> {
    console.log(`MockAuthorityEngine: resendInvite(${slotCid}) for ${this.authority.name}.`)
    return `mock-resent-${slotCid}`
  }

  async getAdminDetails (): Promise<AdminDetails> {
    // Return the instance-specific administration details
    return {
      admin: this.admin,
      proposed: this.proposedAdmin,
      pending: this.livePendingChange()
    }
  }

  // A pending change is live while its effective time is still ahead and it was not cancelled.
  // Both sides are canonical 19-char UTC strings, so text comparison orders them by time.
  private livePendingChange (): PendingAdminChange | undefined {
    const pending = this.pendingChange
    if (pending === undefined) return undefined
    if (this.cancelledEffectiveAts.has(pending.effectiveAt)) return undefined
    if (pending.effectiveAt <= nowCanonicalDatetime()) return undefined
    return pending
  }

  // 66.1 (D-05 contract shape): the mock never calls `sign`, as the mock proposeAdmin ignores its callback.
  async cancelAdminChange (target: { effectiveAt: string; userId: string }, _sign: (digest: Uint8Array) => Promise<Signature>): Promise<void> {
    if (this.cancelledEffectiveAts.has(target.effectiveAt)) return
    const pending = this.livePendingChange()
    if (pending === undefined || pending.effectiveAt !== target.effectiveAt) {
      throw Object.assign(new Error('No pending administration change to cancel'), { code: ADMIN_CHANGE_ERROR_CODES.cancelNotPending })
    }
    this.cancelCalls.push({ effectiveAt: target.effectiveAt, userId: target.userId })
    this.cancelledEffectiveAts.add(target.effectiveAt)
    this.pendingChange = undefined
    if (this.proposedAdmin !== undefined && toCanonicalDatetime(this.proposedAdmin.proposed.effectiveAt) === target.effectiveAt) {
      this.proposedAdmin = undefined
    }
  }

  async getDetails (): Promise<AuthorityDetails> {
    return {
      authority: this.authority,
      proposed: this.proposedAuthority // This remains settable by proposeAuthority if implemented
    }
  }

  async proposeAdmin (adminProposal: Proposal<AdminInit>, _signatureOrCallback: Signature | ((digest: Uint8Array) => Promise<Signature>)): Promise<void> {
    // 66.1 (D-08 mirror): one pending change at a time.
    if (this.livePendingChange() !== undefined) {
      throw Object.assign(new Error('Another administration change is still pending'), { code: ADMIN_CHANGE_ERROR_CODES.pending })
    }
    // Update the instance's proposed administration directly
    this.proposedAdmin = JSON.parse(JSON.stringify(adminProposal))
    console.log(
			`MockAuthorityEngine: Admin proposed for ${this.authority.name}.`
    )
    const effectiveAt = toCanonicalDatetime(adminProposal.proposed.effectiveAt)
    if (effectiveAt > nowCanonicalDatetime()) {
      this.pendingChange = {
        effectiveAt,
        officers: JSON.parse(JSON.stringify(adminProposal.proposed.officers)),
        thresholdPolicies: JSON.parse(JSON.stringify(adminProposal.proposed.thresholdPolicies)),
        promoted: false
      }
    }
  }

  // 57-07 (D-01 promotion half): the mock exists to satisfy the interface
  // and preview mode, not to simulate the schema — promote the in-memory
  // proposedAdmin into the mock's current administration and clear it.
  async applyAdminProposal (
    _nonce: string,
    _sign: (digest: Uint8Array) => Promise<Signature>
  ): Promise<AdminPromotionResult> {
    if (!this.proposedAdmin) {
      throw new AdminPromotionError('roster-mismatch', _nonce)
    }
    const proposed = this.proposedAdmin
    this.admin = {
      ...this.admin,
      effectiveAt: typeof proposed.proposed.effectiveAt === 'string'
        ? Date.parse(proposed.proposed.effectiveAt)
        : proposed.proposed.effectiveAt,
      thresholdPolicies: proposed.proposed.thresholdPolicies,
      officers: proposed.proposed.officers.map((selection) => ({
        userId: selection.existing?.userId ?? 'mock-new-officer',
        authorityId: this.authority.id,
        title: selection.init?.title ?? selection.existing?.title ?? '',
        scopes: (selection.init?.scopes ?? selection.existing?.scopes ?? []) as Scope[]
      }))
    }
    const officersPromoted = proposed.proposed.officers.length
    this.proposedAdmin = undefined
    return {
      authorityId: this.authority.id,
      effectiveAt: this.admin.effectiveAt,
      officersPromoted,
      alreadyApplied: false
    }
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
