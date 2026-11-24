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
