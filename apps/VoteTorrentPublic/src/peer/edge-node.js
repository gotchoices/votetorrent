/**
 * edge-node.js — the browser Edge-tier libp2p node factory, plus the
 * per-strand IndexedDB block-storage seam that makes D-18 hold.
 *
 * This is the FIRST libp2p node this repository has ever constructed for a
 * browser. The two RN `CadreNodeProvider.tsx` files
 * (`apps/VoteTorrentAuthority`, `apps/VoteTorrentVoter`) are role analogs
 * only: their boot-effect lifecycle discipline (mount-guarded start,
 * stop-on-unmount, stop-if-unmounted-mid-boot, errors swallowed at
 * cleanup) and their event-driven-never-polled posture (D-10: no
 * `setInterval` anywhere) both transfer to this module. Their transport,
 * storage, identity, profile and schema-policy CHOICES do NOT — this app
 * reads an election as an anonymous Edge-tier observer, not a participant
 * device, and copying those choices wholesale produces a node that is
 * wrong in the six specific ways enumerated below. `edge-node-shape.test.mjs`
 * asserts each of the six absent, field by field, so a copy-paste
 * regression goes red rather than shipping quietly.
 *
 * THE D-18 ISOLATION ARGUMENT. `@optimystic/quereus-plugin-optimystic` maps
 * every table to the collection URI `tree://default/{TableName}` and caches
 * the local transactor under the fixed key `local:libp2p` — neither the
 * collection URI nor the transactor key carries a strandId. The database
 * INSTANCE is therefore the only isolation boundary this stack offers. One
 * shared `IndexedDBRawStorage` handle across two strands reproduces
 * `project_strand_storage_per_network_isolation` verbatim (the RN side
 * shipped exactly that bug once: every network's rows landed in the same
 * `tree://default/Authority` keyspace, contaminating `count(*)` across
 * networks). `openStrandBlockStorage` below opens one
 * `openOptimysticWebDb(name)` per strandId, with a name derivation that
 * fails closed on an invalid id rather than ever falling back to the
 * package default (`DEFAULT_DB_NAME`, `'optimystic'`) — that single
 * fallback line is the whole failure mode. Rejected alternatives, per
 * D-18: keying the store by `networkHash` (silently merges the day one
 * network carries multiple strands) and a single shared store (the bug
 * itself).
 *
 * BROWSER EXEMPTION FROM THE STRAND-STORAGE MIGRATION TODO. The open todo
 * `.planning/todos/pending/2026-06-25-strand-storage-migrate-old-networks.md`
 * covers the RN half's legacy shared-store data. The browser is exempt BY
 * CONSTRUCTION: these per-strand IndexedDB stores are created fresh, one
 * per strandId, from the moment this module exists — there is no legacy
 * browser store to migrate. (Recording that exemption in the todo itself is
 * `56-10`'s deliverable, not this module's; this header states it once so
 * a later reader does not have to re-derive it.)
 *
 * NAME-COLLISION GUARD. `strandStorageDbName` sanitises with cadre-core's
 * own `getStrandStoragePath` convention
 * (`strandId.replace(/[^a-zA-Z0-9-]/g, '_')`), which is lossy: two distinct
 * raw ids that differ only in characters outside that alphabet sanitise to
 * the SAME string. A short non-cryptographic digest of the raw id (FNV-1a,
 * 32-bit) is appended so the two never collide. This digest is a naming
 * disambiguator only — it carries no security property and is not used
 * anywhere a collision would be a security concern.
 *
 * EXPLICIT NON-CARRIES from the RN provider. Do not reintroduce any of
 * these:
 *  1. `loadOrCreateRNPeerKey` / `loadOrCreateBrowserPeerKey` — identity
 *     comes from `identity.js`'s `loadOrCreateSessionPeerKey`, injected by
 *     the caller as `privateKey` (D-08, D-09).
 *  2. `profile: 'transaction'` — the RN PARTICIPANT profile. This is an
 *     Edge-tier reader; `fretProfile` set to `'edge'` is a different field
 *     with a different meaning.
 *  3. `storage: { provider: scopedStorageProvider }` — the RN callback
 *     shape belongs to `db-p2p-storage-rn`'s per-scope LevelDB. The web
 *     package takes a storage INSTANCE, one per strand (D-18).
 *  4. `requireSignedSchemas: false` — a documented VoteTorrent decision for
 *     the RN network-CREATION path. A read-only anonymous browser node
 *     creates no network; there is no policy here to relax.
 *  5. `strandFilter: { mode: 'all' }` — `StrandFilter` governs which
 *     strands a node PARTICIPATES in and is explicitly NOT D-03's
 *     observability allowlist. Left unset.
 *  6. `circuitRelayTransport(...)`, `network.relayAddrs`, `relay`,
 *     `listenAddrs`, `port`/`wsPort`, `hibernation`, `connectionGater`,
 *     `controlNetwork`, `PARTY_ID`, `CONTROL_ADDR`, and the
 *     `UPDATE_AFTER_DRONE_RESTART` sentinel. A browser dials out and does
 *     not listen. Bootstrap addresses arrive as a parameter from `56-06`'s
 *     config mechanism — this module does not fetch `config.json` itself.
 *
 * WHAT DOES CARRY: `createEdgeNode` returns a `stop()` that is idempotent,
 * safe after a partial or failed start, and swallows errors from both the
 * node stop and the database close — exactly like the RN cleanup.
 *
 * THE ONE TIMER THIS MODULE NOW CONSTRUCTS (56-17, re-opening the invariant
 * this header used to state as absolute — not deleting it, replacing it).
 * `cohortTopic.enabled: true` below causes `@optimystic/db-p2p`'s
 * `createCohortTopicHost` to install exactly ONE recurring `setInterval`
 * (`cohort-topic/host.js:538`), and that timer is OWNED by db-p2p's cohort-
 * topic host, never by this module: this module constructs the node that
 * carries it, and nothing here calls `setInterval`/`setTimeout` directly.
 * Each tick walks the host's own coord registry (`registry.all()`,
 * `cohort-topic/host.js:515`); with an empty registry — this browser's
 * steady state, because it publishes no listen address and (see the
 * `cohortTopic` option below) is willing to serve no tier, so nothing ever
 * dispatches a coord engine into existence on it — the tick performs ZERO
 * gossip frames, ZERO membership refreshes and ZERO demotion checks. It is
 * `unref()`'d on Node (`timer.unref?.()`, `cohort-topic/host.js:542`) and is
 * a plain numeric interval in a browser (there is no event loop to keep
 * alive there). This module still adds NO polling, NO reconnection backoff
 * and NO retry loop of its own — those remain absent, exactly as before.
 * The subscription RENEWAL cadence (`ttl/3`, the recurring OUTBOUND signal
 * this posture change actually introduces) belongs to
 * `reactivity-bridge.js`, named there, not here. Full reasoning and the
 * falsifiable predictions this posture makes: see
 * `56-17-COHORT-TOPIC-POSTURE.md`.
 *
 * Connection state is read from the node's own events by consumers
 * (`56-09`/`56-11`), which also own the `isMounted`-style cancellation
 * guard around this factory — `createEdgeNode` itself is a plain,
 * stateless-between-calls factory function.
 *
 * 7. Do not "simplify" `cohortTopic.host` away. A bare `cohortTopic: {
 *    enabled: true }` with no `host` object is NOT equivalent to what this
 *    module constructs: `createCohortTopicHost` resolves an omitted profile
 *    to `coreProfile()` (`cohort-topic/host.js:83`), and
 *    `libp2p-node-base.js:1186` reads that resolved profile back as the
 *    node's reactivity posture — an anonymous reader's browser would become
 *    a T3 reactivity FORWARDER for other readers (D-08/D-09/D-10). The
 *    `host.profile`/`host.minSigs` object below is the CORE of this
 *    module's posture, not incidental tuning; see
 *    `56-17-COHORT-TOPIC-POSTURE.md`.
 *
 * 8. THIS MODULE ATTACHES A DIAGNOSTIC-ONLY CONNECTION-LIFECYCLE TAP (56-24).
 *    The instant `resolvedDeps.createLibp2pNode(...)` resolves,
 *    `attachConnectionLifecycleTap` (`./connection-lifecycle-probe.js`) is
 *    called on the constructed node. It attaches listeners and mutates
 *    nothing on the node itself — state lives in the probe module's own
 *    `WeakMap`, never on a node property. It adds NO timer and NO polling of
 *    its own (the standing D-10 posture above is preserved, not re-opened):
 *    it only reacts to libp2p's own connection/peer events as they fire.
 *    Its observation window begins only once `createLibp2pNode` has
 *    RESOLVED, which is AFTER that factory's own internal `node.start()` —
 *    any event during `node.start()` itself is outside what this tap can
 *    see, and `56-24-CONNECTION-MEASUREMENT.md` names that residual rather
 *    than rounding past it. The tap's attach is wrapped so a probe failure
 *    can never fail node construction; this module builds no fix from
 *    whatever the tap observes.
 */

import { openOptimysticWebDb, IndexedDBRawStorage } from '@optimystic/db-p2p-storage-web';
import { createLibp2pNode } from '@optimystic/db-p2p/rn';
import { webSockets } from '@libp2p/websockets';
import { edgeProfile } from '@optimystic/db-core';
import { attachConnectionLifecycleTap } from './connection-lifecycle-probe.js';

/** Prefix that guarantees a derived name can never equal the package
 * default database name (`'optimystic'`). @type {string} */
const STRAND_DB_NAME_PREFIX = 'vt-edge-strand-';

/**
 * `cohortTopic.host.minSigs` for this deployment. The substrate default is
 * `14` (`k − x`, `@optimystic/db-core` `dist/src/cohort-topic/sig/threshold.js:16`),
 * presuming a cohort of at least that many signers. This deployment's SERVING
 * COHORT IS A SINGLE STRAND NODE, so `14` is unsatisfiable — no certificate
 * this deployment could ever produce would carry 14 distinct signatures, and
 * holding the default would mean reactivity never works at all. The ORIGIN
 * must carry this identical number, or every notification fails membership
 * verification (a subscriber configured for a different `minSigs` than the
 * cohort that signs its certificates either verifies too little or rejects
 * everything). Raising it later — as the serving cohort grows — is a
 * two-sided change: both this constant and the origin's signing threshold
 * move together. See `56-17-COHORT-TOPIC-POSTURE.md`'s dedicated section for
 * the full cost/rationale.
 * @type {1}
 */
export const PUBLIC_COHORT_MIN_SIGS = 1;

/**
 * `EdgeNodeConfigError` — thrown for an empty/non-array `bootstrapNodes`
 * and for an invalid strandId. Presentation of this error is NOT this
 * module's concern: `56-06` owns the config loader's fault variants and
 * `56-12` owns the fault UI. The message stays factual, no user-facing copy.
 */
export class EdgeNodeConfigError extends Error {
	/** @param {string} message */
	constructor(message) {
		super(message);
		this.name = 'EdgeNodeConfigError';
	}
}

/**
 * A small, non-cryptographic, deterministic digest (FNV-1a, 32-bit) of a
 * string, rendered as 8 lowercase hex characters. Used only to disambiguate
 * two strandIds that sanitise to the same string — see the module header.
 * @param {string} value
 * @returns {string}
 */
function shortStableDigest(value) {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i += 1) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Derives the per-strand IndexedDB database name. Pure. Fails closed on an
 * empty, whitespace-only or non-string strandId by throwing
 * `EdgeNodeConfigError` — NEVER falls back to `openOptimysticWebDb()`'s
 * default name (`DEFAULT_DB_NAME`, `'optimystic'`); that single fallback
 * line is the whole D-18 failure mode.
 * @param {unknown} strandId
 * @returns {string}
 */
export function strandStorageDbName(strandId) {
	if (typeof strandId !== 'string' || strandId.trim().length === 0) {
		throw new EdgeNodeConfigError(
			'strandStorageDbName: strandId must be a non-empty string, got ' + JSON.stringify(strandId),
		);
	}
	const sanitized = strandId.replace(/[^A-Za-z0-9-]/g, '_');
	return `${STRAND_DB_NAME_PREFIX}${sanitized}-${shortStableDigest(strandId)}`;
}

/**
 * Opens (and wraps) this strand's per-strand IndexedDB block storage.
 * Rejected shapes, per D-18: keying by `networkHash` (silently merges the
 * day one network carries multiple strands) and a single shared store (the
 * bug itself).
 * @param {unknown} strandId
 * @returns {Promise<{ dbName: string, db: import('@optimystic/db-p2p-storage-web').OptimysticWebDBHandle, storage: InstanceType<typeof IndexedDBRawStorage> }>}
 */
export async function openStrandBlockStorage(strandId) {
	const dbName = strandStorageDbName(strandId);
	const db = await openOptimysticWebDb(dbName);
	const storage = new IndexedDBRawStorage(db);
	return { dbName, db, storage };
}

/**
 * The two protocols whose advertisement makes a peer a storage member of a
 * network (`Libp2pKeyPeerNetwork.servesThisNetwork`).
 * @param {string} networkName
 * @returns {string[]}
 */
export function storageServiceProtocols(networkName) {
	return [`/optimystic/${networkName}/cluster/1.0.0`, `/optimystic/${networkName}/repo/1.0.0`];
}

/**
 * Stop serving storage on `networkName`: unregister both storage handlers so
 * no peer counts this node into a storage group or picks it as a coordinator.
 * @param {{ unhandle(protocols: string[]): Promise<void> }} node
 * @param {string} networkName
 * @returns {Promise<void>}
 */
export async function withdrawStorageServices(node, networkName) {
	if (!node || typeof node.unhandle !== 'function') {
		throw new EdgeNodeConfigError('withdrawStorageServices: the node cannot unregister protocol handlers');
	}
	await node.unhandle(storageServiceProtocols(networkName));
}

/**
 * @typedef {object} CreateEdgeNodeConfig
 * @property {unknown} strandId
 * @property {string} networkName
 * @property {ReadonlyArray<string>} bootstrapNodes
 * @property {import('@libp2p/interface').PrivateKey} privateKey
 */

/**
 * @typedef {object} CreateEdgeNodeDeps
 * @property {typeof createLibp2pNode} [createLibp2pNode]
 * @property {typeof webSockets} [webSockets]
 * @property {typeof openStrandBlockStorage} [openStrandBlockStorage]
 */

/**
 * Constructs a browser Edge-tier libp2p node: exactly one transport
 * (`webSockets()`), `fretProfile` set to `'edge'`, the caller's injected
 * `privateKey` and `bootstrapNodes`, and a per-strand IndexedDB block
 * store. `deps` defaults to the real implementations and exists so a test
 * can observe the constructed options object without booting a real node.
 *
 * An empty (or non-array) `bootstrapNodes` is rejected with
 * `EdgeNodeConfigError` BEFORE the injected `createLibp2pNode` is ever
 * called — booting a solo node with no bootstrap addresses could never
 * read anything (D-13's no-fallback posture, applied here).
 *
 * @param {CreateEdgeNodeConfig} config
 * @param {CreateEdgeNodeDeps} [deps]
 * @returns {Promise<{
 *   node: Awaited<ReturnType<typeof createLibp2pNode>>,
 *   dbName: string,
 *   db: import('@optimystic/db-p2p-storage-web').OptimysticWebDBHandle,
 *   stop: () => Promise<void>,
 * }>}
 */
export async function createEdgeNode(config, deps) {
	const resolvedDeps = {
		createLibp2pNode: deps?.createLibp2pNode ?? createLibp2pNode,
		webSockets: deps?.webSockets ?? webSockets,
		openStrandBlockStorage: deps?.openStrandBlockStorage ?? openStrandBlockStorage,
	};

	const { strandId, networkName, bootstrapNodes, privateKey } = config;

	if (!Array.isArray(bootstrapNodes) || bootstrapNodes.length === 0) {
		throw new EdgeNodeConfigError(
			'createEdgeNode: bootstrapNodes must be a non-empty array — a solo node with no bootstrap addresses could never read anything',
		);
	}
	for (const addr of bootstrapNodes) {
		if (typeof addr !== 'string' || addr.trim().length === 0) {
			throw new EdgeNodeConfigError('createEdgeNode: every bootstrapNodes entry must be a non-empty string');
		}
	}

	// Validates strandId (throws EdgeNodeConfigError on an invalid one) as a
	// side effect of deriving the storage name — see strandStorageDbName.
	const { dbName, db, storage } = await resolvedDeps.openStrandBlockStorage(strandId);

	let node;
	try {
		node = await resolvedDeps.createLibp2pNode({
			transports: [resolvedDeps.webSockets()],
			storage,
			bootstrapNodes,
			networkName,
			fretProfile: 'edge',
			privateKey,
			// Subscriber-only cohort-topic posture (56-17; see
			// 56-17-COHORT-TOPIC-POSTURE.md). `host.profile` is what
			// `libp2p-node-base.js:1186` reads back as this node's reactivity
			// posture, and the host's own default (unset profile) is
			// `coreProfile()` -- so omitting this makes an anonymous reader's
			// browser a T3 reactivity forwarder for other readers
			// (D-08/D-09/D-10). `wantK` is deliberately left unset so both
			// sides resolve the same node-base default.
			cohortTopic: {
				enabled: true,
				host: {
					profile: edgeProfile({ willingTiers: [] }),
					minSigs: PUBLIC_COHORT_MIN_SIGS,
				},
			},
		});
	} catch (err) {
		await db.close?.();
		throw err;
	}

	// A READER, NOT A REPLICA (2026-11-03). `createLibp2pNode` registers this
	// network's two storage services on every node, and a peer that advertises
	// either is classified as serving the network (`@optimystic/db-p2p`
	// `Libp2pKeyPeerNetwork.servesThisNetwork`), so strand nodes put this
	// anonymous browser in their storage groups -- measured on real nodes: the
	// collection's root group read `[strand-node, PAGE]`. The page then held
	// blocks pushed to it, and, being half of the group the reactivity root is
	// placed on while never willing to serve, refused or short-quorumed most of
	// its own subscription registrations. Withdrawing both handlers makes it
	// 'foreign' to every node (upstream's own comment calls this the defence
	// that "keeps a future client-only node out of every cohort"); its reads are
	// outbound and unaffected. libp2p's identify push tells connected peers.
	try {
		await withdrawStorageServices(node, networkName);
	} catch (err) {
		await node?.stop?.();
		await db.close?.();
		throw err;
	}

	// 56-24: attach the diagnostic-only connection-lifecycle tap the instant
	// the node exists -- see this module header's point 8. Wrapped so a probe
	// failure can never fail node construction; the tap itself never throws,
	// this guard is belt-and-braces against a future change to the probe.
	try {
		attachConnectionLifecycleTap(node, bootstrapNodes);
	} catch {
		// Swallowed -- a diagnostic attach failure must never fail node creation.
	}

	let stopped = false;
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		try {
			await node?.stop?.();
		} catch {
			// Swallowed — mirrors the RN provider's unmount cleanup discipline.
		}
		try {
			db.close?.();
		} catch {
			// Swallowed — same discipline.
		}
	};

	return { node, dbName, db, stop };
}
