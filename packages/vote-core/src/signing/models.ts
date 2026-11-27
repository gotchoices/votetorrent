import type { Scope } from '../authority/index.js'

export interface SigningResult {
  nonce: string
  thresholdReached: boolean
  /** D-10: true only on the ONE call that inserted the AdminSignature row for this nonce.
   *  Every later signature on an already-reached nonce still records its OfficerSignature
   *  and returns thresholdReached=true, crossedNow=false. */
  crossedNow: boolean
}

/** D-10: the outcome of a single SigningEngine.signWithOutcome()/signDerived() call. */
export interface SignOutcome {
  thresholdReached: boolean
  crossedNow: boolean
}

/**
 * D-11: a read-only derivation of a signing session's state from Task, OfficerSignature and
 * AdminSignature rows. No veto — a rejection (a completed Task with no OfficerSignature) only
 * makes the session `unreachable`, never resolves it to a terminal "rejected" state.
 */
export interface SigningStatus {
  nonce: string
  scope: Scope
  threshold: number
  /** Qualifying signatures — same counting rule as SigningEngine (holder-filtered when threshold > 1). */
  signatures: number
  /** Distinct users with an open Task for the nonce who have not signed (holder-filtered when threshold > 1). */
  openTasks: number
  /** Distinct users whose Task for the nonce is completed with no OfficerSignature for (nonce, UserId). */
  rejected: number
  /** An AdminSignature row exists for the nonce. */
  reached: boolean
  /** !reached && signatures + openTasks < threshold. */
  unreachable: boolean
}
