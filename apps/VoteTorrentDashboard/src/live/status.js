/**
 * status.js -- the header status for the live dashboard, as a pure reducer.
 *
 * "Live" means a read pass that started while the network connection was up
 * has completed since the last connect or reset, and that pass finished
 * within the last 40 seconds. Connection state alone is never "Live": a stale
 * screen can look exactly like a lost write, so the word has to be earned by
 * a completed read.
 *
 * This module reads no clock. Callers pass epoch-millisecond times in, which
 * keeps every row of the state table testable without waiting. It has no
 * imports and prints nothing. Errors carry fixed text, never an event field.
 *
 * The reducer does not debounce; the screen applies STATUS_DEBOUNCE_MS when
 * it renders.
 */

/** A pass older than this stops reading as Live (milliseconds). */
export const LIVE_FRESH_WINDOW_MS = 40_000;
/** A disconnection becomes Offline only after this long (milliseconds). */
export const OFFLINE_GRACE_MS = 10_000;
/** The boot retries a lost connection in the background at this cadence. */
export const BACKGROUND_RETRY_MS = 20_000;
/** The screen holds a status change this long before showing it. */
export const STATUS_DEBOUNCE_MS = 1_000;

export const STATUS_KINDS = Object.freeze(['live', 'catching-up', 'offline', 'not-live', 'unpaired']);
/** The kinds the header chip renders; `unpaired` renders the pairing notice instead. */
export const CHIP_KINDS = Object.freeze(['live', 'catching-up', 'offline', 'not-live']);
export const UNPAIRED_REASONS = Object.freeze(['revoked', 'removed', 'key-invalid']);
export const STATUS_EVENT_TYPES = Object.freeze([
	'control-connected',
	'control-disconnected',
	'strand-peers',
	'pass-start',
	'pass-complete',
	'pass-failed',
	'reconnect-start',
	'reconnect-end',
	'follower',
	'promoted',
	'unpaired',
	'reset',
]);

/**
 * @typedef {'revoked' | 'removed' | 'key-invalid'} UnpairedReason
 *
 * @typedef {object} StatusState
 * @property {boolean} controlConnected
 * @property {number} strandPeers non-negative integer
 * @property {boolean} passDone a qualifying pass completed since the last connect or reset
 * @property {boolean} passStartedConnected the in-flight pass began while connected
 * @property {boolean} passInFlight
 * @property {number | null} lastPassAt
 * @property {number | null} disconnectedSince
 * @property {number | null} resetAt
 * @property {boolean} reconnecting
 * @property {'leader' | 'follower'} role
 * @property {UnpairedReason | null} unpaired
 *
 * @typedef {object} StatusView
 * @property {'live' | 'catching-up' | 'offline' | 'not-live' | 'unpaired'} kind
 * @property {number | null} lastPassAt
 * @property {boolean} reconnecting
 * @property {UnpairedReason} [reason]
 */

/** @param {unknown} v @returns {number | null} */
function timeOrNull(v) {
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * @param {{ lastPassAt?: number | null }} [init]
 * @returns {StatusState}
 */
export function initialStatus(init) {
	return Object.freeze({
		controlConnected: false,
		strandPeers: 0,
		passDone: false,
		passStartedConnected: false,
		passInFlight: false,
		lastPassAt: timeOrNull(init?.lastPassAt),
		disconnectedSince: null,
		resetAt: null,
		reconnecting: false,
		role: /** @type {const} */ ('leader'),
		unpaired: null,
	});
}

/** @param {StatusState} s */
function isConnected(s) {
	return s.controlConnected && s.strandPeers > 0;
}

/**
 * @param {StatusState} state
 * @param {{ type: string, [k: string]: unknown }} event
 * @param {number} nowMs
 * @returns {StatusState}
 */
export function reduceStatus(state, event, nowMs) {
	if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
		throw new TypeError('reduceStatus: invalid nowMs');
	}
	if (event === null || typeof event !== 'object' || !STATUS_EVENT_TYPES.includes(event.type)) {
		throw new TypeError('reduceStatus: unknown event');
	}
	if (event.type === 'reset') {
		return Object.freeze({
			...initialStatus({ lastPassAt: /** @type {number | null} */ (event.lastPassAt) }),
			resetAt: nowMs,
			disconnectedSince: nowMs,
		});
	}
	if (state.unpaired !== null) return state;

	const connectedBefore = isConnected(state);
	/** @type {StatusState} */
	const next = { ...state };

	switch (event.type) {
		case 'control-connected':
			next.controlConnected = true;
			break;
		case 'control-disconnected':
			next.controlConnected = false;
			break;
		case 'strand-peers': {
			const c = event.count;
			next.strandPeers = typeof c === 'number' && Number.isSafeInteger(c) && c >= 0 ? c : 0;
			break;
		}
		case 'pass-start':
			next.passInFlight = true;
			next.passStartedConnected = connectedBefore;
			break;
		case 'pass-complete': {
			const at = event.at;
			if (typeof at !== 'number' || !Number.isFinite(at)) {
				throw new TypeError('reduceStatus: invalid pass time');
			}
			next.passInFlight = false;
			if (state.resetAt !== null && at < state.resetAt) break;
			if (state.passStartedConnected) {
				next.lastPassAt = at;
				if (isConnected(next)) next.passDone = true;
			}
			break;
		}
		case 'pass-failed':
			next.passInFlight = false;
			next.passStartedConnected = false;
			break;
		case 'reconnect-start':
			next.reconnecting = true;
			break;
		case 'reconnect-end':
			next.reconnecting = false;
			break;
		case 'follower':
			next.role = 'follower';
			break;
		case 'promoted':
			next.role = 'leader';
			next.controlConnected = false;
			next.strandPeers = 0;
			next.passDone = false;
			next.passInFlight = false;
			next.passStartedConnected = false;
			next.disconnectedSince = nowMs;
			break;
		case 'unpaired': {
			const reason = /** @type {UnpairedReason} */ (event.reason);
			if (!UNPAIRED_REASONS.includes(reason)) {
				throw new TypeError('reduceStatus: unknown unpaired reason');
			}
			next.unpaired = reason;
			break;
		}
		default:
			break;
	}

	const connectedAfter = isConnected(next);
	if (!connectedBefore && connectedAfter) {
		next.passDone = false;
		next.passStartedConnected = false;
		next.disconnectedSince = null;
	} else if (connectedBefore && !connectedAfter) {
		next.disconnectedSince = nowMs;
	}
	if (!connectedAfter && next.disconnectedSince === null) {
		next.disconnectedSince = nowMs;
	}
	return Object.freeze(next);
}

/**
 * @param {StatusState} state
 * @param {number} nowMs
 * @returns {StatusView}
 */
export function viewStatus(state, nowMs) {
	if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
		throw new TypeError('viewStatus: invalid nowMs');
	}
	const { lastPassAt, reconnecting } = state;
	if (state.unpaired !== null) {
		return Object.freeze({ kind: /** @type {const} */ ('unpaired'), lastPassAt, reconnecting, reason: state.unpaired });
	}
	if (state.role === 'follower') {
		return Object.freeze({ kind: /** @type {const} */ ('not-live'), lastPassAt, reconnecting });
	}
	const connected = isConnected(state);
	if (connected && state.passDone && lastPassAt !== null && nowMs - lastPassAt <= LIVE_FRESH_WINDOW_MS) {
		return Object.freeze({ kind: /** @type {const} */ ('live'), lastPassAt, reconnecting });
	}
	if (!connected && state.disconnectedSince !== null && nowMs - state.disconnectedSince >= OFFLINE_GRACE_MS) {
		return Object.freeze({ kind: /** @type {const} */ ('offline'), lastPassAt, reconnecting });
	}
	return Object.freeze({ kind: /** @type {const} */ ('catching-up'), lastPassAt, reconnecting });
}
