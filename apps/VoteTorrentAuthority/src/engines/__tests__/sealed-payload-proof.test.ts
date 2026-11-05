/**
 * sealed-payload-proof.test.ts — the NODE POSITIVE CONTROL for the on-device
 * `[seal-kat]` Hermes proof (Phase 52, D-05).
 *
 * This suite exists to make an on-device FAIL *interpretable*. If the proof's
 * hardcoded vectors were wrong, the device run would go red and the obvious
 * conclusion — "Hermes computes different AES-GCM bytes than Node" — would be
 * false. So the same `runSealedPayloadProof()` the device runs is executed here
 * under Node first, and its constants are re-derived INDEPENDENTLY with
 * `node:crypto` rather than with the `@noble/ciphers` implementation under test.
 * Two implementations, one vector — the idiom `sealed-payload.spec.ts` uses.
 *
 * What this suite CANNOT see, by construction: Metro resolution, Hermes
 * evaluation, and the multi-copy module-binding class. Those are exactly why
 * 52-07 has a device task at all. A green here is a precondition for the device
 * run, never a substitute for it.
 */

import { createCipheriv, createDecipheriv, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runSealedPayloadProof } from '../sealed-payload-proof';

// The locked vectors, restated here rather than imported, so a typo in the
// module under test cannot silently agree with itself.
const KAT_SECRET = Buffer.alloc(20, 0x2a);
const KAT_PLAINTEXT = 'sealed-payload-kat-v1';
const KAT_LOOKUP_ID = 'm6tt8br-eQnbu-DtXgqikUAK6aU5YAgBpCPOoHHbvFc';
const KAT_NONCE_B64URL = 'oKGio6Slpqeoqaqr';
const KAT_CIPHERTEXT_B64URL =
	'qXNuk5pAGJW2xzVRrjb8G6GXFJhEN07Ja28qKlbwvj9hFQUnVg';

const LOOKUP_LABEL = 'bootstrap-lookup';
const CONTENT_LABEL = 'bootstrap-content';
const GCM_TAG_BYTES = 16;

const PROOF_SOURCE_PATH = join(__dirname, '..', 'sealed-payload-proof.ts');

/** HMAC-SHA256 with the LABEL in the key slot and the SECRET as the message. */
function hmacHalf(label: string): Buffer {
	return createHmac('sha256', Buffer.from(label, 'utf8'))
		.update(KAT_SECRET)
		.digest();
}

describe('sealed-payload-proof — Node positive control', () => {
	// -------------------------------------------------------------------------
	// 1. The proof itself
	// -------------------------------------------------------------------------
	it('runs all four legs PASS under Node, with an overall PASS verdict', async () => {
		const result = await runSealedPayloadProof();

		const byName = Object.fromEntries(
			result.legs.map(leg => [leg.name, leg]),
		);
		// Named individually so a red test says WHICH leg broke, not just "not PASS".
		expect(byName.derive?.status).toBe('PASS');
		expect(byName.seal?.status).toBe('PASS');
		expect(byName['unseal-kat']?.status).toBe('PASS');
		expect(byName.tamper?.status).toBe('PASS');

		expect(result.legs).toHaveLength(4);
		expect(result.verdict).toBe('PASS');
	});

	it('reports every leg exactly once, so the device verdict block is complete', async () => {
		const result = await runSealedPayloadProof();
		expect(result.legs.map(leg => leg.name).sort()).toEqual([
			'derive',
			'seal',
			'tamper',
			'unseal-kat',
		]);
	});

	// -------------------------------------------------------------------------
	// 2. Independent re-derivation of the hardcoded vectors with node:crypto
	// -------------------------------------------------------------------------
	describe('the hardcoded vectors, re-derived with node:crypto', () => {
		it('KAT_LOOKUP_ID is base64url of HMAC-SHA256(key=bootstrap-lookup, msg=secret)', () => {
			expect(hmacHalf(LOOKUP_LABEL).toString('base64url')).toBe(KAT_LOOKUP_ID);
		});

		it('the two derived halves are distinct — domain separation is really applied', () => {
			expect(hmacHalf(CONTENT_LABEL).toString('base64url')).not.toBe(
				KAT_LOOKUP_ID,
			);
			expect(hmacHalf(CONTENT_LABEL)).toHaveLength(32);
		});

		it('the pinned unseal-kat wrapper decrypts to the pinned plaintext under node:crypto', () => {
			const contentKey = hmacHalf(CONTENT_LABEL);
			const nonce = Buffer.from(KAT_NONCE_B64URL, 'base64url');
			const sealed = Buffer.from(KAT_CIPHERTEXT_B64URL, 'base64url');
			expect(nonce).toHaveLength(12);

			const body = sealed.subarray(0, sealed.length - GCM_TAG_BYTES);
			const tag = sealed.subarray(sealed.length - GCM_TAG_BYTES);

			const decipher = createDecipheriv('aes-256-gcm', contentKey, nonce);
			// The AAD is the lookupId's UTF-8 BYTES, not its decoded value.
			decipher.setAAD(Buffer.from(KAT_LOOKUP_ID, 'utf8'));
			decipher.setAuthTag(tag);
			const plaintext = Buffer.concat([
				decipher.update(body),
				decipher.final(),
			]).toString('utf8');

			expect(plaintext).toBe(KAT_PLAINTEXT);
		});

		it('node:crypto re-encrypting the same inputs reproduces the pinned ciphertext byte-for-byte', () => {
			const contentKey = hmacHalf(CONTENT_LABEL);
			const nonce = Buffer.from(KAT_NONCE_B64URL, 'base64url');

			const cipher = createCipheriv('aes-256-gcm', contentKey, nonce);
			cipher.setAAD(Buffer.from(KAT_LOOKUP_ID, 'utf8'));
			const produced = Buffer.concat([
				cipher.update(Buffer.from(KAT_PLAINTEXT, 'utf8')),
				cipher.final(),
				cipher.getAuthTag(),
			]);

			expect(produced.toString('base64url')).toBe(KAT_CIPHERTEXT_B64URL);
			expect(produced).toHaveLength(
				Buffer.byteLength(KAT_PLAINTEXT, 'utf8') + GCM_TAG_BYTES,
			);
		});

		it('node:crypto REJECTS a one-byte-flipped ciphertext — the tamper leg tests something real', () => {
			const contentKey = hmacHalf(CONTENT_LABEL);
			const nonce = Buffer.from(KAT_NONCE_B64URL, 'base64url');
			const sealed = Buffer.from(KAT_CIPHERTEXT_B64URL, 'base64url');

			const flipped = Buffer.from(sealed);
			flipped[0] = flipped[0]! ^ 0x01;

			const decipher = createDecipheriv('aes-256-gcm', contentKey, nonce);
			decipher.setAAD(Buffer.from(KAT_LOOKUP_ID, 'utf8'));
			decipher.setAuthTag(flipped.subarray(flipped.length - GCM_TAG_BYTES));
			expect(() => {
				decipher.update(flipped.subarray(0, flipped.length - GCM_TAG_BYTES));
				decipher.final();
			}).toThrow();
		});
	});

	// -------------------------------------------------------------------------
	// 3. No-leak canary (T-52-07-01)
	// -------------------------------------------------------------------------
	describe('no-leak canary over the proof source', () => {
		// Comment lines are filtered out FIRST so the module's own prose about
		// never logging the private half can neither satisfy nor invalidate the
		// check — the guard has to be about executable lines or it is theatre.
		function executableLines(): string[] {
			return readFileSync(PROOF_SOURCE_PATH, 'utf8')
				.split('\n')
				.filter(line => {
					const trimmed = line.trim();
					return (
						trimmed.length > 0 &&
						!trimmed.startsWith('*') &&
						!trimmed.startsWith('/*') &&
						!trimmed.startsWith('//')
					);
				});
		}

		it('has no executable line that logs the private key half', () => {
			const offenders = executableLines().filter(
				line => line.includes('console') && line.includes('contentKey'),
			);
			expect(offenders).toEqual([]);
		});

		it('the filter still sees the file — the canary is not vacuously empty', () => {
			const lines = executableLines();
			expect(lines.length).toBeGreaterThan(50);
			expect(lines.some(line => line.includes('console'))).toBe(true);
			expect(lines.some(line => line.includes('contentKey'))).toBe(true);
		});
	});
});
