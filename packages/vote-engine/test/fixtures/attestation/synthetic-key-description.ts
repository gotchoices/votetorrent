// Synthetic Android Keystore hardware Key Attestation `KeyDescription`
// builder (Phase 43 D-09). Module pattern mirrors `test/fixtures/keys.ts`:
// top-level named exports only, no class wrapper, no default export.
//
// Produces a real, parseable ASN.1 `KeyDescription` extension
// (OID `1.3.6.1.4.1.11129.2.1.17`, RESEARCH.md Pattern 2) embedded on a leaf
// certificate issued by a `test-root-ca.ts` root (optionally via an
// intermediate), returning the leaf-first DER chain PLUS the chain's
// normalized serials so a spec can build a matching `revokedSerials` set
// (Wave 4's revoked-serial branch). Supports both the legacy `KeyDescription`
// (Keymaster) and `KeyMintKeyDescription` (KeyMint) schema classes via the
// `useKeyMintSchema` flag, and an `extensionOnNonLeafOnly` flag to exercise
// the leaf-only-trust negative (Common Pitfall 6).

// `@peculiar/x509`'s internal DI container (tsyringe) requires this polyfill
// to be loaded before any of its exports are used — must be the first import.
import 'reflect-metadata'
import { AsnConvert, OctetString } from '@peculiar/asn1-schema'
import {
  AttestationApplicationId,
  AttestationPackageInfo,
  AuthorizationList,
  IntegerSet,
  KeyDescription,
  KeyMintKeyDescription,
  SecurityLevel,
  Version,
  id_ce_keyDescription
} from '@peculiar/asn1-android'
import { Extension } from '@peculiar/x509'
import type { CryptoKey } from 'jose'
import { issueCert, type TestCertificate } from './test-root-ca.js'
import { SYNTHETIC_APP_PACKAGE, SYNTHETIC_SIGNING_CERT_SHA256 } from './synthetic-jwe.js'

export { SecurityLevel } from '@peculiar/asn1-android'

const DEVICE_KEY_GEN_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const

export interface SyntheticAndroidDeviceKeyPair {
  /** The generated keypair — pass to `buildSyntheticKeyDescription({ leafKeyPair })` so the leaf certificate embeds this exact public key. */
  keyPair: CryptoKeyPair
  /** `deviceKeySpkiBase64`'s value — Android's `challenge.deviceKey` encoding (SubjectPublicKeyInfo DER, base64) that `verifyKeyAttestation`'s 4b-2 check compares the leaf's own public key against. */
  deviceKeySpkiBase64: string
}

/**
 * Generate a fresh P-256 keypair and its Android-shaped `challenge.deviceKey`
 * encoding (51-02): SPKI DER, base64. Use the returned `keyPair` as
 * `buildSyntheticKeyDescription`'s `leafKeyPair` and the returned
 * `deviceKeySpkiBase64` as the `AttestationChallenge.deviceKey` value, so the
 * leaf certificate `verifyKeyAttestation` parses embeds EXACTLY the key the
 * challenge names — required since 51-02's leaf-pubkey binding check (4b-2)
 * rejects any chain whose leaf key differs from `challenge.deviceKey`.
 */
export async function generateAndroidDeviceKeyPair (): Promise<SyntheticAndroidDeviceKeyPair> {
  const keyPair = await crypto.subtle.generateKey(DEVICE_KEY_GEN_ALGORITHM, true, ['sign', 'verify'])
  const spki = await crypto.subtle.exportKey('spki', keyPair.publicKey)
  const deviceKeySpkiBase64 = Buffer.from(spki).toString('base64')
  return { keyPair, deviceKeySpkiBase64 }
}

export interface SyntheticKeyDescriptionOptions {
  /** The test root (from `generateTestRootCa()`) the synthetic chain is issued under. */
  root: TestCertificate
  /** D-02 balanced-bar security level under test (the ATTESTATION security level). */
  securityLevel: SecurityLevel
  /** The ATTESTED KEY's own keymaster/KeyMint security level. Defaults to `securityLevel`; set independently to exercise the WR-01 "TEE-attested but software-backed key" negative. */
  keymasterSecurityLevel?: SecurityLevel
  /** The bytes embedded as `KeyDescription.attestationChallenge` — normally `utf8(base64url(Digest(nonce, deviceKey)))` per the plan's wire-format convention; override to a wrong value to exercise the D-06 negative. */
  attestationChallenge: Uint8Array
  /** Override the leaf cert's serial number (hex). Enables building a matching `revokedSerials` set in a spec. */
  serialNumber?: string
  /** Use the newer `KeyMintKeyDescription` (v300/v400) schema instead of the legacy Keymaster `KeyDescription`. Default false. */
  useKeyMintSchema?: boolean
  /** Attach the KeyDescription extension to the INTERMEDIATE cert instead of the leaf — exercises Common Pitfall 6's leaf-only-trust rejection. Requires `includeIntermediate` (default true). */
  extensionOnNonLeafOnly?: boolean
  /** Whether to interpose an intermediate CA between the leaf and the root. Default true (the realistic KeyStore.getCertificateChain() shape). */
  includeIntermediate?: boolean
  /** Mint the intermediate WITHOUT `basicConstraints: CA=true` — exercises WR-09's
   * refusal to treat a non-CA certificate as an issuer. Default true (a real CA). */
  intermediateIsCa?: boolean
  /** The package name embedded in the software-enforced `attestationApplicationId`. Defaults to `SYNTHETIC_APP_PACKAGE`; override to exercise the WR-03 wrong-app negative. */
  appPackageName?: string
  /** The signing-cert SHA-256 digests embedded in `attestationApplicationId`. Defaults to `[SYNTHETIC_SIGNING_CERT_SHA256]`; override to exercise the WR-03 wrong-signature negative. */
  appSignatureDigests?: Uint8Array[]
  /** Omit the `attestationApplicationId` entirely — exercises the WR-03 "no app binding" negative. */
  omitAttestationApplicationId?: boolean
  /** The hardware-enforced key `origin`. Defaults to KM_ORIGIN_GENERATED (0); set to e.g. 2 (imported) to exercise the WR-04 negative. */
  origin?: number
  /** The hardware-enforced key `purpose` set. Defaults to [SIGN(2)]; override (e.g. [VERIFY(3)]) to exercise the WR-04 no-sign negative. */
  purpose?: number[]
  /**
   * Embed this EXACT keypair as the leaf certificate's subject key instead
   * of generating a fresh random one (51-02). Pass the SAME keypair whose
   * SPKI-DER-base64 encoding was used as `challenge.deviceKey` so
   * `verifyKeyAttestation`'s leaf-pubkey binding check (4b-2) accepts the
   * chain. Default: generate a fresh P-256 pair (pre-51-02 behavior) — the
   * leaf's key will then NOT match any `challenge.deviceKey`.
   */
  leafKeyPair?: CryptoKeyPair
}

export interface SyntheticKeyDescriptionResult {
  /** Leaf-first DER chain: `[leaf, intermediate?, root]` — matches `KeyStore.getCertificateChain()`'s ordering. */
  chainDer: Uint8Array[]
  /** Normalized lowercase-hex serials of every cert in the chain, for building `revokedSerials` sets. */
  serials: { leaf: string, intermediate?: string, root: string }
  leafPrivateKey: CryptoKey
  leafPublicKey: CryptoKey
}

/** Build the software-enforced `attestationApplicationId` OCTET STRING (DER of AttestationApplicationId) naming the app package + its signing-cert digests. */
function buildAttestationApplicationId (packageName: string, signatureDigests: Uint8Array[]): OctetString {
  const der = AsnConvert.serialize(new AttestationApplicationId({
    packageInfos: [new AttestationPackageInfo({ packageName: new OctetString(new TextEncoder().encode(packageName)), version: 1 })],
    signatureDigests: signatureDigests.map((digest) => new OctetString(digest))
  }))
  return new OctetString(der)
}

/** Build the ASN.1 `KeyDescription` (or `KeyMintKeyDescription`) extension carrying `securityLevel` + `attestationChallenge` + the software-enforced app-identity binding. */
function buildKeyDescriptionExtension (options: Pick<SyntheticKeyDescriptionOptions, 'securityLevel' | 'keymasterSecurityLevel' | 'attestationChallenge' | 'useKeyMintSchema' | 'appPackageName' | 'appSignatureDigests' | 'omitAttestationApplicationId' | 'origin' | 'purpose'>): Extension {
  const attestationChallenge = new OctetString(options.attestationChallenge)
  const keymasterSecurityLevel = options.keymasterSecurityLevel ?? options.securityLevel
  const uniqueId = new OctetString(new Uint8Array(0))
  const softwareEnforced = new AuthorizationList(
    options.omitAttestationApplicationId === true
      ? {}
      : {
        attestationApplicationId: buildAttestationApplicationId(
          options.appPackageName ?? SYNTHETIC_APP_PACKAGE,
          options.appSignatureDigests ?? [SYNTHETIC_SIGNING_CERT_SHA256]
        )
      }
  )
  // Hardware-enforced list: default to a hardware-GENERATED, SIGN-capable key
  // (the PASS shape the WR-04 gate requires).
  const teeEnforced = new AuthorizationList({
    origin: options.origin ?? 0, // KM_ORIGIN_GENERATED
    purpose: new IntegerSet(options.purpose ?? [2]) // KeyPurpose.SIGN
  })

  const der = options.useKeyMintSchema === true
    ? AsnConvert.serialize(new KeyMintKeyDescription({
      attestationVersion: Version.keyMint2,
      attestationSecurityLevel: options.securityLevel,
      keyMintVersion: 200,
      keyMintSecurityLevel: keymasterSecurityLevel,
      attestationChallenge,
      uniqueId,
      softwareEnforced,
      hardwareEnforced: teeEnforced
    }))
    : AsnConvert.serialize(new KeyDescription({
      attestationVersion: Version.KM4,
      attestationSecurityLevel: options.securityLevel,
      keymasterVersion: 4,
      keymasterSecurityLevel,
      attestationChallenge,
      uniqueId,
      softwareEnforced,
      teeEnforced
    }))

  // `critical: false` — matches Android's own attestation extension convention.
  return new Extension(id_ce_keyDescription, false, der)
}

/** Build a synthetic leaf-first cert chain carrying a Key Attestation `KeyDescription` extension. */
export async function buildSyntheticKeyDescription (options: SyntheticKeyDescriptionOptions): Promise<SyntheticKeyDescriptionResult> {
  const includeIntermediate = options.includeIntermediate ?? true
  const extension = buildKeyDescriptionExtension(options)

  let signer: TestCertificate = options.root
  let intermediate: TestCertificate | undefined

  if (includeIntermediate) {
    intermediate = await issueCert({
      issuer: options.root,
      subjectName: 'CN=VoteTorrent Test Attestation Intermediate',
      ca: options.intermediateIsCa ?? true,
      extensions: options.extensionOnNonLeafOnly === true ? [extension] : []
    })
    signer = intermediate
  }

  const leaf = await issueCert({
    issuer: signer,
    subjectName: 'CN=VoteTorrent Test Attestation Leaf',
    serialNumber: options.serialNumber,
    extensions: options.extensionOnNonLeafOnly === true ? [] : [extension],
    keyPair: options.leafKeyPair
  })

  const chainDer: Uint8Array[] = [new Uint8Array(leaf.cert.rawData)]
  if (intermediate) {
    chainDer.push(new Uint8Array(intermediate.cert.rawData))
  }
  chainDer.push(new Uint8Array(options.root.cert.rawData))

  return {
    chainDer,
    serials: {
      leaf: leaf.serialNumber,
      intermediate: intermediate?.serialNumber,
      root: options.root.serialNumber
    },
    leafPrivateKey: leaf.privateKey,
    leafPublicKey: leaf.publicKey
  }
}
