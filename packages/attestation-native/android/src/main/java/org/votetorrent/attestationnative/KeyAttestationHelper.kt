package org.votetorrent.attestationnative

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.facebook.react.bridge.ReactApplicationContext
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

private const val ANDROID_KEYSTORE = "AndroidKeyStore"

/** Result of a (placeholder or attested) P-256 keygen. */
data class ProvisionResult(
	val publicKeyBase64: String,
	val keyAlias: String,
	// "strongbox" | "tee" | "software" — the last rung is unreachable in a release build (T-45-04/CR-03).
	val securityLevel: String,
)

/**
 * Terminal (release-only) failure — no StrongBox/TEE hardware backing available and the
 * debug-only software/stub rung is unreachable because [BuildConfig.DEBUG] is false. Fail-closed
 * per D-07/CR-03 — a release build must NEVER silently fall to a software key.
 */
class NoStrongBoxOrTeeException(cause: Throwable) : Exception(
	"no StrongBox or TEE hardware key backing available on this device (release build — fail-closed, D-07/CR-03)",
	cause,
)

/**
 * KeyAttestationHelper — P-256 StrongBox->TEE->(debug-only)stub keygen, per-use biometric gate,
 * cert-chain export (leaf+intermediates, no root), and KeyPermanentlyInvalidatedException
 * handling (Phase 45-02: D-03/D-06/D-07/D-13/D-15b/D-17).
 *
 * Open Q1 (LOCKED, see 45-02-PLAN.md "Open Question resolutions"): placeholder-provision +
 * regenerate-at-produce.
 *   - [generateProvisionKey] creates the P-256 key ONCE with an EMPTY/placeholder attestation
 *     challenge, no biometric (D-16 "biometric-last" — mere key creation, not a real attestation).
 *   - [regenerateAttested] DELETES and REGENERATES the SAME alias with the REAL
 *     setAttestationChallenge(utf8(BOUND_DIGEST)), biometric-gated. The regenerated leaf's public
 *     key differs from the provision-time key — this is verifier-safe: `key-attestation.ts` binds
 *     anti-relay SOLELY via `KeyDescription.attestationChallenge`, never `leaf.publicKey ==
 *     challenge.deviceKey` (verified by direct source read, see 45-02-PLAN.md).
 *
 * Does NOT compute Digest/sha256 — that is JS-side (45-05). This helper receives already-computed
 * challenge bytes and an already-computed BOUND_DIGEST string (Play Integrity leg lives in
 * [PlayIntegrityHelper]).
 */
class KeyAttestationHelper(private val reactContext: ReactApplicationContext) {

	private val keyStore: KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

	/**
	 * (1) Placeholder-provision (Open Q1): generate the P-256 key ONCE with an empty attestation
	 * challenge and no biometric prompt — Android requires SOME setAttestationChallenge(...) call
	 * to obtain an attestation-carrying cert chain at all, but mere key CREATION does not itself
	 * require a fresh biometric (that gate applies at key USE time in [regenerateAttested]).
	 */
	fun generateProvisionKey(keyAlias: String): ProvisionResult {
		return generateKey(keyAlias, attestationChallenge = null)
	}

	/**
	 * (2) Delete + regenerate under [keyAlias] WITH the real attestation challenge bytes
	 * ([attestationChallengeBytes] — utf8(BOUND_DIGEST), already decoded by the caller per
	 * ATTESTATION-CONTRACT.md §3; this helper does NOT re-derive them), then force a fresh
	 * biometric via [BiometricPrompt.authenticate] bound to a [Signature] over the new key (D-06)
	 * before exporting the cert chain. BiometricPrompt is callback-based, not synchronously
	 * returnable — results are delivered via [onResult]/[onKeyInvalidatedReassociate]/[onError].
	 */
	fun regenerateAttested(
		keyAlias: String,
		attestationChallengeBytes: ByteArray,
		activity: FragmentActivity,
		onResult: (List<String>) -> Unit,
		onKeyInvalidatedReassociate: () -> Unit,
		onError: (code: String, throwable: Throwable?) -> Unit,
	) {
		try {
			keyStore.deleteEntry(keyAlias)
		} catch (e: Exception) {
			// No pre-existing entry (first-ever produceAttestation call after provision) or a
			// benign deletion failure — generateKey below creates a fresh entry regardless.
		}

		try {
			generateKey(keyAlias, attestationChallenge = attestationChallengeBytes)
		} catch (e: NoStrongBoxOrTeeException) {
			onError("NO_STRONGBOX_OR_TEE", e)
			return
		} catch (e: Exception) {
			onError("KEY_ATTESTATION_FAILED", e)
			return
		}

		val signature: Signature
		try {
			val privateKey = keyStore.getKey(keyAlias, null) as PrivateKey
			signature = Signature.getInstance("SHA256withECDSA")
			signature.initSign(privateKey)
		} catch (e: KeyPermanentlyInvalidatedException) {
			// D-13 — the device's biometric enrollment changed since this alias's key was
			// created (new fingerprint/face added, or all biometrics removed). NOT a plain
			// failed-match (that surfaces as onAuthenticationFailed/ERROR_LOCKOUT instead).
			// Delete the invalidated key, regenerate a fresh (non-attested) placeholder so the
			// alias has something to re-provision from, and route the caller into forced
			// re-association — do NOT continue this produceAttestation call.
			try {
				keyStore.deleteEntry(keyAlias)
				generateKey(keyAlias, attestationChallenge = null)
			} catch (cleanupError: Exception) {
				// Best-effort cleanup only — the re-association flow re-provisions regardless of
				// whether this regeneration succeeds.
			}
			onKeyInvalidatedReassociate()
			return
		} catch (e: Exception) {
			onError("KEY_ATTESTATION_FAILED", e)
			return
		}

		val cryptoObject = BiometricPrompt.CryptoObject(signature)
		val promptInfo = BiometricPrompt.PromptInfo.Builder()
			.setTitle("Confirm your identity")
			.setSubtitle("Verify to produce your device attestation")
			.setNegativeButtonText("Cancel")
			.build()

		val biometricPrompt = BiometricPrompt(
			activity,
			ContextCompat.getMainExecutor(reactContext),
			object : BiometricPrompt.AuthenticationCallback() {
				override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
					// A successful prompt IS the cryptographic proof of a fresh biometric check
					// (D-06). For key ATTESTATION (not ballot signing) the cert chain itself does
					// not require an explicit .sign() call here — the biometric gate is enforced
					// by Keystore at key-USE time, which this initSign()+authenticate() ceremony
					// already satisfies.
					try {
						onResult(exportCertificateChain(keyAlias))
					} catch (e: Exception) {
						onError("KEY_ATTESTATION_FAILED", e)
					}
				}

				override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
					// D-09 three-way UX classification (AttestationNativeModule.kt owns the final
					// reject-code contract; this helper surfaces a stable intermediate code per
					// BiometricPrompt errorCode, per 45-RESEARCH.md Pattern 4's error-code table).
					val code = when (errorCode) {
						BiometricPrompt.ERROR_NO_BIOMETRICS -> "NO_BIOMETRICS_ENROLLED"
						BiometricPrompt.ERROR_LOCKOUT, BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> "LOCKOUT"
						else -> "BIOMETRIC_ERROR"
					}
					onError(code, RuntimeException(errString.toString()))
				}

				override fun onAuthenticationFailed() {
					// Biometric mismatch — a retry, NOT an error. BiometricPrompt itself
					// re-prompts the user; nothing to surface to JS here.
				}
			},
		)
		biometricPrompt.authenticate(promptInfo, cryptoObject)
	}

	/** (3) D-15b — export leaf+intermediates only; drop the trailing root (verifier pins its own). */
	private fun exportCertificateChain(keyAlias: String): List<String> {
		val chain = keyStore.getCertificateChain(keyAlias)
			?: throw IllegalStateException("no certificate chain for alias $keyAlias")
		return chain.dropLast(1).map { Base64.encodeToString(it.encoded, Base64.NO_WRAP) }
	}

	/**
	 * Shared keygen core for both the placeholder-provision (1) and attested-regeneration (2)
	 * paths — StrongBox->TEE->(debug-only)stub rungs (D-07). [attestationChallenge] null means
	 * "placeholder" (Open Q1's provision-time call, no real challenge yet); a non-null array is
	 * the real utf8(BOUND_DIGEST) bytes.
	 */
	private fun generateKey(keyAlias: String, attestationChallenge: ByteArray?): ProvisionResult {
		fun buildSpec(strongBox: Boolean): KeyGenParameterSpec {
			val builder = KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_SIGN).apply {
				setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1")) // D-03 — P-256 only;
				// secp256k1 is NOT supported for hardware key attestation.
				setDigests(KeyProperties.DIGEST_SHA256)
				setAttestationChallenge(attestationChallenge ?: ByteArray(0))
				setUserAuthenticationRequired(true) // D-17
				setInvalidatedByBiometricEnrollment(true) // D-17/D-13 — KeyPermanentlyInvalidatedException trigger
				if (Build.VERSION.SDK_INT >= 30) {
					setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG) // 0 = per-use (D-06)
				}
				// else: pre-API-30 fallback (Pitfall 4, [ASSUMED] LOW confidence — Pixel 8 proof
				// device is API 34+). setUserAuthenticationRequired(true) alone, with NO
				// validity-duration call, defaults to per-use CryptoObject-bound auth on API < 30.
				// Not on this phase's critical path; flagged for a future pre-30 device check.
				if (strongBox) {
					setIsStrongBoxBacked(true) // D-07 — try StrongBox first
				}
			}
			return builder.build()
		}

		// StrongBox rung.
		try {
			val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
			generator.initialize(buildSpec(strongBox = true))
			val keyPair = generator.generateKeyPair()
			return ProvisionResult(
				publicKeyBase64 = Base64.encodeToString(keyPair.public.encoded, Base64.NO_WRAP),
				keyAlias = keyAlias,
				securityLevel = "strongbox",
			)
		} catch (e: StrongBoxUnavailableException) {
			// Fall through to the TEE rung below.
		}

		// TEE rung.
		try {
			val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
			generator.initialize(buildSpec(strongBox = false))
			val keyPair = generator.generateKeyPair()
			return ProvisionResult(
				publicKeyBase64 = Base64.encodeToString(keyPair.public.encoded, Base64.NO_WRAP),
				keyAlias = keyAlias,
				securityLevel = "tee",
			)
		} catch (e: Exception) {
			// Software/stub rung — T-45-04/CR-03: a release build must NEVER reach this rung.
			// __DEV__/BuildConfig.DEBUG is the ONLY gate; anything else rethrows terminal.
			if (BuildConfig.DEBUG) {
				return generateSoftwareStubKey(keyAlias, attestationChallenge)
			}
			throw NoStrongBoxOrTeeException(e)
		}
	}

	/**
	 * Debug-only software keygen fallback so the emulator path (no StrongBox/TEE) still runs.
	 * Unreachable in a release build — see the `BuildConfig.DEBUG` guard in [generateKey].
	 */
	private fun generateSoftwareStubKey(keyAlias: String, attestationChallenge: ByteArray?): ProvisionResult {
		val spec = KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_SIGN).apply {
			setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
			setDigests(KeyProperties.DIGEST_SHA256)
			setAttestationChallenge(attestationChallenge ?: ByteArray(0))
			setUserAuthenticationRequired(true)
			setInvalidatedByBiometricEnrollment(true)
			if (Build.VERSION.SDK_INT >= 30) {
				setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
			}
		}.build()
		val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
		generator.initialize(spec)
		val keyPair = generator.generateKeyPair()
		return ProvisionResult(
			publicKeyBase64 = Base64.encodeToString(keyPair.public.encoded, Base64.NO_WRAP),
			keyAlias = keyAlias,
			securityLevel = "software",
		)
	}
}
