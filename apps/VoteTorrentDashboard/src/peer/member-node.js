/**
 * member-node.js -- the dashboard's member node: cadre-core's edge node over IndexedDB, one per
 * network, run by an officer's browser that an owner admitted as a device.
 *
 * WHAT IT IS. A member DEVICE of the network's cadre: it holds a persistent identity (the key
 * store `idb-key-store.js` gives it), it is admitted once by a single-use invitation, it claims
 * the network's strand and reads it, and it hears change notifications. It holds no owner key and
 * no officer key, never founds a party, and never serves storage for anyone.
 *
 * WHAT IS DIFFERENT FROM THE PUBLIC PAGE'S `edge-node.js`. That module builds an anonymous,
 * per-tab session reader directly on libp2p. This one is a member with a persistent identity,
 * and cadre-core builds its nodes, so the subscriber-only cohort posture comes from cadre-core's
 * `strandReactivity.edgeHost` option (a VoteTorrent patch of cadre-core) rather than from a
 * `cohortTopic.host` literal written here.
 *
 * WHAT IS COPIED FROM IT (copied, never imported): the fail-closed per-network database names
 * with a short digest against sanitising collisions, the withdrawal of the strand's two storage
 * services so no peer counts this browser into a storage group, and an idempotent stop.
 *
 * REMOVAL CLOSES BEFORE THE WIPE. On `cadre:removed`, cadre-core runs its own removal transition:
 * it shuts the node down (closing the stores), then RE-OPENS the node-local database for the saved
 * start and the dissolve marker, and only then reports `removed` (or `failed`). The stop of a
 * removed node waits for that report (bounded by `REMOVAL_SETTLE_MAX_MS`, a timer that lives only
 * inside `stop()`) and then closes every member-storage handle this tab holds, so the wipe that
 * follows deletes the databases instead of meeting this tab's own open connection.
 *
 * THE FOUR NON-NEGOTIABLES.
 *  1. Never start with any origin but `'joined'`. `startJoined` is the only place that starts the
 *     edge node; a start with no origin means "founded" to cadre-core and would run owner genesis,
 *     seating this browser as a second founder.
 *  2. Never touch an owner key or an owner grant. Owner grants and multi-use invitations are
 *     refused before any network call, and a join that leaves an owner key wired stops the node.
 *  3. Withdraw storage on every strand start, before anyone is told the strand started; a
 *     browser that cannot withdraw is stopped rather than left up as a storage replica.
 *  4. Never fall back to a default database name. Every database is
 *     `memberStorageDbName(networkHash, scope)`.
 *
 * Connection and dialing: the node dials out through the relay addresses handed in from the
 * pairing code, reserves on them, listens on nothing, and keeps libp2p's browser connection gater
 * (`allowPrivateDial: false`), which refuses loopback and private addresses.
 *
 * Logging: every line is `LOG_PREFIX` and an error name (and at most a closed refusal code). No
 * invitation text, key byte, party id, network hash or row value reaches a log line or an error
 * message.
 */

import { createEdgeNode as createCadreEdgeNode, lazyRawStorage, isOwnerGrant } from '@serfab/cadre-core/edge-node';
import { decodeCadreInvitation, CadreInviteRejectedError, DEFAULT_IDENTITY_KEY_ID } from '@serfab/cadre-core';
import { DEFAULT_STRAND_CLUSTER_SIZE } from '@serfab/quereus-plugin-sereus';
import { openOptimysticWebDb, IndexedDBRawStorage, IndexedDBKVStore } from '@optimystic/db-p2p-storage-web';
import { VOTETORRENT_SCHEMA_SQL } from '@votetorrent/vote-engine/browser';

/** The fixed prefix of every log line this module writes. */
export const LOG_PREFIX = '[vt-dashboard/member-node]';

/**
 * Log a failure by its error name only (and a closed refusal code when it carries one).
 *
 * @param {unknown} err
 * @param {string} [code]
 */
export function logFailure(err, code) {
	const name = err instanceof Error && typeof err.name === 'string' && err.name.length > 0 ? err.name : 'Error';
	if (code) console.warn(LOG_PREFIX, name, code);
	else console.warn(LOG_PREFIX, name);
}

// ── Errors ──────────────────────────────────────────────────────────────────

/** A caller handed this module something it cannot use. The message is fixed; it echoes no input. */
export class MemberNodeConfigError extends Error {
	/** @param {string} message a fixed message from this module, never input text */
	constructor(message) {
		super(message);
		this.name = 'MemberNodeConfigError';
	}
}

/**
 * @typedef {'malformed'|'not-invitation'|'party-mismatch'|'spent'|'invalid'|'unreachable'|'cancelled'|'owner-key'|'removed'|'not-configured'|'not-running'|'withdraw-failed'} MemberNodeErrorReason
 */

/** @type {Readonly<Record<MemberNodeErrorReason, string>>} */
const MEMBER_NODE_MESSAGES = Object.freeze({
	malformed: 'The pairing invitation could not be read.',
	'not-invitation': 'The credential is not a single-use device invitation.',
	'party-mismatch': 'This browser is paired with another cadre for this network.',
	spent: 'The invitation was already used or has expired.',
	invalid: 'The invitation or this device key was refused as invalid.',
	unreachable: 'No member of the cadre could be reached.',
	cancelled: 'The operation was cancelled.',
	'owner-key': 'The join left an owner key on this browser, so it was stopped.',
	removed: 'This browser was removed from the cadre.',
	'not-configured': 'The member node is not configured for this strand.',
	'not-running': 'The member node is not running.',
	'withdraw-failed': 'The strand storage services could not be withdrawn.',
});

/** A member-node operation failed for one closed reason. */
export class MemberNodeError extends Error {
	/** @param {MemberNodeErrorReason} reason */
	constructor(reason) {
		const known = Object.prototype.hasOwnProperty.call(MEMBER_NODE_MESSAGES, reason);
		/** @type {MemberNodeErrorReason} */
		const closed = known ? reason : 'unreachable';
		super(MEMBER_NODE_MESSAGES[closed]);
		this.name = 'MemberNodeError';
		/** @type {MemberNodeErrorReason} */
		this.reason = closed;
	}
}

/** An IndexedDB delete was blocked (an open connection) or failed: the storage is still there. */
export class MemberStorageBusyError extends Error {
	constructor() {
		super('A member storage database could not be deleted because it is in use or the delete failed.');
		this.name = 'MemberStorageBusyError';
	}
}

// ── Deployment constants ────────────────────────────────────────────────────

/**
 * The strand cluster size this node runs. Every node of a strand must agree on it. The Authority
 * and Voter `CadreNodeProvider`s set none, so the strands the dashboard joins run cadre-core's
 * default (`DEFAULT_STRAND_CLUSTER_SIZE`); the probe-host drone and gateway and the vote-engine
 * harness run 2, a known deployment difference this module does not change.
 * `member-node.test.mjs` pins this constant against both providers' source.
 */
export const MEMBER_STRAND_CLUSTER_SIZE = DEFAULT_STRAND_CLUSTER_SIZE;

/**
 * The VoteTorrent schema without its `declare schema main { ... } apply schema main;` wrapper:
 * cadre-core re-wraps the sApp schema under `App`, so the wrapped constant would nest invalidly.
 * Same two regexes as the Public page's strand reader and the Authority's `rn-db-factory.ts`.
 */
const VOTETORRENT_INNER_DDL = VOTETORRENT_SCHEMA_SQL.replace(/^\s*declare\s+schema\s+\w+\s*\{/, '')
	.replace(/\}\s*apply\s+schema\s+\w+\s*;\s*$/, '')
	.trim();

/**
 * The sApp configuration this node claims the strand with: the schema from this bundle, never
 * from the network.
 *
 * @type {Readonly<{ id: 'org.votetorrent', version: '1.0.0', schema: string, latencyHint: 'interactive' }>}
 */
export const MEMBER_SAPP_CONFIG = Object.freeze({
	id: /** @type {'org.votetorrent'} */ ('org.votetorrent'),
	version: /** @type {'1.0.0'} */ ('1.0.0'),
	schema: VOTETORRENT_INNER_DDL,
	latencyHint: /** @type {'interactive'} */ ('interactive'),
});

/** The reserved scope of the node-local store: `~` is outside cadre-core's scope charset. */
export const NODE_LOCAL_SCOPE = '~node-local';

const DB_NAME_PREFIX = 'vt-member-';
const SCOPE_RE = /^[A-Za-z0-9._~-]+$/;
const WITHDRAW_LOOKUP_ATTEMPTS = 20;
const DELETE_SETTLE_ROUNDS = 3;
const MEMBER_EVENTS = Object.freeze(['control:connected', 'control:disconnected', 'cadre:removed', 'strand:started']);

/**
 * FNV-1a, 32-bit, as 8 lowercase hex characters. A naming disambiguator only (two hashes that
 * sanitise alike get different names); no security property.
 *
 * @param {string} value
 * @returns {string}
 */
export function shortStableDigest(value) {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i += 1) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

/** @param {string} networkHash */
function sanitizeHash(networkHash) {
	return networkHash.replace(/[^A-Za-z0-9-]/g, '_');
}

/**
 * The IndexedDB database name of one storage scope of one network:
 * `vt-member-<sanitizedNetworkHash>-<scope>-<fnv8>`, the digest over `networkHash + '\n' + scope`.
 * Throws `MemberNodeConfigError` for an empty hash or a scope outside `[A-Za-z0-9._~-]`; never
 * falls back to a default name.
 *
 * @param {string} networkHash
 * @param {string} scope
 * @returns {string}
 */
export function memberStorageDbName(networkHash, scope) {
	if (typeof networkHash !== 'string' || networkHash.trim().length === 0) {
		throw new MemberNodeConfigError('memberStorageDbName: the network hash must be a non-empty string');
	}
	if (typeof scope !== 'string' || !SCOPE_RE.test(scope)) {
		throw new MemberNodeConfigError('memberStorageDbName: the storage scope is outside the allowed charset');
	}
	return `${DB_NAME_PREFIX}${sanitizeHash(networkHash)}-${scope}-${shortStableDigest(`${networkHash}\n${scope}`)}`;
}

/**
 * The two protocols whose advertisement makes a peer a storage member of a network.
 *
 * @param {string} networkName
 * @returns {string[]}
 */
export function storageServiceProtocols(networkName) {
	return [`/optimystic/${networkName}/cluster/1.0.0`, `/optimystic/${networkName}/repo/1.0.0`];
}

/** @param {string} strandId */
export function strandNetworkName(strandId) {
	return `strand-${strandId}`;
}

/**
 * The marker protocol this strand node handles to declare itself a read-only edge reader. Phones refuse a
 * strand peer whose own identify lists it as a member of their write cohorts. Same literal as vote-engine's
 * `EDGE_READER_PROTOCOL` (the dashboard does not import vote-engine's `./rn`); `member-node.test.mjs` pins it.
 */
const EDGE_READER_PROTOCOL = '/votetorrent/edge-reader/1.0.0';

/** How long the withdrawal waits for the immediate identify push before it carries on. */
const IDENTIFY_PUSH_BOUND_MS = 5000;

/**
 * How long the stop of a removed node waits for cadre-core's own removal transition to settle.
 * That transition shuts the node down, then re-opens the node-local database to rewrite the saved
 * start and to set and clear the dissolve marker, and finally reports `removed` or `failed`. The
 * stop waits for that report so it can close the re-opened handle afterwards; the bound keeps a
 * transition that never reports from hanging the wipe. The timer is created and cleared inside
 * `stop()` only, never in the removal handler.
 */
export const REMOVAL_SETTLE_MAX_MS = 20_000;

/**
 * Tell connected peers at once that this node now handles the marker and no storage protocol, instead of
 * after libp2p's 1 s debounced push. Falls back to the debounced push; bounded; a failure is logged by
 * name and never fails the withdrawal.
 *
 * @param {Libp2pLike} node
 */
async function pushIdentifyNow(node) {
	const pusher = node.services?.identifyPush;
	const immediate = pusher?.sendPushMessage;
	const debounced = pusher?.push;
	const send =
		typeof immediate === 'function'
			? () => immediate.call(pusher)
			: typeof debounced === 'function'
				? () => debounced.call(pusher)
				: null;
	if (send === null) return;
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let bound;
	try {
		await Promise.race([send(), new Promise((resolve) => { bound = setTimeout(resolve, IDENTIFY_PUSH_BOUND_MS); })]);
	} catch (err) {
		logFailure(err);
	} finally {
		if (bound !== undefined) clearTimeout(bound);
	}
}

/**
 * Validate the relay addresses from the pairing code: a non-empty array of relay multiaddrs
 * ending in a peer id (`/p2p/<id>`), none a circuit address (`/p2p-circuit`) of a member. The
 * message never echoes an entry.
 *
 * @param {unknown} relayAddrs
 * @returns {readonly string[]} a frozen copy
 */
export function validateRelayAddrs(relayAddrs) {
	if (!Array.isArray(relayAddrs) || relayAddrs.length === 0) {
		throw new MemberNodeConfigError('relayAddrs must be a non-empty array of relay multiaddrs');
	}
	for (const addr of relayAddrs) {
		if (typeof addr !== 'string' || addr.length === 0 || /\s/.test(addr)) {
			throw new MemberNodeConfigError('every relay address must be a multiaddr string without whitespace');
		}
		if (!addr.includes('/p2p/')) {
			throw new MemberNodeConfigError('every relay address must name the relay peer id');
		}
		if (addr.includes('/p2p-circuit')) {
			throw new MemberNodeConfigError('a relay address must not be a circuit address');
		}
	}
	return Object.freeze(relayAddrs.map((addr) => String(addr)));
}

/** One macrotask turn. */
function nextMacrotask() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

// ── Dependencies ────────────────────────────────────────────────────────────

/**
 * Injected dependencies; each defaults to the real implementation. Tests pass fakes.
 *
 * @typedef {object} MemberNodeDeps
 * @property {(platform: import('@serfab/cadre-core/edge-node').EdgeNodePlatform) => import('@serfab/cadre-core/edge-node').EdgeNode} [createEdgeNode]
 * @property {typeof lazyRawStorage} [lazyRawStorage]
 * @property {typeof isOwnerGrant} [isOwnerGrant]
 * @property {typeof decodeCadreInvitation} [decodeCadreInvitation]
 * @property {typeof openOptimysticWebDb} [openOptimysticWebDb]
 * @property {typeof IndexedDBRawStorage} [IndexedDBRawStorage]
 * @property {typeof IndexedDBKVStore} [IndexedDBKVStore]
 * @property {IDBFactory | undefined} [indexedDB] Default `globalThis.indexedDB`.
 * @property {number} [removalSettleMs] Test only: the removal-settle bound; a positive finite number, else `REMOVAL_SETTLE_MAX_MS`.
 */

/**
 * @param {MemberNodeDeps | undefined} deps
 */
function resolveDeps(deps = {}) {
	return {
		createEdgeNode: deps.createEdgeNode ?? createCadreEdgeNode,
		lazyRawStorage: deps.lazyRawStorage ?? lazyRawStorage,
		isOwnerGrant: deps.isOwnerGrant ?? isOwnerGrant,
		decodeCadreInvitation: deps.decodeCadreInvitation ?? decodeCadreInvitation,
		openOptimysticWebDb: deps.openOptimysticWebDb ?? openOptimysticWebDb,
		IndexedDBRawStorage: deps.IndexedDBRawStorage ?? IndexedDBRawStorage,
		IndexedDBKVStore: deps.IndexedDBKVStore ?? IndexedDBKVStore,
		indexedDB: 'indexedDB' in deps ? deps.indexedDB : globalThis.indexedDB,
		removalSettleMs:
			typeof deps.removalSettleMs === 'number' && Number.isFinite(deps.removalSettleMs) && deps.removalSettleMs > 0
				? deps.removalSettleMs
				: REMOVAL_SETTLE_MAX_MS,
	};
}

/** @typedef {ReturnType<typeof resolveDeps>} ResolvedDeps */
/** @typedef {import('@optimystic/db-p2p-storage-web').OptimysticWebDBHandle} WebDbHandle */

/**
 * Delete one IndexedDB database. `onblocked` and `onerror` reject `MemberStorageBusyError`; an
 * absent database is a success.
 *
 * @param {IDBFactory} idb
 * @param {string} name
 * @returns {Promise<void>}
 */
function deleteDatabase(idb, name) {
	return new Promise((resolve, reject) => {
		/** @type {IDBOpenDBRequest} */
		let request;
		try {
			request = idb.deleteDatabase(name);
		} catch {
			reject(new MemberStorageBusyError());
			return;
		}
		request.onsuccess = () => resolve();
		request.onerror = () => reject(new MemberStorageBusyError());
		request.onblocked = () => reject(new MemberStorageBusyError());
	});
}

// ── Platform ────────────────────────────────────────────────────────────────

/**
 * @typedef {object} MemberPlatformOptions
 * @property {string} networkHash
 * @property {import('@serfab/cadre-core').KeyStore} keyStore
 * @property {readonly string[]} relayAddrs
 * @property {string} [strandId]
 * @property {MemberNodeDeps} [deps]
 */

/**
 * The cadre-core edge-node platform of one network's member node. Exported for tests.
 *
 * @param {MemberPlatformOptions} options
 * @returns {import('@serfab/cadre-core/edge-node').EdgeNodePlatform}
 */
export function createMemberPlatform({ networkHash, keyStore, strandId, deps }) {
	const d = resolveDeps(deps);

	/** Bumped by `close()`: a lazy open from before a close must not leave a handle behind. */
	let epoch = 0;
	/** Per-scope generation, bumped by `destroyScope`: an old proxy's late open must not resurrect. */
	/** @type {Map<string, number>} */
	const generations = new Map();
	/** @type {Map<string, import('@optimystic/db-p2p').IRawStorage>} */
	const proxies = new Map();
	/** @type {Map<string, Set<WebDbHandle>>} */
	const handles = new Map();

	/** @type {Promise<{ handle: WebDbHandle, kv: InstanceType<typeof IndexedDBKVStore> }> | null} */
	let nodeLocalOpening = null;
	/** @type {import('@serfab/cadre-core/edge-node').NodeLocalKv | null} */
	let nodeLocalView = null;

	/** @param {string} scope @param {WebDbHandle} handle */
	function trackHandle(scope, handle) {
		let set = handles.get(scope);
		if (!set) {
			set = new Set();
			handles.set(scope, set);
		}
		set.add(handle);
	}

	/** @param {string} scope */
	function closeScopeHandles(scope) {
		const set = handles.get(scope);
		if (!set) return;
		handles.delete(scope);
		for (const handle of set) {
			try {
				handle.close();
			} catch (err) {
				logFailure(err);
			}
		}
	}

	function openNodeLocal() {
		if (nodeLocalOpening) return nodeLocalOpening;
		const name = memberStorageDbName(networkHash, NODE_LOCAL_SCOPE);
		const attempt = d.openOptimysticWebDb(name).then((handle) => ({ handle, kv: new d.IndexedDBKVStore(handle) }));
		nodeLocalOpening = attempt;
		attempt.catch(() => {
			if (nodeLocalOpening === attempt) nodeLocalOpening = null;
		});
		return attempt;
	}

	/** @type {import('@serfab/cadre-core/edge-node').EdgeNodeStorage} */
	const storage = {
		id: `vt-dashboard-${networkHash}`,

		rawStorage(scope) {
			const name = memberStorageDbName(networkHash, scope);
			const cached = proxies.get(scope);
			if (cached) return cached;
			const generation = (generations.get(scope) ?? 0) + 1;
			generations.set(scope, generation);
			const openedInEpoch = epoch;
			const isStale = () => generations.get(scope) !== generation || epoch !== openedInEpoch;
			const proxy = d.lazyRawStorage(async () => {
				if (isStale()) throw new MemberNodeError('not-running');
				const handle = await d.openOptimysticWebDb(name);
				if (isStale()) {
					try {
						handle.close();
					} catch (err) {
						logFailure(err);
					}
					throw new MemberNodeError('not-running');
				}
				trackHandle(scope, handle);
				return new d.IndexedDBRawStorage(handle);
			}, 'power-loss');
			proxies.set(scope, proxy);
			return proxy;
		},

		async destroyScope(scope) {
			const name = memberStorageDbName(networkHash, scope);
			proxies.delete(scope);
			generations.set(scope, (generations.get(scope) ?? 0) + 1);
			closeScopeHandles(scope);
			if (!d.indexedDB) throw new MemberStorageBusyError();
			await deleteDatabase(d.indexedDB, name);
		},

		nodeLocal() {
			if (nodeLocalView) return nodeLocalView;
			nodeLocalView = {
				get: async (key) => (await openNodeLocal()).kv.get(key),
				set: async (key, value) => (await openNodeLocal()).kv.set(key, value),
				delete: async (key) => (await openNodeLocal()).kv.delete(key),
				flush: async () => (await openNodeLocal()).kv.flush(),
			};
			return nodeLocalView;
		},

		async close() {
			epoch += 1;
			const opening = nodeLocalOpening;
			nodeLocalOpening = null;
			nodeLocalView = null;
			if (opening) {
				try {
					const { handle, kv } = await opening;
					try {
						await kv.flush();
						await kv.close();
					} catch (err) {
						logFailure(err);
					}
					try {
						handle.close();
					} catch (err) {
						logFailure(err);
					}
				} catch (err) {
					logFailure(err);
				}
			}
			proxies.clear();
			for (const scope of [...handles.keys()]) closeScopeHandles(scope);
		},
	};

	return {
		keyStore,
		storage,
		allowPrivateDial: false,
		configure(cfg) {
			const strandSlice =
				typeof strandId === 'string' && strandId.length > 0
					? {
							strandFilter: /** @type {const} */ ({ mode: 'strandId', strandId }),
							strandReactivity: { enabled: true, strandIds: [strandId], edgeHost: true },
						}
					: {
							strandFilter: /** @type {const} */ ({ mode: 'none' }),
							strandReactivity: { enabled: false },
						};
			return /** @type {import('@serfab/cadre-core').CadreNodeConfig} */ ({
				...cfg,
				requireSignedSchemas: false,
				strandClusterSize: MEMBER_STRAND_CLUSTER_SIZE,
				// A member that stores nothing must not seed other members' strand nodes: a phone that refuses
				// this node as a cohort member but has it in its strand seed would wait on it forever.
				withholdStrandAddrs: true,
				// cadre-core builds the strand node with this marker handled and no storage protocol registered, so
				// even the first identify a phone receives names this node an edge reader.
				edgeReaderProtocol: EDGE_READER_PROTOCOL,
				...strandSlice,
			});
		},
	};
}

// ── Storage deletion ────────────────────────────────────────────────────────

/**
 * Delete every member database of `networkHash`, and only those: a name is matched by recomputing
 * `memberStorageDbName` for the scope it carries, so a network whose sanitised hash merely starts
 * with this one's is left alone, and `vt-dashboard-keys` / `votetorrent-*` are never touched. A
 * blocked or failed delete rejects `MemberStorageBusyError`; after the deletes the list is read
 * again and any resurrected name deleted again, at most three rounds. Idempotent, including after
 * cadre-core already destroyed the control scope on a removal. On a removal the member node's
 * `stop()` has already closed this tab's handles (including the node-local database cadre-core's
 * removal transition re-opened), so this delete meets no open connection of this tab.
 *
 * @param {string} networkHash
 * @param {{ deps?: { indexedDB?: IDBFactory | undefined } }} [options]
 * @returns {Promise<void>}
 */
export async function deleteMemberStorage(networkHash, { deps = {} } = {}) {
	memberStorageDbName(networkHash, NODE_LOCAL_SCOPE);
	const idb = 'indexedDB' in deps ? deps.indexedDB : globalThis.indexedDB;
	if (!idb || typeof idb.databases !== 'function' || typeof idb.deleteDatabase !== 'function') {
		throw new MemberNodeConfigError('deleteMemberStorage needs indexedDB.databases() and indexedDB.deleteDatabase()');
	}
	const prefix = `${DB_NAME_PREFIX}${sanitizeHash(networkHash)}-`;
	/** @param {string | undefined} name */
	const isOurs = (name) => {
		if (typeof name !== 'string' || !name.startsWith(prefix)) return false;
		const match = /^(.+)-[0-9a-f]{8}$/.exec(name.slice(prefix.length));
		if (!match) return false;
		try {
			return memberStorageDbName(networkHash, match[1]) === name;
		} catch {
			return false;
		}
	};
	const listOurs = async () =>
		(await idb.databases()).map((info) => info.name).filter(isOurs).map((name) => /** @type {string} */ (name));

	let remaining = await listOurs();
	for (let round = 0; round < DELETE_SETTLE_ROUNDS && remaining.length > 0; round += 1) {
		for (const name of remaining) {
			await deleteDatabase(idb, name);
		}
		await nextMacrotask();
		remaining = await listOurs();
	}
	if (remaining.length > 0) throw new MemberStorageBusyError();
}

// ── Member node ─────────────────────────────────────────────────────────────

/**
 * @typedef {'control:connected'|'control:disconnected'|'cadre:removed'|'strand:started'} MemberNodeEvent
 */

/**
 * The subset of a libp2p node the member node uses on a strand node.
 *
 * @typedef {object} Libp2pLike
 * @property {{ toString(): string }} peerId
 * @property {(protocols: string | string[]) => Promise<void>} unhandle
 * @property {(protocol: string, handler: (stream: { abort(err: Error): void }) => void) => Promise<void>} handle
 * @property {() => string[]} [getProtocols]
 * @property {{ identifyPush?: { sendPushMessage?: () => Promise<void>, push?: () => Promise<void> } }} [services]
 * @property {() => Array<{ remotePeer: { toString(): string } }>} getConnections
 */

/**
 * @typedef {object} MemberNode
 * @property {string} peerId the IDENTITY peer id: membership checks, `removeMachine`, `CadreInviteUsage.peerId`
 * @property {(invitationEncoded: string, options?: { onProgress?: (progress: { state: string }) => void, signal?: AbortSignal }) => Promise<'joined'|'already-member'>} joinCadre
 * @property {() => Promise<boolean>} isSelfAdmitted
 * @property {(strandId: string, options?: { signal?: AbortSignal }) => Promise<Libp2pLike>} waitForStrand
 * @property {() => Libp2pLike | null} getStrandNode
 * @property {() => string | null} strandPeerId the per-strand transport peer id (root-group checks)
 * @property {(strandId: string) => import('@serfab/cadre-core').StrandDatabase | null} getStrandDatabase
 * @property {() => import('@libp2p/interface').Libp2p | null} getControlNode
 * @property {() => number} strandPeerCount
 * @property {(event: MemberNodeEvent, cb: (payload: any) => void) => () => void} on
 * @property {() => Promise<'running'|'not-paired'|'removed'>} resume
 * @property {() => 'stopped'|'starting'|'joining'|'running'|'removed'|'failed'} status
 * @property {() => Promise<void>} reconnect
 * @property {() => Promise<void>} stop
 */

/**
 * Build one network's member node. Creating it reads (or, when absent, creates and persists) the
 * identity key through cadre-core's `identityPeerId()`, so the key exists before any invitation
 * is redeemed. It starts nothing.
 *
 * @param {{ networkHash: string, keyStore: import('@serfab/cadre-core').KeyStore, relayAddrs: string[], strandId?: string, deps?: MemberNodeDeps }} options
 * @returns {Promise<MemberNode>}
 */
export async function createMemberNode({ networkHash, keyStore, relayAddrs, strandId, deps }) {
	if (typeof networkHash !== 'string' || networkHash.length === 0) {
		throw new MemberNodeConfigError('createMemberNode: the network hash must be a non-empty string');
	}
	if (
		!keyStore ||
		typeof keyStore.get !== 'function' ||
		typeof keyStore.set !== 'function' ||
		typeof keyStore.delete !== 'function' ||
		typeof keyStore.list !== 'function'
	) {
		throw new MemberNodeConfigError('createMemberNode: the key store must implement get, set, delete and list');
	}
	const relays = validateRelayAddrs(relayAddrs);
	if (strandId !== undefined && (typeof strandId !== 'string' || strandId.length === 0)) {
		throw new MemberNodeConfigError('createMemberNode: the strand id must be a non-empty string when given');
	}
	const d = resolveDeps(deps);
	const platform = createMemberPlatform({ networkHash, keyStore, relayAddrs: relays, strandId, deps });
	const edge = d.createEdgeNode(platform);

	/** @type {Map<MemberNodeEvent, Set<(payload: any) => void>>} */
	const listeners = new Map(MEMBER_EVENTS.map((event) => [/** @type {MemberNodeEvent} */ (event), new Set()]));
	/** @type {Set<{ resolve: (node: Libp2pLike) => void, reject: (err: Error) => void }>} */
	const waiters = new Set();
	/** The strand libp2p node whose storage services this node withdrew. */
	/** @type {Libp2pLike | null} */
	let withdrawnNode = null;
	let removed = false;
	/** Set by `stop()`, cleared by a start or an admitted join. */
	let halted = false;
	/** @type {Promise<void> | null} */
	let stopping = null;
	/** Resolves on cadre-core's first `removed` or `failed` report after a `cadre:removed`; null before one. */
	/** @type {(Promise<void> & { cancel?: () => void }) | null} */
	let removalSettled = null;

	/**
	 * @param {MemberNodeEvent} event
	 * @param {unknown} payload
	 */
	function notify(event, payload) {
		for (const cb of [...(listeners.get(event) ?? [])]) {
			try {
				cb(payload);
			} catch (err) {
				logFailure(err);
			}
		}
	}

	/** @param {MemberNodeErrorReason} reason */
	function rejectWaiters(reason) {
		const pending = [...waiters];
		waiters.clear();
		for (const waiter of pending) waiter.reject(new MemberNodeError(reason));
	}

	/** @param {Libp2pLike} node */
	function resolveWaiters(node) {
		const pending = [...waiters];
		waiters.clear();
		for (const waiter of pending) waiter.resolve(node);
	}

	/** @param {unknown} status */
	function isSettledStatus(status) {
		const state = /** @type {{ state?: unknown } | null | undefined} */ (status)?.state;
		return state === 'removed' || state === 'failed';
	}

	/**
	 * Subscribe (no timer) to cadre-core's status reports and resolve on the first `removed` or
	 * `failed`, then unsubscribe. With no `onStatus` on the edge, the promise never resolves and the
	 * caller's bound decides. `cancel` drops the subscription.
	 *
	 * @returns {Promise<void> & { cancel?: () => void }}
	 */
	function settleWatch() {
		/** @type {() => void} */
		let off = () => {};
		/** @type {Promise<void> & { cancel?: () => void }} */
		const promise = new Promise((resolve) => {
			if (typeof edge.onStatus !== 'function') return;
			let done = false;
			const unsubscribe = edge.onStatus((status) => {
				if (done || !isSettledStatus(status)) return;
				done = true;
				off();
				resolve();
			});
			off = () => {
				done = true;
				unsubscribe();
			};
		});
		promise.cancel = () => off();
		return promise;
	}

	/**
	 * The removed path of `stop()`: wait for cadre-core's removal transition to settle (now, when the
	 * status already reads `removed` or `failed`; else on its report, bounded), then close every
	 * member-storage handle the platform holds. Never stops the edge node: cadre-core stopped it.
	 */
	async function closeAfterRemoval() {
		if (!isSettledStatus(edge.status)) {
			const watch = removalSettled ?? settleWatch();
			/** @type {ReturnType<typeof setTimeout> | undefined} */
			let bound;
			let timedOut = false;
			try {
				await Promise.race([
					watch,
					new Promise((resolve) => {
						bound = setTimeout(() => {
							timedOut = true;
							resolve(undefined);
						}, d.removalSettleMs);
					}),
				]);
			} finally {
				if (bound !== undefined) clearTimeout(bound);
				watch.cancel?.();
			}
			if (timedOut && !isSettledStatus(edge.status)) logFailure(new MemberNodeError('not-running'));
		}
		try {
			await platform.storage.close();
		} catch (err) {
			logFailure(err);
		}
	}

	/** The running CadreNode, or null. */
	function runningNode() {
		return edge.node;
	}

	/** @returns {Libp2pLike | null} */
	function currentStrandLibp2p() {
		if (strandId === undefined) return null;
		const node = runningNode()?.getStrand(strandId)?.libp2pNode;
		return node ? /** @type {Libp2pLike} */ (/** @type {unknown} */ (node)) : null;
	}

	/** @param {{ strandId: string }} event */
	async function onStrandStarted(event) {
		const started = event?.strandId;
		if (strandId === undefined || started !== strandId) return;
		try {
			/** @type {Libp2pLike | null} */
			let node = currentStrandLibp2p();
			for (let attempt = 0; node === null && attempt < WITHDRAW_LOOKUP_ATTEMPTS; attempt += 1) {
				await nextMacrotask();
				node = currentStrandLibp2p();
			}
			if (node === null) throw new MemberNodeError('withdraw-failed');
			// Declare the edge-reader marker BEFORE the storage protocols go, so the single identify push
			// below carries both changes.
			// cadre-core normally declared it already, before the first connection (`edgeReaderProtocol`); this is the
			// fallback for a node that did not.
			if (!(typeof node.getProtocols === 'function' && node.getProtocols().includes(EDGE_READER_PROTOCOL))) {
				await node.handle(EDGE_READER_PROTOCOL, (stream) => {
					try {
						stream.abort(new Error('edge-reader marker only'));
					} catch {
						// already closed
					}
				});
			}
			await node.unhandle(storageServiceProtocols(strandNetworkName(started)));
			await pushIdentifyNow(node);
			withdrawnNode = node;
			resolveWaiters(node);
			notify('strand:started', { strandId: started });
		} catch (err) {
			logFailure(err);
			withdrawnNode = null;
			rejectWaiters('withdraw-failed');
			await stop();
		}
	}

	edge.on('strand:started', (event) => {
		void onStrandStarted(event);
	});
	edge.on('control:connected', () => notify('control:connected', undefined));
	edge.on('control:disconnected', () => notify('control:disconnected', undefined));
	edge.on('cadre:removed', (removal) => {
		removed = true;
		withdrawnNode = null;
		if (removalSettled === null) removalSettled = settleWatch();
		rejectWaiters('not-running');
		notify('cadre:removed', removal);
	});

	// The identity exists before anything can be redeemed: read from the key store, or created and
	// persisted there. A refusal from the key store propagates unchanged.
	const peerId = await edge.identityPeerId();

	/**
	 * The only place this module starts the edge node, and only as a joined device.
	 *
	 * @param {import('@serfab/cadre-core/edge-node').EdgeNodeOptions | undefined} options
	 */
	async function startJoined(options) {
		if (!options || options.origin !== 'joined' || typeof options.partyId !== 'string' || options.partyId.length === 0) {
			throw new MemberNodeError('not-running');
		}
		await edge.start({ ...options, origin: 'joined', relayAddrs: [...relays] });
		halted = false;
		stopping = null;
	}

	function isRemoved() {
		return removed || edge.status.state === 'removed';
	}

	/** @returns {Promise<'running'|'not-paired'|'removed'>} */
	async function resume() {
		if (isRemoved()) return 'removed';
		if (runningNode()?.isRunning) {
			halted = false;
			stopping = null;
			return 'running';
		}
		const saved = await edge.loadSavedStart();
		if (!saved || saved.options?.origin !== 'joined') return 'not-paired';
		try {
			await startJoined(saved.options);
		} catch (err) {
			logFailure(err);
			throw new MemberNodeError('unreachable');
		}
		return 'running';
	}

	/** @returns {Promise<void>} */
	function stop() {
		if (stopping) return stopping;
		stopping = (async () => {
			halted = true;
			withdrawnNode = null;
			rejectWaiters('not-running');
			const state = edge.status.state;
			if (removed || state === 'removed') {
				// A mid-removal `stopped` is exactly the race: cadre-core is about to re-open the
				// node-local database. Wait for its report, then close what this tab holds.
				await closeAfterRemoval();
				return;
			}
			if (state === 'stopped') return;
			try {
				await edge.stop();
			} catch (err) {
				logFailure(err);
			}
		})();
		return stopping;
	}

	/**
	 * @param {unknown} err
	 * @returns {MemberNodeErrorReason}
	 */
	function joinFailureReason(err) {
		const code =
			err instanceof CadreInviteRejectedError || (typeof err === 'object' && err !== null && 'code' in err)
				? /** @type {{ code?: unknown }} */ (err).code
				: undefined;
		if (code === 'invite-spent') return 'spent';
		if (code === 'invite-invalid') return 'invalid';
		return 'unreachable';
	}

	/**
	 * @param {unknown} err
	 * @returns {string | undefined}
	 */
	function closedCode(err) {
		const code = typeof err === 'object' && err !== null ? /** @type {{ code?: unknown }} */ (err).code : undefined;
		return code === 'invite-spent' || code === 'invite-invalid' || code === 'issuer-unknown' ? code : undefined;
	}

	/** @type {MemberNode} */
	const memberNode = {
		peerId,

		async joinCadre(invitationEncoded, { onProgress, signal } = {}) {
			if (isRemoved()) throw new MemberNodeError('removed');
			/** @type {import('@serfab/cadre-core').CadreInvitation} */
			let credential;
			try {
				if (typeof invitationEncoded !== 'string') throw new TypeError('not text');
				credential = d.decodeCadreInvitation(invitationEncoded);
			} catch {
				throw new MemberNodeError('malformed');
			}
			if (d.isOwnerGrant(credential) || credential?.invite?.totalUses !== 1) {
				throw new MemberNodeError('not-invitation');
			}

			// Key first: the identity this browser redeems with is already persisted.
			const identity = await keyStore.get(DEFAULT_IDENTITY_KEY_ID);
			if (!(identity instanceof Uint8Array) || identity.length === 0) {
				throw new MemberNodeError('invalid');
			}

			const saved = await edge.loadSavedStart();
			if (saved && saved.options.partyId !== credential.partyId) {
				throw new MemberNodeError('party-mismatch');
			}

			if (saved && saved.options.origin === 'joined') {
				const resumed = await resume();
				const node = runningNode();
				if (resumed === 'running' && node) {
					let admitted = false;
					try {
						admitted = await node.isAuthorizedMember(peerId);
					} catch (err) {
						logFailure(err);
					}
					if (admitted) return 'already-member';
				}
			}

			if (signal?.aborted) throw new MemberNodeError('cancelled');

			/** @type {import('@serfab/cadre-core/edge-node').JoinCadreResult} */
			let result;
			try {
				result = await edge.joinCadre(credential, {
					relayAddrs: [...relays],
					...(signal ? { signal } : {}),
					onProgress: (progress) => {
						if (onProgress) onProgress({ state: progress?.state });
					},
				});
			} catch (err) {
				if (signal?.aborted) {
					logFailure(err);
					throw new MemberNodeError('cancelled');
				}
				logFailure(err, closedCode(err));
				throw new MemberNodeError(joinFailureReason(err));
			}

			/** @type {unknown} */
			let ownerKey = null;
			try {
				ownerKey = edge.ownerPublicKey();
			} catch (err) {
				logFailure(err);
			}
			if (result?.asOwner === true || typeof ownerKey === 'string') {
				await stop();
				throw new MemberNodeError('owner-key');
			}
			halted = false;
			stopping = null;
			return 'joined';
		},

		async isSelfAdmitted() {
			const node = runningNode();
			if (!node?.isRunning) return false;
			try {
				return await node.isAuthorizedMember(peerId);
			} catch (err) {
				logFailure(err);
				return false;
			}
		},

		waitForStrand(id, { signal } = {}) {
			return new Promise((resolve, reject) => {
				if (strandId === undefined || id !== strandId) {
					reject(new MemberNodeError('not-configured'));
					return;
				}
				const node = runningNode();
				if (isRemoved() || halted || !node) {
					reject(new MemberNodeError('not-running'));
					return;
				}
				const current = currentStrandLibp2p();
				if (withdrawnNode !== null && current === withdrawnNode) {
					resolve(withdrawnNode);
					return;
				}
				if (signal?.aborted) {
					reject(new MemberNodeError('cancelled'));
					return;
				}
				/** @type {{ resolve: (node: Libp2pLike) => void, reject: (err: Error) => void }} */
				const waiter = {
					resolve: (value) => {
						signal?.removeEventListener('abort', onAbort);
						resolve(value);
					},
					reject: (err) => {
						signal?.removeEventListener('abort', onAbort);
						reject(err);
					},
				};
				function onAbort() {
					if (!waiters.delete(waiter)) return;
					reject(new MemberNodeError('cancelled'));
				}
				signal?.addEventListener('abort', onAbort, { once: true });
				waiters.add(waiter);
				node
					.addStrand({
						strandRow: { Id: id, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null, FounderPeerId: null },
						sAppConfig: MEMBER_SAPP_CONFIG,
						awaitFirstSync: false,
					})
					.catch((err) => {
						if (runningNode()?.getStrand(id)) return;
						logFailure(err);
						if (waiters.delete(waiter)) waiter.reject(new MemberNodeError('not-running'));
					});
			});
		},

		getStrandNode() {
			if (isRemoved() || halted) return null;
			const current = currentStrandLibp2p();
			return withdrawnNode !== null && current === withdrawnNode ? withdrawnNode : null;
		},

		strandPeerId() {
			return memberNode.getStrandNode()?.peerId.toString() ?? null;
		},

		getStrandDatabase(id) {
			if (strandId === undefined || id !== strandId || isRemoved() || halted) return null;
			return edge.node?.getStrand(id)?.database ?? null;
		},

		getControlNode() {
			return runningNode()?.getControlNode() ?? null;
		},

		strandPeerCount() {
			const node = memberNode.getStrandNode();
			if (!node) return 0;
			const peers = new Set();
			for (const connection of node.getConnections() ?? []) peers.add(connection.remotePeer.toString());
			return peers.size;
		},

		on(event, cb) {
			const set = listeners.get(event);
			if (!set) throw new MemberNodeConfigError('on: unknown member node event');
			if (typeof cb !== 'function') throw new MemberNodeConfigError('on: the listener must be a function');
			set.add(cb);
			return () => {
				set.delete(cb);
			};
		},

		resume,

		status() {
			return edge.status.state;
		},

		async reconnect() {
			if (isRemoved()) return;
			const node = runningNode();
			if (node?.isRunning) {
				try {
					await node.reconcileControlCohort();
				} catch (err) {
					logFailure(err);
				}
				return;
			}
			await resume();
		},

		stop,
	};

	return memberNode;
}
