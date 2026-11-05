/**
 * election-fixture.js — TEST-ONLY. Nothing under `apps/VoteTorrentPublic/src`
 * may import this file (D-17): a production bundle containing these facts
 * would let a public page assert election facts that are not true, on a
 * page whose entire purpose is that its claims can be checked.
 * `test/node/election-harness.test.mjs` asserts the absence of any import
 * specifier reaching this file (or `fixtures/`, or `test/`) from `src/`.
 *
 * Plain JS, frozen exports, zero imports from `src/` — this file has no
 * dependency on anything this app builds, so it cannot accidentally pull a
 * production module (and its side effects) into a test-only artefact.
 */

/**
 * Matches `ELECTION_ID_PATTERN` and CONTAINS the literal substring
 * `vtx-fixture`, so a `dist/` scan has a token to name.
 * @type {string}
 */
export const FIXTURE_ELECTION_ID = 'vtx-fixture-0001';

/**
 * A frozen `{ title, timeline, date, ballotDeadline }` fact set (Phase 54,
 * D-08). `title` also contains `vtx-fixture`. `timeline` carries all ten
 * `ELECTION_EVENT_ORDER` keys (grown from seven, Phase 59 D-08/D-09),
 * adopted verbatim from
 * `packages/web-data/test/fixtures/seed-election-surface.js`'s
 * `SEED_TIMELINE` (the repo's only other real ten-event timeline) so the
 * public fixture and that dashboard fixture agree. Every value is a
 * canonical 19-character datetime with NO trailing `Z` —
 * `toCanonicalDatetime` silently strips a trailing `Z`, so keeping one here
 * would test nothing it appears to test (see `election-phase.js`'s own
 * header FINDING).
 *
 * `ballotsFinal` (October 1) deliberately PRECEDES `registrationEnds`
 * (October 5). This is NOT a mistake and must not be "fixed": spike 086
 * narrowed its ordering rule specifically because finalising ballot content
 * and closing voter registration are independent preparation tracks, and
 * this ordering is what exercises the narrowed rule rather than the naive
 * declaration-order-is-chronological one (see `election-phase.js`'s
 * `parseTimeline` ORDERING comment).
 *
 * `accruingVotes`/`hashingVotes`/`releasingKeys` sit between `votingStarts`
 * (08:00) and `tallyingStarts` (20:00), at 12:00/14:00/16:00 on the same
 * day — inside the same election-day window every other same-day event in
 * this fixture already satisfies, so no new cross-check conflict is
 * introduced.
 *
 * `date` and `ballotDeadline` are the two schema-enforced values
 * `parseTimeline` cross-checks the unenforced JSON blob against — without
 * them three of the six `CONFLICT` codes are unreachable and the empty-
 * conflicts assertion below is weaker than it looks. Verified by hand that
 * this fixture satisfies all three reachable cross-checks:
 *   - `ballotsFinal` (2026-10-01) precedes `ballotDeadline` (2026-11-01).
 *   - `registrationEnds`, `ballotsFinal` and `votingStarts` all fall before
 *     the END of election day (`date` + 24h = 2026-11-04T00:00:00) —
 *     `votingStarts` at 08:00 on election day itself is fine.
 *   - `closed` (2026-11-20) follows `date` (2026-11-03).
 *
 * @type {Readonly<{
 *   title: string,
 *   timeline: Readonly<Record<
 *     'registrationEnds' | 'ballotsFinal' | 'votingStarts' | 'accruingVotes' |
 *     'hashingVotes' | 'releasingKeys' | 'tallyingStarts' |
 *     'validation' | 'certificationStarts' | 'closed', string>>,
 *   date: string,
 *   ballotDeadline: string,
 * }>}
 */
export const FIXTURE_ELECTION = Object.freeze({
	title: 'vtx-fixture Test Election',
	timeline: Object.freeze({
		registrationEnds: '2026-10-05T00:00:00',
		ballotsFinal: '2026-10-01T00:00:00',
		votingStarts: '2026-11-03T08:00:00',
		accruingVotes: '2026-11-03T12:00:00',
		hashingVotes: '2026-11-03T14:00:00',
		releasingKeys: '2026-11-03T16:00:00',
		tallyingStarts: '2026-11-03T20:00:00',
		validation: '2026-11-05T00:00:00',
		certificationStarts: '2026-11-10T00:00:00',
		closed: '2026-11-20T00:00:00',
	}),
	date: '2026-11-03T00:00:00',
	ballotDeadline: '2026-11-01T00:00:00',
});

/**
 * The second live shape `ElectionRevision.Timeline` carries in practice
 * (Phase 54, 54-02 deviation (e)): the column is typed
 * `Record<ElectionEvent, number>` but is persisted as a JSON STRING —
 * `seed-election-surface.js:188` writes `timeline: JSON.stringify(SEED_TIMELINE)`
 * into exactly this column. The schema itself carries a standing
 * `-- TODO constrain Timeline` and zero CHECK constraints, and spike 086's
 * `parseTimeline` treated any non-object as `{}` — so without this export
 * the string path is untested and a real election would silently render as
 * "phase unknown". Produced as `JSON.stringify(FIXTURE_ELECTION.timeline)`,
 * DERIVED, never hand-written: two hand-maintained copies of the same seven
 * instants would drift the first time one was edited, and the drift would
 * be invisible because each shape is asserted separately.
 * @type {string}
 */
export const FIXTURE_ELECTION_TIMELINE_JSON = JSON.stringify(FIXTURE_ELECTION.timeline);

/**
 * Four canonical instants, one per `PHASE_IDS` member (Phase 54 rename,
 * contract C1), each chosen to land STRICTLY inside its phase under
 * `derivePhase`'s half-open `[start, next)` boundary rule — never on a
 * boundary. The three existing VALUES are deliberately UNCHANGED from the
 * three-phase fixture — this is a vocabulary rename, not a data change:
 * `pre` (was `organizing`), `voting` (was `running`), `settling` (was
 * `released`). `closed` is new — its 12-hour offset past the `closed`
 * boundary (2026-11-20T00:00:00) preserves the strictly-inside property.
 * @type {Readonly<{ pre: string, voting: string, settling: string, closed: string }>}
 */
export const FIXTURE_INSTANTS = Object.freeze({
	pre: '2026-11-03T07:00:00',
	voting: '2026-11-03T12:00:00',
	settling: '2026-11-04T00:00:00',
	closed: '2026-11-20T12:00:00',
});
