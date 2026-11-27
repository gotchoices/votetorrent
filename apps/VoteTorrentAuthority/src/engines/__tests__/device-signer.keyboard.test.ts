/**
 * device-signer.keyboard.test.ts — on-device finding (Redmi 8, MIUI 12.5, Android 10): a
 * BiometricPrompt started while the soft keyboard is open is never drawn and times out ~10 min
 * later (errorCode 5 CANCELED). Every officer signature goes through `createDeviceSigner`'s
 * closure and every auth-required vault secret through `key-vault`, so both must close the IME
 * (and wait for it) before the native prompt call. React Native mock scaffold copied from
 * device-signer.selfverify.test.ts.
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
import { Keyboard } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { SecretWrapper } from '@votetorrent/attestation-native'
import { createDeviceSigner } from '../device-signer'
import { makeFakeNativeP256Signer, type NativeSignPlatform } from '../__fixtures__/fake-native-p256-signer'
import { createAuthorityKeyVault } from '../key-vault'
import { createFakeSecretWrapper } from '../__fixtures__/fake-secret-wrapper'
import { getDeviceUser } from '../device-user'
import { dismissKeyboardForSystemPrompt, KEYBOARD_HIDE_WAIT_MS } from '../../utils/dismissKeyboardForSystemPrompt'

// eslint-disable-next-line @typescript-eslint/no-var-requires -- reach the fake exposed by the react-native mock above.
const { __attestationNativeFake: nativeFake, __setPlatformOS: setPlatformOS } = require('react-native') as {
	__attestationNativeFake: { signWithDeviceKey: jest.Mock }
	__setPlatformOS: (os: string) => void
}

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
const priv = p256.utils.randomSecretKey()
const pub = hex(p256.getPublicKey(priv, true))
const DIGEST = Uint8Array.from({ length: 32 }, (_, i) => (i * 5 + 1) & 0xff)
const user: User = { id: 'user-1', name: 'Officer One', activeKeys: [{ key: pub, type: UserKeyType.p256, expiration: Date.now() + 1000 }] }

let hideListeners: Array<() => void>
let dismissSpy: jest.SpyInstance
let isVisibleSpy: jest.SpyInstance

beforeEach(() => {
	nativeFake.signWithDeviceKey.mockReset()
	;(getDeviceUser as jest.Mock).mockResolvedValue(user)
	hideListeners = []
	dismissSpy = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {})
	isVisibleSpy = jest.spyOn(Keyboard, 'isVisible').mockReturnValue(false)
	jest.spyOn(Keyboard, 'addListener').mockImplementation(((event: string, cb: () => void) => {
		if (event === 'keyboardDidHide') hideListeners.push(cb)
		return { remove: jest.fn() }
	}) as never)
})

afterEach(() => {
	jest.restoreAllMocks()
	jest.useRealTimers()
})

describe('dismissKeyboardForSystemPrompt', () => {
	it('keyboard closed: dismisses and resolves at once, without waiting for an event', async () => {
		await dismissKeyboardForSystemPrompt()
		expect(dismissSpy).toHaveBeenCalledTimes(1)
		expect(hideListeners).toHaveLength(0)
	})

	it('keyboard open: resolves only after keyboardDidHide', async () => {
		isVisibleSpy.mockReturnValue(true)
		let resolved = false
		const p = dismissKeyboardForSystemPrompt().then(() => {
			resolved = true
		})
		await Promise.resolve()
		expect(dismissSpy).toHaveBeenCalledTimes(1)
		expect(resolved).toBe(false)
		hideListeners.forEach(cb => cb())
		await p
		expect(resolved).toBe(true)
	})

	it('keyboard open but no keyboardDidHide ever arrives: resolves after the bounded wait, never hangs', async () => {
		jest.useFakeTimers()
		isVisibleSpy.mockReturnValue(true)
		let resolved = false
		const p = dismissKeyboardForSystemPrompt().then(() => {
			resolved = true
		})
		jest.advanceTimersByTime(KEYBOARD_HIDE_WAIT_MS - 1)
		await Promise.resolve()
		expect(resolved).toBe(false)
		jest.advanceTimersByTime(1)
		await p
		expect(resolved).toBe(true)
	})
})

describe.each<NativeSignPlatform>(['ios', 'android'])('device-signer: the keyboard is dismissed before the native BiometricPrompt starts on %s', platform => {
	beforeEach(() => {
		setPlatformOS(platform)
		nativeFake.signWithDeviceKey.mockImplementation(makeFakeNativeP256Signer(priv, platform).signWithDeviceKey)
	})

	it('Keyboard.dismiss is called before signWithDeviceKey', async () => {
		const signer = await createDeviceSigner('x')
		expect(dismissSpy).not.toHaveBeenCalled() // creating the signer prompts nothing
		await signer(DIGEST)
		expect(dismissSpy).toHaveBeenCalled()
		expect(nativeFake.signWithDeviceKey).toHaveBeenCalledTimes(1)
		expect(dismissSpy.mock.invocationCallOrder[0]).toBeLessThan(nativeFake.signWithDeviceKey.mock.invocationCallOrder[0])
	})

	it('with the keyboard open, the native call waits for keyboardDidHide', async () => {
		isVisibleSpy.mockReturnValue(true)
		const signer = await createDeviceSigner('x')
		const pending = signer(DIGEST)
		for (let i = 0; i < 5; i++) await Promise.resolve()
		expect(nativeFake.signWithDeviceKey).not.toHaveBeenCalled()
		hideListeners.forEach(cb => cb())
		await pending
		expect(nativeFake.signWithDeviceKey).toHaveBeenCalledTimes(1)
	})
})

describe('key-vault: an auth-required wrap/unwrap dismisses the keyboard first', () => {
	function orderedWrapper(): SecretWrapper & { order: string[] } {
		const order: string[] = []
		const fake = createFakeSecretWrapper()
		return {
			order,
			wrapSecret: (...args: Parameters<SecretWrapper['wrapSecret']>) => {
				order.push('wrap')
				return fake.wrapSecret(...args)
			},
			unwrapSecret: (...args: Parameters<SecretWrapper['unwrapSecret']>) => {
				order.push('unwrap')
				return fake.unwrapSecret(...args)
			},
		} as SecretWrapper & { order: string[] }
	}

	it('dismiss precedes wrapSecret and unwrapSecret for a requireUserAuth secret; not called for a no-auth secret', async () => {
		const wrapper = orderedWrapper()
		dismissSpy.mockImplementation(() => {
			wrapper.order.push('dismiss')
		})
		const vault = createAuthorityKeyVault({
			wrapper,
			storage: AsyncStorage,
			authRequiredWrap: { keyAlias: 'VOTETORRENT_TEST_SHARE_WRAP_KEY_V1', prompt: () => ({ title: 't', subtitle: 's', negativeButton: 'n' }) },
		})
		await vault.putSecret('vt.keyholder-share.e9.0.u9', new Uint8Array([9]), { requireUserAuth: true })
		await vault.getSecret('vt.keyholder-share.e9.0.u9')
		expect(wrapper.order).toEqual(['dismiss', 'wrap', 'dismiss', 'unwrap'])

		wrapper.order.length = 0
		await vault.putSecret('vt.officer-enc.e9.u9', new Uint8Array([1]), { requireUserAuth: false })
		expect(wrapper.order).toEqual(['wrap'])
	})
})
