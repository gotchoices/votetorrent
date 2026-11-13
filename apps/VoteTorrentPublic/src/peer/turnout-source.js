/**
 * turnout-source.js -- the hand-off between the peer boot (which holds the
 * strand read handle) and the page (which shows ballots cast so far), 56-31.
 *
 * The boot registers ONE reader for the network it serves once it has
 * STARTED, and removes it when it stops; the page asks `countTurnout`. The
 * reader runs `readNetworkTurnout` against the strand read handle, so the
 * count comes from the network and no vote block is stored in the browser
 * (user decision 2026-11-13, "Count on the network").
 *
 * A page-global holder rather than a value threaded through the boot result:
 * the boot result's shape is pinned by its own tests and the page reads
 * turnout from a different component than the one that owns the boot. Only
 * one boot runs per page, and a reader registered for another network is
 * never used.
 *
 * Never throws; a failure is reported by its error NAME only.
 */

/** @typedef {{ state: 'counted', votes: number, blocks: number } | { state: 'unavailable', errorName: string | null }} TurnoutCount */

/** @type {{ networkHash: string, read: (electionId: string) => Promise<{ votes: number, blocks: number }> } | null} */
let current = null;

/**
 * @param {string} networkHash
 * @param {(electionId: string) => Promise<{ votes: number, blocks: number }>} read
 * @returns {() => void} unregister (a no-op once another reader replaced this one)
 */
export function registerTurnoutReader(networkHash, read) {
	const entry = { networkHash, read };
	current = entry;
	return () => {
		if (current === entry) current = null;
	};
}

/**
 * @param {string} networkHash
 * @param {string} electionId
 * @returns {Promise<TurnoutCount>}
 */
export async function countTurnout(networkHash, electionId) {
	const entry = current;
	if (!entry || entry.networkHash !== networkHash || typeof electionId !== 'string' || electionId === '') {
		return { state: 'unavailable', errorName: null };
	}
	try {
		const r = await entry.read(electionId);
		const votes = Number(r?.votes);
		const blocks = Number(r?.blocks);
		if (!Number.isSafeInteger(votes) || !Number.isSafeInteger(blocks) || votes < 0 || blocks < 0) {
			return { state: 'unavailable', errorName: 'TurnoutShapeError' };
		}
		return { state: 'counted', votes, blocks };
	} catch (err) {
		const name = err && typeof (/** @type {any} */ (err).name) === 'string' ? /** @type {any} */ (err).name : 'Error';
		return { state: 'unavailable', errorName: name };
	}
}
