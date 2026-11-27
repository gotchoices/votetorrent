/**
 * coordinator-wait.js -- retry opening the strand read handle, bounded, while
 * no connected peer has yet been confirmed to serve the strand.
 *
 * WHY. `first-connection.js` waits for the node's first connection to ANY
 * peer. On a real network that first peer is usually the relay: the page dials
 * the strand member THROUGH it (`/p2p-circuit`), so the relay connection lands
 * first and the member's a moment later. The relay does not serve the strand's
 * cluster/repo protocols, so opening the read handle at that moment makes
 * db-p2p's `findCoordinator` throw `FindCoordinatorError` with code
 * `NO_NETWORK_COORDINATOR` ("the remaining candidate peer(s) are foreign or
 * not-yet-confirmed to serve this network's cluster/repo protocol"). Seen on
 * 6/6 fresh loads against a real election, about 1.6 s after start
 * (2026-11-16), and nothing retried, so every load failed.
 *
 * WHAT. Calls `open()`; when it throws a coordinator miss, waits
 * `delayMs` and calls it again, until `timeoutMs` has passed. Any other error
 * is rethrown at once. Out of time, it throws `NoCoordinatorError` (subject
 * `no-coordinator`) carrying the last miss as its `cause`.
 *
 * The same rule cadre-core's joiner build follows (our patch's
 * `isJoinerCoordinatorMiss`, `.yarn/patches/@serfab-cadre-core-*`): the two
 * codes are matched by name and code along the `cause` chain, because the
 * typed class can come from a second loaded copy of db-p2p. Each failed
 * attempt must release what it built (`openStrandReadHandle` closes its
 * half-built `StrandDatabase`); the node itself stays up, so its dials keep
 * landing between attempts.
 */

/** How long boot keeps retrying before it gives up on finding a coordinator. */
export const COORDINATOR_WAIT_MS = 20_000;
/** The pause between two attempts. */
export const COORDINATOR_RETRY_DELAY_MS = 1_000;

/** The two `FindCoordinatorError` codes a later attempt can improve on. */
export const COORDINATOR_MISS_CODES = Object.freeze(['NO_NETWORK_COORDINATOR', 'NO_COORDINATOR_AVAILABLE']);

/** Out of time with no coordinator found. Carries no message from the network. */
export class NoCoordinatorError extends Error {
	/**
	 * @param {number} attempts
	 * @param {unknown} cause
	 */
	constructor(attempts, cause) {
		super(`no peer serving this strand was found after ${attempts} attempt(s) (subject: "no-coordinator")`, { cause });
		this.name = 'NoCoordinatorError';
		this.subject = 'no-coordinator';
		this.attempts = attempts;
	}
}

/**
 * Whether `err`, or any error on its `cause` chain, is a coordinator miss.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isCoordinatorMiss(err) {
	/** @type {unknown[]} */
	const seen = [];
	let current = err;
	while (current && typeof current === 'object' && !seen.includes(current)) {
		seen.push(current);
		const link = /** @type {{ name?: unknown, code?: unknown, cause?: unknown }} */ (current);
		if (link.name === 'FindCoordinatorError' && typeof link.code === 'string' && COORDINATOR_MISS_CODES.includes(link.code)) {
			return true;
		}
		current = link.cause;
	}
	return false;
}

/**
 * @template T
 * @param {() => Promise<T>} open
 * @param {{ timeoutMs?: number, delayMs?: number, sleep?: (ms: number) => Promise<void>, now?: () => number }} [options]
 * @returns {Promise<T>}
 */
export async function openWhenCoordinatorFound(open, options = {}) {
	const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs >= 0 ? options.timeoutMs : COORDINATOR_WAIT_MS;
	const delayMs = typeof options.delayMs === 'number' && options.delayMs >= 0 ? options.delayMs : COORDINATOR_RETRY_DELAY_MS;
	const sleep = options.sleep ?? ((/** @type {number} */ ms) => new Promise((done) => setTimeout(done, ms)));
	const now = options.now ?? (() => Date.now());

	const start = now();
	let attempts = 0;
	for (;;) {
		attempts += 1;
		try {
			return await open();
		} catch (err) {
			if (!isCoordinatorMiss(err)) throw err;
			if (now() - start + delayMs > timeoutMs) throw new NoCoordinatorError(attempts, err);
		}
		await sleep(delayMs);
	}
}
