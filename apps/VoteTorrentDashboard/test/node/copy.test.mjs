/**
 * Tier-1 assertions over the DASHBOARD'S USE of `@votetorrent/ui-web`'s `COPY` table
 * and `t()` helper: the status reducer's kinds and reasons (`src/live/status.js`), the
 * read-only action note's variants and the pairing screen's failure reasons must each
 * have their copy keys, and the live modules carry no user-facing copy of their own.
 *
 * The table-and-`t()`-only assertions (the ones whose SUBJECT is the table itself)
 * live in `packages/ui-web/test/copy.test.mjs`; this file keeps only what couples
 * `COPY`/`t()` to a dashboard module or reads the dashboard's own source tree.
 *
 * Browser-free, no display -- plain node:test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dashboardSrc, moduleUrl, uiWebSrc } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';
import { COPY, t } from '@votetorrent/ui-web';

const { STATUS_KINDS, CHIP_KINDS, UNPAIRED_REASONS } =
	/** @type {typeof import('../../src/live/status.js')} */ (
		await import(moduleUrl(dashboardSrc('live', 'status.js')))
	);

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
