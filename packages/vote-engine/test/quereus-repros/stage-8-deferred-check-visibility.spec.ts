import { Database, ConstraintError, QuereusError } from '@quereus/quereus';
import { expect } from 'chai';

/**
 * Quereus 3.2.1 bug repro — deferred CHECK constraint subqueries see
 * `new.*` column values BEFORE datetime type coercion, causing equality
 * comparisons against already-stored (coerced) values to fail.
 *
 * When a numeric timestamp (e.g. `Date.now()`) is inserted into a
 * `datetime` column, quereus coerces it to ISO text for storage
 * (e.g. `1700000000000` → `'2023-11-14T22:13:20+00:00[UTC]'`).
 * Immediate (non-subquery) CHECK constraints see the pre-coercion
 * value and pass. But auto-deferred CHECK constraints (those containing
 * subqueries) queue the row BEFORE coercion. When the deferred evaluator
 * later runs the subquery, `new.X` is the raw numeric while the stored
 * column value is the coerced text — they don't match.
 *
 * This was previously masked by issue #23 (CantDelete fires on INSERT,
 * fixed in v3.1.2). With that fix in place, code progresses past the
 * operation-mask bug and hits this coercion-timing mismatch.
 *
 * Upstream issue: (to be filed — deferred CHECK datetime coercion)
 *
 * Confirmed broken in: 3.2.1
 */
describe('Quereus repro — stage 8: deferred CHECK datetime coercion mismatch', () => {
	// ---------------------------------------------------------------
	// A — minimal reproduction: datetime coercion + deferred CHECK
	// ---------------------------------------------------------------

	it('A1 — CONTROL: numeric → datetime coercion stores as ISO text', async () => {
		const db = new Database();

		await db.exec(`
			create table T (Id text primary key, TS datetime);
		`);

		await db.exec(`insert into T values ('a', 1700000000000)`);

		const row = await db.prepare('select TS, typeof(TS) as t from T').get();
		expect(row?.t, 'datetime column should store as text').to.equal('text');
		expect(row?.TS, 'datetime column should coerce numeric to ISO string')
			.to.be.a('string')
			.and.to.include('2023');
	});

	it('A2 — CONTROL: non-subquery CHECK sees pre-coercion value and passes', async () => {
		const db = new Database();

		await db.exec(`
			create table T (
				Id text primary key,
				TS datetime,
				constraint TSIsNumber check (typeof(TS) = 'integer')
			);
		`);

		// Immediate CHECK evaluates BEFORE coercion → typeof is 'integer' → passes
		await db.exec(`insert into T values ('a', 1700000000000)`);

		const row = await db.prepare('select TS, typeof(TS) as t from T').get();
		// But storage is coerced to text
		expect(row?.t).to.equal('text');
	});

	it('A3 — BUG: deferred CHECK subquery compares pre-coercion new.* with post-coercion stored value', async () => {
		const db = new Database();

		await db.exec(`
			create table Parent (Id text, TS datetime, primary key (Id, TS));
			create table Child (
				Id text primary key,
				ParentTS datetime,
				constraint ParentExists check (
					exists (select 1 from Parent P where P.TS = new.ParentTS)
				)
			);
		`);

		// Parent.TS: 1700000000000 → stored as '2023-11-14T22:13:20+00:00[UTC]'
		await db.exec(`insert into Parent values ('p1', 1700000000000)`);

		// Child.ParentTS: 1700000000000 should coerce to the same ISO text,
		// but the deferred CHECK sees the raw numeric value for new.ParentTS.
		// Comparison: '2023-11-14T22:13:20+00:00[UTC]' = 1700000000000 → false
		let caught: unknown;
		try {
			await db.exec(`insert into Child values ('c1', 1700000000000)`);
		} catch (err) {
			caught = err;
		}

		// CURRENT BEHAVIOR (bug): throws QuereusError because deferred
		// evaluator sees raw numeric new.ParentTS vs coerced text Parent.TS.
		// The deferred queue throws QuereusError, not ConstraintError.
		expect(caught, 'deferred CHECK sees pre-coercion new.ParentTS').to.be.instanceOf(QuereusError);

		// EXPECTED BEHAVIOR (when fixed):
		// expect(caught, 'Child INSERT should succeed — Parent row exists with same timestamp').to.be.undefined;
		// const row = await db.prepare('select Id from Child').get();
		// expect(row?.Id).to.equal('c1');
	});

	it('A4 — CONTROL: same scenario passes when value already matches post-coercion form', async () => {
		const db = new Database();

		await db.exec(`
			create table Parent (Id text, TS datetime, primary key (Id, TS));
			create table Child (
				Id text primary key,
				ParentTS datetime,
				constraint ParentExists check (
					exists (select 1 from Parent P where P.TS = new.ParentTS)
				)
			);
		`);

		// Use the canonical post-coercion form — no coercion needed, so
		// the deferred CHECK's pre-coercion value matches the stored value.
		const canonical = '2023-11-14T22:13:20';
		await db.exec(`insert into Parent values ('p1', '${canonical}')`);

		await db.exec(`insert into Child values ('c1', '${canonical}')`);

		const row = await db.prepare('select Id from Child').get();
		expect(row?.Id).to.equal('c1');
	});

	// ---------------------------------------------------------------
	// B — text columns: no coercion, deferred CHECK works correctly
	// ---------------------------------------------------------------

	it('B1 — CONTROL: with text columns (no datetime coercion), deferred CHECK passes', async () => {
		const db = new Database();

		await db.exec(`
			create table Parent (Id text, TS text, primary key (Id, TS));
			create table Child (
				Id text primary key,
				ParentTS text,
				constraint ParentExists check (
					exists (select 1 from Parent P where P.TS = new.ParentTS)
				)
			);
		`);

		await db.exec(`insert into Parent values ('p1', 'some-timestamp')`);
		await db.exec(`insert into Child values ('c1', 'some-timestamp')`);

		const row = await db.prepare('select Id from Child').get();
		expect(row?.Id).to.equal('c1');
	});

	// ---------------------------------------------------------------
	// C — votetorrent shape: three-table cascade with numeric timestamps
	// ---------------------------------------------------------------

	it('C1 — BUG: votetorrent-shaped three-table cascade fails with numeric datetime values', async () => {
		const db = new Database();

		await db.exec(`
			create table Authority (Id text primary key, Name text);
			create table Admin (
				AuthorityId text,
				EffectiveAt datetime,
				primary key (AuthorityId, EffectiveAt),
				constraint AuthorityIdValid check (
					exists (select 1 from Authority A where A.Id = new.AuthorityId)
				)
			);
			create table Officer (
				AuthorityId text,
				AdminEffectiveAt datetime,
				UserId text,
				primary key (AuthorityId, AdminEffectiveAt, UserId),
				constraint AdminValid check (
					exists (select 1 from Admin A
							where A.AuthorityId = new.AuthorityId
							  and A.EffectiveAt = new.AdminEffectiveAt)
				)
			);
		`);

		const now = Date.now();

		await db.exec(`
			insert into Authority values ('auth1', 'Primary');
			insert into Admin (AuthorityId, EffectiveAt) values ('auth1', ${now});
		`);

		let caught: unknown;
		try {
			await db.exec(`insert into Officer values ('auth1', ${now}, 'user1')`);
		} catch (err) {
			caught = err;
		}

		// quereus 3.2.1: deferred CHECK subquery sees pre-coercion new.* (raw
		// numeric) while stored Admin.EffectiveAt is post-coercion ISO text —
		// equality fails, AdminValid fires. This bug repro is the reason the
		// engine code now pre-converts all datetime values to canonical ISO
		// form via toCanonicalDatetime() before INSERT (see utils.ts).
		expect(caught, 'Officer INSERT should fail — pre-coercion new.* vs post-coercion stored value mismatch').to.exist;
	});

	it('C2 — CONTROL: same three-table cascade passes with text columns', async () => {
		const db = new Database();

		await db.exec(`
			create table Authority (Id text primary key, Name text);
			create table Admin (
				AuthorityId text,
				EffectiveAt text,
				primary key (AuthorityId, EffectiveAt),
				constraint AuthorityIdValid check (
					exists (select 1 from Authority A where A.Id = new.AuthorityId)
				)
			);
			create table Officer (
				AuthorityId text,
				AdminEffectiveAt text,
				UserId text,
				primary key (AuthorityId, AdminEffectiveAt, UserId),
				constraint AdminValid check (
					exists (select 1 from Admin A
							where A.AuthorityId = new.AuthorityId
							  and A.EffectiveAt = new.AdminEffectiveAt)
				)
			);
		`);

		const now = String(Date.now());

		await db.exec(`
			insert into Authority values ('auth1', 'Primary');
			insert into Admin (AuthorityId, EffectiveAt) values ('auth1', '${now}');
		`);

		await db.exec(`insert into Officer values ('auth1', '${now}', 'user1')`);

		const row = await db.prepare('select UserId from Officer').get();
		expect(row?.UserId).to.equal('user1');
	});

	// ---------------------------------------------------------------
	// D — batch mode: same coercion mismatch in single exec() batch
	// ---------------------------------------------------------------

	it('D1 — BUG: single-batch exec() also fails with datetime coercion mismatch', async () => {
		const db = new Database();

		await db.exec(`
			create table Parent (Id text, TS datetime, primary key (Id, TS));
			create table Child (
				Id text primary key,
				ParentTS datetime,
				constraint ParentExists check (
					exists (select 1 from Parent P where P.TS = new.ParentTS)
				)
			);
		`);

		const ts = 1700000000000;

		let caught: unknown;
		try {
			await db.exec(`
				insert into Parent values ('p1', ${ts});
				insert into Child values ('c1', ${ts});
			`);
		} catch (err) {
			caught = err;
		}

		// CURRENT BEHAVIOR (bug): same coercion mismatch in batch mode.
		// The deferred queue throws QuereusError (not ConstraintError).
		expect(caught, 'batch INSERT fails due to datetime coercion mismatch').to.be.instanceOf(QuereusError);

		// EXPECTED BEHAVIOR (when fixed):
		// expect(caught, 'batch INSERT should succeed').to.be.undefined;
	});
});
