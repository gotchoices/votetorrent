/**
 * Tier-1 coverage of `src/live/status.js`, the pure header-status reducer:
 * the state table, the "status truth" and "switch: no Live carry-over" rows,
 * the terminal unpaired state, purity and a comment-stripped source scan.
 * Browser-free, no clock, no fake-indexeddb.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dashboardSrc, moduleUrl } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';

const mod = /** @type {typeof import('../../src/live/status.js')} */ (
	await import(moduleUrl(dashboardSrc('live', 'status.js')))
);
const {
	LIVE_FRESH_WINDOW_MS,
	OFFLINE_GRACE_MS,
	BACKGROUND_RETRY_MS,
	STATUS_DEBOUNCE_MS,
	STATUS_KINDS,
	CHIP_KINDS,
	UNPAIRED_REASONS,
	STATUS_EVENT_TYPES,
	initialStatus,
	reduceStatus,
	viewStatus,
} = mod;

/**
 * Fold [event, nowMs] pairs through reduceStatus from a starting state.
 * @param {import('../../src/live/status.js').StatusState} start
 * @param {Array<[{ type: string, [k: string]: unknown }, number]>} steps
 */
function fold(start, steps) {
	return steps.reduce((s, [ev, at]) => reduceStatus(s, ev, at), start);
}

const T0 = 1_000_000;
/** A state that is Live at T0 + 5000 with lastPassAt = T0 + 5000. */
function liveState() {
	return fold(initialStatus({ lastPassAt: null }), [
		[{ type: 'reset', lastPassAt: null }, T0],
		[{ type: 'control-connected' }, T0 + 1000],
		[{ type: 'strand-peers', count: 2 }, T0 + 2000],
		[{ type: 'pass-start' }, T0 + 3000],
		[{ type: 'pass-complete', at: T0 + 5000 }, T0 + 5000],
	]);
}

test('constants have the contract values and the frozen lists agree', () => {
	assert.equal(LIVE_FRESH_WINDOW_MS, 40000);
	assert.equal(OFFLINE_GRACE_MS, 10000);
	assert.equal(BACKGROUND_RETRY_MS, 20000);
	assert.equal(STATUS_DEBOUNCE_MS, 1000);
	assert.deepEqual(CHIP_KINDS, STATUS_KINDS.filter((k) => k !== 'unpaired'));
	assert.equal(STATUS_EVENT_TYPES.length, 12);
	assert.deepEqual([...UNPAIRED_REASONS], ['revoked', 'removed', 'key-invalid']);
	for (const list of [STATUS_KINDS, CHIP_KINDS, UNPAIRED_REASONS, STATUS_EVENT_TYPES]) {
		assert.ok(Object.isFrozen(list));
	}
});

test('a fresh state reads catching-up at any time; after reset it goes offline only past the grace', () => {
	const s0 = initialStatus({ lastPassAt: null });
	assert.equal(viewStatus(s0, 5).kind, 'catching-up');
	assert.equal(viewStatus(s0, 5_000_000).kind, 'catching-up');
	const s = reduceStatus(s0, { type: 'reset', lastPassAt: null }, T0);
	assert.equal(viewStatus(s, T0 + 9_999).kind, 'catching-up');
	const v = viewStatus(s, T0 + 10_000);
	assert.equal(v.kind, 'offline');
	assert.equal(v.lastPassAt, null);
});

test('status truth: connection and peers alone stay catching-up until a pass completes', () => {
	let s = fold(initialStatus({ lastPassAt: null }), [
		[{ type: 'reset', lastPassAt: null }, T0],
		[{ type: 'control-connected' }, T0 + 100],
		[{ type: 'strand-peers', count: 2 }, T0 + 200],
	]);
	assert.equal(viewStatus(s, T0 + 300).kind, 'catching-up');
	s = reduceStatus(s, { type: 'pass-start' }, T0 + 400);
	assert.equal(viewStatus(s, T0 + 500).kind, 'catching-up');
	s = reduceStatus(s, { type: 'pass-complete', at: T0 + 600 }, T0 + 600);
	const v = viewStatus(s, T0 + 700);
	assert.equal(v.kind, 'live');
	assert.equal(v.lastPassAt, T0 + 600);
});

test('status truth: zero strand peers never reads live even with completed passes', () => {
	const s = fold(initialStatus({ lastPassAt: null }), [
		[{ type: 'reset', lastPassAt: null }, T0],
		[{ type: 'control-connected' }, T0 + 100],
		[{ type: 'strand-peers', count: 0 }, T0 + 200],
		[{ type: 'pass-start' }, T0 + 300],
		[{ type: 'pass-complete', at: T0 + 400 }, T0 + 400],
	]);
	assert.equal(viewStatus(s, T0 + 500).kind, 'catching-up');
});

test('freshness: live at exactly 40 s after the pass, catching-up one ms later', () => {
	const s = liveState();
	const at = T0 + 5000;
	assert.equal(viewStatus(s, at + 40_000).kind, 'live');
	assert.equal(viewStatus(s, at + 40_001).kind, 'catching-up');
});

test('disconnect: catching-up through the grace, offline after, lastPassAt kept', () => {
	const t = T0 + 6000;
	const s = reduceStatus(liveState(), { type: 'control-disconnected' }, t);
	assert.equal(viewStatus(s, t + 9_999).kind, 'catching-up');
	const v = viewStatus(s, t + 10_000);
	assert.equal(v.kind, 'offline');
	assert.equal(v.lastPassAt, T0 + 5000);
});

test('reconnect reads catching-up even with a recent old pass; a new pass is needed for live', () => {
	let s = reduceStatus(liveState(), { type: 'control-disconnected' }, T0 + 6000);
	s = reduceStatus(s, { type: 'control-connected' }, T0 + 7000);
	assert.equal(viewStatus(s, T0 + 7100).kind, 'catching-up');
	s = reduceStatus(s, { type: 'pass-start' }, T0 + 8000);
	s = reduceStatus(s, { type: 'pass-complete', at: T0 + 9000 }, T0 + 9000);
	assert.equal(viewStatus(s, T0 + 9100).kind, 'live');
});

test('switch: no Live carry-over across a reset', () => {
	const X = T0 + 4000;
	const tReset = T0 + 20_000;
	let s = reduceStatus(liveState(), { type: 'reset', lastPassAt: X }, tReset);
	assert.equal(viewStatus(s, tReset).lastPassAt, X);
	s = reduceStatus(s, { type: 'control-connected' }, tReset + 100);
	s = reduceStatus(s, { type: 'strand-peers', count: 3 }, tReset + 200);
	assert.equal(viewStatus(s, tReset + 300).kind, 'catching-up');
	// a pass that completed before the reset is ignored
	s = reduceStatus(s, { type: 'pass-start' }, tReset + 400);
	s = reduceStatus(s, { type: 'pass-complete', at: tReset - 1 }, tReset + 500);
	assert.equal(viewStatus(s, tReset + 600).kind, 'catching-up');
	assert.equal(viewStatus(s, tReset + 600).lastPassAt, X);
	s = reduceStatus(s, { type: 'pass-start' }, tReset + 700);
	s = reduceStatus(s, { type: 'pass-complete', at: tReset + 800 }, tReset + 800);
	assert.equal(viewStatus(s, tReset + 900).kind, 'live');
});

test('a pass that started while disconnected and completes after a connect changes nothing', () => {
	let s = fold(initialStatus({ lastPassAt: 777 }), [
		[{ type: 'reset', lastPassAt: 777 }, T0],
		[{ type: 'pass-start' }, T0 + 100],
		[{ type: 'control-connected' }, T0 + 200],
		[{ type: 'strand-peers', count: 1 }, T0 + 300],
		[{ type: 'pass-complete', at: T0 + 400 }, T0 + 400],
	]);
	const v = viewStatus(s, T0 + 500);
	assert.equal(v.kind, 'catching-up');
	assert.equal(v.lastPassAt, 777);
});

test('pass-failed keeps lastPassAt and liveness and clears the in-flight flag', () => {
	let s = liveState();
	s = reduceStatus(s, { type: 'pass-start' }, T0 + 6000);
	assert.equal(s.passInFlight, true);
	s = reduceStatus(s, { type: 'pass-failed', name: 'ignored' }, T0 + 7000);
	assert.equal(s.passInFlight, false);
	const v = viewStatus(s, T0 + 8000);
	assert.equal(v.kind, 'live');
	assert.equal(v.lastPassAt, T0 + 5000);
});

test('follower reads not-live whatever the connection says; promoted restarts the grace as catching-up', () => {
	const f = reduceStatus(liveState(), { type: 'follower' }, T0 + 6000);
	assert.equal(viewStatus(f, T0 + 6001).kind, 'not-live');
	const p = reduceStatus(f, { type: 'promoted' }, T0 + 7000);
	assert.equal(viewStatus(p, T0 + 7000).kind, 'catching-up');
	assert.equal(viewStatus(p, T0 + 16_999).kind, 'catching-up');
	assert.equal(viewStatus(p, T0 + 17_000).kind, 'offline');
});

test('reconnect-start and reconnect-end toggle the flag without changing the kind', () => {
	const s = liveState();
	const a = reduceStatus(s, { type: 'reconnect-start' }, T0 + 6000);
	assert.equal(viewStatus(a, T0 + 6001).reconnecting, true);
	assert.equal(viewStatus(a, T0 + 6001).kind, 'live');
	const b = reduceStatus(a, { type: 'reconnect-end' }, T0 + 6500);
	assert.equal(viewStatus(b, T0 + 6501).reconnecting, false);
});

test('unpaired carries each reason and is terminal until reset', () => {
	for (const reason of UNPAIRED_REASONS) {
		const s = reduceStatus(liveState(), { type: 'unpaired', reason }, T0 + 6000);
		const v = viewStatus(s, T0 + 6001);
		assert.equal(v.kind, 'unpaired');
		assert.equal(v.reason, reason);
		for (const ev of [
			{ type: 'control-connected' },
			{ type: 'control-disconnected' },
			{ type: 'pass-start' },
			{ type: 'pass-complete', at: T0 + 7000 },
			{ type: 'follower' },
			{ type: 'unpaired', reason: 'removed' },
		]) {
			assert.equal(reduceStatus(s, ev, T0 + 7000), s);
		}
		const r = reduceStatus(s, { type: 'reset', lastPassAt: null }, T0 + 8000);
		assert.notEqual(viewStatus(r, T0 + 8000).kind, 'unpaired');
		assert.equal('reason' in viewStatus(r, T0 + 8000), false);
	}
});

test('invalid input throws a fixed TypeError that carries no event value', () => {
	const s = initialStatus({ lastPassAt: null });
	const secret = 'secret-field-value';
	const cases = [
		() => reduceStatus(s, { type: secret }, 1),
		() => reduceStatus(s, { type: 'unpaired', reason: secret }, 1),
		() => reduceStatus(s, { type: 'control-connected' }, Number.NaN),
		() => reduceStatus(s, { type: 'pass-complete', at: Number.NaN, secret }, 1),
		() => reduceStatus(s, { type: 'pass-complete', at: secret }, 1),
		() => viewStatus(s, Number.POSITIVE_INFINITY),
	];
	for (const c of cases) {
		assert.throws(c, (err) => err instanceof TypeError && !err.message.includes(secret));
	}
});

test('strand-peers with a negative, NaN or non-integer count counts as zero', () => {
	for (const count of [-1, Number.NaN, 1.5, '3', undefined]) {
		const s = fold(initialStatus({ lastPassAt: null }), [
			[{ type: 'strand-peers', count: 4 }, 1],
			[{ type: 'strand-peers', count }, 2],
		]);
		assert.equal(s.strandPeers, 0);
	}
	assert.equal(reduceStatus(initialStatus({ lastPassAt: null }), { type: 'strand-peers', count: 7 }, 1).strandPeers, 7);
});

test('extra event fields are ignored', () => {
	const s = fold(initialStatus({ lastPassAt: null }), [
		[{ type: 'reset', lastPassAt: null }, T0],
		[{ type: 'control-connected' }, T0 + 1],
		[{ type: 'strand-peers', count: 1 }, T0 + 2],
		[{ type: 'pass-start' }, T0 + 3],
		[{ type: 'pass-complete', at: T0 + 4, changedTables: ['A'], changes: [{ x: 1 }] }, T0 + 4],
	]);
	assert.equal(viewStatus(s, T0 + 5).kind, 'live');
});

test('initialStatus and reset take a non-finite lastPassAt as null', () => {
	assert.equal(initialStatus({ lastPassAt: Number.NaN }).lastPassAt, null);
	assert.equal(initialStatus({ lastPassAt: /** @type {any} */ ('x') }).lastPassAt, null);
	assert.equal(initialStatus({ lastPassAt: 42 }).lastPassAt, 42);
	assert.equal(reduceStatus(initialStatus({ lastPassAt: 1 }), { type: 'reset', lastPassAt: Number.NaN }, 5).lastPassAt, null);
});

test('purity: a deep-frozen input state is never mutated and the result is frozen', () => {
	const before = liveState();
	assert.ok(Object.isFrozen(before));
	const snapshot = JSON.stringify(before);
	for (const type of STATUS_EVENT_TYPES) {
		const ev = type === 'unpaired' ? { type, reason: 'removed' } : { type, at: T0 + 9000, count: 1, lastPassAt: 5 };
		const after = reduceStatus(before, ev, T0 + 9000);
		assert.ok(Object.isFrozen(after));
		assert.equal(JSON.stringify(before), snapshot);
	}
	assert.ok(Object.isFrozen(viewStatus(before, T0 + 9000)));
});

// ---------------------------------------------------------------------------
// Source scan. Tokens are assembled from fragments so this file does not trip
// its own matcher.
// ---------------------------------------------------------------------------
const BANNED = [
	'Da' + 'te',
	'setTime' + 'out',
	'setInter' + 'val',
	'con' + 'sole',
	'fe' + 'tch',
	're' + 'act',
	'@vote' + 'torrent',
	'imp' + 'ort ',
];

/** @param {string} source */
function bannedTokensIn(source) {
	return BANNED.filter((tok) => source.includes(tok));
}

test('source scan positive control: the matcher fires on a planted fixture', () => {
	assert.deepEqual(bannedTokensIn('const x = new ' + 'Da' + 'te();'), ['Da' + 'te']);
});

test('source scan: status.js is clock-free, import-free and prints nothing', () => {
	const src = stripComments(readFileSync(dashboardSrc('live', 'status.js'), 'utf8'));
	assert.deepEqual(bannedTokensIn(src), []);
});
