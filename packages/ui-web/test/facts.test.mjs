/**
 * facts.test.mjs -- the drift gates for `src/lifecycle/facts.js`: group
 * exhaustiveness (D-35), gap enumeration (D-16), phase-id lockstep with
 * 54-02's `phase-ids.js` (D-17), copy-key inventory completeness, and the
 * two source scans (zero imports, no second table-classification list).
 *
 * This file is where `facts.js`'s deliberate lack of imports is paid for --
 * the phase-id vocabulary, the group taxonomy and the copy-key inventory
 * are all held in lockstep HERE rather than by an import. Every source scan
 * below strips comments before matching, because `facts.js`'s own header
 * discusses at length the very identifiers these scans hunt (the
 * self-tripping-checker failure this repo hit three times in Phase 53 --
 * 54-VALIDATION.md § Self-Tripping Checker Rules).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { uiWebSrc } from '../../../scripts/lib/source-paths.mjs';
import { readFileSync } from 'node:fs';

import {
	FACTS,
	FACT_GROUPS,
	GAP_IDS,
	TONES,
	HEADLINE_PHASE_IDS,
	factsFor,
	headlineKey,
	headline,
	groupCopyKey,
	toneCopyKey,
	FACT_COPY_KEYS,
} from '../src/lifecycle/facts.js';
import { PHASE_IDS } from '../src/lifecycle/phase-ids.js';

const FACTS_SOURCE = readFileSync(uiWebSrc('lifecycle', 'facts.js'), 'utf8');

/**
 * Strips `/** ... *\/` block comments -- `facts.js`'s header and every
 * per-entry provenance comment live in this shape. Mirrors
 * `gate-source-integrity.test.mjs`'s own `stripComments` discipline: a
 * check must not be satisfiable by prose in a comment.
 * @param {string} source
 * @returns {string}
 */
function stripBlockComments(source) {
	return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Strips `//` line comments on top of block comments -- `facts.js` also
 * carries the 088 "why" prose as `//` comments above each gap entry.
 * @param {string} source
 * @returns {string}
 */
function stripAllComments(source) {
	return stripBlockComments(source).replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ===========================================================================
// Rung 1: sanity (anti-vacuous)
// ===========================================================================

test('rung 1 (anti-vacuous): FACTS, FACT_GROUPS, GAP_IDS, TONES, HEADLINE_PHASE_IDS and FACT_COPY_KEYS are all non-empty and frozen', () => {
	for (const [name, value] of /** @type {ReadonlyArray<readonly [string, ReadonlyArray<unknown>]>} */ ([
		['FACTS', FACTS],
		['FACT_GROUPS', FACT_GROUPS],
		['GAP_IDS', GAP_IDS],
		['TONES', TONES],
		['HEADLINE_PHASE_IDS', HEADLINE_PHASE_IDS],
		['FACT_COPY_KEYS', FACT_COPY_KEYS],
	])) {
		assert.ok(value.length > 0, `${name} must be non-empty`);
		assert.ok(Object.isFrozen(value), `${name} must be frozen`);
	}
});

// ===========================================================================
// Rung 2/3: group exhaustiveness (D-35) + positive control
// ===========================================================================

/**
 * The real validator: every entry's `group` is a non-empty string AND a
 * member of `FACT_GROUPS`. Because `group` is a scalar field, "present and
 * known" already implies "exactly one group" -- there is no second,
 * redundant multi-group check to add.
 * @param {ReadonlyArray<{ id: string, group: unknown }>} entries
 * @param {ReadonlyArray<string>} groups
 * @returns {Array<string>} the ids of entries with a missing/unknown group
 */
function findUngroupedIds(entries, groups) {
	const offenders = [];
	for (const entry of entries) {
		if (typeof entry.group !== 'string' || entry.group === '' || !groups.includes(entry.group)) {
			offenders.push(entry.id);
		}
	}
	return offenders;
}

test('rung 2: every FACTS entry has a group that is a member of FACT_GROUPS, and every group is claimed by at least one entry', () => {
	const offenders = findUngroupedIds(FACTS, FACT_GROUPS);
	assert.deepEqual(offenders, [], `entries with missing/unknown group: ${offenders.join(', ')}`);

	const claimedGroups = new Set(FACTS.map((f) => f.group));
	for (const group of FACT_GROUPS) {
		assert.ok(claimedGroups.has(group), `group "${group}" is not claimed by any FACTS entry`);
	}

	const ids = FACTS.map((f) => f.id);
	assert.equal(new Set(ids).size, ids.length, 'FACTS contains a duplicate id');
});

test('rung 3 (positive control): the real findUngroupedIds validator reports a fixture entry with group: undefined and one with an unrecognized group', () => {
	const fixture = [
		{ id: 'fine', group: 'ballot' },
		{ id: 'missingGroup', group: undefined },
		{ id: 'unknownGroup', group: 'notARealGroup' },
	];
	const offenders = findUngroupedIds(fixture, FACT_GROUPS);
	assert.deepEqual(offenders.sort(), ['missingGroup', 'unknownGroup']);
});

// ===========================================================================
// Rung 4: group assignment pinned to the UI-SPEC taxonomy (D-35)
// ===========================================================================

/**
 * Transcribed from 54-UI-SPEC.md § Fact Grouping Taxonomy, in FACTS
 * declaration order. @type {ReadonlyArray<readonly [string, string]>}
 */
const EXPECTED_ID_GROUP_PAIRS = Object.freeze([
	['identity', 'electionAndRules'],
	['authority', 'electionAndRules'],
	['governance', 'electionAndRules'],
	['rules', 'electionAndRules'],
	['timeline', 'electionAndRules'],
	['registration', 'electorate'],
	['ballot', 'ballot'],
	['polls', 'ballot'],
	['electorate', 'electorate'],
	['registrantRoll', 'electorate'],
	['keyholders', 'outcome'],
	['turnout', 'outcome'],
	['receipt', 'outcome'],
	['merkle', 'outcome'],
	['keyrelease', 'outcome'],
	['results', 'outcome'],
	['validation', 'outcome'],
	['certification', 'outcome'],
]);

test('rung 4: id-to-group pairs, in declaration order, deep-equal the UI-SPEC taxonomy transcription', () => {
	const actual = FACTS.map((f) => /** @type {readonly [string, string]} */ ([f.id, f.group]));
	assert.deepEqual(actual, [...EXPECTED_ID_GROUP_PAIRS]);
});

// ===========================================================================
// Rung 5: seven gaps, not eight (D-16)
// ===========================================================================

test('rung 5: the multiset of gap/filledGap letters across FACTS has exactly seven members, each once, sorted equal to GAP_IDS', () => {
	const letters = [];
	for (const f of FACTS) {
		if (f.gap !== null) letters.push(f.gap);
		if (f.filledGap !== null) letters.push(f.filledGap);
	}
	assert.equal(letters.length, 7, `expected 7 gap letters total, got ${letters.length}: ${letters.join(',')}`);
	assert.equal(new Set(letters).size, 7, 'a gap letter is used more than once');
	assert.deepEqual([...letters].sort(), [...GAP_IDS]);
});

test('rung 5b: no entry carries the letter H, and no entry id is "runoff" -- runoff is unmodelled, not unstored (D-16)', () => {
	for (const f of FACTS) {
		assert.notEqual(f.gap, 'H', `entry "${f.id}" must not carry gap letter H`);
		assert.notEqual(f.filledGap, 'H', `entry "${f.id}" must not carry filledGap letter H`);
	}
	assert.ok(!FACTS.some((f) => f.id === 'runoff'), 'FACTS must not contain a "runoff" entry');
});

// ===========================================================================
// Rung 6: keyrelease is filled, never gapped (D-14/D-12)
// ===========================================================================

test('rung 6: exactly one entry has a non-null filledGap; it is keyrelease, with gap: null and interpolates: [released, total]', () => {
	const filled = FACTS.filter((f) => f.filledGap !== null);
	assert.equal(filled.length, 1, 'expected exactly one filled entry');
	assert.equal(filled[0].id, 'keyrelease');
	assert.equal(filled[0].gap, null);
	assert.deepEqual(filled[0].interpolates, ['released', 'total']);

	const withInterpolates = FACTS.filter((f) => f.interpolates !== null);
	assert.equal(withInterpolates.length, 1, 'keyrelease must be the only entry with non-null interpolates');
	assert.equal(withInterpolates[0].id, 'keyrelease');
});

test('rung 6b: exactly six entries carry a non-null gap, and each has both a sentenceKey and a detailKey (D-12)', () => {
	const gapped = FACTS.filter((f) => f.gap !== null);
	assert.equal(gapped.length, 6, `expected 6 gap entries, got ${gapped.length}`);
	for (const f of gapped) {
		assert.equal(typeof f.sentenceKey, 'string', `gap entry "${f.id}" must have a sentenceKey`);
		assert.equal(typeof f.detailKey, 'string', `gap entry "${f.id}" must have a detailKey`);
	}
});

// ===========================================================================
// Rung 7: no internal gap letter can reach user-facing copy (D-12)
// ===========================================================================

/**
 * @param {string} key
 * @returns {boolean}
 */
function isWellShapedPublicKey(key) {
	if (!/^public\.[A-Za-z]+(\.[A-Za-z]+)*$/.test(key)) return false;
	return key.split('.').every((segment) => segment.length > 1 || segment === 'public');
}

test('rung 7: every FACT_COPY_KEYS entry matches the public.* shape with no single-character segment', () => {
	for (const key of FACT_COPY_KEYS) {
		assert.ok(isWellShapedPublicKey(key), `key "${key}" is not a well-shaped public.* key`);
	}
});

test('rung 7 (positive control): a public.gap.A-shaped fixture is rejected by the same predicate', () => {
	assert.equal(isWellShapedPublicKey('public.gap.A'), false);
	assert.equal(isWellShapedPublicKey('public.gap.turnout.sentence'), true);
});

// ===========================================================================
// Rung 8: phase-id lockstep with 54-02 (D-17)
// ===========================================================================

// 54-02 owns this vocabulary (packages/ui-web/src/lifecycle/phase-ids.js).
const INDETERMINATE_PHASE_ID = 'indeterminate';

test('rung 8: PHASE_IDS minus the indeterminate sentinel deep-equals HEADLINE_PHASE_IDS, and HEADLINE_PHASE_IDS deep-equals the four literal ids', () => {
	assert.deepEqual(
		/** @type {ReadonlyArray<string>} */ (PHASE_IDS).filter((id) => id !== INDETERMINATE_PHASE_ID),
		[...HEADLINE_PHASE_IDS],
	);
	// Asserted in BOTH directions (per this plan's binding constraint): a
	// rename on either side must be caught, not cancel out.
	assert.deepEqual([...HEADLINE_PHASE_IDS], ['pre', 'voting', 'settling', 'closed']);
});

test('rung 8b: every phase string in any FACTS entry is a member of HEADLINE_PHASE_IDS, and every member is claimed by at least one entry', () => {
	const claimed = new Set();
	for (const f of FACTS) {
		for (const phase of f.phases) {
			assert.ok(
				/** @type {ReadonlyArray<string>} */ (HEADLINE_PHASE_IDS).includes(phase),
				`entry "${f.id}" declares unrecognised phase "${phase}"`,
			);
			claimed.add(phase);
		}
	}
	for (const phase of HEADLINE_PHASE_IDS) {
		assert.ok(claimed.has(phase), `phase "${phase}" is not claimed by any FACTS entry`);
	}
});

// ===========================================================================
// Rung 9: headline totality and tone (D-17)
// ===========================================================================

test('rung 9: headlineKey(id, {}) for every HEADLINE_PHASE_IDS member returns a non-unknown textKey and a TONES member', () => {
	for (const id of HEADLINE_PHASE_IDS) {
		const { textKey, tone } = headlineKey(id, {});
		assert.notEqual(textKey, 'public.headline.unknown', `phase "${id}" must not fall through to unknown`);
		assert.ok(/** @type {ReadonlyArray<string>} */ (TONES).includes(tone), `phase "${id}" returned invalid tone "${tone}"`);
	}
});

test('rung 9b: indeterminate, null and an unrecognised value all return public.headline.unknown / bad (D-10)', () => {
	for (const phase of [INDETERMINATE_PHASE_ID, null, 'not-a-phase']) {
		const result = headlineKey(phase, {});
		assert.deepEqual(result, { textKey: 'public.headline.unknown', tone: 'bad' });
	}
});

// ===========================================================================
// Rung 10: headline `pre` branches (D-17, never-guess)
// ===========================================================================

const EARLIER = '2026-01-01T00:00:00';
const LATER = '2026-06-01T00:00:00';

test('rung 10: pre branch -- before returns registrationOpen/go, on-or-after returns registrationClosed/wait', () => {
	assert.deepEqual(headlineKey('pre', { atCanonical: EARLIER, registrationEndsCanonical: LATER }), {
		textKey: 'public.headline.pre.registrationOpen',
		tone: 'go',
	});
	assert.deepEqual(headlineKey('pre', { atCanonical: LATER, registrationEndsCanonical: EARLIER }), {
		textKey: 'public.headline.pre.registrationClosed',
		tone: 'wait',
	});
	assert.deepEqual(headlineKey('pre', { atCanonical: LATER, registrationEndsCanonical: LATER }), {
		textKey: 'public.headline.pre.registrationClosed',
		tone: 'wait',
	});
});

test('rung 10b: pre branch -- null, empty string, Z-suffixed and non-datetime inputs in either slot never guess "closed"', () => {
	const unusableValues = [null, '', '2026-01-01T00:00:00Z', 'not-a-date'];
	for (const bad of unusableValues) {
		const withBadAt = headlineKey('pre', { atCanonical: bad, registrationEndsCanonical: LATER });
		assert.deepEqual(withBadAt, { textKey: 'public.headline.pre.registrationUnknown', tone: 'wait' });
		assert.notEqual(withBadAt.textKey, 'public.headline.pre.registrationClosed');

		const withBadEnds = headlineKey('pre', { atCanonical: EARLIER, registrationEndsCanonical: bad });
		assert.deepEqual(withBadEnds, { textKey: 'public.headline.pre.registrationUnknown', tone: 'wait' });
		assert.notEqual(withBadEnds.textKey, 'public.headline.pre.registrationClosed');
	}
});

// ===========================================================================
// Rung 11: headline() routes every sentence through t (D-17)
// ===========================================================================

test('rung 11: headline() returns t(textKey) as text and reuses headlineKey\'s tone unchanged, with the recorded t argument matching', () => {
	/** @type {Array<string>} */
	const recordedArgs = [];
	const SENTINEL = '__sentinel__';
	const spyT = (/** @type {string} */ key) => {
		recordedArgs.push(key);
		return SENTINEL;
	};

	const expected = headlineKey('voting', {});
	const result = headline('voting', {}, spyT);

	assert.equal(result.text, SENTINEL);
	assert.equal(result.tone, expected.tone);
	assert.deepEqual(recordedArgs, [expected.textKey]);
});

test('rung 11b: headline() throws when t throws -- the throw-on-unknown-key guard is not swallowed', () => {
	const throwingT = () => {
		throw new Error('t(): unknown copy key');
	};
	assert.throws(() => headline('voting', {}, throwingT), /unknown copy key/);
});

// ===========================================================================
// Rung 12: FACT_COPY_KEYS is complete and derived, not hand-listed
// ===========================================================================

test('rung 12: FACT_COPY_KEYS deep-equals a set independently recomputed from FACTS, FACT_GROUPS, TONES and every headlineKey outcome exercised above', () => {
	const factKeys = FACTS.flatMap((f) => [f.labelKey, f.sentenceKey, f.detailKey, f.emptyKey]).filter(
		(k) => k !== null,
	);
	const groupKeys = FACT_GROUPS.map((g) => groupCopyKey(g)).filter((k) => k !== null);
	const toneKeys = TONES.map((tn) => toneCopyKey(tn)).filter((k) => k !== null);
	const headlineTextKeys = [
		...HEADLINE_PHASE_IDS.map((id) => headlineKey(id, {}).textKey),
		headlineKey('pre', { atCanonical: EARLIER, registrationEndsCanonical: LATER }).textKey,
		headlineKey('pre', { atCanonical: LATER, registrationEndsCanonical: EARLIER }).textKey,
		headlineKey(INDETERMINATE_PHASE_ID, {}).textKey,
	];

	const expected = Array.from(
		new Set(/** @type {Array<string>} */ ([...factKeys, ...groupKeys, ...toneKeys, ...headlineTextKeys])),
	).sort();

	assert.deepEqual([...FACT_COPY_KEYS], expected);
	assert.ok(!FACT_COPY_KEYS.some((k) => k === null || k === undefined), 'FACT_COPY_KEYS contains null/undefined');
	// Do NOT assert any of these keys resolves through t() -- copy.js is
	// 54-09's file, landing one wave later; that gate is 54-09's to add.
});

// ===========================================================================
// Rung 13: factsFor preserves declaration order (D-11)
// ===========================================================================

test('rung 13: factsFor(phase) returns a subsequence of FACTS in the same relative order, with a gap entry interleaved among non-gap entries', () => {
	for (const phase of HEADLINE_PHASE_IDS) {
		const filtered = factsFor(phase);
		const indices = filtered.map((f) => FACTS.findIndex((full) => full.id === f.id));
		const sortedIndices = [...indices].sort((a, b) => a - b);
		assert.deepEqual(indices, sortedIndices, `factsFor("${phase}") is not in FACTS declaration order`);
	}

	// The structural half of "gaps sit beside the fact they belong to"
	// (D-11/D-14): in the 'settling' phase, `keyrelease` (filled, non-gap)
	// sits immediately after `merkle` (gap C) and before `results` (gap E)
	// -- proof that a gap entry is interleaved among non-gap entries rather
	// than every gap being clustered contiguously at the end. Detect this
	// generically: find a non-gap entry immediately following a gap entry.
	const settlingFiltered = factsFor('settling');
	const isGap = settlingFiltered.map((f) => f.gap !== null);
	let sawNonGapAfterGap = false;
	for (let i = 1; i < isGap.length; i++) {
		if (isGap[i - 1] === true && isGap[i] === false) {
			sawNonGapAfterGap = true;
			break;
		}
	}
	assert.ok(
		sawNonGapAfterGap,
		'expected at least one non-gap entry (keyrelease) to follow a gap entry within the settling phase, ' +
			'proving gaps are not simply clustered at the end',
	);

	assert.deepEqual(factsFor('not-a-phase'), []);
	assert.doesNotThrow(() => factsFor('not-a-phase'));
});

// ===========================================================================
// Rung 14: facts.js imports nothing (dependency-free)
// ===========================================================================

/**
 * Strips string literals on top of comments, so a string like
 * `'RegistrantPublic'` cannot masquerade as source-level code the import
 * matcher below would need to see.
 * @param {string} source
 * @returns {string}
 */
function stripCommentsAndStrings(source) {
	return stripAllComments(source).replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''");
}

const IMPORT_OR_REQUIRE_RE = /(^|[^.\w])import\s*[({]|(^|[^.\w])import\s+[\w{*]|(^|[^.\w])require\s*\(/;

test('rung 14: facts.js contains zero ES import statements and zero dynamic import(/require( calls, after stripping comments and strings', () => {
	const stripped = stripCommentsAndStrings(FACTS_SOURCE);
	assert.equal(IMPORT_OR_REQUIRE_RE.test(stripped), false, 'facts.js must import nothing');
});

test('rung 14 (positive control): the same matcher matches an inline fixture string containing an import statement', () => {
	const fixture = "// pretend comment\nimport { PHASE_IDS } from './phase-ids.js';\nexport const x = 1;";
	const strippedFixture = stripCommentsAndStrings(fixture);
	assert.equal(IMPORT_OR_REQUIRE_RE.test(strippedFixture), true, 'the matcher must be able to fail (detect an import)');
});

test('rung 14 (CLI-equivalent): grep-shaped check -- zero lines matching ^import in facts.js', () => {
	const lines = FACTS_SOURCE.split('\n');
	const importLines = lines.filter((line) => /^\s*import\b/.test(line));
	assert.deepEqual(importLines, []);
});

// ===========================================================================
// Rung 15: facts.js carries no second table-classification list (I-04, Pitfall 7)
// ===========================================================================

// Held in one clearly-delimited fixture array so this file's own prose (this
// very sentence, discussing ALLOWED_TABLES/FORBIDDEN_TABLES) can never
// satisfy its own scan -- the scan runs against facts.js's stripped source,
// never against this test file's own source.
const HUNTED_TABLE_LIST_IDENTIFIERS = Object.freeze(['ALLOWED_TABLES', 'FORBIDDEN_TABLES']);
const HUNTED_SQL_VERBS = Object.freeze(['SELECT', 'FROM', 'JOIN', 'INSERT', 'UPDATE']);

/**
 * @param {string} strippedSource
 * @returns {Array<string>}
 */
function findTableListViolations(strippedSource) {
	const found = [];
	for (const identifier of HUNTED_TABLE_LIST_IDENTIFIERS) {
		if (strippedSource.includes(identifier)) found.push(identifier);
	}
	for (const verb of HUNTED_SQL_VERBS) {
		if (new RegExp(`\\b${verb}\\b`).test(strippedSource)) found.push(verb);
	}
	return found;
}

test('rung 15: facts.js, comment-stripped, contains zero allowlist/denylist identifiers and zero SQL verbs -- the single source of truth is 54-06\'s classification.js', () => {
	const stripped = stripAllComments(FACTS_SOURCE);
	const violations = findTableListViolations(stripped);
	assert.deepEqual(violations, [], `found forbidden table-list/SQL literals: ${violations.join(', ')}`);
});

test('rung 15 (positive control): the same matcher flags a fixture string that declares an ALLOWED_TABLES array or a SELECT statement', () => {
	const fixtureWithAllowlist = "export const ALLOWED_TABLES = ['Election'];";
	assert.deepEqual(findTableListViolations(fixtureWithAllowlist), ['ALLOWED_TABLES']);

	const fixtureWithSql = 'const q = "SELECT * FROM Election";';
	const found = findTableListViolations(fixtureWithSql);
	assert.ok(found.includes('SELECT') && found.includes('FROM'));
});
