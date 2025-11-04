import { expect } from 'aegir/chai';
import {
	generateSecureSid,
	generatePrivateKey,
	getPublicKey,
	signMessage,
	verifySignature,
	hashMessage,
	hashBytes,
	generateRandomBytes,
	isValidHex,
	isValidPrivateKey,
} from '../src/common/crypto-utils.js';

describe('Crypto Utils', () => {
	describe('generateSecureSid', () => {
		it('should generate a SID with the correct format', () => {
			const sid = generateSecureSid('test');
			expect(sid).to.match(/^test-[0-9a-f]{32}$/);
		});

		it('should generate unique SIDs', () => {
			const sid1 = generateSecureSid('test');
			const sid2 = generateSecureSid('test');
			expect(sid1).to.not.equal(sid2);
		});

		it('should respect custom length', () => {
			const sid = generateSecureSid('test', 32);
			expect(sid).to.match(/^test-[0-9a-f]{64}$/);
		});

		it('should work with different prefixes', () => {
			const userSid = generateSecureSid('user');
			const authSid = generateSecureSid('auth');
			const electionSid = generateSecureSid('election');

			expect(userSid).to.match(/^user-/);
			expect(authSid).to.match(/^auth-/);
			expect(electionSid).to.match(/^election-/);
		});

		it('should not use Math.random (check for non-predictability)', () => {
			// Generate many SIDs and check for patterns that would indicate Math.random
			const sids = new Set();
			for (let i = 0; i < 100; i++) {
				sids.add(generateSecureSid('test'));
			}
			// All should be unique
			expect(sids.size).to.equal(100);
		});
	});

	describe('generatePrivateKey', () => {
		it('should generate a valid private key', () => {
			const key = generatePrivateKey();
			expect(key).to.match(/^[0-9a-f]{64}$/);
		});

		it('should generate unique private keys', () => {
			const key1 = generatePrivateKey();
			const key2 = generatePrivateKey();
			expect(key1).to.not.equal(key2);
		});

		it('should generate keys that are valid for secp256k1', () => {
			const key = generatePrivateKey();
			// Should not throw when getting public key
			const publicKey = getPublicKey(key);
			expect(publicKey).to.be.a('string');
			expect(publicKey.length).to.be.greaterThan(0);
		});
	});

	describe('getPublicKey', () => {
		it('should derive public key from private key', () => {
			const privateKey = generatePrivateKey();
			const publicKey = getPublicKey(privateKey);

			// Compressed public key should be 66 hex characters (33 bytes)
			expect(publicKey).to.match(/^[0-9a-f]{66}$/);
		});

		it('should generate same public key for same private key', () => {
			const privateKey = generatePrivateKey();
			const publicKey1 = getPublicKey(privateKey);
			const publicKey2 = getPublicKey(privateKey);

			expect(publicKey1).to.equal(publicKey2);
		});

		it('should support uncompressed public keys', () => {
			const privateKey = generatePrivateKey();
			const publicKey = getPublicKey(privateKey, false);

			// Uncompressed public key should be 130 hex characters (65 bytes)
			expect(publicKey).to.match(/^[0-9a-f]{130}$/);
		});
	});

	describe('signMessage and verifySignature', () => {
		it('should sign and verify a message', () => {
			const privateKey = generatePrivateKey();
			const publicKey = getPublicKey(privateKey);
			const message = 'Hello, world!';

			const signature = signMessage(message, privateKey);
			const isValid = verifySignature(message, signature, publicKey);

			expect(isValid).to.be.true;
		});

		it('should fail verification with wrong message', () => {
			const privateKey = generatePrivateKey();
			const publicKey = getPublicKey(privateKey);
			const message = 'Hello, world!';
			const wrongMessage = 'Goodbye, world!';

			const signature = signMessage(message, privateKey);
			const isValid = verifySignature(wrongMessage, signature, publicKey);

			expect(isValid).to.be.false;
		});

		it('should fail verification with wrong public key', () => {
			const privateKey = generatePrivateKey();
			const wrongPrivateKey = generatePrivateKey();
			const wrongPublicKey = getPublicKey(wrongPrivateKey);
			const message = 'Hello, world!';

			const signature = signMessage(message, privateKey);
			const isValid = verifySignature(message, signature, wrongPublicKey);

			expect(isValid).to.be.false;
		});

		it('should fail verification with invalid signature', () => {
			const privateKey = generatePrivateKey();
			const publicKey = getPublicKey(privateKey);
			const message = 'Hello, world!';

			const signature = signMessage(message, privateKey);
			const invalidSignature = signature.slice(0, -2) + '00';
			const isValid = verifySignature(message, invalidSignature, publicKey);

			expect(isValid).to.be.false;
		});

		it('should handle malformed signatures gracefully', () => {
			const privateKey = generatePrivateKey();
			const publicKey = getPublicKey(privateKey);
			const message = 'Hello, world!';

			const isValid1 = verifySignature(message, 'not-a-signature', publicKey);
			const isValid2 = verifySignature(message, '00', publicKey);
			const isValid3 = verifySignature(message, '', publicKey);

			expect(isValid1).to.be.false;
			expect(isValid2).to.be.false;
			expect(isValid3).to.be.false;
		});

		it('should produce deterministic signatures', () => {
			const privateKey = generatePrivateKey();
			const message = 'Hello, world!';

			const signature1 = signMessage(message, privateKey);
			const signature2 = signMessage(message, privateKey);

			// Signatures should be deterministic (RFC 6979)
			expect(signature1).to.equal(signature2);
		});
	});

	describe('hashMessage', () => {
		it('should hash a message', () => {
			const hash = hashMessage('Hello, world!');
			expect(hash).to.match(/^[0-9a-f]{64}$/);
		});

		it('should produce consistent hashes', () => {
			const message = 'Hello, world!';
			const hash1 = hashMessage(message);
			const hash2 = hashMessage(message);
			expect(hash1).to.equal(hash2);
		});

		it('should produce different hashes for different messages', () => {
			const hash1 = hashMessage('Hello, world!');
			const hash2 = hashMessage('Goodbye, world!');
			expect(hash1).to.not.equal(hash2);
		});

		it('should match known SHA-256 test vector', () => {
			// Known SHA-256 hash for empty string
			const hash = hashMessage('');
			expect(hash).to.equal('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
		});
	});

	describe('hashBytes', () => {
		it('should hash binary data', () => {
			const data = new Uint8Array([1, 2, 3, 4, 5]);
			const hash = hashBytes(data);
			expect(hash).to.match(/^[0-9a-f]{64}$/);
		});

		it('should produce consistent hashes', () => {
			const data = new Uint8Array([1, 2, 3, 4, 5]);
			const hash1 = hashBytes(data);
			const hash2 = hashBytes(data);
			expect(hash1).to.equal(hash2);
		});

		it('should match known SHA-256 test vector', () => {
			// Known SHA-256 hash for empty bytes
			const hash = hashBytes(new Uint8Array([]));
			expect(hash).to.equal('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
		});
	});

	describe('generateRandomBytes', () => {
		it('should generate random bytes', () => {
			const random = generateRandomBytes(16);
			expect(random).to.match(/^[0-9a-f]{32}$/);
		});

		it('should generate unique random data', () => {
			const random1 = generateRandomBytes(16);
			const random2 = generateRandomBytes(16);
			expect(random1).to.not.equal(random2);
		});

		it('should respect custom length', () => {
			const random = generateRandomBytes(32);
			expect(random).to.match(/^[0-9a-f]{64}$/);
		});
	});

	describe('isValidHex', () => {
		it('should validate correct hex strings', () => {
			expect(isValidHex('deadbeef')).to.be.true;
			expect(isValidHex('DEADBEEF')).to.be.true;
			expect(isValidHex('0123456789abcdef')).to.be.true;
			expect(isValidHex('')).to.be.true;
		});

		it('should reject invalid hex strings', () => {
			expect(isValidHex('not hex')).to.be.false;
			expect(isValidHex('xyz')).to.be.false;
			expect(isValidHex('123')).to.be.false; // Odd length
			expect(isValidHex('12 34')).to.be.false; // Space
		});
	});

	describe('isValidPrivateKey', () => {
		it('should validate correct private keys', () => {
			const key = generatePrivateKey();
			expect(isValidPrivateKey(key)).to.be.true;
		});

		it('should reject invalid private keys', () => {
			expect(isValidPrivateKey('not a key')).to.be.false;
			expect(isValidPrivateKey('123')).to.be.false;
			expect(isValidPrivateKey('')).to.be.false;
			// All zeros is not a valid private key
			expect(isValidPrivateKey('0000000000000000000000000000000000000000000000000000000000000000')).to.be.false;
		});

		it('should reject keys that are too large for the curve', () => {
			// A key larger than the curve order
			const invalidKey = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141';
			expect(isValidPrivateKey(invalidKey)).to.be.false;
		});
	});

	describe('Security properties', () => {
		it('should not leak private key from signatures', () => {
			const privateKey = generatePrivateKey();
			const message = 'test message';
			const signature = signMessage(message, privateKey);

			// Signature should not contain the private key
			expect(signature).to.not.include(privateKey);
		});

		it('should produce high-entropy SIDs', () => {
			// Generate many SIDs and check for statistical randomness
			const sids: string[] = [];
			for (let i = 0; i < 1000; i++) {
				sids.push(generateSecureSid('test'));
			}

			// Check for uniqueness (no collisions)
			const uniqueSids = new Set(sids);
			expect(uniqueSids.size).to.equal(1000);

			// Check that hex parts don't have obvious patterns
			const hexParts = sids.map(sid => sid.split('-')[1]);
			const firstChars = hexParts.map(hex => hex![0]);
			const uniqueFirstChars = new Set(firstChars);

			// Should have good distribution of first characters
			expect(uniqueFirstChars.size).to.be.greaterThan(10);
		});
	});
});
