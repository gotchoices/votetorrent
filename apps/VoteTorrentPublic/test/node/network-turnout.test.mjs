/**
 * network-turnout.test.mjs -- 56-31: `useNetworkTurnout` (PublicApp.tsx), the
 * page-side half of "ballots cast so far, counted on the network". A React hook
 * in a .tsx file cannot run under node --test, so its shape is source-scanned
 * (comment-stripped), each matcher proven against a planted violation first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publicSrc } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';

const APP = stripComments(readFileSync(publicSrc('screens', 'PublicApp.tsx'), 'utf8'));

/** @param {string} src */
function hookBody(src) {
	const i = src.indexOf('export function useNetworkTurnout(');
	if (i < 0) throw new Error('no useNetworkTurnout');
	const j = src.indexOf('\nexport function ', i + 10);
	return src.slice(i, j < 0 ? undefined : j);
}

/** @param {string} body @returns {string[]} */
function violations(body) {
	const out = [];
	if (!/peerFeed === 'stopped'\) \{\s*setTurnout\(\{ state: 'unavailable' \}\)/.test(body)) out.push('stopped is not unavailable');
	if (!/peerFeed !== 'running'[^{]*\{\s*setTurnout\(\{ state: 'counting' \}\)/.test(body)) out.push('not-yet-running is not counting');
	if ((body.match(/setTimeout\(/g) ?? []).length !== 1) out.push('not exactly one setTimeout');
	if (!/setTimeout\(\(\) => void tick\(\), TURNOUT_REFRESH_MS\)/.test(body)) out.push('the refresh is not the named interval');
	if (!/if \(cancelled\) return;/.test(body)) out.push('no cancelled guard before setState');
	if (!/cancelled = true;\s*if \(timer !== null\) clearTimeout\(timer\);/.test(body)) out.push('the cleanup does not cancel and clear the timer');
	if (/setInterval\(/.test(body)) out.push('setInterval used');
	return out;
}

test('positive control: each turnout-hook matcher names its planted violation', () => {
	const real = hookBody(APP);
	const plants = [
		[real.replace("peerFeed === 'stopped') {", "peerFeed === 'stoppedX') {"), 'stopped is not unavailable'],
		[real.replace('setTimeout(() => void tick(), TURNOUT_REFRESH_MS)', 'setTimeout(() => void tick(), 30000)'), 'named interval'],
		[real.replace('if (cancelled) return;', ''), 'cancelled guard'],
		[real.replace('if (timer !== null) clearTimeout(timer);', ''), 'cleanup'],
		[real + ' setInterval(f, 1);', 'setInterval'],
	];
	for (const [fixture, expected] of plants) {
		assert.notEqual(fixture, real, `plant "${expected}" changed nothing`);
		assert.ok(violations(fixture).some((v) => v.includes(expected)), `"${expected}" not detected: ${violations(fixture)}`);
	}
});

test('56-31: useNetworkTurnout counts only while the boot runs, says unavailable once it stopped, keeps one timer, and clears it', () => {
	assert.deepEqual(violations(hookBody(APP)), []);
});

test('56-31: TURNOUT_REFRESH_MS is 30 s, the interval the turnout detail copy promises', async () => {
	const src = readFileSync(publicSrc('screens', 'PublicApp.tsx'), 'utf8');
	assert.match(src, /export const TURNOUT_REFRESH_MS = 30_000;/);
	const { COPY } = await import('../../../../packages/ui-web/src/index.js');
	assert.match(COPY['public.fact.turnout.detail'], /every 30 seconds/);
});

test('56-31: PublicApp feeds the shell the counted turnout', () => {
	assert.match(APP, /const turnout = useNetworkTurnout\(\{ networkHash: address\.networkHash, electionId: address\.electionId, peerFeed \}\);/);
	assert.match(APP, /<ElectionShell configFault=\{fault\} peerFeed=\{peerFeed\} turnout=\{turnout\} bootFailure=\{bootFailure\} \/>/);
});
