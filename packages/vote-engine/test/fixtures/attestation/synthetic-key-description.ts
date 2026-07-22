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
  AuthorizationList,
  KeyDescription,
  KeyMintKeyDescription,
  SecurityLevel,
  Version,
  id_ce_keyDescription
} from '@peculiar/asn1-android'
import { Extension } from '@peculiar/x509'
import type { CryptoKey } from 'jose'
import { issueCert, type TestCertificate } from './test-root-ca.js'

export { SecurityLevel } from '@peculiar/asn1-android'

export interface SyntheticKeyDescriptionOptions {
  /** The test root (from `generateTestRootCa()`) the synthetic chain is issued under. */
  root: TestCertificate
  /** D-02 balanced-bar security level under test. */
  securityLevel: SecurityLevel
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
}

export interface SyntheticKeyDescriptionResult {
  /** Leaf-first DER chain: `[leaf, intermediate?, root]` — matches `KeyStore.getCertificateChain()`'s ordering. */
  chainDer: Uint8Array[]
  /** Normalized lowercase-hex serials of every cert in the chain, for building `revokedSerials` sets. */
  serials: { leaf: string, intermediate?: string, root: string }
  leafPrivateKey: CryptoKey
  leafPublicKey: CryptoKey
}

/** Build the ASN.1 `KeyDescription` (or `KeyMintKeyDescription`) extension carrying `securityLevel` + `attestationChallenge`. */
function buildKeyDescriptionExtension (options: Pick<SyntheticKeyDescriptionOptions, 'securityLevel' | 'attestationChallenge' | 'useKeyMintSchema'>): Extension {
  const attestationChallenge = new OctetString(options.attestationChallenge)
  const uniqueId = new OctetString(new Uint8Array(0))
  const softwareEnforced = new AuthorizationList({})
  const teeEnforced = new AuthorizationList({})

  const der = options.useKeyMintSchema === true
    ? AsnConvert.serialize(new KeyMintKeyDescription({
      attestationVersion: Version.keyMint2,
      attestationSecurityLevel: options.securityLevel,
      keyMintVersion: 200,
      keyMintSecurityLevel: options.securityLevel,
      attestationChallenge,
      uniqueId,
      softwareEnforced,
      hardwareEnforced: teeEnforced
    }))
    : AsnConvert.serialize(new KeyDescription({
      attestationVersion: Version.KM4,
      attestationSecurityLevel: options.securityLevel,
      keymasterVersion: 4,
      keymasterSecurityLevel: options.securityLevel,
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
      ca: true,
      extensions: options.extensionOnNonLeafOnly === true ? [extension] : []
    })
    signer = intermediate
  }

  const leaf = await issueCert({
    issuer: signer,
    subjectName: 'CN=VoteTorrent Test Attestation Leaf',
    serialNumber: options.serialNumber,
    extensions: options.extensionOnNonLeafOnly === true ? [] : [extension]
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
