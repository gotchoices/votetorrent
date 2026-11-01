/**
 * NativeAttestation.ts — codegen source of truth for the `AttestationNative` TurboModule
 * (Phase 45-01 scaffold). RN 0.78 new-arch codegen generates the Kotlin
 * `NativeAttestationSpec` base class from this file (see `package.json`'s
 * `codegenConfig`); `AttestationNativeModule.kt` extends that generated base class.
 *
 * D-11 two-step producer seam:
 *   (1) provisionDeviceKey(keyAlias) — generates/returns the hardware-backed P-256
 *       public key (biometric-gated). The authority-issued challenge is bound to
 *       this key's public value.
 *   (2) produceAttestation(keyAlias, boundDigest, boundDigestUtf8Base64, enablePlayIntegrity)
 *       — answers the challenge: returns the key-attestation cert chain + (optionally)
 *       a Play Integrity Classic token.
 *
 * TurboModule codegen types are restrictive (no arbitrary interfaces) — both methods
 * return `Object` (a `WritableMap` on the Kotlin side); the JS wrapper
 * (`RealAttestationProducer`, landing in 45-05) parses/validates the returned shape,
 * exactly as `react-native-localize` returns `Object` for `getNumberFormatSettings()`.
 *
 * OPEN QUESTION 1 (45-RESEARCH.md, NOT resolved by this scaffold plan — do not narrow):
 * this signature deliberately supports BOTH candidate implementations for WHEN the
 * real attested key-generation happens:
 *   (a) `provisionDeviceKey` generates the real attested key immediately, using a
 *       placeholder `setAttestationChallenge` value, then `produceAttestation`
 *       re-reads/regenerates the attestation-carrying cert chain against the real
 *       `boundDigest` once the challenge exists; or
 *   (b) `provisionDeviceKey` only returns a public key (possibly from a
 *       non-attested or previously-provisioned key) and ALL attested key generation
 *       is deferred to `produceAttestation`, which receives the real `boundDigest`
 *       up front and can generate-with-challenge in one step.
 * 45-02 resolves which path via an on-device/emulator experiment (45-RESEARCH.md
 * Open Question 1 / Assumption A2). This spec's shape must not be narrowed to
 * foreclose either option until that experiment lands.
 */
import type { TurboModule } from 'react-native'
import { TurboModuleRegistry } from 'react-native'

export interface Spec extends TurboModule {
	/**
	 * Generates (or returns the existing) hardware-backed P-256 signing key under
	 * `keyAlias`. Biometric-gated per D-06/D-17. Resolves `{ publicKeyBase64, keyAlias,
	 * publicKeyCompressedHex }` — `publicKeyBase64` remains the raw X.509 SPKI DER
	 * (base64), consumed only by the Phase 45 attestation path; `publicKeyCompressedHex`
	 * (Phase 49, D-04/RESEARCH Pattern 4) is the NEW 33-byte compressed SEC1 point,
	 * hex-encoded. Callers registering a `UserKey.PubKey` MUST use
	 * `publicKeyCompressedHex` — `publicKeyBase64` is a DER-wrapped blob, not a valid
	 * `UserKey.PubKey`, and will fail closed (and, per `verify()`'s swallow-all
	 * exception handling, silently) if registered as one.
	 * Scaffold (45-01): rejects with a NOT_IMPLEMENTED-class code — no real Keystore
	 * logic yet (lands in 45-02).
	 */
	provisionDeviceKey(keyAlias: string): Promise<Object>

	/**
	 * 63-18 fix: READ-ONLY lookup of the CURRENT device key under `keyAlias`. Never generates,
	 * deletes, prompts or mutates the Keystore/Keychain — unlike `provisionDeviceKey`, which on
	 * Android regenerates the alias on every call. Resolves the same public-key shape
	 * `provisionDeviceKey` does (`publicKeyBase64` + `publicKeyCompressedHex` on Android;
	 * `publicKeyCompressedHex` on iOS). Rejects `DEVICE_KEY_ABSENT` (no key under the alias),
	 * `DEVICE_KEY_INVALIDATED` (permanently invalidated; never deleted), or
	 * `DEVICE_KEY_READ_FAILED`.
	 */
	getCurrentDeviceKey(keyAlias: string): Promise<Object>

	/**
	 * Answers an already-issued challenge bound to the key from `provisionDeviceKey`.
	 * `boundDigest` is the base64url `Digest(nonce, deviceKey)` string (Play Integrity
	 * Classic nonce, AS-IS); `boundDigestUtf8Base64` is the base64 encoding of the
	 * UTF-8 bytes of that same string (the Keystore `setAttestationChallenge` payload
	 * — an intentional asymmetry, see `packages/vote-engine/ATTESTATION-CONTRACT.md`).
	 * `enablePlayIntegrity` independently gates the Play Integrity Classic leg (D-12).
	 * Resolves `{ certificateChainBase64, integrityToken, androidId,
	 * attestationTimeMillis, publicKeyCompressedHex }` — the last field (49-15, D-04/
	 * D-08) is the 33-byte compressed SEC1 point, hex-encoded, of the key ACTUALLY
	 * present under `keyAlias` after this call's delete-and-regenerate cycle. This is
	 * the **post-regeneration** key: `provisionDeviceKey`'s `publicKeyCompressedHex` is
	 * invalidated by a subsequent `produceAttestation` call on the same alias (the
	 * native side deletes and regenerates the alias with a fresh key pair — see
	 * `KeyAttestationHelper`'s class doc comment). Any caller registering a
	 * `UserKey.PubKey` after calling `produceAttestation` MUST use this field's value,
	 * not the earlier `provisionDeviceKey` one — the discarded key would attribute
	 * every subsequent signature to a `signerKey` that did not produce it, and
	 * `verify()` swallows exceptions and returns `false`, so it fails closed and
	 * silently.
	 * Scaffold (45-01): rejects with a NOT_IMPLEMENTED-class code — no real
	 * attestation logic yet (lands in 45-02).
	 */
	produceAttestation(
		keyAlias: string,
		boundDigest: string,
		boundDigestUtf8Base64: string,
		enablePlayIntegrity: boolean,
	): Promise<Object>

	/**
	 * Spike 104 (R1d), ANDROID ONLY — `provisionDeviceKey` with an attestation chain. The voting key
	 * is generated with `attestationChallengeBase64` (base64 of utf8(`ANDROID_DEVICE_KEY_ATTESTATION_TAG`))
	 * as its attestation challenge, so its own chain can later prove the VOTING key is
	 * hardware-backed — the nonce does not exist yet at this point. Regenerates the alias like
	 * `provisionDeviceKey` and resolves the same shape. iOS rejects `UNSUPPORTED_PLATFORM`.
	 */
	provisionAttestedDeviceKey(keyAlias: string, attestationChallengeBase64: string): Promise<Object>

	/**
	 * Spike 104 (R1d), ANDROID ONLY — answers the challenge WITHOUT replacing the voting key. A
	 * throwaway key is generated with `boundDigestUtf8Base64` as its attestation challenge, its chain
	 * exported and the key deleted; the key under `keyAlias` is never touched (unlike
	 * `produceAttestation`, which deletes and regenerates it). Same arguments and Play Integrity leg
	 * as `produceAttestation`; no biometric prompt. Resolves `{ certificateChainBase64` (the
	 * throwaway, nonce-bound chain), `deviceKeyCertificateChainBase64` (the voting key's own chain),
	 * `integrityToken, androidId, attestationTimeMillis, publicKeyCompressedHex` (the voting key,
	 * unchanged) `}`. Rejects `NO_KEY_PROVISIONED`, `KEY_INVALIDATED_REASSOCIATE`,
	 * `DEVICE_KEY_NOT_ATTESTED`, `NO_STRONGBOX_OR_TEE`, `KEY_ATTESTATION_FAILED`,
	 * `INVALID_CHALLENGE_ENCODING`, `PLAY_INTEGRITY_ERROR`. iOS rejects `UNSUPPORTED_PLATFORM`.
	 */
	produceFreshAttestation(
		keyAlias: string,
		boundDigest: string,
		boundDigestUtf8Base64: string,
		enablePlayIntegrity: boolean,
	): Promise<Object>

	/**
	 * Phase 49 (D-06/D-04): produces a biometric-gated, hardware-backed P-256 signature
	 * over `digestBase64` using the key under `keyAlias`. Resolves
	 * `{ signatureHex: string }` — a 64-byte compact, low-S, hex-encoded signature
	 * (`r||s`, `s` normalized into the lower half of the P-256 order; `lowS: true`,
	 * `format: 'compact'`). Callers must NOT re-normalize the returned signature.
	 *
	 * Signing DOMAIN differs by platform: Android output verifies with `prehash: true` over the
	 * digest; iOS output verifies with `prehash: false` over the bytes given. Callers whose
	 * signature is checked by `verifySigP256` must pass `nativeSignInputBase64(digest, Platform.OS)`.
	 * Applies to `signWithDeviceKey` and `signWithRecoveryKey`.
	 *
	 * Byte-format contract for `digestBase64` — a silent-failure trap if violated:
	 * this is **plain base64 (`Base64.NO_WRAP`) of the RAW digest bytes**, never
	 * base64url, and emphatically never the UTF-8 bytes of a base64url string. This is
	 * deliberately UNLIKE `produceAttestation`'s `boundDigestUtf8Base64` argument, whose
	 * UTF-8-of-a-string encoding is a documented asymmetry required by
	 * `setAttestationChallenge` (see `ATTESTATION-CONTRACT.md` §3). Repeating that
	 * asymmetry here would silently sign the wrong bytes — `verify()` swallows
	 * exceptions and returns `false`, so a wrong-bytes signature looks like an ordinary
	 * "invalid signature" rejection, not a crash.
	 *
	 * `promptTitle`/`promptSubtitle`/`promptNegativeButton` are resolved JS-side via
	 * `t()` — a deliberate widening beyond the Phase 45 precedent, which hardcodes
	 * English in `KeyAttestationHelper.kt`. This project's standing rule is that
	 * user-facing copy lives in `src/i18n/index.ts`. There are exactly 4 distinct
	 * string values across all three call shapes (per-use, provisioning, recovery) —
	 * only the subtitle varies (see `49-UI-SPEC.md` §"Native BiometricPrompt string
	 * contract").
	 *
	 * Rejects with one of the typed codes: `CANCELED`, `SYSTEM_CANCELED`,
	 * `NO_BIOMETRICS_ENROLLED`, `LOCKOUT`, `LOCKOUT_PERMANENT`, `BIOMETRIC_ERROR`,
	 * `KEY_INVALIDATED_REASSOCIATE`, `NO_KEY_PROVISIONED`, `NO_ACTIVITY`,
	 * `INVALID_DIGEST_ENCODING`, `PROMPT_BUSY`.
	 *
	 * `CANCELED`: the voter dismissed the prompt (Android `ERROR_USER_CANCELED`/
	 * `ERROR_NEGATIVE_BUTTON`; iOS `LAError.userCancel`/`.userFallback`/`errSecUserCanceled`), or
	 * the app cancelled it through `cancelPendingSign` (always `CANCELED`, on both platforms).
	 *
	 * `SYSTEM_CANCELED` (Phase 65 review CR-01): the SYSTEM ended the prompt, not the voter: the
	 * app went to the background, the screen locked, a call came in, or the HAL timed out (Android
	 * `ERROR_CANCELED`/5; iOS `LAError.systemCancel`/`.appCancel` when the app did not cancel the
	 * sign itself). It is not a decline. Callers with user copy show their `CANCELED` copy for it.
	 * The vault prompts (`wrapSecret`/`unwrapSecret`) and `produceAttestation` never reject it.
	 *
	 * `NO_ACTIVITY`: the app has no foreground activity that can host a prompt, including (Android)
	 * an activity whose state is already saved because the app is in the background, and a prompt
	 * that androidx.biometric silently did not start for that reason. Nothing was shown.
	 *
	 * `PROMPT_BUSY` (D-112): another biometric prompt is already showing or a sign is pending (on
	 * iOS also: an earlier sign's system call is still running after its cancel hit the 2 s cap);
	 * nothing was shown and nothing will settle later. Callers treat it as a consent not given.
	 */
	signWithDeviceKey(
		keyAlias: string,
		digestBase64: string,
		promptTitle: string,
		promptSubtitle: string,
		promptNegativeButton: string,
	): Promise<Object>

	/**
	 * Phase 49 (D-16/D-07): provisions the Authority app's second Keystore alias — a
	 * `DEVICE_CREDENTIAL`-authenticated key that `setInvalidatedByBiometricEnrollment` does NOT
	 * govern, so it survives a biometric re-enrolment that would otherwise permanently strand the
	 * primary `signWithDeviceKey` alias. Unlike `provisionDeviceKey`'s two-step placeholder-then-
	 * attested dance (D-11, a Voter-app attestation concern this key has no analog for), this
	 * resolves the SAME shape in one step — `{ publicKeyBase64, keyAlias, publicKeyCompressedHex }`
	 * — with no attestation challenge: this key exists purely to sign a replacement key back into
	 * `UserKey` (D-16), not to produce a verifier-consumed cert chain.
	 *
	 * `keyAlias` should be the canonical `VOTETORRENT_AUTHORITY_RECOVERY_KEY_V1` value (distinct
	 * from `VOTETORRENT_AUTHORITY_SIGNING_KEY_V1` and from the Voter app's
	 * `VOTETORRENT_DEVICE_KEY_V1` — D-07, different apps, different threat surfaces).
	 *
	 * **Unproven until D-24 leg 3 on real hardware** — do not take biometric-re-enrolment survival
	 * from the docs (D-16).
	 */
	provisionRecoveryKey(keyAlias: string): Promise<Object>

	/**
	 * Phase 49 (D-16/D-26/D-18): produces a device-credential-authenticated, hardware-backed P-256
	 * signature over `digestBase64` using the recovery key under `keyAlias`. Resolves the same
	 * `{ signatureHex: string }` shape as `signWithDeviceKey`, with the identical byte-format
	 * contract for `digestBase64` (plain base64 of raw digest bytes, never base64url, never
	 * UTF-8-of-a-string).
	 *
	 * Recovery is supported ONLY on API 30+, where this authenticates via `BiometricPrompt` with
	 * `setAllowedAuthenticators(DEVICE_CREDENTIAL)` — no negative button, since the platform
	 * forbids combining a negative button with a device-credential authenticator.
	 * `promptNegativeButton` is IGNORED on every path (kept as a parameter for ABI stability).
	 *
	 * **Recovery is explicitly unsupported below API 30 (D-26a rescope, 2026-08-21).** The native
	 * layer rejects `RECOVERY_UNSUPPORTED_OS` before obtaining a key handle or launching any UI —
	 * measured, not assumed: the recovery key is auth-per-use below API 30, and the only
	 * below-API-30 authentication mechanism available to this app is a time-bound one that cannot
	 * authorize an auth-per-use key (n=2, Redmi 8 / API 29 — see
	 * `.planning/todos/pending/2026-08-19-d26-keyguard-fallback-cannot-authorize-per-use-key.md`).
	 *
	 * Rejects with one of `signWithDeviceKey`'s typed codes, plus two further terminal codes:
	 * `NO_DEVICE_CREDENTIAL` (D-18) — the device has no screen lock configured at all, so no
	 * recovery ceremony can succeed regardless of API level. Distinct from `BIOMETRIC_ERROR`, which
	 * implies a ceremony was actually attempted and failed; this device state is checked BEFORE the
	 * OS-version check and any ceremony begins.
	 * `RECOVERY_UNSUPPORTED_OS` (D-26a rescope) — see above.
	 *
	 * `PROMPT_BUSY` (D-112) applies to `signWithRecoveryKey` too: another biometric prompt is already
	 * showing or a sign is pending; nothing was shown and nothing will settle later.
	 * `SYSTEM_CANCELED` and `NO_ACTIVITY` mean the same as for `signWithDeviceKey`: the system, not
	 * the voter, ended the prompt; no activity could host it.
	 *
	 * **Unproven at runtime** — the API 30+ branch is proven by D-24 leg 3 on real hardware
	 * (Samsung SM-M166P, API 36) in 49-14.
	 * Compilation is not evidence of it.
	 */
	signWithRecoveryKey(
		keyAlias: string,
		digestBase64: string,
		promptTitle: string,
		promptSubtitle: string,
		promptNegativeButton: string,
	): Promise<Object>

	/**
	 * D-110/D-111/D-113: dismisses a pending device-key or recovery-key sign. Resolves
	 * `{ canceled: boolean }`: `true` only when a pending sign existed and has now settled (its own
	 * promise rejected `CANCELED`); `false` when nothing was pending. Never rejects for "nothing
	 * pending". Resolves only after the pending sign has settled and, on Android, its prompt is
	 * gone, or after a 2 s native cap, whichever is first. Never cancels a wrapSecret/unwrapSecret
	 * (vault) prompt. Either way the cancelled sign no longer holds the pending-sign slot when this
	 * resolves. On Android a prompt that has not detached within the cap can still make the next sign
	 * `PROMPT_BUSY`; on iOS a next sign issued while the old system call is still running (cap
	 * expired) is refused `PROMPT_BUSY` at once, never queued behind it (review WR-06).
	 */
	cancelPendingSign(): Promise<Object>

	/**
	 * D-42: wraps an arbitrary `plaintextBase64` secret (1..4096 bytes) under a generic,
	 * alias-keyed, non-exportable AES-256-GCM key. This is a SEPARATE capability from the P-256
	 * signing keys above — it protects a secret AT REST (encrypt/decrypt), not a signing operation.
	 * One alias = one auth policy, forever: `requireAuth` AND `authWindowSeconds` are fixed when the
	 * alias's wrap key is first created, and a later call with a different `requireAuth` for the
	 * SAME alias rejects `WRAP_KEY_POLICY_MISMATCH` rather than silently downgrading or upgrading it.
	 *
	 * `authWindowSeconds` (D-14, Phase 63 plan 16) is an integer 0..60; 0 means per-use. A value
	 * above 0 means one successful biometric authentication keeps the key usable for that many
	 * seconds with no `CryptoObject`. It is only valid with `requireAuth` true. Android honours a
	 * window above 0 with a time-bound key (try-init, then one prompt without a CryptoObject); iOS
	 * accepts and ignores it, so it stays per-use (D-14 accept-two).
	 *
	 * Byte contract, identical on both platforms: `plaintextBase64`/`ciphertextBase64` are PLAIN
	 * standard-alphabet base64 (NEVER base64url). The native side generates a fresh 12-byte IV per
	 * call (`ivBase64`, also plain base64) — callers never supply one. `ciphertextBase64` decodes to
	 * `GCM ciphertext || 16-byte tag`. `aadBase64` decodes to the AAD bytes bound into the GCM tag
	 * (may be empty, but is still authenticated).
	 *
	 * The prompt strings (`promptTitle`/`promptSubtitle`/`promptNegativeButton`) are used ONLY when
	 * `requireAuth` is true — JS resolves them via `t()` and passes `''` for all three when
	 * `requireAuth` is false.
	 *
	 * Resolves `{ ciphertextBase64, ivBase64, keyAlias, securityLevel }`, where `securityLevel` is
	 * one of `'strongbox' | 'tee' | 'software' | 'keychain' | 'unknown'` — reported, never asserted;
	 * this module makes no hardware-backing guarantee beyond what the OS actually reports.
	 *
	 * Platform implementation: Android — AndroidKeyStore AES-256-GCM, non-exportable. iOS — a
	 * Keychain-stored AES-256 key (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`), used through
	 * CryptoKit; this is explicitly NOT a Secure Enclave key — the Secure Enclave holds only EC
	 * P-256 keys (there is no `kSecAttrKeyTypeAES`).
	 *
	 * Rejects with one of the closed set of typed codes: `INVALID_ARGUMENT`, `INVALID_ENCODING`,
	 * `NO_WRAP_KEY`, `WRAP_KEY_POLICY_MISMATCH`, `UNWRAP_TAG_MISMATCH`, `KEY_INVALIDATED`,
	 * `DEVICE_LOCKED`, `CANCELED`, `NO_BIOMETRICS_ENROLLED`, `LOCKOUT`, `LOCKOUT_PERMANENT`,
	 * `BIOMETRIC_ERROR`, `NO_ACTIVITY`, `WRAP_FAILED`, `UNWRAP_FAILED`.
	 *
	 * Unproven on device: D-23 proof debt. Compilation/jest-against-a-faked-TurboModule is not
	 * evidence of real Keystore/Keychain behaviour.
	 */
	wrapSecret(
		keyAlias: string,
		plaintextBase64: string,
		aadBase64: string,
		requireAuth: boolean,
		promptTitle: string,
		promptSubtitle: string,
		promptNegativeButton: string,
		authWindowSeconds: number,
	): Promise<Object>

	/**
	 * D-42: the inverse of `wrapSecret` — decrypts a `WrappedSecret` previously produced by
	 * `wrapSecret` under the SAME `keyAlias`, `ivBase64`, `aadBase64`, `requireAuth` and `authWindowSeconds`. Resolves
	 * `{ plaintextBase64 }` (plain standard-alphabet base64 of the decrypted bytes).
	 *
	 * `aadBase64` MUST equal the AAD used at wrap time, or the GCM tag check fails and this rejects
	 * `UNWRAP_TAG_MISMATCH` — this is how a caller binds ciphertext to a specific record (for
	 * example `userId|pubKeyHex`) so a ciphertext cannot be silently transplanted onto a different
	 * record. A missing wrap key (alias never created, or the device was restored from a backup
	 * that carries no Keystore/Keychain state) rejects `NO_WRAP_KEY`, decided before any auth prompt.
	 *
	 * Same closed reject-code set, byte contract, auth-prompt gating and platform implementation as
	 * `wrapSecret` (see that method's doc comment). Unproven on device: D-23 proof debt.
	 */
	unwrapSecret(
		keyAlias: string,
		ciphertextBase64: string,
		ivBase64: string,
		aadBase64: string,
		requireAuth: boolean,
		promptTitle: string,
		promptSubtitle: string,
		promptNegativeButton: string,
		authWindowSeconds: number,
	): Promise<Object>

	/**
	 * Phase 63 review CR-02: deletes the wrap key under `keyAlias` so the next `wrapSecret` creates a
	 * fresh one. Used ONLY to replace a vote-record wrap key that a biometric enrollment change
	 * invalidated. Every ciphertext wrapped under the deleted key becomes permanently unreadable, which
	 * is already true of an invalidated key.
	 *
	 * Restricted, natively and in JS, to the vote-record alias family
	 * `^VOTETORRENT_VOTE_RECORD_WRAP_KEY_V[0-9]+$`. Any other alias (the identity wrap key, the
	 * device signing key, the recovery key) rejects `INVALID_ARGUMENT` before the Keystore/Keychain is
	 * touched. Resolves `{ deleted: boolean }` (`false` when no key existed). Rejects
	 * `INVALID_ARGUMENT`, `WRAP_KEY_POLICY_MISMATCH` (the alias holds something other than an AES wrap
	 * key; never deleted) or `WRAP_FAILED`.
	 */
	deleteWrapKey(keyAlias: string): Promise<Object>

	/**
	 * Phase 63 review CR-01: Android adds (`enabled` true) or clears (`false`) `FLAG_SECURE` on the
	 * current Activity's window, on the UI thread, so the task-switcher snapshot and screenshots of a
	 * screen showing decrypted choices are blank. Resolves `{ applied: boolean }`. Rejects
	 * `NO_ACTIVITY` or `SECURE_SCREEN_FAILED`. iOS has no equivalent flag: it resolves
	 * `{ applied: false }` and the screen renders its own privacy cover on `inactive` instead.
	 */
	setSecureScreen(enabled: boolean): Promise<Object>

	/**
	 * Phase 63 review WR-03: SYNCHRONOUS. Copies `text` to the system clipboard marked sensitive.
	 * Android: a plain-text `ClipData` whose description extras carry
	 * `ClipDescription.EXTRA_IS_SENSITIVE` (API 33+; the same `android.content.extra.IS_SENSITIVE` key
	 * by literal below 33), so the Android 13+ clipboard overlay hides the preview and keyboards do not
	 * keep it in clipboard history; a best-effort clear runs 60 s later if the clip is still ours.
	 * iOS: `UIPasteboard` items with `localOnly` (no Universal Clipboard) and a 60 s expiration.
	 * Returns `true` when the copy was issued, `false` when it failed. Never throws.
	 */
	copySensitiveText(text: string): boolean

	/**
	 * Writes UTF-8 `contents` to a per-app cache file named `fileName` inside a private `vt-share`
	 * directory (Android `cacheDir/vt-share`, iOS `NSTemporaryDirectory()/vt-share`), emptying that
	 * directory first so only the newest export lingers. Resolves `{ uri }` (a `file://` URI).
	 *
	 * `fileName` must match `^[A-Za-z0-9._-]{1,100}$` and must not contain `..`. Reject codes:
	 * `INVALID_NAME`, `WRITE_FAILED`.
	 */
	writeShareFile(fileName: string, contents: string): Promise<Object>

	/**
	 * Android only: shares the cache file at `uri` (a `file://` URI inside `vt-share`) AS A FILE via
	 * `ACTION_SEND` + `EXTRA_STREAM` (a `content://` URI from a private FileProvider, read grant
	 * only). Resolves `{ launched: true }`. Reject codes: `SHARE_FAILED`, `UNSUPPORTED` (always on
	 * iOS, which shares through RN `Share.share({ url })` instead).
	 */
	shareFile(uri: string, mimeType: string, subject: string, dialogTitle: string): Promise<Object>

	/**
	 * Deletes the regular file at the `file://` `uri` when it lies strictly inside the app cache
	 * directory (Android `context.cacheDir`, iOS `NSCachesDirectory`); resolves `{ deleted: boolean }`.
	 * Reject codes: `OUTSIDE_CACHE` (anything else: another directory, the cache root itself, a
	 * non-file), `DELETE_FAILED`.
	 */
	deleteCachedFile(uri: string): Promise<Object>
}

export default TurboModuleRegistry.getEnforcing<Spec>('AttestationNative')
