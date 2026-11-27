/**
 * ballots.js -- the `ceb` read surface: ballots and their questions for the
 * active election, with per-question option counts.
 *
 * RULE R4 (bound parameters only) and inherited-spec item 4 (raw-handle
 * reads are correct here) apply exactly as documented at the top of
 * `./elections.js` -- see that header for the full reasoning; it is not
 * repeated verbatim in every module.
 *
 * RESERVED-WORD BIND NAMES: `desc`, `group`, `order` and `type` are all SQL
 * keywords -- Quereus rejects `:desc` (and the like) after a parameter
 * prefix with "Expected identifier or number after parameter prefix", a
 * parse error naming no column and no statement
 * (`.planning/spikes/078-authority-dashboard-prototype/src/engine.js:131-135`).
 * `Question.Grouping` is quoted exactly as the schema spells it and bound
 * as `:grp`, never `:group`.
 */

import { CAPABILITY_TABLES } from './capability-tables.js';

/** The four `ceb` tables this module covers, read from `capability-tables.js`'s generated `CAPABILITY_TABLES.ballotsQuestions` field -- so there is exactly one list. @type {ReadonlyArray<string>} */
export const TABLES_READ = Object.freeze([...CAPABILITY_TABLES.ballotsQuestions]);

/**
 * @typedef {object} BallotRow
 * @property {string} Id
 * @property {string} Description
 * @property {string[]} Districts
 */

/**
 * @param {import('@quereus/quereus').Database} db
 * @param {string} electionId
 * @returns {Promise<BallotRow[]>}
 */
export async function readBallots(db, electionId) {
	/** @type {BallotRow[]} */
	const out = [];
	for await (const r of db.eval(
		`select Id, Description, Districts from Ballot where ElectionId = :electionId order by Id`,
		{ electionId },
	)) {
		/** @type {string[]} */
		let districts = [];
		try {
			const parsed = JSON.parse(/** @type {string} */ (r.Districts));
			if (Array.isArray(parsed)) districts = parsed;
		} catch {
			districts = [];
		}
		out.push({ Id: /** @type {string} */ (r.Id), Description: /** @type {string} */ (r.Description), Districts: districts });
	}
	return out;
}

/**
 * @typedef {object} QuestionRow
 * @property {string} BallotId
 * @property {string} Code
 * @property {string} Title
 * @property {string} TypeName
 * @property {unknown} OptionRange - raw column value: pg form `{min, max}` (vote-engine formatPgRange), or legacy JSON; read it with `parseOptionRange`
 * @property {number} Required
 * @property {string | null} Grouping
 * @property {number} OptionCount
 */

/**
 * @param {unknown} v
 * @returns {boolean}
 */
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

/**
 * Read a `Question.OptionRange` column value into `{min, max}`. Never throws.
 *
 * The column is written in the pg form `{min, max}` (vote-engine
 * `formatPgRange`). Confirmed rows written before UAT 62 gap 1 hold a JSON
 * object (`{"min":1,"max":1}`) and are signed, so they cannot be rewritten;
 * both forms are read here. Anything else yields null.
 *
 * @param {unknown} raw
 * @returns {{min: number, max: number} | null}
 */
export function parseOptionRange(raw) {
	/** @type {unknown} */
	let v = raw;
	if (typeof raw === 'string') {
		const s = raw.trim();
		const m = /^\{(\s*-?\d+)\s*,\s*(-?\d+\s*)\}$/.exec(s);
		if (m) return { min: Number(m[1]), max: Number(m[2]) };
		try {
			v = JSON.parse(s);
		} catch {
			return null;
		}
	}
	if (v && typeof v === 'object' && !Array.isArray(v)) {
		const { min, max } = /** @type {{min?: unknown, max?: unknown}} */ (v);
		if (isInt(min) && isInt(max)) return { min: /** @type {number} */ (min), max: /** @type {number} */ (max) };
	}
	return null;
}

/**
 * @param {import('@quereus/quereus').Database} db
 * @param {string} electionId
 * @returns {Promise<QuestionRow[]>}
 */
export async function readQuestions(db, electionId) {
	/** @type {QuestionRow[]} */
	const out = [];
	for await (const r of db.eval(
		`select Q.BallotId, Q.Code, Q.Title, QT.Name as TypeName, Q.OptionRange, Q.Required, Q.Grouping,
		        coalesce(OC.OptionCount, 0) as OptionCount
		 from Question Q
		 join Ballot B on B.Id = Q.BallotId
		 join QuestionType QT on QT.Code = Q.Type
		 left join (
		   select BallotId, QuestionCode, count(*) as OptionCount from Option group by BallotId, QuestionCode
		 ) OC on OC.BallotId = Q.BallotId and OC.QuestionCode = Q.Code
		 where B.ElectionId = :electionId
		 order by Q.BallotId, Q.Sequence, Q.Code`,
		{ electionId },
	)) {
		out.push(/** @type {QuestionRow} */ (r));
	}
	return out;
}

/**
 * @param {import('@quereus/quereus').Database} db
 * @returns {Promise<number>}
 */
export async function countBallotSigningTasks(db) {
	const row = await db.prepare(`select count(*) as c from BallotSignatureTaskExtension`).get({});
	return /** @type {number} */ (row?.c ?? 0);
}
