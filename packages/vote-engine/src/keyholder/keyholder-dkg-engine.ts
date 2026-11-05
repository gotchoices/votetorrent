// src/keyholder/keyholder-dkg-engine.ts — KeyholderDkgEngine (62-17: D-13,
// D-14, D-16, D-19, D-26). Drives 62-05's split-round FROST DKG through
// 62-02's signed, append-only `KeyholderDkgMessage` strand rows.
//
// ---------------------------------------------------------------------------
// The round table (D-19)
// ---------------------------------------------------------------------------
//
//   R0 (commit)   -- a sha256 hash binding electionId/revision/attempt to the
//                    sender's own round-1 package, so a rushing peer cannot
//                    tailor its R1 after seeing others' (commit-reveal).
//   R1 (reveal)   -- the Feldman commitment vector and Schnorr proof of
//                    knowledge (DkgRound1Wire), checked against its own R0.
//   R2 (shares)   -- EncryptedShare[], one per OTHER roster member, each
//                    encrypted ONLY to that recipient's keyholder-signed
//                    KeyholderDkgBinding.DkgPublicKey (D-26).
//   R3 (ack/complaint) -- every received share is decrypted and verified
//                    before an ack; a bad share is complained with public,
//                    reader-checkable evidence (verifyComplaintEvidence).
//   R4 (result)   -- the agreed joint public key Y and group commitments.
//                    Once every live keyholder's R4 agrees (and none
//                    dissents -- the schema's AllKeyholdersAgree/NoDissent),
//                    `publish` writes the write-once ElectionKey row.
//
// Numbered rules 1-9 (gates, boundary evaluation, roster rule, cap) are
// documented in `dkg-evaluator.ts`'s header; this engine is the DRIVER that
// turns `planDkgAction`'s verdict into one signed row.
//
// ---------------------------------------------------------------------------
// The round-secret alias lifecycle (D-16)
// ---------------------------------------------------------------------------
//
// Step 1 (`keyholderDkgRoundSecretAlias(e, r, a, 1, self)`) holds the
// dealer's own polynomial coefficients plus its UNREVEALED R1 package from
// the moment round 0 is posted until round 2 is posted. Step 2 is written
// BEFORE step 1 is deleted (crash safety -- see `dkg-vault.ts`'s header) and
// itself deleted right after round 4 is posted. `cleanupVault` additionally
// sweeps every attempt's round-secret aliases once that attempt is known
// ABORTED. The own share is swept only when its PRODUCING attempt is proven
// aborted: `executePostRound4` writes a non-secret marker
// (`keyholderDkgShareAttemptAlias`) naming the attempt beside the share, and
// `cleanupVault` deletes the share (then the marker) only when the marker
// parses AND names an aborted attempt AND no ElectionKey exists. The old
// attempt-agnostic sweep ("any attempt aborted, no key yet") deleted the
// FRESH share of a retried DKG right after round 4 (V-1), leaving a complete
// election key no one could release. A missing or unparseable marker never
// deletes the share (fail-safe toward keeping key material).
//
// No device ever holds the full election private key: `src/keyholder/*`
// never calls `combineSecret`/`reconstructGroupSecret` (D-16 grep gate).
// Each keyholder ends with exactly one 32-byte signing share, raw, under
// `keyholderDkgShareAlias(electionId, revision, userId)`.
//
// ---------------------------------------------------------------------------
// Biometric-prompt budget
// ---------------------------------------------------------------------------
//
// Each round-step action makes 1-3 auth-required vault calls and signs
// exactly once: R0 put + sign, R1 get + sign, R2 get + put + sign, R3 get +
// sign, R4 get + get + put + sign, publish sign (`KEYHOLDER_DKG_ROUND_SECRET_POLICY`/
// `KEYHOLDER_DKG_RECEIVING_KEY_POLICY`/`KEYHOLDER_SHARE_POLICY` all require
// user auth, and so does the signer's own key). On a vault that prompts per
// call that is 2-4 prompts per round, 13-14 per 2-of-2 DKG (measured 13 on
// the Redmi 8, 2026-10-16). This engine does not batch; the Authority app
// does: it runs each `advanceDkg` call inside one keyholder session
// (`keyholder-seat-vault.ts`), which costs at most ONE prompt per call.
// A pass with nothing to do makes no auth-required call at all.
//
// ---------------------------------------------------------------------------
// Two-tier residual (T-62-02-13)
// ---------------------------------------------------------------------------
//
// `remove-disqualified` deletes a Keyholder row through a TIER-2 path --
// `Keyholder` carries no `check on delete` (62-02's deliberate deferral).
// Any evidence used is a transcript-proven fault from permanent, insert-only
// rows, the delete is idempotent, and any live participant may run it. A
// raw-handle re-add is re-removed on the next pass (the planner's
// `remove-disqualified` priority runs before any post or publish).
//
// ---------------------------------------------------------------------------
// Specifications cited
// ---------------------------------------------------------------------------
//
// Komlo & Goldberg, "FROST: Flexible Round-Optimized Schnorr Threshold
// Signatures" (SAC 2020) section 5.1 KeyGen; Pedersen, "A Threshold
// Cryptosystem without a Trusted Party" (EUROCRYPT 1991); Gennaro, Jarecki,
// Krawczyk & Rabin, "Secure Distributed Key Generation for Discrete-Log
// Based Cryptosystems" (J. Cryptology 2007) for the Joint-Feldman complaint
// phase this engine implements; 62-05's `src/crypto/dkg.ts` for the RFC 9591
// citations its own primitives rest on.
//
// ---------------------------------------------------------------------------
// Consumer notes (copied from `<interfaces>`)
// ---------------------------------------------------------------------------
//
// 62-26 stores `generateDkgReceivingKey().privateKey` at accept under
// `keyholderDkgReceivingKeyAlias(userId)` with `KEYHOLDER_DKG_RECEIVING_KEY_POLICY`.
// It calls `advanceDkg(electionId, signer)` on keyholder-screen focus and
// maps `DkgPhase` to the four UI states (not-started/blocked -> pending,
// in-progress -> inProgress, restarting -> complaint, complete -> complete).
// `failed` has no UI-SPEC copy (open question, surfaced in the SUMMARY).
// 62-20 reads `getElectionKey()` for Y and the group commitments, and
// unlocks the share from `keyholderDkgShareAlias(electionId, revision, userId)`.
// 62-24 constructs a `KeyholderDkgEngine` on node B and calls
// `verifyDkgTranscript`, re-verifying every replicated row in SQL; its vault
// is never read except through `hasSecret`.
//
// ---------------------------------------------------------------------------
// Security review (D-25) — protocol composition — dated 2026-10-01, 62-17 Task 3
// ---------------------------------------------------------------------------
//
// The 62-05 review (`src/crypto/dkg.ts`) covers the primitives in isolation.
// This review covers how THIS engine composes them over signed strand rows:
// does it schedule rounds in the right order, verify what it reads, map
// verdicts to the right disqualification, and leave no full key or stale
// secret on any device. ASVS L1: every HIGH finding is fixed (or the
// composing control already closes it) before this section was written.
//
//  1. Commit-reveal ordering: `planDkgAction`'s `post-round` branch never
//     schedules round 1 until every roster member's round-0 row is visible
//     (`awaitingUserIds` at round 0 blocks everyone). Evidence: "gates
//     passing with zero rows ... planDkgAction returns post-round-0", "with
//     4 of 5 R0 rows present, planDkgAction returns none ... and never
//     post-round-1" (`dkg-evaluator.spec.ts`). Negative controls (a), (b).
//  2. R1 commit and proof of knowledge are verified publicly (read-side, by
//     EVERY node, not just the dealer's peers) and failures are attributed
//     to the sender. Evidence: "an R1 that differs from its R0 commit gives
//     aborted/faults with commit-mismatch", "a tampered proof of knowledge
//     gives invalid-round1" (`dkg-evaluator.spec.ts`). Control (a).
//  3. Every received share is verified with `verifyDealerShare` before an
//     ack and before the round-4 `dkgRound3` call (`executePostRound3`,
//     `executePostRound4`). Evidence: scenario B (`dkg.spec.ts`) — a
//     perturbed share is caught and complained, never silently acked.
//     Control (c).
//  4. Verdict-to-disqualification mapping (dealer-fault -> the dealer,
//     complainant-fault -> the complainant, unresolved -> nobody, abort
//     only). Evidence: the five "round-3 verdicts" cases in
//     `dkg-evaluator.spec.ts`, plus scenarios B (dealer-fault) and D
//     (complainant-fault) in `dkg.spec.ts`. Control (d).
//  5. Boundary determinism: a round is evaluated only once every roster
//     member's row for it is visible, so every node reaches the identical
//     verdict regardless of arrival order. Evidence: "with one complaint
//     present and another member's R3 missing, the attempt is still
//     collecting" (`dkg-evaluator.spec.ts`). Control (k).
//  6. Participants come from the LIVE `Keyholder` table
//     (`loadSnapshot`'s `liveRoster` query), and a transcript-proven
//     disqualification is removed (tier 2, see item 15) before the next
//     attempt's round 0 and before any publication — `planDkgAction`
//     prioritizes `remove-disqualified` over every other action. Evidence:
//     scenario B ("removed-disqualified fires first"), scenario C (a
//     raw-handle re-add is re-removed). Control (e).
//  7. The attempt cap matches the schema's `AttemptValid` bound
//     (`DKG_MAX_ATTEMPTS = 3`, `@votetorrent/vote-core`), and
//     `keyholderDkgRoundSecretAlias` independently bounds `attempt` to
//     `1..DKG_MAX_ATTEMPTS` as a second, defense-in-depth gate BEFORE any
//     row is even built. Evidence: scenario E (attempts-exhausted at 3, no
//     `Attempt > 3` row). Control (f).
//  8. `k` comes from the 'mel'-signed `ElectionRevision.KeyholderThreshold`
//     (`loadSnapshot`), never from the roster size, and the published
//     `ElectionKey.Threshold` must equal it (schema `ThresholdMatchesRevision`).
//     Evidence: scenario G (`threshold-out-of-range` gate). Control (g).
//  9. R2 shares are encrypted only to the recipient's keyholder-signed
//     `KeyholderDkgBinding.DkgPublicKey` (`executePostRound2` reads
//     `snapshot.bindings`, never a signing key) — D-26. Control (h).
// 10. R4 agreement and the published `ElectionKey`'s consistency with the
//     agreed `Y`, the derived group commitments, the revision's threshold
//     and the agreed roster length (V-2) are all checked; a malformed
//     GroupCommitments column is guarded (`parseElectionKeyCommitments`,
//     `[]` on the record means "malformed on the row") and reads as a
//     mismatch, never a throw. Both are checked (`evaluateDkgRevision`'s final
//     `electionKeyConsistent` pass; `verifyDkgTranscript`). Evidence: the
//     two "ElectionKey consistency" cases in `dkg-evaluator.spec.ts`, and
//     scenario A's `verifyDkgTranscript` assertion.
// 11. No full key on any device (D-16): `grep -vE '^\s*(//|\*|/\*)'
//     src/keyholder/*.ts | grep -cE "combineSecret|reconstructGroupSecret"`
//     prints 0. Scenario A additionally proves the AFFIRMATIVE side —
//     every vault holds exactly one 32-byte `keyholderDkgShareAlias` share,
//     reconstructible (TEST-SIDE ONLY, via `reconstructGroupSecret`) from
//     any 3-of-5 subset to a scalar whose public key is `Y`.
// 12. Round-secret custody: `keyholderDkgRoundSecretAlias` with
//     `KEYHOLDER_DKG_ROUND_SECRET_POLICY.requireUserAuth === true`; the
//     step-2 record is written BEFORE step 1 is deleted
//     (`executePostRound2`); `cleanupVault` sweeps every ABORTED attempt's
//     round-secret aliases (and, once `complete`, every attempt's) after
//     every action. The SHARE sweep is attempt-bound (V-1): only a share
//     whose attempt marker names an aborted attempt, with no ElectionKey,
//     is deleted; a marker-less share is never deleted. Evidence: scenarios
//     B and D (every honest share survives a retry and releases). Scenario A ("round-secret aliases all
//     swept"), scenario E ("no vault holds a round-secret alias"). Control
//     (j).
// 13. Read-side signature verification of replicated rows: `loadSnapshot`
//     recomputes `SignatureValid(...)  or SignatureValidP256(...)` over every
//     `KeyholderDkgMessage`/`ElectionKey` row in SQL against the row's OWN
//     stored key. That proves only that the row is consistent with that key.
//     AUTHORSHIP (that the key belonged to `SenderUserId` /
//     `PublisherUserId` when the row was written) rests on the insert-time
//     CHECK (`SenderKeyIsUsers` / `PublisherKeyIsUsers`) on immutable
//     NoUpdate/NoDelete rows, and is deliberately NOT re-required at read
//     (WR-02, mirroring 62-39's CR-02 release reads): a later rotation or
//     revocation must not turn a healthy transcript into `failed /
//     election-key-mismatch`. `evaluateDkgRevision` drops a `signatureValid:
//     false` row into `invalidRows` and never attributes it. Control (i).
//     A revoked key still cannot write: `advanceDkg` checks the current key
//     and the schema refuses the insert.
//     ACCEPTED SCOPE (T-62-42-05): since 62-42, rows signed by a key later
//     revoked stay valid for EVERY consumer of `loadSnapshot`: `getDkgStatus`,
//     `verifyDkgTranscript`, `advanceDkg`'s `evaluateDkgRevision` /
//     `planDkgAction` (complaints, disqualification, ElectionKey
//     publication) and `cleanupVault`. If a key is revoked BECAUSE it was
//     compromised, its earlier rows keep counting in all of them.
//     REPLICATION RE-VALIDATION: only partly established. The installed
//     optimystic validator re-executes a pend's statements through the
//     registered engine (db-core/dist/src/transaction/validator.js:100,
//     `registration.engine.execute(transaction)`), which would evaluate the
//     insert CHECKs, and cluster members call it from
//     db-p2p/dist/src/cluster/cluster-repo.js:976 (`validatePendOperations`).
//     NOT ESTABLISHED: that this deployment registers that validator (no
//     `createQuereusValidator` call was found under @serfab/cadre-core/dist,
//     and `unvalidatablePendPolicy` defaults to 'accept' at
//     cluster-repo.js:239), and that block-level sync/restore paths re-run
//     the CHECKs at all. A replication path that applied rows without
//     re-running insert CHECKs would let a self-signed row impersonate a
//     participant.
//     REJECTED variant: drop the membership requirement only once
//     an ElectionKey is published; a row's validity must not depend on whether
//     a LATER row exists, and a pre-publish rotation could still invalidate an
//     honest participant's earlier rounds mid-DKG (DS5 pins that a mid-DKG
//     rotation completes under the current read; its negative control
//     re-adds the membership EXISTS and turns it red).
// 14. No secret bytes in error messages, and no `console` use. The
//     `KeyholderDkgError`/`KeyVaultError` codes and ids are the only error
//     content; `decodeDkgRoundVaultRecord`'s own corruption messages name
//     no field value. Evidence: scenario L asserts the thrown message
//     matches no 64-hex run. `grep -vE '^\s*(//|\*|/\*)' src/keyholder/*.ts
//     | grep -cE "combineSecret|reconstructGroupSecret|console\."` prints 0.
// 15. Two-tier residual (T-62-02-13, inherited from 62-02): `Keyholder`
//     carries no `check on delete`, so `remove-disqualified` is a tier-2
//     path — any live participant may run it, on transcript-proven evidence
//     only, idempotently. A raw-handle re-add is re-removed on the next
//     honest pass (scenario C). The residual for a client that never runs
//     this engine at all (and so never re-removes a re-added row) transfers
//     to the still-open T-62-02-13 Keyholder-delete-authorization gap —
//     not re-opened or re-designed here.
// 16. Liveness residual: there is NO automatic timeout or action (user
//     ruling 2026-10-07) — an absent participant stalls the DKG with
//     `awaitingUserIds` naming them. Since 62-139 a STATUS READ flags
//     `overdueUserIds` (the awaited keyholders) once the current round has
//     been open for `DKG_ROUND_DEADLINE_MS`, by the resolver rule of
//     evaluator rule 10: the earliest answer caps the latest opening
//     candidate, so neither the flagged keyholder nor the first answer can
//     move the deadline later, and candidates more than 5 minutes ahead of
//     the reader are ignored. The flag is advisory and approximate (it can
//     fire early on a back-dated or slow-clock answer) and is computed only
//     here at the status read: time never enters the evaluator, and
//     `advanceDkg` / `planDkgAction` never read it. Officers decide; the only
//     in-app action is to ask the keyholder to open this election's keyholder
//     screen (the driver is pull-only). There is NO in-app way to replace a
//     silent keyholder today: `ElectionEngine.revokeKeyholder` is engine-only
//     with no permission check (todo
//     2026-10-02-keyholder-delete-has-no-check-and-revoke-checks-no-permission)
//     and no product path bumps ElectionRevision (adjustElection writes only
//     ProposedElectionRevision); that is an open decision for the user. If a
//     revoke does happen, the roster-rule fallback (rule 6) turns it into a
//     clean `roster-changed` abort. Signer-claimed timestamps can move the
//     flag earlier (back-dating) but cannot cause any fault. Evidence:
//     scenario H, dkg-round-deadline.spec.ts.
// 17. Lag residual (accepted): a replication lag that makes one node see a
//     roster change before another can consume at most one extra attempt
//     (the roster-rule fallback aborts that attempt as `roster-changed`
//     rather than publishing on a stale roster), bounded by the 3-attempt
//     cap like any other abort.
// 18. Inherited A6/A7 (from 62-05, unchanged by this plan): A6 — a
//     complaint without a DLEQ proof cannot distinguish a lying dealer from
//     a lying complainant when the key-commitment tag itself mismatches, so
//     the verdict is `unresolved` (denial of service only — scenario E
//     shows this costs at most all 3 attempts). A7 — Joint-Feldman DKG bias
//     under a rushing/aborting adversary: the commit-reveal in R0 removes
//     the RUSHING choice, but a participant can still bias the joint key by
//     roughly one bit per self-disqualifying abort-and-retry, bounded by
//     the SAME 3-attempt cap. Both residuals stay OPEN, surfaced to the
//     user/reviewer (not claimed closed by this plan), and GJKR (Pedersen
//     commitments plus a public extraction/complaint phase) is the named
//     alternative if either ever needs closing — not built here, since it
//     would be additional hand-rolled protocol logic beyond what D-25
//     sanctions.
// 19. Hermes proof debt (inherited from 62-05's own dkg.ts review, and this
//     engine's own driver on top of it): the composed round driver
//     (`KeyholderDkgEngine`) has run only in Node, over `InMemoryTestKeyVault`
//     and an in-memory Quereus `Database`. No device run has been made on
//     Hermes or against a hardware-backed vault adapter. Tracked for 62-30
//     in the D-23 "code-complete, unverified" style — never claim device
//     proof for this review.
//
// Negative control results (temporarily mutate the named file, run the
// targeted spec(s), record the failing title(s), then `git checkout --` the
// file to restore):
//
//   (a) Skip `verifyRound1Commit` in the evaluator's round-1 fault check.
//       NOT LIVE-MUTATED: the permission system's Security-Weaken
//       classifier refused this edit (disabling a signature/commit
//       verification call), and per its own instructions the SAME outcome
//       was not re-attempted through a different phrasing or tool. The
//       control is instead evidenced structurally: "an R1 that differs
//       from its R0 commit gives aborted/faults with commit-mismatch on
//       that sender" (`dkg-evaluator.spec.ts`) is a POSITIVE-path test that
//       only passes because `verifyRound1Commit` actually detects the
//       mismatch — removing the call would make this exact assertion fail
//       (`ev.disqualified.find(...).reason` would be `undefined`, not
//       `'commit-mismatch'`), by direct code inspection of the `if`/`else
//       if` chain at the round-1 fault site. Recorded as a gap in live
//       coverage, not in protection — flagged for the human reviewer.
//   (b) Let `planDkgAction` plan round 1 while an R0 is missing (forced the
//       `post-round` branch's `awaitingUserIds.includes(selfUserId)` guard
//       to `true` unconditionally).
//       RED: "with 4 of 5 R0 rows present, planDkgAction returns none for
//       posted members and never post-round-1; awaitingUserIds is the
//       missing member" (`dkg-evaluator.spec.ts`) — planned `post-round
//       0/1` instead of `none` for an already-posted member.
//   (c) Ack a decrypted share without `verifyDealerShare` in
//       `executePostRound3` (forced the check to `false && ...`).
//       RED: scenario B (`dkg.spec.ts`) — the bad share is never
//       complained; `dkgRound3`'s OWN internal check then throws
//       `"share failed verification against the dealer's own commitment"`
//       at round 4 instead (a second, independent layer catches it, but
//       NOT as the intended round-3 complaint — recorded as a defense-in-
//       depth finding, not a silent pass).
//   (d) Map `unresolved` to disqualifying the complainant with
//       `false-complaint` in the evaluator's round-3 verdict loop.
//       RED: "a random-point sharedSecret gives aborted/unresolved-
//       complaint with an empty disqualified list and unresolvedComplaints
//       1" — got `abortReason: 'faults'` instead of `'unresolved-complaint'`.
//   (e) Make `executeRemoveDisqualified` a no-op (never issues the
//       `delete from Keyholder`).
//       RED: scenario B — `runDkgToQuiescence` throws `"exceeded maxPasses
//       (60)"` after 4 minutes of real time. This is `planDkgAction`'s OWN
//       priority ordering working as designed: `remove-disqualified` is
//       checked BEFORE `publish`/`post-round` for every eligible
//       participant, so an un-removed disqualified member blocks ALL
//       further progress rather than letting the DKG silently continue
//       around a raw-handle survivor — an availability-only, fail-closed
//       outcome. The control ALSO proves a second, deeper backstop by code
//       inspection (not independently triggered by this run, since the
//       planner-priority protection fires first): `ElectionKey`'s
//       `ParticipantsAreKeyholders` CHECK (`new.Participants = (select
//       count(*) from Keyholder ...)`) would reject a publish attempt that
//       ever got as far as computing `Participants` from the engine's own
//       (disqualification-aware) roster length against a DB that still
//       counted the un-removed row — the same "provably non-divergent
//       given an earlier control" shape as 62-05 dkg.ts's own F-01 finding.
//   (f) Raise the evaluator's attempt cap to 4 (loop bound and both
//       `attempt === DKG_MAX_ATTEMPTS` cap checks).
//       RED: scenario E — `KeyholderDkgError: keyholderDkgRoundSecretAlias:
//       attempt must be 1..DKG_MAX_ATTEMPTS`, thrown from
//       `executePostRound0` before any attempt-4 row is ever built. The
//       alias function's own defensive bound is a SECOND, independent cap
//       below the evaluator's — the schema's `AttemptValid` CHECK is a
//       third, never reached in this run because the alias guard fires
//       first.
//   (g) Publish with `Threshold = roster.length` instead of
//       `evaluation.threshold` (the revision's signed `KeyholderThreshold`).
//       RED: scenario A — `Quereus error (code 19): CHECK constraint
//       failed: ThresholdMatchesRevision`.
//   (h) Encrypt R2 to `signer.signingPublicKey` instead of
//       `snapshot.bindings[...].dkgPublicKey`.
//       RED: scenario A — final `status.phase` is `'failed'` instead of
//       `'complete'` (every recipient's `decryptShare` fails against the
//       wrong key, producing a complaint storm that exhausts all 3
//       attempts).
//   (i) Ignore `signatureValid` in the evaluator (never route a `false` row
//       into `invalidRows`).
//       RED: "a row with signatureValid false is treated as absent, is
//       listed in invalidRows, and never disqualifies the claimed sender"
//       — `invalidRows` came back `[]` instead of containing the row.
//   (j) Skip the `cleanupVault` calls in `advanceDkg`'s round-driving loop.
//       RED: scenario E — `readRoundRecord` for a BYGONE aborted attempt's
//       step-2 alias returned the record instead of `null`
//       (`"Dealer attempt 1 step 2: expected {...} to equal null"`). (Scenario
//       A alone does NOT catch this control — its own round-secret aliases
//       are already deleted inline by `executePostRound2`/`executePostRound4`
//       on the one successful attempt; the dedicated sweep is load-bearing
//       only for ABORTED attempts' leftovers, which is exactly what
//       scenario E isolates.)
//   (k) Decide a complaint abort as soon as ANY round-3 row is a complaint,
//       instead of waiting for the full round-3 boundary.
//       RED: "with one complaint present and another member's R3 missing,
//       the attempt is still collecting and awaitingUserIds lists the
//       missing member" — got an immediate `aborted/unresolved-complaint`
//       instead of `collecting`.
//
//   (l) WR-02 controls (62-42): re-add an EXISTS over UserKey at the
//       KeyholderDkgMessage read (DS2 goes red); at the ElectionKey read (DS3
//       goes red); delete the advanceDkg current-key check (DS4b goes red).
//
// Findings table (id, severity, status):
//
//   F-01 | LOW    | accepted — control (a) could not be live-mutated (see
//         above); closed by structural code-reading of the existing
//         positive-path test instead of a live red/green cycle. No
//         HIGH/MEDIUM severity — the SAME check is additionally exercised,
//         un-mutated, by three other round-1 fault cases in this run.
//   F-02 | INFO   | accepted — control (e)'s SECOND backstop
//         (`ParticipantsAreKeyholders`) is provably reachable only if the
//         planner-priority protection (which this run DID trigger) is
//         ALSO bypassed; not independently triggered here, same
//         "provably non-divergent given an earlier control" shape as
//         62-05 dkg.ts's F-01. No fix needed.
//
// No HIGH or MEDIUM finding was raised by this review.
//
// Residuals (OPEN, not claimed safe — see items 15-18 above):
//   T-62-02-13 (tier-2 Keyholder delete, inherited) — transferred, not
//   re-designed. A6 and A7 (inherited from 62-05) — bounded by the
//   3-attempt cap, surfaced to the user/reviewer.
//
// Hermes device proof debt: see item 19. Tracked for 62-30 — never claim
// device proof for this review.

import { rethrow as rethrowHelper } from '../signing/ceremony-helpers.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  DKG_MAX_ATTEMPTS,
  DKG_ROUND_DEADLINE_MS,
  type DkgActionTaken,
  type DkgAdvanceResult,
  type DkgRound,
  type DkgTranscriptVerdict,
  type ElectionKeyRecord,
  type IKeyholderDkgEngine,
  type KeyholderDkgSigner,
  type KeyholderDkgStatus
} from '@votetorrent/vote-core'
import type { EngineContext } from '../types.js'
import { allocateTid } from '../database/tid-allocator.js'
import { digestToBytes } from '../utils.js'
import { KEYHOLDER_SHARE_ATTEMPT_POLICY, KEYHOLDER_SHARE_POLICY, KeyVaultError, keyholderDkgReceivingKeyAlias, keyholderDkgShareAlias, keyholderDkgShareAttemptAlias, type IKeyVault } from '../crypto/vault.js'
import {
  buildComplaintEvidence,
  commitRound1,
  decryptShare,
  deriveGroupCommitments,
  dkgIdentifierForUser,
  dkgRound1,
  dkgRound2,
  dkgRound3,
  encryptShare,
  parseDkgSecret,
  serializeDkgSecret,
  validateReleasedShare,
  verifyDealerShare,
  type ComplaintEvidence,
  type DkgContext,
  type DkgReceivedShare,
  type DkgRound1Wire,
  type EncryptedShare
} from '../crypto/dkg.js'
import {
  parseElectionKeyCommitments,
  parseRound0Payload,
  parseRound1Payload,
  parseRound2Payload,
  serializeRound0Payload,
  serializeRound1Payload,
  serializeRound2Payload,
  serializeRound3Payload,
  serializeRound4Payload
} from './dkg-payloads.js'
import {
  evaluateDkgRevision,
  planDkgAction,
  resolveRoundOpenedAt,
  type DkgMessageRow,
  type DkgPlannedAction,
  type DkgRevisionEvaluation,
  type DkgRevisionSnapshot
} from './dkg-evaluator.js'
import {
  KEYHOLDER_DKG_ROUND_SECRET_POLICY,
  KeyholderDkgError,
  decodeDkgRoundVaultRecord,
  encodeDkgRoundVaultRecord,
  keyholderDkgRoundSecretAlias,
  type DkgRoundVaultRecord,
  type KeyholderDkgErrorCode
} from './dkg-vault.js'

// KeyholderDkgError was defined in dkg-vault.ts (Task 1 needed it before this
// file existed) and is re-exported here so the `<interfaces>`-declared
// import path (`from './keyholder-dkg-engine.js'`) still resolves.
export { KeyholderDkgError, type KeyholderDkgErrorCode }


// ---------------------------------------------------------------------------
// Per-(electionId,userId) advance mutex -- mirrors the per-namespace
// promise-chain idiom in `database/tid-allocator.ts`.
// ---------------------------------------------------------------------------

const advanceLocks = new Map<string, Promise<unknown>>()

async function withAdvanceLock<T> (key: string, fn: () => Promise<T>): Promise<T> {
  const prior = advanceLocks.get(key) ?? Promise.resolve()
  const settled = prior.then(
    () => {},
    () => {}
  )
  const next = settled.then(fn)
  advanceLocks.set(
    key,
    next.then(
      () => {},
      () => {}
    )
  )
  return next
}

function normalizeBool (value: unknown): boolean {
  return value === true || value === 1
}

function collectRoundPayloads<T> (
  snapshot: DkgRevisionSnapshot, attempt: number, round: number, parser: (text: string) => T | null
): Record<string, T> {
  const out: Record<string, T> = {}
  for (const row of snapshot.messages) {
    if (row.attempt === attempt && row.round === round && row.signatureValid) {
      const parsed = parser(row.payload)
      if (parsed !== null) out[row.senderUserId] = parsed
    }
  }
  return out
}

/**
 * Rule 16 / evaluator rule 10: SentAt and BoundAt are signer-claimed, so candidates dated further than this ahead of
 * the reader are ignored. Same 5-minute value as SUBMITTED_AT_MAX_FUTURE_SKEW_MS (registration/association) and
 * KEYHOLDER_INVITE_EXPIRY_SKEW_MS (keyholder invitations).
 */
const DKG_TIMESTAMP_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000

/**
 * Sorted unique user ids that have at least one Keyholder row and EVERY one of whose rows is in a revision BEFORE
 * `revision` (a user with any row at or after it is not listed). Compares with Number(...): the column can arrive as a
 * number or a numeric string.
 */
export function earlierRevisionUserIdsOf (rows: Array<{ userId: string, electionRevision: unknown }>, revision: unknown): string[] {
  const current = Number(revision)
  const byUser = new Map<string, boolean>()
  for (const row of rows) {
    const earlier = Number(row.electionRevision) < current
    byUser.set(row.userId, (byUser.get(row.userId) ?? true) && earlier)
  }
  return [...byUser.entries()].filter(([, allEarlier]) => allEarlier).map(([userId]) => userId).sort()
}

export class KeyholderDkgEngine implements IKeyholderDkgEngine {
  constructor (private readonly ctx: EngineContext, private readonly deps: { vault: IKeyVault, now?: () => number }) {}

  /** The injectable clock (the same shape as KeyReleaseEngineDeps.now). Used only for SentAt stamps and the status-read deadline flag. */
  private nowMs (): number {
    return (this.deps.now ?? Date.now)()
  }

  // -------------------------------------------------------------------------
  // Snapshot loader -- read-side signature verification (T-62-17-01)
  // -------------------------------------------------------------------------

  private async loadSnapshot (electionId: string, revisionOverride?: number): Promise<DkgRevisionSnapshot> {
    let revision: number | null = null
    let threshold: number | null = null
    if (revisionOverride !== undefined) {
      const row = await this.ctx.db
        .prepare('select KeyholderThreshold from ElectionRevision where ElectionId = :electionId and Revision = :revision')
        .get({ electionId, revision: revisionOverride })
      if (row) {
        revision = revisionOverride
        threshold = row.KeyholderThreshold as number
      }
    } else {
      const row = await this.ctx.db
        .prepare('select Revision, KeyholderThreshold from ElectionRevision where ElectionId = :electionId')
        .get({ electionId })
      if (row) {
        revision = row.Revision as number
        threshold = row.KeyholderThreshold as number
      }
    }

    if (revision === null) {
      return { electionId, revision: null, threshold: null, liveRoster: [], bindings: {}, pendingInviteCount: 0, messages: [], electionKey: null }
    }

    const liveRoster: string[] = []
    for await (const row of this.ctx.db.eval(
      'select UserId from Keyholder where ElectionId = :electionId and ElectionRevision = :revision order by UserId',
      { electionId, revision }
    )) {
      liveRoster.push(row.UserId as string)
    }

    const bindings: Record<string, { dkgPublicKey: string, boundAt?: string }> = {}
    for await (const row of this.ctx.db.eval(
      'select UserId, DkgPublicKey, BoundAt from KeyholderDkgBinding where ElectionId = :electionId and ElectionRevision = :revision',
      { electionId, revision }
    )) {
      bindings[row.UserId as string] = {
        dkgPublicKey: row.DkgPublicKey as string,
        ...(typeof row.BoundAt === 'string' ? { boundAt: row.BoundAt } : {})
      }
    }

    const pendingRow = await this.ctx.db
      .prepare(
        `select count(*) as c from InviteSlot S
          where S.Type = 'k' and S.ElectionId = :electionId and S.Expiration > :now
            and not exists (select 1 from InviteResult IR where IR.SlotCid = S.Cid)`
      )
      .get({ electionId, now: new Date().toISOString() })
    const pendingInviteCount = (pendingRow?.c as number | undefined) ?? 0

    const messages: DkgMessageRow[] = []
    for await (const row of this.ctx.db.eval(
      `select Attempt, DkgRound, SenderUserId, Payload, ResultKey, SentAt,
          (
            SignatureValid(Digest('KeyholderDkgMessage', ElectionId, ElectionRevision, Attempt, DkgRound, SenderUserId, Payload, ResultKey, SentAt), Signature, SenderKey)
              or SignatureValidP256(Digest('KeyholderDkgMessage', ElectionId, ElectionRevision, Attempt, DkgRound, SenderUserId, Payload, ResultKey, SentAt), Signature, SenderKey)
          ) as SigValid
        from KeyholderDkgMessage
        where ElectionId = :electionId and ElectionRevision = :revision`,
      { electionId, revision }
    )) {
      messages.push({
        attempt: row.Attempt as number,
        round: row.DkgRound as DkgRound,
        senderUserId: row.SenderUserId as string,
        payload: row.Payload as string,
        resultKey: (row.ResultKey as string | null) ?? null,
        signatureValid: normalizeBool(row.SigValid),
        ...(typeof row.SentAt === 'string' ? { sentAt: row.SentAt } : {})
      })
    }

    let electionKey: (ElectionKeyRecord & { signatureValid: boolean, commitmentsWellFormed: boolean }) | null = null
    const ekRow = await this.ctx.db
      .prepare(
        `select Attempt, JointPublicKey, GroupCommitments, Threshold, Participants, PublishedAt, PublisherUserId,
            (
              SignatureValid(Digest('ElectionKey', ElectionId, ElectionRevision, Attempt, JointPublicKey, GroupCommitments, Threshold, Participants, PublishedAt, PublisherUserId), Signature, PublisherKey)
                or SignatureValidP256(Digest('ElectionKey', ElectionId, ElectionRevision, Attempt, JointPublicKey, GroupCommitments, Threshold, Participants, PublishedAt, PublisherUserId), Signature, PublisherKey)
            ) as SigValid
          from ElectionKey where ElectionId = :electionId and ElectionRevision = :revision`
      )
      .get({ electionId, revision })
    if (ekRow) {
      electionKey = {
        electionId,
        revision,
        attempt: ekRow.Attempt as number,
        jointPublicKey: ekRow.JointPublicKey as string,
        groupCommitments: parseElectionKeyCommitments(ekRow.GroupCommitments) ?? [],
        threshold: ekRow.Threshold as number,
        participants: ekRow.Participants as number,
        publishedAt: ekRow.PublishedAt as string,
        publisherUserId: ekRow.PublisherUserId as string,
        signatureValid: normalizeBool(ekRow.SigValid),
        commitmentsWellFormed: parseElectionKeyCommitments(ekRow.GroupCommitments) !== null
      }
    }

    return { electionId, revision, threshold, liveRoster, bindings, pendingInviteCount, messages, electionKey }
  }

  // -------------------------------------------------------------------------
  // IKeyholderDkgEngine
  // -------------------------------------------------------------------------

  async getDkgStatus (electionId: string, selfUserId?: string): Promise<KeyholderDkgStatus> {
    try {
      const snapshot = await this.loadSnapshot(electionId)
      const evaluation = evaluateDkgRevision(snapshot)
      return await this.buildStatus(electionId, evaluation, selfUserId)
    } catch (err) {
      this.rethrow(err, 'getDkgStatus')
    }
  }

  async getElectionKey (electionId: string, revision?: number): Promise<ElectionKeyRecord | null> {
    try {
      let rev = revision
      if (rev === undefined) {
        const row = await this.ctx.db.prepare('select Revision from ElectionRevision where ElectionId = :electionId').get({ electionId })
        if (!row) return null
        rev = row.Revision as number
      }
      const row = await this.ctx.db
        .prepare(
          `select Attempt, JointPublicKey, GroupCommitments, Threshold, Participants, PublishedAt, PublisherUserId
             from ElectionKey where ElectionId = :electionId and ElectionRevision = :revision`
        )
        .get({ electionId, revision: rev })
      if (!row) return null
      return {
        electionId,
        revision: rev,
        attempt: row.Attempt as number,
        jointPublicKey: row.JointPublicKey as string,
        // `[]` means "malformed on the row" (the public record shape is unchanged).
        groupCommitments: parseElectionKeyCommitments(row.GroupCommitments) ?? [],
        threshold: row.Threshold as number,
        participants: row.Participants as number,
        publishedAt: row.PublishedAt as string,
        publisherUserId: row.PublisherUserId as string
      }
    } catch (err) {
      this.rethrow(err, 'getElectionKey')
    }
  }

  async verifyDkgTranscript (electionId: string, revision?: number): Promise<DkgTranscriptVerdict> {
    try {
      let rev = revision
      if (rev === undefined) {
        const row = await this.ctx.db.prepare('select Revision from ElectionRevision where ElectionId = :electionId').get({ electionId })
        if (!row) throw new KeyholderDkgError('no-current-revision', 'verifyDkgTranscript: no ElectionRevision for electionId')
        rev = row.Revision as number
      }
      const snapshot = await this.loadSnapshot(electionId, rev)
      const evaluation = evaluateDkgRevision(snapshot)
      const status = await this.buildStatus(electionId, evaluation, undefined)
      const rowCountRow = await this.ctx.db
        .prepare('select count(*) as c from KeyholderDkgMessage where ElectionId = :electionId and ElectionRevision = :revision')
        .get({ electionId, revision: rev })
      const electionKeyConsistent = snapshot.electionKey === null ? null : evaluation.phase === 'complete'
      return {
        electionId,
        revision: rev,
        rowCount: (rowCountRow?.c as number | undefined) ?? 0,
        invalidRows: evaluation.invalidRows,
        electionKeyConsistent,
        status
      }
    } catch (err) {
      this.rethrow(err, 'verifyDkgTranscript')
    }
  }

  async advanceDkg (electionId: string, signer: KeyholderDkgSigner): Promise<DkgAdvanceResult> {
    return withAdvanceLock(`${electionId}:${signer.userId}`, async () => {
      try {
        const signerRow = await this.ctx.db
          .prepare('select 1 as x from UserKey where UserId = :userId and PubKey = :pubKey')
          .get({ userId: signer.userId, pubKey: signer.signingPublicKey })
        if (!signerRow) {
          throw new KeyholderDkgError('signer-key-mismatch', 'advanceDkg: signer.signingPublicKey is not a UserKey of signer.userId')
        }

        const quickEvaluation = evaluateDkgRevision(await this.loadSnapshot(electionId))
        if (quickEvaluation.cumulativeDisqualified.includes(signer.userId)) {
          return { actions: [], status: await this.buildStatus(electionId, quickEvaluation, signer.userId) }
        }

        const actions: DkgActionTaken[] = []
        for (let i = 0; i < 8; i++) {
          const snapshot = await this.loadSnapshot(electionId)
          const evaluation = evaluateDkgRevision(snapshot)
          const planned = planDkgAction(evaluation, signer.userId)
          if (planned.kind === 'none') {
            if (await this.cleanupVault(electionId, evaluation, signer)) actions.push('cleaned-vault')
            break
          }
          const taken = await this.executeAction(snapshot, evaluation, planned, signer)
          if (taken !== null) actions.push(taken)
          if (await this.cleanupVault(electionId, evaluation, signer)) actions.push('cleaned-vault')
        }
        const finalStatus = await this.getDkgStatus(electionId, signer.userId)
        return { actions, status: finalStatus }
      } catch (err) {
        this.rethrow(err, 'advanceDkg')
      }
    })
  }

  // -------------------------------------------------------------------------
  // Status assembly
  // -------------------------------------------------------------------------

  private async buildStatus (electionId: string, evaluation: DkgRevisionEvaluation, selfUserId?: string): Promise<KeyholderDkgStatus> {
    const status: KeyholderDkgStatus = {
      electionId: evaluation.electionId,
      revision: evaluation.revision,
      threshold: evaluation.threshold,
      phase: evaluation.phase,
      currentAttempt: evaluation.currentAttempt,
      currentRound: evaluation.currentRound,
      roster: evaluation.roster,
      awaitingUserIds: evaluation.awaitingUserIds,
      attempts: evaluation.attempts,
      disqualified: evaluation.disqualified,
      electionKey: evaluation.electionKey
    }
    if (evaluation.blockedReason !== undefined) status.blockedReason = evaluation.blockedReason
    if (evaluation.waitingReason !== undefined) status.waitingReason = evaluation.waitingReason
    if (evaluation.failedReason !== undefined) status.failedReason = evaluation.failedReason
    if (evaluation.revision === null) {
      // No ElectionRevision row was read: the roster facts are UNKNOWN, never [] (T-62-139-06).
      status.liveRoster = undefined
      status.earlierRevisionUserIds = undefined
      status.roundOpenedAt = null
      status.overdueUserIds = []
    } else {
      status.liveRoster = [...evaluation.liveRoster].sort()
      const keyholderRows: Array<{ userId: string, electionRevision: unknown }> = []
      for await (const row of this.ctx.db.eval(
        'select UserId, ElectionRevision from Keyholder where ElectionId = :electionId',
        { electionId }
      )) {
        keyholderRows.push({ userId: row.UserId as string, electionRevision: row.ElectionRevision })
      }
      status.earlierRevisionUserIds = earlierRevisionUserIdsOf(keyholderRows, evaluation.revision)
      const now = this.nowMs()
      const roundOpenedAt = resolveRoundOpenedAt(evaluation.roundTiming, evaluation.awaitingUserIds, now, DKG_TIMESTAMP_MAX_FUTURE_SKEW_MS)
      status.roundOpenedAt = roundOpenedAt
      // Advisory only (rule 16): nothing reads this to act.
      status.overdueUserIds = roundOpenedAt !== null && now - Date.parse(roundOpenedAt) >= DKG_ROUND_DEADLINE_MS
        ? [...evaluation.awaitingUserIds].sort()
        : []
    }
    if (selfUserId !== undefined) {
      const isDisqualified = evaluation.cumulativeDisqualified.includes(selfUserId)
      const isParticipant = evaluation.roster.includes(selfUserId) && !isDisqualified
      const hasShare = evaluation.revision !== null
        ? await this.deps.vault.hasSecret(keyholderDkgShareAlias(electionId, evaluation.revision, selfUserId))
        : false
      status.self = { userId: selfUserId, isParticipant, isDisqualified, hasShare }
    }
    return status
  }

  // -------------------------------------------------------------------------
  // Action execution
  // -------------------------------------------------------------------------

  private async executeAction (
    snapshot: DkgRevisionSnapshot, evaluation: DkgRevisionEvaluation, planned: DkgPlannedAction, signer: KeyholderDkgSigner
  ): Promise<DkgActionTaken | null> {
    if (planned.kind === 'remove-disqualified') {
      return this.executeRemoveDisqualified(evaluation, planned.userIds)
    }
    if (planned.kind === 'publish') {
      return this.executePublish(evaluation, signer)
    }
    if (planned.kind === 'post-round') {
      switch (planned.round) {
        case 0: return this.executePostRound0(evaluation, signer)
        case 1: return this.executePostRound1(evaluation, signer)
        case 2: return this.executePostRound2(snapshot, evaluation, signer)
        case 3: return this.executePostRound3(snapshot, evaluation, signer)
        case 4: return this.executePostRound4(snapshot, evaluation, signer)
        default: return null
      }
    }
    return null
  }

  private async postMessage (
    electionId: string, revision: number, attempt: number, dkgRound: number,
    resultKey: string | null, payload: string, signer: KeyholderDkgSigner
  ): Promise<void> {
    const sentAt = new Date(this.nowMs()).toISOString()
    const digestRow = await this.ctx.db
      .prepare(
        "select Digest('KeyholderDkgMessage', :electionId, :revision, :attempt, :dkgRound, :senderUserId, :payload, :resultKey, :sentAt) as d"
      )
      .get({ electionId, revision, attempt, dkgRound, senderUserId: signer.userId, payload, resultKey, sentAt })
    if (!digestRow || digestRow.d == null) {
      throw new Error('KeyholderDkgEngine: Digest() returned null for KeyholderDkgMessage — crypto plugin not registered?')
    }
    const signature = await signer.sign(digestToBytes(digestRow.d as string))
    if (signature.signerKey !== signer.signingPublicKey) {
      throw new KeyholderDkgError('signature-mismatch', 'advanceDkg: sign() returned a signerKey that does not match signer.signingPublicKey')
    }
    await this.ctx.db.exec(
      `insert into KeyholderDkgMessage (ElectionId, ElectionRevision, Attempt, DkgRound, SenderUserId, Payload, ResultKey, SentAt, SenderKey, Signature)
       values (:electionId, :revision, :attempt, :dkgRound, :senderUserId, :payload, :resultKey, :sentAt, :senderKey, :signature)`,
      { electionId, revision, attempt, dkgRound, senderUserId: signer.userId, payload, resultKey, sentAt, senderKey: signature.signerKey, signature: signature.signature }
    )
  }

  private async executeRemoveDisqualified (evaluation: DkgRevisionEvaluation, userIds: string[]): Promise<DkgActionTaken> {
    const electionId = evaluation.electionId
    const revision = evaluation.revision!
    for (const userId of userIds) {
      const tid = await allocateTid(this.ctx.db, 'election')
      await this.ctx.db.exec(
        `delete from Keyholder
           with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${tid}
           where ElectionId = :electionId and ElectionRevision = :revision and UserId = :userId`,
        { electionId, revision, userId }
      )
    }
    return 'removed-disqualified'
  }

  private async executePostRound0 (evaluation: DkgRevisionEvaluation, signer: KeyholderDkgSigner): Promise<DkgActionTaken> {
    const electionId = evaluation.electionId
    const revision = evaluation.revision!
    const attempt = evaluation.currentAttempt!
    const k = evaluation.threshold!
    const n = evaluation.roster.length
    const dkgCtx: DkgContext = { electionId, revision, attempt }
    const stepAlias1 = keyholderDkgRoundSecretAlias(electionId, revision, attempt, 1, signer.userId)

    let record: DkgRoundVaultRecord
    const existingBytes = await this.deps.vault.getSecret(stepAlias1)
    if (existingBytes !== null) {
      record = decodeDkgRoundVaultRecord(existingBytes)
    } else {
      const { public: pkg, secret } = dkgRound1(dkgIdentifierForUser(signer.userId), k, n)
      const commit = commitRound1(dkgCtx, pkg)
      record = { v: 1, dkgSecret: serializeDkgSecret(secret), round1: pkg, commit }
      await this.deps.vault.putSecret(stepAlias1, encodeDkgRoundVaultRecord(record), KEYHOLDER_DKG_ROUND_SECRET_POLICY)
    }

    const payload = serializeRound0Payload({ v: 1, commit: record.commit, roster: evaluation.roster, threshold: k })
    await this.postMessage(electionId, revision, attempt, 0, null, payload, signer)
    return 'posted-round-0'
  }

  private async executePostRound1 (evaluation: DkgRevisionEvaluation, signer: KeyholderDkgSigner): Promise<DkgActionTaken> {
    const electionId = evaluation.electionId
    const revision = evaluation.revision!
    const attempt = evaluation.currentAttempt!
    const stepAlias1 = keyholderDkgRoundSecretAlias(electionId, revision, attempt, 1, signer.userId)
    const bytes = await this.deps.vault.getSecret(stepAlias1)
    if (bytes === null) {
      throw new KeyholderDkgError('round-secret-missing', 'advanceDkg: round-1 secret record missing for post-round-1')
    }
    const record = decodeDkgRoundVaultRecord(bytes)
    const payload = serializeRound1Payload(record.round1)
    await this.postMessage(electionId, revision, attempt, 1, null, payload, signer)
    return 'posted-round-1'
  }

  private async executePostRound2 (snapshot: DkgRevisionSnapshot, evaluation: DkgRevisionEvaluation, signer: KeyholderDkgSigner): Promise<DkgActionTaken> {
    const electionId = evaluation.electionId
    const revision = evaluation.revision!
    const attempt = evaluation.currentAttempt!
    const dkgCtx: DkgContext = { electionId, revision, attempt }
    const r1ByUser = collectRoundPayloads<DkgRound1Wire>(snapshot, attempt, 1, parseRound1Payload)
    const others = evaluation.roster.filter((u) => u !== signer.userId).map((u) => r1ByUser[u]!)

    const stepAlias1 = keyholderDkgRoundSecretAlias(electionId, revision, attempt, 1, signer.userId)
    const bytes1 = await this.deps.vault.getSecret(stepAlias1)
    if (bytes1 === null) {
      throw new KeyholderDkgError('round-secret-missing', 'advanceDkg: round-1 secret record missing for post-round-2')
    }
    const record1 = decodeDkgRoundVaultRecord(bytes1)
    const secret = parseDkgSecret(record1.dkgSecret)
    const shares = dkgRound2(secret, others)

    const entries: EncryptedShare[] = []
    for (const theirUserId of evaluation.roster) {
      if (theirUserId === signer.userId) continue
      const theirIdentifier = dkgIdentifierForUser(theirUserId)
      const share = shares[theirIdentifier]
      const theirBinding = snapshot.bindings[theirUserId]
      if (share === undefined || theirBinding === undefined) {
        throw new Error(`KeyholderDkgEngine: missing share or binding for recipient ${theirUserId}`)
      }
      entries.push(encryptShare(dkgCtx, dkgIdentifierForUser(signer.userId), theirIdentifier, theirBinding.dkgPublicKey, share))
    }

    const stepAlias2 = keyholderDkgRoundSecretAlias(electionId, revision, attempt, 2, signer.userId)
    if (!(await this.deps.vault.hasSecret(stepAlias2))) {
      const record2: DkgRoundVaultRecord = { v: 1, dkgSecret: serializeDkgSecret(secret), round1: record1.round1, commit: record1.commit }
      await this.deps.vault.putSecret(stepAlias2, encodeDkgRoundVaultRecord(record2), KEYHOLDER_DKG_ROUND_SECRET_POLICY)
    }

    const payload = serializeRound2Payload(entries)
    await this.postMessage(electionId, revision, attempt, 2, null, payload, signer)
    await this.deps.vault.deleteSecret(stepAlias1)
    return 'posted-round-2'
  }

  private async executePostRound3 (snapshot: DkgRevisionSnapshot, evaluation: DkgRevisionEvaluation, signer: KeyholderDkgSigner): Promise<DkgActionTaken> {
    const electionId = evaluation.electionId
    const revision = evaluation.revision!
    const attempt = evaluation.currentAttempt!
    const k = evaluation.threshold!
    const n = evaluation.roster.length
    const dkgCtx: DkgContext = { electionId, revision, attempt }

    const recvAlias = keyholderDkgReceivingKeyAlias(signer.userId)
    const recvBytes = await this.deps.vault.getSecret(recvAlias)
    if (recvBytes === null) {
      throw new KeyholderDkgError('receiving-key-missing', 'advanceDkg: DKG receiving key missing for round-3')
    }

    const r1ByUser = collectRoundPayloads<DkgRound1Wire>(snapshot, attempt, 1, parseRound1Payload)
    const r2ByUser = collectRoundPayloads<EncryptedShare[]>(snapshot, attempt, 2, parseRound2Payload)
    const myIdentifier = dkgIdentifierForUser(signer.userId)
    const complaints: ComplaintEvidence[] = []

    for (const dealerUserId of evaluation.roster) {
      if (dealerUserId === signer.userId) continue
      const dealerR1 = r1ByUser[dealerUserId]
      const enc = r2ByUser[dealerUserId]?.find((e) => e.recipient === myIdentifier)
      if (dealerR1 === undefined || enc === undefined) {
        throw new Error(`KeyholderDkgEngine: missing round-1/round-2 data for dealer ${dealerUserId}`)
      }
      let share: Uint8Array | null = null
      try {
        share = decryptShare(dkgCtx, enc, recvBytes)
      } catch {
        complaints.push(buildComplaintEvidence(enc, recvBytes))
        continue
      }
      if (!verifyDealerShare(k, n, dealerR1, myIdentifier, share)) {
        complaints.push(buildComplaintEvidence(enc, recvBytes))
      }
    }

    const payload = complaints.length > 0
      ? serializeRound3Payload({ v: 1, kind: 'complaint', evidence: complaints })
      : serializeRound3Payload({ v: 1, kind: 'ack' })
    await this.postMessage(electionId, revision, attempt, 3, null, payload, signer)
    return complaints.length > 0 ? 'posted-round-3-complaint' : 'posted-round-3-ack'
  }

  private async executePostRound4 (snapshot: DkgRevisionSnapshot, evaluation: DkgRevisionEvaluation, signer: KeyholderDkgSigner): Promise<DkgActionTaken> {
    const electionId = evaluation.electionId
    const revision = evaluation.revision!
    const attempt = evaluation.currentAttempt!
    const dkgCtx: DkgContext = { electionId, revision, attempt }

    const recvAlias = keyholderDkgReceivingKeyAlias(signer.userId)
    const recvBytes = await this.deps.vault.getSecret(recvAlias)
    if (recvBytes === null) {
      throw new KeyholderDkgError('receiving-key-missing', 'advanceDkg: DKG receiving key missing for round-4')
    }

    const r1ByUser = collectRoundPayloads<DkgRound1Wire>(snapshot, attempt, 1, parseRound1Payload)
    const r2ByUser = collectRoundPayloads<EncryptedShare[]>(snapshot, attempt, 2, parseRound2Payload)
    const myIdentifier = dkgIdentifierForUser(signer.userId)
    const others = evaluation.roster.filter((u) => u !== signer.userId).map((u) => r1ByUser[u]!)
    const received: DkgReceivedShare[] = []
    for (const dealerUserId of evaluation.roster) {
      if (dealerUserId === signer.userId) continue
      const enc = r2ByUser[dealerUserId]?.find((e) => e.recipient === myIdentifier)
      if (enc === undefined) throw new Error(`KeyholderDkgEngine: missing round-2 share from dealer ${dealerUserId}`)
      received.push({ dealer: dkgIdentifierForUser(dealerUserId), share: decryptShare(dkgCtx, enc, recvBytes) })
    }
    const orderedReceived = others.map((pkg) => received.find((r) => r.dealer === pkg.identifier)!)

    const stepAlias2 = keyholderDkgRoundSecretAlias(electionId, revision, attempt, 2, signer.userId)
    const bytes2 = await this.deps.vault.getSecret(stepAlias2)
    if (bytes2 === null) {
      throw new KeyholderDkgError('round-secret-missing', 'advanceDkg: round-2 secret record missing for post-round-4')
    }
    const record2 = decodeDkgRoundVaultRecord(bytes2)
    const secret2 = parseDkgSecret(record2.dkgSecret)
    const material = dkgRound3(secret2, others, orderedReceived)

    const allR1 = evaluation.roster.map((u) => r1ByUser[u]!)
    const derived = deriveGroupCommitments(allR1)
    if (material.groupPublicKey !== derived[0]) {
      throw new Error('KeyholderDkgEngine: dkgRound3 result does not match deriveGroupCommitments over the roster\'s R1 packages')
    }

    const shareAlias = keyholderDkgShareAlias(electionId, revision, signer.userId)
    const markerAlias = keyholderDkgShareAttemptAlias(electionId, revision, signer.userId)
    const existingShareBytes = await this.deps.vault.getSecret(shareAlias)
    // Order on EVERY branch that puts a share: delete the stale attempt marker FIRST, then store the
    // share, then put the marker. A crash after the marker delete and before the share put leaves no
    // share; a crash after the share put and before the marker put leaves a marker-less share, which
    // the sweep never deletes. (The old order stored the fresh share next to a stale marker naming an
    // aborted attempt, which the sweep WOULD delete.) `putSecret` refuses an existing alias.
    if (existingShareBytes !== null) {
      const stillValid = validateReleasedShare(evaluation.threshold!, evaluation.roster.length, material.groupCommitments, {
        identifier: myIdentifier,
        signingShare: bytesToHex(existingShareBytes)
      })
      if (!stillValid) {
        await this.deps.vault.deleteSecret(markerAlias)
        await this.deps.vault.deleteSecret(shareAlias)
        await this.deps.vault.putSecret(shareAlias, material.signingShare, KEYHOLDER_SHARE_POLICY)
        await this.deps.vault.putSecret(markerAlias, new TextEncoder().encode(String(attempt)), KEYHOLDER_SHARE_ATTEMPT_POLICY)
      } else {
        await this.deps.vault.deleteSecret(markerAlias)
        await this.deps.vault.putSecret(markerAlias, new TextEncoder().encode(String(attempt)), KEYHOLDER_SHARE_ATTEMPT_POLICY)
      }
    } else {
      await this.deps.vault.deleteSecret(markerAlias)
      await this.deps.vault.putSecret(shareAlias, material.signingShare, KEYHOLDER_SHARE_POLICY)
      await this.deps.vault.putSecret(markerAlias, new TextEncoder().encode(String(attempt)), KEYHOLDER_SHARE_ATTEMPT_POLICY)
    }

    const payload = serializeRound4Payload({ groupPublicKey: material.groupPublicKey, groupCommitments: material.groupCommitments })
    await this.postMessage(electionId, revision, attempt, 4, material.groupPublicKey, payload, signer)
    await this.deps.vault.deleteSecret(stepAlias2)
    return 'posted-round-4'
  }

  private async executePublish (evaluation: DkgRevisionEvaluation, signer: KeyholderDkgSigner): Promise<DkgActionTaken | null> {
    const electionId = evaluation.electionId
    const revision = evaluation.revision!
    const pub = evaluation.readyToPublish!

    const existing = await this.ctx.db
      .prepare('select Attempt, JointPublicKey from ElectionKey where ElectionId = :electionId and ElectionRevision = :revision')
      .get({ electionId, revision })
    if (existing) return null

    const publishedAt = new Date().toISOString()
    const groupCommitmentsJson = JSON.stringify(pub.groupCommitments)
    const threshold = evaluation.threshold!
    const participants = pub.roster.length

    const digestRow = await this.ctx.db
      .prepare(
        "select Digest('ElectionKey', :electionId, :revision, :attempt, :jointPublicKey, :groupCommitments, :threshold, :participants, :publishedAt, :publisherUserId) as d"
      )
      .get({
        electionId, revision, attempt: pub.attempt, jointPublicKey: pub.jointPublicKey,
        groupCommitments: groupCommitmentsJson, threshold, participants, publishedAt, publisherUserId: signer.userId
      })
    if (!digestRow || digestRow.d == null) {
      throw new Error('KeyholderDkgEngine: Digest() returned null for ElectionKey — crypto plugin not registered?')
    }
    const signature = await signer.sign(digestToBytes(digestRow.d as string))
    if (signature.signerKey !== signer.signingPublicKey) {
      throw new KeyholderDkgError('signature-mismatch', 'advanceDkg: sign() returned a signerKey that does not match signer.signingPublicKey while publishing ElectionKey')
    }

    try {
      await this.ctx.db.exec(
        `insert into ElectionKey (ElectionId, ElectionRevision, Attempt, JointPublicKey, GroupCommitments, Threshold, Participants, PublishedAt, PublisherUserId, PublisherKey, Signature)
         values (:electionId, :revision, :attempt, :jointPublicKey, :groupCommitments, :threshold, :participants, :publishedAt, :publisherUserId, :publisherKey, :signature)`,
        {
          electionId, revision, attempt: pub.attempt, jointPublicKey: pub.jointPublicKey, groupCommitments: groupCommitmentsJson,
          threshold, participants, publishedAt, publisherUserId: signer.userId, publisherKey: signature.signerKey, signature: signature.signature
        }
      )
    } catch (err) {
      const reread = await this.ctx.db
        .prepare('select Attempt, JointPublicKey from ElectionKey where ElectionId = :electionId and ElectionRevision = :revision')
        .get({ electionId, revision })
      if (reread && reread.Attempt === pub.attempt && reread.JointPublicKey === pub.jointPublicKey) {
        return 'published-election-key'
      }
      throw err
    }
    return 'published-election-key'
  }

  // -------------------------------------------------------------------------
  // Vault hygiene
  // -------------------------------------------------------------------------

  private async cleanupVault (electionId: string, evaluation: DkgRevisionEvaluation, signer: KeyholderDkgSigner): Promise<boolean> {
    if (evaluation.revision === null) return false
    const revision = evaluation.revision
    let didSomething = false

    const attemptsToClean = new Set<number>()
    for (const a of evaluation.attempts) {
      if (a.outcome === 'aborted') attemptsToClean.add(a.attempt)
    }
    if (evaluation.phase === 'complete') {
      for (let a = 1; a <= DKG_MAX_ATTEMPTS; a++) attemptsToClean.add(a)
    }
    for (const attempt of attemptsToClean) {
      for (const step of [1, 2] as const) {
        const alias = keyholderDkgRoundSecretAlias(electionId, revision, attempt, step, signer.userId)
        if (await this.deps.vault.deleteSecret(alias)) didSomething = true
      }
    }

    // V-1: the share is deleted only when the attempt that PRODUCED it is proven aborted (and no key exists).
    if (evaluation.electionKey === null) {
      const markerAlias = keyholderDkgShareAttemptAlias(electionId, revision, signer.userId)
      const markerBytes = await this.deps.vault.getSecret(markerAlias)
      if (markerBytes !== null) {
        const text = new TextDecoder().decode(markerBytes)
        const producing = /^[1-9][0-9]*$/.test(text) ? Number(text) : null
        const aborted = producing !== null && evaluation.attempts.some((a) => a.attempt === producing && a.outcome === 'aborted')
        if (aborted) {
          const shareAlias = keyholderDkgShareAlias(electionId, revision, signer.userId)
          await this.deps.vault.deleteSecret(shareAlias)
          await this.deps.vault.deleteSecret(markerAlias)
          didSomething = true
        }
      }
    }

    return didSomething
  }

  // -------------------------------------------------------------------------
  // Error wrapping
  // -------------------------------------------------------------------------

  private rethrow (err: unknown, method: string): never {
    if (err instanceof KeyholderDkgError) throw err
    if (err instanceof KeyVaultError) throw err
    return rethrowHelper(err, 'KeyholderDkgEngine', method)
  }
}
