/**
 * native-sign-input — the one definition of the bytes every verifySigP256-checked native signature
 * is made over (UAT 62 test 22, gap 2). iOS native signs its input as the FINAL ECDSA hash
 * (noble prehash:false); Android's SHA256withECDSA hashes once; the verifier hashes once.
 */
import { p256 } from '@noble/curves/nist.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { verifySigP256 } from '@votetorrent/vote-engine/rn'
import { nativeSignInputBase64, nativeSignInputBytes } from '@votetorrent/attestation-native/src/native-sign-input'

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url')
const DIGEST = Uint8Array.from({ length: 32 }, (_, i) => (i * 11 + 5) & 0xff)

const newKey = () => {
	const priv = p256.utils.randomSecretKey()
	return { priv, pub: hex(p256.getPublicKey(priv, true)) }
}

describe('nativeSignInputBytes', () => {
	it('ios: sha256(digest)', () => {
		expect(Array.from(nativeSignInputBytes(DIGEST, 'ios'))).toEqual(Array.from(sha256(DIGEST)))
	})

	it('android: the digest byte-for-byte, as a copy', () => {
		const out = nativeSignInputBytes(DIGEST, 'android')
		expect(Array.from(out)).toEqual(Array.from(DIGEST))
		const before = Array.from(DIGEST)
		out[0] = out[0]! ^ 0xff
		expect(Array.from(DIGEST)).toEqual(before)
	})

	it.each(['web', 'macos', ''])('%p throws UNSUPPORTED_SIGNING_PLATFORM', platform => {
		expect(() => nativeSignInputBytes(DIGEST, platform)).toThrow(
			expect.objectContaining({ code: 'UNSUPPORTED_SIGNING_PLATFORM' }),
		)
	})
})

describe('nativeSignInputBase64', () => {
	it('is padded standard-alphabet base64 of the input bytes', () => {
		for (const platform of ['ios', 'android']) {
			const out = nativeSignInputBase64(DIGEST, platform)
			expect(out).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
			expect(out).not.toMatch(/[-_]/)
			expect(out.length % 4).toBe(0)
			expect(Array.from(Buffer.from(out, 'base64'))).toEqual(Array.from(nativeSignInputBytes(DIGEST, platform)))
		}
	})
	it('uses the standard alphabet and padding for a digest that exercises + / and =', () => {
		const d = Uint8Array.from({ length: 32 }, () => 0xfb)
		const out = nativeSignInputBase64(d, 'android')
		expect(out).toContain('+')
		expect(out.endsWith('=')).toBe(true)
	})
})

describe('model: native signer + helper vs the schema verifier', () => {
	const iosNative = (input: Uint8Array, priv: Uint8Array) => hex(p256.sign(input, priv, { prehash: false, lowS: true }))
	const androidNative = (input: Uint8Array, priv: Uint8Array) => hex(p256.sign(input, priv, { lowS: true }))

	it('iOS model fed the helper output is accepted by verifySigP256', () => {
		const k = newKey()
		expect(verifySigP256(b64url(DIGEST), iosNative(nativeSignInputBytes(DIGEST, 'ios'), k.priv), k.pub)).toBe(true)
	})

	it('Android model fed the helper output is accepted by verifySigP256', () => {
		const k = newKey()
		expect(verifySigP256(b64url(DIGEST), androidNative(nativeSignInputBytes(DIGEST, 'android'), k.priv), k.pub)).toBe(true)
	})

	it('NEGATIVE CONTROL (gap 2): iOS model fed the RAW digest is rejected', () => {
		const k = newKey()
		expect(verifySigP256(b64url(DIGEST), iosNative(DIGEST, k.priv), k.pub)).toBe(false)
	})

	it('NEGATIVE CONTROL: a signature by a different key is rejected', () => {
		const k = newKey()
		const other = newKey()
		expect(verifySigP256(b64url(DIGEST), iosNative(nativeSignInputBytes(DIGEST, 'ios'), other.priv), k.pub)).toBe(false)
	})
})
