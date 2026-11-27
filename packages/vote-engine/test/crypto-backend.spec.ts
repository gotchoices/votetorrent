/**
 * crypto-backend.spec.ts — the optional native ECDH behind `ecdhX`
 * (`src/crypto/backend.ts`).
 *
 * Node's `createECDH` is OpenSSL, the same library react-native-quick-crypto
 * wraps on the phones, so it stands in for the app's backend here: real
 * native behaviour, including the two places OpenSSL is looser than noble
 * (hybrid point encodings, an out-of-range scalar). Every test restores the
 * noble default in `afterEach`, because the backend lives on `globalThis`.
 */

import { expect } from 'chai'
import { createECDH } from 'node:crypto'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { installedEcdhX, setCryptoBackend } from '../src/crypto/backend.js'
import { ecdhX } from '../src/crypto/encoding.js'
import { generateEncryptionKeyPair, openEnvelope, sealToRecipients } from '../src/crypto/envelope.js'

/** The app's backend shape, over Node's OpenSSL instead of quick-crypto. */
function opensslBackend (calls = { n: 0 }) {
  return {
    secp256k1EcdhX (secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
      calls.n++
      const ecdh = createECDH('secp256k1')
      ecdh.setPrivateKey(secretKey)
      return new Uint8Array(ecdh.computeSecret(publicKey))
    }
  }
}

const N = hexToBytes('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')

describe('crypto backend — native ECDH for ecdhX', () => {
  afterEach(() => setCryptoBackend(undefined))

  it('nothing is installed by default, and ecdhX is noble', () => {
    expect(installedEcdhX()).to.equal(undefined)
    const a = secp256k1.utils.randomSecretKey()
    const b = secp256k1.utils.randomSecretKey()
    const x = ecdhX(a, secp256k1.getPublicKey(b, true))
    expect(bytesToHex(x)).to.equal(bytesToHex(secp256k1.getSharedSecret(a, secp256k1.getPublicKey(b, true), true).slice(1)))
  })

  it('installs an OpenSSL backend, which then serves ecdhX with identical bytes for both point forms', () => {
    const calls = { n: 0 }
    setCryptoBackend(opensslBackend(calls))
    expect(installedEcdhX()).to.be.a('function')
    for (let i = 0; i < 20; i++) {
      const a = secp256k1.utils.randomSecretKey()
      const b = secp256k1.utils.randomSecretKey()
      for (const compressed of [true, false]) {
        const pub = secp256k1.getPublicKey(b, compressed)
        const noble = secp256k1.getSharedSecret(a, pub, true).slice(1)
        expect(bytesToHex(ecdhX(a, pub))).to.equal(bytesToHex(noble))
      }
    }
    expect(calls.n).to.be.greaterThan(40) // the self-check's calls plus 40 here
  })

  it('an envelope sealed under noble opens under the native backend, and the reverse', () => {
    const recipient = generateEncryptionKeyPair()
    const binding = { requestId: 'req-backend', digest: 'digest-backend' }
    const recipients = [{ userId: 'u1', publicKey: recipient.publicKey }]
    const me = { userId: 'u1', secretKey: recipient.secretKey }
    const plaintext = utf8ToBytes('quick-crypto ECDH parity')

    const sealedByNoble = sealToRecipients(plaintext, recipients, binding)
    const calls = { n: 0 }
    setCryptoBackend(opensslBackend(calls))
    const before = calls.n
    const opened = openEnvelope(sealedByNoble, me, binding)
    const sealedByNative = sealToRecipients(plaintext, recipients, binding)
    expect(calls.n - before).to.equal(2) // one ECDH to open, one to seal
    setCryptoBackend(undefined)
    const reopened = openEnvelope(sealedByNative, me, binding)

    expect(opened.ok, JSON.stringify(opened)).to.equal(true)
    expect(reopened.ok, JSON.stringify(reopened)).to.equal(true)
  })

  describe('inputs noble rejects never reach the backend, so ecdhX still throws', () => {
    const peer = secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), false)
    const secret = secp256k1.utils.randomSecretKey()

    it('a hybrid (0x06/0x07) point, which OpenSSL alone would accept', () => {
      const hybrid = peer.slice()
      hybrid[0] = 0x06 | (peer[64]! & 1)
      // The premise: OpenSSL really does accept it.
      const openssl = createECDH('secp256k1')
      openssl.setPrivateKey(secret)
      expect(openssl.computeSecret(hybrid)).to.have.length(32)

      const calls = { n: 0 }
      setCryptoBackend(opensslBackend(calls))
      const before = calls.n
      expect(() => ecdhX(secret, hybrid)).to.throw()
      expect(calls.n).to.equal(before)
    })

    it('a zero scalar and the group order n', () => {
      const calls = { n: 0 }
      setCryptoBackend(opensslBackend(calls))
      const before = calls.n
      expect(() => ecdhX(new Uint8Array(32), peer)).to.throw()
      expect(() => ecdhX(N, peer)).to.throw()
      expect(calls.n).to.equal(before)
    })

    it('a point that is not on the curve reaches the backend, which throws, and noble throws too', () => {
      setCryptoBackend(opensslBackend())
      const bad = peer.slice()
      bad[64] ^= 1
      expect(() => ecdhX(secret, bad)).to.throw()
    })
  })

  describe('the self-check refuses a wrong backend and keeps the previous state', () => {
    it('a backend that returns the wrong bytes', () => {
      expect(() => setCryptoBackend({ secp256k1EcdhX: () => new Uint8Array(32) })).to.throw(/different x-coordinate/)
      expect(installedEcdhX()).to.equal(undefined)
    })

    it('a backend that ignores byteOffset', () => {
      const ignoresOffset = {
        secp256k1EcdhX (secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
          const ecdh = createECDH('secp256k1')
          ecdh.setPrivateKey(new Uint8Array(secretKey.buffer, 0, 32))
          return new Uint8Array(ecdh.computeSecret(publicKey))
        }
      }
      expect(() => setCryptoBackend(ignoresOffset)).to.throw(/different x-coordinate/)
    })

    it('a backend that accepts a point off the curve', () => {
      const good = opensslBackend()
      const lax = {
        secp256k1EcdhX (secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
          try {
            return good.secp256k1EcdhX(secretKey, publicKey)
          } catch {
            return new Uint8Array(32)
          }
        }
      }
      setCryptoBackend(opensslBackend())
      const previous = installedEcdhX()
      expect(() => setCryptoBackend(lax)).to.throw(/not on the curve/)
      expect(installedEcdhX()).to.equal(previous)
    })
  })

  it('a backend that throws or returns a short array at run time falls back to noble', () => {
    let mode: 'ok' | 'throw' | 'short' = 'ok'
    const real = opensslBackend()
    setCryptoBackend({
      secp256k1EcdhX (secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
        if (mode === 'throw') throw new Error('native down')
        if (mode === 'short') return new Uint8Array(31)
        return real.secp256k1EcdhX(secretKey, publicKey)
      }
    })
    const a = secp256k1.utils.randomSecretKey()
    const pub = secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)
    const expected = bytesToHex(secp256k1.getSharedSecret(a, pub, true).slice(1))
    for (const m of ['throw', 'short'] as const) {
      mode = m
      expect(bytesToHex(ecdhX(a, pub))).to.equal(expected)
    }
  })
})
