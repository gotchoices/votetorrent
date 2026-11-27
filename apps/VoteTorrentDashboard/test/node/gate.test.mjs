/**
 * gate.test.mjs — the `hasScope`-only gate's truth table, the dropped-write
 * key-set guard, and the zero-mutation regression assertion (T-50-06-02).
 *
 * No database, no IndexedDB test-shim import — `evaluate()` is pure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { dashboardRoot, dashboardSrc } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';

import { evaluate } from '../../src/auth/gate.js';
import { CAPABILITIES } from '../../src/auth/capabilities.js';

const APP_ROOT = dashboardRoot();
const SRC_DIR = dashboardSrc();

const REGISTRATIONS = CAPABILITIES.find((c) => c.id === 'registrations');
if (!REGISTRATIONS) throw new Error('fixture error: no "registrations" capability found');

test('evaluate(cap, [grantedScope]) returns hasScope/visible true and denialReason null', () => {
	assert.deepEqual(evaluate(REGISTRATIONS, ['vrg']), {
		hasScope: true,
		visible: true,
		denialReason: null,
	});
});

test('evaluate(cap, []) returns hasScope/visible false and denialReason "missing-scope"', () => {
	assert.deepEqual(evaluate(REGISTRATIONS, []), {
		hasScope: false,
		visible: false,
		denialReason: 'missing-scope',
	});
});

test('matching is exact, not prefix or substring: a different granted scope does not satisfy registrations ("vrg")', () => {
	const result = evaluate(REGISTRATIONS, ['mel']);
	assert.equal(result.visible, false);
});

test('the return shape carries exactly hasScope, visible, denialReason — no writable, no inWindow (D-17)', () => {
	assert.deepEqual(Object.keys(evaluate(REGISTRATIONS, ['vrg'])).sort(), [
		'denialReason',
		'hasScope',
		'visible',
	]);
});

test('evaluate takes exactly two parameters — no phaseId (D-17)', () => {
	assert.equal(evaluate.length, 2);
});

test('with all nine scopes granted, exactly 9 capabilities evaluate visible; with none, exactly 0', () => {
	const allScopes = CAPABILITIES.map((c) => c.scope);
	const visibleWithAll = CAPABILITIES.filter((c) => evaluate(c, allScopes).visible).length;
	assert.equal(visibleWithAll, 9);
	const visibleWithNone = CAPABILITIES.filter((c) => evaluate(c, []).visible).length;
	assert.equal(visibleWithNone, 0);
});

test('evaluate does not mutate the passed grantedScopes array', () => {
	/** @type {import('../../src/auth/capabilities.js').ScopeCode[]} */
	const scopes = ['vrg'];
	const before = [...scopes];
	evaluate(REGISTRATIONS, scopes);
	assert.deepEqual(scopes, before);
});

test('denialReason is always a member of the closed set [null, "missing-scope"] across all capabilities x empty/full scope sets', () => {
	const allScopes = CAPABILITIES.map((c) => c.scope);
	const seen = new Set();
	for (const cap of CAPABILITIES) {
		seen.add(evaluate(cap, allScopes).denialReason);
		seen.add(evaluate(cap, []).denialReason);
	}
	assert.deepEqual([...seen].sort(), [null, 'missing-scope'].sort());
});

// ---------------------------------------------------------------------------
// Advisory-gate regression: no file under src/ contains a mutation-shaped
// statement. This is the forward-looking half of the elevation-of-privilege
// mitigation (T-50-06-02) — a previewed scope set cannot reach a real write
// path because there is no write path to reach. When a later phase adds
// panel actions, THIS TEST MUST FAIL, forcing the write-gate question to be
// answered deliberately rather than inherited silently.
// ---------------------------------------------------------------------------

const MUTATION_RE = /\b(insert\s+into|update\s+\S+\s+set|delete\s+from)\b/i;

/** @param {string} dir @returns {string[]} */
function walkFiles(dir) {
	/** @type {string[]} */
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === 'node_modules' || entry.name === 'dist') continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkFiles(full));
		} else {
			out.push(full);
		}
	}
	return out;
}

test('positive control: the mutation matcher hits a fixture "insert into Election (Id) values (\'x\')"', () => {
	const fixture = "insert into Election (Id) values ('x')";
	assert.match(
		fixture,
		MUTATION_RE,
		'matcher is inert — it must hit its own positive-control fixture before the real scan below can be trusted',
	);
});

test('no file under src/ contains an insert/update/delete statement, once comments are stripped', () => {
	const files = walkFiles(SRC_DIR);
	/** @type {string[]} */
	const offenders = [];
	for (const file of files) {
		const raw = readFileSync(file, 'utf8');
		const stripped = stripComments(raw);
		if (MUTATION_RE.test(stripped)) {
			offenders.push(path.relative(APP_ROOT, file));
		}
	}
	assert.deepEqual(
		offenders,
		[],
		`found mutation-shaped statement(s) under src/: ${offenders.join(', ')} — this phase makes no writes; if a later phase adds one, update this test deliberately rather than letting it silently pass`,
	);
});
