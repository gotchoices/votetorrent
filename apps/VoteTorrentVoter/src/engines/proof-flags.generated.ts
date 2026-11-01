// proof-flags.generated.ts — committed default fallback (D-04 escape hatch, false).
//
// Static import ONLY — dynamic require() breaks Metro (authority app's Phase 16-07
// lesson, ported here verbatim per 44-PATTERNS.md). This file IS git-tracked; never
// commit an enabled-flag override.
//
// The authority app's PROOF_ENABLED / DIAL_PROBE_ENABLED / REPLICATION_PROOF_ENABLED /
// SIGNING_PROOF_ENABLED / STRAND_PERSISTENCE_PROOF_ENABLED flags are dropped — the voter app
// has no dev-proof-runner harness.
export const USE_LOCAL_DB_FACTORY = false;

// Selects StubAttestationVerifier for the 'association' engine. __DEV__-gated (see
// attestation-verifier.ts's selectAttestationVerifier): a release build gets the fail-closed
// RefusingAttestationVerifier no matter what this file holds. Committed default false —
// never commit an enabled override.
export const USE_STUB_ATTESTATION_VERIFIER = false;

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

// 62-51: opt-in toggle for the phase-59 D-23(f) registered-state dev fixture (an active Registrant
// plus an Association bound to the stub device key). Consumed ONLY by dev-seed.ts, which is itself
// __DEV__-only. Committed default false - never commit an enabled override. Setting it true
// restores the registered Timeline panel for manual QA; it is NEVER evidence that the registration
// ceremony works.
export const SEED_REGISTERED_STATE_FIXTURE = false;

// Privacy-safe debug log switch for `vt-debug.ts` (`vtDebug(tag, event, detail)`): state names,
// timings, codes and 8-char prefixes only, never keys, signatures, ciphertext, envelopes, join codes or
// error message text. __DEV__-gated (see vt-debug.ts's vtDebugEnabled): a release build logs nothing
// no matter what this file holds. At runtime a debug build can also switch it on over CDP with
// `globalThis.__VT_DEBUG__ = true`. Committed default false - never commit an enabled override; the
// device rig flips it through its scratch Metro config like the flags above.
export const VT_DEBUG_LOGS = false;
