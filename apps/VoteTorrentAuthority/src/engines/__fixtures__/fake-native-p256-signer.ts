/**
 * fake-native-p256-signer.ts — JEST-ONLY platform-faithful model of the native P-256 signer
 * (`signWithDeviceKey` / `signWithRecoveryKey`). The single native model every Authority signer
 * suite uses, so a raw-digest iOS signature is caught in jest (UAT 62 test 22, gap 2).
 *
 *   - ios:     the Secure Enclave signs its input as the FINAL ECDSA hash (noble `prehash: false`).
 *   - android: `SHA256withECDSA` hashes the input once itself (noble default `prehash: true`).
 *
 * Both return compact, low-S hex, like the real natives.
 */
import { p256 } from '@noble/curves/nist.js'

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')

export type NativeSignPlatform = 'ios' | 'android'

/** Decode plain base64 (native's input encoding) to bytes. */
export function bytesFromBase64(b64: string): Uint8Array {
	return Uint8Array.from(Buffer.from(b64, 'base64'))
}

/** What the given platform's native does with its decoded input, signing under `priv`. */
export function nativeSignHex(priv: Uint8Array, platformOS: NativeSignPlatform, input: Uint8Array): string {
	return hex(p256.sign(input, priv, { lowS: true, prehash: platformOS === 'android' }))
}

export interface FakeNativeP256Signer {
	signWithDeviceKey: (alias: string, digestBase64: string, ...prompts: string[]) => Promise<{ signatureHex: string }>
	signWithRecoveryKey: (alias: string, digestBase64: string, ...prompts: string[]) => Promise<{ signatureHex: string }>
}

export function makeFakeNativeP256Signer(priv: Uint8Array, platformOS: NativeSignPlatform): FakeNativeP256Signer {
	const sign = async (_alias: string, digestBase64: string) => ({
		signatureHex: nativeSignHex(priv, platformOS, bytesFromBase64(digestBase64)),
	})
	return { signWithDeviceKey: sign, signWithRecoveryKey: sign }
}
