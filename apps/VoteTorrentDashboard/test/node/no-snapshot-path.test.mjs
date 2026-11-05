/**
 * no-snapshot-path.test.mjs -- the dashboard's snapshot path stays gone (D-16, D-02, R-6).
 *
 * THE RULE. The dashboard once signed in by redeeming a code for a whole
 * database image, restored it into the browser and refreshed it on demand.
 * That design was retired deliberately and all at once: the live dashboard
 * pairs as a cadre member and replicates the officer's strand instead. This
 * file keeps the old path from coming back by any route:
 *   S1  the deleted modules, directory, screen and fixture do not exist, and
 *       `src/lifecycle` holds exactly the two pairing-era modules;
 *   S2  no file under `src/` or `test/browser/` imports a deleted module, and
 *       no `src/` file imports the vote-engine sign-in bundle entry (the
 *       Authority still does, so vote-engine keeps those modules);
 *   S3  no identifier of the old path survives in `src/` code, and the
 *       officer-swap module exports exactly the pairing classifier;
 *   S4  the shared copy table carries no key under the three retired
 *       prefixes, and no dashboard, Public or shared-UI source looks one up;
 *   S5  no dashboard source carries the optimystic network-watch tag, and the
 *       schema's tagged-table set is still exactly the twelve tables tagged
 *       before this phase (a tag arms a watch on every node that reads the
 *       table, so a new one is a deliberate schema decision, never a side
 *       effect).
 *
 * ANTI-SELF-TRIP DISCIPLINE (a checker whose own text holds its pattern is
 * permanently green on itself):
 *   1. Code scan roots are `src/` trees (plus `test/browser/` for imports
 *      only), so this file, under `test/node/`, can never scan itself.
 *   2. Every banned identifier, path and tag is assembled from fragments at
 *      runtime; this file never spells one as a contiguous literal.
 *   3. Comments are stripped before matching (SQL comments too), so prose
 *      that explains the retirement never counts.
 *   4. Each matcher is proved on a synthetic fixture BEFORE the real scan runs,
 *      and every real assertion is set equality.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { dashboardRoot, dashboardSrc, publicSrc, uiWebSrc, workspacePath } from '../../../../scripts/lib/source-paths.mjs';
import { moduleSpecifiersOf, scannedFilesFor, stripComments, stripSqlComments } from '../../../../packages/web-data/test/lib/source-scan.mjs';
import { COPY } from '@votetorrent/ui-web';

/** Join fragments, so no banned name, path or tag is spelled in this file. @param {...string} parts */
const w = (...parts) => parts.join('');

/** Dashboard-relative path with forward slashes. @param {string} abs */
const rel = (abs) => path.relative(dashboardRoot(), abs).split(path.sep).join('/');

const SRC_FILES = scannedFilesFor({ roots: [dashboardSrc()] });
/** @type {Map<string, string>} */
const STRIPPED_SRC = new Map(SRC_FILES.map((f) => [f, stripComments(readFileSync(f, 'utf8'))]));

// ---------------------------------------------------------------------------
// S1: the deleted files are absent.
// ---------------------------------------------------------------------------

const DELETED_PATHS = Object.freeze([
	dashboardSrc('lifecycle', w('boot', 'strap.js')),
	dashboardSrc('lifecycle', w('snapshot', '-restore.js')),
	dashboardSrc('lifecycle', w('re', 'fresh.js')),
	dashboardSrc('lifecycle', w('fresh', 'ness.js')),
	dashboardSrc(w('trans', 'port'), w('bootstrap', '-transport', '-client.js')),
	dashboardSrc(w('trans', 'port')),
	dashboardSrc('screens', w('Boot', 'strap.tsx')),
	dashboardSrc('screens', w('boot', 'strap.css')),
	dashboardRoot('test', 'fixtures', w('bootstrap', '-envelope.js')),
]);

test('S1 control: the same path builder finds a file that does exist', () => {
	assert.ok(existsSync(dashboardSrc('lifecycle', w('forget', '-network.js'))));
});

test('S1 (D-16): the deleted modules, the transport directory, the old screen and its styles, and the fixture do not exist', () => {
	assert.deepEqual(DELETED_PATHS.filter((p) => existsSync(p)).map(rel), []);
	assert.deepEqual(readdirSync(dashboardSrc('lifecycle')).sort(), ['forget-network.js', 'officer-swap.js']);
});

// ---------------------------------------------------------------------------
// S2: nothing imports a deleted module.
// ---------------------------------------------------------------------------

/** Specifier endings of the deleted modules, with or without an extension. */
const DELETED_SPECIFIER_RE = new RegExp(
	`(^|/)(${[
		w('lifecycle/', 'boot', 'strap'),
		w('snapshot', '-restore'),
		w('lifecycle/', 're', 'fresh'),
		w('lifecycle/', 'fresh', 'ness'),
		w('bootstrap', '-transport', '-client'),
		w('bootstrap', '-envelope'),
		w('screens/', 'Boot', 'strap'),
	].join('|')})(\\.js|\\.tsx?)?$`,
);
const SIGNIN_BUNDLE_ENTRY = w('@votetorrent/', 'vote-engine', '/boot', 'strap');

/** Deleted-module specifiers a source declares. @param {string} source */
const deletedImportsOf = (source) =>
	moduleSpecifiersOf(source)
		.map((s) => s.specifier)
		.filter((s) => typeof s === 'string' && DELETED_SPECIFIER_RE.test(s));

test('S2 control: a synthetic import of a deleted module is flagged, and a live import is not', () => {
	const fixture = `import { x } from '../lifecycle/${w('snapshot', '-restore')}.js';\nimport { y } from '../peer/boot.js';`;
	assert.deepEqual(deletedImportsOf(fixture), [`../lifecycle/${w('snapshot', '-restore')}.js`]);
	assert.deepEqual(deletedImportsOf(`// import { x } from '../lifecycle/${w('re', 'fresh')}.js';\nconst keep = 1;`), []);
});

test('S2 control: the sign-in entry matcher catches a synthetic import of that entry and of a subpath', () => {
	const hits = (/** @type {string} */ src) =>
		moduleSpecifiersOf(src).some((s) => s.specifier === SIGNIN_BUNDLE_ENTRY || (s.specifier ?? '').startsWith(`${SIGNIN_BUNDLE_ENTRY}/`));
	assert.ok(hits(`import { x } from '${SIGNIN_BUNDLE_ENTRY}';`));
	assert.ok(hits(`const m = await import('${SIGNIN_BUNDLE_ENTRY}/manifest');`));
	assert.ok(!hits("import { y } from '@votetorrent/vote-engine/rn';"));
});

test('S2 (D-16): no src/ or test/browser/ file imports a deleted module, and no src/ file imports the vote-engine sign-in entry', () => {
	const browserFiles = scannedFilesFor({ roots: [dashboardRoot('test', 'browser')] });
	assert.ok(browserFiles.length >= 10, `test/browser scan is too small to be real: ${browserFiles.length}`);
	/** @type {string[]} */
	const offenders = [];
	for (const file of [...SRC_FILES, ...browserFiles]) {
		for (const spec of deletedImportsOf(readFileSync(file, 'utf8'))) offenders.push(`${rel(file)}: ${spec}`);
	}
	assert.deepEqual(offenders, []);
	const signinImporters = SRC_FILES.filter((f) =>
		moduleSpecifiersOf(readFileSync(f, 'utf8')).some((s) => s.specifier === SIGNIN_BUNDLE_ENTRY || (s.specifier ?? '').startsWith(`${SIGNIN_BUNDLE_ENTRY}/`)),
	).map(rel);
	assert.deepEqual(signinImporters, []);
});

// ---------------------------------------------------------------------------
// S3: no identifier of the old path survives.
// ---------------------------------------------------------------------------

const RETIRED_IDENTIFIERS = Object.freeze([
	w('redeem', 'And', 'Bootstrap'),
	w('redeem', 'SignIn', 'Code'),
	w('split', 'SignIn', 'Code'),
	w('create', 'Rest', 'Bootstrap', 'Transport'),
	w('verify', 'Snapshot'),
	w('build', 'Snapshot'),
	w('apply', 'Snapshot', 'Tables'),
	w('assert', 'Restore', 'Matches', 'Manifest'),
	w('refresh', 'Network'),
	w('snapshot', 'Freshness'),
	w('format', 'Stale', 'Threshold'),
	w('perform', 'Officer', 'Swap'),
	w('classify', 'Redemption'),
	w('create', 'Single', 'Flight', 'Transport'),
	w('Officer', 'Indeterminate', 'Error'),
	w('derive', 'Officer', 'UserId', 'From', 'Envelope'),
	w('BOOTSTRAP', '_PHASES'),
	w('copyKeys', 'For', 'Outcome'),
	w('write', 'Row', 'Counts'),
	w('attach', 'Network', 'Db'),
	w('snapshot', 'Instant'),
]);
const RETIRED_RE = new RegExp(`\\b(${RETIRED_IDENTIFIERS.join('|')})\\b`);

test('S3 control: each retired identifier is caught as a whole word, a // comment naming one is stripped, and a longer name is not', () => {
	for (const name of RETIRED_IDENTIFIERS) assert.match(stripComments(`const v = ${name};`), RETIRED_RE, `the matcher misses ${name}`);
	assert.doesNotMatch(stripComments(`// ${RETIRED_IDENTIFIERS[9]} used to live here\nconst keep = 1;`), RETIRED_RE);
	assert.doesNotMatch(`const v = ${RETIRED_IDENTIFIERS[19]}Later;`, RETIRED_RE);
});

test('S3 control: the export reader lists every top-level const, function and class export, and nothing else', () => {
	const fixture = 'export const A_KIND = 1;\nexport function doIt() {}\nexport class Thing {}\nconst hidden = 2;\n// export const commented = 3;';
	assert.deepEqual([...fixture.matchAll(/^export (?:const|function|class) (\w+)/gm)].map((m) => m[1]).sort(), ['A_KIND', 'Thing', 'doIt']);
});

test('S3 (D-16): no retired identifier survives in comment-stripped src/ code, and officer-swap.js exports exactly the pairing classifier', () => {
	/** @type {string[]} */
	const offenders = [];
	for (const [file, code] of STRIPPED_SRC) {
		const hit = code.match(RETIRED_RE);
		if (hit) offenders.push(`${rel(file)}: ${hit[1]}`);
	}
	assert.deepEqual(offenders, []);
	const swap = readFileSync(dashboardSrc('lifecycle', 'officer-swap.js'), 'utf8');
	const exported = [...swap.matchAll(/^export (?:const|function|class) (\w+)/gm)].map((m) => m[1]).sort();
	assert.deepEqual(exported, ['PAIRING_KINDS', 'classifyPairing']);
});

// ---------------------------------------------------------------------------
// S4: no retired copy key is in the table or looked up.
// ---------------------------------------------------------------------------

const RETIRED_PREFIXES = Object.freeze([w('boot', 'strap'), w('snap', 'shot'), w('net', 'work')]);
const RETIRED_KEY_RE = new RegExp(`^(${RETIRED_PREFIXES.join('|')})\\.`);
const RETIRED_LOOKUP_RE = new RegExp(`\\bt\\(\\s*['"\`](${RETIRED_PREFIXES.join('|')})\\.`);

test('S4 control: a synthetic lookup of a retired key is flagged, and a live one is not', () => {
	assert.match(stripComments(`const s = t('${w('snap', 'shot')}.asOf', { relativeTime });`), RETIRED_LOOKUP_RE);
	assert.doesNotMatch(stripComments("const s = t('forget.heading', { authorityName });"), RETIRED_LOOKUP_RE);
});

test('S4 control: the key matcher flags a synthetic retired key and passes a live one', () => {
	assert.match(`${w('net', 'work')}.forgetCta`, RETIRED_KEY_RE);
	assert.doesNotMatch('forget.heading', RETIRED_KEY_RE);
	assert.doesNotMatch(`public.${w('net', 'work')}.label`, RETIRED_KEY_RE);
});

test('S4 (D-16): the copy table has no key under the retired prefixes, and no dashboard, Public or shared-UI source looks one up', () => {
	assert.deepEqual(Object.keys(COPY).filter((k) => RETIRED_KEY_RE.test(k)), []);
	const files = scannedFilesFor({ roots: [dashboardSrc(), publicSrc(), uiWebSrc()] });
	assert.ok(files.length >= 60, `the copy-lookup scan is too small to be real: ${files.length}`);
	/** @type {string[]} */
	const offenders = [];
	for (const file of files) {
		if (RETIRED_LOOKUP_RE.test(stripComments(readFileSync(file, 'utf8')))) offenders.push(file);
	}
	assert.deepEqual(offenders, []);
});

// ---------------------------------------------------------------------------
// S5: no network-watch tag in dashboard sources; the schema tag set is pinned.
// ---------------------------------------------------------------------------

const WATCH_TAG = w('optimystic', '.', 'network', '_', 'watch');
const WATCH_TAG_TRUE_RE = new RegExp(`"${WATCH_TAG.replace('.', '\\.')}"\\s*=\\s*true`);

/** The twelve tables tagged before this phase, sorted. */
const TAGGED_TABLES = Object.freeze(
	[
		'Ballot',
		'ElectionKey',
		'ElectionRevision',
		'ElectionTally',
		'Election',
		'ProposedElectionRevision',
		'ProposedElection',
		'RegistrationDecision',
		'RegistrationRequest',
		'Task',
		'VoteBlockVoter',
		'VoteBlock',
	].sort(),
);

/** Parse a schema into its tables and the set tagged with the watch tag. @param {string} sql */
function tablesOf(sql) {
	const parts = stripSqlComments(sql).split(/^[ \t]*table[ \t]+(\w+)[ \t]*\(/m);
	/** @type {string[]} */
	const names = [];
	/** @type {string[]} */
	const tagged = [];
	for (let i = 1; i < parts.length; i += 2) {
		names.push(parts[i]);
		if (WATCH_TAG_TRUE_RE.test(parts[i + 1] ?? '')) tagged.push(parts[i]);
	}
	return { names, tagged: tagged.sort() };
}

test('S5 control: the tag matcher fires on a synthetic tag line in code, and not in a comment', () => {
	assert.ok(stripComments(`const tags = { "${WATCH_TAG}": true };`).includes(WATCH_TAG));
	assert.ok(!stripComments(`// "${WATCH_TAG}" arms a watch\nconst keep = 1;`).includes(WATCH_TAG));
});

test('S5 control: a two-table synthetic schema where only the second is tagged yields exactly the second', () => {
	const sql = `\ttable First (\n\t\tId text primary key\n\t);\n\t-- "${WATCH_TAG}" = true is only a comment here\n\ttable Second (\n\t\tId text primary key\n\t) with tags ("${WATCH_TAG}" = true);\n`;
	assert.deepEqual(tablesOf(sql), { names: ['First', 'Second'], tagged: ['Second'] });
});

test('S5 (R-6): no dashboard src/ file carries the network-watch tag', () => {
	const offenders = [...STRIPPED_SRC.entries()].filter(([, code]) => code.includes(WATCH_TAG)).map(([file]) => rel(file));
	assert.deepEqual(offenders, []);
});

test('S5 (R-6): the schema tags exactly the twelve tables tagged before this phase, and the pairing revocation table is parsed and untagged', () => {
	const { names, tagged } = tablesOf(readFileSync(workspacePath('packages/vote-core', 'schema', 'votetorrent.qsql'), 'utf8'));
	assert.ok(names.length >= 70, `the schema parse is too small to be real: ${names.length}`);
	assert.ok(names.includes('DashboardPairingRevocation'), 'the parser did not reach the pairing revocation table');
	assert.deepEqual(tagged, [...TAGGED_TABLES]);
	assert.ok(!tagged.includes('DashboardPairingRevocation'));
});
