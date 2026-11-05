/**
 * read-registrant-roll.js — D-18/D-19's voter roll: exactly three columns, for
 * one election, for a reader with no identity.
 *
 * RULE R4 (bound parameters only): every SQL string in this module is a
 * plain template with NO `${` inside it. Every value that varies arrives
 * through `.get({...})` / `db.eval(sql, {...})` named binds. The names this
 * query returns are authority-supplied text and the election id arrives from a
 * URL query string; interpolating either would make it executable.
 *
 * RULE R4, ADDENDUM (reserved bind NAMES): `:limit`, `:desc`, `:group`,
 * `:order` and `:type` parse as KEYWORDS, not parameters, in this engine. A
 * bind may never carry one of those names.
 *
 * D-19 — THE SELECT LIST IS THE WHOLE POINT. Three columns: LastName,
 * FirstName, District. Not ExtraFields (votetorrent.qsql:1818 calls it a "json
 * object for authority-specific public fields" — unconstrained,
 * authority-supplied, unreviewed, with no schema to reason about). Not Cid and
 * not RegistrantId either, even as a render key: each is a correlation handle
 * from a roll row back into Registrant, and returning exactly three fields
 * means a future render cannot surface one by accident. The caller keys the
 * list by position. All three of those names are members of
 * `IDENTIFYING_COLUMN_TOKENS`, so adding one is a crash at import.
 *
 * WHY A THREE-TABLE JOIN FOR THREE COLUMNS. `RegistrantPublic` carries no
 * ElectionId of its own, so the election scope comes from `ElectionRegistrant`
 * and the current-record pin comes from `Registrant`. This module selects NO
 * column from either of those two — they are joined for scoping and for the
 * PublicCid match only, which is what keeps their AGGREGATE classification's
 * counts-only discipline intact.
 *
 * TWO LOAD-BEARING PREDICATES, both correctness rather than taste:
 *   - `RP.Cid = R.PublicCid` — `RegistrantPublic`'s primary key is
 *     (RegistrantId, Cid) and the table is insert-only, so a registrant whose
 *     public record was reissued has MORE THAN ONE row. Without this pin the
 *     join fans out and superseded names publish alongside current ones.
 *   - `R.Status = 'a'` — the schema enforces active status only at INSERT time
 *     into `ElectionRegistrant` (votetorrent.qsql:1913). A registrant suspended
 *     or revoked afterwards would otherwise stay on a published roll forever.
 *
 * D-22 — this module does NOT read `RegistrantSelective`, and the omission is
 * enforced rather than merely intended: the everyone-audience subset needs
 * setDisclose/setVerify handling over salted leaves, no evaluator exists, and
 * the table is POLICY_GATED, which `assertPublicSafe` treats as forbidden. If a
 * later edit adds it to TABLES_READ, importing this file throws.
 */

import { assertPublicSafe, assertNoIdentifyingColumns } from '../classification.js';

/** @type {'public/read-registrant-roll.js'} */
const MODULE_LABEL = 'public/read-registrant-roll.js';

/** The three tables this module joins. RegistrantPublic is PUBLIC (D-18); ElectionRegistrant and Registrant are AGGREGATE and contribute NO selected column — see the header. @type {ReadonlyArray<string>} */
export const TABLES_READ = Object.freeze(['ElectionRegistrant', 'Registrant', 'RegistrantPublic']);

/** @type {string} */
export const REGISTRANT_ROLL_SQL =
	`select RP.LastName, RP.FirstName, RP.District from ElectionRegistrant ER join Registrant R on R.Id = ER.RegistrantId join RegistrantPublic RP on RP.RegistrantId = R.Id and RP.Cid = R.PublicCid where ER.ElectionId = :electionId and R.Status = 'a' order by RP.LastName asc, RP.FirstName asc, RP.District asc`;

/**
 * @typedef {object} RegistrantRollRow
 * @property {string | null} LastName
 * @property {string | null} FirstName
 * @property {string | null} District
 */

/**
 * The published voter roll for one election, ordered for a deterministic
 * render. Returns `[]` for an election with no registrants — an empty roll and
 * an unknown election are both ordinary states here, and neither throws.
 *
 * @param {import('@quereus/quereus').Database} db
 * @param {string} electionId
 * @returns {Promise<RegistrantRollRow[]>}
 */
export async function readRegistrantRoll(db, electionId) {
	/** @type {RegistrantRollRow[]} */
	const rows = [];
	for await (const r of db.eval(REGISTRANT_ROLL_SQL, { electionId })) {
		rows.push(/** @type {RegistrantRollRow} */ (/** @type {unknown} */ (r)));
	}
	return rows;
}

assertPublicSafe(TABLES_READ, MODULE_LABEL);
assertNoIdentifyingColumns(REGISTRANT_ROLL_SQL, MODULE_LABEL);
