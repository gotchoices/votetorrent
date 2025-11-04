import { randomBytes, bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import type { SID } from '@votetorrent/vote-core';

/**
 * Cryptographic utilities for VoteTorrent
 *
 * This module provides secure cryptographic operations using the @noble suite of libraries.
 * All functions use cryptographically secure random number generation and proper encoding.
 *
 * Security features:
 * - Cryptographically secure random number generation (NOT Math.random())
 * - Proper hex encoding for all binary data
 * - secp256k1 elliptic curve cryptography
 * - SHA-256 hashing
 *
 * @remarks
 * This module replaces all insecure cryptographic operations identified in the security audit.
 */

/**
 * Generates a cryptographically secure random SID (Secure Identifier)
 *
 * @param prefix - The prefix for the SID (e.g., 'auth', 'user', 'election')
 * @param length - The number of random bytes to generate (default: 16)
 * @returns A SID in the format `${prefix}-${hexString}`
 *
 * @remarks
 * This function uses cryptographically secure random number generation from @noble/hashes
 * instead of Math.random(). Each byte of entropy provides 8 bits of randomness.
 *
 * @example
 * ```typescript
 * const userSid = generateSecureSid('user');
 * // Returns: "user-a3f5e8b2c1d4f6e9a2b5c8d1e4f7a0b3"
 * ```
 */
export function generateSecureSid(prefix: string, length: number = 16): SID {
	const bytes = randomBytes(length);
	const hex = bytesToHex(bytes);
	return `${prefix}-${hex}` as SID;
}

/**
 * Generates a cryptographically secure random private key for secp256k1
 *
 * @returns A hex-encoded private key string
 *
 * @remarks
 * Uses secp256k1.utils.randomPrivateKey() which ensures the key is valid
 * for the secp256k1 curve (i.e., less than the curve order).
 *
 * @example
 * ```typescript
 * const privateKey = generatePrivateKey();
 * // Returns: "5f8e9a7c6b5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0"
 * ```
 */
export function generatePrivateKey(): string {
	const privateKeyBytes = secp256k1.utils.randomPrivateKey();
	return bytesToHex(privateKeyBytes);
}

/**
 * Derives the public key from a private key
 *
 * @param privateKeyHex - Hex-encoded private key
 * @param compressed - Whether to return compressed public key (default: true)
 * @returns Hex-encoded public key
 *
 * @example
 * ```typescript
 * const privateKey = generatePrivateKey();
 * const publicKey = getPublicKey(privateKey);
 * ```
 */
export function getPublicKey(privateKeyHex: string, compressed: boolean = true): string {
	const privateKeyBytes = hexToBytes(privateKeyHex);
	const publicKeyBytes = secp256k1.getPublicKey(privateKeyBytes, compressed);
	return bytesToHex(publicKeyBytes);
}

/**
 * Signs a message using secp256k1
 *
 * @param message - The message to sign (will be UTF-8 encoded and hashed with SHA-256)
 * @param privateKeyHex - Hex-encoded private key
 * @returns Hex-encoded signature
 *
 * @remarks
 * The message is automatically hashed with SHA-256 before signing.
 * The signature is deterministic (RFC 6979) for security and reproducibility.
 *
 * @example
 * ```typescript
 * const privateKey = generatePrivateKey();
 * const signature = signMessage('Hello, world!', privateKey);
 * ```
 */
export function signMessage(message: string, privateKeyHex: string): string {
	const messageBytes = new TextEncoder().encode(message);
	const messageHash = sha256(messageBytes);
	const privateKeyBytes = hexToBytes(privateKeyHex);
	const signatureObj = secp256k1.sign(messageHash, privateKeyBytes);
	return bytesToHex(signatureObj.toCompactRawBytes());
}

/**
 * Verifies a signature
 *
 * @param message - The original message that was signed
 * @param signatureHex - Hex-encoded signature
 * @param publicKeyHex - Hex-encoded public key
 * @returns True if the signature is valid, false otherwise
 *
 * @remarks
 * The message is automatically hashed with SHA-256 before verification.
 *
 * @example
 * ```typescript
 * const isValid = verifySignature('Hello, world!', signature, publicKey);
 * ```
 */
export function verifySignature(
	message: string,
	signatureHex: string,
	publicKeyHex: string
): boolean {
	try {
		const messageBytes = new TextEncoder().encode(message);
		const messageHash = sha256(messageBytes);
		const signatureBytes = hexToBytes(signatureHex);
		const publicKeyBytes = hexToBytes(publicKeyHex);

		return secp256k1.verify(signatureBytes, messageHash, publicKeyBytes);
	} catch (error) {
		// Invalid signature format or other error
		return false;
	}
}

/**
 * Computes SHA-256 hash of a string
 *
 * @param message - The message to hash
 * @returns Hex-encoded hash
 *
 * @example
 * ```typescript
 * const hash = hashMessage('Hello, world!');
 * ```
 */
export function hashMessage(message: string): string {
	const messageBytes = new TextEncoder().encode(message);
	const hashBytes = sha256(messageBytes);
	return bytesToHex(hashBytes);
}

/**
 * Computes SHA-256 hash of binary data
 *
 * @param data - The data to hash
 * @returns Hex-encoded hash
 *
 * @example
 * ```typescript
 * const data = new Uint8Array([1, 2, 3, 4]);
 * const hash = hashBytes(data);
 * ```
 */
export function hashBytes(data: Uint8Array): string {
	const hashBytes = sha256(data);
	return bytesToHex(hashBytes);
}

/**
 * Generates cryptographically secure random bytes
 *
 * @param length - Number of bytes to generate
 * @returns Hex-encoded random bytes
 *
 * @remarks
 * Uses the same CSPRNG as generateSecureSid and generatePrivateKey.
 *
 * @example
 * ```typescript
 * const randomData = generateRandomBytes(32);
 * ```
 */
export function generateRandomBytes(length: number): string {
	const bytes = randomBytes(length);
	return bytesToHex(bytes);
}

/**
 * Validates that a string is valid hexadecimal
 *
 * @param hex - String to validate
 * @returns True if valid hex, false otherwise
 *
 * @example
 * ```typescript
 * isValidHex('deadbeef'); // true
 * isValidHex('not hex');  // false
 * ```
 */
export function isValidHex(hex: string): boolean {
	return /^[0-9a-fA-F]*$/.test(hex) && hex.length % 2 === 0;
}

/**
 * Validates that a private key is valid for secp256k1
 *
 * @param privateKeyHex - Hex-encoded private key to validate
 * @returns True if valid, false otherwise
 *
 * @example
 * ```typescript
 * const key = generatePrivateKey();
 * isValidPrivateKey(key); // true
 * isValidPrivateKey('invalid'); // false
 * ```
 */
export function isValidPrivateKey(privateKeyHex: string): boolean {
	if (!isValidHex(privateKeyHex)) {
		return false;
	}

	try {
		const privateKeyBytes = hexToBytes(privateKeyHex);
		// Validate by trying to get the public key
		secp256k1.getPublicKey(privateKeyBytes);
		return true;
	} catch {
		return false;
	}
}
