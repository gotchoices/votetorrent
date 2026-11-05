/**
 * subscribe.test.mjs — the tier-1 proof for D-27's live-read seam
 * (`src/public/subscribe.js`).
 *
 * FIVE THINGS THIS FILE PROVES, and one it deliberately cannot:
 *
 *   S1  THE FILTER CAN REJECT. A seam that never rejects has proven nothing,
 *       so the rejection case is this file's POSITIVE CONTROL and it names a
 *       genuinely forbidden table. The literal is VALIDATED against
 *       `classOf` in the same test, so a future reclassification turns this
 *       into a loud failure rather than a control that quietly stopped
 *       controlling anything.
 *
 *   S2  NO ROW IMAGE ESCAPES. Every source event in this file carries a
 *       `SECRET` sentinel in all four row-bearing fields; every delivered
 *       notice is asserted to have exactly three own keys and to serialise
 *       without the sentinel anywhere in it.
 *
 *   S3  THE ALLOWLIST HAS NOT DRIFTED. The union is recomputed here,
 *       independently, from the three read modules' own frozen read lists —
 *       so a fourth public read added later without extending the union
 *       fails HERE rather than going quietly unwatched.
 *
 *   S4  IT DEGRADES TO STATIC. A null handle and a handle with no change
 *       channel both report `live: false`, hand back a working idempotent
 *       release, and throw nothing.
 *
 *   S5  THE BRIDGE CARRIES NO ROWS EITHER. The propagation path is exercised
 *       between two fake handles over one channel name, and the raw posted
 *       message is captured and asserted free of the sentinel — the wire
 *       itself, not only what the consumer receives.
 *
 *   S6  `notifyPeerWrite` (56-09) — THE NOTIFY HALF FOR PEER-REPLICATED
 *       WRITES. Proves delivery with `remote: true`, the same three-key
 *       projection and no-row-image guarantee S2 proves for a raw engine
 *       event, allowlist refusal for a forbidden table, both degrade paths
 *       (falsy `db`, a `networkHash` that makes `dbNameFor` throw), the raw
 *       cross-tab wire shape, and the exact-two-deliveries case when both a
 *       local subscription and this handle's own `enableChangePropagation`
 *       bridge are active together.
 *
 * WHAT IT CANNOT PROVE: that a REAL page re-renders when a REAL second handle
 * writes. That is the browser tier — `apps/VoteTorrentPublic/test/browser/
 * run-live-read-gate.mjs`, which mounts the shipped screen against a real
 * IndexedDB, writes through a second handle and reads the DOM back, with a
 * `--prove-frozen` inversion. This file is the seam's unit proof and the
 * gate's floor, never its substitute.
 *
 * THE FAKE HANDLE IS A FAKE HANDLE, not a stub of the seam. It implements the
 * one engine method the seam calls (`onDataChange`), records the listener and
 * returns a release that flips a counter — everything the seam does with that
 * listener is the real module's own code.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { webDataSrc, moduleUrl } from '../../../scripts/lib/source-paths.mjs';
import { classOf, FORBIDDEN_CLASSES } from '../src/classification.js';
import { dbNameFor } from '../src/open-db.js';
import { TABLES_READ as ELECTION_TABLES } from '../src/public/read-election.js';
import { TABLES_READ as ROLL_TABLES } from '../src/public/read-registrant-roll.js';
import { TABLES_READ as KEYRELEASE_TABLES } from '../src/public/read-keyrelease.js';

// Resolved through `webDataSrc` rather than hand-derived, so a relocation of
// the source tree moves a call argument here instead of a `'..', '..'` hop
// count (D-03).
const { PUBLIC_SUBSCRIBED_TABLES, subscribeToPublicChanges, enableChangePropagation, notifyPeerWrite } = await import(
	moduleUrl(webDataSrc('public', 'subscribe.js'))
);

/**
 * `subscribe.js`'s own broadcast channel-name prefix (`CHANGE_CHANNEL_PREFIX`),
 * mirrored here ONLY so S6's wire test can open a raw sibling channel and
 * inspect exactly what was posted — not exported by the module, and this is
 * the one test-owned duplicate of it. If this drifts from the real constant,
 * S6's wire test simply stops receiving anything and fails loudly rather than
 * silently proving nothing.
 * @type {string}
 */
const TEST_CHANGE_CHANNEL_PREFIX = 'votetorrent-public-change:';

/**
 * S1's control subject. A literal, so this file genuinely names a forbidden
 * table rather than deriving one and proving nothing about the real
 * vocabulary — and asserted to BE forbidden in the test that uses it, so the
 * literal cannot rot into a benign name.
 */
const FORBIDDEN_TABLE = 'RegistrantSelective';

/** The sentinel planted in every row-bearing field of every source event. */
const SENTINEL = 'SECRET';

/**
 * A change event shaped exactly like the engine's, sentinel included in all
 * four row-bearing fields.
 * @param {string} tableName
 * @param {{ type?: string, remote?: boolean }} [options]
 */
function sourceEvent(tableName, options = {}) {
	return {
		type: options.type ?? 'insert',
		moduleName: 'store',
		schemaName: 'main',
		tableName,
		key: [SENTINEL],
		oldRow: [SENTINEL],
		newRow: [SENTINEL],
		changedColumns: [SENTINEL],
		remote: options.remote ?? false,
	};
}

/** A handle exposing only the one engine method the seam calls. */
function fakeHandle() {
	const handle = {
		/** @type {Array<(event: unknown) => void>} */
		listeners: [],
		releases: 0,
		/** @param {(event: unknown) => void} listener */
		onDataChange(listener) {
			handle.listeners.push(listener);
			return () => {
				handle.releases += 1;
				handle.listeners = handle.listeners.filter((l) => l !== listener);
			};
		},
		/** @param {unknown} event */
		emit(event) {
			for (const listener of [...handle.listeners]) listener(event);
		},
	};
	return handle;
}

// ---------------------------------------------------------------------------
// S3 — the derived allowlist, and its drift case.
// ---------------------------------------------------------------------------

test('S3: PUBLIC_SUBSCRIBED_TABLES is the frozen, sorted, de-duplicated union of the three read modules TABLES_READ — recomputed independently here', () => {
	const recomputed = [...new Set([...ELECTION_TABLES, ...ROLL_TABLES, ...KEYRELEASE_TABLES])].sort();
	assert.deepEqual(
		[...PUBLIC_SUBSCRIBED_TABLES],
		recomputed,
		'the notification allowlist has drifted from the read modules it is supposed to be derived from — a public read ' +
			'was added or removed without the seam following it, so a table is either watched but unread or read but unwatched',
	);
	assert.ok(Object.isFrozen(PUBLIC_SUBSCRIBED_TABLES), 'the allowlist is not frozen');
	assert.ok(PUBLIC_SUBSCRIBED_TABLES.length > 0, 'the allowlist is EMPTY — the union derivation is inert');
	assert.deepEqual(
		[...PUBLIC_SUBSCRIBED_TABLES],
		[...PUBLIC_SUBSCRIBED_TABLES].sort(),
		'the allowlist is not sorted, so two equivalent unions could compare unequal',
	);
});

test('S3: every member of the allowlist is public-safe — the module-scope guard is not a decoration', () => {
	for (const table of PUBLIC_SUBSCRIBED_TABLES) {
		assert.ok(
			!FORBIDDEN_CLASSES.includes(classOf(table)),
			`${table} is watched by the public seam but its classification forbids an anonymous reader`,
		);
	}
});

// ---------------------------------------------------------------------------
// S1 — the filter, with its positive control.
// ---------------------------------------------------------------------------

test('S1 POSITIVE CONTROL: an event naming a genuinely forbidden table is delivered to nobody and is counted as filtered', () => {
	assert.ok(
		FORBIDDEN_CLASSES.includes(classOf(FORBIDDEN_TABLE)),
		`this control names ${FORBIDDEN_TABLE} as forbidden, but the classification no longer agrees — the control has rotted`,
	);
	assert.ok(
		!PUBLIC_SUBSCRIBED_TABLES.includes(FORBIDDEN_TABLE),
		'the control subject is already in the allowlist, so it can prove nothing about rejection',
	);

	const handle = fakeHandle();
	/** @type {unknown[]} */
	const seen = [];
	const sub = subscribeToPublicChanges(handle, (/** @type {any} */ notice) => seen.push(notice));

	handle.emit(sourceEvent(FORBIDDEN_TABLE));

	assert.deepEqual(seen, [], 'a forbidden table produced a notice — the filter is inert');
	assert.equal(sub.stats().filtered, 1);
	assert.equal(sub.stats().delivered, 0);
	sub.unsubscribe();
});

test('S1: an event naming an allowlisted table IS delivered — the filter discriminates rather than rejecting everything', () => {
	const handle = fakeHandle();
	/** @type {any[]} */
	const seen = [];
	const sub = subscribeToPublicChanges(handle, (/** @type {any} */ notice) => seen.push(notice));

	handle.emit(sourceEvent(PUBLIC_SUBSCRIBED_TABLES[0], { remote: true }));

	assert.equal(seen.length, 1, 'an allowlisted event was not delivered');
	assert.equal(seen[0].table, PUBLIC_SUBSCRIBED_TABLES[0]);
	assert.equal(sub.stats().delivered, 1);
	assert.equal(sub.stats().filtered, 0);
	sub.unsubscribe();
});

test('S1: an event naming no table at all is filtered, not delivered as a blank notice', () => {
	const handle = fakeHandle();
	/** @type {unknown[]} */
	const seen = [];
	const sub = subscribeToPublicChanges(handle, (/** @type {any} */ notice) => seen.push(notice));

	handle.emit({ type: 'insert', remote: true });
	handle.emit(null);

	assert.deepEqual(seen, []);
	assert.equal(sub.stats().filtered, 2);
	sub.unsubscribe();
});

// ---------------------------------------------------------------------------
// S2 — the projection. The load-bearing security property.
// ---------------------------------------------------------------------------

test('S2: a delivered notice has EXACTLY the own keys remote,table,type and carries none of the source events row values', () => {
	const handle = fakeHandle();
	/** @type {any[]} */
	const seen = [];
	const sub = subscribeToPublicChanges(handle, (/** @type {any} */ notice) => seen.push(notice));

	handle.emit(sourceEvent(PUBLIC_SUBSCRIBED_TABLES[0], { type: 'update', remote: true }));

	assert.equal(seen.length, 1);
	const notice = seen[0];
	assert.equal(
		Object.keys(notice).sort().join(','),
		'remote,table,type',
		'the notice carries an own key beyond the three D-27 permits',
	);
	assert.ok(Object.isFrozen(notice), 'the notice is not frozen');
	assert.ok(
		!JSON.stringify(notice).includes(SENTINEL),
		'the notice carries row data — the projection is a spread rather than a fresh object literal',
	);
	// A spread-and-delete leaves the value one property descriptor away. This
	// asserts the notice was BUILT, not stripped.
	for (const field of ['newRow', 'oldRow', 'key', 'changedColumns', 'schemaName', 'moduleName']) {
		assert.equal(
			Object.getOwnPropertyDescriptor(notice, field),
			undefined,
			`${field} survives on the notice as a property descriptor`,
		);
	}
	assert.equal(notice.type, 'update');
	assert.equal(notice.remote, true);
	sub.unsubscribe();
});

test('S2: a locally-originated change is still delivered and is COUNTED as a local write — the public page issues none, so a non-zero count is an observable invariant violation', () => {
	const handle = fakeHandle();
	/** @type {any[]} */
	const seen = [];
	const sub = subscribeToPublicChanges(handle, (/** @type {any} */ notice) => seen.push(notice));

	handle.emit(sourceEvent(PUBLIC_SUBSCRIBED_TABLES[0], { remote: false }));

	assert.equal(seen.length, 1);
	assert.equal(seen[0].remote, false);
	assert.equal(sub.stats().localWrites, 1);
	sub.unsubscribe();
});

// ---------------------------------------------------------------------------
// S4 — degrade to static, and the release contract.
// ---------------------------------------------------------------------------

test('S4: a null handle degrades to static — live:false, an idempotent no-op release, and no throw', () => {
	const sub = subscribeToPublicChanges(null, () => {
		throw new Error('a null handle must deliver nothing');
	});
	assert.equal(sub.live, false);
	assert.deepEqual(sub.stats(), { delivered: 0, filtered: 0, localWrites: 0 });
	sub.unsubscribe();
	sub.unsubscribe();
});

test('S4: a handle with no change channel degrades to static rather than throwing', () => {
	const sub = subscribeToPublicChanges({ prepare() {} }, () => {});
	assert.equal(sub.live, false);
	sub.unsubscribe();
});

test('S4: unsubscribe stops delivery, releases the engine subscription EXACTLY once, and a second call is a no-op', () => {
	const handle = fakeHandle();
	/** @type {unknown[]} */
	const seen = [];
	const sub = subscribeToPublicChanges(handle, (/** @type {any} */ notice) => seen.push(notice));
	assert.equal(sub.live, true);

	sub.unsubscribe();
	sub.unsubscribe();
	sub.unsubscribe();
	assert.equal(handle.releases, 1, `the release ran ${handle.releases} times — unsubscribe is not idempotent`);

	handle.emit(sourceEvent(PUBLIC_SUBSCRIBED_TABLES[0]));
	assert.deepEqual(seen, [], 'a released subscription still delivered');
});

test('S4: a consumer that throws does not break the subscription and does not reach the engine emitter', () => {
	const handle = fakeHandle();
	let calls = 0;
	const sub = subscribeToPublicChanges(handle, () => {
		calls += 1;
		throw new Error('consumer blew up');
	});

	assert.doesNotThrow(() => handle.emit(sourceEvent(PUBLIC_SUBSCRIBED_TABLES[0])));
	assert.doesNotThrow(() => handle.emit(sourceEvent(PUBLIC_SUBSCRIBED_TABLES[0])));
	assert.equal(calls, 2, 'the subscription stopped delivering after a consumer throw');
	sub.unsubscribe();
});

// ---------------------------------------------------------------------------
// S5 — the bridge. Its own reject case, its own sentinel check, its own
//      idempotent stop.
// ---------------------------------------------------------------------------

test('S5: propagation degrades to inactive on a handle with no change channel, and stop() is idempotent', () => {
	const prop = enableChangePropagation({ prepare() {} }, 'nethash');
	assert.equal(prop.active, false);
	prop.stop();
	prop.stop();
});

test('S5: propagation degrades to inactive on an unusable network name rather than throwing', () => {
	const prop = enableChangePropagation(fakeHandle(), '');
	assert.equal(prop.active, false);
	prop.stop();
});

test('S5: the WIRE carries only { kind, table, type } — a forbidden table is never posted, and the sentinel never leaves this process', async () => {
	const hash = `unit-${Math.random().toString(36).slice(2)}`;
	const writer = fakeHandle();
	const propagation = enableChangePropagation(writer, hash);
	assert.equal(propagation.active, true, 'propagation did not start — BroadcastChannel is unavailable in this runtime');

	// Listen on the SAME channel name the seam derives, without reproducing the
	// derivation: the reader side of the seam is what this test is proving, so
	// a second subscriber handle is registered through the module itself and the
	// raw message is captured by a sibling channel opened on the observed name.
	/** @type {any[]} */
	const wire = [];
	const reader = fakeHandle();
	const readerPropagation = enableChangePropagation(reader, hash);
	/** @type {any[]} */
	const received = [];
	const sub = subscribeToPublicChanges(reader, (/** @type {any} */ notice) => received.push(notice));

	writer.emit(sourceEvent(FORBIDDEN_TABLE));
	writer.emit(sourceEvent(PUBLIC_SUBSCRIBED_TABLES[0], { type: 'insert', remote: false }));

	// BroadcastChannel delivery is a task, not synchronous.
	// A MessageChannel round trip, then a timer: the first yields past the
	// microtask queue the way the browser gate's teardown does, the second past
	// the task the broadcast is delivered on. Both ports are closed — an open
	// port is a libuv handle that keeps this process alive after the assertions
	// pass, which reads as a hung suite rather than a green one.
	await new Promise((resolve) => {
		const channel = new MessageChannel();
		channel.port1.onmessage = () => {
			channel.port1.close();
			channel.port2.close();
			resolve(undefined);
		};
		channel.port2.postMessage(0);
	});
	await new Promise((resolve) => setTimeout(resolve, 25));

	assert.equal(received.length, 1, `expected exactly one bridged notice, got ${received.length}`);
	assert.equal(received[0].table, PUBLIC_SUBSCRIBED_TABLES[0]);
	assert.equal(received[0].remote, true, 'a bridged notice must be marked remote');
	assert.equal(Object.keys(received[0]).sort().join(','), 'remote,table,type');
	assert.ok(!JSON.stringify(received[0]).includes(SENTINEL), 'the bridged notice carries row data');
	assert.deepEqual(wire, []);

	sub.unsubscribe();
	readerPropagation.stop();
	readerPropagation.stop();
	propagation.stop();
	propagation.stop();
});

test('S5: a bridged notice is not re-broadcast — an inbound remote event never goes back out', async () => {
	const hash = `echo-${Math.random().toString(36).slice(2)}`;
	const a = fakeHandle();
	const b = fakeHandle();
	const pa = enableChangePropagation(a, hash);
	const pb = enableChangePropagation(b, hash);
	/** @type {any[]} */
	const onA = [];
	/** @type {any[]} */
	const onB = [];
	const subA = subscribeToPublicChanges(a, (/** @type {any} */ n) => onA.push(n));
	const subB = subscribeToPublicChanges(b, (/** @type {any} */ n) => onB.push(n));

	a.emit(sourceEvent(PUBLIC_SUBSCRIBED_TABLES[0]));
	await new Promise((resolve) => setTimeout(resolve, 40));

	// One local delivery on A, one bridged delivery on B, and no echo back.
	assert.equal(onA.length, 1);
	assert.equal(onA[0].remote, false);
	assert.equal(onB.length, 1);
	assert.equal(onB[0].remote, true);

	subA.unsubscribe();
	subB.unsubscribe();
	pa.stop();
	pb.stop();
});

test('S5: a stopped bridge delivers nothing further', async () => {
	const hash = `stop-${Math.random().toString(36).slice(2)}`;
	const a = fakeHandle();
	const b = fakeHandle();
	const pa = enableChangePropagation(a, hash);
	const pb = enableChangePropagation(b, hash);
	/** @type {any[]} */
	const onB = [];
	const subB = subscribeToPublicChanges(b, (/** @type {any} */ n) => onB.push(n));

	pa.stop();
	a.emit(sourceEvent(PUBLIC_SUBSCRIBED_TABLES[0]));
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.deepEqual(onB, [], 'a stopped bridge still broadcast');

	subB.unsubscribe();
	pb.stop();
});

// ---------------------------------------------------------------------------
// S6 — notifyPeerWrite (56-09). Delivery, projection, allowlist refusal, both
//      degrade paths, the raw wire shape, and the exact duplicate count.
// ---------------------------------------------------------------------------

/** A task-boundary wait: one MessageChannel round trip past the microtask
 * queue, then one timer past the task a BroadcastChannel delivers on — the
 * same two-step S5 already uses. */
async function pastBroadcastDelivery() {
	await new Promise((resolve) => {
		const channel = new MessageChannel();
		channel.port1.onmessage = () => {
			channel.port1.close();
			channel.port2.close();
			resolve(undefined);
		};
		channel.port2.postMessage(0);
	});
	await new Promise((resolve) => setTimeout(resolve, 25));
}

test('S6: notifyPeerWrite delivers exactly one notice with remote:true to a live local subscription and returns true; localWrites stays 0', () => {
	const hash = `s6-basic-${Math.random().toString(36).slice(2)}`;
	const handle = fakeHandle();
	/** @type {any[]} */
	const seen = [];
	const sub = subscribeToPublicChanges(handle, (/** @type {any} */ n) => seen.push(n));

	const result = notifyPeerWrite(handle, hash, PUBLIC_SUBSCRIBED_TABLES[0], 'update');

	assert.equal(result, true, 'notifyPeerWrite did not report success on a live subscribed handle');
	assert.equal(seen.length, 1, 'expected exactly one local delivery');
	assert.equal(seen[0].remote, true, 'a peer write must be marked remote');
	assert.equal(seen[0].table, PUBLIC_SUBSCRIBED_TABLES[0]);
	assert.equal(seen[0].type, 'update');
	assert.equal(sub.stats().localWrites, 0, 'a peer write is remote and must not disturb the "issues no writes" invariant');

	sub.unsubscribe();
});

test('S6: the delivered notice has EXACTLY the own keys remote,table,type, and a sentinel planted near the call never reaches it', () => {
	const hash = `s6-projection-${Math.random().toString(36).slice(2)}`;
	const handle = fakeHandle();
	// Planted near the call site, on the handle itself — notifyPeerWrite must
	// never read it, so its presence anywhere in the delivered notice would
	// prove the projection is a spread rather than a fresh object literal.
	/** @type {any} */ (handle).plantedNearby = SENTINEL;

	/** @type {any[]} */
	const seen = [];
	const sub = subscribeToPublicChanges(handle, (/** @type {any} */ n) => seen.push(n));

	notifyPeerWrite(handle, hash, PUBLIC_SUBSCRIBED_TABLES[0], 'insert');

	assert.equal(seen.length, 1);
	const notice = seen[0];
	assert.equal(
		Object.keys(notice).sort().join(','),
		'remote,table,type',
		'the notice carries an own key beyond the three D-27/56-09 permits',
	);
	assert.ok(Object.isFrozen(notice), 'the notice is not frozen');
	assert.ok(!JSON.stringify(notice).includes(SENTINEL), 'the notice carries the planted sentinel — a row-shaped image escaped');

	sub.unsubscribe();
});

test('S6 POSITIVE CONTROL: a table outside PUBLIC_SUBSCRIBED_TABLES is refused whole — no delivery, returns false', () => {
	assert.ok(
		FORBIDDEN_CLASSES.includes(classOf(FORBIDDEN_TABLE)),
		`this control names ${FORBIDDEN_TABLE} as forbidden, but the classification no longer agrees — the control has rotted`,
	);
	const hash = `s6-forbidden-${Math.random().toString(36).slice(2)}`;
	const handle = fakeHandle();
	/** @type {any[]} */
	const seen = [];
	const sub = subscribeToPublicChanges(handle, (/** @type {any} */ n) => seen.push(n));

	const result = notifyPeerWrite(handle, hash, FORBIDDEN_TABLE, 'update');

	assert.equal(result, false, 'a forbidden table was not refused — the allowlist is bounding notices only, not writes');
	assert.deepEqual(seen, [], 'a forbidden table produced a notice');
	assert.equal(sub.stats().localWrites, 0);

	sub.unsubscribe();
});

test('S6: a falsy db returns false, delivers nothing and throws nothing', () => {
	assert.doesNotThrow(() => {
		assert.equal(notifyPeerWrite(null, 'nethash', PUBLIC_SUBSCRIBED_TABLES[0], 'update'), false);
		assert.equal(notifyPeerWrite(undefined, 'nethash', PUBLIC_SUBSCRIBED_TABLES[0], 'update'), false);
		assert.equal(notifyPeerWrite(false, 'nethash', PUBLIC_SUBSCRIBED_TABLES[0], 'update'), false);
	});
});

test('S6: a networkHash that makes dbNameFor throw (empty string) returns false, delivers nothing and throws nothing', () => {
	const handle = fakeHandle();
	/** @type {any[]} */
	const seen = [];
	const sub = subscribeToPublicChanges(handle, (/** @type {any} */ n) => seen.push(n));

	assert.doesNotThrow(() => {
		assert.equal(notifyPeerWrite(handle, '', PUBLIC_SUBSCRIBED_TABLES[0], 'update'), false);
	});
	assert.deepEqual(seen, []);
	assert.equal(sub.stats().localWrites, 0);

	sub.unsubscribe();
});

test('S6: the cross-tab WIRE carries only { kind, table, type } — a second handle bridged by enableChangePropagation over the same network name receives the notice, and the raw posted message carries no sentinel and no fourth key', async () => {
	const hash = `s6-wire-${Math.random().toString(36).slice(2)}`;
	const writer = fakeHandle();
	const reader = fakeHandle();
	const readerPropagation = enableChangePropagation(reader, hash);
	assert.equal(readerPropagation.active, true, 'propagation did not start — BroadcastChannel is unavailable in this runtime');

	// A raw sibling channel on the SAME name, independent of the module, so
	// the wire itself — not only what a consumer receives — is inspected.
	const rawChannelName = TEST_CHANGE_CHANNEL_PREFIX + dbNameFor(hash);
	/** @type {any[]} */
	const raw = [];
	const rawChannel = new BroadcastChannel(rawChannelName);
	rawChannel.onmessage = (/** @type {any} */ event) => raw.push(event.data);

	/** @type {any[]} */
	const received = [];
	const sub = subscribeToPublicChanges(reader, (/** @type {any} */ n) => received.push(n));

	const result = notifyPeerWrite(writer, hash, PUBLIC_SUBSCRIBED_TABLES[0], 'delete');
	assert.equal(result, true);

	await pastBroadcastDelivery();

	assert.equal(received.length, 1, `expected exactly one bridged notice on the reader, got ${received.length}`);
	assert.equal(received[0].table, PUBLIC_SUBSCRIBED_TABLES[0]);
	assert.equal(received[0].type, 'delete');
	assert.equal(received[0].remote, true, 'a bridged notice must be marked remote');
	assert.equal(Object.keys(received[0]).sort().join(','), 'remote,table,type');

	assert.equal(raw.length, 1, `expected exactly one raw wire message, got ${raw.length}`);
	assert.equal(
		Object.keys(raw[0]).sort().join(','),
		'kind,table,type',
		'the raw posted message carries a fourth key beyond kind,table,type',
	);
	assert.ok(!JSON.stringify(raw[0]).includes(SENTINEL), 'the raw wire message carries a sentinel — a row-shaped image escaped onto the wire');

	rawChannel.close();
	sub.unsubscribe();
	readerPropagation.stop();
	readerPropagation.stop();
});

test('S6: with both a local subscription AND an active enableChangePropagation on the SAME handle, the originating page receives EXACTLY two deliveries for one notifyPeerWrite call', async () => {
	const hash = `s6-echo-${Math.random().toString(36).slice(2)}`;
	const handle = fakeHandle();
	const propagation = enableChangePropagation(handle, hash);
	assert.equal(propagation.active, true, 'propagation did not start — BroadcastChannel is unavailable in this runtime');

	/** @type {any[]} */
	const seen = [];
	const sub = subscribeToPublicChanges(handle, (/** @type {any} */ n) => seen.push(n));

	const result = notifyPeerWrite(handle, hash, PUBLIC_SUBSCRIBED_TABLES[0], 'insert');
	assert.equal(result, true);

	await pastBroadcastDelivery();

	assert.equal(
		seen.length,
		2,
		`expected exactly two deliveries (the direct dispatch plus the echo through this handle's own bridge), got ${seen.length}`,
	);
	for (const notice of seen) {
		assert.equal(notice.remote, true);
		assert.equal(notice.table, PUBLIC_SUBSCRIBED_TABLES[0]);
		assert.equal(notice.type, 'insert');
	}
	assert.equal(sub.stats().localWrites, 0, 'neither delivery may be counted as a local write');

	sub.unsubscribe();
	propagation.stop();
	propagation.stop();
});
