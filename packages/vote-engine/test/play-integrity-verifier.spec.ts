/**
 * play-integrity-verifier.spec.ts — Phase 43 D-01/D-02/D-06/D-09 branch
 * matrix for the Play Integrity half of the device attestation verifier
 * (43-02, Wave 0 — RED). `verifyPlayIntegrity` lands in Wave 3; until then
 * this spec fails at import (the module does not exist yet) — that IS the
 * expected state. Do NOT stub the verifier here.
 *
 * Locked contract (RESEARCH.md Pattern 1 / Common Pitfall 1): the classic
 * API's anti-relay field is `requestDetails.nonce` — NEVER the standard
 * API's request-hash field (that belongs to the standard/Google-managed
 * API D-04 rejected). This file must never reference that other field.
 *
 * Structure mirrors `association.spec.ts`'s `StubAttestationVerifier` block
 * (:353-397): `describe -> helper factory with overrides -> it() pairs`
 * asserting `result.ok` + a `result.reason` regex, never a thrown exception.
 *
 * Phase 47 (D-09) — a SECOND top-level `describe` block below covers the
 * `PlayIntegrityVerifier` CLASS itself, not just the free `verifyPlayIntegrity`
 * function above. It exists because D-09 relocated the CR-03 fail-closed
 * "Play Console keys not provisioned" check from
 * `engine-factory.ts:402-406` (a construction-time throw) into `verify()`'s
 * first statement (an early-returned `{ ok: false, reason }` tuple), gated
 * by a new `keysProvisioned` constructor parameter. As an explicit
 * mutation-lock note: deleting or relocating the `this.keysProvisioned`
 * guard in `play-integrity-verifier.ts` MUST turn tests (a) and (c) below
 * RED.
 */

import { expect } from 'chai'
import { digestFields, resolveHasher, resolveOutputEncoder } from '@optimystic/quereus-plugin-crypto'
import type { AttestationChallenge, DeviceAttestation } from '@votetorrent/vote-core'
// Wave-3 target — does not exist yet. This import failing IS the RED gate.
import { verifyPlayIntegrity } from '../src/association/verifiers/play-integrity.js'
import { PlayIntegrityVerifier } from '../src/association/play-integrity-verifier.js'
import type { IIntegrityKeyProvider } from '../src/association/key-provider.js'
import { generateTestRootCa } from './fixtures/attestation/test-root-ca.js'
import { buildSyntheticDeviceAttestation } from './fixtures/attestation/synthetic-device-attestation.js'
import { generateAndroidDeviceKeyPair } from './fixtures/attestation/synthetic-key-description.js'
import { p256KeyToCompressedHex } from '../src/voting/vote-signing.js'
import {
  buildDefaultSyntheticPayload,
  buildForgedHs256Jwe,
  buildSyntheticJwe,
  generateSyntheticJweKeyMaterial,
  SYNTHETIC_EXPECTED_APP_IDENTITY,
  type SyntheticJwePayloadOverrides
} from './fixtures/attestation/synthetic-jwe.js'

// Same registered config the schema's SQL `Digest()` UDF uses
// (`database/initialize.ts:99`) — never a hand-rolled sha256(nonce+deviceKey).
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

/** The exact wire-format this plan locks: base64url(Digest(nonce, deviceKey)) bound into requestDetails.nonce. */
function boundNonce (challenge: Pick<AttestationChallenge, 'nonce' | 'deviceKey'>): string {
  return digestFields([challenge.nonce, challenge.deviceKey], hasher, encode) as string
}

async function buildTokenFor (challenge: AttestationChallenge, payloadOverrides?: SyntheticJwePayloadOverrides) {
  const keys = await generateSyntheticJweKeyMaterial()
  const payload = buildDefaultSyntheticPayload({ nonce: boundNonce(challenge), ...payloadOverrides })
  const jwe = await buildSyntheticJwe(payload, keys)
  const keyProvider = {
    getDecryptionKey: async () => keys.decryptionKey,
    getVerificationKey: async () => keys.verificationPublicKey
  }
  return { jwe, keys, keyProvider, payload }
}

describe('verifyPlayIntegrity (D-01/D-02/D-06/D-09)', () => {
  it('returns ok:true for a PASS token bound to Digest(nonce, deviceKey)', async () => {
    const challenge = makeChallenge()
    const { jwe, keyProvider } = await buildTokenFor(challenge)
    const result = await verifyPlayIntegrity(jwe, challenge, keyProvider, SYNTHETIC_EXPECTED_APP_IDENTITY)
    expect(result.ok).to.equal(true)
  })

  it('rejects an HS256 algorithm-confusion forgery signed with the verification-key bytes (CR-01 regression)', async () => {
    const challenge = makeChallenge()
    const keys = await generateSyntheticJweKeyMaterial()
    // The raw SPKI bytes of the ES256 public key — exactly what a naive
    // `LocalConfigKeyProvider` would hand `jose` as the "verification key",
    // and what an attacker who knows the (public / placeholder) key can use as
    // an HMAC secret. An otherwise-PASS payload isolates the algorithm as the
    // ONLY thing that can reject this token.
    const spkiBytes = new Uint8Array(await crypto.subtle.exportKey('spki', keys.verificationPublicKey as unknown as globalThis.CryptoKey))
    const payload = buildDefaultSyntheticPayload({ nonce: boundNonce(challenge) })
    const forgedJwe = await buildForgedHs256Jwe(payload, keys.decryptionKey, spkiBytes)
    // A deliberately-vulnerable provider that returns the raw key bytes: only
    // an ES256 algorithm allowlist + real EC-public-key import can save us.
    const keyProvider = { getDecryptionKey: async () => keys.decryptionKey, getVerificationKey: async () => spkiBytes }

    const result = await verifyPlayIntegrity(forgedJwe, challenge, keyProvider, SYNTHETIC_EXPECTED_APP_IDENTITY)
    expect(result.ok).to.equal(false)
  })

  it('returns ok:false (never throws) for a verified-but-malformed payload missing deviceIntegrity (WR-02)', async () => {
    const challenge = makeChallenge()
    const keys = await generateSyntheticJweKeyMaterial()
    // A correctly-signed token whose payload is missing `deviceIntegrity`
    // entirely — the pre-WR-02 code would `.includes` on `undefined` and throw.
    const malformed = {
      requestDetails: { requestPackageName: 'org.votetorrent.authority', nonce: boundNonce(challenge), timestampMillis: String(Date.now()) },
      appIntegrity: { appRecognitionVerdict: 'PLAY_RECOGNIZED', packageName: 'org.votetorrent.authority', certificateSha256Digest: ['synthetic-cert-sha256-digest'] }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jwe = await buildSyntheticJwe(malformed as any, keys)
    const keyProvider = { getDecryptionKey: async () => keys.decryptionKey, getVerificationKey: async () => keys.verificationPublicKey }

    let result: Awaited<ReturnType<typeof verifyPlayIntegrity>> | undefined
    let threw = false
    try {
      result = await verifyPlayIntegrity(jwe, challenge, keyProvider, SYNTHETIC_EXPECTED_APP_IDENTITY)
    } catch {
      threw = true
    }
    expect(threw, 'verifyPlayIntegrity must not throw on a malformed payload').to.equal(false)
    expect(result?.ok).to.equal(false)
    expect(result?.reason).to.match(/shape|deviceIntegrity|invalid/i)
  })

  it('rejects a tampered ciphertext', async () => {
    const challenge = makeChallenge()
    const keys = await generateSyntheticJweKeyMaterial()
    const payload = buildDefaultSyntheticPayload({ nonce: boundNonce(challenge) })
    const jwe = await buildSyntheticJwe(payload, keys, { tamperCiphertext: true })
    const keyProvider = { getDecryptionKey: async () => keys.decryptionKey, getVerificationKey: async () => keys.verificationPublicKey }

    const result = await verifyPlayIntegrity(jwe, challenge, keyProvider, SYNTHETIC_EXPECTED_APP_IDENTITY)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/decrypt|tamper|integrity/i)
  })

  it('rejects a token signed with the wrong ES256 key', async () => {
    const challenge = makeChallenge()
    const keys = await generateSyntheticJweKeyMaterial()
    const wrongKeys = await generateSyntheticJweKeyMaterial()
    const payload = buildDefaultSyntheticPayload({ nonce: boundNonce(challenge) })
    const jwe = await buildSyntheticJwe(payload, keys, { signingKey: wrongKeys.signingPrivateKey })
    const keyProvider = { getDecryptionKey: async () => keys.decryptionKey, getVerificationKey: async () => keys.verificationPublicKey }

    const result = await verifyPlayIntegrity(jwe, challenge, keyProvider, SYNTHETIC_EXPECTED_APP_IDENTITY)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/sign|verify|key/i)
  })

  it('rejects when appIntegrity.packageName does not match requestDetails.requestPackageName', async () => {
    const challenge = makeChallenge()
    const { jwe, keyProvider } = await buildTokenFor(challenge, {
      requestPackageName: 'org.votetorrent.authority',
      appPackageName: 'com.attacker.relay'
    })
    const result = await verifyPlayIntegrity(jwe, challenge, keyProvider, SYNTHETIC_EXPECTED_APP_IDENTITY)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/package/i)
  })

  it('rejects a genuine-but-DIFFERENT app whose token is internally consistent (CR-04 wrong-app relay)', async () => {
    // requestPackageName === appIntegrity.packageName (internally consistent),
    // so the internal-consistency check passes — but it is NOT our authority
    // app, so the CR-04 package pin must reject it.
    const challenge = makeChallenge()
    const { jwe, keyProvider } = await buildTokenFor(challenge, { requestPackageName: 'com.other.playapp' })
    const result = await verifyPlayIntegrity(jwe, challenge, keyProvider, SYNTHETIC_EXPECTED_APP_IDENTITY)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/expected authority app package|package/i)
  })

  it('rejects when appIntegrity.certificateSha256Digest is not on the allowlist (CR-04 wrong signing cert)', async () => {
    const challenge = makeChallenge()
    const keys = await generateSyntheticJweKeyMaterial()
    const payload = buildDefaultSyntheticPayload({ nonce: boundNonce(challenge) })
    // Present a digest the allowlist does not contain (a different signing key).
    payload.appIntegrity.certificateSha256Digest = ['Zm9yZ2VkLWNlcnQtZGlnZXN0']
    const jwe = await buildSyntheticJwe(payload, keys)
    const keyProvider = { getDecryptionKey: async () => keys.decryptionKey, getVerificationKey: async () => keys.verificationPublicKey }

    const result = await verifyPlayIntegrity(jwe, challenge, keyProvider, SYNTHETIC_EXPECTED_APP_IDENTITY)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/certificate|digest|signing/i)
  })

  it('rejects when appRecognitionVerdict is not PLAY_RECOGNIZED', async () => {
    const challenge = makeChallenge()
    const { jwe, keyProvider } = await buildTokenFor(challenge, { appRecognitionVerdict: 'UNRECOGNIZED' })
    const result = await verifyPlayIntegrity(jwe, challenge, keyProvider, SYNTHETIC_EXPECTED_APP_IDENTITY)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/app.*recogni|verdict/i)
  })

  it('rejects deviceRecognitionVerdict = FAILS_DEVICE_INTEGRITY (D-02)', async () => {
    const challenge = makeChallenge()
    const { jwe, keyProvider } = await buildTokenFor(challenge, { deviceRecognitionVerdict: ['FAILS_DEVICE_INTEGRITY'] })
    const result = await verifyPlayIntegrity(jwe, challenge, keyProvider, SYNTHETIC_EXPECTED_APP_IDENTITY)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/device.*integrity|verdict/i)
  })

  it('rejects deviceRecognitionVerdict = [MEETS_BASIC_INTEGRITY] only — below the balanced bar (D-02)', async () => {
    const challenge = makeChallenge()
    const { jwe, keyProvider } = await buildTokenFor(challenge, { deviceRecognitionVerdict: ['MEETS_BASIC_INTEGRITY'] })
    const result = await verifyPlayIntegrity(jwe, challenge, keyProvider, SYNTHETIC_EXPECTED_APP_IDENTITY)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/device.*integrity|verdict/i)
  })

  it('rejects deviceRecognitionVerdict = [MEETS_VIRTUAL_INTEGRITY] — emulator signal, below the balanced bar (D-02)', async () => {
    const challenge = makeChallenge()
    const { jwe, keyProvider } = await buildTokenFor(challenge, { deviceRecognitionVerdict: ['MEETS_VIRTUAL_INTEGRITY'] })
    const result = await verifyPlayIntegrity(jwe, challenge, keyProvider, SYNTHETIC_EXPECTED_APP_IDENTITY)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/device.*integrity|verdict/i)
  })

  it('rejects a stale timestampMillis (freshness)', async () => {
    const challenge = makeChallenge()
    const staleTimestampMillis = String(Date.now() - 10 * 60_000) // 10 minutes old
    const { jwe, keyProvider } = await buildTokenFor(challenge, { timestampMillis: staleTimestampMillis })
    const result = await verifyPlayIntegrity(jwe, challenge, keyProvider, SYNTHETIC_EXPECTED_APP_IDENTITY)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/stale|expired|fresh|timestamp/i)
  })

  it('rejects when requestDetails.nonce does not equal base64url(Digest(nonce, deviceKey)) — D-06 cross-key relay', async () => {
    const challenge = makeChallenge()
    const keys = await generateSyntheticJweKeyMaterial()
    const payload = buildDefaultSyntheticPayload({ nonce: 'this-is-not-the-bound-digest' })
    const jwe = await buildSyntheticJwe(payload, keys)
    const keyProvider = { getDecryptionKey: async () => keys.decryptionKey, getVerificationKey: async () => keys.verificationPublicKey }

    const result = await verifyPlayIntegrity(jwe, challenge, keyProvider, SYNTHETIC_EXPECTED_APP_IDENTITY)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/nonce|digest|binding/i)
  })
})

/**
 * Build a real `PlayIntegrityVerifier`, mirroring
 * `association-attestation-policy.spec.ts:133-141`'s `buildRealVerifier()`.
 * `keysProvisioned` is threaded through as the 5th ctor argument ONLY when
 * the caller passes a value — the default-arity test (e) below calls this
 * with no argument at all and constructs the THREE-argument form, so the
 * `= true` default is genuinely exercised rather than restated.
 */
async function buildClassVerifier (keysProvisioned?: boolean): Promise<{
  verifier: PlayIntegrityVerifier
  jweKeys: Awaited<ReturnType<typeof generateSyntheticJweKeyMaterial>>
  testRoot: Awaited<ReturnType<typeof generateTestRootCa>>
  keyProvider: IIntegrityKeyProvider
}> {
  const jweKeys = await generateSyntheticJweKeyMaterial()
  const testRoot = await generateTestRootCa()
  const keyProvider: IIntegrityKeyProvider = {
    getDecryptionKey: async () => jweKeys.decryptionKey,
    getVerificationKey: async () => jweKeys.verificationPublicKey
  }
  const pinnedRoots = [new Uint8Array(testRoot.cert.rawData)]
  const verifier = keysProvisioned === undefined
    ? new PlayIntegrityVerifier(keyProvider, pinnedRoots, SYNTHETIC_EXPECTED_APP_IDENTITY)
    : new PlayIntegrityVerifier(keyProvider, pinnedRoots, SYNTHETIC_EXPECTED_APP_IDENTITY, new Set<string>(), keysProvisioned)
  return { verifier, jweKeys, testRoot, keyProvider }
}

describe('PlayIntegrityVerifier class — D-09 keysProvisioned fail-closed relocation', () => {
  it('(a) fail-closed: keysProvisioned=false rejects the SAME fixture (b) proves is accepted', async () => {
    const challenge = makeChallenge()
    const { verifier, jweKeys, testRoot } = await buildClassVerifier(false)
    // Same buildSyntheticDeviceAttestation fixture, no overrides — the fixture
    // that (b) proves is ACCEPTED by a provisioned verifier. keysProvisioned
    // is therefore the only variable that differs between (a) and (b).
    const attestation = await buildSyntheticDeviceAttestation({ challenge, jweKeys, testRoot })
    const result = await verifier.verify(challenge, attestation)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/not provisioned/i)
    expect(result.reason).to.include('SETUP.md')
  })

  it('(b) positive control: the normal path still runs to completion when provisioned', async () => {
    // 51-02: the leaf certificate's embedded public key must equal
    // challenge.deviceKey (verifyKeyAttestation's 4b-2 binding check), so the
    // challenge and the synthetic chain must share the SAME generated keypair.
    const { keyPair, deviceKeySpkiBase64 } = await generateAndroidDeviceKeyPair()
    const challenge = makeChallenge({ deviceKey: deviceKeySpkiBase64 })
    const { verifier, jweKeys, testRoot } = await buildClassVerifier(true)
    const attestation = await buildSyntheticDeviceAttestation({ challenge, jweKeys, testRoot, overrides: { leafKeyPair: keyPair } })
    const result = await verifier.verify(challenge, attestation)
    // This is what stops (a) from passing vacuously against a fixture that
    // was broken all along, and proves the guard does not short-circuit the
    // real Play Integrity + Key Attestation path when keys ARE provisioned.
    expect(result.ok, 'positive control: a provisioned verifier must still accept the default synthetic attestation end to end').to.equal(true)
  })

  it('(c) ordering: the guard is the FIRST statement, unmasked by the platform-details rejection', async () => {
    const challenge = makeChallenge()
    const { verifier } = await buildClassVerifier(false)
    // An iOS-platform attestation — input the UNGUARDED body rejects at its
    // very first check with 'attestation carries no Android platform
    // details'. This is the structural fail-open detector: if the guard is
    // ever moved below the `android` narrowing, this test reports the
    // platform-details reason instead and goes RED.
    const attestation: DeviceAttestation = {
      publicKey: 'synthetic-device-voting-pubkey',
      deviceId: 'synthetic-device-ios-1',
      attestationTime: Date.now(),
      certificateChain: [],
      platformDetails: {
        type: 'iOS',
        secureEnclavePublicKey: 'synthetic-secure-enclave-pubkey'
      }
    }
    const result = await verifier.verify(challenge, attestation)
    expect(result.reason).to.match(/not provisioned/i)
    expect(result.reason).to.not.match(/platform details/i)
  })

  it('(d) never-throws contract preserved (play-integrity-verifier.ts:21-24), and the guard genuinely governs the result', async () => {
    const challenge = makeChallenge()
    const { verifier, jweKeys, testRoot } = await buildClassVerifier(false)
    // The default (accepted) synthetic Android attestation — the SAME fixture
    // (b) proves a PROVISIONED verifier accepts end to end. Using it here
    // (rather than the iOS input from (c)) makes this test doubly load-bearing:
    // it exercises the never-throws contract using the file's own :104-113
    // try/catch shape, AND its `result.ok` assertion is itself a THIRD
    // guard-specific detector — if the `this.keysProvisioned` guard is ever
    // removed, this well-formed attestation runs the full real Play Integrity
    // + Key Attestation path and resolves `{ ok: true }` instead, flipping
    // this assertion (unlike test (c)'s iOS input, which the unguarded body
    // would independently reject via the `android` narrowing and so cannot
    // detect a missing guard on its own).
    const attestation = await buildSyntheticDeviceAttestation({ challenge, jweKeys, testRoot })

    let result: Awaited<ReturnType<typeof verifier.verify>> | undefined
    let threw = false
    try {
      result = await verifier.verify(challenge, attestation)
    } catch {
      threw = true
    }
    expect(threw, 'PlayIntegrityVerifier.verify must not throw when keys are unprovisioned').to.equal(false)
    expect(result?.ok).to.equal(false)
  })

  it('(e) default-arity lock: the three-argument constructor form leaves the verifier provisioned', async () => {
    // 51-02: see (b)'s comment — the leaf key must match challenge.deviceKey.
    const { keyPair, deviceKeySpkiBase64 } = await generateAndroidDeviceKeyPair()
    const challenge = makeChallenge({ deviceKey: deviceKeySpkiBase64 })
    const { verifier, jweKeys, testRoot } = await buildClassVerifier()
    const attestation = await buildSyntheticDeviceAttestation({ challenge, jweKeys, testRoot, overrides: { leafKeyPair: keyPair } })
    const result = await verifier.verify(challenge, attestation)
    // Locks the `= true` default so association-attestation-policy.spec.ts:140
    // and authority-transport.spec.ts's existing 3-argument construction
    // sites keep behaving identically. Corollary: the authority EngineFactory
    // MUST thread the real flag in (47-09) — forgetting the argument fails OPEN.
    expect(result.ok).to.equal(true)
    expect(result.reason).to.equal(undefined)
  })
})

// Spike 104 (R1d): the real Android ceremony presents the voting key's own chain (provisioning tag)
// beside a throwaway key's nonce-bound chain. Both must pass; either failing rejects, and the reason
// names which one.
describe('PlayIntegrityVerifier — two-chain Android form (spike 104, R1d)', () => {
  async function twoChain (mutate?: { deviceLeaf?: CryptoKeyPair, deviceChallenge?: Uint8Array, freshChallenge?: Uint8Array }) {
    const { keyPair: votingKey, deviceKeySpkiBase64 } = await generateAndroidDeviceKeyPair()
    const { keyPair: throwaway } = await generateAndroidDeviceKeyPair()
    const challenge = makeChallenge({ deviceKey: p256KeyToCompressedHex(deviceKeySpkiBase64) })
    const { verifier, jweKeys, testRoot } = await buildClassVerifier(true)
    const attestation = await buildSyntheticDeviceAttestation({
      challenge,
      jweKeys,
      testRoot,
      overrides: {
        leafKeyPair: throwaway,
        ...(mutate?.freshChallenge !== undefined ? { attestationChallengeBytes: mutate.freshChallenge } : {}),
        deviceKeyChain: { leafKeyPair: mutate?.deviceLeaf ?? votingKey, ...(mutate?.deviceChallenge !== undefined ? { attestationChallengeBytes: mutate.deviceChallenge } : {}) }
      }
    })
    return { verifier, challenge, attestation }
  }

  it('accepts the honest two-chain attestation (voting key tagged, throwaway key nonce-bound)', async () => {
    const { verifier, challenge, attestation } = await twoChain()
    const result = await verifier.verify(challenge, attestation)
    expect(result.ok, result.ok ? '' : result.reason).to.equal(true)
  })

  it("REJECTS when the device-key chain's leaf is another key (T-51-02-01)", async () => {
    const { keyPair: other } = await generateAndroidDeviceKeyPair()
    const { verifier, challenge, attestation } = await twoChain({ deviceLeaf: other })
    const result = await verifier.verify(challenge, attestation)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/^device-key chain: .*not the challenge deviceKey/)
  })

  it('REJECTS when the device-key chain lacks the provisioning tag', async () => {
    const { verifier, challenge, attestation } = await twoChain({ deviceChallenge: new TextEncoder().encode('some-other-tag') })
    const result = await verifier.verify(challenge, attestation)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/^device-key chain: .*provisioning tag/)
  })

  it('REJECTS when the nonce-bound chain answers a different nonce (anti-relay)', async () => {
    const { verifier, challenge, attestation } = await twoChain({ freshChallenge: new TextEncoder().encode(boundNonce({ nonce: 'an-earlier-nonce', deviceKey: 'x' })) })
    const result = await verifier.verify(challenge, attestation)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/^nonce-bound chain: /)
  })
})

