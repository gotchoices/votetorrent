/**
 * elections.js -- the `mel` read surface: the active election, its founding
 * revision (the row carrying the Timeline `election-phase.js` computes
 * against), and its per-election policy counts.
 *
 * RULE R4 (bound parameters only): every SQL string in this module is a
 * plain template with NO `${` inside it. Every value that varies arrives
 * through `.get({...})` / `db.eval(sql, {...})` named binds. Spike 078's
 * `loadDashboardData` (`.planning/spikes/078-authority-dashboard-prototype/src/engine.js:163-178`)
 * built `where Id = '${AUTHORITY_ID}'` by string interpolation -- that is
 * the rejected pattern. Registrant names, ballot descriptions and question
 * titles are externally-supplied text that reaches these queries;
 * interpolation would make them executable.
 *
 * INHERITED-SPEC ITEM 4 (raw-handle reads are correct here, not a
 * precedent): the standing "write through vote-engine, never the raw
 * Quereus handle" rule binds WRITES. This phase makes none (D-01); the
 * `@votetorrent/vote-engine/browser` subpath deliberately exports no
 * domain engine (only `UserEngine`, for `isPrivileged`); and 50-06's
 * `PanelProps.db` is typed `Database` from `@quereus/quereus` on purpose.
 * Reading on the raw handle here is not a template for a future write path.
 *
 * INHERITED-SPEC ITEM 2 ("most recently created election"): `Election`
 * (votetorrent.qsql:827-853) carries no creation timestamp -- `Id` is 32
 * random bytes, not monotonic, and `ElectionRevision.RevisionTimestamp` is
 * the LATEST revision's timestamp (updated in place), not a creation time.
 * `selectActiveElection`'s `order by Date desc, Id asc` is the deterministic
 * proxy this plan adopts: the furthest-out election day, ties broken by Id
 * so two runs never disagree. This is NOT an election picker -- the
 * UI-SPEC is explicit that multi-election navigation is a later phase.
 */

import { CAPABILITY_TABLES } from './capability-tables.js';

/** The eight `mel` tables this module covers -- read from `capability-tables.js`'s generated `CAPABILITY_TABLES.elections` field rather than re-declared here, so there is exactly one list (that generator, `generate-capabilities.mjs`, is the same schema-parse run that also emits `capabilities.js`). @type {ReadonlyArray<string>} */
export const TABLES_READ = Object.freeze([...CAPABILITY_TABLES.elections]);

/**
 * @typedef {object} ActiveElection
 * @property {string} Id
 * @property {string} Title
 * @property {string} Date
 * @property {string} RevisionDeadline
 * @property {string} BallotDeadline
 * @property {string} Type
 * @property {string | null} TypeName
 */

/**
 * The election a snapshot with more than one election resolves to render,
 * per inherited-spec item 2 above. Returns `null` on a database with no
 * `Election` row -- never throws.
 *
 * @param {import('@quereus/quereus').Database} db
 * @returns {Promise<ActiveElection | null>}
 */
export async function selectActiveElection(db) {
	const row = await db
		.prepare(
			`select E.Id, E.Title, E.Date, E.RevisionDeadline, E.BallotDeadline, E.Type, ET.Name as TypeName
			 from Election E left join ElectionType ET on ET.Code = E.Type
			 order by E.Date desc, E.Id asc limit 1`,
		)
		.get({});
	return row ? /** @type {ActiveElection} */ (row) : null;
}

/**
 * @typedef {object} ElectionOverview
 * @property {number} Revision
 * @property {string} RevisionTimestamp
 * @property {string[]} Tags
 * @property {string} Instructions
 * @property {unknown} Timeline - the RAW column value, untouched. Parsing
 *   the timeline into a phase belongs to
 *   `packages/ui-web/src/lifecycle/election-phase.js` (moved there in
 *   53-05, D-01/D-02), not here -- this module reads, it does not interpret.
 * @property {number} KeyholderThreshold
 */

/**
 * Read the founding `ElectionRevision` row for `electionId`. `Tags` is
 * parsed defensively -- a malformed JSON array yields `[]`, never a throw.
 * `Timeline` is returned raw and unmodified.
 *
 * @param {import('@quereus/quereus').Database} db
 * @param {string} electionId
 * @returns {Promise<ElectionOverview | null>}
 */
export async function readElectionOverview(db, electionId) {
	const row = await db
		.prepare(
			`select Revision, RevisionTimestamp, Tags, Instructions, Timeline, KeyholderThreshold
			 from ElectionRevision where ElectionId = :electionId`,
		)
		.get({ electionId });
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
 * @typedef {object} RegistrationFieldBreakdownRow
 * @property {string} Tier
 * @property {string} TierName
 * @property {string} Requirement
 * @property {string} RequirementName
 * @property {number} Count
 */

/**
 * @typedef {object} ElectionPolicies
 * @property {number} registrationFieldCount
 * @property {number} disclosurePolicyCount
 * @property {number | null} attestationRequired - null when no
 *   `ElectionAttestationPolicy` row exists for this election.
 * @property {RegistrationFieldBreakdownRow[]} registrationFieldBreakdown
 * @property {number} pendingElectionSigningTasks - outstanding
 *   `ElectionSignatureTaskExtension` rows, network-wide (this table keys
 *   off `ProposedElection`, not the confirmed `Election` this panel
 *   otherwise reads, so it is not electionId-scoped).
 * @property {number} pendingRevisionSigningTasks - outstanding
 *   `ElectionRevisionSignatureTaskExtension` rows, network-wide, same
 *   reason as above.
 */

/**
 * @param {import('@quereus/quereus').Database} db
 * @param {string} electionId
 * @returns {Promise<ElectionPolicies>}
 */
export async function readElectionPolicies(db, electionId) {
	const registrationFieldCountRow = await db
		.prepare(`select count(*) as c from ElectionRegistrationField where ElectionId = :electionId`)
		.get({ electionId });

	const disclosurePolicyCountRow = await db
		.prepare(`select count(*) as c from ElectionDisclosurePolicy where ElectionId = :electionId`)
		.get({ electionId });

	const attestationRow = await db
		.prepare(`select AttestationRequired from ElectionAttestationPolicy where ElectionId = :electionId`)
		.get({ electionId });

	/** @type {RegistrationFieldBreakdownRow[]} */
	const registrationFieldBreakdown = [];
	for await (const r of db.eval(
		`select ERF.Tier, RT.Name as TierName, ERF.Requirement, FR.Name as RequirementName, count(*) as Count
		 from ElectionRegistrationField ERF
		 join RegistrantTier RT on RT.Code = ERF.Tier
		 join FieldRequirement FR on FR.Code = ERF.Requirement
		 where ERF.ElectionId = :electionId
		 group by ERF.Tier, RT.Name, ERF.Requirement, FR.Name`,
		{ electionId },
	)) {
		registrationFieldBreakdown.push(/** @type {RegistrationFieldBreakdownRow} */ (r));
	}

	const pendingElectionRow = await db.prepare(`select count(*) as c from ElectionSignatureTaskExtension`).get({});
	const pendingRevisionRow = await db
		.prepare(`select count(*) as c from ElectionRevisionSignatureTaskExtension`)
		.get({});

	return {
		registrationFieldCount: /** @type {number} */ (registrationFieldCountRow?.c ?? 0),
		disclosurePolicyCount: /** @type {number} */ (disclosurePolicyCountRow?.c ?? 0),
		attestationRequired: attestationRow ? /** @type {number} */ (attestationRow.AttestationRequired) : null,
		registrationFieldBreakdown,
		pendingElectionSigningTasks: /** @type {number} */ (pendingElectionRow?.c ?? 0),
		pendingRevisionSigningTasks: /** @type {number} */ (pendingRevisionRow?.c ?? 0),
	};
}

/**
 * @param {import('@quereus/quereus').Database} db
 * @returns {Promise<number>}
 */
export async function countElections(db) {
	const row = await db.prepare(`select count(*) as c from Election`).get({});
	return /** @type {number} */ (row?.c ?? 0);
}
