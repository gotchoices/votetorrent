package org.votetorrent.attestationnative

import android.os.SystemClock
import android.util.Log
import androidx.biometric.BiometricPrompt
import androidx.fragment.app.FragmentActivity
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The tag androidx.biometric 1.1.0 gives its BiometricFragment (private `BIOMETRIC_FRAGMENT_TAG` of
 * `BiometricPrompt`, confirmed with javap on the pinned AAR). A fragment found under this tag means a
 * biometric sheet is attached to the activity, whoever opened it.
 */
internal const val BIOMETRIC_FRAGMENT_TAG = "androidx.biometric.BiometricFragment"

/**
 * Debug trace tag for the device-key / recovery-key sign lifecycle (start, reserve, prompt shown,
 * settle, cancel): `adb logcat -s VtSign:I`. INFO only (never `Log.w`/`Log.e`, so `leg_cancel`'s
 * `" E "` count is untouched). Kinds, codes and timings only: never digest, signature or key bytes,
 * and never an error message text.
 */
internal const val TAG_SIGN = "VtSign"

/** Which signing ceremony a [PendingSign] belongs to. Vault wrap/unwrap prompts never enter the gate. */
internal enum class PendingSignKind { DEVICE, RECOVERY }

/**
 * Wraps the two terminal callbacks of one sign so only the FIRST terminal call runs (an
 * [AtomicBoolean] compareAndSet). A late `onAuthenticationSucceeded` after a cancel therefore hits an
 * already-settled record and its signature is discarded, never resolved to JS. Each method returns
 * whether it won. Key invalidation is detected before the gate is reserved, so it settles directly
 * and never goes through this wrapper. The winning call logs one [TAG_SIGN] line with the [label]
 * (the sign kind), the code on an error, and the ms since this wrapper was built (the sign's start);
 * a losing late call logs that it was dropped.
 */
internal class SettleOnce(
	private val onResult: (String) -> Unit,
	private val onError: (String, Throwable?) -> Unit,
	private val label: String = "SIGN",
) {
	private val settled = AtomicBoolean(false)
	private val startedAt = SystemClock.uptimeMillis()

	private fun elapsed(): Long = SystemClock.uptimeMillis() - startedAt

	fun result(hex: String): Boolean {
		if (!settled.compareAndSet(false, true)) {
			Log.i(TAG_SIGN, "settle dropped kind=$label outcome=signature ms=${elapsed()}")
			return false
		}
		Log.i(TAG_SIGN, "settle ok kind=$label ms=${elapsed()}")
		onResult(hex)
		return true
	}

	fun error(code: String, t: Throwable?): Boolean {
		if (!settled.compareAndSet(false, true)) {
			Log.i(TAG_SIGN, "settle dropped kind=$label code=$code ms=${elapsed()}")
			return false
		}
		Log.i(TAG_SIGN, "settle error kind=$label code=$code ms=${elapsed()}")
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

/**
 * UI thread only. False when [activity] cannot show a BiometricPrompt right now. androidx.biometric
 * 1.1.0's `BiometricPrompt.authenticateInternal` returns with only a log line and no callback when
 * the client fragment manager `isStateSaved()` (after `onSaveInstanceState`, for example while the
 * app is backgrounded but `currentActivity` is still set). A sign that went ahead would hold the
 * pending-sign gate forever and make every later sign PROMPT_BUSY (review WR-02), so the sign paths
 * refuse up front instead.
 */
internal fun canHostBiometricPrompt(activity: FragmentActivity): Boolean =
	!activity.isFinishing && !activity.isDestroyed && !activity.supportFragmentManager.isStateSaved
