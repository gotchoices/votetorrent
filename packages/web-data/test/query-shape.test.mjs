/**
 * query-shape.test.mjs — D-14's counts-only aggregate and D-19's three-column
 * roll, pinned to the EXACT SQL rather than to a description of it.
 *
 * THE DESIGN CHOICE 54-06 HANDED OVER. Every SQL string in the read layer is an
 * exported frozen constant. That is what lets this gate IMPORT the statements
 * and assert on their parsed shape, instead of regexing arbitrary source and
 * hoping the regex still matches after a reflow. The difference is precise
 * versus fragile: a fragile gate gets loosened the first time it misfires, and a
 * loosened gate is how a guard starts passing for the wrong reason.
 *
 * FIVE RULES:
 *   Q1  the generic public-SQL rule, applied to EVERY discovered constant — so
 *       a public query written next year is covered without editing this file.
 *   Q2  D-14: the key-release aggregate's select list is aggregate functions
 *       ONLY, and it counts published KeyholderShareRelease rows scoped to the
 *       election revision (62-126: no longer completed Tasks).
 *   Q3  D-19: the roll's select column set EQUALS exactly three names — set
 *       equality, not containment. 54-06's own guard checks containment, which
 *       would accept a fourth column; D-19's text is "these only".
 *   Q4  `ExtraFields` and `SigningNonce` appear nowhere in public source at
 *       all, not merely in a select list.
 *   Q5  D-22: the policy-gated registrant table is unreachable from the public
 *       subpath.
 *
 * EVERY CONTROL MUTATES A REAL CONSTANT rather than a synthetic string. A rule
 * proven against a hand-written fixture is proven against the shape the fixture
 * author imagined; mutating the real string proves it fires on the shape the
 * codebase actually produces.
 *
 * WHAT THIS GATE CANNOT PROVE. It reads STATEMENTS, not RESULTS. It cannot see a
 * value that leaves the layer in a variable, and it cannot see what the render
 * layer does with three permitted columns. Nor does it prove the roll's join
 * RETURNS the rows its column list describes — see the standing note at the
 * bottom of this file about the roll being source-asserted rather than
 * data-asserted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { publicSrc, webDataSrc } from '../../../scripts/lib/source-paths.mjs';
import {
	CLASSIFICATION,
	CLASS,
	IDENTIFYING_COLUMN_TOKENS,
	assertNoIdentifyingColumns,
	selectListOf,
} from '../src/classification.js';
import { partitionByExtension, scanForNames, scanSourceForNames, selectItemsOf, walkSourceFiles } from './lib/source-scan.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const BEGIN_SENTINEL = ['BEGIN', 'CONTROL', 'FIXTURES'].join(' ');
const END_SENTINEL = ['END', 'CONTROL', 'FIXTURES'].join(' ');

/* ─────────────────────────────────────────────────────────────────────────────
 * BEGIN CONTROL FIXTURES
 * The only hand-written column and bind literals in this file.
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * The six public SQL constants 54-06's SUMMARY records, by name. Pinned so a
 * DISCOVERY gate cannot pass by finding nothing: if a constant disappears or is
 * renamed, this list disagrees and the run goes red rather than silently
 * covering five statements instead of six. (`KEYHOLDER_ROSTER_SQL` is the
 * seventh in that table and lives under `src/officer/`, outside this root.)
 * @type {ReadonlyArray<string>}
 */
const EXPECTED_PUBLIC_SQL_CONSTANTS = Object.freeze([
	'KEYHOLDER_COUNT_SQL',
	'KEYRELEASE_AGGREGATE_SQL',
	'PUBLIC_ELECTION_LIST_SQL',
	'PUBLIC_ELECTION_REVISION_SQL',
	'PUBLIC_ELECTION_SQL',
	'REGISTRANT_ROLL_SQL',
]);

/**
 * Bind names that parse as KEYWORDS rather than parameters in this engine
 * (measured in 54-03b for `:limit`: "Expected identifier or number after
 * parameter prefix", naming no column and no statement). A bind carrying one of
 * these silently stops being a bind.
 * @type {ReadonlyArray<string>}
 */
const RESERVED_BIND_NAMES = Object.freeze([':limit', ':desc', ':group', ':order', ':type']);

/**
 * The three tokens banned from a public statement in ANY clause, not just its
 * select list. See the header note on Q1 for why these three and not the whole
 * of IDENTIFYING_COLUMN_TOKENS.
 * @type {ReadonlyArray<string>}
 */
const WHOLE_STATEMENT_BANNED = Object.freeze(['ExtraFields', 'SigningNonce', 'UserId']);

/** D-19's exact permitted roll columns. */
const ROLL_COLUMNS = Object.freeze(['LastName', 'FirstName', 'District']);

/** Q1's four mutations, each applied to a real constant. @type {ReadonlyArray<readonly [string, (sql: string) => string]>} */
const Q1_MUTATIONS = /** @type {ReadonlyArray<readonly [string, (sql: string) => string]>} */ (Object.freeze([
	['interpolation inserted', (sql) => sql.replace(' from ', ' from ${tableName} ')],
	['a reserved bind name substituted', (sql) => sql.replace(':electionId', ':type')],
	['an identifying token added to the select list', (sql) => sql.replace(' from ', ', RP.PublicCid from ')],
	['SigningNonce added to a where clause', (sql) => `${sql.replace(/ where /, ' where T.SigningNonce is not null and ')}`],
]));

/** Q2's three mutations of the real aggregate. @type {ReadonlyArray<readonly [string, (sql: string) => string]>} */
const Q2_MUTATIONS = /** @type {ReadonlyArray<readonly [string, (sql: string) => string]>} */ (Object.freeze([
	['a bare per-row user column added', (sql) => sql.replace(' from ', ', UserId as who from ')],
	['a bare released share added', (sql) => sql.replace(' from ', ', SigningShare from ')],
	['the revision scope dropped', (sql) => sql.replace(' and ElectionRevision = :revision', '')],
	['the old task source restored', (sql) => sql.replace('from KeyholderShareRelease', 'from Task T join ReleaseKeyTaskExtension R on R.TaskId = T.Id')],
]));

/** Q3's two mutations of the real roll. @type {ReadonlyArray<readonly [string, (sql: string) => string]>} */
const Q3_MUTATIONS = /** @type {ReadonlyArray<readonly [string, (sql: string) => string]>} */ (Object.freeze([
	['a fourth selected column', (sql) => sql.replace(' from ', ', RP.ExtraFields from ')],
	['the current-record pin dropped', (sql) => sql.replace(' and RP.Cid = R.PublicCid', '')],
]));

/** Q4's comment-vs-code discrimination fixtures. */
const Q4_CODE_FIXTURE = `const q = 'select RP.ExtraFields from RegistrantPublic RP';`;
const Q4_COMMENT_FIXTURE = ` * FirstName, District. Not ExtraFields (votetorrent.qsql:1818 calls it a "json`;
const Q4_NONCE_CODE_FIXTURE = `const q = 'select T.SigningNonce from Task T';`;

/* ─────────────────────────────────────────────────────────────────────────────
 * END CONTROL FIXTURES
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Discover every public SQL constant by walking and importing, rather than by a
 * hard-coded list. `EXPECTED_PUBLIC_SQL_CONSTANTS` then cross-checks the result,
 * so discovery and the pin can disagree — which is the whole point: a discovery
 * gate that finds nothing passes vacuously.
 *
 * @returns {Promise<Map<string, { sql: string, file: string }>>}
 */
async function discoverPublicSql() {
	/** @type {Map<string, { sql: string, file: string }>} */
	const found = new Map();
	const part = partitionByExtension(walkSourceFiles(webDataSrc('public')));
	assert.deepEqual(part.unknown, [], `src/public/ holds files with an unclassified extension: ${part.unknown.join(', ')}`);
	for (const file of part.scanned) {
		const mod = await import(pathToFileURL(file).href);
		for (const [name, value] of Object.entries(mod)) {
			if (typeof value !== 'string') continue;
			if (!value.trim().toLowerCase().startsWith('select')) continue;
			assert.ok(!found.has(name), `two modules under src/public/ export a SQL constant named ${name}`);
			found.set(name, { sql: value, file });
		}
	}
	return found;
}

/**
 * Normalise a select item to its bare column name: drop a table alias prefix and
 * any `as` alias.
 * @param {string} item
 * @returns {string}
 */
function columnNameOf(item) {
	const withoutAlias = item.replace(/\s+as\s+[A-Za-z_][A-Za-z0-9_]*\s*$/i, '').trim();
	const parts = withoutAlias.split('.');
	return parts[parts.length - 1].trim();
}

/**
 * Rule Q1 applied to one statement. Returns human-readable violations.
 * @param {string} name
 * @param {string} sql
 * @returns {string[]}
 */
function q1Violations(name, sql) {
	/** @type {string[]} */
	const out = [];
	if (sql.includes('${')) {
		out.push(`${name}: contains a template interpolation. RULE R4 — every varying value is a NAMED BIND; interpolation makes externally-supplied text executable.`);
	}
	for (const reserved of RESERVED_BIND_NAMES) {
		if (new RegExp(`${reserved}\\b`, 'i').test(sql)) {
			out.push(`${name}: uses the reserved bind name "${reserved}", which parses as a KEYWORD rather than a parameter in this engine — the value silently stops being bound. Rename the bind.`);
		}
	}
	try {
		assertNoIdentifyingColumns(sql, name);
	} catch (error) {
		out.push(`${name}: ${/** @type {Error} */ (error).message}`);
	}
	for (const token of WHOLE_STATEMENT_BANNED) {
		if (new RegExp(`\\b${token}\\b`).test(sql)) {
			out.push(
				`${name}: names "${token}" somewhere in the statement. For the PUBLIC subpath none of these three has any ` +
					'legitimate use in ANY clause — the roll scopes through RegistrantId and the aggregate joins on TaskId/Id. ' +
					'If this fires, THE QUERY IS WRONG and must be escalated; do not loosen the rule.',
			);
		}
	}
	return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Discovery — asserted non-vacuous before anything is checked.
// ───────────────────────────────────────────────────────────────────────────

test('discovery: the public SQL constants found by walking equal the six 54-06 recorded', async () => {
	const found = await discoverPublicSql();
	assert.ok(found.size > 0, 'zero public SQL constants were discovered — every rule below would pass vacuously');
	assert.deepEqual(
		[...found.keys()].sort(),
		[...EXPECTED_PUBLIC_SQL_CONSTANTS],
		'the set of exported public SQL constants changed. Adding one is fine — add its name here in the same commit, and ' +
			'confirm rules Q1-Q5 below cover it. Losing one silently is how this gate stops covering a statement.',
	);
	for (const [name, { sql }] of found) {
		assert.ok(sql.trim().length > 20, `${name} is suspiciously short: ${sql}`);
		assert.ok(!sql.includes('\n'), `${name} spans lines. selectListOf locates the select list by the literal ' from ' substring and this gate asserts exact shapes; reflow the surrounding code instead.`);
	}
});

// ───────────────────────────────────────────────────────────────────────────
// Q1 — the generic rule, and its four mutation controls.
// ───────────────────────────────────────────────────────────────────────────

test('control Q1: each of the four sub-rules rejects a mutation of a REAL constant', async () => {
	const found = await discoverPublicSql();
	const roll = found.get('REGISTRANT_ROLL_SQL');
	assert.ok(roll, 'REGISTRANT_ROLL_SQL is missing; the Q1 mutation controls have no real subject to mutate');
	const aggregate = found.get('KEYRELEASE_AGGREGATE_SQL');
	assert.ok(aggregate, 'KEYRELEASE_AGGREGATE_SQL is missing; the Q1 mutation controls have no real subject to mutate');

	for (const [label, mutate] of Q1_MUTATIONS) {
		const subject = label.includes('SigningNonce') ? aggregate.sql : roll.sql;
		const mutated = mutate(subject);
		assert.notEqual(mutated, subject, `the "${label}" mutation did not change the constant; the control is inert`);
		assert.ok(
			q1Violations('MUTANT', mutated).length > 0,
			`rule Q1 is inert for "${label}" — a real constant mutated that way was accepted`,
		);
	}
});

test('Q1: every discovered public SQL constant is bound-parameter clean and names no identifying column', async () => {
	const found = await discoverPublicSql();
	/** @type {string[]} */
	const violations = [];
	for (const [name, { sql }] of found) violations.push(...q1Violations(name, sql));
	assert.deepEqual(violations, [], 'a public SQL constant violates the generic public-query rule');
});

// ───────────────────────────────────────────────────────────────────────────
// Q2 — D-14's counts-only aggregate.
// ───────────────────────────────────────────────────────────────────────────

/** @param {string} sql @returns {string[]} */
function q2Violations(sql) {
	/** @type {string[]} */
	const out = [];
	for (const item of selectItemsOf(sql, selectListOf)) {
		if (!/^(count|sum)\s*\(/i.test(item)) {
			out.push(
				`the key-release aggregate selects "${item}", which is not a count(…) or sum(…) form. D-14 says NO TASK ROW IS ` +
					'EXPOSED; a bare column in this select list is a task row by any other name.',
			);
		}
	}
	if (!/\bfrom\s+KeyholderShareRelease\b/i.test(sql)) {
		out.push(
			'the aggregate no longer reads KeyholderShareRelease. 62-126: the published release row is the fact; counting ' +
				'Task/ReleaseKeyTaskExtension measures a bookkeeping task, so a published share can read as unreleased.',
		);
	}
	if (/\b(Task|ReleaseKeyTaskExtension|IsCompleted)\b/.test(sql)) {
		out.push('the aggregate reads Task state again (Task / ReleaseKeyTaskExtension / IsCompleted); 62-126 moved it to share rows.');
	}
	if (!/\bElectionId\s*=\s*:electionId\b/.test(sql) || !/\bElectionRevision\s*=\s*:revision\b/.test(sql)) {
		out.push('the aggregate is not scoped to BOTH the election and the revision (a primary-key-prefix count).');
	}
	return out;
}

test('control Q2: the bare UserId, bare share, dropped-scope and old-task-source mutants of the REAL aggregate are all rejected', async () => {
	const found = await discoverPublicSql();
	const { sql } = /** @type {{ sql: string }} */ (found.get('KEYRELEASE_AGGREGATE_SQL'));
	for (const [label, mutate] of Q2_MUTATIONS) {
		const mutated = mutate(sql);
		assert.notEqual(mutated, sql, `the "${label}" mutation did not change the aggregate; the control is inert`);
		assert.ok(q2Violations(mutated).length > 0, `rule Q2 is inert for "${label}"`);
	}
});

test('Q2 (D-14): the key-release aggregate selects counts only and counts share rows scoped to the revision', async () => {
	const found = await discoverPublicSql();
	const aggregate = found.get('KEYRELEASE_AGGREGATE_SQL');
	assert.ok(
		aggregate,
		'KEYRELEASE_AGGREGATE_SQL was not found under src/public/. A gate that SKIPS when its subject is missing is inert; ' +
			'this one fails instead.',
	);
	assert.deepEqual(q2Violations(aggregate.sql), [], 'D-14 is broken: the key-release aggregate is no longer counts-only');

	// 62-126: no task-type literal any more -- the share table is keyed by (ElectionId, ElectionRevision, UserId)
	// and every value is a bind.
	assert.ok(!/'[a-z-]+'/i.test(aggregate.sql), 'the aggregate carries a string literal; every value must be a bound parameter');
	assert.ok(/:electionId\b/.test(aggregate.sql), 'the aggregate no longer binds an election id');
	assert.ok(/:revision\b/.test(aggregate.sql), 'the aggregate no longer binds a revision');
});

test('Q2 contrast: the same subject answered two ways — counts here, per-row names under src/officer/', async () => {
	const found = await discoverPublicSql();
	const denominator = found.get('KEYHOLDER_COUNT_SQL');
	assert.ok(denominator, 'KEYHOLDER_COUNT_SQL is missing');
	for (const item of selectItemsOf(denominator.sql, selectListOf)) {
		assert.ok(/^(count|sum)\s*\(/i.test(item), `the keyholder denominator selects "${item}", which is not a count/sum form`);
	}

	// The officer counterpart selects a per-row NAME. It is imported by PATH,
	// deliberately: this assertion is the point of D-04 made concrete, and it must
	// keep working without this file ever reaching the ./officer export.
	const officer = await import(pathToFileURL(webDataSrc('officer', 'read-keyholders.js')).href);
	assert.equal(typeof officer.KEYHOLDER_ROSTER_SQL, 'string', 'the officer keyholder roster constant is missing');
	const officerItems = selectItemsOf(officer.KEYHOLDER_ROSTER_SQL, selectListOf);
	assert.ok(
		officerItems.some((i) => !/^(count|sum)\s*\(/i.test(i)),
		'the officer roster is now counts-only too. If that is deliberate, the contrast this assertion draws is gone and ' +
			'D-04\'s worked example needs rewriting; if it is not, the officer surface lost a capability.',
	);
	assert.ok(
		officerItems.length > 0 && officerItems.some((i) => /Name/.test(i)),
		'the officer roster no longer selects a per-row name — the very query the subpath boundary exists to keep off a public page',
	);
});

// ───────────────────────────────────────────────────────────────────────────
// Q3 — D-19's exactly-three-column roll.
// ───────────────────────────────────────────────────────────────────────────

/** @param {string} sql @returns {string[]} */
function q3Violations(sql) {
	/** @type {string[]} */
	const out = [];
	const columns = selectItemsOf(sql, selectListOf).map(columnNameOf).sort();
	const expected = [...ROLL_COLUMNS].sort();
	if (JSON.stringify(columns) !== JSON.stringify(expected)) {
		out.push(
			`the roll's select column set is {${columns.join(', ')}} but D-19 says exactly {${expected.join(', ')}}. ` +
				'This is SET EQUALITY, not containment: a containment check would accept a fourth column, and "these only" is ' +
				'the whole of D-19.',
		);
	}
	if (!/\bRP\.Cid\s*=\s*R\.PublicCid\b/.test(sql)) {
		out.push(
			'the roll lost its `RP.Cid = R.PublicCid` pin. RegistrantPublic\'s primary key is (RegistrantId, Cid) and the table ' +
				'is insert-only, so a registrant whose public record was REISSUED has more than one row; without the pin the ' +
				'join fans out and superseded names publish alongside current ones.',
		);
	}
	if (!/\bR\.Status\s*=\s*'a'/.test(sql)) {
		out.push(
			'the roll lost its active-status filter. The schema enforces active status only at INSERT time into ' +
				'ElectionRegistrant, so a registrant suspended or revoked afterwards would stay on a published roll forever.',
		);
	}
	return out;
}

test('control Q3: the fourth-column and dropped-pin mutants of the REAL roll are rejected', async () => {
	const found = await discoverPublicSql();
	const { sql } = /** @type {{ sql: string }} */ (found.get('REGISTRANT_ROLL_SQL'));
	for (const [label, mutate] of Q3_MUTATIONS) {
		const mutated = mutate(sql);
		assert.notEqual(mutated, sql, `the "${label}" mutation did not change the roll; the control is inert`);
		assert.ok(q3Violations(mutated).length > 0, `rule Q3 is inert for "${label}"`);
	}

	// The normaliser itself must be live: it has to strip both a table alias
	// prefix and an `as` alias, or set equality would pass on aliased junk.
	assert.equal(columnNameOf('RP.LastName'), 'LastName');
	assert.equal(columnNameOf('RP.ExtraFields as District'), 'ExtraFields');
	assert.equal(columnNameOf('  District  '), 'District');
});

test('Q3 (D-19): the roll\'s select column set equals exactly LastName, FirstName and District', async () => {
	const found = await discoverPublicSql();
	const roll = found.get('REGISTRANT_ROLL_SQL');
	assert.ok(roll, 'REGISTRANT_ROLL_SQL was not found under src/public/; this gate fails rather than skipping');
	assert.deepEqual(q3Violations(roll.sql), [], 'D-19 is broken: the published voter roll is no longer exactly three columns');
});

// ───────────────────────────────────────────────────────────────────────────
// Q4 — the two whole-source bans.
// ───────────────────────────────────────────────────────────────────────────

test('control Q4: each banned token fires in code position and is suppressed in a comment', () => {
	const tokens = ['ExtraFields', 'SigningNonce'];
	assert.ok(
		scanSourceForNames(Q4_CODE_FIXTURE, tokens).some((h) => h.name === 'ExtraFields'),
		'rule Q4 is inert for ExtraFields in code position',
	);
	assert.ok(
		scanSourceForNames(Q4_NONCE_CODE_FIXTURE, tokens).some((h) => h.name === 'SigningNonce'),
		'rule Q4 is inert for SigningNonce in code position',
	);
	assert.deepEqual(
		scanSourceForNames(`/**\n${Q4_COMMENT_FIXTURE}\n */`, tokens).map((h) => h.name),
		[],
		'rule Q4 over-fires on prose. 54-06\'s roll module WRITES OUT why ExtraFields is excluded, in a header comment. ' +
			'A rule that punishes a module for explaining itself gets the explanation deleted.',
	);
});

test('Q4 (D-19): ExtraFields and SigningNonce occur zero times in public source, in any position', () => {
	// WHY THESE TWO ARE A WHOLE-SOURCE BAN while the rest of
	// IDENTIFYING_COLUMN_TOKENS is select-list-only: RegistrantId and PublicCid
	// appear LEGITIMATELY in the roll's join conditions (`R.Id = ER.RegistrantId`,
	// `RP.Cid = R.PublicCid`), so banning them outright would forbid the correct
	// query. These two have no legitimate use anywhere on the public side.
	for (const token of ['ExtraFields', 'SigningNonce']) {
		assert.ok(
			IDENTIFYING_COLUMN_TOKENS.includes(token),
			`${token} is no longer an identifying-column token; reconcile this rule against classification.js`,
		);
	}
	const offenders = scanForNames({
		roots: [webDataSrc('public'), publicSrc()],
		names: ['ExtraFields', 'SigningNonce'],
	});
	assert.deepEqual(
		offenders.map((o) => `${o.file}:${o.line} [${o.name}] :: ${o.text}`),
		[],
		'an unconstrained authority-supplied JSON column or a signing nonce is referenced as code in public source',
	);
});

// ───────────────────────────────────────────────────────────────────────────
// Q5 — D-22 stays enforced, not merely intended.
// ───────────────────────────────────────────────────────────────────────────

test('Q5 (D-22): the policy-gated registrant table is named by no public TABLES_READ and no public SQL', async () => {
	// DERIVED from the classification, never written as a literal — the same
	// discipline the anonymity scan follows.
	const policyGated = Object.keys(CLASSIFICATION).filter((t) => CLASSIFICATION[t][0] === CLASS.POLICY_GATED);
	assert.equal(
		policyGated.length,
		1,
		`expected exactly one POLICY_GATED table (the one D-22 defers); found ${policyGated.length}: ${policyGated.join(', ')}. ` +
			'If a second one appeared, D-22\'s "no evaluator exists" reasoning now covers two tables and this rule needs widening.',
	);

	const part = partitionByExtension(walkSourceFiles(webDataSrc('public')));
	let modulesChecked = 0;
	for (const file of part.scanned) {
		const mod = await import(pathToFileURL(file).href);
		for (const [name, value] of Object.entries(mod)) {
			if (!Array.isArray(value) || !name.includes('TABLES_READ')) continue;
			modulesChecked += 1;
			for (const table of value) {
				assert.ok(
					!policyGated.includes(table),
					`${file} declares the policy-gated registrant table in ${name}. The everyone-audience subset needs ` +
						'setDisclose/setVerify handling over salted leaves and no evaluator exists (D-22).',
				);
			}
		}
	}
	assert.ok(modulesChecked >= 3, `only ${modulesChecked} TABLES_READ declarations were found under src/public/; the walk is broken`);

	const found = await discoverPublicSql();
	for (const [name, { sql }] of found) {
		for (const table of policyGated) {
			assert.ok(!new RegExp(`\\b${table}\\b`).test(sql), `${name} names the policy-gated registrant table`);
		}
	}
});

// ───────────────────────────────────────────────────────────────────────────
// Self-trip guard.
// ───────────────────────────────────────────────────────────────────────────

test('self-trip guard: outside the fixture region this file names no forbidden table and no banned column token', () => {
	const own = readFileSync(THIS_FILE, 'utf8');
	const begin = own.indexOf(BEGIN_SENTINEL);
	const end = own.indexOf(END_SENTINEL);
	assert.ok(begin > 0 && end > begin, 'the control-fixture sentinels are missing or out of order in this file');
	const remainder = own.slice(0, begin) + own.slice(end + END_SENTINEL.length);

	// Q4's own tokens are the interesting case: this file DISCUSSES them at
	// length. They are permitted in the fixture region and in the prose that
	// explains the rule, but a bare COLUMN LITERAL outside both would be the
	// self-tripping shape — so the guard is scoped to code lines.
	const codeLines = remainder.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l));
	const forbidden = Object.keys(CLASSIFICATION).filter((t) =>
		['NEVER', 'DRAFT', 'POLICY_GATED'].includes(CLASSIFICATION[t][0]),
	);
	/** @type {string[]} */
	const leaks = [];
	for (const line of codeLines) {
		for (const name of forbidden) {
			if (new RegExp(`\\b${name}\\b`).test(line)) leaks.push(`${name} :: ${line.trim()}`);
		}
	}
	assert.deepEqual(
		leaks,
		[],
		`this checker names a forbidden table in code position outside its fixture region: ${leaks.join(' | ')}`,
	);
});

/*
 * STANDING NOTE, carried forward rather than left in a commit message.
 *
 * WHAT THESE RULES DO NOT ESTABLISH ABOUT THE ROLL. Q3 asserts the roll's
 * COLUMN LIST and the presence of its two correctness predicates. It does not
 * assert that the join RETURNS the rows that column list describes. 54-06
 * recorded the same limit honestly: no fixture in the repo seeds
 * RegistrantPublic, and Registrant.SignatureValid needs a genuine signature
 * rather than the placeholder-signature ceremony the existing fixtures use, so
 * `readRegistrantRoll` has only ever been observed returning `[]`. The two
 * cases worth building, owned by 54-16: (a) a registrant with a REISSUED public
 * record, asserting exactly one roll row rather than two — the `RP.Cid =
 * R.PublicCid` pin; (b) a registrant whose Status moved to 's' after the
 * ElectionRegistrant insert, asserting they leave the roll.
 */
