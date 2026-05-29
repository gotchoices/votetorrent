import { Database, ConstraintError } from '@quereus/quereus';
import { expect } from 'chai';

/**
 * Quereus 3.x bug repro — `primary key ()` (zero-column PK) enforces
 * UNIQUE across all rows.
 *
 * A table declared with `primary key ()` (an empty column list) treats
 * the empty PK as a globally unique constraint. The first INSERT
 * succeeds; every subsequent INSERT — regardless of column values —
 * fails with `UNIQUE constraint failed: <table> PK`.
 *
 * Expected behavior: a zero-column PK denotes "no primary key" (or, if
 * one prefers, "the empty key is shared by all rows"). Either way it
 * should NOT generate a UNIQUE violation for distinct rows. SQLite and
 * PostgreSQL both allow tables without a primary key; Quereus accepts
 * the `primary key ()` syntax but then mis-enforces it.
 *
 * Production impact (VoteTorrent): the workaround in this codebase has
 * been to add a synthetic discriminator column to the PK (see
 * Phase 12.3 — ProposedNetwork.Revision was added to the composite PK
 * so multiple proposed revisions per network can coexist).
 *
 * Sub-tests:
 *   Z1 — CONTROL: omitting the `primary key ()` clause entirely accepts
 *        multiple INSERTs.
 *   Z2 — BROKEN: `primary key ()` rejects the second INSERT with a
 *        UNIQUE-constraint error, even when every column differs.
 *   Z3 — CONTROL: a single-column PK accepts distinct rows (sanity).
 *   Z4 — WORKAROUND: adding any column to the PK (`primary key (Id)`)
 *        restores correct behavior.
 *
 * When upstream ships a fix, invert Z2's assertion and rename it
 * `Z2 — FIXED`.
 */
describe('Quereus repro — `primary key ()` zero-column PK enforces global UNIQUE', () => {
	it('Z1 — CONTROL: a table with no `primary key` clause accepts multiple rows', async () => {
		const db = new Database();

		await db.exec(`
			declare schema main
			{
				table T (
					Id int,
					Color text
				);
			}
			apply schema main;
		`);

		await db.exec(`insert into T (Id, Color) values (1, 'r')`);
		await db.exec(`insert into T (Id, Color) values (2, 'g')`);

		let n = 0;
		for await (const _row of db.eval(`select Id from T`)) n++;
		expect(n, 'no-PK table should hold 2 distinct rows').to.equal(2);
	});

	it('Z2 — BROKEN: `primary key ()` rejects the 2nd INSERT with UNIQUE constraint failed: T PK', async () => {
		const db = new Database();

		await db.exec(`
			declare schema main
			{
				table T (
					Id int,
					Color text,
					primary key ()
				);
			}
			apply schema main;
		`);

		await db.exec(`insert into T (Id, Color) values (1, 'r')`);

		let caught: unknown;
		try {
			await db.exec(`insert into T (Id, Color) values (2, 'g')`);
		} catch (err) {
			caught = err;
		}

		expect(caught, 'second INSERT against `primary key ()` should fail (pinning observed behavior)')
			.to.be.instanceOf(ConstraintError);
		expect((caught as Error).message)
			.to.match(/UNIQUE constraint failed.*\bT\b/i);
	});

	it('Z3 — CONTROL: single-column PK accepts distinct rows', async () => {
		const db = new Database();

		await db.exec(`
			declare schema main
			{
				table T (
					Id int,
					Color text,
					primary key (Id)
				);
			}
			apply schema main;
		`);

		await db.exec(`insert into T (Id, Color) values (1, 'r')`);
		await db.exec(`insert into T (Id, Color) values (2, 'g')`);

		let n = 0;
		for await (const _row of db.eval(`select Id from T`)) n++;
		expect(n, 'single-column PK with distinct keys should hold 2 rows').to.equal(2);
	});

	it('Z4 — WORKAROUND: adding any column to the PK restores correct behavior', async () => {
		// Mirrors VoteTorrent's Phase 12.3 fix for ProposedNetwork:
		// added a Revision discriminator to the composite PK so multiple
		// proposed revisions per network coexist instead of colliding on
		// the empty key.
		const db = new Database();

		await db.exec(`
			declare schema main
			{
				table T (
					Id int,
					Revision int,
					Color text,
					primary key (Revision)
				);
			}
			apply schema main;
		`);

		await db.exec(`insert into T (Id, Revision, Color) values (1, 1, 'r')`);
		await db.exec(`insert into T (Id, Revision, Color) values (1, 2, 'g')`);

		let n = 0;
		for await (const _row of db.eval(`select Id from T`)) n++;
		expect(n, 'composite PK with a discriminator column should hold 2 rows').to.equal(2);
	});
});
