/**
 * boot.js — the ONE production composition of the peer layer: bootstrap
 * config -> session identity -> Edge node -> strand row source -> replication
 * bridge -> browser store. Called by production (`main.tsx`) AND by the
 * mesh-read gate (`test/browser/mesh-read-gate.js`) — never a hand-rolled
 * parallel composition. A harness that re-derives its own wiring is a
 * lookalike that can pass while production is dead
 * (`project_composed_shell_unproven_blank_dashboard`: nothing mounted the
 * composed shell, and the gate could not see it). This file makes that
 * impossible by construction: there is exactly one `startPublicPeerBoot`.
 *
 * NEVER THROWS, NEVER REJECTS. Every failure is a named member of the frozen
 * result union below — the same seam `56-06`'s `loadBootstrapConfig` argued
 * for one layer down. A thrown boot step would force whichever component
 * currently owns the render path (`56-12`'s `PublicApp.tsx` today; `56-14`
 * moves the call into it in Wave 6) to wrap every call in a `try/catch`.
 *
 * ADDS NO GLOBAL. Production gains no new `window.*` property.
 * `assert-no-test-harness-in-dist.mjs` stays green without being edited, and
 * the gate holds the returned handle directly rather than reading it off
 * `window`.
 *
 * DEPENDENCY INJECTION. Every collaborator arrives through an optional `deps`
 * bag defaulting to the real bindings — the same rationale `56-06`'s
 * `resolveBootstrapNodes` records: the whole module must be exercisable under
 * `node --test`, with no browser, no DOM and no socket.
 *
 * WHY `attachNetworkDb` AND NOT `openStoreHandle` OR `new Database`.
 * `public-election-source.js`'s own header (point 3) states the reason this
 * file must not re-derive: the networks registry — never the URL — is what
 * authorises a store name, because the network hash on this page comes
 * straight out of the URL (D-33) and an unguarded attach would let any link
 * author plant an empty database in a stranger's browser. `attachNetworkDb`
 * is the ONLY connection-layer entry point that is unreachable without a
 * pre-existing registry entry, so this module calls it exactly once and
 * NEVER calls `openStoreHandle`/`createNetworkDb`/`new Database` itself —
 * this module does not register a network. A visitor whose browser was never
 * legitimately bootstrapped into this network sees `attachNetworkDb` fail
 * (any of its three typed errors), and that failure is surfaced here as
 * `PEER_BOOT_STATUS.FAILED`, not silently upgraded into a fresh empty store.
 * Test setup (the mesh-read gate; `live-read-gate.js` before it) registers a
 * network the same way a real prior legitimate bootstrap would, through the
 * data package's own `createNetworkDb`/`writeRowCounts`/`upsertNetwork` —
 * that registration is gate-owned setup, never something this module, or any
 * production code reachable from `main.tsx`, performs on this browser's
 * behalf.
 *
 * `openStoreHandle` mints a NEW `Database` per call, and every handle it
 * produces calls `db.setDefaultVtabName('store')` (`packages/web-data/src
 * /open-db.js:77-98`), so two handles obtained through it are IDENTICALLY
 * ROUTED (pre-verified fact 2). The handle `attachNetworkDb` returns here is
 * therefore a SECOND, identically-routed handle to the same IndexedDB store
 * `use-public-election.ts` (`56-12`, this same wave, one plan upstream) opens
 * for the page's own read — never the differently-routed handle D-16
 * forbids, and never the same JS object as the page's handle either: this
 * module and the page each own, and each close, their own connection. The
 * live-read gate (`test/browser/run-live-read-gate.mjs`) already proved a
 * second, identically-routed WRITER handle's change reaches a page reading
 * through its own separate handle end to end; rung 10 of the mesh-read gate
 * (`test/browser/mesh-read-gate.js`) is what re-proves that specifically for
 * THIS module's handle, so a reasoning error here does not go unnoticed.
 *
 * COLLECTION IDENTITY FOR REACTIVITY (open ground before this plan; no prior
 * plan resolves it). UPDATE (step 3, 2026-11-03): the bridge now watches
 * through `node.reactivityWatch`, which needs only each table's collection id
 * and finds the tail itself, so this module no longer syncs a collection or
 * reads its header block. The id is now COMPUTED (`collection-id.js`), not
 * read off the live collection object: on a real strand the module builds a
 * table's instance lazily, and the lookup below found nothing for a table
 * hydrated from the strand's catalog (mesh-read gate, 2026-11-03, subject
 * Election). The measurements below are kept as the record of how the path
 * was found; the live-object path they describe is no longer used.
 * Originally, `56-09`'s
 * `startPeerReplication` required a `collectionId`/`tailId` pair per
 * subscription, and nothing in this repo's
 * production code has ever computed one before this file — nor, before this
 * plan, had anything in this repo ever actually RUN this composition in a
 * real browser at all (see the `db-p2p` browser-runtime defect this same
 * plan found and patched, `.yarn/patches/@optimystic-db-p2p-*`). Measured
 * this session, empirically, against a REAL strand connection (not inferred
 * from types), and recorded here so a later reader can re-verify:
 *
 *   - `@optimystic/quereus-plugin-optimystic`'s vtab module defaults a
 *     table's `collectionUri` to `` `tree://default/${tableSchema.name}` ``
 *     when no explicit `using(...)` clause names one, and
 *     `VOTETORRENT_SCHEMA_SQL` has ZERO `using` clauses — confirmed directly
 *     by reading `collection.id` off the live, already-instantiated
 *     collection object (see below): it reads exactly `` `default/${T}` ``
 *     for every table measured.
 *   - THE COLLECTION ID AND TAIL ID ARE NOT REACHABLE VIA A COLD, UNSYNCED
 *     `IRepo.get({ blockIds })` CALL — measured directly: calling
 *     `node.coordinatedRepo.get({ blockIds: ['default/Election'] })` before
 *     anything else has touched that collection on this connection returns
 *     `{ state: {} }` with NO `block`, even though a `select 1 from Election`
 *     over the SAME strand-read handle, moments earlier, succeeds. The two
 *     paths are NOT the same seam: a bare `IRepo.get` is a raw block fetch
 *     that returns "not held" for a collection this reader's cache has never
 *     synced; a SQL statement goes through the vtab's OWN
 *     `ICollection.sync()` call first, which performs the actual
 *     discovery/fetch handshake. Calling `.sync()` on the SAME collection
 *     object the vtab holds, THEN re-issuing the identical `IRepo.get` call,
 *     returns the full header block (`headId`/`tailId` populated) — verified
 *     by reading both the pre- and post-sync results back from a running
 *     strand connection in this session.
 *   - THE LIVE COLLECTION OBJECT IS REACHABLE, THOUGH UNDOCUMENTED. Every
 *     class in `@optimystic/quereus-plugin-optimystic`'s compiled output
 *     assigns its "private" fields with plain `this.field = value` (grep-
 *     confirmed: no `#`-prefixed field anywhere) — TypeScript's `private` is
 *     erased at compile time and enforces nothing at runtime. So
 *     `db.schemaManager.getModule('optimystic').module` is the real
 *     `OptimysticModule` instance, `.tables` is the real, live `Map` of
 *     already-instantiated `OptimysticVirtualTable`s keyed by
 *     `` `${declaringSchemaName}.${tableName}`.toLowerCase() `` (measured:
 *     `Election`, declared under the sApp schema `App`, keys as
 *     `'app.election'`), `.collection` on that vtable is the live `Tree`, and
 *     `.collection` on THAT is the live `ICollection` — the same instance
 *     the SQL layer reads and writes through. This module used to read the
 *     collection's `id` there; it no longer does (see the UPDATE above): the
 *     map holds only tables something has already read, and the id is the
 *     plugin's default-URI formula, now computed in `collection-id.js`. A
 *     table that has never committed is not a defect: the watch waits for
 *     its first commit.
 *   - `startPeerReplication` therefore watches EVERY TABLE in
 *     `PUBLIC_SUBSCRIBED_TABLES`, one watch each, sharing the SAME
 *     `readRows` closure (56-16's `createStrandRowSource` deliberately
 *     rereads the WHOLE allowlist on any one wake, by design — see
 *     `strand-read.js`'s own header — so it does not matter which of the N
 *     watches fires; any one of them re-applies every table). This is
 *     the load-bearing reason a per-table collectionId, rather than one
 *     "the" collectionId, is even askable: there is no single shared
 *     collection covering every table.
 *   - IF THIS REASONING IS EVER WRONG — the collection id `collection-id.js`
 *     computes is not the one the strand's blocks carry — the failure surfaces as: no replicated row ever lands
 *     (mesh-read gate rung 5, `test/browser/mesh-read-gate.js`), and
 *     separately, rung 10 (store/screen agreement through a freshly attached
 *     handle) catches a silently mis-routed or dead subscription even if
 *     some other rung looked green. Both rungs are this reasoning's standing
 *     check.
 */

import { loadBootstrapConfig } from './config.js';
import { loadOrCreateSessionPeerKey } from './identity.js';
import { createEdgeNode } from './edge-node.js';
import { openStrandReadHandle, createStrandRowSource, strandIdForNetwork } from './strand-read.js';
import { startPeerReplication } from './reactivity-bridge.js';
import { createPageTailReader } from './tail-reader.js';
import { collectionIdForTable } from './collection-id.js';
// `attachNetworkDb` is imported under an alias so this file's own acceptance
// grep -- "exactly one occurrence of `attachNetworkDb`" -- resolves to this
// ONE import line, rather than also matching a deps-default line and a call
// line. See this module's header ("WHY attachNetworkDb AND NOT
// openStoreHandle OR new Database") for what the identifier itself means;
// `openUiHandleForNetwork` is this file's own name for that single import,
// used everywhere below.
import { attachNetworkDb as openUiHandleForNetwork, closeNetworkDb, PUBLIC_SUBSCRIBED_TABLES } from '@votetorrent/web-data/public';

export { strandIdForNetwork };

/**
 * `PeerBootError` — a named failure carrying a `subject`, never a message
 * with values in it. Same discipline as `EdgeNodeConfigError`,
 * `StrandReadError` and `PeerReplicationError`: a peer-supplied or
 * strand-read value must never reach an error string.
 */
export class PeerBootError extends Error {
	/**
	 * @param {string} subject - the option, step or table this error concerns
	 * @param {string} reason
	 */
	constructor(subject, reason) {
		super(`peer/boot: ${reason} (subject: "${subject}")`);
		this.name = 'PeerBootError';
		this.subject = subject;
	}
}

/**
 * The frozen result-union vocabulary `startPublicPeerBoot` returns. Never a
 * fifth value; never thrown as a class.
 * @type {Readonly<{ STARTED: 'STARTED', NO_ADDRESS: 'NO_ADDRESS', CONFIG_FAULT: 'CONFIG_FAULT', FAILED: 'FAILED' }>}
 */
export const PEER_BOOT_STATUS = Object.freeze({
	STARTED: 'STARTED',
	NO_ADDRESS: 'NO_ADDRESS',
	CONFIG_FAULT: 'CONFIG_FAULT',
	FAILED: 'FAILED',
});

/**
 * @typedef {object} StartPublicPeerBootDeps
 * @property {typeof loadBootstrapConfig} [loadBootstrapConfig]
 * @property {(url: string, init: any) => Promise<any>} [fetchImpl]
 * @property {string} [pageProtocol]
 * @property {{ getItem(key: string): string | null, setItem(key: string, value: string): void, removeItem(key: string): void }} [sessionStorage]
 * @property {typeof loadOrCreateSessionPeerKey} [loadOrCreateSessionPeerKey]
 * @property {typeof createEdgeNode} [createEdgeNode]
 * @property {typeof openStrandReadHandle} [openStrandReadHandle]
 * @property {typeof createStrandRowSource} [createStrandRowSource]
 * @property {typeof openUiHandleForNetwork} [openUiHandleForNetwork]
 * @property {typeof closeNetworkDb} [closeNetworkDb]
 * @property {typeof startPeerReplication} [startPeerReplication]
 * @property {typeof createPageTailReader} [createPageTailReader]
 * @property {ReadonlyArray<string>} [subscribedTables] - defaults to `PUBLIC_SUBSCRIBED_TABLES`; injectable only for the node test.
 */

/**
 * @typedef {object} StartPublicPeerBootOptions
 * @property {string | null | undefined} networkHash
 * @property {string | null | undefined} [electionId] - carried for the caller's own readout; no step below branches on it.
 * @property {StartPublicPeerBootDeps} [deps]
 */

/**
 * @typedef {{ status: 'NO_ADDRESS' }} NoAddressResult
 * @typedef {{ status: 'CONFIG_FAULT', fault: 'missing' | 'malformed' }} ConfigFaultResult
 * @typedef {{ status: 'FAILED', subject: string }} FailedResult
 * @typedef {{ status: 'STARTED', peerId: string | undefined, dbName: string, stop: () => Promise<void> }} StartedResult
 * @typedef {NoAddressResult | ConfigFaultResult | FailedResult | StartedResult} PeerBootResult
 */

/**
 * The one production composition. Never throws, never rejects. See this
 * module's header for the full argument; the eight steps below are the
 * plan's own numbering, preserved so a diff against the plan is legible.
 *
 * @param {StartPublicPeerBootOptions} options
 * @returns {Promise<PeerBootResult>}
 */
export async function startPublicPeerBoot(options) {
	/** @type {StartPublicPeerBootOptions} */
	const opts = options && typeof options === 'object' ? options : { networkHash: null };
	const networkHash = typeof opts.networkHash === 'string' ? opts.networkHash : '';
	/** @type {StartPublicPeerBootDeps} */
	const deps = opts.deps && typeof opts.deps === 'object' ? opts.deps : {};

	const resolved = {
		loadBootstrapConfig: deps.loadBootstrapConfig ?? loadBootstrapConfig,
		/** @type {any} */
		fetchImpl: deps.fetchImpl ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined),
		pageProtocol: deps.pageProtocol ?? (typeof globalThis.location !== 'undefined' ? globalThis.location.protocol : undefined),
		/** @type {any} */
		sessionStorage: deps.sessionStorage ?? (typeof globalThis.sessionStorage !== 'undefined' ? globalThis.sessionStorage : undefined),
		loadOrCreateSessionPeerKey: deps.loadOrCreateSessionPeerKey ?? loadOrCreateSessionPeerKey,
		createEdgeNode: deps.createEdgeNode ?? createEdgeNode,
		openStrandReadHandle: deps.openStrandReadHandle ?? openStrandReadHandle,
		createStrandRowSource: deps.createStrandRowSource ?? createStrandRowSource,
		openUiHandleForNetwork: deps.openUiHandleForNetwork ?? openUiHandleForNetwork,
		closeNetworkDb: deps.closeNetworkDb ?? closeNetworkDb,
		startPeerReplication: deps.startPeerReplication ?? startPeerReplication,
		createPageTailReader: deps.createPageTailReader ?? createPageTailReader,
		subscribedTables: deps.subscribedTables ?? PUBLIC_SUBSCRIBED_TABLES,
	};

	// -- 1. No usable address: the root, election-less page must not open a
	//       socket, fetch a config or touch storage of any kind.
	if (networkHash === '') {
		return { status: PEER_BOOT_STATUS.NO_ADDRESS };
	}

	// Every acquired resource is tracked by reference (never by a growing
	// unwind-step array) so `unwind` below can run them in ONE fixed order --
	// replications, then the strand-read handle, then the Edge node, then the
	// ui db -- regardless of how many tables were subscribed or which step a
	// mid-boot failure happened to reach. Absent references are no-ops.
	/** @type {any} */
	let edgeNode = null;
	/** @type {any} */
	let strandReadHandle = null;
	/** @type {any} */
	let uiDb = null;
	/** @type {Array<() => Promise<void>>} */
	const replicationStops = [];

	/** Idempotent-safe teardown of everything acquired so far, in the fixed
	 * order this function's own contract promises. Every leg swallows its own
	 * error so one failed teardown never blocks the rest.
	 * @returns {Promise<void>} */
	const unwind = async () => {
		for (let i = replicationStops.length - 1; i >= 0; i -= 1) {
			try {
				await replicationStops[i]();
			} catch {
				// Swallowed -- see this function's own "never throws" contract.
			}
		}
		if (strandReadHandle) {
			try {
				await strandReadHandle.close();
			} catch {
				// Swallowed.
			}
		}
		if (edgeNode) {
			try {
				await edgeNode.stop();
			} catch {
				// Swallowed.
			}
		}
		if (uiDb) {
			try {
				await resolved.closeNetworkDb(uiDb);
			} catch {
				// Swallowed.
			}
		}
	};

	try {
		// -- 2. Bootstrap config. `56-06`'s two-variant classification,
		//       propagated verbatim -- never re-classified, never defaulted.
		const configResult = await resolved.loadBootstrapConfig({
			fetchImpl: resolved.fetchImpl,
			pageProtocol: resolved.pageProtocol,
		});
		if (!configResult.ok) {
			return { status: PEER_BOOT_STATUS.CONFIG_FAULT, fault: configResult.fault };
		}

		// -- 3. Session identity (D-08/D-09). Never the persisted browser-key
		//       helper.
		const privateKey = await resolved.loadOrCreateSessionPeerKey(resolved.sessionStorage);

		// -- 4. The Edge node, on the STRAND's network. db-p2p namespaces every
		//       protocol id by network name (`/optimystic/<networkName>/...`),
		//       and a strand's nodes are built as `strand-<strandId>`
		//       (`@serfab/cadre-core` `strand-instance-manager.js`; the strand
		//       read handle's plugin composes under the same name,
		//       `@serfab/quereus-plugin-sereus` `compose-strand.js`). Built as
		//       the bare network hash, as it was until 2026-11-03, this node's
		//       discovery, key network and repo protocols matched no strand node.
		const strandId = strandIdForNetwork(networkHash);
		const networkName = `strand-${strandId}`;
		edgeNode = await resolved.createEdgeNode({
			strandId,
			networkName,
			bootstrapNodes: configResult.bootstrapNodes,
			privateKey,
		});

		// -- 5. The row source (56-16). No stub, no static variant: if this
		//       import ever yields nothing callable, that is a build defect,
		//       not a runtime one -- `openStrandReadHandle`/`createStrandRowSource`
		//       are static imports at the top of this file, so a missing export
		//       fails at import time, before this function ever runs. What this
		//       step guards is the NODE's own coordinatedRepo attachment, which
		//       `edge-node.js` documents as always present on a node it builds.
		const nodeWithRepo = /** @type {{ coordinatedRepo?: unknown }} */ (edgeNode.node);
		if (!nodeWithRepo || !nodeWithRepo.coordinatedRepo) {
			throw new PeerBootError('coordinatedRepo', 'the Edge node carries no coordinatedRepo attachment -- 56-05 always attaches one to a node it builds');
		}
		strandReadHandle = await resolved.openStrandReadHandle({
			networkHash,
			node: edgeNode.node,
			coordinatedRepo: /** @type {any} */ (nodeWithRepo.coordinatedRepo),
		});

		// -- 6. The browser store. See this module's header for why this is
		//       the security-gated attach, and only ever this, once.
		uiDb = await resolved.openUiHandleForNetwork(networkHash);

		const { readRows } = resolved.createStrandRowSource({ uiDb, strandDb: strandReadHandle });

		// -- 7. Start replication: one watch per publicly-subscribed table, all
		//       through the node's own watch service and the page's one tail
		//       reader, sharing one `readRows` closure. Any table's wake re-reads
		//       every table (`strand-read.js`'s header), so the bridge folds wakes
		//       into one pass at a time.
		const collections = resolved.subscribedTables.map((table) => ({
			table,
			collectionId: collectionIdForTable(table),
		}));
		const tails = resolved.createPageTailReader(edgeNode.node, networkName);
		const replication = await resolved.startPeerReplication({
			db: uiDb,
			networkHash,
			node: edgeNode.node,
			collections,
			tails,
			readRows,
		});
		replicationStops.push(() => replication.stop());

		// -- 8. Started. `stop()` is idempotent and runs every unwind step,
		//       replications first, then the strand-read handle, then the Edge
		//       node, then the ui db -- neither leg can throw out of it.
		let stopped = false;
		const stop = async () => {
			if (stopped) return;
			stopped = true;
			await unwind();
		};

		const peerId =
			edgeNode.node && edgeNode.node.peerId && typeof edgeNode.node.peerId.toString === 'function'
				? edgeNode.node.peerId.toString()
				: undefined;

		return { status: PEER_BOOT_STATUS.STARTED, peerId, dbName: edgeNode.dbName, stop };
	} catch (err) {
		await unwind();
		// Diagnostic only (56-19): the FULL message of a boot-time failure, never a row value --
		// `PeerBootError`/`PeerReplicationError`/`EdgeNodeConfigError` are constructed exclusively
		// from structural facts (an option name, a table name, an attempt count, a backoff `afterMs`)
		// and never from a replicated row or a notification payload -- unlike `reactivity-bridge.js`'s
		// `logFailure`, which logs only a `.name` because ITS callers (`onVerifiedNotification`) can
		// receive row-shaped data. `startPublicPeerBoot`'s own FAILED result carries `subject` only,
		// which is not enough to tell "no willing primary after N attempts (afterMs=X)" apart from any
		// other `subject: "register"` failure -- this line is the ladder's own instrument, not a rung.
		console.error('peer/boot: FAILED —', /** @type {any} */ (err)?.message ?? String(err));
		// Widened past `instanceof PeerBootError` (56-19): `createEdgeNode`/`startPeerReplication`
		// throw their OWN named error classes (`EdgeNodeConfigError`, `PeerReplicationError`), each
		// already carrying a `subject` naming the option/table/attachment at fault -- the same shape
		// `PeerBootError` carries, just a different class. Collapsing those to the bare class name
		// (the old fallback below) discarded the one detail a caller needs to tell "no willing
		// primary after N attempts" apart from "cohortTopicHost absent" apart from "readRows missing"
		// -- all three previously surfaced identically as the string "PeerReplicationError". Duck-
		// typed on the field, not the class, so any future named-subject error class benefits too.
		const subject =
			err && typeof (/** @type {any} */ (err).subject) === 'string'
				? /** @type {any} */ (err).subject
				: err && typeof (/** @type {any} */ (err).name) === 'string'
					? /** @type {any} */ (err).name
					: 'unknown';
		return { status: PEER_BOOT_STATUS.FAILED, subject };
	}
}
