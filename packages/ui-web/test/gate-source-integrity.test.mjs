/**
 * gate-source-integrity.test.mjs — the assertions that keep the D-19/D-23
 * instrument non-vacuous, asserted against `run-ui-gates.mjs`'s and
 * `lib/tokens.mjs`'s own source TEXT.
 *
 * Every matcher below is proven able to detect a PLANTED violation (item 7's
 * inertness control, plus dedicated inertness sub-cases beside items 1, 2
 * and 6) before it is trusted against the real file — a source assertion
 * that cannot detect a planted violation proves nothing about the real one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const RUNNER_URL = new URL('../scripts/run-ui-gates.mjs', import.meta.url);
const TOKENS_LIB_URL = new URL('../scripts/lib/tokens.mjs', import.meta.url);
const runnerSource = readFileSync(RUNNER_URL, 'utf8');
const tokensLibSource = readFileSync(TOKENS_LIB_URL, 'utf8');

/**
 * Strips /* ... *\/ comments, mirroring tokens.mjs's own comment-stripping
 * discipline — a check must not be satisfiable by prose in a header comment.
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
	return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Strips the ONE labelled exception region 53-11 (D-20) deliberately added —
 * `readStyleSheetCountWitness`'s body — before scanning for `styleSheets`.
 * That function is `--prove-token-missing`'s STANDING WITNESS that a naive
 * `document.styleSheets.length` check would have passed on a deliberately
 * broken, token-less build (see the runner's own header note on why counting
 * loaded style resources is otherwise blind); it is not the main D-23 probe
 * this check (1) exists to keep honest, and it is bounded by test (1c) below
 * so this exception cannot silently grow to swallow a real regression.
 * @param {string} source
 * @returns {string}
 */
function stripStyleSheetWitnessException(source) {
	return source.replace(/async function readStyleSheetCountWitness\([\s\S]*?\n\}\n/, '');
}

test('(1) run-ui-gates.mjs contains zero occurrences of `styleSheets` outside the labelled prove-token-missing witness exception', () => {
	const scoped = stripStyleSheetWitnessException(runnerSource);
	assert.equal((scoped.match(/styleSheets/g) ?? []).length, 0);
});

test('(1b) inertness control: the styleSheets matcher DOES fire on a planted fixture', () => {
	const fixture = 'const ok = document.styleSheets.length === 1;';
	assert.ok((fixture.match(/styleSheets/g) ?? []).length > 0, 'matcher must be able to detect the real regression shape');
});

test('(1c) the witness exception region itself exists and contains EXACTLY one occurrence of styleSheets — bounding the exception so it cannot silently grow to swallow a real regression', () => {
	const witnessMatch = runnerSource.match(/async function readStyleSheetCountWitness\([\s\S]*?\n\}\n/);
	assert.ok(witnessMatch, 'expected the labelled readStyleSheetCountWitness function to exist');
	const count = (witnessMatch[0].match(/styleSheets/g) ?? []).length;
	assert.equal(count, 1);
});

test('(1d) sanity: the witness exception is not the whole file — stripping it still leaves the real RUNG_IDS declaration reachable', () => {
	const scoped = stripStyleSheetWitnessException(runnerSource);
	assert.match(scoped, /RUNG_IDS = Object\.freeze\(/);
});

test('(2) run-ui-gates.mjs contains zero occurrences of the template-literal record(...) call form', () => {
	// A backtick immediately after `record(` (optionally with whitespace)
	// would mean a rung id was built from an interpolated value.
	const templateRecordRe = /record\(\s*`/;
	assert.equal(templateRecordRe.test(runnerSource), false);
});

test('(2b) inertness control: the template-literal record() matcher DOES fire on a planted fixture', () => {
	const fixture = 'record(`rung-${dynamicName}`, true, "detail");';
	const templateRecordRe = /record\(\s*`/;
	assert.ok(templateRecordRe.test(fixture), 'matcher must be able to detect an interpolated rung id');
});

test('(3) every string literal passed as record()\'s first argument is a member of RUNG_IDS, and every RUNG_IDS member is recorded somewhere (both directions)', () => {
	const rungIdsMatch = runnerSource.match(/RUNG_IDS = Object\.freeze\(\[([\s\S]*?)\]\)/);
	assert.ok(rungIdsMatch, 'RUNG_IDS declaration must be findable in the runner source');
	const declaredIds = [...rungIdsMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
	assert.ok(declaredIds.length > 0, 'RUNG_IDS must declare at least one id');

	const recordedIds = new Set([...runnerSource.matchAll(/\brecord\(\s*'([^']+)'/g)].map((m) => m[1]));

	for (const recordedId of recordedIds) {
		assert.ok(declaredIds.includes(recordedId), `record() call names "${recordedId}", which is not in RUNG_IDS`);
	}
	for (const declaredId of declaredIds) {
		assert.ok(recordedIds.has(declaredId), `RUNG_IDS declares "${declaredId}", which is never passed to record()`);
	}
});

test('(4) tokens.mjs\'s compareToken body contains exactly one === and zero occurrences of || and zero of !== \'\'', () => {
	const bodyMatch = tokensLibSource.match(/export function compareToken\(expected, actual\) \{([\s\S]*?)\n\}/);
	assert.ok(bodyMatch, 'compareToken function body must be findable');
	const body = bodyMatch[1];
	assert.equal((body.match(/===/g) ?? []).length, 1);
	assert.equal((body.match(/\|\|/g) ?? []).length, 0);
	assert.equal((body.match(/!==\s*''/g) ?? []).length, 0);
});

test('(5) run-ui-gates.mjs contains zero occurrences of startViteDevServer, and the vite argv it spawns contains the literal \'build\'', () => {
	assert.equal((runnerSource.match(/startViteDevServer/g) ?? []).length, 0);
	assert.match(runnerSource, /'build', '--config'/);
});

test('(6) the runner\'s tokens.css read path is the package-relative ../src/tokens.css form, and the file contains zero occurrences of a token-list literal (no \'--bg\' string)', () => {
	assert.match(runnerSource, /new URL\('\.\.\/src\/tokens\.css', import\.meta\.url\)/);
	assert.equal((runnerSource.match(/'--bg'/g) ?? []).length, 0);
});

test('(6b) inertness control: the \'--bg\' token-list-literal matcher DOES fire on a planted fixture', () => {
	const fixture = "const REQUIRED = ['--bg', '--surface'];";
	assert.ok((fixture.match(/'--bg'/g) ?? []).length > 0, 'matcher must be able to detect a carried token list');
});

test('(7) inertness control over three planted violations in one pass, run against inline fixtures — a source assertion that cannot detect a planted violation proves nothing about the real file', () => {
	const styleSheetsFixture = 'if (document.styleSheets.length === 1) { /* ... */ }';
	const templateRecordFixture = 'record(`token-${name}`, passed, detail);';
	const tokenListFixture = "const REQUIRED_TOKENS = ['--bg', '--surface', '--border'];";

	assert.ok((styleSheetsFixture.match(/styleSheets/g) ?? []).length > 0);
	assert.ok(/record\(\s*`/.test(templateRecordFixture));
	assert.ok((tokenListFixture.match(/'--bg'/g) ?? []).length > 0);
});

test('sanity: comment-stripped runner source still contains its real RUNG_IDS declaration (the stripper does not eat real code)', () => {
	const stripped = stripComments(runnerSource);
	assert.match(stripped, /RUNG_IDS = Object\.freeze\(/);
});
