// `@peculiar/x509`'s internal DI container (tsyringe) requires this polyfill
// to be loaded before any of its exports are used — must be the first import.
import 'reflect-metadata'
import { X509Certificate, X509ChainBuilder } from '@peculiar/x509'
import { AsnConvert } from '@peculiar/asn1-schema'
import { AttestationApplicationId, KeyDescription, KeyMintKeyDescription, SecurityLevel } from '@peculiar/asn1-android'
import { timingSafeEqual } from 'node:crypto'
import type { AttestationChallenge, AttestationVerification } from '@votetorrent/vote-core'
import { recomputeChallengeDigest } from './digest-binding.js'
import { certDigestBytesToHex, type ExpectedAppIdentity } from './app-identity.js'

/**
 * key-attestation.ts — offline Android Keystore hardware Key Attestation
 * verification (D-02/D-06/D-09, T-43-03/04/05/07/08): validates the
 * `KeyStore.getCertificateChain()`-shaped leaf-first DER chain up to a
 * PINNED Google hardware root (RESEARCH.md Pattern 2), parses ONLY the
 * leaf's `KeyDescription` extension (OID `1.3.6.1.4.1.11129.2.1.17` —
 * Common Pitfall 6, never trust a similarly-OID'd extension elsewhere in
 * the chain), enforces the D-02 balanced device-integrity bar (TEE or
 * StrongBox, never Software), enforces the anti-relay Digest binding
 * (Phase 44's D-06 — distinct from `association-engine.ts`'s own
 * Phase-42 "D-06" device-uniqueness comment, Pitfall 4), and rejects any
 * chain whose leaf OR intermediate serial appears in an injected
 * REVOKED/SUSPENDED snapshot (T-43-08).
 *
 * Every parse/validation failure is caught and converted to a structured
 * `{ ok: false, reason }` result — mirroring `database/initialize.ts`'s
 * `verifySig()` discipline: never let a crypto/ASN.1-library exception
 * propagate as an unhandled throw.
 *
 * Pinned roots and the revoked-serial snapshot are INJECTED parameters
 * (bundled, committed, offline snapshots at the call site) — this
 * function NEVER fetches `https://android.googleapis.com/attestation/*`
 * at verify-time (D-04 offline posture).
 */

const ATTESTATION_EXTENSION_OID = '1.3.6.1.4.1.11129.2.1.17'

// Android Keymaster/KeyMint tag values (hardware-enforced AuthorizationList).
const KM_ORIGIN_GENERATED = 0 // key was generated in secure hardware (not imported/derived)
const KM_PURPOSE_SIGN = 2 // KeyPurpose.SIGN — the voting key must be usable for signing

/**
 * Normalize an `X509Certificate.serialNumber` hex string (uppercase, no
 * `0x` prefix, as returned by `@peculiar/x509`) to lowercase hex with any
 * leading DER positive-sign `00` padding byte(s) stripped — the same
 * convention `test/fixtures/attestation/test-root-ca.ts`'s
 * `normalizeSerialHex` and the runtime `attestation-status.generated.ts`
 * revoked-serial snapshot both use, so a chain cert's serial can be
 * cross-checked against `revokedSerials` byte-for-byte.
 */
function normalizeSerialHex (hex: string): string {
  let h = hex.toLowerCase()
  while (h.length > 2 && h.startsWith('00')) {
    h = h.slice(2)
  }
  return h
}

function bytesEqual (a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false
  return timingSafeEqual(new Uint8Array(a), new Uint8Array(b))
}

/**
 * Normalize an ASN.1-decoded OCTET STRING value to `Uint8Array`. `@peculiar`
 * decodes top-level OCTET STRING fields as `OctetString` (with `.buffer`) but
 * nested ones (e.g. `AttestationPackageInfo.packageName`) as a raw
 * `ArrayBuffer` — handle both shapes.
 */
function asBytes (value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  const buffer = (value as { buffer?: unknown })?.buffer
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer)
  if (ArrayBuffer.isView(buffer)) return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  return new Uint8Array(0)
}

/**
 * Validate an Android Keystore hardware Key Attestation cert chain and
 * bind it to an issued `AttestationChallenge`.
 *
 * @param certChainDer Leaf-first DER chain, as returned by
 *   `KeyStore.getCertificateChain()` — `[leaf, intermediate?, root]`.
 * @param challenge The `AttestationChallenge` this attestation must answer
 *   (`Digest(challenge.nonce, challenge.deviceKey)` is recomputed here and
 *   compared to the leaf's `KeyDescription.attestationChallenge`).
 * @param pinnedRootsDer Bundled snapshot of Google's hardware attestation
 *   root(s) DER bytes — injected, never fetched.
 * @param revokedSerials Bundled REVOKED/SUSPENDED serial snapshot
 *   (lowercase-hex, `normalizeSerialHex` convention) — injected, never
 *   fetched.
 */
export async function verifyKeyAttestation (
  certChainDer: Uint8Array[],
  challenge: AttestationChallenge,
  pinnedRootsDer: Uint8Array[],
  revokedSerials: Set<string>,
  expectedAppIdentity: ExpectedAppIdentity
): Promise<AttestationVerification> {
  try {
    if (certChainDer.length === 0) {
      return { ok: false, reason: 'certificate chain is empty' }
    }

    const certs = certChainDer.map((der) => new X509Certificate(der))
    const leaf = certs[0]!
    const pinnedRootCerts = pinnedRootsDer.map((der) => new X509Certificate(der))

    // 1. Chain validation up to a PINNED root only (never trust a
    // self-signed root the presented chain itself supplies).
    const builder = new X509ChainBuilder({ certificates: [...pinnedRootCerts, ...certs.slice(1)] })
    const chain = await builder.build(leaf)
    const chainRoot = chain[chain.length - 1]
    const terminatesAtPinnedRoot = chain.length > 1 && chainRoot !== undefined &&
      pinnedRootCerts.some((r) => bytesEqual(r.rawData, chainRoot.rawData))
    if (!terminatesAtPinnedRoot) {
      return { ok: false, reason: 'no verifiable certificate chain path to a pinned Google hardware root' }
    }

    // Expiry check across the validated chain.
    const now = new Date()
    for (const cert of chain) {
      if (now < cert.notBefore || now > cert.notAfter) {
        return { ok: false, reason: 'a certificate in the attestation chain is expired or not yet valid' }
      }
    }

    // 2. Parse the LEAF's attestation extension specifically — Pitfall 6.
    // Never `certs.find(...)` across the whole chain; a similarly-OID'd
    // extension on a non-leaf cert is not attestation data to be trusted.
    const ext = leaf.getExtension(ATTESTATION_EXTENSION_OID)
    if (!ext) {
      return { ok: false, reason: 'leaf certificate carries no KeyDescription attestation extension (leaf-only trust)' }
    }

    let keyDescription: KeyDescription
    try {
      keyDescription = AsnConvert.parse(ext.value, KeyDescription)
    } catch {
      // KeyMint-schema (v300/v400) fallback — same ASN.1 shape/positions
      // as legacy `KeyDescription`, different field names only. Normalize to
      // the legacy shape (keyMintSecurityLevel -> keymasterSecurityLevel,
      // hardwareEnforced -> teeEnforced) so the checks below are schema-agnostic.
      keyDescription = AsnConvert.parse(ext.value, KeyMintKeyDescription).toLegacyKeyDescription()
    }
    const attestationSecurityLevel = keyDescription.attestationSecurityLevel
    const attestationChallengeBytes = new Uint8Array(keyDescription.attestationChallenge.buffer)

    // 3. D-02 balanced bar: TEE or StrongBox required, Software rejected.
    // `attestationSecurityLevel` describes where the ATTESTATION was produced.
    if (attestationSecurityLevel === SecurityLevel.software) {
      return { ok: false, reason: 'key attestation security level is Software-backed; TEE or StrongBox required' }
    }
    // WR-01: also gate `keymasterSecurityLevel` (KeyMint `keyMintSecurityLevel`),
    // which describes where the ATTESTED KEY ITSELF lives. A key can be
    // software-backed while attested by a TEE — both must be non-Software to
    // assert the voting key is genuinely hardware-backed.
    if (keyDescription.keymasterSecurityLevel === SecurityLevel.software) {
      return { ok: false, reason: 'attested key keymaster/KeyMint security level is Software-backed; the key itself must live in TEE or StrongBox' }
    }

    // 4. D-06 anti-relay binding (Phase 44's D-06 — distinct from
    // association-engine.ts's own Phase-42 device-uniqueness "D-06").
    // This function does NOT recompute Digest itself beyond calling the
    // shared digest-binding.ts helper — composable per RESEARCH.md Pattern 2.
    const expectedChallenge = new TextEncoder().encode(recomputeChallengeDigest(challenge.nonce, challenge.deviceKey))
    const challengeBound = expectedChallenge.length === attestationChallengeBytes.length &&
      timingSafeEqual(expectedChallenge, attestationChallengeBytes)
    if (!challengeBound) {
      return { ok: false, reason: 'attestationChallenge does not match Digest(nonce, deviceKey) — D-06 anti-relay binding failed' }
    }

    // 4b. WR-03 app-identity binding: verify the software-enforced
    // `attestationApplicationId` names OUR package and OUR signing certificate.
    // Without this the chain proves "a TEE/StrongBox key on a genuine device
    // answering this challenge" but not "generated by *our* app".
    const appIdOctet = keyDescription.softwareEnforced?.attestationApplicationId
    if (appIdOctet === undefined) {
      return { ok: false, reason: 'leaf KeyDescription carries no attestationApplicationId — cannot bind the key to this app (WR-03)' }
    }
    let attestationApplicationId: AttestationApplicationId
    try {
      attestationApplicationId = AsnConvert.parse(asBytes(appIdOctet), AttestationApplicationId)
    } catch {
      return { ok: false, reason: 'leaf KeyDescription attestationApplicationId could not be parsed' }
    }
    const attestedPackageNames = attestationApplicationId.packageInfos.map((info) => new TextDecoder().decode(asBytes(info.packageName)))
    if (!attestedPackageNames.includes(expectedAppIdentity.packageName)) {
      return { ok: false, reason: `attestationApplicationId package(s) [${attestedPackageNames.join(', ')}] do not include the expected authority app package ('${expectedAppIdentity.packageName}')` }
    }
    const allowedCertDigests = new Set(expectedAppIdentity.certificateSha256Digests)
    const attestedSignatureDigests = attestationApplicationId.signatureDigests.map((digest) => certDigestBytesToHex(asBytes(digest)))
    if (!attestedSignatureDigests.some((hex) => allowedCertDigests.has(hex))) {
      return { ok: false, reason: 'attestationApplicationId signature digest does not match any allowlisted signing-certificate digest for this app (WR-03)' }
    }

    // 4c. WR-04: assert the attested key was hardware-GENERATED (not imported)
    // and is authorized for SIGNing — read from the HARDWARE-enforced list
    // (`teeEnforced`; KeyMint `hardwareEnforced`, normalized above). An imported
    // key could otherwise satisfy the TEE/StrongBox bar without being
    // hardware-generated.
    const hardwareEnforced = keyDescription.teeEnforced
    if (hardwareEnforced?.origin !== KM_ORIGIN_GENERATED) {
      return { ok: false, reason: `attested key origin (${String(hardwareEnforced?.origin)}) is not KM_ORIGIN_GENERATED — the key was not generated in secure hardware (imported/derived keys are rejected)` }
    }
    const hardwarePurposes = hardwareEnforced.purpose !== undefined ? Array.from(hardwareEnforced.purpose) : []
    if (!hardwarePurposes.includes(KM_PURPOSE_SIGN)) {
      return { ok: false, reason: `attested key hardware-enforced purpose [${hardwarePurposes.join(', ')}] does not include SIGN` }
    }

    // 5. Offline revoked/suspended-serial rejection (T-43-08) — every cert
    // in the validated chain, not just the leaf. Pure, DB-free, offline:
    // `revokedSerials` is an injected in-memory Set, never fetched here.
    for (const cert of chain) {
      const serial = normalizeSerialHex(cert.serialNumber)
      if (revokedSerials.has(serial)) {
        return { ok: false, reason: `attestation key revoked/suspended — certificate serial '${serial}' is on the Google attestation-status revoked/suspended snapshot` }
      }
    }

    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `key attestation verification failed: ${message}` }
  }
}
