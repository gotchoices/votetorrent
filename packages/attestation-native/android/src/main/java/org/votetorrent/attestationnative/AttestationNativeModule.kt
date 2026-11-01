package org.votetorrent.attestationnative

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.util.Base64
import android.util.Log
import android.view.WindowManager
import androidx.biometric.BiometricManager
import androidx.fragment.app.FragmentActivity
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.module.annotations.ReactModule
import java.util.concurrent.atomic.AtomicBoolean

/**
 * AttestationNativeModule — the `AttestationNative` TurboModule implementation (Phase 45-02:
 * real StrongBox/TEE key attestation + Play Integrity Classic, filling the 45-01 reject-stubbed
 * skeleton). Delegates all platform-API work to [KeyAttestationHelper] / [PlayIntegrityHelper];
 * this class only wires the two-step D-11 producer seam and owns the D-09 reject-code mapping.
 *
 * OPEN QUESTION 1 — RESOLVED (see 45-02-PLAN.md "Open Question resolutions"): placeholder-
 * provision + regenerate-at-produce. `provisionDeviceKey` generates the P-256 key ONCE with an
 * empty/placeholder attestation challenge (no biometric, D-16 biometric-last);
 * `produceAttestation` deletes and REGENERATES the same alias with the real
 * `setAttestationChallenge(utf8(BOUND_DIGEST))`, biometric-gated.
 *
 * D-09 three-way reject-code mapping (two failure surfaces — 45-RESEARCH.md Common Pitfall 3):
 *   - recoverable-action: `NO_BIOMETRICS_ENROLLED` (BiometricPrompt `ERROR_NO_BIOMETRICS`).
 *   - recoverable-transient: `LOCKOUT` (`ERROR_LOCKOUT`/`ERROR_LOCKOUT_PERMANENT`) and
 *     `PLAY_INTEGRITY_ERROR` (Play Integrity network/timeout — the key-attestation leg already
 *     succeeded when this fires).
 *   - terminal: `NO_STRONGBOX_OR_TEE` (release-only — reachable ONLY because
 *     `BuildConfig.DEBUG`/`__DEV__` short-circuits the software/stub rung via
 *     [KeyAttestationHelper], D-07/D-09, so the emulator is never blocked) and
 *     `KEY_INVALIDATED_REASSOCIATE` (D-13 — routed to forced re-association, not a plain
 *     terminal failure). **CORRECTED 2026-08-24: [produceAttestation] never emits
 *     `KEY_INVALIDATED_REASSOCIATE`** — its arm was removed as provably dead
 *     ([KeyAttestationHelper.regenerateAttested] regenerates the key before signing with it, so
 *     nothing can invalidate it). The code is still emitted, for real, by [signWithDeviceKey] and
 *     [signWithRecoveryKey], which sign with a persistent key.
 *
 * Phase 49 (D-13) extends this taxonomy for [signWithDeviceKey] with three new classes:
 *   - `cancellation`: `CANCELED` (`ERROR_CANCELED`/`ERROR_USER_CANCELED`/`ERROR_NEGATIVE_BUTTON`)
 *     — a neutral dismissal, never rendered as an error screen and never logged as a fault
 *     (49-UI-SPEC.md). 49-15/Gap B widened this classification to [produceAttestation] as well
 *     (via [KeyAttestationHelper.regenerateAttested]'s `onAuthenticationError`) — that is the
 *     ONLY signing prompt reachable from a `pm clear` device, so it, not [signWithDeviceKey], is
 *     the site that actually closes Gap B. The raw BiometricPrompt `errorCode` each of the three
 *     `onAuthenticationError` sites received is logged at INFO under the `VtSigningReject` tag,
 *     specifically so the emulator-vs-hardware question 49-13 left open (whether a real device
 *     ever delivers `ERROR_CANCELED`/5 for a negative-button/BACK dismissal, versus 10/13) stays
 *     answerable from a 49-14 hardware run.
 *     Phase 65 review CR-01 narrows this for the two persistent-key SIGN paths
 *     ([signWithDeviceKey], [signWithRecoveryKey]) only: there `ERROR_CANCELED`/5 (the system
 *     ended the prompt: app backgrounded, screen locked, incoming call, HAL timeout) rejects
 *     `SYSTEM_CANCELED`, and only 10/13 reject `CANCELED`. [produceAttestation] and the vault
 *     prompts keep mapping all three to `CANCELED`.
 *   - `LOCKOUT_PERMANENT` is now a DISTINCT recoverable-transient entry, split out from the plain
 *     `LOCKOUT` class above (different remediation copy) — [regenerateAttested]'s own mapping is
 *     NOT retroactively changed to match; it keeps collapsing both lockout codes into `LOCKOUT`.
 *   - `NO_KEY_PROVISIONED` is a routing (not terminal) class: the Keystore alias simply does not
 *     exist yet, detected BEFORE any prompt is shown — 49-UI-SPEC.md's explicitly-flagged sixth
 *     condition, sibling to (not a redefinition of) D-13's original five codes.
 *
 * Plan 06 (D-16/D-26/D-18) adds [signWithRecoveryKey] and one further TERMINAL class:
 *   - `NO_DEVICE_CREDENTIAL`: the device has no screen lock configured at all. TERMINAL, not
 *     routing — distinct from `KEY_INVALIDATED_REASSOCIATE`, which routes the caller back into a
 *     re-provisioning ceremony that CAN succeed. Removing the lock screen destroys both the
 *     primary signing key and the recovery key (the device credential IS the lock screen, D-18's
 *     boundary); there is no on-device ceremony this code could route the caller into.
 *
 * Plan 19 (D-26a rescope, 2026-08-21) adds one further TERMINAL class to [signWithRecoveryKey]:
 *   - `RECOVERY_UNSUPPORTED_OS`: the device's `Build.VERSION.SDK_INT` is below the minimum
 *     required for a recovery ceremony to ever complete (measured — see
 *     [KeyAttestationHelper.signWithRecoveryKey]'s doc comment). TERMINAL, not routing, for the
 *     same reason as `NO_DEVICE_CREDENTIAL`: no on-device ceremony exists that this code could
 *     route the caller into.
 *
 * Phase 65 gap 1 adds one further class to [signWithDeviceKey] and [signWithRecoveryKey] and one
 * method:
 *   - `PROMPT_BUSY` (D-112): another sign is pending or a BiometricFragment is already attached.
 *     Nothing was shown and nothing will settle later; decided BEFORE a BiometricPrompt is built.
 *   - [cancelPendingSign] (D-110/D-111): rejects the pending sign `CANCELED`, dismisses its prompt on
 *     the UI thread and resolves `{canceled}` once the prompt is gone (2 s cap). Never rejects and
 *     never touches a wrap/unwrap prompt.
 */
@ReactModule(name = AttestationNativeModule.NAME)
class AttestationNativeModule(reactContext: ReactApplicationContext) :
	NativeAttestationSpec(reactContext) {

	private val keyAttestationHelper by lazy { KeyAttestationHelper(reactApplicationContext) }
	private val playIntegrityHelper by lazy { PlayIntegrityHelper(reactApplicationContext) }
	private val secretWrapHelper by lazy { SecretWrapHelper(reactApplicationContext) }

	override fun getName(): String {
		return NAME
	}

	override fun provisionDeviceKey(keyAlias: String, promise: Promise) {
		try {
			val result = keyAttestationHelper.generateProvisionKey(keyAlias)
			promise.resolve(Arguments.createMap().apply {
				putString("publicKeyBase64", result.publicKeyBase64)
				putString("keyAlias", result.keyAlias)
				putString("securityLevel", result.securityLevel)
				// Phase 49 (D-04/RESEARCH Pattern 4) — the 33-byte compressed SEC1 point callers
				// must register as UserKey.PubKey; publicKeyBase64 above stays the raw SPKI DER.
				putString("publicKeyCompressedHex", result.publicKeyCompressedHex)
			})
		} catch (e: NoStrongBoxOrTeeException) {
			// D-09 terminal, release-only (see class doc comment).
			promise.reject("NO_STRONGBOX_OR_TEE", e)
		} catch (e: Exception) {
			// A BIOMETRIC_STRONG key cannot be generated with no biometric enrolled — Keystore
			// throws a generic InvalidAlgorithmParameterException that would otherwise surface as
			// PROVISION_FAILED ("Couldn't verify your biometrics"). Only AFTER keygen has failed,
			// ask whether that is the reason, and if so report the actionable, already-mapped
			// NO_BIOMETRICS_ENROLLED code. Success paths are untouched.
			if (noBiometricEnrolled()) {
				promise.reject("NO_BIOMETRICS_ENROLLED", e)
			} else {
				promise.reject("PROVISION_FAILED", e)
			}
		}
	}

	override fun getCurrentDeviceKey(keyAlias: String, promise: Promise) {
		try {
			// READ-ONLY (63-18 fix): never generates, prompts or mutates the Keystore.
			val result = keyAttestationHelper.readCurrentKey(keyAlias)
			promise.resolve(Arguments.createMap().apply {
				putString("publicKeyBase64", result.publicKeyBase64)
				putString("keyAlias", result.keyAlias)
				putString("securityLevel", result.securityLevel)
				putString("publicKeyCompressedHex", result.publicKeyCompressedHex)
			})
		} catch (e: DeviceKeyAbsentException) {
			promise.reject("DEVICE_KEY_ABSENT", e)
		} catch (e: DeviceKeyInvalidatedException) {
			promise.reject("DEVICE_KEY_INVALIDATED", e)
		} catch (e: Exception) {
			promise.reject("DEVICE_KEY_READ_FAILED", e)
		}
	}

	/**
	 * Spike 104 (R1d) — [provisionDeviceKey] with an attestation chain: the voting key is generated
	 * with `attestationChallengeBase64` (the fixed provisioning tag) so its own chain can prove it is
	 * hardware-backed. Same resolve map and reject codes as [provisionDeviceKey], plus
	 * `INVALID_CHALLENGE_ENCODING` for an undecodable or empty challenge.
	 */
	override fun provisionAttestedDeviceKey(keyAlias: String, attestationChallengeBase64: String, promise: Promise) {
		val challengeBytes: ByteArray = try {
			Base64.decode(attestationChallengeBase64, Base64.NO_WRAP)
		} catch (e: Exception) {
			promise.reject("INVALID_CHALLENGE_ENCODING", e)
			return
		}
		if (challengeBytes.isEmpty()) {
			promise.reject("INVALID_CHALLENGE_ENCODING", "attestation challenge is empty")
			return
		}
		try {
			val result = keyAttestationHelper.generateAttestedProvisionKey(keyAlias, challengeBytes)
			promise.resolve(Arguments.createMap().apply {
				putString("publicKeyBase64", result.publicKeyBase64)
				putString("keyAlias", result.keyAlias)
				putString("securityLevel", result.securityLevel)
				putString("publicKeyCompressedHex", result.publicKeyCompressedHex)
			})
		} catch (e: NoStrongBoxOrTeeException) {
			promise.reject("NO_STRONGBOX_OR_TEE", e)
		} catch (e: Exception) {
			if (noBiometricEnrolled()) {
				promise.reject("NO_BIOMETRICS_ENROLLED", e)
			} else {
				promise.reject("PROVISION_FAILED", e)
			}
		}
	}

	/**
	 * Spike 104 (R1d) — answer the challenge with a THROWAWAY key, leaving the voting key under
	 * `keyAlias` untouched (see [KeyAttestationHelper.attestFresh]). Same arguments and Play Integrity
	 * leg as [produceAttestation]; no biometric prompt. Resolves `{ certificateChainBase64` (the
	 * throwaway key's nonce-bound chain), `deviceKeyCertificateChainBase64` (the voting key's own
	 * chain), `integrityToken, androidId, attestationTimeMillis, publicKeyCompressedHex` (the voting
	 * key, unchanged) `}`. Rejects `NO_KEY_PROVISIONED`, `KEY_INVALIDATED_REASSOCIATE`,
	 * `DEVICE_KEY_NOT_ATTESTED`, `NO_STRONGBOX_OR_TEE`, `KEY_ATTESTATION_FAILED`,
	 * `INVALID_CHALLENGE_ENCODING`, `PLAY_INTEGRITY_ERROR`.
	 */
	override fun produceFreshAttestation(
		keyAlias: String,
		boundDigest: String,
		boundDigestUtf8Base64: String,
		enablePlayIntegrity: Boolean,
		promise: Promise,
	) {
		// ATTESTATION-CONTRACT.md §3 — the exact setAttestationChallenge bytes, computed JS-side.
		val challengeBytes: ByteArray = try {
			Base64.decode(boundDigestUtf8Base64, Base64.NO_WRAP)
		} catch (e: Exception) {
			promise.reject("INVALID_CHALLENGE_ENCODING", e)
			return
		}

		val fresh: FreshAttestation = try {
			keyAttestationHelper.attestFresh(keyAlias, challengeBytes)
		} catch (e: DeviceKeyAbsentException) {
			promise.reject("NO_KEY_PROVISIONED", e)
			return
		} catch (e: DeviceKeyInvalidatedException) {
			promise.reject("KEY_INVALIDATED_REASSOCIATE", e)
			return
		} catch (e: DeviceKeyNotAttestedException) {
			promise.reject("DEVICE_KEY_NOT_ATTESTED", e)
			return
		} catch (e: NoStrongBoxOrTeeException) {
			promise.reject("NO_STRONGBOX_OR_TEE", e)
			return
		} catch (e: Exception) {
			promise.reject("KEY_ATTESTATION_FAILED", e)
			return
		}

		playIntegrityHelper.requestToken(
			boundDigest = boundDigest,
			enablePlayIntegrity = enablePlayIntegrity,
			onResult = { integrityToken ->
				promise.resolve(Arguments.createMap().apply {
					putArray("certificateChainBase64", Arguments.createArray().apply {
						fresh.freshCertificateChain.forEach { pushString(it) }
					})
					putArray("deviceKeyCertificateChainBase64", Arguments.createArray().apply {
						fresh.deviceKeyCertificateChain.forEach { pushString(it) }
					})
					putString("integrityToken", integrityToken)
					putString("androidId", playIntegrityHelper.getDeviceId())
					putDouble("attestationTimeMillis", System.currentTimeMillis().toDouble())
					putString("publicKeyCompressedHex", fresh.deviceKeyCompressedHex)
				})
			},
			onError = { e ->
				// recoverable-transient (D-09) — the key-attestation leg already succeeded.
				promise.reject("PLAY_INTEGRITY_ERROR", e)
			},
		)
	}

	private fun noBiometricEnrolled(): Boolean =
		BiometricManager.from(reactApplicationContext)
			.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) ==
			BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED

	override fun provisionRecoveryKey(keyAlias: String, promise: Promise) {
		try {
			// Phase 49 (D-16) — the recovery variant of the shared keygen: one-step, no attestation
			// challenge, KeyAuthenticator.DEVICE_CREDENTIAL bitmask (API 30+) so this key survives a
			// biometric re-enrolment that would strand VOTETORRENT_AUTHORITY_SIGNING_KEY_V1.
			// 49-14 follow-up — now idempotent: an existing, still-usable alias is reused (its
			// public value returned as-is) rather than unconditionally regenerated. See
			// KeyAttestationHelper.generateRecoveryKey's doc comment.
			val result = keyAttestationHelper.generateRecoveryKey(keyAlias)
			promise.resolve(Arguments.createMap().apply {
				putString("publicKeyBase64", result.publicKeyBase64)
				putString("keyAlias", result.keyAlias)
				putString("securityLevel", result.securityLevel)
				putString("publicKeyCompressedHex", result.publicKeyCompressedHex)
			})
		} catch (e: RecoveryKeyInvalidatedException) {
			// 49-14 follow-up (D-16 observability defect) — the existing recovery key is
			// PERMANENTLY invalidated. This is the D-16 FAIL signal: it must reach JS as its own
			// distinct, classified code — never silently regenerated (that would destroy the very
			// evidence this signal exists to preserve) and never collapsed into the generic
			// PROVISION_FAILED/biometric-error bucket a caller would render as
			// "Couldn't verify your biometrics."
			promise.reject("RECOVERY_KEY_INVALIDATED", e)
		} catch (e: NoStrongBoxOrTeeException) {
			// D-09 terminal, release-only (see class doc comment) — same taxonomy as provisionDeviceKey.
			promise.reject("NO_STRONGBOX_OR_TEE", e)
		} catch (e: Exception) {
			promise.reject("PROVISION_FAILED", e)
		}
	}

	override fun produceAttestation(
		keyAlias: String,
		boundDigest: String,
		boundDigestUtf8Base64: String,
		enablePlayIntegrity: Boolean,
		promise: Promise,
	) {
		val activity = reactApplicationContext.currentActivity as? FragmentActivity
		if (activity == null) {
			promise.reject("NO_ACTIVITY", "no current FragmentActivity available to host the BiometricPrompt")
			return
		}

		// ATTESTATION-CONTRACT.md §3 — these are the EXACT bytes for setAttestationChallenge; the
		// module does NOT recompute them, only decodes what JS (45-05) already computed.
		val challengeBytes: ByteArray = try {
			Base64.decode(boundDigestUtf8Base64, Base64.NO_WRAP)
		} catch (e: Exception) {
			promise.reject("INVALID_CHALLENGE_ENCODING", e)
			return
		}

		keyAttestationHelper.regenerateAttested(
			keyAlias = keyAlias,
			attestationChallengeBytes = challengeBytes,
			activity = activity,
			onResult = onResult@{ certificateChainBase64 ->
				// Gap A prerequisite (49-15, D-04/D-08) — regenerateAttested's onResult fires only
				// AFTER the alias has been deleted+regenerated and the biometric satisfied, so the
				// alias holds the attested key at exactly this moment. Resolve its public value here,
				// not from the discarded provisionDeviceKey-time key.
				val publicKeyCompressedHex: String
				try {
					publicKeyCompressedHex = keyAttestationHelper.exportPublicKeyCompressedHex(keyAlias)
				} catch (e: Exception) {
					// Fail closed rather than resolve a partial map — an undefined public key in JS
					// would register a bogus UserKey.PubKey that verify() then fails closed AND
					// silently against (swallowed exception -> false), the exact shape this phase
					// exists to eliminate.
					promise.reject("KEY_ATTESTATION_FAILED", e)
					return@onResult
				}
				finishWithPlayIntegrity(certificateChainBase64, publicKeyCompressedHex, boundDigest, enablePlayIntegrity, promise)
			},
			onError = { code, throwable ->
				promise.reject(code, throwable)
			},
		)
	}

	override fun signWithDeviceKey(
		keyAlias: String,
		digestBase64: String,
		promptTitle: String,
		promptSubtitle: String,
		promptNegativeButton: String,
		promise: Promise,
	) {
		val activity = reactApplicationContext.currentActivity as? FragmentActivity
		if (activity == null) {
			vtSignLog("sign refused kind=DEVICE code=NO_ACTIVITY")
			promise.reject("NO_ACTIVITY", "no current FragmentActivity available to host the BiometricPrompt")
			return
		}

		// D-04/T-49-DER-2 (WR-10-class trap, 49-RESEARCH.md Pattern 2): plain base64 decode of the
		// RAW digest bytes — NOT the UTF-8 bytes of a base64url STRING. Deliberately UNLIKE
		// produceAttestation's boundDigestUtf8Base64 asymmetry (ATTESTATION-CONTRACT.md §3); mixing
		// the two encodings here would silently sign the wrong bytes.
		val digestBytes: ByteArray = try {
			Base64.decode(digestBase64, Base64.NO_WRAP)
		} catch (e: Exception) {
			promise.reject("INVALID_DIGEST_ENCODING", e)
			return
		}

		keyAttestationHelper.signWithDeviceKey(
			keyAlias = keyAlias,
			digestBytes = digestBytes,
			activity = activity,
			promptTitle = promptTitle,
			promptSubtitle = promptSubtitle,
			promptNegativeButton = promptNegativeButton,
			onResult = { signatureHex ->
				promise.resolve(Arguments.createMap().apply { putString("signatureHex", signatureHex) })
			},
			onKeyInvalidatedReassociate = {
				promise.reject(
					"KEY_INVALIDATED_REASSOCIATE",
					"biometric enrollment changed since this key was created — key invalidated, re-association required",
				)
			},
			onError = { code, throwable ->
				promise.reject(code, throwable)
			},
		)
	}

	override fun signWithRecoveryKey(
		keyAlias: String,
		digestBase64: String,
		promptTitle: String,
		promptSubtitle: String,
		promptNegativeButton: String,
		promise: Promise,
	) {
		val activity = reactApplicationContext.currentActivity as? FragmentActivity
		if (activity == null) {
			vtSignLog("sign refused kind=RECOVERY code=NO_ACTIVITY")
			promise.reject("NO_ACTIVITY", "no current FragmentActivity available to host the recovery ceremony")
			return
		}

		// Same D-04/T-49-DER-2 byte-format contract as signWithDeviceKey.
		val digestBytes: ByteArray = try {
			Base64.decode(digestBase64, Base64.NO_WRAP)
		} catch (e: Exception) {
			promise.reject("INVALID_DIGEST_ENCODING", e)
			return
		}

		keyAttestationHelper.signWithRecoveryKey(
			keyAlias = keyAlias,
			digestBytes = digestBytes,
			activity = activity,
			promptTitle = promptTitle,
			promptSubtitle = promptSubtitle,
			promptNegativeButton = promptNegativeButton,
			onResult = { signatureHex ->
				promise.resolve(Arguments.createMap().apply { putString("signatureHex", signatureHex) })
			},
			onKeyInvalidatedReassociate = {
				promise.reject(
					"KEY_INVALIDATED_REASSOCIATE",
					"recovery key invalidated — re-association required",
				)
			},
			onError = { code, throwable ->
				promise.reject(code, throwable)
			},
		)
	}

	override fun cancelPendingSign(promise: Promise) {
		// Resolve once: the helper reports `true` itself once it has taken (and settled) a record,
		// even if a later step throws (review IN-04), so this catch only answers for a throw before
		// anything was taken.
		val answered = AtomicBoolean(false)
		val answer = { canceled: Boolean ->
			if (answered.compareAndSet(false, true)) {
				promise.resolve(Arguments.createMap().apply { putBoolean("canceled", canceled) })
			}
		}
		try {
			// A null activity is allowed: the cancel still settles the pending promise.
			val activity = reactApplicationContext.currentActivity as? FragmentActivity
			keyAttestationHelper.cancelPendingSign(activity) { canceled -> answer(canceled) }
		} catch (e: Exception) {
			// The contract never rejects.
			answer(false)
		}
	}

	/**
	 * On-device biometric success: request the Play Integrity leg (D-12 gated) and the
	 * device ID (D-14), then assemble the native-side attestation result map. JS (45-05) is
	 * responsible for building the final `DeviceAttestation` from this map.
	 */
	private fun finishWithPlayIntegrity(
		certificateChainBase64: List<String>,
		publicKeyCompressedHex: String,
		boundDigest: String,
		enablePlayIntegrity: Boolean,
		promise: Promise,
	) {
		playIntegrityHelper.requestToken(
			boundDigest = boundDigest,
			enablePlayIntegrity = enablePlayIntegrity,
			onResult = { integrityToken ->
				val androidId = playIntegrityHelper.getDeviceId()
				promise.resolve(Arguments.createMap().apply {
					putArray("certificateChainBase64", Arguments.createArray().apply {
						certificateChainBase64.forEach { pushString(it) }
					})
					putString("integrityToken", integrityToken)
					putString("androidId", androidId)
					putDouble("attestationTimeMillis", System.currentTimeMillis().toDouble())
					// Gap A prerequisite (49-15, D-04/D-08) — the POST-regeneration public key;
					// see produceAttestation's onResult lambda for why this must be exported here
					// rather than reused from provisionDeviceKey's earlier resolution.
					putString("publicKeyCompressedHex", publicKeyCompressedHex)
				})
			},
			onError = { e ->
				// recoverable-transient (D-09) — the key-attestation leg already succeeded;
				// only the independent Play Integrity leg failed (network/timeout/quota).
				promise.reject("PLAY_INTEGRITY_ERROR", e)
			},
		)
	}

	/**
	 * D-42 (Phase 62 plan 08): generic alias-keyed AES-256-GCM secret-at-rest wrap, distinct from
	 * every P-256 signing-key method above. Reject codes this pair adds to the module's taxonomy:
	 * `INVALID_ARGUMENT`, `INVALID_ENCODING`, `NO_WRAP_KEY`, `WRAP_KEY_POLICY_MISMATCH`,
	 * `UNWRAP_TAG_MISMATCH`, `KEY_INVALIDATED`, `WRAP_FAILED`, `UNWRAP_FAILED` — plus the existing
	 * `NO_ACTIVITY`/`CANCELED`/`NO_BIOMETRICS_ENROLLED`/`LOCKOUT`/`LOCKOUT_PERMANENT`/
	 * `BIOMETRIC_ERROR` classes, reused verbatim when `requireAuth` is true.
	 *
	 * D-14 (63-16): both methods take a trailing `authWindowSeconds`; Android honours a window above 0
	 * with a time-bound key (try-init, then one prompt without a CryptoObject); iOS accepts and
	 * ignores it.
	 */
	override fun wrapSecret(
		keyAlias: String,
		plaintextBase64: String,
		aadBase64: String,
		requireAuth: Boolean,
		promptTitle: String,
		promptSubtitle: String,
		promptNegativeButton: String,
		authWindowSeconds: Double,
		promise: Promise,
	) {
		val plaintext: ByteArray
		val aad: ByteArray
		try {
			plaintext = Base64.decode(plaintextBase64, Base64.NO_WRAP)
			aad = Base64.decode(aadBase64, Base64.NO_WRAP)
		} catch (e: Exception) {
			promise.reject("INVALID_ENCODING", e)
			return
		}

		val window = authWindowSecondsOrNull(authWindowSeconds, requireAuth)
		if (window == null) {
			promise.reject("INVALID_ARGUMENT", "authWindowSeconds must be an integer in 0..$MAX_AUTH_WINDOW_SECONDS, and 0 unless requireAuth")
			return
		}

		val activity = if (requireAuth) {
			val a = reactApplicationContext.currentActivity as? FragmentActivity
			if (a == null) {
				promise.reject("NO_ACTIVITY", "no current FragmentActivity available to host the BiometricPrompt")
				return
			}
			a
		} else {
			null
		}

		secretWrapHelper.wrap(
			alias = keyAlias,
			plaintext = plaintext,
			aad = aad,
			requireAuth = requireAuth,
			activity = activity,
			promptTitle = promptTitle,
			promptSubtitle = promptSubtitle,
			promptNegativeButton = promptNegativeButton,
			authWindowSeconds = window,
			onResult = { ciphertext, iv, securityLevel ->
				promise.resolve(Arguments.createMap().apply {
					putString("ciphertextBase64", Base64.encodeToString(ciphertext, Base64.NO_WRAP))
					putString("ivBase64", Base64.encodeToString(iv, Base64.NO_WRAP))
					putString("keyAlias", keyAlias)
					putString("securityLevel", securityLevel)
				})
			},
			onError = { code, throwable -> promise.reject(code, throwable) },
		)
	}

	override fun unwrapSecret(
		keyAlias: String,
		ciphertextBase64: String,
		ivBase64: String,
		aadBase64: String,
		requireAuth: Boolean,
		promptTitle: String,
		promptSubtitle: String,
		promptNegativeButton: String,
		authWindowSeconds: Double,
		promise: Promise,
	) {
		val ciphertext: ByteArray
		val iv: ByteArray
		val aad: ByteArray
		try {
			ciphertext = Base64.decode(ciphertextBase64, Base64.NO_WRAP)
			iv = Base64.decode(ivBase64, Base64.NO_WRAP)
			aad = Base64.decode(aadBase64, Base64.NO_WRAP)
		} catch (e: Exception) {
			promise.reject("INVALID_ENCODING", e)
			return
		}

		val window = authWindowSecondsOrNull(authWindowSeconds, requireAuth)
		if (window == null) {
			promise.reject("INVALID_ARGUMENT", "authWindowSeconds must be an integer in 0..$MAX_AUTH_WINDOW_SECONDS, and 0 unless requireAuth")
			return
		}

		val activity = if (requireAuth) {
			val a = reactApplicationContext.currentActivity as? FragmentActivity
			if (a == null) {
				promise.reject("NO_ACTIVITY", "no current FragmentActivity available to host the BiometricPrompt")
				return
			}
			a
		} else {
			null
		}

		secretWrapHelper.unwrap(
			alias = keyAlias,
			ciphertext = ciphertext,
			iv = iv,
			aad = aad,
			requireAuth = requireAuth,
			activity = activity,
			promptTitle = promptTitle,
			promptSubtitle = promptSubtitle,
			promptNegativeButton = promptNegativeButton,
			authWindowSeconds = window,
			onResult = { plaintext ->
				promise.resolve(Arguments.createMap().apply {
					putString("plaintextBase64", Base64.encodeToString(plaintext, Base64.NO_WRAP))
				})
			},
			onError = { code, throwable -> promise.reject(code, throwable) },
		)
	}

	/**
	 * Phase 63 review CR-02: delete a vote-record wrap key so the next seal creates a fresh one. The
	 * alias restriction lives in [SecretWrapHelper.deleteWrapKey] (identity and signing aliases are
	 * refused before the Keystore is touched). Resolves `{ deleted }`.
	 */
	override fun deleteWrapKey(keyAlias: String, promise: Promise) {
		try {
			val deleted = secretWrapHelper.deleteWrapKey(keyAlias)
			promise.resolve(Arguments.createMap().apply { putBoolean("deleted", deleted) })
		} catch (e: InvalidWrapKeyAliasException) {
			promise.reject("INVALID_ARGUMENT", e)
		} catch (e: WrapKeyPolicyMismatchException) {
			promise.reject("WRAP_KEY_POLICY_MISMATCH", e)
		} catch (e: Exception) {
			promise.reject("WRAP_FAILED", e)
		}
	}

	/**
	 * Phase 63 review CR-01: add or clear FLAG_SECURE on the current Activity's window, on the UI
	 * thread, so the Recents snapshot and screenshots of the decrypted receipt are blank.
	 */
	override fun setSecureScreen(enabled: Boolean, promise: Promise) {
		val activity = reactApplicationContext.currentActivity
		if (activity == null) {
			promise.reject("NO_ACTIVITY", "no current Activity to apply FLAG_SECURE to")
			return
		}
		UiThreadUtil.runOnUiThread {
			try {
				if (enabled) {
					activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
				} else {
					activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
				}
				promise.resolve(Arguments.createMap().apply { putBoolean("applied", enabled) })
			} catch (e: Exception) {
				promise.reject("SECURE_SCREEN_FAILED", e)
			}
		}
	}

	/**
	 * Phase 63 review WR-03: SYNCHRONOUS sensitive copy. The clip's description extras carry
	 * EXTRA_IS_SENSITIVE (API 33+; the same key by literal below 33, which older systems ignore), so the
	 * Android 13+ overlay hides the preview and IMEs keep it out of clipboard history. A private token
	 * in the extras lets the 60 s best-effort clear recognise its own clip from the DESCRIPTION alone,
	 * never reading the clip text (no "pasted from clipboard" notice). The clear only happens while the
	 * app can still see the clipboard (foreground on API 29+); otherwise it is a no-op.
	 */
	override fun copySensitiveText(text: String): Boolean {
		return try {
			val clipboard = reactApplicationContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
			val token = java.util.UUID.randomUUID().toString()
			val clip = ClipData.newPlainText("", text)
			clip.description.extras = PersistableBundle().apply {
				putBoolean(if (Build.VERSION.SDK_INT >= 33) ClipDescription.EXTRA_IS_SENSITIVE else LEGACY_EXTRA_IS_SENSITIVE, true)
				putString(CLIP_TOKEN_EXTRA, token)
			}
			clipboard.setPrimaryClip(clip)
			Handler(Looper.getMainLooper()).postDelayed({
				try {
					val desc = clipboard.primaryClipDescription
					if (desc != null && desc.extras?.getString(CLIP_TOKEN_EXTRA) == token) {
						if (Build.VERSION.SDK_INT >= 28) {
							clipboard.clearPrimaryClip()
						} else {
							clipboard.setPrimaryClip(ClipData.newPlainText("", ""))
						}
					}
				} catch (e: Exception) {
					// Best effort only.
				}
			}, SENSITIVE_CLIP_CLEAR_MS)
			true
		} catch (e: Exception) {
			false
		}
	}

	/** Plan 62-75: write a sanitized cache file; resolves `{ uri }`. Rejects INVALID_NAME / WRITE_FAILED. */
	override fun writeShareFile(fileName: String, contents: String, promise: Promise) {
		Thread {
			try {
				val uri = FileShareHelper.writeShareFile(reactApplicationContext, fileName, contents)
				promise.resolve(Arguments.createMap().apply { putString("uri", uri.toString()) })
			} catch (e: FileShareException) {
				promise.reject(e.code, e.message, e)
			} catch (e: Exception) {
				promise.reject("WRITE_FAILED", e)
			}
		}.start()
	}

	/** Plan 62-138: delete a regular file strictly inside cacheDir; resolves `{ deleted }`. Rejects OUTSIDE_CACHE / DELETE_FAILED. */
	override fun deleteCachedFile(uri: String, promise: Promise) {
		Thread {
			try {
				val deleted = FileShareHelper.deleteCachedFile(reactApplicationContext, uri)
				promise.resolve(Arguments.createMap().apply { putBoolean("deleted", deleted) })
			} catch (e: FileShareException) {
				promise.reject(e.code, e.message, e)
			} catch (e: Exception) {
				promise.reject("DELETE_FAILED", e)
			}
		}.start()
	}

	/** Plan 62-75: share a vt-share cache file as a file (never EXTRA_TEXT). Rejects SHARE_FAILED. */
	override fun shareFile(uri: String, mimeType: String, subject: String, dialogTitle: String, promise: Promise) {
		try {
			FileShareHelper.shareFile(
				reactApplicationContext.currentActivity,
				reactApplicationContext,
				uri,
				mimeType,
				subject,
				dialogTitle,
			)
			promise.resolve(Arguments.createMap().apply { putBoolean("launched", true) })
		} catch (e: FileShareException) {
			promise.reject(e.code, e.message, e)
		} catch (e: Exception) {
			promise.reject("SHARE_FAILED", e)
		}
	}

	companion object {
		const val NAME = "AttestationNative"

		/** ClipDescription.EXTRA_IS_SENSITIVE's value, for API levels whose SDK predates the constant. */
		private const val LEGACY_EXTRA_IS_SENSITIVE = "android.content.extra.IS_SENSITIVE"
		private const val CLIP_TOKEN_EXTRA = "org.votetorrent.clipToken"
		private const val SENSITIVE_CLIP_CLEAR_MS = 60_000L
	}
}
