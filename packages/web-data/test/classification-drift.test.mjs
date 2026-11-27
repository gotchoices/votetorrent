/**
 * classification-drift.test.mjs — D-15's single-source discipline, and 54-06's
 * explicitly unowned hand-off (b): the classification must EQUAL the schema, and
 * there must be exactly one classification.
 *
 * WHY A BUILD-TIME ASSERTION WHEN `classOf` ALREADY THROWS. `classOf` fires only
 * when some module NAMES the new table. An unclassified table is therefore
 * invisible until someone reads it — precisely the moment it is least welcome,
 * because by then a query exists and the pressure is to classify the table
 * whatever way unblocks the query. This assertion fires on the SCHEMA EDIT, when
 * the only question on the table is "what is this row, and who may see it?".
 * `classOf`'s runtime throw stays as defence in depth.
 *
 * FOUR RULES:
 *   C1  the parsed `table` declarations equal `CLASSIFICATION`'s keys in both
 *       directions; the parsed `view` declarations are counted and asserted
 *       DISJOINT from the classification (views are static literal unions,
 *       deliberately unclassified, which is why no public read joins one).
 *   C2  no SECOND table-classification list is DECLARED anywhere in product
 *       source. Declaration position specifically — an import of the real one
 *       is legitimate and is the discrimination control.
 *   C3  `packages/ui-web/src/lifecycle/facts.js` carries no table LIST
 *       (54-ISSUES I-04 / 54-RESEARCH Pitfall 7).
 *   C4  every `TABLES_READ` declared under `packages/web-data/src/` resolves
 *       through `classOf`, so a typo'd or renamed table fails at gate time
 *       rather than at read time.
 *
 * WHAT THIS GATE CANNOT PROVE: it compares NAMES. It says nothing about whether
 * a table's assigned CLASS is the right one — that judgement lives in the `why`
 * text of each `CLASSIFICATION` entry and is reviewed by a human, not asserted
 * here. It also parses the schema with an anchored per-line matcher rather than
 * a real SQL parser; a `table` declaration written across two lines would be
 * missed, which is why the parsed COUNT is pinned as well as the set.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { uiWebSrc, webDataSrc, workspacePath } from '../../../scripts/lib/source-paths.mjs';
import { CLASSIFICATION, classOf } from '../src/classification.js';
import { partitionByExtension, stripComments, stripSqlComments, walkSourceFiles } from './lib/source-scan.mjs';

const SCHEMA_PATH = workspacePath('packages/vote-core', 'schema', 'votetorrent.qsql');
const CLASSIFICATION_FILE = webDataSrc('classification.js');
/**
 * 54-04 landed the fact/gap model at `packages/ui-web/src/lifecycle/facts.js`.
 * Resolved through `uiWebSrc` rather than by `import.meta.url` arithmetic; if a
 * later plan moves it, change this call argument, not a derivation.
 */
const FACTS_FILE = uiWebSrc('lifecycle', 'facts.js');

const EXPECTED_TABLE_COUNT = 77; // 62-02 adds 4 keyholder DKG/key-loop tables; the vote-block schema adds 2; the officer tally adds 1 and the dashboard pairing revocation adds 1; and the administration-change cancellation adds 1
const EXPECTED_VIEW_COUNT = 22;

const THIS_FILE = fileURLToPath(import.meta.url);
const BEGIN_SENTINEL = ['BEGIN', 'CONTROL', 'FIXTURES'].join(' ');
const END_SENTINEL = ['END', 'CONTROL', 'FIXTURES'].join(' ');

/**
 * The identifiers a SECOND table-classification list would be bound to. ASSEMBLED
 * rather than written, so this file's own source does not carry the literals it
 * hunts — the failure this phase has recorded six times. (This file is not under
 * any root C2 scans, and a guard below asserts that too, but the assembly costs
 * nothing and removes the question.)
 * @type {ReadonlyArray<string>}
 */
const SECOND_LIST_IDENTIFIERS = Object.freeze([
	['ALLOWED', 'TABLES'].join('_'),
	['FORBIDDEN', 'TABLES'].join('_'),
	['PUBLIC', 'TABLES'].join('_'),
	['TABLE', 'CLASSES'].join('_'),
	['CLASSI', 'FICATION'].join(''),
]);

/** Matches only a BINDING of one of those names — never an import of it. */
const SECOND_LIST_RE = new RegExp(
	String.raw`(?:^|[^.\w])(?:export\s+)?(?:const|let|var)\s+(${SECOND_LIST_IDENTIFIERS.join('|')})\b`,
);

/* ─────────────────────────────────────────────────────────────────────────────
 * BEGIN CONTROL FIXTURES
 * The only hand-written schema-name and identifier literals in this file.
 * ───────────────────────────────────────────────────────────────────────────── */

/** A synthetic schema carrying one extra table and one extra view the real file does not have. */
const SYNTHETIC_SCHEMA = [
	'declare schema main',
	'{',
	"\tview ElectionType as select 'o' as Code, 'Official' as Name;",
	'\tview GhostView as select 1 as X;',
	'\ttable Election (Id text);',
	'\ttable GhostTable (Id text);',
	'\t-- table CommentedGhost (Id text);',
	'}',
].join('\n');
/** Names the synthetic-schema control expects the parser to find. */
const SYNTHETIC_EXPECTED_TABLES = Object.freeze(['Election', 'GhostTable']);
const SYNTHETIC_EXPECTED_VIEWS = Object.freeze(['ElectionType', 'GhostView']);
/** The table declaration that is COMMENTED OUT and must not be counted. */
const SYNTHETIC_COMMENTED_TABLE = 'CommentedGhost';

/** Fixtures for rule C2. */
const C2_VIOLATION_FIXTURES = Object.freeze([
	['exported const array', `export const FORBIDDEN_TABLES = ['RegistrantPrivate'];`],
	['plain const object', `const TABLE_CLASSES = { Election: 'PUBLIC' };`],
	['let binding', `let ALLOWED_TABLES = [];`],
	['a second CLASSIFICATION map', `export const CLASSIFICATION = { Election: ['PUBLIC'] };`],
]);
/** Fixtures for rule C2 that must NOT fire — import position is legitimate. */
const C2_BENIGN_FIXTURES = Object.freeze([
	['named import of the real classification', `import { CLASSIFICATION, classOf } from '../classification.js';`],
	['re-export of the real classification', `export { CLASSIFICATION } from './classification.js';`],
	['a property access', `const cls = policy.CLASSIFICATION;`],
	['a comment discussing a second list', `// do not reintroduce a FORBIDDEN_TABLES array here`],
]);

/** Fixtures for rule C3. A classified table name on a non-provenance line must fire. */
const C3_VIOLATION_FIXTURES = Object.freeze([
	['an array of table names', `const tables = ['RegistrantPublic', 'ElectionRegistrant'];`],
	['an object keyed by table name', `const byTable = { RegistrantPublic: 1 };`],
	['a renderable copy key naming a table', `labelKey: 'public.RegistrantPublic.heading',`],
]);
/** The provenance shape that is legitimate and must NOT fire. */
const C3_BENIGN_FIXTURE = `\t\tsource: 'RegistrantPublic (LastName, FirstName, District only)',`;

/** A table name the classification cannot know, for rule C4's control. */
const C4_UNKNOWN_TABLE = 'Tally';

/* ─────────────────────────────────────────────────────────────────────────────
 * END CONTROL FIXTURES
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Parse `table NAME (` and `view NAME as` declarations from a schema, with `--`
 * comments stripped first and an ANCHORED per-line matcher.
 *
 * @param {string} schemaText
 * @returns {{ tables: string[], views: string[], duplicateTables: string[] }}
 */
function parseSchemaDeclarations(schemaText) {
	const lines = stripSqlComments(schemaText).split('\n');
	/** @type {string[]} */
	const tables = [];
	/** @type {string[]} */
	const views = [];
	/** @type {string[]} */
	const duplicateTables = [];
	for (const line of lines) {
		const t = /^\s*table\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
		if (t) {
			if (tables.includes(t[1])) duplicateTables.push(t[1]);
			tables.push(t[1]);
			continue;
		}
		const v = /^\s*view\s+([A-Za-z_][A-Za-z0-9_]*)\s+as\b/.exec(line);
		if (v) views.push(v[1]);
	}
	return { tables, views, duplicateTables };
}

/**
 * Every `src` directory under `apps` and under `packages`, discovered by
 * LISTING rather than hard-coded, so a new workspace member is covered by rule
 * C2 the moment it exists.
 */
function productSourceRoots() {
	/** @type {string[]} */
	const roots = [];
	for (const group of ['apps', 'packages']) {
		const groupDir = workspacePath(group);
		if (!existsSync(groupDir)) continue;
		for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const src = path.join(groupDir, entry.name, 'src');
			if (existsSync(src)) roots.push(src);
		}
	}
	assert.ok(roots.length >= 5, `product-source discovery found only ${roots.length} roots; the discovery is broken, not the tree`);
	return roots.sort();
}

/**
 * Rule C2 applied to one source text.
 * @param {string} source
 * @returns {string | null} the matched identifier, or null
 */
function secondListDeclaration(source) {
	const m = SECOND_LIST_RE.exec(stripComments(source));
	return m ? m[1] : null;
}

// ───────────────────────────────────────────────────────────────────────────
// C1 controls, run first.
// ───────────────────────────────────────────────────────────────────────────

test('control C1 (parser is live): a synthetic schema reports its planted extra table and extra view', () => {
	const parsed = parseSchemaDeclarations(SYNTHETIC_SCHEMA);
	assert.deepEqual(parsed.tables, [...SYNTHETIC_EXPECTED_TABLES], 'the table parser did not read the synthetic schema as written');
	assert.deepEqual(parsed.views, [...SYNTHETIC_EXPECTED_VIEWS], 'the view parser did not read the synthetic schema as written');

	// The comparison, not just the parser, must be live: run the real comparison
	// shape against the synthetic parse and confirm it reports BOTH plants.
	const classified = new Set(Object.keys(CLASSIFICATION));
	const unclassified = parsed.tables.filter((t) => !classified.has(t));
	assert.deepEqual(
		unclassified,
		['GhostTable'],
		'the set comparison is inert — a table present in the schema and absent from the classification was not reported',
	);
	const viewsClassified = parsed.views.filter((v) => classified.has(v));
	assert.deepEqual(viewsClassified, [], 'a synthetic view was found in the classification; the disjointness check reads the wrong set');
	assert.ok(
		parsed.views.includes('GhostView'),
		'the planted extra view was not reported, so the view half of this rule proves nothing',
	);
});

test('control C1 (comment stripping): a commented-out table declaration is not counted', () => {
	const parsed = parseSchemaDeclarations(SYNTHETIC_SCHEMA);
	assert.ok(
		!parsed.tables.includes(SYNTHETIC_COMMENTED_TABLE),
		'a `-- table X (` line was counted as a declaration; comment stripping is not doing work in this parser',
	);
	// And the real schema contains a prose line beginning `-- table …`, so this is
	// not a hypothetical: strip it wrong and the real count moves.
	const rawHasCommentedTableProse = /^\s*--\s*table\s/m.test(readFileSync(SCHEMA_PATH, 'utf8'));
	assert.ok(rawHasCommentedTableProse, 'the real schema no longer carries a commented `table` line; this control lost its subject');
});

// ───────────────────────────────────────────────────────────────────────────
// C1 — the real drift assertion.
// ───────────────────────────────────────────────────────────────────────────

test('C1 (D-15): CLASSIFICATION\'s key set equals the table declarations parsed live from votetorrent.qsql', () => {
	const parsed = parseSchemaDeclarations(readFileSync(SCHEMA_PATH, 'utf8'));

	assert.deepEqual(parsed.duplicateTables, [], `votetorrent.qsql declares a table name twice: ${parsed.duplicateTables.join(', ')}`);

	// THE SET DIFFERENCE IS ASSERTED BEFORE THE COUNT, deliberately. A count
	// mismatch tells a reader that something moved; the set difference tells them
	// WHICH TABLE, which is the only part they can act on. Asserting the count
	// first would mask the name behind "62 !== 61".
	const schemaSet = new Set(parsed.tables);
	const classifiedSet = new Set(Object.keys(CLASSIFICATION));
	const unclassified = [...schemaSet].filter((t) => !classifiedSet.has(t)).sort();
	const orphaned = [...classifiedSet].filter((t) => !schemaSet.has(t)).sort();

	assert.deepEqual(
		unclassified,
		[],
		`votetorrent.qsql declares ${unclassified.length} table(s) the classification does not know: ${unclassified.join(', ')}. ` +
			'Classify each one DELIBERATELY in packages/web-data/src/classification.js — with a `why` a reviewer can argue with. ' +
			'Never silence this by removing the table from the parse.',
	);
	assert.deepEqual(
		orphaned,
		[],
		`the classification names ${orphaned.length} table(s) the schema no longer declares: ${orphaned.join(', ')}. ` +
			'A stale entry is a permission granted to a table nobody can point at; remove it.',
	);

	// The count is pinned SEPARATELY, after the sets agree, because the anchored
	// per-line parser could stop matching a declaration shape (one reflowed
	// across two lines) and produce two sets that agree on nothing at all.
	assert.equal(
		parsed.tables.length,
		EXPECTED_TABLE_COUNT,
		`the schema parsed to ${parsed.tables.length} table declarations, not ${EXPECTED_TABLE_COUNT}. Either the schema grew ` +
			'(classify the new table, then update this number in the same commit) or the anchored parser stopped matching a ' +
			'declaration shape — check for a declaration reflowed across lines.',
	);
});

test('C1 (D-15): the schema\'s views are counted and are disjoint from the classification', () => {
	const parsed = parseSchemaDeclarations(readFileSync(SCHEMA_PATH, 'utf8'));
	assert.equal(
		parsed.views.length,
		EXPECTED_VIEW_COUNT,
		`the schema parsed to ${parsed.views.length} view declarations, not ${EXPECTED_VIEW_COUNT}`,
	);
	const classifiedSet = new Set(Object.keys(CLASSIFICATION));
	const misfiled = parsed.views.filter((v) => classifiedSet.has(v)).sort();
	assert.deepEqual(
		misfiled,
		[],
		`the classification names ${misfiled.join(', ')}, which the schema declares as a VIEW, not a table. Views are static ` +
			'literal unions and are deliberately unclassified — 54-06\'s read-election.js declines to join one for exactly this ' +
			'reason (a view name in TABLES_READ is an UnknownTableError on a legitimate read).',
	);
});

// ───────────────────────────────────────────────────────────────────────────
// C2 controls and rule.
// ───────────────────────────────────────────────────────────────────────────

test('control C2 (positive): a second table-classification list in declaration position is rejected', () => {
	for (const [label, fixture] of C2_VIOLATION_FIXTURES) {
		assert.ok(
			secondListDeclaration(fixture) !== null,
			`rule C2 is inert for the "${label}" fixture — a second table list of that shape would go undetected`,
		);
	}
});

test('control C2 (discrimination): importing or re-exporting the real classification is legitimate', () => {
	for (const [label, fixture] of C2_BENIGN_FIXTURES) {
		assert.equal(
			secondListDeclaration(fixture),
			null,
			`rule C2 over-fires: the "${label}" fixture was rejected. The rule must match a BINDING, not any mention.`,
		);
	}
});

test('control C2 (inertness of the exclusion): the matcher DOES fire on the real classification.js', () => {
	assert.ok(
		secondListDeclaration(readFileSync(CLASSIFICATION_FILE, 'utf8')) !== null,
		'the matcher does not fire on the one file that legitimately declares the list. The real run below would then be green ' +
			'because the matcher is blind, not because the single exclusion is doing the work.',
	);
});

test('control C2 (extension partition): a raw-error *.fixture.txt and a named *-LICENSE.txt are non-code, any other .txt stays unknown', () => {
	const part = partitionByExtension([
		path.join('r', 'n01-instanceof-ternary.fixture.txt'),
		path.join('r', 'FINGERPRINT-ATLAS-LICENSE.txt'),
		path.join('r', 'notes.txt'),
		path.join('r', '.fixture.txt'),
		path.join('r', 'n01.fixture.txt.bak'),
		path.join('r', 'LICENSE.txt'),
		path.join('r', '-license.txt'),
		path.join('r', 'ATLAS-LICENSE.txt.bak'),
	]);
	assert.deepEqual(
		part.skipped,
		[path.join('r', 'n01-instanceof-ternary.fixture.txt'), path.join('r', 'FINGERPRINT-ATLAS-LICENSE.txt')],
		'a *.fixture.txt or a named *-LICENSE.txt was not classified non-code',
	);
	assert.deepEqual(
		part.unknown,
		[
			path.join('r', 'notes.txt'),
			path.join('r', '.fixture.txt'),
			path.join('r', 'n01.fixture.txt.bak'),
			path.join('r', 'LICENSE.txt'),
			path.join('r', '-license.txt'),
			path.join('r', 'ATLAS-LICENSE.txt.bak'),
		],
		'a .txt that is not a named *.fixture.txt or *-LICENSE.txt left the unknown bucket; the walker no longer fails closed on it',
	);
	// Positive anchors: the real files exist under a product src root and are the ones skipped.
	const rawErrorDir = workspacePath('apps', 'VoteTorrentAuthority', 'src', 'screens', '__tests__', '__fixtures__', 'raw-error');
	const real = partitionByExtension(walkSourceFiles(rawErrorDir));
	assert.ok(real.skipped.length > 0, 'no raw-error *.fixture.txt was found; this control no longer covers the files it was written for');
	assert.deepEqual(real.unknown, [], `the raw-error fixtures did not all classify: ${real.unknown.join(', ')}`);
	const qrDir = workspacePath('apps', 'VoteTorrentAuthority', 'src', 'utils', 'qr');
	const qr = partitionByExtension(walkSourceFiles(qrDir));
	assert.ok(
		qr.skipped.some((file) => path.basename(file) === 'FINGERPRINT-ATLAS-LICENSE.txt'),
		'the fingerprint atlas licence was not found and skipped; this control no longer covers the file it was written for',
	);
	assert.deepEqual(qr.unknown, [], `the qr dir did not all classify: ${qr.unknown.join(', ')}`);
});

test('C2 (D-15): no second table-classification list is declared anywhere in product source', () => {
	/** @type {string[]} */
	const offenders = [];
	let scannedCount = 0;
	for (const root of productSourceRoots()) {
		const part = partitionByExtension(walkSourceFiles(root));
		assert.deepEqual(part.unknown, [], `${root} holds files with an unclassified extension: ${part.unknown.join(', ')}`);
		for (const file of part.scanned) {
			if (file === CLASSIFICATION_FILE) continue; // the SOLE exclusion — the one real list
			scannedCount += 1;
			const hit = secondListDeclaration(readFileSync(file, 'utf8'));
			if (hit) offenders.push(`${file}: declares ${hit}`);
		}
	}
	assert.ok(scannedCount > 100, `only ${scannedCount} product source files were scanned; the discovery walk is broken`);
	assert.deepEqual(
		offenders,
		[],
		'a second table-classification list exists. D-15\'s "no allowlist to rot" rationale is defeated the moment two lists ' +
			'disagree — spike 088 shipped one that still forbade the published voter roll and omitted both key-release tables. ' +
			'Import packages/web-data/src/classification.js instead.',
	);
});

// ───────────────────────────────────────────────────────────────────────────
// C3 — facts.js carries no table LIST (I-04 / Pitfall 7).
// ───────────────────────────────────────────────────────────────────────────

/**
 * Rule C3's line predicate. A classified table name may appear in `facts.js`
 * ONLY inside a `source:` provenance string.
 *
 * WHY THIS SHAPE RATHER THAN "ZERO OCCURRENCES". 54-04 landed `facts.js` WITH
 * provenance strings — `source: 'Task ⋈ ReleaseKeyTaskExtension (…)'` and eight
 * others — which name the schema tables a fact is derived from. Those are a
 * non-renderable annotation for a code reader (facts.js's own header, point 4,
 * says only `labelKey`/`sentenceKey`/`detailKey`/`emptyKey` render), and they
 * are not a list anything can read. Asserting "zero occurrences" would be
 * asserting something false about the landed tree, and the way that gets
 * "fixed" is by deleting the provenance — losing information to satisfy a rule
 * that was aimed at something else. What I-04 and Pitfall 7 actually forbid is a
 * SECOND LIST: an array or a keyed object of table names that can disagree with
 * the classification. That is what this asserts, plus the stronger point that no
 * RENDERABLE key may name a table.
 *
 * @param {string} line
 * @returns {boolean} true when the line is a legitimate provenance annotation
 */
function isProvenanceLine(line) {
	return /^\s*source:\s*['"`]/.test(line);
}

test('control C3 (positive and discrimination): a table name outside a provenance string fires; inside one it does not', () => {
	const names = Object.keys(CLASSIFICATION);
	for (const [label, fixture] of C3_VIOLATION_FIXTURES) {
		const named = names.filter((n) => new RegExp(`\\b${n}\\b`).test(fixture));
		assert.ok(named.length > 0, `the "${label}" fixture names no classified table; it cannot control anything`);
		assert.ok(
			!isProvenanceLine(fixture),
			`rule C3 is inert for the "${label}" fixture — it was accepted as a provenance line, so a real second list of that shape would pass`,
		);
	}
	assert.ok(
		isProvenanceLine(C3_BENIGN_FIXTURE),
		'rule C3 over-fires: the provenance shape 54-04 actually landed was rejected, which would force deleting real information to go green',
	);
});

test('C3 (I-04 / Pitfall 7): facts.js declares no table list, and every table name it holds is provenance only', () => {
	const raw = readFileSync(FACTS_FILE, 'utf8');
	const code = stripComments(raw);

	// (a) No second-list binding, and none of spike 088's identifiers survive.
	assert.equal(
		secondListDeclaration(raw),
		null,
		'facts.js declares a table list again. 088\'s ALLOWED/FORBIDDEN arrays still forbade the published voter roll and omitted ' +
			'both key-release tables; 54-04 dropped them on purpose.',
	);
	// The header DISCUSSES those identifiers, so the raw file contains them and
	// the comment-stripped file must not. That difference is the proof that
	// comment stripping is doing real work here rather than being decorative.
	assert.ok(/ALLOWED_TABLES|FORBIDDEN_TABLES/.test(raw), 'facts.js no longer explains why it carries no table list; this control lost its subject');
	assert.ok(
		!/ALLOWED_TABLES|FORBIDDEN_TABLES/.test(code),
		'a spike-088 table-list identifier survives comment stripping in facts.js — it is code, not prose, and it is a second list',
	);

	// (b) Every classified table name in CODE position sits on a provenance line.
	const names = Object.keys(CLASSIFICATION);
	/** @type {string[]} */
	const offenders = [];
	const lines = code.split('\n');
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		const named = names.filter((n) => new RegExp(`\\b${n}\\b`).test(line));
		if (named.length === 0) continue;
		if (isProvenanceLine(line)) continue;
		offenders.push(`${FACTS_FILE}:${i + 1} names ${named.join(', ')} outside a provenance string :: ${line.trim()}`);
	}
	assert.deepEqual(
		offenders,
		[],
		'facts.js names a schema table somewhere other than a `source:` provenance string — an array member, an object key or a ' +
			'renderable copy key. Any of those is a second table list by another spelling.',
	);

	// (c) The control is not vacuous: facts.js DOES carry provenance strings, so
	//     the predicate above is exercised by the real file rather than skipped.
	assert.ok(
		lines.filter(isProvenanceLine).some((l) => names.some((n) => new RegExp(`\\b${n}\\b`).test(l))),
		'facts.js contains no provenance line naming a classified table, so rule C3(b) never ran against real content',
	);

	// (d) No RENDERABLE key names a table. This is the part that would actually
	//     put an internal schema identifier on an anonymous reader's screen.
	/** @type {string[]} */
	const renderable = [];
	for (let i = 0; i < lines.length; i += 1) {
		if (!/^\s*(labelKey|sentenceKey|detailKey|emptyKey)\s*:/.test(lines[i])) continue;
		const named = names.filter((n) => new RegExp(`\\b${n}\\b`).test(lines[i]));
		if (named.length > 0) renderable.push(`${FACTS_FILE}:${i + 1} :: ${lines[i].trim()}`);
	}
	assert.deepEqual(renderable, [], 'a renderable copy key in facts.js names a schema table');
});

// ───────────────────────────────────────────────────────────────────────────
// C4 — every declared TABLES_READ resolves.
// ───────────────────────────────────────────────────────────────────────────

test('control C4: classOf throws on a table the classification does not know', () => {
	assert.throws(
		() => classOf(C4_UNKNOWN_TABLE),
		/UnknownTableError/,
		'classOf accepted an unclassified table name; C4 below would then prove nothing',
	);
});

test('C4: every TABLES_READ declared under packages/web-data/src resolves through classOf', async () => {
	const files = partitionByExtension(walkSourceFiles(webDataSrc())).scanned;
	let modulesWithTablesRead = 0;
	let tablesChecked = 0;
	for (const file of files) {
		const mod = await import(pathToFileURL(file).href);
		if (!Array.isArray(mod.TABLES_READ)) continue;
		modulesWithTablesRead += 1;
		for (const table of mod.TABLES_READ) {
			assert.doesNotThrow(
				() => classOf(table),
				`${file} declares table "${table}", which the classification does not know. A typo or a rename must fail HERE, ` +
					'at gate time, not at read time on somebody\'s screen.',
			);
			tablesChecked += 1;
		}
	}
	assert.ok(
		modulesWithTablesRead >= 4,
		`only ${modulesWithTablesRead} module(s) under src/ export a TABLES_READ; the discovery walk is broken (54-06 landed at least four)`,
	);
	assert.ok(tablesChecked > 0, 'no table names were checked — every discovered TABLES_READ was empty');
});

// ───────────────────────────────────────────────────────────────────────────
// Self-trip guards.
// ───────────────────────────────────────────────────────────────────────────

test('self-trip guard: rule C2\'s own matcher reports nothing in this file outside the fixture region', () => {
	const own = readFileSync(THIS_FILE, 'utf8');
	const begin = own.indexOf(BEGIN_SENTINEL);
	const end = own.indexOf(END_SENTINEL);
	assert.ok(begin > 0 && end > begin, 'the control-fixture sentinels are missing or out of order in this file');
	const remainder = own.slice(0, begin) + own.slice(end + END_SENTINEL.length);
	assert.equal(
		secondListDeclaration(remainder),
		null,
		'this checker declares one of the very bindings it hunts, outside its fixture region',
	);
});

test('self-trip guard: this test file is not inside any product source root C2 scans', () => {
	for (const root of productSourceRoots()) {
		assert.ok(!THIS_FILE.startsWith(`${root}${path.sep}`), `this test file lives inside ${root} and would scan its own fixtures`);
	}
});
