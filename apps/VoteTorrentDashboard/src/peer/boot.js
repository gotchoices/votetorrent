/**
 * boot.js -- the live dashboard's one runtime composition, used by the app and by the gates.
 *
 * WHAT IT DOES, IN ORDER, AND WHY.
 *  1. The local copy opens FIRST, inside the network's lifecycle lock, and the boot is handed back
 *     with `db` set before any network step. The panels render the officer's last replicated rows
 *     at once, online or not. The status is reset with the registry's persisted `lastPassAt`, so an
 *     offline reload shows when the copy was last brought up to date.
 *  2. The member node runs in ONE tab per network. A tab first asks for the network's node lock
 *     (`vt-dashboard-node-<hash>`) without waiting; the tab that gets it is the leader, every other
 *     tab is a follower that reads the same local copy, re-reads on the leader's row-less change
 *     notices, and queues for the lock so it takes over when the leader closes. Two tabs never run
 *     one identity (two reservations on one relay, two writers to one raw store).
 *  3. The leader brings the node up through `resume()`, never a plain start: a start without the
 *     saved `'joined'` origin means "founded" to cadre-core and would run owner genesis, seating
 *     this browser as a founder. A pairing that just finished hands over its running node and
 *     strand reader instead (`adopt`), and those steps are skipped.
 *  4. The strand reader and the replication start with the officer tables, the strand's network
 *     name and the strand node (not the identity node). The replication runs no pass at start, so
 *     the boot wakes it once.
 *  5. Every node and pass event feeds the status reducer. The data version moves only when a pass
 *     changed rows (an empty table list would read as "everything" downstream).
 *  6. After every completed pass the pairing is checked against the LOCAL copy the pass has just
 *     brought up to date. A revocation unpairs at once; a key that stops verifying unpairs only when
 *     two passes in a row agree (a transiently empty read must not wipe a working browser); a check
 *     that could not read anything never unpairs. The check never awaits `whenIdle()` (it runs
 *     inside the pass loop) and never awaits the wipe: the wipe runs outside the pass and stops this
 *     boot through its registered runtime.
 *  7. When the relay or the strand is unreachable the boot stays on the local copy and retries the
 *     missing step, or reconnects and wakes the replication, every `BACKGROUND_RETRY_MS`.
 *  8. One live network per tab: a new boot awaits the previous boot's stop (which stops its
 *     replication first) before it opens its store or resets the status. The reducer cannot tell
 *     one network's pass from another's, so this ordering is what keeps a "Live" from carrying
 *     over. A stopped boot emits nothing.
 *
 * The boot never throws and never rejects: every failure is a closed `failure` value or a logged
 * error name. Every collaborator can be replaced through `deps` (the gates' fake peer layer).
 *
 * Logging: a fixed prefix plus an error's name. No code, row value or message text.
 */

import { initialStatus, reduceStatus, viewStatus, BACKGROUND_RETRY_MS, UNPAIRED_REASONS } from '../live/status.js';
import {
	withNetworkLifecycleLock,
	registerNetworkRuntime,
	resolveLockManager,
	resolveTabScope,
	nodeLockName,
	lifecycleChannelName,
	NETWORK_CLOSING_KIND,
	wipeNetwork as realWipeNetwork,
} from '../lifecycle/forget-network.js';
import {
	attachLiveDb as realAttachLiveDb,
	closeNetworkDb as realCloseNetworkDb,
	findNetwork as realFindNetwork,
	isLegacyEntry as realIsLegacyEntry,
	recordLastPassAt as realRecordLastPassAt,
	subscribeToOfficerChanges as realSubscribeToOfficerChanges,
} from '@votetorrent/web-data/officer';
import { createMemberNode as realCreateMemberNode } from './member-node.js';
import { createIdbKeyStore as realCreateIdbKeyStore } from './idb-key-store.js';
import { openOfficerStrandReader as realOpenStrandReader } from './strand-read.js';
import { startOfficerReplication as realStartOfficerReplication, OFFICER_REPLICATION_TABLES } from './reactivity-bridge.js';
import { checkPairingStillValid as realCheckPairingStillValid } from './pairing.js';

/** The fixed prefix of every log line this module writes. */
const LOG_PREFIX = 'peer/boot:';

/** Every closed reason a boot can fail with. */
export const BOOT_FAILURES = Object.freeze([
	'invalid-network',
	'unknown-network',
	'legacy',
	'absent',
	'not-initialized',
	'no-storage',
	'open-failed',
	'not-paired',
]);
/** How often the status view is re-evaluated (and strand peers polled). */
export const STATUS_TICK_MS = 1_000;
/** The shortest gap between two persisted `lastPassAt` writes. */
export const LAST_PASS_PERSIST_MS = 60_000;
/** How many consecutive completed passes must find the pairing key invalid before unpairing. */
export const KEY_INVALID_CONFIRM_PASSES = 2;

/** @param {unknown} err */
function logFailure(err) {
	const name = err instanceof Error && typeof err.name === 'string' && err.name.length > 0 ? err.name : 'Error';
	console.error(LOG_PREFIX, name);
}

/** @param {unknown} err */
function isAbort(err) {
	return err instanceof Error && err.name === 'AbortError';
}

/**
 * A Set whose content cannot change: its mutators throw.
 *
 * @param {Iterable<string>} names
 * @returns {ReadonlySet<string>}
 */
function frozenTableSet(names) {
	const set = new Set(names);
	const refuse = () => {
		throw new TypeError('changedTables is read-only');
	};
	Object.defineProperties(set, { add: { value: refuse }, delete: { value: refuse }, clear: { value: refuse } });
	return Object.freeze(set);
}

const NO_TABLES = frozenTableSet([]);
const INITIAL_DATA_VERSION = Object.freeze({ version: 0, changedTables: NO_TABLES, markEligible: false });

/**
 * @typedef {'invalid-network'|'unknown-network'|'legacy'|'absent'|'not-initialized'|'no-storage'|'open-failed'|'not-paired'} BootFailure
 *
 * @typedef {object} DataVersionValue
 * @property {number} version
 * @property {ReadonlySet<string>} changedTables
 * @property {boolean} markEligible
 *
 * @typedef {object} DashboardBoot
 * @property {string} networkHash
 * @property {any} db the local store handle (the panels' only handle); null when the store never opened
 * @property {BootFailure | null} failure
 * @property {'leader' | 'follower'} role
 * @property {() => import('../live/status.js').StatusView} getStatus
 * @property {(listener: (view: import('../live/status.js').StatusView) => void) => () => void} subscribeStatus
 * @property {() => DataVersionValue} getDataVersion
 * @property {(listener: (value: DataVersionValue) => void) => () => void} subscribeData
 * @property {() => Promise<void>} reconnect
 * @property {() => Promise<void>} stop
 * @property {() => Promise<void>} whenIdle
 * @property {(cb: (reason: 'revoked' | 'removed' | 'key-invalid') => void) => () => void} onUnpaired
 * @property {(cb: () => void) => () => void} onForgotten
 *
 * @typedef {object} BootDeps
 * @property {typeof realAttachLiveDb} [attachLiveDb]
 * @property {typeof realCloseNetworkDb} [closeNetworkDb]
 * @property {typeof realFindNetwork} [findNetwork]
 * @property {typeof realIsLegacyEntry} [isLegacyEntry]
 * @property {typeof realRecordLastPassAt} [recordLastPassAt]
 * @property {typeof realSubscribeToOfficerChanges} [subscribeToOfficerChanges]
 * @property {(options: any) => Promise<any>} [createMemberNode]
 * @property {(options: { networkHash: string }) => any} [createIdbKeyStore]
 * @property {(options: { memberNode: any, strandId: string, signal?: AbortSignal }) => Promise<any>} [openStrandReader]
 * @property {(options: any) => { stop: () => Promise<void>, whenIdle: () => Promise<void>, wake: () => void }} [startOfficerReplication]
 * @property {(options: { db: any, networkHash: string, entry: any }) => Promise<{ ok: true } | { ok: false, reason: 'revoked' | 'key-invalid' }>} [checkPairingStillValid]
 * @property {(options: any) => Promise<any>} [wipeNetwork]
 * @property {Record<string, any>} [wipeDeps] extra `deps` for the wipe (merged over the boot's locks, tab scope and channel)
 * @property {any} [storage]
 * @property {any} [locks]
 * @property {any} [BroadcastChannel]
 * @property {import('../lifecycle/forget-network.js').TabScope} [tabScope]
 * @property {() => number} [now]
 * @property {(fn: () => void, ms: number) => any} [setInterval]
 * @property {(handle: any) => void} [clearInterval]
 */

/**
 * @param {BootDeps} deps
 */
function resolveDeps(deps) {
	return {
		attachLiveDb: deps.attachLiveDb ?? realAttachLiveDb,
		closeNetworkDb: deps.closeNetworkDb ?? realCloseNetworkDb,
		findNetwork: deps.findNetwork ?? realFindNetwork,
		isLegacyEntry: deps.isLegacyEntry ?? realIsLegacyEntry,
		recordLastPassAt: deps.recordLastPassAt ?? realRecordLastPassAt,
		subscribeToOfficerChanges: deps.subscribeToOfficerChanges ?? realSubscribeToOfficerChanges,
		createMemberNode: deps.createMemberNode ?? realCreateMemberNode,
		createIdbKeyStore: deps.createIdbKeyStore ?? realCreateIdbKeyStore,
		openStrandReader: deps.openStrandReader ?? realOpenStrandReader,
		startOfficerReplication: deps.startOfficerReplication ?? realStartOfficerReplication,
		checkPairingStillValid: deps.checkPairingStillValid ?? realCheckPairingStillValid,
		wipeNetwork: deps.wipeNetwork ?? realWipeNetwork,
		wipeDeps: deps.wipeDeps ?? {},
		storage: deps.storage,
		locks: resolveLockManager(deps.locks),
		BroadcastChannel: 'BroadcastChannel' in deps ? deps.BroadcastChannel : globalThis.BroadcastChannel,
		tabScope: resolveTabScope(deps.tabScope),
		now: deps.now ?? Date.now,
		setInterval: deps.setInterval ?? ((/** @type {() => void} */ fn, /** @type {number} */ ms) => globalThis.setInterval(fn, ms)),
		clearInterval: deps.clearInterval ?? ((/** @type {any} */ handle) => globalThis.clearInterval(handle)),
	};
}

/**
 * Map an open error to its closed failure.
 *
 * @param {unknown} err
 * @returns {BootFailure}
 */
function openFailure(err) {
	const e = /** @type {any} */ (err);
	if (e && e.name === 'LiveStoreMissingError' && (e.reason === 'absent' || e.reason === 'not-initialized')) return e.reason;
	if (e && e.name === 'LiveStoreUnavailableError') return 'no-storage';
	return 'open-failed';
}

/**
 * @typedef {object} StartDashboardBootOptions
 * @property {string} networkHash
 * @property {{ memberNode: any, strandReader: any } | null} [adopt] the pairing handoff
 * @property {BootDeps} [deps]
 */

/**
 * Start the live dashboard for one network. Resolves once the local copy is open (or the boot
 * failed to open it); the network bring-up continues in the background. Never throws, never
 * rejects.
 *
 * @param {StartDashboardBootOptions} options
 * @returns {Promise<DashboardBoot>}
 */
export async function startDashboardBoot(options) {
	const opts = options && typeof options === 'object' ? options : /** @type {StartDashboardBootOptions} */ ({ networkHash: '' });
	const deps = opts.deps && typeof opts.deps === 'object' ? opts.deps : {};
	let runtime;
	try {
		runtime = createBootRuntime(opts.networkHash, opts.adopt ?? null, resolveDeps(deps));
	} catch (err) {
		logFailure(err);
		const fallback = createBootRuntime('', null, resolveDeps({}));
		fallback.failWith('open-failed');
		return fallback.boot;
	}
	try {
		await runtime.start();
	} catch (err) {
		logFailure(err);
		runtime.failWith('open-failed');
	}
	return runtime.boot;
}

/**
 * Stop `current` (when given), then start a boot for another network. Every
 * `startDashboardBoot` already awaits the tab's previous boot; this is the named form.
 *
 * @param {DashboardBoot | null} current
 * @param {{ networkHash: string, deps?: BootDeps }} options
 * @returns {Promise<DashboardBoot>}
 */
export async function switchDashboardBoot(current, { networkHash, deps } = /** @type {any} */ ({})) {
	if (current) {
		try {
			await current.stop();
		} catch (err) {
			logFailure(err);
		}
	}
	return startDashboardBoot({ networkHash, deps });
}

/**
 * @param {unknown} networkHash
 * @param {{ memberNode: any, strandReader: any } | null} adoptOption
 * @param {ReturnType<typeof resolveDeps>} d
 */
function createBootRuntime(networkHash, adoptOption, d) {
	const hash = typeof networkHash === 'string' ? networkHash : '';
	const scope = d.tabScope;

	let state = initialStatus({ lastPassAt: null });
	let view = viewStatus(state, d.now());
	/** @type {DataVersionValue} */
	let dataVersion = INITIAL_DATA_VERSION;

	/** @type {Set<(view: any) => void>} */
	const statusListeners = new Set();
	/** @type {Set<(value: DataVersionValue) => void>} */
	const dataListeners = new Set();
	/** @type {Set<(reason: any) => void>} */
	const unpairedListeners = new Set();
	/** @type {Set<() => void>} */
	const forgottenListeners = new Set();

	/** @type {any} */
	let db = null;
	/** @type {BootFailure | null} */
	let failure = null;
	/** @type {any} */
	let entry = null;
	/** @type {{ memberNode: any, strandReader: any } | null} the handoff, until it is used or released */
	let handoff = adoptOption && typeof adoptOption === 'object' ? adoptOption : null;
	const adopted = handoff !== null;
	/** @type {any} */
	let memberNode = null;
	/** @type {any} */
	let reader = null;
	/** @type {{ stop: () => Promise<void>, whenIdle: () => Promise<void>, wake: () => void } | null} */
	let replication = null;
	/** @type {Array<() => void>} */
	const nodeListenerOffs = [];

	/** @type {'leader' | 'follower'} */
	let role = 'leader';
	let isLeader = false;
	/** @type {(() => void) | null} resolves the promise that holds the node lock */
	let releaseLock = null;
	/** @type {AbortController | null} */
	let promotionAbort = null;
	/** @type {(() => void) | null} */
	let followerUnsub = null;
	/** @type {any} */
	let channel = null;
	/** @type {(() => void) | null} */
	let unregisterRuntime = null;
	/** @type {any} */
	let statusTimer = null;
	/** @type {any} */
	let retryTimer = null;

	let stopped = false;
	let unpairing = false;
	let closingSeen = false;
	let notPaired = false;
	let resumed = false;
	let bootCheckDone = false;
	let keyInvalidCount = 0;
	/** @type {number | null} */
	let lastPersistAt = null;
	/** @type {number | null} */
	let pendingPersistAt = null;
	/** @type {Promise<void> | null} */
	let ensureFlight = null;
	/** @type {Promise<void> | null} */
	let retryFlight = null;
	/** @type {Promise<void> | null} */
	let reconnectFlight = null;
	/** @type {Promise<void> | null} */
	let teardownPromise = null;
	const bringUpAbort = new AbortController();
	/** @type {Set<Promise<unknown>>} */
	const inflight = new Set();
	/** @type {Set<string>} */
	const pendingNoticeTables = new Set();
	let noticeQueued = false;

	const halted = () => stopped || unpairing;

	/**
	 * @template T
	 * @param {Promise<T>} promise
	 * @returns {Promise<T>}
	 */
	function track(promise) {
		const settled = promise.then(
			() => undefined,
			() => undefined,
		);
		inflight.add(settled);
		settled.then(() => inflight.delete(settled));
		return promise;
	}

	async function settleInflight() {
		while (inflight.size > 0) {
			await Promise.all([...inflight]);
		}
	}

	// ── Status ────────────────────────────────────────────────────────────

	function refreshView() {
		if (stopped) return;
		const next = viewStatus(state, d.now());
		if (
			next.kind === view.kind &&
			next.lastPassAt === view.lastPassAt &&
			next.reconnecting === view.reconnecting &&
			next.reason === view.reason
		) {
			return;
		}
		view = next;
		for (const listener of [...statusListeners]) {
			try {
				listener(view);
			} catch (err) {
				logFailure(err);
			}
		}
	}

	/** @param {{ type: string, [k: string]: unknown }} event */
	function dispatch(event) {
		if (stopped) return;
		try {
			state = reduceStatus(state, event, d.now());
		} catch (err) {
			logFailure(err);
			return;
		}
		refreshView();
	}

	function pollStrandPeers() {
		if (!memberNode || !isLeader) return;
		let count = 0;
		try {
			count = memberNode.strandPeerCount();
		} catch (err) {
			logFailure(err);
		}
		if (count !== state.strandPeers) dispatch({ type: 'strand-peers', count });
	}

	function seedControl() {
		if (!memberNode) return;
		let connected = false;
		try {
			connected = (memberNode.getControlNode()?.getConnections?.()?.length ?? 0) > 0;
		} catch (err) {
			logFailure(err);
		}
		if (connected) dispatch({ type: 'control-connected' });
		else if (state.controlConnected) dispatch({ type: 'control-disconnected' });
	}

	// ── Data ──────────────────────────────────────────────────────────────

	/**
	 * @param {Iterable<string>} tables
	 * @param {boolean} markEligible
	 */
	function bumpData(tables, markEligible) {
		if (stopped) return;
		const changedTables = frozenTableSet(tables);
		if (changedTables.size === 0) return;
		dataVersion = Object.freeze({ version: dataVersion.version + 1, changedTables, markEligible });
		for (const listener of [...dataListeners]) {
			try {
				listener(dataVersion);
			} catch (err) {
				logFailure(err);
			}
		}
	}

	/** @param {any} notice */
	function onOfficerNotice(notice) {
		if (halted() || role !== 'follower') return;
		if (notice && typeof notice.table === 'string') pendingNoticeTables.add(notice.table);
		if (noticeQueued) return;
		noticeQueued = true;
		queueMicrotask(() => {
			noticeQueued = false;
			const tables = [...pendingNoticeTables];
			pendingNoticeTables.clear();
			if (role === 'follower') bumpData(tables, true);
		});
	}

	// ── Passes ────────────────────────────────────────────────────────────

	/** @param {any} event */
	function handlePass(event) {
		if (halted() || !event || typeof event !== 'object') return;
		const doneBefore = state.passDone;
		if (event.type === 'pass-start') {
			pollStrandPeers();
			dispatch({ type: 'pass-start' });
		} else if (event.type === 'pass-complete') {
			dispatch({ type: 'pass-complete', at: event.at });
		} else if (event.type === 'pass-failed') {
			dispatch({ type: 'pass-failed' });
		}
		if (Array.isArray(event.changedTables) && event.changedTables.length > 0) {
			bumpData(event.changedTables, doneBefore);
		}
	}

	function maybePersist() {
		if (pendingPersistAt === null) return;
		if (lastPersistAt !== null && d.now() - lastPersistAt < LAST_PASS_PERSIST_MS) return;
		flushPersist();
	}

	function flushPersist() {
		if (pendingPersistAt === null) return;
		const at = pendingPersistAt;
		pendingPersistAt = null;
		lastPersistAt = d.now();
		try {
			d.recordLastPassAt(hash, at, d.storage);
		} catch (err) {
			logFailure(err);
		}
	}

	/** @param {any} verdict */
	function applyVerdict(verdict) {
		if (halted()) return;
		if (!verdict || verdict.ok === true) {
			keyInvalidCount = 0;
			return;
		}
		if (verdict.reason === 'revoked') {
			beginUnpair('revoked');
		} else if (verdict.reason === 'key-invalid') {
			keyInvalidCount += 1;
			if (keyInvalidCount >= KEY_INVALID_CONFIRM_PASSES) beginUnpair('key-invalid');
		}
	}

	/**
	 * The pairing check on the LOCAL copy. A rejection (the check could not read) is logged and
	 * never unpairs.
	 *
	 * @param {any} current
	 */
	async function checkPairing(current) {
		let verdict;
		try {
			verdict = await d.checkPairingStillValid({ db, networkHash: hash, entry: current });
		} catch (err) {
			logFailure(err);
			return;
		}
		applyVerdict(verdict);
	}

	/**
	 * Runs inside the replication's pass loop after each completed pass. Never awaits
	 * `whenIdle()`, `stop()` or the wipe.
	 *
	 * @param {{ at: number, changedTables: ReadonlyArray<string> }} info
	 */
	async function handleAfterPass(info) {
		if (halted()) return;
		if (info && typeof info.at === 'number' && state.lastPassAt === info.at) {
			pendingPersistAt = info.at;
			maybePersist();
		}
		let current;
		try {
			current = d.findNetwork(hash, d.storage);
		} catch (err) {
			logFailure(err);
			return;
		}
		if (!current) {
			void forgottenTeardown();
			return;
		}
		entry = current;
		await checkPairing(current);
	}

	// ── Unpair and teardown ──────────────────────────────────────────────

	/** @param {'revoked' | 'removed' | 'key-invalid'} reason */
	function beginUnpair(reason) {
		if (unpairing || stopped || !UNPAIRED_REASONS.includes(reason)) return;
		unpairing = true;
		dispatch({ type: 'unpaired', reason });
		void (async () => {
			try {
				await d.wipeNetwork({
					networkHash: hash,
					reason,
					storage: d.storage,
					deps: { locks: d.locks, tabScope: scope, BroadcastChannel: d.BroadcastChannel, ...d.wipeDeps },
				});
			} catch (err) {
				logFailure(err);
			}
			await internalTeardown();
			for (const cb of [...unpairedListeners]) {
				try {
					cb(reason);
				} catch (err) {
					logFailure(err);
				}
			}
		})();
	}

	async function forgottenTeardown() {
		if (stopped || unpairing) return;
		closingSeen = true;
		const listeners = [...forgottenListeners];
		await internalTeardown();
		for (const cb of listeners) {
			try {
				cb();
			} catch (err) {
				logFailure(err);
			}
		}
	}

	/** @param {any} event */
	function handleLifecycleMessage(event) {
		const data = event?.data;
		if (!data || typeof data !== 'object' || data.kind !== NETWORK_CLOSING_KIND) return;
		if (stopped || unpairing) return;
		closingSeen = true;
		promotionAbort?.abort();
		void forgottenTeardown();
	}

	function clearTimers() {
		if (statusTimer !== null) d.clearInterval(statusTimer);
		if (retryTimer !== null) d.clearInterval(retryTimer);
		statusTimer = null;
		retryTimer = null;
	}

	/** Idempotent, fixed order; every leg swallows its own error. */
	function internalTeardown() {
		if (teardownPromise) return teardownPromise;
		teardownPromise = (async () => {
			stopped = true;
			clearTimers();
			bringUpAbort.abort();
			promotionAbort?.abort();
			await settleInflight();
			if (!unpairing) flushPersist();
			for (const off of nodeListenerOffs.splice(0)) {
				try {
					off();
				} catch (err) {
					logFailure(err);
				}
			}
			const unusedHandoff = handoff;
			handoff = null;
			try {
				await replication?.stop();
			} catch (err) {
				logFailure(err);
			}
			for (const r of new Set([reader, unusedHandoff?.strandReader])) {
				if (!r) continue;
				try {
					await r.close();
				} catch (err) {
					logFailure(err);
				}
			}
			for (const node of new Set([memberNode, unusedHandoff?.memberNode])) {
				if (!node) continue;
				try {
					await node.stop();
				} catch (err) {
					logFailure(err);
				}
			}
			if (followerUnsub) {
				try {
					followerUnsub();
				} catch (err) {
					logFailure(err);
				}
				followerUnsub = null;
			}
			releaseLock?.();
			releaseLock = null;
			isLeader = false;
			if (channel) {
				try {
					channel.onmessage = null;
					channel.close();
				} catch (err) {
					logFailure(err);
				}
				channel = null;
			}
			if (db) {
				try {
					await d.closeNetworkDb(db);
				} catch (err) {
					logFailure(err);
				}
			}
			unregisterRuntime?.();
			unregisterRuntime = null;
			if (scope.active.boot === boot) scope.active.boot = null;
		})();
		return teardownPromise;
	}

	// ── Leader bring-up ──────────────────────────────────────────────────

	/** @param {any} node */
	function attachNodeListeners(node) {
		nodeListenerOffs.push(
			node.on('control:connected', () => dispatch({ type: 'control-connected' })),
			node.on('control:disconnected', () => dispatch({ type: 'control-disconnected' })),
			node.on('cadre:removed', () => beginUnpair('removed')),
		);
	}

	function ensureRunning() {
		if (!ensureFlight) {
			ensureFlight = track(ensureRunningOnce()).finally(() => {
				ensureFlight = null;
			});
		}
		return ensureFlight;
	}

	async function ensureRunningOnce() {
		try {
			if (halted() || !isLeader || notPaired) return;
			const pairing = entry?.pairing;
			const strandId = pairing?.strandId;

			// Boot-time check: a browser that was unpaired while closed learns it before any network step.
			if (!handoff && !adopted && !bootCheckDone) {
				bootCheckDone = true;
				if (typeof entry?.lastPassAt === 'number') {
					await checkPairing(entry);
					if (halted()) return;
				}
			}

			if (!memberNode) {
				const node = handoff
					? handoff.memberNode
					: await d.createMemberNode({
							networkHash: hash,
							keyStore: d.createIdbKeyStore({ networkHash: hash }),
							relayAddrs: pairing.relayAddrs,
							strandId,
						});
				memberNode = node;
				if (halted()) return;
				attachNodeListeners(node);
				seedControl();
			}

			if (!handoff && !resumed) {
				const result = await memberNode.resume();
				if (halted()) return;
				if (result === 'removed') {
					beginUnpair('removed');
					return;
				}
				if (result === 'not-paired') {
					notPaired = true;
					failure = 'not-paired';
					return;
				}
				resumed = true;
				seedControl();
			}

			if (!reader) {
				let next;
				if (handoff) {
					next = handoff.strandReader;
				} else {
					await memberNode.waitForStrand(strandId, { signal: bringUpAbort.signal });
					if (halted()) return;
					next = await d.openStrandReader({ memberNode, strandId, signal: bringUpAbort.signal });
				}
				reader = next;
				if (halted()) return;
			}

			if (!replication) {
				replication = d.startOfficerReplication({
					db,
					networkHash: hash,
					strandReader: reader,
					strandNode: memberNode.getStrandNode(),
					networkName: 'strand-' + strandId,
					tables: OFFICER_REPLICATION_TABLES,
					strandPeerId: memberNode.strandPeerId(),
					onPass: handlePass,
					afterPass: handleAfterPass,
				});
				handoff = null;
				pollStrandPeers();
				replication.wake();
			}
		} catch (err) {
			if (!isAbort(err)) logFailure(err);
		}
	}

	function bringUpComplete() {
		return replication !== null;
	}

	/** The retry tick's work, shared with `reconnect()`; single-flight. */
	function runRetryWork(/** @type {boolean} */ force) {
		if (retryFlight) return retryFlight;
		// Not tracked as a whole: a slow reconnect must not hold up a teardown (the bring-up step
		// inside it is tracked by `ensureRunning`).
		retryFlight = (
			(async () => {
				if (halted() || !isLeader || notPaired) return;
				if (!bringUpComplete()) {
					await ensureRunning();
					return;
				}
				if (!force && state.controlConnected && state.strandPeers > 0) return;
				try {
					await memberNode.reconnect();
				} catch (err) {
					logFailure(err);
				}
				if (halted()) return;
				seedControl();
				replication?.wake();
			})()
		).finally(() => {
			retryFlight = null;
		});
		return retryFlight;
	}

	function statusTick() {
		if (stopped) return;
		if (!unpairing) pollStrandPeers();
		refreshView();
	}

	function retryTick() {
		if (halted() || !isLeader || notPaired) return;
		void runRetryWork(false);
	}

	// ── Node lock: leader or follower ────────────────────────────────────

	function becomeLeaderWithLock() {
		isLeader = true;
		return new Promise((resolve) => {
			releaseLock = () => resolve(undefined);
		});
	}

	function becomeFollower() {
		if (halted()) return;
		role = 'follower';
		dispatch({ type: 'follower' });
		const released = handoff;
		handoff = null;
		if (released) {
			void track(
				(async () => {
					try {
						await released.strandReader?.close();
					} catch (err) {
						logFailure(err);
					}
					try {
						await released.memberNode?.stop();
					} catch (err) {
						logFailure(err);
					}
				})(),
			);
		}
		try {
			followerUnsub = d.subscribeToOfficerChanges(hash, onOfficerNotice);
		} catch (err) {
			logFailure(err);
		}
		promotionAbort = new AbortController();
		d.locks
			.request(nodeLockName(hash), { mode: 'exclusive', signal: promotionAbort.signal }, (/** @type {any} */ lock) => {
				if (!lock || halted() || closingSeen) return undefined;
				const held = becomeLeaderWithLock();
				void track(promote());
				return held;
			})
			.catch((/** @type {unknown} */ err) => {
				if (!isAbort(err)) logFailure(err);
			});
	}

	async function promote() {
		if (followerUnsub) {
			try {
				followerUnsub();
			} catch (err) {
				logFailure(err);
			}
			followerUnsub = null;
		}
		role = 'leader';
		dispatch({ type: 'promoted' });
		let current;
		try {
			current = d.findNetwork(hash, d.storage);
		} catch (err) {
			logFailure(err);
		}
		if (!current || closingSeen) {
			void forgottenTeardown();
			return;
		}
		entry = current;
		await ensureRunning();
	}

	async function bringUp() {
		/** @type {Promise<'leader' | 'follower' | 'none'>} */
		const decided = new Promise((decide) => {
			d.locks
				.request(nodeLockName(hash), { mode: 'exclusive', ifAvailable: true }, (/** @type {any} */ lock) => {
					if (lock === null) {
						decide('follower');
						return undefined;
					}
					if (halted() || closingSeen) {
						decide('none');
						return undefined;
					}
					const held = becomeLeaderWithLock();
					decide('leader');
					return held;
				})
				.catch((/** @type {unknown} */ err) => {
					logFailure(err);
					decide('none');
				});
		});
		const decision = await decided;
		if (decision === 'follower') {
			becomeFollower();
			return;
		}
		if (decision === 'leader') await ensureRunning();
	}

	// ── The boot object ──────────────────────────────────────────────────

	/** @type {DashboardBoot} */
	const boot = {
		networkHash: hash,
		get db() {
			return db;
		},
		get failure() {
			return failure;
		},
		get role() {
			return role;
		},
		getStatus() {
			return view;
		},
		subscribeStatus(listener) {
			if (typeof listener !== 'function') throw new TypeError('subscribeStatus: the listener must be a function');
			statusListeners.add(listener);
			return () => {
				statusListeners.delete(listener);
			};
		},
		getDataVersion() {
			return dataVersion;
		},
		subscribeData(listener) {
			if (typeof listener !== 'function') throw new TypeError('subscribeData: the listener must be a function');
			dataListeners.add(listener);
			return () => {
				dataListeners.delete(listener);
			};
		},
		async reconnect() {
			if (halted() || !isLeader || role !== 'leader') return;
			if (reconnectFlight) return reconnectFlight;
			reconnectFlight = (async () => {
				dispatch({ type: 'reconnect-start' });
				try {
					await runRetryWork(true);
				} finally {
					dispatch({ type: 'reconnect-end' });
				}
			})().finally(() => {
				reconnectFlight = null;
			});
			return reconnectFlight;
		},
		async stop() {
			await internalTeardown();
			statusListeners.clear();
			dataListeners.clear();
			forgottenListeners.clear();
			if (!unpairing) unpairedListeners.clear();
		},
		async whenIdle() {
			await settleInflight();
			await replication?.whenIdle();
		},
		onUnpaired(cb) {
			if (typeof cb !== 'function') throw new TypeError('onUnpaired: the callback must be a function');
			unpairedListeners.add(cb);
			return () => {
				unpairedListeners.delete(cb);
			};
		},
		onForgotten(cb) {
			if (typeof cb !== 'function') throw new TypeError('onForgotten: the callback must be a function');
			forgottenListeners.add(cb);
			return () => {
				forgottenListeners.delete(cb);
			};
		},
	};

	/** @param {BootFailure} reason */
	function failWith(reason) {
		failure = reason;
		const opened = db;
		db = null;
		stopped = true;
		clearTimers();
		unregisterRuntime?.();
		unregisterRuntime = null;
		if (opened) {
			Promise.resolve()
				.then(() => d.closeNetworkDb(opened))
				.catch(logFailure);
		}
		if (scope.active.boot === boot) scope.active.boot = null;
	}

	async function start() {
		if (hash.length === 0) {
			failWith('invalid-network');
			return;
		}

		// One live network per tab: the previous boot stops (replication first) before this one
		// opens its store or resets the status.
		const previous = scope.active.boot;
		scope.active.boot = boot;
		if (previous && previous !== boot) {
			try {
				await previous.stop();
			} catch (err) {
				logFailure(err);
			}
		}
		if (stopped) return;

		/** @type {BootFailure | null} */
		const opened = await withNetworkLifecycleLock(
			hash,
			async () => {
				const found = d.findNetwork(hash, d.storage);
				if (!found) return 'unknown-network';
				if (d.isLegacyEntry(found)) return 'legacy';
				entry = found;
				try {
					db = await d.attachLiveDb(hash, { create: false });
				} catch (err) {
					logFailure(err);
					return openFailure(err);
				}
				unregisterRuntime = registerNetworkRuntime(hash, { stop: internalTeardown }, { tabScope: scope });
				return null;
			},
			{ locks: d.locks },
		);
		if (opened !== null) {
			failWith(opened);
			return;
		}
		if (stopped) {
			// Stopped while the store opened: the teardown already ran without this handle.
			const late = db;
			db = null;
			if (late) {
				try {
					await d.closeNetworkDb(late);
				} catch (err) {
					logFailure(err);
				}
			}
			unregisterRuntime?.();
			unregisterRuntime = null;
			return;
		}

		dispatch({ type: 'reset', lastPassAt: adopted ? null : (entry.lastPassAt ?? null) });
		statusTimer = d.setInterval(statusTick, STATUS_TICK_MS);
		retryTimer = d.setInterval(retryTick, BACKGROUND_RETRY_MS);

		if (typeof d.BroadcastChannel === 'function') {
			try {
				channel = new d.BroadcastChannel(lifecycleChannelName(hash));
				channel.onmessage = handleLifecycleMessage;
			} catch (err) {
				logFailure(err);
				channel = null;
			}
		}

		void track(bringUp());
	}

	return { boot, start, failWith };
}
