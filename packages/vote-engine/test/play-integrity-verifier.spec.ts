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
 */

import { expect } from 'chai'
import { digestFields, resolveHasher, resolveOutputEncoder } from '@optimystic/quereus-plugin-crypto'
import type { AttestationChallenge } from '@votetorrent/vote-core'
// Wave-3 target — does not exist yet. This import failing IS the RED gate.
import { verifyPlayIntegrity } from '../src/association/verifiers/play-integrity.js'
import {
  buildDefaultSyntheticPayload,
  buildForgedHs256Jwe,
  buildSyntheticJwe,
  generateSyntheticJweKeyMaterial,
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
    expiration: new Date(Date.now() + 60_000).toISOString(),
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
    const result = await verifyPlayIntegrity(jwe, challenge, keyProvider)
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

    const result = await verifyPlayIntegrity(forgedJwe, challenge, keyProvider)
    expect(result.ok).to.equal(false)
  })

  it('rejects a tampered ciphertext', async () => {
    const challenge = makeChallenge()
    const keys = await generateSyntheticJweKeyMaterial()
    const payload = buildDefaultSyntheticPayload({ nonce: boundNonce(challenge) })
    const jwe = await buildSyntheticJwe(payload, keys, { tamperCiphertext: true })
    const keyProvider = { getDecryptionKey: async () => keys.decryptionKey, getVerificationKey: async () => keys.verificationPublicKey }

    const result = await verifyPlayIntegrity(jwe, challenge, keyProvider)
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

    const result = await verifyPlayIntegrity(jwe, challenge, keyProvider)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/sign|verify|key/i)
  })

  it('rejects when appIntegrity.packageName does not match requestDetails.requestPackageName', async () => {
    const challenge = makeChallenge()
    const { jwe, keyProvider } = await buildTokenFor(challenge, {
      requestPackageName: 'org.votetorrent.authority',
      appPackageName: 'com.attacker.relay'
    })
    const result = await verifyPlayIntegrity(jwe, challenge, keyProvider)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/package/i)
  })

  it('rejects when appRecognitionVerdict is not PLAY_RECOGNIZED', async () => {
    const challenge = makeChallenge()
    const { jwe, keyProvider } = await buildTokenFor(challenge, { appRecognitionVerdict: 'UNRECOGNIZED' })
    const result = await verifyPlayIntegrity(jwe, challenge, keyProvider)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/app.*recogni|verdict/i)
  })

  it('rejects deviceRecognitionVerdict = FAILS_DEVICE_INTEGRITY (D-02)', async () => {
    const challenge = makeChallenge()
    const { jwe, keyProvider } = await buildTokenFor(challenge, { deviceRecognitionVerdict: ['FAILS_DEVICE_INTEGRITY'] })
    const result = await verifyPlayIntegrity(jwe, challenge, keyProvider)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/device.*integrity|verdict/i)
  })

  it('rejects deviceRecognitionVerdict = [MEETS_BASIC_INTEGRITY] only — below the balanced bar (D-02)', async () => {
    const challenge = makeChallenge()
    const { jwe, keyProvider } = await buildTokenFor(challenge, { deviceRecognitionVerdict: ['MEETS_BASIC_INTEGRITY'] })
    const result = await verifyPlayIntegrity(jwe, challenge, keyProvider)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/device.*integrity|verdict/i)
  })

  it('rejects deviceRecognitionVerdict = [MEETS_VIRTUAL_INTEGRITY] — emulator signal, below the balanced bar (D-02)', async () => {
    const challenge = makeChallenge()
    const { jwe, keyProvider } = await buildTokenFor(challenge, { deviceRecognitionVerdict: ['MEETS_VIRTUAL_INTEGRITY'] })
    const result = await verifyPlayIntegrity(jwe, challenge, keyProvider)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/device.*integrity|verdict/i)
  })

  it('rejects a stale timestampMillis (freshness)', async () => {
    const challenge = makeChallenge()
    const staleTimestampMillis = String(Date.now() - 10 * 60_000) // 10 minutes old
    const { jwe, keyProvider } = await buildTokenFor(challenge, { timestampMillis: staleTimestampMillis })
    const result = await verifyPlayIntegrity(jwe, challenge, keyProvider)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/stale|expired|fresh|timestamp/i)
  })

  it('rejects when requestDetails.nonce does not equal base64url(Digest(nonce, deviceKey)) — D-06 cross-key relay', async () => {
    const challenge = makeChallenge()
    const keys = await generateSyntheticJweKeyMaterial()
    const payload = buildDefaultSyntheticPayload({ nonce: 'this-is-not-the-bound-digest' })
    const jwe = await buildSyntheticJwe(payload, keys)
    const keyProvider = { getDecryptionKey: async () => keys.decryptionKey, getVerificationKey: async () => keys.verificationPublicKey }

    const result = await verifyPlayIntegrity(jwe, challenge, keyProvider)
    expect(result.ok).to.equal(false)
    expect(result.reason).to.match(/nonce|digest|binding/i)
  })
})
