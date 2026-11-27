// Synthetic Android Key Attestation root/intermediate/leaf certificate
// generator (Phase 43, D-09). Module pattern mirrors `test/fixtures/keys.ts`:
// top-level named exports only, no class wrapper, no default export.
//
// `generateTestRootCa()` is the controllable stand-in for Google's hardware
// attestation root — `verifyKeyAttestation` (Wave 4) is pointed at this test
// root's DER bytes via its `pinnedRootsDer` argument instead of the real
// `https://android.googleapis.com/attestation/root` snapshot. `issueCert()`
// mints intermediate/leaf certificates signed by any `TestCertificate`
// (root or intermediate), built entirely on `@peculiar/x509`'s
// `X509CertificateGenerator` + Node's native WebCrypto (`globalThis.crypto`,
// available unconditionally on Node >= 20 — no `@peculiar/webcrypto` shim
// needed for this Node-only phase, per RESEARCH.md D-09/D-10/D-11).

// `@peculiar/x509`'s internal DI container (tsyringe) requires this polyfill
// to be loaded before any of its exports are used — must be the first import.
import 'reflect-metadata'
import { BasicConstraintsExtension, X509Certificate, X509CertificateGenerator, type Extension } from '@peculiar/x509'
import type { CryptoKey } from 'jose'

/** ECDSA P-256 / SHA-256 for every synthetic cert in this fixture set — simple, WebCrypto-native, and unrelated to the attestation key's own algorithm (which the KeyDescription extension describes independently). */
const SIGNING_ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' } as const
const KEY_GEN_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000

export interface TestCertificate {
  cert: X509Certificate
  privateKey: CryptoKey
  publicKey: CryptoKey
  /**
   * Normalized lowercase-hex serial number (DER positive-sign `00` padding
   * bytes stripped) — the convention the runtime `attestation-status.generated.ts`
   * revoked-serial snapshot is expected to use (Wave 4+), so a spec can build
   * a `revokedSerials` set that matches this fixture's own serial exactly.
   */
  serialNumber: string
}

/**
 * Normalize an `X509Certificate.serialNumber` hex string (as returned by
 * `@peculiar/x509`) to lowercase hex with any leading DER positive-sign `00`
 * padding byte(s) stripped. `X509Certificate.serialNumber` is already
 * uppercase hex with no `0x` prefix; this only lowercases + trims padding.
 */
export function normalizeSerialHex (hex: string): string {
  let h = hex.toLowerCase()
  while (h.length > 2 && h.startsWith('00')) {
    h = h.slice(2)
  }
  return h
}

/** Generate a self-signed test root CA (the synthetic stand-in for Google's hardware attestation root). */
export async function generateTestRootCa (options?: { serialNumber?: string }): Promise<TestCertificate> {
  const keys = await crypto.subtle.generateKey(KEY_GEN_ALGORITHM, true, ['sign', 'verify'])
  const cert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: options?.serialNumber,
    name: 'CN=VoteTorrent Test Attestation Root, O=VoteTorrent Test Fixtures',
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + ONE_YEAR_MS),
    keys,
    signingAlgorithm: SIGNING_ALGORITHM,
    extensions: [new BasicConstraintsExtension(true, 2, true)]
  })
  return {
    cert,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    serialNumber: normalizeSerialHex(cert.serialNumber)
  }
}

export interface IssueCertOptions {
  /** The certificate (root or intermediate) that signs the new cert. */
  issuer: TestCertificate
  subjectName: string
  /** Override the minted cert's serial number (hex, no `0x` prefix). Enables building a matching `revokedSerials` set in a spec. */
  serialNumber?: string
  /** Mark the minted cert as a CA (for building an intermediate). Default false (leaf). */
  ca?: boolean
  /** Extra extensions to attach — e.g. the KeyDescription attestation extension for a leaf. */
  extensions?: Extension[]
  /**
   * Embed a CALLER-SUPPLIED keypair as the minted cert's subject key instead
   * of generating a fresh one (51-02: `verifyKeyAttestation`'s leaf-pubkey
   * binding check needs the leaf's embedded public key to equal a specific,
   * externally-known `challenge.deviceKey`). Default: generate a fresh P-256
   * pair, unchanged behavior.
   */
  keyPair?: CryptoKeyPair
}

/** Mint an intermediate or leaf certificate signed by `options.issuer`. */
export async function issueCert (options: IssueCertOptions): Promise<TestCertificate> {
  const keys = options.keyPair ?? await crypto.subtle.generateKey(KEY_GEN_ALGORITHM, true, ['sign', 'verify'])
  const extensions = [...(options.extensions ?? [])]
  if (options.ca) {
    extensions.push(new BasicConstraintsExtension(true, 0, true))
  }
  const cert = await X509CertificateGenerator.create({
    serialNumber: options.serialNumber,
    subject: options.subjectName,
    issuer: options.issuer.cert.subject,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + ONE_YEAR_MS),
    publicKey: keys.publicKey,
    signingKey: options.issuer.privateKey,
    signingAlgorithm: SIGNING_ALGORITHM,
    extensions
  })
  return {
    cert,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    serialNumber: normalizeSerialHex(cert.serialNumber)
  }
}
