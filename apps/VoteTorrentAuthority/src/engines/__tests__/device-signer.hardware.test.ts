/**
 * device-signer.hardware.test.ts — 49-07 jest regression guard for the hardware-backed
 * `createDeviceSigner` rewrite (D-01/D-09/D-13).
 *
 * Jest CANNOT exercise the real Android Keystore, the real `BiometricPrompt`, or the
 * byte-level agreement between Kotlin's `derToCompactLowS` and `@noble/curves`'s `p256.verify()`
 * — those are D-24 leg 1 and leg 2, proven only on real hardware in 49-13/49-14. This suite
 * proves only what jest CAN reach: the JS-side plumbing around a mocked native module.
 *
 * The native TurboModule bridge is faked the same way
 * `packages/attestation-native/src/real-attestation-producer.ts`'s own jest suite fakes it:
 * react-native's `TurboModuleRegistry.getEnforcing` is overridden for the `'AttestationNative'`
 * name only, via a Proxy, so the REAL `device-signer.ts` module (including its module-load
 * guard) is exercised, not a stand-in.
 */

// NOTE: do NOT `{ ...jest.requireActual('react-native') }` here — see
// real-attestation-producer.test.ts's identical comment: react-native's index.js exports most
// modules as lazy getters, and spreading forces every one to evaluate eagerly, including
// native-bridge accessors nothing in this suite touches. A Proxy defers property access to
// exactly what the code under test reads (only `TurboModuleRegistry`).
jest.mock('react-native', () => {
	const actual: Record<string, unknown> = jest.requireActual('react-native')
	const attestationNativeFake = {
		signWithDeviceKey: jest.fn(),
	}
	const actualTurboModuleRegistry = actual.TurboModuleRegistry as { getEnforcing: (name: string) => unknown }
	const turboModuleRegistryProxy = new Proxy(actualTurboModuleRegistry, {
		get(target, prop, receiver) {
			if (prop === 'getEnforcing') {
				return (name: string) => (name === 'AttestationNative' ? attestationNativeFake : target.getEnforcing(name))
			}
			return Reflect.get(target, prop, receiver)
		},
	})
	// Platform.OS is set per test via __setPlatformOS (never inherited from the jest preset's 'ios').
	let platformOS = 'ios'
	const actualPlatform = actual.Platform as Record<string, unknown>
	const platformProxy = new Proxy(actualPlatform, {
		get(target, prop, receiver) {
			if (prop === 'OS') return platformOS
			return Reflect.get(target, prop, receiver)
		},
	})
	return new Proxy(actual, {
		get(target, prop, receiver) {
			if (prop === 'TurboModuleRegistry') return turboModuleRegistryProxy
			if (prop === 'Platform') return platformProxy
			if (prop === '__setPlatformOS') return (os: string) => { platformOS = os }
			if (prop === '__attestationNativeFake') return attestationNativeFake
			return Reflect.get(target, prop, receiver)
		},
	})
})

jest.mock('../device-user', () => ({
	getDeviceUser: jest.fn(),
	// 49-14 follow-up: defaults to "no recovery in progress" so this suite's pre-existing
	// happy-path/rejection assertions are unaffected; the dedicated coverage for the marker
	// itself overrides this per-test.
	isRecoveryInProgress: jest.fn().mockResolvedValue(false),
}))

import type { User } from '@votetorrent/vote-core'
import { UserKeyType } from '@votetorrent/vote-core'
import { p256 } from '@noble/curves/nist.js'
import { createDeviceSigner } from '../device-signer'
import { makeFakeNativeP256Signer, type NativeSignPlatform } from '../__fixtures__/fake-native-p256-signer'
import { getDeviceUser, isRecoveryInProgress } from '../device-user'
import { createHash } from 'crypto'

// eslint-disable-next-line @typescript-eslint/no-var-requires -- reach the fake exposed by the react-native mock above.
const { __attestationNativeFake: nativeFake, __setPlatformOS: setPlatformOS } = require('react-native') as {
	__attestationNativeFake: { signWithDeviceKey: jest.Mock }
	__setPlatformOS: (os: string) => void
}

const mockGetDeviceUser = getDeviceUser as jest.MockedFunction<typeof getDeviceUser>
const mockIsRecoveryInProgress = isRecoveryInProgress as jest.MockedFunction<typeof isRecoveryInProgress>

// The signer self-verifies every native signature against the recorded key, so this suite needs a
// real P-256 key pair and a real signature (a fake hex string is correctly refused as a desync).
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
const SIGNING_PRIV = p256.utils.randomSecretKey()
// Installs the platform-faithful native model and returns the list of signature hex strings native
// actually handed back, in call order (WR-R6-01: the signer's output is compared with what native
// produced, never with itself).
const installNative = (platform: NativeSignPlatform): string[] => {
	setPlatformOS(platform)
	const model = makeFakeNativeP256Signer(SIGNING_PRIV, platform)
	const produced: string[] = []
	nativeFake.signWithDeviceKey.mockImplementation(async (alias: string, digestBase64: string, ...prompts: string[]) => {
		const result = await model.signWithDeviceKey(alias, digestBase64, ...prompts)
		produced.push(result.signatureHex)
		return result
	})
	return produced
}

const PROVISIONED_USER: User = {
	id: 'user-1',
	name: 'Officer One',
	activeKeys: [{ key: hex(p256.getPublicKey(SIGNING_PRIV, true)), type: UserKeyType.p256, expiration: Date.now() + 1000 }],
}

describe.each<NativeSignPlatform>(['ios', 'android'])('device-signer.ts — hardware rewrite (49-07) on %s', platform => {
	beforeEach(() => {
		setPlatformOS(platform)
		nativeFake.signWithDeviceKey.mockReset()
		mockGetDeviceUser.mockReset()
		mockIsRecoveryInProgress.mockReset()
		mockIsRecoveryInProgress.mockResolvedValue(false)
	})

	it('(a) base64-encodes the digest and passes the alias + three prompt strings through unchanged', async () => {
		mockGetDeviceUser.mockResolvedValue(PROVISIONED_USER)
		const digest = new Uint8Array([1, 2, 3, 4])
		const produced = installNative(platform)

		const sign = await createDeviceSigner('Officer One')
		const signature = await sign(digest)
		expect(produced).toHaveLength(1)
		expect(produced[0]).not.toBe('')

		expect(nativeFake.signWithDeviceKey).toHaveBeenCalledTimes(1)
		const [alias, digestBase64, title, subtitle, negativeButton] = nativeFake.signWithDeviceKey.mock.calls[0] as [
			string,
			string,
			string,
			string,
			string,
		]
		expect(alias).toBe('VOTETORRENT_AUTHORITY_SIGNING_KEY_V1')
		// Plain (standard-alphabet) base64 — never base64url. iOS native signs its input as the final
		// hash, so it gets sha256(digest); Android's SHA256withECDSA hashes itself, so it gets the digest.
		const expected = platform === 'ios' ? createHash('sha256').update(digest).digest() : Buffer.from(digest)
		expect(digestBase64).toBe(expected.toString('base64'))
		expect(typeof title).toBe('string')
		expect(typeof subtitle).toBe('string')
		expect(typeof negativeButton).toBe('string')

		expect(signature).toEqual({
			signerUserId: PROVISIONED_USER.id,
			signerKey: PROVISIONED_USER.activeKeys[0]!.key,
			// Returned hex is passed through verbatim — never re-normalized.
			signature: produced[0],
		})
	})

	it('(b) propagates a native CANCELED rejection with its code intact, never converted to a generic error', async () => {
		mockGetDeviceUser.mockResolvedValue(PROVISIONED_USER)
		const rejection = Object.assign(new Error('user canceled the biometric prompt'), { code: 'CANCELED' })
		nativeFake.signWithDeviceKey.mockRejectedValue(rejection)

		const sign = await createDeviceSigner('Officer One')
		await expect(sign(new Uint8Array([9, 9, 9]))).rejects.toMatchObject({ code: 'CANCELED' })
	})

	it('(c) rejects NO_KEY_PROVISIONED before any native call when no device user is provisioned', async () => {
		mockGetDeviceUser.mockResolvedValue(undefined)

		await expect(createDeviceSigner('Officer One')).rejects.toMatchObject({ code: 'NO_KEY_PROVISIONED' })
		expect(nativeFake.signWithDeviceKey).not.toHaveBeenCalled()
	})

	// 49-14 follow-up (interrupted-handleRecovery Keystore/metadata desync — the PREVENTION half
	// of the fix): device-signer.ts must fail closed, before any native call, while
	// handleRecovery's in-progress marker is set.
	describe('(d) 49-14 follow-up — isRecoveryInProgress fail-closed check', () => {
		it('rejects KEY_INVALIDATED_REASSOCIATE before any native call when a recovery is in progress', async () => {
			mockGetDeviceUser.mockResolvedValue(PROVISIONED_USER)
			mockIsRecoveryInProgress.mockResolvedValue(true)

			await expect(createDeviceSigner('Officer One')).rejects.toMatchObject({
				code: 'KEY_INVALIDATED_REASSOCIATE',
			})
			expect(nativeFake.signWithDeviceKey).not.toHaveBeenCalled()
		})

		it('signs normally when no recovery is in progress (explicit false, not just the default)', async () => {
			mockGetDeviceUser.mockResolvedValue(PROVISIONED_USER)
			mockIsRecoveryInProgress.mockResolvedValue(false)
			const digest = new Uint8Array([1, 2, 3])
			const produced = installNative(platform)

			const sign = await createDeviceSigner('Officer One')
			const signature = await sign(digest)
			expect(nativeFake.signWithDeviceKey).toHaveBeenCalledTimes(1)
			expect(produced).toHaveLength(1)
			expect(signature).toEqual({
				signerUserId: PROVISIONED_USER.id,
				signerKey: PROVISIONED_USER.activeKeys[0]!.key,
				signature: produced[0],
			})
		})

		it('checks the marker AFTER the NO_KEY_PROVISIONED gate (an unprovisioned device is never routed to recovery)', async () => {
			mockGetDeviceUser.mockResolvedValue(undefined)
			mockIsRecoveryInProgress.mockResolvedValue(true)

			await expect(createDeviceSigner('Officer One')).rejects.toMatchObject({ code: 'NO_KEY_PROVISIONED' })
			expect(nativeFake.signWithDeviceKey).not.toHaveBeenCalled()
		})
	})
})
