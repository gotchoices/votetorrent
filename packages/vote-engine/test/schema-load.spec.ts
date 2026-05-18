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

	it('registers all six custom functions from the crypto plugin', async () => {
		const db = new Database();
		await prepareDb(db);

		// D-10: each custom function called individually; absence of throw is
		// the primary assertion. Specific value assertions follow PATTERNS.md §1.

		const h16 = await db.prepare(`select H16('test') as v`).get();
		expect(h16!['v']).to.be.a('string');

		const iso = await db
			.prepare(`select isISODatetime('2024-01-01T00:00:00Z') as v`)
			.get();
		expect(iso!['v']).to.equal(1);

		const ends = await db
			.prepare(`select endswith('foo.bar', '.bar') as v`)
			.get();
		expect(ends!['v']).to.equal(1);

		const digest = await db.prepare(`select Digest('a', 'b') as v`).get();
		expect(digest!['v']).to.be.a('string');

		const digestAll = await db.prepare(`select DigestAll('a') as v`).get();
		expect(digestAll!['v']).to.be.a('string');

		// SignatureValid may return false per D-10; we only assert the call
		// did not throw and produced a row.
		const sigValid = await db
			.prepare(`select SignatureValid('digest', 'sig', 'key') as v`)
			.get();
		expect(sigValid).to.exist;
	});
});
