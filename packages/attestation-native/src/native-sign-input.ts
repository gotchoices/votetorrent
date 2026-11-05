/**
 * native-sign-input.ts — the ONE definition of the 32 bytes handed to native `signWithDeviceKey` /
 * `signWithRecoveryKey` when the resulting signature is checked by the schema verifier
 * (`verifySigP256` / `SignatureValidP256`, @noble/curves default `prehash: true`, i.e. it checks
 * ECDSA(sha256(digest))).
 *
 * PLATFORM ASYMMETRY (UAT 62 test 22, gap 2):
 *   - iOS native signs its input as the FINAL ECDSA hash (`.ecdsaSignatureDigestX962SHA256`,
 *     noble `prehash: false`), so the caller must pass `sha256(digest)`.
 *   - Android native uses `SHA256withECDSA`, which hashes once itself, so the caller passes the
 *     digest AS-IS.
 *   - Any other platform has no native signer; refusing beats signing the wrong domain.
 *
 * Every native signing caller whose signature is verified by `verifySigP256` MUST go through this
 * helper. The one deliberate exception is the iOS proof of possession, which signs
 * sha256(utf8(POP_DIGEST)) under a `prehash: false` verifier (ATTESTATION-CONTRACT-IOS.md §4).
 *
 * Pure module: no react-native import, no TurboModule access.
 */
import { resolveHasher } from '@optimystic/quereus-plugin-crypto'

const hasher = resolveHasher('sha256')

interface BtoaEnv {
	btoa: (data: string) => string
}
const { btoa: btoaFn } = globalThis as unknown as BtoaEnv

/** The bytes native must sign so the signature passes `verifySigP256` over `digest`. */
export function nativeSignInputBytes(digest: Uint8Array, platformOS: string): Uint8Array {
	if (platformOS === 'ios') return hasher(digest)
	if (platformOS === 'android') return Uint8Array.from(digest)
	throw Object.assign(new Error(`No native signer for platform '${platformOS}'`), {
		code: 'UNSUPPORTED_SIGNING_PLATFORM',
	})
}

/** `nativeSignInputBytes` as plain, padded, standard-alphabet base64 (native's input encoding). */
export function nativeSignInputBase64(digest: Uint8Array, platformOS: string): string {
	const bytes = nativeSignInputBytes(digest, platformOS)
	let binary = ''
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
	return btoaFn(binary)
}
