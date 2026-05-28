import { Database } from '@quereus/quereus';
import { expect } from 'chai';

/**
 * Quereus deferred CHECK datetime coercion — fixed in 3.3.0.
 *
 * Previously, deferred CHECK constraints (those containing subqueries)
 * saw `new.*` values BEFORE datetime type coercion, while stored column
 * values were post-coercion ISO text — equality comparisons failed.
 *
 * Confirmed broken in: 3.2.1
 * Confirmed fixed in:  3.3.0
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

	it('A3 — FIXED: deferred CHECK subquery sees coerced new.* matching stored value', async () => {
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

		await db.exec(`insert into Child values ('c1', 1700000000000)`);

		const row = await db.prepare('select Id from Child').get();
		expect(row?.Id).to.equal('c1');
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

	it('C1 — FIXED: votetorrent-shaped three-table cascade succeeds with numeric datetime values', async () => {
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

		await db.exec(`insert into Officer values ('auth1', ${now}, 'user1')`);

		const row = await db.prepare('select UserId from Officer').get();
		expect(row?.UserId).to.equal('user1');
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

	it('D1 — FIXED: single-batch exec() succeeds with datetime coercion', async () => {
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

		await db.exec(`
			insert into Parent values ('p1', ${ts});
			insert into Child values ('c1', ${ts});
		`);

		const row = await db.prepare('select Id from Child').get();
		expect(row?.Id).to.equal('c1');
	});
});
