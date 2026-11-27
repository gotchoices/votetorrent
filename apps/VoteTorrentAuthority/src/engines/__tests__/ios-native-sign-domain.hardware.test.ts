/**
 * Pinned hardware fact: what iOS native signWithDeviceKey / signWithRecoveryKey actually signs.
 *
 * Provenance: iPhone 13, iOS 26.7, 2026-10-07, UAT test 22 evidence_2. Signature produced by the
 * Secure Enclave key whose public key was recorded for the signer (no key desync). Input digest is
 * bytes 0x00..0x1f passed AS-IS to native signWithDeviceKey.
 *
 * Why it exists: the signature verifies with noble prehash:false over the RAW digest (iOS signs its
 * input as the final ECDSA hash) and FAILS verifySigP256 (noble default prehash:true, i.e.
 * ECDSA(sha256(digest))). So raw iOS output is not schema-valid; callers must pre-hash through
 * nativeSignInputBytes. If a native change makes this vector start verifying under verifySigP256,
 * the helper's iOS branch must change with it.
 */
import { p256 } from '@noble/curves/nist.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { verifySigP256 } from '@votetorrent/vote-engine/rn'

const hex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'))
const PUB = '03d3ca318b958c63697cda811d97c2e6c5611296de252025216a491cdf0e00a458'
const SIG =
	'96060ac19fbb41cd614e07246330774d5f977c0178a4ed13b8abaa012bb8694e289cb8bba2486b20c9c890ad1c7fe9808272141abbe82fceb51f8a8a2f248ec8'
const DIGEST = Uint8Array.from({ length: 32 }, (_, i) => i)

describe('iPhone 13 native signing domain (UAT 62 test 22)', () => {
	it('verifies with prehash:false over the raw digest', () => {
		expect(p256.verify(hex(SIG), DIGEST, hex(PUB), { prehash: false })).toBe(true)
	})

	it('FAILS verifySigP256 (the schema verifier): raw iOS output is not schema-valid', () => {
		expect(verifySigP256(Buffer.from(DIGEST).toString('base64url'), SIG, PUB)).toBe(false)
	})

	it('does not verify over sha256(digest) with prehash:false', () => {
		expect(p256.verify(hex(SIG), sha256(DIGEST), hex(PUB), { prehash: false })).toBe(false)
	})

	it('control: flipping the last signature byte breaks the first assertion', () => {
		const bad = hex(SIG)
		bad[bad.length - 1] = bad[bad.length - 1]! ^ 0x01
		expect(p256.verify(bad, DIGEST, hex(PUB), { prehash: false })).toBe(false)
	})
})
