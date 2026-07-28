/**
 * fixtures.spec.ts — structural-sanity gate for the Phase 43 D-09 synthetic
 * attestation fixture generators (43-02, Wave 0). Asserts each generator
 * produces a well-formed artifact:
 *   - `buildSyntheticJwe` round-trips decrypt+verify with the test keys it
 *     was built with.
 *   - `generateTestRootCa`/`issueCert` produce a cert chain whose leaf
 *     verifies up to the root, with readable/overridable serials.
 *   - `buildSyntheticKeyDescription` embeds a parseable `KeyDescription`
 *     with the requested `securityLevel` and `attestationChallenge`.
 *
 * This spec must stay GREEN — it is NOT part of the Wave-3/4 RED verifier
 * gate (`play-integrity-verifier.spec.ts` / `key-attestation-verifier.spec.ts`
 * are the RED specs; this file only proves the fixtures themselves work).
 */

// `@peculiar/x509`'s internal DI container (tsyringe) requires this polyfill
// to be loaded before any of its exports are used — must be the first import.
import 'reflect-metadata'
import { expect } from 'chai'
import { AsnConvert } from '@peculiar/asn1-schema'
import { KeyDescription, KeyMintKeyDescription, SecurityLevel } from '@peculiar/asn1-android'
import { X509Certificate, X509ChainBuilder } from '@peculiar/x509'
import { compactDecrypt, compactVerify } from 'jose'
import { generateTestRootCa, issueCert, normalizeSerialHex } from './test-root-ca.js'
import {
  buildDefaultSyntheticPayload,
  buildSyntheticJwe,
  decodeSyntheticJwe,
  generateSyntheticJweKeyMaterial
} from './synthetic-jwe.js'
import { buildSyntheticKeyDescription } from './synthetic-key-description.js'

const ATTESTATION_EXTENSION_OID = '1.3.6.1.4.1.11129.2.1.17'

describe('attestation fixtures — structural sanity (43-02, Wave 0)', () => {
  describe('synthetic-jwe.ts', () => {
    it('buildSyntheticJwe produces a compact JWE that round-trips decrypt+verify with the test keys', async () => {
      const keys = await generateSyntheticJweKeyMaterial()
      const payload = buildDefaultSyntheticPayload({ nonce: 'round-trip-nonce' })
      const compactJwe = await buildSyntheticJwe(payload, keys)

      expect(compactJwe.split('.')).to.have.length(5)

      const decoded = await decodeSyntheticJwe(compactJwe, keys)
      expect(decoded).to.deep.equal(payload)
    })

    it('supports per-field payload overrides', () => {
      const payload = buildDefaultSyntheticPayload({
        requestPackageName: 'com.example.other',
        appRecognitionVerdict: 'UNRECOGNIZED',
        deviceRecognitionVerdict: ['FAILS_DEVICE_INTEGRITY']
      })
      expect(payload.requestDetails.requestPackageName).to.equal('com.example.other')
      expect(payload.appIntegrity.appRecognitionVerdict).to.equal('UNRECOGNIZED')
      expect(payload.deviceIntegrity.deviceRecognitionVerdict).to.deep.equal(['FAILS_DEVICE_INTEGRITY'])
    })

    it('tamperCiphertext breaks decryption (A256GCM auth-tag failure)', async () => {
      const keys = await generateSyntheticJweKeyMaterial()
      const payload = buildDefaultSyntheticPayload()
      const tampered = await buildSyntheticJwe(payload, keys, { tamperCiphertext: true })

      let threw = false
      try {
        await compactDecrypt(tampered, keys.decryptionKey)
      } catch {
        threw = true
      }
      expect(threw, 'expected decryption of a tampered ciphertext to throw').to.be.true
    })

    it('signingKey override produces a JWS that fails to verify against the original verification key', async () => {
      const keys = await generateSyntheticJweKeyMaterial()
      const wrongKeys = await generateSyntheticJweKeyMaterial()
      const payload = buildDefaultSyntheticPayload()
      const compactJwe = await buildSyntheticJwe(payload, keys, { signingKey: wrongKeys.signingPrivateKey })

      const { plaintext } = await compactDecrypt(compactJwe, keys.decryptionKey)
      const innerJws = new TextDecoder().decode(plaintext)

      let threw = false
      try {
        await compactVerify(innerJws, keys.verificationPublicKey)
      } catch {
        threw = true
      }
      expect(threw, 'expected verification against the wrong key to throw').to.be.true
    })
  })

  describe('test-root-ca.ts', () => {
    it('generateTestRootCa produces a self-signed root with a readable serial', async () => {
      const root = await generateTestRootCa()
      expect(root.cert).to.be.instanceOf(X509Certificate)
      expect(root.serialNumber).to.be.a('string').with.length.greaterThan(0)
      expect(await root.cert.isSelfSigned()).to.equal(true)
    })

    it('issueCert mints a leaf whose chain verifies up to the root via X509ChainBuilder', async () => {
      const root = await generateTestRootCa()
      const leaf = await issueCert({ issuer: root, subjectName: 'CN=Fixture Sanity Leaf' })

      const builder = new X509ChainBuilder({ certificates: [root.cert] })
      const chain = await builder.build(leaf.cert)
      expect(chain.length).to.be.greaterThan(1)
      expect(chain[chain.length - 1]!.serialNumber).to.equal(root.cert.serialNumber)
    })

    it('accepts and normalizes a serialNumber override', async () => {
      const root = await generateTestRootCa()
      const leaf = await issueCert({ issuer: root, subjectName: 'CN=Serial Override Leaf', serialNumber: '1a2b3c' })
      expect(leaf.serialNumber).to.equal(normalizeSerialHex('1a2b3c'))
    })
  })

  describe('synthetic-key-description.ts', () => {
    it('embeds a parseable legacy KeyDescription with the requested securityLevel and attestationChallenge', async () => {
      const root = await generateTestRootCa()
      const challengeBytes = new TextEncoder().encode('fixture-sanity-challenge')
      const { chainDer, serials } = await buildSyntheticKeyDescription({
        root,
        securityLevel: SecurityLevel.trustedEnvironment,
        attestationChallenge: challengeBytes
      })

      expect(chainDer.length).to.equal(3) // leaf, intermediate, root
      expect(serials.leaf).to.be.a('string').with.length.greaterThan(0)
      expect(serials.intermediate).to.be.a('string').with.length.greaterThan(0)
      expect(serials.root).to.equal(root.serialNumber)

      const leaf = new X509Certificate(chainDer[0]!)
      const ext = leaf.getExtension(ATTESTATION_EXTENSION_OID)
      expect(ext, 'expected the leaf to carry the KeyDescription extension').to.not.equal(null)
      const keyDescription = AsnConvert.parse(ext!.value, KeyDescription)
      expect(keyDescription.attestationSecurityLevel).to.equal(SecurityLevel.trustedEnvironment)
      expect(new Uint8Array(keyDescription.attestationChallenge.buffer)).to.deep.equal(challengeBytes)

      // Chain terminates at the same test root that signed it (pool includes the intermediate).
      const intermediate = new X509Certificate(chainDer[1]!)
      const builder = new X509ChainBuilder({ certificates: [root.cert, intermediate] })
      const chain = await builder.build(leaf)
      expect(chain[chain.length - 1]!.serialNumber).to.equal(root.cert.serialNumber)
    })

    it('embeds a parseable KeyMintKeyDescription when useKeyMintSchema is set', async () => {
      const root = await generateTestRootCa()
      const challengeBytes = new TextEncoder().encode('keymint-fixture-challenge')
      const { chainDer } = await buildSyntheticKeyDescription({
        root,
        securityLevel: SecurityLevel.strongBox,
        attestationChallenge: challengeBytes,
        useKeyMintSchema: true
      })

      const leaf = new X509Certificate(chainDer[0]!)
      const ext = leaf.getExtension(ATTESTATION_EXTENSION_OID)
      expect(ext).to.not.equal(null)
      const keyDescription = AsnConvert.parse(ext!.value, KeyMintKeyDescription)
      expect(keyDescription.attestationSecurityLevel).to.equal(SecurityLevel.strongBox)
      expect(new Uint8Array(keyDescription.attestationChallenge.buffer)).to.deep.equal(challengeBytes)
    })

    it('extensionOnNonLeafOnly places the extension on the intermediate, leaving the leaf bare', async () => {
      const root = await generateTestRootCa()
      const { chainDer } = await buildSyntheticKeyDescription({
        root,
        securityLevel: SecurityLevel.trustedEnvironment,
        attestationChallenge: new TextEncoder().encode('nonleaf-fixture-challenge'),
        extensionOnNonLeafOnly: true
      })

      const leaf = new X509Certificate(chainDer[0]!)
      const intermediate = new X509Certificate(chainDer[1]!)
      expect(leaf.getExtension(ATTESTATION_EXTENSION_OID)).to.equal(null)
      expect(intermediate.getExtension(ATTESTATION_EXTENSION_OID)).to.not.equal(null)
    })

    it('supports a serialNumber override on the leaf, readable for building a revokedSerials set', async () => {
      const root = await generateTestRootCa()
      const { serials } = await buildSyntheticKeyDescription({
        root,
        securityLevel: SecurityLevel.trustedEnvironment,
        attestationChallenge: new TextEncoder().encode('serial-override-challenge'),
        serialNumber: 'deadbe'
      })
      expect(serials.leaf).to.equal(normalizeSerialHex('deadbe'))
    })
  })
})
