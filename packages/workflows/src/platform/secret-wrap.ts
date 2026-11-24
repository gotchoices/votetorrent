/**
 * secret-wrap.ts: the wrapped-secret shapes shared with the native secret-wrap module.
 *
 * These three types are copied verbatim from the native secret-wrap module and must stay exactly
 * equal to it: this package has no dependency on the native package, so the copy is the only way to
 * name the shapes in a Node-safe place. The Voter app, which has both in scope, pins the equality with
 * a strict compile-time parity test (`workflows-platform-parity.test.ts`) that fails the app typecheck
 * when either side drifts.
 */

/**
 * Reported, never asserted: the implementation makes no hardware-backing guarantee beyond what the
 * OS reports. `'test-stub'` is reserved for an in-memory test provider and is rejected as a native
 * result, so a test provider can never pass as a real one.
 */
export type WrapKeySecurityLevel = 'strongbox' | 'tee' | 'software' | 'keychain' | 'unknown' | 'test-stub'

export interface WrappedSecret {
  v: 1
  alg: 'AES-256-GCM'
  keyAlias: string
  ivBase64: string
  ciphertextBase64: string
  securityLevel: WrapKeySecurityLevel
}

export interface SecretWrapPrompt {
  title: string
  subtitle: string
  negativeButton: string
}

/**
 * The closed set of secret-wrap error codes, the same members in the same order as the native
 * secret-wrap module's code list. It must stay EXACTLY equal to the native type: the Voter app pins the
 * equality with a strict compile-time parity check (`vote-record-move.parity.test.ts`, phase 67 plan 30)
 * that fails the app typecheck when either side drifts. Type-only, so the platform runtime namespace
 * stays empty.
 */
export type SecretWrapErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_ENCODING'
  | 'NO_WRAP_KEY'
  | 'WRAP_KEY_POLICY_MISMATCH'
  | 'UNWRAP_TAG_MISMATCH'
  | 'KEY_INVALIDATED'
  | 'DEVICE_LOCKED'
  | 'CANCELED'
  | 'NO_BIOMETRICS_ENROLLED'
  | 'LOCKOUT'
  | 'LOCKOUT_PERMANENT'
  | 'BIOMETRIC_ERROR'
  | 'NO_ACTIVITY'
  | 'WRAP_FAILED'
  | 'UNWRAP_FAILED'
  | 'NATIVE_UNAVAILABLE'
  | 'MALFORMED_NATIVE_RESULT'
