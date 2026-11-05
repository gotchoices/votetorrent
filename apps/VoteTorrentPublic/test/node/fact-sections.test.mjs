/**
 * fact-sections.test.mjs — where the render layer's ORDERING and BRANCH-
 * SELECTION guarantees are paid for (54-13; D-11, D-12, D-14, D-16, D-35).
 *
 * Every path is resolved through `scripts/lib/source-paths.mjs`'s
 * `publicSrc()` / `uiWebSrc()`, never re-derived from `import.meta.url`.
 *
 * EVERY SOURCE SCAN STRIPS COMMENT LINES BEFORE MATCHING, and that is not
 * hygiene: `FactSections.tsx`'s own header discusses the computed-class form,
 * the gap modifier and the gap letters at length, and `fact-groups.js`'s
 * header discusses the fails-never-defaults rule. A checker whose subject's
 * prose satisfies the pattern it hunts is permanently green — a failure this
 * repo manufactured seven times in Phase 53 alone.
 *
 * EVERY HUNTED LITERAL LIVES IN THE ONE DELIMITED `FIXTURES` OBJECT BELOW, so
 * this file's own prose cannot satisfy its own scan either. Nothing outside
 * that object spells out a class attribute, a copy key or a forbidden column
 * name.
 *
 * WHAT THIS FILE CANNOT PROVE, stated up front because the gap is the whole
 * reason 54-16 exists: it proves that the gap modifier is a STATIC, GREPPABLE
 * class attribute and that the selectors a browser gate needs are present. It
 * proves NOTHING about de-emphasis. Presence is not rendering. The assertion
 * that `.fact-card--gap`'s COMPUTED style diverges from `.fact-card` belongs
 * to the browser tier, and no scan here substitutes for it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publicSrc } from '../../../../scripts/lib/source-paths.mjs';
import { extractStaticClassNameTokens } from '../../../../scripts/lib/css-class-coverage.mjs';
import { COPY } from '../../../../packages/ui-web/src/index.js';
// The two subjects this file EXECUTES are imported by direct relative path --
// the D-25 idiom `election-address.test.mjs` and `election-shell.test.mjs`
// already use for an executed module, as distinct from `publicSrc()`, which is
// for a file read as TEXT. This is not a stylistic preference: a dynamic
// `import()` through a resolver yields an untyped module, and `tsc --noEmit`
// runs over `test/` with `noImplicitAny`, so every callback below would fail
// as an implicit any. The scans further down still resolve every path they
// READ through `publicSrc()`.
import { FACTS, FACT_GROUPS, FACT_COPY_KEYS, GAP_IDS, factsFor } from '../../../../packages/ui-web/src/lifecycle/facts.js';
import { groupFactsForPhase, groupFactList, FactGroupingError } from '../../src/fact-groups.js';
import {
	ROLL_FIELDS,
	ROLL_DISCLOSURE_POLICY,
	resolveRollColumns,
	foldDistrictCounts,
	SMALL_DISTRICT_THRESHOLD,
	DISTRICT_FIELD,
} from '../../src/roll-disclosure.js';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';

/** @param {string[]} segs @returns {string} */
const strippedSrc = (...segs) => stripComments(readFileSync(publicSrc(...segs), 'utf8'));

/** `FACT_GROUPS` widened to plain strings. The model types it as a union, and
 * every comparison below is deliberately made against arbitrary strings so a
 * value that FELL OUT of the union is still measurable rather than a compile
 * error that hides the runtime question. */
const GROUP_NAMES = /** @type {ReadonlyArray<string>} */ (FACT_GROUPS);
/** Same widening for the gap letters, for the same reason. */
const GAP_LETTERS = /** @type {ReadonlyArray<string>} */ (GAP_IDS);

const FACT_SECTIONS = strippedSrc('screens', 'FactSections.tsx');
const FACT_GROUPS_SRC = strippedSrc('fact-groups.js');
const SHELL = strippedSrc('screens', 'ElectionShell.tsx');
const READ_SEAM = strippedSrc('public-election-source.js');

// ===========================================================================
// THE ONE FIXTURE BLOCK. Every literal this file hunts for, and every planted
// violation it runs its controls over, lives here and nowhere else.
// ===========================================================================
const FIXTURES = Object.freeze({
	/** The static class attributes the render layer must spell out literally. */
	gapClassAttr: 'className="fact-card fact-card--gap"',
	filledClassAttr: 'className="fact-card"',
	/** The planted computed form: what a "tidy-up" would produce, and what
	 * makes the class-coverage gate blind. */
	computedClassAttr: 'className={`fact-card ${isGap ? mod : \'\'}`}',
	/** The two kind attributes a browser gate selects on. */
	gapKindAttr: 'data-fact-kind="gap"',
	filledKindAttr: 'data-fact-kind="fact"',
	idAttr: 'data-fact-id',
	groupAttr: 'data-fact-group',
	/** A copy key whose final dot segment is a single character — a gap letter
	 * reaching a rendered string, which D-12 forbids. */
	gapLetterKey: "'public.gap.A'",
	/** A gap field rendered inside a JSX expression container, and one passed
	 * into a t() argument list. */
	gapFieldInJsx: '<span>{fact.gap}</span>',
	gapFieldInT: "const s = t(fact.filledGap, {});",
	/** The Pitfall-4 trap: the denominator fed from the work-item count. */
	badDenominator: 'total: keyRelease.total',
	goodDenominator: 'total: keyRelease.keyholderCount',
	/** Identifying columns D-14 forbids the render layer from ever naming. */
	identifyingColumns: Object.freeze(['UserId', 'SigningNonce', 'TaskId', 'Task']),
	plantedIdentifyingRow: 'const who = row.Task.UserId;',
	/** A raw query result reaching the render layer. */
	plantedRawQuery: 'const r = await db.eval(SQL, {}); return r.rows;',
	/** The four group names, in UI-SPEC top-to-bottom order. */
	groupOrder: Object.freeze(['electionAndRules', 'ballot', 'electorate', 'outcome']),
	/** The six gapped fact ids and the one filled key-release id (D-16). */
	gappedIds: Object.freeze(['turnout', 'receipt', 'merkle', 'results', 'validation', 'certification']),
	filledGapId: 'keyrelease',
	/** The eighth gap that must never exist, and the letter that would carry it. */
	forbiddenGapId: 'runoff',
	forbiddenGapLetter: 'H',
	/** The four renderable phase ids. */
	phases: Object.freeze(['pre', 'voting', 'settling', 'closed']),
	/** Phases that carry no facts at all. */
	emptyPhases: Object.freeze(['indeterminate', null, 'nope']),
	/** D-09's fold: four production-length districts (>= 20 characters,
	 * carrying the `vtx-fixture` marker per `registrant-roll-fixture.js`'s own
	 * standard), used as the worked-example table's A/B/C/D. */
	productionDistricts: Object.freeze([
		'North Bridgewater Ward 3 (vtx-fixture)',
		'South Millbrook Township 4 (vtx-fixture)',
		'East Fairhaven Precinct 9 (vtx-fixture)',
		'West Colchester Borough 2 (vtx-fixture)',
	]),
	/** The declared roll policy with the `District` entry's audience replaced
	 * by a recognised-but-unsatisfiable code, so the chart's mount guard and
	 * the table's column resolution degrade together. */
	withheldDistrictPolicy: Object.freeze(
		ROLL_DISCLOSURE_POLICY.map((e) =>
			e.field === DISTRICT_FIELD ? Object.freeze({ field: e.field, audience: 'district' }) : Object.freeze({ field: e.field, audience: e.audience }),
		),
	),
	/** The two chart mount literals (D-08), and the specific roll-table mount
	 * this file's real JSX contains -- used for ORDERING checks that must not
	 * be confused by `ReadonlyArray<RegistrantRollRow>`'s own `<RegistrantRoll`
	 * substring. */
	meterMount: '<Meter',
	barSeriesMount: '<BarSeries',
	rollMount: '<RegistrantRoll rows={roll} />',
	/** The chart wrapper's static class attribute (D-08), and the body
	 * paragraph's, reused from test 3's D-20 ordering check. */
	chartWrapperClassAttr: 'className="fact-card__chart"',
	bodyClassAttr: 'fact-card__body',
	/** The three copy keys the two chart mounts consume. */
	chartCopyKeys: Object.freeze([
		'public.fact.keyrelease.meterEmpty',
		'public.registrantRoll.chart.otherBucket',
		'public.registrantRoll.chart.tooltip',
	]),
	/** The banned meter denominator, as a JSX PROP -- distinct from
	 * `badDenominator` above, which is the object-property form. */
	badMeterTotalProp: 'total={keyRelease.total}',
	/** The banned Recharts prop that would flip the bar orientation
	 * (`<interface_contract>`'s "orientation trap"). */
	bannedLayoutProp: 'layout=',
	/** D-23's forbidden motion/loading tokens. */
	motionTokens: Object.freeze(['transition', 'animation', 'skeleton', 'loading']),
});

/** Matches a per-datum `tone` property — hue re-encoding value, which D-09 forbids. */
const PER_DATUM_TONE_RE = /\btone:/;
/** Matches a raw, quoted `District` string literal — DISTRICT_FIELD's business, one module over. */
const DISTRICT_LITERAL_RE = /['"`]District['"`]/;
/** Counts non-overlapping occurrences of a mount literal that starts with `<`, requiring the
 * character immediately after the literal is NOT a letter — so `<RegistrantRoll` does not also
 * match inside `<RegistrantRollRow` (the `ReadonlyArray<RegistrantRollRow>` type annotation). */
/** @param {string} literal @returns {RegExp} */
const mountOccurrenceRe = (literal) => new RegExp(`${literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z])`, 'g');
/** @param {string} source @param {string} literal @returns {number} */
const countMountOccurrences = (source, literal) => (source.match(mountOccurrenceRe(literal)) ?? []).length;
/** @param {string} source @param {string} literal @returns {number} index of the first non-collided occurrence, or -1 */
const firstMountIndex = (source, literal) => {
	const re = mountOccurrenceRe(literal);
	const m = re.exec(source);
	return m ? m.index : -1;
};

/** Matches a COMPUTED class attribute — an opening brace directly after
 * `className=`. Built from the fixture so the two cannot drift. */
const COMPUTED_CLASS_RE = /className=\s*\{/;
/** Matches a quoted copy key whose final dot segment is one character. */
const SINGLE_CHAR_KEY_SEGMENT_RE = /['"`]public(?:\.[A-Za-z0-9_]+)*\.[A-Za-z0-9]['"`]/;
/** A gap field inside a same-line JSX expression container. */
const GAP_FIELD_IN_JSX_RE = /\{[^{}\n]*\bfact\.(?:gap|filledGap)\b[^{}\n]*\}/;
/** A gap field inside a `t(` argument list. */
const GAP_FIELD_IN_T_RE = /\bt\(\s*[^)\n]*\bfact\.(?:gap|filledGap)\b/;
/** The denominator taken from the work-item count rather than the keyholders. */
const BAD_DENOMINATOR_RE = /total:\s*\w+\.total\b/;

// ---------------------------------------------------------------------------
// 1. Sanity — anti-vacuous. Without this, every set rung below could pass on
//    an empty model.
// ---------------------------------------------------------------------------

test('1. sanity: the fact model and the grouping both yield something to assert over', () => {
	assert.ok(FACTS.length > 0, 'FACTS is empty — every rung below would pass vacuously');
	assert.ok(FACT_GROUPS.length > 0, 'FACT_GROUPS is empty');
	assert.ok(FACT_COPY_KEYS.length > 0, 'FACT_COPY_KEYS is empty');
	assert.ok(groupFactsForPhase('settling').length > 0, 'the settling phase groups to nothing');
	assert.ok(FACT_SECTIONS.length > 0 && FACT_GROUPS_SRC.length > 0 && SHELL.length > 0, 'a subject file stripped to nothing');
});

// ---------------------------------------------------------------------------
// 2. Group order is UI-SPEC order (D-35).
// ---------------------------------------------------------------------------

test('2. every phase groups into a strictly increasing subsequence of FACT_GROUPS indices, and FACT_GROUPS itself is the UI-SPEC order', () => {
	// Asserted SEPARATELY from the subsequence check so a rename on either
	// side is caught rather than the two cancelling out.
	assert.deepEqual([...FACT_GROUPS], [...FIXTURES.groupOrder]);

	for (const phase of FIXTURES.phases) {
		const indices = groupFactsForPhase(phase).map((g) => GROUP_NAMES.indexOf(g.group));
		assert.ok(
			indices.every((v, i) => v >= 0 && (i === 0 || v > indices[i - 1])),
			`${phase}: groups are not in FACT_GROUPS order — got indices ${JSON.stringify(indices)}`,
		);
	}
});

// ---------------------------------------------------------------------------
// 3. Declaration order and completeness (D-11). The strongest rung here.
//
//    RESTATED AGAINST THE TREE, and the restatement matters. 54-13's plan
//    asked for a whole-page flatten that deep-equals `factsFor(phase)` for
//    every phase. That is FALSE BY CONSTRUCTION for `pre`, and measurably so:
//    `registration` is declared at FACTS index 5 in the `electorate` group,
//    `ballot` at index 6 in the `ballot` group, and `ballot` sorts BEFORE
//    `electorate` in FACT_GROUPS. Grouping a page therefore reorders across
//    groups — that is what grouping IS — and the criterion holds only for the
//    three phases where no such pair happens to interleave.
//
//    Satisfying the criterion literally would mean abandoning either the
//    UI-SPEC's group order or the grouping itself. So what is asserted here is
//    what D-11 actually requires and what the must-haves actually say:
//    nothing is dropped or duplicated ANYWHERE, and WITHIN a group the facts
//    are a subsequence of FACTS in declaration order. The whole-page flatten is
//    still pinned exactly for the three phases where it is a true statement,
//    with the interleaving pair named below so a later reader who "restores"
//    the stronger-looking form meets the reason rather than weakening the
//    grouping to satisfy it.
// ---------------------------------------------------------------------------

/** The declaration index of every fact, by id — the order D-11 preserves.
 * A plain object rather than a Map, and `-1` rather than `undefined` for an
 * unknown id, so an id that fell out of the model reads as an ORDER VIOLATION
 * below instead of silently comparing as undefined. */
const DECLARATION_INDEX = Object.freeze(Object.fromEntries(FACTS.map((f, i) => [f.id, i])));

/** @param {string} id @returns {number} */
function declarationIndexOf(id) {
	const index = DECLARATION_INDEX[id];
	return typeof index === 'number' ? index : -1;
}

test('3. nothing is dropped or duplicated, for any phase', () => {
	for (const phase of FIXTURES.phases) {
		const flat = groupFactsForPhase(phase).flatMap((g) => g.facts.map((f) => f.id));
		const expected = factsFor(phase).map((f) => f.id);
		assert.equal(flat.length, expected.length, `${phase}: the grouping changed the card count`);
		assert.deepEqual([...flat].sort(), [...expected].sort(), `${phase}: the grouping dropped or duplicated a fact`);
	}
});

test('3a. within every returned group, the facts are a strictly increasing subsequence of FACTS declaration order (D-11)', () => {
	for (const phase of FIXTURES.phases) {
		for (const group of groupFactsForPhase(phase)) {
			const indices = group.facts.map((f) => declarationIndexOf(f.id));
			assert.ok(
				indices.every((v, i) => v >= 0 && (i === 0 || v > indices[i - 1])),
				`${phase}/${group.group}: the facts are not in declaration order — got ${JSON.stringify(indices)}`,
			);
		}
	}
});

test('3b. the whole-page flatten is exact for the three phases where cross-group declaration order does not interleave, and the interleaving pair in pre is named rather than assumed', () => {
	for (const phase of ['voting', 'settling', 'closed']) {
		const flat = groupFactsForPhase(phase).flatMap((g) => g.facts.map((f) => f.id));
		assert.deepEqual(flat, factsFor(phase).map((f) => f.id), `${phase}: the flatten diverged from declaration order`);
	}

	// The measured reason `pre` is excluded — asserted, not asserted-about, so
	// this exclusion expires the moment the model stops interleaving.
	const earlier = FACTS.find((f) => f.id === 'registration');
	const later = FACTS.find((f) => f.id === 'ballot');
	assert.ok(earlier && later, 'the named interleaving pair no longer exists in the model');
	assert.ok(
		declarationIndexOf(earlier.id) < declarationIndexOf(later.id),
		'the pair no longer interleaves by declaration index — re-check whether pre can rejoin the exact assertion above',
	);
	assert.ok(
		GROUP_NAMES.indexOf(later.group) < GROUP_NAMES.indexOf(earlier.group),
		'the pair no longer interleaves by group order — re-check whether pre can rejoin the exact assertion above',
	);
	assert.notDeepEqual(
		groupFactsForPhase('pre').flatMap((g) => g.facts.map((f) => f.id)),
		factsFor('pre').map((f) => f.id),
		'pre no longer diverges — fold it back into the exact assertion above instead of leaving a dead exclusion',
	);
});

// ---------------------------------------------------------------------------
// 4. Gaps are interleaved, never sectioned off (D-11).
//
//    THE REJECTED ALTERNATIVE this defends against: a separate "not yet
//    available" section holding every gap. It was rejected because it severs
//    the adjacency — a reader who skims the facts never meets the absence at
//    the point where they are forming a belief about the thing it qualifies.
//    Turnout must sit next to polls, not in an appendix.
// ---------------------------------------------------------------------------

test('4. at least one returned group holds BOTH a gapped and a non-gapped fact, for voting and for settling', () => {
	for (const phase of ['voting', 'settling']) {
		const mixed = groupFactsForPhase(phase).filter(
			(g) => g.facts.some((f) => f.gap !== null) && g.facts.some((f) => f.gap === null),
		);
		assert.ok(mixed.length > 0, `${phase}: no group holds a gap beside a fact — the gaps have been sectioned off`);
	}
});

// ---------------------------------------------------------------------------
// 5. Empty groups omitted; empty phases return a frozen empty array.
// ---------------------------------------------------------------------------

test('5. no returned group is empty, and a phase carrying no facts returns a frozen empty array without throwing', () => {
	for (const phase of FIXTURES.phases) {
		for (const group of groupFactsForPhase(phase)) {
			assert.ok(group.facts.length > 0, `${phase}: an empty ${group.group} heading was rendered`);
			assert.ok(Object.isFrozen(group) && Object.isFrozen(group.facts), 'a returned group or its facts array is not frozen');
		}
	}
	for (const phase of FIXTURES.emptyPhases) {
		const result = groupFactsForPhase(phase);
		assert.equal(result.length, 0, `${String(phase)} yielded groups`);
		assert.ok(Object.isFrozen(result), `${String(phase)} did not yield a FROZEN empty array`);
	}
});

// ---------------------------------------------------------------------------
// 6. Fails, never defaults (D-35) — the positive control runs through the
//    REAL exported path. A control over a re-implementation proves nothing
//    about the implementation.
// ---------------------------------------------------------------------------

test('6. groupFactList throws a named FactGroupingError, naming the offending id, for an unrecognised group AND for a missing one', () => {
	assert.equal(typeof groupFactList, 'function', 'the validator is not exported — the control below would have to duplicate it');

	for (const planted of [
		{ id: 'planted-unrecognised', group: 'not-a-group', gap: null },
		{ id: 'planted-undefined', group: undefined, gap: null },
	]) {
		assert.throws(
			() => groupFactList([planted]),
			(/** @type {any} */ err) => {
				assert.equal(err.name, 'FactGroupingError', 'the throw is not the named error');
				assert.ok(err instanceof FactGroupingError, 'the exported class is not the one thrown');
				assert.ok(String(err.message).includes(planted.id), 'the message does not name the offending fact');
				return true;
			},
			`${planted.id} did not fail — a defaulted bucket would silently relocate a fact, invisibly to any gate that only counts cards`,
		);
	}

	// Inertness: the same real path accepts a well-formed list, so the throws
	// above discriminate rather than firing on everything.
	assert.equal(groupFactList([...factsFor('settling')]).length > 0, true, 'the validator rejects a well-formed list — it fires on everything');
});

// ---------------------------------------------------------------------------
// 7. Six gap cards and ONE filled key-release card — no runoff (D-16).
//
//    Runoff is an UNMODELLED CONCEPT, not an unstored fact. There is no entry
//    for it in FACTS and no letter for it in GAP_IDS, and this rung is what
//    keeps an eighth gap out when a later reader "notices it is missing".
// ---------------------------------------------------------------------------

test('7. exactly six gapped entries, exactly one filled-gap entry (keyrelease, gap null), no runoff and no eighth letter', () => {
	const gapped = FACTS.filter((f) => f.gap !== null).map((f) => f.id);
	assert.deepEqual([...gapped].sort(), [...FIXTURES.gappedIds].sort(), 'the gap set is not the six D-16 admits');

	const filled = FACTS.filter((f) => f.filledGap !== null);
	assert.equal(filled.length, 1, 'expected exactly one filled-gap entry');
	assert.equal(filled[0].id, FIXTURES.filledGapId);
	assert.equal(filled[0].gap, null, 'the key-release entry carries a gap — it would render on the GAP branch, contradicting D-14');

	assert.ok(!FACTS.some((f) => f.id === FIXTURES.forbiddenGapId), 'a runoff entry was invented');
	assert.ok(!GAP_LETTERS.includes(FIXTURES.forbiddenGapLetter), 'an eighth gap letter appeared');
	assert.ok(
		!FACTS.some((f) => String(f.gap) === FIXTURES.forbiddenGapLetter || String(f.filledGap) === FIXTURES.forbiddenGapLetter),
		'a fact carries the eighth gap letter',
	);

	// And the routing fact the render layer actually consults.
	const inSettling = groupFactsForPhase('settling').flatMap((g) => g.facts).find((f) => f.id === FIXTURES.filledGapId);
	assert.ok(inSettling, 'the key-release entry is not present in the settling phase at all');
	assert.equal(inSettling.gap, null, 'the settling key-release entry would take the gap branch');
});

// ---------------------------------------------------------------------------
// 8. The gap modifier is a STATIC, GREPPABLE class attribute.
//
//    THE MECHANISM: `scripts/lib/css-class-coverage.mjs`'s
//    `extractStaticClassNameTokens` matches only brace-free class attributes.
//    A computed one makes the tier-1 class-coverage gate structurally blind to
//    the gap modifier — and a mounted class with no matching selector is
//    exactly the defect class this repo has shipped twice past green gates.
//    The control below runs the REAL extractor, not a local approximation.
// ---------------------------------------------------------------------------

test('8. positive control: the real extractor sees the gap modifier in the literal form and is BLIND to it in the computed form', () => {
	const fromLiteral = extractStaticClassNameTokens(FIXTURES.gapClassAttr);
	assert.ok(fromLiteral.has('fact-card--gap'), 'the extractor cannot see the gap modifier even in the literal form — the control is broken');
	assert.ok(fromLiteral.has('fact-card'));

	const fromComputed = extractStaticClassNameTokens(FIXTURES.computedClassAttr);
	assert.equal(fromComputed.size, 0, 'the extractor read tokens out of a computed attribute — this control no longer proves the blindness');
	assert.match(FIXTURES.computedClassAttr, COMPUTED_CLASS_RE, 'the computed-class matcher is inert against the planted form');
	assert.doesNotMatch(FIXTURES.gapClassAttr, COMPUTED_CLASS_RE, 'the computed-class matcher fires on the literal form');
});

test('8. FactSections.tsx spells both class attributes out literally and contains no computed class attribute anywhere', () => {
	assert.ok(FACT_SECTIONS.includes(FIXTURES.gapClassAttr), 'the gap card class attribute is not a literal');
	assert.ok(FACT_SECTIONS.includes(FIXTURES.filledClassAttr), 'the filled card class attribute is not a literal');
	assert.doesNotMatch(
		FACT_SECTIONS,
		COMPUTED_CLASS_RE,
		'a computed class attribute makes css-class-coverage blind to whatever it computes — the duplication between the two branches IS that gate\'s evidence',
	);

	// And the real extractor really does recover the modifier from the real file.
	const tokens = extractStaticClassNameTokens(FACT_SECTIONS);
	assert.ok(tokens.has('fact-card--gap'), 'the class-coverage gate cannot see the gap modifier in the real source');
});

// ---------------------------------------------------------------------------
// 9. No second disclosure, no hook, no raw HTML.
//
//    D-12 says THE EXISTING toggle. A parallel disclosure would fork the D-19
//    React-identity gate's subject, whose whole value is being the one
//    hook-calling component on the page. And `AdvisoryDisclosure` must never
//    appear here at all — a rule this file inherits from `DetailsToggle`'s own
//    header: the advisory may never become conditional on anything.
// ---------------------------------------------------------------------------

test('9. FactSections.tsx mounts DetailsToggle and nothing else stateful — no hook, no native disclosure, no raw HTML, no advisory', () => {
	for (const forbidden of ['useState', 'useReducer', 'useEffect', '<details', '<summary', 'dangerouslySetInnerHTML', '<AdvisoryDisclosure']) {
		assert.ok(!FACT_SECTIONS.includes(forbidden), `FactSections.tsx contains ${forbidden}`);
	}
	assert.ok(FACT_SECTIONS.includes('<DetailsToggle'), 'the shared toggle is not mounted at all — D-12 requires the reason to sit behind it');
});

// ---------------------------------------------------------------------------
// 10. No gap letter can reach the reader (D-12). Two halves, each with its own
//     planted-violation control.
// ---------------------------------------------------------------------------

test('10. positive controls: both halves of the gap-letter scan fire on their planted violations and are silent on the real forms', () => {
	assert.match(FIXTURES.gapLetterKey, SINGLE_CHAR_KEY_SEGMENT_RE, 'the single-character-segment matcher is inert');
	assert.doesNotMatch("'public.gap.detailsSummary'", SINGLE_CHAR_KEY_SEGMENT_RE, 'the matcher fires on an ordinary key');
	assert.match(FIXTURES.gapFieldInJsx, GAP_FIELD_IN_JSX_RE, 'the JSX-container matcher is inert against a rendered gap field');
	assert.match(FIXTURES.gapFieldInT, GAP_FIELD_IN_T_RE, 'the t()-argument matcher is inert against an interpolated gap field');
	assert.doesNotMatch('if (fact.gap !== null) {', GAP_FIELD_IN_JSX_RE, 'the matcher fires on the branch predicate, which is the sanctioned use');
	assert.doesNotMatch('if (fact.gap !== null) {', GAP_FIELD_IN_T_RE);
});

test('10a. neither render-layer file renders a gap field or a single-character copy key', () => {
	for (const [label, source] of [['FactSections.tsx', FACT_SECTIONS], ['fact-groups.js', FACT_GROUPS_SRC]]) {
		assert.doesNotMatch(source, SINGLE_CHAR_KEY_SEGMENT_RE, `${label} names a copy key whose final segment is one character — a gap letter on screen`);
		assert.doesNotMatch(source, GAP_FIELD_IN_JSX_RE, `${label} renders a gap field inside a JSX expression container`);
		assert.doesNotMatch(source, GAP_FIELD_IN_T_RE, `${label} passes a gap field into t()`);
	}
});

test('10b. every key the fact model can emit is dotted lowercase-ish prose, with no single-character segment anywhere', () => {
	const shape = /^public\.[A-Za-z]+(\.[A-Za-z]+)*$/;
	for (const key of FACT_COPY_KEYS) {
		assert.match(key, shape, `${key} is not in the public.* dotted shape`);
		for (const segment of key.split('.')) {
			assert.ok(segment.length > 1, `${key} carries a single-character segment — that is how a gap letter reaches a reader`);
		}
	}
	// Control: the planted key is in the same family and IS rejected.
	assert.ok(FIXTURES.gapLetterKey.replace(/'/g, '').split('.').some((s) => s.length === 1), 'the planted control key has no single-character segment');
});

// ---------------------------------------------------------------------------
// 11. No work-item row can reach the render layer (D-14).
//
//     RESTATED AGAINST THE TREE. This plan's own acceptance criterion asked
//     that `ElectionShell.tsx` name `readKeyReleaseProgress` directly. That is
//     UNSATISFIABLE without breaking a landed gate: `election-shell.test.mjs`
//     case 12b asserts the shell contains ZERO `useEffect`, ZERO `await ` and
//     no read call, because a second `return` in that file is the cheapest way
//     to make `AdvisoryDisclosure` conditional by accident. So the aggregate is
//     read in `public-election-source.js` — the one seam that already owns the
//     handle's lifetime, which is also what "alongside the existing reads"
//     points at — and the shell passes the resulting three numbers down. The
//     assertion below is written where the wiring actually lives, so it stays a
//     real check rather than a restated one.
// ---------------------------------------------------------------------------

test('11. positive control: the identifying-column and raw-query matchers fire on their planted fixtures', () => {
	assert.ok(FIXTURES.identifyingColumns.some((c) => FIXTURES.plantedIdentifyingRow.includes(c)), 'the planted row names no forbidden column');
	assert.ok(FIXTURES.plantedRawQuery.includes('.rows'), 'the planted raw query exposes no result rows');
	assert.ok(FIXTURES.plantedRawQuery.includes('db.eval('), 'the planted raw query issues no direct engine call');
});

test('11a. FactSections.tsx names no identifying column, and the shell hands it only the three numbers', () => {
	for (const column of FIXTURES.identifyingColumns) {
		assert.ok(!FACT_SECTIONS.includes(column), `FactSections.tsx names ${column} — D-14 forbids any work-item row reaching the render layer`);
	}
	assert.ok(!SHELL.includes('.rows'), 'the shell touches a raw query result');
	assert.ok(!SHELL.includes('db.eval('), 'the shell issues a direct engine call');
	assert.match(SHELL, /<FactSections[^>]*keyRelease=\{[^}]*\}/, 'the shell does not hand FactSections a key-release value at all');
});

test('11b. the aggregate is wired in the read seam that owns the handle, and only three fields are copied out of it', () => {
	assert.ok(READ_SEAM.includes('readKeyReleaseProgress'), 'public-election-source.js does not wire D-14 readKeyReleaseProgress');
	for (const field of ['released:', 'total:', 'keyholderCount:']) {
		assert.ok(READ_SEAM.includes(field), `the read seam does not copy ${field} out of the aggregate`);
	}
	for (const column of FIXTURES.identifyingColumns) {
		assert.ok(!READ_SEAM.includes(column), `public-election-source.js names ${column}`);
	}
});

// ---------------------------------------------------------------------------
// 12. The denominator is the keyholder count, not the work-item count.
//
//     `total` counts release-key work items, which is ZERO before any is
//     raised — so a denominator taken from it renders "0 of 0" for the ENTIRE
//     settling window, indistinguishable from a genuinely empty election
//     (54-RESEARCH Pitfall 4). The interpolation PARAMETER keeps the name
//     `total` because that is the placeholder the sentence declares and 54-04
//     froze in `interpolates`; renaming it would make `t()` throw. Only the
//     VALUE moves.
// ---------------------------------------------------------------------------

test('12. positive control: the bad-denominator matcher fires on the planted trap and is silent on the landed form', () => {
	assert.match(FIXTURES.badDenominator, BAD_DENOMINATOR_RE, 'the bad-denominator matcher is inert against the planted trap');
	assert.doesNotMatch(FIXTURES.goodDenominator, BAD_DENOMINATOR_RE, 'the matcher fires on the correct form');
});

test('12a. FactSections.tsx feeds the total placeholder from the keyholder count and never from the work-item count', () => {
	assert.ok(FACT_SECTIONS.includes(FIXTURES.goodDenominator), 'the total placeholder is not fed from keyholderCount');
	assert.doesNotMatch(FACT_SECTIONS, BAD_DENOMINATOR_RE, 'the total placeholder is fed from the work-item count — it would read "0 of 0" all through settling');
});

// ---------------------------------------------------------------------------
// 13. The shell's structural rules survive.
//
//     These PARTLY DUPLICATE `election-shell.test.mjs`'s own rungs, and that
//     is deliberate rather than redundant: the two NEW facts are that the
//     mount exists and that it is positioned correctly. Do not delete one of
//     these as a duplicate — the overlap is what makes this file fail on its
//     own subject rather than sending a reader to another file.
// ---------------------------------------------------------------------------

test('13. ElectionShell.tsx keeps one return and one of each mount, with FactSections before the advisory and the advisory outside the toggle', () => {
	const count = (/** @type {RegExp} */ re) => (SHELL.match(re) ?? []).length;
	assert.equal(count(/\breturn\b/g), 1, 'the shell gained a second return — the advisory can now be branched away');
	for (const [name, re] of [
		['LifecyclePill', /<LifecyclePill\b/g],
		['AdvisoryDisclosure', /<AdvisoryDisclosure\b/g],
		['DetailsToggle', /<DetailsToggle\b/g],
		['FactSections', /<FactSections\b/g],
	]) {
		assert.equal(count(/** @type {RegExp} */ (re)), 1, `expected exactly one ${name} mount`);
	}
	assert.ok(SHELL.indexOf('<FactSections') < SHELL.indexOf('<AdvisoryDisclosure'), 'layout order: the fact sections must precede the advisory');
	assert.doesNotMatch(SHELL, /<DetailsToggle[\s\S]*<AdvisoryDisclosure[\s\S]*<\/DetailsToggle>/, 'the advisory was nested inside the toggle');
});

// ---------------------------------------------------------------------------
// 14. Render-gate readiness for the browser tier — THE CHECKABILITY RUNG.
//
//     This proves only that the SELECTORS a computed-style gate needs exist.
//     It proves NOTHING about de-emphasis: presence is not rendering, and the
//     assertion that `.fact-card--gap` computes differently from `.fact-card`
//     has to happen in a real browser, on a page where both are rendered.
//     `settling` is the phase that renders both kinds together.
// ---------------------------------------------------------------------------

test('14. both branches carry a stable id attribute, each kind attribute appears exactly once, and settling renders both kinds on one page', () => {
	assert.equal((FACT_SECTIONS.match(new RegExp(FIXTURES.idAttr, 'g')) ?? []).length, 2, 'expected one id attribute per branch');
	for (const attr of [FIXTURES.gapKindAttr, FIXTURES.filledKindAttr]) {
		assert.equal(FACT_SECTIONS.split(attr).length - 1, 1, `expected exactly one ${attr}`);
	}
	assert.ok(FACT_SECTIONS.includes(FIXTURES.groupAttr), 'the section carries no group attribute for a browser gate to select on');

	const settling = groupFactsForPhase('settling').flatMap((g) => g.facts);
	assert.ok(settling.some((f) => f.gap !== null), 'settling renders no gap card — the browser gate would have only one subject');
	assert.ok(settling.some((f) => f.gap === null), 'settling renders no filled card — the browser gate would have only one subject');
});

// ---------------------------------------------------------------------------
// 15. D-09's small-district fold (`foldDistrictCounts`) — executed, not read
//     as text. Every row of this plan's worked-example table is encoded
//     verbatim, using production-length districts throughout.
// ---------------------------------------------------------------------------

const [DIST_A, DIST_B, DIST_C, DIST_D] = FIXTURES.productionDistricts;

/**
 * Builds a `rows` array from a list of `[district, count]` pairs. A
 * `district` of `undefined` produces rows with no `District` property at
 * all — the "unstated" case.
 * @param {ReadonlyArray<[string | undefined, number]>} spec
 * @returns {Array<{ District?: string }>}
 */
function districtRows(spec) {
	/** @type {Array<{ District?: string }>} */
	const rows = [];
	for (const [district, count] of spec) {
		for (let i = 0; i < count; i += 1) rows.push(district === undefined ? {} : { District: district });
	}
	return rows;
}

/** @param {ReadonlyArray<Readonly<{ label: string | null, count: number, folded: boolean }>>} buckets */
const bucketShape = (buckets) => buckets.map((b) => ({ label: b.label, count: b.count, folded: b.folded }));

test('15. sanity: SMALL_DISTRICT_THRESHOLD is 2, ROLL_FIELDS includes DISTRICT_FIELD, and every production district fixture is at least 20 characters', () => {
	assert.equal(SMALL_DISTRICT_THRESHOLD, 2, "the threshold is not D-09's justified value");
	assert.ok(ROLL_FIELDS.includes(DISTRICT_FIELD), 'DISTRICT_FIELD disagrees with ROLL_FIELDS');
	for (const d of FIXTURES.productionDistricts) {
		assert.ok(d.length >= 20, `production district "${d}" is shorter than 20 characters — too short to catch a real clipping defect`);
	}
});

test('16. A=7,B=5,C=1: C folds, and B folds too by the complementary-disclosure guard — A(7), Other(6)', () => {
	const buckets = foldDistrictCounts(districtRows([[DIST_A, 7], [DIST_B, 5], [DIST_C, 1]]));
	assert.deepEqual(bucketShape(buckets), [
		{ label: DIST_A, count: 7, folded: false },
		{ label: null, count: 6, folded: true },
	]);
	assert.ok(!buckets.some((b) => b.label === DIST_B), 'B is still named on the axis — the complementary-disclosure guard did not fire');
});

test('17. A=7,B=5,C=1,D=1: C and D fold, the bucket already aggregates two groups — A(7), B(5), Other(2)', () => {
	const buckets = foldDistrictCounts(districtRows([[DIST_A, 7], [DIST_B, 5], [DIST_C, 1], [DIST_D, 1]]));
	assert.deepEqual(bucketShape(buckets), [
		{ label: DIST_A, count: 7, folded: false },
		{ label: DIST_B, count: 5, folded: false },
		{ label: null, count: 2, folded: true },
	]);
});

test('18. A=7,B=5: neither folds — A(7), B(5), no Other bucket', () => {
	const buckets = foldDistrictCounts(districtRows([[DIST_A, 7], [DIST_B, 5]]));
	assert.deepEqual(bucketShape(buckets), [
		{ label: DIST_A, count: 7, folded: false },
		{ label: DIST_B, count: 5, folded: false },
	]);
});

test('19. A=1 alone: the lone group still folds — one unnamed Other(1), never a named bar of one', () => {
	const buckets = foldDistrictCounts(districtRows([[DIST_A, 1]]));
	assert.deepEqual(bucketShape(buckets), [{ label: null, count: 1, folded: true }]);
});

test('20. A=7,B=5, plus 2 unstated rows: the unstated group folds, and B folds too by the guard — A(7), Other(7)', () => {
	const buckets = foldDistrictCounts([...districtRows([[DIST_A, 7], [DIST_B, 5]]), {}, {}]);
	assert.deepEqual(bucketShape(buckets), [
		{ label: DIST_A, count: 7, folded: false },
		{ label: null, count: 7, folded: true },
	]);
	assert.ok(!buckets.some((b) => b.label === DIST_B), 'B is still named on the axis — the complementary-disclosure guard did not fire');
});

test('21. District withheld by policy: foldDistrictCounts returns an empty array, in lockstep with resolveRollColumns', () => {
	const rows = districtRows([[DIST_A, 7], [DIST_B, 5]]);
	assert.deepEqual(foldDistrictCounts(rows, FIXTURES.withheldDistrictPolicy), []);
	assert.ok(
		!resolveRollColumns(FIXTURES.withheldDistrictPolicy).columns.includes(DISTRICT_FIELD),
		'fixture sanity: the withheld policy still permits District — the two disclosure paths would be out of lockstep',
	);
});

test('22. robustness: null, undefined and [] never throw and resolve to an empty verdict, and every row whose District is not a non-empty string lands in the folded bucket', () => {
	for (const input of [null, undefined, []]) {
		assert.doesNotThrow(() => foldDistrictCounts(/** @type {any} */ (input)));
		assert.deepEqual(foldDistrictCounts(/** @type {any} */ (input)), []);
	}
	const rows = [...districtRows([[DIST_A, 5], [DIST_B, 5]]), { District: null }, { District: '' }, { District: 5 }];
	/** @type {ReadonlyArray<{ label: string | null, count: number, folded: boolean }>} */
	let buckets = [];
	assert.doesNotThrow(() => {
		buckets = /** @type {any} */ (foldDistrictCounts(/** @type {any} */ (rows)));
	});
	const otherBucket = buckets.find((b) => b.label === null);
	assert.ok(otherBucket, 'no unnamed bucket formed — the three malformed-District rows must land somewhere');
	assert.ok(
		otherBucket.count >= 3,
		`the unnamed bucket's count (${otherBucket.count}) does not include the three malformed-District rows`,
	);
});

test("23. determinism: the same rows in a different order fold to a deepEqual result — D-23's silent redraw needs a stable order", () => {
	const rows = districtRows([[DIST_A, 7], [DIST_B, 5], [DIST_C, 1]]);
	const shuffled = [...rows].reverse();
	assert.deepEqual(foldDistrictCounts(rows), foldDistrictCounts(shuffled));
});

test('24. every returned bucket array and entry is frozen', () => {
	const buckets = foldDistrictCounts(districtRows([[DIST_A, 7], [DIST_B, 5], [DIST_C, 1]]));
	assert.ok(Object.isFrozen(buckets), 'the returned array is not frozen');
	for (const b of buckets) assert.ok(Object.isFrozen(b), 'a bucket entry is not frozen');
});

// ---------------------------------------------------------------------------
// 25-32. Source-shape rungs for the two mounts C6/C7 land in Task 2 (D-08,
// D-09, D-20, D-23). Every hunted literal lives in FIXTURES above; every
// rung's own matcher gets a named positive control BEFORE the real source is
// scanned, run against a planted fixture rather than a re-implementation.
// ---------------------------------------------------------------------------

test('25. positive control: the mount-count matcher (word-boundary-safe against <RegistrantRollRow-style collisions) is inert on a violating count and fires on a healthy planted mount', () => {
	assert.equal(countMountOccurrences(FIXTURES.meterMount + ' />', FIXTURES.meterMount), 1, 'the <Meter count matcher is inert against a planted healthy mount');
	assert.equal(countMountOccurrences(FIXTURES.barSeriesMount + ' />', FIXTURES.barSeriesMount), 1, 'the <BarSeries count matcher is inert against a planted healthy mount');
	// The collision this matcher exists to avoid: a type annotation must not count as a mount.
	assert.equal(countMountOccurrences(FIXTURES.rollMount + 'Row>', FIXTURES.rollMount), 0, 'the matcher counted a mount inside a longer identifier — the word-boundary guard is broken');
	const violating = FIXTURES.meterMount + ' />' + FIXTURES.filledKindAttr;
	assert.ok(firstMountIndex(violating, FIXTURES.meterMount) < violating.indexOf(FIXTURES.filledKindAttr), 'fixture sanity: the planted violation puts the mount before the kind attribute');
});

test('25a. D-08: exactly one <Meter and one <BarSeries mount, both inside the filled card (after data-fact-kind="fact"), and neither reaches the gap branch', () => {
	assert.equal(countMountOccurrences(FACT_SECTIONS, FIXTURES.meterMount), 1, 'expected exactly one <Meter mount');
	assert.equal(countMountOccurrences(FACT_SECTIONS, FIXTURES.barSeriesMount), 1, 'expected exactly one <BarSeries mount');
	const kindIndex = FACT_SECTIONS.indexOf(FIXTURES.filledKindAttr);
	assert.ok(kindIndex >= 0, 'the filled kind attribute is no longer present');
	assert.ok(firstMountIndex(FACT_SECTIONS, FIXTURES.meterMount) > kindIndex, "the Meter mount does not follow the filled card's own kind attribute — it may have reached the gap branch");
	assert.ok(firstMountIndex(FACT_SECTIONS, FIXTURES.barSeriesMount) > kindIndex, "the BarSeries mount does not follow the filled card's own kind attribute — it may have reached the gap branch");
});

test('26. positive control: the roll-precedes-chart ordering check is inert on a violating fixture (chart before the roll mount) and fires on a healthy one', () => {
	const violating = FIXTURES.barSeriesMount + FIXTURES.rollMount;
	assert.ok(violating.indexOf(FIXTURES.barSeriesMount) < violating.indexOf(FIXTURES.rollMount), 'fixture sanity: the violating fixture puts the chart first');
	const healthy = FIXTURES.rollMount + FIXTURES.barSeriesMount;
	assert.ok(healthy.indexOf(FIXTURES.rollMount) < healthy.indexOf(FIXTURES.barSeriesMount), 'fixture sanity: the healthy fixture puts the roll mount first');
});

test('26a. D-20: exactly one <RegistrantRoll mount remains, it precedes the roll-composition chart, and the body paragraph precedes the key-release meter', () => {
	assert.equal(countMountOccurrences(FACT_SECTIONS, '<RegistrantRoll'), 1, 'expected exactly one <RegistrantRoll mount — the table was replaced rather than kept (D-20)');
	assert.ok(FACT_SECTIONS.includes(FIXTURES.rollMount), 'the roll mount is not the exact literal this rung expects');
	assert.ok(FACT_SECTIONS.indexOf(FIXTURES.rollMount) < FACT_SECTIONS.indexOf(FIXTURES.barSeriesMount), 'the roll table does not precede the roll-composition chart');
	assert.ok(FACT_SECTIONS.includes(FIXTURES.bodyClassAttr), 'the body paragraph class is no longer present');
	assert.ok(FACT_SECTIONS.indexOf(FIXTURES.bodyClassAttr) < firstMountIndex(FACT_SECTIONS, FIXTURES.meterMount), 'the body paragraph does not precede the key-release meter');
});

test('27. positive control: the second-resolution-site and raw-District-literal matchers fire on planted violations and are silent on the real, sanctioned forms', () => {
	assert.ok('import { resolveRollColumns } from \'../roll-disclosure.js\';'.includes('resolveRollColumns'), 'fixture sanity: the planted second-resolution import names resolveRollColumns');
	assert.match("const f = row['District'];", DISTRICT_LITERAL_RE, 'the raw-District-literal matcher is inert against a planted violation');
	assert.doesNotMatch('const f = DISTRICT_FIELD;', DISTRICT_LITERAL_RE, 'the matcher fires on the sanctioned form — a named constant, never a raw literal');
});

test('27a. D-09: FactSections.tsx imports foldDistrictCounts from roll-disclosure.js, holds no second disclosure-resolution site, and names no raw District literal', () => {
	assert.match(FACT_SECTIONS, /foldDistrictCounts[\s\S]*from '\.\.\/roll-disclosure\.js'/, 'FactSections.tsx does not import foldDistrictCounts from roll-disclosure.js');
	assert.ok(!FACT_SECTIONS.includes('resolveRollColumns'), 'FactSections.tsx holds a second disclosure-resolution site — T-60-06-01 forbids it, the fold must resolve the policy itself');
	assert.ok(!FACT_SECTIONS.includes('ROLL_DISCLOSURE_POLICY'), 'FactSections.tsx names the policy directly — District must resolve only through foldDistrictCounts');
	assert.doesNotMatch(FACT_SECTIONS, DISTRICT_LITERAL_RE, "FactSections.tsx names a raw District string literal — that is DISTRICT_FIELD's business, one module over");
});

test('28. positive control: the per-datum-tone matcher fires on a planted tone property and is silent on the sanctioned defaultTone form', () => {
	assert.match("tone: 'series-2',", PER_DATUM_TONE_RE, 'the per-datum-tone matcher is inert against a planted violation');
	assert.doesNotMatch('defaultTone="series-1"', PER_DATUM_TONE_RE, 'the matcher fires on the sanctioned defaultTone form');
});

test('28a. D-09: defaultTone="series-1" appears exactly once and no per-datum tone property exists — every district bar is the same hue', () => {
	assert.equal(FACT_SECTIONS.split('defaultTone="series-1"').length - 1, 1, 'expected exactly one defaultTone="series-1"');
	assert.doesNotMatch(FACT_SECTIONS, PER_DATUM_TONE_RE, 'FactSections.tsx sets a per-datum tone — hue would then re-encode value, which D-09 and UI-SPEC C7 both forbid');
});

test('29. positive control: the banned layout= prop matcher fires on a planted layout="vertical" fixture and is silent on the sanctioned orientation form', () => {
	assert.ok('layout="vertical"'.includes(FIXTURES.bannedLayoutProp), 'the planted violation does not actually contain the banned prop');
	assert.ok(!'orientation="horizontal"'.includes(FIXTURES.bannedLayoutProp), 'the matcher fires on the sanctioned orientation form');
});

test('29a. the orientation trap: FactSections.tsx passes orientation="horizontal" to BarSeries and never a layout= prop', () => {
	assert.ok(FACT_SECTIONS.includes('orientation="horizontal"'), 'FactSections.tsx does not pass orientation="horizontal" to BarSeries');
	assert.ok(!FACT_SECTIONS.includes(FIXTURES.bannedLayoutProp), "FactSections.tsx passes a layout= prop directly — see <interface_contract>'s orientation trap");
});

test('30. positive control: each D-23 motion/loading token matcher fires on its own planted fixture', () => {
	for (const token of FIXTURES.motionTokens) {
		assert.ok(('the ' + token + ' state').includes(token), `the ${token} matcher is inert against its own planted fixture`);
	}
});

test('30a. D-23: FactSections.tsx contains none of transition, animation, skeleton or loading, and no hook token, anywhere in its comment-stripped source', () => {
	for (const token of FIXTURES.motionTokens) {
		assert.ok(!FACT_SECTIONS.includes(token), `FactSections.tsx contains "${token}" — D-23 forbids any motion or loading state reaching this public page`);
	}
	for (const hook of ['useState', 'useReducer', 'useEffect']) {
		assert.ok(!FACT_SECTIONS.includes(hook), `FactSections.tsx contains ${hook} — test 9 already forbids this; restated here for D-23's own reason`);
	}
});

test('31. positive control: the quoted-copy-key occurrence counter fires the planted count on a doubled mount and is silent on a single one', () => {
	const single = 'emptyCopyKey="public.fact.keyrelease.meterEmpty"';
	const doubled = single + single;
	/** @param {string} source @param {string} key @returns {number} */
	const countOf = (source, key) => (source.match(new RegExp(`['"\`]${key.replace(/\./g, '\\.')}['"\`]`, 'g')) ?? []).length;
	assert.equal(countOf(doubled, FIXTURES.chartCopyKeys[0]), 2, 'the occurrence counter is inert against a planted doubled mount');
	assert.equal(countOf(single, FIXTURES.chartCopyKeys[0]), 1, 'the occurrence counter mis-fires against a single planted mount');
});

test('31a. each of the three chart copy keys appears exactly once as a quoted literal in FactSections.tsx and resolves in COPY to a non-empty string', () => {
	for (const key of FIXTURES.chartCopyKeys) {
		const occurrences = (FACT_SECTIONS.match(new RegExp(`['"\`]${key.replace(/\./g, '\\.')}['"\`]`, 'g')) ?? []).length;
		assert.equal(occurrences, 1, `${key} is mounted ${occurrences} times in FactSections.tsx — expected exactly one`);
		assert.equal(typeof COPY[key], 'string', `${key} is not declared in COPY — t() would throw and the card would fail to render`);
		assert.ok(/** @type {string} */ (COPY[key]).length > 0, `${key} resolves to an empty string`);
	}
});

test('32. positive control: extractStaticClassNameTokens recovers fact-card__chart from the literal form and stays blind to it in the computed form', () => {
	const tokens = extractStaticClassNameTokens(FIXTURES.chartWrapperClassAttr);
	assert.ok(tokens.has('fact-card__chart'), 'the extractor cannot see the chart wrapper class even in the literal form — the control is broken');
	const computed = extractStaticClassNameTokens(FIXTURES.computedClassAttr);
	assert.equal(computed.size, 0, 'the extractor read tokens out of a computed attribute — the class-coverage gate would not actually be blind to it');
});

test('32a. the chart wrapper class is static and reachable: exactly two fact-card__chart mounts (one per chart), and extractStaticClassNameTokens recovers it from the real source', () => {
	assert.equal(FACT_SECTIONS.split(FIXTURES.chartWrapperClassAttr).length - 1, 2, 'expected exactly two fact-card__chart wrapper mounts — one per chart');
	const tokens = extractStaticClassNameTokens(FACT_SECTIONS);
	assert.ok(tokens.has('fact-card__chart'), 'css-class-coverage cannot see the chart wrapper class in the real source');
});
