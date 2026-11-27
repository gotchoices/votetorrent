/**
 * block-cipher.spec.ts — Phase 62 Plan 04 (D-18, D-25)
 *
 * Proves the block-content cipher in `src/crypto/block-cipher.ts` against
 * `doc/encryption-formats.md` section 3: round-trip under a real
 * `secp256k1_FROST` DKG-shaped joint key, fail-closed wrong-key/binding/
 * tampering behavior, an independent `node:crypto` re-implementation
 * (KAT-BLOCK-INDEP), a FROZEN regression pin, and input validation.
 *
 * `node:crypto` is used ONLY in this test file — never in `src/crypto/`.
 */

import { expect } from 'chai'
import { createCipheriv, createECDH, hkdfSync } from 'node:crypto'
import { secp256k1, secp256k1_FROST } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  BLOCK_CIPHER_ALG,
  BLOCK_CIPHER_FORMAT_VERSION,
  BlockCipherError,
  decryptBlockContent,
  encryptBlockContent,
  encryptBlockContentWithRandomness,
  serializeBlockCiphertext
} from '../src/crypto/block-cipher.js'
import type { BlockCiphertext } from '../src/crypto/block-cipher.js'

const repeated = (byte: number, length: number): Uint8Array => new Uint8Array(length).fill(byte)
const sequence = (start: number, length: number): Uint8Array => Uint8Array.from({ length }, (_, i) => (start + i) & 0xff)

describe('block-cipher (62-04, D-18)', () => {
  // -------------------------------------------------------------------------
  // Block round trip under a real DKG-shaped key
  // -------------------------------------------------------------------------
  describe('round trip under secp256k1_FROST DKG (3-of-5, test only)', () => {
    it('encryptBlockContent(hex(Y), ...) then decryptBlockContent(s, ...) returns identical bytes, with Y from trustedDealer+combineSecret over 3 of 5 shares', () => {
      const signers = { min: 3, max: 5 }
      const ids = [1, 2, 3, 4, 5].map((n) => secp256k1_FROST.Identifier.fromNumber(n))
      const dealt = secp256k1_FROST.trustedDealer(signers, ids)
      const chosenIds = Object.keys(dealt.secretShares).slice(0, 3)
      const shares = chosenIds.map((id) => dealt.secretShares[id]!)
      const s = secp256k1_FROST.combineSecret(shares, signers)
      const Y = bytesToHex(secp256k1.getPublicKey(s, true))
      expect(Y, 'Y must equal commitments[0], the DKG joint public key').to.equal(bytesToHex(dealt.public.commitments[0]!))

      const plaintext = new TextEncoder().encode('vote-record-bytes')
      const binding = { electionId: 'el-dkg', revision: 1, blockId: 'blk-dkg' }
      const ciphertext = encryptBlockContent(Y, plaintext, binding)
      const result = decryptBlockContent(s, ciphertext, binding)
      expect(result.ok).to.equal(true)
      if (result.ok) expect(Buffer.from(result.plaintext).equals(Buffer.from(plaintext))).to.equal(true)
    })

    it('a second case uses a directly generated scalar (not DKG-derived)', () => {
      const s = secp256k1.utils.randomSecretKey()
      const Y = bytesToHex(secp256k1.getPublicKey(s, true))
      const plaintext = new TextEncoder().encode('directly-generated-key case')
      const binding = { electionId: 'el-direct', revision: 0, blockId: 'blk-direct' }
      const ciphertext = encryptBlockContent(Y, plaintext, binding)
      const result = decryptBlockContent(s, ciphertext, binding)
      expect(result.ok).to.equal(true)
      if (result.ok) expect(Buffer.from(result.plaintext).equals(Buffer.from(plaintext))).to.equal(true)
    })
  })

  // -------------------------------------------------------------------------
  // Wrong key / binding / tampering
  // -------------------------------------------------------------------------
  describe('fail-closed behavior', () => {
    const s = repeated(0x61, 32)
    const Y = bytesToHex(secp256k1.getPublicKey(s, true))
    const binding = { electionId: 'el-1', revision: 5, blockId: 'blk-1' }
    const plaintext = new TextEncoder().encode('block content')
    const ciphertext = encryptBlockContent(Y, plaintext, binding)

    function flip (b64u: string): string {
      const bytes = Buffer.from(b64u, 'base64url')
      bytes[0] = bytes[0]! ^ 0x01
      return bytes.toString('base64url')
    }

    it('decrypting with a different scalar gives authentication-failed', () => {
      const wrongScalar = repeated(0x62, 32)
      const result = decryptBlockContent(wrongScalar, ciphertext, binding)
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('authentication-failed')
    })

    it('changing electionId gives authentication-failed', () => {
      const result = decryptBlockContent(s, ciphertext, { ...binding, electionId: 'el-other' })
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('authentication-failed')
    })

    it('changing revision gives authentication-failed', () => {
      const result = decryptBlockContent(s, ciphertext, { ...binding, revision: 6 })
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('authentication-failed')
    })

    it('changing blockId gives authentication-failed', () => {
      const result = decryptBlockContent(s, ciphertext, { ...binding, blockId: 'blk-other' })
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('authentication-failed')
    })

    it('a flipped bit in ct gives authentication-failed', () => {
      const result = decryptBlockContent(s, { ...ciphertext, ct: flip(ciphertext.ct) }, binding)
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('authentication-failed')
    })

    it('a flipped bit in nonce gives authentication-failed', () => {
      const result = decryptBlockContent(s, { ...ciphertext, nonce: flip(ciphertext.nonce) }, binding)
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('authentication-failed')
    })

    it('a flipped bit in kc gives authentication-failed', () => {
      const result = decryptBlockContent(s, { ...ciphertext, kc: flip(ciphertext.kc) }, binding)
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('authentication-failed')
    })

    it('a flipped bit in eph (still on-curve) gives authentication-failed', () => {
      // Flip a high bit of the x-coordinate but keep the prefix byte intact;
      // re-derive a syntactically valid-length hex that may or may not be
      // on-curve — if it lands off-curve this assertion is skipped in favor
      // of the dedicated off-curve-eph case below, so pick a byte position
      // and prefix known to stay on a DIFFERENT valid curve point: use the
      // other party's own generator-derived point instead of bit-flipping,
      // which guarantees on-curve-but-wrong.
      const otherEph = bytesToHex(secp256k1.getPublicKey(repeated(0x99, 32), true))
      const result = decryptBlockContent(s, { ...ciphertext, eph: otherEph }, binding)
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('authentication-failed')
    })

    it('an off-curve eph gives malformed-ciphertext', () => {
      const offCurveEph = '02' + '00'.repeat(32)
      const result = decryptBlockContent(s, { ...ciphertext, eph: offCurveEph }, binding)
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('malformed-ciphertext')
    })

    it('v: 2 gives unsupported-version, asserted not to be authentication-failed', () => {
      const result = decryptBlockContent(s, { ...ciphertext, v: 2 as unknown as 1 }, binding)
      expect(result.ok).to.equal(false)
      if (!result.ok) {
        expect(result.reason).to.equal('unsupported-version')
        expect(result.reason).to.not.equal('authentication-failed')
      }
    })

    it('a non-JSON string gives malformed-ciphertext', () => {
      const result = decryptBlockContent(s, 'not json {{{', binding)
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('malformed-ciphertext')
    })

    it('a zero scalar gives invalid-argument', () => {
      const result = decryptBlockContent(new Uint8Array(32), ciphertext, binding)
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('invalid-argument')
    })

    it('the unmodified ciphertext still decrypts (paired positive control)', () => {
      const result = decryptBlockContent(s, ciphertext, binding)
      expect(result.ok).to.equal(true)
    })
  })

  // -------------------------------------------------------------------------
  // Encrypt input errors
  // -------------------------------------------------------------------------
  describe('encrypt input validation', () => {
    const binding = { electionId: 'el-1', revision: 0, blockId: 'blk-1' }
    const plaintext = new TextEncoder().encode('x')
    const validY = bytesToHex(secp256k1.getPublicKey(repeated(0x71, 32), true))

    it('an invalid Y hex throws BlockCipherError invalid-joint-key', () => {
      try {
        encryptBlockContent('not-a-key', plaintext, binding)
        expect.fail('must throw')
      } catch (err) {
        expect(err).to.be.instanceOf(BlockCipherError)
        expect((err as BlockCipherError).code).to.equal('invalid-joint-key')
      }
    })

    it('a negative revision throws invalid-binding', () => {
      try {
        encryptBlockContent(validY, plaintext, { ...binding, revision: -1 })
        expect.fail('must throw')
      } catch (err) {
        expect((err as BlockCipherError).code).to.equal('invalid-binding')
      }
    })

    it('a fractional revision throws invalid-binding', () => {
      try {
        encryptBlockContent(validY, plaintext, { ...binding, revision: 1.5 })
        expect.fail('must throw')
      } catch (err) {
        expect((err as BlockCipherError).code).to.equal('invalid-binding')
      }
    })

    it('an unsafe-integer revision throws invalid-binding', () => {
      try {
        encryptBlockContent(validY, plaintext, { ...binding, revision: Number.MAX_SAFE_INTEGER + 10 })
        expect.fail('must throw')
      } catch (err) {
        expect((err as BlockCipherError).code).to.equal('invalid-binding')
      }
    })

    it('an empty electionId throws invalid-binding', () => {
      try {
        encryptBlockContent(validY, plaintext, { ...binding, electionId: '' })
        expect.fail('must throw')
      } catch (err) {
        expect((err as BlockCipherError).code).to.equal('invalid-binding')
      }
    })

    it('an empty blockId throws invalid-binding', () => {
      try {
        encryptBlockContent(validY, plaintext, { ...binding, blockId: '' })
        expect.fail('must throw')
      } catch (err) {
        expect((err as BlockCipherError).code).to.equal('invalid-binding')
      }
    })

    it('a non-Uint8Array plaintext throws invalid-plaintext', () => {
      try {
        encryptBlockContent(validY, 'not-bytes' as unknown as Uint8Array, binding)
        expect.fail('must throw')
      } catch (err) {
        expect((err as BlockCipherError).code).to.equal('invalid-plaintext')
      }
    })
  })

  // -------------------------------------------------------------------------
  // KAT-BLOCK-INDEP and FROZEN-BLOCK
  // -------------------------------------------------------------------------
  describe('KAT-BLOCK-INDEP — independent node:crypto re-implementation, doc/encryption-formats.md section 3', () => {
    const s = repeated(0x61, 32)
    const Y = bytesToHex(secp256k1.getPublicKey(s, true))
    const eph = repeated(0x51, 32)
    const nonce = sequence(0xd0, 12)
    const binding = { electionId: 'el-kat', revision: 3, blockId: 'blk-kat' }
    const plaintext = new TextEncoder().encode('{"kat":"vt-block-1"}')

    function lengthPrefixed (fields: readonly string[]): Buffer {
      const parts: Buffer[] = []
      for (const field of fields) {
        const bytes = Buffer.from(field, 'utf8')
        const len = Buffer.alloc(4)
        len.writeUInt32BE(bytes.length, 0)
        parts.push(len, bytes)
      }
      return Buffer.concat(parts)
    }

    function nodeEncryptBlockContent (): BlockCiphertext {
      const yBytes = Buffer.from(Y, 'hex')
      const ephPub = Buffer.from(secp256k1.getPublicKey(eph, true))
      const ecdh = createECDH('secp256k1')
      ecdh.setPrivateKey(Buffer.from(eph))
      const z = ecdh.computeSecret(yBytes)
      const salt = Buffer.concat([ephPub, yBytes])
      const kdfOut = Buffer.from(hkdfSync('sha256', z, salt, Buffer.from('vt-block-1/key'), 64))
      const k = kdfOut.subarray(0, 32)
      const kc = kdfOut.subarray(32, 64)
      const aad = lengthPrefixed(['vt-block-1/content', binding.electionId, String(binding.revision), binding.blockId])
      const cipher = createCipheriv('aes-256-gcm', k, Buffer.from(nonce))
      cipher.setAAD(aad)
      const body = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()])
      const ct = Buffer.concat([body, cipher.getAuthTag()])
      return {
        v: 1,
        alg: 'vt-block-1',
        eph: ephPub.toString('hex'),
        nonce: Buffer.from(nonce).toString('base64url'),
        kc: kc.toString('base64url'),
        ct: ct.toString('base64url')
      }
    }

    it('KAT-BLOCK-INDEP-a: encryptBlockContentWithRandomness equals a node:crypto-built ciphertext, member for member', () => {
      const ours = encryptBlockContentWithRandomness(Y, plaintext, binding, { ephemeralSecretKey: eph, nonce })
      const reference = nodeEncryptBlockContent()
      expect(ours.eph).to.equal(reference.eph)
      expect(ours.nonce).to.equal(reference.nonce)
      expect(ours.kc).to.equal(reference.kc)
      expect(ours.ct).to.equal(reference.ct)
    })

    it('KAT-BLOCK-INDEP-b: the node:crypto-built ciphertext decrypts with decryptBlockContent', () => {
      const reference = nodeEncryptBlockContent()
      const result = decryptBlockContent(s, reference, binding)
      expect(result.ok).to.equal(true)
      if (result.ok) expect(Buffer.from(result.plaintext).toString('utf8')).to.equal('{"kat":"vt-block-1"}')
    })
  })

  describe('FROZEN-BLOCK — repo-generated regression and cross-runtime parity pin', () => {
    const s = repeated(0x61, 32)
    const Y = bytesToHex(secp256k1.getPublicKey(s, true))
    const eph = repeated(0x51, 32)
    const nonce = sequence(0xd0, 12)
    const binding = { electionId: 'el-kat', revision: 3, blockId: 'blk-kat' }
    const plaintext = new TextEncoder().encode('{"kat":"vt-block-1"}')

    const FROZEN_BLOCK_JSON =
      '{"v":1,"alg":"vt-block-1","eph":"03baf7689c0a3558fb604589036a8d1e4b685d909f6e0e2c6018a14049ae64ec26","nonce":"0NHS09TV1tfY2drb","kc":"DjJvJ5-9HSucfMe_7PxRpxRl-DrjK5f_kzKXbL4e8j8","ct":"LOGVNkwQbqJMg0huj41JmOxy1enfcqPnSLy-k7OdfSmP4rC4"}'

    it('FROZEN-BLOCK: serializeBlockCiphertext of the KAT ciphertext equals the pinned string', () => {
      const ours = encryptBlockContentWithRandomness(Y, plaintext, binding, { ephemeralSecretKey: eph, nonce })
      expect(serializeBlockCiphertext(ours)).to.equal(FROZEN_BLOCK_JSON)
    })

    it('FROZEN-BLOCK: the pinned string decrypts to the frozen plaintext', () => {
      const parsed = JSON.parse(FROZEN_BLOCK_JSON)
      const result = decryptBlockContent(s, parsed, binding)
      expect(result.ok).to.equal(true)
      if (result.ok) expect(Buffer.from(result.plaintext).toString('utf8')).to.equal('{"kat":"vt-block-1"}')
    })
  })

  // -------------------------------------------------------------------------
  // Freshness
  // -------------------------------------------------------------------------
  describe('freshness', () => {
    it('two encryptions of the same input differ in eph, nonce, kc and ct', () => {
      const s = repeated(0x81, 32)
      const Y = bytesToHex(secp256k1.getPublicKey(s, true))
      const binding = { electionId: 'el-fresh', revision: 0, blockId: 'blk-fresh' }
      const plaintext = new TextEncoder().encode('p')
      const a = encryptBlockContent(Y, plaintext, binding)
      const b = encryptBlockContent(Y, plaintext, binding)
      expect(a.eph).to.not.equal(b.eph)
      expect(a.nonce).to.not.equal(b.nonce)
      expect(a.kc).to.not.equal(b.kc)
      expect(a.ct).to.not.equal(b.ct)
    })
  })

  describe('locked constants', () => {
    it('BLOCK_CIPHER_FORMAT_VERSION and BLOCK_CIPHER_ALG', () => {
      expect(BLOCK_CIPHER_FORMAT_VERSION).to.equal(1)
      expect(BLOCK_CIPHER_ALG).to.equal('vt-block-1')
    })
  })
})
