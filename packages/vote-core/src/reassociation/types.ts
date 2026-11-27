import type { Signature } from '../common/index.js'
import type { AssociationAttestationAnswer, AssociationIdentityField, AssociationRequestStatus } from '../association/models.js'
import type { AssociationMatchMethod, DeviceRetirement, ReassociationApprovalInput, ReassociationApprovalResult, ReassociationProcessingSummary, ReassociationRejectionResult, ReassociationReview } from './models.js'

/**
 * D-01/D-19: every mutating `IReassociationEngine` method's signing parameter is a `Signature` OR
 * a callback that receives the canonical digest bytes and returns one — NEVER a raw private key.
 * Mirrors `IAssociationEngine`'s identically-shaped (unexported) `SignatureOrCallback`.
 */
export type ReassociationSignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

/** One staged re-association request, as the authority's intake sees it — EXACTLY one of
 * `registrationCode` / `identityFields` is set on a re-association; neither is set on a first
 * association. Structurally satisfied by 62-15's `P2pStagedAssociationRequest`. */
export interface ReassociationStagedRequest {
  readonly requestId: string
  readonly registrationCode?: string
  readonly identityFields?: readonly AssociationIdentityField[]
}

/** One staged attestation answer, as the authority's intake sees it. Structurally satisfied by
 * 62-15's `P2pStagedAttestation`. */
export interface ReassociationStagedAttestation {
  readonly requestId: string
  readonly answer: AssociationAttestationAnswer
  readonly requesterKey: string
  readonly signature: Signature
}

/** The decision the authority publishes for one re-association request's transition. */
export interface ReassociationDecisionInput {
  readonly requestId: string
  readonly status: AssociationRequestStatus
  readonly challengeNonce?: string
  readonly reason?: string
  readonly decidedAt: string
  /** D-41 — 'a' decisions only: the retired device key. */
  readonly revokesDeviceKey?: string
  /** D-45 — 'a' decisions only: how the registrant was matched. */
  readonly matchMethod?: AssociationMatchMethod
}

/**
 * The authority-side intake port `IReassociationEngine`'s driver methods read staged requests and
 * attestations from, and publish decisions to. Structurally satisfied by 62-15's
 * `P2pAssociationTransport` — this interface is never implemented directly by this module, only
 * matched structurally by an injected transport.
 */
export interface ReassociationIntake {
  readStagedRequests (sinceCursor?: string): Promise<readonly ReassociationStagedRequest[]>
  readStagedAttestations (sinceCursor?: string): Promise<readonly ReassociationStagedAttestation[]>
  publishDecision (decision: ReassociationDecisionInput): Promise<string>
}

/**
 * Opens a sealed staging envelope — the registration code or identity fields, and the approved
 * registration payload this module reads to resolve/rank candidates, all travel sealed and are
 * opened only through this port. NEVER throws (62-14/62-15's documented discipline): every
 * failure, including "not a recipient" and a corrupt vault secret, comes back as `ok: false` with
 * a reason code — never a thrown error, and never the plaintext itself on failure. Structurally
 * satisfied by 62-14's `IntakeOpener` and 62-15's `StagingOpener`.
 */
export interface ReassociationOpener {
  open (sealed: string, binding: { readonly requestId: string; readonly digest: string }):
    Promise<{ readonly ok: true; readonly plaintext: string } | { readonly ok: false; readonly reason: string; readonly detail: string }>
}

/** One published decision record, as the old device's `getDeviceRetirement` read sees it. */
export interface ReassociationDecisionRecord {
  readonly requestId: string
  readonly status: AssociationRequestStatus
  readonly revokesDeviceKey?: string
  readonly decidedAt: string
}

/** Structurally satisfied by `P2pAssociationTransport.readDecisionRecords`. */
export interface ReassociationDecisionSource {
  readDecisionRecords (sinceCursor?: string): Promise<readonly ReassociationDecisionRecord[]>
}

/**
 * D-40/D-41/D-45/D-46 — the re-association API. A SEPARATE vote-core interface from
 * `IAssociationEngine` (not a widening of it): app code types against `IAssociationEngine` with
 * partial mocks today, so adding methods there would force every existing mock to grow stub
 * bodies. `AssociationEngine` (vote-engine) implements BOTH interfaces on the same class; RN apps
 * already reach it through `rn-entry.ts`'s existing export.
 */
export interface IReassociationEngine {
  /**
   * Voter, registering device, at ORIGINAL registration time (not re-association time). `sign` is
   * the identity-key callback — the ONLY key input (D-01): this function signature accepts no key
   * material. Signs the same digest TWICE internally and rejects a non-deterministic signer, so
   * the returned code is reproducible from the identity key alone on any later call.
   */
  deriveRegistrationCode (registrantId: string, sign: (digest: Uint8Array) => Promise<Signature>): Promise<string>

  /** The `RequesterKey` of the approved registration for `registrantId` — the only key whose
   * derived code would match — or `undefined` when none is resolvable. */
  getRegistrationCodeHolderKey (registrantId: string): Promise<string | undefined>

  /** Authority sync driver (R0 synthetic-rejection completion, R1 resolution + D-46 routing, R2
   * compound completion) — the automatic authority-side counterpart of
   * `IAssociationEngine.processPendingAssociationRequests`, scoped to sentinel-registrant rows. */
  processPendingReassociations (
    authorityId: string,
    signatureOrCallback: ReassociationSignatureOrCallback,
    intake: ReassociationIntake,
    opener: ReassociationOpener
  ): Promise<ReassociationProcessingSummary>

  /** Every `'p'` sentinel-registrant row awaiting an officer, newest `submittedAt` first. */
  listPendingReassociations (
    authorityId: string,
    intake: ReassociationIntake,
    opener: ReassociationOpener
  ): Promise<ReassociationReview[]>

  getReassociationReview (
    requestId: string,
    intake: ReassociationIntake,
    opener: ReassociationOpener,
    options?: { readonly registrantId?: string }
  ): Promise<ReassociationReview | undefined>

  /** Officer approval — signs the `'p' -> 'c'` challenge binding the chosen registrant; the
   * actual device retirement completes in R2, after the new device's attestation verifies. */
  approveReassociation (
    requestId: string,
    input: ReassociationApprovalInput,
    signatureOrCallback: ReassociationSignatureOrCallback,
    intake: ReassociationIntake,
    opener: ReassociationOpener
  ): Promise<ReassociationApprovalResult>

  /** Officer rejection — a synthetic `'p' -> 'c' -> 'r'`, publishing `'r'` with
   * `REASSOCIATION_NOT_APPROVED_REASON`. */
  rejectReassociation (
    requestId: string,
    signatureOrCallback: ReassociationSignatureOrCallback,
    intake: ReassociationIntake
  ): Promise<ReassociationRejectionResult>

  /** The old device's own read: retired iff an `'a'` decision names `deviceKey` in
   * `RevokesDeviceKey` AND no `Association` row still carries that key. */
  getDeviceRetirement (deviceKey: string, source?: ReassociationDecisionSource): Promise<DeviceRetirement | undefined>
}
