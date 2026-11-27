/**
 * apple-app-attest-ca.ts — synthetic Apple App Attest root / intermediate / credCert generator.
 *
 * Module pattern deliberately mirrors `packages/vote-engine/test/fixtures/attestation/test-root-ca.ts`
 * (top-level named exports, `@peculiar/x509` + Node WebCrypto, no class wrapper) — that file is the
 * synthetic GOOGLE hardware-attestation root; this is its Apple counterpart.
 *
 * `generateAppleRootCa()` is the controllable stand-in for Apple's real
 * "Apple App Attest Root CA 1" — the verifier is pointed at this root's DER bytes via its
 * `pinnedRootsDer` argument, exactly as `verifyKeyAttestation` is pointed at a synthetic Google root.
 * That keeps the suite offline and hermetic: no Apple endpoint is contacted, and swapping in the
 * real "Apple App Attest Root CA 1" DER is a one-line production change.
 */
import 'reflect-metadata'
import { BasicConstraintsExtension, X509Certificate, X509CertificateGenerator, Extension } from '@peculiar/x509'
import { createHash } from 'node:crypto'

const SIGNING_ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' } as const
const KEY_GEN_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000

// The nonce-extension OID and its DER codec live in the PRODUCTION verifier
// (`src/association/verifiers/apple-nonce-extension.ts`) and are re-exported here so the fixture
// encodes exactly what the verifier decodes — a fixture with its own copy could drift into
// agreeing with itself while disagreeing with production.
export { APPLE_NONCE_OID, encodeAppleNonceExtension, decodeAppleNonceExtension } from '../../../src/association/verifiers/apple-nonce-extension.js'
import { APPLE_NONCE_OID, encodeAppleNonceExtension } from '../../../src/association/verifiers/apple-nonce-extension.js'

export interface TestCertificate {
  cert: X509Certificate
  privateKey: CryptoKey
  publicKey: CryptoKey
}

async function generateKeyPair (): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey(KEY_GEN_ALGORITHM, false, ['sign', 'verify']) as CryptoKeyPair
}

/** Self-signed CA — the pinned trust anchor the verifier is handed. */
export async function generateAppleRootCa (name = 'CN=Test Apple App Attest Root CA 1'): Promise<TestCertificate> {
  const keys = await generateKeyPair()
  const cert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name,
    notBefore: new Date(Date.now() - ONE_YEAR_MS),
    notAfter: new Date(Date.now() + ONE_YEAR_MS),
    signingAlgorithm: SIGNING_ALGORITHM,
    keys,
    extensions: [new BasicConstraintsExtension(true, 2, true)]
  })
  return { cert, privateKey: keys.privateKey, publicKey: keys.publicKey }
}

/** Mint a certificate signed by `issuer`. `extraExtensions` carries the Apple nonce extension for a credCert. */
export async function issueCert (opts: {
  issuer: TestCertificate
  name: string
  serialNumber: string
  isCa: boolean
  extraExtensions?: Extension[]
  subjectKeys?: CryptoKeyPair
  /**
   * Validity window overrides. Default to +/- a year (i.e. currently valid) so every existing caller
   * is unaffected; supplied only by the T-51-10 expiry negative controls, which need a chain that is
   * cryptographically perfect and merely out of date.
   */
  notBefore?: Date
  notAfter?: Date
}): Promise<TestCertificate> {
  const keys = opts.subjectKeys ?? await generateKeyPair()
  const extensions: Extension[] = [new BasicConstraintsExtension(opts.isCa, opts.isCa ? 1 : undefined, true)]
  if (opts.extraExtensions) extensions.push(...opts.extraExtensions)
  const cert = await X509CertificateGenerator.create({
    serialNumber: opts.serialNumber,
    subject: opts.name,
    issuer: opts.issuer.cert.subject,
    notBefore: opts.notBefore ?? new Date(Date.now() - ONE_YEAR_MS),
    notAfter: opts.notAfter ?? new Date(Date.now() + ONE_YEAR_MS),
    signingAlgorithm: SIGNING_ALGORITHM,
    publicKey: keys.publicKey,
    signingKey: opts.issuer.privateKey,
    extensions
  })
  return { cert, privateKey: keys.privateKey, publicKey: keys.publicKey }
}

/** Build a credCert carrying the Apple nonce extension for `nonce`. */
export async function issueCredCert (issuer: TestCertificate, nonce: Uint8Array, serialNumber = '03'): Promise<TestCertificate> {
  const ext = new Extension(APPLE_NONCE_OID, false, encodeAppleNonceExtension(nonce).buffer as ArrayBuffer)
  return await issueCert({ issuer, name: 'CN=Test App Attest credCert', serialNumber, isCa: false, extraExtensions: [ext] })
}

/**
 * App Attest `keyId` = SHA-256 of the attested public key in **uncompressed X9.62 form** (0x04 ‖ X ‖ Y),
 * NOT of the SPKI DER wrapper. Getting this wrong yields a keyId that never matches the credential id
 * in authData — a silent mismatch, so it is isolated here.
 */
export async function keyIdForPublicKey (publicKey: CryptoKey): Promise<Uint8Array> {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey))
  return new Uint8Array(createHash('sha256').update(raw).digest())
}
