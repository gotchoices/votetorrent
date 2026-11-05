/**
 * audience-boundary.test.mjs — D-04's audience split, asserted as a BOUNDARY
 * rather than as a word.
 *
 * WHY THIS MATTERS MORE THAN THE SCAN NEXT DOOR. `anonymity-scan.test.mjs` is
 * the backstop; this file is the primary control. After 54-03 moved the
 * dashboard's ENTIRE read layer under `src/officer/` — elections, ballots,
 * registrations, plus 54-06's per-row keyholder roster — a single crossing
 * import does not publish one query, it publishes an identity graph. The split
 * is what makes anonymity structural; a textual scan is what catches the cases
 * the split does not.
 *
 * DELIBERATELY NOT A REACHABILITY WALK FROM THE PUBLIC ENTRY. A flat per-file
 * rule over the whole package `src/` is strictly STRONGER: it forbids a
 * laundering route through any shared module whether or not the public entry
 * currently reaches it, and it needs no specifier-resolution graph to be
 * correct. Spike 090's `closure.mjs` is rejected for this job (54-RESEARCH
 * Pitfall 5): it follows only relative specifiers and records a bare workspace
 * specifier as external — exactly the edge this rule must cross — and it is a
 * frozen historical spike record, so coupling a product gate to it would make a
 * historical artifact load-bearing.
 *
 * THREE RULES, EACH WITH ITS OWN PLANTED-FIXTURE CONTROL RUN FIRST:
 *   B1  nothing outside the officer subpath reaches into it, by any specifier
 *       form — relative, deep-traversal relative, bare subpath, or computed
 *       dynamic (which is treated as a FAILURE TO ANALYSE, not an absence).
 *   B2  what a public module may reach outside its own directory is an
 *       enumerated, justified allowlist that may contain no officer path.
 *   B3  the public app imports only the `./public` subpath, and the package's
 *       exports map cannot launder the officer surface under a public key.
 *
 * WHAT THIS GATE CANNOT PROVE: it reads LITERAL specifiers. A module reached
 * through a computed specifier is caught only in the sense that the computed
 * form itself is rejected; if a future build step rewrites specifiers, this
 * rule reads the pre-rewrite source. It also says nothing about what a
 * permitted module does at runtime — `PERMITTED_OUTSIDE_PUBLIC`'s entries are
 * justified in prose, and prose is not enforcement.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { publicSrc, webDataRoot, webDataSrc } from '../../../scripts/lib/source-paths.mjs';
import { moduleSpecifiersOf, partitionByExtension, walkSourceFiles } from './lib/source-scan.mjs';

const PACKAGE_JSON = JSON.parse(readFileSync(webDataRoot('package.json'), 'utf8'));
const PACKAGE_NAME = PACKAGE_JSON.name;
const OFFICER_DIR = webDataSrc('officer');
const PUBLIC_DIR = webDataSrc('public');
const OFFICER_SUBPATH = `${PACKAGE_NAME}/officer`;
const PUBLIC_SUBPATH = `${PACKAGE_NAME}/public`;

/* ─────────────────────────────────────────────────────────────────────────────
 * BEGIN CONTROL FIXTURES
 * Every hand-written module path and specifier literal used only to make a rule
 * fail lives below. The self-trip guard removes this region before checking the
 * rest of the file.
 * ───────────────────────────────────────────────────────────────────────────── */

/** Fixtures for rule B1. Each is a synthetic file placed under `src/public/`. */
const B1_VIOLATION_FIXTURES = Object.freeze([
	['relative import into the officer directory', `import { readKeyholders } from '../officer/read-keyholders.js';`],
	[
		'deep relative traversal reaching the same directory by a longer path',
		`import { readKeyholders } from '../../src/officer/read-keyholders.js';`,
	],
	['barrel re-export from the officer directory', `export { readKeyholders } from '../officer/read-keyholders.js';`],
	['export * from the officer directory', `export * from '../officer/index.js';`],
	['bare workspace specifier naming the officer subpath', `import { readKeyholders } from '@votetorrent/web-data/officer';`],
	['dynamic import of the officer barrel', `const m = await import('../officer/index.js');`],
	['computed dynamic import — unanalysable, therefore a failure', `const m = await import(whichBarrel);`],
	['require of the officer barrel', `const m = require('../officer/index.js');`],
]);

/** Fixtures for rule B1 that must NOT fire — the rule is about the boundary, not the word. */
const B1_BENIGN_FIXTURES = Object.freeze([
	[
		'a sibling module whose NAME contains "officer" but which is not in the officer directory',
		`import { note } from './officer-notes.js';`,
	],
	['the permitted classification import', `import { classOf } from '../classification.js';`],
	['a comment that discusses the forbidden import', `// import { readKeyholders } from '../officer/read-keyholders.js';`],
]);

/** Fixture for rule B2 — an unlisted sibling module reached from `src/public/`. */
const B2_UNLISTED_FIXTURE = `import { thing } from '../not-on-the-allowlist.js';`;
/** Fixture for rule B2 rule (ii) — an allowlist entry that points into the officer directory. */
const B2_LAUNDERING_ALLOWLIST = Object.freeze([
	{ module: 'officer/read-keyholders.js', why: 'a justification string does not make a boundary crossing legal' },
]);

/** Fixtures for rule B3 — bare specifiers the public app must never declare. */
const B3_VIOLATION_FIXTURES = Object.freeze([
	['the officer subpath', `import { readKeyholders } from '@votetorrent/web-data/officer';`],
	['the bare root entry', `import { openStoreHandle } from '@votetorrent/web-data';`],
	['a deep path into the package src', `import { classOf } from '@votetorrent/web-data/src/classification.js';`],
]);
/** Fixture for rule B3 that must NOT fire. */
const B3_BENIGN_FIXTURE = `import { readPublicElection } from '@votetorrent/web-data/public';`;
/** A synthetic exports map that launders the officer surface under a public-looking key. */
const B3_LAUNDERING_EXPORTS = Object.freeze({
	'./public': './src/officer/index.js',
	'./officer': './src/officer/index.js',
});

/* ─────────────────────────────────────────────────────────────────────────────
 * END CONTROL FIXTURES
 * ───────────────────────────────────────────────────────────────────────────── */

const THIS_FILE = fileURLToPath(import.meta.url);
const BEGIN_SENTINEL = ['BEGIN', 'CONTROL', 'FIXTURES'].join(' ');
const END_SENTINEL = ['END', 'CONTROL', 'FIXTURES'].join(' ');

/**
 * What a module under `src/public/` may import from ELSEWHERE in this package's
 * `src/`. Read off what 54-03a and 54-06 actually landed, not guessed: the
 * three connection-layer modules `public/index.js` re-exports, plus the
 * classification every read module resolves its tables through.
 *
 * Each entry carries its justification IN THE DATA STRUCTURE, so widening the
 * list forces the widener to write down why — and so a reader of a failure can
 * see what the existing crossings are for. 54-12 adds the D-01 attach path and
 * should append here with its own reason.
 *
 * @type {ReadonlyArray<{ module: string, why: string }>}
 */
const PERMITTED_OUTSIDE_PUBLIC = Object.freeze([
	Object.freeze({
		module: 'classification.js',
		why: 'the single-source table classification (D-15). Every public read module resolves its own TABLES_READ through it at MODULE SCOPE, which is what makes a widening edit a crash at import rather than a review miss.',
	}),
	Object.freeze({
		module: 'open-db.js',
		why: 'audience-neutral connection layer: opens a browser-local IndexedDB-backed database and selects no application table. Re-exported by BOTH barrels for exactly that reason.',
	}),
	Object.freeze({
		module: 'reattach.js',
		why: 'audience-neutral re-attach and row-count layer. Reads counts written at bootstrap; names no application table in a select list.',
	}),
	Object.freeze({
		module: 'networks-registry.js',
		why: 'audience-neutral network registry, stored OUTSIDE the database in the storage adapter. It is how an anonymous reader finds which local replica to attach.',
	}),
]);

// ───────────────────────────────────────────────────────────────────────────
// The rules, as pure functions, so a control and the real run share one engine.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Rule B1 applied to one file. Returns human-readable violations.
 * @param {string} filePath - absolute path the source would live at
 * @param {string} source
 * @returns {string[]}
 */
function b1Violations(filePath, source) {
	/** @type {string[]} */
	const out = [];
	for (const { specifier, kind } of moduleSpecifiersOf(source)) {
		if (kind === 'dynamic-computed') {
			out.push(
				`${filePath}: a COMPUTED dynamic import cannot be analysed, so this gate cannot prove it does not reach ` +
					'the officer surface. Rewrite it as a literal specifier; an unanalysable specifier is a failure, not an absence.',
			);
			continue;
		}
		if (specifier === null) continue;
		if (specifier.startsWith('.')) {
			const resolved = path.resolve(path.dirname(filePath), specifier);
			if (resolved === OFFICER_DIR || resolved.startsWith(`${OFFICER_DIR}${path.sep}`)) {
				out.push(`${filePath}: ${kind} specifier "${specifier}" resolves into src/officer/ (${resolved})`);
			}
			continue;
		}
		if (specifier === OFFICER_SUBPATH || specifier.startsWith(`${OFFICER_SUBPATH}/`)) {
			out.push(`${filePath}: ${kind} specifier "${specifier}" is this package's own officer entry`);
		}
	}
	return out;
}

/**
 * Rule B2 applied to one file under `src/public/`.
 * @param {string} filePath
 * @param {string} source
 * @param {ReadonlyArray<{ module: string, why: string }>} allowlist
 * @returns {string[]}
 */
function b2Violations(filePath, source, allowlist) {
	const permitted = new Set(allowlist.map((e) => webDataSrc(e.module)));
	/** @type {string[]} */
	const out = [];
	for (const { specifier, kind } of moduleSpecifiersOf(source)) {
		if (specifier === null || !specifier.startsWith('.')) continue;
		const resolved = path.resolve(path.dirname(filePath), specifier);
		if (resolved === PUBLIC_DIR || resolved.startsWith(`${PUBLIC_DIR}${path.sep}`)) continue; // inside its own directory
		if (permitted.has(resolved)) continue;
		out.push(
			`${filePath}: ${kind} specifier "${specifier}" leaves src/public/ and is not on PERMITTED_OUTSIDE_PUBLIC ` +
				`(resolved: ${resolved}). Add it with a written justification, or move the dependency.`,
		);
	}
	return out;
}

/**
 * Rule B3 applied to one file under the public app's `src/`.
 * @param {string} filePath
 * @param {string} source
 * @returns {string[]}
 */
function b3Violations(filePath, source) {
	/** @type {string[]} */
	const out = [];
	for (const { specifier, kind } of moduleSpecifiersOf(source)) {
		if (specifier === null || !specifier.startsWith(PACKAGE_NAME)) continue;
		if (specifier === PUBLIC_SUBPATH) continue;
		out.push(
			`${filePath}: ${kind} specifier "${specifier}" reaches ${PACKAGE_NAME} by something other than its ` +
				`"${PUBLIC_SUBPATH}" entry. The public app has exactly one legal door into this package.`,
		);
	}
	return out;
}

/** @param {string} root @returns {string[]} scannable code files, with unknown extensions rejected */
function codeFilesUnder(root) {
	const part = partitionByExtension(walkSourceFiles(root));
	assert.deepEqual(
		part.unknown,
		[],
		`${root} holds files with an unclassified extension: ${part.unknown.join(', ')}. Classify it in test/lib/source-scan.mjs.`,
	);
	return part.scanned;
}

// ───────────────────────────────────────────────────────────────────────────
// Controls, all run before the real rules.
// ───────────────────────────────────────────────────────────────────────────

test('control B1 (positive): every specifier form that reaches src/officer/ is rejected', () => {
	const synthetic = webDataSrc('public', 'synthetic-fixture.js');
	for (const [label, fixture] of B1_VIOLATION_FIXTURES) {
		const violations = b1Violations(synthetic, fixture);
		assert.ok(
			violations.length > 0,
			`rule B1 is inert for the "${label}" fixture — it did not fire. That specifier form is currently unguarded.`,
		);
	}
});

test('control B1 (discrimination): the rule is about the boundary, not about the word "officer"', () => {
	const synthetic = webDataSrc('public', 'synthetic-fixture.js');
	for (const [label, fixture] of B1_BENIGN_FIXTURES) {
		assert.deepEqual(
			b1Violations(synthetic, fixture),
			[],
			`rule B1 over-fires: the "${label}" fixture was rejected. It pattern-matches a word instead of resolving a path.`,
		);
	}
	// The sibling-module fixture must still be JUDGED — by B2, not silently accepted.
	const [, siblingFixture] = B1_BENIGN_FIXTURES[0];
	assert.ok(
		b2Violations(synthetic, siblingFixture, PERMITTED_OUTSIDE_PUBLIC).length === 0,
		'the sibling fixture resolves inside src/public/ and so is correctly outside B2 as well',
	);
});

test('control B2 (positive): an unlisted sibling module and a laundering allowlist entry are both rejected', () => {
	const synthetic = webDataSrc('public', 'synthetic-fixture.js');
	assert.ok(
		b2Violations(synthetic, B2_UNLISTED_FIXTURE, PERMITTED_OUTSIDE_PUBLIC).length > 0,
		'rule B2 is inert — an import of a module that is not on the allowlist was accepted',
	);
	const officerEntries = B2_LAUNDERING_ALLOWLIST.filter((e) => {
		const resolved = webDataSrc(e.module);
		return resolved === OFFICER_DIR || resolved.startsWith(`${OFFICER_DIR}${path.sep}`);
	});
	assert.equal(
		officerEntries.length,
		1,
		'rule B2(ii) is inert — an allowlist entry pointing into src/officer/ was not detected, so the allowlist could be widened into the officer surface',
	);
});

test('control B3 (positive and discrimination): the officer subpath, the bare root and a deep path are rejected; ./public is not', () => {
	const synthetic = publicSrc('synthetic-fixture.tsx');
	for (const [label, fixture] of B3_VIOLATION_FIXTURES) {
		assert.ok(
			b3Violations(synthetic, fixture).length > 0,
			`rule B3 is inert for the "${label}" fixture — the public app could reach the package that way undetected`,
		);
	}
	assert.deepEqual(
		b3Violations(synthetic, B3_BENIGN_FIXTURE),
		[],
		'rule B3 over-fires: the legitimate ./public import was rejected',
	);
});

test('control B3 (exports map): a synthetic map whose ./public key points into src/officer/ is rejected', () => {
	const offenders = exportsMapViolations(B3_LAUNDERING_EXPORTS);
	assert.ok(
		offenders.some((o) => o.includes('./public')),
		'the exports-map rule is inert — a map that resolves ./public into src/officer/ was accepted, which is the whole laundering shape it exists to catch',
	);
});

/**
 * Every way an exports map can put an officer file behind a non-officer key.
 * @param {Record<string, unknown>} map
 * @returns {string[]}
 */
function exportsMapViolations(map) {
	/** @type {string[]} */
	const out = [];
	for (const [key, target] of Object.entries(map)) {
		if (typeof target !== 'string') {
			out.push(`exports key "${key}" is not a plain string target; this rule only understands string targets`);
			continue;
		}
		const resolved = path.resolve(webDataRoot(), target);
		const underOfficer = resolved === OFFICER_DIR || resolved.startsWith(`${OFFICER_DIR}${path.sep}`);
		if (underOfficer && key !== './officer') {
			out.push(`exports key "${key}" resolves under src/officer/ (${target}); only "./officer" may do that`);
		}
	}
	return out;
}

// ───────────────────────────────────────────────────────────────────────────
// The real rules.
// ───────────────────────────────────────────────────────────────────────────

test('B1 (D-04): no file outside src/officer/ reaches into it, by any specifier form', () => {
	const files = codeFilesUnder(webDataSrc()).filter(
		(f) => f !== OFFICER_DIR && !f.startsWith(`${OFFICER_DIR}${path.sep}`),
	);
	assert.ok(files.length > 0, 'the walk found no non-officer files under packages/web-data/src — the rule would be vacuous');

	/** @type {string[]} */
	const violations = [];
	for (const file of files) violations.push(...b1Violations(file, readFileSync(file, 'utf8')));
	assert.deepEqual(
		violations,
		[],
		'D-04 is broken: something outside src/officer/ reaches the officer read layer. After 54-03 that layer holds the ' +
			'dashboard\'s entire read surface, so a crossing import publishes an identity graph, not one query.',
	);
});

test('B2 (D-04): every crossing out of src/public/ is on the enumerated allowlist, and none of it is an officer path', () => {
	const files = codeFilesUnder(PUBLIC_DIR);
	assert.ok(files.length > 0, 'src/public/ walked to zero files — the rule would be vacuous');

	/** @type {string[]} */
	const violations = [];
	for (const file of files) violations.push(...b2Violations(file, readFileSync(file, 'utf8'), PERMITTED_OUTSIDE_PUBLIC));
	assert.deepEqual(violations, [], 'a module under src/public/ reaches outside its directory to something nobody enumerated');

	// (ii) The allowlist itself may never contain an officer path. Asserted
	//      SEPARATELY from B1 so the allowlist cannot be widened into the
	//      officer surface by an edit that looks like a routine addition.
	for (const entry of PERMITTED_OUTSIDE_PUBLIC) {
		const resolved = webDataSrc(entry.module);
		assert.ok(
			!(resolved === OFFICER_DIR || resolved.startsWith(`${OFFICER_DIR}${path.sep}`)),
			`PERMITTED_OUTSIDE_PUBLIC names "${entry.module}", which is under src/officer/. No justification makes that legal.`,
		);
		// (iii) Every entry must carry a real reason.
		assert.ok(
			typeof entry.why === 'string' && entry.why.trim().length >= 40,
			`PERMITTED_OUTSIDE_PUBLIC entry "${entry.module}" has no substantive justification. Write down why the crossing is safe.`,
		);
	}

	// The allowlist must not rot in the other direction either: an entry nobody
	// imports any more is a permission granted for a reason that no longer exists.
	const importedTargets = new Set();
	for (const file of files) {
		for (const { specifier } of moduleSpecifiersOf(readFileSync(file, 'utf8'))) {
			if (specifier === null || !specifier.startsWith('.')) continue;
			importedTargets.add(path.resolve(path.dirname(file), specifier));
		}
	}
	for (const entry of PERMITTED_OUTSIDE_PUBLIC) {
		assert.ok(
			importedTargets.has(webDataSrc(entry.module)),
			`PERMITTED_OUTSIDE_PUBLIC grants "${entry.module}" but nothing under src/public/ imports it. Remove the stale permission.`,
		);
	}
});

test('B3 (D-04): the public app reaches this package only through its ./public entry', () => {
	const files = codeFilesUnder(publicSrc());
	assert.ok(files.length > 0, 'the public app walked to zero code files — the rule would be vacuous');

	/** @type {string[]} */
	const violations = [];
	let sawPackageSpecifier = 0;
	for (const file of files) {
		const source = readFileSync(file, 'utf8');
		violations.push(...b3Violations(file, source));
		for (const { specifier } of moduleSpecifiersOf(source)) {
			if (specifier !== null && specifier.startsWith(PACKAGE_NAME)) sawPackageSpecifier += 1;
		}
	}
	assert.deepEqual(violations, [], 'the public app reaches this package by a door other than ./public');

	// HONESTY MARKER, not an assertion that can fail today. At wave 5 the public
	// app declares the package as a dependency but does not yet import it, so the
	// file-level half of B3 is currently VACUOUS and its live proof is the
	// fixture control above. This gate lands at wave 5 deliberately so the shell
	// (54-12/13/14) is born under it; the count below will become non-zero then.
	assert.ok(sawPackageSpecifier >= 0, 'unreachable');
});

test('B3 (D-04): the package exports map cannot launder the officer surface under a public key', () => {
	const map = PACKAGE_JSON.exports;
	assert.ok(map && typeof map === 'object', 'packages/web-data/package.json declares no exports map — the subpath split is not enforced by the resolver at all');

	const publicTarget = map['./public'];
	assert.equal(typeof publicTarget, 'string', 'the "./public" export key is missing or is not a plain string target');
	const publicResolved = path.resolve(webDataRoot(), publicTarget);
	assert.ok(
		publicResolved.startsWith(`${PUBLIC_DIR}${path.sep}`),
		`the "./public" export resolves to ${publicResolved}, which is not under src/public/`,
	);

	assert.deepEqual(
		exportsMapViolations(map),
		[],
		'an export key other than "./officer" resolves under src/officer/ — the officer surface is reachable behind a public-looking name',
	);
});

// ───────────────────────────────────────────────────────────────────────────
// Self-trip guard.
// ───────────────────────────────────────────────────────────────────────────

test('self-trip guard: outside the fixture region this file declares no officer specifier literal', () => {
	const own = readFileSync(THIS_FILE, 'utf8');
	const begin = own.indexOf(BEGIN_SENTINEL);
	const end = own.indexOf(END_SENTINEL);
	assert.ok(begin > 0 && end > begin, 'the control-fixture sentinels are missing or out of order in this file');
	const remainder = own.slice(0, begin) + own.slice(end + END_SENTINEL.length);

	// This file is not inside any scanned root, so this is discipline rather than
	// necessity — but a checker whose own source carries the literal it hunts is
	// one root-widening away from being permanently green.
	assert.ok(
		!remainder.includes(`'${OFFICER_SUBPATH}'`),
		'this checker quotes the officer subpath specifier outside its fixture region',
	);
	assert.ok(
		!/from '\.\.\/officer\//.test(remainder),
		'this checker writes a relative officer import outside its fixture region',
	);
});

test('self-trip guard: this test file is not inside any root the rules above scan', () => {
	for (const root of [webDataSrc(), publicSrc()]) {
		assert.ok(
			!THIS_FILE.startsWith(`${root}${path.sep}`),
			`this test file lives inside ${root}, so its own fixtures would be scanned as product source`,
		);
	}
});
