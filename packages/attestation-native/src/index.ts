/**
 * index.ts — public entry point for `@votetorrent/attestation-native` (Phase 45-01 scaffold,
 * extended in 45-05 with the JS orchestration layer).
 *
 * IMPORTANT: this barrel does NOT re-export the `AttestationNative` default TurboModule instance
 * (45-01's original scaffold did — dropped in 45-05, Rule 1 fix). A static `export ... from`
 * unconditionally evaluates the source module when the BARREL is imported, regardless of which
 * named export the importer actually uses — so re-exporting `AttestationNative` here would make
 * every consumer of this package (even one only wanting `createRealAttestationProducer`) eagerly
 * trigger `TurboModuleRegistry.getEnforcing('AttestationNative')` at import time, throwing under
 * Node/jest (`__fbBatchedBridgeConfig is not set`). Nothing outside this package imports
 * `AttestationNative`/`NativeAttestationSpec` directly — `real-attestation-producer.ts`'s
 * `getNative()` already accesses the native module lazily via a scoped `require()` (see that
 * file's header comment), which is the only sanctioned access path.
 */
export type { Spec as NativeAttestationSpec } from './specs/NativeAttestation'

// 45-05: the RealAttestationProducer JS orchestration — BOUND_DIGEST computation (D-06,
// byte-for-byte matching the authority verifier's recomputeChallengeDigest), the D-16b
// module-load probe, and the injectable createRealAttestationProducer({ enablePlayIntegrity })
// factory driving the two-step TurboModule seam.
export { computeBoundDigest, createRealAttestationProducer } from './real-attestation-producer'
