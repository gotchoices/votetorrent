/**
 * Tier-1 coverage of `src/live/change-marks.js`, the pure change-mark diff:
 * first render, ineligible passes, the row cap, deletes, ordering, purity,
 * fixed-text errors and a comment-stripped source scan. Browser-free.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dashboardSrc, moduleUrl } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';

const { ROW_MARK_CAP, MARK_LIFETIME_MS, MARK_FADE_MS, diffForMarks } = /** @type {typeof import('../../src/live/change-marks.js')} */ (
	await import(moduleUrl(dashboardSrc('live', 'change-marks.js')))
);

/** @param {number} n @param {string} [sig] @param {string} [prefix] */
const rows = (n, sig = 'a', prefix = 'k') => Array.from({ length: n }, (_, i) => ({ key: `${prefix}${i}`, sig }));
/** @param {Array<{ key: string, sig: string }>} list */
const indexOf = (list) => new Map(list.map((r) => [r.key, r.sig]));

test('constants have the contract values', () => {
	assert.equal(ROW_MARK_CAP, 25);
	assert.equal(MARK_LIFETIME_MS, 4000);
	assert.equal(MARK_FADE_MS, 2500);
	assert.ok(MARK_FADE_MS < MARK_LIFETIME_MS);
});

test('a null prevIndex marks nothing and builds the index', () => {
	const r = diffForMarks(null, [{ key: 'a', sig: '1' }, { key: 'b', sig: '2' }], { eligible: true });
	assert.deepEqual(r.marked, []);
	assert.equal(r.removedCount, 0);
	assert.equal(r.headerMarked, false);
	assert.deepEqual([...r.nextIndex], [['a', '1'], ['b', '2']]);
});

test('an ineligible pass marks nothing but still records what was rendered', () => {
	const prev = indexOf(rows(3, 'a'));
	for (const options of [{ eligible: false }, /** @type {any} */ ({ eligible: 'yes' }), /** @type {any} */ ({}), /** @type {any} */ (undefined)]) {
		const r = diffForMarks(prev, rows(3, 'b'), options);
		assert.deepEqual(r.marked, []);
		assert.equal(r.removedCount, 0);
		assert.equal(r.headerMarked, false);
		assert.equal(r.nextIndex.get('k0'), 'b');
	}
});

test('a changed sig, a new key and identical rows', () => {
	const prev = indexOf(rows(2, 'a'));
	assert.deepEqual(diffForMarks(prev, [{ key: 'k0', sig: 'a' }, { key: 'k1', sig: 'z' }], { eligible: true }).marked, ['k1']);
	assert.deepEqual(diffForMarks(prev, [...rows(2, 'a'), { key: 'new', sig: 'a' }], { eligible: true }).marked, ['new']);
	assert.deepEqual(diffForMarks(prev, rows(2, 'a'), { eligible: true }).marked, []);
});

test('exactly the cap marks rows; one more marks the header only', () => {
	const at = diffForMarks(indexOf(rows(ROW_MARK_CAP, 'a')), rows(ROW_MARK_CAP, 'b'), { eligible: true });
	assert.equal(at.marked.length, 25);
	assert.equal(at.headerMarked, false);
	const over = diffForMarks(indexOf(rows(ROW_MARK_CAP + 1, 'a')), rows(ROW_MARK_CAP + 1, 'b'), { eligible: true });
	assert.deepEqual(over.marked, []);
	assert.equal(over.headerMarked, true);
	assert.equal(over.removedCount, 0);
});

test('a delete marks the header; changes alongside it within the cap are still listed', () => {
	const prev = indexOf([{ key: 'a', sig: '1' }, { key: 'b', sig: '1' }, { key: 'c', sig: '1' }]);
	const r = diffForMarks(prev, [{ key: 'a', sig: '1' }, { key: 'b', sig: '2' }], { eligible: true });
	assert.equal(r.removedCount, 1);
	assert.equal(r.headerMarked, true);
	assert.deepEqual(r.marked, ['b']);
});

test('marked follows next order; a duplicate key appears once and the last sig wins', () => {
	const prev = indexOf([{ key: 'a', sig: '0' }, { key: 'b', sig: '0' }]);
	const r = diffForMarks(prev, [{ key: 'b', sig: '1' }, { key: 'a', sig: '1' }, { key: 'b', sig: '2' }], { eligible: true });
	assert.deepEqual(r.marked, ['b', 'a']);
	assert.equal(r.nextIndex.get('b'), '2');
});

test('purity: prevIndex is not mutated and nextIndex is a new Map', () => {
	const prev = indexOf(rows(4, 'a'));
	const before = [...prev];
	const r = diffForMarks(prev, rows(2, 'b'), { eligible: true });
	assert.deepEqual([...prev], before);
	assert.notEqual(r.nextIndex, prev);
	assert.ok(r.nextIndex instanceof Map);
});

test('invalid input throws a fixed TypeError that never carries a key or signature', () => {
	const secret = 'registrant-secret-key';
	const cases = [
		() => diffForMarks(null, /** @type {any} */ ('nope'), { eligible: true }),
		() => diffForMarks(/** @type {any} */ ({ [secret]: 1 }), [], { eligible: true }),
		() => diffForMarks(null, [{ key: secret, sig: /** @type {any} */ (5) }], { eligible: true }),
		() => diffForMarks(null, [{ key: /** @type {any} */ (7), sig: secret }], { eligible: true }),
		() => diffForMarks(null, [/** @type {any} */ (null)], { eligible: true }),
	];
	for (const c of cases) {
		assert.throws(c, (err) => err instanceof TypeError && !err.message.includes(secret));
	}
});

// Tokens are assembled from fragments so this file does not trip its own matcher.
const BANNED = ['Da' + 'te', 'setTime' + 'out', 'setInter' + 'val', 'con' + 'sole', 're' + 'act', '@vote' + 'torrent', 'imp' + 'ort '];
/** @param {string} source */
const bannedTokensIn = (source) => BANNED.filter((tok) => source.includes(tok));

test('source scan positive control: the matcher fires on a planted fixture', () => {
	assert.deepEqual(bannedTokensIn('setTime' + 'out(f, 1)'), ['setTime' + 'out']);
});

test('source scan: change-marks.js has no clock, timer, import or print', () => {
	assert.deepEqual(bannedTokensIn(stripComments(readFileSync(dashboardSrc('live', 'change-marks.js'), 'utf8'))), []);
});
