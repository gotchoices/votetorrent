import type { CryptoKey } from 'jose'

/**
 * key-provider.ts — the Play Console key-material seam (D-04b).
 *
 * `verifyPlayIntegrity` (verifiers/play-integrity.ts) needs the symmetric
 * A256KW/A256GCM decryption key and the ES256 verification public key
 * Google's Play Console issues per app, but must not hard-code them or
 * assume any particular secret-storage mechanism. `IIntegrityKeyProvider`
 * is that seam — modeled on `IAttestationVerifier`'s doc-comment convention
 * (vote-core/association/types.ts:52-62): "exists so a real X can be
 * injected later without changing the shape."
 *
 * Unlike `IAttestationVerifier`/`StubAttestationVerifier` (a throwaway
 * always-pass stub), this file ships exactly ONE concrete implementation,
 * `LocalConfigKeyProvider` — a real, swap-in-ready reader of locally
 * configured key material (analogous to `engine-factory.ts`'s `rnDbFactory`,
 * not to a "stub key provider"). There is no stub variant this phase.
 */

/**
 * D-04b: seam for supplying the Play Console key material `verifyPlayIntegrity`
 * needs to decrypt+verify a classic-API token offline. A real implementation
 * might read from a secrets manager, keystore, or encrypted config; this
 * interface's shape stays stable regardless of where the keys come from.
 */
export interface IIntegrityKeyProvider {
  /** The symmetric A256KW/A256GCM key used to decrypt the outer JWE. */
  getDecryptionKey (): Promise<Uint8Array>

  /**
   * The ES256 public key used to verify the inner JWS signature. Either the
   * raw SPKI-encoded public-key bytes (a `LocalConfigKeyProvider`'s shape)
   * or an already-imported `CryptoKey` (a test double's shape, or a
   * provider backed by a platform keystore that only exposes imported
   * keys) — `jose`'s `compactVerify` accepts both directly.
   */
  getVerificationKey (): Promise<Uint8Array | CryptoKey>
}

/** Base64-encoded Play Console key material, as read from local config. */
export interface LocalConfigKeyProviderConfig {
  /** Base64-encoded symmetric A256KW/A256GCM decryption key. */
  decryptionKeyBase64: string
  /** Base64-encoded ES256 SPKI public key used for JWS verification. */
  verificationKeyBase64: string
}

function base64ToBytes (b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

/**
 * `LocalConfigKeyProvider` — reads Play Console key material from a local
 * config object. This is the real, currently-shipping implementation of
 * `IIntegrityKeyProvider` (D-04b) — not a throwaway stub — decoding the
 * configured base64 strings to raw bytes on each call.
 */
export class LocalConfigKeyProvider implements IIntegrityKeyProvider {
  constructor (private readonly config: LocalConfigKeyProviderConfig) {}

  async getDecryptionKey (): Promise<Uint8Array> {
    return base64ToBytes(this.config.decryptionKeyBase64)
  }

  async getVerificationKey (): Promise<Uint8Array> {
    return base64ToBytes(this.config.verificationKeyBase64)
  }
}
