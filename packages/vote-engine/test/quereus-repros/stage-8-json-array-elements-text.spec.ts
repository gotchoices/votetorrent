import { Database } from '@quereus/quereus';
import { expect } from 'chai';

/**
 * Quereus 2.x bug repro — Stage 8
 *
 * `json_array_elements_text/1` is a phantom function in Quereus 2.x:
 * referencing it produces a "Function not found" error at prepare/exec time.
 *
 * The VoteTorrent schema uses it for set-unfolding JSON arrays of strings
 * inside CHECK constraints (Officer.ScopesValid:
 *   `select 1 from json_array_elements_text(Scopes) S(s) where s not in (select Code from Scope)`).
 *
 * "Phantom" because the function appears to be Postgres-isms imported into
 * the schema-author mental model but never registered in Quereus core.
 * Quereus 2.x ships `json_each` and `json_extract` (per the SQL docs at
 * /home/risavkarna/Documents/quereus/docs/sql.md), so the schema-side
 * fix is a sweep to use those instead. The upstream conversation is:
 * either register `json_array_elements_text` as an alias for `json_each`'s
 * value column, or document the canonical equivalent.
 *
 * Test asserts the buggy/observed behavior so it PASSES today.
 */
describe('Quereus repro — stage 8: `json_array_elements_text/1` phantom function', () => {
	it('references to json_array_elements_text/1 throw "Function not found"', async () => {
		const db = new Database();

		let caught: unknown;
		try {
			// Plainest possible invocation — no schema, no CHECK eval, no
			// joins. Just the bare function call to isolate the issue.
			await db.exec(`select 1 from json_array_elements_text('["a","b"]') S(s)`);
		} catch (err) {
			caught = err;
		}

		expect(caught, 'reference to json_array_elements_text should throw').to.be.instanceOf(Error);
		const msg = (caught as Error).message;
		// Match the observed error shape from Plan 03-05 probe:
		//   "Function not found: json_array_elements_text/1"
		expect(msg).to.match(
			/Function not found.*json_array_elements_text/i,
			`expected "Function not found: json_array_elements_text/1"-shaped error, got: ${msg}`
		);
	});

	it('control: `json_each` IS registered and works for set-unfolding JSON arrays', async () => {
		// Establishes that the schema-side fix exists: callers can rewrite
		// `from json_array_elements_text(X) S(s)` as `from json_each(X)` and
		// project `value`. This control test will start failing if json_each
		// is removed or renamed upstream, which is information the maintainer
		// will want.
		const db = new Database();

		const rows: unknown[] = [];
		for await (const row of db.eval(`select value from json_each('["a","b","c"]')`)) {
			rows.push(row['value']);
		}
		expect(rows, `json_each must enumerate JSON array elements`).to.deep.equal(['a', 'b', 'c']);
	});
});
