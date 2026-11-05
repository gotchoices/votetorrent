package org.votetorrent.authority

import android.app.KeyguardManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.spec.ECGenParameterSpec

/**
 * D-07 StrongBox rung probe — a MEASUREMENT, not an assertion.
 *
 * Exists to settle, on real hardware, the two claims the working-tree revision of
 * `KeyAttestationHelper.generateKey` states as fact in its own comments:
 *
 *   (1) `setAttestationChallenge(ByteArray(0))` is a REQUEST for attestation carrying an INVALID
 *       challenge, which StrongBox/KeyMint rejects (ATTESTATION_CHALLENGE_MISSING), while
 *       `setAttestationChallenge` never being called at all yields a plain non-attested key that
 *       StrongBox accepts.
 *   (2) The TEE rung tolerates the same empty array that StrongBox rejects.
 *
 * Deliberately makes NO junit assertion about the outcome of any case: the point is to record what
 * this silicon actually does, so a verdict can be derived from the record rather than from a
 * transcribed belief. It fails only if the probe itself could not run.
 *
 * Every KeyGenParameterSpec below is byte-identical to `generateKey`'s `buildSpec` — same curve,
 * digest, auth flags, and per-use parameters — so a result here transfers to production. The only
 * varied axes are `setIsStrongBoxBacked` and the attestation-challenge form.
 *
 * Run: scripts/run-strongbox-rung-probe.sh
 */
@RunWith(AndroidJUnit4::class)
class StrongBoxRungProbeTest {

	private companion object {
		const val TAG = "VtSbProbe"
		const val ANDROID_KEYSTORE = "AndroidKeyStore"
		/** Mirrors ProvisionSigningKeyScreen's runLocalCeremony challenge shape. */
		const val REAL_CHALLENGE = "signing-key-provisioning-probe-0123456789abcdef"
	}

	private enum class Challenge { ABSENT, EMPTY, REAL }

	@Test
	fun probeStrongBoxRung() {
		val context = InstrumentationRegistry.getInstrumentation().targetContext
		val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

		val pm = context.packageManager
		val hasStrongBoxFeature =
			if (Build.VERSION.SDK_INT >= 28) {
				pm.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)
			} else {
				false
			}
		val keyguard = context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
		val deviceSecure = keyguard.isDeviceSecure

		val device = JSONObject().apply {
			put("model", Build.MODEL)
			put("device", Build.DEVICE)
			put("manufacturer", Build.MANUFACTURER)
			put("sdkInt", Build.VERSION.SDK_INT)
			put("release", Build.VERSION.RELEASE)
			put("fingerprint", Build.FINGERPRINT)
			put("securityPatch", if (Build.VERSION.SDK_INT >= 23) Build.VERSION.SECURITY_PATCH else "n/a")
			put("hasStrongBoxFeature", hasStrongBoxFeature)
			put("deviceSecure", deviceSecure)
		}
		Log.i(TAG, "DEVICE $device")

		val cases = listOf(
			Triple("A_strongbox_challenge_absent", true, Challenge.ABSENT),
			Triple("B_strongbox_challenge_empty", true, Challenge.EMPTY),
			Triple("C_strongbox_challenge_real", true, Challenge.REAL),
			Triple("D_tee_challenge_empty", false, Challenge.EMPTY),
			Triple("E_tee_challenge_real", false, Challenge.REAL),
		)

		val results = JSONArray()
		for ((name, strongBox, challenge) in cases) {
			results.put(runCase(keyStore, name, strongBox, challenge))
		}

		val report = JSONObject().apply {
			put("probe", "d07-strongbox-rung")
			put("device", device)
			put("cases", results)
		}

		// Two sinks on purpose: logcat for a live read, and a file the runner pulls so the
		// certificate chains survive logcat's per-line truncation and can be fed to the existing
		// host-side decoder (packages/vote-engine/scripts/decode-attestation-leaf.mjs).
		// filesDir, not getExternalFilesDir: scoped storage (Android 11+) hides an app's
		// Android/data subtree from `adb shell`/`adb pull`, and `run-as` cannot reach external
		// storage either — the internal dir is the only path the runner can actually retrieve.
		val out = File(context.filesDir, "strongbox-rung-probe.json")
		out.writeText(report.toString(2))
		Log.i(TAG, "REPORT_WRITTEN ${out.absolutePath}")
		Log.i(TAG, "SUMMARY " + summarize(results))
	}

	private fun runCase(
		keyStore: KeyStore,
		name: String,
		strongBox: Boolean,
		challenge: Challenge,
	): JSONObject {
		val alias = "probe-$name"
		val result = JSONObject().apply {
			put("case", name)
			put("strongBoxRequested", strongBox)
			put("challenge", challenge.name)
		}

		runCatching { if (keyStore.containsAlias(alias)) keyStore.deleteEntry(alias) }

		try {
			val builder = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN).apply {
				setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
				setDigests(KeyProperties.DIGEST_SHA256)
				when (challenge) {
					Challenge.ABSENT -> Unit
					Challenge.EMPTY -> setAttestationChallenge(ByteArray(0))
					Challenge.REAL -> setAttestationChallenge(REAL_CHALLENGE.toByteArray())
				}
				setUserAuthenticationRequired(true)
				setInvalidatedByBiometricEnrollment(true)
				if (Build.VERSION.SDK_INT >= 30) {
					setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
				}
				if (strongBox) {
					setIsStrongBoxBacked(true)
				}
			}
			val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
			generator.initialize(builder.build())
			generator.generateKeyPair()

			result.put("outcome", "OK")
			val chain = keyStore.getCertificateChain(alias)
			result.put("chainLength", chain?.size ?: 0)
			val encoded = JSONArray()
			chain?.forEach { encoded.put(Base64.encodeToString(it.encoded, Base64.NO_WRAP)) }
			result.put("chainBase64", encoded)
		} catch (e: StrongBoxUnavailableException) {
			result.put("outcome", "STRONGBOX_UNAVAILABLE")
			describe(e, result)
		} catch (e: Throwable) {
			result.put("outcome", "EXCEPTION")
			describe(e, result)
		} finally {
			runCatching { if (keyStore.containsAlias(alias)) keyStore.deleteEntry(alias) }
		}

		Log.i(TAG, "CASE $result".take(3800))
		return result
	}

	/** Records the whole cause chain — KeyMint's real reason is usually two levels down. */
	private fun describe(t: Throwable, into: JSONObject) {
		into.put("exceptionClass", t.javaClass.name)
		into.put("exceptionMessage", t.message ?: "")
		val causes = JSONArray()
		var c = t.cause
		var depth = 0
		while (c != null && depth < 6) {
			causes.put("${c.javaClass.name}: ${c.message}")
			c = c.cause
			depth++
		}
		into.put("causes", causes)
	}

	private fun summarize(results: JSONArray): String {
		val parts = mutableListOf<String>()
		for (i in 0 until results.length()) {
			val r = results.getJSONObject(i)
			parts += "${r.getString("case")}=${r.getString("outcome")}"
		}
		return parts.joinToString(" ")
	}
}
