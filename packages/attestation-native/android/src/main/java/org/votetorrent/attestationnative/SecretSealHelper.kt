package org.votetorrent.attestationnative

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Log
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.UiThreadUtil
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.ProviderException
import java.security.PublicKey
import java.security.spec.MGF1ParameterSpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.BadPaddingException
import javax.crypto.Cipher
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource

private const val SEAL_KEYSTORE = "AndroidKeyStore"

/** Seal-key alias pattern. Must equal `SEAL_KEY_ALIAS_PATTERN` in secret-seal.ts (checked by the
 * Authority's secret-seal ABI gate). Disjoint from every `_WRAP_KEY_V<n>` and EC signing alias. */
private val SEAL_KEY_ALIAS_PATTERN = Regex("^VOTETORRENT_[A-Z0-9_]+_SEAL_KEY_V[0-9]+$")

/** Largest plaintext one seal takes. Must equal `MAX_SEAL_PLAINTEXT_BYTES` in secret-seal.ts. RSA-2048 with
 * OAEP-SHA-256 fits 190 bytes; the cap is lower so iOS and Android accept exactly the same inputs. */
internal const val MAX_SEAL_PLAINTEXT_BYTES = 128

private const val SEAL_TRANSFORMATION = "RSA/ECB/OAEPWithSHA-256AndMGF1Padding"

/** OAEP with SHA-256 and MGF1-SHA-1, spelled out on BOTH sides. AndroidKeyStore decrypts with MGF1-SHA-1 only
 * (an MGF1 digest choice arrived in API 34), while software providers disagree on the default MGF1 digest
 * for this transformation name. An explicit spec makes encrypt and decrypt agree on every provider. */
private val SEAL_OAEP_SPEC = OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA1, PSource.PSpecified.DEFAULT)

private const val TAG_SEAL = "VtSealKey"

class InvalidSealKeyAliasException(alias: String) : Exception("invalid seal key alias: $alias")
class SealKeyPolicyMismatchException(message: String) : Exception(message)

/**
 * SecretSealHelper — public-key sealing for small secrets (keyholder seat keys). An RSA-2048 key pair in
 * AndroidKeyStore, StrongBox when the device has it, else TEE.
 *
 *  - SEAL uses only the PUBLIC key, in software, so it never prompts. A sealed secret is decryptable only
 *    inside the Keystore.
 *  - UNSEAL is per-use and biometric-only: `setUserAuthenticationRequired(true)` plus, on API 30+,
 *    `setUserAuthenticationParameters(0, AUTH_BIOMETRIC_STRONG)`; below 30 the same per-use biometric
 *    CryptoObject rule as the per-use wrap keys (no validity window is ever set). Exactly one
 *    BiometricPrompt per unseal. `setInvalidatedByBiometricEnrollment(true)`: a biometric change destroys
 *    the private key, reported KEY_INVALIDATED.
 *  - Get-or-create, never regenerate: an existing alias is reused or refused SEAL_KEY_POLICY_MISMATCH,
 *    never overwritten (whatever it sealed would become unreadable).
 *
 * Reject codes: INVALID_ARGUMENT, NO_SEAL_KEY, SEAL_KEY_POLICY_MISMATCH, KEY_INVALIDATED, SEAL_FAILED,
 * UNSEAL_FAILED, plus the BiometricPrompt classes CANCELED / NO_BIOMETRICS_ENROLLED / LOCKOUT /
 * LOCKOUT_PERMANENT / BIOMETRIC_ERROR and NO_ACTIVITY.
 */
class SecretSealHelper(private val reactContext: ReactApplicationContext) {

	private val keyStore: KeyStore = KeyStore.getInstance(SEAL_KEYSTORE).apply { load(null) }

	private fun requireAlias(alias: String) {
		if (!SEAL_KEY_ALIAS_PATTERN.matches(alias)) throw InvalidSealKeyAliasException(alias)
	}

	/** An existing alias must hold an auth-required RSA private key; anything else is refused. */
	private fun existingPrivateKey(alias: String): PrivateKey? {
		if (!keyStore.containsAlias(alias)) return null
		val entry = keyStore.getEntry(alias, null)
		if (entry !is KeyStore.PrivateKeyEntry || entry.privateKey.algorithm != KeyProperties.KEY_ALGORITHM_RSA) {
			throw SealKeyPolicyMismatchException("alias $alias does not hold an RSA private key")
		}
		val info = KeyFactory.getInstance(entry.privateKey.algorithm, SEAL_KEYSTORE)
			.getKeySpec(entry.privateKey, KeyInfo::class.java)
		if (!info.isUserAuthenticationRequired || info.userAuthenticationValidityDurationSeconds > 0) {
			throw SealKeyPolicyMismatchException("alias $alias is not a per-use auth-required key")
		}
		return entry.privateKey
	}

	private fun securityLevelOf(privateKey: PrivateKey): String {
		val info = KeyFactory.getInstance(privateKey.algorithm, SEAL_KEYSTORE).getKeySpec(privateKey, KeyInfo::class.java)
		if (Build.VERSION.SDK_INT >= 31) {
			return when (info.securityLevel) {
				KeyProperties.SECURITY_LEVEL_STRONGBOX -> "strongbox"
				KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "tee"
				KeyProperties.SECURITY_LEVEL_SOFTWARE -> "software"
				else -> "unknown"
			}
		}
		return if (info.isInsideSecureHardware) "tee" else "software"
	}

	private fun buildSpec(alias: String, strongBox: Boolean): KeyGenParameterSpec {
		val builder = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
			.setKeySize(2048)
			.setDigests(KeyProperties.DIGEST_SHA256)
			.setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_RSA_OAEP)
			.setUserAuthenticationRequired(true)
			.setInvalidatedByBiometricEnrollment(true)
		if (Build.VERSION.SDK_INT >= 30) {
			builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG) // 0 = per-use
		}
		if (strongBox) builder.setIsStrongBoxBacked(true)
		return builder.build()
	}

	/** StrongBox -> TEE ladder, the same reasoning as SecretWrapHelper.generateKey. */
	private fun generate(alias: String) {
		try {
			KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, SEAL_KEYSTORE).apply {
				initialize(buildSpec(alias, strongBox = true))
			}.generateKeyPair()
			Log.i(TAG_SEAL, "alias=$alias op=generate rung=strongbox")
			return
		} catch (e: StrongBoxUnavailableException) {
			Log.i(TAG_SEAL, "alias=$alias op=generate StrongBox unavailable, stepping down to TEE")
		} catch (e: ProviderException) {
			Log.w(TAG_SEAL, "alias=$alias op=generate StrongBox REJECTED, stepping down to TEE", e)
		}
		KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, SEAL_KEYSTORE).apply {
			initialize(buildSpec(alias, strongBox = false))
		}.generateKeyPair()
		Log.i(TAG_SEAL, "alias=$alias op=generate rung=tee")
	}

	/** A provider-neutral copy of the public key, so the software encrypt never routes through the Keystore. */
	private fun publicKeyOf(alias: String): PublicKey {
		val cert = keyStore.getCertificate(alias) ?: throw SealKeyPolicyMismatchException("alias $alias has no certificate")
		return KeyFactory.getInstance(KeyProperties.KEY_ALGORITHM_RSA).generatePublic(X509EncodedKeySpec(cert.publicKey.encoded))
	}

	/** Seal [plaintext] to [alias]'s public key, creating the key pair on first use. Never prompts. */
	@Synchronized
	fun seal(alias: String, plaintext: ByteArray): Pair<ByteArray, String> {
		requireAlias(alias)
		if (plaintext.isEmpty() || plaintext.size > MAX_SEAL_PLAINTEXT_BYTES) {
			throw IllegalArgumentException("plaintext must be 1..$MAX_SEAL_PLAINTEXT_BYTES bytes")
		}
		val privateKey = existingPrivateKey(alias) ?: run {
			generate(alias)
			existingPrivateKey(alias) ?: throw IllegalStateException("seal key $alias missing right after generation")
		}
		val cipher = Cipher.getInstance(SEAL_TRANSFORMATION)
		cipher.init(Cipher.ENCRYPT_MODE, publicKeyOf(alias), SEAL_OAEP_SPEC)
		return cipher.doFinal(plaintext) to securityLevelOf(privateKey)
	}

	/** Unseal [ciphertext] under [alias]'s private key: exactly one BiometricPrompt. Never creates a key. */
	fun unseal(
		alias: String,
		ciphertext: ByteArray,
		activity: FragmentActivity,
		promptTitle: String,
		promptSubtitle: String,
		promptNegativeButton: String,
		onResult: (plaintext: ByteArray) -> Unit,
		onError: (code: String, throwable: Throwable?) -> Unit,
	) {
		val privateKey: PrivateKey
		try {
			requireAlias(alias)
			privateKey = existingPrivateKey(alias) ?: run {
				onError("NO_SEAL_KEY", IllegalStateException("no seal key under alias $alias")); return
			}
		} catch (e: InvalidSealKeyAliasException) {
			onError("INVALID_ARGUMENT", e); return
		} catch (e: SealKeyPolicyMismatchException) {
			onError("SEAL_KEY_POLICY_MISMATCH", e); return
		} catch (e: Exception) {
			onError("UNSEAL_FAILED", e); return
		}

		val cipher: Cipher
		try {
			cipher = Cipher.getInstance(SEAL_TRANSFORMATION)
			cipher.init(Cipher.DECRYPT_MODE, privateKey, SEAL_OAEP_SPEC)
		} catch (e: KeyPermanentlyInvalidatedException) {
			onError("KEY_INVALIDATED", e); return
		} catch (e: Exception) {
			onError("UNSEAL_FAILED", e); return
		}

		val promptInfo = BiometricPrompt.PromptInfo.Builder()
			.setTitle(promptTitle)
			.setSubtitle(promptSubtitle)
			.setNegativeButtonText(promptNegativeButton)
			.build()

		UiThreadUtil.runOnUiThread {
			if (!canHostBiometricPrompt(activity)) {
				onError("NO_ACTIVITY", IllegalStateException("the activity cannot host a BiometricPrompt right now"))
				return@runOnUiThread
			}
			val prompt = BiometricPrompt(
				activity,
				ContextCompat.getMainExecutor(reactContext),
				object : BiometricPrompt.AuthenticationCallback() {
					override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
						try {
							onResult(result.cryptoObject!!.cipher!!.doFinal(ciphertext))
						} catch (e: KeyPermanentlyInvalidatedException) {
							onError("KEY_INVALIDATED", e)
						} catch (e: BadPaddingException) {
							onError("UNSEAL_FAILED", e)
						} catch (e: Exception) {
							onError("UNSEAL_FAILED", e)
						}
					}

					override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
						onError(mapSealBiometricErrorCode(errorCode), RuntimeException(errString.toString()))
					}

					override fun onAuthenticationFailed() {
						// Biometric mismatch: a retry, not an error.
					}
				},
			)
			prompt.authenticate(promptInfo, BiometricPrompt.CryptoObject(cipher))
		}
	}

	/** The same errorCode -> code mapping as SecretWrapHelper / KeyAttestationHelper. */
	private fun mapSealBiometricErrorCode(errorCode: Int): String = when (errorCode) {
		BiometricPrompt.ERROR_CANCELED,
		BiometricPrompt.ERROR_USER_CANCELED,
		BiometricPrompt.ERROR_NEGATIVE_BUTTON -> "CANCELED"
		BiometricPrompt.ERROR_NO_BIOMETRICS -> "NO_BIOMETRICS_ENROLLED"
		BiometricPrompt.ERROR_LOCKOUT -> "LOCKOUT"
		BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> "LOCKOUT_PERMANENT"
		else -> "BIOMETRIC_ERROR"
	}
}
