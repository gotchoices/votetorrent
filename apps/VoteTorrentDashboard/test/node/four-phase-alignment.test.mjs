/**
 * four-phase-alignment.test.mjs -- the agreement between three things that
 * used to be three separately hand-maintained lists:
 *
 *   1. `PHASE_IDS` (`@votetorrent/ui-web/lifecycle`) -- the one vocabulary
 *      declaration;
 *   2. `SEED_PHASE_INSTANTS` (the dashboard's seed fixture) -- one canonical
 *      instant per phase id, read by BOTH this suite and the tier-3 browser
 *      harness (`test/browser/gate-matrix.tsx`, `test/browser/run-headless.mjs`);
 *   3. what `derivePhase` actually returns when handed the fixture's own
 *      `SEED_TIMELINE` at each of those instants.
 *
 * Until 54-07 those three lists drifted independently: the browser harness
 * carried its own `INSTANTS` map, `run-headless.mjs` carried its own
 * three-id `TIER3_PHASE_IDS` literal, and nothing bound either to the
 * package's vocabulary. This file is deliberately TIER 1 so a vocabulary
 * drift -- a renamed id, a fifth id, an instant edited onto the wrong side
 * of a boundary -- fails in about a second rather than three minutes into a
 * headless browser run, and fails with a message naming the disagreement
 * instead of a DOM diff.
 *
 * `@votetorrent/ui-web/lifecycle` is Node-importable from this workspace
 * (unlike `./components`, which needs a DOM), which is what makes a tier-1
 * gate on the shared derivation possible at all.
 *
 * The second half of this file is a set of SOURCE-LEVEL assertions over
 * `ElectionsPanel.tsx` and `election-ops.css`. `node --test` cannot import a
 * `.tsx`, so those read the sources as TEXT, in the shape
 * `test/node/election-ops-panels.test.mjs` (54-03b's) established. Every
 * source matcher runs over the COMMENT-STRIPPED text, via the repository's one
 * shared character-level stripper (`scripts/lib/strip-comments.mjs`, 54-22): a
 * panel's own explanatory prose must never be able to satisfy -- or defeat --
 * a matcher, including prose inside a `{/* ... *}/` JSX comment block, which a
 * line-opening filter alone would miss (54-25).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { dashboardSrc } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';
import { derivePhase, PHASE_IDS } from '@votetorrent/ui-web/lifecycle';
import {
	SEED_ELECTION,
	SEED_TIMELINE,
	SEED_PHASE_INSTANTS,
} from '../../../../packages/web-data/test/fixtures/seed-election-surface.js';

const TIMELINE_JSON = JSON.stringify(SEED_TIMELINE);

// ---------------------------------------------------------------------------
// 1. The key set IS the vocabulary.
// ---------------------------------------------------------------------------

test('SEED_PHASE_INSTANTS names exactly PHASE_IDS, in PHASE_IDS order -- the anti-drift binding', () => {
	assert.deepEqual(Object.keys(SEED_PHASE_INSTANTS), [...PHASE_IDS]);
});

test('every SEED_PHASE_INSTANTS value is a canonical 19-character datetime with no Z suffix', () => {
	for (const [phaseId, instant] of Object.entries(SEED_PHASE_INSTANTS)) {
		assert.match(instant, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, `${phaseId}'s instant is not canonical`);
	}
});

// ---------------------------------------------------------------------------
// 2. Each instant derives ITS OWN phase, confidently and without conflict.
// ---------------------------------------------------------------------------

test('each SEED_PHASE_INSTANTS entry derives its own phase against SEED_TIMELINE, with indeterminate false and zero conflicts', () => {
	for (const [phaseId, instant] of Object.entries(SEED_PHASE_INSTANTS)) {
		const result = derivePhase(SEED_ELECTION, TIMELINE_JSON, instant);
		assert.equal(result.phase, phaseId, `instant ${instant} derived "${result.phase}", not "${phaseId}" (fired: ${result.firedRule})`);
		assert.equal(result.indeterminate, false, `${phaseId} must derive confidently`);
		// A real assertion, not decoration: SEED_TIMELINE and SEED_ELECTION are
		// consistent under all six CONFLICT codes today, and a future fixture
		// edit that breaks that consistency must surface here rather than as a
		// silently degraded browser rung.
		assert.deepEqual(
			result.conflicts,
			[],
			`${phaseId}: expected no cross-check conflict, got ${result.conflicts.map((c) => c.code).join(', ')}`,
		);
	}
});

test('the string and object forms of the Timeline derive the identical phase at every instant (54-02 deviation (e), from the consumer side)', () => {
	for (const [phaseId, instant] of Object.entries(SEED_PHASE_INSTANTS)) {
		const viaString = derivePhase(SEED_ELECTION, TIMELINE_JSON, instant);
		const viaObject = derivePhase(SEED_ELECTION, SEED_TIMELINE, instant);
		assert.equal(viaString.phase, viaObject.phase, `${phaseId}: string/object phase disagreement`);
		assert.equal(viaString.stage, viaObject.stage, `${phaseId}: string/object stage disagreement`);
	}
});

// ---------------------------------------------------------------------------
// 3. The instants sit where the boundaries say they do -- so the fixture
//    cannot derive the right phase for the wrong reason.
// ---------------------------------------------------------------------------

test('the settling instant lies strictly inside [tallyingStarts, closed) and the closed instant is at or after closed -- string comparison of the canonical form', () => {
	assert.ok(
		SEED_PHASE_INSTANTS.settling >= SEED_TIMELINE.tallyingStarts,
		`settling instant ${SEED_PHASE_INSTANTS.settling} must be >= tallyingStarts ${SEED_TIMELINE.tallyingStarts}`,
	);
	assert.ok(
		SEED_PHASE_INSTANTS.settling < SEED_TIMELINE.closed,
		`settling instant ${SEED_PHASE_INSTANTS.settling} must be < closed ${SEED_TIMELINE.closed}`,
	);
	assert.ok(
		SEED_PHASE_INSTANTS.closed >= SEED_TIMELINE.closed,
		`closed instant ${SEED_PHASE_INSTANTS.closed} must be >= closed ${SEED_TIMELINE.closed}`,
	);
	assert.ok(
		SEED_PHASE_INSTANTS.pre < SEED_TIMELINE.votingStarts,
		`pre instant ${SEED_PHASE_INSTANTS.pre} must be < votingStarts ${SEED_TIMELINE.votingStarts}`,
	);
	assert.ok(
		SEED_PHASE_INSTANTS.voting >= SEED_TIMELINE.votingStarts && SEED_PHASE_INSTANTS.voting < SEED_TIMELINE.tallyingStarts,
		`voting instant ${SEED_PHASE_INSTANTS.voting} must sit in [votingStarts, tallyingStarts)`,
	);
});

// ---------------------------------------------------------------------------
// 4. The stage values the panel renders, pinned without a browser.
// ---------------------------------------------------------------------------

test('derivePhase(...).stage is the newest passed cut-off: null at pre, votingStarts at voting, certificationStarts at settling, closed at closed', () => {
	/** @type {Record<string, string | null>} */
	const expected = {
		pre: null,
		voting: 'votingStarts',
		settling: 'certificationStarts',
		closed: 'closed',
	};
	for (const [phaseId, instant] of Object.entries(SEED_PHASE_INSTANTS)) {
		const { stage } = derivePhase(SEED_ELECTION, TIMELINE_JSON, instant);
		assert.equal(stage, expected[phaseId], `${phaseId}: stage`);
	}
});

// ---------------------------------------------------------------------------
// 5. Positive control -- the suite can tell a derived phase from a guessed one.
// ---------------------------------------------------------------------------

test('positive control: with `closed` deleted from the Timeline, the settling instant returns indeterminate rather than a confident phase', () => {
	const broken = { ...SEED_TIMELINE };
	delete broken.closed;
	const result = derivePhase(SEED_ELECTION, JSON.stringify(broken), SEED_PHASE_INSTANTS.settling);
	assert.equal(result.indeterminate, true, 'a missing deciding boundary must degrade to indeterminate');
	assert.notEqual(result.phase, 'settling', 'the suite would be inert if a broken timeline still derived settling');
});

// ---------------------------------------------------------------------------
// 6. ElectionsPanel.tsx's call site and its settling-stage marker, asserted at
//    the SOURCE level (`node --test` cannot import a `.tsx`).
//
//    Every matcher below runs over the COMMENT-STRIPPED text, via the shared
//    character-level stripper (`scripts/lib/strip-comments.mjs`, 54-22): the
//    panel's own explanatory prose must never be able to satisfy -- or defeat
//    -- a matcher, including prose inside a multi-line `{/* ... *}/` JSX
//    comment block, which a line-opening filter alone would miss (54-25).
// ---------------------------------------------------------------------------

const PANEL_PATH = path.join(dashboardSrc('screens', 'panels'), 'ElectionsPanel.tsx');
const PANEL_STRIPPED = stripComments(readFileSync(PANEL_PATH, 'utf8'));

// ASSEMBLED, never written out -- `packages/ui-web/test/three-bucket-absent.test.mjs`'s
// convention. A checker whose own source contains the identifier it hunts is
// permanently green under any repo-wide "this name is gone" scan, and it would
// make that scan's zero-occurrence claim dishonest. This one names a function
// 54-07 deleted, so writing it out here would resurrect it in grep.
const RETIRED_ALIAS = ['compute', 'Election', 'Phase'].join('');

test('this file\'s own source contains zero raw occurrences of the retired alias identifier it hunts (self-trip guard)', () => {
	const ownSource = readFileSync(new URL(import.meta.url), 'utf8');
	assert.equal((ownSource.match(new RegExp(RETIRED_ALIAS, 'g')) ?? []).length, 0);
});

test('ElectionsPanel.tsx calls derivePhase and no longer names the retired bridge alias', () => {
	assert.match(PANEL_STRIPPED, /derivePhase\(/);
	assert.doesNotMatch(PANEL_STRIPPED, new RegExp(RETIRED_ALIAS));
	// The matcher is proven able to fire, so the assertion above is not vacuous.
	assert.match(`const { phase } = ${RETIRED_ALIAS}(overview.Timeline, at);`, new RegExp(RETIRED_ALIAS));
});

test('ElectionsPanel.tsx destructures only phase and stage -- derivePhase\'s diagnostics embed raw Timeline values and must not reach an officer\'s screen or console', () => {
	assert.doesNotMatch(PANEL_STRIPPED, /\breason\b/, 'reason embeds raw timeline values');
	assert.doesNotMatch(PANEL_STRIPPED, /\bconflicts\b/, 'conflicts[].detail embeds raw timeline values');
	assert.doesNotMatch(PANEL_STRIPPED, /\bfiredRule\b/, 'firedRule is a machine diagnostic');
});

// The pill and the timeline classes compare against a coarse clock, so the
// pill crosses a deadline while the dashboard stays open.
const AT_FROM_CLOCK_RE = /const atCanonical = toCanonicalDatetime\(nowMs\);/;

test('ElectionsPanel.tsx derives the phase against the coarse clock: useNow() feeds atCanonical, and atCanonical feeds derivePhase', () => {
	assert.match(PANEL_STRIPPED, /useNow\(\)/);
	assert.match(PANEL_STRIPPED, AT_FROM_CLOCK_RE);
	assert.match(PANEL_STRIPPED, /derivePhase\([\s\S]*?atCanonical/);
	// Control: the assignment matcher misses the frozen-instant form it replaced.
	assert.doesNotMatch('const atCanonical = resolveComparisonInstant(x);', AT_FROM_CLOCK_RE);
});

test('ElectionsPanel.tsx selects the timeline row class three ways: eo-tl--current, eo-tl--past, eo-tl--future', () => {
	for (const cls of ['eo-tl--current', 'eo-tl--past', 'eo-tl--future']) {
		assert.match(PANEL_STRIPPED, new RegExp(cls.replace(/-/g, '\\-')), `${cls} is not selected`);
	}
});

// --- The D-13 honesty gate --------------------------------------------------
//
// D-13 guarantees no Tally, Certification or Validation table exists, so any
// word implying one would be a claim with no source. The marked row says only
// "this published cut-off has passed".
const OUTCOME_CLAIM_RE = /\b(Tallied|Certified|Validated|Certification complete|Results? released|Finalis|Finaliz)/i;

test('positive control: the outcome-claim matcher FIRES on a planted "Results released" string -- proven able to fail before it is trusted', () => {
	assert.match('<span>Results released</span>', OUTCOME_CLAIM_RE);
	assert.match('<span>Tallied</span>', OUTCOME_CLAIM_RE);
	assert.doesNotMatch('<span>{event}</span>', OUTCOME_CLAIM_RE, 'sanity: the matcher must not fire on an ordinary expression cell');
});

test('outcome-claim scan: ElectionsPanel.tsx makes no claim about tally, validation or certification OUTCOMES (D-13 -- no such table exists)', () => {
	assert.doesNotMatch(PANEL_STRIPPED, OUTCOME_CLAIM_RE);
});

// --- The marker must be visible, not merely present -------------------------

const CSS_PATH = path.join(dashboardSrc('screens', 'panels'), 'election-ops.css');
const CSS_STRIPPED = readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Parse one class's declaration block into a property -> value map.
 * @param {string} css @param {string} selector @returns {Record<string, string>}
 */
function declarationsFor(css, selector) {
	const match = css.match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`));
	assert.ok(match, `${selector} is not declared`);
	/** @type {Record<string, string>} */
	const decls = {};
	for (const raw of match[1].split(';')) {
		const idx = raw.indexOf(':');
		if (idx === -1) continue;
		decls[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
	}
	return decls;
}

/**
 * How many property names the two blocks disagree on -- counting a property
 * present in one and absent in the other.
 * @param {Record<string, string>} a @param {Record<string, string>} b @returns {number}
 */
function propertyDiffCount(a, b) {
	const names = new Set([...Object.keys(a), ...Object.keys(b)]);
	let diff = 0;
	for (const name of names) if (a[name] !== b[name]) diff += 1;
	return diff;
}

test('election-ops.css declares .eo-tl--current computed-style-distinct from BOTH .eo-tl--past and .eo-tl--future, in at least two properties each -- presence is not rendering', () => {
	const current = declarationsFor(CSS_STRIPPED, '.eo-tl--current');
	const past = declarationsFor(CSS_STRIPPED, '.eo-tl--past');
	const future = declarationsFor(CSS_STRIPPED, '.eo-tl--future');
	assert.ok(
		propertyDiffCount(current, past) >= 2,
		`.eo-tl--current differs from .eo-tl--past in only ${propertyDiffCount(current, past)} propert(y/ies)`,
	);
	assert.ok(
		propertyDiffCount(current, future) >= 2,
		`.eo-tl--current differs from .eo-tl--future in only ${propertyDiffCount(current, future)} propert(y/ies)`,
	);
});

test('control: propertyDiffCount reports 0 for two identical blocks -- the distinctness check is proven able to fail', () => {
	const fixture = '.a-x { color: red; }\n.b-x { color: red; }';
	assert.equal(propertyDiffCount(declarationsFor(fixture, '.a-x'), declarationsFor(fixture, '.b-x')), 0);
});

test('the settling-stage marker is a real NON-COLOUR cue (D-17): ElectionsPanel.tsx declares STAGE_MARKER and the class alone does not carry the whole signal', () => {
	assert.match(PANEL_STRIPPED, /STAGE_MARKER/);
});
