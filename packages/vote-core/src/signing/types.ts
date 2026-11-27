import type { Scope } from '../authority'
import type { Signature } from '../common'
import type { SigningResult, SignOutcome, SigningStatus } from './models'
import type { IBuilder } from '../common/builder.js'

/** Options threaded through sign()/signWithOutcome()/signDerived(). */
export interface SignOptions {
  ownsTransaction?: boolean
  isPlaceholderSignature?: boolean
}

/**
 * D-07c: AdminDigestArgs — fields in alphabetical order per D-07d.
 *
 * 57-01 (D-02): `officers` carries the deterministically sorted, JSON-
 * serialized admin roster (see `authority-engine.ts`'s `sortRosterEntries`)
 * so the 'rad' digest attests to the FULL roster a proposal revises, not
 * only `thresholdPolicies`. Producer (`AuthorityEngine.proposeAdmin`) and
 * verifier (`SigningEngine.startSigningSession` PATH A) must serialize and
 * bind this identically.
 *
 * 57-13 (CR-01): each serialized roster entry now also carries a per-officer
 * `userId` (`null` for `.init` officers), so the signed digest attests to
 * WHO receives each scope, not only to the scope set and display name. This
 * interface's own fields are unchanged — `officers` is still a plain JSON
 * string — only the shape of the JSON it carries has widened.
 */
export interface AdminDigestArgs {
  authorityId: string
  effectiveAt: string
  officers: string
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
  /** 39-05 (D-01 Rule-1 fix): options threaded to match SigningEngine's committed implementation
   *  (signed-mutation.ts / signature-tasks-engine.ts already call the 3-arg form; the interface
   *  had drifted out of sync since 42-03/999.1's ownsTransaction + isPlaceholderSignature additions). */
  sign(nonce: string, signature: Signature, options?: SignOptions): Promise<boolean> // true if the threshold has been reached and an AdminSignature has been created
  /** D-10: like sign(), but also reports crossedNow — true only on the ONE call that inserted the AdminSignature row for this nonce. */
  signWithOutcome(nonce: string, signature: Signature, options?: SignOptions): Promise<SignOutcome>
  /** Finding 4.1: signs a derived session (e.g. a finalize-time Question/Option row) whose AdminSignature is only writable once its header nonce has already reached AdminSignature for the same scope and authority. */
  signDerived(nonce: string, signature: Signature, headerNonce: string, options?: SignOptions): Promise<SignOutcome>
  /** D-11: a read-only, no-veto derivation of a signing session's reached/unreachable state. Returns null for an unknown nonce. */
  getSigningStatus(nonce: string): Promise<SigningStatus | null>
  /** 62-13 (D-08): `options` is optional and trailing. Only `options.ownsTransaction` is
   *  honoured — it is forwarded to the session's own internal signWithOutcome call, so a caller
   *  (AuthorityEngine.proposeAdmin, above a rad threshold of 1) can compose the session into a
   *  larger transaction alongside fanOutSignatureTasks. The default (`ownsTransaction` unset or
   *  true) is a self-owned transaction — byte-identical to every pre-62-13 caller. */
  startSigningSession(
    authorityId: string,
    digestArgs: AdminDigestArgs | null,
    scope: Scope,
    signature: Signature,
    nonce?: string,
    options?: SignOptions
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
