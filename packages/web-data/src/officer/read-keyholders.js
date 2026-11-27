/**
 * read-keyholders.js — the per-row keyholder roster: WHO holds a key for this
 * election revision, by name. Officer audience only.
 *
 * WHY THIS FILE LIVES HERE AND NOT ONE DIRECTORY OVER — this is D-04's whole
 * argument made concrete. `Keyholder` is classified PUBLIC (it names who holds
 * a key) but `User` is classified AGGREGATE (counts only: a full key-to-user
 * listing is an identity graph). Joining the two to surface a per-row NAME is
 * therefore an officer capability, and it is exactly the query D-04 names when
 * it says the audience split must make a forbidden read UNREACHABLE rather than
 * merely UNDETECTED. Its public counterpart is
 * `packages/web-data/src/public/read-keyrelease.js`, which answers the same
 * subject — key release — with counts alone.
 *
 * NO `assertPublicSafe` CALL HERE, DELIBERATELY. It would PASS (`Keyholder` is
 * PUBLIC, `User` is AGGREGATE) while this query is per-row, and a guard that
 * passes for the wrong reason is worse than no guard: the next reader would
 * take the green as evidence this module is publishable. What makes this module
 * officer-only is the SUBPATH BOUNDARY — it is exported from `officer/index.js`
 * and from nowhere under `src/public/` — not a predicate. `classOf` IS called
 * over each table below, so an unclassified table still breaks loudly.
 *
 * PUBLISHED, NOT VALID (D-17): the roster carries each keyholder's `ReleasedAt` from a real
 * `KeyholderShareRelease` row, or null. SQL cannot run `validateReleasedShare` (the share against the
 * published group commitments) or re-verify a replicated row's signature, so a non-null `ReleasedAt`
 * means "a release row was PUBLISHED", never "a valid share was released". The VALIDATED count is
 * `KeyReleaseEngine.getKeyReleaseStatus().releasedCount` (62-20), which is what the Voter shows.
 * `KeyholderShareRelease` is PUBLIC (settling/closed), so adding it changes nothing about this
 * module's officer-only placement, which stays structural (the subpath boundary).
 *
 * RULE R4 (bound parameters only): the SQL string in this module is a plain
 * template with NO `${` inside it; every value that varies arrives through a
 * named bind. RULE R4, ADDENDUM: `:limit`, `:desc`, `:group`, `:order` and
 * `:type` parse as keywords, not parameters, so no bind may carry those names.
 */

import { classOf } from '../classification.js';

/** @type {'officer/read-keyholders.js'} */
const MODULE_LABEL = 'officer/read-keyholders.js';

/** Keyholder (PUBLIC) joined to User (AGGREGATE), left-joined to KeyholderShareRelease (PUBLIC). The set is officer-only by placement — see the header. @type {ReadonlyArray<string>} */
export const TABLES_READ = Object.freeze(['Keyholder', 'User', 'KeyholderShareRelease']);

/** @type {string} */
export const KEYHOLDER_ROSTER_SQL =
	`select K.UserId, U.Name, S.ReleasedAt from Keyholder K join User U on U.Id = K.UserId left join KeyholderShareRelease S on S.ElectionId = K.ElectionId and S.ElectionRevision = K.ElectionRevision and S.UserId = K.UserId where K.ElectionId = :electionId and K.ElectionRevision = :revision order by U.Name asc, K.UserId asc`;

/**
 * @typedef {object} KeyholderRosterRow
 * @property {string} UserId
 * @property {string} Name
 * @property {string | null} ReleasedAt ISO-Z `ReleasedAt` of a PUBLISHED `KeyholderShareRelease` row for this keyholder, or null. Published, NOT validated — see the header.
 */

/**
 * Every keyholder of record for one election revision, by name.
 *
 * @param {import('@quereus/quereus').Database} db
 * @param {string} electionId
 * @param {number} revision
 * @returns {Promise<KeyholderRosterRow[]>}
 */
export async function readKeyholders(db, electionId, revision) {
	/** @type {KeyholderRosterRow[]} */
	const rows = [];
	for await (const r of db.eval(KEYHOLDER_ROSTER_SQL, { electionId, revision: Number(revision) })) {
		const row = /** @type {KeyholderRosterRow} */ (/** @type {unknown} */ (r));
		rows.push({ ...row, ReleasedAt: row.ReleasedAt ?? null });
	}
	return rows;
}

for (const table of TABLES_READ) {
	try {
		classOf(table);
	} catch (cause) {
		throw new Error(`${MODULE_LABEL} declares a table the classification does not know: ${table}`, { cause });
	}
}
