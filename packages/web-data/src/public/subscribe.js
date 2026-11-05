/**
 * public/subscribe.js — D-27's live-read seam: the anonymous page's answer to
 * "something in this browser's copy of the store changed", and NOTHING else.
 *
 * D-27's rationale, restated because it is the whole reason this file exists:
 * a read-once-at-mount page becomes silently frozen the moment sync arrives,
 * and no gate catches that, because the data never changes in test. So the
 * page is built LIVE and degrades to STATIC — never the other way round.
 *
 * FIVE MEASURED FACTS, each read out of the installed packages this session
 * (Quereus 4.17.1 / @quereus/plugin-indexeddb 4.17.1). Every one of them
 * changes what is buildable here, so they are stated rather than left to be
 * re-derived:
 *
 * 1. `onDataChange`'s SECOND PARAMETER CANNOT FILTER. Its options type is an
 *    open index signature and the implementation signature names the
 *    parameter with a leading underscore and never reads it. ALL FILTERING
 *    THEREFORE HAPPENS INSIDE THE LISTENER. Do not attempt to pass an
 *    allowlist through it; a future reader who "tidies" the call by adding a
 *    second argument has added a decoration, not a control.
 *
 * 2. A RAW CHANGE EVENT CARRIES FULL ROW IMAGES. The engine's event type
 *    carries a new row, a previous row, a projected primary key and a
 *    changed-column list. Handing that object to a consumer would be a data
 *    channel that bypasses every select list the public read modules were
 *    written around — the anonymity boundary defeated by the notification
 *    rather than by the query. This module therefore PROJECTS every event
 *    down to `{ table, type, remote }` by CONSTRUCTING A NEW FROZEN OBJECT
 *    LITERAL, never by spreading the event and deleting keys (a deleted key
 *    is still one property descriptor away, and is the wrong shape to assert
 *    against). This projection is the load-bearing security property of this
 *    file.
 *
 * 3. NOTHING BRIDGES TWO HANDLES OVER ONE BROWSER STORE, and the reason is
 *    one level deeper than "nobody starts the bridge". The plugin's register
 *    function builds a provider and a store module and returns them; it
 *    constructs no cross-tab bridge, and no file in this repo does either.
 *    But even a hand-constructed one is unusable here: the connection layer
 *    opens every handle with isolation enabled, which wraps the store module
 *    in an isolation module — and THAT wrapper exposes no `getEventEmitter`
 *    at all (measured: a real handle's table returns `undefined` for its
 *    emitter). The engine falls back to emitting local events itself, which
 *    is why `db.onDataChange` works for a handle's OWN writes; there is
 *    simply no module emitter to hand a bridge. Consequence: without
 *    `enableChangePropagation` below, D-27's seam is PROVABLY DEAD even in
 *    the one case that can fire today — and a seam that never fires looks
 *    exactly like a store that never changes, which is D-27's own stated
 *    failure mode reappearing inside the fix.
 *
 * 4. SO THIS MODULE CARRIES ITS OWN BRIDGE, AND THE BRIDGE CARRIES NO ROWS.
 *    The stock cross-tab bridge posts `{ ...event }` — the full row image —
 *    to every listener in the origin. Reusing it would have opened a NEW
 *    trust boundary into an anonymous page's heap in the name of closing a
 *    freshness gap. `enableChangePropagation` instead broadcasts the SAME
 *    projected `{ table, type }` this module hands its own consumers, so a
 *    row image never reaches the wire in the first place. The receiving side
 *    marks it `remote: true` and re-delivers it locally.
 *
 * 5. A REMOTE NOTICE DOES NOT INVALIDATE THE RECEIVING HANDLE'S POINT-LOOKUP
 *    READ CACHE, and that is a KNOWN LIMITATION with a reason rather than a
 *    TODO. Invalidating it needs the store PROVIDER, and no public API hands
 *    one back — the table handle holds its module as a declared-private
 *    field. The exposure is BOUNDED by the cached store's own contract:
 *    iteration and approximate-count always delegate to the underlying
 *    store, so scans and aggregates are unaffected; only primary-key point
 *    lookups can be served stale. A consumer that needs a guaranteed-fresh
 *    single row must re-read through a freshly attached handle.
 *
 * THIS MODULE NAMES NO TABLE. The allowlist is DERIVED at module scope from
 * the public read modules' own frozen read lists, so the notification channel
 * can never be wider than the read channel, and a fourth public read added
 * later without extending the union fails its own drift test rather than
 * going quietly unwatched. The derived union then passes through the
 * classification guard at module scope, so a member that ever stops being
 * public-safe breaks this file at IMPORT rather than silently widening the
 * notice channel.
 *
 * The three read modules are imported DIRECTLY, never through `./index.js`:
 * the barrel imports this file, and the cycle would be a runtime hazard
 * rather than a style question.
 *
 * ERROR HYGIENE: the only thing this module ever logs is an error's `name`.
 * Never its text (the engine embeds offending row and column values in
 * constraint-failure messages), never the event, and never the notice.
 */

import { assertPublicSafe } from '../classification.js';
import { dbNameFor } from '../open-db.js';
import { TABLES_READ as ELECTION_TABLES } from './read-election.js';
import { TABLES_READ as ROLL_TABLES } from './read-registrant-roll.js';
import { TABLES_READ as KEYRELEASE_TABLES } from './read-keyrelease.js';

/** @type {'public/subscribe.js'} */
const MODULE_LABEL = 'public/subscribe.js';

/**
 * The tables this seam will ever report, DERIVED as the sorted, de-duplicated
 * union of the three public read modules' own frozen read lists. Never a
 * hand-typed literal: a hand-typed list is a second place the read surface
 * lives, and the two drift silently.
 * @type {ReadonlyArray<string>}
 */
export const PUBLIC_SUBSCRIBED_TABLES = Object.freeze(
	[...new Set([...ELECTION_TABLES, ...ROLL_TABLES, ...KEYRELEASE_TABLES])].sort(),
);

// Module-scope guard. A member that ever stops being public-safe is an import
// crash here, not a widened notification channel nobody notices.
assertPublicSafe(PUBLIC_SUBSCRIBED_TABLES, MODULE_LABEL);

/**
 * The broadcast channel-name prefix. DELIBERATELY NOT the engine plugin's own
 * prefix: that channel carries full row images in a different message shape,
 * and sharing a name would let one be parsed as the other. See header point 4.
 * @type {string}
 */
const CHANGE_CHANNEL_PREFIX = 'votetorrent-public-change:';

/**
 * The one message kind this module posts and the only one it accepts. Anything
 * else on the channel is ignored without inspection.
 * @type {string}
 */
const CHANGE_MESSAGE_KIND = 'public-change';

/** The one prefix every log line in this module carries. @type {string} */
const LOG_PREFIX = 'public/subscribe:';

/**
 * Per-handle set of internal remote-notice sinks. A `WeakMap` keyed by the
 * `Database` handle so a closed, dereferenced handle takes its sinks with it —
 * the bridge and the subscription are started against the SAME handle by the
 * same effect, and neither may outlive it.
 * @type {WeakMap<object, Set<(table: string, type: string) => void>>}
 */
const REMOTE_SINKS = new WeakMap();

/**
 * @typedef {object} PublicChangeNotice
 * @property {string} table - a member of `PUBLIC_SUBSCRIBED_TABLES`.
 * @property {string} type - the mutation kind, as the engine reported it.
 * @property {boolean} remote - true when the change originated on another handle.
 */

/**
 * @typedef {object} PublicChangeStats
 * @property {number} delivered
 * @property {number} filtered
 * @property {number} localWrites
 */

/**
 * @typedef {object} PublicChangeSubscription
 * @property {boolean} live
 * @property {() => void} unsubscribe
 * @property {() => Readonly<PublicChangeStats>} stats
 */

/**
 * @typedef {object} ChangePropagation
 * @property {boolean} active
 * @property {() => void} stop
 */

/**
 * The error's `name` and nothing else — see this file's header.
 * @param {unknown} err
 * @returns {void}
 */
function logFailure(err) {
	const name = err && typeof (/** @type {any} */ (err).name) === 'string' ? /** @type {any} */ (err).name : 'Error';
	console.error(LOG_PREFIX, name);
}

/**
 * The table an event names, as a plain string, or `''` when it names none.
 * Reads ONE field off the event and copies nothing else.
 * @param {any} event
 * @returns {string}
 */
function tableOf(event) {
	return event && typeof event.tableName === 'string' ? event.tableName : '';
}

/**
 * The mutation kind an event reports. Not row data — a three-value enum the
 * engine sets itself.
 * @param {any} event
 * @returns {string}
 */
function typeOf(event) {
	return event && typeof event.type === 'string' ? event.type : 'unknown';
}

/**
 * @param {string} table
 * @returns {boolean}
 */
function isSubscribed(table) {
	return PUBLIC_SUBSCRIBED_TABLES.includes(table);
}

/**
 * Subscribe to changes in the tables the public read layer already reads.
 *
 * NEVER THROWS, and never leaves a consumer without a working release: a
 * handle that exposes no change channel yields `{ live: false }` and an
 * idempotent no-op `unsubscribe`, because a page that cannot subscribe must
 * still render (D-27's "degrade to static").
 *
 * Two sources feed one filter: the handle's OWN change channel (its local
 * writes), and the same-origin bridge `enableChangePropagation` starts (every
 * other handle's writes, already projected). Both go through the identical
 * projection, so there is exactly one place a row image could ever escape and
 * exactly one place it is prevented.
 *
 * `stats()` returns counters and no event content. `localWrites` is an
 * OBSERVABLE INVARIANT: the public page issues no writes, so a non-zero count
 * is a violation someone can see rather than a silent one.
 *
 * @param {any} db the open handle, or null.
 * @param {(notice: Readonly<PublicChangeNotice>) => void} onChange
 * @returns {PublicChangeSubscription}
 */
export function subscribeToPublicChanges(db, onChange) {
	let delivered = 0;
	let filtered = 0;
	let localWrites = 0;
	let released = false;

	/** @returns {Readonly<PublicChangeStats>} */
	const stats = () => Object.freeze({ delivered, filtered, localWrites });

	/**
	 * The one projection. A NEW frozen object literal with exactly three keys,
	 * built from two strings and a boolean read off the source — never a
	 * spread of the source with keys deleted afterwards. See header point 2.
	 * @param {string} table
	 * @param {string} type
	 * @param {boolean} remote
	 * @returns {void}
	 */
	const deliver = (table, type, remote) => {
		if (!isSubscribed(table)) {
			filtered += 1;
			return;
		}
		const notice = Object.freeze({ table, type, remote });
		delivered += 1;
		if (remote !== true) localWrites += 1;
		try {
			onChange(notice);
		} catch (err) {
			// A consumer that throws must not reach the engine's emitter, which
			// would otherwise log it per listener and continue against a
			// consumer whose expectations are now wrong.
			logFailure(err);
		}
	};

	if (!db || typeof db.onDataChange !== 'function') {
		return {
			live: false,
			unsubscribe: () => {
				released = true;
			},
			stats,
		};
	}

	/** @type {(table: string, type: string) => void} */
	const remoteSink = (table, type) => deliver(table, type, true);
	let sinks = REMOTE_SINKS.get(db);
	if (!sinks) {
		sinks = new Set();
		REMOTE_SINKS.set(db, sinks);
	}
	sinks.add(remoteSink);

	// NO SECOND ARGUMENT — header point 1. The engine's own release function is
	// kept and returned exactly once.
	const release = db.onDataChange((/** @type {any} */ event) => {
		deliver(tableOf(event), typeOf(event), event?.remote === true);
	});

	return {
		live: true,
		unsubscribe: () => {
			if (released) return;
			released = true;
			sinks?.delete(remoteSink);
			try {
				if (typeof release === 'function') release();
			} catch (err) {
				logFailure(err);
			}
		},
		stats,
	};
}

/**
 * Deliver an inbound broadcast to every subscription registered against `db`.
 * The message is VALIDATED, never trusted: an unrecognised kind is ignored
 * without inspection, and a table outside the allowlist is dropped before any
 * consumer exists to see it.
 *
 * @param {object} db
 * @param {any} message
 * @returns {void}
 */
function dispatchRemoteNotice(db, message) {
	if (!message || typeof message !== 'object' || message.kind !== CHANGE_MESSAGE_KIND) return;
	const table = typeof message.table === 'string' ? message.table : '';
	if (!isSubscribed(table)) return;
	const type = typeof message.type === 'string' ? message.type : 'unknown';
	const sinks = REMOTE_SINKS.get(db);
	if (!sinks) return;
	for (const sink of [...sinks]) {
		try {
			sink(table, type);
		} catch (err) {
			logFailure(err);
		}
	}
}

/**
 * `notifyPeerWrite(db, networkHash, table, type)` — the notify half of
 * `56-09`'s replication seam. A peer-replication write applies rows to `db`
 * through Quereus's external-write seam (`applyExternalRowChanges` /
 * `Database.ingestExternalRowChanges`), which by upstream's own documented
 * contract "does NOT emit module data events (the external writer owns
 * those, including the `remote` flag)". This function is that ownership
 * discharged: it reuses `dispatchRemoteNotice`'s validated / projected /
 * never-spread dispatch and the `PUBLIC_SUBSCRIBED_TABLES` allowlist — the
 * SAME code path an inbound cross-tab broadcast produces — so a peer write
 * and a cross-tab write travel identically and there is still exactly ONE
 * place a row image could escape.
 *
 * Granularity: this carries TABLE plus the three-valued mutation kind
 * (`insert`/`update`/`delete`), and NOTHING FINER. There is no table→fact
 * reverse map in this repo, and none is created here.
 *
 * NEVER THROWS. A falsy `db`, a `networkHash` that makes `dbNameFor` throw,
 * and a table outside `PUBLIC_SUBSCRIBED_TABLES` each return `false` and
 * deliver nothing.
 *
 * @param {any} db the open handle the peer write was applied to.
 * @param {string} networkHash
 * @param {string} table
 * @param {string} type
 * @returns {boolean} `true` iff a notice was dispatched.
 */
export function notifyPeerWrite(db, networkHash, table, type) {
	if (!db) return false;

	/** @type {string} */
	let name;
	try {
		name = dbNameFor(networkHash);
	} catch (err) {
		logFailure(err);
		return false;
	}

	if (!isSubscribed(table)) return false;

	// The SAME validated object literal shape `dispatchRemoteNotice` accepts
	// from an inbound broadcast — never a spread, never enriched with a row.
	const message = { kind: CHANGE_MESSAGE_KIND, table, type };

	// (a) Local dispatch — delivers to this handle's own subscriptions.
	dispatchRemoteNotice(db, message);

	// (b) Cross-tab dispatch. WHY A NEW CHANNEL IS OPENED AND CLOSED PER CALL
	// RATHER THAN CACHED: this function's signature carries no lifecycle, and
	// this module's `REMOTE_SINKS` discipline is a `WeakMap` precisely so
	// nothing outlives its handle — a cached channel would be a resource with
	// no `stop()` to release it, and in Node it would hold the event loop
	// open (see this file's non-`unref` note on `enableChangePropagation`).
	// Guarded on BroadcastChannel's presence so its absence degrades only the
	// cross-tab half, never the local half above.
	if (typeof BroadcastChannel !== 'undefined') {
		/** @type {any} */
		let channel;
		try {
			channel = new BroadcastChannel(CHANGE_CHANNEL_PREFIX + name);
			channel.postMessage(message);
		} catch (err) {
			logFailure(err);
		} finally {
			try {
				channel?.close();
			} catch (err) {
				logFailure(err);
			}
		}
	}

	// WHY THE ORIGINATING PAGE SEES TWO DELIVERIES, AND THAT IS THE ACCEPTED
	// COST. A `BroadcastChannel` does not deliver to the object that posted
	// it, but it DOES deliver to sibling objects in the same page — including
	// the channel `enableChangePropagation` owns on this SAME handle, whose
	// `onmessage` runs `dispatchRemoteNotice` again. A notice is idempotent
	// by construction (it carries no rows; every consumer re-reads), so the
	// duplication is bounded at exactly two rather than compounding. Two
	// rejected alternatives: dispatching locally only would leave a second
	// tab sharing this origin's IndexedDB permanently stale (its own bridge's
	// apply would be value-identical and therefore report nothing); posting
	// only would make local delivery silently depend on an unrelated
	// function (`enableChangePropagation`) having been called on this handle.
	//
	// WHY THE ENGINE'S OWN UNDERSCORE-PREFIXED EMITTER ACCESSOR IS NOT USED.
	// That accessor is covered by no documented contract and would break
	// silently across a quereus bump — and it is the wrong channel anyway
	// (this file's header point 3 already measured it as unreachable behind
	// the isolation wrapper). `subscribeToPublicChanges` reads its own
	// `REMOTE_SINKS`, which is what `dispatchRemoteNotice` already feeds.

	return true;
}

/**
 * Start same-origin change propagation for one handle over one network's
 * browser store. BOTH A READER AND A WRITER CALL THIS — that symmetry is not
 * incidental. If only the reader called it, a gate would have to start
 * something production does not, and a gate that passes because the test
 * added plumbing has proven nothing.
 *
 * What it does, in both directions:
 *   - OUT: every LOCAL change to an allowlisted table is projected and posted
 *     as `{ kind, table, type }`. No row image reaches the wire — header
 *     point 4. A change to any other table is not posted at all.
 *   - IN: a message from another handle in this origin is validated,
 *     re-projected and delivered to this handle's own subscriptions with
 *     `remote: true`.
 *
 * A broadcast channel does not deliver to the channel object that posted it,
 * so a handle never hears its own writes twice, and two handles in ONE page
 * bridge to each other exactly as two tabs would.
 *
 * NEVER THROWS: no change channel, no broadcast support, or an unusable
 * network name each yield `{ active: false }` and an idempotent no-op `stop`.
 *
 * The stock bridge's optional provider argument has no analogue here on
 * purpose — see header point 5 for the point-lookup cache limitation that
 * follows from it, and its bound.
 *
 * @param {any} db
 * @param {string} networkHash
 * @returns {ChangePropagation}
 */
export function enableChangePropagation(db, networkHash) {
	let stopped = false;

	if (!db || typeof db.onDataChange !== 'function' || typeof BroadcastChannel === 'undefined') {
		return {
			active: false,
			stop: () => {
				stopped = true;
			},
		};
	}

	/** @type {string} */
	let channelName;
	try {
		channelName = CHANGE_CHANNEL_PREFIX + dbNameFor(networkHash);
	} catch (err) {
		logFailure(err);
		return { active: false, stop: () => { stopped = true; } };
	}

	/** @type {any} */
	let channel;
	try {
		channel = new BroadcastChannel(channelName);
	} catch (err) {
		logFailure(err);
		return { active: false, stop: () => { stopped = true; } };
	}

	channel.onmessage = (/** @type {any} */ event) => {
		dispatchRemoteNotice(db, event?.data);
	};

	// DELIBERATELY NO `channel.unref?.()` HERE, and the omission was measured
	// rather than assumed. Node's `BroadcastChannel` is a libuv handle that
	// holds the event loop open, so an unref looks like the obvious way to keep
	// a Node-tier suite from hanging on this module — but removing the line and
	// re-running that suite changed nothing (16/16 either way): the real holder
	// was an unclosed `MessagePort` in the test itself. A line that is inert in
	// every real path but reads as a control is exactly the shape this repo has
	// shipped before. It would also MASK a genuinely leaked channel, which is
	// the failure `stop()` exists to make visible.

	const release = db.onDataChange((/** @type {any} */ event) => {
		// An inbound notice is re-delivered locally with `remote: true`; posting
		// it back out would be an echo loop between two handles.
		if (event?.remote === true) return;
		const table = tableOf(event);
		if (!isSubscribed(table)) return;
		try {
			channel.postMessage({ kind: CHANGE_MESSAGE_KIND, table, type: typeOf(event) });
		} catch (err) {
			logFailure(err);
		}
	});

	return {
		active: true,
		stop: () => {
			if (stopped) return;
			stopped = true;
			try {
				if (typeof release === 'function') release();
			} catch (err) {
				logFailure(err);
			}
			try {
				channel.onmessage = null;
				channel.close();
			} catch (err) {
				logFailure(err);
			}
		},
	};
}
