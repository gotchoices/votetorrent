/**
 * vote-record-wrap.ts - Voter `VoteRecordWrapProvider` seam (D-13, D-29, Phase 63 plan 07).
 *
 * This alias protects the vote record's data key. It is the opposite policy of the D-42 identity
 * alias (device-key-wrap.ts): `requireAuth: true` on every wrap and unwrap, so viewing saved
 * choices needs a fingerprint.
 *
 * Android uses a time-bound key (D-14): `VOTE_RECORD_AUTH_WINDOW_SECONDS` is passed only through
 * `voteRecordWrapOptions`, on wrap and on unwrap. If the vote-signing prompt opens the window,
 * Submit costs one prompt; otherwise two, which is an accepted D-14 outcome. Opening a saved receipt
 * after the window lapses prompts once (D-13). iOS ignores the window and stays per-use. The R-5
 * fallback to per-use is the constant set to 0, with no native change.
 *
 * One alias means one policy forever, fixed at key creation. V1 has never shipped, so it adopted
 * the windowed policy.
 *
 * Never reuse the identity alias or its provider.
 *
 * Phase 63 review WR-04: on Android below API 30 the effective window is 0 (per-use, biometric
 * CryptoObject), because the only pre-30 time-bound key is satisfied by a PIN and survives biometric
 * re-enrollment. Native downgrades a window there too (defence in depth).
 *
 * Phase 63 review CR-02: a biometric enrollment change invalidates this alias for good. When sealing a
 * NEW record reports the key invalidated (`KEY_INVALIDATED`, or iOS's `NO_WRAP_KEY` for an item it can
 * no longer read), the provider deletes the vote-record key and wraps exactly once more under a fresh
 * one. Records sealed under the old key were already unreadable and stay so (the receipt maps that to
 * its unreadable state). Only the vote-record alias can ever be deleted (JS and native both refuse any
 * other alias), and the read path never deletes.
 */

import { Platform } from 'react-native'
import {
	createNativeSecretWrapper,
	SecretWrapError,
	type ReplaceableSecretWrapper,
	type SecretWrapOptions,
	type SecretWrapPrompt,
	type SecretWrapper,
	type WrappedSecret,
} from '@votetorrent/attestation-native'

export const VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1 = 'VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1'

export interface VoteRecordWrapProvider {
	wrap(plaintext: Uint8Array, aad: Uint8Array, prompt: SecretWrapPrompt): Promise<WrappedSecret>
	unwrap(wrapped: WrappedSecret, aad: Uint8Array, prompt: SecretWrapPrompt): Promise<Uint8Array>
}

/**
 * D-14 / R-5: the auth window, in seconds, of the vote-record wrap key. D-14's aim is one prompt at
 * Submit and its accepted worst case is two. A 10 s window lets the vote-signing prompt authorise
 * the seal that follows it within a fraction of a second. It is no longer, to keep the "view the
 * saved choices without a prompt right after Submit" gap (R-4) narrow.
 *
 * R-5 decision rule, applied by the device proof (63-18) after it counts the prompts at Submit:
 * - 1 prompt: keep this at 10 and record "one prompt".
 * - 2 prompts, or the windowed path is unstable on device: flip this to 0 and record "two prompts".
 *   0 restores per-use with ZERO native change, because the per-use native path is untouched. A
 *   window that saves no prompt buys nothing and still carries the 10 s residual, so per-use is then
 *   strictly better. Both outcomes satisfy D-14.
 *
 * V1 alias hazard: this value is part of `VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1`'s fixed policy. An
 * install that created V1 under another value gets `WRAP_KEY_POLICY_MISMATCH`, which the vault maps
 * to `policy-mismatch`. The proof therefore runs `pm clear` first, and again after any flip, then
 * re-grants ACCESS_LOCAL_NETWORK. Once a build carrying V1 ships, a change needs a new
 * `VOTETORRENT_VOTE_RECORD_WRAP_KEY_V2` alias; it never deletes V1.
 *
 * iOS ignores the value and stays per-use.
 */
export const VOTE_RECORD_AUTH_WINDOW_SECONDS = 10

/** WR-04: the lowest Android API level whose time-bound key is BIOMETRIC_STRONG-only. */
export const MIN_ANDROID_API_FOR_AUTH_WINDOW = 30

export interface PlatformInfo {
	OS: string
	Version: number | string
}

/**
 * WR-04: the window this platform may actually use. Android below API 30 gets 0 (per-use): the
 * pre-30 time-bound key admits a device PIN and is not invalidated by biometric re-enrollment, which
 * would break D-13. Every other platform gets `VOTE_RECORD_AUTH_WINDOW_SECONDS` (iOS ignores it).
 */
export function voteRecordAuthWindowSeconds(platform: PlatformInfo = Platform): number {
	if (platform.OS === 'android') {
		const level = typeof platform.Version === 'number' ? platform.Version : Number.parseInt(String(platform.Version), 10)
		// An unreadable level is treated as old: per-use is the strictly stronger policy.
		if (!Number.isFinite(level) || level < MIN_ANDROID_API_FOR_AUTH_WINDOW) return 0
	}
	return VOTE_RECORD_AUTH_WINDOW_SECONDS
}

/**
 * The ONLY place the vote alias's wrap options are built. Every vote-record wrap and unwrap is
 * auth-required, with the platform's effective D-14 window (WR-04) unless a caller passes one.
 */
export function voteRecordWrapOptions(
	aad: Uint8Array,
	prompt: SecretWrapPrompt,
	authWindowSeconds: number = voteRecordAuthWindowSeconds(),
): SecretWrapOptions {
	return { requireAuth: true, aad, prompt, authWindowSeconds }
}

function codeOf(err: unknown): string | undefined {
	return err instanceof SecretWrapError ? err.code : undefined
}

/** CR-02: seal-time codes that mean "this alias's key can never be used again". */
const REPLACEABLE_ON_SEAL: ReadonlySet<string> = new Set(['KEY_INVALIDATED', 'NO_WRAP_KEY'])

function canDelete(wrapper: SecretWrapper): wrapper is ReplaceableSecretWrapper {
	return typeof (wrapper as Partial<ReplaceableSecretWrapper>).deleteWrapKey === 'function'
}

export function createVoteRecordWrapProvider(wrapper: SecretWrapper): VoteRecordWrapProvider {
	return {
		async wrap(plaintext, aad, prompt) {
			let window = voteRecordAuthWindowSeconds()
			let fellBackToPerUse = false
			let replaced = false
			// Bounded: at most one per-use fallback and one key replacement, so at most three native
			// calls. A failure after a replacement propagates; it never loops.
			for (;;) {
				try {
					return await wrapper.wrapSecret(VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1, plaintext, voteRecordWrapOptions(aad, prompt, window))
				} catch (err) {
					const code = codeOf(err)
					// WR-04 coherence: an existing per-use key (created below API 30, then the OS was
					// upgraded) is a STRICTER policy than the window asked for, so use it as per-use.
					if (code === 'WRAP_KEY_POLICY_MISMATCH' && window > 0 && !fellBackToPerUse) {
						fellBackToPerUse = true
						window = 0
						continue
					}
					if (code !== undefined && REPLACEABLE_ON_SEAL.has(code) && !replaced && canDelete(wrapper)) {
						replaced = true
						try {
							await wrapper.deleteWrapKey(VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1)
						} catch {
							// The key could not be replaced: report what actually happened to the seal.
							throw err
						}
						window = voteRecordAuthWindowSeconds()
						continue
					}
					throw err
				}
			}
		},
		async unwrap(wrapped, aad, prompt) {
			// Downgrade guard: a tampered envelope must never steer the unwrap to another alias
			// (for example the no-auth identity alias).
			if (wrapped.keyAlias !== VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1) {
				throw new SecretWrapError('INVALID_ARGUMENT', 'vote record wrapped key names an unexpected alias')
			}
			const window = voteRecordAuthWindowSeconds()
			try {
				return await wrapper.unwrapSecret(wrapped, voteRecordWrapOptions(aad, prompt, window))
			} catch (err) {
				// WR-04 coherence, as in wrap. The read path NEVER deletes a key (CR-02).
				if (codeOf(err) === 'WRAP_KEY_POLICY_MISMATCH' && window > 0) {
					return wrapper.unwrapSecret(wrapped, voteRecordWrapOptions(aad, prompt, 0))
				}
				throw err
			}
		},
	}
}

export function createNativeVoteRecordWrapProvider(): VoteRecordWrapProvider {
	return createVoteRecordWrapProvider(createNativeSecretWrapper())
}

let testOverride: VoteRecordWrapProvider | undefined
let nativeProvider: VoteRecordWrapProvider | undefined

/** The jest override if installed, otherwise a lazily constructed, memoised native provider. */
export function resolveVoteRecordWrapProvider(): VoteRecordWrapProvider {
	if (testOverride !== undefined) return testOverride
	if (!nativeProvider) nativeProvider = createNativeVoteRecordWrapProvider()
	return nativeProvider
}

/**
 * TEST ONLY. Sets or clears the override `resolveVoteRecordWrapProvider` returns. Production code
 * must never call this: the setter-reference gate in vote-record-wrap.test.ts enforces that only
 * this file references it outside test files.
 */
export function setVoteRecordWrapProviderForTests(provider: VoteRecordWrapProvider | undefined): void {
	testOverride = provider
}
