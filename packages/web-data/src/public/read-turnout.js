/**
 * read-turnout.js -- ballots cast so far, counted ON THE NETWORK (56-31, gap A
 * filled).
 *
 * USER DECISION 2026-11-13 ("Count on the network"): `VoteBlock` is AGGREGATE
 * (counts yes, rows no: a row carries the block's voter registrant ids and the
 * encrypted ballots). Its rows are NOT replicated into a visitor's browser:
 * this read runs against the page's strand read handle, and only two numbers
 * come back -- how many vote blocks are committed for the election's current
 * revision, and how many votes they hold (`sum(EntryCount)`).
 *
 * The select list is aggregate functions only (the query-shape gate holds it
 * to that, like D-14's key-release aggregate). The current revision is picked
 * in the WHERE clause, never in the select list (`selectListOf` refuses a
 * subquery there by design).
 *
 * NOT IN `PUBLIC_SUBSCRIBED_TABLES`: `subscribe.js` derives the replicated set
 * from the OTHER read modules; this one is deliberately left out, which is the
 * whole point of the decision above.
 */

import { assertPublicSafe, assertNoIdentifyingColumns } from '../classification.js';

const MODULE_LABEL = 'public/read-turnout.js';

export const TABLES_READ = Object.freeze(['VoteBlock', 'ElectionRevision']);

export const PUBLIC_TURNOUT_SQL =
	'select count(*) as blocks, sum(EntryCount) as votes from VoteBlock where ElectionId = :electionId and ElectionRevision = (select max(Revision) from ElectionRevision where ElectionId = :electionId)';

/**
 * @typedef {object} PublicTurnout
 * @property {number} blocks - committed vote blocks for the current revision
 * @property {number} votes - votes in those blocks
 */

/**
 * @param {any} strandDb the strand read handle's database (NOT the page's local store)
 * @param {string} electionId
 * @returns {Promise<Readonly<PublicTurnout>>}
 */
export async function readNetworkTurnout(strandDb, electionId) {
	/** @type {any} */
	let row = null;
	for await (const r of strandDb.eval(PUBLIC_TURNOUT_SQL, { electionId })) {
		row = r;
		break;
	}
	const blocks = Number(row?.blocks ?? 0);
	const votes = Number(row?.votes ?? 0);
	return Object.freeze({
		blocks: Number.isSafeInteger(blocks) && blocks >= 0 ? blocks : 0,
		votes: Number.isSafeInteger(votes) && votes >= 0 ? votes : 0,
	});
}

assertPublicSafe(TABLES_READ, MODULE_LABEL);
assertNoIdentifyingColumns(PUBLIC_TURNOUT_SQL, MODULE_LABEL);
