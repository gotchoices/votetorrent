import type { Association, AssociationIdentityField, AssociationRequestStatus } from '../association/models.js'

/**
 * 62-18 (D-40, D-41, D-45, D-46) — a voter who has a new device re-joins their existing
 * registration without ever moving a key. The new device cannot know its own `registrantId`
 * (research Pitfall 5, 59 D-23: the voter never stores or shows its registrantId) — so a
 * re-association request always names this SENTINEL value as `AssociationRequestInit.registrantId`,
 * and carries a registration code or identity fields inside the sealed staging plaintext instead.
 * The real registrant is resolved by the authority (by code, or by officer identity match) and
 * bound into the AUTHORITY-SIGNED `AttestationChallenge` the normal D-18 challenge/answer protocol
 * already issues — so no private key, and no registrantId guess, ever has to leave either device.
 * `deriveRegistrationCode` (registration-code.ts, this module) receives only a signing CALLBACK,
 * never a key (D-01).
 */
export const REASSOCIATION_UNRESOLVED_REGISTRANT_ID = 'reassociation-unresolved'

/** D-41: officer rejection reason published on a re-association request the officer declines. */
export const REASSOCIATION_NOT_APPROVED_REASON = 'reassociation-not-approved'

/**
 * D-41: the automatic association driver's conflict rejection — a request naming a registrant
 * that already has another device associated is rejected with this reason rather than silently
 * creating a second active device for the same registrant.
 */
export const REGISTRANT_HAS_ACTIVE_DEVICE_REASON = 'registrant-has-active-device'

/**
 * `AssociationRequest.TransitionValid` admits no `'p' -> 'r'` transition — only `'p' -> 'c'` and
 * `'c' -> 'a'/'r'`. A synthetic rejection therefore passes through a 'c' state first, using a
 * `ChallengeNonce` that starts with this prefix (followed by the reason code and a uuid) instead
 * of a real `AttestationChallenge` nonce, so the driver can tell a synthetic 'c' row apart from a
 * genuine one and finish it to 'r' without ever minting a challenge for it.
 */
export const REASSOCIATION_REJECTION_NONCE_PREFIX = 'reassociation-rejected:'

/** D-45: the identity-fallback candidate list is capped so an officer review screen never renders
 * an unbounded scan result. */
export const REASSOCIATION_MAX_CANDIDATES = 10

/** 62-01's `AssociationMatchMethod` view codes — how an approved re-association was matched. */
export type AssociationMatchMethod = 'code' | 'identity'

/** 62-14's `ReassociationRoute` codes — whether a request completes without an officer. */
export type ReassociationRouteKind = 'manual' | 'automatic'

export type ReassociationErrorCode =
  | 'invalid-argument'
  | 'not-found'
  | 'not-a-reassociation'
  | 'not-pending'
  | 'registrant-not-active'
  | 'registrant-authority-mismatch'
  | 'code-registrant-mismatch'
  | 'threshold-requires-co-sign'
  | 'non-deterministic-signer'

/**
 * Every refusal in this module is a `ReassociationError`, never a bare `Error`. Its `message`
 * carries only ids (requestId, registrantId, authorityId) — NEVER a registration code or an
 * identity-field value (T-62-01-10): opened plaintext lives in memory only, for the one call that
 * opened it, and never crosses into an error message, a log line, or a stored row.
 */
export class ReassociationError extends Error {
  readonly code: ReassociationErrorCode

  constructor (code: ReassociationErrorCode, message: string) {
    super(message)
    this.name = 'ReassociationError'
    this.code = code
  }
}

/**
 * D-45: what led the authority to a candidate registrant. `kind: 'code'` NEVER carries the code
 * itself — only whether it matched, so a review screen can render "code matched" without ever
 * holding the code value. `kind: 'identity'` carries the submitted identity fields for the
 * officer's own comparison, in memory only, for the lifetime of the review. `kind: 'none'` is a
 * sentinel request with neither a code nor identity fields.
 */
export type ReassociationEvidence =
  | { readonly kind: 'code'; readonly outcome: 'matched' | 'unmatched' | 'unverifiable' }
  | { readonly kind: 'identity'; readonly fields: readonly AssociationIdentityField[] }
  | { readonly kind: 'none' }

/** D-45 identity-fallback ranked candidate — one approved registrant, how many submitted fields
 * matched it, and (when derivable) a display name. */
export interface ReassociationCandidate {
  readonly registrantId: string
  readonly matchedFieldNames: readonly string[]
  readonly displayName?: string
}

/**
 * The officer review shape for one pending re-association request. `route` follows 62-14's
 * `reassociationRouteFor` rule: automatic ONLY for a policy of `'automatic'` AND a matched code
 * (D-46) — identity evidence, an unmatched code, an unverifiable code and no evidence are always
 * `'manual'`.
 */
export interface ReassociationReview {
  readonly requestId: string
  readonly authorityId: string
  readonly status: AssociationRequestStatus
  readonly newDeviceKey: string
  readonly electionId?: string
  readonly submittedAt: string
  readonly receivedAt: string
  readonly evidence: ReassociationEvidence
  /** The code-matched registrant, or (identity evidence only) the officer's chosen candidate. */
  readonly resolvedRegistrantId?: string
  /** "firstName lastName" from `resolvedRegistrantId`'s own approved registration payload. */
  readonly registrantName?: string
  /** Identity evidence + a resolved registrant only — the registrant's own identity record, for
   * the officer's side-by-side comparison. */
  readonly registrantRecord?: readonly AssociationIdentityField[]
  /** Identity evidence only — ranked, capped at `REASSOCIATION_MAX_CANDIDATES`. */
  readonly candidates: readonly ReassociationCandidate[]
  /** Devices of `resolvedRegistrantId` that an approval would retire (D-41). */
  readonly existingDevices: readonly Association[]
  /** `'code'` iff the evidence code matched `resolvedRegistrantId`; otherwise `'identity'`. */
  readonly matchMethod: AssociationMatchMethod
  readonly route: ReassociationRouteKind
}

export interface ReassociationApprovalInput {
  readonly registrantId: string
}

export interface ReassociationApprovalResult {
  readonly requestId: string
  readonly registrantId: string
  readonly matchMethod: AssociationMatchMethod
  /** D-41: the registrant's old device keys that approval will retire once the new device
   * attests — sorted, possibly empty for a true first association. */
  readonly devicesToRetire: readonly string[]
  readonly challengeNonce: string
  readonly outcome: 'awaiting-device-attestation'
}

export interface ReassociationRejectionResult {
  readonly requestId: string
  readonly reason: string
}

/** The old device's own read of whether it has been retired by a completed re-association. */
export interface DeviceRetirement {
  readonly deviceKey: string
  readonly requestId: string
  readonly decidedAt: string
}

export interface ReassociationProcessingSummary {
  readonly challengesIssued: number
  readonly associated: number
  readonly rejected: number
  readonly awaitingReview: number
  /** WR-02 — decisions written locally on an earlier run but never published, published now.
   * Present ONLY when > 0 (like `closedAsDuplicate`), so a quiet run keeps the four-field shape. */
  readonly republished?: number
  /** WR-02 — publishes that failed this run (retried on the next sync). Present ONLY when > 0. */
  readonly publishFailures?: number
}
