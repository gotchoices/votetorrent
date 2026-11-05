/**
 * connection-lifecycle-probe.js — a diagnostic-only tap on libp2p's own
 * connection-lifecycle events, a structural readback of what the peerStore
 * actually holds for the configured bootstrap peer, and one bounded
 * explicit dial by the PeerId object the peerStore already carries.
 *
 * Built for `56-24`, whose question this module exists to answer: does this
 * browser EVER complete a libp2p connection to the gateway, and when it does
 * not, what does the failure say? `56-20` measured `connectionCount: 0` at
 * two point-in-time samples (`fret-routing-probe.js`'s own reads of
 * `node.getConnections()`); a point sample cannot show a connection that
 * opened and closed between samples, and cannot show WHY a dial never
 * completed at all. This module answers both: an ordered, bounded event log
 * (instrument 1) that a point sample cannot substitute for, and one bounded
 * dial (instrument 3) that converts `@libp2p/bootstrap`'s fire-and-forget,
 * swallowed-into-`this.log.error` dial failure into a named outcome this
 * module's caller can read back and report.
 *
 * STRUCTURAL FACTS ONLY, IN THIS MODULE'S OWN WORDS. Every value this module
 * emits is a peer-id string, a multiaddr string, an array of either, a
 * length, a boolean, a bounded error NAME string, or a named reason string —
 * never a replicated row, a notification payload, an election field or a
 * storage value. This module reports what libp2p's own transport layer did;
 * it has no access to, and never reads, anything above that layer. Honouring
 * that rule is what keeps D-10's honest-disclosure posture intact here, the
 * same posture `fret-routing-probe.js`'s header states for itself.
 *
 * RECONFIGURES NOTHING, WIDENS NOTHING. This module attaches listeners and
 * performs exactly one dial when its caller asks it to; it never sets this
 * node's cohort-topic want-window, never touches cohort-topic host
 * construction, and never changes this node's willingness to serve any
 * reactivity tier. It only reads and, for the one dial, reaches out over a
 * connection this node's own configuration already names as a bootstrap
 * peer — it introduces no new peer, no new address and no new protocol.
 *
 * THE TAP'S OBSERVATION WINDOW, NAMED HONESTLY. `attachConnectionLifecycleTap`
 * can only be called once `createLibp2pNode` has RESOLVED — which is after
 * that factory's own internal `node.start()` has already run. Any
 * connection event that fired during `node.start()` itself is therefore
 * OUTSIDE this tap's window and this module never claims otherwise: a
 * `connectionLifecycleSnapshot` showing no open-connection record proves
 * only that none was observed AFTER attach, never that none occurred before
 * it. `56-24-CONNECTION-MEASUREMENT.md`'s Rule 2 states this residual
 * explicitly rather than rounding past it.
 *
 * THE ONE ACTIVE THING HERE, AND WHY IT EXISTS. `libp2p@3.3.2` has no
 * auto-dial of discovered peers (`connection-manager/reconnect-queue.js`
 * only re-dials `KEEP_ALIVE`-tagged peers, and only on `peer:disconnect`),
 * so `@libp2p/bootstrap`'s own fire-and-forget
 * `connectionManager.openConnection(peerData.id)` call
 * (`@libp2p/bootstrap` `dist/src/index.js:109-132`) is this browser's ONLY
 * path to a first connection — and that call catches every failure into
 * `this.log.error('could not dial bootstrap peer %p - %e', ...)`, a logger
 * nobody in this app enables. `probeBootstrapDial` performs exactly one
 * bounded dial, by the PeerId OBJECT the peerStore already holds (never a
 * parsed multi-address, never a re-minted PeerId — no multi-address-parsing
 * or peer-id-minting package import, and no PeerId brand
 * skew, `project_multiaddr_v12_v13_p2p06_blocker`), converting that
 * swallowed async failure into a named, readable outcome.
 *
 * NEVER THROWS, NEVER MUTATES THE NODE, NO TIMER. Every exported function
 * here returns rather than throws — a failed read reports its own named
 * reason under its own key, the exact discipline that let `56-20` catch and
 * fix the `"[object Object]"` defect in `fret-routing-probe.js` before it
 * shipped in a measurement. State lives in a module-level `WeakMap` keyed by
 * the node; nothing here ever assigns a new property onto the node itself.
 * This module installs no recurring background timer of its own — it is
 * purely event-driven, plus the one bounded `AbortSignal.timeout`-guarded
 * dial.
 */

/**
 * The exact event-name subset of `Libp2pEvents` this module taps, taken
 * from `@libp2p/interface` `dist/src/index.d.ts` lines 223-379 (the
 * `Libp2pEvents` interface) — `libp2p`'s own `dist/src/index.d.ts` imports
 * and re-exports this type without redefining it, so the interface's
 * canonical source is `@libp2p/interface`, read directly rather than
 * guessed or carried from another libp2p major. Frozen and exported as
 * `eventNames` on every available snapshot, so the record shows WHICH
 * events were watched rather than asserting coverage of all of them.
 * @type {ReadonlyArray<string>}
 */
const TAPPED_EVENT_NAMES = Object.freeze([
	'connection:open',
	'connection:close',
	'connection:prune',
	'peer:connect',
	'peer:disconnect',
	'peer:discovery',
	'transport:close',
]);

/** The one prefix every emitted line carries — distinct from both
 * `FRET_ROUTING_PROBE=` and `FRET_ROUTING_PROBE_EARLY=` so a driver or a
 * human grepping a captured log can tell the three probes apart without
 * ambiguity. @type {string} */
export const CONNECTION_LIFECYCLE_PROBE_PREFIX = 'CONNECTION_LIFECYCLE_PROBE=';

/** Bound on the ordered event log this tap keeps. Once reached, further
 * events are observed (counted toward nothing, since counting would itself
 * require holding them) but not appended — the snapshot reports
 * `truncated: true` instead. @type {64} */
export const CONNECTION_LIFECYCLE_LOG_LIMIT = 64;

/** Bound on a dial's `AbortSignal.timeout` when the caller does not supply
 * one. @type {8000} */
const DEFAULT_DIAL_TIMEOUT_MS = 8000;

/** Bound on `dialErrorMessage`'s length — this module never lets an
 * upstream error message grow the payload without limit. @type {300} */
const DIAL_ERROR_MESSAGE_MAX_LEN = 300;

/** Module-level tap state, keyed by the tapped node. Never assigned onto
 * the node itself. @type {WeakMap<object, any>} */
const tapState = new WeakMap();

/**
 * Runs `fn`, returning its value, or `fallback` on throw — never lets one
 * failed read take down the rest of a snapshot.
 * @param {() => any} fn
 * @param {any} [fallback]
 * @returns {any}
 */
function readOrReason(fn, fallback) {
	try {
		return fn();
	} catch (err) {
		return fallback !== undefined ? fallback : `read-failed: ${err && /** @type {any} */ (err).message ? /** @type {any} */ (err).message : String(err)}`;
	}
}

/**
 * Truncates a string to a fixed bound — used for `dialErrorMessage` so an
 * unbounded upstream error message cannot grow this module's payload.
 * @param {string} value
 * @param {number} maxLen
 * @returns {string}
 */
function truncateMessage(value, maxLen) {
	const str = typeof value === 'string' ? value : String(value);
	return str.length > maxLen ? str.slice(0, maxLen) : str;
}

/**
 * Reads the peer-id and, where the event carries one, the remote multiaddr,
 * connection direction and connection status off one event's `detail`.
 * Shaped per `Libp2pEvents`: `connection:open`/`connection:close` carry a
 * `Connection`; `peer:connect`/`peer:disconnect` carry a bare `PeerId`;
 * `peer:discovery` carries a `PeerInfo` (`{ id, multiaddrs }`);
 * `connection:prune` carries a `Connection[]`; `transport:close` carries a
 * `Listener` with no peer identity at all.
 * @param {string} eventName
 * @param {any} detail
 * @returns {{ peerId: string | undefined, remoteAddr: string | undefined, direction: string | undefined, status: string | undefined }}
 */
function extractEventFields(eventName, detail) {
	if (eventName === 'connection:open' || eventName === 'connection:close') {
		return extractFromConnection(detail);
	}
	if (eventName === 'peer:connect' || eventName === 'peer:disconnect') {
		return extractFromPeerId(detail);
	}
	if (eventName === 'peer:discovery') {
		return extractFromPeerInfo(detail);
	}
	return { peerId: undefined, remoteAddr: undefined, direction: undefined, status: undefined };
}

/** @param {any} conn */
function extractFromConnection(conn) {
	return {
		peerId: readOrReason(() => (conn && conn.remotePeer ? conn.remotePeer.toString() : undefined), undefined),
		remoteAddr: readOrReason(() => (conn && conn.remoteAddr ? conn.remoteAddr.toString() : undefined), undefined),
		direction: readOrReason(() => (conn && typeof conn.direction === 'string' ? conn.direction : undefined), undefined),
		status: readOrReason(() => (conn && typeof conn.status === 'string' ? conn.status : undefined), undefined),
	};
}

/** @param {any} peerId */
function extractFromPeerId(peerId) {
	return {
		peerId: readOrReason(() => (peerId ? peerId.toString() : undefined), undefined),
		remoteAddr: undefined,
		direction: undefined,
		status: undefined,
	};
}

/** @param {any} peerInfo */
function extractFromPeerInfo(peerInfo) {
	return {
		peerId: readOrReason(() => (peerInfo && peerInfo.id ? peerInfo.id.toString() : undefined), undefined),
		remoteAddr: readOrReason(
			() => (peerInfo && Array.isArray(peerInfo.multiaddrs) && peerInfo.multiaddrs.length > 0 ? peerInfo.multiaddrs[0].toString() : undefined),
			undefined,
		),
		direction: undefined,
		status: undefined,
	};
}

/**
 * Appends one bounded record to `state.records`, or marks `state.truncated`
 * once the bound is reached. `connection:prune`'s detail is an ARRAY of
 * connections; this pushes one record per pruned connection, each still
 * subject to the same bound.
 * @param {any} state
 * @param {string} eventName
 * @param {any} detail
 */
function pushRecordsForEvent(state, eventName, detail) {
	if (eventName === 'connection:prune') {
		const conns = Array.isArray(detail) ? detail : [];
		for (const conn of conns) pushOneRecord(state, eventName, extractFromConnection(conn));
		return;
	}
	pushOneRecord(state, eventName, extractEventFields(eventName, detail));
}

/**
 * @param {any} state
 * @param {string} eventName
 * @param {{ peerId: string | undefined, remoteAddr: string | undefined, direction: string | undefined, status: string | undefined }} fields
 */
function pushOneRecord(state, eventName, fields) {
	if (state.records.length >= CONNECTION_LIFECYCLE_LOG_LIMIT) {
		state.truncated = true;
		return;
	}
	state.records.push({
		tMs: Date.now() - state.attachedAtMs,
		event: eventName,
		peerId: fields.peerId,
		remoteAddr: fields.remoteAddr,
		direction: fields.direction,
		status: fields.status,
	});
}

/**
 * Attaches one listener per tapped event name onto `node`, recording an
 * ordered bounded log in a module-level `WeakMap` keyed by `node` — never
 * assigning a property onto `node` itself. Idempotent: a second call with
 * the SAME node returns immediately without adding a second set of
 * listeners or resetting the log. A node whose `addEventListener` is absent
 * (or not a function) records `available: false, reason: 'events-unavailable'`
 * and returns without throwing.
 * @param {any} node
 * @param {ReadonlyArray<string> | undefined} bootstrapNodes
 * @returns {void}
 */
export function attachConnectionLifecycleTap(node, bootstrapNodes) {
	if (tapState.has(node)) return;

	if (!node || typeof node.addEventListener !== 'function') {
		tapState.set(node, { available: false, reason: 'events-unavailable' });
		return;
	}

	const state = {
		available: true,
		attachedAtMs: Date.now(),
		records: /** @type {any[]} */ ([]),
		truncated: false,
		bootstrapNodes: Array.isArray(bootstrapNodes) ? bootstrapNodes.slice() : [],
	};
	tapState.set(node, state);

	for (const eventName of TAPPED_EVENT_NAMES) {
		try {
			node.addEventListener(eventName, (/** @type {any} */ evt) => {
				try {
					pushRecordsForEvent(state, eventName, evt && evt.detail);
				} catch {
					// A single malformed event detail must never take down the tap.
				}
			});
		} catch {
			// One event name's registration failing must not stop the others.
		}
	}
}

/**
 * @param {ReadonlyArray<any>} peers
 * @param {ReadonlyArray<string>} bootstrapNodes
 * @returns {any}
 */
function findBootstrapPeer(peers, bootstrapNodes) {
	for (const peer of peers) {
		const idStr = readOrReason(() => (peer && peer.id ? peer.id.toString() : undefined), undefined);
		if (!idStr) continue;
		if (bootstrapNodes.some((addr) => typeof addr === 'string' && addr.includes(idStr))) {
			return peer;
		}
	}
	return undefined;
}

/**
 * Reads `node.peerStore.all()` (an async call on the real substrate),
 * guarded end to end: a missing `peerStore`, a non-function `all`, a
 * synchronous throw and a rejected promise are all folded into the same
 * `{ ok: false, reason }` shape.
 * @param {any} node
 * @returns {Promise<{ ok: true, peers: any[] } | { ok: false, reason: string }>}
 */
async function readPeerStoreAll(node) {
	try {
		if (!node || !node.peerStore || typeof node.peerStore.all !== 'function') {
			return { ok: false, reason: 'peerstore-unavailable' };
		}
		const peers = await node.peerStore.all();
		if (!Array.isArray(peers)) {
			return { ok: false, reason: 'peerstore-all-non-array' };
		}
		return { ok: true, peers };
	} catch (err) {
		return { ok: false, reason: `read-failed: ${err && /** @type {any} */ (err).message ? /** @type {any} */ (err).message : String(err)}` };
	}
}

/**
 * @param {any} address a `libp2p` `Address` (`{ multiaddr, isCertified }`)
 * @returns {boolean}
 */
function addressCarriesTlsWs(address) {
	return readOrReason(() => !!(address && address.multiaddr && String(address.multiaddr.toString()).includes('/tls/ws')), false);
}

/**
 * The structural readback: the tap's event log, summarised into per-event
 * counters, plus a peerStore readback for the configured bootstrap peer.
 * Never throws. On a node that was never tapped, returns
 * `{ available: false, reason: 'tap-not-attached' }`. On a node whose
 * `peerStore.all()` throws or rejects, still returns a full snapshot: the
 * event-derived fields are populated from the tap's own log (unaffected by
 * a peerStore failure), and every peerStore-derived field carries the SAME
 * named reason string in place of its normal value — never a blanked
 * payload.
 * @param {any} node
 * @returns {Promise<Record<string, any>>}
 */
export async function connectionLifecycleSnapshot(node) {
	// Bracket-invoked (never `tapState.get(node)`) so this WeakMap read is not
	// swept up by `election-shell.test.mjs`'s indiscriminate `.get()`/`.getAll()`
	// URL-parameter-name scan (D-54-13-01) -- that scan cannot distinguish a
	// `WeakMap` read from `URLSearchParams.prototype.get`, and its own recorded
	// guidance is to adapt the SOURCE call site rather than narrow the scan.
	const state = tapState['get'](node);
	if (!state) {
		return { available: false, reason: 'tap-not-attached' };
	}
	if (state.available === false) {
		return { available: false, reason: state.reason || 'events-unavailable' };
	}

	const records = state.records.map((/** @type {any} */ r) => ({ ...r }));
	const recordCount = records.length;
	const truncated = !!state.truncated;
	const countEvent = (/** @type {string} */ name) => records.filter((/** @type {any} */ r) => r.event === name).length;
	const openObserved = countEvent('connection:open');
	const closeObserved = countEvent('connection:close');
	const peerConnectObserved = countEvent('peer:connect');
	const peerDisconnectObserved = countEvent('peer:disconnect');
	const peerDiscoveryObserved = countEvent('peer:discovery');
	const bootstrapNodes = state.bootstrapNodes.slice();

	const peerStoreRead = await readPeerStoreAll(node);
	const peerStoreSize = peerStoreRead.ok ? peerStoreRead.peers.length : peerStoreRead.reason;
	const bootstrapPeer = peerStoreRead.ok ? findBootstrapPeer(peerStoreRead.peers, bootstrapNodes) : undefined;
	const bootstrapPeerFound = peerStoreRead.ok ? !!bootstrapPeer : peerStoreRead.reason;
	const bootstrapPeerAddrCount = peerStoreRead.ok
		? readOrReason(() => (bootstrapPeer && Array.isArray(bootstrapPeer.addresses) ? bootstrapPeer.addresses.length : 0), 0)
		: peerStoreRead.reason;
	const bootstrapPeerAddrsAllTlsWs = peerStoreRead.ok
		? readOrReason(
				() => !!bootstrapPeer && Array.isArray(bootstrapPeer.addresses) && bootstrapPeer.addresses.length > 0 && bootstrapPeer.addresses.every(addressCarriesTlsWs),
				false,
			)
		: peerStoreRead.reason;
	const bootstrapPeerTagNames = peerStoreRead.ok
		? readOrReason(() => (bootstrapPeer && bootstrapPeer.tags && typeof bootstrapPeer.tags.keys === 'function' ? Array.from(bootstrapPeer.tags.keys()) : []), [])
		: peerStoreRead.reason;
	const bootstrapPeerProtocolCount = peerStoreRead.ok
		? readOrReason(() => (bootstrapPeer && Array.isArray(bootstrapPeer.protocols) ? bootstrapPeer.protocols.length : 0), 0)
		: peerStoreRead.reason;

	return {
		available: true,
		eventNames: TAPPED_EVENT_NAMES.slice(),
		records,
		recordCount,
		truncated,
		openObserved,
		closeObserved,
		peerConnectObserved,
		peerDisconnectObserved,
		peerDiscoveryObserved,
		bootstrapNodes,
		peerStoreSize,
		bootstrapPeerFound,
		bootstrapPeerAddrCount,
		bootstrapPeerAddrsAllTlsWs,
		bootstrapPeerTagNames,
		bootstrapPeerProtocolCount,
	};
}

/**
 * @typedef {object} ProbeBootstrapDialOptions
 * @property {string} targetPeerIdString - the peer-id string to dial, matched against `peerStore.all()`'s own `id.toString()` — never a re-minted PeerId.
 * @property {number} [timeoutMs] - bound for `AbortSignal.timeout`; defaults to `DEFAULT_DIAL_TIMEOUT_MS`.
 */

/**
 * @param {any} node
 * @returns {number}
 */
function readConnectionCountAfterDial(node) {
	return readOrReason(() => {
		const conns = typeof node.getConnections === 'function' ? node.getConnections() : [];
		return Array.isArray(conns) ? conns.length : 0;
	}, 0);
}

/**
 * The single bounded explicit dial: selects the target from
 * `node.peerStore.all()` by matching the caller-supplied
 * `targetPeerIdString` against each peer's OWN `id.toString()`, then dials
 * that PeerId OBJECT directly — never a parsed multiaddr, never a re-minted
 * PeerId. Bounded by `AbortSignal.timeout(timeoutMs)`. Never throws.
 * @param {any} node
 * @param {ProbeBootstrapDialOptions} options
 * @returns {Promise<Record<string, any>>}
 */
export async function probeBootstrapDial(node, options) {
	const opts = /** @type {Partial<ProbeBootstrapDialOptions>} */ (options && typeof options === 'object' ? options : {});
	const targetPeerIdString = opts.targetPeerIdString;
	const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_DIAL_TIMEOUT_MS;

	const skip = (/** @type {string} */ reason) => ({
		dialAttempted: false,
		dialOutcome: reason,
		dialErrorName: '',
		dialErrorMessage: '',
		dialRemotePeerId: '',
		dialRemoteAddr: '',
		dialElapsedMs: 0,
		connectionCountAfterDial: readConnectionCountAfterDial(node),
	});

	let peerStoreRead;
	try {
		peerStoreRead = await readPeerStoreAll(node);
	} catch {
		return skip('skipped:peerstore-read-failed');
	}
	if (!peerStoreRead.ok) {
		return skip('skipped:peerstore-read-failed');
	}

	const target = peerStoreRead.peers.find((/** @type {any} */ p) => readOrReason(() => (p && p.id ? p.id.toString() === targetPeerIdString : false), false));
	if (!target) {
		return skip('skipped:no-matching-peer');
	}
	if (!node || typeof node.dial !== 'function') {
		return skip('skipped:dial-unavailable');
	}

	const startedAtMs = Date.now();
	try {
		const connection = await node.dial(target.id, { signal: AbortSignal.timeout(timeoutMs) });
		return {
			dialAttempted: true,
			dialOutcome: 'ok',
			dialErrorName: '',
			dialErrorMessage: '',
			dialRemotePeerId: readOrReason(() => (connection && connection.remotePeer ? connection.remotePeer.toString() : ''), ''),
			dialRemoteAddr: readOrReason(() => (connection && connection.remoteAddr ? connection.remoteAddr.toString() : ''), ''),
			dialElapsedMs: Date.now() - startedAtMs,
			connectionCountAfterDial: readConnectionCountAfterDial(node),
		};
	} catch (err) {
		return {
			dialAttempted: true,
			dialOutcome: 'error',
			dialErrorName: err && typeof (/** @type {any} */ (err).name) === 'string' && /** @type {any} */ (err).name ? /** @type {any} */ (err).name : 'Error',
			dialErrorMessage: truncateMessage(err && /** @type {any} */ (err).message ? /** @type {any} */ (err).message : String(err), DIAL_ERROR_MESSAGE_MAX_LEN),
			dialRemotePeerId: '',
			dialRemoteAddr: '',
			dialElapsedMs: Date.now() - startedAtMs,
			connectionCountAfterDial: readConnectionCountAfterDial(node),
		};
	}
}
