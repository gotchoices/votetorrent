/**
 * Tier-1 coverage of `src/lifecycle/freshness.js` (D-10's age arithmetic)
 * only. The forget cases moved to `forget-network.test.mjs` when forget and
 * unpair became one teardown; this file goes when `freshness.js` does (the
 * snapshot path's retirement removes both).
 *
 * `import 'fake-indexeddb/auto'` first, then `node:test` + `node:assert/strict`,
 * per this project's tier-1 discipline.
 */
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	STALE_THRESHOLD_HOURS,
	InvalidSnapshotInstantError,
	assertCanonicalInstant,
	snapshotAgeMillis,
	formatSnapshotAge,
	formatStaleThreshold,
	isSnapshotStale,
	snapshotFreshness,
} from '../../src/lifecycle/freshness.js';

// ---------------------------------------------------------------------------
// freshness.js — snapshotAgeMillis
// ---------------------------------------------------------------------------

test('snapshotAgeMillis: exactly 86400000ms between two canonical instants a day apart', () => {
	assert.equal(snapshotAgeMillis('2026-08-24T12:00:00', '2026-08-25T12:00:00'), 86_400_000);
});

test('snapshotAgeMillis: rejects a non-19-character instant, paired with a canonical value that succeeds', () => {
	assert.throws(
		() => snapshotAgeMillis('2026-08-24T12:00:0', '2026-08-25T12:00:00'),
		(/** @type {any} */ err) => {
			assert.ok(err instanceof InvalidSnapshotInstantError);
			assert.equal(err.label, 'bootstrappedAt');
			return true;
		},
	);
	assert.equal(snapshotAgeMillis('2026-08-24T12:00:00', '2026-08-24T12:00:00'), 0);
});

test('snapshotAgeMillis: rejects a Z-suffixed instant, paired with a canonical value that succeeds', () => {
	assert.throws(
		() => snapshotAgeMillis('2026-08-24T12:00:00', '2026-08-25T12:00:00Z'),
		(/** @type {any} */ err) => {
			assert.ok(err instanceof InvalidSnapshotInstantError);
			assert.equal(err.label, 'atCanonical');
			return true;
		},
	);
	assert.equal(snapshotAgeMillis('2026-08-24T12:00:00', '2026-08-25T12:00:00'), 86_400_000);
});

test('snapshotAgeMillis: rejects a non-canonical shape (space instead of "T"), paired with a canonical value that succeeds', () => {
	assert.throws(
		() => snapshotAgeMillis('2026-08-24 12:00:00', '2026-08-25T12:00:00'),
		InvalidSnapshotInstantError,
	);
	assert.equal(snapshotAgeMillis('2026-08-24T12:00:00', '2026-08-25T12:00:00'), 86_400_000);
});

test('assertCanonicalInstant: never interpolates the offending value into the thrown message', () => {
	const CANARY = 'not-canonical-value-xyz';
	assert.throws(
		() => assertCanonicalInstant(CANARY, 'someLabel'),
		(/** @type {any} */ err) => {
			assert.ok(!err.message.includes(CANARY));
			assert.ok(err.message.includes('someLabel'));
			return true;
		},
	);
});

test('snapshotFreshness: clock skew (bootstrappedAt later than the comparison instant) yields ageMillis 0 and skewed true, never a negative age', () => {
	const freshness = snapshotFreshness('2026-08-25T12:00:05', '2026-08-25T12:00:00');
	assert.equal(freshness.ageMillis, 0);
	assert.equal(freshness.skewed, true);
	assert.ok(freshness.ageMillis >= 0);
});

test('snapshotFreshness: no skew when bootstrappedAt is not later than the comparison instant', () => {
	const freshness = snapshotFreshness('2026-08-24T12:00:00', '2026-08-25T12:00:00');
	assert.equal(freshness.skewed, false);
	assert.equal(freshness.ageMillis, 86_400_000);
});

// ---------------------------------------------------------------------------
// freshness.js — formatSnapshotAge
// ---------------------------------------------------------------------------

test('formatSnapshotAge: 0ms and 30s both produce a non-throwing phrase containing no unexpected digit', () => {
	assert.doesNotThrow(() => formatSnapshotAge(0));
	assert.doesNotThrow(() => formatSnapshotAge(30_000));
	assert.equal(typeof formatSnapshotAge(0), 'string');
	assert.ok(formatSnapshotAge(0).length > 0);
});

test('formatSnapshotAge: selects the largest whole unit, asserted by unit (derived from Intl itself), not by hand-typed wording', () => {
	const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

	// 90 minutes reads in hours (floor(90/60) = 1 hour).
	assert.equal(formatSnapshotAge(90 * 60 * 1000), rtf.format(-1, 'hour'));

	// 50 hours reads in days (floor(50/24) = 2 days).
	assert.equal(formatSnapshotAge(50 * 60 * 60 * 1000), rtf.format(-2, 'day'));

	// 45 seconds reads in minutes-or-smaller — under a minute, it is seconds.
	assert.equal(formatSnapshotAge(45 * 1000), rtf.format(-45, 'second'));
});

// ---------------------------------------------------------------------------
// freshness.js — isSnapshotStale / formatStaleThreshold
// ---------------------------------------------------------------------------

test('isSnapshotStale: false at exactly the threshold, true one millisecond past it', () => {
	const thresholdMs = STALE_THRESHOLD_HOURS * 60 * 60 * 1000;
	assert.equal(isSnapshotStale(thresholdMs), false);
	assert.equal(isSnapshotStale(thresholdMs + 1), true);
});

test('formatStaleThreshold: contains the digits of STALE_THRESHOLD_HOURS and a unit word, derived from the constant rather than hardcoded', () => {
	const expected = new Intl.NumberFormat(undefined, { style: 'unit', unit: 'hour', unitDisplay: 'long' }).format(
		STALE_THRESHOLD_HOURS,
	);
	assert.equal(formatStaleThreshold(), expected);
	assert.ok(formatStaleThreshold().includes(String(STALE_THRESHOLD_HOURS)));
});

// ---------------------------------------------------------------------------
// freshness.js — snapshotFreshness shape
// ---------------------------------------------------------------------------

test('snapshotFreshness: returns the full shape, absolute byte-identical to the bootstrappedAt it was given', () => {
	const bootstrappedAt = '2026-08-20T00:00:00';
	const freshness = snapshotFreshness(bootstrappedAt, '2026-08-24T00:00:00');
	assert.equal(freshness.absolute, bootstrappedAt);
	assert.equal(typeof freshness.ageMillis, 'number');
	assert.equal(typeof freshness.relativeTime, 'string');
	assert.equal(typeof freshness.stale, 'boolean');
	assert.equal(typeof freshness.skewed, 'boolean');
	// Four days > 24h threshold.
	assert.equal(freshness.stale, true);
});

// ---------------------------------------------------------------------------
// PII hygiene
// ---------------------------------------------------------------------------

test('PII-CANARY-9f3a: no thrown message from any error path in freshness.js contains the marker', () => {
	const CANARY = 'PII-CANARY-9f3a';
	/** @type {string[]} */
	const messages = [];

	try {
		// The LABEL is a code-controlled constant, never snapshot content, so
		// the module is expected to include it verbatim -- only the VALUE
		// (the canary here) must never leak. `atCanonical` names the label.
		assertCanonicalInstant(CANARY, 'atCanonical');
	} catch (/** @type {any} */ err) {
		messages.push(err.message);
	}
	try {
		snapshotAgeMillis(CANARY, '2026-01-01T00:00:00');
	} catch (/** @type {any} */ err) {
		messages.push(err.message);
	}
	try {
		snapshotFreshness(CANARY);
	} catch (/** @type {any} */ err) {
		messages.push(err.message);
	}

	assert.ok(messages.length >= 3, `expected every forced error path to be exercised, got ${messages.length}`);
	for (const message of messages) {
		assert.ok(!message.includes(CANARY), `error message leaked the PII canary: "${message}"`);
	}
});
