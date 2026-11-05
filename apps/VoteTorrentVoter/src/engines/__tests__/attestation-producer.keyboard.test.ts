/**
 * attestation-producer.keyboard.test.ts — on-device finding (Redmi 8, MIUI 12.5, Android 10): a
 * BiometricPrompt started while the soft keyboard is open is never drawn. The REAL producer's two
 * prompt-raising calls (`produce`, `signDeviceKeyDigest`) must close the IME first; the stub and a
 * caller-supplied producer are returned untouched.
 */
import { Keyboard } from 'react-native'
import type { AttestationChallenge } from '@votetorrent/vote-core'

const order: string[] = []
const mockRealProducer = {
	provisionDeviceKey: jest.fn(async () => {
		order.push('provision')
		return { publicKey: 'PUB', reprovisioned: false }
	}),
	getCurrentDeviceKey: jest.fn(async () => {
		order.push('current')
		return { publicKey: 'PUB' }
	}),
	produce: jest.fn(async () => {
		order.push('produce')
		return { attestation: true }
	}),
	signDeviceKeyDigest: jest.fn(async () => {
		order.push('sign')
		return { signerUserId: 'u', signerKey: 'k', signature: 's' }
	}),
}

jest.mock('@votetorrent/attestation-native', () => ({
	createRealAttestationProducer: () => mockRealProducer,
}))

import { StubAttestationProducer, resolveAttestationProducer, type AttestationProducer } from '../attestation-producer'

const CHALLENGE = { nonce: 'n', deviceKey: 'PUB' } as unknown as AttestationChallenge
let hideListeners: Array<() => void>

describe('attestation-producer — keyboard dismissed before native prompts', () => {
	const originalDev = (globalThis as { __DEV__?: boolean }).__DEV__

	beforeEach(() => {
		;(globalThis as { __DEV__?: boolean }).__DEV__ = false // release rung -> real producer
		order.length = 0
		mockRealProducer.provisionDeviceKey.mockClear()
		mockRealProducer.produce.mockClear()
		mockRealProducer.signDeviceKeyDigest.mockClear()
		hideListeners = []
		jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {
			order.push('dismiss')
		})
		jest.spyOn(Keyboard, 'isVisible').mockReturnValue(false)
		jest.spyOn(Keyboard, 'addListener').mockImplementation(((event: string, cb: () => void) => {
			if (event === 'keyboardDidHide') hideListeners.push(cb)
			return { remove: jest.fn() }
		}) as never)
	})

	afterEach(() => {
		;(globalThis as { __DEV__?: boolean }).__DEV__ = originalDev
		jest.restoreAllMocks()
	})

	it('produce and signDeviceKeyDigest dismiss the keyboard first; provisionDeviceKey (no prompt) does not', async () => {
		const producer = resolveAttestationProducer()
		const provisioned = await producer.provisionDeviceKey()
		expect(provisioned).toEqual({ publicKey: 'PUB', reprovisioned: false }) // extra fields pass through
		await producer.produce(CHALLENGE)
		await producer.signDeviceKeyDigest!(new Uint8Array([1, 2, 3]))
		expect(order).toEqual(['provision', 'dismiss', 'produce', 'dismiss', 'sign'])
		expect(mockRealProducer.produce).toHaveBeenCalledWith(CHALLENGE)
	})

	it('getCurrentDeviceKey is a prompt-free pass-through: no keyboard dismissal, no provisioning (63-18)', async () => {
		mockRealProducer.provisionDeviceKey.mockClear()
		const producer = resolveAttestationProducer()
		expect(await producer.getCurrentDeviceKey()).toEqual({ publicKey: 'PUB' })
		expect(order).toEqual(['current'])
		expect(mockRealProducer.provisionDeviceKey).not.toHaveBeenCalled()
	})

	it('with the keyboard open, produce waits for keyboardDidHide before the native call', async () => {
		;(Keyboard.isVisible as jest.Mock).mockReturnValue(true)
		const producer = resolveAttestationProducer()
		const pending = producer.produce(CHALLENGE)
		for (let i = 0; i < 5; i++) await Promise.resolve()
		expect(mockRealProducer.produce).not.toHaveBeenCalled()
		hideListeners.forEach(cb => cb())
		await pending
		expect(mockRealProducer.produce).toHaveBeenCalledTimes(1)
	})

	it('a supplied producer and the __DEV__ stub are returned untouched (no wrapping)', () => {
		const supplied: AttestationProducer = { provisionDeviceKey: jest.fn(), getCurrentDeviceKey: jest.fn(), produce: jest.fn() }
		expect(resolveAttestationProducer(supplied)).toBe(supplied)
		;(globalThis as { __DEV__?: boolean }).__DEV__ = true
		expect(resolveAttestationProducer()).toBe(StubAttestationProducer)
	})
})
