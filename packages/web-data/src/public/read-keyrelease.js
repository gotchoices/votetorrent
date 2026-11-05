/**
 * read-keyrelease.js — D-14: "N of M keyholders have released a key", with no
 * task row exposed. The one genuinely live fact during the ~13-day settling
 * window, filled by an aggregate rather than left as a gap (087 gap D).
 *
 * RULE R4 (bound parameters only): every SQL string in this module is a
 * plain template with NO `${` inside it. Every value that varies arrives
 * through `.get({...})` / `db.eval(sql, {...})` named binds.
 *
 * RULE R4, ADDENDUM (reserved bind NAMES): `:limit`, `:desc`, `:group`,
 * `:order` and `:type` parse as KEYWORDS, not parameters, in this engine. That
 * addendum is not academic here — see point 2 below.
 *
 * THREE LOAD-BEARING FACTS ABOUT THE AGGREGATE STRING:
 *
 * 1. THE COUNT READS THE PUBLISHED FACT. 62-126 (62-29 open question 2): "released" is the number
 *    of `KeyholderShareRelease` rows for the election revision -- a keyholder's share is PUBLIC
 *    once published (D-17), and that row is the fact. It used to join `Task` +
 *    `ReleaseKeyTaskExtension` and sum `IsCompleted`, which measures a bookkeeping task: a share
 *    published without a completed task read as unreleased, and a task completed without a
 *    published share read as released. Like the officer roster (`officer/read-keyholders.js`),
 *    the figure means PUBLISHED, NOT VALIDATED: SQL cannot run `validateReleasedShare`, and
 *    reconstruction filters bogus rows (AR-62-007; T-62-126-03 accepted).
 *    `KeyholderShareRelease` is PUBLIC for the settling and closed phases (AR-62-095), the only
 *    phases this fact is live in.
 *
 * 2. THE COUNT IS ON THE PRIMARY-KEY PREFIX. `(ElectionId, ElectionRevision, UserId)` is the
 *    key, so `ElectionId = :electionId and ElectionRevision = :revision` is a key-prefix count.
 *    Equality predicates only: this engine returns zero rows for `AND` + `IN` (memory
 *    project_quereus_and_in_predicate_zero_rows), and no bind is a reserved name.
 *
 * 3. ONLY COUNTS LEAVE THIS FUNCTION. Never select `UserId`, `Identifier`, `SigningShare`,
 *    `SignerKey`, `Signature` or `ReleasedAt`: any of them answers WHICH keyholder released,
 *    which D-14's "no task row exposed" forbids (54-ISSUES I-07). `assertNoIdentifyingColumns`
 *    checks the SELECT LIST at import.
 *
 * `total` is the keyholders of record (it equals `keyholderCount`): there is no longer a task
 * table to count, and the render layer says "released of keyholderCount" anyway.
 */

import { assertPublicSafe, assertNoIdentifyingColumns } from '../classification.js';

/** @type {'public/read-keyrelease.js'} */
const MODULE_LABEL = 'public/read-keyrelease.js';

/** KeyholderShareRelease (PUBLIC from settling, AR-62-095) is counted; Keyholder is PUBLIC and supplies the denominator. @type {ReadonlyArray<string>} */
export const TABLES_READ = Object.freeze(['KeyholderShareRelease', 'Keyholder']);

/** @type {string} */
export const KEYRELEASE_AGGREGATE_SQL =
	`select count(*) as released from KeyholderShareRelease where ElectionId = :electionId and ElectionRevision = :revision`;

/** @type {string} */
export const KEYHOLDER_COUNT_SQL =
	`select count(*) as keyholders from Keyholder where ElectionId = :electionId and ElectionRevision = :revision`;

/**
 * @typedef {object} KeyReleaseProgress
 * @property {number} released - PUBLISHED KeyholderShareRelease rows for this election revision (published, not validated).
 * @property {number} total - keyholders of record; equal to keyholderCount (62-126 removed the task count).
 * @property {number} keyholderCount - keyholders of record: the denominator.
 */

/**
 * D-14's fact, as three numbers.
 *
 * `released` is zero when no share row exists (`count(*)` is never null, but the result is still
 * coerced with `Number(...)` and defaulted to `0`). `revision` is bound as a NUMBER, matching
 * `KeyholderShareRelease.ElectionRevision`'s `integer` declaration.
 *
 * @param {import('@quereus/quereus').Database} db
 * @param {string} electionId
 * @param {number} revision
 * @returns {Promise<KeyReleaseProgress>}
 */
export async function readKeyReleaseProgress(db, electionId, revision) {
	const binds = { electionId, revision: Number(revision) };
	const aggregateRow = await db.prepare(KEYRELEASE_AGGREGATE_SQL).get(binds);
	const keyholderRow = await db.prepare(KEYHOLDER_COUNT_SQL).get(binds);
	const keyholderCount = Number(keyholderRow?.keyholders ?? 0) || 0;
	return {
		released: Number(aggregateRow?.released ?? 0) || 0,
		total: keyholderCount,
		keyholderCount,
	};
}

assertPublicSafe(TABLES_READ, MODULE_LABEL);
for (const sql of [KEYRELEASE_AGGREGATE_SQL, KEYHOLDER_COUNT_SQL]) {
	assertNoIdentifyingColumns(sql, MODULE_LABEL);
}
