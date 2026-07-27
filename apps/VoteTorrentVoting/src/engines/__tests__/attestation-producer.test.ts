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

	/**
	 * 45-10 gap closure: USE_REAL_ATTESTATION_PRODUCER / resolveRealProducerForced().
	 *
	 * `USE_REAL_ATTESTATION_PRODUCER` and `USE_STUB_PLAY_INTEGRITY` are module-level
	 * `const` bindings captured at module load time from `./proof-flags.generated` — unlike
	 * `__DEV__` they CANNOT be toggled by assigning a global. Each row below uses
	 * `jest.isolateModules` + `jest.doMock('../proof-flags.generated', ...)` to vary them,
	 * then a fresh `require('../attestation-producer')` inside the isolated scope. The
	 * `@votetorrent/attestation-native` mock from the top of this file does NOT survive
	 * `isolateModules`'s fresh registry, so it is re-established per row via `jest.doMock`
	 * as well, backed by a per-row-local mock function so each row's assertions are
	 * independent of the outer-scope `mockCreateRealAttestationProducer`.
	 */
	describe('resolveRealProducerForced() / USE_REAL_ATTESTATION_PRODUCER — 45-10 gap closure', () => {
		afterEach(() => {
			;(globalThis as { __DEV__?: boolean }).__DEV__ = originalDev
		})

		type Outcome = 'supplied' | 'stub' | 'real'

		function loadIsolated(flags: { useRealAttestationProducer: boolean; useStubPlayIntegrity: boolean }): {
			resolveAttestationProducer: typeof resolveAttestationProducer
			resolveRealProducerForced: () => boolean
			StubAttestationProducer: AttestationProducer
			mockCreateRealAttestationProducer: jest.Mock
		} {
			let result!: {
				resolveAttestationProducer: typeof resolveAttestationProducer
				resolveRealProducerForced: () => boolean
				StubAttestationProducer: AttestationProducer
				mockCreateRealAttestationProducer: jest.Mock
			}

			jest.isolateModules(() => {
				// Explicit jest.resetModules() is REQUIRED here (not merely redundant with
				// isolateModules): this file has a permanent, hoisted top-level
				// `jest.mock('@votetorrent/attestation-native', ...)` PLUS a static top-level
				// `import '../attestation-producer'` that eagerly requires it before any
				// isolateModules block runs. Empirically, without this reset,
				// `jest.doMock('@votetorrent/attestation-native', ...)` below is silently
				// ignored inside the isolated registry and the OUTER top-level mock factory
				// is used instead (verified via a throwaway repro) — the reset forces the
				// isolated registry to re-resolve the mock factory fresh.
				jest.resetModules()

				const localMockCreateRealAttestationProducer = jest.fn((_opts: { enablePlayIntegrity: boolean }) => ({
					provisionDeviceKey: jest.fn(),
					produce: jest.fn(),
				}))

				jest.doMock('../proof-flags.generated', () => ({
					USE_LOCAL_DB_FACTORY: false,
					USE_STUB_PLAY_INTEGRITY: flags.useStubPlayIntegrity,
					USE_REAL_ATTESTATION_PRODUCER: flags.useRealAttestationProducer,
				}))
				jest.doMock('@votetorrent/attestation-native', () => ({
					createRealAttestationProducer: (opts: { enablePlayIntegrity: boolean }) =>
						localMockCreateRealAttestationProducer(opts),
				}))

				// eslint-disable-next-line @typescript-eslint/no-var-requires
				const mod = require('../attestation-producer') as typeof import('../attestation-producer')

				result = {
					resolveAttestationProducer: mod.resolveAttestationProducer,
					resolveRealProducerForced: mod.resolveRealProducerForced,
					StubAttestationProducer: mod.StubAttestationProducer,
					mockCreateRealAttestationProducer: localMockCreateRealAttestationProducer,
				}
			})

			return result
		}

		const rowChallenge: AttestationChallenge = challenge

		describe('16-row truth table: __DEV__ x USE_REAL_ATTESTATION_PRODUCER x USE_STUB_PLAY_INTEGRITY x supplied-producer', () => {
			it.each<{
				dev: boolean
				forced: boolean
				stubPi: boolean
				supplied: boolean
				expected: Outcome
				expectedEnablePlayIntegrity?: boolean
			}>([
				// -- supplied producer always wins (8 rows: dev x forced x stubPi, supplied=true) --
				{ dev: true, forced: true, stubPi: true, supplied: true, expected: 'supplied' },
				{ dev: true, forced: true, stubPi: false, supplied: true, expected: 'supplied' },
				{ dev: true, forced: false, stubPi: true, supplied: true, expected: 'supplied' },
				{ dev: true, forced: false, stubPi: false, supplied: true, expected: 'supplied' },
				{ dev: false, forced: true, stubPi: true, supplied: true, expected: 'supplied' },
				{ dev: false, forced: true, stubPi: false, supplied: true, expected: 'supplied' },
				{ dev: false, forced: false, stubPi: true, supplied: true, expected: 'supplied' },
				{ dev: false, forced: false, stubPi: false, supplied: true, expected: 'supplied' },
				// -- no supplied producer, __DEV__ true (4 rows) --
				{
					dev: true,
					forced: false,
					stubPi: false,
					supplied: false,
					expected: 'stub',
				}, // Phase 44 default unchanged
				{
					dev: true,
					forced: false,
					stubPi: true,
					supplied: false,
					expected: 'stub',
				}, // forced-real false -> still stub regardless of stub-PI
				{
					dev: true,
					forced: true,
					stubPi: true,
					supplied: false,
					expected: 'real',
					expectedEnablePlayIntegrity: false,
				}, // D-12 real-key + stub-PI tier
				{
					dev: true,
					forced: true,
					stubPi: false,
					supplied: false,
					expected: 'real',
					expectedEnablePlayIntegrity: true,
				},
				// -- no supplied producer, __DEV__ false (4 rows) — CR-03: stub unreachable regardless of flags --
				{
					dev: false,
					forced: false,
					stubPi: false,
					supplied: false,
					expected: 'real',
					expectedEnablePlayIntegrity: true,
				},
				{
					dev: false,
					forced: false,
					stubPi: true,
					supplied: false,
					expected: 'real',
					expectedEnablePlayIntegrity: true,
				},
				{
					dev: false,
					forced: true,
					stubPi: false,
					supplied: false,
					expected: 'real',
					expectedEnablePlayIntegrity: true,
				},
				{
					dev: false,
					forced: true,
					stubPi: true,
					supplied: false,
					expected: 'real',
					expectedEnablePlayIntegrity: true,
				},
			])(
				'dev=$dev forced=$forced stubPi=$stubPi supplied=$supplied -> $expected',
				({ dev, forced, stubPi, supplied, expected, expectedEnablePlayIntegrity }) => {
					;(globalThis as { __DEV__?: boolean }).__DEV__ = dev
					const isolated = loadIsolated({ useRealAttestationProducer: forced, useStubPlayIntegrity: stubPi })

					const suppliedProducer: AttestationProducer | undefined = supplied
						? { provisionDeviceKey: jest.fn(), produce: jest.fn() }
						: undefined

					const producer = isolated.resolveAttestationProducer(suppliedProducer)

					if (expected === 'supplied') {
						expect(producer).toBe(suppliedProducer)
						expect(isolated.mockCreateRealAttestationProducer).not.toHaveBeenCalled()
					} else if (expected === 'stub') {
						expect(producer).toBe(isolated.StubAttestationProducer)
						expect(isolated.mockCreateRealAttestationProducer).not.toHaveBeenCalled()
					} else {
						expect(producer).not.toBe(isolated.StubAttestationProducer)
						expect(isolated.mockCreateRealAttestationProducer).toHaveBeenCalledWith({
							enablePlayIntegrity: expectedEnablePlayIntegrity,
						})
					}
				},
			)
		})

		// T-45-05-04 / CR-03 release-fail-closed guard: a future edit that widens the new
		// rung above the __DEV__ check (or otherwise lets a release build reach the stub)
		// MUST fail this test. Iterates every (USE_REAL_ATTESTATION_PRODUCER,
		// USE_STUB_PLAY_INTEGRITY) combination with __DEV__ false and no supplied producer.
		describe('CR-03 / T-45-05-04 release-fail-closed guard', () => {
			it.each<{ forced: boolean; stubPi: boolean }>([
				{ forced: false, stubPi: false },
				{ forced: false, stubPi: true },
				{ forced: true, stubPi: false },
				{ forced: true, stubPi: true },
			])(
				'CR-03: __DEV__ false, USE_REAL_ATTESTATION_PRODUCER=$forced, USE_STUB_PLAY_INTEGRITY=$stubPi never returns StubAttestationProducer, and enablePlayIntegrity is always true',
				({ forced, stubPi }) => {
					;(globalThis as { __DEV__?: boolean }).__DEV__ = false
					const isolated = loadIsolated({ useRealAttestationProducer: forced, useStubPlayIntegrity: stubPi })

					const producer = isolated.resolveAttestationProducer()

					expect(producer).not.toBe(isolated.StubAttestationProducer)
					expect(isolated.mockCreateRealAttestationProducer).toHaveBeenCalledWith({ enablePlayIntegrity: true })
				},
			)
		})

		describe('resolveRealProducerForced() direct unit cases', () => {
			it.each<{ dev: boolean; forced: boolean; expected: boolean }>([
				{ dev: true, forced: true, expected: true },
				{ dev: true, forced: false, expected: false },
				{ dev: false, forced: true, expected: false },
				{ dev: false, forced: false, expected: false },
			])('__DEV__=$dev, USE_REAL_ATTESTATION_PRODUCER=$forced -> $expected', ({ dev, forced, expected }) => {
				;(globalThis as { __DEV__?: boolean }).__DEV__ = dev
				const isolated = loadIsolated({ useRealAttestationProducer: forced, useStubPlayIntegrity: false })

				expect(isolated.resolveRealProducerForced()).toBe(expected)
			})
		})

		// Sanity: rowChallenge is a valid AttestationChallenge shape reused from the outer
		// describe block, confirming this describe block shares fixtures rather than
		// inventing a parallel harness.
		it('reuses the outer-scope challenge fixture (no parallel harness)', () => {
			expect(rowChallenge.nonce).toBe(challenge.nonce)
		})
	})
})
