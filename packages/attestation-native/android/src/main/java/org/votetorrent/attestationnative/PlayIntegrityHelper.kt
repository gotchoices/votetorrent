package org.votetorrent.attestationnative

import android.provider.Settings
import com.facebook.react.bridge.ReactApplicationContext
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.IntegrityTokenRequest

/**
 * PlayIntegrityHelper — Play Integrity Classic `requestIntegrityToken(setNonce(BOUND_DIGEST))`,
 * independently gated by `enablePlayIntegrity` (D-12), plus the ANDROID_ID deviceId (D-14).
 *
 * D-02/D-05: calls Google's official Classic API directly (`com.google.android.play:integrity`,
 * pinned in `android/build.gradle`) — no third-party npm wrapper. The device never
 * decrypts/parses the returned token (Don't Hand-Roll — that is exclusively the authority-side
 * `verifyPlayIntegrity`, which holds the Play Console decryption keys); this helper forwards it
 * OPAQUE.
 */
class PlayIntegrityHelper(private val reactContext: ReactApplicationContext) {

	/**
	 * (1) D-12's independent proof-flag: when [enablePlayIntegrity] is false, resolve the labeled
	 * placeholder immediately — the "real-key, stub-PI" tier, togglable WITHOUT touching the
	 * key-attestation leg. When true, request a real Play Integrity Classic token with
	 * `setNonce(boundDigest)` passed AS-IS — [boundDigest] is the base64url `BOUND_DIGEST` STRING
	 * (ATTESTATION-CONTRACT.md §2); it is never re-hashed or re-encoded here.
	 *
	 * Rate limit (VERIFIED, 45-RESEARCH.md Pattern 5): 5 tokens/minute per app instance,
	 * 10,000/day per app by default — do not loop/retry this call aggressively during on-device
	 * proof runs.
	 */
	fun requestToken(
		boundDigest: String,
		enablePlayIntegrity: Boolean,
		onResult: (String) -> Unit,
		onError: (Throwable) -> Unit,
	) {
		if (!enablePlayIntegrity) {
			onResult(STUB_PLAY_INTEGRITY_TOKEN)
			return
		}

		val integrityManager = IntegrityManagerFactory.create(reactContext)
		val request = IntegrityTokenRequest.builder()
			.setNonce(boundDigest) // BOUND_DIGEST string AS-IS (D-02/D-06) — no re-encoding.
			.build()
		integrityManager.requestIntegrityToken(request)
			.addOnSuccessListener { response -> onResult(response.token()) }
			.addOnFailureListener { e -> onError(e) }
	}

	/** (2) D-14 — the value that becomes `DeviceAttestation.deviceId` (assembled JS-side, 45-05). */
	fun getDeviceId(): String {
		return Settings.Secure.getString(reactContext.contentResolver, Settings.Secure.ANDROID_ID)
	}

	companion object {
		// Labeled so it is never mistaken for a real token downstream (D-12's independent stub tier).
		const val STUB_PLAY_INTEGRITY_TOKEN = "STUB_PLAY_INTEGRITY_TOKEN_NOT_REAL"
	}
}
