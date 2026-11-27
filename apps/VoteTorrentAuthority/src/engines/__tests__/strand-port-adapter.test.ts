/**
 * Phase 62 Plan 21 (D-32): strand-port-adapter.ts — `createStrandPort` over a real Quereus
 * `Database` (plain `:param` binds) and over a fake db (the close-never-touches-db proof).
 */

import { Database } from '@quereus/quereus';
import { createStrandPort } from '../strand-port-adapter';
import type { StrandSqlDatabase } from '../strand-port-adapter';

// The real Quereus `Database`'s `eval`/`exec` param types are narrower than
// `StrandSqlDatabase`'s engine-agnostic `Record<string, unknown>` — the same structural-fit cast
// `engine-factory.ts`'s own `openStrand` closure makes at its call site.
function asStrandDb(db: Database): StrandSqlDatabase {
	return db as unknown as StrandSqlDatabase;
}

describe('createStrandPort (D-32)', () => {
	it('mutate + query round-trip plain :param binds against a real Quereus Database', async () => {
		const db = new Database();
		await db.exec('create table T (Id text primary key, N integer null)');
		const port = createStrandPort(asStrandDb(db));

		await port.mutate('insert into T (Id, N) values (:id, :n)', { id: 'a', n: 7 });
		const rows = await port.query<{ Id: string; N: number }>('select Id, N from T where Id = :id', { id: 'a' });

		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({ Id: 'a', N: 7 });
	});

	it('close() resolves without calling a fake db close/exec/eval', async () => {
		const fakeDb = { eval: jest.fn(), exec: jest.fn(), close: jest.fn() };
		const port = createStrandPort(fakeDb as never);

		await expect(port.close()).resolves.toBeUndefined();
		expect(fakeDb.close).not.toHaveBeenCalled();
		expect(fakeDb.exec).not.toHaveBeenCalled();
		expect(fakeDb.eval).not.toHaveBeenCalled();
	});

	it('after port.close() the real Quereus Database stays open — a direct db.eval still yields a row', async () => {
		const db = new Database();
		const port = createStrandPort(asStrandDb(db));
		await port.close();

		const rows: Array<{ one: number }> = [];
		for await (const row of db.eval('select 1 as one')) {
			rows.push(row as { one: number });
		}
		expect(rows).toEqual([{ one: 1 }]);
	});
});
