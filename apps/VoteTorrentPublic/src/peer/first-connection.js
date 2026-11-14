/**
 * first-connection.js -- wait, bounded, for the Edge node's first peer
 * connection before anything reads the strand (todo 2026-11-13, "boot races
 * the first connection").
 *
 * WHY. `createEdgeNode` returns as soon as the libp2p node is built; its
 * bootstrap dial is still in flight. Opening the strand read handle at that
 * moment asks for a coordinator while the node knows no peer, and the read
 * fails at once ("No coordinator available for key ... none of them is
 * connected"). The boot then unwinds and stops the node, which also aborts the
 * dial that was about to land. On the real network the dial has usually landed
 * first (~0.2 s), so the page has been winning a race, not relying on an
 * order. Seen every time against a loopback gateway (the D-11 gate draft).
 *
 * WHAT. Resolves `{ connected: true }` as soon as the node holds any open
 * connection (already open, or the next `connection:open` event), or
 * `{ connected: false }` once `timeoutMs` passes. One connection is enough:
 * the bootstrap peers are strand peers, and the strand's own routing takes it
 * from there. NEVER THROWS, NEVER REJECTS, and always removes its listener.
 * A node with neither `getConnections` nor `addEventListener` can never be
 * seen to connect, so it waits out the timeout and reports not connected.
 */

/** How long a boot waits for its first connection before giving up. */
export const FIRST_CONNECTION_TIMEOUT_MS = 10_000;

/**
 * @param {any} node a libp2p node (`getConnections`, `addEventListener`, `removeEventListener`)
 * @param {{ timeoutMs?: number, setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (handle: any) => void }} [options]
 * @returns {Promise<{ connected: boolean }>}
 */
export function waitForFirstConnection(node, options = {}) {
	const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs >= 0 ? options.timeoutMs : FIRST_CONNECTION_TIMEOUT_MS;
	const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
	const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));

	const hasOpenConnection = () => {
		try {
			const conns = typeof node?.getConnections === 'function' ? node.getConnections() : [];
			return Array.isArray(conns) && conns.length > 0;
		} catch {
			return false;
		}
	};

	return new Promise((resolve) => {
		if (hasOpenConnection()) {
			resolve({ connected: true });
			return;
		}
		let settled = false;
		/** @type {any} */
		let timer = null;
		const canListen = typeof node?.addEventListener === 'function';
		const onOpen = () => finish(true);
		/** @param {boolean} connected */
		function finish(connected) {
			if (settled) return;
			settled = true;
			if (timer !== null) clearTimer(timer);
			if (canListen && typeof node.removeEventListener === 'function') {
				try {
					node.removeEventListener('connection:open', onOpen);
				} catch {
					// Swallowed: the wait never throws.
				}
			}
			resolve({ connected });
		}
		if (canListen) {
			try {
				node.addEventListener('connection:open', onOpen);
			} catch {
				// Swallowed: falls back to the timeout.
			}
		}
		timer = setTimer(() => finish(hasOpenConnection()), timeoutMs);
		// A connection that opened between the first check and the listener.
		if (hasOpenConnection()) finish(true);
	});
}
