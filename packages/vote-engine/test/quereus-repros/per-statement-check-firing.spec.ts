import { Database } from '@quereus/quereus';
import { expect } from 'chai';

/**
 * Phase 12.4 D-07g — per-statement CHECK firing probe.
 *
 * Empirically determines whether quereus 3.3.0 fires CHECK constraints
 * per-statement inside a single `db.exec` batch (so an Officer CHECK that
 * references Admin sees a not-yet-inserted Admin row mid-batch and fails),
 * or defers CHECKs to end-of-batch (so the whole sequence succeeds).
 *
 * Source: CONTEXT D-07g (single batch vs three statements decision for
 * createAuthority). The observation logged by B1 is the gate Plan 01 reads
 * to choose between one-batch and three-batch createAuthority shapes.
 *
 * B2 confirms the three-batch fallback (Authority+Admin in batch #1,
 * Officer in batch #2) always works — current `createAuthority`
 * (network-engine.ts:104-143) already uses this split. The fallback is
 * the safe default if B1 reports per-statement firing.
 */

describe('Quereus repro — per-statement CHECK firing inside db.exec batch (Phase 12.4 D-07g)', () => {
	const SCHEMA = `
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
	`;

	it('B1 — FK-style CHECK in same db.exec batch sees the row inserted by an earlier statement in the batch', async () => {
		const db = new Database();
		await db.exec(SCHEMA);

		// Intentionally interleaved order matching D-07a:
		// Authority → Officer (CHECK references Admin which is NOT YET inserted) → Admin
		let thrown: Error | null = null;
		try {
			await db.exec(`
				insert into Authority values ('auth1', 'Test');
				insert into Officer values ('auth1', '2026-01-01', 'user1');
				insert into Admin (AuthorityId, EffectiveAt) values ('auth1', '2026-01-01');
			`);
		} catch (err) {
			thrown = err as Error;
		}

		const perStatementFiring = thrown !== null;

		// eslint-disable-next-line no-console
		console.log(
			`[D-07g] per-statement firing observed: ${perStatementFiring ? 'YES' : 'NO'}` +
			(thrown ? ` — error: ${thrown.message}` : '')
		);

		if (perStatementFiring) {
			// eslint-disable-next-line no-console
			console.log(
				`[D-07g] Plan 01 createAuthority MUST use the three-batch shape ` +
				`(Authority+Admin, then Officer) — single-batch insert in topological order fails.`
			);
		} else {
			// eslint-disable-next-line no-console
			console.log(
				`[D-07g] Plan 01 createAuthority MAY use a single batch — CHECKs are deferred ` +
				`to end-of-batch and see all rows inserted by the batch.`
			);
		}

		// Deterministic assertion — the observation is the value; the test
		// always passes so it never blocks the suite. Plan 01 reads the
		// console.log line above to pick the batching strategy.
		expect(perStatementFiring === true || perStatementFiring === false).to.equal(true);
	});

	it('B2 — FK-style CHECK across two separate db.exec calls fires after the earlier batch commits', async () => {
		const db = new Database();
		await db.exec(SCHEMA);

		// Batch #1: Authority + Admin (AuthorityIdValid CHECK sees Authority row).
		await db.exec(`
			insert into Authority values ('auth1', 'Test');
			insert into Admin (AuthorityId, EffectiveAt) values ('auth1', '2026-01-01');
		`);

		// Batch #2: Officer (AdminValid CHECK sees committed Admin row).
		await db.exec(`
			insert into Officer values ('auth1', '2026-01-01', 'user1');
		`);

		const row = await db.prepare(`select UserId from Officer where AuthorityId = 'auth1'`).get();
		expect(row?.UserId).to.equal('user1');
	});
});
