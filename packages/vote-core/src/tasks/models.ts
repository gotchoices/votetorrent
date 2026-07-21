import type { AdminInit, AuthorityInit, Authority } from '../authority'
import type { Proposal, Signature } from '../common'
import type { ElectionDetails, ElectionInit, Ballot } from '../election'
import type { NetworkReference, NetworkInit } from '../network'

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
}
