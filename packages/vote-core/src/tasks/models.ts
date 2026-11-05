import type { AdminInit, AuthorityInit, Authority } from '../authority'
import type { Proposal, Signature } from '../common'
import type { ElectionDetails, ElectionInit, Ballot } from '../election'
import type { NetworkReference, NetworkInit } from '../network'
import type { RegisterInit, RegistrationRequestDecision, RegistrationRequestIssuerType } from '../registration/index.js'

export interface Task {
  type: string
}

export type ReleaseKeyTask = Task & {
  type: 'release-key'
  network: NetworkReference
  election: ElectionDetails
  userId: string
}

export type SignatureTask = Task & {
  type: 'signature'
  network: NetworkReference
  userId: string
  signatureType:
  | 'admin'
  | 'authority'
  | 'ballot'
  | 'election'
  | 'election-revision'
  | 'network'
  | 'registrant'
}

export type AdminSignatureTask = SignatureTask & {
  signatureType: 'admin'
  administration: Proposal<AdminInit>
  authority: Authority
}

export type AuthoritySignatureTask = SignatureTask & {
  signatureType: 'authority'
  authority: Proposal<AuthorityInit>
}

export type NetworkSignatureTask = SignatureTask & {
  signatureType: 'network'
  network: Proposal<NetworkInit>
}

export type ElectionSignatureTask = SignatureTask & {
  signatureType: 'election'
  election: Proposal<ElectionInit>
}

export type ElectionRevisionSignatureTask = SignatureTask & {
  signatureType: 'election-revision'
  election: Proposal<ElectionInit>
}

export type BallotSignatureTask = SignatureTask & {
  signatureType: 'ballot'
  ballot: Proposal<Ballot>
}

/**
 * D-05: the officer-facing registration-approval signature task. Unlike its
 * six siblings above, its source is the non-`ProposedX` `RegistrationRequest`
 * table, not a `Proposal<T>` row, so `payload` is the request's stored
 * `RegisterInit` directly — deliberately NOT wrapped in `Proposal<…>`.
 */
export type RegistrantSignatureTask = SignatureTask & {
  signatureType: 'registrant'
  /** The `RegistrationRequest.Id` this task's extension row points at. */
  requestId: string
  /** The request's stored `RegisterInit`, parsed. */
  payload: RegisterInit
  /** ISO-Z string — the submitter-supplied `RegistrationRequestInit.submittedAt` (48-02 L-3), never engine-generated. */
  submittedAt: string
  issuerType: RegistrationRequestIssuerType
  /**
   * OPTIONAL — present only for `issuerType === 'bridge'` rows, resolved from
   * the bridge-key registry (D-03). Its absence on a bridge row means the
   * registry lookup found no label; a consumer must NOT infer
   * "registrant-submitted" from a missing label — `issuerType` is the only
   * authoritative issuer signal (D-03).
   */
  bridgeLabel?: string
}

export interface SignatureResult {
  isAccepted: boolean
  signature: Signature
  /**
   * 39-03 (DEBT-11, D-06 resolution 1): OPTIONAL reusable per-digest signing
   * callback. The header `signature` above covers only the ballot-task's own
   * header digest; when supplied, this callback lets `finalizeBallot` sign
   * EACH promoted per-row Question/Option `AdminSigning` digest for real
   * (IsPlaceholderSignature = false) instead of the legacy placeholder.
   *
   * The device-signer closure this wraps (`createDeviceSigner`,
   * apps/VoteTorrentAuthority/src/engines/device-signer.ts) is a plain
   * in-memory function closing over the already-unlocked private key — it is
   * re-invocable with no additional user decision per call, so per-row
   * real-signing does not require N fresh officer approvals. Optional so
   * existing callers (tests, the reject path, any caller that only exercises
   * the header-signature ceremony) remain byte-identical.
   */
  sign?: (digest: Uint8Array) => Promise<Signature>
  /**
   * L-1 (48-11): OPTIONAL channel carrying D-07's structured out-of-band verification checklist
   * into the accept ceremony. Required in practice on the `'registrant'` accept path — an accept
   * missing it is refused, no placeholder substituted — and ignored on every other signature type.
   * Optional so every existing caller stays byte-identical, mirroring how `sign?` above was added
   * in 39-03 for the same class of problem: a ceremony needing data the base result shape did not
   * carry.
   *
   * Approval runs through this signature-task ceremony, and ONLY through it, because
   * `IRegistrationEngine` deliberately exposes no approve/decide method (48-05 T-48-05-02) — a
   * single boolean-flagged decide method would let a caller mint a `Registrant` while bypassing
   * the ceremony this field exists to feed.
   */
  decision?: RegistrationRequestDecision
}
