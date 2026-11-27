// src/key-release/key-release-engine.ts — KeyReleaseEngine (62-20: D-13,
// D-14, D-17, D-18, D-20). Covers the key-loop legs AFTER 62-17's DKG:
// release-task creation, signed share publication, public reconstruction
// and block decryption.
//
// ---------------------------------------------------------------------------
// D-20: pull-and-seed, own device only, idempotent
// ---------------------------------------------------------------------------
//
// `seedReleaseKeyTasks` is called at the HEAD of
// `KeysTasksEngine.getKeysToRelease`, which the Authority already calls on
// app open (`useTaskCount`) and on task-inbox focus (`TasksScreen`). There
// is no scheduler, no timer and no background job anywhere in this plan —
// detection is entirely pull-driven. A device seeds a Task only for a
// keyholder whose share IT OWN VAULT holds (`hasSecret`, which never
// prompts); the Task Id is a deterministic hash of
// `(electionId, revision, userId)`, so repeated or concurrent reads never
// create a second Task for the same triple, and a completed Task is never
// re-created. `debugSeedPendingTasks` (`elections-engine.ts`, `__DEV__`
// only) is untouched by this plan and is the ONLY other `'release-key'`
// Task producer in this package.
//
// ---------------------------------------------------------------------------
// D-17: release publishes, anyone with k shares reconstructs
// ---------------------------------------------------------------------------
//
// `releaseKeyShare` unlocks the keyholder's own 32-byte share from
// `IKeyVault` (`keyholderDkgShareAlias`) and publishes it PUBLICLY as one
// signed `KeyholderShareRelease` row, checked against the published group
// commitments (`validateReleasedShare`, 62-05) before it is ever signed.
// `reconstructElectionKey`/`decryptElectionBlocks` need NO user, NO vault
// and NO window check — public shares are public by design, and anyone with
// k valid accepted releases reconstructs through `reconstructGroupSecret`
// (62-05), which re-filters every share and asserts `s*G == Y`. This
// module's reconstruction NEVER calls `combineSecret` directly, and never
// lives in `src/keyholder/` — 62-17's D-16 grep gate requires zero
// `combineSecret`/`reconstructGroupSecret` uses there; custody code never
// reconstructs.
//
// ---------------------------------------------------------------------------
// D-14: k-of-n, pinned to the revision
// ---------------------------------------------------------------------------
//
// k is `ElectionKey.Threshold`, required to equal the CURRENT revision's
// `ElectionRevision.KeyholderThreshold` (the threshold check is skipped only
// for an explicitly-requested NON-current revision — the participant and
// commitment checks still apply there). A published key inconsistent with
// its revision or its round-4 roster is never reconstructed
// (`election-key-inconsistent`); fewer than k valid shares refuses
// `insufficient-shares`.
//
// ---------------------------------------------------------------------------
// D-18: block decryption
// ---------------------------------------------------------------------------
//
// `decryptElectionBlocks` reconstructs ONCE then calls
// `openElectionBlock` (`./election-block.js`) per block, in input order. A
// reconstruction failure maps every block to `not-reconstructable` with the
// failing `KeyReleaseError` code as `detail` — no partial reconstruction is
// attempted.
//
// ---------------------------------------------------------------------------
// Read-side trust (replicated rows are never trusted on the strength of
// having replicated)
// ---------------------------------------------------------------------------
//
// `loadSnapshot` recomputes `SignatureValid(...) or SignatureValidP256(...)`
// against the row's OWN stored key, IN SQL, for every `ElectionKey`,
// round-1 `KeyholderDkgMessage` and `KeyholderShareRelease` row it reads.
// Key MEMBERSHIP is deliberately not re-required at read (CR-02): it was
// proven once, at insert, by `SenderKeyIsUsers` / `PublisherKeyIsUsers` /
// `SignerIsUser` on NoUpdate/NoDelete rows, so a later key rotation or
// revocation cannot make the election key unrecoverable, and a revoked key
// cannot write any new row. (Rejected alternative: "any key ever
// registered" from `UserEvent` history, which is unsigned evidence.)
// 62-24 reads through this exact — 62-24 reads through this exact
// path over real replication, so an invalid-signature row is dropped
// (`key-release-evaluator.ts` rule 1), never trusted, never attributed.
//
// ---------------------------------------------------------------------------
// Security review — key release and reconstruction (D-25) — dated
// 2026-10-01, 62-20 Task 3
// ---------------------------------------------------------------------------
//
// ASVS L1: every HIGH finding is fixed (or the composing control already
// closes it) before this section was written.
//
//  1. Release only within the window: `releaseKeyShare` checks
//     `hasEnteredReleasingKeys` (step 3) BEFORE any vault read (step 7/8).
//     Evidence: scenario H (`key-release.spec.ts`) — an early release
//     rejects `release-window-not-open`, writes no row, and leaves
//     `authPromptCount` unchanged. Negative control (c).
//  2. Seeding is own-device only, never cross-user, idempotent by
//     deterministic Id, and never prompts: `seedReleaseKeyTasks` filters
//     candidates with `vault.hasSecret` (never `getSecret`), the Task Id is
//     `releaseKeyTaskId(electionId, revision, userId)`, and an existing Task
//     OR an existing `KeyholderShareRelease` row short-circuits a repeat
//     seed. Evidence: scenario A — own-device-only count, repeat reads stay
//     at 5, zero `authPromptCount` delta. Controls (e), (f).
//  3. Never at accept, never from the debug seed: this module is the ONLY
//     NEW `'release-key'` Task producer this plan adds;
//     `invitation-engine.ts` (accept) and `elections-engine.ts`'s
//     `debugSeedPendingTasks` (`__DEV__`) are untouched. Evidence: the
//     producer-gate greps in Task 2's acceptance criteria.
//  4. The releaser is a round-4 agreeing participant, and its signer key is
//     a `UserKey` of that user, both checked BEFORE any vault read.
//     Evidence: scenario I. The schema's `ReleaserParticipated`/
//     `SignerIsUser` CHECKs back this at insert as a second, independent
//     layer. Controls (d) and (i, identifier variant below).
//  5. A published share is commitment-checked (`validateReleasedShare`)
//     against commitments DERIVED FROM THE TRANSCRIPT (V-2: the attempt's
//     round-1 packages of the round-4 participants, signature-valid
//     against their stored SenderKey,
//     `transcriptCommitments` on the snapshot), never against the
//     write-once `ElectionKey.GroupCommitments` column, which any live
//     keyholder can publish with junk. The column is parsed with
//     `parseElectionKeyCommitments` (never throws) and is advisory; the DKG
//     status reports a mismatch. A share is checked
//     BEFORE it is ever signed — a share that fails its own group
//     commitments is never published. Evidence: scenario G (raw-inserted
//     bogus share), and the honest-release path's own `share-invalid` gate.
//  6. Read-side signature re-verification: every `ElectionKey` and
//     `KeyholderShareRelease` row is re-checked in SQL on every read against
//     the row's own stored key, never trusted on the strength of having
//     replicated. Key membership is proven once, at insert, by the
//     `SenderKeyIsUsers`/`PublisherKeyIsUsers`/`SignerIsUser` CHECKs on
//     immutable NoUpdate/NoDelete rows, and is deliberately NOT re-required
//     at read so a later rotation or revocation cannot strand the key
//     (CR-02). Evidence: the evaluator's `signature-invalid` rejection case
//     (control b) and key-release-rotation.spec.ts (KR2-KR4).
//  7. Share filtering before interpolation: `reconstructElectionKey` only
//     ever calls `reconstructGroupSecret` (62-05), never `combineSecret`
//     directly — `grep -c "combineSecret"` over this file is 0. Evidence:
//     scenario G — a bogus share is rejected and excluded, 3 honest shares
//     still reconstruct. Control (a).
//  8. k comes from `ElectionKey.Threshold`, required to equal the current
//     revision's `KeyholderThreshold` (skipped only for an explicitly
//     non-current revision, where participants/commitments still apply).
//     Evidence: the evaluator's `election-key-inconsistent` cases. Control
//     (g).
//  9. `s*G == Y` is asserted — inherited from 62-05's `reconstructGroupSecret`,
//     exercised by scenario D (`secp256k1.getPublicKey(secretKey, true)`
//     equals the published `JointPublicKey`).
// 10. A Task cannot complete without a published share: `completeKeyRelease`
//     requires a signer, requires it to match the Task's own user, and only
//     marks the Task complete AFTER `releaseKeyShare` resolves. Evidence:
//     scenario J, control (h).
// 11. No secret in errors or logs: every `KeyReleaseError` message carries
//     codes, ids and counts only — never a share, scalar or the
//     reconstructed key. `secretKey` is never vaulted, inserted, returned
//     from any DB call or logged; local copies are zeroed (best-effort, no
//     erasure claim) after use. Evidence: scenario L — no 64-hex run in any
//     thrown message from scenarios D, G, H, I, J, K. `grep -c "console\."`
//     over this file is 0; `grep -c "putSecret"` is 0 (this engine only
//     ever READS the share alias, never writes one — `executePostRound4` in
//     `keyholder-dkg-engine.ts` is the only writer).
// 12. D-18: a block payload always carries both `votes` and `voterRecords` —
//     `encryptElectionBlock` refuses a payload missing either, before any
//     encryption. Control (j), in `election-block.ts`.
// 13. Residual, ACCEPTED: once k shares are public, anyone can decrypt. That
//     is D-17 by design. The window check stops an HONEST release before
//     `releasingKeys`, but a keyholder running a raw client could publish a
//     signed share early — `ReleasedAt` is self-asserted, not independently
//     timestamped. k-of-n means fewer than k early shares reveal nothing
//     (D-14). The TSA-timestamp seam (`doc/election.md:121`) stays out of
//     scope for this plan. Tracked as T-62-20-06, surfaced to the
//     orchestrator in the SUMMARY, not claimed closed.
// 14. Residual, ACCEPTED: the Task's own completion gate is tier 2
//     (`context.IsMutationValid`, pre-existing schema design, unrelated to
//     this plan). Tracked as T-62-20-08.
// 15. Hermes device proof debt: this composed engine has run only in Node,
//     over `InMemoryTestKeyVault` and an in-memory Quereus `Database`. No
//     device run has been made on Hermes or against a hardware-backed vault
//     adapter. Tracked for 62-30 in the D-23 "code-complete, unverified"
//     style — never claim device proof from this review.
//
// CR-02 controls (62-39), live-mutated, restored from a scratch copy:
//   C1 re-add the current-UserKey EXISTS at the round-1 read: KR2 goes red.
//   C2 re-add it at the loadSnapshot ElectionKey read: KR4 goes red.
//   C3 re-add it at the KeyholderShareRelease read: KR3 goes red.
//   C4 re-add it at the seedReleaseKeyTasks candidate read: KR4 goes red.
//   C5 delete the releaseKeyShare step-5 current-key check: KR5b goes red.
//
// Negative control results — ALL 10 live-mutated (temporarily edited the
// named file with the mutation wrapped `false && (...)`/inlined so the
// surrounding code stays syntactically valid), the targeted spec(s) run to
// completion, the failing title(s) recorded below VERBATIM from the actual
// run, then `git checkout --` restored the file (`git diff --quiet` over
// `src/key-release/` and `src/tasks/keys-tasks-engine.ts` confirmed clean
// after every one):
//
//   (a) Bypass `reconstructGroupSecret`'s filter+assertion entirely —
//       interpolate over snapshot.releases (unfiltered, raw) via
//       `secp256k1_FROST.combineSecret` directly.
//       RED (2 failing): "G: 2 honest releases plus the bogus X row still
//       gives insufficient-shares" (`expectThrows: function did not throw`
//       — combineSecret succeeds on the raw 3-row set, bogus share and
//       all); "D: with all 5 released, reconstruction still uses exactly
//       k=3 (usedUserIds length 3)" (`key-release.spec.ts`).
//   (b) Treat `signatureValid` false rows as accepted in the evaluator
//       (drop the rule-1 check).
//       RED (2 failing): "a row with signatureValid false gives
//       signature-invalid, not counted" and "two honest plus three bogus
//       rows gives releasedCount 2 and phase releasing"
//       (`key-release-evaluator.spec.ts`).
//   (c) Remove the `hasEnteredReleasingKeys` check in `releaseKeyShare`.
//       RED (1 failing): "H: releaseKeyShare before the window rejects
//       release-window-not-open, writes no row, and reads no vault"
//       (`key-release.spec.ts`) — no longer throws.
//   (d) Remove the `r4ParticipantUserIds` participant check in
//       `releaseKeyShare`.
//       RED (1 failing): "I: a signer whose userId is not an R4
//       participant gives not-a-participant" — the release instead
//       proceeds past the participant gate and fails downstream with
//       `share-missing` (the outsider's vault never held a share) instead
//       of `not-a-participant`, confirming the check is bypassed.
//   (e) Seed for every R4 participant without the `vault.hasSecret` filter.
//       RED (1 failing): "A: at the window, one participant seeds exactly
//       one own-device task with the deterministic Id" — got 5 Tasks
//       instead of 1 on the FIRST device's single read.
//   (f) Use a random Task Id (not `releaseKeyTaskId`) and drop the
//       existence check in seeding.
//       RED (2 failing): "A: at the window, one participant seeds exactly
//       one own-device task with the deterministic Id" (the persisted Id no
//       longer equals `releaseKeyTaskId(...)`) and "A: idempotent under
//       repeated and concurrent reads ..." (30 Task rows instead of 5 —
//       every repeat read now seeds a fresh one).
//   (g) Skip the threshold-versus-`keyholderThreshold` consistency check in
//       the evaluator.
//       RED (1 failing): "electionKey.threshold differing from the current
//       revision keyholderThreshold gives election-key-inconsistent"
//       (`key-release-evaluator.spec.ts`) — the phase came back `releasing`
//       instead.
//   (h) In `KeysTasksEngine.completeKeyRelease`, mark the Task complete
//       when `signer` is absent (skip the `signer-required` gate).
//       RED (2 failing): "J: completeKeyRelease(task) with no signer
//       rejects signer-required; the Task stays IsCompleted 0 and no row
//       exists" (completes with no throw instead); "J: a signer for a
//       different keyholder rejects signer-task-mismatch" (a cascading
//       failure of the SAME mutation — the first test's unguarded
//       completion already marked the shared Task complete, so the second
//       test's own pending-task lookup returns nothing).
//   (i) Skip the `identifier !== dkgIdentifierForUser(userId)` check in the
//       evaluator.
//       RED (1 failing): "a row whose identifier belongs to a different
//       user gives identifier-mismatch" (`key-release-evaluator.spec.ts`)
//       — the row falls through to rule 4 and is rejected `share-invalid`
//       instead of `identifier-mismatch` (still rejected, by a different
//       rule, confirming rule 3 itself is bypassed).
//   (j) Let `encryptElectionBlock` accept a payload without `voterRecords`
//       or `votes`.
//       RED (2 failing): "throws BlockCipherError invalid-plaintext for a
//       payload missing voterRecords" and "... missing votes"
//       (`key-release-evaluator.spec.ts`) — the call proceeds past the
//       shape check into `encryptBlockContent` and fails later on the
//       (deliberately invalid) test `jointPublicKey` instead, confirming
//       the D-18 shape gate itself is bypassed.
//
// Findings table: no HIGH or MEDIUM finding raised by this review.
//
// Residuals (OPEN, not claimed safe): T-62-20-06 (raw-client early
// release — item 13), T-62-20-08 (tier-2 Task gate — item 14). Hermes
// device proof debt: item 15, tracked for 62-30 — never claim device proof
// for this review.

import { rethrow as rethrowHelper } from '../signing/ceremony-helpers.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import type {
  ElectionBlockDecryptResult,
  ElectionBlockInput,
  ElectionKeyRecord,
  IKeyReleaseEngine,
  KeyReleaseStatus,
  KeyShareReleaseOutcome,
  KeyShareReleaseRecord,
  KeyholderDkgSigner,
  ReconstructedElectionKey,
  SeedReleaseKeyTasksResult
} from '@votetorrent/vote-core'
import type { EngineContext } from '../types.js'
import { allocateTid } from '../database/tid-allocator.js'
import { digestToBytes, parseJsonOr } from '../utils.js'
import { KeyVaultError, keyholderDkgShareAlias, type IKeyVault } from '../crypto/vault.js'
import { DkgError, deriveGroupCommitments, dkgIdentifierForUser, reconstructGroupSecret, validateReleasedShare, type DkgRound1Wire } from '../crypto/dkg.js'
import { parseElectionKeyCommitments, parseRound1Payload } from '../keyholder/dkg-payloads.js'
import { openElectionBlock } from './election-block.js'
import { hasEnteredReleasingKeys } from './release-window.js'
import { evaluateKeyRelease, type KeyReleaseRow, type KeyReleaseSnapshot } from './key-release-evaluator.js'

function normalizeBool (value: unknown): boolean {
  return value === true || value === 1
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type KeyReleaseErrorCode =
  | 'signer-required' | 'signer-task-mismatch' | 'signer-key-mismatch' | 'signature-mismatch'
  | 'no-current-revision' | 'revision-not-current' | 'no-election-key' | 'election-key-inconsistent'
  | 'release-window-not-open' | 'not-a-participant' | 'vault-unavailable' | 'share-missing' | 'share-invalid'
  | 'insufficient-shares' | 'group-key-mismatch'

/** Messages carry codes, ids and counts ONLY — never a byte of share, scalar or the reconstructed key (T-62-20-11). */
export class KeyReleaseError extends Error {
  readonly code: KeyReleaseErrorCode

  constructor (code: KeyReleaseErrorCode, message: string) {
    super(message)
    this.name = 'KeyReleaseError'
    this.code = code
  }
}

export interface KeyReleaseEngineDeps {
  vault?: IKeyVault
  now?: () => number
}

/** 64-hex sha256 of utf8 JSON `['vt-release-key-task-id', electionId, revision, userId]` — deterministic, so repeated/concurrent seeding never creates a second Task for the same triple. */
export function releaseKeyTaskId (electionId: string, revision: number, userId: string): string {
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify(['vt-release-key-task-id', electionId, revision, userId]))))
}

// ---------------------------------------------------------------------------
// Per-key promise-chain mutexes (mirror tid-allocator.ts's idiom)
// ---------------------------------------------------------------------------

const seedLocks = new WeakMap<object, Promise<unknown>>()

async function withSeedLock<T> (key: object, fn: () => Promise<T>): Promise<T> {
  const prior = seedLocks.get(key) ?? Promise.resolve()
  const settled = prior.then(() => {}, () => {})
  const next = settled.then(fn)
  seedLocks.set(key, next.then(() => {}, () => {}))
  return next
}

const releaseLocks = new Map<string, Promise<unknown>>()

async function withReleaseLock<T> (key: string, fn: () => Promise<T>): Promise<T> {
  const prior = releaseLocks.get(key) ?? Promise.resolve()
  const settled = prior.then(() => {}, () => {})
  const next = settled.then(fn)
  releaseLocks.set(key, next.then(() => {}, () => {}))
  return next
}

// ---------------------------------------------------------------------------
// KeyReleaseEngine
// ---------------------------------------------------------------------------

export class KeyReleaseEngine implements IKeyReleaseEngine {
  constructor (private readonly ctx: EngineContext, private readonly deps: KeyReleaseEngineDeps = {}) {}

  private now (): number {
    return this.deps.now !== undefined ? this.deps.now() : Date.now()
  }

  // -------------------------------------------------------------------------
  // Snapshot loader — read-side signature re-verification (T-62-20 header item 6)
  // -------------------------------------------------------------------------

  private async loadSnapshot (electionId: string, revisionOverride?: number): Promise<KeyReleaseSnapshot> {
    const now = this.now()
    const curRow = await this.ctx.db
      .prepare('select Revision, KeyholderThreshold, Timeline from ElectionRevision where ElectionId = :electionId')
      .get({ electionId })
    const currentRevision = curRow ? (curRow.Revision as number) : null

    let revision: number | null
    let isCurrentRevision: boolean
    let keyholderThreshold: number | null
    let timeline: unknown

    if (currentRevision === null) {
      revision = null
      isCurrentRevision = false
      keyholderThreshold = null
      timeline = {}
    } else if (revisionOverride === undefined || revisionOverride === currentRevision) {
      revision = currentRevision
      isCurrentRevision = true
      keyholderThreshold = curRow!.KeyholderThreshold as number
      timeline = parseJsonOr<Record<string, number>>(curRow!.Timeline as string | null, {}, 'ElectionRevision.Timeline')
    } else {
      revision = revisionOverride
      isCurrentRevision = false
      const row = await this.ctx.db
        .prepare('select KeyholderThreshold, Timeline from ElectionRevision where ElectionId = :electionId and Revision = :revision')
        .get({ electionId, revision: revisionOverride })
      keyholderThreshold = row ? (row.KeyholderThreshold as number) : null
      timeline = parseJsonOr<Record<string, number>>(row ? (row.Timeline as string | null) : null, {}, 'ElectionRevision.Timeline')
    }

    if (revision === null) {
      return {
        electionId, revision: null, isCurrentRevision: false, keyholderThreshold: null, timeline: {}, now,
        electionKey: null, r4ParticipantUserIds: [], transcriptCommitments: null, releases: []
      }
    }

    const ekRow = await this.ctx.db
      .prepare(
        `select Attempt, JointPublicKey, GroupCommitments, Threshold, Participants, PublishedAt, PublisherUserId,
            (
              (
                SignatureValid(Digest('ElectionKey', ElectionId, ElectionRevision, Attempt, JointPublicKey, GroupCommitments, Threshold, Participants, PublishedAt, PublisherUserId), Signature, PublisherKey)
                  or SignatureValidP256(Digest('ElectionKey', ElectionId, ElectionRevision, Attempt, JointPublicKey, GroupCommitments, Threshold, Participants, PublishedAt, PublisherUserId), Signature, PublisherKey)
              )
            ) as SigValid
          from ElectionKey where ElectionId = :electionId and ElectionRevision = :revision`
      )
      .get({ electionId, revision })

    let electionKey: (ElectionKeyRecord & { signatureValid: boolean }) | null = null
    if (ekRow) {
      electionKey = {
        electionId,
        revision,
        attempt: ekRow.Attempt as number,
        jointPublicKey: ekRow.JointPublicKey as string,
        // Advisory only; `[]` means "malformed on the row". Validation uses `transcriptCommitments`.
        groupCommitments: parseElectionKeyCommitments(ekRow.GroupCommitments) ?? [],
        threshold: ekRow.Threshold as number,
        participants: ekRow.Participants as number,
        publishedAt: ekRow.PublishedAt as string,
        publisherUserId: ekRow.PublisherUserId as string,
        signatureValid: normalizeBool(ekRow.SigValid)
      }
    }

    const r4ParticipantUserIds: string[] = []
    if (electionKey !== null) {
      for await (const row of this.ctx.db.eval(
        `select M.SenderUserId
           from KeyholderDkgMessage M join Keyholder K
             on K.ElectionId = M.ElectionId and K.ElectionRevision = M.ElectionRevision and K.UserId = M.SenderUserId
           where M.ElectionId = :electionId and M.ElectionRevision = :revision
             and M.Attempt = :attempt and M.DkgRound = 4 and M.ResultKey = :jointPublicKey
           order by M.SenderUserId`,
        { electionId, revision, attempt: electionKey.attempt, jointPublicKey: electionKey.jointPublicKey }
      )) {
        r4ParticipantUserIds.push(row.SenderUserId as string)
      }
    }

    // Commitments derived from the TRANSCRIPT: the attempt's round-1 packages of exactly the round-4 participants,
    // signature-valid against each row's stored SenderKey, one parseable package each. Any gap or throw gives null
    // (fail-closed). CR-02: the sender's key is NOT required to still be in the CURRENT UserKey table; SenderKeyIsUsers
    // proved membership at insert and the row is immutable, so a later rotation must not block release.
    let transcriptCommitments: string[] | null = null
    if (electionKey !== null && r4ParticipantUserIds.length > 0) {
      const r1Rows: Array<{ userId: string, payload: string, sigValid: boolean }> = []
      for await (const row of this.ctx.db.eval(
        `select SenderUserId, Payload,
            (
              (
                SignatureValid(Digest('KeyholderDkgMessage', ElectionId, ElectionRevision, Attempt, DkgRound, SenderUserId, Payload, ResultKey, SentAt), Signature, SenderKey)
                  or SignatureValidP256(Digest('KeyholderDkgMessage', ElectionId, ElectionRevision, Attempt, DkgRound, SenderUserId, Payload, ResultKey, SentAt), Signature, SenderKey)
              )
            ) as SigValid
          from KeyholderDkgMessage
          where ElectionId = :electionId and ElectionRevision = :revision and Attempt = :attempt and DkgRound = 1`,
        { electionId, revision, attempt: electionKey.attempt }
      )) {
        r1Rows.push({ userId: row.SenderUserId as string, payload: row.Payload as string, sigValid: normalizeBool(row.SigValid) })
      }
      try {
        const packages: DkgRound1Wire[] = []
        for (const userId of r4ParticipantUserIds) {
          const mine = r1Rows.filter((r) => r.userId === userId && r.sigValid)
          if (mine.length !== 1) throw new Error('round-1 gap')
          const pkg = parseRound1Payload(mine[0]!.payload)
          if (pkg === null) throw new Error('round-1 unparseable')
          packages.push(pkg)
        }
        transcriptCommitments = deriveGroupCommitments(packages)
      } catch {
        transcriptCommitments = null
      }
    }

    const releases: KeyReleaseRow[] = []
    for await (const row of this.ctx.db.eval(
      `select UserId, Identifier, SigningShare, ReleasedAt, SignerKey,
          (
            (
              SignatureValid(Digest('KeyholderShareRelease', ElectionId, ElectionRevision, UserId, Identifier, SigningShare, ReleasedAt), Signature, SignerKey)
                or SignatureValidP256(Digest('KeyholderShareRelease', ElectionId, ElectionRevision, UserId, Identifier, SigningShare, ReleasedAt), Signature, SignerKey)
            )
          ) as SigValid
        from KeyholderShareRelease where ElectionId = :electionId and ElectionRevision = :revision`,
      { electionId, revision }
    )) {
      releases.push({
        userId: row.UserId as string,
        identifier: row.Identifier as string,
        signingShare: row.SigningShare as string,
        releasedAt: row.ReleasedAt as string,
        signerKey: row.SignerKey as string,
        signatureValid: normalizeBool(row.SigValid)
      })
    }

    return { electionId, revision, isCurrentRevision, keyholderThreshold, timeline, now, electionKey, r4ParticipantUserIds, transcriptCommitments, releases }
  }

  // -------------------------------------------------------------------------
  // IKeyReleaseEngine
  // -------------------------------------------------------------------------

  async getKeyReleaseStatus (electionId: string, selfUserId?: string, revision?: number): Promise<KeyReleaseStatus> {
    try {
      const snapshot = await this.loadSnapshot(electionId, revision)
      const evaluation = evaluateKeyRelease(snapshot)
      const status: KeyReleaseStatus = { ...evaluation.status }
      if (selfUserId !== undefined) {
        const isParticipant = snapshot.r4ParticipantUserIds.includes(selfUserId)
        const hasReleased = evaluation.status.releasedUserIds.includes(selfUserId)
        const hasShare = this.deps.vault !== undefined && snapshot.revision !== null
          ? await this.deps.vault.hasSecret(keyholderDkgShareAlias(electionId, snapshot.revision, selfUserId))
          : false
        status.self = { userId: selfUserId, isParticipant, hasReleased, hasShare }
      }
      return status
    } catch (err) {
      this.rethrow(err, 'getKeyReleaseStatus')
    }
  }

  async getReleasedShares (electionId: string, revision?: number): Promise<KeyShareReleaseRecord[]> {
    try {
      const snapshot = await this.loadSnapshot(electionId, revision)
      return evaluateKeyRelease(snapshot).acceptedReleases
    } catch (err) {
      this.rethrow(err, 'getReleasedShares')
    }
  }

  async getLocalKeyholderUserIds (): Promise<string[]> {
    try {
      if (this.deps.vault === undefined) return []
      const vault = this.deps.vault
      const out = new Set<string>()
      // CURRENT revision only — ElectionRevision carries exactly one row per election.
      for await (const row of this.ctx.db.eval(
        `select K.ElectionId, K.ElectionRevision, K.UserId
           from Keyholder K join ElectionRevision ER
             on ER.ElectionId = K.ElectionId and ER.Revision = K.ElectionRevision`,
        {}
      )) {
        const electionId = row.ElectionId as string
        const electionRevision = row.ElectionRevision as number
        const userId = row.UserId as string
        if (await vault.hasSecret(keyholderDkgShareAlias(electionId, electionRevision, userId))) {
          out.add(userId)
        }
      }
      return Array.from(out).sort()
    } catch (err) {
      this.rethrow(err, 'getLocalKeyholderUserIds')
    }
  }

  async seedReleaseKeyTasks (): Promise<SeedReleaseKeyTasksResult> {
    return withSeedLock(this.ctx.db, async () => {
      try {
        const result: SeedReleaseKeyTasksResult = { seeded: [], alreadySeeded: 0, failures: [] }
        // Rule 1: no local keyholder can ever be known without a vault — fail-closed, not a crash.
        if (this.deps.vault === undefined) return result
        const vault = this.deps.vault
        const now = this.now()

        // Rule 2: elections with a published, signature-valid ElectionKey for their
        // CURRENT revision whose releasingKeys window has opened.
        const candidates: Array<{ electionId: string, revision: number, attempt: number, jointPublicKey: string }> = []
        for await (const row of this.ctx.db.eval(
          `select ER.ElectionId, ER.Revision, ER.Timeline,
              EK.Attempt, EK.JointPublicKey, EK.GroupCommitments, EK.Threshold, EK.Participants, EK.PublishedAt, EK.PublisherUserId,
              (
                (
                  SignatureValid(Digest('ElectionKey', EK.ElectionId, EK.ElectionRevision, EK.Attempt, EK.JointPublicKey, EK.GroupCommitments, EK.Threshold, EK.Participants, EK.PublishedAt, EK.PublisherUserId), EK.Signature, EK.PublisherKey)
                    or SignatureValidP256(Digest('ElectionKey', EK.ElectionId, EK.ElectionRevision, EK.Attempt, EK.JointPublicKey, EK.GroupCommitments, EK.Threshold, EK.Participants, EK.PublishedAt, EK.PublisherUserId), EK.Signature, EK.PublisherKey)
                )
              ) as SigValid
            from ElectionRevision ER join ElectionKey EK on EK.ElectionId = ER.ElectionId and EK.ElectionRevision = ER.Revision`,
          {}
        )) {
          if (!normalizeBool(row.SigValid)) continue
          const timeline = parseJsonOr<Record<string, number>>(row.Timeline as string | null, {}, 'ElectionRevision.Timeline')
          if (!hasEnteredReleasingKeys(timeline, now)) continue
          candidates.push({
            electionId: row.ElectionId as string,
            revision: row.Revision as number,
            attempt: row.Attempt as number,
            jointPublicKey: row.JointPublicKey as string
          })
        }

        for (const candidate of candidates) {
          const { electionId, revision, attempt, jointPublicKey } = candidate
          const participants: string[] = []
          for await (const row of this.ctx.db.eval(
            `select M.SenderUserId from KeyholderDkgMessage M join Keyholder K
               on K.ElectionId = M.ElectionId and K.ElectionRevision = M.ElectionRevision and K.UserId = M.SenderUserId
             where M.ElectionId = :electionId and M.ElectionRevision = :revision
               and M.Attempt = :attempt and M.DkgRound = 4 and M.ResultKey = :jointPublicKey
             order by M.SenderUserId`,
            { electionId, revision, attempt, jointPublicKey }
          )) {
            participants.push(row.SenderUserId as string)
          }

          // Rule 3: own-device only — never prompts (hasSecret only).
          for (const userId of participants) {
            if (!(await vault.hasSecret(keyholderDkgShareAlias(electionId, revision, userId)))) continue

            const taskId = releaseKeyTaskId(electionId, revision, userId)
            const existingTask = await this.ctx.db.prepare('select Id from Task where Id = :id').get({ id: taskId })
            if (existingTask) { result.alreadySeeded++; continue }
            const existingRelease = await this.ctx.db
              .prepare('select 1 as x from KeyholderShareRelease where ElectionId = :electionId and ElectionRevision = :revision and UserId = :userId')
              .get({ electionId, revision, userId })
            if (existingRelease) { result.alreadySeeded++; continue }

            try {
              // Rule 4: ONE Task + extension pair per transaction — never batched.
              // Per-keyholder namespace: each keyholder's device writes ONLY its own TidHighWater row. A shared
              // 'keys-tasks' row is a primary key two replicas upsert from stale views, so the second
              // device's commit failed UNIQUE(TidHighWater.Namespace) and its task was never seeded.
              const tid = await allocateTid(this.ctx.db, `keys-tasks:${userId}`)
              await this.ctx.db.exec('BEGIN')
              try {
                await this.ctx.db.exec(
                  `insert into Task (Id, UserId, Type, IsCompleted)
                   with context IsMutationValid = true, Tid = :tid
                   values (:id, :userId, 'release-key', 0)`,
                  { id: taskId, userId, tid }
                )
                await this.ctx.db.exec(
                  `insert into ReleaseKeyTaskExtension (TaskId, ElectionId, ElectionRevision)
                   with context Tid = :tid
                   values (:taskId, :electionId, :electionRevision)`,
                  { taskId, electionId, electionRevision: revision, tid }
                )
                await this.ctx.db.exec('COMMIT')
              } catch (err) {
                await this.ctx.db.exec('ROLLBACK')
                throw err
              }
              result.seeded.push({ taskId, userId, electionId, revision })
            } catch (err) {
              // Rule 5: a PK conflict re-reads; a per-candidate failure never aborts the others.
              const reread = await this.ctx.db.prepare('select Id from Task where Id = :id').get({ id: taskId })
              if (reread) {
                result.alreadySeeded++
              } else {
                result.failures.push({ userId, electionId, detail: err instanceof Error ? err.message : String(err) })
              }
            }
          }
        }

        return result
      } catch (err) {
        this.rethrow(err, 'seedReleaseKeyTasks')
      }
    })
  }

  async releaseKeyShare (electionId: string, signer: KeyholderDkgSigner, revision?: number): Promise<KeyShareReleaseOutcome> {
    return withReleaseLock(`${electionId}:${signer.userId}`, async () => {
      try {
        const snapshot = await this.loadSnapshot(electionId, revision)

        // 1. current revision exists, and a requested revision matches it.
        if (snapshot.revision === null) {
          throw new KeyReleaseError('no-current-revision', 'releaseKeyShare: election has no current revision')
        }
        if (revision !== undefined && !snapshot.isCurrentRevision) {
          throw new KeyReleaseError('revision-not-current', 'releaseKeyShare: the requested revision is not the election\'s current revision')
        }
        const resolvedRevision = snapshot.revision

        // 2. ElectionKey is signature-valid and consistent.
        if (snapshot.electionKey === null || !snapshot.electionKey.signatureValid) {
          throw new KeyReleaseError('no-election-key', 'releaseKeyShare: no published, signature-valid ElectionKey for this revision')
        }
        const ek = snapshot.electionKey
        const thresholdMatches = !snapshot.isCurrentRevision || ek.threshold === snapshot.keyholderThreshold
        const participantsMatch = ek.participants === snapshot.r4ParticipantUserIds.length
        const transcriptCommitments = snapshot.transcriptCommitments
        const commitmentsMatch = transcriptCommitments !== null && transcriptCommitments[0] === ek.jointPublicKey
        if (!thresholdMatches || !participantsMatch || !commitmentsMatch || transcriptCommitments === null) {
          throw new KeyReleaseError('election-key-inconsistent', 'releaseKeyShare: published ElectionKey is inconsistent with the revision, roster or commitments')
        }

        // 3. release window open — BEFORE any vault read.
        if (!hasEnteredReleasingKeys(snapshot.timeline, this.now())) {
          throw new KeyReleaseError('release-window-not-open', 'releaseKeyShare: the releasingKeys window has not opened yet')
        }

        // 4. signer is an agreeing round-4 participant.
        if (!snapshot.r4ParticipantUserIds.includes(signer.userId)) {
          throw new KeyReleaseError('not-a-participant', 'releaseKeyShare: signer.userId is not an agreeing round-4 participant')
        }

        // 5. signer key is a UserKey of signer.userId.
        const signerRow = await this.ctx.db
          .prepare('select 1 as x from UserKey where UserId = :userId and PubKey = :pubKey')
          .get({ userId: signer.userId, pubKey: signer.signingPublicKey })
        if (!signerRow) {
          throw new KeyReleaseError('signer-key-mismatch', 'releaseKeyShare: signer.signingPublicKey is not a UserKey of signer.userId')
        }

        // 6. already released? (no vault access for the accepted case.)
        const evaluation = evaluateKeyRelease(snapshot)
        const alreadyAccepted = evaluation.acceptedReleases.find((r) => r.userId === signer.userId)
        if (alreadyAccepted !== undefined) {
          return { outcome: 'already-released', release: alreadyAccepted }
        }
        const rejectedOwn = evaluation.status.rejectedReleases.find((r) => r.userId === signer.userId)
        if (rejectedOwn !== undefined) {
          throw new KeyReleaseError('share-invalid', 'releaseKeyShare: a release row already exists for this user and failed validation — the primary key forbids a second row')
        }

        // 7. vault present.
        if (this.deps.vault === undefined) {
          throw new KeyReleaseError('vault-unavailable', 'releaseKeyShare: no vault configured on this engine')
        }
        const alias = keyholderDkgShareAlias(electionId, resolvedRevision, signer.userId)
        const shareBytes = await this.deps.vault.getSecret(alias)
        if (shareBytes === null) {
          throw new KeyReleaseError('share-missing', 'releaseKeyShare: no share in the vault for this (electionId, revision, userId)')
        }

        // 8. validate against the published group commitments — never publish a share that fails its own commitments.
        const identifier = dkgIdentifierForUser(signer.userId)
        const signingShareHex = bytesToHex(shareBytes)
        const valid = validateReleasedShare(ek.threshold, ek.participants, transcriptCommitments, { identifier, signingShare: signingShareHex })
        if (!valid) {
          shareBytes.fill(0)
          throw new KeyReleaseError('share-invalid', 'releaseKeyShare: share fails validateReleasedShare against the published group commitments')
        }

        // 9. sign and insert — never hold a transaction across sign().
        const releasedAt = new Date(this.now()).toISOString()
        const digestRow = await this.ctx.db
          .prepare("select Digest('KeyholderShareRelease', :electionId, :revision, :userId, :identifier, :signingShare, :releasedAt) as d")
          .get({ electionId, revision: resolvedRevision, userId: signer.userId, identifier, signingShare: signingShareHex, releasedAt })
        if (!digestRow || digestRow.d == null) {
          shareBytes.fill(0)
          throw new Error('KeyReleaseEngine: Digest() returned null for KeyholderShareRelease — crypto plugin not registered?')
        }
        const signature = await signer.sign(digestToBytes(digestRow.d as string))
        if (signature.signerKey !== signer.signingPublicKey) {
          shareBytes.fill(0)
          throw new KeyReleaseError('signature-mismatch', 'releaseKeyShare: sign() returned a signerKey that does not match signer.signingPublicKey')
        }

        try {
          await this.ctx.db.exec(
            `insert into KeyholderShareRelease (ElectionId, ElectionRevision, UserId, Identifier, SigningShare, ReleasedAt, SignerKey, Signature)
             values (:electionId, :revision, :userId, :identifier, :signingShare, :releasedAt, :signerKey, :signature)`,
            { electionId, revision: resolvedRevision, userId: signer.userId, identifier, signingShare: signingShareHex, releasedAt, signerKey: signature.signerKey, signature: signature.signature }
          )
        } catch (err) {
          // 10. PK conflict — re-read: same identifier and share means already-released.
          const reread = await this.ctx.db
            .prepare('select Identifier, SigningShare, ReleasedAt, SignerKey from KeyholderShareRelease where ElectionId = :electionId and ElectionRevision = :revision and UserId = :userId')
            .get({ electionId, revision: resolvedRevision, userId: signer.userId })
          shareBytes.fill(0)
          if (reread && reread.Identifier === identifier && reread.SigningShare === signingShareHex) {
            return {
              outcome: 'already-released',
              release: {
                electionId, revision: resolvedRevision, userId: signer.userId, identifier, signingShare: signingShareHex,
                releasedAt: reread.ReleasedAt as string, signerKey: reread.SignerKey as string
              }
            }
          }
          throw err
        }

        // 11. best-effort erasure — no erasure claim is made.
        shareBytes.fill(0)
        const release: KeyShareReleaseRecord = {
          electionId, revision: resolvedRevision, userId: signer.userId, identifier, signingShare: signingShareHex, releasedAt, signerKey: signature.signerKey
        }
        return { outcome: 'released', release }
      } catch (err) {
        this.rethrow(err, 'releaseKeyShare')
      }
    })
  }

  async reconstructElectionKey (electionId: string, revision?: number): Promise<ReconstructedElectionKey> {
    try {
      const snapshot = await this.loadSnapshot(electionId, revision)
      const evaluation = evaluateKeyRelease(snapshot)
      const phase = evaluation.status.phase
      if (phase === 'no-current-revision') {
        throw new KeyReleaseError('no-current-revision', 'reconstructElectionKey: election has no current revision')
      }
      if (phase === 'no-election-key') {
        throw new KeyReleaseError('no-election-key', 'reconstructElectionKey: no published, signature-valid ElectionKey for this revision')
      }
      if (phase === 'election-key-inconsistent') {
        throw new KeyReleaseError('election-key-inconsistent', 'reconstructElectionKey: published ElectionKey is inconsistent with the revision, roster or commitments')
      }

      const ek = snapshot.electionKey!
      const shares = evaluation.acceptedReleases.map((r) => ({ identifier: r.identifier, signingShare: r.signingShare }))

      let result
      try {
        result = reconstructGroupSecret({
          threshold: ek.threshold,
          participants: ek.participants,
          groupPublicKey: ek.jointPublicKey,
          groupCommitments: snapshot.transcriptCommitments!,
          shares
        })
      } catch (err) {
        if (err instanceof DkgError && err.code === 'insufficient-shares') {
          throw new KeyReleaseError('insufficient-shares', `reconstructElectionKey: ${evaluation.acceptedReleases.length} accepted share(s), need ${ek.threshold}`)
        }
        if (err instanceof DkgError && err.code === 'group-key-mismatch') {
          throw new KeyReleaseError('group-key-mismatch', 'reconstructElectionKey: reconstructed secret does not match the published JointPublicKey')
        }
        throw err
      }

      const byIdentifier = new Map(evaluation.acceptedReleases.map((r) => [r.identifier, r.userId] as const))
      const usedUserIds = result.usedIdentifiers
        .map((id) => byIdentifier.get(id))
        .filter((u): u is string => u !== undefined)
        .sort()

      return {
        electionId,
        revision: snapshot.revision!,
        jointPublicKey: ek.jointPublicKey,
        secretKey: result.secretKey,
        threshold: ek.threshold,
        participants: ek.participants,
        usedUserIds,
        rejectedReleases: evaluation.status.rejectedReleases
      }
    } catch (err) {
      this.rethrow(err, 'reconstructElectionKey')
    }
  }

  async decryptElectionBlocks (electionId: string, blocks: readonly ElectionBlockInput[], revision?: number): Promise<ElectionBlockDecryptResult[]> {
    try {
      let reconstructed: ReconstructedElectionKey
      try {
        reconstructed = await this.reconstructElectionKey(electionId, revision)
      } catch (err) {
        const code = err instanceof KeyReleaseError ? err.code : 'reconstruction-failed'
        return blocks.map((b) => ({ ok: false as const, blockId: b.blockId, reason: 'not-reconstructable' as const, detail: code }))
      }
      const electionKeyForOpen = { electionId: reconstructed.electionId, revision: reconstructed.revision, jointPublicKey: reconstructed.jointPublicKey }
      const results = blocks.map((b) => openElectionBlock(reconstructed.secretKey, electionKeyForOpen, b))
      reconstructed.secretKey.fill(0)
      return results
    } catch (err) {
      this.rethrow(err, 'decryptElectionBlocks')
    }
  }

  // -------------------------------------------------------------------------
  // Error wrapping — KeyReleaseError and KeyVaultError pass through UNWRAPPED.
  // -------------------------------------------------------------------------

  private rethrow (err: unknown, method: string): never {
    if (err instanceof KeyReleaseError) throw err
    if (err instanceof KeyVaultError) throw err
    return rethrowHelper(err, 'KeyReleaseEngine', method)
  }
}
