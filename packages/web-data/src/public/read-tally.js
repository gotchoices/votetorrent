/**
 * read-tally.js -- the published results of one election revision, for the
 * public page (56-30, gap E filled).
 *
 * USER DECISION 2026-11-13: `ElectionTally` is reclassified PUBLIC (it was an
 * interim NEVER that named this phase as its owner), its row is replicated
 * like every other public table, and the page shows the TOTALS: the root
 * histogram of the officer-published tally tree, per ballot, per question,
 * per option, plus votes / invalid / excluded and the block count.
 *
 * WHAT LEAVES THIS MODULE. The select list never names the publisher's user
 * id (`assertNoIdentifyingColumns` below enforces it). `TallyJson` is read
 * whole because only the parsed root `histogram` and `size` are needed and a
 * JSON path in SQL would tie this module to the engine's JSON functions; the
 * parse keeps exactly those two fields and drops the per-block leaves and
 * nodes before anything is returned. Labels come from the ballot's own
 * `Question` and `Option` rows (both PUBLIC); a code with no label row is
 * shown as its code, never dropped.
 *
 * NOT VERIFIED HERE. The tally's signature digest binds the publisher's user
 * id, which this page does not read, so this module makes no "signed" or
 * "verified" claim: it reports what the network holds. Recomputing the tally
 * in the browser is a separate, later step.
 *
 * A missing row is a FINDING (`null`: no results published for this
 * revision). A malformed `TallyJson` throws `TallyUnreadableError` (name only,
 * never the content), which the caller turns into a card-local "couldn't be
 * read".
 */

import { assertPublicSafe, assertNoIdentifyingColumns } from '../classification.js';

const MODULE_LABEL = 'public/read-tally.js';

export const TABLES_READ = Object.freeze(['ElectionTally', 'Ballot', 'Question', 'Option']);

export const PUBLIC_TALLY_SQL =
	'select ElectionRevision, BlockRoot, TallyRoot, BlockCount, TallyJson, PublishedAt from ElectionTally where ElectionId = :electionId and ElectionRevision = :revision';

export const PUBLIC_BALLOT_LABELS_SQL = 'select Id, Description from Ballot where ElectionId = :electionId';

export const PUBLIC_QUESTION_LABELS_SQL =
	'select Q.BallotId, Q.Code, Q.Title, Q.Sequence from Question Q join Ballot B on B.Id = Q.BallotId where B.ElectionId = :electionId';

export const PUBLIC_OPTION_LABELS_SQL =
	'select O.BallotId, O.QuestionCode, O.Code, O.Title, O.Sequence from Option O join Ballot B on B.Id = O.BallotId where B.ElectionId = :electionId';

/** A stored tally whose JSON is not the shape this page can show. */
export class TallyUnreadableError extends Error {
	constructor() {
		super('read-tally: the published tally is not in a shape this page can read');
		this.name = 'TallyUnreadableError';
	}
}

/**
 * @typedef {object} PublicOptionCount
 * @property {string} code
 * @property {string} title
 * @property {number} count
 */

/**
 * @typedef {object} PublicQuestionResult
 * @property {string} code
 * @property {string} title
 * @property {number} answered
 * @property {number} blank - valid votes that left this question unanswered
 * @property {ReadonlyArray<PublicOptionCount>} options
 */

/**
 * @typedef {object} PublicUnsupportedQuestion
 * @property {string} code
 * @property {string} title
 * @property {number} answered
 */

/**
 * @typedef {object} PublicBallotResult
 * @property {string} ballotId
 * @property {string | null} description
 * @property {number} votes
 * @property {number} valid
 * @property {number} invalid
 * @property {number} excluded
 * @property {ReadonlyArray<PublicQuestionResult>} questions
 * @property {ReadonlyArray<PublicUnsupportedQuestion>} unsupported
 */

/**
 * @typedef {object} PublicResults
 * @property {number} revision
 * @property {number} blockCount
 * @property {string} blockRoot
 * @property {string} tallyRoot
 * @property {string | null} publishedAt
 * @property {ReadonlyArray<PublicBallotResult>} ballots
 */

/** @param {unknown} v @returns {number} */
function count(v) {
	const n = typeof v === 'number' ? v : Number(v);
	if (!Number.isSafeInteger(n) || n < 0) throw new TallyUnreadableError();
	return n;
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isRecord(v) {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Own-property entries only: codes are template strings that may spell `__proto__`. @param {Record<string, unknown>} obj */
function ownEntries(obj) {
	return Object.keys(obj).map((k) => /** @type {[string, unknown]} */ ([k, obj[k]]));
}

/** @param {unknown} seq */
function seqOf(seq) {
	return typeof seq === 'number' && Number.isFinite(seq) ? seq : Number.MAX_SAFE_INTEGER;
}

/**
 * @template {{ code: string, sequence: number }} T
 * @param {T[]} items
 */
function bySequenceThenCode(items) {
	return items.sort((a, b) => a.sequence - b.sequence || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

/**
 * @param {any} db
 * @param {string} sql
 * @param {Record<string, unknown>} binds
 */
async function all(db, sql, binds) {
	/** @type {any[]} */
	const rows = [];
	for await (const r of db.eval(sql, binds)) rows.push(r);
	return rows;
}

/**
 * The published results for one election revision, or `null` when none is
 * published.
 *
 * @param {any} db an open handle (the page's local store)
 * @param {string} electionId
 * @param {number} revision
 * @returns {Promise<Readonly<PublicResults> | null>}
 */
export async function readPublishedResults(db, electionId, revision) {
	const binds = { electionId, revision: Number(revision) };
	const tally = await db.prepare(PUBLIC_TALLY_SQL).get(binds);
	if (!tally) return null;

	/** @type {any} */
	let parsed;
	try {
		parsed = JSON.parse(String(tally.TallyJson));
	} catch {
		throw new TallyUnreadableError();
	}
	if (!isRecord(parsed) || !isRecord(parsed.histogram) || !isRecord(parsed.histogram.ballots)) throw new TallyUnreadableError();

	const labelBinds = { electionId };
	const ballotRows = await all(db, PUBLIC_BALLOT_LABELS_SQL, labelBinds);
	const questionRows = await all(db, PUBLIC_QUESTION_LABELS_SQL, labelBinds);
	const optionRows = await all(db, PUBLIC_OPTION_LABELS_SQL, labelBinds);

	/** @type {Map<string, string | null>} */
	const ballotDescription = new Map(ballotRows.map((r) => [String(r.Id), typeof r.Description === 'string' ? r.Description : null]));
	/** @type {Map<string, { title: string, sequence: number }>} */
	const questionLabel = new Map(
		questionRows.map((r) => [`${r.BallotId}\u0000${r.Code}`, { title: typeof r.Title === 'string' ? r.Title : String(r.Code), sequence: seqOf(r.Sequence) }]),
	);
	/** @type {Map<string, { title: string, sequence: number }>} */
	const optionLabel = new Map(
		optionRows.map((r) => [
			`${r.BallotId}\u0000${r.QuestionCode}\u0000${r.Code}`,
			{ title: typeof r.Title === 'string' ? r.Title : String(r.Code), sequence: seqOf(r.Sequence) },
		]),
	);

	/** @type {PublicBallotResult[]} */
	const ballots = [];
	for (const [ballotId, raw] of ownEntries(/** @type {Record<string, unknown>} */ (parsed.histogram.ballots))) {
		if (!isRecord(raw)) throw new TallyUnreadableError();
		const votes = count(raw.votes);
		const invalid = count(raw.invalid);
		const excluded = count(raw.excluded);
		const valid = votes - invalid - excluded;
		if (valid < 0) throw new TallyUnreadableError();

		const questions = bySequenceThenCode(
			ownEntries(isRecord(raw.questions) ? raw.questions : {}).map(([code, q]) => {
				if (!isRecord(q) || !isRecord(q.options)) throw new TallyUnreadableError();
				const answered = count(q.answered);
				const label = questionLabel.get(`${ballotId}\u0000${code}`);
				const options = bySequenceThenCode(
					ownEntries(q.options).map(([optionCode, n]) => {
						const ol = optionLabel.get(`${ballotId}\u0000${code}\u0000${optionCode}`);
						return { code: optionCode, title: ol ? ol.title : optionCode, count: count(n), sequence: ol ? ol.sequence : Number.MAX_SAFE_INTEGER };
					}),
				).map(({ code: c, title, count: n }) => Object.freeze({ code: c, title, count: n }));
				return {
					code,
					title: label ? label.title : code,
					answered,
					blank: Math.max(0, valid - answered),
					options: Object.freeze(options),
					sequence: label ? label.sequence : Number.MAX_SAFE_INTEGER,
				};
			}),
		).map(({ sequence: _s, ...q }) => Object.freeze(q));

		const unsupported = bySequenceThenCode(
			ownEntries(isRecord(raw.unsupported) ? raw.unsupported : {}).map(([code, n]) => {
				const label = questionLabel.get(`${ballotId}\u0000${code}`);
				return { code, title: label ? label.title : code, answered: count(n), sequence: label ? label.sequence : Number.MAX_SAFE_INTEGER };
			}),
		).map(({ sequence: _s, ...u }) => Object.freeze(u));

		ballots.push(
			Object.freeze({
				ballotId,
				description: ballotDescription.has(ballotId) ? /** @type {string | null} */ (ballotDescription.get(ballotId)) : null,
				votes,
				valid,
				invalid,
				excluded,
				questions: Object.freeze(questions),
				unsupported: Object.freeze(unsupported),
			}),
		);
	}
	ballots.sort((a, b) => (a.ballotId < b.ballotId ? -1 : a.ballotId > b.ballotId ? 1 : 0));

	return Object.freeze({
		revision: Number(tally.ElectionRevision),
		blockCount: count(tally.BlockCount),
		blockRoot: String(tally.BlockRoot),
		tallyRoot: String(tally.TallyRoot),
		publishedAt: typeof tally.PublishedAt === 'string' ? tally.PublishedAt : null,
		ballots: Object.freeze(ballots),
	});
}

assertPublicSafe(TABLES_READ, MODULE_LABEL);
for (const sql of [PUBLIC_TALLY_SQL, PUBLIC_BALLOT_LABELS_SQL, PUBLIC_QUESTION_LABELS_SQL, PUBLIC_OPTION_LABELS_SQL]) {
	assertNoIdentifyingColumns(sql, MODULE_LABEL);
}
