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

// D-12 independent Play-Integrity-leg stub toggle (real-key + stub-PI test tier).
// __DEV__-gated (see attestation-producer.ts's resolvePlayIntegrityEnabled); committed
// default false (real) — never commit an enabled override.
export const USE_STUB_PLAY_INTEGRITY = false;

// 45-09-gap / D-12 forced-real-producer toggle. Forces resolveAttestationProducer()
// to select the REAL producer (createRealAttestationProducer) from INSIDE a __DEV__
// build, so a debug build with Metro live-reload can exercise real hardware key
// attestation — combine with USE_STUB_PLAY_INTEGRITY=true for the D-12 real-key +
// stub-PI tier. __DEV__-gated (see attestation-producer.ts's resolveRealProducerForced):
// a release build evaluates the gate to false no matter what this file holds, so it is
// provably inert outside __DEV__ and can never weaken CR-03 / T-45-05-04. Committed
// default false — never commit an enabled override.
export const USE_REAL_ATTESTATION_PRODUCER = false;
