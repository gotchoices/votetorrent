package org.votetorrent.attestationnative

import android.util.Base64
import androidx.fragment.app.FragmentActivity
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.annotations.ReactModule

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
 *     terminal failure).
 */
@ReactModule(name = AttestationNativeModule.NAME)
class AttestationNativeModule(reactContext: ReactApplicationContext) :
	NativeAttestationSpec(reactContext) {

	private val keyAttestationHelper by lazy { KeyAttestationHelper(reactApplicationContext) }
	private val playIntegrityHelper by lazy { PlayIntegrityHelper(reactApplicationContext) }

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
			})
		} catch (e: NoStrongBoxOrTeeException) {
			// D-09 terminal, release-only (see class doc comment).
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
		val activity = currentActivity as? FragmentActivity
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
			onResult = { certificateChainBase64 ->
				finishWithPlayIntegrity(certificateChainBase64, boundDigest, enablePlayIntegrity, promise)
			},
			onKeyInvalidatedReassociate = {
				// D-13 — biometric enrollment changed since key creation; KeyAttestationHelper
				// already deleted + regenerated a fresh placeholder key. The JS caller must
				// restart the two-step D-11 ceremony from provisionDeviceKey().
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

	/**
	 * On-device biometric success: request the Play Integrity leg (D-12 gated) and the
	 * device ID (D-14), then assemble the native-side attestation result map. JS (45-05) is
	 * responsible for building the final `DeviceAttestation` from this map.
	 */
	private fun finishWithPlayIntegrity(
		certificateChainBase64: List<String>,
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
				})
			},
			onError = { e ->
				// recoverable-transient (D-09) — the key-attestation leg already succeeded;
				// only the independent Play Integrity leg failed (network/timeout/quota).
				promise.reject("PLAY_INTEGRITY_ERROR", e)
			},
		)
	}

	companion object {
		const val NAME = "AttestationNative"
	}
}
