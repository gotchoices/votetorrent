/**
 * Tests for custom SQL functions (Digest, DigestAll, SignatureValid)
 *
 * These tests verify that the custom cryptographic functions work correctly
 * when registered with the Quereus database and can be used in SQL queries
 * and constraints.
 */

import { expect } from 'aegir/chai';
import { Database } from '@quereus/quereus';
import { CUSTOM_FUNCTIONS } from '../src/database/custom-functions.js';
import {
	generatePrivateKey,
	getPublicKey,
	signMessage,
	hashMessage,
} from '../src/common/crypto-utils.js';

/**
 * Helper to collect async iterable results into an array
 */
async function collectRows<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const results: T[] = [];
	for await (const row of iterable) {
		results.push(row);
	}
	return results;
}

describe('Custom Database Functions', () => {
	let db: Database;

	// Note: Each describe block within this suite should manage its own database lifecycle
	// if it needs special setup (like creating tables)

	describe('Digest() Function', () => {
		beforeEach(() => {
			db = new Database();
			const mainSchema = db.schemaManager.getMainSchema();
			for (const funcDef of CUSTOM_FUNCTIONS) {
				mainSchema.addFunction(funcDef);
			}
		});

		afterEach(async () => {
			await db.close();
		});

		it('should hash a single string value', async () => {
			const result = await db.exec(
				"SELECT Digest('hello') as hash"
			);
			const stmt = db.prepare("SELECT Digest('hello') as hash");
			const rows = await collectRows(stmt.all());

			expect(rows).to.have.length(1);
			expect(rows[0]?.hash).to.be.a('string');
			expect(rows[0]?.hash).to.have.length.greaterThan(0);

			// Verify it matches the TypeScript hash
			const expectedHash = hashMessage('hello');
			expect(rows[0]?.hash).to.equal(expectedHash);
		});

		it('should hash multiple concatenated values', async () => {
			const stmt = db.prepare("SELECT Digest('hello', 'world') as hash");
			const rows = await collectRows(stmt.all());

			expect(rows).to.have.length(1);

			// Should equal hash of 'helloworld'
			const expectedHash = hashMessage('helloworld');
			expect(rows[0]?.hash).to.equal(expectedHash);
		});

		it('should handle NULL values as empty strings', async () => {
			const stmt = db.prepare("SELECT Digest('hello', NULL, 'world') as hash");
			const rows = await collectRows(stmt.all());

			expect(rows).to.have.length(1);

			// Should equal hash of 'helloworld'
			const expectedHash = hashMessage('helloworld');
			expect(rows[0]?.hash).to.equal(expectedHash);
		});

		it('should handle numeric values', async () => {
			const stmt = db.prepare("SELECT Digest(123, 456) as hash");
			const rows = await collectRows(stmt.all());

			expect(rows).to.have.length(1);

			// Should equal hash of '123456'
			const expectedHash = hashMessage('123456');
			expect(rows[0]?.hash).to.equal(expectedHash);
		});

		it('should be deterministic', async () => {
			const stmt1 = db.prepare("SELECT Digest('test', 123) as hash");
			const stmt2 = db.prepare("SELECT Digest('test', 123) as hash");

			const rows1 = await collectRows(stmt1.all());
			const rows2 = await collectRows(stmt2.all());

			expect(rows1[0]?.hash).to.equal(rows2[0]?.hash);
		});

		it('should produce different hashes for different inputs', async () => {
			const stmt1 = db.prepare("SELECT Digest('hello') as hash");
			const stmt2 = db.prepare("SELECT Digest('world') as hash");

			const rows1 = await collectRows(stmt1.all());
			const rows2 = await collectRows(stmt2.all());

			expect(rows1[0]?.hash).to.not.equal(rows2[0]?.hash);
		});
	});

	// TODO: Fix Quereus memory table persistence issue causing test failures
	// These tests work individually but fail when run together
	describe.skip('DigestAll() Aggregate Function', () => {
		beforeEach(async () => {
			// Create a fresh database for each test
			db = new Database();
			const mainSchema = db.schemaManager.getMainSchema();
			for (const funcDef of CUSTOM_FUNCTIONS) {
				mainSchema.addFunction(funcDef);
			}

			// Create a test table with some data
			await db.exec(`
				CREATE TABLE test_data (
					id INTEGER PRIMARY KEY,
					value TEXT
				)
			`);

			// Insert test data
			await db.exec(`
				INSERT INTO test_data (id, value) VALUES
					(1, 'first'),
					(2, 'second'),
					(3, 'third')
			`);
		});

		afterEach(async () => {
			// Close database
			await db.close();
		});

		it('should accumulate hashes in order', async () => {
			const stmt = db.prepare(`
				SELECT DigestAll(Digest(value)) as cumulative_hash
				FROM test_data
			`);
			const rows = await collectRows(stmt.all());

			expect(rows).to.have.length(1);
			expect(rows[0]?.cumulative_hash).to.be.a('string');
			expect(rows[0]?.cumulative_hash).to.have.length.greaterThan(0);
		});

		it('should be order-dependent', async () => {
			// Hash in original order
			const stmt1 = db.prepare(`
				SELECT DigestAll(Digest(value)) as hash
				FROM test_data
				ORDER BY id ASC
			`);
			const rows1 = await collectRows(stmt1.all());

			// Hash in reverse order
			const stmt2 = db.prepare(`
				SELECT DigestAll(Digest(value)) as hash
				FROM test_data
				ORDER BY id DESC
			`);
			const rows2 = await collectRows(stmt2.all());

			// Different orders should produce different hashes
			expect(rows1[0]?.hash).to.not.equal(rows2[0]?.hash);
		});

		it('should work as a window function', async () => {
			const stmt = db.prepare(`
				SELECT
					id,
					value,
					DigestAll(Digest(value)) OVER (ORDER BY id) as running_hash
				FROM test_data
				ORDER BY id
			`);
			const rows = await collectRows(stmt.all());

			expect(rows).to.have.length(3);

			// Each row should have a different running hash
			expect(rows[0]?.running_hash).to.not.equal(rows[1]?.running_hash);
			expect(rows[1]?.running_hash).to.not.equal(rows[2]?.running_hash);

			// The final row should match the aggregate result
			const aggregateStmt = db.prepare(`
				SELECT DigestAll(Digest(value)) as hash
				FROM test_data
			`);
			const aggregateRows = await collectRows(aggregateStmt.all());
			expect(rows[2]?.running_hash).to.equal(aggregateRows[0]?.hash);
		});

		it('should return NULL for empty set', async () => {
			await db.exec('DELETE FROM test_data');

			const stmt = db.prepare(`
				SELECT DigestAll(Digest(value)) as hash
				FROM test_data
			`);
			const rows = await collectRows(stmt.all());

			expect(rows).to.have.length(1);
			expect(rows[0]?.hash).to.be.null;
		});

		it('should skip NULL values', async () => {
			await db.exec(`
				INSERT INTO test_data (id, value) VALUES (4, NULL)
			`);

			const stmt = db.prepare(`
				SELECT DigestAll(Digest(value)) as hash
				FROM test_data
				WHERE id <= 3
			`);
			const rows1 = await collectRows(stmt.all());

			const stmt2 = db.prepare(`
				SELECT DigestAll(Digest(value)) as hash
				FROM test_data
			`);
			const rows2 = await collectRows(stmt2.all());

			// NULL should not affect the hash
			expect(rows1[0]?.hash).to.equal(rows2[0]?.hash);
		});
	});

	describe('SignatureValid() Function', () => {
		let privateKey: string;
		let publicKey: string;
		let message: string;
		let messageHash: string;
		let signature: string;

		beforeEach(() => {
			// Create a fresh database for each test
			db = new Database();
			const mainSchema = db.schemaManager.getMainSchema();
			for (const funcDef of CUSTOM_FUNCTIONS) {
				mainSchema.addFunction(funcDef);
			}

			// Generate test data
			// Generate test keys and signature
			privateKey = generatePrivateKey();
			publicKey = getPublicKey(privateKey);
			message = 'Test message for signature verification';
			messageHash = hashMessage(message);
			signature = signMessage(message, privateKey);
		});

		afterEach(async () => {
			await db.close();
		});

		it('should validate correct signatures', async () => {
			const stmt = db.prepare(`
				SELECT SignatureValid(?, ?, ?) as is_valid
			`);
			const rows = await collectRows(stmt.all({ 1: messageHash, 2: signature, 3: publicKey }));

			expect(rows).to.have.length(1);
			expect(rows[0]?.is_valid).to.equal(1); // 1 for valid
		});

		it('should reject invalid signatures', async () => {
			const wrongSignature = generatePrivateKey(); // Random hex string as invalid signature

			const stmt = db.prepare(`
				SELECT SignatureValid(?, ?, ?) as is_valid
			`);
			const rows = await collectRows(stmt.all({
				1: messageHash,
				2: wrongSignature,
				3: publicKey,
			}));

			expect(rows).to.have.length(1);
			expect(rows[0]?.is_valid).to.equal(0); // 0 for invalid
		});

		it('should reject signatures with wrong public key', async () => {
			const wrongPrivateKey = generatePrivateKey();
			const wrongPublicKey = getPublicKey(wrongPrivateKey);

			const stmt = db.prepare(`
				SELECT SignatureValid(?, ?, ?) as is_valid
			`);
			const rows = await collectRows(stmt.all({
				1: messageHash,
				2: signature,
				3: wrongPublicKey,
			}));

			expect(rows).to.have.length(1);
			expect(rows[0]?.is_valid).to.equal(0); // 0 for invalid
		});

		it('should reject signatures for different messages', async () => {
			const differentMessage = 'Different message';
			const differentHash = hashMessage(differentMessage);

			const stmt = db.prepare(`
				SELECT SignatureValid(?, ?, ?) as is_valid
			`);
			const rows = await collectRows(stmt.all({
				1: differentHash,
				2: signature,
				3: publicKey,
			}));

			expect(rows).to.have.length(1);
			expect(rows[0]?.is_valid).to.equal(0); // 0 for invalid
		});

		it('should return 0 for NULL parameters', async () => {
			const stmt = db.prepare(`
				SELECT SignatureValid(NULL, ?, ?) as is_valid
			`);
			const rows = await collectRows(stmt.all({ 1: signature, 2: publicKey }));

			expect(rows).to.have.length(1);
			expect(rows[0]?.is_valid).to.equal(0); // 0 for invalid
		});

		// TODO: Fix Quereus memory table persistence issue
		it.skip('should work in CHECK constraints', async () => {
			// Create a table with signature validation constraint
			await db.exec(`
				CREATE TABLE signed_messages (
					id INTEGER PRIMARY KEY,
					message TEXT,
					message_hash TEXT,
					signature TEXT,
					public_key TEXT,
					CHECK (SignatureValid(message_hash, signature, public_key) = 1)
				)
			`);

			// Valid signature should insert successfully
			const insertStmt = db.prepare(`
				INSERT INTO signed_messages (id, message, message_hash, signature, public_key)
				VALUES (?, ?, ?, ?, ?)
			`);
			await expect(
				insertStmt.run({
					1: 1,
					2: message,
					3: messageHash,
					4: signature,
					5: publicKey,
				})
			).to.be.fulfilled;

			// Invalid signature should fail constraint
			const wrongSignature = generatePrivateKey();
			await expect(
				insertStmt.run({
					1: 2,
					2: 'Another message',
					3: hashMessage('Another message'),
					4: wrongSignature,
					5: publicKey,
				})
			).to.be.rejected;
		});
	});

	describe('H16() Function', () => {
		beforeEach(() => {
			db = new Database();
			const mainSchema = db.schemaManager.getMainSchema();
			for (const funcDef of CUSTOM_FUNCTIONS) {
				mainSchema.addFunction(funcDef);
			}
		});

		afterEach(async () => {
			await db.close();
		});

		it('should return first 16 characters of hash', async () => {
			const stmt = db.prepare("SELECT H16('test') as hash");
			const rows = await collectRows(stmt.all());

			expect(rows).to.have.length(1);
			expect(rows[0]?.hash).to.be.a('string');
			expect(rows[0]?.hash).to.have.length(16);
		});

		it('should match first 16 chars of Digest()', async () => {
			const stmt = db.prepare("SELECT H16('test') as h16, Digest('test') as digest");
			const rows = await collectRows(stmt.all());

			const h16 = rows[0]?.h16;
			const digest = rows[0]?.digest;

			expect(h16).to.equal(String(digest).substring(0, 16));
		});

		it('should handle NULL values', async () => {
			const stmt = db.prepare("SELECT H16(NULL) as hash");
			const rows = await collectRows(stmt.all());

			expect(rows).to.have.length(1);
			expect(rows[0]?.hash).to.be.null;
		});

		it('should be deterministic', async () => {
			const stmt1 = db.prepare("SELECT H16('test') as hash");
			const stmt2 = db.prepare("SELECT H16('test') as hash");

			const rows1 = await collectRows(stmt1.all());
			const rows2 = await collectRows(stmt2.all());

			expect(rows1[0]?.hash).to.equal(rows2[0]?.hash);
		});

		it('should produce different hashes for different inputs', async () => {
			const stmt1 = db.prepare("SELECT H16('test1') as hash");
			const stmt2 = db.prepare("SELECT H16('test2') as hash");

			const rows1 = await collectRows(stmt1.all());
			const rows2 = await collectRows(stmt2.all());

			expect(rows1[0]?.hash).to.not.equal(rows2[0]?.hash);
		});

		it('should handle numeric values', async () => {
			const stmt = db.prepare("SELECT H16(12345) as hash");
			const rows = await collectRows(stmt.all());

			expect(rows).to.have.length(1);
			expect(rows[0]?.hash).to.be.a('string');
			expect(rows[0]?.hash).to.have.length(16);
		});
	});

	describe('Integration: Digest + SignatureValid', () => {
		beforeEach(() => {
			db = new Database();
			const mainSchema = db.schemaManager.getMainSchema();
			for (const funcDef of CUSTOM_FUNCTIONS) {
				mainSchema.addFunction(funcDef);
			}
		});

		afterEach(async () => {
			await db.close();
		});

		it('should verify signatures of digested data', async () => {
			const privateKey = generatePrivateKey();
			const publicKey = getPublicKey(privateKey);

			// Data to sign
			const data1 = 'part1';
			const data2 = 'part2';
			const data3 = 'part3';

			// Create hash using Digest() function (this simulates what happens in SQL)
			const digestStmt = db.prepare("SELECT Digest(?, ?, ?) as hash");
			const digestRows = await collectRows(digestStmt.all({ 1: data1, 2: data2, 3: data3 }));
			const digestHash = String(digestRows[0]?.hash);

			// Sign the digest using TypeScript
			// We need to sign the concatenated original values, as that's what Digest() hashes
			const combinedData = data1 + data2 + data3;
			const signature = signMessage(combinedData, privateKey);

			// Verify the signature in SQL
			const verifyStmt = db.prepare(`
				SELECT SignatureValid(Digest(?, ?, ?), ?, ?) as is_valid
			`);
			const verifyRows = await collectRows(verifyStmt.all({
				1: data1,
				2: data2,
				3: data3,
				4: signature,
				5: publicKey,
			}));

			expect(verifyRows[0]?.is_valid).to.equal(1);
		});
	});
});
