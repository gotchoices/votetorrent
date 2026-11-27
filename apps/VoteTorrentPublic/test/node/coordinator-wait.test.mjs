/**
 * coordinator-wait.test.mjs -- the bounded retry around opening the strand
 * read handle while no connected peer is yet confirmed to serve the strand
 * (`src/peer/coordinator-wait.js`). Fake clock and sleep: no timer runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	openWhenCoordinatorFound,
	isCoordinatorMiss,
	NoCoordinatorError,
	COORDINATOR_WAIT_MS,
	COORDINATOR_RETRY_DELAY_MS,
	COORDINATOR_MISS_CODES,
} from '../../src/peer/coordinator-wait.js';

/** @param {string} code */
const findCoordinatorError = (code) =>
	Object.assign(new Error('No coordinator available for key on network /optimystic/strand-x'), { name: 'FindCoordinatorError', code });

/** A fake clock that the fake sleep advances. */
function fakeTime() {
	let t = 0;
	/** @type {number[]} */
	const sleeps = [];
	return {
		sleeps,
		now: () => t,
		sleep: async (/** @type {number} */ ms) => {
			sleeps.push(ms);
			t += ms;
		},
	};
}

test('C1: the bound and the matched codes are the documented ones', () => {
	assert.equal(COORDINATOR_WAIT_MS, 20_000);
	assert.equal(COORDINATOR_RETRY_DELAY_MS, 1_000);
	assert.deepEqual([...COORDINATOR_MISS_CODES], ['NO_NETWORK_COORDINATOR', 'NO_COORDINATOR_AVAILABLE']);
});

test('C2: isCoordinatorMiss matches both codes, on the error or anywhere on its cause chain, by name and code', () => {
	assert.equal(isCoordinatorMiss(findCoordinatorError('NO_NETWORK_COORDINATOR')), true);
	assert.equal(isCoordinatorMiss(findCoordinatorError('NO_COORDINATOR_AVAILABLE')), true);
	const wrapped = new Error('strand init failed', { cause: new Error('mid', { cause: findCoordinatorError('NO_NETWORK_COORDINATOR') }) });
	assert.equal(isCoordinatorMiss(wrapped), true);
	// Not a miss: other codes, other names, non-errors, a cause cycle.
	assert.equal(isCoordinatorMiss(findCoordinatorError('SELF_COORDINATION_EXHAUSTED')), false);
	assert.equal(isCoordinatorMiss(Object.assign(new Error('x'), { name: 'BlockUnavailableError', code: 'NO_NETWORK_COORDINATOR' })), false);
	assert.equal(isCoordinatorMiss(undefined), false);
	assert.equal(isCoordinatorMiss('NO_NETWORK_COORDINATOR'), false);
	/** @type {any} */
	const loop = new Error('loop');
	loop.cause = loop;
	assert.equal(isCoordinatorMiss(loop), false);
});

test('C3: a first-attempt success returns at once, with no sleep', async () => {
	const time = fakeTime();
	let calls = 0;
	const out = await openWhenCoordinatorFound(async () => {
		calls += 1;
		return 'handle';
	}, time);
	assert.equal(out, 'handle');
	assert.equal(calls, 1);
	assert.deepEqual(time.sleeps, []);
});

test('C4: the relay-first sequence -- two misses, then the member is confirmed -- returns the handle on the third attempt', async () => {
	const time = fakeTime();
	let calls = 0;
	const out = await openWhenCoordinatorFound(async () => {
		calls += 1;
		if (calls < 3) throw findCoordinatorError('NO_NETWORK_COORDINATOR');
		return 'handle';
	}, time);
	assert.equal(out, 'handle');
	assert.equal(calls, 3);
	assert.deepEqual(time.sleeps, [1_000, 1_000]);
});

test('C5: any other error is rethrown at once, unretried', async () => {
	const time = fakeTime();
	const other = Object.assign(new Error('bad schema'), { name: 'QuereusError' });
	let calls = 0;
	await assert.rejects(
		openWhenCoordinatorFound(async () => {
			calls += 1;
			throw other;
		}, time),
		(/** @type {any} */ err) => err === other,
	);
	assert.equal(calls, 1);
	assert.deepEqual(time.sleeps, []);
});

test('C6: misses until the bound is spent end in NoCoordinatorError, subject no-coordinator, carrying the last miss', async () => {
	const time = fakeTime();
	let calls = 0;
	const last = findCoordinatorError('NO_COORDINATOR_AVAILABLE');
	await assert.rejects(
		openWhenCoordinatorFound(
			async () => {
				calls += 1;
				throw last;
			},
			{ ...time, timeoutMs: 5_000, delayMs: 1_000 },
		),
		(/** @type {any} */ err) =>
			err instanceof NoCoordinatorError && err.name === 'NoCoordinatorError' && err.subject === 'no-coordinator' && err.cause === last && err.attempts === calls,
	);
	// Attempts at t=0,1,2,3,4,5 s: the next pause would end past 5 s.
	assert.equal(calls, 6);
	assert.ok(time.now() <= 5_000, `waited past the bound: ${time.now()} ms`);
});

test('C7: the error message names no network value (it is logged by boot)', async () => {
	const time = fakeTime();
	await assert.rejects(
		openWhenCoordinatorFound(
			async () => {
				throw findCoordinatorError('NO_NETWORK_COORDINATOR');
			},
			{ ...time, timeoutMs: 0 },
		),
		(/** @type {any} */ err) => err instanceof NoCoordinatorError && !/optimystic|strand-x/.test(err.message),
	);
});
