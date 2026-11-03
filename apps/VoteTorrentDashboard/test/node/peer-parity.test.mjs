/**
 * peer-parity.test.mjs -- the drift instrument for the dashboard's two copied peer files.
 *
 * WHY COPIES EXIST. `src/peer/tail-reader.js` and `src/peer/collection-id.js` are byte copies of the
 * Public page's files of the same names. The apps never import each other (each app bundles only its
 * own tree and the shared packages), and the alternative of moving the two files into a shared package
 * was weighed and rejected for this phase (66-RESEARCH "Alternatives Considered"). A copy is the
 * contract, so this file is what notices when the two drift apart.
 *
 * It also pins the collection id formula against the Optimystic plugin's own exported
 * `defaultCollectionUri` for EVERY officer table, so an upstream change to the default collection URI
 * fails here rather than leaving the dashboard watching collections no block carries.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { defaultCollectionUri } from '@optimystic/quereus-plugin-optimystic';
import { OFFICER_SUBSCRIBED_TABLES, ADMIN_PANEL_AND_GATE_TABLES, PAIRING_TABLES } from '@votetorrent/web-data/officer';
import { dashboardSrc, publicSrc } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../packages/web-data/test/lib/source-scan.mjs';
import { collectionIdForTable, SAPP_SCHEMA_NAME } from '../../src/peer/collection-id.js';

/** The two files copied byte for byte from the Public page. */
const COPIED_FILES = Object.freeze(['tail-reader.js', 'collection-id.js']);

/**
 * Line-ending and trailing-whitespace normalization, nothing else.
 * @param {string} text
 * @returns {string}
 */
function normalize(text) {
	return text
		.replace(/\r\n/g, '\n')
		.split('\n')
		.map((line) => line.replace(/[ \t]+$/, ''))
		.join('\n');
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function sameText(a, b) {
	return normalize(a) === normalize(b);
}

test('PP1: both dashboard copies equal their Public originals (line-ending-normalized)', () => {
	for (const file of COPIED_FILES) {
		const copy = readFileSync(dashboardSrc('peer', file), 'utf8');
		const original = readFileSync(publicSrc('peer', file), 'utf8');
		assert.ok(copy.length > 0, 'a copied file is empty');
		assert.equal(normalize(copy), normalize(original), 'a dashboard copy drifted from its Public original');
	}
});

test('PP2 (positive control): the same comparison reports a one-character difference', () => {
	const copy = readFileSync(dashboardSrc('peer', 'tail-reader.js'), 'utf8');
	const original = readFileSync(publicSrc('peer', 'tail-reader.js'), 'utf8');
	assert.equal(sameText(copy, original), true);
	assert.equal(sameText(`${copy}x`, original), false, 'the comparison is inert: an appended character was not noticed');
	assert.equal(sameText(copy.replace('export', 'exports'), original), false);
});

test('PP3: collectionIdForTable is the plugin default collection URI without tree://, for every officer table', () => {
	assert.ok(Array.isArray(OFFICER_SUBSCRIBED_TABLES) && OFFICER_SUBSCRIBED_TABLES.length > 0, 'the officer table list is empty');
	assert.ok(Object.isFrozen(OFFICER_SUBSCRIBED_TABLES), 'the officer table list is not frozen');
	let checked = 0;
	for (const table of OFFICER_SUBSCRIBED_TABLES) {
		const uri = defaultCollectionUri(SAPP_SCHEMA_NAME, table);
		assert.ok(uri.startsWith('tree://'), 'the plugin default URI changed shape');
		assert.equal(collectionIdForTable(table), uri.slice('tree://'.length));
		checked += 1;
	}
	assert.equal(checked, OFFICER_SUBSCRIBED_TABLES.length);
});

test('PP4 (D-12): every admin/gate and pairing table is in the officer list, so PP3 pins its collection id', () => {
	const missing = [...ADMIN_PANEL_AND_GATE_TABLES, ...PAIRING_TABLES].filter((t) => !OFFICER_SUBSCRIBED_TABLES.includes(t));
	assert.deepEqual(missing, []);
	assert.ok(ADMIN_PANEL_AND_GATE_TABLES.length > 0 && PAIRING_TABLES.length > 0);
});

test('PP5 (inertness control): with a different schema name the pin fails for the first table', () => {
	const table = OFFICER_SUBSCRIBED_TABLES[0];
	const uri = defaultCollectionUri('main', table);
	assert.notEqual(SAPP_SCHEMA_NAME, 'main');
	assert.notEqual(collectionIdForTable(table), uri.slice('tree://'.length), 'the pin holds for any schema name, so it pins nothing');
});

test('PP6: collectionIdForTable refuses an empty or non-string table name', () => {
	for (const bad of ['', undefined, null, 42]) {
		assert.throws(() => collectionIdForTable(/** @type {any} */ (bad)), TypeError);
	}
});

test('PP7: no dashboard peer file imports from the Public app', () => {
	const appName = ['VoteTorrent', 'Public'].join('');
	const relative = ['..', '..', '..', appName].join('/');
	const peerDir = dashboardSrc('peer');
	const files = readdirSync(peerDir).filter((f) => f.endsWith('.js'));
	assert.ok(files.length >= COPIED_FILES.length, 'the peer directory scan found too few files');
	/** @type {string[]} */
	const offenders = [];
	for (const file of files) {
		const stripped = stripComments(readFileSync(path.join(peerDir, file), 'utf8'));
		if (stripped.includes(appName) || stripped.includes(relative)) offenders.push(file);
	}
	assert.deepEqual(offenders, []);
	// Control: the same matcher fires on an import naming the Public app.
	const planted = stripComments(`import { x } from '${relative}/src/peer/collection-id.js';`);
	assert.ok(planted.includes(appName), 'the matcher is inert');
});
