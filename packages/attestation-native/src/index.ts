/**
 * index.ts — public entry point for `@votetorrent/attestation-native` (Phase 45-01 scaffold,
 * extended in 45-05 with the JS orchestration layer).
 *
 * IMPORTANT: this barrel does NOT re-export the `AttestationNative` default TurboModule instance
 * (45-01's original scaffold did — dropped in 45-05, Rule 1 fix). A static `export ... from`
 * unconditionally evaluates the source module when the BARREL is imported, regardless of which
 * named export the importer actually uses — so re-exporting `AttestationNative` here would make
 * every consumer of this package (even one only wanting `createRealAttestationProducer`) eagerly
 * trigger `TurboModuleRegistry.getEnforcing('AttestationNative')` at import time, throwing under
 * Node/jest (`__fbBatchedBridgeConfig is not set`). Nothing outside this package imports
 * `AttestationNative`/`NativeAttestationSpec` directly — `real-attestation-producer.ts`'s
 * `getNative()` already accesses the native module lazily via a scoped `require()` (see that
 * file's header comment), which is the only sanctioned access path.
 */
export type { Spec as NativeAttestationSpec } from './specs/NativeAttestation'

// 45-05: the RealAttestationProducer JS orchestration — BOUND_DIGEST computation (D-06,
// byte-for-byte matching the authority verifier's recomputeChallengeDigest), the D-16b
// module-load probe, and the injectable createRealAttestationProducer({ enablePlayIntegrity })
// factory driving the two-step TurboModule seam.
export {
	computeBoundDigest,
	// iOS §3.1/§4 digests. Exported so the vote-engine verifier's independent copies can be pinned
	// against these in a cross-implementation agreement test — the two must never drift.
	computeAssertionDigest,
	computePopDigest,
	createRealAttestationProducer,
	DEFAULT_DEVICE_KEY_SIGN_PROMPT,
} from './real-attestation-producer'
export type { SignDeviceKeyDigestOptions } from './real-attestation-producer'

// D-42 (Phase 62 plan 08): the generic, alias-keyed AES-256-GCM secret-wrap capability consumed
// by this plan's Voter `device-key-wrap.ts` and by later plans (62-21, 62-26) in other apps. Same
// "no re-export of the TurboModule default" rule as above — `secret-wrap.ts`'s own `getNative()`
// stays the only access path, lazily required inside each call.
export {
	VOTETORRENT_VOTER_IDENTITY_WRAP_KEY_V1,
	WRAP_KEY_ALIAS_PATTERN,
	VOTE_RECORD_WRAP_KEY_ALIAS_PATTERN,
	isDeletableWrapKeyAlias,
	MAX_AUTH_WINDOW_SECONDS,
	isValidWrapKeyAlias,
	SECRET_WRAP_ERROR_CODES,
	SecretWrapError,
	createNativeSecretWrapper,
} from './secret-wrap'
export type {
	WrapKeySecurityLevel,
	WrappedSecret,
	SecretWrapPrompt,
	SecretWrapOptions,
	SecretWrapper,
	ReplaceableSecretWrapper,
	SecretWrapErrorCode,
} from './secret-wrap'

// Keyholder prompt batching: public-key sealing of small secrets (seal never prompts, unseal prompts
// once). Same lazy-native rule as secret-wrap.ts.
export {
	SEAL_KEY_ALIAS_PATTERN,
	MAX_SEAL_PLAINTEXT_BYTES,
	SEAL_ALGORITHMS,
	SECRET_SEAL_ERROR_CODES,
	SecretSealError,
	isValidSealKeyAlias,
	createNativeSecretSealer,
} from './secret-seal'
export type { SealAlgorithm, SealSecurityLevel, SealedSecret, SecretSealPrompt, SecretSealer, SecretSealErrorCode } from './secret-seal'

// Phase 62 plan 75 (D-36): write a cache file and share it AS A FILE. Named exports only — same
// "no re-export of the TurboModule default" rule as above; `file-share.ts` requires it lazily.
export { FileShareError, writeShareFile, shareFileAndroid, deleteCachedFile } from './file-share'
export type { FileShareErrorCode } from './file-share'

// Phase 63 review (CR-01, WR-03): FLAG_SECURE toggle and sensitive clipboard copy. Named exports
// only; `secure-surface.ts` requires the TurboModule lazily and never throws.
export { setSecureScreen, copySensitiveText } from './secure-surface'
export type { SensitiveCopyResult } from './secure-surface'

// Phase 65 gap 1 (D-110): dismiss a pending device-key or recovery-key sign. Named exports only;
// `sign-cancel.ts` requires the TurboModule lazily and never throws.
export { cancelPendingSign, SIGN_CANCEL_JS_CAP_MS } from './sign-cancel'

// Phase 62 plan 90 (gap 2): the single definition of the bytes native signs for verifySigP256-checked
// signatures. Pure module (no TurboModule), safe in the barrel.
export { nativeSignInputBytes, nativeSignInputBase64 } from './native-sign-input'
