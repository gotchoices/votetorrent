/**
 * election-phase.js -- the COMPUTED (never selected) election lifecycle
 * phase, and the small set of pure datetime helpers `ElectionsPanel` needs
 * to render it.
 *
 * Five things a later reader cannot infer:
 *
 * 1. The phase is computed from the election's own `ElectionRevision.Timeline`,
 *    never chosen by an officer. Spike 078 shipped three `organizing` /
 *    `running` / `released` buttons as a SIMULATION AID so a reviewer could
 *    watch a since-removed write-window gate move -- that gate is gone
 *    (D-17), so a picker built here would reintroduce exactly the simulation
 *    this phase replaced with real data. There is no `setPhase` anywhere in
 *    this app.
 * 2. A foreign, absent, incomplete, non-monotonic or otherwise untrustworthy
 *    timeline yields `indeterminate` (D-10) -- `derivePhase` never throws and
 *    never guesses. A guessed phase would tell a viewer an election is in a
 *    state the data does not actually support. Unlike the retired three-phase
 *    model, `indeterminate` is rendered as a visible pill, not silence: the
 *    `Timeline` column carries zero CHECK constraints, so a broken timeline is
 *    an expected input, not an exception.
 * 3. `ElectionRevision.Timeline` carries two live shapes: `vote-core` types
 *    it `Record<ElectionEvent, number>` (epoch milliseconds), but this
 *    project's own dashboard prototype (spike 078) persisted canonical
 *    19-character datetime strings into the same column, and the schema
 *    itself still carries a standing `-- TODO: constrain Timeline`
 *    (votetorrent.qsql:840,:891). Every timeline value is normalised through
 *    `normalizeInstant` before it is compared, so both shapes are accepted
 *    identically. A THIRD shape is also live: `ElectionRevision.Timeline`'s
 *    column itself carries a JSON **string** in practice (confirmed:
 *    `seed-election-surface.js:188` writes `JSON.stringify(...)`), so
 *    `parseTimeline` also accepts the whole blob as a JSON string -- see
 *    deviation (e) below. Do not "fix" any of these shapes and do not pick
 *    one.
 * 4. The phase boundaries are HALF-OPEN and derived by a NEWEST-FIRST walk
 *    (spike 086): `pre` while `at < votingStarts`, `voting` while
 *    `votingStarts <= at < tallyingStarts`, `settling` while
 *    `tallyingStarts <= at < closed`, `closed` from the `closed` event
 *    onward. `derivePhase` walks the three boundaries newest-first (closed,
 *    then settling, then voting): the first boundary already crossed decides
 *    the phase, and a MISSING boundary only degrades the answer to
 *    `indeterminate` when nothing later already settles it -- so a broken
 *    `votingStarts` still yields a confident `settling` once `tallyingStarts`
 *    has passed, because voting is provably over either way (rung 5's
 *    property). Comparison is a plain numeric (epoch-ms) comparison, exact
 *    because every instant is normalised through `normalizeInstant` first.
 * 5. `derivePhase`'s `reason` string and every `conflicts[].detail` are
 *    MACHINE DIAGNOSTICS, never user-facing copy -- they embed raw timeline
 *    values and English sentences authored outside `copy.js`. They cross into
 *    54-12/54-13's render path, which is a copy-table boundary: every
 *    rendered sentence must be routed through `t()` (contract C2).
 *
 * `derivePhase` is the module's ONE derivation. A one-wave delegating bridge
 * alias over it existed while the two apps were repointed; it was deleted the
 * moment its last consumer moved, and nothing here should grow a second entry
 * point back. A wrapper that takes fewer arguments cannot supply the
 * schema-enforced cross-check row, so it necessarily reports fewer
 * discrepancies than the real function does -- which is why the bridge was
 * time-boxed rather than kept for convenience.
 *
 * FINDING (measured at execution time, 2026-08-26): `toCanonicalDatetime`
 * (packages/vote-engine/src/utils.ts) is not merely a validator -- for any
 * string that fails its fast-path 19-character regex, it falls through to
 * `new Date(input)` and, if that parses, returns the result re-sliced back
 * to 19 characters. A trailing `Z` (or any other `Date`-parseable suffix) is
 * therefore silently stripped, and the result is the SAME canonical string a
 * plain 19-character input of the same instant would produce -- it does
 * NOT surface as a distinct non-canonical value after normalisation.
 * Empirically: `toCanonicalDatetime('2026-11-03T08:00:00Z') === '2026-11-03T08:00:00'`.
 * This finding is about `toCanonicalDatetime`, which remains the only
 * conversion used by `assertCanonicalDatetime` and `resolveComparisonInstant`
 * -- it does not describe `normalizeInstant`, which is a distinct function
 * (below) with its own explicit-UTC handling of the canonical form.
 *
 * `Date.parse` and a bare `new Date(...)` BAN, AMENDED (Phase 54): the prior
 * blanket ban is narrowed to its real intent -- NO IMPLICIT-ZONE PARSE. The
 * lifted `normalizeInstant`, `startOfUtcDay` and `iso` all use `Date`, and
 * every `Date.parse`/`new Date(...)` call in this file either (a) receives an
 * explicit `Z` suffix, (b) goes through `Date.UTC`, or (c) receives a value
 * that already carries its own zone information (an arbitrary non-canonical
 * string, e.g. already-`Z`-suffixed ISO-8601 -- the one fallback branch in
 * `normalizeInstant` that is not itself pinned to UTC; a bare, zoneless
 * non-canonical string is expected to fail there more often than it
 * succeeds, which is acceptable because it is not the canonical 19-character
 * form D-26 is pinning). The 19-character canonical form specifically -- the
 * value D-26 requires be parsed as UTC explicitly, so the derived phase never
 * shifts with the reader's timezone -- is always parsed via an explicit `Z`
 * suffix in `normalizeInstant`, matching the same T-only, no-`Z` canonical
 * regex `assertCanonicalDatetime` pins. `toCanonicalDatetime` remains the
 * only conversion used by `assertCanonicalDatetime` and
 * `resolveComparisonInstant` -- unchanged by this amendment.
 *
 * Lifted from `.claude/skills/spike-findings-votetorrent/sources/
 * 086-election-phase-derivation/phase.js` (Phase 54, D-06/D-07/D-10),
 * replacing the three-phase (`organizing`/`running`/`released`) interval walk
 * that 53-05 had moved verbatim from
 * `apps/VoteTorrentDashboard/src/lifecycle/election-phase.js`. This lift is
 * no longer byte-for-byte verbatim -- the sha-verified-verbatim claim the
 * prior header carried does not carry over. Five deliberate deviations from
 * the 086 source, all D-07's restatement obligation:
 *
 *   (a) `threeBucket()` is omitted entirely (D-07: zero occurrences anywhere
 *       in `apps/` or `packages/`). Its `pre-election` / `during-election` /
 *       `completed-election` buckets are a vocabulary this repo never
 *       adopted -- the word `threeBucket` survives nowhere in this package's
 *       `src/` outside this sentence.
 *   (b) 086's `PHASES` map is NOT lifted -- `PHASE_IDS` from `./phase-ids.js`
 *       is the single vocabulary declaration; a second map naming the same
 *       four strings would be pure drift bait.
 *   (c) 086's `ELECTION_EVENTS` is NOT lifted -- the identical seven-member
 *       frozen `ELECTION_EVENT_ORDER` already in this file is used instead.
 *   (d) `PHASE_OPENED_BY` is EXPORTED here (086 keeps it private), so the
 *       drift assertion in `test/election-phase.test.mjs` can prove the
 *       walk's boundary map and `PHASE_IDS` cannot diverge.
 *   (e) `parseTimeline` additionally accepts the timeline as a JSON STRING,
 *       defensively parsed inside a `try` that degrades to an empty blob --
 *       086 only ever received an already-parsed object, but the real
 *       `ElectionRevision.Timeline` column carries both shapes (point 3
 *       above) and this project's own retired three-phase derivation had its
 *       own `JSON.parse` branch for exactly that reason. Dropping it would
 *       silently turn every string-valued timeline into `indeterminate` for
 *       both apps.
 */

import { toCanonicalDatetime, nowCanonicalDatetime } from '@votetorrent/vote-engine/browser';
import { PHASE_IDS, phaseCopyKey, INDETERMINATE_PHASE } from './phase-ids.js';
import { CANONICAL_RE, ELECTION_EVENT_ORDER, CONFLICT, normalizeInstant, parseTimeline, finestStage, iso } from './timeline-core.js';

// Re-exported unchanged (WR-11, Phase 53 review): `PHASE_IDS`/`phaseCopyKey`
// moved to the dependency-free `./phase-ids.js` sibling so `LifecyclePill.tsx`
// (a `./components` barrel member) can depend on them without transitively
// loading `@votetorrent/vote-engine/browser` -- see `phase-ids.js`'s own
// header. This module's public surface (and every existing
// `@votetorrent/ui-web/lifecycle` consumer) is unchanged.
export { PHASE_IDS, phaseCopyKey };

// D-19 (Phase 59 plan 59-02): `CANONICAL_RE`, `ELECTION_EVENT_ORDER`,
// `CONFLICT`, `normalizeInstant`, `parseTimeline`, `finestStage` and `iso`
// now live in the dependency-free sibling `./timeline-core.js`, imported
// above and re-exported below where they were already part of this
// module's public `./lifecycle` surface. This module DELEGATES to them; it
// no longer defines them. See `./timeline-core.js`'s own header for why the
// split exists (the same reason `phase-ids.js` was split out in Phase 53).
export { ELECTION_EVENT_ORDER, CONFLICT, normalizeInstant, parseTimeline };

/** @typedef {'pre' | 'voting' | 'settling' | 'closed'} PhaseId */

/**
 * Which `ElectionEvent` opens each non-`pre` phase. `pre` is the implicit
 * start and has no opener. EXPORTED (086 keeps it private, deviation (d))
 * so `test/election-phase.test.mjs` can assert `Object.keys(PHASE_OPENED_BY)`
 * deep-equals `PHASE_IDS.slice(1)` -- the walk's boundary map and the
 * vocabulary cannot silently diverge.
 * @type {Readonly<Record<'voting' | 'settling' | 'closed', string>>}
 */
export const PHASE_OPENED_BY = Object.freeze({
	voting: 'votingStarts',
	settling: 'tallyingStarts',
	closed: 'closed',
});

/**
 * @typedef {import('./timeline-core.js').TimelineConflict} TimelineConflict
 */

/**
 * @typedef {import('./timeline-core.js').ParsedTimeline} ParsedTimeline
 */

/**
 * @typedef {import('./timeline-core.js').ElectionCrossCheckFields} ElectionCrossCheckFields
 */

/**
 * @typedef {object} DerivePhaseResult
 * @property {PhaseId | typeof INDETERMINATE_PHASE} phase
 * @property {string | null} stage
 * @property {string | null} firedRule
 * @property {string} reason
 * @property {Record<string, number | null>} at
 * @property {Array<TimelineConflict>} conflicts
 * @property {boolean} indeterminate
 */

/**
 * Throws when `value` is not a canonical 19-character, no-`Z` datetime,
 * naming both `label` and the offending value -- this guards a value the
 * dashboard PRODUCES (the comparison instant), not one it merely reads, so
 * naming the value is appropriate here (contrast the read-side PII-hygiene
 * rule, which applies to row values, not to this app's own derived instant).
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
export function assertCanonicalDatetime(value, label) {
	if (typeof value !== 'string' || !CANONICAL_RE.test(value)) {
		throw new Error(
			`assertCanonicalDatetime: "${label}" must be a canonical 19-character datetime with no "Z" suffix, got ${JSON.stringify(value)}`,
		);
	}
	return value;
}

/**
 * Resolve the instant `derivePhase` compares a timeline against. Returns
 * `provided` unchanged when it is already canonical; falls
 * back to `nowCanonicalDatetime()` when `provided` is `null` or `undefined`
 * (a panel can mount before any snapshot instant exists); throws via
 * `assertCanonicalDatetime` for any other, non-canonical value.
 *
 * @param {string | null | undefined} [provided]
 * @returns {string}
 */
export function resolveComparisonInstant(provided) {
	if (provided === null || provided === undefined) {
		return nowCanonicalDatetime();
	}
	return assertCanonicalDatetime(provided, 'resolveComparisonInstant(provided)');
}

/**
 * Derive the public phase at `now`.
 *
 * THE LOAD-BEARING RULE: if the event that decides a boundary is missing or
 * unparseable, the phase is `indeterminate` -- never a silent default. A
 * public dashboard that renders "voting is open" because `votingStarts` was
 * absent from an unconstrained JSON blob is worse than one that renders
 * "unknown".
 *
 * @param {ElectionCrossCheckFields} election
 * @param {unknown} timeline
 * @param {unknown} now
 * @returns {DerivePhaseResult}
 */
export function derivePhase(election, timeline, now) {
	const nowMs = normalizeInstant(now);
	const { at, conflicts } = parseTimeline(timeline, election);

	if (nowMs === null) {
		return {
			phase: INDETERMINATE_PHASE,
			stage: null,
			firedRule: null,
			reason: '`now` is not a usable instant',
			at,
			conflicts,
			indeterminate: true,
		};
	}

	// Walk the boundaries newest-first. The first boundary already passed
	// decides the phase; a missing boundary we would have had to cross to get
	// here makes the answer indeterminate rather than wrong.
	/** @type {ReadonlyArray<readonly [PhaseId, string]>} */
	const ordered = [
		['closed', PHASE_OPENED_BY.closed],
		['settling', PHASE_OPENED_BY.settling],
		['voting', PHASE_OPENED_BY.voting],
	];

	for (const [phase, opener] of ordered) {
		const boundary = at[opener];
		if (boundary === null) {
			// We cannot rule this phase in or out. Note the ordering: because we
			// walk newest-first, a LATER boundary that has already been crossed
			// returns above and never reaches here. So a broken `votingStarts`
			// still yields a confident `settling` once `tallyingStarts` has
			// passed -- voting is provably over either way. A missing boundary
			// degrades the answer only when nothing later already settles it.
			// (Proved by rung 5's two halves.)
			return {
				phase: INDETERMINATE_PHASE,
				stage: null,
				firedRule: opener,
				reason: `cannot decide: '${opener}' is missing or unparseable, so the ${phase} boundary is unknown`,
				at,
				conflicts,
				indeterminate: true,
			};
		}
		if (nowMs >= boundary) {
			return {
				phase,
				stage: finestStage(at, nowMs),
				firedRule: `now >= ${opener}`,
				reason: `${iso(nowMs)} is at or after ${opener} (${iso(boundary)})`,
				at,
				conflicts,
				indeterminate: false,
			};
		}
	}

	return {
		phase: 'pre',
		stage: finestStage(at, nowMs),
		firedRule: 'now < votingStarts',
		reason: `${iso(nowMs)} precedes votingStarts (${iso(at.votingStarts)})`,
		at,
		conflicts,
		indeterminate: false,
	};
}

export { iso as formatInstant };
