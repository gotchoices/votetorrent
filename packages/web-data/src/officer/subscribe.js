/**
 * officer/subscribe.js -- the live dashboard's change-notice seam (contract
 * C-7), the officer twin of `../public/subscribe.js`.
 *
 * WHAT IT CARRIES. "Table T changed with op O on network N", and nothing
 * else. A notice tells a panel to re-read; it never carries a row.
 *
 * - TABLE NAMES APPEAR IN TWO HAND-WRITTEN LISTS ONLY, `PAIRING_TABLES` and
 *   `ADMIN_PANEL_AND_GATE_TABLES`. Each states why it is hand-written, and
 *   each is bounded by a drift test derived from its real consumers
 *   (`test/officer-subscribe.test.mjs`). Everything else is DERIVED from the
 *   officer read modules' own frozen read lists and `CAPABILITY_TABLES`, and
 *   every member of the union passes the classification guard at import.
 * - NOTICES ARE ROW-LESS. A delivered notice is a NEW frozen object literal
 *   with exactly `table` and `op`; the cross-tab message is a new literal
 *   with exactly `kind`, `table` and `op`. Never a spread of an event or a
 *   message (the same rule as the public seam's header point 2): a spread
 *   copies whatever the source carried.
 * - NOTICES ARE SCOPED PER NETWORK. Listeners register against one network
 *   hash and the broadcast channel name carries that hash, so a notice for
 *   network A never reaches a listener for network B (only the selected
 *   network runs).
 * - ERROR HYGIENE: the only thing logged is an error's `name`.
 *
 * WHO DRIVES IT. The engine's own change emitter is not used here at all.
 * The replication bridge calls `notifyOfficerPeerWrite` once per
 * (table, op) per completed pass, from the effective changes it applied
 * (insert, update or delete -- never "upsert", which is dropped). The
 * per-network broadcast channel exists so follower tabs of the same network
 * re-read too.
 *
 * The officer read modules are imported DIRECTLY, never through `./index.js`:
 * the barrel imports this file, and the cycle would be a runtime hazard.
 */

import { CAPABILITY_TABLES } from './capability-tables.js';
import { TABLES_READ as ELECTIONS_TABLES } from './elections.js';
import { TABLES_READ as BALLOTS_TABLES } from './ballots.js';
import { TABLES_READ as REGISTRATIONS_TABLES } from './registrations.js';
import { TABLES_READ as KEYHOLDERS_TABLES } from './read-keyholders.js';
import { classOf } from '../classification.js';

/**
 * The tables the per-pass pairing validity check reads: the statement's
 * Officer and UserKey rows (with the User they belong to) and the revocation
 * lookup. `Admin` is deliberately NOT a pairing table: current-officer status
 * is judged by the owner at mint time, so browser clock skew never wipes a
 * browser. This is the only place in this package's `src/` outside
 * `../classification.js` that names the revocation table, which is officer
 * only.
 * @type {ReadonlyArray<string>}
 */
export const PAIRING_TABLES = Object.freeze(['DashboardPairingRevocation', 'Officer', 'User', 'UserKey']);

/**
 * The base tables read by the advisory gate (vote-engine
 * `UserEngine.isPrivileged`: `Officer` joined to the `CurrentAdmin` view over
 * `Admin`) and by the dashboard's
 * `apps/VoteTorrentDashboard/src/screens/panels/authority-admin-queries.js`.
 * Both live outside this package, so this list cannot be imported from them;
 * the drift test derives the required set from both sources and fails when
 * either reads a table outside the union. A panel that starts reading a new
 * table must extend this list in the same change. The `CurrentAdmin` view now
 * also reads the administration-change cancellation table, so the advisory
 * gate's view read requires it too.
 * @type {ReadonlyArray<string>}
 */
export const ADMIN_PANEL_AND_GATE_TABLES = Object.freeze(
	[
		'Admin',
		'AdminCancellation',
		'AdminSigning',
		'Authority',
		'AuthorityPeer',
		'ElectionRevision',
		'InviteCancellation',
		'InviteResult',
		'InviteSlot',
		'Keyholder',
		'Network',
		'Officer',
		'User',
	].sort(),
);

/**
 * Every table a notice may name: the sorted, de-duplicated union of the
 * capability lists, the four officer read modules' read lists and the two
 * hand-written lists above.
 * @type {ReadonlyArray<string>}
 */
export const OFFICER_SUBSCRIBED_TABLES = Object.freeze(
	[
		...new Set([
			...Object.values(CAPABILITY_TABLES).flat(),
			...ELECTIONS_TABLES,
			...BALLOTS_TABLES,
			...REGISTRATIONS_TABLES,
			...KEYHOLDERS_TABLES,
			...ADMIN_PANEL_AND_GATE_TABLES,
			...PAIRING_TABLES,
		]),
	].sort(),
);

// Module-scope guard: an unclassified member crashes the import rather than
// widening the notice channel.
for (const table of OFFICER_SUBSCRIBED_TABLES) {
	classOf(table);
}

/**
 * The effective change kinds a notice may carry. Callers pass the kind the
 * change actually had, never "upsert".
 * @type {ReadonlyArray<string>}
 */
export const OFFICER_CHANGE_OPS = Object.freeze(['delete', 'insert', 'update']);

/** @type {'vt-dashboard-changes-'} */
export const OFFICER_CHANGE_CHANNEL_PREFIX = 'vt-dashboard-changes-';

/** The one message kind this module posts and accepts. */
const CHANGE_MESSAGE_KIND = 'officer-change';

/** The one prefix every log line in this module carries. */
const LOG_PREFIX = 'officer/subscribe:';

/**
 * @typedef {object} OfficerChangeNotice
 * @property {string} table - a member of `OFFICER_SUBSCRIBED_TABLES`
 * @property {string} op - a member of `OFFICER_CHANGE_OPS`
 */

/**
 * @typedef {object} NetworkState
 * @property {Set<(notice: Readonly<OfficerChangeNotice>) => void>} listeners
 * @property {any} channel - the network's open BroadcastChannel, or null
 */

/** @type {Map<string, NetworkState>} */
const NETWORKS = new Map();

/**
 * The broadcast channel name for one network.
 * @param {string} networkHash
 * @returns {string}
 */
export function officerChangeChannelName(networkHash) {
	if (typeof networkHash !== 'string' || networkHash.length === 0) {
		throw new TypeError('officerChangeChannelName: networkHash must be a non-empty string');
	}
	return OFFICER_CHANGE_CHANNEL_PREFIX + networkHash;
}

/**
 * The error's `name` and nothing else.
 * @param {unknown} err
 * @returns {void}
 */
function logFailure(err) {
	const name = err && typeof (/** @type {any} */ (err).name) === 'string' ? /** @type {any} */ (err).name : 'Error';
	console.error(LOG_PREFIX, name);
}

/**
 * @param {unknown} table
 * @param {unknown} op
 * @returns {boolean}
 */
function isValidNotice(table, op) {
	return (
		typeof table === 'string' &&
		OFFICER_SUBSCRIBED_TABLES.includes(table) &&
		typeof op === 'string' &&
		OFFICER_CHANGE_OPS.includes(op)
	);
}

/**
 * Deliver one notice to this page's listeners for one network. The notice is
 * built once, as a new frozen literal.
 * @param {string} networkHash
 * @param {string} table
 * @param {string} op
 * @returns {void}
 */
function deliverLocal(networkHash, table, op) {
	const state = NETWORKS.get(networkHash);
	if (!state || state.listeners.size === 0) return;
	const notice = Object.freeze({ table, op });
	for (const listener of [...state.listeners]) {
		try {
			listener(notice);
		} catch (err) {
			logFailure(err);
		}
	}
}

/**
 * Subscribe to change notices for one network.
 *
 * @param {string} networkHash
 * @param {(notice: Readonly<OfficerChangeNotice>) => void} listener
 * @returns {() => void} an idempotent release
 */
export function subscribeToOfficerChanges(networkHash, listener) {
	if (typeof networkHash !== 'string' || networkHash.length === 0) {
		throw new TypeError('subscribeToOfficerChanges: networkHash must be a non-empty string');
	}
	if (typeof listener !== 'function') {
		throw new TypeError('subscribeToOfficerChanges: listener must be a function');
	}

	let state = NETWORKS.get(networkHash);
	if (!state) {
		state = { listeners: new Set(), channel: null };
		NETWORKS.set(networkHash, state);
	}

	if (state.channel === null && state.listeners.size === 0 && typeof BroadcastChannel !== 'undefined') {
		try {
			const channel = new BroadcastChannel(officerChangeChannelName(networkHash));
			channel.onmessage = (/** @type {any} */ event) => {
				const data = event?.data;
				if (!data || typeof data !== 'object' || data.kind !== CHANGE_MESSAGE_KIND) return;
				const table = typeof data.table === 'string' ? data.table : '';
				const op = typeof data.op === 'string' ? data.op : '';
				if (!isValidNotice(table, op)) return;
				deliverLocal(networkHash, table, op);
			};
			// No `unref`: see the public seam's measured note. A Node test
			// that hangs here has leaked a subscription, which the release
			// below exists to make visible.
			state.channel = channel;
		} catch (err) {
			logFailure(err);
			state.channel = null;
		}
	}

	state.listeners.add(listener);

	const owned = state;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		owned.listeners.delete(listener);
		if (owned.listeners.size > 0) return;
		const channel = owned.channel;
		owned.channel = null;
		if (channel) {
			try {
				channel.onmessage = null;
				channel.close();
			} catch (err) {
				logFailure(err);
			}
		}
		if (NETWORKS.get(networkHash) === owned) NETWORKS.delete(networkHash);
	};
}

/**
 * Report that a pass changed `table` with `op` on one network. Delivers once
 * to this page's listeners for that network and posts once to the network's
 * channel for other tabs. Callers notify once per (table, op) per pass, not
 * per row.
 *
 * NEVER THROWS. Returns false and delivers nothing for a falsy `db`, an
 * invalid network hash, a table outside `OFFICER_SUBSCRIBED_TABLES` or an op
 * outside `OFFICER_CHANGE_OPS`. `db` is not otherwise read: a notice never
 * reads rows.
 *
 * @param {unknown} db the handle the pass wrote to
 * @param {string} networkHash
 * @param {string} table
 * @param {string} op
 * @returns {boolean} true iff a notice was delivered and posted
 */
export function notifyOfficerPeerWrite(db, networkHash, table, op) {
	try {
		if (!db) return false;
		if (typeof networkHash !== 'string' || networkHash.length === 0) return false;
		if (!isValidNotice(table, op)) return false;

		// Exactly three keys, never enriched.
		const message = { kind: CHANGE_MESSAGE_KIND, table, op };

		deliverLocal(networkHash, table, op);

		if (typeof BroadcastChannel !== 'undefined') {
			const state = NETWORKS.get(networkHash);
			if (state && state.channel) {
				// A BroadcastChannel does not deliver to its own poster, so this
				// page's listeners get exactly the one local delivery above.
				try {
					state.channel.postMessage(message);
				} catch (err) {
					logFailure(err);
				}
			} else {
				/** @type {any} */
				let channel = null;
				try {
					channel = new BroadcastChannel(officerChangeChannelName(networkHash));
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
		}

		return true;
	} catch (err) {
		logFailure(err);
		return false;
	}
}
