import type { ImageRef } from '../common'
import type { Proposal, Timestamp, ThresholdPolicy } from '../common/index.js'
import type { Invite } from '../invite/models'

/** ********* Authority ***********/
export interface Authority {
  /** Sovereign ID of the authority */
  id: string

  /** Official, legal name */
  name: string

  /** Registered domain name of the authority */
  domainName: string

  /** Image reference for the authority */
  imageRef?: ImageRef
}

export interface AuthorityInit {
  /** Name of the authority */
  name: string

  /** Domain name of the authority */
  domainName: string

  /** Image url for the authority */
  imageUrl?: string
}

export interface AuthorityDetails {
  /** The authority */
  authority: Authority

  /** The proposed changes to the authority */
  proposed?: Proposal<AuthorityInit>
}

export type AuthorityInvite = Invite & {
  /** Suggested name for the new Authority */
  name: string

  /** The type of the invite */
  type: 'au'
}

export interface SentAuthorityInvite {
  name: string
  type: 'au'
}

/** ********* Administration ***********/
export interface Admin {
  /** ID of the administration */
  id: string

  /** The authority's id */
  authorityId: string

  /** The effective date of the administration */
  effectiveAt: Timestamp

  /** The officers */
  officers: Officer[]

  /** The threshold policies */
  thresholdPolicies: ThresholdPolicy[]
}

export interface AdminInit {
  /** The officers */
  officers: OfficerSelection[]

  /**
   * The effective date of the administration.
   *
   * WR-06 (12.4-REVIEW): widened from `Timestamp` (number) to
   * `Timestamp | string` so callers may pass a canonical-datetime ISO
   * string (e.g. the value returned by `nowCanonicalDatetime()` and
   * propagated through `seedAuthorityInvite`'s `adminEffectiveAt` field).
   * The engine normalizes both forms through `toCanonicalDatetime`. This
   * removes the need for the `as never` casts that previously bypassed
   * type-checking at the test boundary.
   */
  effectiveAt: Timestamp | string

  /** Threshold policies */
  thresholdPolicies: ThresholdPolicy[]
}

export interface AdminDetails {
  /** The administration */
  admin: Admin

  /** The proposed changes to the administration */
  proposed?: Proposal<AdminInit>
}

/** ********* Officer ***********/
export interface Officer {
  /** ID of the officer's user */
  userId: string

  /** The authority's id */
  authorityId: string

  /** Title of the officer */
  title: string

  /** Scopes of the officer */
  scopes: Scope[]
}

export interface OfficerInit {
  /** Suggested name of the officer (informational for targeting the right person) */
  name: string

  /** Title of the officer */
  title: string

  /** Scopes of the officer */
  scopes: Scope[]

  // WR-05 (12.4-REVIEW) / v1.2 follow-up: this type does NOT yet carry a
  // per-officer `userId` field. `NetworkEngine.createAuthority` therefore
  // binds `ctx.user.id` for every officer row, which works for the single-
  // officer happy path but cannot represent a true multi-officer invite
  // where each officer has a distinct userId. When this gap is closed (add
  // `userId?: string` here, thread through OfficerSelection / Admin invite
  // flows, and have createAuthority verify the caller-supplied first-officer
  // userId matches the one bound into InviteResult.Digest by respondToInvite),
  // remove the `callerUserId` fallback and the WR-05 guard in
  // `network-engine.ts:createAuthority`.
}

export interface OfficerSelection {
  /** If it's a new officer */
  init?: OfficerInit

  /** If it's an existing officer */
  existing?: Officer
}

export type OfficerInvite = Invite &
OfficerInit & {
  /** The type of the invite */
  type: 'of'
}

export type SentOfficerInvite = OfficerInit & {
  type: 'of'
}

/** Scope codes representing different officer privileges */
export type Scope =
 | 'rn'
 | 'rad'
 | 'vrg'
 | 'iad'
 | 'rnp'
 | 'uai'
 | 'ceb'
 | 'mel'
 | 'cap'

export const scopeDescriptions: Record<string, string> = {
  rn: 'Revise Network',
  rad: 'Revise or replace the Administration',
  vrg: 'Validate registrations',
  iad: 'Invite other Authorities',
  uai: 'Update Authority Information',
  ceb: 'Create/Edit ballot templates',
  mel: 'Manage Elections',
  cap: 'Configure Authority Peers'
}
