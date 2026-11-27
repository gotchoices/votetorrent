/**
 * sign-cancel.test.ts — guards the never-throwing, lazy JS wrapper `cancelPendingSign` of
 * `@votetorrent/attestation-native`. The TurboModule is faked with a Proxy over
 * `TurboModuleRegistry.getEnforcing`, as secret-wrap.test.ts does.
 */

const mockGetEnforcingState = { shouldThrow: false, calls: 0 }

jest.mock('react-native', () => {
	const actual: Record<string, unknown> = jest.requireActual('react-native')
	const attestationNativeFake: Record<string, unknown> = {
		cancelPendingSign: jest.fn(),
	}
	const actualTurboModuleRegistry = actual.TurboModuleRegistry as { getEnforcing: (name: string) => unknown }
	const turboModuleRegistryProxy = new Proxy(actualTurboModuleRegistry, {
		get(target, prop, receiver) {
			if (prop === 'getEnforcing') {
				return (name: string) => {
					if (name !== 'AttestationNative') return target.getEnforcing(name)
					mockGetEnforcingState.calls++
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

import { cancelPendingSign, SIGN_CANCEL_JS_CAP_MS } from '@votetorrent/attestation-native'

// eslint-disable-next-line @typescript-eslint/no-var-requires -- reach the fake exposed by the react-native mock above.
const { __attestationNativeFake: nativeFake } = require('react-native') as {
	__attestationNativeFake: { cancelPendingSign: jest.Mock | undefined }
}
const nativeCancel = nativeFake.cancelPendingSign as jest.Mock

describe('cancelPendingSign wrapper', () => {
	beforeEach(() => {
		nativeCancel.mockReset()
		nativeFake.cancelPendingSign = nativeCancel
		mockGetEnforcingState.shouldThrow = false
	})

	// These first two MUST run before any successful require of the spec: the module is cached
	// after its first successful require within this file.
	it('importing the package does not touch the TurboModule', () => {
		expect(mockGetEnforcingState.calls).toBe(0)
	})

	it('resolves false when the module is missing', async () => {
		mockGetEnforcingState.shouldThrow = true
		await expect(cancelPendingSign()).resolves.toBe(false)
	})

	it('resolves false when the method is missing', async () => {
		nativeFake.cancelPendingSign = undefined
		await expect(cancelPendingSign()).resolves.toBe(false)
	})

	it('resolves false when native rejects', async () => {
		nativeCancel.mockRejectedValue(new Error('x'))
		await expect(cancelPendingSign()).resolves.toBe(false)
	})

	it('resolves true on {canceled:true} and calls native once with no arguments', async () => {
		nativeCancel.mockResolvedValue({ canceled: true })
		await expect(cancelPendingSign()).resolves.toBe(true)
		expect(nativeCancel).toHaveBeenCalledTimes(1)
		expect(nativeCancel).toHaveBeenCalledWith()
	})

	it('resolves false for {canceled:false}, null and a non-boolean canceled', async () => {
		nativeCancel.mockResolvedValue({ canceled: false })
		await expect(cancelPendingSign()).resolves.toBe(false)
		nativeCancel.mockResolvedValue(null)
		await expect(cancelPendingSign()).resolves.toBe(false)
		nativeCancel.mockResolvedValue({ canceled: 'true' })
		await expect(cancelPendingSign()).resolves.toBe(false)
	})

	it('caps a native call that never settles, and clears the cap timer when it does settle', async () => {
		jest.useFakeTimers()
		try {
			nativeCancel.mockReturnValue(new Promise(() => {}))
			const pending = cancelPendingSign()
			jest.advanceTimersByTime(SIGN_CANCEL_JS_CAP_MS)
			await expect(pending).resolves.toBe(false)

			nativeCancel.mockReset()
			nativeCancel.mockResolvedValue({ canceled: true })
			await expect(cancelPendingSign()).resolves.toBe(true)
			expect(jest.getTimerCount()).toBe(0)
		} finally {
			jest.useRealTimers()
		}
	})
})
