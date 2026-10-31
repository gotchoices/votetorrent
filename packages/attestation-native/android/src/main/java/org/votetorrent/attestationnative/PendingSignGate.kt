package org.votetorrent.attestationnative

import androidx.biometric.BiometricPrompt
import androidx.fragment.app.FragmentActivity
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The tag androidx.biometric 1.1.0 gives its BiometricFragment (private `BIOMETRIC_FRAGMENT_TAG` of
 * `BiometricPrompt`, confirmed with javap on the pinned AAR). A fragment found under this tag means a
 * biometric sheet is attached to the activity, whoever opened it.
 */
internal const val BIOMETRIC_FRAGMENT_TAG = "androidx.biometric.BiometricFragment"

/** Which signing ceremony a [PendingSign] belongs to. Vault wrap/unwrap prompts never enter the gate. */
internal enum class PendingSignKind { DEVICE, RECOVERY }

/**
 * Wraps the three terminal callbacks of one sign so only the FIRST terminal call runs (an
 * [AtomicBoolean] compareAndSet). A late `onAuthenticationSucceeded` after a cancel therefore hits an
 * already-settled record and its signature is discarded, never resolved to JS. Each method returns
 * whether it won.
 */
internal class SettleOnce(
	private val onResult: (String) -> Unit,
	private val onKeyInvalidated: () -> Unit,
	private val onError: (String, Throwable?) -> Unit,
) {
	private val settled = AtomicBoolean(false)

	fun result(hex: String): Boolean {
		if (!settled.compareAndSet(false, true)) return false
		onResult(hex)
		return true
	}

	fun keyInvalidated(): Boolean {
		if (!settled.compareAndSet(false, true)) return false
		onKeyInvalidated()
		return true
	}

	fun error(code: String, t: Throwable?): Boolean {
		if (!settled.compareAndSet(false, true)) return false
		onError(code, t)
		return true
	}
}

/** One pending device-key or recovery-key sign. [prompt] is written and read on the UI thread only. */
internal class PendingSign(val kind: PendingSignKind, val settle: SettleOnce) {
	@Volatile
	var prompt: BiometricPrompt? = null
}

/**
 * The single pending-sign record. Why it exists: UAT 65 Run 3 showed androidx.biometric 1.1.0
 * swallows a second prompt (`showPromptForAuthentication()` returns early while one shows) yet
 * `BiometricPrompt.init()` re-registers the activity-scoped callback, so the next sign shows nothing,
 * never settles and hijacks the old sheet's callback (D-110/D-111/D-112).
 *
 * Threading: every method is thread-safe under one lock. [PendingSign.prompt] and
 * [isBiometricFragmentAttached] are UI-thread only. The gate only ever holds device-key and
 * recovery-key signs; vault wrap/unwrap prompts never enter it (D-110).
 */
internal class PendingSignGate {
	private val lock = Any()
	private var current: PendingSign? = null

	/** Returns a new record, or null when a sign is already held. */
	fun tryReserve(kind: PendingSignKind, settle: SettleOnce): PendingSign? = synchronized(lock) {
		if (current != null) return null
		val p = PendingSign(kind, settle)
		current = p
		p
	}

	fun isHeld(p: PendingSign): Boolean = synchronized(lock) { current === p }

	/** Clears only when [p] is still current, so an old prompt's late callback cannot clear a newer record. */
	fun release(p: PendingSign) {
		synchronized(lock) {
			if (current === p) current = null
		}
	}

	/** Returns and clears the held record atomically. */
	fun take(): PendingSign? = synchronized(lock) {
		val p = current
		current = null
		p
	}
}

/** UI thread only. */
internal fun isBiometricFragmentAttached(activity: FragmentActivity): Boolean =
	activity.supportFragmentManager.findFragmentByTag(BIOMETRIC_FRAGMENT_TAG) != null
