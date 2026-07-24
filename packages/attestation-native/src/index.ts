/**
 * index.ts — public entry point for `@votetorrent/attestation-native` (Phase 45-01 scaffold).
 *
 * This plan delivers ONLY the codegen-source TurboModule spec + its default enforcing
 * instance. The `RealAttestationProducer` JS orchestration (BOUND_DIGEST computation,
 * two-step `AttestationProducer` implementation, D-16b digest probe) is added to this
 * package in 45-05 — do not create it here.
 */
export { default as AttestationNative } from './specs/NativeAttestation'
export type { Spec as NativeAttestationSpec } from './specs/NativeAttestation'
