/**
 * real-attestation-producer.test.ts — Phase 45-07 jest regression guard for
 * `@votetorrent/attestation-native`'s `RealAttestationProducer`
 * (`packages/attestation-native/src/real-attestation-producer.ts`, created
 * by 45-05).
 *
 * Asserts:
 *   (1) D-11 two-step seam ordering: `produce()` before `provisionDeviceKey()`
 *       rejects; the happy path calls the native `produceAttestation` exactly
 *       once and assembles a `DeviceAttestation` carrying the RAW
 *       `challenge.nonce` (Pitfall 5 — never the bound digest) plus the
 *       faked native's cert chain / integrity token.
 *   (2) D-06 native argument binding: `produce()` passes
 *       `computeBoundDigest(challenge.nonce, challenge.deviceKey)` to the
 *       faked native `produceAttestation` AS-IS, and separately passes the
 *       base64-of-utf8 form of that same digest (ATTESTATION-CONTRACT.md §3
 *       asymmetry — never conflate the two).
 *   (3) D-16b probe throws on a mismatched `digestFields` binding at module
 *       LOAD time (not per-call) — a Hermes-side divergence would be caught
 *       loudly rather than shipping a silently-wrong attestation. A control
 *       assertion proves the real module does NOT throw.
 *   (4) D-16b cross-runtime parity: `computeBoundDigest('probe-nonce-v1',
 *       'probe-devicekey-v1')` strictly equals a hardcoded Node-computed
 *       base64url golden vector.
 *
 * The native TurboModule bridge is faked (react-native's `TurboModuleRegistry
 * .getEnforcing` is overridden for the `'AttestationNative'` name only) so
 * this suite exercises the module's REAL pure-JS parts (`computeBoundDigest`,
 * the D-16b probe, `createRealAttestationProducer`'s orchestration) — it does
 * NOT mock the whole `@votetorrent/attestation-native` package (that would
 * mock away the functions under test).
 */

// NOTE: do NOT `{ ...jest.requireActual('react-native') }` here — react-native's index.js
// exports most modules (DevMenu, DevSettings, ...) as lazy getters, and spreading forces
// Object.assign to evaluate EVERY getter eagerly, including native-bridge accessors
// (`TurboModuleRegistry.getEnforcing('DevMenu')`) that nothing in this suite actually
// touches and that throw outside a real native runtime. A Proxy defers property access to
// exactly what the code under test reads (only `TurboModuleRegistry`), matching how the
// unmocked module behaves.
jest.mock('react-native', () => {
	const actual: Record<string, unknown> = jest.requireActual('react-native')
	const attestationNativeFake = {
		provisionDeviceKey: jest.fn(),
		produceAttestation: jest.fn(),
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
	return new Proxy(actual, {
		get(target, prop, receiver) {
			if (prop === 'TurboModuleRegistry') return turboModuleRegistryProxy
			if (prop === '__attestationNativeFake') return attestationNativeFake
			return Reflect.get(target, prop, receiver)
		},
	})
})

import type { AttestationChallenge } from '@votetorrent/vote-core'
import { computeBoundDigest, createRealAttestationProducer } from '@votetorrent/attestation-native'

// eslint-disable-next-line @typescript-eslint/no-var-requires -- reach the fake exposed by the react-native mock above.
const { __attestationNativeFake: nativeFake } = require('react-native') as {
	__attestationNativeFake: { provisionDeviceKey: jest.Mock; produceAttestation: jest.Mock }
}

describe('real-attestation-producer — D-11/D-06/D-16b (Phase 45-07 regression guard)', () => {
	const challenge: AttestationChallenge = {
		nonce: 'challenge-nonce-xyz',
		authorityId: 'authority-1',
		registrantId: 'registrant-1',
		deviceKey: 'device-voting-pubkey-hex',
		expiration: Date.now() + 60_000,
	}

	const fakeProvisionResult = { publicKeyBase64: 'fake-public-key-b64', keyAlias: 'VOTETORRENT_DEVICE_KEY_V1' }
	const fakeProduceResult = {
		certificateChainBase64: ['fake-cert-a', 'fake-cert-b'],
		integrityToken: 'fake-integrity-token',
		androidId: 'fake-android-id',
		attestationTimeMillis: 1_700_000_000_000,
	}

	beforeEach(() => {
		nativeFake.provisionDeviceKey.mockReset().mockResolvedValue(fakeProvisionResult)
		nativeFake.produceAttestation.mockReset().mockResolvedValue(fakeProduceResult)
	})

	describe('two-step seam ordering (D-11)', () => {
		it('produce() before provisionDeviceKey() rejects (no provisioned key)', async () => {
			// The JS orchestration layer (createRealAttestationProducer) does not itself gate
			// ordering — the D-11 two-step contract is enforced by the NATIVE Keystore, whose
			// `produceAttestation` operates on a key alias that only exists once
			// `provisionDeviceKey()` has actually run. Simulate that real native behavior: with
			// no prior provisionDeviceKey() call, the faked native produceAttestation rejects
			// (no key under KEY_ALIAS), and produce() must propagate that rejection verbatim.
			nativeFake.provisionDeviceKey.mockReset() // never called by this test
			nativeFake.produceAttestation.mockReset().mockRejectedValue(new Error('no key provisioned under this alias'))
			const producer = createRealAttestationProducer({ enablePlayIntegrity: true })

			await expect(producer.produce(challenge)).rejects.toThrow(/no key provisioned/)
			expect(nativeFake.provisionDeviceKey).not.toHaveBeenCalled()
		})

		it('happy path: provisionDeviceKey() then produce() calls native produceAttestation exactly once and preserves the RAW nonce', async () => {
			const producer = createRealAttestationProducer({ enablePlayIntegrity: true })

			const { publicKey } = await producer.provisionDeviceKey()
			expect(publicKey).toBe(fakeProvisionResult.publicKeyBase64)
			expect(nativeFake.provisionDeviceKey).toHaveBeenCalledTimes(1)

			const attestation = await producer.produce(challenge)

			expect(nativeFake.produceAttestation).toHaveBeenCalledTimes(1)
			// Pitfall 5: platformDetails.nonce carries the RAW challenge.nonce, NOT the bound digest.
			expect(attestation.platformDetails?.type).toBe('Android')
			expect(attestation.platformDetails?.type === 'Android' && attestation.platformDetails.nonce).toBe(challenge.nonce)
			expect(attestation.certificateChain).toEqual(fakeProduceResult.certificateChainBase64)
			expect(attestation.platformDetails?.type === 'Android' && attestation.platformDetails.safetyNetAttestation).toBe(
				fakeProduceResult.integrityToken,
			)
			expect(attestation.deviceId).toBe(fakeProduceResult.androidId)
		})
	})

	describe('native bound-digest argument binding (D-06)', () => {
		it('passes computeBoundDigest(nonce, deviceKey) AS-IS and its base64(utf8(...)) form separately (ATTESTATION-CONTRACT.md §3 asymmetry)', async () => {
			const producer = createRealAttestationProducer({ enablePlayIntegrity: false })
			await producer.provisionDeviceKey()
			await producer.produce(challenge)

			const expectedBoundDigest = computeBoundDigest(challenge.nonce, challenge.deviceKey)
			expect(nativeFake.produceAttestation).toHaveBeenCalledTimes(1)
			const callArgs = nativeFake.produceAttestation.mock.calls[0] as [string, string, string, boolean]
			const [keyAlias, boundDigestArg, boundDigestUtf8Base64Arg, enablePlayIntegrityArg] = callArgs

			expect(keyAlias).toBe('VOTETORRENT_DEVICE_KEY_V1')
			// §2 (Play Integrity classic nonce): the BOUND_DIGEST string, verbatim, no transform.
			expect(boundDigestArg).toBe(expectedBoundDigest)
			// §3 (Keystore attestationChallenge): base64-of-the-UTF8-bytes of that SAME string —
			// deliberately NOT equal to boundDigestArg (the asymmetry is intentional).
			expect(boundDigestUtf8Base64Arg).not.toBe(boundDigestArg)
			expect(Buffer.from(boundDigestUtf8Base64Arg, 'base64').toString('utf8')).toBe(expectedBoundDigest)
			expect(enablePlayIntegrityArg).toBe(false)
		})
	})

	describe('D-16b module-load probe', () => {
		it('throws when the digestFields binding diverges from the known-good vector', () => {
			jest.isolateModules(() => {
				jest.doMock('@optimystic/quereus-plugin-crypto', () => ({
					digestFields: () => 'deliberately-wrong-digest-value',
					resolveHasher: (name: string) => name,
					resolveOutputEncoder: (name: string) => name,
				}))

				expect(() => {
					// eslint-disable-next-line @typescript-eslint/no-var-requires
					require('@votetorrent/attestation-native')
				}).toThrow(/probe|digest/i)

				jest.dontMock('@optimystic/quereus-plugin-crypto')
			})
		})

		it('does NOT throw when the real digestFields binding is used (control)', () => {
			jest.isolateModules(() => {
				expect(() => {
					// eslint-disable-next-line @typescript-eslint/no-var-requires
					require('@votetorrent/attestation-native')
				}).not.toThrow()
			})
		})
	})

	describe('cross-runtime parity vector (D-16b)', () => {
		it("computeBoundDigest('probe-nonce-v1', 'probe-devicekey-v1') equals the Node-computed golden vector", () => {
			// Golden vector: computed on Node against the same @optimystic/quereus-plugin-crypto
			// binding the SQL Digest() UDF uses (packages/attestation-native/src/real-attestation-producer.ts's
			// own PROBE_EXPECTED literal). Do NOT recompute this dynamically — a dynamically-computed
			// expected value would defeat the cross-runtime purpose (a Hermes-side divergence must
			// diverge from a FIXED string, not from itself).
			expect(computeBoundDigest('probe-nonce-v1', 'probe-devicekey-v1')).toBe('epUx8O72zVpRIQl1WGnqZSQpvFJjJPPZtmgqJBcUfzI')
		})
	})
})
