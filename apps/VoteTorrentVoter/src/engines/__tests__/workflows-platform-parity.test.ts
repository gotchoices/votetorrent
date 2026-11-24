/**
 * workflows-platform-parity.test.ts (phase 67 plan 03).
 *
 * `@votetorrent/workflows/platform` COPIES the native wrap/prompt/sign-option types instead of importing
 * them (the shared package has no native dependency). This file is where both sides are in scope, so it
 * pins the copies to the native originals with a strict compile-time `Equal<>`: any drift on either side
 * fails `yarn typecheck` on this file. Every import is `import type`, so jest never loads the native
 * module or the shared package at runtime; the one `it` only makes jest report the file.
 */

import type {
	createRealAttestationProducer,
	SecretWrapPrompt as NativeSecretWrapPrompt,
	SignDeviceKeyDigestOptions as NativeSignDeviceKeyDigestOptions,
	WrapKeySecurityLevel as NativeWrapKeySecurityLevel,
	WrappedSecret as NativeWrappedSecret,
} from '@votetorrent/attestation-native'
import type AsyncStorage from '@react-native-async-storage/async-storage'
import type {
	AttestationProducer as PlatformAttestationProducer,
	KvStorage,
	SecretWrapPrompt as PlatformSecretWrapPrompt,
	SignCallback as PlatformSignCallback,
	SignDeviceKeyDigestOptions as PlatformSignDeviceKeyDigestOptions,
	VoteRecordWrapProvider as PlatformVoteRecordWrapProvider,
	VoteSigningProducer as PlatformVoteSigningProducer,
	WrapKeySecurityLevel as PlatformWrapKeySecurityLevel,
	WrappedSecret as PlatformWrappedSecret,
} from '@votetorrent/workflows/platform'
import type { AttestationProducer as AppAttestationProducer } from '../attestation-producer'
import type { SignCallback as AppSignCallback } from '../device-signer'
import type { VoteRecordWrapProvider as AppVoteRecordWrapProvider } from '../vote-record-wrap'

/** Strict identity: true only when A and B are the same type (not merely mutually assignable). */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Assignable<A, B> = [A] extends [B] ? true : false

const secretWrapPromptParity: Equal<PlatformSecretWrapPrompt, NativeSecretWrapPrompt> = true
const wrappedSecretParity: Equal<PlatformWrappedSecret, NativeWrappedSecret> = true
const wrapKeySecurityLevelParity: Equal<PlatformWrapKeySecurityLevel, NativeWrapKeySecurityLevel> = true
const signDeviceKeyDigestOptionsParity: Equal<PlatformSignDeviceKeyDigestOptions, NativeSignDeviceKeyDigestOptions> = true
const realProducerSignsVotes: Assignable<ReturnType<typeof createRealAttestationProducer>, PlatformVoteSigningProducer> = true
const signCallbackParity: Equal<AppSignCallback, PlatformSignCallback> = true
const appStoreIsKvStorage: Assignable<typeof AsyncStorage, KvStorage> = true
const attestationProducerReexport: Equal<AppAttestationProducer, PlatformAttestationProducer> = true
const voteRecordWrapProviderReexport: Equal<AppVoteRecordWrapProvider, PlatformVoteRecordWrapProvider> = true

describe('workflows platform parity (Voter)', () => {
	it('the compile-time pins hold (checked by yarn typecheck)', () => {
		expect([
			secretWrapPromptParity,
			wrappedSecretParity,
			wrapKeySecurityLevelParity,
			signDeviceKeyDigestOptionsParity,
			realProducerSignsVotes,
			signCallbackParity,
			appStoreIsKvStorage,
			attestationProducerReexport,
			voteRecordWrapProviderReexport,
		]).toEqual([true, true, true, true, true, true, true, true, true])
	})
})
