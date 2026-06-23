import type { SAppConfig } from './types.js';
/**
 * Error thrown when sApp schema signature verification fails.
 */
export declare class SchemaVerificationError extends Error {
    readonly sAppId: string;
    readonly version: string;
    constructor(sAppId: string, version: string, reason: string);
}
/**
 * Sign an sApp schema with the author's ed25519 private key.
 * Used by sApp authors when publishing their schema.
 *
 * @param schema - The declarative schema DDL
 * @param version - Schema version string
 * @param authorPrivateKey - Author's ed25519 private key (base64url)
 * @returns Signature (base64url)
 */
export declare function signSchema(schema: string, version: string, authorPrivateKey: string): string;
/**
 * Verify an sApp schema signature against the author's ed25519 public key.
 *
 * @param schema - The declarative schema DDL
 * @param version - Schema version string
 * @param signature - Signature to verify (base64url)
 * @param authorPublicKey - Author's ed25519 public key (base64url)
 * @returns true if the signature is valid
 */
export declare function verifySchema(schema: string, version: string, signature: string, authorPublicKey: string): boolean;
/**
 * Assert that an SAppConfig has a valid schema signature.
 * Throws SchemaVerificationError on failure.
 *
 * Fail-closed by default: when `options.requireSignature` is not explicitly
 * `false`, an absent signature is rejected with reason `'missing signature'`,
 * distinct from the `'invalid signature'` (tampered/wrong-key) case. The
 * relaxation (`requireSignature: false`) only excuses *absence* of a signature;
 * a present-but-bad signature still throws.
 *
 * @param sAppConfig - The sApp configuration to verify
 * @param options - Verification policy; `requireSignature` defaults to `true`
 * @throws SchemaVerificationError if the signature is missing (when required) or invalid
 */
export declare function assertSchemaSignature(sAppConfig: SAppConfig, options?: {
    requireSignature?: boolean;
}): void;
