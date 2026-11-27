/**
 * read-election.js — the anonymous reader's view of one election: its published
 * header, its founding revision, and the election list the no-login index needs.
 *
 * RULE R4 (bound parameters only): every SQL string in this module is a
 * plain template with NO `${` inside it. Every value that varies arrives
 * through `.get({...})` / `db.eval(sql, {...})` named binds. Registrant names,
 * ballot text and a URL-supplied election id all reach this layer as
 * externally-supplied text; interpolation would make them executable.
 *
 * RULE R4, ADDENDUM (reserved bind NAMES): `:limit`, `:desc`, `:group`,
 * `:order` and `:type` parse as KEYWORDS, not parameters, in this engine —
 * measured in 54-03b for `:limit` ("Expected identifier or number after
 * parameter prefix", naming no column and no statement). A bind may never carry
 * one of those names; rename the bind instead of interpolating the value.
 *
 * NO `ElectionType` JOIN, deliberately: `ElectionType` is one of the schema's
 * 18 static `select 'o' as Code ...` VIEWS, not a classified table, so joining
 * it to get a display name would put a name into `TABLES_READ` that `classOf`
 * cannot resolve — the gate would throw on a legitimate read. This module
 * returns the raw `Type` code and the render layer labels it. (The officer-side
 * `officer/elections.js` does join it; it runs no classification guard.)
 *
 * The three guard calls at the bottom of this file run at MODULE SCOPE, so a
 * future edit that widens this module into a forbidden table or a
 * person-identifying column is a crash at import, not a review miss.
 */

import { assertPublicSafe, assertNoIdentifyingColumns } from '../classification.js';

/** @type {'public/read-election.js'} */
const MODULE_LABEL = 'public/read-election.js';

/** The two PUBLIC-classified tables this module reads. Hand-declared per module (it is a per-module fact, not a slice of the classification), then resolved THROUGH `classification.js` by the guard below — so this list cannot drift into a forbidden table silently. @type {ReadonlyArray<string>} */
export const TABLES_READ = Object.freeze(['Election', 'ElectionRevision']);

/** @type {string} */
export const PUBLIC_ELECTION_SQL =
	`select Id, Title, Date, RevisionDeadline, BallotDeadline, Type from Election where Id = :electionId`;

/** @type {string} */
export const PUBLIC_ELECTION_REVISION_SQL =
	`select Revision, RevisionTimestamp, Tags, Instructions, Timeline, KeyholderThreshold from ElectionRevision where ElectionId = :electionId`;

/** @type {string} */
export const PUBLIC_ELECTION_LIST_SQL = `select Id, Title, Date from Election order by Date desc, Id asc`;

/**
 * @typedef {object} PublicElection
 * @property {string} Id
 * @property {string} Title
 * @property {string} Date
 * @property {string} RevisionDeadline
 * @property {string} BallotDeadline
 * @property {string} Type - the raw ElectionType code; the render layer labels it.
 */

/**
 * The published header of one election. Returns `null` when no such row
 * exists — never throws on a missing row, because "this browser holds no such
 * election" is an ordinary state for an anonymous reader whose replica was
 * seeded from a different network.
 *
 * @param {import('@quereus/quereus').Database} db
 * @param {string} electionId
 * @returns {Promise<PublicElection | null>}
 */
export async function readPublicElection(db, electionId) {
	const row = await db.prepare(PUBLIC_ELECTION_SQL).get({ electionId });
	return row ? /** @type {PublicElection} */ (/** @type {unknown} */ (row)) : null;
}

/**
 * @typedef {object} PublicElectionRevision
 * @property {number} Revision
 * @property {string} RevisionTimestamp
 * @property {string[]} Tags
 * @property {string} Instructions
 * @property {unknown} Timeline - the RAW column value, untouched. Deriving a
 *   phase from the timeline belongs to `packages/ui-web/src/lifecycle`; this
 *   module reads, it does not interpret.
 * @property {number} KeyholderThreshold
 */

/**
 * The founding `ElectionRevision` row for `electionId`. `Tags` is parsed
 * defensively — a malformed JSON array yields `[]`, never a throw, because an
 * anonymous page has no operator to surface a parse failure to.
 *
 * @param {import('@quereus/quereus').Database} db
 * @param {string} electionId
 * @returns {Promise<PublicElectionRevision | null>}
 */
export async function readPublicElectionRevision(db, electionId) {
	const row = await db.prepare(PUBLIC_ELECTION_REVISION_SQL).get({ electionId });
	if (!row) return null;

	/** @type {string[]} */
	let tags = [];
	try {
		const parsed = JSON.parse(/** @type {string} */ (row.Tags));
		if (Array.isArray(parsed)) tags = parsed;
	} catch {
		tags = [];
	}

	return {
		Revision: /** @type {number} */ (row.Revision),
		RevisionTimestamp: /** @type {string} */ (row.RevisionTimestamp),
		Tags: tags,
		Instructions: /** @type {string} */ (row.Instructions),
		Timeline: row.Timeline,
		KeyholderThreshold: /** @type {number} */ (row.KeyholderThreshold),
	};
}

/**
 * @typedef {object} PublicElectionListEntry
 * @property {string} Id
 * @property {string} Title
 * @property {string} Date
 */

/**
 * Every election this browser-local replica holds, newest election day first.
 *
 * `Election` (votetorrent.qsql:827-853) carries no creation timestamp — `Id` is
 * 32 random bytes, not monotonic — so `order by Date desc, Id asc` is the same
 * deterministic proxy `officer/elections.js` documents: furthest-out election
 * day first, ties broken by Id so two runs never disagree.
 *
 * @param {import('@quereus/quereus').Database} db
 * @returns {Promise<PublicElectionListEntry[]>}
 */
export async function listPublicElections(db) {
	/** @type {PublicElectionListEntry[]} */
	const rows = [];
	for await (const r of db.eval(PUBLIC_ELECTION_LIST_SQL, {})) {
		rows.push(/** @type {PublicElectionListEntry} */ (/** @type {unknown} */ (r)));
	}
	return rows;
}

assertPublicSafe(TABLES_READ, MODULE_LABEL);
for (const sql of [PUBLIC_ELECTION_SQL, PUBLIC_ELECTION_REVISION_SQL, PUBLIC_ELECTION_LIST_SQL]) {
	assertNoIdentifyingColumns(sql, MODULE_LABEL);
}
