import { compactDecrypt, compactVerify } from 'jose'
import type { AttestationChallenge, AttestationVerification } from '@votetorrent/vote-core'
import type { IIntegrityKeyProvider } from '../key-provider.js'
import { recomputeChallengeDigest } from './digest-binding.js'
import { certDigestBase64ToHex, type ExpectedAppIdentity } from './app-identity.js'

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

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * WR-02: validate the decoded (verified) payload has the exact shape this
 * verifier reads BEFORE any field access, so a signer emitting a differently
 * shaped payload (schema drift, a missing field) yields a structured
 * `{ ok:false, reason }` rather than a `TypeError` (e.g. `.includes` on
 * `undefined`) that would propagate as an unhandled rejection — the class
 * contract is "never throws for adversarial input".
 */
function validateDecodedShape (payload: unknown): string | undefined {
  if (!isRecord(payload)) return 'decoded Play Integrity payload is not an object'

  const { requestDetails, appIntegrity, deviceIntegrity } = payload
  if (!isRecord(requestDetails)) return 'payload.requestDetails is missing or not an object'
  if (typeof requestDetails.requestPackageName !== 'string') return 'payload.requestDetails.requestPackageName is missing or not a string'
  if (typeof requestDetails.nonce !== 'string') return 'payload.requestDetails.nonce is missing or not a string'
  if (typeof requestDetails.timestampMillis !== 'string') return 'payload.requestDetails.timestampMillis is missing or not a string'

  if (!isRecord(appIntegrity)) return 'payload.appIntegrity is missing or not an object'
  if (typeof appIntegrity.appRecognitionVerdict !== 'string') return 'payload.appIntegrity.appRecognitionVerdict is missing or not a string'
  if (typeof appIntegrity.packageName !== 'string') return 'payload.appIntegrity.packageName is missing or not a string'

  if (!isRecord(deviceIntegrity)) return 'payload.deviceIntegrity is missing or not an object'
  if (!Array.isArray(deviceIntegrity.deviceRecognitionVerdict)) return 'payload.deviceIntegrity.deviceRecognitionVerdict is missing or not an array'

  return undefined
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
  keyProvider: IIntegrityKeyProvider,
  expectedAppIdentity: ExpectedAppIdentity
): Promise<AttestationVerification> {
  let payload: DecodedIntegrityPayload

  try {
    const decryptionKey = await keyProvider.getDecryptionKey()
    // CR-02: pin the JWE key-management + content-encryption algorithms to the
    // fixed classic-API wire contract (A256KW / A256GCM). Without these
    // allowlists jose honors any `alg`/`enc` the attacker names in the
    // protected header — a downgrade/confusion barrier removed for free.
    const { plaintext } = await compactDecrypt(jweCompact, decryptionKey, {
      keyManagementAlgorithms: ['A256KW'],
      contentEncryptionAlgorithms: ['A256GCM']
    })
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

  const shapeError = validateDecodedShape(payload)
  if (shapeError !== undefined) {
    return { ok: false, reason: `Play Integrity payload shape invalid: ${shapeError}` }
  }

  const { requestDetails, appIntegrity, deviceIntegrity } = payload

  if (requestDetails.requestPackageName !== appIntegrity.packageName) {
    return { ok: false, reason: `requestDetails.requestPackageName ('${requestDetails.requestPackageName}') does not match appIntegrity.packageName ('${appIntegrity.packageName}')` }
  }

  // CR-04: pin the token to THIS app — not merely internally consistent. A
  // different Play-recognized app minting a token that carries the bound nonce
  // must be rejected (anti-relay, D-06/D-09).
  if (appIntegrity.packageName !== expectedAppIdentity.packageName) {
    return { ok: false, reason: `appIntegrity.packageName ('${appIntegrity.packageName}') is not the expected authority app package ('${expectedAppIdentity.packageName}')` }
  }

  const allowedCertDigests = new Set(expectedAppIdentity.certificateSha256Digests)
  const presentedCertDigests = appIntegrity.certificateSha256Digest ?? []
  const certDigestMatches = presentedCertDigests.some((digest) => {
    try {
      return allowedCertDigests.has(certDigestBase64ToHex(digest))
    } catch {
      return false
    }
  })
  if (!certDigestMatches) {
    return { ok: false, reason: 'appIntegrity.certificateSha256Digest does not match any allowlisted signing-certificate digest for this app' }
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
