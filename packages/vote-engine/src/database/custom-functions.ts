/**
 * Custom SQL functions for Quereus database
 *
 * These functions implement cryptographic operations used in database constraints
 * and queries. They bridge the gap between SQL schema requirements and TypeScript
 * cryptographic implementations.
 */

import { createScalarFunction, createAggregateFunction } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { hashMessage, verifySignatureHash } from '../common/crypto-utils.js';
import { bytesToHex } from '@noble/hashes/utils';

/**
 * Digest(...args) - Cryptographic hash function for variable number of arguments
 *
 * Takes any number of SQL values, concatenates them, and returns their SHA-256 hash
 * as a hex-encoded string. NULL values are treated as empty strings.
 *
 * Usage in SQL:
 *   Digest(col1, col2, col3) → hex-encoded SHA-256 hash
 *   Digest('hello', 'world') → hash of 'helloworld'
 *
 * Implementation:
 *   1. Convert each argument to string (NULL → '')
 *   2. Concatenate all strings
 *   3. Hash with SHA-256
 *   4. Return hex-encoded hash
 */
export const digestFunc = createScalarFunction(
	{
		name: 'Digest',
		numArgs: -1, // Variable number of arguments
		deterministic: true,
	},
	(...args: SqlValue[]): SqlValue => {
		try {
			// Convert all arguments to strings, treating NULL as empty string
			const parts: string[] = args.map((arg) => {
				if (arg === null || arg === undefined) {
					return '';
				}
				if (arg instanceof Uint8Array) {
					// Convert binary data to hex
					return bytesToHex(arg);
				}
				return String(arg);
			});

			// Concatenate all parts
			const combined = parts.join('');

			// Hash the combined string
			const hash = hashMessage(combined);

			return hash;
		} catch (error) {
			// Log error but return null to allow SQL to continue
			console.error('Digest function error:', error);
			return null;
		}
	}
);

/**
 * SignatureValid(messageDigest, signature, publicKey) - Signature verification function
 *
 * Verifies that a signature is valid for a given message digest and public key.
 * All inputs should be hex-encoded strings.
 *
 * Parameters:
 *   @param messageDigest - Hex-encoded hash of the message (from Digest())
 *   @param signature - Hex-encoded ECDSA signature
 *   @param publicKey - Hex-encoded public key
 *
 * Returns:
 *   1 (true) if signature is valid
 *   0 (false) if signature is invalid or any parameter is NULL
 *
 * Usage in SQL:
 *   constraint SignatureValid check (
 *     SignatureValid(
 *       Digest(Nonce, AuthoritySid, AdminEffectiveAt, Scope, Digest, UserSid),
 *       Signature,
 *       SignerKey
 *     )
 *   )
 *
 * Implementation:
 *   1. Validate all parameters are non-NULL strings
 *   2. Call existing verifySignature() from crypto-utils
 *   3. Return 1 for valid, 0 for invalid
 *
 * Security Notes:
 *   - Uses secp256k1 elliptic curve cryptography
 *   - Message is expected to already be hashed (SHA-256)
 *   - All encoding/decoding errors return false (0)
 */
export const signatureValidFunc = createScalarFunction(
	{
		name: 'SignatureValid',
		numArgs: 3,
		deterministic: true,
	},
	(
		messageDigest: SqlValue,
		signature: SqlValue,
		publicKey: SqlValue
	): SqlValue => {
		try {
			// Validate all parameters are present and are strings
			if (
				messageDigest === null ||
				messageDigest === undefined ||
				signature === null ||
				signature === undefined ||
				publicKey === null ||
				publicKey === undefined
			) {
				return 0; // Invalid if any parameter is NULL
			}

			// Convert to strings
			const messageDigestStr = String(messageDigest);
			const signatureStr = String(signature);
			const publicKeyStr = String(publicKey);

			// Verify the signature using verifySignatureHash
			// The Digest() function already produces a SHA-256 hash, so we verify
			// against the hash directly rather than hashing again
			const isValid = verifySignatureHash(
				messageDigestStr,
				signatureStr,
				publicKeyStr
			);

			return isValid ? 1 : 0;
		} catch (error) {
			// Any error in signature verification means invalid signature
			console.error('SignatureValid function error:', error);
			return 0;
		}
	}
);

/**
 * DigestAll(value) - Aggregate/window function for combining hashes
 *
 * Accumulates hashes across multiple rows in order, combining them into a single
 * cumulative hash. Used with window functions to create merkle-tree-like digests
 * of ordered data.
 *
 * Parameters:
 *   @param value - Hash value to accumulate (typically from Digest())
 *
 * Returns:
 *   Cumulative hash of all values processed so far
 *
 * Usage in SQL (as window function):
 *   SELECT DigestAll(Digest(EffectiveAt, ThresholdPolicies))
 *     OVER (ORDER BY EffectiveAt)
 *   FROM Admin
 *
 * Usage in SQL (as aggregate):
 *   SELECT DigestAll(Digest(col1, col2))
 *   FROM table
 *   GROUP BY category
 *
 * Implementation:
 *   1. Start with NULL accumulator
 *   2. For each row:
 *      - If accumulator is NULL, set it to current value
 *      - Otherwise, compute Digest(accumulator, currentValue)
 *   3. Return final accumulated hash
 *
 * Note:
 *   This function is order-dependent. Different orderings will produce
 *   different results, which is intentional for creating deterministic
 *   signatures of ordered data sets.
 */
interface DigestAllAccumulator {
	hash: string | null;
}

export const digestAllFunc = createAggregateFunction(
	{
		name: 'DigestAll',
		numArgs: 1,
		initialValue: { hash: null },
		deterministic: true,
	},
	(acc: DigestAllAccumulator, value: SqlValue): DigestAllAccumulator => {
		// Skip NULL values
		if (value === null || value === undefined) {
			return acc;
		}

		const valueStr = String(value);

		// If accumulator is empty, this is the first value
		if (acc.hash === null) {
			return { hash: valueStr };
		}

		// Combine current accumulator with new value
		// Hash(previousHash + currentValue)
		try {
			const combined = acc.hash + valueStr;
			const newHash = hashMessage(combined);
			return { hash: newHash };
		} catch (error) {
			console.error('DigestAll step error:', error);
			return acc;
		}
	},
	(acc: DigestAllAccumulator): SqlValue => {
		// Return NULL for empty set, otherwise return accumulated hash
		return acc.hash;
	}
);

/**
 * H16(value) - First 16 characters of SHA-256 hash
 *
 * Returns the first 16 hexadecimal characters of the SHA-256 hash of the input value.
 * Used for creating shorter hash identifiers while maintaining reasonable collision resistance.
 *
 * Parameters:
 *   @param value - Value to hash (converted to string)
 *
 * Returns:
 *   First 16 hex characters of SHA-256 hash, or NULL if input is NULL
 *
 * Usage in SQL:
 *   constraint HashValid check on insert (Hash = H16(Sid))
 *
 * Implementation:
 *   1. Convert input to string (NULL → NULL)
 *   2. Compute SHA-256 hash
 *   3. Return first 16 characters of hex-encoded hash
 *
 * Security Notes:
 *   - 16 hex chars = 64 bits of entropy
 *   - Suitable for short identifiers with acceptable collision probability
 *   - For security-critical uses, prefer full Digest() function
 */
export const h16Func = createScalarFunction(
	{
		name: 'H16',
		numArgs: 1,
		deterministic: true,
	},
	(value: SqlValue): SqlValue => {
		if (value === null || value === undefined) {
			return null;
		}
		try {
			const valueStr = String(value);
			const hash = hashMessage(valueStr);
			// Return first 16 hex characters (64 bits)
			return hash.substring(0, 16);
		} catch (error) {
			console.error('H16 function error:', error);
			return null;
		}
	}
);

/**
 * All custom functions to be registered with the database
 */
export const CUSTOM_FUNCTIONS = [digestFunc, digestAllFunc, signatureValidFunc, h16Func];
