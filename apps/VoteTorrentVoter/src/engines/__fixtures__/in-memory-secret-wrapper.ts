/**
 * in-memory-secret-wrapper.ts - TEST ONLY - not a security boundary - Metro never bundles this
 * because no production module imports it (D-29 / D-13, Phase 63 plan 07).
 *
 * Lives under `__fixtures__`, not `__tests__`, because this app's jest `testMatch` (the RN preset)
 * only picks up `__tests__/**` and `*.test.ts(x)`: a file under `__fixtures__` is importable by
 * tests but never itself collected as a test file.
 *
 * A generic `SecretWrapper` with REAL AES-256-GCM from Node's builtin `crypto`, so tamper and AAD
 * assertions prove something. It models the real wrapper's 1..4,096 B plaintext cap, its per-alias
 * auth policy (fixed at key creation, requireAuth AND window) and its error codes, and it counts
 * prompts per call.
 *
 * The D-14 auth window is modelled ONLY when the test injects a clock (`nowMs`). Without a clock
 * every auth-required call counts a prompt, which is the two-prompt upper bound that the 63-07,
 * 63-11, 63-12 and 63-13 suites rely on. With a clock, a windowed alias skips the prompt while the
 * last authentication is younger than the window. Assumption A1 (the vote-signing prompt opens this
 * key's window) is modelled only through the explicit `noteExternalAuthentication()` hook, which is
 * an ASSUMPTION about the device. Real prompt counts come only from 63-18's device leg `prompts`.
 *
 * `crypto` is reached through a typed `require()` rather than an `import`, and `btoa`/`atob` come
 * through a `globalThis` cast: this app's tsconfig declares no `@types/node`, so a bare `Buffer`
 * reference would not compile under `yarn workspace votetorrent-voter typecheck`.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires -- deliberate lazy require, see header comment.
const nodeCrypto = require('crypto') as {
	randomBytes(size: number): Uint8Array
	createCipheriv(
		algorithm: string,
		key: Uint8Array,
		iv: Uint8Array,
	): {
		update(data: Uint8Array): Uint8Array
		final(): Uint8Array
		getAuthTag(): Uint8Array
		setAAD(aad: Uint8Array): void
	}
	createDecipheriv(
		algorithm: string,
		key: Uint8Array,
		iv: Uint8Array,
	): {
		update(data: Uint8Array): Uint8Array
		final(): Uint8Array
		setAuthTag(tag: Uint8Array): void
		setAAD(aad: Uint8Array): void
	}
}

import {
	isDeletableWrapKeyAlias,
	isValidWrapKeyAlias,
	MAX_AUTH_WINDOW_SECONDS,
	SecretWrapError,
	type SecretWrapErrorCode,
	type SecretWrapOptions,
	type SecretWrapper,
	type WrappedSecret,
} from '@votetorrent/attestation-native'

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

function concatBytes(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, p) => sum + p.length, 0)
	const out = new Uint8Array(total)
	let offset = 0
	for (const part of parts) {
		out.set(part, offset)
		offset += part.length
	}
	return out
}

const MAX_PLAINTEXT_BYTES = 4096

export type InMemorySecretWrapperCall = {
	op: 'wrap' | 'unwrap'
	keyAlias: string
	requireAuth: boolean
	promptTitle: string | null
}

export type InMemorySecretWrapper = SecretWrapper & {
	readonly promptCount: number
	readonly wrapCalls: number
	readonly unwrapCalls: number
	readonly calls: readonly InMemorySecretWrapperCall[]
	/** The SAME Uint8Array reference last passed to wrapSecret (so a test can prove it was zeroed). */
	readonly lastWrapPlaintext: Uint8Array | undefined
	/** The SAME Uint8Array reference last returned from unwrapSecret. */
	readonly lastUnwrapResult: Uint8Array | undefined
	failNextCall(op: 'wrap' | 'unwrap', code: SecretWrapErrorCode | 'plain-error'): void
	/**
	 * Models an authentication made elsewhere (the vote-signing prompt, assumption A1) opening the
	 * window of every windowed alias. Throws when no `nowMs` clock was injected.
	 */
	noteExternalAuthentication(): void
	/** The alias's fixed auth policy, or undefined when the alias has no key yet. */
	aliasPolicy(alias: string): { requireAuth: boolean; authWindowSeconds: number } | undefined
	/**
	 * CR-02: models a biometric enrollment change. Every later wrap/unwrap under [alias] rejects
	 * `KEY_INVALIDATED` with NO prompt (native fails at Cipher.init, before any prompt) until the alias
	 * is deleted. Throws when the alias has no key.
	 */
	invalidateAlias(alias: string): void
	/** Aliases passed to `deleteWrapKey`, in order (only present when `replaceable`). */
	readonly deleteCalls: readonly string[]
	/** Makes the next `deleteWrapKey` reject `WRAP_FAILED` without deleting. */
	failNextDelete(): void
}

/** The fixture plus the CR-02 `deleteWrapKey` capability (`replaceable: true`). */
export type ReplaceableInMemorySecretWrapper = InMemorySecretWrapper & {
	deleteWrapKey(keyAlias: string): Promise<boolean>
}

export function createInMemorySecretWrapperForTests(config: {
	nowMs?: () => number
	replaceable: true
}): ReplaceableInMemorySecretWrapper
export function createInMemorySecretWrapperForTests(config?: { nowMs?: () => number; replaceable?: false }): InMemorySecretWrapper
export function createInMemorySecretWrapperForTests(config?: {
	nowMs?: () => number
	replaceable?: boolean
}): InMemorySecretWrapper | ReplaceableInMemorySecretWrapper {
	const nowMs = config?.nowMs
	const keys = new Map<string, { key: Uint8Array; requireAuth: boolean; authWindowSeconds: number; invalidated?: boolean }>()
	const deleteCalls: string[] = []
	let failDelete = false

	/** CR-02 model: an invalidated alias fails before any prompt, as native does. */
	function rejectIfInvalidated(op: 'wrap' | 'unwrap', keyAlias: string, options: SecretWrapOptions): void {
		if (keys.get(keyAlias)?.invalidated !== true) return
		if (op === 'wrap') wrapCalls += 1
		else unwrapCalls += 1
		calls.push({ op, keyAlias, requireAuth: options.requireAuth, promptTitle: options.requireAuth ? options.prompt!.title : null })
		throw new SecretWrapError('KEY_INVALIDATED', 'in-memory-secret-wrapper: alias invalidated')
	}
	// ONE value for the whole fixture, not per alias: mirrors KeyMint's per-user auth token, which any
	// timeout key accepts (A1).
	let lastAuthAtMs: number | undefined
	const armed: { wrap?: SecretWrapErrorCode | 'plain-error'; unwrap?: SecretWrapErrorCode | 'plain-error' } = {}
	const calls: InMemorySecretWrapperCall[] = []
	let promptCount = 0
	let wrapCalls = 0
	let unwrapCalls = 0
	let lastWrapPlaintext: Uint8Array | undefined
	let lastUnwrapResult: Uint8Array | undefined

	function begin(op: 'wrap' | 'unwrap', keyAlias: string, options: SecretWrapOptions): void {
		if (!isValidWrapKeyAlias(keyAlias)) {
			throw new SecretWrapError('INVALID_ARGUMENT', `invalid wrap key alias: ${keyAlias}`)
		}
		if (options.requireAuth && options.prompt === undefined) {
			throw new SecretWrapError('INVALID_ARGUMENT', 'prompt is required when requireAuth is true')
		}
		const window = options.authWindowSeconds ?? 0
		if (options.authWindowSeconds !== undefined) {
			if (
				!Number.isInteger(options.authWindowSeconds) ||
				options.authWindowSeconds < 0 ||
				options.authWindowSeconds > MAX_AUTH_WINDOW_SECONDS
			) {
				throw new SecretWrapError('INVALID_ARGUMENT', 'authWindowSeconds must be an integer in 0..' + MAX_AUTH_WINDOW_SECONDS)
			}
			if (options.authWindowSeconds > 0 && !options.requireAuth) {
				throw new SecretWrapError('INVALID_ARGUMENT', 'authWindowSeconds requires requireAuth')
			}
		}
		if (op === 'wrap') wrapCalls += 1
		else unwrapCalls += 1
		calls.push({
			op,
			keyAlias,
			requireAuth: options.requireAuth,
			promptTitle: options.requireAuth ? options.prompt!.title : null,
		})
		// A prompt that is then cancelled still counts as shown. Per-use, or without a clock, every
		// auth-required call prompts; with a clock a windowed call inside the window does not.
		const prompted =
			options.requireAuth &&
			(window === 0 || nowMs === undefined || lastAuthAtMs === undefined || nowMs() - lastAuthAtMs >= window * 1000)
		if (prompted) promptCount += 1
		const code = armed[op]
		if (code !== undefined) {
			armed[op] = undefined
			if (code === 'plain-error') throw new Error('in-memory-secret-wrapper: injected plain error')
			throw new SecretWrapError(code, 'in-memory-secret-wrapper: injected ' + code)
		}
		// Only a prompted call that did not fail opens a window.
		if (prompted && nowMs !== undefined) lastAuthAtMs = nowMs()
	}

	const fixture: InMemorySecretWrapper = {
		get deleteCalls() {
			return deleteCalls
		},
		invalidateAlias(alias) {
			const entry = keys.get(alias)
			if (entry === undefined) throw new Error('in-memory-secret-wrapper: no key to invalidate under ' + alias)
			entry.invalidated = true
		},
		failNextDelete() {
			failDelete = true
		},
		get promptCount() {
			return promptCount
		},
		get wrapCalls() {
			return wrapCalls
		},
		get unwrapCalls() {
			return unwrapCalls
		},
		get calls() {
			return calls
		},
		get lastWrapPlaintext() {
			return lastWrapPlaintext
		},
		get lastUnwrapResult() {
			return lastUnwrapResult
		},
		failNextCall(op, code) {
			armed[op] = code
		},
		noteExternalAuthentication() {
			if (nowMs === undefined) {
				throw new Error('in-memory-secret-wrapper: noteExternalAuthentication needs a nowMs clock')
			}
			lastAuthAtMs = nowMs()
		},
		aliasPolicy(alias) {
			const entry = keys.get(alias)
			return entry === undefined ? undefined : { requireAuth: entry.requireAuth, authWindowSeconds: entry.authWindowSeconds }
		},

		async wrapSecret(keyAlias: string, plaintext: Uint8Array, options: SecretWrapOptions): Promise<WrappedSecret> {
			if (!isValidWrapKeyAlias(keyAlias)) {
				throw new SecretWrapError('INVALID_ARGUMENT', `invalid wrap key alias: ${keyAlias}`)
			}
			if (plaintext.length < 1 || plaintext.length > MAX_PLAINTEXT_BYTES) {
				throw new SecretWrapError(
					'INVALID_ARGUMENT',
					`plaintext must be 1..${MAX_PLAINTEXT_BYTES} bytes, got ${plaintext.length}`,
				)
			}
			rejectIfInvalidated('wrap', keyAlias, options)
			begin('wrap', keyAlias, options)
			lastWrapPlaintext = plaintext
			let entry = keys.get(keyAlias)
			if (!entry) {
				entry = {
					key: nodeCrypto.randomBytes(32),
					requireAuth: options.requireAuth,
					authWindowSeconds: options.authWindowSeconds ?? 0,
				}
				keys.set(keyAlias, entry)
			} else if (entry.requireAuth !== options.requireAuth || entry.authWindowSeconds !== (options.authWindowSeconds ?? 0)) {
				throw new SecretWrapError('WRAP_KEY_POLICY_MISMATCH', 'alias was created with a different auth policy')
			}
			const iv = nodeCrypto.randomBytes(12)
			const cipher = nodeCrypto.createCipheriv('aes-256-gcm', entry.key, iv)
			cipher.setAAD(options.aad)
			const ciphertext = concatBytes(cipher.update(plaintext), cipher.final())
			const combined = concatBytes(ciphertext, cipher.getAuthTag())
			return {
				v: 1,
				alg: 'AES-256-GCM',
				keyAlias,
				ivBase64: base64FromBytes(iv),
				ciphertextBase64: base64FromBytes(combined),
				securityLevel: 'test-stub',
			}
		},

		async unwrapSecret(wrapped: WrappedSecret, options: SecretWrapOptions): Promise<Uint8Array> {
			rejectIfInvalidated('unwrap', wrapped.keyAlias, options)
			begin('unwrap', wrapped.keyAlias, options)
			const entry = keys.get(wrapped.keyAlias)
			if (!entry) throw new SecretWrapError('NO_WRAP_KEY', 'no wrap key for alias')
			if (entry.requireAuth !== options.requireAuth || entry.authWindowSeconds !== (options.authWindowSeconds ?? 0)) {
				throw new SecretWrapError('WRAP_KEY_POLICY_MISMATCH', 'alias was created with a different auth policy')
			}
			const iv = bytesFromBase64(wrapped.ivBase64)
			const combined = bytesFromBase64(wrapped.ciphertextBase64)
			const ciphertext = combined.slice(0, combined.length - 16)
			const tag = combined.slice(combined.length - 16)
			const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', entry.key, iv)
			decipher.setAAD(options.aad)
			decipher.setAuthTag(tag)
			let out: Uint8Array
			try {
				out = concatBytes(decipher.update(ciphertext), decipher.final())
			} catch (err) {
				throw new SecretWrapError('UNWRAP_TAG_MISMATCH', (err as Error).message ?? 'GCM authentication failed')
			}
			lastUnwrapResult = out
			return out
		},
	}
	if (config?.replaceable !== true) return fixture
	return Object.assign(fixture, {
		async deleteWrapKey(keyAlias: string): Promise<boolean> {
			// Mirrors native: only the vote-record family may be deleted, checked before anything else.
			if (!isDeletableWrapKeyAlias(keyAlias)) {
				throw new SecretWrapError('INVALID_ARGUMENT', `wrap key alias may not be deleted: ${keyAlias}`)
			}
			deleteCalls.push(keyAlias)
			if (failDelete) {
				failDelete = false
				throw new SecretWrapError('WRAP_FAILED', 'in-memory-secret-wrapper: injected delete failure')
			}
			return keys.delete(keyAlias)
		},
	})
}
