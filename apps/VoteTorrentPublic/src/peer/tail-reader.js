/**
 * tail-reader.js — the `CollectionTailReader` this page hands `node.reactivityWatch`.
 *
 * The watch service (`@optimystic/db-p2p` `ReactivityCollectionWatch`) wakes a watcher on three
 * things: a notification the cohort signed (checked against the root group's threshold before it
 * wakes anyone), a change landing in this node's own storage, and a tick at the renewal cadence that
 * reads each watched collection's committed tail and compares it with the last one. The tick needs a
 * reader, and a reader needs a transactor: `committedTailReader(transactor)`.
 *
 * The strand read handle's transactor lives inside the Optimystic plugin and is not exposed
 * (`StrandDatabase.getTransactor()` returns its NAME, `'network'`). So this module builds a second
 * `NetworkTransactor` over the same Edge node, the way the plugin builds its own
 * (`@optimystic/quereus-plugin-optimystic` `createNetworkTransactor`): the node's one key network, its
 * coordinated repo for itself and a `RepoClient` for every other peer, and the node's derived link
 * deadlines. It is used for tail reads only; nothing here pends or commits.
 *
 * One reader per page: the watch service batches a tick's reads by reader identity, so every table's
 * watch shares the reader this returns.
 */

import { NetworkTransactor } from '@optimystic/db-core';
import { RepoClient, stateHoldingsOnReads, committedTailReader, resolveLinkDeadlines } from '@optimystic/db-p2p';

/** A missing node attachment, named. Never carries a row value. */
export class TailReaderError extends Error {
	/**
	 * @param {string} subject - the node attachment or option this error concerns
	 * @param {string} reason
	 */
	constructor(subject, reason) {
		super(`tail-reader: ${reason} (subject: "${subject}")`);
		this.name = 'TailReaderError';
		this.subject = subject;
	}
}

/**
 * Build the page's one tail reader over `node`.
 * @param {any} node - a running Edge `OptimysticNode` (`createEdgeNode`'s node)
 * @param {string} networkName - the name the node was built with; the protocol prefix is `/optimystic/<networkName>`
 * @returns {import('@optimystic/db-p2p').CollectionTailReader}
 */
export function createPageTailReader(node, networkName) {
	if (!node) throw new TailReaderError('node', 'a running node is required');
	if (!networkName) throw new TailReaderError('networkName', 'the network name is required');
	const { keyNetwork, coordinatedRepo } = node;
	if (!keyNetwork) throw new TailReaderError('keyNetwork', 'the node carries no keyNetwork attachment');
	if (!coordinatedRepo) throw new TailReaderError('coordinatedRepo', 'the node carries no coordinatedRepo attachment');

	const protocolPrefix = `/optimystic/${networkName}`;
	const selfId = node.peerId.toString();
	const localStore = node.storageRepo;
	/**
	 * The transactor hands over db-core's minimal peer id; the cohort members it names are libp2p peers
	 * this node's key network found, which is what `RepoClient` dials (the plugin passes them the same way).
	 * @param {import('@optimystic/db-core').PeerId} peerId
	 * @returns {import('@optimystic/db-core').IRepo}
	 */
	const getRepo = (peerId) => {
		if (peerId.toString() === selfId) return coordinatedRepo;
		const remote = RepoClient.create(/** @type {any} */ (peerId), keyNetwork, protocolPrefix);
		return localStore ? stateHoldingsOnReads(remote, localStore) : remote;
	};
	const { dialTimeoutMs, transactionTimeoutMs, retryBackoffBaseMs } = node.linkDeadlines ?? resolveLinkDeadlines();
	const transactor = new NetworkTransactor({
		timeoutMs: transactionTimeoutMs,
		abortOrCancelTimeoutMs: Math.max(5000, dialTimeoutMs),
		dialTimeoutMs,
		retryBackoffBaseMs,
		keyNetwork,
		getRepo,
		localChangeNotifier: node.blockChangeNotifier,
		localPeerId: node.peerId,
		clock: node.hlcClock,
	});
	return committedTailReader(transactor);
}
