/**
 * strand-progress.js -- whether the member node's strand node is still receiving the strand's data, for
 * the strand reader's wait (`strand-read.js`) to tell a slow first build from a dead one.
 *
 * WHY THIS EXISTS. cadre-core publishes a joining machine's strand database only once its first build is
 * done (`StrandInstance.database`, status `'syncing'` until then), and it exposes no event or count for
 * how far that build has got. On slow phones over the relay the build was measured going for minutes
 * while it fetched one block after another (gap G-3: 38 of 41 index trees open when a fixed 120 s wait
 * gave up). So this module counts what the strand node RECEIVES, from two sources:
 *
 * 1. ANSWERED DATA STREAMS. Every block the build fetches is one request on the strand's repo protocol,
 *    and every push or sync exchange a member makes is one stream on the strand's block-transfer or sync
 *    protocol. A stream of those protocols that closes WITHOUT an error is one exchange that completed:
 *    the peer answered. A stream that is aborted or reset (a response timeout aborts it, so does a cancel)
 *    closes WITH an error and counts nothing, so a peer that accepts streams and never answers is not
 *    progress. Read through the public libp2p interface only: `getConnections()`, `Connection.streams`,
 *    `Stream.protocol` and the stream's `close` event, whose `StreamCloseEvent.error` is set exactly when
 *    the stream did not close cleanly (`@libp2p/interface`).
 * 2. THE STRAND STORE'S CHANGE FEED. `storageRepo.onAnyCollectionChange` on the strand node: the typed
 *    host-facing attachment of an Optimystic node (`OptimysticNodeAttachments.storageRepo` in
 *    `@optimystic/db-p2p`), and the same feed cadre-core's own first-sync gate wakes on. It fires when a
 *    member's push or a read-driven promotion lands a block in this node's store.
 *
 * ADAPTER CONTRACT. The protocol names are db-p2p's (`${prefix}/repo/1.0.0`, `buildBlockTransferProtocol`,
 * `buildSyncProtocol`) under cadre-core's strand prefix `/optimystic/strand-<strandId>`, the same prefix
 * `member-node.js` withdraws the storage services under. `member-node.test.mjs` pins them against
 * db-p2p's own builders, pins `onAnyCollectionChange` against a real `StorageRepo`, and pins the clean and
 * aborted close of a real libp2p stream, so a dependency bump that renames or reshapes any of them goes red.
 *
 * Streams are seen by SAMPLING: the reader calls `sample` once per poll, and a stream is counted only if
 * it was open at one of those samples. The first build fetches serially, so one request is nearly always in
 * flight; a request that opens and completes between two samples is missed, and that only lowers the
 * count, never raises it.
 *
 * The liveness protocols (identify, FRET ping and neighbours) are left out on purpose: a phone that answers
 * pings while the build makes no headway is not progress.
 *
 * ACCEPTED RESIDUAL. A peer that answers every block request with an error reply still completes each
 * exchange cleanly, so it counts as progress. The reader's hard cap bounds that case.
 *
 * NO IMPORT-TIME WORK and no imports: module scope holds only declarations. No timers: the caller drives
 * sampling, and `stop` leaves nothing behind that can count (a close listener on a stream still open just
 * returns).
 */

/**
 * The strand's data-bearing protocols, under cadre-core's strand prefix.
 * @param {string} strandId
 * @returns {readonly string[]}
 */
export function strandDataProtocols(strandId) {
	const prefix = `/optimystic/strand-${strandId}`;
	return Object.freeze([`${prefix}/repo/1.0.0`, `${prefix}/db-p2p/block-transfer/1.0.0`, `${prefix}/db-p2p/sync/1.0.0`]);
}

/**
 * @typedef {object} StrandProgressWatch
 * @property {(node: any) => number} sample - look at the strand node now; returns the progress count so far
 * @property {() => void} stop - idempotent; unsubscribes the store feed and stops counting
 */

/**
 * Start watching. Nothing is subscribed until the first `sample` that is handed a strand node.
 *
 * @param {{ strandId: string }} options
 * @returns {StrandProgressWatch}
 */
export function watchStrandProgress({ strandId }) {
	const dataProtocols = new Set(strandDataProtocols(strandId));
	let count = 0;
	let stopped = false;
	/** @type {WeakSet<object>} */
	const seenStreams = new WeakSet();
	/** @type {any} */
	let feedRepo = null;
	/** @type {(() => void) | null} */
	let unsubscribeFeed = null;

	/** @param {any} stream @param {any} event */
	function onStreamClose(stream, event) {
		if (stopped || event?.error) return;
		if (dataProtocols.has(stream?.protocol)) count += 1;
	}

	function onStoreChange() {
		if (!stopped) count += 1;
	}

	function releaseFeed() {
		const unsubscribe = unsubscribeFeed;
		unsubscribeFeed = null;
		feedRepo = null;
		try {
			unsubscribe?.();
		} catch {
			// an unsubscribe that throws leaves nothing this module can do
		}
	}

	/** @param {any} node */
	function followFeed(node) {
		const repo = node?.storageRepo;
		if (repo === feedRepo) return;
		releaseFeed();
		if (!repo || typeof repo.onAnyCollectionChange !== 'function') return;
		const unsubscribe = repo.onAnyCollectionChange(onStoreChange);
		feedRepo = repo;
		unsubscribeFeed = typeof unsubscribe === 'function' ? unsubscribe : null;
	}

	/** @param {any} node */
	function listenToStreams(node) {
		if (typeof node?.getConnections !== 'function') return;
		for (const connection of node.getConnections() ?? []) {
			for (const stream of connection?.streams ?? []) {
				if (!stream || typeof stream !== 'object' || seenStreams.has(stream)) continue;
				seenStreams.add(stream);
				// A stream already negotiated to another protocol (a relay hop, a reactivity subscription, which
				// can stay open for hours) is never listened to, so no listener piles up on it across waits.
				if (stream.protocol && !dataProtocols.has(stream.protocol)) continue;
				if (typeof stream.addEventListener !== 'function') continue;
				// Otherwise the protocol is judged when the stream closes: a lazily negotiated stream may not carry it yet.
				stream.addEventListener('close', (/** @type {any} */ event) => onStreamClose(stream, event), { once: true });
			}
		}
	}

	return Object.freeze({
		sample(node) {
			if (stopped) return count;
			try {
				followFeed(node);
				listenToStreams(node);
			} catch {
				// A node mid-stop can throw from its accessors; that sample sees nothing new.
			}
			return count;
		},
		stop() {
			if (stopped) return;
			stopped = true;
			releaseFeed();
		},
	});
}
