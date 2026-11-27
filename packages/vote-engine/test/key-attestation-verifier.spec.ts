/**
 * key-attestation-verifier.spec.ts — Phase 43 D-01/D-02/D-06/D-09 branch
 * matrix for the Android Keystore hardware Key Attestation half of the
 * device attestation verifier (43-02, Wave 0 — RED). `verifyKeyAttestation`
 * lands in Wave 4; until then this spec fails at import (the module does not
 * exist yet) — that IS the expected state. Do NOT stub the verifier here.
 *
 * Signature under test (locked by this plan, RESEARCH.md Pattern 2 +
 * Code Examples): `verifyKeyAttestation(certChainDer, challenge,
 * pinnedRootsDer, revokedSerials)` — the 4th arg is the D-09/T-43-08
 * revoked/suspended-serial rejection set (initially empty for PASS/other
 * negative cases).
 *
 * Structure mirrors `association.spec.ts`'s `StubAttestationVerifier` block
 * (:353-397): `describe -> helper factory with overrides -> it() pairs`
 * asserting `result.ok` + a `result.reason` regex, never a thrown exception.
 */

import { expect } from 'chai'
import 'reflect-metadata'
import { SecurityLevel } from '@peculiar/asn1-android'
import { digestFields, resolveHasher, resolveOutputEncoder } from '@optimystic/quereus-plugin-crypto'
import { ANDROID_DEVICE_KEY_ATTESTATION_TAG, type AttestationChallenge } from '@votetorrent/vote-core'
// Wave-4 target — does not exist yet. This import failing IS the RED gate.
import { verifyKeyAttestation } from '../src/association/verifiers/key-attestation.js'
import { generateTestRootCa } from './fixtures/attestation/test-root-ca.js'
import { buildSyntheticKeyDescription, generateAndroidDeviceKeyPair } from './fixtures/attestation/synthetic-key-description.js'
import { SYNTHETIC_EXPECTED_APP_IDENTITY } from './fixtures/attestation/synthetic-jwe.js'
import { p256KeyToCompressedHex } from '../src/voting/vote-signing.js'

const hasher = resolveHasher('sha256')
const encode = resolveOutputEncoder('base64url')

function makeChallenge (overrides?: Partial<AttestationChallenge>): AttestationChallenge {
  return {
    nonce: 'challenge-nonce-1',
    authorityId: 'authority-1',
    registrantId: 'registrant-1',
    deviceKey: 'device-key-1',
    ...overrides
  }
}

/**
 * 51-02: build a challenge whose `deviceKey` is a REAL SPKI-DER-base64
 * encoded P-256 public key, plus the matching keypair to embed as the
 * synthetic leaf's own subject key (`buildSyntheticKeyDescription`'s
 * `leafKeyPair`). Required whenever a test needs `verifyKeyAttestation` to
 * reach a check AT OR AFTER the new 4b-2 leaf-pubkey binding check — i.e.
 * every `ok:true` case, plus the revoked-serial (5) and WR-04 (4c) negatives,
 * which fire only once 4b-2 has already passed. Tests exercising a check
 * BEFORE 4b-2 (root validation, leaf-only-trust, D-06 digest binding, WR-03)
 * are unaffected and keep using the plain `device-key-1` shape from
 * `makeChallenge()`.
 */
async function makeChallengeWithMatchingLeafKey (overrides?: Partial<AttestationChallenge>): Promise<{ challenge: AttestationChallenge, leafKeyPair: CryptoKeyPair }> {
  const { keyPair, deviceKeySpkiBase64 } = await generateAndroidDeviceKeyPair()
  const challenge = makeChallenge({ deviceKey: deviceKeySpkiBase64, ...overrides })
  return { challenge, leafKeyPair: keyPair }
}

/** The exact wire-format this plan locks: attestationChallenge = utf8(base64url(Digest(nonce, deviceKey))). */
function boundChallengeBytes (challenge: Pick<AttestationChallenge, 'nonce' | 'deviceKey'>): Uint8Array {
  const encoded = digestFields([challenge.nonce, challenge.deviceKey], hasher, encode) as string
  return new TextEncoder().encode(encoded)
}

describe('verifyKeyAttestation (D-01/D-02/D-06/D-09)', () => {
  it('returns ok:true for a TEE-backed chain bound to the challenge digest', async () => {
    const root = await generateTestRootCa()
    const { challenge, leafKeyPair } = await makeChallengeWithMatchingLeafKey()
    const { chainDer } = await buildSyntheticKeyDescription({
      root,
      securityLevel: SecurityLevel.trustedEnvironment,
      attestationChallenge: boundChallengeBytes(challenge),
      leafKeyPair
    })

    const result = await verifyKeyAttestation(chainDer, challenge, [new Uint8Array(root.cert.rawData)], new Set<string>(), SYNTHETIC_EXPECTED_APP_IDENTITY)
    expect(result.ok).to.equal(true)
  })

  it('WR-09: rejects a chain whose intermediate is NOT a CA — a non-CA may never be treated as an issuer', async () => {
    // Chain BUILDING verifies signatures; `signatureOnly: true` deliberately skips
    // basicConstraints, so nothing here asserted CA-ness before. This is defence in depth (no
    // exploit is constructible against Google's real hierarchy), but "we could not build an
    // exploit" is not the same property as "a non-CA can never be an issuer".
    const root = await generateTestRootCa()
    const { challenge, leafKeyPair } = await makeChallengeWithMatchingLeafKey()
    const { chainDer } = await buildSyntheticKeyDescription({
      root,
      securityLevel: SecurityLevel.trustedEnvironment,
      attestationChallenge: boundChallengeBytes(challenge),
      leafKeyPair,
      intermediateIsCa: false
    })

    const result = await verifyKeyAttestation(chainDer, challenge, [new Uint8Array(root.cert.rawData)], new Set<string>(), SYNTHETIC_EXPECTED_APP_IDENTITY)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.contain('is not a CA')
  })

  it('returns ok:true for a StrongBox-backed chain (also accepted under the balanced bar)', async () => {
    const root = await generateTestRootCa()
    const { challenge, leafKeyPair } = await makeChallengeWithMatchingLeafKey()
    const { chainDer } = await buildSyntheticKeyDescription({
      root,
      securityLevel: SecurityLevel.strongBox,
      attestationChallenge: boundChallengeBytes(challenge),
      leafKeyPair
    })

    const result = await verifyKeyAttestation(chainDer, challenge, [new Uint8Array(root.cert.rawData)], new Set<string>(), SYNTHETIC_EXPECTED_APP_IDENTITY)
    expect(result.ok).to.equal(true)
  })

  it('parses a KeyMint-schema leaf (v300/v400) the same as legacy Keymaster', async () => {
    const root = await generateTestRootCa()
    const { challenge, leafKeyPair } = await makeChallengeWithMatchingLeafKey()
    const { chainDer } = await buildSyntheticKeyDescription({
      root,
      securityLevel: SecurityLevel.trustedEnvironment,
      attestationChallenge: boundChallengeBytes(challenge),
      useKeyMintSchema: true,
      leafKeyPair
    })

    const result = await verifyKeyAttestation(chainDer, challenge, [new Uint8Array(root.cert.rawData)], new Set<string>(), SYNTHETIC_EXPECTED_APP_IDENTITY)
    expect(result.ok).to.equal(true)
  })

  it('rejects a Software-only security level (D-02 — TEE or StrongBox required)', async () => {
    const root = await generateTestRootCa()
    const challenge = makeChallenge()
    const { chainDer } = await buildSyntheticKeyDescription({
      root,
      securityLevel: SecurityLevel.software,
      attestationChallenge: boundChallengeBytes(challenge)
    })

    const result = await verifyKeyAttestation(chainDer, challenge, [new Uint8Array(root.cert.rawData)], new Set<string>(), SYNTHETIC_EXPECTED_APP_IDENTITY)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/software|security.*level/i)
  })

  it('rejects a TEE-ATTESTED but SOFTWARE-backed key (WR-01 — keymaster/KeyMint level gated too)', async () => {
    const root = await generateTestRootCa()
    const challenge = makeChallenge()
    const { chainDer } = await buildSyntheticKeyDescription({
      root,
      securityLevel: SecurityLevel.trustedEnvironment,
      keymasterSecurityLevel: SecurityLevel.software,
      attestationChallenge: boundChallengeBytes(challenge)
    })

    const result = await verifyKeyAttestation(chainDer, challenge, [new Uint8Array(root.cert.rawData)], new Set<string>(), SYNTHETIC_EXPECTED_APP_IDENTITY)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/software|security.*level|keymaster|keymint/i)
  })

  it('rejects a chain that does not terminate at a pinned root (forged/untrusted root)', async () => {
    const untrustedRoot = await generateTestRootCa()
    const unrelatedPinnedRoot = await generateTestRootCa()
    const challenge = makeChallenge()
    const { chainDer } = await buildSyntheticKeyDescription({
      root: untrustedRoot,
      securityLevel: SecurityLevel.trustedEnvironment,
      attestationChallenge: boundChallengeBytes(challenge)
    })

    const result = await verifyKeyAttestation(chainDer, challenge, [new Uint8Array(unrelatedPinnedRoot.cert.rawData)], new Set<string>(), SYNTHETIC_EXPECTED_APP_IDENTITY)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/root|chain|path/i)
  })

  it('rejects when the attestation extension appears only on a non-leaf certificate (Pitfall 6 leaf-only trust)', async () => {
    const root = await generateTestRootCa()
    const challenge = makeChallenge()
    const { chainDer } = await buildSyntheticKeyDescription({
      root,
      securityLevel: SecurityLevel.trustedEnvironment,
      attestationChallenge: boundChallengeBytes(challenge),
      extensionOnNonLeafOnly: true
    })

    const result = await verifyKeyAttestation(chainDer, challenge, [new Uint8Array(root.cert.rawData)], new Set<string>(), SYNTHETIC_EXPECTED_APP_IDENTITY)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/leaf|extension/i)
  })

  it('rejects when attestationChallenge does not match Digest(nonce, deviceKey) — D-06 cross-key/cross-device relay', async () => {
    const root = await generateTestRootCa()
    const challenge = makeChallenge()
    const { chainDer } = await buildSyntheticKeyDescription({
      root,
      securityLevel: SecurityLevel.trustedEnvironment,
      attestationChallenge: new TextEncoder().encode('not-the-bound-challenge')
    })

    const result = await verifyKeyAttestation(chainDer, challenge, [new Uint8Array(root.cert.rawData)], new Set<string>(), SYNTHETIC_EXPECTED_APP_IDENTITY)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/challenge|digest|binding/i)
  })

  it('rejects a chain whose leaf serial is on the revoked/suspended list (T-43-08)', async () => {
    const root = await generateTestRootCa()
    const { challenge, leafKeyPair } = await makeChallengeWithMatchingLeafKey()
    const { chainDer, serials } = await buildSyntheticKeyDescription({
      root,
      securityLevel: SecurityLevel.trustedEnvironment,
      attestationChallenge: boundChallengeBytes(challenge),
      leafKeyPair
    })
    const revokedSerials = new Set<string>([serials.leaf])

    const result = await verifyKeyAttestation(chainDer, challenge, [new Uint8Array(root.cert.rawData)], revokedSerials, SYNTHETIC_EXPECTED_APP_IDENTITY)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/revoked|suspended/)
  })

  it('rejects a leaf whose attestationApplicationId names a DIFFERENT app package (WR-03 wrong-app)', async () => {
    const root = await generateTestRootCa()
    const challenge = makeChallenge()
    const { chainDer } = await buildSyntheticKeyDescription({
      root,
      securityLevel: SecurityLevel.trustedEnvironment,
      attestationChallenge: boundChallengeBytes(challenge),
      appPackageName: 'com.other.playapp'
    })

    const result = await verifyKeyAttestation(chainDer, challenge, [new Uint8Array(root.cert.rawData)], new Set<string>(), SYNTHETIC_EXPECTED_APP_IDENTITY)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/attestationApplicationId|package|app/i)
  })

  it('rejects a leaf whose attestationApplicationId signature digest is not allowlisted (WR-03 wrong signing cert)', async () => {
    const root = await generateTestRootCa()
    const challenge = makeChallenge()
    const { chainDer } = await buildSyntheticKeyDescription({
      root,
      securityLevel: SecurityLevel.trustedEnvironment,
      attestationChallenge: boundChallengeBytes(challenge),
      appSignatureDigests: [new Uint8Array(32).fill(0x11)]
    })

    const result = await verifyKeyAttestation(chainDer, challenge, [new Uint8Array(root.cert.rawData)], new Set<string>(), SYNTHETIC_EXPECTED_APP_IDENTITY)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/signature|digest|certificate/i)
  })

  it('rejects an IMPORTED key (origin !== KM_ORIGIN_GENERATED) — WR-04', async () => {
    const root = await generateTestRootCa()
    const { challenge, leafKeyPair } = await makeChallengeWithMatchingLeafKey()
    const { chainDer } = await buildSyntheticKeyDescription({
      root,
      securityLevel: SecurityLevel.trustedEnvironment,
      attestationChallenge: boundChallengeBytes(challenge),
      origin: 2, // KM_ORIGIN_IMPORTED
      leafKeyPair
    })

    const result = await verifyKeyAttestation(chainDer, challenge, [new Uint8Array(root.cert.rawData)], new Set<string>(), SYNTHETIC_EXPECTED_APP_IDENTITY)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/origin|generated|imported/i)
  })

  it('rejects a key whose hardware-enforced purpose does not include SIGN (WR-04)', async () => {
    const root = await generateTestRootCa()
    const { challenge, leafKeyPair } = await makeChallengeWithMatchingLeafKey()
    const { chainDer } = await buildSyntheticKeyDescription({
      root,
      securityLevel: SecurityLevel.trustedEnvironment,
      attestationChallenge: boundChallengeBytes(challenge),
      purpose: [3], // KeyPurpose.VERIFY only — not SIGN
      leafKeyPair
    })

    const result = await verifyKeyAttestation(chainDer, challenge, [new Uint8Array(root.cert.rawData)], new Set<string>(), SYNTHETIC_EXPECTED_APP_IDENTITY)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/purpose|sign/i)
  })

  it('rejects a leaf with no attestationApplicationId at all (WR-03 no app binding)', async () => {
    const root = await generateTestRootCa()
    const challenge = makeChallenge()
    const { chainDer } = await buildSyntheticKeyDescription({
      root,
      securityLevel: SecurityLevel.trustedEnvironment,
      attestationChallenge: boundChallengeBytes(challenge),
      omitAttestationApplicationId: true
    })

    const result = await verifyKeyAttestation(chainDer, challenge, [new Uint8Array(root.cert.rawData)], new Set<string>(), SYNTHETIC_EXPECTED_APP_IDENTITY)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/attestationApplicationId|app/i)
  })

  describe('leaf public key binding (folded 2026-08-25 defect)', () => {
    it('positive control: a leaf whose public key equals challenge.deviceKey, passing every other check, returns ok:true', async () => {
      const root = await generateTestRootCa()
      const { challenge, leafKeyPair } = await makeChallengeWithMatchingLeafKey()
      const { chainDer } = await buildSyntheticKeyDescription({
        root,
        securityLevel: SecurityLevel.trustedEnvironment,
        attestationChallenge: boundChallengeBytes(challenge),
        leafKeyPair
      })

      const result = await verifyKeyAttestation(chainDer, challenge, [new Uint8Array(root.cert.rawData)], new Set<string>(), SYNTHETIC_EXPECTED_APP_IDENTITY)
      expect(result.ok).to.equal(true)
    })

    it('rejects a cryptographically-perfect chain whose LEAF public key is a DIFFERENT key than challenge.deviceKey', async () => {
      // The exact attack this check closes: an attacker holding a genuine
      // TEE/StrongBox key K_hw on a real device binds the challenge digest
      // to a DIFFERENT, exportable key K_soft (challenge.deviceKey = K_soft)
      // instead of K_hw. Every check up to and including the digest binding
      // (4) and the app-identity binding (4b) passes — none of them look at
      // the leaf's own public key — so without this check the attestation
      // would appear hardware-backed while the actual registered voting key
      // (K_soft) is not.
      const root = await generateTestRootCa()
      // K_soft: the key the challenge claims is being registered.
      const { deviceKeySpkiBase64: kSoft } = await generateAndroidDeviceKeyPair()
      // K_hw: the DIFFERENT key the leaf certificate actually attests.
      const { keyPair: kHw } = await generateAndroidDeviceKeyPair()
      const challenge = makeChallenge({ deviceKey: kSoft })
      const { chainDer } = await buildSyntheticKeyDescription({
        root,
        securityLevel: SecurityLevel.trustedEnvironment,
        // The digest binding (check 4) is computed over challenge.deviceKey
        // (K_soft) — it passes. Only the LEAF's embedded key differs (K_hw).
        attestationChallenge: boundChallengeBytes(challenge),
        leafKeyPair: kHw
      })

      const result = await verifyKeyAttestation(chainDer, challenge, [new Uint8Array(root.cert.rawData)], new Set<string>(), SYNTHETIC_EXPECTED_APP_IDENTITY)
      expect(result.ok).to.equal(false)
      expect(result.reason).to.match(/not the challenge deviceKey/i)
      // Never-log rule: the reason must carry no key bytes.
      expect(result.reason).to.not.match(/[A-Za-z0-9+/]{20,}/)
    })

    it('REJECTS (fail-closed) when challenge.deviceKey is not a P-256 public key in any form — never silently skips the check', async () => {
      const root = await generateTestRootCa()
      const challenge = makeChallenge({ deviceKey: 'not-valid-base64-spki!!!' })
      const { chainDer } = await buildSyntheticKeyDescription({
        root,
        securityLevel: SecurityLevel.trustedEnvironment,
        attestationChallenge: boundChallengeBytes(challenge)
      })

      const result = await verifyKeyAttestation(chainDer, challenge, [new Uint8Array(root.cert.rawData)], new Set<string>(), SYNTHETIC_EXPECTED_APP_IDENTITY)
      expect(result.ok).to.equal(false)
      expect(result.reason).to.match(/not a P-256 public key/i)
    })

    // Spike 103: the Voter now issues Android challenges against the COMPRESSED HEX device key
    // (the form every SignatureValidP256 CHECK decodes), so the binding compares P-256 points.
    it('accepts a challenge naming the attested key as compressed hex (spike 103), as well as SPKI', async () => {
      const root = await generateTestRootCa()
      const { keyPair, deviceKeySpkiBase64 } = await generateAndroidDeviceKeyPair()
      const challenge = makeChallenge({ deviceKey: p256KeyToCompressedHex(deviceKeySpkiBase64) })
      const { chainDer } = await buildSyntheticKeyDescription({
        root,
        securityLevel: SecurityLevel.trustedEnvironment,
        attestationChallenge: boundChallengeBytes(challenge),
        leafKeyPair: keyPair
      })

      const result = await verifyKeyAttestation(chainDer, challenge, [new Uint8Array(root.cert.rawData)], new Set<string>(), SYNTHETIC_EXPECTED_APP_IDENTITY)
      expect(result.ok, result.ok ? '' : result.reason).to.equal(true)
    })

    it('REJECTS a compressed-hex challenge naming a DIFFERENT key than the attested leaf', async () => {
      const root = await generateTestRootCa()
      const { keyPair } = await generateAndroidDeviceKeyPair()
      const { deviceKeySpkiBase64: otherSpki } = await generateAndroidDeviceKeyPair()
      const challenge = makeChallenge({ deviceKey: p256KeyToCompressedHex(otherSpki) })
      const { chainDer } = await buildSyntheticKeyDescription({
        root,
        securityLevel: SecurityLevel.trustedEnvironment,
        attestationChallenge: boundChallengeBytes(challenge),
        leafKeyPair: keyPair
      })

      const result = await verifyKeyAttestation(chainDer, challenge, [new Uint8Array(root.cert.rawData)], new Set<string>(), SYNTHETIC_EXPECTED_APP_IDENTITY)
      expect(result.ok).to.equal(false)
      expect(result.reason).to.match(/not the challenge deviceKey/i)
    })
  })

  // Spike 104 (R1d): Android binds a challenge only at keygen and the voting key signs the request
  // before the nonce exists, so a real ceremony presents the voting key's own chain (provisioning tag)
  // and a throwaway key's chain (nonce digest). Each role keeps every check except the one its
  // sibling carries.
  describe('roles: device-key and fresh chains (spike 104, R1d)', () => {
    const TAG = new TextEncoder().encode(ANDROID_DEVICE_KEY_ATTESTATION_TAG)
    const pinned = (root: Awaited<ReturnType<typeof generateTestRootCa>>) => [new Uint8Array(root.cert.rawData)]

    async function votingKeyChallenge () {
      const { keyPair, deviceKeySpkiBase64 } = await generateAndroidDeviceKeyPair()
      return { challenge: makeChallenge({ deviceKey: p256KeyToCompressedHex(deviceKeySpkiBase64) }), votingKeyPair: keyPair }
    }

    it("'device-key' accepts the voting key's own chain generated with the provisioning tag", async () => {
      const root = await generateTestRootCa()
      const { challenge, votingKeyPair } = await votingKeyChallenge()
      const { chainDer } = await buildSyntheticKeyDescription({ root, securityLevel: SecurityLevel.trustedEnvironment, attestationChallenge: TAG, leafKeyPair: votingKeyPair })

      const result = await verifyKeyAttestation(chainDer, challenge, pinned(root), new Set<string>(), SYNTHETIC_EXPECTED_APP_IDENTITY, 'device-key')
      expect(result.ok, result.ok ? '' : result.reason).to.equal(true)
    })

    it("'device-key' REJECTS a tagged chain whose leaf is not the voting key (T-51-02-01 kept)", async () => {
      const root = await generateTestRootCa()
      const { challenge } = await votingKeyChallenge()
      const { keyPair: otherKeyPair } = await generateAndroidDeviceKeyPair()
      const { chainDer } = await buildSyntheticKeyDescription({ root, securityLevel: SecurityLevel.trustedEnvironment, attestationChallenge: TAG, leafKeyPair: otherKeyPair })

      const result = await verifyKeyAttestation(chainDer, challenge, pinned(root), new Set<string>(), SYNTHETIC_EXPECTED_APP_IDENTITY, 'device-key')
      expect(result.ok).to.equal(false)
      expect(result.reason).to.match(/not the challenge deviceKey/i)
    })

    it("'device-key' REJECTS the voting key's chain when it carries the nonce digest instead of the tag", async () => {
      const root = await generateTestRootCa()
      const { challenge, votingKeyPair } = await votingKeyChallenge()
      const { chainDer } = await buildSyntheticKeyDescription({ root, securityLevel: SecurityLevel.trustedEnvironment, attestationChallenge: boundChallengeBytes(challenge), leafKeyPair: votingKeyPair })

      const result = await verifyKeyAttestation(chainDer, challenge, pinned(root), new Set<string>(), SYNTHETIC_EXPECTED_APP_IDENTITY, 'device-key')
      expect(result.ok).to.equal(false)
      expect(result.reason).to.match(/provisioning tag/i)
    })

    it("'device-key' still enforces the hardware bar (a Software-level tagged chain is refused)", async () => {
      const root = await generateTestRootCa()
      const { challenge, votingKeyPair } = await votingKeyChallenge()
      const { chainDer } = await buildSyntheticKeyDescription({ root, securityLevel: SecurityLevel.software, attestationChallenge: TAG, leafKeyPair: votingKeyPair })

      const result = await verifyKeyAttestation(chainDer, challenge, pinned(root), new Set<string>(), SYNTHETIC_EXPECTED_APP_IDENTITY, 'device-key')
      expect(result.ok).to.equal(false)
      expect(result.reason).to.match(/Software/)
    })

    it("'fresh' accepts a throwaway key's chain bound to Digest(nonce, deviceKey) — its leaf is not the voting key", async () => {
      const root = await generateTestRootCa()
      const { challenge } = await votingKeyChallenge()
      const { keyPair: throwaway } = await generateAndroidDeviceKeyPair()
      const { chainDer } = await buildSyntheticKeyDescription({ root, securityLevel: SecurityLevel.trustedEnvironment, attestationChallenge: boundChallengeBytes(challenge), leafKeyPair: throwaway })

      const result = await verifyKeyAttestation(chainDer, challenge, pinned(root), new Set<string>(), SYNTHETIC_EXPECTED_APP_IDENTITY, 'fresh')
      expect(result.ok, result.ok ? '' : result.reason).to.equal(true)
      // The same chain in the default role is refused — 'single' needs the leaf to be the voting key.
      const single = await verifyKeyAttestation(chainDer, challenge, pinned(root), new Set<string>(), SYNTHETIC_EXPECTED_APP_IDENTITY)
      expect(single.ok).to.equal(false)
    })

    it("'fresh' REJECTS a chain bound to a different nonce (D-06 anti-relay kept)", async () => {
      const root = await generateTestRootCa()
      const { challenge } = await votingKeyChallenge()
      const { keyPair: throwaway } = await generateAndroidDeviceKeyPair()
      const { chainDer } = await buildSyntheticKeyDescription({ root, securityLevel: SecurityLevel.trustedEnvironment, attestationChallenge: boundChallengeBytes({ ...challenge, nonce: 'an-earlier-nonce' }), leafKeyPair: throwaway })

      const result = await verifyKeyAttestation(chainDer, challenge, pinned(root), new Set<string>(), SYNTHETIC_EXPECTED_APP_IDENTITY, 'fresh')
      expect(result.ok).to.equal(false)
      expect(result.reason).to.match(/Digest\(nonce, deviceKey\)/)
    })

    it("'fresh' REJECTS the provisioning-tag chain (a tagged chain never answers a nonce)", async () => {
      const root = await generateTestRootCa()
      const { challenge, votingKeyPair } = await votingKeyChallenge()
      const { chainDer } = await buildSyntheticKeyDescription({ root, securityLevel: SecurityLevel.trustedEnvironment, attestationChallenge: TAG, leafKeyPair: votingKeyPair })

      const result = await verifyKeyAttestation(chainDer, challenge, pinned(root), new Set<string>(), SYNTHETIC_EXPECTED_APP_IDENTITY, 'fresh')
      expect(result.ok).to.equal(false)
    })
  })
})
