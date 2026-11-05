/**
 * timeline-core.js -- the dependency-free half of the election timeline
 * derivation (D-19, Phase 59 plan 59-02).
 *
 * This module imports NOTHING beyond plain JavaScript: no `vote-engine`, no
 * `react`. Do not add an import here without re-checking that invariant.
 *
 * Split out of `election-phase.js` for the same reason `phase-ids.js` was
 * split out of it in Phase 53 (WR-11): `@votetorrent/ui-web/lifecycle`
 * reaches `@votetorrent/vote-engine/browser` -- a database engine that
 * handles key material -- via its `toCanonicalDatetime`/`nowCanonicalDatetime`
 * import, and `./components` peers on `react-dom`. The voter's React Native
 * bundle must not pay for either: `phase-ids.js`'s own header records the
 * measured cost of pulling the engine in unnecessarily (0.30-0.44s vs 0.02s
 * bare). This module is the "which of N rows is current" primitive the
 * voter's Timeline tab (59-06, 59-07) needs, extracted so it can be reached
 * without that cost.
 *
 * `finestStage` (below) is the "which of N rows is current" primitive:
 * newest-first, it returns the last declared event whose instant has
 * already passed. Authority `Timeline.tsx:83`'s `statusOf` walk --
 * `currentIdx` = the index of the FIRST milestone whose date is `>= now` --
 * is the rejected alternative (D-18): it lights the row one stage AHEAD of
 * the one the election is actually in, because it answers "which is next",
 * not "which is current". `election-phase.js`'s `derivePhase` calls this
 * same function to compute its four-phase-scoped `stage` field; this module
 * is where the function itself lives now.
 *
 * `CONFLICT[].detail` strings (produced by `parseTimeline`, below) are
 * MACHINE DIAGNOSTICS embedding raw timeline values -- they are never
 * user-facing copy. Every rendered sentence a consumer derives from them
 * must be routed through `t()`; do not render a `detail` string directly.
 *
 * Extracted mechanically (via `sed -n` over the exact line ranges recorded
 * in 59-02-PLAN.md's preflight table) from `election-phase.js` as it stood
 * at commit `46dae0c0`, not retyped -- `parseTimeline` is the module that
 * already absorbs all three live shapes of the `Timeline` column and
 * returns an honest `indeterminate` instead of guessing; retyping it is how
 * a verbatim move becomes a silent behaviour change. Four edits were then
 * applied on top of the mechanical extraction: (1) `ELECTION_EVENT_ORDER`
 * grew from the seven `ElectionEvent` values to the ten D-09 members; (2)
 * `STRICT_CHAIN`/`PREPARATION` were hoisted out of `parseTimeline`'s body to
 * module-level frozen constants and exported, with `STRICT_CHAIN` extended
 * from five to eight members; (3) `finestStage`, `iso` and `CANONICAL_RE`
 * gained `export`; (4) the `TimelineStageId`/`TimelineStageStatus` typedefs
 * were added.
 */

/** T-only, no-`Z`, 19-character canonical form -- pins `assertCanonicalDatetime` and `normalizeInstant` to the SAME regex. */
export const CANONICAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

/**
 * @typedef {'registrationEnds' | 'ballotsFinal' | 'votingStarts' | 'accruingVotes' | 'hashingVotes' | 'releasingKeys' | 'tallyingStarts' | 'validation' | 'certificationStarts' | 'closed'} TimelineStageId
 */

/** @typedef {'past' | 'current' | 'future'} TimelineStageStatus */

/**
 * The ten `ElectionEvent` values, in schema/vote-core order (D-09). Frozen;
 * never derived at runtime. `ELECTION_EVENT_ORDER` **is** the frozen id
 * list; `TimelineStageId` (above) is its type -- there is exactly ONE array
 * of the ten stage ids in the repo, and no second `TIMELINE_STAGE_IDS`
 * constant may be added.
 *
 * The insertion point of the three new events -- `accruingVotes`,
 * `hashingVotes`, `releasingKeys`, between `votingStarts` and
 * `tallyingStarts` -- is DERIVED, not chosen: the legacy enum orders
 * `RE -> BF -> VS -> AV -> HV -> RK -> TS -> V -> CS -> C`
 * (`oldsrc/structs/election.ts:5`) and `doc/election.md` orders Voter votes
 * (`:86`) -> Vote hashing (`:112`) -> Election unlocked (`:118`) -> Election
 * tallied (`:124`). Keys release BEFORE tallying, because tallying requires
 * them.
 *
 * @type {ReadonlyArray<TimelineStageId>}
 */
export const ELECTION_EVENT_ORDER = Object.freeze([
	'registrationEnds',
	'ballotsFinal',
	'votingStarts',
	'accruingVotes',
	'hashingVotes',
	'releasingKeys',
	'tallyingStarts',
	'validation',
	'certificationStarts',
	'closed',
]);

/**
 * Conflict codes `parseTimeline` can report. @type {Readonly<Record<string, string>>}
 */
export const CONFLICT = Object.freeze({
	MISSING_EVENT: 'MISSING_EVENT',
	UNPARSEABLE: 'UNPARSEABLE',
	OUT_OF_ORDER: 'OUT_OF_ORDER',
	BALLOTS_FINAL_AFTER_DEADLINE: 'BALLOTS_FINAL_AFTER_DEADLINE',
	EVENT_AFTER_ELECTION_DATE: 'EVENT_AFTER_ELECTION_DATE',
	CLOSED_BEFORE_ELECTION_DATE: 'CLOSED_BEFORE_ELECTION_DATE',
});

/**
 * @typedef {object} TimelineConflict
 * @property {string} code
 * @property {string} event
 * @property {string} detail
 */

/**
 * @typedef {object} ParsedTimeline
 * @property {Record<string, number | null>} at
 * @property {Array<TimelineConflict>} conflicts
 */

/**
 * The schema-enforced fields `parseTimeline` cross-checks the unenforced JSON
 * Timeline against. Both are optional because a caller that holds no election
 * row -- a test fixture, or the retired two-argument bridge wrapper this
 * module used to export -- can supply neither, and a missing cross-check must
 * degrade to "no discrepancy reported", never to a thrown error.
 * @typedef {object} ElectionCrossCheckFields
 * @property {unknown} [ballotDeadline]
 * @property {unknown} [date]
 */

/**
 * Normalise one raw Timeline value to epoch-ms, or `null`.
 *
 * `Record<ElectionEvent, number>` is the declared TS type, but this project's
 * own prior three-phase derivation accepted `string | number` via
 * `toCanonicalDatetime` -- so the declared type is already known not to hold
 * at runtime. Both are accepted here too.
 *
 * The 19-character canonical VT form (no trailing `Z`) is parsed as UTC
 * EXPLICITLY (D-26): letting the JS engine guess would make the derived
 * phase depend on the reader's timezone, which for a public election
 * dashboard is a correctness bug, not a formatting one.
 *
 * @param {unknown} raw
 * @returns {number | null}
 */
export function normalizeInstant(raw) {
	if (raw === undefined || raw === null) return null;
	if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
	if (typeof raw !== 'string') return null;

	const trimmed = raw.trim();
	if (trimmed === '') return null;

	// Canonical VT form (19 chars, T separator, no zone): pin to UTC
	// explicitly rather than local, via an explicit `Z` suffix (D-26).
	if (CANONICAL_RE.test(trimmed)) {
		const ms = Date.parse(trimmed + 'Z');
		return Number.isFinite(ms) ? ms : null;
	}

	// Fallback: an arbitrary non-canonical string, expected to already carry
	// its own zone (e.g. `Z`-suffixed ISO-8601) more often than it succeeds
	// zoneless -- not the canonical form D-26 pins.
	const ms = Date.parse(trimmed);
	return Number.isFinite(ms) ? ms : null;
}

// ORDERING, narrowed after spike 088 ran this against the only real 7-event
// fixture in the repo (078's seeded Timeline) and this rule fired on it.
//
// The first version asserted that DECLARATION order is chronological order, and
// so flagged `ballotsFinal` (2026-10-01) preceding `registrationEnds`
// (2026-10-05). That is not a defect: finalising ballot content and closing
// voter registration are INDEPENDENT preparation tracks, and either may finish
// first. Only the post-voting chain is genuinely causal -- you cannot tally
// before voting ends, validate before tallying, or certify before validating.
//
// So: the five post-voting events are pairwise ordered; the two preparation
// events must each precede `votingStarts` but NOT each other.
//
// D-09: the three new events (`accruingVotes`, `hashingVotes`, `releasingKeys`)
// are causally chained too -- they are inserted into STRICT_CHAIN between
// `votingStarts` and `tallyingStarts`. `PREPARATION` is unchanged.
/** @type {ReadonlyArray<TimelineStageId>} */
export const STRICT_CHAIN = Object.freeze([
	'votingStarts',
	'accruingVotes',
	'hashingVotes',
	'releasingKeys',
	'tallyingStarts',
	'validation',
	'certificationStarts',
	'closed',
]);
/** @type {ReadonlyArray<TimelineStageId>} */
export const PREPARATION = Object.freeze(['registrationEnds', 'ballotsFinal']);

/**
 * Parse the whole timeline blob into `{ event -> ms|null }` plus the
 * conflicts found while doing it. Never throws: a public page must render
 * something honest for arbitrarily broken authority data.
 *
 * Accepts `timeline` as an already-parsed object OR as a JSON string
 * (deviation (e) from spike 086 -- see `election-phase.js`'s header point 3):
 * a string that fails to parse, or that parses to something other than an
 * object, degrades to an empty blob, which in turn makes every event
 * `MISSING_EVENT` -- never a confident phase.
 *
 * @param {unknown} timeline
 * @param {ElectionCrossCheckFields} [election]
 * @returns {ParsedTimeline}
 */
export function parseTimeline(timeline, election = {}) {
	/** @type {Array<TimelineConflict>} */
	const conflicts = [];
	/** @type {Record<string, number | null>} */
	const at = {};

	/** @type {Record<string, unknown>} */
	let blob;
	if (typeof timeline === 'string') {
		try {
			const parsed = JSON.parse(timeline);
			blob = parsed !== null && typeof parsed === 'object' ? /** @type {Record<string, unknown>} */ (parsed) : {};
		} catch {
			blob = {};
		}
	} else {
		blob = timeline !== null && typeof timeline === 'object' ? /** @type {Record<string, unknown>} */ (timeline) : {};
	}

	for (const event of ELECTION_EVENT_ORDER) {
		const raw = blob[event];
		const ms = normalizeInstant(raw);
		at[event] = ms;
		if (ms === null) {
			conflicts.push({
				code: raw === undefined || raw === null ? CONFLICT.MISSING_EVENT : CONFLICT.UNPARSEABLE,
				event,
				detail:
					raw === undefined || raw === null
						? `${event} is absent from Timeline`
						: `${event} = ${JSON.stringify(raw)} is not a usable instant`,
			});
		}
	}

	/** @type {string | null} */
	let prevEvent = null;
	for (const event of STRICT_CHAIN) {
		if (at[event] === null) continue;
		if (prevEvent !== null && /** @type {number} */ (at[event]) < /** @type {number} */ (at[prevEvent])) {
			conflicts.push({
				code: CONFLICT.OUT_OF_ORDER,
				event,
				detail: `${event} (${iso(at[event])}) precedes ${prevEvent} (${iso(at[prevEvent])})`,
			});
		}
		prevEvent = event;
	}
	for (const event of PREPARATION) {
		if (at[event] === null || at.votingStarts === null) continue;
		if (/** @type {number} */ (at[event]) > /** @type {number} */ (at.votingStarts)) {
			conflicts.push({
				code: CONFLICT.OUT_OF_ORDER,
				event,
				detail: `${event} (${iso(at[event])}) falls after votingStarts (${iso(at.votingStarts)})`,
			});
		}
	}

	// Cross-check the unenforced JSON against the three schema-enforced dates.
	// These are the conflicts that matter most: the DB will act on its columns
	// and ignore the JSON, so a disagreement means the dashboard and the
	// database would tell a viewer different things.
	const ballotDeadline = normalizeInstant(election.ballotDeadline);
	const electionDate = normalizeInstant(election.date);

	if (ballotDeadline !== null && at.ballotsFinal !== null && at.ballotsFinal > ballotDeadline) {
		conflicts.push({
			code: CONFLICT.BALLOTS_FINAL_AFTER_DEADLINE,
			event: 'ballotsFinal',
			detail:
				`Timeline says ballots are final at ${iso(at.ballotsFinal)}, after the ` +
				`schema-enforced Election.BallotDeadline ${iso(ballotDeadline)}. ` +
				`Ballot.MutationValid (E.BallotDeadline > context.now) would already reject writes.`,
		});
	}

	if (electionDate !== null) {
		// AMBIGUITY, resolved deliberately (spike 086 rung 2 caught this as a
		// false positive on an ordinary election). `Election.Date` is commented
		// "date of the election" -- a DAY -- but is typed `datetime` and compared
		// as an INSTANT by the schema's own constraints (`DateValid: Date >=
		// context.now`, `RevisionDeadlineValid: RevisionDeadline <= Date`).
		// Authorities set it to midnight, so voting at noon on election day is
		// after it as an instant while being squarely ON it as a day. Comparing
		// as an instant flags every normal election. We therefore treat Date as
		// a DAY and conflict only past the end of that day.
		const dayEnd = startOfUtcDay(electionDate) + 86_400_000;
		for (const event of ['registrationEnds', 'ballotsFinal', 'votingStarts']) {
			const eventMs = at[event];
			if (eventMs !== null && eventMs >= dayEnd) {
				conflicts.push({
					code: CONFLICT.EVENT_AFTER_ELECTION_DATE,
					event,
					detail:
						`${event} (${iso(eventMs)}) falls after the end of election day ` +
						`(Election.Date ${iso(electionDate)}, day ends ${iso(dayEnd)})`,
				});
			}
		}
		if (at.closed !== null && at.closed < electionDate) {
			conflicts.push({
				code: CONFLICT.CLOSED_BEFORE_ELECTION_DATE,
				event: 'closed',
				detail: `closed (${iso(at.closed)}) precedes Election.Date (${iso(electionDate)})`,
			});
		}
	}

	return { at, conflicts };
}

/**
 * The finest-grained stage: the last declared event whose instant has passed.
 * This is the "which of N rows is current" primitive -- a newest-first walk
 * (D-18), NOT Authority `Timeline.tsx:83`'s rejected `statusOf` walk
 * (`currentIdx` = first milestone with `date >= now`), which lights the row
 * one stage AHEAD of the one the election is actually in.
 * @param {Record<string, number | null>} at
 * @param {number} nowMs
 * @returns {TimelineStageId | null}
 */
export function finestStage(at, nowMs) {
	/** @type {TimelineStageId | null} */
	let stage = null;
	for (const event of ELECTION_EVENT_ORDER) {
		const eventMs = at[event];
		if (eventMs !== null && nowMs >= eventMs) stage = event;
	}
	return stage;
}

/** @param {number} ms @returns {number} */
function startOfUtcDay(ms) {
	const d = new Date(ms);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** @param {number | null | undefined} ms @returns {string} */
export function iso(ms) {
	return ms === null || ms === undefined ? '(none)' : new Date(ms).toISOString().slice(0, 19) + 'Z';
}
