import { Database } from '@quereus/quereus';
import { expect } from 'chai';
import { prepareDb } from '../src/database/initialize';

/**
 * Schema-load gate test for SCHEMA-13 and SCHEMA-14.
 *
 * Per Phase 1 / Plan 01-07 decisions:
 *  - D-08: this is a NEW file (basics.spec.ts is not modified).
 *  - D-09: assert initDB(db) does not throw, and that each of the 8 core
 *    tables is queryable via `select 1 from <T> limit 0`.
 *  - D-10: assert each of the 6 custom functions is callable (no throw).
 *    SignatureValid may return false; absence-of-throw is the assertion.
 */
describe('Schema load', () => {
	it('loads the production schema via initDB and exposes all core tables', async () => {
		const db = new Database();
		await prepareDb(db);

		// D-09 (2): each of the 8 core tables must be queryable.
		// `select 1 from <T> limit 0` parses the FROM clause without returning
		// rows; a missing table surfaces as a throw from prepare()/all() or
		// while iterating the resulting async stream. Under quereus 0.12,
		// `.all()` returns an `AsyncIterable<Record<...>>`; draining it to
		// completion is what actually exercises the FROM clause.
		// SQL strings are written verbatim (one per table) to keep the failure
		// mode diagnostic — a regression points at the exact table that broke.
		const drain = async (
			stream: AsyncIterable<Record<string, unknown>>
		): Promise<number> => {
			let count = 0;
			for await (const _ of stream) count++;
			return count;
		};

		const network = await drain(db.prepare('select 1 from Network limit 0').all());
		expect(network, 'table Network should be queryable').to.equal(0);

		const authority = await drain(db.prepare('select 1 from Authority limit 0').all());
		expect(authority, 'table Authority should be queryable').to.equal(0);

		const admin = await drain(db.prepare('select 1 from Admin limit 0').all());
		expect(admin, 'table Admin should be queryable').to.equal(0);

		const officer = await drain(db.prepare('select 1 from Officer limit 0').all());
		expect(officer, 'table Officer should be queryable').to.equal(0);

		const election = await drain(db.prepare('select 1 from Election limit 0').all());
		expect(election, 'table Election should be queryable').to.equal(0);

		const task = await drain(db.prepare('select 1 from Task limit 0').all());
		expect(task, 'table Task should be queryable').to.equal(0);

		const inviteSlot = await drain(db.prepare('select 1 from InviteSlot limit 0').all());
		expect(inviteSlot, 'table InviteSlot should be queryable').to.equal(0);

		const user = await drain(db.prepare('select 1 from User limit 0').all());
		expect(user, 'table User should be queryable').to.equal(0);
	});

	it('registers crypto-plugin SQL functions and exposes quereus builtins used by the schema', async () => {
		const db = new Database();
		await prepareDb(db);

		// D-10: each callable function is exercised individually; absence of
		// throw is the primary assertion.
		//
		// Scope (post quereus 0.12 → 2.x migration):
		//
		// - quereus 2.x builtins used by the schema: `isISODatetime`, `like`.
		// - @optimystic/quereus-plugin-crypto SQL surface (5 functions):
		//   `digest`, `sign`, `verify`, `hash_mod`, `random_bytes`. These are
		//   the only SQL functions registered by the plugin; case-insensitive
		//   resolution maps schema-level `Digest(...)` → `digest(...)`.
		//
		// Intentionally NOT covered here:
		// - JS-only helpers exported by the plugin (`Digest`, `DigestAll`,
		//   `Sign`, `SignatureValid`). They are not part of the SQL surface
		//   and must not be invoked via `select <name>(...)`.
		// - `H16` — a JS-only utility; schema references at votetorrent.qsql
		//   lines 8 and 19 are documentation/TODO comments, not SQL calls.

		// quereus 2.x returns BOOLEAN as native true/false (0.12 returned 1/0).
		const iso = await db
			.prepare(`select isISODatetime('2024-01-01T00:00:00Z') as v`)
			.get();
		expect(iso!['v']).to.equal(true);

		const likeMatch = await db
			.prepare(`select like('%Z', '2024-01-01T00:00:00Z') as v`)
			.get();
		expect(likeMatch!['v']).to.satisfy((v: unknown) => v === true || v === 1);

		// Crypto plugin: signature is (data, algorithm?, inputEncoding?, outputEncoding?).
		// Inputs default to base64url; 'dGVzdA' is base64url for 'test'.
		const digest = await db
			.prepare(`select digest('dGVzdA') as v`)
			.get();
		expect(digest!['v']).to.be.a('string');

		// hash_mod(data, bits): returns INTEGER < 2^bits.
		const hm = await db
			.prepare(`select hash_mod('dGVzdA', 16) as v`)
			.get();
		expect(hm!['v']).to.be.a('number');

		// random_bytes(bits?, encoding?): returns TEXT.
		const rb = await db.prepare(`select random_bytes(64) as v`).get();
		expect(rb!['v']).to.be.a('string');
	});

	it('binds caller-supplied now via with context for time-bounded CHECK constraints', async () => {
		// SCHEMA-15 / G-01 witness: prove that the `with context now = ...`
		// binding round-trips through the planner and that the ExpirationFuture
		// CHECK on UserKey now references `context.now` (not `datetime('now')`)
		// without firing the SchemaManager.validateCheckConstraintDeterminism
		// rejection.
		//
		// We `prepare()` an INSERT into UserKey that supplies `with context now`;
		// planner success witnesses that (a) the CHECK body parses, (b) the
		// context-var is declared on the table, and (c) the determinism validator
		// is satisfied. We do NOT execute the INSERT — full bootstrap requires
		// the crypto plugin's view-column resolution path, which is independent
		// of G-01.
		const db = new Database();
		await prepareDb(db);

		let prepareError: Error | undefined;
		try {
			const stmt = db.prepare(
				`insert into UserKey (UserId, Type, PubKey, Expiration)
				with context now = datetime('now'), IsSignatureValid = true
				values (:userId, :keyType, :keyValue, :expiration)`
			);
			// finalize() if the API exposes it; otherwise letting it GC is fine
			// — we only needed the prepare path to succeed.
			void stmt;
		} catch (err) {
			prepareError = err instanceof Error ? err : new Error(String(err));
		}

		if (prepareError) {
			const msg = prepareError.message;
			if (msg.includes('validateCheckConstraintDeterminism')) {
				throw new Error(
					`SCHEMA-15 regression: determinism validator fired despite context.now rewrites: ${msg}`
				);
			}
			throw new Error(`with-context UserKey insert failed to prepare: ${msg}`);
		}

		expect(
			prepareError,
			'UserKey insert with `with context now = datetime(\'now\')` must prepare cleanly under quereus 2.x'
		).to.be.undefined;
	});
});
