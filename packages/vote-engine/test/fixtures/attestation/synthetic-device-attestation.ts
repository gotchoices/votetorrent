// Synthetic full `DeviceAttestation` harness (Phase 43-05, D-11). Composes
// the 43-02 JWE-of-JWS builder (`synthetic-jwe.ts`) and the 43-02
// KeyDescription/cert-chain builder (`synthetic-key-description.ts`) into a
// SINGLE `DeviceAttestation` — `platformDetails.safetyNetAttestation` +
// `certificateChain` — the same shape a real Android producer would submit
// to `AssociationAssociateBuilder.setAttestation(...)`. The REAL
// `PlayIntegrityVerifier` (Wave 4) ACCEPTS the default (no-override) output
// of `buildSyntheticDeviceAttestation`; overrides drive the REJECT variants
// (failed device-integrity verdict, wrong nonce, Software-only key).
//
// Module pattern mirrors `synthetic-jwe.ts`/`synthetic-key-description.ts`:
// top-level named exports only, no class wrapper, no default export.

import { SecurityLevel } from '@peculiar/asn1-android'
import { ANDROID_DEVICE_KEY_ATTESTATION_TAG, type AttestationChallenge, type DeviceAttestation } from '@votetorrent/vote-core'
import { recomputeChallengeDigest } from '../../../src/association/verifiers/digest-binding.js'
import {
  buildDefaultSyntheticPayload,
  buildSyntheticJwe,
  type BuildSyntheticJweOverrides,
  type SyntheticJweKeyMaterial,
  type SyntheticJwePayloadOverrides
} from './synthetic-jwe.js'
import { buildSyntheticKeyDescription } from './synthetic-key-description.js'
import type { TestCertificate } from './test-root-ca.js'

export interface BuildSyntheticDeviceAttestationOverrides {
  /** Overrides for the decrypted Play Integrity payload (e.g. `deviceRecognitionVerdict`, `appRecognitionVerdict`) — leave `nonce` unset to keep the D-06 binding intact. */
  payload?: Omit<SyntheticJwePayloadOverrides, 'nonce'>
  /** Override the classic-API token's `requestDetails.nonce` directly — a wrong-nonce REJECT variant (D-06). */
  payloadNonce?: string
  /** JWE-construction overrides (tampered ciphertext, wrong signing key) — see `synthetic-jwe.ts`. */
  jwe?: BuildSyntheticJweOverrides
  /** D-02 balanced-bar security level for the Key Attestation chain. Defaults to `trustedEnvironment` (accepted). */
  securityLevel?: SecurityLevel
  /** Override the KeyDescription `attestationChallenge` extension bytes directly — a wrong-binding REJECT variant (D-06). Defaults to `utf8(Digest(challenge.nonce, challenge.deviceKey))`, matching the real verifier's expectation. */
  attestationChallengeBytes?: Uint8Array
  /** Override the platform-level `AndroidAttestationDetails.nonce` (the builder's own cross-field validator requires this to equal the draft's `nonce`, i.e. the challenge nonce being answered). Defaults to `challenge.nonce`. */
  platformNonce?: string
  deviceId?: string
  publicKey?: string
  keystorePublicKey?: string
  /**
   * Embed this EXACT keypair as the Key Attestation leaf certificate's
   * subject key (51-02), instead of a freshly generated random one. Pass the
   * SAME keypair whose SPKI-DER-base64 encoding is `challenge.deviceKey` so
   * `verifyKeyAttestation`'s leaf-pubkey binding check (4b-2) accepts the
   * chain — required for any ACCEPTING (ok:true) scenario since that check
   * landed. See `synthetic-key-description.ts`'s `generateAndroidDeviceKeyPair()`.
   */
  leafKeyPair?: CryptoKeyPair
  /**
   * Spike 104 (R1d) two-chain form: ALSO build the voting key's own chain and carry it as
   * `platformDetails.deviceKeyCertificateChain`. `certificateChain` then belongs to the throwaway
   * key (`leafKeyPair`, or a random one) that answered the nonce. `attestationChallengeBytes`
   * defaults to utf8(`ANDROID_DEVICE_KEY_ATTESTATION_TAG`).
   */
  deviceKeyChain?: { leafKeyPair: CryptoKeyPair, attestationChallengeBytes?: Uint8Array, securityLevel?: SecurityLevel }
}

export interface BuildSyntheticDeviceAttestationOptions {
  /** The issued `AttestationChallenge` this attestation answers. */
  challenge: AttestationChallenge
  /** Play Integrity JWE key material (`generateSyntheticJweKeyMaterial()`), shared with the `IIntegrityKeyProvider` the verifier is constructed with. */
  jweKeys: SyntheticJweKeyMaterial
  /** Key Attestation test root (`generateTestRootCa()`), shared with the `pinnedHardwareRoots` the verifier is constructed with. */
  testRoot: TestCertificate
  overrides?: BuildSyntheticDeviceAttestationOverrides
}

/**
 * Assemble a full `DeviceAttestation` (Play Integrity JWE token +
 * hardware-Key-Attestation cert chain) the real `PlayIntegrityVerifier`
 * ACCEPTS when built with no overrides, proving the whole chain works
 * end-to-end. Overrides produce REJECT variants without touching the
 * verifier itself.
 */
export async function buildSyntheticDeviceAttestation (options: BuildSyntheticDeviceAttestationOptions): Promise<DeviceAttestation> {
  const { challenge, jweKeys, testRoot, overrides } = options
  const boundDigest = recomputeChallengeDigest(challenge.nonce, challenge.deviceKey)

  // ---- Play Integrity half: JWE-of-JWS token, requestDetails.nonce bound to the digest ----
  const payload = buildDefaultSyntheticPayload({
    nonce: overrides?.payloadNonce ?? boundDigest,
    ...overrides?.payload
  })
  const safetyNetAttestation = await buildSyntheticJwe(payload, jweKeys, overrides?.jwe)

  // ---- Key Attestation half: leaf-first cert chain, attestationChallenge bound to the digest ----
  const attestationChallengeBytes = overrides?.attestationChallengeBytes ?? new TextEncoder().encode(boundDigest)
  const { chainDer } = await buildSyntheticKeyDescription({
    root: testRoot,
    securityLevel: overrides?.securityLevel ?? SecurityLevel.trustedEnvironment,
    attestationChallenge: attestationChallengeBytes,
    leafKeyPair: overrides?.leafKeyPair
  })
  // PlayIntegrityVerifier.verify base64-decodes DeviceAttestation.certificateChain
  // entries before parsing DER (play-integrity-verifier.ts:38) — encode accordingly.
  const certificateChain = chainDer.map((der) => Buffer.from(der).toString('base64'))

  const deviceKeyChain = overrides?.deviceKeyChain
  const deviceKeyCertificateChain = deviceKeyChain === undefined
    ? undefined
    : (await buildSyntheticKeyDescription({
        root: testRoot,
        securityLevel: deviceKeyChain.securityLevel ?? SecurityLevel.trustedEnvironment,
        attestationChallenge: deviceKeyChain.attestationChallengeBytes ?? new TextEncoder().encode(ANDROID_DEVICE_KEY_ATTESTATION_TAG),
        leafKeyPair: deviceKeyChain.leafKeyPair
      })).chainDer.map((der) => Buffer.from(der).toString('base64'))

  return {
    publicKey: overrides?.publicKey ?? 'synthetic-device-voting-pubkey',
    deviceId: overrides?.deviceId ?? `synthetic-device-${Date.now()}-${Math.floor(Math.random() * 100_000)}`,
    attestationTime: Date.now(),
    certificateChain,
    platformDetails: {
      type: 'Android',
      safetyNetAttestation,
      keystorePublicKey: overrides?.keystorePublicKey ?? 'synthetic-keystore-pubkey',
      // AssociationAssociateBuilder's cross-field validator requires this to
      // equal the draft's own `nonce` (the challenge nonce being answered) —
      // defaults to the real challenge nonce so the accepting variant passes
      // BOTH the builder's cross-field check and the verifier's D-06 binding.
      nonce: overrides?.platformNonce ?? challenge.nonce,
      ...(deviceKeyCertificateChain !== undefined ? { deviceKeyCertificateChain } : {})
    }
  }
}
