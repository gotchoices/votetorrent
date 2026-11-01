package org.votetorrent.attestationnative

import android.app.KeyguardManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import android.util.Log
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.UiThreadUtil
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.ProviderException
import java.security.Signature
import java.security.spec.ECGenParameterSpec

private const val ANDROID_KEYSTORE = "AndroidKeyStore"

/**
 * D-26a rescope (2026-08-21) — the minimum API level at which [KeyAttestationHelper.
 * signWithRecoveryKey] can complete a recovery ceremony. Below this level the function rejects
 * `RECOVERY_UNSUPPORTED_OS` before obtaining any key handle or launching any UI — see that
 * function's doc comment for the measured cause. Named so the threshold has one place, not a bare
 * `30` literal at each call site.
 */
private const val MIN_SDK_FOR_DEVICE_CREDENTIAL_RECOVERY = 30

/**
 * Gap B observability (49-15) — app-process `Log.i` tag for the raw BiometricPrompt `errorCode`
 * received at each of the three `onAuthenticationError` call sites, so a real-hardware run can
 * record which constant (5/10/13) the device actually delivers for a negative-button or BACK-key
 * dismissal — the question 49-13 left open. 15 chars, under Android's 23-char tag limit. INFO
 * level only (never `Log.w`/`Log.e`): a cancellation is not a fault, and `leg_cancel`'s
 * `cancel-no-logged-fault` check counts `" E "` matches in this app's own pid.
 */
private const val TAG_SIGNING_REJECT = "VtSigningReject"

/** D-111: cap on waiting for the cancelled prompt's fragment to detach, and the poll step. */
private const val CANCEL_WAIT_CAP_MS = 2000L
private const val CANCEL_POLL_STEP_MS = 50L

/**
 * D-07 rung observability — which rung [KeyAttestationHelper.generateKey] actually landed on, and
 * WHY it stepped down. Without this, a TEE result is indistinguishable between "no StrongBox chip
 * on this device" (expected) and "StrongBox chip present but it rejected our key request"
 * (a defect). 14 chars, under Android's 23-char tag limit.
 *
 * Unlike [TAG_SIGNING_REJECT] this does emit at `Log.w` for the downgrade case — a silent security
 * rung downgrade IS a fault worth surfacing. It stays clear of `Log.e`/`" E "` so it cannot
 * perturb `leg_cancel`'s `cancel-no-logged-fault` check, which counts `" E "` in this app's pid.
 */
private const val TAG_KEYGEN_RUNG = "VtKeygenRung"

/**
 * Phase 49 (D-07) — canonical Authority Keystore aliases, distinct from the Voter app's device
 * signing key alias (`real-attestation-producer.ts`'s `KEY_ALIAS` constant). Different apps,
 * different threat surfaces, independent rotation, and the Authority app has no attestation flow
 * to bind to — so these are NOT aliased to, or derived from, the Voter constant. Both must stay
 * stable for the same reason the Voter alias must: [KeyPermanentlyInvalidatedException] detection
 * (D-13) depends on re-resolving a *known* alias, not a freshly-generated one.
 *
 * [VOTETORRENT_AUTHORITY_SIGNING_KEY_V1] is the primary per-use `AUTH_BIOMETRIC_STRONG` signing
 * key (provisioned/used via the existing [generateProvisionKey]/[regenerateAttested]/
 * [signWithDeviceKey] path). [VOTETORRENT_AUTHORITY_RECOVERY_KEY_V1] is the D-16 second key that
 * `setInvalidatedByBiometricEnrollment` does NOT govern, provisioned/used via
 * [generateRecoveryKey]/[signWithRecoveryKey].
 */
const val VOTETORRENT_AUTHORITY_SIGNING_KEY_V1 = "VOTETORRENT_AUTHORITY_SIGNING_KEY_V1"
const val VOTETORRENT_AUTHORITY_RECOVERY_KEY_V1 = "VOTETORRENT_AUTHORITY_RECOVERY_KEY_V1"

/**
 * Which authenticator [KeyGenParameterSpec.Builder.setUserAuthenticationParameters] requests at
 * key-creation time (API 30+ only — see the `Build.VERSION.SDK_INT >= 30` guards below). The `0`
 * timeout argument is ALWAYS per-use (D-10) regardless of which member is selected; D-10 rejected
 * any non-zero validity duration explicitly, since its boundary is a wall clock and any code path
 * signing inside the window would inherit the authentication silently.
 */
enum class KeyAuthenticator {
	/** Per-use biometric — the primary Authority signing key and the Voter attestation key. */
	BIOMETRIC_STRONG,

	/**
	 * Per-use device credential (PIN/pattern/password OR biometric, whichever the lock screen
	 * accepts) — the D-16 recovery key. `setInvalidatedByBiometricEnrollment` governs only
	 * biometric-auth keys, so a key created with this authenticator SURVIVES a biometric
	 * re-enrolment that would otherwise permanently strand [BIOMETRIC_STRONG]-authenticated keys.
	 * **Unproven until D-24 leg 3 on real hardware** — do not take this from the docs (D-16).
	 */
	DEVICE_CREDENTIAL,
}

/**
 * P-256 curve order `n` and `n/2` (49-RESEARCH.md Pattern 3, computed from
 * `@noble/curves/nist.js:17`) — used by [derToCompactLowS]'s low-S normalization, which must match
 * `@noble/curves` v2's `lowS: true` verify-side default exactly.
 */
private val P256_ORDER = BigInteger(
	"ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", 16
)
private val P256_HALF_ORDER = P256_ORDER.shiftRight(1)

/**
 * DER `SEQUENCE { INTEGER r, INTEGER s }` (Java `Signature.sign()`'s output for an EC key) ->
 * 64-byte compact `r||s`, with `s` normalized to the lower half of the P-256 order (D-04,
 * 49-RESEARCH.md Pattern 3 — copied verbatim, no third-party ASN.1 dependency per "Don't
 * Hand-Roll": a general ASN.1 library is unjustified weight for this one fixed-shape parse).
 *
 * This is the byte-level contract `signWithDeviceKey` must satisfy for the signature to verify
 * against `@noble/curves` v2's `p256.verify()` defaults (`prehash: true`, `lowS: true`,
 * `format: 'compact'`) with zero JS-side changes.
 */
private fun derToCompactLowS(der: ByteArray): ByteArray {
	// Minimal ASN.1 walk: SEQUENCE tag(0x30) + length, then two INTEGER(0x02) TLVs. Assumes
	// short-form DER length encoding throughout — always true for a P-256 ECDSA signature (r and s
	// are each <= 33 bytes, well under the 128-byte long-form threshold); the require() below is
	// cheap insurance against a misparse rather than a real expected failure mode.
	require(der.size >= 2 && der[0] == 0x30.toByte()) { "expected DER SEQUENCE tag" }
	require((der[1].toInt() and 0x80) == 0) { "unexpected long-form DER SEQUENCE length in ECDSA signature" }
	var offset = 2 // skip SEQUENCE tag + length byte

	// First INTEGER TLV -> r. Two-arg unsigned BigInteger constructor: a DER INTEGER's payload can
	// itself carry a leading 0x00 sign-pad byte, which must NOT be interpreted as sign information a
	// second time — the single-arg (signed) BigInteger(bytes) constructor would double-count it.
	require(der[offset] == 0x02.toByte()) { "expected DER INTEGER tag for r" }
	offset++
	val rLen = der[offset].toInt() and 0xFF
	offset++
	val rBytes = der.copyOfRange(offset, offset + rLen)
	offset += rLen
	val r = BigInteger(1, rBytes)

	// Second INTEGER TLV -> s. Same unsigned-constructor discipline as r above.
	require(der[offset] == 0x02.toByte()) { "expected DER INTEGER tag for s" }
	offset++
	val sLen = der[offset].toInt() and 0xFF
	offset++
	val sBytes = der.copyOfRange(offset, offset + sLen)
	offset += sLen
	var s = BigInteger(1, sBytes)

	if (s > P256_HALF_ORDER) {
		s = P256_ORDER.subtract(s) // low-S normalization (matches noble's lowS:true default)
	}
	return fixed32(r) + fixed32(s)
}

/**
 * `BigInteger` -> exactly 32 big-endian bytes. `BigInteger.toByteArray()` is signed
 * two's-complement output: for a positive 256-bit value whose top bit is set it PREPENDS an extra
 * `0x00` byte (33 bytes total) to keep the result non-negative — the 33-byte branch strips exactly
 * that byte. For small values it can return FEWER than 32 bytes — the left-pad branch handles that
 * (effectively unreachable for real signature scalars, but guards a real-world r/s that starts with
 * several zero bits).
 */
private fun fixed32(n: BigInteger): ByteArray {
	val raw = n.toByteArray()
	return when {
		raw.size == 32 -> raw
		raw.size == 33 && raw[0] == 0.toByte() -> raw.copyOfRange(1, 33)
		raw.size < 32 -> ByteArray(32 - raw.size) + raw
		else -> throw IllegalStateException("unexpected scalar byte length: ${raw.size}")
	}
}

/**
 * X.509 `SubjectPublicKeyInfo` DER (the shape `java.security.PublicKey.getEncoded()` returns for an
 * AndroidKeyStore EC key) -> 33-byte compressed SEC1 point, hex-encoded lowercase (49-RESEARCH.md
 * Pattern 4). The SPKI BIT STRING payload for a P-256/`secp256r1` key is the UNCOMPRESSED 65-byte
 * point `0x04 || X(32) || Y(32)`; every `UserKey.PubKey` in this schema is a 33-byte COMPRESSED
 * point (`device-user.ts:50`'s `secp256k1.getPublicKey(privKey, true)` convention) — storing the
 * raw SPKI blob (or the uncompressed 65-byte point) as-is would silently break the fixed-shape
 * `UserKey.PubKey` column and every `verify()` call that decodes it.
 *
 * Does NOT hardcode a fixed byte offset for the point (RESEARCH Assumption A2 flags that an OEM
 * Keystore's named-curve OID encoding could shift it) — instead walks the outer SEQUENCE, skips the
 * `AlgorithmIdentifier` SEQUENCE using its own declared length, then reads the BIT STRING (tag
 * 0x03), skips its unused-bits byte, and requires the first payload byte to be 0x04 with an exactly
 * 65-byte payload. A malformed input throws naming the actual first byte and payload length — the
 * value D-24 leg 1 reads off logcat to confirm this parse on-device before it is trusted.
 */
private fun spkiToCompressedPointHex(spki: ByteArray): String {
	require(spki.isNotEmpty() && spki[0] == 0x30.toByte()) { "expected outer DER SEQUENCE (SubjectPublicKeyInfo)" }
	var offset = 1
	val (outerLen, outerLenBytes) = readDerLength(spki, offset)
	offset += outerLenBytes
	val outerEnd = offset + outerLen

	// AlgorithmIdentifier SEQUENCE — skip using its own declared length, never a hardcoded offset.
	require(offset < outerEnd && spki[offset] == 0x30.toByte()) { "expected AlgorithmIdentifier SEQUENCE" }
	offset++
	val (algLen, algLenBytes) = readDerLength(spki, offset)
	offset += algLenBytes + algLen

	// BIT STRING (tag 0x03): 1-byte "unused bits" count (0 for a byte-aligned EC point) precedes
	// the point payload.
	require(offset < outerEnd && spki[offset] == 0x03.toByte()) { "expected BIT STRING tag for SPKI public key" }
	offset++
	val (bitStrLen, bitStrLenBytes) = readDerLength(spki, offset)
	offset += bitStrLenBytes
	val unusedBits = spki[offset].toInt() and 0xFF
	require(unusedBits == 0) { "unexpected non-zero BIT STRING unused-bits count: $unusedBits" }
	offset++
	val payloadLen = bitStrLen - 1
	val payload = spki.copyOfRange(offset, offset + payloadLen)

	val firstByte = payload.getOrNull(0)?.toInt()?.and(0xFF)
	require(firstByte == 0x04 && payload.size == 65) {
		"malformed EC SubjectPublicKeyInfo payload — expected 0x04-prefixed 65-byte uncompressed " +
			"point, got first byte ${firstByte?.let { "0x%02x".format(it) } ?: "<empty>"} and " +
			"payload length ${payload.size}"
	}

	val x = payload.copyOfRange(1, 33)
	val y = payload.copyOfRange(33, 65)
	val yIsEven = (y[y.size - 1].toInt() and 1) == 0
	val prefix: Byte = if (yIsEven) 0x02 else 0x03
	val compressed = byteArrayOf(prefix) + x
	return compressed.joinToString("") { "%02x".format(it) }
}

/** Short-form-or-long-form DER length reader. Returns (length, bytesConsumedForTheLengthField). */
private fun readDerLength(bytes: ByteArray, offset: Int): Pair<Int, Int> {
	val first = bytes[offset].toInt() and 0xFF
	return if ((first and 0x80) == 0) {
		first to 1
	} else {
		val numLenBytes = first and 0x7F
		var len = 0
		for (i in 1..numLenBytes) {
			len = (len shl 8) or (bytes[offset + i].toInt() and 0xFF)
		}
		len to (1 + numLenBytes)
	}
}

/** Result of a (placeholder or attested) P-256 keygen. */
data class ProvisionResult(
	val publicKeyBase64: String,
	val keyAlias: String,
	// "strongbox" | "tee" | "software" — the last rung is unreachable in a release build (T-45-04/CR-03).
	val securityLevel: String,
	// 33-byte compressed SEC1 point, hex-encoded (D-04/RESEARCH Pattern 4) — the form callers MUST
	// register as `UserKey.PubKey`. `publicKeyBase64` above remains the raw X.509 SPKI DER,
	// consumed only by the Phase 45 attestation cert-chain path.
	val publicKeyCompressedHex: String,
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
 * 49-14 follow-up (D-16 observability defect) — thrown by [KeyAttestationHelper.generateRecoveryKey]
 * when the alias already holds a key that Keystore has permanently invalidated
 * ([KeyPermanentlyInvalidatedException] on [Signature.initSign]). This is precisely the D-16 FAIL
 * signal: a [KeyAuthenticator.DEVICE_CREDENTIAL]-authenticated key is claimed to survive a
 * biometric re-enrolment that strands [KeyAuthenticator.BIOMETRIC_STRONG] keys — if it did NOT
 * survive, that must be observable, not silently masked by regenerating a fresh key under the same
 * alias (which is what the unconditional-regenerate defect this exception replaces used to do).
 * Regenerating the recovery alias in response to this state may only ever be an explicit,
 * separately-triggered recovery-of-the-recovery action — never an implicit side effect of the
 * normal provisioning/recovery ceremony, which is why [generateRecoveryKey] throws here instead of
 * deleting and regenerating like [generateProvisionKey]/[regenerateAttested] do for the signing key.
 */
class RecoveryKeyInvalidatedException(cause: Throwable) : Exception(
	"recovery key at this alias has been permanently invalidated (KeyPermanentlyInvalidatedException) " +
		"— the D-16 device-credential recovery key did NOT survive whatever biometric enrollment " +
		"change occurred; this is a FAIL signal, not an error to silently regenerate past",
	cause,
)

/** [KeyAttestationHelper.readCurrentKey]: no key exists under the alias. Nothing is created. */
class DeviceKeyAbsentException(keyAlias: String) : Exception(
	"no device key exists under alias $keyAlias (read-only lookup — nothing was generated)",
)

/**
 * [KeyAttestationHelper.readCurrentKey]: the key under the alias is permanently invalidated
 * (KeyPermanentlyInvalidatedException from initSign). Surfaced, never deleted or regenerated.
 */
/**
 * Spike 104 (R1d) — the voting key exists but carries no attestation chain (it was provisioned
 * without a challenge, before R1d). Its hardware backing cannot be proven, so a ceremony must
 * re-provision rather than answer with it.
 */
class DeviceKeyNotAttestedException(keyAlias: String) : Exception(
	"the key under $keyAlias carries no attestation chain — provision it with provisionAttestedDeviceKey",
)

/** [KeyAttestationHelper.attestFresh]'s result: both chains (leaf-first, root dropped) and the voting key. */
data class FreshAttestation(
	val deviceKeyCertificateChain: List<String>,
	val freshCertificateChain: List<String>,
	val deviceKeyCompressedHex: String,
)

class DeviceKeyInvalidatedException(cause: Throwable) : Exception(
	"device key at this alias has been permanently invalidated (KeyPermanentlyInvalidatedException)",
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

	/** D-110..D-112: the single pending device-key/recovery-key sign. Vault prompts never enter it. */
	private val pendingSignGate = PendingSignGate()

	/**
	 * (1) Placeholder-provision (Open Q1): generate the P-256 key ONCE with NO attestation
	 * challenge and no biometric prompt. Mere key CREATION does not require a fresh biometric —
	 * that gate applies at key USE time in [regenerateAttested].
	 *
	 * This deliberately produces a NON-attested key. An earlier revision passed a zero-length
	 * challenge here, on the belief that "Android requires SOME setAttestationChallenge(...) call
	 * to obtain an attestation-carrying cert chain at all". That belief was wrong in a way only
	 * StrongBox hardware exposes: an empty challenge is a REQUEST for attestation carrying an
	 * INVALID challenge, which KeyMint rejects with ATTESTATION_CHALLENGE_MISSING (measured on a
	 * Pixel 7 Pro / Titan M2 — see [generateKey]). It is also moot: the placeholder's chain is
	 * never exported, because [regenerateAttested] deletes and regenerates this alias with the
	 * real utf8(BOUND_DIGEST) challenge before exporting anything.
	 */
	fun generateProvisionKey(keyAlias: String): ProvisionResult {
		return generateKey(keyAlias, attestationChallenge = null, authenticator = KeyAuthenticator.BIOMETRIC_STRONG)
	}

	/**
	 * Spike 104 (R1d) — the Voter's voting key, generated WITH an attestation chain. Same key spec
	 * as [generateProvisionKey] (regenerates the alias, no prompt), but [attestationChallenge] is a
	 * fixed provisioning tag: no authority nonce exists yet, because this key signs the association
	 * request that the nonce answers. Its chain is what proves the VOTING key itself is
	 * hardware-backed; the nonce is answered later by [attestFresh]'s throwaway key, so this key is
	 * never deleted or replaced by the ceremony.
	 *
	 * [attestationChallenge] must be non-empty: an empty challenge is a request for attestation with
	 * an INVALID challenge, which StrongBox refuses (see [generateKey]).
	 */
	fun generateAttestedProvisionKey(keyAlias: String, attestationChallenge: ByteArray): ProvisionResult {
		require(attestationChallenge.isNotEmpty()) { "attestation challenge must be non-empty" }
		return generateKey(keyAlias, attestationChallenge = attestationChallenge, authenticator = KeyAuthenticator.BIOMETRIC_STRONG)
	}

	/**
	 * Spike 104 (R1d) — answer an authority nonce WITHOUT touching the voting key under [keyAlias].
	 *
	 * `setAttestationChallenge` is keygen-time, so the nonce can only be bound into a NEW key. The
	 * old design ([regenerateAttested]) made that new key the voting key by deleting the one that
	 * had signed the request — leaving the challenge naming a key the phone no longer held. Here the
	 * new key is a throwaway under [freshAliasFor]: it is generated with [attestationChallengeBytes]
	 * (utf8(BOUND_DIGEST)), its chain exported, and it is deleted before returning. The voting key
	 * stays, and later signs the answer that carries both chains.
	 *
	 * No biometric prompt: the throwaway key never signs, and nothing here uses the voting key's
	 * private half. [Signature.initSign] is only the same validity probe [readCurrentKey] uses.
	 *
	 * Throws [DeviceKeyAbsentException] (no voting key), [DeviceKeyInvalidatedException] (it can no
	 * longer sign the answer), [DeviceKeyNotAttestedException] (provisioned without a chain, e.g. by
	 * [generateProvisionKey] before R1d), or [NoStrongBoxOrTeeException] from the throwaway keygen.
	 */
	fun attestFresh(keyAlias: String, attestationChallengeBytes: ByteArray): FreshAttestation {
		if (!keyStore.containsAlias(keyAlias)) {
			throw DeviceKeyAbsentException(keyAlias)
		}
		try {
			val privateKey = keyStore.getKey(keyAlias, null) as? PrivateKey
				?: throw DeviceKeyAbsentException(keyAlias)
			Signature.getInstance("SHA256withECDSA").initSign(privateKey)
		} catch (e: KeyPermanentlyInvalidatedException) {
			throw DeviceKeyInvalidatedException(e)
		}
		// A key generated without attestation has a one-certificate, self-signed "chain".
		val deviceChain = keyStore.getCertificateChain(keyAlias)
		if (deviceChain == null || deviceChain.size < 2) {
			throw DeviceKeyNotAttestedException(keyAlias)
		}

		val freshAlias = freshAliasFor(keyAlias)
		try {
			generateKey(freshAlias, attestationChallenge = attestationChallengeBytes)
			return FreshAttestation(
				// D-15b — leaf+intermediates only, as exportCertificateChain does.
				deviceKeyCertificateChain = deviceChain.dropLast(1).map { Base64.encodeToString(it.encoded, Base64.NO_WRAP) },
				freshCertificateChain = exportCertificateChain(freshAlias),
				deviceKeyCompressedHex = spkiToCompressedPointHex(deviceChain[0].publicKey.encoded),
			)
		} finally {
			try {
				keyStore.deleteEntry(freshAlias)
			} catch (e: Exception) {
				// Best effort: a leftover throwaway key is harmless, and the next call regenerates it.
			}
		}
	}

	/** The throwaway alias [attestFresh] attests under — never a voting, recovery or wrap alias. */
	private fun freshAliasFor(keyAlias: String): String = "${keyAlias}_FRESH_ATTESTATION"

	/**
	 * READ-ONLY current-key accessor. Resolves the public key presently stored under [keyAlias]
	 * WITHOUT generating, deleting, prompting, or otherwise mutating the Keystore. Unlike
	 * [generateProvisionKey] (which regenerates the alias on every call), this is safe for pure
	 * lookups. `initSign` is the same validity probe [reuseExistingRecoveryKey] uses: it throws
	 * [KeyPermanentlyInvalidatedException] before any prompt is shown.
	 */
	fun readCurrentKey(keyAlias: String): ProvisionResult {
		if (!keyStore.containsAlias(keyAlias)) {
			throw DeviceKeyAbsentException(keyAlias)
		}
		try {
			val privateKey = keyStore.getKey(keyAlias, null) as? PrivateKey
				?: throw DeviceKeyAbsentException(keyAlias)
			Signature.getInstance("SHA256withECDSA").initSign(privateKey)
		} catch (e: KeyPermanentlyInvalidatedException) {
			throw DeviceKeyInvalidatedException(e)
		}
		val certificate = keyStore.getCertificate(keyAlias)
			?: throw DeviceKeyAbsentException(keyAlias)
		val publicKey = certificate.publicKey
		return ProvisionResult(
			publicKeyBase64 = Base64.encodeToString(publicKey.encoded, Base64.NO_WRAP),
			keyAlias = keyAlias,
			securityLevel = resolveExistingKeySecurityLevel(keyAlias),
			publicKeyCompressedHex = spkiToCompressedPointHex(publicKey.encoded),
		)
	}

	/**
	 * Phase 49 (D-16) — provision the second Authority Keystore alias with
	 * [KeyAuthenticator.DEVICE_CREDENTIAL]. Unlike [generateProvisionKey]/[regenerateAttested]'s
	 * two-step placeholder-then-attested dance (Open Q1, a Voter-app/D-11 concern with no analog
	 * here — the Authority app has no attestation flow to bind a challenge to), this key is
	 * generated once, directly, with no attestation challenge at all: it exists purely to sign a
	 * replacement key back into `UserKey` when the primary biometric key is invalidated, not to
	 * produce a verifier-consumed cert chain.
	 *
	 * 49-14 follow-up (real-hardware defect surfaced during D-24 leg 3) — **REUSE PATH, deliberately
	 * added ONLY here, never in the shared [generateKey] core.** The prior unconditional-regenerate
	 * behavior meant every call — including `ProvisionSigningKeyScreen.tsx`'s `handleRecovery`
	 * re-resolving "the same alias already provisioned during first-run" — silently REPLACED the
	 * Keystore entry, so the ceremony destroyed the very key its own `UserKey.DeleteValid` CHECK
	 * needed to already be registered, and could never observe whether the ORIGINAL key survived a
	 * biometric re-enrolment (D-16's actual claim). Now: if [keyAlias] already holds a key, this
	 * function validates it is still usable — via [Signature.initSign], the SAME operation
	 * [signWithRecoveryKey] already relies on to surface [KeyPermanentlyInvalidatedException] — and
	 * returns its EXISTING public value rather than regenerating. An invalidated key throws
	 * [RecoveryKeyInvalidatedException] (see its own doc comment for why that must never be
	 * silently papered over). Only a genuinely ABSENT alias falls through to a real first-time
	 * [generateKey] call.
	 *
	 * Does NOT touch [generateProvisionKey]/[regenerateAttested]'s signing-key path, which is
	 * SHARED with this alias's [generateKey] core but whose regenerate-under-the-same-alias
	 * behavior during recovery (`handleRecovery`'s step 1, `provisionDeviceKey`) is CORRECT and
	 * must stay unconditional — the signing key alias always names the CURRENT signer, with no
	 * analogous "was this the same key as before" question to answer.
	 */
	fun generateRecoveryKey(keyAlias: String): ProvisionResult {
		if (keyStore.containsAlias(keyAlias)) {
			return reuseExistingRecoveryKey(keyAlias)
		}
		return generateKey(keyAlias, attestationChallenge = null, authenticator = KeyAuthenticator.DEVICE_CREDENTIAL)
	}

	/**
	 * [generateRecoveryKey]'s reuse-path helper — validates the existing [keyAlias] entry is still
	 * usable and, if so, resolves a [ProvisionResult] describing it WITHOUT any `generateKeyPair()`
	 * call (no Keystore mutation at all). [Signature.initSign] is the validity probe: per
	 * [signWithDeviceKey]/[signWithRecoveryKey]'s identical pattern elsewhere in this file, Android
	 * throws [KeyPermanentlyInvalidatedException] from `initSign()` itself (before any biometric/
	 * device-credential prompt is ever shown) when the underlying key material is gone — this is
	 * the SAME check, reused rather than re-derived, so this function's classification of "usable"
	 * can never drift from what a real sign attempt would discover.
	 */
	private fun reuseExistingRecoveryKey(keyAlias: String): ProvisionResult {
		try {
			val privateKey = keyStore.getKey(keyAlias, null) as PrivateKey
			val signature = Signature.getInstance("SHA256withECDSA")
			signature.initSign(privateKey)
		} catch (e: KeyPermanentlyInvalidatedException) {
			throw RecoveryKeyInvalidatedException(e)
		}

		val certificate = keyStore.getCertificate(keyAlias)
			?: throw IllegalStateException("no certificate for existing recovery alias $keyAlias")
		val publicKey = certificate.publicKey
		return ProvisionResult(
			publicKeyBase64 = Base64.encodeToString(publicKey.encoded, Base64.NO_WRAP),
			keyAlias = keyAlias,
			securityLevel = resolveExistingKeySecurityLevel(keyAlias),
			publicKeyCompressedHex = spkiToCompressedPointHex(publicKey.encoded),
		)
	}

	/**
	 * Best-effort security-level readback for [reuseExistingRecoveryKey] — [ProvisionResult]'s
	 * `securityLevel` field is informational only (no caller in `AttestationNativeModule.kt` or the
	 * JS layer branches on it; confirmed by direct source read before adding this), so a
	 * best-effort classification here is safe. [KeyInfo.getSecurityLevel] (the precise
	 * strongbox/TEE/software discriminant [generateKey] itself derives structurally, by which rung
	 * of its own try/catch cascade succeeded) is API 31+ only; below that, [KeyInfo.isInsideSecureHardware]
	 * is the coarsest available signal (true for either hardware rung, no strongbox/TEE distinction).
	 */
	private fun resolveExistingKeySecurityLevel(keyAlias: String): String {
		return try {
			val privateKey = keyStore.getKey(keyAlias, null) as PrivateKey
			val keyInfo = KeyFactory.getInstance(privateKey.algorithm, ANDROID_KEYSTORE)
				.getKeySpec(privateKey, KeyInfo::class.java)
			if (Build.VERSION.SDK_INT >= 31) {
				when (keyInfo.securityLevel) {
					KeyProperties.SECURITY_LEVEL_STRONGBOX -> "strongbox"
					KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "tee"
					else -> "software"
				}
			} else {
				if (keyInfo.isInsideSecureHardware) "tee" else "software"
			}
		} catch (e: Exception) {
			// Purely informational field (see doc comment above) — never fail the reuse path over
			// an inability to classify the existing key's hardware backing.
			"unknown"
		}
	}

	/**
	 * (2) Delete + regenerate under [keyAlias] WITH the real attestation challenge bytes
	 * ([attestationChallengeBytes] — utf8(BOUND_DIGEST), already decoded by the caller per
	 * ATTESTATION-CONTRACT.md §3; this helper does NOT re-derive them), then force a fresh
	 * biometric via [BiometricPrompt.authenticate] bound to a [Signature] over the new key (D-06)
	 * before exporting the cert chain. BiometricPrompt is callback-based, not synchronously
	 * returnable — results are delivered via [onResult]/[onError].
	 *
	 * **This function cannot surface [KeyPermanentlyInvalidatedException], by construction** — and
	 * so, unlike [signWithDeviceKey]/[signWithRecoveryKey], it takes no re-association callback.
	 * `setAttestationChallenge` is a KEYGEN-TIME parameter: the challenge is baked into the
	 * attestation certificate when the key pair is created and cannot be rebound afterwards. So
	 * answering a new challenge REQUIRES a new key, which is why the delete+regenerate below is
	 * unconditional rather than a recovery step. The key this function signs with is therefore
	 * always microseconds old, created AFTER any biometric enrolment the user could have made, and
	 * nothing can have invalidated it. See
	 * `.planning/todos/pending/2026-08-03-attestation-d13-key-invalidation-leg.md`.
	 */
	fun regenerateAttested(
		keyAlias: String,
		attestationChallengeBytes: ByteArray,
		activity: FragmentActivity,
		onResult: (List<String>) -> Unit,
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
		} catch (e: Exception) {
			// NO `catch (e: KeyPermanentlyInvalidatedException)` HERE — REMOVED 2026-08-24 as
			// provably dead code, do not re-add it. It sat above this generic catch and claimed to
			// implement D-13 (delete the invalidated key, regenerate, route into forced
			// re-association), but it could never run: `initSign` above operates on the key
			// generated ~microseconds earlier by THIS call, so no biometric enrolment the user
			// could have performed is able to invalidate it. Its cleanup arm was worse than inert
			// — it would have replaced the attested key with a NON-attested placeholder.
			//
			// The dead branch also mis-stated the design. Regeneration is not recovery: it is
			// mandatory, because `setAttestationChallenge` can only be supplied at keygen (see the
			// doc comment above). The security property this path actually provides is KEY
			// NON-REUSE — no attested key survives across ceremonies — which is strictly stronger
			// than detect-then-recover.
			//
			// `KeyPermanentlyInvalidatedException` IS handled, for real and on reachable paths, in
			// `signWithDeviceKey` and `signWithRecoveryKey`, which sign with a PERSISTENT key they
			// do not regenerate first. That is where the hardware proof lives (D-24 leg 3,
			// `49-14-PROOF-LOG.md` §F). Should the impossible somehow occur here, it lands in this
			// generic catch as `KEY_ATTESTATION_FAILED` — fail-closed, which is correct.
			onError("KEY_ATTESTATION_FAILED", e)
			return
		}

		val cryptoObject = BiometricPrompt.CryptoObject(signature)
		val promptInfo = BiometricPrompt.PromptInfo.Builder()
			.setTitle("Confirm your identity")
			.setSubtitle("Verify to produce your device attestation")
			.setNegativeButtonText("Cancel")
			.build()

		// 45-11 DEVICE FINDING — BiometricPrompt's constructor attaches a Fragment to the
		// FragmentActivity's FragmentManager, and `authenticate()` commits it. BOTH must run on
		// the main/UI thread. This helper is invoked from the TurboModule's calling thread (the
		// native-modules thread), so constructing the prompt here threw
		// `Must be called from main thread of fragment host` and no prompt was ever presented.
		// `ContextCompat.getMainExecutor(...)` below only routes the CALLBACKS to main — it does
		// NOT affect the construction or the authenticate() call, which is why this went unnoticed.
		// Jest is structurally blind to this; 45-09 never reached it because the stub producer
		// short-circuited produce() entirely.
		UiThreadUtil.runOnUiThread {
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
					//
					// Gap B (49-15, 49-GAPS.md corrected root cause) — THE CLOSING CHANGE. This is
					// the ONLY onAuthenticationError this function ever had, and it previously had NO
					// cancellation branch at all: every dismissal (ERROR_CANCELED/5,
					// ERROR_USER_CANCELED/10, ERROR_NEGATIVE_BUTTON/13) fell through to
					// "BIOMETRIC_ERROR", which produceAttestation forwarded verbatim and
					// mapDeviceSigningError rendered as deviceSigningErrorGeneric — the ONLY signing
					// prompt a pm-clear device can reach (ProvisionSigningKeyScreen's first-run
					// produceAttestation call). Adding this branch does NOT touch the two branches
					// below it, which still fold their two respective codes into a single "LOCKOUT",
					// exactly as the signWithDeviceKey-area comment (now updated) still protects.
					val code = when (errorCode) {
						BiometricPrompt.ERROR_CANCELED,
						BiometricPrompt.ERROR_USER_CANCELED,
						BiometricPrompt.ERROR_NEGATIVE_BUTTON -> "CANCELED"
						BiometricPrompt.ERROR_NO_BIOMETRICS -> "NO_BIOMETRICS_ENROLLED"
						BiometricPrompt.ERROR_LOCKOUT, BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> "LOCKOUT"
						else -> "BIOMETRIC_ERROR"
					}
					Log.i(
						TAG_SIGNING_REJECT,
						"produceAttestation errorCode=$errorCode mapped=$code",
					)
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
	}

	/**
	 * (Phase 49, D-06/D-04) Produce a biometric-gated, hardware-backed P-256 signature over
	 * [digestBytes] using the key under [keyAlias]. Follows [regenerateAttested]'s ceremony shape
	 * exactly (resolve key -> catch [KeyPermanentlyInvalidatedException] FIRST -> build
	 * [BiometricPrompt.CryptoObject] -> dispatch on the UI thread -> three-callback
	 * [BiometricPrompt.AuthenticationCallback]), with one addition: unlike [regenerateAttested]
	 * (where the biometric gate alone was the proof — key ATTESTATION needs no signature),
	 * [onAuthenticationSucceeded] here actually signs [digestBytes] and returns the normalized
	 * compact signature — a real signature is the product, not just the biometric check.
	 *
	 * Does NOT recompute [digestBytes] — [AttestationNativeModule] already base64-decoded the
	 * bridge payload (D-04/T-49-DER-2) before calling this.
	 */
	fun signWithDeviceKey(
		keyAlias: String,
		digestBytes: ByteArray,
		activity: FragmentActivity,
		promptTitle: String,
		promptSubtitle: String,
		promptNegativeButton: String,
		onResult: (String) -> Unit,
		onKeyInvalidatedReassociate: () -> Unit,
		onError: (code: String, throwable: Throwable?) -> Unit,
	) {
		vtSignLog("sign start kind=DEVICE")
		// 49-UI-SPEC.md's explicitly-flagged sixth condition: no key has EVER been provisioned
		// under this alias — detected BEFORE any prompt is shown, so it must not be collapsed into
		// BIOMETRIC_ERROR (that class implies a prompt was actually presented and failed).
		if (!keyStore.containsAlias(keyAlias)) {
			vtSignLog("sign refused kind=DEVICE code=NO_KEY_PROVISIONED")
			onError("NO_KEY_PROVISIONED", IllegalStateException("no key provisioned under alias $keyAlias"))
			return
		}

		val signature: Signature
		try {
			val privateKey = keyStore.getKey(keyAlias, null) as PrivateKey
			signature = Signature.getInstance("SHA256withECDSA")
			signature.initSign(privateKey)
		} catch (e: KeyPermanentlyInvalidatedException) {
			// D-13 — caught FIRST, exactly like regenerateAttested — never falls through to the
			// generic catch below. The device's biometric enrollment changed since this alias's key
			// was created; route the caller to restart the D-11 provisioning ceremony.
			vtSignLog("sign refused kind=DEVICE code=KEY_INVALIDATED_REASSOCIATE")
			onKeyInvalidatedReassociate()
			return
		} catch (e: Exception) {
			vtSignLog("sign refused kind=DEVICE code=BIOMETRIC_ERROR class=${e.javaClass.simpleName}")
			onError("BIOMETRIC_ERROR", e)
			return
		}

		val cryptoObject = BiometricPrompt.CryptoObject(signature)
		val promptInfo = BiometricPrompt.PromptInfo.Builder()
			.setTitle(promptTitle)
			.setSubtitle(promptSubtitle)
			.setNegativeButtonText(promptNegativeButton)
			.build()

		// 45-11 DEVICE FINDING (MUST preserve, T-49-KEY-2): BiometricPrompt construction AND
		// authenticate() both require the main/UI thread. This helper is invoked from the
		// TurboModule's calling thread (the native-modules thread), so both calls stay wrapped here
		// exactly as regenerateAttested wraps them above. Jest is structurally blind to this device-
		// only defect — do not move either call off the UI thread.
		//
		// D-112: reserve on THIS thread before posting, so a cancel arriving between here and the UI
		// runnable finds the record (and the runnable then shows nothing) rather than finding nothing
		// and leaving an orphaned prompt. A second sign while one is pending never constructs a prompt.
		val settle = SettleOnce(onResult, onError, "DEVICE")
		val pending = pendingSignGate.tryReserve(PendingSignKind.DEVICE, settle)
		if (pending == null) {
			Log.i(TAG_SIGNING_REJECT, "signWithDeviceKey mapped=PROMPT_BUSY reason=pending")
			settle.error("PROMPT_BUSY", IllegalStateException("another sign is pending"))
			return
		}
		vtSignLog("reserve ok kind=DEVICE")
		UiThreadUtil.runOnUiThread {
			// A cancel already settled this sign: show nothing.
			if (!pendingSignGate.isHeld(pending)) return@runOnUiThread
			// WR-02: an activity that cannot host a prompt makes androidx.biometric 1.1.0 return from
			// authenticate() with no callback, which would hold the gate forever. Refuse up front, as
			// NO_ACTIVITY (round-3 WR-02): the app has no foreground activity that can show a prompt
			// (typically it is in the background), which callers must tell apart from a hardware error.
			if (!canHostBiometricPrompt(activity)) {
				pendingSignGate.release(pending)
				Log.i(TAG_SIGNING_REJECT, "signWithDeviceKey mapped=NO_ACTIVITY reason=host-cannot-show")
				settle.error("NO_ACTIVITY", IllegalStateException("the activity cannot host a biometric prompt"))
				return@runOnUiThread
			}
			// A BiometricFragment already attached (for example a vault prompt): constructing a
			// BiometricPrompt would re-register that sheet's callback (androidx.biometric 1.1.0), so
			// refuse BEFORE construction.
			if (isBiometricFragmentAttached(activity)) {
				pendingSignGate.release(pending)
				Log.i(TAG_SIGNING_REJECT, "signWithDeviceKey mapped=PROMPT_BUSY reason=prompt-showing")
				settle.error("PROMPT_BUSY", IllegalStateException("a biometric prompt is already showing"))
				return@runOnUiThread
			}
			try {
			val biometricPrompt = BiometricPrompt(
				activity,
				ContextCompat.getMainExecutor(reactContext),
				object : BiometricPrompt.AuthenticationCallback() {
					override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
						// D-06/signWithDeviceKey NEW (unlike regenerateAttested, which has no
						// explicit .sign() call): take the CryptoObject's per-use-authenticated
						// Signature, sign the raw digest bytes, and normalize DER -> compact/low-S
						// (D-04) before resolving.
						try {
							val sig = result.cryptoObject!!.signature!!
							sig.update(digestBytes)
							val derSignature = sig.sign()
							val compact = derToCompactLowS(derSignature)
							val hex = compact.joinToString("") { b -> "%02x".format(b) }
							pendingSignGate.release(pending)
							settle.result(hex)
						} catch (e: Exception) {
							pendingSignGate.release(pending)
							settle.error("BIOMETRIC_ERROR", e)
						}
					}

					override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
						// D-13 — cancellation branch FIRST, distinct from the four existing classes;
						// regenerateAttested collapses both lockout codes into LOCKOUT — this mapping
						// deliberately splits them (different remediation copy, 49-UI-SPEC.md). Do
						// NOT retroactively change regenerateAttested's mapping.
						//
						// 49-15/Gap B: ERROR_CANCELED (5) added alongside the pre-existing
						// ERROR_USER_CANCELED (10) / ERROR_NEGATIVE_BUTTON (13) so all three
						// onAuthenticationError sites in this file classify the same three codes as
						// CANCELED — but this site is not itself the Gap B fix: a pm-clear device
						// (every cancel leg's starting state) can never reach signWithDeviceKey, since
						// it requires an existing provisioning AND a network User. The split/collapse
						// difference between this site and regenerateAttested's lockout handling — not
						// the cancellation handling — is what must not be retroactively changed.
						// (Superseded for this site and the recovery sign by review CR-01 below;
						// regenerateAttested still maps all three to CANCELED.)
						//
						// Review CR-01: ERROR_CANCELED (5) is the SYSTEM ending the prompt (the app went
						// to the background, the screen locked, a call came in, a HAL timeout), not the
						// voter, so it rejects SYSTEM_CANCELED. Only the voter's own dismissals
						// (ERROR_USER_CANCELED 10, ERROR_NEGATIVE_BUTTON 13) reject CANCELED. Our own
						// cancelPendingSign settles CANCELED through settle-once BEFORE it calls
						// cancelAuthentication(), so the late error 5 that cancel provokes loses the
						// settle and is dropped: an app cancel still reaches JS as CANCELED.
						val code = when (errorCode) {
							BiometricPrompt.ERROR_CANCELED -> "SYSTEM_CANCELED"
							BiometricPrompt.ERROR_USER_CANCELED,
							BiometricPrompt.ERROR_NEGATIVE_BUTTON -> "CANCELED"
							BiometricPrompt.ERROR_NO_BIOMETRICS -> "NO_BIOMETRICS_ENROLLED"
							BiometricPrompt.ERROR_LOCKOUT -> "LOCKOUT"
							BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> "LOCKOUT_PERMANENT"
							else -> "BIOMETRIC_ERROR"
						}
						Log.i(
							TAG_SIGNING_REJECT,
							"signWithDeviceKey errorCode=$errorCode mapped=$code",
						)
						pendingSignGate.release(pending)
						settle.error(code, RuntimeException(errString.toString()))
					}

					override fun onAuthenticationFailed() {
						// Biometric mismatch — a retry, NOT an error, per D-13 (BiometricPrompt
						// re-prompts itself; nothing to surface to JS here).
					}
				},
			)
			pending.prompt = biometricPrompt
			vtSignLog("authenticate kind=DEVICE")
			biometricPrompt.authenticate(promptInfo, cryptoObject)
			// WR-02: 1.1.0 adds the BiometricFragment and runs executePendingTransactions() inside
			// authenticate() (javap on the pinned AAR), and every dismissal is an async
			// commitAllowingStateLoss, so no fragment here means authenticate() took a silent early
			// return and no callback will ever come. Release and settle rather than hold the gate. The
			// only known cause is an activity whose state is already saved (the app went to the
			// background between the check above and here), so this is NO_ACTIVITY too.
			if (!isBiometricFragmentAttached(activity)) {
				pendingSignGate.release(pending)
				Log.i(TAG_SIGNING_REJECT, "signWithDeviceKey mapped=NO_ACTIVITY reason=prompt-not-started")
				settle.error("NO_ACTIVITY", IllegalStateException("the biometric prompt was not started"))
			} else {
				vtSignLog("prompt shown kind=DEVICE")
			}
			} catch (e: Exception) {
				// A throw here would leave the gate held and every later sign PROMPT_BUSY.
				vtSignLog("prompt threw kind=DEVICE class=${e.javaClass.simpleName}")
				pendingSignGate.release(pending)
				settle.error("BIOMETRIC_ERROR", e)
			}
		}
	}

	/**
	 * (Phase 49, D-16/D-26a/D-18) Produce a device-credential-authenticated, hardware-backed P-256
	 * signature over [digestBytes] using the recovery key under [keyAlias]. Mirrors
	 * [signWithDeviceKey]'s shape (same [NO_KEY_PROVISIONED]-before-any-prompt check, same
	 * [KeyPermanentlyInvalidatedException]-first catch ordering, same [derToCompactLowS]/
	 * `SHA256withECDSA` [Signature] setup).
	 *
	 * Recovery is supported ONLY on API 30+, via [signRecoveryViaBiometricPrompt] — [BiometricPrompt]
	 * with `setAllowedAuthenticators(DEVICE_CREDENTIAL)` and NO negative button (the platform
	 * forbids combining a negative button with a device-credential authenticator). Recovery is
	 * **explicitly unsupported below API 30**: the function rejects the TERMINAL code
	 * `RECOVERY_UNSUPPORTED_OS` before obtaining a key handle or initializing a [Signature] at all,
	 * immediately after the `containsAlias` check.
	 *
	 * **D-26a rescope, 2026-08-21 — measured, not assumed.** [generateRecoveryKey] creates this key
	 * below API 30 with `setUserAuthenticationRequired(true)` and deliberately no keygen call that
	 * would grant it a positive authentication-validity window — an AUTH-PER-USE key, satisfiable
	 * only through a `CryptoObject`-bound authentication. The platform's `KeyguardManager`
	 * confirm-device-credential intent flow performs a TIME-BOUND authentication and authorizes only
	 * keys with a positive validity duration — it cannot authorize an auth-per-use key. This was the
	 * prior below-API-30 fallback path, and it was measured non-functional (n=2, Redmi 8 / API 29,
	 * both after a clean `pm clear`): the OS launched the confirm-device-credential ceremony, the
	 * credential was entered, the activity returned `RESULT_OK`, and `signature.sign()` threw
	 * `SignatureException: KeyStoreException: Key user not authenticated`. See
	 * `.planning/todos/pending/2026-08-19-d26-keyguard-fallback-cannot-authorize-per-use-key.md` for
	 * the full measurement. Giving the recovery key a positive validity duration below API 30 was
	 * considered and REJECTED — it trades per-use binding for a timed auth window on the very key
	 * this phase exists to protect (the same property D-10 rejected for the primary signing key) —
	 * and must never be reintroduced.
	 *
	 * Before either the OS-version check or the API 30+ ceremony: [KeyguardManager.isDeviceSecure]
	 * is checked. A device with no screen lock at all emits the distinct TERMINAL code
	 * `NO_DEVICE_CREDENTIAL` (D-18) rather than `RECOVERY_UNSUPPORTED_OS` — a more specific truth
	 * (no credential exists at all) than the coarser OS-version truth, and it applies on every API
	 * level, so it is checked first.
	 *
	 * The API 30+ branch is proven by D-24 leg 3 on real hardware (Samsung SM-M166P, API 36) in
	 * 49-14; compilation is
	 * not evidence of it. `promptNegativeButton` is now unused on every path (kept as a parameter
	 * for ABI stability).
	 */
	fun signWithRecoveryKey(
		keyAlias: String,
		digestBytes: ByteArray,
		activity: FragmentActivity,
		promptTitle: String,
		promptSubtitle: String,
		promptNegativeButton: String,
		onResult: (String) -> Unit,
		onKeyInvalidatedReassociate: () -> Unit,
		onError: (code: String, throwable: Throwable?) -> Unit,
	) {
		vtSignLog("sign start kind=RECOVERY")
		val keyguardManager = ContextCompat.getSystemService(reactContext, KeyguardManager::class.java)
		if (keyguardManager == null || !keyguardManager.isDeviceSecure) {
			// D-18 terminal state, checked BEFORE the OS-version check and either ceremony branch —
			// a more specific truth than an unsupported OS version, and applicable on every API level.
			vtSignLog("sign refused kind=RECOVERY code=NO_DEVICE_CREDENTIAL")
			onError("NO_DEVICE_CREDENTIAL", IllegalStateException("device has no screen lock configured"))
			return
		}

		// Same sixth-condition check as signWithDeviceKey (49-UI-SPEC.md) — the recovery alias may
		// simply never have been provisioned yet.
		if (!keyStore.containsAlias(keyAlias)) {
			vtSignLog("sign refused kind=RECOVERY code=NO_KEY_PROVISIONED")
			onError("NO_KEY_PROVISIONED", IllegalStateException("no recovery key provisioned under alias $keyAlias"))
			return
		}

		// D-26a rescope, load-bearing order: this OS-version check runs BEFORE any key handle is
		// obtained or Signature initialized, exactly like the NO_DEVICE_CREDENTIAL check above and
		// the D-18 precedent — below API 30 no ceremony can ever complete (see this function's doc
		// comment for the measured cause), so no ceremony work should be attempted at all.
		if (Build.VERSION.SDK_INT < MIN_SDK_FOR_DEVICE_CREDENTIAL_RECOVERY) {
			vtSignLog("sign refused kind=RECOVERY code=RECOVERY_UNSUPPORTED_OS")
			onError("RECOVERY_UNSUPPORTED_OS", IllegalStateException(
				"recovery is unsupported below API $MIN_SDK_FOR_DEVICE_CREDENTIAL_RECOVERY: the " +
					"recovery key is auth-per-use and KeyguardManager's time-bound " +
					"confirm-device-credential authentication cannot authorize it " +
					"(measured SDK_INT=${Build.VERSION.SDK_INT})",
			))
			return
		}

		val signature: Signature
		try {
			val privateKey = keyStore.getKey(keyAlias, null) as PrivateKey
			signature = Signature.getInstance("SHA256withECDSA")
			signature.initSign(privateKey)
		} catch (e: KeyPermanentlyInvalidatedException) {
			// D-13 — caught FIRST, exactly like signWithDeviceKey. In practice this key's
			// setInvalidatedByBiometricEnrollment flag is a no-op (it governs only biometric-auth
			// keys) so this should not fire from a biometric re-enrolment — but a screen-lock
			// change already routes through the isDeviceSecure() check above, not here, and any
			// OTHER cause of invalidation is still routed identically to signWithDeviceKey.
			vtSignLog("sign refused kind=RECOVERY code=KEY_INVALIDATED_REASSOCIATE")
			onKeyInvalidatedReassociate()
			return
		} catch (e: Exception) {
			vtSignLog("sign refused kind=RECOVERY code=BIOMETRIC_ERROR class=${e.javaClass.simpleName}")
			onError("BIOMETRIC_ERROR", e)
			return
		}

		signRecoveryViaBiometricPrompt(
			signature = signature,
			digestBytes = digestBytes,
			activity = activity,
			promptTitle = promptTitle,
			promptSubtitle = promptSubtitle,
			onResult = onResult,
			onError = onError,
		)
	}

	/** API 30+ branch of [signWithRecoveryKey] — see that function's doc comment for the shape. */
	private fun signRecoveryViaBiometricPrompt(
		signature: Signature,
		digestBytes: ByteArray,
		activity: FragmentActivity,
		promptTitle: String,
		promptSubtitle: String,
		onResult: (String) -> Unit,
		onError: (code: String, throwable: Throwable?) -> Unit,
	) {
		val cryptoObject = BiometricPrompt.CryptoObject(signature)
		// D-26/49-RESEARCH.md "Pitfall 1" — BiometricPrompt.PromptInfo.Builder THROWS at build()
		// time if setNegativeButtonText is combined with setAllowedAuthenticators(DEVICE_CREDENTIAL)
		// — the platform forbids the combination outright. promptNegativeButton is therefore NOT
		// passed to this builder at all (and is now unused on every path — see the doc block
		// above; the branch that once consumed it was removed with the pre-API-30 fallback).
		val promptInfo = BiometricPrompt.PromptInfo.Builder()
			.setTitle(promptTitle)
			.setSubtitle(promptSubtitle)
			.setAllowedAuthenticators(BiometricManager.Authenticators.DEVICE_CREDENTIAL)
			.build()

		// 45-11 DEVICE FINDING (MUST preserve, T-49-KEY-2): same UI-thread wrapping as
		// signWithDeviceKey/regenerateAttested — construction AND authenticate() both require it.
		//
		// D-112: same reserve-before-post and busy checks as signWithDeviceKey.
		val settle = SettleOnce(onResult, onError, "RECOVERY")
		val pending = pendingSignGate.tryReserve(PendingSignKind.RECOVERY, settle)
		if (pending == null) {
			Log.i(TAG_SIGNING_REJECT, "signWithRecoveryKey mapped=PROMPT_BUSY reason=pending")
			settle.error("PROMPT_BUSY", IllegalStateException("another sign is pending"))
			return
		}
		vtSignLog("reserve ok kind=RECOVERY")
		UiThreadUtil.runOnUiThread {
			if (!pendingSignGate.isHeld(pending)) return@runOnUiThread
			if (!canHostBiometricPrompt(activity)) {
				pendingSignGate.release(pending)
				Log.i(TAG_SIGNING_REJECT, "signWithRecoveryKey mapped=NO_ACTIVITY reason=host-cannot-show")
				settle.error("NO_ACTIVITY", IllegalStateException("the activity cannot host a biometric prompt"))
				return@runOnUiThread
			}
			if (isBiometricFragmentAttached(activity)) {
				pendingSignGate.release(pending)
				Log.i(TAG_SIGNING_REJECT, "signWithRecoveryKey mapped=PROMPT_BUSY reason=prompt-showing")
				settle.error("PROMPT_BUSY", IllegalStateException("a biometric prompt is already showing"))
				return@runOnUiThread
			}
			try {
			val biometricPrompt = BiometricPrompt(
				activity,
				ContextCompat.getMainExecutor(reactContext),
				object : BiometricPrompt.AuthenticationCallback() {
					override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
						try {
							val sig = result.cryptoObject!!.signature!!
							sig.update(digestBytes)
							val derSignature = sig.sign()
							val compact = derToCompactLowS(derSignature)
							val hex = compact.joinToString("") { b -> "%02x".format(b) }
							pendingSignGate.release(pending)
							settle.result(hex)
						} catch (e: Exception) {
							pendingSignGate.release(pending)
							settle.error("BIOMETRIC_ERROR", e)
						}
					}

					override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
						// No NO_BIOMETRICS_ENROLLED branch here — that class is meaningless for a
						// DEVICE_CREDENTIAL-only authenticator (it reports absent biometric
						// enrollment, not an absent device credential; NO_DEVICE_CREDENTIAL above
						// already covers the "nothing configured at all" case for this ceremony).
						// Review CR-01: same split as signWithDeviceKey: a system cancel (5) rejects
						// SYSTEM_CANCELED, the voter's own dismissal (10/13) CANCELED, and our own
						// cancelPendingSign has already settled CANCELED so its late 5 is dropped.
						val code = when (errorCode) {
							BiometricPrompt.ERROR_CANCELED -> "SYSTEM_CANCELED"
							BiometricPrompt.ERROR_USER_CANCELED,
							BiometricPrompt.ERROR_NEGATIVE_BUTTON -> "CANCELED"
							BiometricPrompt.ERROR_LOCKOUT -> "LOCKOUT"
							BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> "LOCKOUT_PERMANENT"
							else -> "BIOMETRIC_ERROR"
						}
						// Named for the public entry point (signWithRecoveryKey), never this private
						// branch helper's name, so a proof-log reader can match the line to the JS call
						// that produced it.
						Log.i(
							TAG_SIGNING_REJECT,
							"signWithRecoveryKey errorCode=$errorCode mapped=$code",
						)
						pendingSignGate.release(pending)
						settle.error(code, RuntimeException(errString.toString()))
					}

					override fun onAuthenticationFailed() {
						// Wrong PIN/pattern/password — a retry, NOT an error; the platform re-prompts
						// itself, nothing to surface to JS here.
					}
				},
			)
			pending.prompt = biometricPrompt
			vtSignLog("authenticate kind=RECOVERY")
			biometricPrompt.authenticate(promptInfo, cryptoObject)
			// WR-02: same silent-early-return check as signWithDeviceKey.
			if (!isBiometricFragmentAttached(activity)) {
				pendingSignGate.release(pending)
				Log.i(TAG_SIGNING_REJECT, "signWithRecoveryKey mapped=NO_ACTIVITY reason=prompt-not-started")
				settle.error("NO_ACTIVITY", IllegalStateException("the biometric prompt was not started"))
			} else {
				vtSignLog("prompt shown kind=RECOVERY")
			}
			} catch (e: Exception) {
				vtSignLog("prompt threw kind=RECOVERY class=${e.javaClass.simpleName}")
				pendingSignGate.release(pending)
				settle.error("BIOMETRIC_ERROR", e)
			}
		}
	}

	/**
	 * D-110/D-111: dismiss the pending device-key or recovery-key sign, if any. Order matters: the
	 * sign's JS promise is rejected `CANCELED` FIRST (settle-once, so a late callback is discarded),
	 * THEN the prompt is cancelled on the UI thread, THEN we wait (cap 2 s) until no BiometricFragment
	 * is attached, because androidx.biometric 1.1.0's `authenticate()` reuses a fragment it finds by
	 * tag, so a new sign must not start while the old one is still attached. Nothing pending resolves
	 * `false` at once and touches no fragment (a lone BiometricFragment is a vault prompt, D-110).
	 * We do not rely on 1.1.0 delivering ERROR_CANCELED after a client cancel. INFO logs only; never
	 * digest, signature or key bytes.
	 *
	 * Once a record is taken, [onDone] is always called with `true`, even if posting to the UI thread
	 * throws (review IN-04): the sign was settled, so "nothing was pending" would be false. A sign
	 * whose UI runnable never constructed a prompt (it saw the cancel, or refused) has nothing to
	 * wait for, so [onDone] runs without polling: any attached fragment then belongs to someone else,
	 * such as a vault prompt (review IN-06). [onDone] may be called more than once only if it throws.
	 */
	fun cancelPendingSign(activity: FragmentActivity?, onDone: (Boolean) -> Unit) {
		val p = pendingSignGate.take()
		if (p == null) {
			vtSignLog("cancel start held=false")
			onDone(false)
			return
		}
		vtSignLog("cancel start held=true kind=${p.kind}")
		try {
			cancelTaken(p, activity, onDone)
		} catch (e: Exception) {
			Log.i(TAG_SIGNING_REJECT, "cancelPendingSign kind=${p.kind} threw ${e.javaClass.simpleName}")
			onDone(true)
		}
	}

	private fun cancelTaken(p: PendingSign, activity: FragmentActivity?, onDone: (Boolean) -> Unit) {
		p.settle.error("CANCELED", RuntimeException("sign canceled by the app"))
		Log.i(TAG_SIGNING_REJECT, "cancelPendingSign kind=${p.kind} mapped=CANCELED")
		UiThreadUtil.runOnUiThread {
			// This runnable is posted after the sign's own UI runnable, so a null prompt means that
			// runnable already ran and showed nothing (IN-06): do not wait on an unrelated fragment.
			if (p.prompt == null) {
				Log.i(TAG_SIGNING_REJECT, "cancelPendingSign kind=${p.kind} promptGone=true waitedMs=0 noPrompt=true")
				vtSignLog("cancel end kind=${p.kind} settled=true promptGone=true waitedMs=0 noPrompt=true")
				onDone(true)
				return@runOnUiThread
			}
			try {
				p.prompt?.cancelAuthentication()
			} catch (e: Exception) {
				Log.i(TAG_SIGNING_REJECT, "cancelPendingSign kind=${p.kind} cancelAuthentication threw ${e.javaClass.simpleName}")
			}
			val handler = Handler(Looper.getMainLooper())
			val start = SystemClock.uptimeMillis()
			var finished = false
			fun finish(gone: Boolean) {
				if (finished) return
				finished = true
				Log.i(
					TAG_SIGNING_REJECT,
					"cancelPendingSign kind=${p.kind} promptGone=$gone waitedMs=${SystemClock.uptimeMillis() - start}",
				)
				vtSignLog("cancel end kind=${p.kind} settled=true promptGone=$gone waitedMs=${SystemClock.uptimeMillis() - start}")
				onDone(true)
			}
			lateinit var poll: Runnable
			poll = Runnable {
				val gone = activity == null || !isBiometricFragmentAttached(activity)
				if (gone) {
					finish(true)
				} else if (SystemClock.uptimeMillis() - start >= CANCEL_WAIT_CAP_MS) {
					finish(false)
				} else {
					handler.postDelayed(poll, CANCEL_POLL_STEP_MS)
				}
			}
			poll.run()
		}
	}

	/** (3) D-15b — export leaf+intermediates only; drop the trailing root (verifier pins its own). */
	private fun exportCertificateChain(keyAlias: String): List<String> {
		val chain = keyStore.getCertificateChain(keyAlias)
			?: throw IllegalStateException("no certificate chain for alias $keyAlias")
		return chain.dropLast(1).map { Base64.encodeToString(it.encoded, Base64.NO_WRAP) }
	}

	/**
	 * Gap A prerequisite (49-15, D-04/D-08) — reads the certificate CURRENTLY stored under
	 * [keyAlias] and returns its public key as a 33-byte compressed SEC1 point, hex-encoded. This
	 * is the value a caller MUST register after [regenerateAttested] runs, because that function
	 * deletes and regenerates the alias with a fresh key pair — this helper's own class doc comment
	 * already states that "the regenerated leaf's public key differs from the provision-time key".
	 * Reuses [spkiToCompressedPointHex] (no second DER parser is introduced): the public key's
	 * X.509 `encoded` form IS the same SubjectPublicKeyInfo shape that function already parses.
	 * Same fail-loud posture as [signWithDeviceKey]'s `NO_KEY_PROVISIONED` pre-check — never a
	 * null/empty-string sentinel on a missing alias.
	 */
	fun exportPublicKeyCompressedHex(keyAlias: String): String {
		if (!keyStore.containsAlias(keyAlias)) {
			throw IllegalStateException("no key provisioned under alias $keyAlias")
		}
		val certificate = keyStore.getCertificate(keyAlias)
			?: throw IllegalStateException("no certificate for alias $keyAlias")
		return spkiToCompressedPointHex(certificate.publicKey.encoded)
	}

	/**
	 * Shared keygen core for both the placeholder-provision (1) and attested-regeneration (2)
	 * paths — StrongBox->TEE->(debug-only)stub rungs (D-07). [attestationChallenge] null means
	 * "placeholder" (Open Q1's provision-time call, no real challenge yet); a non-null array is
	 * the real utf8(BOUND_DIGEST) bytes.
	 */
	private fun generateKey(
		keyAlias: String,
		attestationChallenge: ByteArray?,
		authenticator: KeyAuthenticator = KeyAuthenticator.BIOMETRIC_STRONG,
	): ProvisionResult {
		fun buildSpec(strongBox: Boolean): KeyGenParameterSpec {
			val builder = KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_SIGN).apply {
				setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1")) // D-03 — P-256 only;
				// secp256k1 is NOT supported for hardware key attestation.
				setDigests(KeyProperties.DIGEST_SHA256)
				// D-07 / StrongBox: `setAttestationChallenge(null)` means "no attestation cert" —
				// a zero-length challenge is NOT the same thing, it requests attestation and
				// supplies an INVALID challenge. TEE tolerates the empty array; StrongBox does
				// not. Measured on a Pixel 7 Pro (cheetah, API 37, Titan M2), the coalesce this
				// replaced made StrongBox keygen fail outright:
				//   keymint-service.citadel: StartAttestKey: ATTESTATION_CHALLENGE_MISSING
				//   keystore2: Error::Km(ATTESTATION_CHALLENGE_MISSING)
				//   -> java.security.ProviderException: Failed to generate key pair.
				// with the param dump showing `ATTESTATION_CHALLENGE, value: Blob([])`.
				// So only ASK for attestation when there is a real challenge to bind it to. The
				// placeholder key does not need an attestation-carrying chain: [regenerateAttested]
				// deletes and regenerates this alias with the real utf8(BOUND_DIGEST) before any
				// chain is exported. This also makes the D-16 DEVICE_CREDENTIAL key behave as its
				// own doc comment already claims ("no attestation challenge at all").
				if (attestationChallenge != null) {
					setAttestationChallenge(attestationChallenge)
				}
				setUserAuthenticationRequired(true) // D-17
				// D-17/D-13 — KeyPermanentlyInvalidatedException trigger. Governs ONLY
				// biometric-auth keys (KeyAuthenticator.BIOMETRIC_STRONG) — this is precisely why a
				// KeyAuthenticator.DEVICE_CREDENTIAL key (D-16) SURVIVES a biometric re-enrolment
				// that permanently strands a BIOMETRIC_STRONG key. Setting it unconditionally on
				// BOTH variants reads like a bug otherwise: it is a no-op for DEVICE_CREDENTIAL
				// keys, not a shared invalidation trigger. **D-16 requires this be verified on real
				// hardware, not taken from the docs** — that is D-24 leg 3 in 49-14.
				setInvalidatedByBiometricEnrollment(true)
				if (Build.VERSION.SDK_INT >= 30) {
					val bitmask = when (authenticator) {
						KeyAuthenticator.BIOMETRIC_STRONG -> KeyProperties.AUTH_BIOMETRIC_STRONG
						KeyAuthenticator.DEVICE_CREDENTIAL -> KeyProperties.AUTH_DEVICE_CREDENTIAL
					}
					setUserAuthenticationParameters(0, bitmask) // 0 = per-use (D-06/D-10), both variants
				}
				// else: pre-API-30 (D-26a rescope, 2026-08-21). Below API 30 there is no way to
				// request a specific authenticator at the KeyGenParameterSpec/BiometricPrompt API
				// surface — a bare-auth key can still be created via
				// setUserAuthenticationRequired(true) alone (no setUserAuthenticationParameters
				// call, no positive-validity-duration keygen call), which makes it auth-per-use.
				// There is no API this app is willing to use that can authorize an auth-per-use key
				// below API 30 — measured: the platform's confirm-device-credential intent flow
				// performs a time-bound authentication and cannot satisfy it (n=2, Redmi 8 / API 29
				// — see
				// .planning/todos/pending/2026-08-19-d26-keyguard-fallback-cannot-authorize-per-use-key.md).
				// So below API 30, signWithRecoveryKey rejects RECOVERY_UNSUPPORTED_OS rather than
				// attempting a ceremony. The key is still generated here so the provisioning flow
				// stays uniform across API levels — DO NOT change any keygen call in this function
				// (setUserAuthenticationRequired, setInvalidatedByBiometricEnrollment,
				// setUserAuthenticationParameters, setIsStrongBoxBacked all stay byte-identical) and
				// DO NOT add a positive authentication-validity-duration keygen call here — that
				// rejected alternative trades per-use binding for a timed auth window on the very
				// key this phase exists to protect (the same property D-10 rejected for the primary
				// signing key).
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
			Log.i(TAG_KEYGEN_RUNG, "StrongBox rung selected (attested=${attestationChallenge != null})")
			return ProvisionResult(
				publicKeyBase64 = Base64.encodeToString(keyPair.public.encoded, Base64.NO_WRAP),
				keyAlias = keyAlias,
				securityLevel = "strongbox",
				publicKeyCompressedHex = spkiToCompressedPointHex(keyPair.public.encoded),
			)
		} catch (e: StrongBoxUnavailableException) {
			// The ordinary, expected rung step-down: this device has no StrongBox chip at all.
			Log.i(TAG_KEYGEN_RUNG, "StrongBox unavailable on this device — stepping down to TEE")
		} catch (e: ProviderException) {
			// A StrongBox chip IS present but rejected THIS key request (bad/unsupported params,
			// KeyMint errors such as ATTESTATION_CHALLENGE_MISSING, provisioning faults, ...).
			// Previously only StrongBoxUnavailableException was caught, so any such failure
			// escaped `generateKey` entirely and skipped the TEE rung — leaving a StrongBox
			// device strictly WORSE OFF than a TEE-only one, with provisioning dead rather than
			// degraded. The D-07 ladder is supposed to degrade, so step down here too.
			//
			// Logged at W, with the exception, ON PURPOSE: this branch silently downgrades the
			// security rung, and a silent downgrade would masquerade as "this device has no
			// StrongBox". Anything diagnosing a rung result MUST check for this line before
			// concluding a TEE result reflects the hardware.
			Log.w(
				TAG_KEYGEN_RUNG,
				"StrongBox present but REJECTED this key request — stepping down to TEE. " +
					"This is a rung DOWNGRADE, not an absent chip; the resulting key is TEE-backed.",
				e,
			)
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
				publicKeyCompressedHex = spkiToCompressedPointHex(keyPair.public.encoded),
			)
		} catch (e: Exception) {
			// Software/stub rung — T-45-04/CR-03: a release build must NEVER reach this rung.
			// __DEV__/BuildConfig.DEBUG is the ONLY gate; anything else rethrows terminal.
			if (BuildConfig.DEBUG) {
				return generateSoftwareStubKey(keyAlias, attestationChallenge, authenticator)
			}
			throw NoStrongBoxOrTeeException(e)
		}
	}

	/**
	 * Debug-only software keygen fallback so the emulator path (no StrongBox/TEE) still runs.
	 * Unreachable in a release build — see the `BuildConfig.DEBUG` guard in [generateKey]. Mirrors
	 * [generateKey]'s [KeyAuthenticator] parameterization so a debug-build recovery key falling to
	 * this rung still gets `AUTH_DEVICE_CREDENTIAL`, not a silently-wrong biometric-only key.
	 */
	private fun generateSoftwareStubKey(
		keyAlias: String,
		attestationChallenge: ByteArray?,
		authenticator: KeyAuthenticator = KeyAuthenticator.BIOMETRIC_STRONG,
	): ProvisionResult {
		val spec = KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_SIGN).apply {
			setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
			setDigests(KeyProperties.DIGEST_SHA256)
			// Same null-vs-empty distinction as [generateKey] — kept identical so the debug stub
			// rung cannot diverge from the hardware rungs in what it asks the Keystore for.
			if (attestationChallenge != null) {
				setAttestationChallenge(attestationChallenge)
			}
			setUserAuthenticationRequired(true)
			setInvalidatedByBiometricEnrollment(true)
			if (Build.VERSION.SDK_INT >= 30) {
				val bitmask = when (authenticator) {
					KeyAuthenticator.BIOMETRIC_STRONG -> KeyProperties.AUTH_BIOMETRIC_STRONG
					KeyAuthenticator.DEVICE_CREDENTIAL -> KeyProperties.AUTH_DEVICE_CREDENTIAL
				}
				setUserAuthenticationParameters(0, bitmask)
			}
		}.build()
		val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
		generator.initialize(spec)
		val keyPair = generator.generateKeyPair()
		return ProvisionResult(
			publicKeyBase64 = Base64.encodeToString(keyPair.public.encoded, Base64.NO_WRAP),
			keyAlias = keyAlias,
			securityLevel = "software",
			publicKeyCompressedHex = spkiToCompressedPointHex(keyPair.public.encoded),
		)
	}
}
