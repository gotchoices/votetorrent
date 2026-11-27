/**
 * timeline-copy-hygiene.test.ts — Phase 59-05 (D-13).
 *
 * Gates the new `timeline` i18n namespace (+ `common.tabTimeline`) for required-key presence,
 * non-emptiness, actual translation (EN != ES outside a small declared-identical allowlist), and
 * copy discipline (no GSD phase numbers, no decision IDs). Asserts ONLY against the imported
 * `resources` object — never reads a source file — so it can never trip over its own comments
 * (a known project trap: a checker whose own text quotes the pattern it greps for is
 * permanently green).
 */
import {resources} from '../src/i18n/index';

type TimelineNamespace = Record<string, string>;

const enTimeline = resources.en.timeline as unknown as TimelineNamespace;
const esTimeline = resources.es.timeline as unknown as TimelineNamespace;

// All 39 keys from the 59-05-PLAN.md preflight table (`<preflight>`'s resolved form of
// 59-UI-SPEC.md's Copywriting Contract). Presence-checked, not count-checked — later plans may
// legitimately add keys, and the parity gate (`i18n-parity.test.ts`) already catches asymmetry.
const REQUIRED_TIMELINE_KEYS = [
	'stage.registrationEnds.title',
	'stage.ballotsFinal.title',
	'stage.votingPeriod.title',
	'stage.accruingVotes.title',
	'stage.hashingVotes.title',
	'stage.releasingKeys.title',
	'stage.tallyingStarts.title',
	'stage.validation.title',
	'stage.certificationStarts.title',
	'stage.closed.title',
	'help.accessibilityLabel',
	'subtitle.yesterday',
	'subtitle.today',
	'subtitle.futureWeekday',
	'subtitle.pastDate',
	'subtitle.futureDate',
	'header.dateRange',
	'headerTitle',
	'rail.now',
	'registration.isRegistered',
	'registration.isRegisteredBold',
	'registration.pending',
	'registration.notRegistered',
	'registration.unknown',
	'registration.viewCta',
	'registration.editCta',
	'voting.previewBallotCta',
	'voting.voteNowCta',
	'voting.viewSubmissionCta',
	'row.detailsCta',
	'keyholders.viewCta',
	'keyholders.screenTitle',
	'keyholders.releasedCount',
	'keyholders.emptyHeading',
	'keyholders.emptyBody',
	'indeterminate.heading',
	'indeterminate.body',
	'indeterminate.retryCta',
	'dev.clockOffsetLabel',
];

// Pure-placeholder passthroughs — identical EN/ES BY DESIGN (both resolve to a raw
// interpolation token with no surrounding prose), named explicitly so the "EN must differ from
// ES" check below does not false-positive on them.
const IDENTICAL_BY_DESIGN = new Set<string>([
	'subtitle.futureWeekday',
	'subtitle.pastDate',
	'subtitle.futureDate',
	'header.dateRange',
]);

// Case-insensitive "phase" + digits, or "D-" + two digits (a GSD decision id) — the standing
// project rule: never a GSD phase number or decision ID in user-facing copy.
const PHASE_OR_DECISION_ID_PATTERN = /phase\s*\d+|D-\d{2}/i;

describe('timeline i18n copy hygiene (D-13)', () => {
	test('all 39 required keys are present in resources.en.timeline', () => {
		const missing = REQUIRED_TIMELINE_KEYS.filter(k => !(k in enTimeline));
		expect(missing).toEqual([]);
	});

	test('all 39 required keys are present in resources.es.timeline', () => {
		const missing = REQUIRED_TIMELINE_KEYS.filter(k => !(k in esTimeline));
		expect(missing).toEqual([]);
	});

	test('common.tabTimeline is present in both en and es', () => {
		expect(typeof (resources.en.common as Record<string, string>).tabTimeline).toBe('string');
		expect(typeof (resources.es.common as Record<string, string>).tabTimeline).toBe('string');
	});

	test.each(REQUIRED_TIMELINE_KEYS)('en.timeline[%s] is a non-empty, non-whitespace string', key => {
		const value = enTimeline[key];
		expect(typeof value).toBe('string');
		expect(value!.trim().length).toBeGreaterThan(0);
	});

	test.each(REQUIRED_TIMELINE_KEYS)('es.timeline[%s] is a non-empty, non-whitespace string', key => {
		const value = esTimeline[key];
		expect(typeof value).toBe('string');
		expect(value!.trim().length).toBeGreaterThan(0);
	});

	test('common.tabTimeline values are non-empty, non-whitespace strings', () => {
		const enValue = (resources.en.common as Record<string, string>).tabTimeline;
		const esValue = (resources.es.common as Record<string, string>).tabTimeline;
		expect(enValue.trim().length).toBeGreaterThan(0);
		expect(esValue.trim().length).toBeGreaterThan(0);
	});

	test.each(REQUIRED_TIMELINE_KEYS)('en.timeline[%s] contains no phase number or decision id', key => {
		expect(enTimeline[key]).not.toMatch(PHASE_OR_DECISION_ID_PATTERN);
	});

	test.each(REQUIRED_TIMELINE_KEYS)('es.timeline[%s] contains no phase number or decision id', key => {
		expect(esTimeline[key]).not.toMatch(PHASE_OR_DECISION_ID_PATTERN);
	});

	test('common.tabTimeline values contain no phase number or decision id', () => {
		const enValue = (resources.en.common as Record<string, string>).tabTimeline;
		const esValue = (resources.es.common as Record<string, string>).tabTimeline;
		expect(enValue).not.toMatch(PHASE_OR_DECISION_ID_PATTERN);
		expect(esValue).not.toMatch(PHASE_OR_DECISION_ID_PATTERN);
	});

	test.each(REQUIRED_TIMELINE_KEYS.filter(k => !IDENTICAL_BY_DESIGN.has(k)))(
		'en.timeline[%s] is actually translated (differs from es)',
		key => {
			expect(enTimeline[key]).not.toBe(esTimeline[key]);
		},
	);

	test('the four pure-placeholder passthroughs are identical by design (documented, not a translation gap)', () => {
		for (const key of IDENTICAL_BY_DESIGN) {
			expect(enTimeline[key]).toBe(esTimeline[key]);
		}
	});
});
