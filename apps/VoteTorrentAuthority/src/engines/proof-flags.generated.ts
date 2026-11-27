// proof-flags.generated.ts — committed default fallback (all flags false).
// The run scripts (run-vtest02.sh, run-dial-probe.sh, run-signing-proof.sh,
// run-replication-proof.sh, run-recovery-branch-proof.sh,
// run-sealed-payload-proof.sh) overwrite this file before bundling and restore
// the default-false content in an EXIT trap. schema-type-regression.spec.ts
// locks every heredoc to this file's flag SET (order does not matter).
// NOTE: this file IS git-tracked (gitignore would be a no-op for a tracked
// file — WR-02, 17-REVIEW). If a run script is killed before its EXIT trap
// fires, `git status` will show this file modified: restore it with
// `git checkout -- apps/VoteTorrentAuthority/src/engines/proof-flags.generated.ts`
// and NEVER commit an enabled-flag override.
// Static import ONLY — dynamic require() breaks Metro (Phase 16-07 lesson).
export const PROOF_ENABLED = false;
export const DIAL_PROBE_ENABLED = false;
export const REPLICATION_PROOF_ENABLED = false;
export const USE_LOCAL_DB_FACTORY = false;
export const SIGNING_PROOF_ENABLED = false;
export const STRAND_PERSISTENCE_PROOF_ENABLED = false;
export const USE_STUB_ATTESTATION_VERIFIER = false;
// __DEV__-gated: skip the Play Integrity half of Android attestation on this verifier so the real
// key-attestation half (and the app-identity certificate pin it enforces) can be exercised without
// Play Console key material. Read only through `resolveSkipPlayIntegrityHalf()`, which is
// `__DEV__ && SKIP_PLAY_INTEGRITY_HALF`, so a release build ignores it. Committed default false —
// never commit an enabled override.
export const SKIP_PLAY_INTEGRITY_HALF = false;
export const REGISTRANT_SEED_ENABLED = false;
export const RECOVERY_BRANCH_PROOF_ENABLED = false;
export const SEALED_PAYLOAD_PROOF_ENABLED = false;
