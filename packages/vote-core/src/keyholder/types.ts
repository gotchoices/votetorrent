// src/keyholder/types.ts — the DKG engine contract (62-17: D-13, D-15, D-19).
//
// `IKeyholderDkgEngine` is the API 62-20, 62-24 and 62-26 consume verbatim.
// Implemented by `KeyholderDkgEngine` in vote-engine's `src/keyholder/keyholder-dkg-engine.ts`.

import type {
  DkgAdvanceResult,
  DkgTranscriptVerdict,
  ElectionBlockDecryptResult,
  ElectionBlockInput,
  ElectionKeyRecord,
  KeyReleaseStatus,
  KeyShareReleaseOutcome,
  KeyShareReleaseRecord,
  KeyholderDkgSigner,
  KeyholderDkgStatus,
  ReconstructedElectionKey,
  SeedReleaseKeyTasksResult
} from './models.js'

export interface IKeyholderDkgEngine {
  /** Read-only status for `electionId`'s CURRENT revision. Never writes. */
  getDkgStatus(electionId: string, selfUserId?: string): Promise<KeyholderDkgStatus>
  /**
   * Drive the DKG forward by at most a few rounds of signed strand rows for
   * `signer`'s own participation. Never throws for a self who is not a live
   * keyholder — returns `{ actions: [] }` instead.
   */
  advanceDkg(electionId: string, signer: KeyholderDkgSigner): Promise<DkgAdvanceResult>
  /** The published `ElectionKey` for `electionId`'s `revision` (default: current), or null. */
  getElectionKey(electionId: string, revision?: number): Promise<ElectionKeyRecord | null>
  /** Re-verify every replicated row's signature and payload and re-run the evaluator. */
  verifyDkgTranscript(electionId: string, revision?: number): Promise<DkgTranscriptVerdict>
}

// ---------------------------------------------------------------------------
// Key release and public reconstruction (62-20: D-13, D-14, D-17, D-18, D-20)
// ---------------------------------------------------------------------------
//
// `IKeyReleaseEngine` is the API 62-24 (two-node share-release legs) and
// 62-29 (KeyReleaseScreen, Voter `releasedCount`, web-data reads) consume
// verbatim. Implemented by `KeyReleaseEngine` in vote-engine's
// `src/key-release/key-release-engine.ts`.
export interface IKeyReleaseEngine {
  /**
   * D-20: seed one `release-key` Task per local keyholder whose election's
   * timeline has ENTERED `releasingKeys` — own device only (vault
   * `hasSecret`, never prompts), idempotent by a deterministic Task Id.
   * Never creates a task at invite-accept time.
   */
  seedReleaseKeyTasks(): Promise<SeedReleaseKeyTasksResult>
  /** Every userId this device's vault holds a DKG share for, across elections, sorted and de-duplicated. `[]` with no vault. */
  getLocalKeyholderUserIds(): Promise<string[]>
  /**
   * D-17: unlock `signer.userId`'s share from its own vault and publish it
   * publicly as one signed `KeyholderShareRelease` row, checked against the
   * published group commitments before it is signed. Refuses before the
   * release window opens and before any vault read on every refusal path.
   */
  releaseKeyShare(electionId: string, signer: KeyholderDkgSigner, revision?: number): Promise<KeyShareReleaseOutcome>
  /** Read-only release/reconstruction status. Available to anyone — no user, no vault required. */
  getKeyReleaseStatus(electionId: string, selfUserId?: string, revision?: number): Promise<KeyReleaseStatus>
  /** ACCEPTED releases only. */
  getReleasedShares(electionId: string, revision?: number): Promise<KeyShareReleaseRecord[]>
  /** D-14, D-17: anyone with k accepted shares reconstructs the election secret key — no vault, no signer, no logged-in user required. */
  reconstructElectionKey(electionId: string, revision?: number): Promise<ReconstructedElectionKey>
  /** D-18: reconstruct once, then decrypt each block (votes AND voter records); per-block results, in input order. */
  decryptElectionBlocks(electionId: string, blocks: readonly ElectionBlockInput[], revision?: number): Promise<ElectionBlockDecryptResult[]>
}
