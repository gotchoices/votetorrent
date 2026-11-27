/**
 * change-marks.js -- which rows of a live panel to mark as freshly changed.
 *
 * A changed row is marked only after the panel's first render and only when
 * the caller says the pass is eligible: never during the first catch-up and
 * never for a load from the local copy, so opening a dashboard never causes a
 * wall of marks. More than ROW_MARK_CAP changes marks the panel header
 * instead of the rows. A delete removes the row at once and marks the header.
 *
 * The 4000 ms lifetime and the 2500 ms fade are exported for the React layer
 * to apply; this module holds no timers and reads no clock. It has no imports.
 * Errors carry fixed text, because a row key can identify a registrant.
 */

/** More changed rows than this collapse into one header mark. */
export const ROW_MARK_CAP = 25;
/** How long a row mark stays (milliseconds). */
export const MARK_LIFETIME_MS = 4_000;
/** How long the fade at the end of the lifetime takes (milliseconds). */
export const MARK_FADE_MS = 2_500;

/**
 * @typedef {object} MarkResult
 * @property {string[]} marked keys to mark, in `next` order
 * @property {number} removedCount rows present before and gone now
 * @property {boolean} headerMarked
 * @property {Map<string, string>} nextIndex key to signature for the rows just rendered
 */

/**
 * @param {Map<string, string> | null} prevIndex what the previous render showed, or null on the first render
 * @param {Array<{ key: string, sig: string }>} next the rows about to render
 * @param {{ eligible: boolean }} options
 * @returns {MarkResult}
 */
export function diffForMarks(prevIndex, next, options) {
	if (!Array.isArray(next)) throw new TypeError('diffForMarks: invalid rows');
	if (prevIndex !== null && !(prevIndex instanceof Map)) throw new TypeError('diffForMarks: invalid index');
	/** @type {string[]} */
	const order = [];
	const nextIndex = new Map();
	for (const row of next) {
		if (row === null || typeof row !== 'object' || typeof row.key !== 'string' || typeof row.sig !== 'string') {
			throw new TypeError('diffForMarks: invalid rows');
		}
		if (!nextIndex.has(row.key)) order.push(row.key);
		nextIndex.set(row.key, row.sig);
	}
	if (prevIndex === null || options?.eligible !== true) {
		return { marked: [], removedCount: 0, headerMarked: false, nextIndex };
	}
	const changed = order.filter((key) => prevIndex.get(key) !== nextIndex.get(key));
	let removedCount = 0;
	for (const key of prevIndex.keys()) {
		if (!nextIndex.has(key)) removedCount += 1;
	}
	const overCap = changed.length > ROW_MARK_CAP;
	return {
		marked: overCap ? [] : changed,
		removedCount,
		headerMarked: removedCount > 0 || overCap,
		nextIndex,
	};
}
