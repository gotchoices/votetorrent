/**
 * TEST-6.2.1: Signature Validation Integration Tests
 *
 * Tests the integration between quereus-plugin-crypto's SignatureValid and
 * the cluster consensus signature verification in cluster-repo.ts.
 *
 * The cluster currently uses libp2p Ed25519 (@libp2p/crypto) for signing/verifying.
 * The crypto plugin uses @noble/curves for multi-curve signature verification.
 * These tests validate cross-library compatibility and the end-to-end signature
 * flow through consensus phases.
 */
export {};
//# sourceMappingURL=signature-validation-integration.spec.d.ts.map