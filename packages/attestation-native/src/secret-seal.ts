/**
 * secret-seal.ts — typed JS wrapper over the `sealSecret`/`unsealSecret` TurboModule methods (keyholder
 * prompt batching). Public-key sealing of SMALL secrets (1..128 bytes): sealing uses only the public half
 * of a hardware key pair, so it NEVER prompts; unsealing is per-use and biometric-only, exactly one prompt.
 *
 * Android: RSA-2048 AndroidKeyStore key (StrongBox, else TEE), RSA-OAEP SHA-256 / MGF1-SHA-1.
 * iOS: Secure Enclave P-256 key, ECIES (cofactor, variable IV, X9.63 SHA-256, AES-GCM).
 *
 * The private half is destroyed by a biometric enrolment change on both platforms (`KEY_INVALIDATED`).
 * A binary built before these methods existed, or a device with no secure hardware for the key (the iOS
 * Simulator), rejects `NATIVE_UNAVAILABLE` / `SEAL_UNAVAILABLE`, so a caller can fall back to the
 * per-use AES wrap in `secret-wrap.ts`.
 *
 * Native access is LAZY for the same reason as `secret-wrap.ts`'s `getNative()`.
 */

import type { Spec as NativeAttestationSpec } from './specs/NativeAttestation'

/** `VOTETORRENT_<APP>_<PURPOSE>_SEAL_KEY_V<n>`. Must equal the pattern in SecretSealHelper.kt and
 * AttestationNativeModule.swift. Disjoint from `WRAP_KEY_ALIAS_PATTERN`. */
export const SEAL_KEY_ALIAS_PATTERN = /^VOTETORRENT_[A-Z0-9_]+_SEAL_KEY_V[0-9]+$/

/** Must equal `MAX_SEAL_PLAINTEXT_BYTES` in SecretSealHelper.kt and `maxSealPlaintextBytes` in the Swift. */
export const MAX_SEAL_PLAINTEXT_BYTES = 128

export const SEAL_ALGORITHMS = ['RSA-OAEP-SHA256', 'ECIES-P256-SHA256-AESGCM'] as const
export type SealAlgorithm = (typeof SEAL_ALGORITHMS)[number]

export const SEAL_SECURITY_LEVELS = ['strongbox', 'tee', 'software', 'unknown', 'secure-enclave', 'test-stub'] as const
export type SealSecurityLevel = (typeof SEAL_SECURITY_LEVELS)[number]

export interface SealedSecret {
	v: 1
	alg: SealAlgorithm
	keyAlias: string
	ciphertextBase64: string
	securityLevel: SealSecurityLevel
}

export interface SecretSealPrompt {
	title: string
	subtitle: string
	negativeButton: string
}

export interface SecretSealer {
	sealSecret(keyAlias: string, plaintext: Uint8Array): Promise<SealedSecret>
	unsealSecret(sealed: SealedSecret, prompt: SecretSealPrompt): Promise<Uint8Array>
}

export const SECRET_SEAL_ERROR_CODES = [
	'INVALID_ARGUMENT',
	'INVALID_ENCODING',
	'NO_SEAL_KEY',
	'SEAL_KEY_POLICY_MISMATCH',
	'SEAL_UNAVAILABLE',
	'KEY_INVALIDATED',
	'DEVICE_LOCKED',
	'CANCELED',
	'NO_BIOMETRICS_ENROLLED',
	'LOCKOUT',
	'LOCKOUT_PERMANENT',
	'BIOMETRIC_ERROR',
	'NO_ACTIVITY',
	'SEAL_FAILED',
	'UNSEAL_FAILED',
	'NATIVE_UNAVAILABLE',
	'MALFORMED_NATIVE_RESULT',
] as const

export type SecretSealErrorCode = (typeof SECRET_SEAL_ERROR_CODES)[number]

const KNOWN_CODES: ReadonlySet<string> = new Set(SECRET_SEAL_ERROR_CODES)
const KNOWN_ALGS: ReadonlySet<string> = new Set(SEAL_ALGORITHMS)
const KNOWN_LEVELS: ReadonlySet<string> = new Set(SEAL_SECURITY_LEVELS)

export class SecretSealError extends Error {
	readonly code: SecretSealErrorCode

	constructor(code: SecretSealErrorCode, message: string) {
		super(message)
		this.name = 'SecretSealError'
		this.code = code
	}
}

export function isValidSealKeyAlias(alias: string): boolean {
	return typeof alias === 'string' && SEAL_KEY_ALIAS_PATTERN.test(alias)
}

function getNative(): NativeAttestationSpec {
	// eslint-disable-next-line @typescript-eslint/no-var-requires -- deliberate lazy require, mirrors secret-wrap.ts.
	return require('./specs/NativeAttestation').default as NativeAttestationSpec
}

type Base64GlobalEnv = {
	btoa: (data: string) => string
	atob: (data: string) => string
}
const { btoa: btoaFn, atob: atobFn } = globalThis as unknown as Base64GlobalEnv

function base64FromBytes(bytes: Uint8Array): string {
	let binary = ''
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
	return btoaFn(binary)
}

function bytesFromBase64(value: string): Uint8Array {
	const binary = atobFn(value)
	const out = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
	return out
}

function mapNativeError(err: unknown, fallback: SecretSealErrorCode): SecretSealError {
	const code = (err as { code?: unknown } | undefined)?.code
	if (typeof code === 'string' && KNOWN_CODES.has(code)) {
		return new SecretSealError(code as SecretSealErrorCode, `native secret-seal operation rejected: ${code}`)
	}
	return new SecretSealError(fallback, 'native secret-seal operation rejected with an unrecognized code')
}

/** Resolves the native method, or throws NATIVE_UNAVAILABLE (no module, or a binary without it). */
function nativeMethod<K extends 'sealSecret' | 'unsealSecret'>(name: K): NativeAttestationSpec[K] {
	let native: NativeAttestationSpec
	try {
		native = getNative()
	} catch {
		throw new SecretSealError('NATIVE_UNAVAILABLE', 'the AttestationNative TurboModule is not available')
	}
	const fn = (native as Partial<NativeAttestationSpec>)[name]
	if (typeof fn !== 'function') {
		throw new SecretSealError('NATIVE_UNAVAILABLE', `${name} is not available in this binary`)
	}
	return fn.bind(native) as NativeAttestationSpec[K]
}

function parseSealResult(raw: unknown, keyAlias: string): SealedSecret {
	const r = raw as { ciphertextBase64?: unknown; keyAlias?: unknown; securityLevel?: unknown; alg?: unknown }
	if (typeof r?.ciphertextBase64 !== 'string' || typeof r.keyAlias !== 'string' || typeof r.securityLevel !== 'string' || typeof r.alg !== 'string') {
		throw new SecretSealError('MALFORMED_NATIVE_RESULT', 'sealSecret result is missing a required field')
	}
	if (r.keyAlias !== keyAlias) {
		throw new SecretSealError('MALFORMED_NATIVE_RESULT', 'sealSecret result keyAlias does not match the request')
	}
	if (!KNOWN_ALGS.has(r.alg) || !KNOWN_LEVELS.has(r.securityLevel)) {
		throw new SecretSealError('MALFORMED_NATIVE_RESULT', 'sealSecret result has an unrecognized alg or securityLevel')
	}
	let length: number
	try {
		length = bytesFromBase64(r.ciphertextBase64).length
	} catch {
		throw new SecretSealError('MALFORMED_NATIVE_RESULT', 'sealSecret result did not decode as base64')
	}
	if (length < 32) {
		throw new SecretSealError('MALFORMED_NATIVE_RESULT', 'sealSecret result ciphertext is too short')
	}
	return { v: 1, alg: r.alg as SealAlgorithm, keyAlias, ciphertextBase64: r.ciphertextBase64, securityLevel: r.securityLevel as SealSecurityLevel }
}

/** A `SecretSealer` over the native `sealSecret`/`unsealSecret` methods. */
export function createNativeSecretSealer(): SecretSealer {
	return {
		async sealSecret(keyAlias: string, plaintext: Uint8Array): Promise<SealedSecret> {
			if (!isValidSealKeyAlias(keyAlias)) throw new SecretSealError('INVALID_ARGUMENT', `invalid seal key alias: ${keyAlias}`)
			if (!(plaintext instanceof Uint8Array) || plaintext.length < 1 || plaintext.length > MAX_SEAL_PLAINTEXT_BYTES) {
				throw new SecretSealError('INVALID_ARGUMENT', `plaintext must be 1..${MAX_SEAL_PLAINTEXT_BYTES} bytes`)
			}
			const seal = nativeMethod('sealSecret')
			let raw: unknown
			try {
				raw = await seal(keyAlias, base64FromBytes(plaintext))
			} catch (err) {
				throw mapNativeError(err, 'SEAL_FAILED')
			}
			return parseSealResult(raw, keyAlias)
		},

		async unsealSecret(sealed: SealedSecret, prompt: SecretSealPrompt): Promise<Uint8Array> {
			if (sealed?.v !== 1 || !KNOWN_ALGS.has(sealed.alg) || !isValidSealKeyAlias(sealed.keyAlias)) {
				throw new SecretSealError('INVALID_ARGUMENT', 'unsupported SealedSecret')
			}
			const unseal = nativeMethod('unsealSecret')
			let raw: unknown
			try {
				raw = await unseal(sealed.keyAlias, sealed.ciphertextBase64, prompt.title, prompt.subtitle, prompt.negativeButton)
			} catch (err) {
				throw mapNativeError(err, 'UNSEAL_FAILED')
			}
			const r = raw as { plaintextBase64?: unknown }
			if (typeof r?.plaintextBase64 !== 'string') {
				throw new SecretSealError('MALFORMED_NATIVE_RESULT', 'unsealSecret result is missing plaintextBase64')
			}
			try {
				return bytesFromBase64(r.plaintextBase64)
			} catch {
				throw new SecretSealError('MALFORMED_NATIVE_RESULT', 'unsealSecret result did not decode as base64')
			}
		},
	}
}
