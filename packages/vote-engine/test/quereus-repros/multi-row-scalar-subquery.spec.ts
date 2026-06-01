import { Database, createScalarFunction, FunctionFlags, TEXT_TYPE } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { createHash } from 'crypto';
import { expect } from 'chai';

/**
 * Phase 12.4 D-08 / D-09 — multi-row scalar-subquery determinism probe.
 *
 * Empirically characterizes how quereus 3.3.0 selects rows when a scalar
 * subquery returns multiple rows, and verifies the D-09 SQL contract
 * (`ORDER BY UserId ASC LIMIT 1`) yields a single deterministic Digest
 * value over a multi-row Officer source.
 *
 * Sources:
 * - CONTEXT D-08 (multi-row scalar subquery determinism)
 * - CONTEXT D-09 (sort + bind first contract)
 * - RESEARCH Open Question 2 (scalar-subquery row selection)
 * - PATTERNS Section 14 (probe spec analog)
 *
 * Test A2 is a HARD GATE for Plan 01: if it fails, Plan 01 cannot proceed —
 * escalate to `/gsd-discuss-phase 12.4` with the probe output.
 *
 * The `Digest` scalar function MUST be registered identically to
 * `packages/vote-engine/src/database/initialize.ts:49-62` — variadic,
 * deterministic, parts joined with `|`, sha256 base64url.
 */

function registerDigest(db: Database): void {
	const digestSchema = createScalarFunction(
		{
			name: 'Digest',
			numArgs: -1,
			flags: FunctionFlags.DETERMINISTIC,
			returnType: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }
		},
		(...args: SqlValue[]) => {
			const parts = args.map(a => a === null || a === undefined ? '' : String(a));
			const concat = parts.join('|');
			return createHash('sha256').update(concat).digest('base64url');
		}
	);
	db.registerFunction(digestSchema);
}

function jsDigest(...args: (string | null)[]): string {
	const parts = args.map(a => a === null || a === undefined ? '' : String(a));
	const concat = parts.join('|');
	return createHash('sha256').update(concat).digest('base64url');
}

describe('Quereus repro — multi-row scalar subquery determinism (Phase 12.4 D-08)', () => {
	it('A1 — bare scalar subquery over 3 distinct UserIds yields a value across 100 reads', async () => {
		const db = new Database();
		registerDigest(db);

		await db.exec(`
			create table Officer (
				AuthorityId text,
				AdminEffectiveAt text,
				UserId text,
				Title text,
				Scopes text default '[]',
				primary key (AuthorityId, AdminEffectiveAt, UserId)
			);
		`);

		await db.exec(`
			insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title) values ('A1', '2026-01-01T00:00:00', 'user-a', 'Officer A');
			insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title) values ('A1', '2026-01-01T00:00:00', 'user-b', 'Officer B');
			insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title) values ('A1', '2026-01-01T00:00:00', 'user-c', 'Officer C');
		`);

		const values = new Set<string>();
		let multiRowError: Error | null = null;
		try {
			const stmt = await db.prepare(
				`select (select Digest(AdminEffectiveAt, UserId, Title, Scopes) from Officer where AuthorityId = 'A1') as d`
			);
			for (let i = 0; i < 100; i++) {
				const row = await stmt.get();
				if (row && typeof row.d === 'string') {
					values.add(row.d);
				}
			}
		} catch (err) {
			multiRowError = err as Error;
		}

		// Compute the three possible single-row Digests
		const candidates = new Set<string>([
			jsDigest('2026-01-01T00:00:00', 'user-a', 'Officer A', '[]'),
			jsDigest('2026-01-01T00:00:00', 'user-b', 'Officer B', '[]'),
			jsDigest('2026-01-01T00:00:00', 'user-c', 'Officer C', '[]'),
		]);

		if (multiRowError) {
			// quereus 3.3.0 actually rejects multi-row scalar subqueries with an
			// explicit error rather than picking an arbitrary row. This is the
			// strongest possible motivation for the D-09 ORDER BY UserId LIMIT 1
			// contract — without it, the SQL fails entirely on multi-officer
			// authorities.
			// eslint-disable-next-line no-console
			console.log(
				`[D-08 A1] quereus 3.3.0 REJECTS multi-row scalar subquery with error: ${multiRowError.message}. ` +
				`D-09 ORDER BY UserId LIMIT 1 contract is MANDATORY (not merely a stability hedge).`
			);
		} else {
			const observed = Array.from(values);
			const allInCandidates = observed.every(v => candidates.has(v));
			// eslint-disable-next-line no-console
			console.log(`[D-08 A1] distinct scalar-subquery values across 100 reads: ${values.size} — allInCandidates=${allInCandidates}`);
			if (values.size !== 1) {
				// eslint-disable-next-line no-console
				console.warn(
					`[D-08 A1] WARNING: scalar-subquery is NOT stable across reads (size=${values.size}). ` +
					`The D-09 ORDER BY UserId LIMIT 1 contract becomes mandatory.`
				);
			}
		}

		// Always-true informational assertion: we either observed at least one
		// value, OR observed quereus's explicit multi-row rejection.
		expect(values.size >= 1 || multiRowError !== null).to.equal(true);
	});

	it('A2 — ORDER BY UserId LIMIT 1 enforces a single deterministic Digest value (D-09 contract)', async () => {
		const db = new Database();
		registerDigest(db);

		await db.exec(`
			create table Officer (
				AuthorityId text,
				AdminEffectiveAt text,
				UserId text,
				Title text,
				Scopes text default '[]',
				primary key (AuthorityId, AdminEffectiveAt, UserId)
			);
		`);

		await db.exec(`
			insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title) values ('A1', '2026-01-01T00:00:00', 'user-a', 'Officer A');
			insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title) values ('A1', '2026-01-01T00:00:00', 'user-b', 'Officer B');
			insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title) values ('A1', '2026-01-01T00:00:00', 'user-c', 'Officer C');
		`);

		const stmt = await db.prepare(
			`select (
				select Digest(AdminEffectiveAt, UserId, Title, Scopes)
				from (select * from Officer where AuthorityId = 'A1' order by UserId ASC LIMIT 1)
			) as d`
		);

		const values = new Set<string>();
		for (let i = 0; i < 100; i++) {
			const row = await stmt.get();
			if (row && typeof row.d === 'string') {
				values.add(row.d);
			}
		}

		// HARD GATE for Plan 01 — ORDER BY UserId LIMIT 1 MUST be deterministic.
		expect(values.size, 'ORDER BY UserId LIMIT 1 must yield a single deterministic Digest').to.equal(1);

		// Cross-check the SQL-returned Digest equals the JS-recomputed Digest
		// over the first row by UserId ASC (user-a, Officer A, []).
		const sqlDigest = Array.from(values)[0];
		const expectedDigest = jsDigest('2026-01-01T00:00:00', 'user-a', 'Officer A', '[]');
		expect(sqlDigest, 'SQL-returned Digest must match JS-recomputed Digest for first row by UserId ASC').to.equal(expectedDigest);
	});

	it('A3 — single-row Officer source yields the same Digest as ORDER BY UserId LIMIT 1', async () => {
		const db = new Database();
		registerDigest(db);

		await db.exec(`
			create table Officer (
				AuthorityId text,
				AdminEffectiveAt text,
				UserId text,
				Title text,
				Scopes text default '[]',
				primary key (AuthorityId, AdminEffectiveAt, UserId)
			);
		`);

		await db.exec(`
			insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title) values ('A1', '2026-01-01T00:00:00', 'user-solo', 'Solo Officer');
		`);

		const bareRow = await db.prepare(
			`select (select Digest(AdminEffectiveAt, UserId, Title, Scopes) from Officer where AuthorityId = 'A1') as d`
		).get();

		const orderedRow = await db.prepare(
			`select (
				select Digest(AdminEffectiveAt, UserId, Title, Scopes)
				from (select * from Officer where AuthorityId = 'A1' order by UserId ASC LIMIT 1)
			) as d`
		).get();

		expect(bareRow?.d).to.be.a('string');
		expect(orderedRow?.d).to.be.a('string');
		expect(bareRow?.d, 'single-row degenerate case: bare and ordered Digests must match').to.equal(orderedRow?.d);
	});
});
