/**
 * NativeAttestation.ts — codegen source of truth for the `AttestationNative` TurboModule
 * (Phase 45-01 scaffold). RN 0.78 new-arch codegen generates the Kotlin
 * `NativeAttestationSpec` base class from this file (see `package.json`'s
 * `codegenConfig`); `AttestationNativeModule.kt` extends that generated base class.
 *
 * D-11 two-step producer seam:
 *   (1) provisionDeviceKey(keyAlias) — generates/returns the hardware-backed P-256
 *       public key (biometric-gated). The authority-issued challenge is bound to
 *       this key's public value.
 *   (2) produceAttestation(keyAlias, boundDigest, boundDigestUtf8Base64, enablePlayIntegrity)
 *       — answers the challenge: returns the key-attestation cert chain + (optionally)
 *       a Play Integrity Classic token.
 *
 * TurboModule codegen types are restrictive (no arbitrary interfaces) — both methods
 * return `Object` (a `WritableMap` on the Kotlin side); the JS wrapper
 * (`RealAttestationProducer`, landing in 45-05) parses/validates the returned shape,
 * exactly as `react-native-localize` returns `Object` for `getNumberFormatSettings()`.
 *
 * OPEN QUESTION 1 (45-RESEARCH.md, NOT resolved by this scaffold plan — do not narrow):
 * this signature deliberately supports BOTH candidate implementations for WHEN the
 * real attested key-generation happens:
 *   (a) `provisionDeviceKey` generates the real attested key immediately, using a
 *       placeholder `setAttestationChallenge` value, then `produceAttestation`
 *       re-reads/regenerates the attestation-carrying cert chain against the real
 *       `boundDigest` once the challenge exists; or
 *   (b) `provisionDeviceKey` only returns a public key (possibly from a
 *       non-attested or previously-provisioned key) and ALL attested key generation
 *       is deferred to `produceAttestation`, which receives the real `boundDigest`
 *       up front and can generate-with-challenge in one step.
 * 45-02 resolves which path via an on-device/emulator experiment (45-RESEARCH.md
 * Open Question 1 / Assumption A2). This spec's shape must not be narrowed to
 * foreclose either option until that experiment lands.
 */
import type { TurboModule } from 'react-native'
import { TurboModuleRegistry } from 'react-native'

export interface Spec extends TurboModule {
	/**
	 * Generates (or returns the existing) hardware-backed P-256 signing key under
	 * `keyAlias`. Biometric-gated per D-06/D-17. Resolves `{ publicKeyBase64, keyAlias }`.
	 * Scaffold (45-01): rejects with a NOT_IMPLEMENTED-class code — no real Keystore
	 * logic yet (lands in 45-02).
	 */
	provisionDeviceKey(keyAlias: string): Promise<Object>

	/**
	 * Answers an already-issued challenge bound to the key from `provisionDeviceKey`.
	 * `boundDigest` is the base64url `Digest(nonce, deviceKey)` string (Play Integrity
	 * Classic nonce, AS-IS); `boundDigestUtf8Base64` is the base64 encoding of the
	 * UTF-8 bytes of that same string (the Keystore `setAttestationChallenge` payload
	 * — an intentional asymmetry, see `packages/vote-engine/ATTESTATION-CONTRACT.md`).
	 * `enablePlayIntegrity` independently gates the Play Integrity Classic leg (D-12).
	 * Resolves the attestation result map (cert chain + optional integrity token).
	 * Scaffold (45-01): rejects with a NOT_IMPLEMENTED-class code — no real
	 * attestation logic yet (lands in 45-02).
	 */
	produceAttestation(
		keyAlias: string,
		boundDigest: string,
		boundDigestUtf8Base64: string,
		enablePlayIntegrity: boolean,
	): Promise<Object>
}

export default TurboModuleRegistry.getEnforcing<Spec>('AttestationNative')
