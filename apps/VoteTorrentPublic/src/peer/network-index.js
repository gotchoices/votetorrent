/**
 * network-index.js -- 56-29 Part B: list the elections a NETWORK holds, for a
 * link that names a network but no election.
 *
 * WHY. The index (D-34) used to list only what this browser already holds.
 * A visitor who opens `?network=<hash>` on a fresh browser holds nothing, so
 * the page showed "no elections" for a network that has some. This module
 * asks the network instead: it builds a short-lived Edge node on the strand's
 * network (the same `strand-<id>` name and the same steps `boot.js` uses),
 * opens the strand read handle, runs the public election-list query
 * (`listPublicElections`, public-safe columns only), and tears everything
 * down again.
 *
 * IT CREATES NOTHING IN THE BROWSER. No UI store is opened or created, no
 * networks registry entry and no web-storage entry is written: a link author
 * must not be able to make a stranger's browser store anything by sending a
 * network-only link (T-54-12-02 as amended by 56-26 -- a store is created only
 * after the strand proves an ADDRESSED election, which a network-only link
 * does not name). The rows come back to the caller and live only in memory.
 * (The strand read handle keeps its own block cache, `vt-edge-strand-...`,
 * exactly as it does for an election page.)
 *
 * BOUNDED RETRIES. A fresh node's first strand read can race the coordinator
 * lookup (it throws) or run before the strand has synced (it returns zero
 * rows). Both are retried up to `NETWORK_LIST_ATTEMPTS` times, spaced
 * `NETWORK_LIST_DELAY_MS` apart. Rows on any attempt win; all-empty is a
 * settled "no elections"; all-throw is FAILED.
 *
 * NEVER THROWS, NEVER LOGS A VALUE: a failure is reported by its error NAME
 * only (a strand row can carry PII, and an error message can quote one).
 */

import { loadBootstrapConfig } from './config.js';
import { loadOrCreateSessionPeerKey } from './identity.js';
import { createEdgeNode } from './edge-node.js';
import { openStrandReadHandle, strandIdForNetwork } from './strand-read.js';
import { listPublicElections } from '@votetorrent/web-data/public';
import { waitForFirstConnection } from './first-connection.js';
import { openWhenCoordinatorFound } from './coordinator-wait.js';

/** The error name a FAILED result carries when no peer connected in time. */
export const NO_PEER_CONNECTED = 'NoPeerConnected';

export const NETWORK_LIST_ATTEMPTS = 3;
export const NETWORK_LIST_DELAY_MS = 2000;

/** @type {Readonly<{ LISTED: 'LISTED', NO_ADDRESS: 'NO_ADDRESS', CONFIG_FAULT: 'CONFIG_FAULT', FAILED: 'FAILED' }>} */
export const NETWORK_LIST_STATUS = Object.freeze({
	LISTED: 'LISTED',
	NO_ADDRESS: 'NO_ADDRESS',
	CONFIG_FAULT: 'CONFIG_FAULT',
	FAILED: 'FAILED',
});

/**
 * @typedef {object} NetworkElection
 * @property {string} networkHash
 * @property {string} electionId
 * @property {string | null} title
 * @property {string} date - only for the index's merge order; never rendered.
 */

/**
 * @typedef {object} NetworkListResult
 * @property {'LISTED' | 'NO_ADDRESS' | 'CONFIG_FAULT' | 'FAILED'} status
 * @property {ReadonlyArray<NetworkElection>} elections
 * @property {string | null} errorName
 */

/** @param {any} err @returns {string} */
function nameOf(err) {
	return err && typeof err.name === 'string' && err.name !== '' ? err.name : 'Error';
}

/**
 * @param {string} networkHash
 * @param {any} rows
 * @returns {NetworkElection[]}
 */
function toNetworkElections(networkHash, rows) {
	/** @type {NetworkElection[]} */
	const out = [];
	for (const r of Array.isArray(rows) ? rows : []) {
		if (!r || typeof r.Id !== 'string' || r.Id === '') continue;
		out.push({
			networkHash,
			electionId: r.Id,
			title: typeof r.Title === 'string' ? r.Title : null,
			date: typeof r.Date === 'string' ? r.Date : '',
		});
	}
	return out;
}

/**
 * @param {'LISTED' | 'NO_ADDRESS' | 'CONFIG_FAULT' | 'FAILED'} status
 * @param {NetworkElection[]} elections
 * @param {string | null} errorName
 * @returns {Readonly<NetworkListResult>}
 */
function result(status, elections, errorName) {
	return Object.freeze({ status, elections: Object.freeze(elections.map((e) => Object.freeze(e))), errorName });
}

/**
 * @param {{ networkHash?: string | null, deps?: Record<string, any> | null }} [options]
 * @returns {Promise<Readonly<NetworkListResult>>}
 */
export async function listNetworkElections(options) {
	const opts = options && typeof options === 'object' ? options : {};
	const networkHash = typeof opts.networkHash === 'string' ? opts.networkHash : '';
	if (networkHash === '') return result(NETWORK_LIST_STATUS.NO_ADDRESS, [], null);
	const deps = opts.deps && typeof opts.deps === 'object' ? opts.deps : {};

	const r = {
		loadBootstrapConfig: deps.loadBootstrapConfig ?? loadBootstrapConfig,
		/** @type {any} */
		fetchImpl: deps.fetchImpl ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined),
		pageProtocol: deps.pageProtocol ?? (typeof globalThis.location !== 'undefined' ? globalThis.location.protocol : undefined),
		/** @type {any} */
		sessionStorage: deps.sessionStorage ?? (typeof globalThis.sessionStorage !== 'undefined' ? globalThis.sessionStorage : undefined),
		loadOrCreateSessionPeerKey: deps.loadOrCreateSessionPeerKey ?? loadOrCreateSessionPeerKey,
		createEdgeNode: deps.createEdgeNode ?? createEdgeNode,
		openStrandReadHandle: deps.openStrandReadHandle ?? openStrandReadHandle,
		listPublicElections: deps.listPublicElections ?? listPublicElections,
		waitForFirstConnection: deps.waitForFirstConnection ?? waitForFirstConnection,
		openWhenCoordinatorFound: deps.openWhenCoordinatorFound ?? openWhenCoordinatorFound,
		attempts: typeof deps.attempts === 'number' ? deps.attempts : NETWORK_LIST_ATTEMPTS,
		sleep: deps.sleep ?? ((/** @type {number} */ ms) => new Promise((done) => setTimeout(done, ms))),
	};

	/** @type {any} */
	let edgeNode = null;
	/** @type {any} */
	let strandHandle = null;
	try {
		const config = await r.loadBootstrapConfig({ fetchImpl: r.fetchImpl, pageProtocol: r.pageProtocol });
		if (!config || !config.ok) return result(NETWORK_LIST_STATUS.CONFIG_FAULT, [], null);

		const privateKey = await r.loadOrCreateSessionPeerKey(r.sessionStorage);
		const strandId = strandIdForNetwork(networkHash);
		edgeNode = await r.createEdgeNode({
			strandId,
			networkName: `strand-${strandId}`,
			bootstrapNodes: config.bootstrapNodes,
			privateKey,
		});
		const node = edgeNode && edgeNode.node;
		// Bounded wait for the first peer connection; reading the strand before
		// any dial lands fails at once (`first-connection.js`).
		const firstConnection = await r.waitForFirstConnection(node);
		if (!firstConnection || firstConnection.connected !== true) {
			return result(NETWORK_LIST_STATUS.FAILED, [], NO_PEER_CONNECTED);
		}
		// Retried while no connected peer is yet confirmed to serve the strand
		// (the first connection is often the relay; `coordinator-wait.js`).
		strandHandle = await r.openWhenCoordinatorFound(() =>
			r.openStrandReadHandle({ networkHash, node, coordinatedRepo: node && node.coordinatedRepo }),
		);

		/** @type {string | null} */
		let lastErrorName = null;
		let anyRead = false;
		for (let attempt = 1; attempt <= r.attempts; attempt += 1) {
			try {
				const rows = toNetworkElections(networkHash, await r.listPublicElections(strandHandle.db));
				anyRead = true;
				if (rows.length > 0) return result(NETWORK_LIST_STATUS.LISTED, rows, null);
			} catch (err) {
				lastErrorName = nameOf(err);
			}
			if (attempt < r.attempts) await r.sleep(NETWORK_LIST_DELAY_MS);
		}
		return anyRead
			? result(NETWORK_LIST_STATUS.LISTED, [], null)
			: result(NETWORK_LIST_STATUS.FAILED, [], lastErrorName);
	} catch (err) {
		return result(NETWORK_LIST_STATUS.FAILED, [], nameOf(err));
	} finally {
		if (strandHandle) {
			try {
				await strandHandle.close();
			} catch {
				// release is best-effort
			}
		}
		if (edgeNode) {
			try {
				await edgeNode.stop();
			} catch {
				// release is best-effort
			}
		}
	}
}
