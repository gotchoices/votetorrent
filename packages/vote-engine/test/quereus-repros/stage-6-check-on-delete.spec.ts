import { Database, ConstraintError } from '@quereus/quereus';
import { expect } from 'chai';

/**
 * Quereus stage 6 — `check on delete` scoping verification.
 * Upstream fix: https://github.com/gotchoices/quereus/issues/23 (resolved in 3.x)
 *
 * `constraint X check on delete (expr)` must fire only on DELETE, not INSERT.
 * Previously (Quereus 2.9.0) INSERT would trip the constraint — that bug is
 * now fixed. These tests confirm correct behavior.
 */
describe('Quereus — stage 6: `check on delete` correctly scoped to DELETE only', () => {
	it('INSERT succeeds with `check on delete (false)` — constraint not evaluated on INSERT', async () => {
		const db = new Database();

		await db.exec(`
			declare schema main

			{
				table T (
					Id int,
					primary key (),
					constraint NoDeleteEver check on delete (false)
				);
			}

			apply schema main;
		`);

		await db.exec(`insert into T (Id) values (1)`);
		const row = await db.prepare('select Id from T where Id = 1').get();
		expect(row?.Id).to.equal(1);
	});

	it('INSERT succeeds with `check on delete (1 = 0)` — not a literal-false special case', async () => {
		const db = new Database();

		await db.exec(`
			declare schema main

			{
				table U (
					Id int,
					primary key (),
					constraint NoDeleteEither check on delete (1 = 0)
				);
			}

			apply schema main;
		`);

		await db.exec(`insert into U (Id) values (1)`);
		const row = await db.prepare('select Id from U where Id = 1').get();
		expect(row?.Id).to.equal(1);
	});

	it('DELETE is blocked by `check on delete (false)`', async () => {
		const db = new Database();

		await db.exec(`
			declare schema main

			{
				table V (
					Id int,
					primary key (),
					constraint NoDel check on delete (false)
				);
			}

			apply schema main;
		`);

		await db.exec(`insert into V (Id) values (1)`);

		let caught: unknown;
		try {
			await db.exec(`delete from V where Id = 1`);
		} catch (err) {
			caught = err;
		}
		expect(caught).to.be.instanceOf(ConstraintError);
	});
});
