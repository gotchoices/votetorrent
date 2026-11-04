/**
 * forget-network.js -- the ONE destructive path for a network's local copy.
 *
 * Two entry points share one teardown:
 *   - `forgetNetwork`: the officer chose to forget a network (typed
 *     confirmation against the entry's `authorityName`).
 *   - `wipeNetwork`: the network told this browser it is no longer a member
 *     (a revocation row, a pairing key that stopped verifying, or the owner
 *     removed the machine). No confirmation: the officer already lost access.
 *
 * THE ORDERING IS THE MITIGATION, stated in full. Everything runs inside the
 * per-network lifecycle lock (`lifecycleLockName(hash)`), so a boot cannot
 * open the store while it is being deleted and two teardowns of one network
 * never run in parallel:
 *
 *   1. Post `{ kind: 'network-closing', reason }` once on the network's
 *      lifecycle channel. Every other tab of this origin tears its boot down
 *      on it; a follower aborts its queued promotion so it never re-opens
 *      what is about to be deleted.
 *   2. Stop every runtime registered for the network in this tab (the
 *      running boot: replication, strand reader, member node, store handle).
 *   3. Wait for the network's node lock (`nodeLockName(hash)`) to be free and
 *      HOLD it until step 9 is done, so no tab can start a member node in the
 *      middle of the delete. The wait is bounded (`OTHER_TAB_RELEASE_WAIT_MS`);
 *      a tab that never lets go is `NetworkInUseError` before anything is
 *      deleted.
 *   4. Delete the local store (`deleteNetworkDbSettled`: the passed handle is
 *      closed first; a blocked delete is a rejection, never a resolve).
 *   5. Delete the member node's storage (every `vt-member-...` database of
 *      THIS network, settled against `indexedDB.databases()`). Idempotent
 *      against cadre-core's own control-scope destroy after a removal.
 *   6. Delete this network's device keys (the origin wrap key and other
 *      networks' keys stay).
 *   7. `clearRowCounts` -- the legacy snapshot row-count key, cleared
 *      explicitly so the obligation stays local to this file and greppable.
 *   8. `removeNetwork` -- LAST.
 *   9. Confirm with `assertNetworkForgotten`; a store or member database that
 *      came back as an empty shell is deleted once more and checked again.
 *
 * DATA BEFORE REGISTRY, AND WHY: if the registry entry went first and a delete
 * then failed, the result would be an unlisted database still on disk -- a
 * network the officer believes is gone, with no UI left to try again from.
 * With this ordering a failed delete leaves the network listed and retryable,
 * and the next boot re-detects a revocation or a removal. Any failure in steps
 * 3-7 propagates; no exception handler turns it into a success shape.
 *
 * `onblocked` IS A FAILURE, NEVER A RESOLVE. `deleteNetworkDb` rejects
 * `DeleteBlockedError` on a blocked delete, and this module inherits that
 * posture rather than re-deciding it.
 *
 * THE HONEST LIMIT: nothing here expires on its own. A browser that is never
 * told to forget a network, and is never unpaired by it, keeps that network's
 * whole local copy, registrant PII included.
 *
 * THE REAL-BROWSER RESURRECTION RACE (50-17). In a genuine browser an
 * un-awaited background write left over from the read that produced the store
 * handle (a query-planner statistics write) can re-create an EMPTY shell of a
 * just-deleted database moments after the delete reported success: the store
 * plugin reopens a database by name on access, and an open with no version
 * creates it. `fake-indexeddb` cannot reproduce it. 50-17 Task 2 tested and
 * refuted the competing explanation (a probe that itself created the database):
 * with the probe made non-creating, five consecutive retry-disabled runs still
 * showed the shell, carrying exactly `__catalog__` and `__stats__`. The settle
 * loop below converged after exactly 2 rounds on every measured run. The full
 * experiment log is in
 * `.planning/phases/50-authority-web-dashboard-separate-web-project/50-17-SUMMARY.md`.
 *
 * The settle loops call the sanctioned delete primitives, possibly more than
 * once, and verify against the SAME `indexedDB.databases()` truth that
 * `assertNetworkForgotten` trusts. Between rounds they yield through a
 * `MessageChannel` round trip -- a real macrotask, like the background write
 * they are waiting out, but not a timer: this file holds itself to a no-timer
 * discipline. Bounded at `DELETE_SETTLE_MAX_ROUNDS`; a failure to converge is
 * `DeleteBlockedError`, the same name the first-attempt failure uses.
 *
 * THE PEER LAYER IS REACHED LAZILY. `DashboardShell.tsx` imports this file
 * statically, so a static import of the member node's modules would pull the
 * whole peer stack into the entry chunk. They are reached only through
 * `import()`, and each collaborator can be replaced through `deps`.
 *
 * Logging: a fixed prefix plus an error's name, nothing else.
 */

import {
	deleteNetworkDb,
	dbNameFor,
	clearRowCounts,
	readRowCountsRecord,
	findNetwork,
	removeNetwork,
	listNetworks,
	rowCountsKeyFor,
} from '@votetorrent/web-data/officer';
import { UNPAIRED_REASONS } from '../live/status.js';

/** The fixed prefix of every log line this module writes. */
const LOG_PREFIX = 'lifecycle/forget-network:';

/** Prefix of the Web Lock that only the tab running a network's member node holds. */
export const NODE_LOCK_PREFIX = 'vt-dashboard-node-';
/** Prefix of the Web Lock around a network's store open and its teardown. */
export const LIFECYCLE_LOCK_PREFIX = 'vt-dashboard-lifecycle-';
/** Prefix of the BroadcastChannel that tells other tabs a network is closing. */
export const LIFECYCLE_CHANNEL_PREFIX = 'vt-dashboard-lifecycle-';
/** The only message kind the lifecycle channel carries. */
export const NETWORK_CLOSING_KIND = 'network-closing';
/** Every reason a network can close for. */
export const CLOSING_REASONS = Object.freeze(['forgotten', 'key-invalid', 'removed', 'revoked']);
/** How long a teardown waits for another tab to let go of the network's node. */
export const OTHER_TAB_RELEASE_WAIT_MS = 15_000;

/** How many delete-then-settle rounds a settle loop runs before reporting `DeleteBlockedError`. */
const DELETE_SETTLE_MAX_ROUNDS = 8;
/** How many macrotask round trips to wait, per round, before re-checking. */
const DELETE_SETTLE_YIELDS_PER_ROUND = 40;
/** The name prefix of the member node's databases (kept in step with `peer/member-node.js`). */
const MEMBER_DB_NAME_PREFIX = 'vt-member-';

/**
 * @param {unknown} err
 */
function logFailure(err) {
	const name = err instanceof Error && typeof err.name === 'string' && err.name.length > 0 ? err.name : 'Error';
	console.error(LOG_PREFIX, name);
}

/**
 * @param {unknown} networkHash
 * @param {string} label
 * @returns {string}
 */
function requireHash(networkHash, label) {
	if (typeof networkHash !== 'string' || networkHash.length === 0) {
		throw new TypeError(`${label}: the network hash must be a non-empty string`);
	}
	return networkHash;
}

/** @param {string} networkHash */
export function nodeLockName(networkHash) {
	return NODE_LOCK_PREFIX + requireHash(networkHash, 'nodeLockName');
}

/** @param {string} networkHash */
export function lifecycleLockName(networkHash) {
	return LIFECYCLE_LOCK_PREFIX + requireHash(networkHash, 'lifecycleLockName');
}

/** @param {string} networkHash */
export function lifecycleChannelName(networkHash) {
	return LIFECYCLE_CHANNEL_PREFIX + requireHash(networkHash, 'lifecycleChannelName');
}

// ── Errors ──────────────────────────────────────────────────────────────────

/** The officer typed a confirmation that does not match the network's
 * `authorityName`. Never carries either value. */
export class ForgetConfirmationMismatchError extends Error {
	constructor() {
		super("forgetNetwork: typed confirmation does not match this network's authorityName");
		this.name = 'ForgetConfirmationMismatchError';
	}
}

/** `forgetNetwork` was asked to forget a hash the registry has no entry for. */
export class UnknownNetworkError extends Error {
	/** @param {string} networkHash */
	constructor(networkHash) {
		super(`forgetNetwork: no registry entry for network "${networkHash}"`);
		this.name = 'UnknownNetworkError';
		this.networkHash = networkHash;
	}
}

/**
 * @typedef {'IndexedDB database' | 'member storage' | 'device key' | 'registry entry' | 'row-count record'} Survivor
 */

/** `assertNetworkForgotten` found one of the network's artefacts still present. */
export class NetworkStillPresentError extends Error {
	/** @param {Survivor} survivor */
	constructor(survivor) {
		super(`assertNetworkForgotten: the ${survivor} for this network is still present`);
		this.name = 'NetworkStillPresentError';
		/** @type {Survivor} */
		this.survivor = survivor;
	}
}

/** Another tab kept the network's member node past `OTHER_TAB_RELEASE_WAIT_MS`. Nothing was deleted. */
export class NetworkInUseError extends Error {
	constructor() {
		super('forgetNetwork: another tab is still running this network');
		this.name = 'NetworkInUseError';
		/** @type {'other-tab'} */
		this.subject = 'other-tab';
	}
}

/** @returns {Error} */
function deleteBlockedError() {
	const err = new Error('forget-network: a database of this network is still listed after the settle rounds');
	err.name = 'DeleteBlockedError';
	return err;
}

// ── Locks ───────────────────────────────────────────────────────────────────

/**
 * The subset of the Web Locks API this app uses (exclusive mode only).
 *
 * @typedef {object} LockManagerLike
 * @property {(name: string, optionsOrCallback: any, callback?: (lock: { name: string, mode: string } | null) => any) => Promise<any>} request
 * @property {() => Promise<{ held?: Array<{ name?: string, mode?: string }>, pending?: Array<{ name?: string, mode?: string }> }>} [query]
 */

/**
 * @typedef {object} InTabLockManager
 * @property {LockManagerLike['request']} request
 * @property {() => Promise<{ held: Array<{ name: string, mode: string }>, pending: Array<{ name: string, mode: string }> }>} query
 */

/** @returns {Error} */
function abortError() {
	if (typeof DOMException === 'function') return new DOMException('The lock request was aborted.', 'AbortError');
	const err = new Error('The lock request was aborted.');
	err.name = 'AbortError';
	return err;
}

/**
 * An in-tab lock manager: a small Web Locks subset (exclusive mode, FIFO per
 * name, `ifAvailable`, `signal`, `query()`). The fallback when
 * `navigator.locks` is absent (Node, old browsers), and the way tests
 * simulate several tabs sharing one origin.
 *
 * @returns {InTabLockManager}
 */
export function createInTabLockManager() {
	/**
	 * @typedef {{ cb: (lock: any) => any, resolve: (v: any) => void, reject: (e: unknown) => void, signal?: AbortSignal, onAbort: (() => void) | null }} Pending
	 * @typedef {{ held: { name: string, mode: string } | null, queue: Pending[] }} NameState
	 */
	/** @type {Map<string, NameState>} */
	const states = new Map();

	/** @param {string} name */
	function stateOf(name) {
		let state = states.get(name);
		if (!state) {
			state = { held: null, queue: [] };
			states.set(name, state);
		}
		return state;
	}

	/** @param {string} name */
	function pump(name) {
		const state = states.get(name);
		if (!state) return;
		if (state.held === null && state.queue.length === 0) {
			states.delete(name);
			return;
		}
		if (state.held !== null) return;
		const next = /** @type {Pending} */ (state.queue.shift());
		if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort);
		const lock = Object.freeze({ name, mode: 'exclusive' });
		state.held = lock;
		Promise.resolve()
			.then(() => next.cb(lock))
			.then(
				(value) => {
					state.held = null;
					next.resolve(value);
					pump(name);
				},
				(err) => {
					state.held = null;
					next.reject(err);
					pump(name);
				},
			);
	}

	return {
		request(name, optionsOrCallback, callback) {
			const options = typeof optionsOrCallback === 'function' ? {} : (optionsOrCallback ?? {});
			const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
			if (typeof name !== 'string' || typeof cb !== 'function') {
				return Promise.reject(new TypeError('locks.request: a name and a callback are required'));
			}
			return new Promise((resolve, reject) => {
				/** @type {AbortSignal | undefined} */
				const signal = options.signal;
				if (signal?.aborted) {
					reject(abortError());
					return;
				}
				const state = stateOf(name);
				if (options.ifAvailable === true && (state.held !== null || state.queue.length > 0)) {
					Promise.resolve()
						.then(() => cb(null))
						.then(resolve, reject);
					return;
				}
				/** @type {Pending} */
				const pending = { cb, resolve, reject, signal, onAbort: null };
				if (signal) {
					pending.onAbort = () => {
						const current = states.get(name);
						const index = current ? current.queue.indexOf(pending) : -1;
						if (index === -1 || !current) return;
						current.queue.splice(index, 1);
						reject(abortError());
						pump(name);
					};
					signal.addEventListener('abort', pending.onAbort, { once: true });
				}
				state.queue.push(pending);
				pump(name);
			});
		},

		async query() {
			/** @type {Array<{ name: string, mode: string }>} */
			const held = [];
			/** @type {Array<{ name: string, mode: string }>} */
			const pending = [];
			for (const [name, state] of states) {
				if (state.held) held.push({ name, mode: 'exclusive' });
				for (let i = 0; i < state.queue.length; i += 1) pending.push({ name, mode: 'exclusive' });
			}
			return { held, pending };
		},
	};
}

/** The module's fallback lock manager, shared by every caller in this tab. */
const FALLBACK_LOCKS = createInTabLockManager();

/**
 * The lock manager to use: the injected one, else the browser's, else this
 * module's in-tab fallback (shared with `peer/boot.js`).
 *
 * @param {LockManagerLike | undefined | null} [locks]
 * @returns {LockManagerLike}
 */
export function resolveLockManager(locks) {
	if (locks) return locks;
	const native = /** @type {any} */ (globalThis).navigator?.locks;
	if (native && typeof native.request === 'function') return native;
	return FALLBACK_LOCKS;
}

/**
 * Run `task` under the network's exclusive lifecycle lock. Returns the task's
 * result and propagates its rejection.
 *
 * @template T
 * @param {string} networkHash
 * @param {() => Promise<T> | T} task
 * @param {{ locks?: LockManagerLike | null }} [options]
 * @returns {Promise<T>}
 */
export function withNetworkLifecycleLock(networkHash, task, { locks } = {}) {
	const name = lifecycleLockName(networkHash);
	if (typeof task !== 'function') throw new TypeError('withNetworkLifecycleLock: the task must be a function');
	return resolveLockManager(locks).request(name, { mode: 'exclusive' }, () => task());
}

// ── Tab scope and runtimes ──────────────────────────────────────────────────

/**
 * @typedef {object} NetworkRuntime
 * @property {() => Promise<void> | void} stop
 *
 * @typedef {object} TabScope
 * @property {Map<string, Set<NetworkRuntime>>} runtimes
 * @property {{ boot: any }} active
 */

/** @returns {TabScope} */
export function createTabScope() {
	return { runtimes: new Map(), active: { boot: null } };
}

/** The module's default tab scope (shared with `peer/boot.js`). */
const DEFAULT_TAB_SCOPE = createTabScope();

/**
 * @param {TabScope | undefined | null} [tabScope]
 * @returns {TabScope}
 */
export function resolveTabScope(tabScope) {
	return tabScope ?? DEFAULT_TAB_SCOPE;
}

/**
 * Register something that must stop before a network's data is deleted.
 * Returns an idempotent unregister.
 *
 * @param {string} networkHash
 * @param {NetworkRuntime} runtime
 * @param {{ tabScope?: TabScope | null }} [options]
 * @returns {() => void}
 */
export function registerNetworkRuntime(networkHash, runtime, { tabScope } = {}) {
	requireHash(networkHash, 'registerNetworkRuntime');
	if (!runtime || typeof runtime.stop !== 'function') {
		throw new TypeError('registerNetworkRuntime: the runtime must have a stop function');
	}
	const scope = resolveTabScope(tabScope);
	let set = scope.runtimes.get(networkHash);
	if (!set) {
		set = new Set();
		scope.runtimes.set(networkHash, set);
	}
	set.add(runtime);
	let done = false;
	return () => {
		if (done) return;
		done = true;
		const current = scope.runtimes.get(networkHash);
		if (!current) return;
		current.delete(runtime);
		if (current.size === 0) scope.runtimes.delete(networkHash);
	};
}

// ── Peer-layer collaborators (lazy) ─────────────────────────────────────────

/**
 * @typedef {object} TeardownDeps
 * @property {(networkHash: string) => Promise<void>} [deleteMemberStorage]
 * @property {(networkHash: string, scope: string) => string} [memberStorageDbName]
 * @property {(networkHash: string) => Promise<void>} [deleteDeviceKeys]
 * @property {(networkHash: string) => Promise<string[]>} [listDeviceKeyIds]
 * @property {string} [deviceKeysDbName]
 * @property {any} [BroadcastChannel]
 * @property {LockManagerLike | null} [locks]
 * @property {TabScope | null} [tabScope]
 * @property {(ms: number) => AbortSignal} [timeoutSignal]
 */

function loadMemberNode() {
	return import('../peer/member-node.js');
}

function loadIdbKeyStore() {
	return import('../peer/idb-key-store.js');
}

function loadDeviceKey() {
	return import('../peer/device-key.js');
}

/**
 * @param {TeardownDeps} deps
 * @returns {Promise<(networkHash: string) => Promise<void>>}
 */
async function memberStorageDeleter(deps) {
	if (deps.deleteMemberStorage) return deps.deleteMemberStorage;
	const mod = await loadMemberNode();
	return (networkHash) => mod.deleteMemberStorage(networkHash);
}

/**
 * @param {TeardownDeps} deps
 * @returns {Promise<(networkHash: string, scope: string) => string>}
 */
async function memberNameFn(deps) {
	if (deps.memberStorageDbName) return deps.memberStorageDbName;
	return (await loadMemberNode()).memberStorageDbName;
}

/**
 * @param {TeardownDeps} deps
 * @returns {Promise<(networkHash: string) => Promise<void>>}
 */
async function deviceKeysDeleter(deps) {
	if (deps.deleteDeviceKeys) return deps.deleteDeviceKeys;
	const mod = await loadIdbKeyStore();
	return (networkHash) => mod.deleteDeviceKeys(networkHash);
}

/**
 * @param {TeardownDeps} deps
 * @returns {Promise<(networkHash: string) => Promise<string[]>>}
 */
async function deviceKeyLister(deps) {
	if (deps.listDeviceKeyIds) return deps.listDeviceKeyIds;
	const mod = await loadIdbKeyStore();
	return async (networkHash) => {
		const store = mod.createIdbKeyStore({ networkHash });
		try {
			return await store.list();
		} finally {
			store.close();
		}
	};
}

/**
 * @param {TeardownDeps} deps
 * @returns {Promise<string>}
 */
async function deviceKeysDbNameOf(deps) {
	if (typeof deps.deviceKeysDbName === 'string') return deps.deviceKeysDbName;
	return (await loadDeviceKey()).DEVICE_KEYS_DB_NAME;
}

/**
 * A predicate for "this name is one of `networkHash`'s member databases": the
 * name parses as `<prefix><scope>-<8 hex>` and recomputing the name for that
 * scope gives it back exactly, so another network's databases never match.
 *
 * @param {string} networkHash
 * @param {(networkHash: string, scope: string) => string} nameFn
 * @returns {(name: unknown) => boolean}
 */
function memberDbMatcher(networkHash, nameFn) {
	const probe = nameFn(networkHash, '~');
	const prefix = probe.slice(0, probe.length - '~'.length - 1 - 8);
	return (name) => {
		if (typeof name !== 'string' || !name.startsWith(prefix)) return false;
		const match = /^(.+)-[0-9a-f]{8}$/.exec(name.slice(prefix.length));
		if (!match) return false;
		try {
			return nameFn(networkHash, match[1]) === name;
		} catch {
			return false;
		}
	};
}

/** @returns {boolean} */
function canListDatabases() {
	return typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function';
}

/** @returns {Promise<string[]>} */
async function listedDatabaseNames() {
	const infos = await indexedDB.databases();
	/** @type {string[]} */
	const names = [];
	for (const info of infos) {
		if (typeof info.name === 'string') names.push(info.name);
	}
	return names;
}

// ── Settled deletes ─────────────────────────────────────────────────────────

/**
 * Yield once to the task queue through a `MessageChannel` round trip -- a real
 * macrotask, without a timer (see the header).
 *
 * @returns {Promise<void>}
 */
function yieldToTaskQueue() {
	return new Promise((resolve) => {
		const channel = new MessageChannel();
		channel.port2.onmessage = () => {
			channel.port1.close();
			channel.port2.close();
			resolve(undefined);
		};
		channel.port1.postMessage(null);
	});
}

/** @returns {Promise<void>} */
async function settleYields() {
	for (let y = 0; y < DELETE_SETTLE_YIELDS_PER_ROUND; y += 1) {
		// eslint-disable-next-line no-await-in-loop -- deliberately serial, waiting out a real macrotask each time
		await yieldToTaskQueue();
	}
}

/**
 * Call the sanctioned `deleteNetworkDb` primitive, then verify against
 * `indexedDB.databases()` that the store stayed gone, re-deleting (bounded)
 * when an empty shell came back. A rejection from `deleteNetworkDb` itself
 * propagates at once.
 *
 * @param {string} networkHash
 * @param {{ db?: any, storage?: any, timeoutMs?: number }} options
 * @returns {Promise<void>}
 */
async function deleteNetworkDbSettled(networkHash, options) {
	await deleteNetworkDb(networkHash, options);
	if (!canListDatabases()) return;

	// Later rounds never re-pass the handle (it is closed), but keep the
	// storage adapter and the timeout: dropping the adapter cleared the
	// row-count record from `globalThis.localStorage` instead of the caller's.
	const retryOptions = { ...options, db: undefined };
	const name = dbNameFor(networkHash);
	let remaining = await listedDatabaseNames();
	let round = 0;
	while (remaining.includes(name) && round < DELETE_SETTLE_MAX_ROUNDS) {
		await settleYields();
		await deleteNetworkDb(networkHash, retryOptions);
		remaining = await listedDatabaseNames();
		round += 1;
	}
	if (remaining.includes(name)) throw deleteBlockedError();
}

/**
 * Delete every member database of the network, then settle: re-run the delete
 * while `indexedDB.databases()` still lists one of them, bounded.
 * `MemberStorageBusyError` from the delete propagates by name.
 *
 * @param {string} networkHash
 * @param {TeardownDeps} deps
 * @returns {Promise<void>}
 */
async function deleteMemberStorageSettled(networkHash, deps) {
	const remove = await memberStorageDeleter(deps);
	await remove(networkHash);
	if (!canListDatabases()) return;
	const isOurs = memberDbMatcher(networkHash, await memberNameFn(deps));
	let remaining = (await listedDatabaseNames()).filter(isOurs);
	let round = 0;
	while (remaining.length > 0 && round < DELETE_SETTLE_MAX_ROUNDS) {
		await settleYields();
		await remove(networkHash);
		remaining = (await listedDatabaseNames()).filter(isOurs);
		round += 1;
	}
	if (remaining.length > 0) throw deleteBlockedError();
}

// ── The shared teardown ─────────────────────────────────────────────────────

/**
 * The storage handed to the store delete. `deleteNetworkDb` clears the
 * row-count key itself after a confirmed delete; that clear is held back here
 * so it happens at step 7, after the member storage and the device keys, and a
 * failure in steps 5-6 leaves the network exactly as listed as it was. Every
 * other key passes through unchanged.
 *
 * @param {string} networkHash
 * @param {any} storage
 * @returns {any}
 */
function deferRowCountClear(networkHash, storage) {
	const target = storage ?? /** @type {any} */ (globalThis).localStorage;
	if (!target || typeof target.getItem !== 'function') return storage;
	const deferred = rowCountsKeyFor(networkHash);
	return {
		getItem: (/** @type {string} */ key) => target.getItem(key),
		setItem: (/** @type {string} */ key, /** @type {string} */ value) => target.setItem(key, value),
		removeItem: (/** @type {string} */ key) => {
			if (key !== deferred) target.removeItem(key);
		},
	};
}

/**
 * @param {string} networkHash
 * @param {string} reason
 * @param {any} Channel
 */
function postClosing(networkHash, reason, Channel) {
	if (typeof Channel !== 'function') return;
	try {
		const channel = new Channel(lifecycleChannelName(networkHash));
		try {
			channel.postMessage({ kind: NETWORK_CLOSING_KIND, reason });
		} finally {
			channel.close();
		}
	} catch (err) {
		logFailure(err);
	}
}

/**
 * Steps 1-9 of the header. Runs INSIDE the lifecycle lock.
 *
 * @param {string} networkHash
 * @param {{ reason: string, storage?: any, timeoutMs?: number, db?: any, deps?: TeardownDeps }} options
 * @returns {Promise<void>}
 */
async function runNetworkTeardown(networkHash, { reason, storage, timeoutMs, db, deps = {} }) {
	// 1. Tell every other tab.
	postClosing(networkHash, reason, 'BroadcastChannel' in deps ? deps.BroadcastChannel : globalThis.BroadcastChannel);

	// 2. Stop this tab's runtimes for the network.
	const scope = resolveTabScope(deps.tabScope);
	const runtimes = [...(scope.runtimes.get(networkHash) ?? [])];
	for (const runtime of runtimes) {
		try {
			await runtime.stop();
		} catch (err) {
			logFailure(err);
		}
	}
	const leftover = scope.runtimes.get(networkHash);
	if (leftover) {
		for (const runtime of runtimes) leftover.delete(runtime);
		if (leftover.size === 0) scope.runtimes.delete(networkHash);
	}

	// 3. Wait for the node lock and hold it through the deletes.
	const locks = resolveLockManager(deps.locks);
	const makeSignal = deps.timeoutSignal ?? ((/** @type {number} */ ms) => AbortSignal.timeout(ms));
	const signal = makeSignal(OTHER_TAB_RELEASE_WAIT_MS);
	let granted = false;
	const storeStorage = deferRowCountClear(networkHash, storage);
	const deleteOptions = timeoutMs === undefined ? { db, storage: storeStorage } : { db, storage: storeStorage, timeoutMs };
	try {
		await locks.request(nodeLockName(networkHash), { mode: 'exclusive', signal }, async () => {
			granted = true;
			// 4. The local store.
			await deleteNetworkDbSettled(networkHash, deleteOptions);
			// 5. The member node's storage.
			await deleteMemberStorageSettled(networkHash, deps);
			// 6. This network's device keys.
			await (await deviceKeysDeleter(deps))(networkHash);
			// 7. The legacy row-count key.
			await clearRowCounts(networkHash, storage);
			// 8. Registry LAST.
			removeNetwork(networkHash, storage);
			// 9. Resurrection-safe confirmation.
			await confirmForgotten(networkHash, storage, deleteOptions, deps);
		});
	} catch (err) {
		if (!granted && signal.aborted) throw new NetworkInUseError();
		throw err;
	}
}

/**
 * @param {string} networkHash
 * @param {any} storage
 * @param {{ db?: any, storage?: any, timeoutMs?: number }} deleteOptions
 * @param {TeardownDeps} deps
 */
async function confirmForgotten(networkHash, storage, deleteOptions, deps) {
	try {
		await assertNetworkForgotten(networkHash, storage, { deps });
		return;
	} catch (err) {
		if (!(err instanceof NetworkStillPresentError)) throw err;
		if (err.survivor === 'IndexedDB database') {
			await deleteNetworkDbSettled(networkHash, { ...deleteOptions, db: undefined });
		} else if (err.survivor === 'member storage') {
			await deleteMemberStorageSettled(networkHash, deps);
		} else {
			throw err;
		}
	}
	await assertNetworkForgotten(networkHash, storage, { deps });
}

// ── Entry points ────────────────────────────────────────────────────────────

/**
 * @typedef {object} ForgetNetworkOptions
 * @property {string} networkHash
 * @property {string} typedConfirmation
 * @property {import('@quereus/quereus').Database} [db] - an already-open handle, closed first
 * @property {import('@votetorrent/web-data/officer').StorageAdapter} [storage]
 * @property {number} [timeoutMs] - forwarded to `deleteNetworkDb`'s blocked-delete timeout
 * @property {TeardownDeps} [deps]
 */

/**
 * Forget one network on the officer's request: the store, the member storage,
 * the device keys, the row-count record and the registry entry, in that order
 * (see the header). Returns the registry's remaining entries.
 *
 * @param {ForgetNetworkOptions} options
 * @returns {Promise<{ networkHash: string, remaining: import('@votetorrent/web-data/officer').NetworkRegistryEntry[] }>}
 */
export async function forgetNetwork(options) {
	const { networkHash, typedConfirmation, db, storage, timeoutMs, deps = {} } = options;
	requireHash(networkHash, 'forgetNetwork');

	return withNetworkLifecycleLock(
		networkHash,
		async () => {
			// Registry lookup: the UI never offers "forget" for a network it does not list.
			const entry = findNetwork(networkHash, storage);
			if (!entry) {
				throw new UnknownNetworkError(networkHash);
			}

			// Typed confirmation, trimmed, exact case-sensitive equality against the entry's
			// OWN authorityName. An EMPTY expected value confirms nothing: the registry accepts
			// '' and `'' !== ''` is false, so an empty input used to pass. The refusal lives
			// here, in the function that deletes, not only in the component.
			const expected = entry.authorityName.trim();
			if (expected.length === 0) {
				throw new ForgetConfirmationMismatchError();
			}
			const typed = String(typedConfirmation ?? '').trim();
			if (typed !== expected) {
				throw new ForgetConfirmationMismatchError();
			}

			await runNetworkTeardown(networkHash, { reason: 'forgotten', storage, timeoutMs, db, deps });
			return { networkHash, remaining: listNetworks(storage) };
		},
		{ locks: deps.locks },
	);
}

/**
 * @typedef {object} WipeNetworkOptions
 * @property {string} networkHash
 * @property {'revoked' | 'removed' | 'key-invalid'} reason
 * @property {import('@votetorrent/web-data/officer').StorageAdapter} [storage]
 * @property {number} [timeoutMs]
 * @property {TeardownDeps} [deps]
 */

/**
 * Unpair: the same teardown as `forgetNetwork`, with no confirmation. Runs
 * whether or not the registry entry still exists, so a second wipe (or a wipe
 * after a forget) resolves.
 *
 * @param {WipeNetworkOptions} options
 * @returns {Promise<{ networkHash: string, remaining: import('@votetorrent/web-data/officer').NetworkRegistryEntry[] }>}
 */
export async function wipeNetwork(options) {
	const { networkHash, reason, storage, timeoutMs, deps = {} } = options ?? /** @type {any} */ ({});
	requireHash(networkHash, 'wipeNetwork');
	if (!UNPAIRED_REASONS.includes(/** @type {any} */ (reason))) {
		throw new TypeError('wipeNetwork: unknown reason');
	}
	return withNetworkLifecycleLock(
		networkHash,
		async () => {
			await runNetworkTeardown(networkHash, { reason, storage, timeoutMs, deps });
			return { networkHash, remaining: listNetworks(storage) };
		},
		{ locks: deps.locks },
	);
}

/**
 * The mechanically checkable definition of "gone": no store, no member
 * storage, no device key, no registry entry, no row-count record, checked in
 * that order. Throws `NetworkStillPresentError` naming the first survivor.
 * The device-key database is never opened when `indexedDB.databases()` does
 * not list it (opening would create it).
 *
 * @param {string} networkHash
 * @param {import('@votetorrent/web-data/officer').StorageAdapter} [storage]
 * @param {{ deps?: TeardownDeps }} [options]
 * @returns {Promise<void>}
 */
export async function assertNetworkForgotten(networkHash, storage, { deps = {} } = {}) {
	// `indexedDB.databases()` absence is non-fatal: some older browsers and test
	// doubles lack it, and the database checks are skipped there.
	if (canListDatabases()) {
		const names = await listedDatabaseNames();
		if (names.includes(dbNameFor(networkHash))) {
			throw new NetworkStillPresentError('IndexedDB database');
		}
		if (deps.memberStorageDbName || names.some((name) => name.startsWith(MEMBER_DB_NAME_PREFIX))) {
			const isOurs = memberDbMatcher(networkHash, await memberNameFn(deps));
			if (names.some(isOurs)) {
				throw new NetworkStillPresentError('member storage');
			}
		}
		const keysDb = await deviceKeysDbNameOf(deps);
		if (names.includes(keysDb)) {
			const ids = await (await deviceKeyLister(deps))(networkHash);
			if (ids.length > 0) {
				throw new NetworkStillPresentError('device key');
			}
		}
	}

	if (findNetwork(networkHash, storage)) {
		throw new NetworkStillPresentError('registry entry');
	}

	if (await readRowCountsRecord(networkHash, storage)) {
		throw new NetworkStillPresentError('row-count record');
	}
}
