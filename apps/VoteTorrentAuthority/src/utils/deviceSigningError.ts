/**
 * deviceSigningError.ts — D-13 device-signing error taxonomy contract (49-01,
 * Wave 0 scaffolding).
 *
 * Single source of truth for mapping `signWithDeviceKey`'s native rejection
 * `code` to a UI class. Every one of this phase's 22 `createDeviceSigner`
 * call sites routes its catch block through `mapDeviceSigningError` rather
 * than re-deriving the mapping locally (see `49-UI-SPEC.md`
 * §Cross-Cutting: Error Taxonomy Contract).
 *
 * Pure TypeScript — no React Native, native-module, or navigation imports,
 * so it is fully jest-testable and importable from any call site without
 * pulling in the bridge.
 *
 * Analog: `apps/VoteTorrentVoter/src/engines/attestation-failure.ts` (Phase
 * 45's D-09 code -> UX class mapper). This file is one taxonomy tier deeper
 * (routes by exact code, not just a 3-way class) and does NOT reproduce
 * that analog's `__DEV__` terminal-class downgrade — this phase's taxonomy
 * has no release-only terminal class (StrongBox/TEE absence is Phase 45's
 * D-07 concern, not this phase's).
 */

/**
 * D-13 taxonomy + UI-SPEC routing decision for `signWithDeviceKey` rejections.
 *
 * `'cancellation'` through `'key-invalidated'` are D-13's five native codes.
 * `'no-key-provisioned'` and `'no-device-credential'` are NOT part of D-13's
 * five — they are documented additions:
 *   - `'no-key-provisioned'` is `49-UI-SPEC.md`'s explicitly-flagged sixth
 *     condition: the Keystore alias is absent, detected BEFORE any prompt is
 *     shown.
 *   - `'no-device-credential'` is D-18's terminal no-recovery state: the
 *     device has no screen lock, so on-device recovery is impossible.
 */
export type DeviceSigningErrorClass =
	| 'cancellation' // no UI at all — silent dismissal
	| 'no-biometrics-enrolled'
	| 'lockout'
	| 'lockout-permanent'
	| 'biometric-error'
	| 'key-invalidated' // navigate, never inline
	| 'no-key-provisioned' // navigate, never inline — detected BEFORE any prompt
	| 'no-device-credential' // D-18 terminal — no recovery possible
	| 'recovery-key-invalidated' // 49-14 follow-up — the D-16 FAIL signal, inline-rendered
	| 'recovery-key-not-registered' // 49-14 follow-up — DeleteValid precondition unmet, inline-rendered
	| 'recovery-unsupported-os'; // 49-19, D-26a rescope terminal state — recovery is supported on
	// API 30+ and explicitly unsupported below it; sibling in shape to 'no-device-credential'
	// (both terminal, both absent from the copy map), distinct in cause (OS version, not device
	// configuration).

/**
 * Native reject code -> UI class. Reused verbatim from Phase 45's taxonomy
 * where applicable (D-13), extended with the two sibling conditions above.
 * Any code NOT present here (including the explicit `BIOMETRIC_ERROR`
 * catch-all, and any unrecognized/future code) falls through
 * `mapDeviceSigningError`'s default to `'biometric-error'`.
 */
export const CODE_TO_CLASS: Record<string, DeviceSigningErrorClass> = {
	CANCELED: 'cancellation',
	// Phase 65 review CR-01: the native sign now tells a system cancel (Android ERROR_CANCELED/5,
	// iOS LAError.systemCancel/.appCancel: app backgrounded, screen locked, incoming call) from the
	// officer's own dismissal. Same silent cancellation class: no new copy.
	SYSTEM_CANCELED: 'cancellation',
	NO_BIOMETRICS_ENROLLED: 'no-biometrics-enrolled',
	LOCKOUT: 'lockout',
	LOCKOUT_PERMANENT: 'lockout-permanent',
	KEY_INVALIDATED_REASSOCIATE: 'key-invalidated',
	NO_KEY_PROVISIONED: 'no-key-provisioned',
	NO_DEVICE_CREDENTIAL: 'no-device-credential',
	// 49-14 follow-up (D-16 observability defect) — native's provisionRecoveryKey now rejects with
	// this code (KeyAttestationHelper.kt's RecoveryKeyInvalidatedException) instead of silently
	// regenerating an invalidated recovery-key alias. See this class's DEVICE_SIGNING_ERROR_COPY_KEY
	// entry below for why it renders inline rather than navigating.
	RECOVERY_KEY_INVALIDATED: 'recovery-key-invalidated',
	// 49-14 follow-up — JS-thrown (ProvisionSigningKeyScreen.tsx's handleRecovery), never a native
	// reject code: the network User's currently-registered recovery key does not match this
	// device's recovery key, i.e. `UserKey.DeleteValid`'s clause 1 (a valid, non-expired signer) or
	// clause 2 (not the user's last key) precondition is unmet before the ceremony would even
	// attempt to revoke the invalidated signing key. Reuses this same code-based taxonomy
	// mechanism deliberately (a `code` field on a plain thrown Error) rather than introducing a
	// second classification mechanism alongside it.
	RECOVERY_KEY_NOT_REGISTERED: 'recovery-key-not-registered',
	// 49-19, D-26a rescope — native reject code raised by KeyAttestationHelper.kt's
	// signWithRecoveryKey BEFORE any ceremony starts (before obtaining a key handle or launching
	// any UI), on API < 30 only. Measured cause: below API 30 the recovery key is auth-per-use,
	// and KeyguardManager's time-bound confirm-device-credential authentication cannot authorize
	// an auth-per-use key (measured n=2 on a Redmi 8 / API 29 — see
	// .planning/todos/pending/2026-08-19-d26-keyguard-fallback-cannot-authorize-per-use-key.md).
	RECOVERY_UNSUPPORTED_OS: 'recovery-unsupported-os',
};

/**
 * Classify a `signWithDeviceKey` rejection into a D-13 UI class. Reads
 * `(err as {code?: string}).code`; any unrecognized or missing code
 * classifies as `'biometric-error'` — never silently treated as a success
 * path (T-49-KEY mitigation) and mirrors `attestation-failure.ts`'s own
 * "unknown code is never silently terminal" default.
 */
export function mapDeviceSigningError(err: unknown): DeviceSigningErrorClass {
	const code = (err as { code?: string } | null | undefined)?.code;
	if (typeof code === 'string' && Object.prototype.hasOwnProperty.call(CODE_TO_CLASS, code)) {
		return CODE_TO_CLASS[code]!;
	}
	return 'biometric-error';
}

/**
 * i18n copy key for each INLINE-rendered error class (the four classes
 * `49-UI-SPEC.md`'s Error Taxonomy Contract table renders as `InlineError`
 * on the calling screen, PLUS the two `recovery-key-*` classes 49-14 added
 * — see their own entries below for why those render inline too).
 *
 * `cancellation`, `key-invalidated`, `no-key-provisioned`,
 * `no-device-credential`, and `recovery-unsupported-os` are DELIBERATELY
 * ABSENT from this map — that absence IS the contract, not an omission:
 * `cancellation` renders nothing (silent dismissal); `key-invalidated` and
 * `no-key-provisioned` always navigate (to `ProvisionSigningKey`) rather
 * than rendering inline; `no-device-credential` and `recovery-unsupported-os`
 * (49-19, D-26a rescope) each render a terminal no-recovery screen body
 * (49-21) rather than an `InlineError`.
 */
export const DEVICE_SIGNING_ERROR_COPY_KEY: Partial<Record<DeviceSigningErrorClass, string>> = {
	'no-biometrics-enrolled': 'deviceSigningErrorNoBiometricsEnrolled',
	lockout: 'deviceSigningErrorLockout',
	'lockout-permanent': 'deviceSigningErrorLockoutPermanent',
	'biometric-error': 'deviceSigningErrorGeneric',
	// 49-14 follow-up — both render INLINE (unlike key-invalidated/no-key-provisioned, which
	// navigate): neither implies the primary signing-key ceremony should restart from scratch, and
	// neither has a dedicated terminal screen the way no-device-credential (D-18) does. Distinct
	// copy from deviceSigningErrorGeneric is the entire point (see this file's own header comment
	// on T-49-USER-7 — a structural precondition failure must never read as "couldn't verify your
	// biometrics").
	'recovery-key-invalidated': 'deviceSigningErrorRecoveryKeyInvalidated',
	'recovery-key-not-registered': 'deviceSigningErrorRecoveryKeyNotRegistered',
};

/**
 * True for the two classes `49-UI-SPEC.md`'s degradation clause marks
 * load-bearing at every one of the 22 call sites: a navigation-class error
 * must never be rendered inline (there is no `InlineError` copy for it —
 * see `DEVICE_SIGNING_ERROR_COPY_KEY` above), it must route the officer to
 * the provisioning/recovery screen instead.
 *
 * `recovery-unsupported-os` (49-19, D-26a rescope) is deliberately NOT a
 * navigation class, even though — like `key-invalidated` — it too carries no
 * inline copy. Unlike `key-invalidated`, there is no ceremony on the
 * provisioning screen that could succeed for it: recovery is unsupported on
 * this OS version, full stop, so routing there would strand the officer at a
 * dead end. The screen this class reaches instead renders a terminal body in
 * place of the recovery body (49-21).
 */
export function isNavigationClass(c: DeviceSigningErrorClass): boolean {
	return c === 'key-invalidated' || c === 'no-key-provisioned';
}

/**
 * Recognition predicate (49-11), additive alongside the 49-01 taxonomy above.
 *
 * `mapDeviceSigningError` deliberately defaults **unknown** input to
 * `'biometric-error'` — that default exists so an unrecognized/future native
 * code degrades to a recoverable UI state instead of throwing. But every one
 * of the 17 `createDeviceSigner` call sites this predicate protects wraps a
 * WHOLE `try` body — engine writes, network calls, validation — not just the
 * sign call. Routing every caught error through `mapDeviceSigningError` alone
 * would relabel a genuine engine failure (e.g. a rejected `DeleteValid` CHECK)
 * as "Couldn't verify your biometrics," hiding the real fault (T-49-USER-7).
 *
 * `isDeviceSigningError` is what keeps the two populations apart: only an
 * error carrying a string `code` that is a KNOWN key of `CODE_TO_CLASS`
 * counts as a device-signing rejection. Anything else — a plain `Error`,
 * `undefined`, `{}`, or an object with an unrecognized `code` — is "not
 * mine" and must fall through to the call site's own raw-message handling.
 * Own keys only — a prototype name such as 'constructor' is not a code.
 */
export function isDeviceSigningError(err: unknown): boolean {
	const code = (err as { code?: unknown } | null | undefined)?.code;
	return typeof code === 'string' && Object.prototype.hasOwnProperty.call(CODE_TO_CLASS, code);
}

// Keystore/metadata desync detection (49-14) lives in device-signer.ts's self-verify, which throws
// KEY_INVALIDATED_REASSOCIATE (a code in CODE_TO_CLASS). It is NOT message-based here: Quereus CHECK
// messages carry no table name, so a SignatureValid failure could be any party's signature.
