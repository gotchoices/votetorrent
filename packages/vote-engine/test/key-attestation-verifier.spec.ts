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
import type { AttestationChallenge } from '@votetorrent/vote-core'
// Wave-4 target — does not exist yet. This import failing IS the RED gate.
import { verifyKeyAttestation } from '../src/association/verifiers/key-attestation.js'
import { generateTestRootCa } from './fixtures/attestation/test-root-ca.js'
import { buildSyntheticKeyDescription } from './fixtures/attestation/synthetic-key-description.js'
import { SYNTHETIC_EXPECTED_APP_IDENTITY } from './fixtures/attestation/synthetic-jwe.js'

const hasher = resolveHasher('sha256')
const encode = resolveOutputEncoder('base64url')

function makeChallenge (overrides?: Partial<AttestationChallenge>): AttestationChallenge {
  return {
    nonce: 'challenge-nonce-1',
    authorityId: 'authority-1',
    registrantId: 'registrant-1',
    deviceKey: 'device-key-1',
    expiration: new Date(Date.now() + 60_000).toISOString(),
    ...overrides
  }
}

/** The exact wire-format this plan locks: attestationChallenge = utf8(base64url(Digest(nonce, deviceKey))). */
function boundChallengeBytes (challenge: Pick<AttestationChallenge, 'nonce' | 'deviceKey'>): Uint8Array {
  const encoded = digestFields([challenge.nonce, challenge.deviceKey], hasher, encode) as string
  return new TextEncoder().encode(encoded)
}

describe('verifyKeyAttestation (D-01/D-02/D-06/D-09)', () => {
  it('returns ok:true for a TEE-backed chain bound to the challenge digest', async () => {
    const root = await generateTestRootCa()
    const challenge = makeChallenge()
    const { chainDer } = await buildSyntheticKeyDescription({
      root,
      securityLevel: SecurityLevel.trustedEnvironment,
      attestationChallenge: boundChallengeBytes(challenge)
    })

    const result = await verifyKeyAttestation(chainDer, challenge, [new Uint8Array(root.cert.rawData)], new Set<string>(), SYNTHETIC_EXPECTED_APP_IDENTITY)
    expect(result.ok).to.equal(true)
  })

  it('returns ok:true for a StrongBox-backed chain (also accepted under the balanced bar)', async () => {
    const root = await generateTestRootCa()
    const challenge = makeChallenge()
    const { chainDer } = await buildSyntheticKeyDescription({
      root,
      securityLevel: SecurityLevel.strongBox,
      attestationChallenge: boundChallengeBytes(challenge)
    })

    const result = await verifyKeyAttestation(chainDer, challenge, [new Uint8Array(root.cert.rawData)], new Set<string>(), SYNTHETIC_EXPECTED_APP_IDENTITY)
    expect(result.ok).to.equal(true)
  })

  it('parses a KeyMint-schema leaf (v300/v400) the same as legacy Keymaster', async () => {
    const root = await generateTestRootCa()
    const challenge = makeChallenge()
    const { chainDer } = await buildSyntheticKeyDescription({
      root,
      securityLevel: SecurityLevel.trustedEnvironment,
      attestationChallenge: boundChallengeBytes(challenge),
      useKeyMintSchema: true
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
    const challenge = makeChallenge()
    const { chainDer, serials } = await buildSyntheticKeyDescription({
      root,
      securityLevel: SecurityLevel.trustedEnvironment,
      attestationChallenge: boundChallengeBytes(challenge)
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
    const challenge = makeChallenge()
    const { chainDer } = await buildSyntheticKeyDescription({
      root,
      securityLevel: SecurityLevel.trustedEnvironment,
      attestationChallenge: boundChallengeBytes(challenge),
      origin: 2 // KM_ORIGIN_IMPORTED
    })

    const result = await verifyKeyAttestation(chainDer, challenge, [new Uint8Array(root.cert.rawData)], new Set<string>(), SYNTHETIC_EXPECTED_APP_IDENTITY)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/origin|generated|imported/i)
  })

  it('rejects a key whose hardware-enforced purpose does not include SIGN (WR-04)', async () => {
    const root = await generateTestRootCa()
    const challenge = makeChallenge()
    const { chainDer } = await buildSyntheticKeyDescription({
      root,
      securityLevel: SecurityLevel.trustedEnvironment,
      attestationChallenge: boundChallengeBytes(challenge),
      purpose: [3] // KeyPurpose.VERIFY only — not SIGN
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
})
