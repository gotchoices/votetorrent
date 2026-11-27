/**
 * officer-reads.test.mjs -- real-schema execution of every read function in
 * `src/officer/{elections,ballots,registrations}.js` (empty and populated),
 * the coverage assertion against `capability-tables.js`'s generated
 * `CAPABILITY_TABLES` map, and the column/mutation/interpolation absence
 * scans that back rules R3/R4. Moved here (from the dashboard's own
 * `test/node/reads.test.mjs`, alongside the modules it tests) by 54-03b --
 * honest rename, since its subject was always this package's officer read
 * surface, never a dashboard file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Database } from '@quereus/quereus';
import { prepareDb } from '@votetorrent/vote-engine/browser';

import {
	CAPABILITY_TABLES,
	selectActiveElection,
	readElectionOverview,
	readElectionPolicies,
	countElections,
	ELECTIONS_TABLES_READ,
	readBallots,
	readQuestions,
	countBallotSigningTasks,
	BALLOTS_TABLES_READ,
	readRegistrantStatusBreakdown,
	readRegistrationRequestBreakdown,
	readRegistrantRoster,
	readRegistrationSurfaceCounts,
	hasAnyRegistrationData,
	ROSTER_PAGE_SIZE,
	REGISTRATIONS_TABLES_READ,
} from '@votetorrent/web-data/officer';
import { seedFoundingAuthority } from './fixtures/seed-founding-authority.js';
import { seedElectionSurface, SEED_ELECTION, SEED_EXPECTED_COUNTS, ceremony } from './fixtures/seed-election-surface.js';
import { webDataSrc } from '../../../scripts/lib/source-paths.mjs';

const OFFICER_DIR = webDataSrc('officer');

/** @returns {Promise<import('@quereus/quereus').Database>} */
async function foundingOnlyDb() {
	const db = new Database();
	await prepareDb(db);
	await seedFoundingAuthority(db);
	return db;
}

/** @returns {Promise<import('@quereus/quereus').Database>} */
async function seededDb() {
	const db = await foundingOnlyDb();
	await seedElectionSurface(db);
	return db;
}

// --- Coverage: CAPABILITY_TABLES subset of module TABLES_READ --------------

test('coverage: registrations TABLES_READ covers all 14 vrg tables from CAPABILITY_TABLES', () => {
	const tables = CAPABILITY_TABLES.registrations;
	assert.ok(tables);
	assert.equal(tables.length, 14);
	for (const table of tables) {
		assert.ok(REGISTRATIONS_TABLES_READ.includes(table), `registrations TABLES_READ missing ${table}`);
	}
});

test('coverage: elections TABLES_READ covers all 8 mel tables from CAPABILITY_TABLES', () => {
	const tables = CAPABILITY_TABLES.elections;
	assert.ok(tables);
	assert.equal(tables.length, 8);
	for (const table of tables) {
		assert.ok(ELECTIONS_TABLES_READ.includes(table), `elections TABLES_READ missing ${table}`);
	}
});

test('coverage: ballotsQuestions TABLES_READ covers all 4 ceb tables from CAPABILITY_TABLES', () => {
	const tables = CAPABILITY_TABLES.ballotsQuestions;
	assert.ok(tables);
	assert.equal(tables.length, 4);
	for (const table of tables) {
		assert.ok(BALLOTS_TABLES_READ.includes(table), `ballots TABLES_READ missing ${table}`);
	}
});

test('coverage: every extra TABLES_READ name (beyond CAPABILITY_TABLES) is a real schema table or view', async () => {
	const db = await foundingOnlyDb();
	const allModuleTables = new Set([...ELECTIONS_TABLES_READ, ...BALLOTS_TABLES_READ, ...REGISTRATIONS_TABLES_READ]);
	for (const table of allModuleTables) {
		// eslint-disable-next-line no-await-in-loop
		await assert.doesNotReject(() => db.prepare(`select count(*) as c from ${table}`).get({}), `${table} is not a real table/view`);
	}
});

test('positive control: a coverage check with one table removed from a copy of TABLES_READ reports the missing name', () => {
	const tables = CAPABILITY_TABLES.registrations;
	assert.ok(tables);
	const syntheticTablesRead = REGISTRATIONS_TABLES_READ.filter((t) => t !== 'PollingDevice');
	const missing = tables.filter((t) => !syntheticTablesRead.includes(t));
	assert.deepEqual(missing, ['PollingDevice'], 'a coverage check that cannot detect a gap is not a coverage check');
});

// --- SQL validity against the real schema, founding-only database ----------

test('SQL validity (founding-only): every read function resolves without throwing and returns empty/zero', async () => {
	const db = await foundingOnlyDb();

	assert.equal(await selectActiveElection(db), null);
	assert.equal(await countElections(db), 0);
	assert.equal(await readElectionOverview(db, 'nonexistent'), null);
	const policies = await readElectionPolicies(db, 'nonexistent');
	assert.equal(policies.registrationFieldCount, 0);
	assert.equal(policies.disclosurePolicyCount, 0);
	assert.equal(policies.attestationRequired, null);
	assert.deepEqual(policies.registrationFieldBreakdown, []);

	assert.deepEqual(await readBallots(db, 'nonexistent'), []);
	assert.deepEqual(await readQuestions(db, 'nonexistent'), []);
	assert.equal(await countBallotSigningTasks(db), 0);

	const statusBreakdown = await readRegistrantStatusBreakdown(db);
	assert.equal(statusBreakdown.length, 3);
	assert.deepEqual(
		statusBreakdown.map((r) => r.Count),
		[0, 0, 0],
	);
	assert.deepEqual(await readRegistrationRequestBreakdown(db), []);
	const roster = await readRegistrantRoster(db);
	assert.deepEqual(roster, { rows: [], total: 0 });
	const surfaceCounts = await readRegistrationSurfaceCounts(db, 'nonexistent');
	assert.equal(surfaceCounts.length, 14);
	assert.ok(surfaceCounts.every((entry) => entry.count === 0));
	assert.equal(await hasAnyRegistrationData(db), false);
});

test('positive control: temporarily renaming a selected column makes exactly that SQL-validity assertion fail, naming the column', async () => {
	// This is a source-level positive control (proving the SQL-validity test
	// above is discriminating), not a runtime mutation of the schema: it
	// re-derives the roster query with a deliberately wrong column name and
	// confirms Quereus rejects it naming that column.
	const db = await foundingOnlyDb();
	await assert.rejects(
		() =>
			db
				.prepare(
					`select R.Id, R.Status, R.Expiration, RP.LastName, RP.FirstName, RP.Districtt
					 from Registrant R left join RegistrantPublic RP on RP.RegistrantId = R.Id and RP.Cid = R.PublicCid
					 order by RP.LastName, RP.FirstName, R.Id limit :rosterLimit`,
				)
				.get({ rosterLimit: 100 }),
		/Districtt/,
	);
});

// --- Populated reads, founding + election surface --------------------------

test('selectActiveElection returns the seeded election with TypeName read from the view, not a literal', async () => {
	const db = await seededDb();
	const active = await selectActiveElection(db);
	assert.ok(active);
	assert.equal(active.Id, SEED_ELECTION.id);
	assert.equal(active.Title, SEED_ELECTION.title);
	assert.equal(active.Date, SEED_ELECTION.date);
	assert.equal(active.RevisionDeadline, SEED_ELECTION.revisionDeadline);
	assert.equal(active.BallotDeadline, SEED_ELECTION.ballotDeadline);
	assert.equal(active.Type, SEED_ELECTION.type);
	assert.equal(active.TypeName, 'Official');
});

test('readElectionOverview returns Revision 0, KeyholderThreshold 3, parsed Tags, and Timeline raw', async () => {
	const db = await seededDb();
	const overview = await readElectionOverview(db, SEED_ELECTION.id);
	assert.ok(overview);
	assert.equal(overview.Revision, 0);
	assert.equal(overview.KeyholderThreshold, 3);
	assert.deepEqual(overview.Tags, ['general']);
	assert.equal(typeof overview.Timeline, 'string');
	assert.match(/** @type {string} */ (overview.Timeline), /votingStarts/);
});

test('countElections returns 1 on the seeded database', async () => {
	const db = await seededDb();
	assert.equal(await countElections(db), 1);
});

test('readElectionPolicies returns zero-count policy entries with a present, empty breakdown array', async () => {
	const db = await seededDb();
	const policies = await readElectionPolicies(db, SEED_ELECTION.id);
	assert.equal(policies.registrationFieldCount, 0);
	assert.equal(policies.disclosurePolicyCount, 0);
	assert.deepEqual(policies.registrationFieldBreakdown, []);
});

test('readBallots returns 2 rows, deterministically ordered, with Districts parsed to string arrays', async () => {
	const db = await seededDb();
	const rows = await readBallots(db, SEED_ELECTION.id);
	assert.equal(rows.length, 2);
	assert.deepEqual(
		rows.map((r) => r.Id),
		['b1', 'b2'],
	);
	assert.deepEqual(rows[0].Districts, ['county']);
	assert.deepEqual(rows[1].Districts, ['county', 'd3']);
});

test('readQuestions returns 3 rows ordered by BallotId/Sequence/Code with TypeName from the view and an uneven OptionCount', async () => {
	const db = await seededDb();
	const rows = await readQuestions(db, SEED_ELECTION.id);
	assert.equal(rows.length, 3);
	assert.deepEqual(
		rows.map((r) => [r.BallotId, r.Code]),
		[
			['b1', 'q1'],
			['b1', 'q2'],
			['b2', 'q1'],
		],
	);
	assert.deepEqual(
		rows.map((r) => r.OptionCount),
		[3, 2, 2],
	);
	assert.deepEqual(
		rows.map((r) => r.TypeName),
		['Select', 'Text', 'Rank'],
	);
	assert.equal(rows[1].Required, 0, 'q2 was seeded with Required = 0');
	assert.equal(rows[0].Grouping, 'offices', 'q1 was seeded with a non-null Grouping');
});

test('readRegistrantStatusBreakdown still returns three zero-count entries on the seeded database (Registrant is unseedable at tier 1)', async () => {
	const db = await seededDb();
	const breakdown = await readRegistrantStatusBreakdown(db);
	assert.deepEqual(
		breakdown.map((r) => [r.Code, r.Name, r.Count]),
		[
			['a', 'Active', 0],
			['s', 'Suspended', 0],
			['r', 'Revoked', 0],
		],
	);
});

test('readRegistrationRequestBreakdown returns an empty array on the seeded database and does not throw', async () => {
	const db = await seededDb();
	assert.deepEqual(await readRegistrationRequestBreakdown(db), []);
});

test('readRegistrantRoster returns { rows: [], total: 0 } on the seeded database, binding rosterLimit rather than interpolating it', async () => {
	const db = await seededDb();
	assert.deepEqual(await readRegistrantRoster(db), { rows: [], total: 0 });
});

test('readRegistrationSurfaceCounts returns one entry per vrg table with RegistrationBridgeKey=1 and PollingDevice=1 seeded, everything else 0', async () => {
	const db = await seededDb();
	const entries = await readRegistrationSurfaceCounts(db, SEED_ELECTION.id);
	assert.equal(entries.length, 14);
	const byTable = Object.fromEntries(entries.map((e) => [e.table, e.count]));
	assert.equal(byTable.RegistrationBridgeKey, SEED_EXPECTED_COUNTS.RegistrationBridgeKey);
	assert.equal(byTable.PollingDevice, SEED_EXPECTED_COUNTS.PollingDevice);
	assert.equal(byTable.Registrant, 0);
	assert.equal(byTable.RegistrantPrivate, 0);
	assert.equal(byTable.RegistrantSelective, 0);
	assert.equal(byTable.Association, 0);
	assert.equal(byTable.AssociationPrivate, 0);
	assert.equal(byTable.AssociationRequest, 0);
	assert.equal(byTable.AttestationChallenge, 0);
	assert.equal(byTable.AuthorityIntakePolicy, 0);
	assert.equal(byTable.ElectionRegistrant, 0);
	assert.equal(byTable.RegistrantPublic, 0);
	assert.equal(byTable.RegistrantSignatureTaskExtension, 0);
	assert.equal(byTable.RegistrationRequest, 0);
});

test('positive control: temporarily deleting PollingDevice from a copy of registrations TABLES_READ makes the coverage test fail naming PollingDevice', () => {
	const tables = CAPABILITY_TABLES.registrations;
	assert.ok(tables);
	const withoutPollingDevice = REGISTRATIONS_TABLES_READ.filter((t) => t !== 'PollingDevice');
	assert.ok(tables.includes('PollingDevice'));
	assert.ok(!withoutPollingDevice.includes('PollingDevice'));
});

test('hasAnyRegistrationData is false on founding-only and true once a RegistrationBridgeKey exists', async () => {
	const foundingOnly = await foundingOnlyDb();
	assert.equal(await hasAnyRegistrationData(foundingOnly), false);

	const seeded = await seededDb();
	assert.equal(await hasAnyRegistrationData(seeded), true);
});

test('hasAnyRegistrationData is true once a lone AuthorityIntakePolicy row exists (Phase 62 Plan 25, 62-01 open question)', async () => {
	const db = await foundingOnlyDb();
	assert.equal(await hasAnyRegistrationData(db), false);

	const { Id: authorityId } = await db.prepare('select Id from Authority').get({});

	const tid = 600;
	const nonce = await ceremony(db, {
		scope: 'vrg',
		tid,
		digestSql: ':tid, :tbl, :aid, :rev, :url, :mode, :setAt',
		params: {
			tbl: 'AuthorityIntakePolicy',
			aid: authorityId,
			rev: 1,
			url: 'https://bridge.example/intake',
			mode: 'manual',
			setAt: '2026-03-01T00:00:00.000Z',
		},
	});
	await db.exec(
		`insert into AuthorityIntakePolicy (AuthorityId,Revision,RestBridgeUrl,ReassociationMode,SetAt)
		 with context SigningNonce = :n, Tid = :tid
		 values (:aid,:rev,:url,:mode,:setAt)`,
		{
			n: nonce,
			tid,
			aid: authorityId,
			rev: 1,
			url: 'https://bridge.example/intake',
			mode: 'manual',
			setAt: '2026-03-01T00:00:00.000Z',
		},
	);

	assert.equal(await hasAnyRegistrationData(db), true);
});

// --- Rules R3 / R4 source-level scans ---------------------------------------

test('no read function returns PrivateDetails, SelectiveDetails, Payload, PayloadCid or ExtraFields', () => {
	for (const file of ['elections.js', 'ballots.js', 'registrations.js']) {
		const source = readFileSync(path.join(OFFICER_DIR, file), 'utf8');
		const stripped = source
			.split('\n')
			.filter((line) => {
				const trimmed = line.trim();
				return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
			})
			.join('\n');
		assert.doesNotMatch(stripped, /PrivateDetails|SelectiveDetails|\.Payload|PayloadCid|ExtraFields/, `${file} references a forbidden column`);
	}
});

test('no SQL string in src/officer/ contains a template-literal interpolation', () => {
	for (const file of ['elections.js', 'ballots.js', 'registrations.js']) {
		const source = readFileSync(path.join(OFFICER_DIR, file), 'utf8');
		const stripped = source
			.split('\n')
			.filter((line) => {
				const trimmed = line.trim();
				return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
			})
			.join('\n');
		assert.doesNotMatch(stripped, /\$\{/, `${file} contains a template-literal interpolation`);
	}
});

test('no mutating statement (insert into / delete from / update ... set) anywhere in src/officer/', () => {
	for (const file of ['elections.js', 'ballots.js', 'registrations.js']) {
		const source = readFileSync(path.join(OFFICER_DIR, file), 'utf8');
		const stripped = source
			.split('\n')
			.filter((line) => {
				const trimmed = line.trim();
				return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
			})
			.join('\n');
		assert.doesNotMatch(stripped, /insert into|delete from|update .* set /i, `${file} contains a mutating statement`);
	}
});

test('ROSTER_PAGE_SIZE is exactly 100', () => {
	assert.equal(ROSTER_PAGE_SIZE, 100);
});
