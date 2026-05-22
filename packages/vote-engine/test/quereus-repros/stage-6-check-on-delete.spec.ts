import { Database, ConstraintError } from '@quereus/quereus';
import { expect } from 'chai';

/**
 * Quereus 2.x bug repro — Stage 6
 *
 * `constraint X check on delete (expr)` fires on INSERT (and other ops),
 * not just DELETE as the syntax declares.
 *
 * Expected behavior: the `on delete` modifier scopes the CHECK to DELETE
 * ops only; INSERT should not evaluate `expr`.
 *
 * Observed behavior (Quereus 2.9.0): INSERT trips the constraint with
 * `CHECK constraint failed: X`. Discovered during the VoteTorrent
 * engine-insert-path probe (Plan 03-05); the production schema declares
 * `constraint CantDelete check on delete (false)` on 16 tables, of which
 * 4 actively block insert paths.
 *
 * Test asserts the buggy behavior so the test PASSES today. Once upstream
 * ships a fix, this test will fail — at which point the assertion should
 * be inverted (assert INSERT succeeds) and the schema's `on delete`
 * markers can be re-enabled without workarounds.
 *
 * Root cause hypothesis: parser correctly captures `operations: ['delete']`
 * in the AST (verified at dist/src/parser/parser.js:3261/3361); the schema
 * manager converts to bitmask `RowOpFlag.DELETE = 4`; the bug is downstream
 * in `shouldCheckConstraint` or its callers — INSERT-path eval is not
 * filtering by op mask correctly.
 */
describe('Quereus repro — stage 6: `check on delete` fires on INSERT', () => {
	it('INSERT trips a `check on delete (false)` constraint (BUG)', async () => {
		const db = new Database();

		// Minimal schema: one table, one `check on delete (false)` constraint.
		// No views, no plugins, no other constraints.
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

		let caught: unknown;
		try {
			await db.exec(`insert into T (Id) values (1)`);
		} catch (err) {
			caught = err;
		}

		// Assert the buggy behavior: INSERT throws a CHECK violation that
		// names the `on delete`-scoped constraint.
		expect(caught, 'INSERT should throw under Quereus 2.9.0 (bug)').to.be.instanceOf(Error);
		const msg = (caught as Error).message;
		expect(msg).to.match(
			/CHECK constraint failed.*NoDeleteEver|NoDeleteEver.*CHECK constraint/i,
			`expected CHECK violation naming NoDeleteEver, got: ${msg}`
		);

		// Sanity: this is a ConstraintError, not a parse/type error.
		expect(caught).to.be.instanceOf(ConstraintError);
	});

	it('semantic equivalence: `check on delete (1 = 0)` also fires on INSERT (rules out literal-false handling)', async () => {
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

		let caught: unknown;
		try {
			await db.exec(`insert into U (Id) values (1)`);
		} catch (err) {
			caught = err;
		}

		// Same shape failure as above; confirms the bug is the `on delete`
		// modifier being ignored, not a special case of the literal `false`.
		expect(caught, 'INSERT should throw under Quereus 2.9.0 (bug)').to.be.instanceOf(ConstraintError);
		const msg = (caught as Error).message;
		expect(msg).to.match(
			/CHECK constraint failed.*NoDeleteEither|NoDeleteEither.*CHECK constraint/i,
			`expected CHECK violation naming NoDeleteEither, got: ${msg}`
		);
	});
});
