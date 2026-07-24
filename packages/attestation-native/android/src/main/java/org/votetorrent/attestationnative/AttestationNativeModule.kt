package org.votetorrent.attestationnative

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.annotations.ReactModule

/**
 * AttestationNativeModule — the `AttestationNative` TurboModule implementation
 * (Phase 45-01 scaffold).
 *
 * This is intentionally REJECT-STUBBED: no StrongBox/TEE key generation, no
 * BiometricPrompt, no Play Integrity SDK call yet. Both methods reject with a
 * NOT_IMPLEMENTED-class code so the module can be proven resolvable (autolinked,
 * codegen-compiled, registered) on-device BEFORE any real platform-API logic is
 * written. The real StrongBox->TEE->__DEV__-stub fail-closed posture (D-07) and
 * the actual key-attestation / Play Integrity Classic logic land in 45-02, against
 * this exact skeleton.
 *
 * OPEN QUESTION 1 (see NativeAttestation.ts / 45-RESEARCH.md — NOT resolved here):
 * whether `provisionDeviceKey` generates the real attested key immediately (with a
 * placeholder attestation challenge, re-attested in `produceAttestation`) or defers
 * ALL attested key generation to `produceAttestation` is confirmed in 45-02 via an
 * on-device/emulator experiment. Do not narrow this module's shape to foreclose
 * either path before that experiment lands.
 */
@ReactModule(name = AttestationNativeModule.NAME)
class AttestationNativeModule(reactContext: ReactApplicationContext) :
	NativeAttestationSpec(reactContext) {

	override fun getName(): String {
		return NAME
	}

	override fun provisionDeviceKey(keyAlias: String, promise: Promise) {
		promise.reject(
			"NOT_IMPLEMENTED",
			"attestation-native scaffold (45-01) — real logic lands in 45-02",
		)
	}

	override fun produceAttestation(
		keyAlias: String,
		boundDigest: String,
		boundDigestUtf8Base64: String,
		enablePlayIntegrity: Boolean,
		promise: Promise,
	) {
		promise.reject(
			"NOT_IMPLEMENTED",
			"attestation-native scaffold (45-01) — real logic lands in 45-02",
		)
	}

	companion object {
		const val NAME = "AttestationNative"
	}
}
