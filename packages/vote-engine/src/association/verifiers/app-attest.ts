/**
 * app-attest.ts — offline Apple App Attest attestation verification (Phase 51).
 *
 * Structural twin of `packages/vote-engine/src/association/verifiers/key-attestation.ts`:
 *  - same `@peculiar/x509` + `reflect-metadata` stack (no new runtime dependency except CBOR);
 *  - PINNED roots are an INJECTED parameter — never fetched, never taken from the presented chain;
 *  - every parse/validation failure is caught and returned as `{ ok: false, reason }`, never thrown
 *    (the shipped verifiers' "never throws for adversarial input" discipline).
 *
 * Implements Apple's published numbered steps ("Validating apps that connect to your server").
 * Step numbering in the comments is Apple's, so the code can be diffed against the doc.
 */
import 'reflect-metadata'
import { BasicConstraintsExtension, X509Certificate, X509ChainBuilder } from '@peculiar/x509'
import { createHash, timingSafeEqual } from 'node:crypto'
import { cborDecode, type CborValue } from '@votetorrent/vote-core'
import { decodeAppleNonceExtension, APPLE_NONCE_OID } from './apple-nonce-extension.js'

export interface AppAttestVerification {
  ok: boolean
  reason?: string
  /** On success: the attested public key (raw X9.62), for the caller to store against the keyId. */
  attestedPublicKeyRaw?: Uint8Array
}

export interface AppAttestExpectations {
  /** `<teamId>.<bundleId>` — the RP identifier. `rpIdHash` must equal SHA256 of this. */
  appId: string
  /** The `clientDataHash` the server expects: SHA256 of the challenge it issued. */
  expectedClientDataHash: Uint8Array
  /** The keyId the device claimed, base64. Must equal the credential id AND SHA256(attested pubkey). */
  keyId: Uint8Array
  /** PINNED Apple App Attest root(s), DER. Injected — never fetched (D-04 offline posture). */
  pinnedRootsDer: Uint8Array[]
  /** 'development' expects aaguid `appattestdevelop`; 'production' expects `appattest` + 7 zero bytes. */
  environment: 'development' | 'production'
  /**
   * OPTIONAL injected "now" for the STEP 1 chain-validity window check. Defaults to `new Date()`,
   * so PRODUCTION BEHAVIOUR IS UNCHANGED — a genuinely expired chain is still rejected at runtime.
   *
   * This seam exists ONLY so a spec replaying a REAL captured Apple App Attest chain (short-lived
   * leaf certs) can verify it at its CAPTURE time instead of decaying as wall-clock time passes.
   * It is NOT a way to disable expiry checking in production — nothing in the shipped app ever
   * passes this field, and `app-attest-verifier.ts`'s negative controls prove the check still
   * fires when a chain is genuinely outside its validity window at the injected time.
   */
  now?: Date
}

const AAGUID_DEVELOPMENT = new TextEncoder().encode('appattestdevelop')
const AAGUID_PRODUCTION = (() => {
  const b = new Uint8Array(16)
  b.set(new TextEncoder().encode('appattest'))
  return b
})()

// NOTE: `Buffer` is deliberately NOT used here. `Buffer` is not a Hermes global, and this
// module has no `import { Buffer } from 'buffer'` — a bare `Buffer.from` would raise
// `ReferenceError: Buffer is not defined` on device, be swallowed by the outer fail-closed
// `catch`, and reject every genuine attestation with a misleading reason (CR-01). Node's
// `timingSafeEqual` accepts any ArrayBufferView, and the RN shim
// (`apps/VoteTorrentAuthority/polyfills/node-crypto.js`) indexes `a[i] ^ b[i]`, so a plain
// `Uint8Array` is the correct argument on BOTH runtimes. Same fix as
// `verifiers/key-attestation.ts`'s `bytesEqual`.
function bytesEqual (a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function sha256 (...parts: Uint8Array[]): Uint8Array {
  const h = createHash('sha256')
  for (const p of parts) h.update(p)
  return new Uint8Array(h.digest())
}

/** Parsed App Attest authenticator data. */
export interface AuthenticatorData {
  rpIdHash: Uint8Array
  flags: number
  counter: number
  aaguid: Uint8Array
  credentialId: Uint8Array
}

export function parseAuthenticatorData (authData: Uint8Array): AuthenticatorData {
  if (authData.length < 55) throw new Error(`authData too short (${authData.length} bytes)`)
  const rpIdHash = authData.subarray(0, 32)
  const flags = authData[32]!
  const counter = (authData[33]! << 24 >>> 0) + (authData[34]! << 16) + (authData[35]! << 8) + authData[36]!
  const aaguid = authData.subarray(37, 53)
  const credIdLen = (authData[53]! << 8) | authData[54]!
  const credentialId = authData.subarray(55, 55 + credIdLen)
  if (credentialId.length !== credIdLen) throw new Error('authData: credential id runs past the buffer')
  return { rpIdHash, flags, counter, aaguid, credentialId }
}

export async function verifyAppAttest (
  attestationObject: Uint8Array,
  expect: AppAttestExpectations
): Promise<AppAttestVerification> {
  try {
    // ---- decode the CBOR attestation object ----
    const decoded = cborDecode(attestationObject)
    if (!(decoded instanceof Map)) return { ok: false, reason: 'attestation object is not a CBOR map' }
    const fmt = decoded.get('fmt')
    if (fmt !== 'apple-appattest') return { ok: false, reason: `unexpected attestation fmt: ${String(fmt)}` }
    const attStmt = decoded.get('attStmt')
    if (!(attStmt instanceof Map)) return { ok: false, reason: 'attStmt is not a CBOR map' }
    const authData = decoded.get('authData')
    if (!(authData instanceof Uint8Array)) return { ok: false, reason: 'authData is not a byte string' }
    const x5c = attStmt.get('x5c')
    if (!Array.isArray(x5c) || x5c.length < 2) return { ok: false, reason: 'attStmt.x5c must hold at least credCert + intermediate' }

    // ---- STEP 1: verify the chain to a PINNED Apple root ----
    const chainCerts = (x5c as CborValue[]).map(d => new X509Certificate(d as Uint8Array))
    const credCert = chainCerts[0]!
    const roots = expect.pinnedRootsDer.map(d => new X509Certificate(d))
    const builder = new X509ChainBuilder({ certificates: [...chainCerts.slice(1), ...roots] })
    const path = await builder.build(credCert)
    // A built path that never reaches a pinned root is NOT a valid path — check the terminus
    // explicitly rather than trusting build() to have failed. (Same discipline as the Android half.)
    const terminus = path[path.length - 1]
    const reachedPinnedRoot = terminus !== undefined && roots.some(r => r.equal(terminus))
    if (path.length < 2 || !reachedPinnedRoot) {
      return { ok: false, reason: 'no verifiable certificate path to a pinned Apple App Attest root' }
    }
    // Verify each link's signature — chain BUILDING is not chain VALIDATION.
    for (let i = 0; i < path.length - 1; i++) {
      const okSig = await path[i]!.verify({ publicKey: path[i + 1]!.publicKey, signatureOnly: true })
      if (!okSig) return { ok: false, reason: `certificate path signature failed at link ${i}` }
    }
    // WR-09 (51-REVIEW): CA-ness is the other half of what "validation" means, and
    // `signatureOnly: true` above deliberately skips it — the same reason the expiry loop below
    // had to be re-added by hand. Every NON-LEAF position in the path is being trusted as an
    // ISSUER, so each must actually carry `basicConstraints: CA=true`. Defence in depth: no
    // exploit is constructible against Apple's own hierarchy (an App Attest leaf key can only
    // produce assertions, never certificate signatures), but "we could not build an exploit" is
    // not the same property as "a non-CA can never be treated as an issuer".
    for (let i = 1; i < path.length; i++) {
      const bc = path[i]!.getExtension(BasicConstraintsExtension)
      if (bc == null || !bc.ca) {
        return { ok: false, reason: `certificate at path position ${i} is not a CA — refusing to treat it as an issuer` }
      }
    }
    // Expiry across the validated path. A cryptographically intact chain is not a VALID one: every
    // `verify()` above passes `signatureOnly: true`, which deliberately skips the validity window, so
    // without this an attestation signed by a long-expired credCert (or under an expired
    // intermediate) is accepted indefinitely. The Android sibling has always checked this
    // (`key-attestation.ts`); iOS did not, and the asymmetry was never a documented decision —
    // T-51-10, found by the phase 51 retroactive-STRIDE audit. The pinned root is included on
    // purpose: an expired trust anchor should fail closed, not be waved through.
    const now = expect.now ?? new Date()
    for (const cert of path) {
      if (now < cert.notBefore || now > cert.notAfter) {
        return { ok: false, reason: 'a certificate in the App Attest chain is expired or not yet valid' }
      }
    }

    // ---- STEP 2/3: nonce = SHA256(authData || clientDataHash) ----
    // clientDataHash is ALREADY a hash and is concatenated RAW — never re-hashed.
    const expectedNonce = sha256(authData, expect.expectedClientDataHash)

    // ---- STEP 4: the credCert's OID 1.2.840.113635.100.8.2 must carry exactly that nonce ----
    const ext = credCert.getExtension(APPLE_NONCE_OID)
    if (ext == null) return { ok: false, reason: `credCert carries no ${APPLE_NONCE_OID} nonce extension` }
    let carriedNonce: Uint8Array
    try {
      carriedNonce = decodeAppleNonceExtension(new Uint8Array(ext.value))
    } catch (e) {
      return { ok: false, reason: `credCert nonce extension malformed: ${(e as Error).message}` }
    }
    if (!bytesEqual(carriedNonce, expectedNonce)) {
      return { ok: false, reason: 'credCert nonce does not equal SHA256(authData || clientDataHash) — challenge binding failed' }
    }

    // ---- STEP 5: keyId must equal SHA256 of the attested public key (raw X9.62) ----
    const attestedPublicKeyRaw = new Uint8Array(credCert.publicKey.rawData)
    // `publicKey.rawData` is SPKI DER; the raw X9.62 point is its trailing BIT STRING contents.
    // For P-256 SPKI that is the last 65 bytes (0x04 || X(32) || Y(32)).
    //
    // WR-08 (51-REVIEW): validate the shape BEFORE slicing. `subarray` with a NEGATIVE start
    // silently counts from the END rather than throwing, so an SPKI shorter than 65 bytes yielded
    // a truncated slice that was then compared in STEP 5 AND returned as `attestedPublicKeyRaw`
    // for `app-attest-assertion.ts` to hand to `p256.verify`. It failed closed, but the reported
    // reason blamed the assertion rather than the malformed key, and the keyId comparison was
    // performed against garbage. Checking the uncompressed-point tag (0x04) also rejects a
    // compressed or non-EC key rather than hashing whatever bytes happened to be there.
    if (attestedPublicKeyRaw.length < 65 || attestedPublicKeyRaw[attestedPublicKeyRaw.length - 65] !== 0x04) {
      return { ok: false, reason: 'credCert public key is not an uncompressed P-256 point (SPKI is too short, or its trailing point does not begin with 0x04)' }
    }
    const rawPoint = attestedPublicKeyRaw.subarray(attestedPublicKeyRaw.length - 65)
    const computedKeyId = sha256(rawPoint)
    if (!bytesEqual(computedKeyId, expect.keyId)) {
      return { ok: false, reason: 'keyId does not equal SHA256 of the credCert public key' }
    }

    // ---- STEP 6/7/8: authenticator data checks ----
    const ad = parseAuthenticatorData(authData)
    const expectedRpIdHash = sha256(new TextEncoder().encode(expect.appId))
    if (!bytesEqual(ad.rpIdHash, expectedRpIdHash)) {
      return { ok: false, reason: 'rpIdHash does not equal SHA256(appId) — attestation is for a different app' }
    }
    if (ad.counter !== 0) {
      return { ok: false, reason: `attestation counter must be 0, got ${ad.counter}` }
    }
    const expectedAaguid = expect.environment === 'development' ? AAGUID_DEVELOPMENT : AAGUID_PRODUCTION
    if (!bytesEqual(ad.aaguid, expectedAaguid)) {
      return { ok: false, reason: `aaguid does not match the expected ${expect.environment} value — a development attestation must never be accepted in production` }
    }
    if (!bytesEqual(ad.credentialId, expect.keyId)) {
      return { ok: false, reason: 'authData credential id does not equal keyId' }
    }

    return { ok: true, attestedPublicKeyRaw: rawPoint }
  } catch (e) {
    // Never let a crypto/ASN.1/CBOR exception escape — mirror the shipped verifiers.
    return { ok: false, reason: `verification error: ${(e as Error).message}` }
  }
}
