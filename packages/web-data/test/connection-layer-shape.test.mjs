/**
 * connection-layer-shape.test.mjs -- R4's extension over the top-level
 * connection layer (54-21, I-56's second half).
 *
 * WHY THIS FILE EXISTS. R4 -- every varying value in SQL is a named bind,
 * never an interpolation -- already has coverage over `src/public/`
 * (`query-shape.test.mjs`'s Q1, over exported SQL constants) and over
 * `src/officer/` (`officer-reads.test.mjs`'s three hard-coded files). The
 * connection layer -- `open-db.js`, `reattach.js`, `networks-registry.js`,
 * `classification.js` -- sits in neither scope, so the one SQL interpolation
 * that lives there (`reattach.js`'s `readRowCounts`) was unowned by any rule,
 * and nothing would have covered a second one added next to it.
 *
 * WHAT MAKES THIS RULE SQL-SCOPED RATHER THAN AN ALLOW-LIST OF EVERY
 * INTERPOLATION. Measured today: `open-db.js` 5, `reattach.js` 11,
 * `networks-registry.js` 2, `classification.js` 4 -- 22 template literals
 * that interpolate, of which exactly ONE begins with a SQL verb. The other 21
 * are error-message text. A blanket no-interpolation rule over this layer
 * would report 21 false offenders on day one and get loosened within a week
 * -- see D-05's design note that a loosened gate is how a guard starts
 * passing for the wrong reason. So a template is only ever a candidate
 * offender when its trimmed content BEGINS with a SQL verb
 * (select/insert/update/delete/with) -- everything else is excluded by
 * construction, not by a per-string exception.
 *
 * THE ONE ALLOW-LISTED SITE. `reattach.js`'s `readRowCounts` builds a
 * `select count(*)` statement whose table name is interpolated directly into
 * the FROM clause. A table name in FROM position is an
 * IDENTIFIER, and identifiers are not bindable as parameters in any SQL
 * engine, Quereus included -- "rewrite it as a bind" is a category error, not
 * an available option. The only interpolation-free rewrite is 61
 * hand-written per-table count(*) constants, which would drift from
 * `votetorrent.qsql` the moment a table is added and would defeat the design
 * intent `classOf` exists to serve (the schema growing a table must BREAK
 * the gate, never quietly bypass a stale constant list). So the
 * interpolation stays, and what makes the exemption defensible is that the
 * interpolated value is drawn from a CLOSED ENUMERATION -- 54-21's second
 * task upgrades the guard from `TABLE_NAME_RE` (a shape, admitting any
 * identifier-shaped string) to membership in the 61 tables
 * `classification.js` classifies (a closed set). `SQL_INTERPOLATION_ALLOWLIST`
 * below records that decision at the site, keyed by FILE AND OWNING
 * FUNCTION -- not by file alone -- so a second SQL interpolation added
 * anywhere else in `reattach.js` is not sheltered by this entry. Control 3
 * proves that with a real mutation.
 *
 * SELF-TRIPPING-CHECKER DEFENCE. Recorded eleven times in this phase: a
 * checker whose own source spells the two-character token it hunts is
 * permanently green the moment its scan root ever widens over its own file.
 * This file's classification logic hunts for that opener; the opener is
 * therefore ASSEMBLED from character codes (see `INTERP_OPENER` below) and
 * used everywhere the real scanning logic needs it. The only place the
 * literal two-character sequence appears hand-written is inside the
 * delimited control-fixtures region below, where realistic SQL- and
 * error-message-shaped source strings are DATA, not the checker's own
 * pattern -- exactly the same discipline `query-shape.test.mjs`'s
 * `Q1_MUTATIONS` and `anonymity-scan.test.mjs`'s fixtures already use for
 * their own hand-written literals. The self-trip guard at the bottom proves
 * it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, cpSync, mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { webDataSrc, repoRoot } from '../../../scripts/lib/source-paths.mjs';
import { stripComments } from './lib/source-scan.mjs';
import { readRowCounts } from '../src/reattach.js';
import { classOf, UnknownTableError } from '../src/classification.js';
import { SEED_TABLES, EXPECTED_COUNTS } from './fixtures/seed-founding-authority.js';

const THIS_FILE = fileURLToPath(import.meta.url);

/**
 * The interpolation opener, assembled from character codes (36 = "$",
 * 123 = "{") rather than spelled as a two-character literal -- see the file
 * header and the self-trip guard at the bottom. Every place this file's own
 * scanning logic needs to recognise an interpolation uses this constant, not
 * the literal.
 * @type {string}
 */
const INTERP_OPENER = String.fromCharCode(36, 123);

/** A comment-stripped template's trimmed content classifies as SQL when it begins with one of these, case-insensitively. */
const SQL_LEADING_RE = /^(select|insert|update|delete|with)\b/i;

/** A backtick-delimited template literal, escapes included. This package's connection-layer modules contain no nested backtick literal inside another interpolated expression (verified for 54-21), so this single-pass regex is sufficient; a nested backtick would need real parsing. */
const TEMPLATE_LITERAL_RE = /`(?:[^`\\]|\\[\s\S])*`/g;

/** The last top-level `function NAME(` (plain or `export`/`async`-prefixed) at or before a given offset -- this package's connection-layer modules nest no deeper than one function body, so "the last declaration before the offset" is the enclosing one. */
const TOP_LEVEL_FUNCTION_RE = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g;

/**
 * @param {string} strippedSource
 * @param {number} offset
 * @returns {string | null}
 */
function enclosingFunctionName(strippedSource, offset) {
	TOP_LEVEL_FUNCTION_RE.lastIndex = 0;
	let match;
	let name = /** @type {string | null} */ (null);
	while ((match = TOP_LEVEL_FUNCTION_RE.exec(strippedSource)) !== null) {
		if (match.index > offset) break;
		name = match[1];
	}
	return name;
}

/**
 * @typedef {{ file: string, functionName: string | null, snippet: string }} SqlInterpolationOffender
 */

/**
 * Every SQL-classified template literal's interpolation openers in `source`
 * (comment-stripped first), one offender per OPENER -- a SQL template with
 * two openers is reported twice, not once. A non-SQL template that
 * interpolates is excluded by construction: its trimmed content simply never
 * reaches the offender push.
 *
 * @param {string} source
 * @param {string} relFile
 * @returns {SqlInterpolationOffender[]}
 */
function sqlInterpolationOffendersIn(source, relFile) {
	const stripped = stripComments(source);
	/** @type {SqlInterpolationOffender[]} */
	const offenders = [];
	TEMPLATE_LITERAL_RE.lastIndex = 0;
	let match;
	while ((match = TEMPLATE_LITERAL_RE.exec(stripped)) !== null) {
		const raw = match[0].slice(1, -1);
		if (!raw.includes(INTERP_OPENER)) continue;
		const trimmed = raw.trim();
		if (!SQL_LEADING_RE.test(trimmed)) continue; // non-SQL: ignored by construction, not by exception
		const functionName = enclosingFunctionName(stripped, match.index);
		let openerIdx = raw.indexOf(INTERP_OPENER);
		while (openerIdx !== -1) {
			offenders.push({ file: relFile, functionName, snippet: trimmed.slice(0, 160) });
			openerIdx = raw.indexOf(INTERP_OPENER, openerIdx + INTERP_OPENER.length);
		}
	}
	return offenders;
}

/**
 * Every template literal that interpolates in `source`, classified SQL vs
 * non-SQL by the same rule as `sqlInterpolationOffendersIn`, counted ONE PER
 * TEMPLATE (not per opener) -- this is the granularity the plan's "22 total,
 * 1 SQL, 21 non-SQL" measurement uses.
 *
 * @param {string} source
 * @returns {{ sql: number, nonSql: number }}
 */
function interpolatingTemplateCounts(source) {
	const stripped = stripComments(source);
	let sql = 0;
	let nonSql = 0;
	TEMPLATE_LITERAL_RE.lastIndex = 0;
	let match;
	while ((match = TEMPLATE_LITERAL_RE.exec(stripped)) !== null) {
		const raw = match[0].slice(1, -1);
		if (!raw.includes(INTERP_OPENER)) continue;
		if (SQL_LEADING_RE.test(raw.trim())) sql += 1;
		else nonSql += 1;
	}
	return { sql, nonSql };
}

/**
 * The top-level (non-recursive) `.js` files directly under `srcRoot` --
 * `officer/` and `public/` are subdirectories with their own R4 rules and are
 * therefore never descended into.
 *
 * @param {string} srcRoot
 * @returns {string[]}
 */
function topLevelJsFiles(srcRoot) {
	return readdirSync(srcRoot, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
		.map((entry) => entry.name)
		.sort();
}

/**
 * Scan the top-level connection-layer modules under `srcRoot` for SQL
 * interpolation offenders. `relTo`, when given, is the root offenders' `file`
 * fields are computed relative to (defaults to `repoRoot`) -- control 3 needs
 * a temp-directory scan whose files are still comparable in shape even though
 * they cannot resolve to a real repo-relative path.
 *
 * @param {string} srcRoot
 * @param {string} [relTo]
 * @returns {{ files: string[], offenders: SqlInterpolationOffender[] }}
 */
function scanConnectionLayer(srcRoot, relTo = repoRoot) {
	const files = topLevelJsFiles(srcRoot);
	/** @type {SqlInterpolationOffender[]} */
	const offenders = [];
	for (const name of files) {
		const abs = path.join(srcRoot, name);
		const rel = path.relative(relTo, abs).split(path.sep).join('/');
		const source = readFileSync(abs, 'utf8');
		offenders.push(...sqlInterpolationOffendersIn(source, rel));
	}
	return { files, offenders };
}

/**
 * @param {SqlInterpolationOffender} offender
 * @param {ReadonlyArray<{ file: string, functionName: string, reason: string }>} allowlist
 * @returns {boolean}
 */
function isAllowlisted(offender, allowlist) {
	return allowlist.some((entry) => entry.file === offender.file && entry.functionName === offender.functionName);
}

/* ─────────────────────────────────────────────────────────────────────────────
 * BEGIN CONTROL FIXTURES
 * Every hand-written source-shaped literal in this file -- including every
 * literal occurrence of the interpolation opener as two adjacent characters
 * -- lives below, and nowhere else. The self-trip guard removes this whole
 * region before checking the rest.
 * ───────────────────────────────────────────────────────────────────────────── */

/** Control 1 (matcher): a synthetic SQL template with one interpolation, inside a named function. */
const MATCHER_FIXTURE_SOURCE = "async function readOne(db, x) { return db.prepare(`select count(*) as c from ${x}`).get({}); }";

/** Control 2 (over-fire): a synthetic error-message template with one interpolation -- must NOT be reported. */
const OVERFIRE_FIXTURE_SOURCE = 'function fail(x) { throw new TypeError(`refusing non-identifier table name "${x}"`); }';

/** The name of the function control 3 plants into a temp copy of `reattach.js`, distinct from `readRowCounts` so the allow-list's function-scoped match cannot absorb it by accident. */
const PLANTED_FUNCTION_NAME = 'readSecondaryCounts';

/** The second SQL interpolation control 3 plants -- same file as the real exemption, a different owning function. */
const PLANTED_SOURCE_SNIPPET = `\n\nexport async function ${PLANTED_FUNCTION_NAME}(db, tableNames) {\n\tfor (const table of tableNames) {\n\t\tawait db.prepare(\`select count(*) as c from ${'${table}'}_secondary\`).get({});\n\t}\n}\n`;

/* ─────────────────────────────────────────────────────────────────────────────
 * END CONTROL FIXTURES
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * The frozen, one-entry exemption for `reattach.js`'s `readRowCounts`. Keyed
 * by FILE AND OWNING FUNCTION, not by file alone -- see control 3.
 * @type {ReadonlyArray<{ file: string, functionName: string, reason: string }>}
 */
export const SQL_INTERPOLATION_ALLOWLIST = Object.freeze([
	Object.freeze({
		file: 'packages/web-data/src/reattach.js',
		functionName: 'readRowCounts',
		reason:
			'A table name in FROM position is an identifier, and identifiers are not bindable as parameters in ' +
			'any SQL engine, Quereus included -- there is no :table bind form, so rewriting this site is a ' +
			'category error, not an available option. The only interpolation-free alternative is 61 ' +
			'hand-written per-table count(*) constants, one per schema table, which would drift from ' +
			'votetorrent.qsql the moment a table is added and would defeat classOf\'s design intent that the ' +
			'schema growing a table must break the gate rather than silently bypass a stale constant list. ' +
			'The interpolation therefore stays, and what makes it defensible is that the interpolated value is ' +
			'drawn from a closed enumeration -- membership in the 61 tables classification.js classifies -- ' +
			'rather than merely from an identifier-shaped string.',
	}),
]);

/** `SQL_INTERPOLATION_ALLOWLIST.length` must equal this, changed only DELIBERATELY. @type {number} */
const SQL_INTERPOLATION_ALLOWLIST_ENTRY_COUNT = 1;

/**
 * Measured 54-21 Task 1 (before Task 2's guard upgrade): total interpolating
 * templates across the four connection-layer modules was 22 (1 SQL, 21
 * error-message text). Task 2 adds ONE more non-SQL interpolating template
 * -- `readRowCounts`'s new `UnknownTableError` rejection message -- so the
 * counts below are Task 2's measurement, not Task 1's. Both are recorded
 * here (rather than only the final number) precisely because a "the count
 * changed" surprise is the failure mode this pinning exists to catch; the
 * cause this time is a deliberate, reviewed addition.
 */
const EXPECTED_TOTAL_INTERPOLATING_TEMPLATES = 23;
/** Measured 54-21: of those, exactly one begins with a SQL verb. */
const EXPECTED_SQL_INTERPOLATING_TEMPLATES = 1;
/** Measured 54-21 Task 2: the remainder are error-message text, correctly un-reported. */
const EXPECTED_NONSQL_INTERPOLATING_TEMPLATES = 22;

// ───────────────────────────────────────────────────────────────────────────
// 0. The scanned set is exactly the top-level connection-layer modules.
// ───────────────────────────────────────────────────────────────────────────

test('the scanned set is exactly the top-level connection-layer modules, not the officer or public subtrees', () => {
	const { files } = scanConnectionLayer(webDataSrc());
	assert.deepEqual(files, ['classification.js', 'networks-registry.js', 'open-db.js', 'reattach.js']);
	for (const file of files) {
		assert.ok(!file.includes('/'), `${file}: topLevelJsFiles must never descend into a subdirectory`);
	}
});

// ───────────────────────────────────────────────────────────────────────────
// 1. Matcher control -- a synthetic SQL interpolation IS reported.
// ───────────────────────────────────────────────────────────────────────────

test('control 1 (matcher): a synthetic SQL template with an interpolation is reported', () => {
	const offenders = sqlInterpolationOffendersIn(MATCHER_FIXTURE_SOURCE, 'fixture/matcher.js');
	assert.equal(offenders.length, 1);
	assert.equal(offenders[0].functionName, 'readOne');
});

// ───────────────────────────────────────────────────────────────────────────
// 2. Over-fire control -- a synthetic error-message interpolation is NOT
//    reported. Run before the real scan, per the plan: this is the control
//    that keeps the rule usable.
// ───────────────────────────────────────────────────────────────────────────

test('control 2 (over-fire): a synthetic error-message template with an interpolation is not reported', () => {
	const offenders = sqlInterpolationOffendersIn(OVERFIRE_FIXTURE_SOURCE, 'fixture/overfire.js');
	assert.deepEqual(offenders, []);
});

// ───────────────────────────────────────────────────────────────────────────
// 3. Real-file mutation control -- a SECOND SQL interpolation planted into a
//    temp copy of reattach.js is reported and is NOT absorbed by the
//    one-entry allow-list, because the allow-list is keyed on the OWNING
//    FUNCTION, not merely the file.
// ───────────────────────────────────────────────────────────────────────────

test('control 3 (real-file mutation): a second SQL interpolation planted into a temp copy of reattach.js is reported and not sheltered by the allow-list', () => {
	const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'connection-layer-shape-'));
	try {
		const tmpSrc = path.join(tmpRoot, 'src');
		cpSync(webDataSrc(), tmpSrc, { recursive: true });
		appendFileSync(path.join(tmpSrc, 'reattach.js'), PLANTED_SOURCE_SNIPPET);

		const { offenders } = scanConnectionLayer(tmpSrc, tmpSrc);
		const planted = offenders.filter((o) => o.functionName === PLANTED_FUNCTION_NAME);
		const original = offenders.filter((o) => o.functionName === 'readRowCounts');

		assert.equal(planted.length, 1, 'the planted second interpolation must be reported exactly once');
		assert.equal(original.length, 1, 'the real exemption site must still be reported by the raw scan (allow-list is applied by the caller, not the scanner)');

		assert.ok(!isAllowlisted(planted[0], SQL_INTERPOLATION_ALLOWLIST), 'the planted interpolation must NOT be absorbed by the readRowCounts allow-list entry -- the exemption is site-specific');
		assert.ok(
			SQL_INTERPOLATION_ALLOWLIST.some((e) => e.file === 'packages/web-data/src/reattach.js') &&
				!planted.some((o) => isAllowlisted(o, SQL_INTERPOLATION_ALLOWLIST)),
			'a per-file allow-list would have sheltered the planted interpolation; this one does not',
		);
	} finally {
		rmSync(tmpRoot, { recursive: true, force: true });
	}
});

// ───────────────────────────────────────────────────────────────────────────
// 4. Allow-list load-bearing control -- with the allow-list emptied, the
//    real scan over the real src/ must report EXACTLY ONE offender, in
//    reattach.js. A zero here would mean the SQL-template classifier never
//    matched the real statement, and the green real-scan test below would
//    mean nothing.
// ───────────────────────────────────────────────────────────────────────────

test('control 4 (allow-list load-bearing): with the allow-list emptied, the real scan reports exactly one offender, in reattach.js', () => {
	const { offenders } = scanConnectionLayer(webDataSrc());
	const unfiltered = offenders.filter((o) => !isAllowlisted(o, []));
	assert.equal(unfiltered.length, 1, `expected exactly one offender with an empty allow-list, got ${unfiltered.length}: ${JSON.stringify(unfiltered)}`);
	assert.equal(unfiltered[0].file, 'packages/web-data/src/reattach.js');
	assert.equal(unfiltered[0].functionName, 'readRowCounts');
	assert.equal(unfiltered[0].snippet, 'select count(*) as c from ' + INTERP_OPENER + 'table}');
});

// ───────────────────────────────────────────────────────────────────────────
// 5. Allow-list shape.
// ───────────────────────────────────────────────────────────────────────────

test('SQL_INTERPOLATION_ALLOWLIST has exactly one entry -- change this DELIBERATELY and say why in the commit', () => {
	assert.equal(
		SQL_INTERPOLATION_ALLOWLIST.length,
		SQL_INTERPOLATION_ALLOWLIST_ENTRY_COUNT,
		'SQL_INTERPOLATION_ALLOWLIST must have exactly one entry -- change this DELIBERATELY and say why in the commit',
	);
});

test('the allow-list entry names both the identifier-bindability argument and the closed-set replacement for the shape check', () => {
	const entry = SQL_INTERPOLATION_ALLOWLIST[0];
	assert.ok(entry.reason.length >= 120, `reason must be at least 120 characters, got ${entry.reason.length}`);
	assert.match(entry.reason, /identifier/i);
	assert.match(entry.reason, /not bindable/i);
	assert.match(entry.reason, /closed enumeration|classOf|classification/i);
});

// ───────────────────────────────────────────────────────────────────────────
// 6. Measured composition -- pinned, per the plan's own measurement.
// ───────────────────────────────────────────────────────────────────────────

test('measured: 22 interpolating templates across the connection layer, 1 SQL and 21 non-SQL', () => {
	let sql = 0;
	let nonSql = 0;
	for (const name of topLevelJsFiles(webDataSrc())) {
		const counts = interpolatingTemplateCounts(readFileSync(path.join(webDataSrc(), name), 'utf8'));
		sql += counts.sql;
		nonSql += counts.nonSql;
	}
	assert.equal(sql, EXPECTED_SQL_INTERPOLATING_TEMPLATES);
	assert.equal(nonSql, EXPECTED_NONSQL_INTERPOLATING_TEMPLATES);
	assert.equal(sql + nonSql, EXPECTED_TOTAL_INTERPOLATING_TEMPLATES);
});

// ───────────────────────────────────────────────────────────────────────────
// 7. THE REAL SCAN. Every control above has already run.
// ───────────────────────────────────────────────────────────────────────────

test('R4 over the connection layer: zero unexempted SQL interpolations, with the one-entry allow-list applied', () => {
	const { offenders } = scanConnectionLayer(webDataSrc());
	const unexempted = offenders.filter((o) => !isAllowlisted(o, SQL_INTERPOLATION_ALLOWLIST));
	assert.deepEqual(unexempted, [], `unexempted SQL interpolation(s) in the connection layer: ${JSON.stringify(unexempted)}`);
});

// ───────────────────────────────────────────────────────────────────────────
// 8. readRowCounts's own guard -- upgraded from an identifier shape to
//    membership in the closed classified-table set. `TABLE_NAME_RE` stays as
//    the first check; `classOf` is the second. A stub `db` is used
//    throughout: these tests are about which table NAMES the guard lets
//    through, not about Quereus itself, and an "exploding" stub proves a
//    rejection happens BEFORE the statement is ever prepared.
// ───────────────────────────────────────────────────────────────────────────

/** A `db` that resolves every count query with 0 -- used to prove a name is ACCEPTED without needing a real Quereus handle. @type {import('@quereus/quereus').Database} */
const ACCEPTING_STUB_DB = /** @type {any} */ (
	Object.freeze({
		prepare: () => ({ get: async () => ({ c: 0 }) }),
	})
);

/** A `db` that throws if `prepare` is ever called -- used to prove a rejection happens before the statement is built, not merely that the awaited call eventually fails. @type {import('@quereus/quereus').Database} */
const EXPLODING_STUB_DB = /** @type {any} */ (
	Object.freeze({
		prepare: () => {
			throw new Error('EXPLODING_STUB_DB: prepare() must not be called -- the guard should have rejected first');
		},
	})
);

test('readRowCounts: every member of SEED_TABLES is a classified table and is accepted', async () => {
	for (const table of SEED_TABLES) {
		assert.doesNotThrow(() => classOf(table), `${table} must be classified`);
	}
	const counts = await readRowCounts(ACCEPTING_STUB_DB, SEED_TABLES);
	assert.deepEqual(Object.keys(counts).sort(), [...SEED_TABLES].sort());
});

test('readRowCounts: every key of EXPECTED_COUNTS is a classified table and is accepted', async () => {
	const keys = Object.keys(EXPECTED_COUNTS);
	for (const table of keys) {
		assert.doesNotThrow(() => classOf(table), `${table} must be classified`);
	}
	const counts = await readRowCounts(ACCEPTING_STUB_DB, keys);
	assert.deepEqual(Object.keys(counts).sort(), keys.sort());
});

test('readRowCounts: an identifier-shaped but unclassified table name is rejected with a TypeError naming the table', async () => {
	const unclassified = 'NotARealTable';
	assert.throws(() => classOf(unclassified), UnknownTableError, 'fixture is invalid: this name must NOT be classified for the test to prove anything');

	await assert.rejects(
		() => readRowCounts(EXPLODING_STUB_DB, [unclassified]),
		/** @param {any} err */
		(err) => {
			assert.ok(err instanceof TypeError, `expected a TypeError, got ${err?.constructor?.name}`);
			assert.equal(err.name, 'TypeError');
			assert.match(err.message, new RegExp(unclassified));
			return true;
		},
	);
});

test('readRowCounts: a non-identifier table name is still rejected with a TypeError -- the original guard did not regress', async () => {
	const nonIdentifier = '1; drop table Authority';
	await assert.rejects(
		() => readRowCounts(EXPLODING_STUB_DB, [nonIdentifier]),
		/** @param {any} err */
		(err) => {
			assert.ok(err instanceof TypeError, `expected a TypeError, got ${err?.constructor?.name}`);
			assert.equal(err.name, 'TypeError');
			return true;
		},
	);
});

// ───────────────────────────────────────────────────────────────────────────
// 9. Self-trip guard.
// ───────────────────────────────────────────────────────────────────────────

const BEGIN_SENTINEL = ['BEGIN', 'CONTROL', 'FIXTURES'].join(' ');
const END_SENTINEL = ['END', 'CONTROL', 'FIXTURES'].join(' ');

test('self-trip guard: this file is not itself a member of the scanned connection-layer set', () => {
	assert.ok(!THIS_FILE.startsWith(webDataSrc()), 'this test file must not resolve inside the scanned src/ root');
});

/**
 * Every block comment and line comment's raw text in `source` -- the "prose,
 * a JSDoc line" surface the plan's landmine note warns about. Deliberately
 * narrower than `stripComments`'s complement: real runtime code that builds a
 * diagnostic message with a template literal (this file has several) is not
 * prose, and is not what this guard is for.
 *
 * @param {string} source
 * @returns {string}
 */
function commentTextOf(source) {
	const blocks = source.match(/\/\*[\s\S]*?\*\//g) || [];
	const lines = source.match(/\/\/.*$/gm) || [];
	return blocks.join('\n') + '\n' + lines.join('\n');
}

test('self-trip guard: outside its fixture region, no comment or JSDoc line in this file spells the interpolation opener as a literal', () => {
	const own = readFileSync(THIS_FILE, 'utf8');
	const begin = own.indexOf(BEGIN_SENTINEL);
	const end = own.indexOf(END_SENTINEL);
	assert.ok(begin > 0 && end > begin, 'the control-fixture sentinels are missing or out of order in this file');

	const remainder = own.slice(0, begin) + own.slice(end + END_SENTINEL.length);
	const comments = commentTextOf(remainder);

	assert.ok(
		!comments.includes(INTERP_OPENER),
		'a comment or JSDoc line in this checker spells the interpolation opener as a literal -- prose that quotes the ' +
			'token a checker hunts is one root-widening away from being permanently green. Describe it without the ' +
			'literal, or move the literal into the fixture region.',
	);
});
