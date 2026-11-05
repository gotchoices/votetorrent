/**
 * device-key-wrap.ts — Voter `DeviceKeyWrapProvider` seam (D-42, Phase 62 plan 08).
 *
 * `device-user.ts` depends on this seam, not on `@votetorrent/attestation-native` directly, so
 * jest can inject the jest-only in-memory stub (under this directory's `__fixtures__`) without
 * touching the native TurboModule bridge at all — mirrors `attestation-producer.ts`'s
 * `resolveAttestationProducer(realProducer?)` injection shape (a supplied/overridden value always
 * wins; otherwise a lazily-constructed real implementation).
 *
 * `requireAuth: false` on both methods is deliberate and D-42-scoped: this alias protects the
 * identity key AT REST (extraction from a rooted device / backup / stolen RKStorage file), not
 * against use by whoever has the unlocked device — 62-RESEARCH-CONTINUITY.md Pitfall 2. A
 * `requireAuth: true` alias (e.g. 62-26's keyholder-share alias) is a SEPARATE alias with its own
 * provider, never this one.
 */

import {
	createNativeSecretWrapper,
	VOTETORRENT_VOTER_IDENTITY_WRAP_KEY_V1,
	type WrappedSecret,
} from '@votetorrent/attestation-native'

export interface DeviceKeyWrapProvider {
	wrap(plaintext: Uint8Array, aad: Uint8Array): Promise<WrappedSecret>
	unwrap(wrapped: WrappedSecret, aad: Uint8Array): Promise<Uint8Array>
}

/** Native-backed provider for the D-42 voter identity-key alias. `requireAuth: false` on both
 * methods — see this file's header comment. */
export function createNativeDeviceKeyWrapProvider(): DeviceKeyWrapProvider {
	const wrapper = createNativeSecretWrapper()
	return {
		async wrap(plaintext: Uint8Array, aad: Uint8Array): Promise<WrappedSecret> {
			return wrapper.wrapSecret(VOTETORRENT_VOTER_IDENTITY_WRAP_KEY_V1, plaintext, { requireAuth: false, aad })
		},
		async unwrap(wrapped: WrappedSecret, aad: Uint8Array): Promise<Uint8Array> {
			return wrapper.unwrapSecret(wrapped, { requireAuth: false, aad })
		},
	}
}

let testOverride: DeviceKeyWrapProvider | undefined
let nativeProvider: DeviceKeyWrapProvider | undefined

/**
 * Resolve the `DeviceKeyWrapProvider` to use: the jest test override if one is installed via
 * `setDeviceKeyWrapProviderForTests`, otherwise a lazily constructed, memoised native provider.
 * Resolved fresh on every call (never cached onto a module-level binding other than this seam),
 * mirroring `resolveAttestationProducer`'s per-call resolution.
 */
export function resolveDeviceKeyWrapProvider(): DeviceKeyWrapProvider {
	if (testOverride !== undefined) return testOverride
	if (!nativeProvider) nativeProvider = createNativeDeviceKeyWrapProvider()
	return nativeProvider
}

/**
 * TEST ONLY. Sets or clears the module-level test override `resolveDeviceKeyWrapProvider` returns.
 * Production code must never call this — a grep gate in 62-08's plan enforces that only this file
 * references the setter outside `__tests__`/`__fixtures__`.
 */
export function setDeviceKeyWrapProviderForTests(provider: DeviceKeyWrapProvider | undefined): void {
	testOverride = provider
}
