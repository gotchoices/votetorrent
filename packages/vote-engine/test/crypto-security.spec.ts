/**
 * Advanced Cryptographic Security Tests
 *
 * These tests verify the security properties of the cryptographic implementations
 * and test against known attack vectors and edge cases.
 */

import { expect } from 'aegir/chai';
import {
	generateSecureSid,
	generatePrivateKey,
	getPublicKey,
	signMessage,
	verifySignature,
	verifySignatureHash,
	hashMessage,
	hashBytes,
	generateRandomBytes,
	isValidHex,
	isValidPrivateKey,
} from '../src/common/crypto-utils.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

describe('Cryptographic Security Tests', () => {
	describe('Attack Vector Resistance', () => {
		it('should prevent signature malleability', () => {
			// ECDSA signatures can be malleable - test that we handle this correctly
			const privateKey = generatePrivateKey();
			const publicKey = getPublicKey(privateKey);
			const message = 'Test message';
			const signature = signMessage(message, privateKey);

			// Verify original signature works
			expect(verifySignature(message, signature, publicKey)).to.be.true;

			// Try to create a malleable signature by flipping bits
			// (This should fail because @noble/curves uses non-malleable signatures)
			const sigBytes = hexToBytes(signature);
			const malleableSig = new Uint8Array(sigBytes);
			malleableSig[0] ^= 0xFF; // Flip bits in first byte
			const malleableSigHex = bytesToHex(malleableSig);

			// Malleable signature should fail verification
			expect(verifySignature(message, malleableSigHex, publicKey)).to.be.false;
		});

		it('should prevent timing attacks on signature verification', () => {
			// Signature verification should take similar time regardless of validity
			const privateKey = generatePrivateKey();
			const publicKey = getPublicKey(privateKey);
			const message = 'Test message';
			const signature = signMessage(message, privateKey);

			const wrongPublicKey = getPublicKey(generatePrivateKey());

			// Time valid signature verification
			const validStart = Date.now();
			for (let i = 0; i < 100; i++) {
				verifySignature(message, signature, publicKey);
			}
			const validTime = Date.now() - validStart;

			// Time invalid signature verification
			const invalidStart = Date.now();
			for (let i = 0; i < 100; i++) {
				verifySignature(message, signature, wrongPublicKey);
			}
			const invalidTime = Date.now() - invalidStart;

			// Times should be within 50% of each other (not constant time, but reasonable)
			const ratio = Math.max(validTime, invalidTime) / Math.min(validTime, invalidTime);
			expect(ratio).to.be.lessThan(1.5);
		});

		it('should resist hash collision attempts', () => {
			// Generate many hashes and ensure no collisions
			const hashes = new Set<string>();
			const count = 10000;

			for (let i = 0; i < count; i++) {
				const hash = hashMessage(`message-${i}`);
				expect(hashes.has(hash)).to.be.false;
				hashes.add(hash);
			}

			expect(hashes.size).to.equal(count);
		});

		it('should handle very long messages securely', () => {
			const privateKey = generatePrivateKey();
			const publicKey = getPublicKey(privateKey);

			// Test with 1MB message
			const longMessage = 'x'.repeat(1024 * 1024);
			const signature = signMessage(longMessage, privateKey);

			expect(verifySignature(longMessage, signature, publicKey)).to.be.true;
		});

		it('should reject signatures with wrong message length', () => {
			const privateKey = generatePrivateKey();
			const publicKey = getPublicKey(privateKey);
			const message = 'Test message';
			const signature = signMessage(message, privateKey);

			// Verify fails with truncated message
			expect(verifySignature(message.substring(0, 5), signature, publicKey)).to.be.false;

			// Verify fails with extended message
			expect(verifySignature(message + 'extra', signature, publicKey)).to.be.false;
		});
	});

	describe('Edge Cases and Boundary Conditions', () => {
		it('should handle empty strings', () => {
			const hash = hashMessage('');
			expect(hash).to.be.a('string');
			expect(hash).to.have.length(64); // SHA-256 produces 64 hex chars
		});

		it('should handle null bytes in messages', () => {
			const message = 'before\x00after';
			const hash = hashMessage(message);
			expect(hash).to.be.a('string');
			expect(hash).to.have.length(64);

			// Should be different from non-null version
			const nonNullHash = hashMessage('beforeafter');
			expect(hash).to.not.equal(nonNullHash);
		});

		it('should handle Unicode and emoji in messages', () => {
			const privateKey = generatePrivateKey();
			const publicKey = getPublicKey(privateKey);

			const messages = [
				'Hello 世界',
				'🔐 Crypto 🔑',
				'Ñoño',
				'café',
				'🚀💻🔒',
			];

			for (const message of messages) {
				const signature = signMessage(message, privateKey);
				expect(verifySignature(message, signature, publicKey)).to.be.true;
			}
		});

		it('should handle maximum length SIDs', () => {
			// Test with very large byte length
			const sid = generateSecureSid('test', 256);
			expect(sid).to.match(/^test-[0-9a-f]{512}$/); // 256 bytes = 512 hex chars
		});

		it('should handle zero-length SID generation gracefully', () => {
			// This should still work, just produce prefix only
			const sid = generateSecureSid('test', 0);
			expect(sid).to.equal('test-');
		});

		it('should handle special characters in SID prefixes', () => {
			const specialPrefixes = [
				'user-admin',
				'authority_123',
				'election.official',
				'vote@authority',
			];

			for (const prefix of specialPrefixes) {
				const sid = generateSecureSid(prefix);
				expect(sid).to.match(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[0-9a-f]{32}$`));
			}
		});

		it('should validate hex strings correctly for all edge cases', () => {
			// Valid cases
			expect(isValidHex('')).to.be.true; // Empty is valid
			expect(isValidHex('00')).to.be.true;
			expect(isValidHex('ff')).to.be.true;
			expect(isValidHex('ABCDEF')).to.be.true;
			expect(isValidHex('123456')).to.be.true;

			// Invalid cases
			expect(isValidHex('0')).to.be.false; // Odd length
			expect(isValidHex('xyz')).to.be.false; // Non-hex chars
			expect(isValidHex('12 34')).to.be.false; // Space
			expect(isValidHex('12-34')).to.be.false; // Dash
			expect(isValidHex('0x1234')).to.be.false; // 0x prefix
		});
	});

	describe('Known Test Vectors', () => {
		it('should match SHA-256 test vectors from NIST', () => {
			// NIST test vectors for SHA-256
			const vectors = [
				{
					message: '',
					hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
				},
				{
					message: 'abc',
					hash: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
				},
				{
					message: 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
					hash: '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
				},
			];

			for (const vector of vectors) {
				const hash = hashMessage(vector.message);
				expect(hash).to.equal(vector.hash);
			}
		});

		it('should produce deterministic signatures (RFC 6979)', () => {
			// RFC 6979 specifies deterministic ECDSA signatures
			const privateKey = generatePrivateKey();
			const message = 'Test message for deterministic signatures';

			// Sign the same message multiple times
			const signatures = [];
			for (let i = 0; i < 10; i++) {
				signatures.push(signMessage(message, privateKey));
			}

			// All signatures should be identical
			const firstSig = signatures[0];
			for (const sig of signatures) {
				expect(sig).to.equal(firstSig);
			}
		});
	});

	describe('Cross-Function Integration', () => {
		it('should correctly chain hash -> sign -> verify', () => {
			const privateKey = generatePrivateKey();
			const publicKey = getPublicKey(privateKey);
			const data = 'Important data to sign';

			// Hash the data
			const hash = hashMessage(data);

			// Sign the hash using verifySignatureHash
			const signature = signMessage(data, privateKey);

			// Verify using hash
			expect(verifySignatureHash(hash, signature, publicKey)).to.be.true;
		});

		it('should handle multiple keys and signatures correctly', () => {
			// Create multiple key pairs
			const keys: Array<{ private: string; public: string }> = [];
			for (let i = 0; i < 5; i++) {
				const privateKey = generatePrivateKey();
				keys.push({
					private: privateKey,
					public: getPublicKey(privateKey),
				});
			}

			const message = 'Multi-signature test';

			// Each key should sign and verify independently
			for (let i = 0; i < keys.length; i++) {
				const key = keys[i];
				if (!key) continue;
				const signature = signMessage(message, key.private);

				// Should verify with correct key
				expect(verifySignature(message, signature, key.public)).to.be.true;

				// Should fail with all other keys
				for (let j = 0; j < keys.length; j++) {
					if (i !== j) {
						const otherKey = keys[j];
						if (!otherKey) continue;
						expect(verifySignature(message, signature, otherKey.public)).to.be.false;
					}
				}
			}
		});

		it('should maintain signature validity across message hash', () => {
			const privateKey = generatePrivateKey();
			const publicKey = getPublicKey(privateKey);

			// Sign original message
			const message = 'Original message';
			const signature = signMessage(message, privateKey);

			// Get hash of message
			const messageHash = hashMessage(message);

			// Verify using both methods
			expect(verifySignature(message, signature, publicKey)).to.be.true;
			expect(verifySignatureHash(messageHash, signature, publicKey)).to.be.true;
		});
	});

	describe('Performance and Resource Usage', () => {
		it('should generate keys quickly', () => {
			const start = Date.now();
			for (let i = 0; i < 100; i++) {
				generatePrivateKey();
			}
			const elapsed = Date.now() - start;

			// Should generate 100 keys in less than 1 second
			expect(elapsed).to.be.lessThan(1000);
		});

		it('should hash large data efficiently', () => {
			const largeData = 'x'.repeat(1024 * 1024); // 1MB

			const start = Date.now();
			hashMessage(largeData);
			const elapsed = Date.now() - start;

			// Should hash 1MB in less than 100ms
			expect(elapsed).to.be.lessThan(100);
		});

		it('should verify signatures quickly', () => {
			const privateKey = generatePrivateKey();
			const publicKey = getPublicKey(privateKey);
			const message = 'Performance test message';
			const signature = signMessage(message, privateKey);

			const start = Date.now();
			for (let i = 0; i < 100; i++) {
				verifySignature(message, signature, publicKey);
			}
			const elapsed = Date.now() - start;

			// Should verify 100 signatures in less than 500ms
			expect(elapsed).to.be.lessThan(500);
		});

		it('should handle concurrent operations', async () => {
			// Test that multiple crypto operations can run concurrently
			const operations = [];

			for (let i = 0; i < 10; i++) {
				operations.push(
					Promise.resolve().then(() => {
						const privateKey = generatePrivateKey();
						const publicKey = getPublicKey(privateKey);
						const message = `Concurrent message ${i}`;
						const signature = signMessage(message, privateKey);
						return verifySignature(message, signature, publicKey);
					})
				);
			}

			const results = await Promise.all(operations);
			expect(results.every(r => r === true)).to.be.true;
		});
	});

	describe('Randomness Quality', () => {
		it('should produce uniformly distributed random bytes', () => {
			// Generate many random bytes and check distribution
			const buckets = new Array(256).fill(0);
			const samples = 10000;

			for (let i = 0; i < samples; i++) {
				const randomHex = generateRandomBytes(1);
				const randomByte = parseInt(randomHex, 16);
				buckets[randomByte]++;
			}

			// Check that distribution is roughly uniform
			// Each bucket should have approximately samples/256 values
			const expectedPerBucket = samples / 256;
			const tolerance = expectedPerBucket * 0.5; // 50% tolerance

			for (const count of buckets) {
				expect(count).to.be.greaterThan(expectedPerBucket - tolerance);
				expect(count).to.be.lessThan(expectedPerBucket + tolerance);
			}
		});

		it('should pass basic entropy check for SIDs', () => {
			// Generate many SIDs and verify entropy
			const sids = [];
			for (let i = 0; i < 1000; i++) {
				sids.push(generateSecureSid('test'));
			}

			// Count unique characters in hex part
			const hexParts = sids.map(sid => sid.split('-')[1]);
			const allHex = hexParts.join('');

			// Check that all hex digits appear
			const hexChars = new Set(allHex);
			expect(hexChars.size).to.be.greaterThan(10); // Should use most hex digits

			// Calculate simple entropy measure
			const charCounts: Record<string, number> = {};
			for (const char of allHex) {
				charCounts[char] = (charCounts[char] || 0) + 1;
			}

			// Each character should appear roughly equally
			const avgCount = allHex.length / 16; // 16 possible hex chars
			for (const count of Object.values(charCounts)) {
				// Each char should appear within 30% of average
				expect(count).to.be.greaterThan(avgCount * 0.7);
				expect(count).to.be.lessThan(avgCount * 1.3);
			}
		});

		it('should not produce sequential private keys', () => {
			// Generate keys and verify they are not sequential
			const keys = [];
			for (let i = 0; i < 10; i++) {
				keys.push(generatePrivateKey());
			}

			// Convert to BigInt and check differences
			for (let i = 1; i < keys.length; i++) {
				const key1 = BigInt('0x' + keys[i - 1]);
				const key2 = BigInt('0x' + keys[i]);
				const diff = key1 > key2 ? key1 - key2 : key2 - key1;

				// Difference should be very large (not sequential)
				// For a 256-bit number, sequential would be diff < 1000
				const diffNumber = Number(diff);
				expect(diffNumber).to.be.greaterThan(1000);
			}
		});
	});

	describe('Error Handling and Validation', () => {
		it('should reject invalid private keys for signing', () => {
			const invalidKeys = [
				'',
				'not-hex',
				'12', // Too short
				'0'.repeat(128), // All zeros
				'f'.repeat(128), // All ones (likely > curve order)
			];

			for (const invalidKey of invalidKeys) {
				expect(() => {
					signMessage('test', invalidKey);
				}).to.throw();
			}
		});

		it('should reject invalid public keys for verification', () => {
			const privateKey = generatePrivateKey();
			const signature = signMessage('test', privateKey);

			const invalidPublicKeys = [
				'',
				'not-hex',
				'12', // Too short
				'0'.repeat(66), // Invalid point
			];

			for (const invalidKey of invalidPublicKeys) {
				const result = verifySignature('test', signature, invalidKey);
				expect(result).to.be.false;
			}
		});

		it('should handle corrupted signatures gracefully', () => {
			const privateKey = generatePrivateKey();
			const publicKey = getPublicKey(privateKey);
			const message = 'test';
			const signature = signMessage(message, privateKey);

			// Various corrupted signatures
			const corruptedSigs = [
				'',
				'not-hex',
				signature.substring(0, 64), // Truncated
				signature + 'ff', // Extended
				signature.replace(/0/g, 'f'), // Bit flips
			];

			for (const corruptedSig of corruptedSigs) {
				const result = verifySignature(message, corruptedSig, publicKey);
				expect(result).to.be.false;
			}
		});
	});
});
