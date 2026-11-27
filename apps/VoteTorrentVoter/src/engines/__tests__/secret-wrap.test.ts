/**
 * secret-wrap.test.ts — jest regression guard for `@votetorrent/attestation-native`'s
 * `createNativeSecretWrapper` (D-42, Phase 62 plan 08) plus the Voter's jest-only in-memory stub.
 *
 * The native TurboModule bridge is faked exactly as `real-attestation-producer.test.ts` fakes it —
 * a Proxy over `TurboModuleRegistry.getEnforcing` that substitutes a jest.fn-backed object for the
 * `'AttestationNative'` name only — so this suite exercises the REAL JS validation/mapping logic
 * in `secret-wrap.ts`, not a mock of the whole package.
 */

// `mockGetEnforcingState.shouldThrow` is read on EVERY `getEnforcing('AttestationNative')` call
// (not just at module-load time), so a single test can flip it to simulate "TurboModule not
// registered" without `jest.resetModules`/`jest.isolateModules` — Node/Jest's require() cache only
// evaluates `./specs/NativeAttestation` ONCE per test file, so toggling this flag works regardless
// of call order. Named with the `mock` prefix so Babel's jest-hoist plugin allows referencing it
// from inside the hoisted `jest.mock(...)` factory below (the ONE naming exception jest-hoist
// permits for out-of-scope references).
const mockGetEnforcingState = { shouldThrow: false }

jest.mock('react-native', () => {
	const actual: Record<string, unknown> = jest.requireActual('react-native')
	const attestationNativeFake = {
		wrapSecret: jest.fn(),
		unwrapSecret: jest.fn(),
	}
	const actualTurboModuleRegistry = actual.TurboModuleRegistry as { getEnforcing: (name: string) => unknown }
	const turboModuleRegistryProxy = new Proxy(actualTurboModuleRegistry, {
		get(target, prop, receiver) {
			if (prop === 'getEnforcing') {
				return (name: string) => {
					if (name !== 'AttestationNative') return target.getEnforcing(name)
					if (mockGetEnforcingState.shouldThrow) {
						throw new Error('AttestationNative TurboModule is not registered')
					}
					return attestationNativeFake
				}
			}
			return Reflect.get(target, prop, receiver)
		},
	})
	return new Proxy(actual, {
		get(target, prop, receiver) {
			if (prop === 'TurboModuleRegistry') return turboModuleRegistryProxy
			if (prop === '__attestationNativeFake') return attestationNativeFake
			return Reflect.get(target, prop, receiver)
		},
	})
})

import {
	createNativeSecretWrapper,
	MAX_AUTH_WINDOW_SECONDS,
	SecretWrapError,
	type WrappedSecret,
} from '@votetorrent/attestation-native'
import { createInMemoryKeyWrapProviderForTests } from '../__fixtures__/in-memory-key-wrap-provider'

// eslint-disable-next-line @typescript-eslint/no-var-requires -- reach the fake exposed by the react-native mock above.
const { __attestationNativeFake: nativeFake } = require('react-native') as {
	__attestationNativeFake: { wrapSecret: jest.Mock; unwrapSecret: jest.Mock }
}

const VALID_ALIAS = 'VOTETORRENT_VOTER_IDENTITY_WRAP_KEY_V1'

function base64FromBytes(bytes: Uint8Array): string {
	let binary = ''
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
	return btoa(binary)
}

function bytesFromBase64(value: string): Uint8Array {
	const binary = atob(value)
	const out = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
	return out
}

function fakeWrapResolution(plaintext: Uint8Array, overrides: Partial<Record<string, unknown>> = {}) {
	const ciphertext = new Uint8Array(plaintext.length + 16).fill(7)
	return {
		ciphertextBase64: base64FromBytes(ciphertext),
		ivBase64: base64FromBytes(new Uint8Array(12).fill(1)),
		keyAlias: VALID_ALIAS,
		securityLevel: 'tee',
		...overrides,
	}
}

function makeWrapped(overrides: Partial<WrappedSecret> = {}): WrappedSecret {
	return {
		v: 1,
		alg: 'AES-256-GCM',
		keyAlias: VALID_ALIAS,
		ivBase64: base64FromBytes(new Uint8Array(12).fill(1)),
		ciphertextBase64: base64FromBytes(new Uint8Array(16 + 5).fill(7)),
		securityLevel: 'tee',
		...overrides,
	}
}

describe('createNativeSecretWrapper — D-42 (Phase 62 plan 08)', () => {
	beforeEach(() => {
		nativeFake.wrapSecret.mockReset()
		nativeFake.unwrapSecret.mockReset()
		mockGetEnforcingState.shouldThrow = false
	})

	// MUST run before any other test in this describe block: `./specs/NativeAttestation`'s
	// `TurboModuleRegistry.getEnforcing('AttestationNative')` call happens once, at the FIRST
	// `require('./specs/NativeAttestation')` inside `getNative()`, and Node/Jest's require() cache
	// then returns that same resolved result on every later call within this test file — so
	// `mockGetEnforcingState.shouldThrow` can only be observed by whichever test reaches
	// `getNative()` first.
	it('if getEnforcing throws, the result is SecretWrapError NATIVE_UNAVAILABLE', async () => {
		mockGetEnforcingState.shouldThrow = true
		const wrapper = createNativeSecretWrapper()
		await expect(
			wrapper.wrapSecret(VALID_ALIAS, new Uint8Array([1]), { requireAuth: false, aad: new Uint8Array() }),
		).rejects.toMatchObject({ code: 'NATIVE_UNAVAILABLE' })
	})

	it('wrapSecret calls native once with (alias, std-base64(bytes), std-base64(aad), false, "", "", "") and returns a well-formed WrappedSecret', async () => {
		const plaintext = new Uint8Array([1, 2, 3, 4])
		const aad = new Uint8Array([9, 9])
		nativeFake.wrapSecret.mockResolvedValue(fakeWrapResolution(plaintext))

		const wrapper = createNativeSecretWrapper()
		const result = await wrapper.wrapSecret(VALID_ALIAS, plaintext, { requireAuth: false, aad })

		expect(nativeFake.wrapSecret).toHaveBeenCalledTimes(1)
		expect(nativeFake.wrapSecret).toHaveBeenCalledWith(
			VALID_ALIAS,
			base64FromBytes(plaintext),
			base64FromBytes(aad),
			false,
			'',
			'',
			'',
			0,
		)
		expect(result.v).toBe(1)
		expect(result.alg).toBe('AES-256-GCM')
		expect(result.keyAlias).toBe(VALID_ALIAS)
	})

	it('an alias failing WRAP_KEY_ALIAS_PATTERN rejects INVALID_ARGUMENT with 0 native calls', async () => {
		const wrapper = createNativeSecretWrapper()
		await expect(
			wrapper.wrapSecret('VOTETORRENT_DEVICE_KEY_V1', new Uint8Array([1]), { requireAuth: false, aad: new Uint8Array() }),
		).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
		await expect(
			wrapper.wrapSecret('VOTETORRENT_AUTHORITY_SIGNING_KEY_V1', new Uint8Array([1]), {
				requireAuth: false,
				aad: new Uint8Array(),
			}),
		).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
		expect(nativeFake.wrapSecret).not.toHaveBeenCalled()
	})

	it('requireAuth true without prompt rejects INVALID_ARGUMENT with 0 native calls', async () => {
		const wrapper = createNativeSecretWrapper()
		await expect(
			wrapper.wrapSecret(VALID_ALIAS, new Uint8Array([1]), { requireAuth: true, aad: new Uint8Array() }),
		).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
		expect(nativeFake.wrapSecret).not.toHaveBeenCalled()
	})

	it('requireAuth true with a prompt forwards title/subtitle/negativeButton verbatim', async () => {
		const plaintext = new Uint8Array([1, 2, 3])
		nativeFake.wrapSecret.mockResolvedValue(fakeWrapResolution(plaintext))
		const wrapper = createNativeSecretWrapper()
		await wrapper.wrapSecret(VALID_ALIAS, plaintext, {
			requireAuth: true,
			aad: new Uint8Array(),
			prompt: { title: 'Title', subtitle: 'Subtitle', negativeButton: 'Nope' },
		})
		expect(nativeFake.wrapSecret).toHaveBeenCalledWith(
			VALID_ALIAS,
			base64FromBytes(plaintext),
			base64FromBytes(new Uint8Array()),
			true,
			'Title',
			'Subtitle',
			'Nope',
			0,
		)
	})

	it('empty plaintext and a 4097-byte plaintext both reject INVALID_ARGUMENT', async () => {
		const wrapper = createNativeSecretWrapper()
		await expect(
			wrapper.wrapSecret(VALID_ALIAS, new Uint8Array(0), { requireAuth: false, aad: new Uint8Array() }),
		).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
		await expect(
			wrapper.wrapSecret(VALID_ALIAS, new Uint8Array(4097), { requireAuth: false, aad: new Uint8Array() }),
		).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
		expect(nativeFake.wrapSecret).not.toHaveBeenCalled()
	})

	it('a native rejection carrying code UNWRAP_TAG_MISMATCH surfaces verbatim; an unknown code surfaces as WRAP_FAILED/UNWRAP_FAILED', async () => {
		const wrapper = createNativeSecretWrapper()

		nativeFake.unwrapSecret.mockRejectedValue({ code: 'UNWRAP_TAG_MISMATCH' })
		await expect(wrapper.unwrapSecret(makeWrapped(), { requireAuth: false, aad: new Uint8Array() })).rejects.toMatchObject({
			code: 'UNWRAP_TAG_MISMATCH',
		})

		nativeFake.wrapSecret.mockRejectedValue({ code: 'SOME_UNKNOWN_NATIVE_CODE' })
		await expect(
			wrapper.wrapSecret(VALID_ALIAS, new Uint8Array([1]), { requireAuth: false, aad: new Uint8Array() }),
		).rejects.toMatchObject({ code: 'WRAP_FAILED' })

		nativeFake.unwrapSecret.mockRejectedValue({ code: 'SOME_UNKNOWN_NATIVE_CODE' })
		await expect(wrapper.unwrapSecret(makeWrapped(), { requireAuth: false, aad: new Uint8Array() })).rejects.toMatchObject({
			code: 'UNWRAP_FAILED',
		})
	})

	describe('native result validation (MALFORMED_NATIVE_RESULT)', () => {
		it('rejects when a field is missing', async () => {
			nativeFake.wrapSecret.mockResolvedValue({ ciphertextBase64: 'x', ivBase64: 'y', keyAlias: VALID_ALIAS })
			const wrapper = createNativeSecretWrapper()
			await expect(
				wrapper.wrapSecret(VALID_ALIAS, new Uint8Array([1]), { requireAuth: false, aad: new Uint8Array() }),
			).rejects.toMatchObject({ code: 'MALFORMED_NATIVE_RESULT' })
		})

		it('rejects when the iv does not decode to 12 bytes', async () => {
			const plaintext = new Uint8Array([1, 2, 3])
			nativeFake.wrapSecret.mockResolvedValue(
				fakeWrapResolution(plaintext, { ivBase64: base64FromBytes(new Uint8Array(11)) }),
			)
			const wrapper = createNativeSecretWrapper()
			await expect(
				wrapper.wrapSecret(VALID_ALIAS, plaintext, { requireAuth: false, aad: new Uint8Array() }),
			).rejects.toMatchObject({ code: 'MALFORMED_NATIVE_RESULT' })
		})

		it('rejects when the ciphertext decodes to fewer than plaintext.length + 16 bytes', async () => {
			const plaintext = new Uint8Array([1, 2, 3])
			nativeFake.wrapSecret.mockResolvedValue(
				fakeWrapResolution(plaintext, { ciphertextBase64: base64FromBytes(new Uint8Array(plaintext.length + 15)) }),
			)
			const wrapper = createNativeSecretWrapper()
			await expect(
				wrapper.wrapSecret(VALID_ALIAS, plaintext, { requireAuth: false, aad: new Uint8Array() }),
			).rejects.toMatchObject({ code: 'MALFORMED_NATIVE_RESULT' })
		})

		it('rejects when keyAlias differs from the requested alias', async () => {
			const plaintext = new Uint8Array([1, 2, 3])
			nativeFake.wrapSecret.mockResolvedValue(
				fakeWrapResolution(plaintext, { keyAlias: 'VOTETORRENT_SOMETHING_ELSE_WRAP_KEY_V1' }),
			)
			const wrapper = createNativeSecretWrapper()
			await expect(
				wrapper.wrapSecret(VALID_ALIAS, plaintext, { requireAuth: false, aad: new Uint8Array() }),
			).rejects.toMatchObject({ code: 'MALFORMED_NATIVE_RESULT' })
		})

		it('rejects when securityLevel is outside the native set, including "test-stub"', async () => {
			const plaintext = new Uint8Array([1, 2, 3])
			const wrapper = createNativeSecretWrapper()

			nativeFake.wrapSecret.mockResolvedValue(fakeWrapResolution(plaintext, { securityLevel: 'test-stub' }))
			await expect(
				wrapper.wrapSecret(VALID_ALIAS, plaintext, { requireAuth: false, aad: new Uint8Array() }),
			).rejects.toMatchObject({ code: 'MALFORMED_NATIVE_RESULT' })

			nativeFake.wrapSecret.mockResolvedValue(fakeWrapResolution(plaintext, { securityLevel: 'bogus' }))
			await expect(
				wrapper.wrapSecret(VALID_ALIAS, plaintext, { requireAuth: false, aad: new Uint8Array() }),
			).rejects.toMatchObject({ code: 'MALFORMED_NATIVE_RESULT' })
		})
	})

	it('unwrapSecret returns a Uint8Array equal to the decoded plaintextBase64', async () => {
		const plaintext = new Uint8Array([5, 6, 7, 8])
		nativeFake.unwrapSecret.mockResolvedValue({ plaintextBase64: base64FromBytes(plaintext) })
		const wrapper = createNativeSecretWrapper()
		const result = await wrapper.unwrapSecret(makeWrapped(), { requireAuth: false, aad: new Uint8Array() })
		expect(result).toEqual(plaintext)
	})

	it('SecretWrapError carries the typed code', () => {
		const err = new SecretWrapError('WRAP_FAILED', 'boom')
		expect(err).toBeInstanceOf(Error)
		expect(err.code).toBe('WRAP_FAILED')
	})
})

describe('authWindowSeconds pass-through (D-14, Phase 63 plan 16)', () => {
	const aad = new Uint8Array([1])
	const prompt = { title: 'T', subtitle: 'S', negativeButton: 'N' }

	beforeEach(() => {
		nativeFake.wrapSecret.mockReset()
		nativeFake.unwrapSecret.mockReset()
		mockGetEnforcingState.shouldThrow = false
		nativeFake.wrapSecret.mockResolvedValue(fakeWrapResolution(new Uint8Array([1, 2])))
		nativeFake.unwrapSecret.mockResolvedValue({ plaintextBase64: base64FromBytes(new Uint8Array([1])) })
	})

	it('MAX_AUTH_WINDOW_SECONDS is 60', () => {
		expect(MAX_AUTH_WINDOW_SECONDS).toBe(60)
	})

	it('absent authWindowSeconds sends a trailing 0: wrapSecret has 8 args, unwrapSecret has 9', async () => {
		const wrapper = createNativeSecretWrapper()
		await wrapper.wrapSecret(VALID_ALIAS, new Uint8Array([1, 2]), { requireAuth: false, aad })
		await wrapper.unwrapSecret(makeWrapped(), { requireAuth: false, aad })
		expect(nativeFake.wrapSecret.mock.calls[0]).toHaveLength(8)
		expect(nativeFake.wrapSecret.mock.calls[0][7]).toBe(0)
		expect(nativeFake.unwrapSecret.mock.calls[0]).toHaveLength(9)
		expect(nativeFake.unwrapSecret.mock.calls[0][8]).toBe(0)
	})

	it.each([0, 10, MAX_AUTH_WINDOW_SECONDS])('requireAuth true with authWindowSeconds %i passes it through as the last argument', async (window) => {
		const wrapper = createNativeSecretWrapper()
		await wrapper.wrapSecret(VALID_ALIAS, new Uint8Array([1, 2]), { requireAuth: true, aad, prompt, authWindowSeconds: window })
		await wrapper.unwrapSecret(makeWrapped(), { requireAuth: true, aad, prompt, authWindowSeconds: window })
		expect(nativeFake.wrapSecret.mock.calls[0]).toHaveLength(8)
		expect(nativeFake.wrapSecret.mock.calls[0][7]).toBe(window)
		expect(nativeFake.unwrapSecret.mock.calls[0]).toHaveLength(9)
		expect(nativeFake.unwrapSecret.mock.calls[0][8]).toBe(window)
	})

	const bad: Array<[string, unknown, boolean]> = [
		['-1', -1, true],
		['1.5', 1.5, true],
		['NaN', NaN, true],
		['Infinity', Infinity, true],
		['61', 61, true],
		["'10' (string)", '10', true],
		['5 without requireAuth', 5, false],
	]

	it.each(bad)('wrapSecret rejects authWindowSeconds %s INVALID_ARGUMENT with 0 native calls', async (_label, value, requireAuth) => {
		const wrapper = createNativeSecretWrapper()
		await expect(
			wrapper.wrapSecret(VALID_ALIAS, new Uint8Array([1, 2]), {
				requireAuth,
				aad,
				prompt: requireAuth ? prompt : undefined,
				authWindowSeconds: value as number,
			}),
		).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
		expect(nativeFake.wrapSecret).not.toHaveBeenCalled()
	})

	it.each(bad)('unwrapSecret rejects authWindowSeconds %s INVALID_ARGUMENT with 0 native calls', async (_label, value, requireAuth) => {
		const wrapper = createNativeSecretWrapper()
		await expect(
			wrapper.unwrapSecret(makeWrapped(), {
				requireAuth,
				aad,
				prompt: requireAuth ? prompt : undefined,
				authWindowSeconds: value as number,
			}),
		).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
		expect(nativeFake.unwrapSecret).not.toHaveBeenCalled()
	})
})

describe('createInMemoryKeyWrapProviderForTests — jest-only stub', () => {
	it('round-trips: unwrap(wrap(p, aad), aad) equals p, with securityLevel test-stub', async () => {
		const provider = createInMemoryKeyWrapProviderForTests()
		const plaintext = new Uint8Array([10, 20, 30, 40, 50])
		const aad = new Uint8Array([1, 2, 3])
		const wrapped = await provider.wrap(plaintext, aad)
		expect(wrapped.securityLevel).toBe('test-stub')
		const unwrapped = await provider.unwrap(wrapped, aad)
		expect(unwrapped).toEqual(plaintext)
		expect(provider.wrapCalls).toBe(1)
		expect(provider.unwrapCalls).toBe(1)
	})

	it('unwrapping with different aad rejects', async () => {
		const provider = createInMemoryKeyWrapProviderForTests()
		const plaintext = new Uint8Array([1, 2, 3])
		const wrapped = await provider.wrap(plaintext, new Uint8Array([9]))
		await expect(provider.unwrap(wrapped, new Uint8Array([8]))).rejects.toBeDefined()
	})

	it('corruptOnWrap makes unwrap reject', async () => {
		const provider = createInMemoryKeyWrapProviderForTests({ corruptOnWrap: true })
		const plaintext = new Uint8Array([1, 2, 3])
		const aad = new Uint8Array([9])
		const wrapped = await provider.wrap(plaintext, aad)
		await expect(provider.unwrap(wrapped, aad)).rejects.toBeDefined()
	})

	it('failWrap makes wrap reject', async () => {
		const provider = createInMemoryKeyWrapProviderForTests({ failWrap: true })
		await expect(provider.wrap(new Uint8Array([1]), new Uint8Array())).rejects.toThrow()
	})

	it('failUnwrap makes unwrap reject', async () => {
		const provider = createInMemoryKeyWrapProviderForTests({ failUnwrap: true })
		const okProvider = createInMemoryKeyWrapProviderForTests()
		const wrapped = await okProvider.wrap(new Uint8Array([1, 2]), new Uint8Array())
		await expect(provider.unwrap(wrapped, new Uint8Array())).rejects.toThrow()
	})
})
