/**
 * D-03: attestation-producer.ts — the AttestationProducer seam.
 *
 * Asserts:
 *   (a) StubAttestationProducer(challenge, deviceKey) resolves a DeviceAttestation
 *       whose platformDetails.nonce round-trips challenge.nonce and whose
 *       platformDetails.type === 'Android'.
 *   (b) resolveAttestationProducer() prefers a supplied real producer even when
 *       __DEV__ is true (real producer wins — Phase 45 drop-in), and falls back to
 *       StubAttestationProducer only when no real producer is supplied.
 *   (c) resolveAttestationProducer()'s real-branch THROWS when __DEV__ is false and
 *       no real producer is supplied (fail-closed, CR-03 posture) — never silently
 *       returns the stub.
 *   (d) resolveAttestationProducer() returns the supplied real producer when
 *       __DEV__ is false and a real producer IS supplied.
 *
 * __DEV__ is a writable/configurable global under the react-native jest preset
 * (react-native/jest/setup.js) — toggled per-test and restored in afterEach, no
 * jest.resetModules/doMock needed since attestation-producer.ts reads __DEV__ at
 * call time, not at module-load time.
 */

import type { AttestationChallenge } from '@votetorrent/vote-core'
import {
	StubAttestationProducer,
	resolveAttestationProducer,
	type AttestationProducer,
} from '../attestation-producer'

describe('attestation-producer — D-03 producer seam', () => {
	const originalDev = (globalThis as { __DEV__?: boolean }).__DEV__

	afterEach(() => {
		;(globalThis as { __DEV__?: boolean }).__DEV__ = originalDev
	})

	const challenge: AttestationChallenge = {
		nonce: 'nonce-abc-123',
		authorityId: 'authority-1',
		registrantId: 'registrant-1',
		deviceKey: 'devkey-pubkey-hex',
		expiration: Date.now() + 60_000,
	}

	describe('StubAttestationProducer', () => {
		it('resolves a DeviceAttestation whose nonce round-trips the challenge nonce and type is Android', async () => {
			const attestation = await StubAttestationProducer(challenge, 'devkey')

			expect(attestation.platformDetails?.type).toBe('Android')
			expect(attestation.platformDetails?.type === 'Android' && attestation.platformDetails.nonce).toBe(
				challenge.nonce,
			)
		})

		it('carries deterministic, clearly-non-real placeholder cert/key/deviceId fields', async () => {
			const attestation = await StubAttestationProducer(challenge, 'devkey')

			expect(attestation.publicKey).toBe('devkey')
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
			const realProducer: AttestationProducer = jest.fn()

			const producer = resolveAttestationProducer(realProducer)

			expect(producer).toBe(realProducer)
		})

		it('THROWS when __DEV__ is false and no real producer is supplied (fail-closed, CR-03)', () => {
			;(globalThis as { __DEV__?: boolean }).__DEV__ = false

			expect(() => resolveAttestationProducer()).toThrow(/real attestation producer not provided/i)
		})

		it('returns the supplied real producer when __DEV__ is false', () => {
			;(globalThis as { __DEV__?: boolean }).__DEV__ = false
			const realProducer: AttestationProducer = jest.fn()

			const producer = resolveAttestationProducer(realProducer)

			expect(producer).toBe(realProducer)
		})
	})
})
