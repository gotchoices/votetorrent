import { Database, ConstraintError } from '@quereus/quereus';
import { expect } from 'chai';

/**
 * Quereus 2.x bug repros — what Plan 03-05 catalogued as "stage 7" turned
 * out to be TWO independent bugs once isolated. This file demonstrates both;
 * the README directs each as a separate upstream issue.
 *
 * Bug A — VIEW row-loss with `union all`
 * --------------------------------------
 * A view defined as `select … union all select …` returns ONLY THE FIRST
 * ROW when queried, even though the same `union all` chain inline returns
 * every row. This is the actual root cause of what Plan 03-05 called
 * "stage 3" (derived-column-alias view resolution at CHECK eval) — the
 * earlier view rewrite at commit 7ba9354 didn't actually fix anything;
 * it just changed the shape. ElectionTypeValid only ever "passed" for
 * ElectionType = 'o' (the first row); inserts with 'a' would always
 * fail because the view exposes only 'o'.
 *
 * Bug B — `NOT IN (subquery)` always-false in CHECK
 * --------------------------------------------------
 * `X not in (subquery)` in a CHECK constraint always evaluates as false,
 * regardless of whether X actually appears in the subquery results.
 * The same expression evaluates correctly in a `select` context.
 * The internal error message rewrites the expression as
 * `not (X in (subquery))`, suggesting an early de-sugaring path that
 * leaves the resulting `not (...)` evaluating to NULL.
 *
 * Stage 7's original claim — that `X IN (subquery)` itself misbehaves
 * in CHECK contexts — is REFUTED: with a real TABLE as the subquery
 * target (not a view), IN works correctly. The stage 7 IN failure
 * Plan 03-05 saw was a downstream consequence of Bug A (view
 * returning only the first row).
 */
describe('Quereus repro — stage 7 split (Bug A: view union-all, Bug B: not-in CHECK)', () => {
	// ---------------------------------------------------------------
	// Bug A — VIEW row-loss with `union all`
	// ---------------------------------------------------------------

	it('A1 — CONTROL: inline `select … union all select …` returns all rows', async () => {
		const db = new Database();
		let n = 0;
		for await (const _row of db.eval(`
			select 'r' as Code union all
			select 'g' as Code union all
			select 'b' as Code
		`)) {
			n++;
		}
		expect(n, 'inline union-all chain must return all 3 rows').to.equal(3);
	});

	it('A2 — BUG: same `union all` chain inside a VIEW returns only 1 row', async () => {
		const db = new Database();

		await db.exec(`
			declare schema main

			{
				view V as
					select 'r' as Code, 'Red' as Name
					union all select 'g' as Code, 'Green' as Name
					union all select 'b' as Code, 'Blue' as Name;
			}

			apply schema main;
		`);

		const seen: string[] = [];
		for await (const row of db.eval(`select Code from V`)) {
			seen.push(row['Code'] as string);
		}

		// Buggy behavior: only the first leg of the union all is returned.
		expect(seen, `expected 1 row (BUG); 3 would be correct.`).to.deep.equal(['r']);
	});

	it('A3 — downstream symptom: CHECK against view incorrectly rejects values past the first row', async () => {
		// This was originally catalogued as a separate IN-subquery bug (Plan 03-05 stage 7).
		// It is in fact a downstream effect of Bug A: the view exposes only 'r', so
		// inserting Color='g' correctly fails the `IN (select Code from V)` check
		// against the (buggy) one-row view. Fixing Bug A also fixes this symptom.
		const db = new Database();

		await db.exec(`
			declare schema main

			{
				view V as
					select 'r' as Code, 'Red' as Name
					union all select 'g' as Code, 'Green' as Name;

				table T (
					Id int,
					Color text,
					primary key (),
					constraint VC check (Color in (select Code from V))
				);
			}

			apply schema main;
		`);

		// Color = 'r' (first view row) succeeds — masks the view bug for that value.
		await db.exec(`insert into T (Id, Color) values (1, 'r')`);

		// Color = 'g' (second view row) fails — observed CHECK violation is the
		// downstream symptom of Bug A.
		let caught: unknown;
		try {
			await db.exec(`insert into T (Id, Color) values (2, 'g')`);
		} catch (err) {
			caught = err;
		}
		expect(caught, "INSERT 'g' should throw under Quereus 2.9.0 (downstream of Bug A)").to.be.instanceOf(ConstraintError);
	});

	// ---------------------------------------------------------------
	// Bug B — `NOT IN (subquery)` always-false in CHECK
	// ---------------------------------------------------------------

	it('B1 — CONTROL: `X not in (subquery)` evaluates correctly in SELECT context', async () => {
		const db = new Database();

		await db.exec(`
			declare schema main
			{ table Block ( Code text primary key ); }
			apply schema main;
		`);
		await db.exec(`insert into Block (Code) values ('r')`);
		await db.exec(`insert into Block (Code) values ('y')`);

		const r1 = await db.prepare(`select ('g' not in (select Code from Block)) as v`).get();
		expect(r1?.['v'], "'g' not in blocklist {r, y} should be true").to.equal(true);

		const r2 = await db.prepare(`select ('r' not in (select Code from Block)) as v`).get();
		expect(r2?.['v'], "'r' not in blocklist {r, y} should be false").to.equal(false);
	});

	it('B2 — BUG: `X not in (subquery)` in CHECK rejects values that are NOT in the subquery', async () => {
		const db = new Database();

		await db.exec(`
			declare schema main

			{
				table Block ( Code text primary key );

				table T (
					Id int,
					Color text,
					primary key (),
					constraint NB check (Color not in (select Code from Block))
				);
			}

			apply schema main;
		`);
		await db.exec(`insert into Block (Code) values ('r')`);
		await db.exec(`insert into Block (Code) values ('y')`);

		// 'g' is NOT in the blocklist {r, y} — under correct semantics, INSERT succeeds.
		// Under the bug, the CHECK evaluates as false and INSERT throws.
		let caught: unknown;
		try {
			await db.exec(`insert into T (Id, Color) values (1, 'g')`);
		} catch (err) {
			caught = err;
		}

		expect(caught, 'INSERT should throw under Quereus 2.9.0 (bug)').to.be.instanceOf(ConstraintError);
		const msg = (caught as Error).message;
		// The error message rewrites the expression as `not Color in (...)`,
		// hinting at an early de-sugaring of `not in` that leaves the resulting
		// `not (...)` evaluating to NULL when the inner IN doesn't yield a clean boolean.
		expect(msg).to.match(/not Color in|NB/i, `expected CHECK violation naming NB, got: ${msg}`);
	});

	it('B3 — control: IN-subquery in CHECK works correctly against a TABLE', async () => {
		// Stage 7's original "IN (subquery) is broken in CHECK" claim refuted.
		// With a real TABLE as the subquery target (not a buggy view), IN works.
		const db = new Database();

		await db.exec(`
			declare schema main

			{
				table Allow ( Code text primary key );

				table T (
					Id int,
					Color text,
					primary key (),
					constraint AC check (Color in (select Code from Allow))
				);
			}

			apply schema main;
		`);
		await db.exec(`insert into Allow (Code) values ('r')`);
		await db.exec(`insert into Allow (Code) values ('g')`);

		await db.exec(`insert into T (Id, Color) values (1, 'g')`);
		const row = await db.prepare(`select Id, Color from T where Id = 1`).get();
		expect(row?.['Color']).to.equal('g');

		let caught: unknown;
		try {
			await db.exec(`insert into T (Id, Color) values (3, 'zzz')`);
		} catch (err) {
			caught = err;
		}
		expect(caught, "INSERT of disallowed value should throw").to.be.instanceOf(ConstraintError);
	});
});
