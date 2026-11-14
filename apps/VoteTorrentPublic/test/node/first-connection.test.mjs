/**
 * first-connection.test.mjs -- the bounded wait for the Edge node's first peer
 * connection (`src/peer/first-connection.js`), with a real EventTarget as the
 * node and a manual timer, so no test sleeps.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForFirstConnection, FIRST_CONNECTION_TIMEOUT_MS } from '../../src/peer/first-connection.js';

/** A node whose connections can be opened by hand; counts live listeners. */
function fakeNode(initial = 0) {
	const target = new EventTarget();
	const node = {
		conns: Array.from({ length: initial }, (_, i) => ({ id: i })),
		listeners: 0,
		getConnections() {
			return node.conns;
		},
		/** @param {string} type @param {any} fn */
		addEventListener(type, fn) {
			node.listeners += 1;
			target.addEventListener(type, fn);
		},
		/** @param {string} type @param {any} fn */
		removeEventListener(type, fn) {
			node.listeners -= 1;
			target.removeEventListener(type, fn);
		},
		open() {
			node.conns.push({ id: node.conns.length });
			target.dispatchEvent(new Event('connection:open'));
		},
	};
	return node;
}

function manualTimer() {
	/** @type {Array<{ fn: () => void, ms: number, cleared: boolean }>} */
	const timers = [];
	return {
		timers,
		/** @param {() => void} fn @param {number} ms */
		setTimer: (fn, ms) => {
			const t = { fn, ms, cleared: false };
			timers.push(t);
			return t;
		},
		/** @param {any} t */
		clearTimer: (t) => {
			t.cleared = true;
		},
		fire() {
			for (const t of timers) if (!t.cleared) t.fn();
		},
	};
}

test('W1: a connection already open resolves at once, with no listener and no timer', async () => {
	const node = fakeNode(1);
	const timer = manualTimer();
	assert.deepEqual(await waitForFirstConnection(node, timer), { connected: true });
	assert.equal(timer.timers.length, 0);
	assert.equal(node.listeners, 0);
});

test('W2: a connection that opens later resolves connected, clears the timer and removes the listener', async () => {
	const node = fakeNode(0);
	const timer = manualTimer();
	const pending = waitForFirstConnection(node, timer);
	assert.equal(node.listeners, 1);
	node.open();
	assert.deepEqual(await pending, { connected: true });
	assert.equal(timer.timers[0].cleared, true);
	assert.equal(node.listeners, 0);
});

test('W3: no connection before the timeout resolves not connected (never rejects) and removes the listener', async () => {
	const node = fakeNode(0);
	const timer = manualTimer();
	const pending = waitForFirstConnection(node, { ...timer, timeoutMs: 1234 });
	assert.equal(timer.timers[0].ms, 1234);
	timer.fire();
	assert.deepEqual(await pending, { connected: false });
	assert.equal(node.listeners, 0);
	node.open();
	assert.deepEqual(await pending, { connected: false }, 'a late connection does not change a settled wait');
});

test('W4: the default timeout is the exported bound', async () => {
	const timer = manualTimer();
	const pending = waitForFirstConnection(fakeNode(0), timer);
	assert.equal(timer.timers[0].ms, FIRST_CONNECTION_TIMEOUT_MS);
	timer.fire();
	await pending;
});

test('W5: a node with no connection API, or one whose getConnections throws, is never connected and never throws', async () => {
	for (const node of [null, {}, { getConnections() { throw new Error('boom'); } }]) {
		const timer = manualTimer();
		const pending = waitForFirstConnection(node, timer);
		timer.fire();
		assert.deepEqual(await pending, { connected: false });
	}
});
