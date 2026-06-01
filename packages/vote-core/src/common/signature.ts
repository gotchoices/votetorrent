export interface Signature {
  /** Hex-encoded secp256k1 compact signature (128 chars, 64 bytes). */
  signature: string
  /** Hex-encoded secp256k1 compressed public key (66 chars, 33 bytes). */
  signerKey: string
  /** User ID of the signer (Sovereign UUID) — not a key. */
  signerUserId: string
}
