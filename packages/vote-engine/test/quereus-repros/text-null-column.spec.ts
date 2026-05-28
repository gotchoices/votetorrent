import { Database, ConstraintError } from '@quereus/quereus';
import { expect } from 'chai';

/**
 * Quereus regression repro — explicit NULL binding against a column with
 * a non-NULL `default` value.
 *
 * Bug: a column declared with a non-NULL default (e.g. `text default 'X'`,
 * `boolean default true`) treats an explicit NULL binding — whether via
 * `:param` or a SQL `null` literal — as a NOT NULL constraint violation,
 * even though the column is not declared `not null`. Omitting the column
 * from the INSERT column list correctly applies the default; only
 * **explicitly** writing null fails. The error message can also name an
 * unrelated nullable sibling column in the same row, which makes the bug
 * hard to diagnose (see D3).
 *
 * Confirmed in Quereus **3.3.0** (current pin); also reproduced in 3.1.2.
 *
 * The spec passes today by asserting the observed broken behavior. When
 * upstream ships a fix, invert D1/D2/D3 to assert success and update the
 * D3 error-message assertion.
 */
describe('Quereus repro — explicit NULL against `default X` column', () => {
	// ---------------------------------------------------------------
	// Confirmed-broken cases — these pass today by asserting the
	// observed (incorrect) behavior. Invert when upstream ships a fix.
	// ---------------------------------------------------------------

	it('D1 — BROKEN: bound `:param=null` against `text default X` throws NOT NULL', async () => {
		const db = new Database();
		await db.exec(`
			declare schema main
			{
				table Q (
					Id text primary key,
					Mid text default 'X'
				);
			}
			apply schema main;
		`);
		let caught: unknown;
		try {
			await db.exec(
				`insert into Q (Id, Mid) values (:id, :mid)`,
				{ id: '1', mid: null }
			);
		} catch (err) {
			caught = err;
		}
		expect(caught, 'binding null to a default-bearing column should be accepted but currently throws').to.be.instanceOf(ConstraintError);
	});

	it('D2 — BROKEN: SQL `null` literal against `text default X` throws NOT NULL', async () => {
		const db = new Database();
		await db.exec(`
			declare schema main
			{
				table Q (
					Id text primary key,
					Mid text default 'X'
				);
			}
			apply schema main;
		`);
		let caught: unknown;
		try {
			await db.exec(`insert into Q (Id, Mid) values ('1', null)`);
		} catch (err) {
			caught = err;
		}
		expect(caught, 'SQL null literal against a default-bearing column should be accepted but currently throws').to.be.instanceOf(ConstraintError);
	});

	it('D3 — BROKEN: misleading column name when sibling `text null` precedes the default-bearing column', async () => {
		// Mirrors the real-world ProposedQuestion scenario: DependsOn (`text null`)
		// is bound to null AND OptionRange (`text default '{1,1}'`) is bound to null.
		// The thrown error names the offending column as a sibling and not the
		// default-bearing one, which is what produced the original 12.3-08
		// misdiagnosis (`NOT NULL constraint failed: ProposedQuestion.DependsOn`).
		const db = new Database();
		await db.exec(`
			declare schema main
			{
				table Q (
					Id text primary key,
					A text null,
					Mid text default 'X',
					B text null
				);
			}
			apply schema main;
		`);
		let caught: ConstraintError | undefined;
		try {
			await db.exec(
				`insert into Q (Id, A, Mid, B) values (:id, :a, :mid, :b)`,
				{ id: '1', a: null, mid: null, b: null }
			);
		} catch (err) {
			caught = err as ConstraintError;
		}
		expect(caught, 'expected a NOT NULL constraint violation').to.be.instanceOf(ConstraintError);
		// Document the actual error message verbatim — useful when the upstream
		// fix lands and we need to verify the error message changed (or vanished).
		expect(caught?.message, 'documenting observed error message').to.match(/NOT NULL constraint failed: Q\.(A|Mid|B)/);
	});

	// ---------------------------------------------------------------
	// Working cases — defaults + nulls behave correctly when nulls
	// aren't explicit. These guard against regression on the right
	// side of the bug.
	// ---------------------------------------------------------------

	it('D4 — WORKS: omitting a `text default X` column from the column list applies the default', async () => {
		const db = new Database();
		await db.exec(`
			declare schema main
			{
				table Q (
					Id text primary key,
					Mid text default 'X'
				);
			}
			apply schema main;
		`);
		await db.exec(`insert into Q (Id) values ('1')`);
		const row = await db.prepare(`select Mid from Q where Id = '1'`).get();
		expect(row?.Mid).to.equal('X');
	});

	it('D5 — WORKS: `text null` columns accept null via every path (omit, literal, param)', async () => {
		// Pinned as a sanity contrast: this is the column type that the original
		// 12.3-08 diagnosis blamed. It works correctly; the bug is on default-bearing
		// siblings, not on `text null`.
		const db = new Database();
		await db.exec(`
			declare schema main
			{
				table Q (
					Id text primary key,
					A text null,
					B text null,
					C text null
				);
			}
			apply schema main;
		`);
		await db.exec(`insert into Q (Id) values ('omit')`);
		await db.exec(`insert into Q (Id, A, B, C) values ('lit', null, null, null)`);
		await db.exec(
			`insert into Q (Id, A, B, C) values (:id, :a, :b, :c)`,
			{ id: 'param', a: null, b: null, c: null }
		);
		const rows: Array<{ Id: string; A: string | null; B: string | null; C: string | null }> = [];
		for await (const r of db.eval(`select Id, A, B, C from Q order by Id`)) {
			rows.push(r as { Id: string; A: string | null; B: string | null; C: string | null });
		}
		expect(rows.map(r => r.Id)).to.deep.equal(['lit', 'omit', 'param']);
		for (const r of rows) {
			expect(r.A).to.equal(null);
			expect(r.B).to.equal(null);
			expect(r.C).to.equal(null);
		}
	});

	it('D6 — control: `text not null` still rejects an omitted column', async () => {
		const db = new Database();
		await db.exec(`
			declare schema main
			{
				table Q (
					Id text primary key,
					DependsOn text not null
				);
			}
			apply schema main;
		`);
		let caught: unknown;
		try {
			await db.exec(`insert into Q (Id) values ('q1')`);
		} catch (err) {
			caught = err;
		}
		expect(caught, 'INSERT omitting a NOT NULL column should throw').to.be.instanceOf(ConstraintError);
	});
});
