/**
 * Tier-1 assertions over the DASHBOARD'S USE of `@votetorrent/ui-web`'s `COPY` table
 * and `t()` helper -- coupling the table to `BOOTSTRAP_PHASES`, `copyKeysForOutcome`
 * and `Bootstrap.tsx`'s own source wiring, plus the dashboard-tree source scans.
 *
 * The table-and-`t()`-only assertions (the ones whose SUBJECT is the table itself,
 * including the D-25 refusal-family block and the D-10 header-contract assertions)
 * moved to `packages/ui-web/test/copy.test.mjs` in 53-04 Task 3 (D-25) -- this file
 * keeps only what couples `COPY`/`t()` to a dashboard module or reads the dashboard's
 * own source tree.
 *
 * Browser-free, no display -- plain node:test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { dashboardRoot, dashboardSrc, moduleUrl, uiWebSrc } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';
import { COPY, t } from '@votetorrent/ui-web';

const { BOOTSTRAP_PHASES, BOOTSTRAP_OUTCOME_CODES, copyKeysForOutcome } =
	/** @type {typeof import('../../src/lifecycle/bootstrap.js')} */ (
		await import(moduleUrl(dashboardSrc('lifecycle', 'bootstrap.js')))
	);

const { STATUS_KINDS, CHIP_KINDS, UNPAIRED_REASONS } =
	/** @type {typeof import('../../src/live/status.js')} */ (
		await import(moduleUrl(dashboardSrc('live', 'status.js')))
	);

test('every BOOTSTRAP_PHASES member has a matching bootstrap.phase.<value> key in COPY, derived mechanically -- never a hand-written phase list', () => {
	// The defect this pins: the screen rendered `{state.phase}` directly, so
	// the officer saw the literal machine identifiers "submitting",
	// "applying-schema" and friends in an aria-live region. The expectation
	// here is built from the imported BOOTSTRAP_PHASES array itself, exactly
	// mirroring the template Bootstrap.tsx applies
	// (`` `bootstrap.phase.${state.phase}` ``) -- a hand-written list of five
	// strings in this test would not catch a drift between the two.
	for (const phase of BOOTSTRAP_PHASES) {
		const key = `bootstrap.phase.${phase}`;
		assert.ok(key in COPY, `expected COPY to have a "${key}" key for BOOTSTRAP_PHASES member "${phase}"`);
		assert.ok(t(key).length > 0);
	}
});

// ---------------------------------------------------------------------------
// Live-dashboard copy coupling (66-05): the keys the status reducer's lists and
// the pairing module's failure values imply. Derived from the imported lists,
// never from a hand-written copy of them.
// ---------------------------------------------------------------------------

test('every CHIP_KINDS member has a status.chip.<kind> key, derived mechanically from status.js', () => {
	for (const kind of CHIP_KINDS) {
		const key = `status.chip.${kind}`;
		assert.ok(key in COPY, `expected COPY to have "${key}" for CHIP_KINDS member "${kind}"`);
		assert.ok(COPY[key].length > 0);
	}
	assert.ok('status.chip.offline-no-update' in COPY);
	assert.throws(() => t('status.chip.offline'), (err) => err instanceof Error && err.message.includes('time'));
	assert.equal(t('status.chip.offline', { time: '09:41' }), 'Offline \u00b7 last update 09:41');
});

test('STATUS_KINDS minus CHIP_KINDS is exactly unpaired, which renders the pairing notice instead of a chip', () => {
	assert.deepEqual(
		STATUS_KINDS.filter((k) => !CHIP_KINDS.includes(k)),
		['unpaired'],
	);
});

test('every UNPAIRED_REASONS member has an unpaired.body.<reason> key that resolves', () => {
	for (const reason of UNPAIRED_REASONS) {
		const key = `unpaired.body.${reason}`;
		assert.ok(key in COPY, `expected COPY to have "${key}" for UNPAIRED_REASONS member "${reason}"`);
		assert.ok(t(key, { officerName: 'Alex', authorityName: 'Example Authority' }).length > 0);
	}
});

test('the read-only action-note pair that ReadOnlyNote resolves by variant exists', () => {
	assert.ok('panel.readOnly.short' in COPY);
	assert.ok('panel.readOnly.long' in COPY);
});

// The pairing failure values that show a failure screen. This literal is the
// list the pairing module will export once `src/peer/pairing.js` lands; the
// plan that adds that export replaces this literal with an import.
const PAIRING_FAILURE_COPY_REASONS = [
	'malformed',
	'old-style',
	'expired',
	'spent',
	'unreachable',
	'digest-mismatch',
	'officer-not-valid',
	'no-storage',
	'unsupported',
];

test('every pairing failure reason that has a screen has a heading and a body, and the step rows exist', () => {
	for (const reason of PAIRING_FAILURE_COPY_REASONS) {
		assert.ok(`pairing.failed.${reason}.heading` in COPY, `missing heading for ${reason}`);
		assert.ok(`pairing.failed.${reason}.body` in COPY, `missing body for ${reason}`);
	}
	for (const step of ['connecting', 'joining', 'first-sync']) {
		assert.ok(`pairing.step.${step}` in COPY, `missing step row ${step}`);
	}
});

const LIVE_COPY_PREFIXES = ['pairing.', 'scanner.', 'status.', 'swap.', 'forget.', 'unpaired.', 'panel.readOnly.', 'switcher.', 'shell.', 'marks.'];

test('live-dashboard copy lives only in the table: no long value of the new keys appears in the live modules', () => {
	// Positive control: the same matcher finds a known value in the table's own source.
	const tableSource = readFileSync(uiWebSrc('copy.js'), 'utf8');
	assert.ok(tableSource.includes('Pair this browser'));
	const longValues = Object.keys(COPY)
		.filter((k) => LIVE_COPY_PREFIXES.some((p) => k.startsWith(p)))
		.map((k) => COPY[k])
		.filter((v) => v.length >= 8);
	assert.ok(longValues.length > 60);
	for (const file of ['status.js', 'change-marks.js']) {
		const src = stripComments(readFileSync(dashboardSrc('live', file), 'utf8'));
		for (const v of longValues) {
			assert.ok(!src.includes(v), `src/live/${file} carries user-facing copy: ${v}`);
		}
	}
});

test('t(`bootstrap.phase.<unmapped>`) throws naming the key, so a new phase cannot silently render raw', () => {
	assert.throws(
		() => t('bootstrap.phase.not-a-phase'),
		(err) => err instanceof Error && err.message.includes('bootstrap.phase.not-a-phase'),
	);
});

// ---------------------------------------------------------------------------
// D-25: the status a service answers picks a refusal family. This local table
// describes what `copyKeysForOutcome` (a DASHBOARD function) must select for
// each status -- it is a selection-logic fixture, not a re-test of the moved
// table's own content (that content -- the pairwise-different wording, the
// per-family action token -- is asserted in packages/ui-web/test/copy.test.mjs
// against the table itself).
// ---------------------------------------------------------------------------

/** @type {ReadonlyArray<{ status: string, headingKey: string, bodyKey: string }>} */
const REFUSAL_STATUS_KEYS = Object.freeze([
	{ status: 'unknown', headingKey: 'bootstrap.errorCodeNotRecognizedHeading', bodyKey: 'bootstrap.errorCodeNotRecognizedBody' },
	{ status: 'used', headingKey: 'bootstrap.errorCodeAlreadyUsedHeading', bodyKey: 'bootstrap.errorCodeAlreadyUsedBody' },
	{ status: 'expired', headingKey: 'bootstrap.errorCodeTimedOutHeading', bodyKey: 'bootstrap.errorCodeTimedOutBody' },
]);

/** Every file under `src/`, so the conflated-sentence check below covers the
 * whole surface the behavior bullet names -- not just the copy table. A
 * comment quoting the old sentence would re-introduce it as searchable text
 * and is deliberately caught too. */
function walkSrc(/** @type {string} */ dir) {
	/** @type {string[]} */
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === 'node_modules' || entry.name === 'dist') continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walkSrc(full));
		else out.push(full);
	}
	return out;
}

test('D-25: the conflated sentence is REPLACED, not supplemented -- "already been used" appears in no file under src/', () => {
	const copyFile = uiWebSrc('copy.js');
	// Positive control FIRST: the same substring matcher, on the same file,
	// finds a string that IS present. Without this, a matcher that silently
	// stopped working (wrong path, empty read) would report a green pass.
	assert.ok(
		readFileSync(copyFile, 'utf8').includes('Try another code'),
		'matcher is inert -- the "Try another code" positive control was not found in copy.js',
	);
	const offenders = walkSrc(dashboardSrc()).filter((/** @type {string} */ file) =>
		readFileSync(file, 'utf8').includes('already been used'),
	);
	assert.deepEqual(
		offenders.map((/** @type {string} */ f) => path.relative(dashboardRoot(), f)),
		[],
		'the conflated sentence fragment "already been used" survives -- the old string must be replaced, not moved under a new key or quoted back into a comment',
	);
});

test('D-25: bootstrap.errorInvalidCodeCta survives -- VERIFICATION_KEYS and SCHEMA_MISMATCH_KEYS borrow it', () => {
	assert.ok('bootstrap.errorInvalidCodeCta' in COPY);
	assert.ok(t('bootstrap.errorInvalidCodeCta').length > 0);
});

test('D-25: bootstrap.errorInvalidCodeBody now answers the LOCAL malformed-paste case only', () => {
	const body = t('bootstrap.errorInvalidCodeBody');
	assert.ok(
		!body.toLowerCase().includes('already been used'),
		`errorInvalidCodeBody must not answer a refusal it cannot know about: "${body}"`,
	);
	// A code that never left the browser cannot have gone stale or been spent,
	// so the only honest next action is a local one: re-copy and re-paste.
	assert.ok(body.toLowerCase().includes('paste'), `expected a local next action in: "${body}"`);
});

// ---------------------------------------------------------------------------
// D-25 selection: the status the service answered picks the family.
//
// Each rejection below asserts the REASON in the thrown message and is paired,
// in the same test, with a call that SUCCEEDS -- so a `copyKeysForOutcome`
// that threw unconditionally could not pass any of them.
// ---------------------------------------------------------------------------

test('D-25: the three redemption statuses select three DIFFERENT copy families', () => {
	const selected = REFUSAL_STATUS_KEYS.map((family) => ({
		status: family.status,
		keys: copyKeysForOutcome('code-refused', undefined, family.status),
	}));
	for (const { status, keys } of selected) {
		const expected = REFUSAL_STATUS_KEYS.find((f) => f.status === status);
		assert.ok(expected, `no declared family for status "${status}"`);
		assert.equal(keys.headingKey, expected.headingKey, `status "${status}" selected the wrong heading key`);
		assert.equal(keys.bodyKey, expected.bodyKey, `status "${status}" selected the wrong body key`);
	}
	const headingKeys = new Set(selected.map((s) => s.keys.headingKey));
	const bodyKeys = new Set(selected.map((s) => s.keys.bodyKey));
	assert.equal(headingKeys.size, 3, `expected 3 distinct heading keys, observed ${[...headingKeys].join(', ')}`);
	assert.equal(bodyKeys.size, 3, `expected 3 distinct body keys, observed ${[...bodyKeys].join(', ')}`);
});

test('D-25: copyKeysForOutcome("code-refused") with NO status throws naming the outcome and the requirement -- never a silent fall back to the generic copy', () => {
	// Positive control in the same test: the identical call WITH a status
	// succeeds, so this cannot pass by the function being broken outright.
	assert.deepEqual(copyKeysForOutcome('code-refused', undefined, 'unknown'), {
		headingKey: 'bootstrap.errorCodeNotRecognizedHeading',
		bodyKey: 'bootstrap.errorCodeNotRecognizedBody',
		ctaKey: 'bootstrap.errorInvalidCodeCta',
	});
	assert.throws(
		() => copyKeysForOutcome('code-refused'),
		(err) =>
			err instanceof Error &&
			err.message.includes('code-refused') &&
			/requires a status/.test(err.message),
		'a code-refused with no status must be a LOUD programming error -- defaulting would re-conflate all three refusals invisibly',
	);
});

test('D-25: copyKeysForOutcome("code-refused", undefined, "ok") throws -- an ok status is not a refusal', () => {
	assert.doesNotThrow(() => copyKeysForOutcome('code-refused', undefined, 'used'));
	assert.throws(
		() => copyKeysForOutcome('code-refused', undefined, 'ok'),
		(err) => err instanceof Error && err.message.includes('"ok"') && /not a refusal/.test(err.message),
	);
});

test('D-25: copyKeysForOutcome("code-refused", undefined, <unmapped>) throws NAMING the offending value', () => {
	assert.doesNotThrow(() => copyKeysForOutcome('code-refused', undefined, 'expired'));
	assert.throws(
		() => copyKeysForOutcome('code-refused', undefined, 'not-a-status'),
		(err) => err instanceof Error && err.message.includes('not-a-status'),
	);
});

test('D-25: every other outcome is unchanged -- only the code-refused arm moved', () => {
	const invalid = { headingKey: 'bootstrap.errorInvalidCodeHeading', bodyKey: 'bootstrap.errorInvalidCodeBody', ctaKey: 'bootstrap.errorInvalidCodeCta' };
	const transport = { headingKey: 'bootstrap.errorTransportHeading', bodyKey: 'bootstrap.errorTransportBody', ctaKey: 'bootstrap.errorTransportCta' };
	const verification = { headingKey: 'snapshot.errorVerificationHeading', bodyKey: 'snapshot.errorVerificationBody', ctaKey: 'bootstrap.errorInvalidCodeCta' };
	const schema = { headingKey: 'snapshot.errorSchemaMismatchHeading', bodyKey: 'snapshot.errorSchemaMismatchBody', ctaKey: 'bootstrap.errorInvalidCodeCta' };

	assert.deepEqual(copyKeysForOutcome('invalid-code'), invalid);
	assert.deepEqual(copyKeysForOutcome('already-bootstrapped'), invalid);
	assert.deepEqual(copyKeysForOutcome('verify-failed', 'network-hash-mismatch'), invalid);
	assert.deepEqual(copyKeysForOutcome('transport-unreachable'), transport);
	assert.deepEqual(copyKeysForOutcome('restore-incomplete'), verification);
	assert.deepEqual(copyKeysForOutcome('officer-indeterminate'), schema);
	for (const reason of ['malformed-envelope', 'manifest-mismatch', 'digest-mismatch']) {
		assert.deepEqual(copyKeysForOutcome('verify-failed', reason), verification, `verify-failed/${reason}`);
	}
	for (const reason of ['format-version-mismatch', 'schema-hash-mismatch', 'non-canonical-generated-at']) {
		assert.deepEqual(copyKeysForOutcome('verify-failed', reason), schema, `verify-failed/${reason}`);
	}
	assert.throws(() => copyKeysForOutcome('ok'), /has no error copy/);
	assert.throws(() => copyKeysForOutcome('not-a-real-outcome'), /unmapped outcome/);
});

// ---------------------------------------------------------------------------
// The machine-identifier gate (T-52-12-01).
//
// SCOPE: exactly the copy `copyKeysForOutcome` can produce -- enumerated by
// WALKING the outcome / reason / status space, never from a hand-written key
// list, so a twelfth key added later is covered the day it is added.
//
// NOT the whole COPY table, deliberately: `network.swapErrorBody` belongs to
// DashboardShell's swap banner (a family reached through `swapError`, never
// through `copyKeysForOutcome`) and legitimately contains the word "used" in
// ordinary English. A table-wide ban would be unsatisfiable without editing a
// string this plan has no business editing.
//
// The forbidden token list is DERIVED: every BOOTSTRAP_OUTCOME_CODES member
// (all hyphenated, so no false positives) plus the three refusal statuses.
// `'ok'` is deliberately excluded -- a two-letter substring match fires on
// ordinary prose ("looks", "broken"), and a check that cries wolf is a check
// that gets deleted.
// ---------------------------------------------------------------------------

const ALL_VERIFY_REASONS_FOR_GATE = Object.freeze([
	'malformed-envelope',
	'format-version-mismatch',
	'non-canonical-generated-at',
	'network-hash-mismatch',
	'schema-hash-mismatch',
	'manifest-mismatch',
	'digest-mismatch',
]);

/** Every (key, value) pair reachable through copyKeysForOutcome. */
function reachableCopy() {
	/** @type {Array<[string, string]>} */
	const pairs = [];
	const collect = (/** @type {{ headingKey: string, bodyKey: string, ctaKey: string }} */ keys) => {
		for (const key of [keys.headingKey, keys.bodyKey, keys.ctaKey]) pairs.push([key, t(key)]);
	};
	for (const outcome of BOOTSTRAP_OUTCOME_CODES) {
		if (outcome === 'ok') continue;
		if (outcome === 'verify-failed') {
			for (const reason of ALL_VERIFY_REASONS_FOR_GATE) collect(copyKeysForOutcome(outcome, reason));
			continue;
		}
		if (outcome === 'code-refused') {
			for (const status of REFUSAL_STATUS_KEYS.map((f) => f.status)) collect(copyKeysForOutcome(outcome, undefined, status));
			continue;
		}
		collect(copyKeysForOutcome(outcome));
	}
	return pairs;
}

test('D-25: copyKeysForOutcome is TOTAL over the whole outcome/reason/status space -- every key resolves through t()', () => {
	const pairs = reachableCopy();
	assert.ok(pairs.length >= 11, `expected at least 11 reachable (key, value) pairs, observed ${pairs.length}`);
	const distinctKeys = new Set(pairs.map(([key]) => key));
	assert.ok(distinctKeys.size >= 11, `expected at least 11 distinct reachable keys, observed ${distinctKeys.size}`);
	for (const [key, value] of pairs) {
		assert.equal(typeof value, 'string', `${key} did not resolve to a string`);
		assert.ok(value.length > 0, `${key} resolved empty`);
	}
});

test('T-52-12-01: no copy an officer can reach through copyKeysForOutcome contains a machine identifier', () => {
	const forbidden = [...BOOTSTRAP_OUTCOME_CODES.filter((code) => code !== 'ok'), 'unknown', 'expired', 'used'];

	// POSITIVE CONTROL FIRST: the matcher fires on a fixture that DOES contain
	// one. Without this, a matcher broken to always-false would report green
	// over the whole space.
	const fixture = 'Sorry, the service answered unknown for that code.';
	const fixtureHits = forbidden.filter((token) => fixture.toLowerCase().includes(token));
	assert.deepEqual(fixtureHits, ['unknown'], 'matcher is inert -- the positive-control fixture did not trip it');

	for (const [key, value] of reachableCopy()) {
		const lowered = value.toLowerCase();
		for (const token of forbidden) {
			assert.ok(
				!lowered.includes(token),
				`COPY.${key} leaks the machine identifier "${token}" into text an officer reads: "${value}"`,
			);
		}
	}
});

// ---------------------------------------------------------------------------
// Source-level wiring for the .tsx (`node --test` cannot import it) -- the
// idiom `bootstrap-redemption.test.mjs` already established. Both matchers are
// paired with an inertness control.
// ---------------------------------------------------------------------------

const BOOTSTRAP_TSX_SOURCE = readFileSync(dashboardSrc('screens', 'Bootstrap.tsx'), 'utf8');
const BOOTSTRAP_TSX_CODE = stripComments(BOOTSTRAP_TSX_SOURCE);

test('D-25 wiring: Bootstrap.tsx passes the status as the THIRD argument to copyKeysForOutcome', () => {
	// Positive control: the file really was read and really is the screen.
	assert.ok(
		BOOTSTRAP_TSX_CODE.includes('export function Bootstrap('),
		'matcher is inert -- Bootstrap.tsx was not read (wrong path or empty file)',
	);
	assert.ok(
		BOOTSTRAP_TSX_CODE.includes('copyKeysForOutcome(state.outcome, state.reason, state.status)'),
		'Bootstrap.tsx must plumb the redemption status into the copy lookup -- without it every refusal renders the same family',
	);
});

test('inertness control: the three-argument matcher does NOT accept the old two-argument call', () => {
	const fixture = "const errorCopy = copyKeysForOutcome(state.outcome, state.reason);";
	assert.ok(
		!fixture.includes('copyKeysForOutcome(state.outcome, state.reason, state.status)'),
		'matcher is inert -- it accepted the pre-plan two-argument call site',
	);
});

test('D-25 wiring: ScreenState\'s error variant declares the optional status field', () => {
	assert.match(BOOTSTRAP_TSX_CODE, /kind: 'error';[^}]*status\?: string/);
	// Inertness control: a variant WITHOUT the field must not match.
	assert.doesNotMatch("| { kind: 'error'; outcome: string; reason?: string }", /kind: 'error';[^}]*status\?: string/);
});
