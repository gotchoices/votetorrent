import type { Signature } from '../common/index.js'
import type { IBuilder } from '../common/builder.js'
import type {
  AssociateInit,
  Association,
  AssociationAttestationAnswer,
  AssociationRequestInit,
  AssociationRequestRead,
  AssociationRequestStatus,
  AttestationChallenge,
  AttestationVerdict,
  DeviceAttestation
} from './models.js'

/**
 * D-01/D-19: every mutating method's signing parameter is a `Signature` OR a
 * callback that receives the canonical digest bytes and returns one — NEVER
 * a raw private key. The engine never holds the key (D-01).
 */
type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

export interface IAssociationEngine {
  /**
   * D-03: authority issues a one-time nonce-bound challenge before Associate.
   *
   * `electionId` (D-14a) is an OPTIONAL, trailing parameter binding this
   * challenge to a specific election — welded into the schema's
   * `InsertValid` `Digest(...)` (and the engine's matching `digestExpr`) so a
   * challenge issued for one election cannot satisfy another's attestation
   * policy (T-45-03). Omitted / `undefined` binds a null `ElectionId`, which
   * `associate()`'s fail-closed policy gate (Assumption A5) always treats as
   * attestation-required.
   *
   * D-10 (51-05): no `expiration` parameter — `AttestationChallenge` carries
   * no `Expiration` column. Single-use is enforced by D-11 consumption in
   * `associate()`, not by a TTL.
   */
  issueAttestationChallenge(
    registrantId: string,
    deviceKey: string,
    signatureOrCallback: SignatureOrCallback,
    electionId?: string
  ): Promise<AttestationChallenge>

  /** D-03: authority deletes a consumed/expired challenge. */
  removeAttestationChallenge(nonce: string, signatureOrCallback: SignatureOrCallback): Promise<void>

  /** D-02: Associate is a builder — multi-field draft + signing + serialization. */
  buildAssociate(): IAssociationAssociateBuilder

  /**
   * Direct associate — the Associate builder's commit() delegates 1:1 to this
   * method. D-03 flow: authority verifies the device attestation off-chain
   * (via IAttestationVerifier), stores the sensitive half in AssociationPrivate,
   * and signs the public Association (committing to the attestation via AttestationCid).
   */
  associate(init: AssociateInit, signatureOrCallback: SignatureOrCallback): Promise<void>

  /** Public Association row read. */
  getAssociation(registrantId: string, deviceKey: string): Promise<Association | undefined>

  /**
   * Array variant of {@link getAssociation} — every public `Association` row
   * bound to `registrantId`. Carries the IDENTICAL Phase-42 D-04
   * information-disclosure boundary as the point read: at most `DeviceHash`,
   * never `AssociationPrivate.DeviceId`.
   */
  getAssociations(registrantId: string): Promise<Association[]>

  /**
   * D-23a: reverse lookup — every public `Association` row bound to a
   * DEVICE, rather than to a registrant. `deviceKey` is the **P-256 device
   * key** the `Association` row is keyed on (`provisionDeviceKey()`'s
   * result) — NOT the secp256k1 `deviceUserKey` that signs the registration
   * request. The registration ceremony uses two distinct keys and
   * conflating them is a live trap: a lookup with the wrong one silently
   * reads "not registered" forever.
   *
   * `DeviceKey` is the TRAILING column of `Association`'s `(RegistrantId,
   * DeviceKey)` primary key, so this is a SCAN, not a point lookup —
   * accepted at voter-local row counts as a documented tradeoff rather than
   * an added index (D-23a explicitly forbids adding one).
   *
   * Results are ordered `registrantId` ascending. Carries the IDENTICAL
   * Phase-42 D-04 information-disclosure boundary as {@link getAssociation}:
   * at most `DeviceHash`, never `AssociationPrivate.DeviceId`.
   */
  getAssociationsByDeviceKey(deviceKey: string): Promise<Association[]>

  /**
   * D-11 inspect half (paired with the existing `removeAttestationChallenge`
   * expire half): every outstanding `AttestationChallenge`. `registrantId` is
   * an OPTIONAL narrowing predicate — omitted returns all outstanding
   * challenges.
   */
  getAttestationChallenges(registrantId?: string): Promise<AttestationChallenge[]>

  /** 'vrg'-signed delete. */
  removeAssociation(registrantId: string, deviceKey: string, signatureOrCallback: SignatureOrCallback): Promise<void>

  /**
   * D-03: append-only, UNSIGNED write (D-02 — no `seedSignedMutation`,
   * following the `InviteCancellation` precedent, not `UserEvent`). Called
   * by `associate()` unconditionally on both the pass and the fail path —
   * it records a judgement, it does not make one.
   */
  recordAttestationVerdict(registrantId: string, deviceKey: string, verification: AttestationVerification): Promise<void>

  /**
   * `deviceKey` is an OPTIONAL narrowing predicate — omitted returns every
   * verdict for the registrant across all its device keys. Results are
   * ordered `DeviceKey` asc then `Sequence` asc, so the LAST element of a
   * narrowed result is the most recent verdict. An EMPTY result for a
   * device that has an `Association` row means no verifier ever ran for it
   * (the `AttestationRequired=0` path) — `Association.attestationCid` is
   * non-null on both the attested and the non-attested path (Phase 45
   * D-14a..D-14e), so its presence proves nothing.
   */
  getAttestationVerdicts(registrantId: string, deviceKey?: string): Promise<AttestationVerdict[]>

  /**
   * D-02/D-18: submit a self-signed association request. Returns the
   * assigned request id. Parameter list matches
   * `IRegistrationEngine.submitRegistrationRequest` exactly, so a transport
   * binding can delegate 1:1 with no shape translation. Carries no
   * `userId`/`userKey`/`IsUserValid` parameter — the row's own
   * requester-key self-signature is the only authorization gate; this INSERT
   * runs no `seedSignedMutation`/`AdminSigning` ceremony.
   *
   * Timestamp contract mirrors 48-02 L-3: the engine takes `SubmittedAt`
   * from `init.submittedAt` verbatim and generates none of its own.
   */
  submitAssociationRequest(init: AssociationRequestInit, requesterKey: string, signatureOrCallback: SignatureOrCallback): Promise<string>

  /**
   * D-18: the second, distinct voter-to-authority message — answering the
   * challenge the authority issued for `answer.requestId`. NOT a widened
   * `submitAssociationRequest` call; the self-signed ask and the self-signed
   * attestation-answer assert structurally different things with different
   * validity rules.
   */
  submitAssociationAttestation(answer: AssociationAttestationAnswer, requesterKey: string, signatureOrCallback: SignatureOrCallback): Promise<void>

  /**
   * D-06 read-only status-screen list. `status` is an OPTIONAL narrowing
   * predicate — omitted returns every request for the authority.
   */
  listAssociationRequests(authorityId: string, status?: AssociationRequestStatus): Promise<AssociationRequestRead[]>

  /** Returns `undefined` for an unknown id, never throws. */
  getAssociationRequest(requestId: string): Promise<AssociationRequestRead | undefined>

  /**
   * D-05/D-19: the automatic authority-side driver — picks up pending
   * requests, issues challenges, and processes challenge-answered requests
   * through the unchanged `associate()` (verify + sign + write). Runs under
   * a `'vrg'`-scoped ceremony (an officer key must be present to sign;
   * D-05 is "automatic, not officer-approved", not "unattended"). NO
   * approve/reject-decision method exists on this interface — D-05 states
   * processing is authority-VERIFIED, not officer-APPROVED, so there is no
   * per-request decision to model (mirrors `IRegistrationEngine`'s own D-06
   * "deliberately no approve method" rationale).
   */
  processPendingAssociationRequests(authorityId: string, signatureOrCallback: SignatureOrCallback): Promise<{ challengesIssued: number; associated: number; rejected: number }>
}

export interface IAssociationAssociateBuilder extends IBuilder<AssociateInit, void> {
  fromPayload(payload: AssociateInit): this
}

/** Result of an {@link IAttestationVerifier} check. */
export interface AttestationVerification {
  ok: boolean
  reason?: string
}

/**
 * D-07: attestation platform verification seam — no codebase analog. Real
 * iOS App Attest / Android Play Integrity verification (cert-chain-to-root,
 * statement validity, nonce freshness) is deferred; this minimal interface
 * exists so a real verifier can be injected into AssociationEngine later
 * without changing the engine's shape. SEAM-ONLY this phase — no default
 * auto-pass implementation ships here.
 */
export interface IAttestationVerifier {
  verify(challenge: AttestationChallenge, attestation: DeviceAttestation): Promise<AttestationVerification>
}
