import { compactDecrypt, compactVerify } from 'jose'
import type { AttestationChallenge, AttestationVerification } from '@votetorrent/vote-core'
import type { IIntegrityKeyProvider } from '../key-provider.js'
import { recomputeChallengeDigest } from './digest-binding.js'

/**
 * play-integrity.ts — offline classic-API Google Play Integrity verification
 * (D-04): decrypt+verify a compact JWE-of-JWS token with locally-held Play
 * Console key material (via `IIntegrityKeyProvider`) — no GCP account, no
 * live Google dependency.
 *
 * Wire shape (RESEARCH.md Pattern 1): the outer compact JWE is
 * A256KW-key-wrapped / A256GCM-content-encrypted; its plaintext is a
 * compact ES256 JWS whose payload is the classic decoded-integrity JSON:
 * `requestDetails` / `appIntegrity` / `deviceIntegrity`. This function reads
 * ONLY `requestDetails.nonce` (the classic API's anti-relay field) — NEVER
 * `requestHash` (the standard/Google-managed API's field, out of scope for
 * D-04's rejected-standard-API decision; Common Pitfall 1).
 *
 * Every `jose` exception (tampered ciphertext failing GCM auth, a JWS
 * signature that doesn't verify against the configured key, malformed
 * tokens) is caught and converted to a structured `{ ok: false, reason }`
 * result — mirroring `database/initialize.ts`'s `verifySig()` discipline:
 * never let a crypto-library exception propagate as an unhandled throw.
 *
 * Deliberately takes NO `EngineContext`/db handle — this is a pure,
 * composable verifier function (Pitfall 3). Key material and pinned
 * config are injected via `keyProvider` instead.
 */

const FRESHNESS_WINDOW_MS = 5 * 60_000 // 5 minutes — classic-API tokens are meant to be verified promptly after minting

interface DecodedIntegrityPayload {
  requestDetails: { requestPackageName: string, nonce: string, timestampMillis: string }
  appIntegrity: { appRecognitionVerdict: string, packageName: string, certificateSha256Digest?: string[] }
  deviceIntegrity: { deviceRecognitionVerdict: string[] }
  accountDetails?: { accountsSignedIn: string[] }
}

/**
 * Verify a classic-API Play Integrity compact JWE-of-JWS token offline
 * against an issued `AttestationChallenge`.
 *
 * Enforces, in order, each with a distinct `reason`:
 *  1. The token decrypts (A256KW/A256GCM) and verifies (ES256) against the
 *     keys `keyProvider` supplies.
 *  2. `requestDetails.requestPackageName` matches `appIntegrity.packageName`
 *     (D-09 wrong-package negative).
 *  3. `appIntegrity.appRecognitionVerdict === 'PLAY_RECOGNIZED'`.
 *  4. `deviceIntegrity.deviceRecognitionVerdict` includes
 *     `'MEETS_DEVICE_INTEGRITY'` — the D-02 balanced device bar. FAILS /
 *     MEETS_BASIC_INTEGRITY-only / MEETS_VIRTUAL_INTEGRITY (emulator) are
 *     all rejected; STRONG is not required.
 *  5. `requestDetails.timestampMillis` is fresh (within
 *     `FRESHNESS_WINDOW_MS`).
 *  6. `requestDetails.nonce` equals
 *     `recomputeChallengeDigest(challenge.nonce, challenge.deviceKey)` — the
 *     D-06 anti-relay binding, welding this token to the exact voting key.
 */
export async function verifyPlayIntegrity (
  jweCompact: string,
  challenge: AttestationChallenge,
  keyProvider: IIntegrityKeyProvider
): Promise<AttestationVerification> {
  let payload: DecodedIntegrityPayload

  try {
    const decryptionKey = await keyProvider.getDecryptionKey()
    const { plaintext } = await compactDecrypt(jweCompact, decryptionKey)
    const innerJws = new TextDecoder().decode(plaintext)

    const verificationKey = await keyProvider.getVerificationKey()
    // CR-01: pin the JWS signature algorithm to ES256. Without an `algorithms`
    // allowlist, jose honors whatever `alg` the attacker names in the JWS
    // header — including `HS256`, which turns the (public / placeholder)
    // verification key bytes into an HMAC secret (algorithm-confusion forgery).
    // The key MUST also be a real EC public key (see key-provider.ts), never a
    // raw Uint8Array, so a symmetric HMAC path is structurally impossible.
    const { payload: verifiedPayload } = await compactVerify(innerJws, verificationKey, { algorithms: ['ES256'] })
    payload = JSON.parse(new TextDecoder().decode(verifiedPayload)) as DecodedIntegrityPayload
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `Play Integrity token decrypt/verify failed: ${message}` }
  }

  const { requestDetails, appIntegrity, deviceIntegrity } = payload

  if (requestDetails.requestPackageName !== appIntegrity.packageName) {
    return { ok: false, reason: `requestDetails.requestPackageName ('${requestDetails.requestPackageName}') does not match appIntegrity.packageName ('${appIntegrity.packageName}')` }
  }

  if (appIntegrity.appRecognitionVerdict !== 'PLAY_RECOGNIZED') {
    return { ok: false, reason: `appIntegrity.appRecognitionVerdict is '${appIntegrity.appRecognitionVerdict}', expected PLAY_RECOGNIZED` }
  }

  if (!deviceIntegrity.deviceRecognitionVerdict.includes('MEETS_DEVICE_INTEGRITY')) {
    return { ok: false, reason: `deviceIntegrity.deviceRecognitionVerdict [${deviceIntegrity.deviceRecognitionVerdict.join(', ')}] does not meet the required device-integrity verdict bar (D-02)` }
  }

  const timestampMs = Number(requestDetails.timestampMillis)
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > FRESHNESS_WINDOW_MS) {
    return { ok: false, reason: `requestDetails.timestampMillis ('${requestDetails.timestampMillis}') is stale or unparseable — token is not fresh` }
  }

  const boundNonce = recomputeChallengeDigest(challenge.nonce, challenge.deviceKey)
  if (requestDetails.nonce !== boundNonce) {
    return { ok: false, reason: 'requestDetails.nonce does not equal Digest(challenge.nonce, challenge.deviceKey) — D-06 anti-relay binding failed' }
  }

  return { ok: true }
}
