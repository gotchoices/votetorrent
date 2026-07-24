/**
 * D-03/D-11: attestation-producer.ts — the two-step AttestationProducer seam.
 *
 * Asserts:
 *   (a) StubAttestationProducer.provisionDeviceKey() resolves a non-empty placeholder
 *       public key.
 *   (b) StubAttestationProducer.produce(challenge) resolves a DeviceAttestation whose
 *       platformDetails.nonce round-trips challenge.nonce (RAW) and whose
 *       platformDetails.type === 'Android'.
 *   (c) resolveAttestationProducer() prefers a supplied real producer regardless of
 *       __DEV__ (real producer wins — Phase 45 drop-in), and falls back to
 *       StubAttestationProducer only when no real producer is supplied AND __DEV__.
 *   (d) resolveAttestationProducer() returns the REAL producer (via
 *       createRealAttestationProducer, mocked) — NOT the stub — when __DEV__ is
 *       false and no real producer is supplied (spoofing posture: the stub is never
 *       reachable outside __DEV__).
 *
 * __DEV__ is a writable/configurable global under the react-native jest preset
 * (react-native/jest/setup.js) — toggled per-test and restored in afterEach, no
 * jest.resetModules/doMock needed since attestation-producer.ts reads __DEV__ at
 * call time, not at module-load time.
 *
 * `@votetorrent/attestation-native` is mocked so this suite never imports the real
 * native TurboModule spec (which would throw via `TurboModuleRegistry.getEnforcing`
 * outside a real RN runtime).
 */

import type { AttestationChallenge } from '@votetorrent/vote-core'

const mockCreateRealAttestationProducer = jest.fn((_opts: { enablePlayIntegrity: boolean }) => ({
	provisionDeviceKey: jest.fn(),
	produce: jest.fn(),
}))

jest.mock('@votetorrent/attestation-native', () => ({
	createRealAttestationProducer: (opts: { enablePlayIntegrity: boolean }) => mockCreateRealAttestationProducer(opts),
}))

import { StubAttestationProducer, resolveAttestationProducer, type AttestationProducer } from '../attestation-producer'

describe('attestation-producer — D-03/D-11 producer seam', () => {
	const originalDev = (globalThis as { __DEV__?: boolean }).__DEV__

	afterEach(() => {
		;(globalThis as { __DEV__?: boolean }).__DEV__ = originalDev
		mockCreateRealAttestationProducer.mockClear()
	})

	const challenge: AttestationChallenge = {
		nonce: 'nonce-abc-123',
		authorityId: 'authority-1',
		registrantId: 'registrant-1',
		deviceKey: 'devkey-pubkey-hex',
		expiration: Date.now() + 60_000,
	}

	describe('StubAttestationProducer', () => {
		it('provisionDeviceKey() resolves a non-empty placeholder public key', async () => {
			const { publicKey } = await StubAttestationProducer.provisionDeviceKey()

			expect(typeof publicKey).toBe('string')
			expect(publicKey.length).toBeGreaterThan(0)
		})

		it('produce() resolves a DeviceAttestation whose nonce round-trips the challenge nonce and type is Android', async () => {
			const attestation = await StubAttestationProducer.produce(challenge)

			expect(attestation.platformDetails?.type).toBe('Android')
			expect(attestation.platformDetails?.type === 'Android' && attestation.platformDetails.nonce).toBe(
				challenge.nonce,
			)
		})

		it('produce() carries deterministic, clearly-non-real placeholder cert/key/deviceId fields', async () => {
			const attestation = await StubAttestationProducer.produce(challenge)

			expect(attestation.publicKey).toBe(challenge.deviceKey)
			expect(attestation.deviceId).toContain(challenge.registrantId)
			expect(Array.isArray(attestation.certificateChain)).toBe(true)
			expect(attestation.certificateChain.length).toBeGreaterThan(0)
			expect(attestation.certificateChain[0]).toMatch(/stub|placeholder/i)
		})
	})

	describe('resolveAttestationProducer — __DEV__ fail-closed gate', () => {
		it('returns StubAttestationProducer when __DEV__ is true (no real producer supplied)', () => {
			;(globalThis as { __DEV__?: boolean }).__DEV__ = true

			const producer = resolveAttestationProducer()

			expect(producer).toBe(StubAttestationProducer)
		})

		it('returns the supplied real producer even when __DEV__ is true (real producer wins — Phase 45 drop-in)', () => {
			;(globalThis as { __DEV__?: boolean }).__DEV__ = true
			const realProducer: AttestationProducer = {
				provisionDeviceKey: jest.fn(),
				produce: jest.fn(),
			}

			const producer = resolveAttestationProducer(realProducer)

			expect(producer).toBe(realProducer)
		})

		it('returns the REAL producer (via createRealAttestationProducer, not the stub) when __DEV__ is false and no real producer is supplied', () => {
			;(globalThis as { __DEV__?: boolean }).__DEV__ = false

			const producer = resolveAttestationProducer()

			expect(mockCreateRealAttestationProducer).toHaveBeenCalledWith({ enablePlayIntegrity: true })
			expect(producer).not.toBe(StubAttestationProducer)
		})

		it('returns the supplied real producer when __DEV__ is false', () => {
			;(globalThis as { __DEV__?: boolean }).__DEV__ = false
			const realProducer: AttestationProducer = {
				provisionDeviceKey: jest.fn(),
				produce: jest.fn(),
			}

			const producer = resolveAttestationProducer(realProducer)

			expect(producer).toBe(realProducer)
		})
	})
})
