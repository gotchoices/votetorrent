// proof-flags.generated.ts — committed default fallback (D-04 escape hatch, false).
//
// Static import ONLY — dynamic require() breaks Metro (authority app's Phase 16-07
// lesson, ported here verbatim per 44-PATTERNS.md). This file IS git-tracked; never
// commit an enabled-flag override.
//
// Only USE_LOCAL_DB_FACTORY is load-bearing this phase (D-04). The authority app's
// PROOF_ENABLED / DIAL_PROBE_ENABLED / REPLICATION_PROOF_ENABLED / SIGNING_PROOF_ENABLED /
// STRAND_PERSISTENCE_PROOF_ENABLED / USE_STUB_ATTESTATION_VERIFIER flags are dropped —
// the voter app has no dev-proof-runner harness and hardcodes StubAttestationVerifier
// unconditionally in engine-factory.ts (no gate to select).
export const USE_LOCAL_DB_FACTORY = false;
