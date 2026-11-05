/**
 * registrations.js -- the `vrg` read surface, the deepest of the three
 * (39% of the whole authorization surface, 16 of 41 enforcement sites over
 * 12 tables). RULE R4 and inherited-spec item 4 apply exactly as documented
 * at the top of `./elections.js`.
 *
 * RULE R3 (column allowlist, counts never contents for the private tiers):
 * this module NEVER selects `RegistrantPrivate.PrivateDetails` (schema
 * comment: "never disclosed"), `RegistrantSelective.SelectiveDetails`
 * (salted leaves -- disclosure is a per-election policy decision, not a
 * dashboard one), `RegistrationRequest.Payload` / `.PayloadCid`,
 * `RegistrantPublic.ExtraFields` (unbounded authority-specific keys), or
 * any `AssociationPrivate` payload column. Those five tables are reached
 * by `select count(*)` ONLY, inside `readRegistrationSurfaceCounts` below.
 *
 * FINDING (measured at execution time, 2026-08-26): `limit` is itself a SQL
 * keyword, and Quereus rejects a bind parameter NAMED `limit` (`:limit`)
 * after the `LIMIT` clause with the exact same class of parse error the
 * plan's own read-first notes warn about for `:desc` / `:group` / `:order`
 * / `:type` -- "Expected identifier or number after parameter prefix",
 * naming no column and no statement. Empirically:
 * `select Id from Authority limit :limit` fails to parse;
 * `select Id from Authority limit :rosterLimit` parses and runs cleanly.
 * `readRegistrantRoster` below therefore binds the roster bound as
 * `:rosterLimit`, not `:limit` -- the SAME reserved-word hazard class, one
 * more instance of it. The value is still a genuine bound parameter (never
 * interpolated); only the bind's NAME differs from the plan's literal
 * example.
 */

import { CAPABILITY_TABLES } from './capability-tables.js';

/** The fourteen `vrg` tables this module covers -- read from `capability-tables.js`'s generated `CAPABILITY_TABLES.registrations` field rather than re-declared here, so there is exactly one list (that generator, `generate-capabilities.mjs`, is the same schema-parse run that also emits `capabilities.js`). @type {ReadonlyArray<string>} */
export const TABLES_READ = Object.freeze([...CAPABILITY_TABLES.registrations]);

/** The registrant roster page bound -- a PRIVACY control first, a
 * performance one second: a borrowed or shoulder-surfed browser exposes at
 * most this many rows rather than an entire county roll, and a page-source
 * `Ctrl-F` cannot enumerate more than this. @type {100} */
export const ROSTER_PAGE_SIZE = 100;

/**
 * @typedef {object} StatusBreakdownRow
 * @property {string} Code
 * @property {string} Name
 * @property {number} Count
 */

/**
 * Drives FROM the view, so every status appears even at zero -- an absent
 * row and a zero row read very differently to an officer.
 *
 * @param {import('@quereus/quereus').Database} db
 * @returns {Promise<StatusBreakdownRow[]>}
 */
export async function readRegistrantStatusBreakdown(db) {
	/** @type {StatusBreakdownRow[]} */
	const out = [];
	for await (const r of db.eval(
		`select S.Code, S.Name, (select count(*) from Registrant R where R.Status = S.Code) as Count
		 from RegistrantStatus S`,
		{},
	)) {
		out.push(/** @type {StatusBreakdownRow} */ (r));
	}
	return out;
}

/**
 * @typedef {object} RequestBreakdownRow
 * @property {string} Status
 * @property {string} StatusName
 * @property {string} IssuerType
 * @property {string} IssuerName
 * @property {number} Count
 */

/**
 * The issuer split is not decoration -- the schema's own `BridgeIdValid`
 * comment calls it the D-03 machine-distinguishability gate, so an officer
 * can see which requests were asserted on someone's behalf.
 *
 * @param {import('@quereus/quereus').Database} db
 * @returns {Promise<RequestBreakdownRow[]>}
 */
export async function readRegistrationRequestBreakdown(db) {
	/** @type {RequestBreakdownRow[]} */
	const out = [];
	for await (const r of db.eval(
		`select RR.Status, RS.Name as StatusName, RR.IssuerType, RI.Name as IssuerName, count(*) as Count
		 from RegistrationRequest RR
		 join RegistrationRequestStatus RS on RS.Code = RR.Status
		 join RegistrationRequestIssuer RI on RI.Code = RR.IssuerType
		 group by RR.Status, RS.Name, RR.IssuerType, RI.Name`,
		{},
	)) {
		out.push(/** @type {RequestBreakdownRow} */ (r));
	}
	return out;
}

/**
 * @typedef {object} RosterRow
 * @property {string} Id
 * @property {string} Status
 * @property {string} Expiration - VERBATIM. `Z`-suffixed by CHECK, not
 *   canonical 19-character -- never normalised, never parsed.
 * @property {string | null} LastName
 * @property {string | null} FirstName
 * @property {string | null} District
 */

/**
 * @typedef {object} RosterResult
 * @property {RosterRow[]} rows
 * @property {number} total
 */

/**
 * @param {import('@quereus/quereus').Database} db
 * @param {number} [limit]
 * @returns {Promise<RosterResult>}
 */
export async function readRegistrantRoster(db, limit = ROSTER_PAGE_SIZE) {
	/** @type {RosterRow[]} */
	const rows = [];
	for await (const r of db.eval(
		`select R.Id, R.Status, R.Expiration, RP.LastName, RP.FirstName, RP.District
		 from Registrant R left join RegistrantPublic RP on RP.RegistrantId = R.Id and RP.Cid = R.PublicCid
		 order by RP.LastName, RP.FirstName, R.Id limit :rosterLimit`,
		{ rosterLimit: limit },
	)) {
		rows.push(/** @type {RosterRow} */ (r));
	}

	const totalRow = await db.prepare(`select count(*) as c from Registrant`).get({});
	return { rows, total: /** @type {number} */ (totalRow?.c ?? 0) };
}

/**
 * @typedef {object} SurfaceCountEntry
 * @property {string} table
 * @property {number} count
 */

// A static, literal SQL string per `vrg` table -- no template interpolation
// anywhere (rule R4), and table/column identifiers cannot be bound via a
// `:name` parameter in standard SQL regardless. `ElectionRegistrant` is the
// one entry scoped to the active election; every other table is counted
// network-wide (rule R3: these five private/selective/payload-bearing
// tables are reached by count(*) ONLY -- RegistrantPrivate,
// RegistrantSelective, AssociationPrivate, Association, AttestationChallenge).
const SURFACE_COUNT_QUERIES = Object.freeze({
	Association: 'select count(*) as c from Association',
	AssociationRequest: 'select count(*) as c from AssociationRequest',
	AssociationPrivate: 'select count(*) as c from AssociationPrivate',
	AttestationChallenge: 'select count(*) as c from AttestationChallenge',
	AuthorityIntakePolicy: 'select count(*) as c from AuthorityIntakePolicy',
	ElectionRegistrant: 'select count(*) as c from ElectionRegistrant where ElectionId = :electionId',
	PollingDevice: 'select count(*) as c from PollingDevice',
	Registrant: 'select count(*) as c from Registrant',
	RegistrantPrivate: 'select count(*) as c from RegistrantPrivate',
	RegistrantPublic: 'select count(*) as c from RegistrantPublic',
	RegistrantSelective: 'select count(*) as c from RegistrantSelective',
	RegistrantSignatureTaskExtension: 'select count(*) as c from RegistrantSignatureTaskExtension',
	RegistrationBridgeKey: 'select count(*) as c from RegistrationBridgeKey',
	RegistrationRequest: 'select count(*) as c from RegistrationRequest',
});

/**
 * One `{ table, count }` entry per `vrg` table, in `capability.tables`
 * order (i.e. `TABLES_READ` order) -- the positive control that proves the
 * counts are really being read, and the section that makes all fourteen
 * tables visible in the panel.
 *
 * @param {import('@quereus/quereus').Database} db
 * @param {string} electionId
 * @returns {Promise<SurfaceCountEntry[]>}
 */
export async function readRegistrationSurfaceCounts(db, electionId) {
	/** @type {SurfaceCountEntry[]} */
	const out = [];
	for (const table of TABLES_READ) {
		const sql = SURFACE_COUNT_QUERIES[/** @type {keyof typeof SURFACE_COUNT_QUERIES} */ (table)];
		// eslint-disable-next-line no-await-in-loop -- sequential against one shared handle, this project's tier-1 discipline
		const row = await db.prepare(sql).get(table === 'ElectionRegistrant' ? { electionId } : {});
		out.push({ table, count: /** @type {number} */ (row?.c ?? 0) });
	}
	return out;
}

/**
 * The single tested predicate that decides Empty versus Populated for the
 * Registrations panel -- so that decision lives here, not in the
 * component.
 *
 * @param {import('@quereus/quereus').Database} db
 * @returns {Promise<boolean>}
 */
/**
 * Phase 62 Plan 25 (62-01's open question, answered): an `AuthorityIntakePolicy` row alone makes
 * this return true, exactly as `RegistrationBridgeKey` already does. Both are configuration rows,
 * not registrant data, but an officer who saved a bridge URL or a re-association mode must see
 * that row reflected in the panel's surface counts, not an "empty" placeholder that hides it.
 */
export async function hasAnyRegistrationData(db) {
	const row = await db
		.prepare(
			`select (
			   exists(select 1 from Association) or
			   exists(select 1 from AssociationPrivate) or
			   exists(select 1 from AttestationChallenge) or
			   exists(select 1 from AuthorityIntakePolicy) or
			   exists(select 1 from ElectionRegistrant) or
			   exists(select 1 from PollingDevice) or
			   exists(select 1 from Registrant) or
			   exists(select 1 from RegistrantPrivate) or
			   exists(select 1 from RegistrantPublic) or
			   exists(select 1 from RegistrantSelective) or
			   exists(select 1 from RegistrantSignatureTaskExtension) or
			   exists(select 1 from RegistrationBridgeKey) or
			   exists(select 1 from RegistrationRequest)
			 ) as AnyRow`,
		)
		.get({});
	return Boolean(row?.AnyRow);
}

/* ---------------------------------------------------------------------------
 * INTAKE SERIES (D-04)
 *
 * Buckets registration-intake volume over time for the Registrations panel's
 * C3 chart (60-05). Bucketed on RegistrationRequest.ReceivedAt -- the
 * authority-observed intake time the engine writes with toIsoZDatetime,
 * sitting inside no digest (votetorrent.qsql:1506) -- and NEVER on
 * SubmittedAt, the submitter-supplied, DG-1-digest-bound value
 * (votetorrent.qsql:1505). A chart built on SubmittedAt would let a
 * requester choose where its own mark lands on the officer's time axis.
 * ------------------------------------------------------------------------- */

/** 48 hours, in milliseconds -- the hour/day bucket-unit threshold (D-04, UI-SPEC "<= ~2 days"). Left as the literal number, not a multiplication chain, so a test can pin the exact value. @type {172800000} */
export const INTAKE_HOUR_MAX_SPAN_MS = 172800000;

/** 56 days, in milliseconds -- the day/week bucket-unit threshold (D-04, UI-SPEC "up to ~8 weeks"). Left as the literal number for the same reason as INTAKE_HOUR_MAX_SPAN_MS. @type {4838400000} */
export const INTAKE_DAY_MAX_SPAN_MS = 4838400000;

/** @type {3600000} */
const HOUR_MS = 3600000;
/** @type {86400000} */
const DAY_MS = 86400000;
/** @type {604800000} */
const WEEK_MS = 604800000;

/**
 * @typedef {object} IntakeBucketRow
 * @property {string} bucketStart
 * @property {number} count - DELIBERATELY lower-case, unlike this module's
 *   other reads (which use `Count`): the UI-SPEC's Data Layer Contract pins
 *   this exact shape for 60-05's consumer. Do not "correct" it to `Count`.
 */

/** @typedef {'hour' | 'day' | 'week'} IntakeBucketUnit */

/**
 * `hour` for a span <= INTAKE_HOUR_MAX_SPAN_MS, `day` for a span
 * <= INTAKE_DAY_MAX_SPAN_MS, `week` otherwise. Both boundaries are
 * inclusive-of-the-finer-unit. A negative or non-finite span is treated as 0
 * (i.e. `hour`), never thrown on.
 *
 * @param {number} spanMs
 * @returns {IntakeBucketUnit}
 */
export function chooseIntakeBucketUnit(spanMs) {
	const safeSpanMs = Number.isFinite(spanMs) && spanMs > 0 ? spanMs : 0;
	if (safeSpanMs <= INTAKE_HOUR_MAX_SPAN_MS) return 'hour';
	if (safeSpanMs <= INTAKE_DAY_MAX_SPAN_MS) return 'day';
	return 'week';
}

/**
 * Parses a bucketStart string to its UTC epoch ms. Must round-trip
 * byte-exactly with strftime's own output shapes (measured: `hour` ->
 * 19-char, no `Z`; `day`/`week` -> 10-char date). Appending `Z` before
 * parsing is load-bearing -- `Date.parse` of a bare `2026-09-15T13:00:00` is
 * LOCAL time per spec, which would silently shift every bucket by the
 * runner's UTC offset and pass on a UTC machine. All bucket arithmetic in
 * this module is UTC epoch math, never local, never calendar arithmetic --
 * fixed HOUR_MS / DAY_MS / WEEK_MS steps are safe precisely because the axis
 * is UTC.
 *
 * @param {string} bucketStart
 * @param {IntakeBucketUnit} unit
 * @returns {number}
 */
function bucketStartToEpochMs(bucketStart, unit) {
	return unit === 'hour' ? Date.parse(bucketStart + 'Z') : Date.parse(bucketStart + 'T00:00:00Z');
}

/**
 * The inverse of bucketStartToEpochMs -- formats a UTC epoch ms back to the
 * exact bucketStart shape strftime produces for the given unit.
 *
 * @param {number} ms
 * @param {IntakeBucketUnit} unit
 * @returns {string}
 */
function epochMsToBucketStart(ms, unit) {
	const iso = new Date(ms).toISOString();
	return unit === 'hour' ? iso.slice(0, 13) + ':00:00' : iso.slice(0, 10);
}

/**
 * Sorts the input by bucketStart, drops any row whose bucketStart is null,
 * empty or unparseable (defence in depth -- the real schema's
 * ReceivedAtValid CHECK prevents it, but strftime returns null for an
 * unparseable value and a NaN bucket must never reach a chart), then walks
 * from the first bucket's epoch to the last in fixed unit-sized steps,
 * emitting the input count where one exists and 0 where none does. This is
 * the D-02 absent-vs-zero discipline applied to the time axis (UI-SPEC:
 * "Zero-request buckets render as zero-height marks, not gaps"). Empty
 * input returns [].
 *
 * @param {ReadonlyArray<{bucketStart: string | null | undefined, count: number}>} rows
 * @param {IntakeBucketUnit} unit
 * @returns {IntakeBucketRow[]}
 */
export function densifyIntakeBuckets(rows, unit) {
	/** @type {{bucketStart: string, count: number}[]} */
	const clean = [];
	for (const r of rows) {
		if (typeof r.bucketStart !== 'string' || r.bucketStart.length === 0) continue;
		if (!Number.isFinite(bucketStartToEpochMs(r.bucketStart, unit))) continue;
		clean.push({ bucketStart: r.bucketStart, count: r.count });
	}
	if (clean.length === 0) return [];
	clean.sort((a, b) => (a.bucketStart < b.bucketStart ? -1 : a.bucketStart > b.bucketStart ? 1 : 0));

	const stepMs = unit === 'hour' ? HOUR_MS : unit === 'day' ? DAY_MS : WEEK_MS;
	/** @type {Map<string, number>} */
	const byBucket = new Map();
	for (const r of clean) byBucket.set(r.bucketStart, r.count);
	const firstMs = bucketStartToEpochMs(clean[0].bucketStart, unit);
	const lastMs = bucketStartToEpochMs(clean[clean.length - 1].bucketStart, unit);

	/** @type {IntakeBucketRow[]} */
	const out = [];
	for (let ms = firstMs; ms <= lastMs; ms += stepMs) {
		const bucketStart = epochMsToBucketStart(ms, unit);
		out.push({ bucketStart, count: byBucket.get(bucketStart) ?? 0 });
	}
	return out;
}

/**
 * Anchors on the EARLIEST day bucket's UTC midnight; for each day row
 * computes index = floor((dayMs - anchorMs) / WEEK_MS) and sums counts per
 * index. Returns the SPARSE result -- the caller densifies it with
 * densifyIntakeBuckets(weekRows, 'week'), so gap-filling lives in one
 * function, not two. Anchoring on the data rather than on an ISO week
 * number is exactly why no `%W` format string appears anywhere in this
 * module (measured: `%W` is not fully implemented on the resolved engine
 * build).
 *
 * @param {ReadonlyArray<{bucketStart: string, count: number}>} dayRows
 * @returns {IntakeBucketRow[]}
 */
export function foldDayBucketsIntoWeeks(dayRows) {
	if (dayRows.length === 0) return [];
	const sorted = dayRows.slice().sort((a, b) => (a.bucketStart < b.bucketStart ? -1 : a.bucketStart > b.bucketStart ? 1 : 0));
	const anchorMs = bucketStartToEpochMs(sorted[0].bucketStart, 'day');
	/** @type {Map<number, number>} */
	const byIndex = new Map();
	for (const row of sorted) {
		const dayMs = bucketStartToEpochMs(row.bucketStart, 'day');
		const index = Math.floor((dayMs - anchorMs) / WEEK_MS);
		byIndex.set(index, (byIndex.get(index) ?? 0) + row.count);
	}
	return [...byIndex.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([index, count]) => ({ bucketStart: epochMsToBucketStart(anchorMs + index * WEEK_MS, 'week'), count }));
}

/** The DB's full ReceivedAt span in one row. `ReceivedAt` is the only column named (D-04) -- never `SubmittedAt`. @type {string} */
export const INTAKE_SPAN_SQL = `select min(ReceivedAt) as earliest, max(ReceivedAt) as latest, count(*) as total from RegistrationRequest`;

/** Hour buckets over ReceivedAt. The group-by expression repeats the whole strftime(...) call verbatim -- grouping by the select-list alias alone does not parse on the resolved 4.18.0 build (measured). @type {string} */
export const INTAKE_HOURLY_SQL = `select strftime('%Y-%m-%dT%H:00:00', ReceivedAt) as bucketStart, count(*) as count from RegistrationRequest group by strftime('%Y-%m-%dT%H:00:00', ReceivedAt) order by 1`;

/** Day buckets over ReceivedAt. Same group-by-repetition constraint as INTAKE_HOURLY_SQL. Also the source for the week path, which folds these day buckets rather than reading raw ReceivedAt values. @type {string} */
export const INTAKE_DAILY_SQL = `select strftime('%F', ReceivedAt) as bucketStart, count(*) as count from RegistrationRequest group by strftime('%F', ReceivedAt) order by 1`;

/** registration intake series read failed -- a fixed literal message carrying no interpolation and no value (T-60-02). No `cause`: a cause chain re-attaches the engine's message, which is exactly what this class exists to withhold. */
export class IntakeSeriesReadError extends Error {
	/** @param {string} originalName */
	constructor(originalName) {
		super('registration intake series could not be read');
		this.name = 'IntakeSeriesReadError';
		/** @type {string} */
		this.originalName = originalName;
	}
}

/** @type {string} */
const INTAKE_LOG_PREFIX = 'officer/registrations intake:';

/**
 * The error's `name` and nothing else -- see public/subscribe.js's identical
 * idiom (T-60-02). No message, no SQL, no row, no column.
 *
 * @param {unknown} err
 * @returns {void}
 */
function logFailure(err) {
	const name = err && typeof (/** @type {any} */ (err).name) === 'string' ? /** @type {any} */ (err).name : 'Error';
	console.error(INTAKE_LOG_PREFIX, name);
}

/**
 * D-04: buckets the intake series on ReceivedAt -- authority-observed,
 * written by the engine with toIsoZDatetime, inside no digest -- and never
 * on SubmittedAt, the submitter-supplied value inside DG-1. A chart built on
 * SubmittedAt would let a requester choose where its own mark lands on the
 * officer's time axis. The unit adapts to the data's own span (hour / day /
 * week, chooseIntakeBucketUnit); interior gaps are densified to zero-count
 * rows (the D-02 discipline, densifyIntakeBuckets).
 *
 * The week path deliberately re-groups DAY buckets (foldDayBucketsIntoWeeks)
 * instead of reading raw ReceivedAt values. Reading one row per request
 * would turn a counts-only aggregate surface into a row-enumeration surface
 * over RegistrationRequest (rule R3, threat T-60-01) and would scale with
 * request volume instead of with elapsed time. It also removes any need for
 * `%W`, which is not fully implemented on the resolved engine build.
 *
 * @param {import('@quereus/quereus').Database} db
 * @returns {Promise<IntakeBucketRow[]>}
 */
export async function readRegistrationIntakeSeries(db) {
	try {
		const span = await db.prepare(INTAKE_SPAN_SQL).get({});
		const earliest = /** @type {string | null | undefined} */ (span?.earliest);
		const latest = /** @type {string | null | undefined} */ (span?.latest);
		const total = /** @type {number} */ (span?.total ?? 0);
		if (!total || earliest == null || latest == null) return [];

		const earliestMs = Date.parse(earliest);
		const latestMs = Date.parse(latest);
		if (!Number.isFinite(earliestMs) || !Number.isFinite(latestMs)) return [];

		const unit = chooseIntakeBucketUnit(latestMs - earliestMs);

		if (unit === 'hour') {
			/** @type {{bucketStart: string, count: number}[]} */
			const rows = [];
			for await (const r of db.eval(INTAKE_HOURLY_SQL, {})) {
				rows.push(/** @type {{bucketStart: string, count: number}} */ (r));
			}
			return densifyIntakeBuckets(rows, 'hour');
		}

		/** @type {{bucketStart: string, count: number}[]} */
		const dayRows = [];
		for await (const r of db.eval(INTAKE_DAILY_SQL, {})) {
			dayRows.push(/** @type {{bucketStart: string, count: number}} */ (r));
		}
		if (unit === 'day') return densifyIntakeBuckets(dayRows, 'day');
		return densifyIntakeBuckets(foldDayBucketsIntoWeeks(dayRows), 'week');
	} catch (err) {
		logFailure(err);
		const originalName = err && typeof (/** @type {any} */ (err).name) === 'string' ? /** @type {any} */ (err).name : 'Error';
		throw new IntakeSeriesReadError(originalName);
	}
}
