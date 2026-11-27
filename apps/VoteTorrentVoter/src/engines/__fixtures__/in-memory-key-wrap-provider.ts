/**
 * in-memory-key-wrap-provider.ts — TEST ONLY — not a security boundary — Metro never bundles this
 * because no production module imports it (D-42, Phase 62 plan 08).
 *
 * Lives under `__fixtures__`, not `__tests__`, because this app's jest `testMatch` (the RN preset)
 * only picks up `__tests__/**` and `*.test.ts(x)` — a file under `__fixtures__` is importable by
 * tests but never itself collected as a test file.
 *
 * Implements `DeviceKeyWrapProvider` with REAL AES-256-GCM from Node's builtin `crypto` (not a
 * mock) so `device-user.migration.test.ts`'s round-trip/tamper assertions prove something: a
 * flipped ciphertext byte genuinely fails the GCM tag check, exactly like the native Keystore/
 * Keychain implementation would.
 *
 * `crypto` is reached through a typed `require()` (same lazy-require idiom as
 * `real-attestation-producer.test.ts`'s `require('react-native')`) RATHER than an `import`, and
 * its functions are typed to return plain `Uint8Array`/byte-array shapes rather than the ambient
 * `Buffer` global — this app's `tsconfig.json` (`@react-native/typescript-config`, `types:
 * ["react-native", "jest"]`) declares no `@types/node`, so a bare `Buffer` reference would not
 * compile under `yarn workspace votetorrent-voter typecheck`.
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

import type { DeviceKeyWrapProvider } from '../device-key-wrap'
import { VOTETORRENT_VOTER_IDENTITY_WRAP_KEY_V1, SecretWrapError, type WrappedSecret } from '@votetorrent/attestation-native'

/**
 * `TextEncoder`/`btoa`/`atob` are globals on both Hermes/RN and Node (same `globalThis` cast idiom
 * as `secret-wrap.ts`/`real-attestation-producer.ts` — avoids an ambient-global declaration that
 * would collide with `@types/node` wherever it IS present elsewhere in the monorepo).
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

export interface InMemoryKeyWrapProviderOptions {
	failWrap?: boolean
	failUnwrap?: boolean
	/** Flips one ciphertext byte so a later unwrap fails the GCM tag check. */
	corruptOnWrap?: boolean
}

export type InMemoryKeyWrapProvider = DeviceKeyWrapProvider & {
	readonly wrapCalls: number
	readonly unwrapCalls: number
}

/** A jest-only `DeviceKeyWrapProvider` backed by a random 32-byte AES key held in closure for the
 * lifetime of the returned instance (one key per provider instance, matching the native
 * get-or-create-ONE-key-per-alias contract). */
export function createInMemoryKeyWrapProviderForTests(options: InMemoryKeyWrapProviderOptions = {}): InMemoryKeyWrapProvider {
	const key = nodeCrypto.randomBytes(32)
	let wrapCalls = 0
	let unwrapCalls = 0

	return {
		get wrapCalls() {
			return wrapCalls
		},
		get unwrapCalls() {
			return unwrapCalls
		},

		async wrap(plaintext: Uint8Array, aad: Uint8Array): Promise<WrappedSecret> {
			wrapCalls += 1
			if (options.failWrap) {
				throw new Error('in-memory-key-wrap-provider: simulated wrap failure')
			}
			const iv = nodeCrypto.randomBytes(12)
			const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv)
			cipher.setAAD(aad)
			const ciphertext = concatBytes(cipher.update(plaintext), cipher.final())
			const tag = cipher.getAuthTag()
			const combined = concatBytes(ciphertext, tag)
			if (options.corruptOnWrap) {
				combined[0] = combined[0]! ^ 0xff
			}
			return {
				v: 1,
				alg: 'AES-256-GCM',
				keyAlias: VOTETORRENT_VOTER_IDENTITY_WRAP_KEY_V1,
				ivBase64: base64FromBytes(iv),
				ciphertextBase64: base64FromBytes(combined),
				securityLevel: 'test-stub',
			}
		},

		async unwrap(wrapped: WrappedSecret, aad: Uint8Array): Promise<Uint8Array> {
			unwrapCalls += 1
			if (options.failUnwrap) {
				throw new Error('in-memory-key-wrap-provider: simulated unwrap failure')
			}
			const iv = bytesFromBase64(wrapped.ivBase64)
			const combined = bytesFromBase64(wrapped.ciphertextBase64)
			const ciphertext = combined.slice(0, combined.length - 16)
			const tag = combined.slice(combined.length - 16)
			const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', key, iv)
			decipher.setAAD(aad)
			decipher.setAuthTag(tag)
			try {
				return concatBytes(decipher.update(ciphertext), decipher.final())
			} catch (err) {
				// Node's AES-GCM throws a generic Error ("Unsupported state or unable to
				// authenticate data") on a tag mismatch — re-surface it with the SAME typed code
				// `secret-wrap.ts` maps a native UNWRAP_TAG_MISMATCH rejection to, so a consumer
				// (`device-user.ts`'s `getDevicePrivKeyHex`) classifies it identically regardless
				// of whether the provider is this stub or the real native one.
				throw new SecretWrapError('UNWRAP_TAG_MISMATCH', (err as Error).message ?? 'GCM authentication failed')
			}
		},
	}
}
