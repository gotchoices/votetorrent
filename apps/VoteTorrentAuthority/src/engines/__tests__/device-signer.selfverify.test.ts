/**
 * device-signer.selfverify.test.ts: createDeviceSigner verifies every native signature against the
 * recorded signerKey with the schema's own verifier (verifySigP256). A mismatch is the Keystore/
 * metadata desync and throws KEY_INVALIDATED_REASSOCIATE before any engine write sees the signature.
 */

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
import { makeFakeNativeP256Signer, nativeSignHex, type NativeSignPlatform } from '../__fixtures__/fake-native-p256-signer'
import { verifySigP256 } from '@votetorrent/vote-engine/rn'
import { getDeviceUser, isRecoveryInProgress } from '../device-user'

// eslint-disable-next-line @typescript-eslint/no-var-requires -- reach the fake exposed by the react-native mock above.
const { __attestationNativeFake: nativeFake, __setPlatformOS: setPlatformOS } = require('react-native') as {
	__attestationNativeFake: { signWithDeviceKey: jest.Mock }
	__setPlatformOS: (os: string) => void
}

const mockGetDeviceUser = getDeviceUser as jest.MockedFunction<typeof getDeviceUser>

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
const keyA = (() => { const priv = p256.utils.randomSecretKey(); return { priv, pub: hex(p256.getPublicKey(priv, true)) } })()
const keyB = (() => { const priv = p256.utils.randomSecretKey(); return { priv, pub: hex(p256.getPublicKey(priv, true)) } })()
const DIGEST = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff)

const userWith = (key: string, type: UserKeyType = UserKeyType.p256): User => ({
	id: 'user-1',
	name: 'Officer One',
	activeKeys: [{ key, type, expiration: Date.now() + 1000 }],
})

// Every case runs on BOTH platforms with a native model faithful to that platform (iOS signs its input
// as the final ECDSA hash, Android hashes once itself), so a raw-digest iOS signature is caught here.
describe.each<NativeSignPlatform>(['ios', 'android'])('device-signer self-verify (UAT 62 gap 2) on %s', platform => {
	beforeEach(() => {
		setPlatformOS(platform)
		nativeFake.signWithDeviceKey.mockReset()
		mockGetDeviceUser.mockReset()
		;(isRecoveryInProgress as jest.Mock).mockResolvedValue(false)
	})

	it('V1: a signature made by the recorded key passes through unchanged', async () => {
		mockGetDeviceUser.mockResolvedValue(userWith(keyA.pub))
		const model = makeFakeNativeP256Signer(keyA.priv, platform)
		let produced = ''
		nativeFake.signWithDeviceKey.mockImplementation(async (...args: [string, string]) => {
			const r = await model.signWithDeviceKey(...args)
			produced = r.signatureHex
			return r
		})
		const signer = await createDeviceSigner('x')
		const out = await signer(DIGEST)
		expect(produced).not.toBe('')
		expect(out).toEqual({ signerUserId: 'user-1', signerKey: keyA.pub, signature: produced })
	})

	it('V2: a signature made by a different key rejects with KEY_INVALIDATED_REASSOCIATE and returns no signature', async () => {
		mockGetDeviceUser.mockResolvedValue(userWith(keyA.pub))
		nativeFake.signWithDeviceKey.mockImplementation(makeFakeNativeP256Signer(keyB.priv, platform).signWithDeviceKey)
		const signer = await createDeviceSigner('x')
		await expect(signer(DIGEST)).rejects.toMatchObject({ code: 'KEY_INVALIDATED_REASSOCIATE' })
	})

	it('V3: a recorded key that is not p256 rejects with KEY_INVALIDATED_REASSOCIATE without a native call', async () => {
		mockGetDeviceUser.mockResolvedValue(userWith(keyA.pub, UserKeyType.mobile))
		const signer = await createDeviceSigner('x').catch(e => e)
		if (typeof signer === 'function') {
			await expect(signer(DIGEST)).rejects.toMatchObject({ code: 'KEY_INVALIDATED_REASSOCIATE' })
		} else {
			expect(signer).toMatchObject({ code: 'KEY_INVALIDATED_REASSOCIATE' })
		}
		expect(nativeFake.signWithDeviceKey).not.toHaveBeenCalled()
	})

	it('V4: a native rejection reaches the caller unwrapped', async () => {
		mockGetDeviceUser.mockResolvedValue(userWith(keyA.pub))
		nativeFake.signWithDeviceKey.mockRejectedValue(Object.assign(new Error('cancelled'), { code: 'BIOMETRIC_CANCELLED' }))
		const signer = await createDeviceSigner('x')
		await expect(signer(DIGEST)).rejects.toMatchObject({ code: 'BIOMETRIC_CANCELLED' })
	})
})

describe('V5: negative control for the platform-faithful fake', () => {
	it('the iOS model fed the RAW digest produces a signature the schema verifier rejects; fed sha256(digest) it accepts', async () => {
		const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url')
		const rawSig = nativeSignHex(keyA.priv, 'ios', DIGEST)
		expect(verifySigP256(b64url(DIGEST), rawSig, keyA.pub)).toBe(false)
		// and the android model fed the raw digest is the schema-valid one
		expect(verifySigP256(b64url(DIGEST), nativeSignHex(keyA.priv, 'android', DIGEST), keyA.pub)).toBe(true)
	})
})
