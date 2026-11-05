/**
 * secret-wrap.ts — typed JS wrapper over the `wrapSecret`/`unwrapSecret` TurboModule methods
 * (D-42, Phase 62 plan 08). Generic, alias-keyed AES-256-GCM secret-at-rest protection — NOT the
 * P-256 signing-key flow `real-attestation-producer.ts` already owns.
 *
 * Every consumer (this plan's Voter `device-key-wrap.ts`, and later 62-21/62-26's Authority
 * consumers) goes through this module rather than calling the TurboModule directly, so the alias
 * pattern, input validation and native-result validation live in exactly one place.
 *
 * Access to the native module is LAZY, for the identical reason `real-attestation-producer.ts`'s
 * `getNative()` is: `TurboModuleRegistry.getEnforcing(...)` throws under Node/jest, so a top-level
 * import of `./specs/NativeAttestation`'s default export would break importing this module (and
 * therefore every constant/type it exports) outside a real native runtime.
 */

import type { Spec as NativeAttestationSpec } from './specs/NativeAttestation'

/** D-42 canonical alias for the Voter app's identity-key wrap key. */
export const VOTETORRENT_VOTER_IDENTITY_WRAP_KEY_V1 = 'VOTETORRENT_VOTER_IDENTITY_WRAP_KEY_V1'

/**
 * Alias naming rule for every consumer of this module:
 * `VOTETORRENT_<APP>_<PURPOSE>_WRAP_KEY_V<n>`. One alias = one auth policy, forever (BOTH
 * `requireAuth` AND `authWindowSeconds`) — a consumer must never reuse an alias with a different
 * `requireAuth` or window value (native rejects
 * `WRAP_KEY_POLICY_MISMATCH` rather than silently downgrading).
 */
export const WRAP_KEY_ALIAS_PATTERN = /^VOTETORRENT_[A-Z0-9_]+_WRAP_KEY_V[0-9]+$/

export function isValidWrapKeyAlias(alias: string): boolean {
	return WRAP_KEY_ALIAS_PATTERN.test(alias)
}

/**
 * Phase 63 review CR-02: the ONLY aliases `deleteWrapKey` may delete, the vote-record wrap-key
 * family. It never matches the identity alias (`VOTETORRENT_VOTER_IDENTITY_WRAP_KEY_V1`) nor any
 * signing alias. Must equal `DELETABLE_WRAP_KEY_ALIAS_PATTERN` in SecretWrapHelper.kt and the Swift
 * `deletableWrapKeyAliasPattern` (the Voter's secure-surface ABI gate checks all three).
 */
export const VOTE_RECORD_WRAP_KEY_ALIAS_PATTERN = /^VOTETORRENT_VOTE_RECORD_WRAP_KEY_V[0-9]+$/

export function isDeletableWrapKeyAlias(alias: string): boolean {
	return VOTE_RECORD_WRAP_KEY_ALIAS_PATTERN.test(alias)
}

/** Reported, never asserted — this module makes no hardware-backing guarantee beyond what the OS
 * actually reports. `'test-stub'` is reserved for the jest-only in-memory provider and is REJECTED
 * as a native result (T-62-08-07 — a test provider must never masquerade as a real one). */
export type WrapKeySecurityLevel = 'strongbox' | 'tee' | 'software' | 'keychain' | 'unknown' | 'test-stub'

/** The set of security levels a REAL native result may report (excludes 'test-stub'). */
const NATIVE_SECURITY_LEVELS: ReadonlySet<string> = new Set(['strongbox', 'tee', 'software', 'keychain', 'unknown'])

export interface WrappedSecret {
	v: 1
	alg: 'AES-256-GCM'
	keyAlias: string
	ivBase64: string
	ciphertextBase64: string
	securityLevel: WrapKeySecurityLevel
}

export interface SecretWrapPrompt {
	title: string
	subtitle: string
	negativeButton: string
}

/**
 * Upper bound on `SecretWrapOptions.authWindowSeconds`, so no caller can turn an auth-required key
 * into an effectively unlocked one. Must equal `MAX_AUTH_WINDOW_SECONDS` in SecretWrapHelper.kt
 * (the secret-wrap ABI gate checks this).
 */
export const MAX_AUTH_WINDOW_SECONDS = 60

export interface SecretWrapOptions {
	requireAuth: boolean
	aad: Uint8Array
	/** Required iff `requireAuth` is true. */
	prompt?: SecretWrapPrompt
	/**
	 * D-14: seconds one biometric authentication keeps the wrap key usable. Integer 0..60; absent
	 * or 0 means per-use (today's behaviour). Fixed when an alias's key is first created, so one
	 * alias has one policy (requireAuth AND window) forever. Requires `requireAuth`. Android honours
	 * a window above 0 with a time-bound key (try-init, then one prompt without a CryptoObject); iOS
	 * accepts and ignores it (stays per-use). The only planned consumer is the vote-record alias
	 * (63-17's `VOTE_RECORD_AUTH_WINDOW_SECONDS`).
	 */
	authWindowSeconds?: number
}

export interface SecretWrapper {
	wrapSecret(keyAlias: string, plaintext: Uint8Array, options: SecretWrapOptions): Promise<WrappedSecret>
	unwrapSecret(wrapped: WrappedSecret, options: SecretWrapOptions): Promise<Uint8Array>
}

/**
 * Phase 63 review CR-02: a `SecretWrapper` that can also delete a vote-record wrap key, so a key a
 * biometric enrollment change invalidated can be replaced. `deleteWrapKey` refuses (INVALID_ARGUMENT,
 * before any native call) every alias outside `VOTE_RECORD_WRAP_KEY_ALIAS_PATTERN`. Resolves whether
 * a key existed. A separate interface so existing `SecretWrapper` implementations are unaffected.
 */
export interface ReplaceableSecretWrapper extends SecretWrapper {
	deleteWrapKey(keyAlias: string): Promise<boolean>
}

/** The closed set of native reject codes (NativeAttestation.ts's wrapSecret/unwrapSecret doc
 * comment), plus two JS-side codes for conditions the native layer never reports. */
export const SECRET_WRAP_ERROR_CODES = [
	'INVALID_ARGUMENT',
	'INVALID_ENCODING',
	'NO_WRAP_KEY',
	'WRAP_KEY_POLICY_MISMATCH',
	'UNWRAP_TAG_MISMATCH',
	'KEY_INVALIDATED',
	'DEVICE_LOCKED',
	'CANCELED',
	'NO_BIOMETRICS_ENROLLED',
	'LOCKOUT',
	'LOCKOUT_PERMANENT',
	'BIOMETRIC_ERROR',
	'NO_ACTIVITY',
	'WRAP_FAILED',
	'UNWRAP_FAILED',
	'NATIVE_UNAVAILABLE',
	'MALFORMED_NATIVE_RESULT',
] as const

export type SecretWrapErrorCode = (typeof SECRET_WRAP_ERROR_CODES)[number]

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set(SECRET_WRAP_ERROR_CODES)

export class SecretWrapError extends Error {
	readonly code: SecretWrapErrorCode

	constructor(code: SecretWrapErrorCode, message: string) {
		super(message)
		this.name = 'SecretWrapError'
		this.code = code
	}
}

/**
 * Lazily resolve the native TurboModule — see this file's header comment. NEVER call at module
 * scope. A throw here (module not registered, e.g. under jest with no fake installed) maps to
 * `SecretWrapError('NATIVE_UNAVAILABLE')`.
 */
function getNative(): NativeAttestationSpec {
	// eslint-disable-next-line @typescript-eslint/no-var-requires -- deliberate lazy require, mirrors real-attestation-producer.ts.
	return require('./specs/NativeAttestation').default as NativeAttestationSpec
}

/**
 * `TextEncoder`/`btoa`/`atob` ARE globals on Hermes/RN and Node — accessed via a `globalThis` cast
 * (not an ambient declaration) so this file type-checks identically under this package's own
 * `tsconfig.json` (includes `"node"`) and the app's `@react-native/typescript-config`-based program
 * (does not). Mirrors `real-attestation-producer.ts`'s `Base64GlobalEnv` pattern — NOT imported
 * from that file (it exports no such helpers, and this package must not depend on app-private
 * internals of its own sibling module in a way that would make `index.ts`'s re-export graph
 * eagerly evaluate the TurboModule-touching module).
 */
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

const MAX_PLAINTEXT_BYTES = 4096

function validateAlias(alias: string): void {
	if (!isValidWrapKeyAlias(alias)) {
		throw new SecretWrapError('INVALID_ARGUMENT', `invalid wrap key alias: ${alias}`)
	}
}

function validatePlaintextLength(length: number): void {
	if (length < 1 || length > MAX_PLAINTEXT_BYTES) {
		throw new SecretWrapError(
			'INVALID_ARGUMENT',
			`plaintext must be 1..${MAX_PLAINTEXT_BYTES} bytes, got ${length}`,
		)
	}
}

function validateOptions(options: SecretWrapOptions): void {
	if (options.requireAuth && options.prompt === undefined) {
		throw new SecretWrapError('INVALID_ARGUMENT', 'prompt is required when requireAuth is true')
	}
	const window = options.authWindowSeconds
	if (window !== undefined) {
		if (typeof window !== 'number' || !Number.isInteger(window) || window < 0 || window > MAX_AUTH_WINDOW_SECONDS) {
			throw new SecretWrapError('INVALID_ARGUMENT', 'authWindowSeconds must be an integer in 0..' + MAX_AUTH_WINDOW_SECONDS)
		}
		if (window > 0 && !options.requireAuth) {
			throw new SecretWrapError('INVALID_ARGUMENT', 'authWindowSeconds requires requireAuth')
		}
	}
}

function validateWrappedShape(wrapped: WrappedSecret): void {
	if (wrapped.v !== 1) {
		throw new SecretWrapError('INVALID_ARGUMENT', `unsupported WrappedSecret.v: ${String(wrapped.v)}`)
	}
	if (wrapped.alg !== 'AES-256-GCM') {
		throw new SecretWrapError('INVALID_ARGUMENT', `unsupported WrappedSecret.alg: ${String(wrapped.alg)}`)
	}
	validateAlias(wrapped.keyAlias)
}

function mapNativeError(err: unknown, fallback: SecretWrapErrorCode): SecretWrapError {
	const code = (err as { code?: unknown } | undefined)?.code
	if (typeof code === 'string' && KNOWN_ERROR_CODES.has(code)) {
		return new SecretWrapError(code as SecretWrapErrorCode, `native secret-wrap operation rejected: ${code}`)
	}
	return new SecretWrapError(fallback, 'native secret-wrap operation rejected with an unrecognized code')
}

/** Validate a native wrap result and return a `WrappedSecret`, or throw `MALFORMED_NATIVE_RESULT`. */
function parseWrapResult(raw: unknown, keyAlias: string, plaintextLength: number): WrappedSecret {
	const result = raw as {
		ciphertextBase64?: unknown
		ivBase64?: unknown
		keyAlias?: unknown
		securityLevel?: unknown
	}
	if (
		typeof result.ciphertextBase64 !== 'string' ||
		typeof result.ivBase64 !== 'string' ||
		typeof result.keyAlias !== 'string' ||
		typeof result.securityLevel !== 'string'
	) {
		throw new SecretWrapError('MALFORMED_NATIVE_RESULT', 'wrapSecret result is missing a required field')
	}
	if (result.keyAlias !== keyAlias) {
		throw new SecretWrapError('MALFORMED_NATIVE_RESULT', 'wrapSecret result keyAlias does not match the request')
	}
	if (!NATIVE_SECURITY_LEVELS.has(result.securityLevel)) {
		throw new SecretWrapError('MALFORMED_NATIVE_RESULT', `wrapSecret result has an unrecognized securityLevel: ${result.securityLevel}`)
	}

	let ivBytes: Uint8Array
	let ciphertextBytes: Uint8Array
	try {
		ivBytes = bytesFromBase64(result.ivBase64)
		ciphertextBytes = bytesFromBase64(result.ciphertextBase64)
	} catch {
		throw new SecretWrapError('MALFORMED_NATIVE_RESULT', 'wrapSecret result did not decode as base64')
	}
	if (ivBytes.length !== 12) {
		throw new SecretWrapError('MALFORMED_NATIVE_RESULT', `wrapSecret result iv must decode to 12 bytes, got ${ivBytes.length}`)
	}
	if (ciphertextBytes.length < plaintextLength + 16) {
		throw new SecretWrapError(
			'MALFORMED_NATIVE_RESULT',
			`wrapSecret result ciphertext is shorter than plaintext.length + 16 bytes (got ${ciphertextBytes.length}, expected >= ${plaintextLength + 16})`,
		)
	}

	return {
		v: 1,
		alg: 'AES-256-GCM',
		keyAlias: result.keyAlias,
		ivBase64: result.ivBase64,
		ciphertextBase64: result.ciphertextBase64,
		securityLevel: result.securityLevel as WrapKeySecurityLevel,
	}
}

function parseUnwrapResult(raw: unknown): Uint8Array {
	const result = raw as { plaintextBase64?: unknown }
	if (typeof result.plaintextBase64 !== 'string') {
		throw new SecretWrapError('MALFORMED_NATIVE_RESULT', 'unwrapSecret result is missing plaintextBase64')
	}
	try {
		return bytesFromBase64(result.plaintextBase64)
	} catch {
		throw new SecretWrapError('MALFORMED_NATIVE_RESULT', 'unwrapSecret result plaintextBase64 did not decode as base64')
	}
}

/** Create a `SecretWrapper` backed by the native `wrapSecret`/`unwrapSecret`/`deleteWrapKey`
 * TurboModule methods. */
export function createNativeSecretWrapper(): ReplaceableSecretWrapper {
	return {
		async deleteWrapKey(keyAlias: string): Promise<boolean> {
			if (!isDeletableWrapKeyAlias(keyAlias)) {
				throw new SecretWrapError('INVALID_ARGUMENT', `wrap key alias may not be deleted: ${keyAlias}`)
			}
			let native: NativeAttestationSpec
			try {
				native = getNative()
			} catch {
				throw new SecretWrapError('NATIVE_UNAVAILABLE', 'the AttestationNative TurboModule is not available')
			}
			if (typeof native.deleteWrapKey !== 'function') {
				// A binary built before this method existed.
				throw new SecretWrapError('NATIVE_UNAVAILABLE', 'deleteWrapKey is not available in this binary')
			}
			let raw: unknown
			try {
				raw = await native.deleteWrapKey(keyAlias)
			} catch (err) {
				throw mapNativeError(err, 'WRAP_FAILED')
			}
			const deleted = (raw as { deleted?: unknown } | null)?.deleted
			if (typeof deleted !== 'boolean') {
				throw new SecretWrapError('MALFORMED_NATIVE_RESULT', 'deleteWrapKey result is missing deleted')
			}
			return deleted
		},

		async wrapSecret(keyAlias: string, plaintext: Uint8Array, options: SecretWrapOptions): Promise<WrappedSecret> {
			validateAlias(keyAlias)
			validatePlaintextLength(plaintext.length)
			validateOptions(options)

			let native: NativeAttestationSpec
			try {
				native = getNative()
			} catch {
				throw new SecretWrapError('NATIVE_UNAVAILABLE', 'the AttestationNative TurboModule is not available')
			}

			const prompt = options.requireAuth ? options.prompt! : { title: '', subtitle: '', negativeButton: '' }
			let raw: unknown
			try {
				raw = await native.wrapSecret(
					keyAlias,
					base64FromBytes(plaintext),
					base64FromBytes(options.aad),
					options.requireAuth,
					prompt.title,
					prompt.subtitle,
					prompt.negativeButton,
					options.authWindowSeconds ?? 0,
				)
			} catch (err) {
				if (err instanceof SecretWrapError) throw err
				throw mapNativeError(err, 'WRAP_FAILED')
			}

			return parseWrapResult(raw, keyAlias, plaintext.length)
		},

		async unwrapSecret(wrapped: WrappedSecret, options: SecretWrapOptions): Promise<Uint8Array> {
			validateWrappedShape(wrapped)
			validateOptions(options)

			let native: NativeAttestationSpec
			try {
				native = getNative()
			} catch {
				throw new SecretWrapError('NATIVE_UNAVAILABLE', 'the AttestationNative TurboModule is not available')
			}

			const prompt = options.requireAuth ? options.prompt! : { title: '', subtitle: '', negativeButton: '' }
			let raw: unknown
			try {
				raw = await native.unwrapSecret(
					wrapped.keyAlias,
					wrapped.ciphertextBase64,
					wrapped.ivBase64,
					base64FromBytes(options.aad),
					options.requireAuth,
					prompt.title,
					prompt.subtitle,
					prompt.negativeButton,
					options.authWindowSeconds ?? 0,
				)
			} catch (err) {
				if (err instanceof SecretWrapError) throw err
				throw mapNativeError(err, 'UNWRAP_FAILED')
			}

			return parseUnwrapResult(raw)
		},
	}
}
