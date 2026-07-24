/**
 * index.ts — public entry point for `@votetorrent/attestation-native` (Phase 45-01 scaffold,
 * extended in 45-05 with the JS orchestration layer).
 */
export { default as AttestationNative } from './specs/NativeAttestation'
export type { Spec as NativeAttestationSpec } from './specs/NativeAttestation'

// 45-05: the RealAttestationProducer JS orchestration — BOUND_DIGEST computation (D-06,
// byte-for-byte matching the authority verifier's recomputeChallengeDigest), the D-16b
// module-load probe, and the injectable createRealAttestationProducer({ enablePlayIntegrity })
// factory driving the two-step TurboModule seam.
export { computeBoundDigest, createRealAttestationProducer } from './real-attestation-producer'
