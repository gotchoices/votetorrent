import type { Scope } from '../authority'
import type { Signature } from '../common'
import type { SigningResult } from './models'
import type { IBuilder } from '../common/builder.js'

/** D-07c: AdminDigestArgs — fields in alphabetical order per D-07d */
export interface AdminDigestArgs {
  authorityId: string
  effectiveAt: string
  thresholdPolicies: string
}

/** D-07a: OfficerInviteDigestArgs — fields in alphabetical order per D-07d */
export interface OfficerInviteDigestArgs {
  expiration: string
  inviteKey: string
  inviteSignature: string
  name: string
  scopes: string
  title: string
  type: string
}

/** D-07b: AuthorityInviteDigestArgs — fields in alphabetical order per D-07d */
export interface AuthorityInviteDigestArgs {
  expiration: string
  inviteKey: string
  inviteSignature: string
  name: string
  type: string
}

export interface ISigningEngine {
  /** D-18: Generate a signing nonce without creating AdminSigning. Used by invite flows that must INSERT InviteSlots before AdminSigning. */
  generateSigningNonce(): string
  sign(nonce: string, signature: Signature): Promise<boolean> // true if the threshold has been reached and an AdminSignature has been created
  startSigningSession(
    authorityId: string,
    digestArgs: AdminDigestArgs | null,
    scope: Scope,
    signature: Signature,
    nonce?: string
  ): Promise<SigningResult>
  buildSign(): ISigningSignBuilder
  buildStartSigningSession(): ISigningStartSigningSessionBuilder
}

export interface ISigningSignBuilder extends IBuilder<{ nonce: string; signature: Signature }, boolean> {
  fromPayload(payload: { nonce: string; signature: Signature }): this
}

export interface ISigningStartSigningSessionBuilder extends IBuilder<{ authorityId: string; digestArgs: AdminDigestArgs | null; scope: Scope; signature: Signature; nonce?: string }, SigningResult> {
  fromPayload(payload: { authorityId: string; digestArgs: AdminDigestArgs | null; scope: Scope; signature: Signature; nonce?: string }): this
}
