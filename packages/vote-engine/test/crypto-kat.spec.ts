/**
 * crypto-kat.spec.ts — Phase 62 Plan 04 (D-25)
 *
 * Known-answer vectors for the four primitives `src/crypto/*` composes:
 * HKDF-SHA256 (RFC 5869), AES-256-GCM (NIST SP 800-38D / the GCM spec's
 * published test cases), the secp256k1 generator (SEC 2 v2.0), and ECDH
 * (SEC 1 v2.0 section 3.3.1, independently against OpenSSL).
 *
 * Each `it()` title below names the standard it pins and the
 * `doc/encryption-formats.md` section that normatively describes the usage.
 * `node:crypto` is used ONLY in this test file — never in `src/crypto/`.
 */

import { expect } from 'chai'
import { createCipheriv, createECDH, hkdfSync } from 'node:crypto'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { gcm } from '@noble/ciphers/aes.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

describe('crypto known-answer vectors (62-04, D-25)', () => {
  // -------------------------------------------------------------------------
  // KAT-HKDF — RFC 5869 Appendix A.1, doc/encryption-formats.md section 1
  // -------------------------------------------------------------------------
  describe('KAT-HKDF — RFC 5869 Appendix A.1', () => {
    it('KAT-HKDF-a: noble hkdf(sha256, ...) over the RFC 5869 A.1 vector returns the published 42-byte OKM', () => {
      const ikm = hexToBytes('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b')
      const salt = hexToBytes('000102030405060708090a0b0c')
      const info = hexToBytes('f0f1f2f3f4f5f6f7f8f9')
      const okm = hkdf(sha256, ikm, salt, info, 42)
      expect(bytesToHex(okm)).to.equal(
        '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865'
      )
    })

    it('KAT-HKDF-b: noble hkdf agrees with node:crypto hkdfSync on real envelope-shaped KEK inputs (independent re-implementation)', () => {
      const ikm = new Uint8Array(32).fill(0x07)
      const salt = new Uint8Array(66).fill(0x09)
      const info = new TextEncoder().encode('vt-env-1/wrap')
      const nobleOut = hkdf(sha256, ikm, salt, info, 32)
      const nodeOut = new Uint8Array(hkdfSync('sha256', Buffer.from(ikm), Buffer.from(salt), Buffer.from(info), 32))
      expect(bytesToHex(nobleOut)).to.equal(bytesToHex(nodeOut))
    })
  })

  // -------------------------------------------------------------------------
  // KAT-GCM — the GCM spec's published AES-256-GCM Test Case 16
  // -------------------------------------------------------------------------
  describe('KAT-GCM — AES-256-GCM, GCM spec Test Case 16', () => {
    const key = hexToBytes('feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308')
    const iv = hexToBytes('cafebabefacedbaddecaf888')
    const aad = hexToBytes('feedfacedeadbeeffeedfacedeadbeefabaddad2')
    const plaintext = hexToBytes(
      'd9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39'
    )
    const expectedCtTag =
      '522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662' +
      '76fc6ece0f4e1768cddf8853bb2d551b'

    it('KAT-GCM-a: noble gcm() over Test Case 16 returns the published ct||tag', () => {
      const out = gcm(key, iv, aad).encrypt(plaintext)
      expect(bytesToHex(out)).to.equal(expectedCtTag)
    })

    it('KAT-GCM-b: noble gcm() agrees with node:crypto aes-256-gcm over the same vector (independent re-implementation)', () => {
      const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(iv))
      cipher.setAAD(Buffer.from(aad))
      const body = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()])
      const tag = cipher.getAuthTag()
      expect(bytesToHex(gcm(key, iv, aad).encrypt(plaintext))).to.equal(Buffer.concat([body, tag]).toString('hex'))
    })

    it('KAT-GCM-c: decryption with one flipped tag bit throws', () => {
      const out = gcm(key, iv, aad).encrypt(plaintext)
      const tampered = Uint8Array.from(out)
      tampered[tampered.length - 1] ^= 0x01
      expect(() => gcm(key, iv, aad).decrypt(tampered)).to.throw()
    })

    it('KAT-GCM-d: decrypting the untampered ct||tag round-trips to the original plaintext (paired positive control)', () => {
      const out = gcm(key, iv, aad).encrypt(plaintext)
      expect(bytesToHex(gcm(key, iv, aad).decrypt(out))).to.equal(bytesToHex(plaintext))
    })
  })

  // -------------------------------------------------------------------------
  // KAT-SEC2 — the secp256k1 generator point
  // -------------------------------------------------------------------------
  describe('KAT-SEC2 — the secp256k1 generator, SEC 2 v2.0', () => {
    it('KAT-SEC2-a: getPublicKey(scalar 1, compressed) equals the SEC 2 generator hex', () => {
      const scalar = new Uint8Array(32)
      scalar[31] = 1
      const pub = secp256k1.getPublicKey(scalar, true)
      expect(bytesToHex(pub)).to.equal('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798')
    })
  })

  // -------------------------------------------------------------------------
  // KAT-ECDH — noble vs OpenSSL, SEC 1 v2.0 section 3.3.1
  // -------------------------------------------------------------------------
  describe('KAT-ECDH — noble getSharedSecret vs OpenSSL createECDH, SEC 1 v2.0 section 3.3.1', () => {
    function repeated (byte: number, length: number): Uint8Array {
      return new Uint8Array(length).fill(byte)
    }

    function sequence (start: number, length: number): Uint8Array {
      return Uint8Array.from({ length }, (_, i) => (start + i) & 0xff)
    }

    const pairs: ReadonlyArray<readonly [Uint8Array, Uint8Array]> = [
      [repeated(0x11, 32), repeated(0x22, 32)],
      [repeated(0x01, 32), repeated(0x02, 32)],
      [sequence(1, 32), sequence(100, 32)]
    ]

    it('KAT-ECDH-a: scalar pair #1 (sk = 32x0x11, pub = G*(32x0x22)) — noble x-coordinate matches OpenSSL computeSecret, and equals the recorded facts-at-plan-time value', () => {
      const [sk, pubScalar] = pairs[0]!
      const pub = secp256k1.getPublicKey(pubScalar, true)
      const x = secp256k1.getSharedSecret(sk, pub, true).slice(1)
      expect(bytesToHex(x)).to.equal('77e0510d5042e2f5e9e59c977b81eeed590cf7d20c1c51da451a8eaa9fdc45ff')

      const ecdh = createECDH('secp256k1')
      ecdh.setPrivateKey(Buffer.from(sk))
      const nodeShared = ecdh.computeSecret(Buffer.from(pub))
      expect(bytesToHex(x)).to.equal(nodeShared.toString('hex'))
    })

    for (const [i, [sk, pubScalar]] of pairs.entries()) {
      it(`KAT-ECDH-b-${i + 1}: scalar pair #${i + 1} — noble x-coordinate matches OpenSSL computeSecret byte-for-byte`, () => {
        const pub = secp256k1.getPublicKey(pubScalar, true)
        const x = secp256k1.getSharedSecret(sk, pub, true).slice(1)
        expect(x.length, 'ECDH IKM must be exactly the 32-byte x-coordinate').to.equal(32)

        const ecdh = createECDH('secp256k1')
        ecdh.setPrivateKey(Buffer.from(sk))
        const nodeShared = ecdh.computeSecret(Buffer.from(pub))
        expect(bytesToHex(x)).to.equal(nodeShared.toString('hex'))
      })
    }

    it('KAT-ECDH-c: getSharedSecret throws on an off-curve point', () => {
      const sk = repeated(0x11, 32)
      // x = 0 is not on the curve y^2 = x^3 + 7 (0^3 + 7 = 7 is not a QR mod p),
      // so this is a guaranteed off-curve syntactically-valid-length point.
      const offCurve = new Uint8Array(33)
      offCurve[0] = 0x02
      expect(secp256k1.utils.isValidPublicKey(offCurve, true), 'fixture sanity: this point must actually be off-curve').to.equal(false)
      expect(() => secp256k1.getSharedSecret(sk, offCurve, true)).to.throw()
    })

    it('KAT-ECDH-d: getSharedSecret throws on a zero scalar', () => {
      const zeroScalar = new Uint8Array(32)
      const pub = secp256k1.getPublicKey(repeated(0x22, 32), true)
      expect(() => secp256k1.getSharedSecret(zeroScalar, pub, true)).to.throw()
    })
  })
})
