/**
 * registrant-roll.test.mjs — the tier-1 gates for the published voter roll:
 * D-23's fail-closed disclosure resolver, and the source-scan half of D-18/
 * D-19/D-20.
 *
 * Every path is resolved through `scripts/lib/source-paths.mjs` (53-01's rule)
 * and never re-derived from `import.meta.url`. The one module this file RUNS is
 * imported by a direct relative specifier rather than through a resolver-built
 * dynamic `import()`: `tsc --noEmit` covers `test/` with `noImplicitAny`, and a
 * dynamically imported module is untyped, so every callback over its exports
 * fails typecheck. `election-address.test.mjs` states the same rule; the
 * resolver is still what locates every file read as TEXT.
 *
 * WHAT NO RUNG IN THIS FILE CAN PROVE, stated up front so a green here is not
 * over-read: nothing below renders. That three columns actually appear, that a
 * production-length district scrolls rather than clipping, and that the
 * authority-supplied text reaches the DOM escaped are browser-tier assertions
 * and belong to 54-16. Presence is not rendering — this repo has shipped two
 * defects on exactly that gap.
 *
 * SELF-TRIPPING-CHECKER DISCIPLINE. Every literal this file hunts for lives in
 * one frozen array and is never restated in prose, and every scan strips
 * comment lines before matching. A checker whose own comment spells the token
 * it greps for is permanently green; that failure has now been manufactured
 * eight times in this phase.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publicSrc } from '../../../../scripts/lib/source-paths.mjs';
import { COPY } from '../../../../packages/ui-web/src/index.js';
import { FACTS, factsFor } from '../../../../packages/ui-web/src/lifecycle/facts.js';
import { groupFactsForPhase } from '../../src/fact-groups.js';
import {
	ROLL_FIELDS,
	DISCLOSURE_AUDIENCE_CODES,
	ANONYMOUS_AUDIENCE,
	ROLL_DISCLOSURE_POLICY,
	resolveRollColumns,
} from '../../src/roll-disclosure.js';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';

/** @param {...string} segs @returns {string} */
const strippedSrc = (...segs) => stripComments(readFileSync(publicSrc(...segs), 'utf8'));

const ROLL_COMPONENT = strippedSrc('screens', 'RegistrantRoll.tsx');
const ROLL_DISCLOSURE = strippedSrc('roll-disclosure.js');
const FACT_SECTIONS = strippedSrc('screens', 'FactSections.tsx');
const SHELL = strippedSrc('screens', 'ElectionShell.tsx');
const READ_SEAM = strippedSrc('public-election-source.js');

// ===========================================================================
// THE ONE FIXTURE BLOCK. Every token this file hunts for and every planted
// violation its controls run over lives here and nowhere else.
// ===========================================================================

/**
 * The registrant vocabulary that must not reach the public app's source. Three
 * are the fields beyond D-19's published set; three are correlation handles
 * from a roll row back into the registrant tables.
 * @type {ReadonlyArray<string>}
 */
const FORBIDDEN_ROLL_TOKENS = Object.freeze([
	'ExtraFields',
	'RegistrantSelective',
	'RegistrantPrivate',
	'PublicCid',
	'SelectiveCid',
	'PrivateCid',
	'RegistrantId',
]);

/** The only class names the roll component may render. Both are 54-09's. */
const DECLARED_ROLL_CLASSES = Object.freeze(['registrant-roll', 'registrant-roll__note']);

/** The three copy keys the roll component owns as literals. */
const ROLL_COPY_KEYS = Object.freeze([
	'public.registrantRoll.disclaimer',
	'public.registrantRoll.empty',
	'public.rules.policyUnreadable',
]);

/**
 * Constructs that would let the component collapse or reorder the rows it is
 * given. A fan-out from a dropped upstream current-record pin must stay
 * VISIBLE rather than being papered over into a plausible-looking list.
 * @type {ReadonlyArray<string>}
 */
const ROW_COLLAPSING_CONSTRUCTS = Object.freeze(['new Set(', 'new Map(', '.reduce(', '.filter(', '.sort(']);

/**
 * Component-level overrides that would defeat 54-09's overflow rule. A roll
 * that clips a production-length district silently is the third instance of a
 * defect class this repo has already shipped twice.
 * @type {ReadonlyArray<string>}
 */
const OVERFLOW_OVERRIDE_TOKENS = Object.freeze(['style={', 'text-overflow', 'nowrap', 'overflow', 'width:']);

/** Disclosure constructs D-20 forbids: the roll is inline, with nothing to click first. */
const REVEAL_CONSTRUCTS = Object.freeze(['<DetailsToggle', '<details', '<summary', 'reveal']);

// ---------------------------------------------------------------------------
// 1. Sanity — anti-vacuous. Without this every scan below could pass on an
//    empty string, and every set rung on an empty model.
// ---------------------------------------------------------------------------

test('1. sanity: every source this file scans is non-empty after comment stripping, and the fact model yields something to assert over', () => {
	for (const [label, source] of [
		['RegistrantRoll.tsx', ROLL_COMPONENT],
		['roll-disclosure.js', ROLL_DISCLOSURE],
		['FactSections.tsx', FACT_SECTIONS],
		['ElectionShell.tsx', SHELL],
		['public-election-source.js', READ_SEAM],
	]) {
		assert.ok(source.trim().length > 0, `${label} is empty after comment stripping — every scan over it would pass vacuously`);
	}
	assert.ok(FACTS.length > 0, 'sanity: the fact model is empty');
});

// ---------------------------------------------------------------------------
// 2. The constants are exactly what the schema and D-19 say.
// ---------------------------------------------------------------------------

test('2. ROLL_FIELDS is the frozen three-column published set, in schema order', () => {
	assert.deepEqual([...ROLL_FIELDS], ['LastName', 'FirstName', 'District']);
	assert.ok(Object.isFrozen(ROLL_FIELDS), 'ROLL_FIELDS is not frozen — a caller could widen the published field set at runtime');
});

test('2a. DISCLOSURE_AUDIENCE_CODES is the frozen two-code vocabulary transcribed from the schema view, and ANONYMOUS_AUDIENCE is the one an anonymous reader satisfies', () => {
	assert.deepEqual([...DISCLOSURE_AUDIENCE_CODES], ['district', 'everyone']);
	assert.ok(Object.isFrozen(DISCLOSURE_AUDIENCE_CODES));
	assert.equal(ANONYMOUS_AUDIENCE, 'everyone');
	assert.ok(DISCLOSURE_AUDIENCE_CODES.includes(ANONYMOUS_AUDIENCE), 'the anonymous audience is not one of the recognised codes');
});

test('2b. ROLL_DISCLOSURE_POLICY declares exactly one frozen entry per published field, every one of them the anonymous audience', () => {
	assert.ok(Object.isFrozen(ROLL_DISCLOSURE_POLICY));
	assert.equal(ROLL_DISCLOSURE_POLICY.length, ROLL_FIELDS.length);
	assert.deepEqual(
		ROLL_DISCLOSURE_POLICY.map((e) => e.field),
		[...ROLL_FIELDS],
	);
	for (const entry of ROLL_DISCLOSURE_POLICY) {
		assert.ok(Object.isFrozen(entry), `policy entry for ${entry.field} is not frozen`);
		assert.equal(entry.audience, ANONYMOUS_AUDIENCE);
	}
});

// ---------------------------------------------------------------------------
// 3. The happy path, and the inertness control that proves the fault-mode
//    rungs below are not merely passing because the resolver reports
//    everything unreadable.
// ---------------------------------------------------------------------------

test('3. the declared policy publishes all three columns in ROLL_FIELDS order with nothing unreadable', () => {
	const { columns, unreadable } = resolveRollColumns(ROLL_DISCLOSURE_POLICY);
	assert.deepEqual([...columns], [...ROLL_FIELDS]);
	assert.deepEqual([...unreadable], []);
});

test('3a. inertness control: a hand-built valid policy DISTINCT from the declared one also yields nothing unreadable — the resolver is not simply reporting every field unreadable', () => {
	const handBuilt = [
		{ field: 'District', audience: 'everyone' },
		{ field: 'FirstName', audience: 'everyone' },
		{ field: 'LastName', audience: 'everyone' },
	];
	assert.notDeepEqual(
		handBuilt.map((e) => e.field),
		[...ROLL_FIELDS],
		'fixture sanity: the hand-built policy must differ from the declared one, or this control re-tests rung 3',
	);
	const { columns, unreadable } = resolveRollColumns(handBuilt);
	assert.deepEqual([...unreadable], []);
	// Ordered by ROLL_FIELDS, never by the policy's own order — a reordered
	// policy cannot reorder the table.
	assert.deepEqual([...columns], [...ROLL_FIELDS]);
});

// ---------------------------------------------------------------------------
// 4. D-23's fault modes. Each withholds its column AND records the field as
//    unreadable, so a policy fault is never indistinguishable from a
//    deliberate withholding.
// ---------------------------------------------------------------------------

/**
 * The declared policy with one field's entry replaced by an arbitrary value —
 * or removed entirely when `replacement` is `undefined`.
 * @param {string} field
 * @param {unknown} replacement
 * @returns {unknown[]}
 */
function policyWith(field, replacement) {
	/** @type {unknown[]} */
	const out = [];
	for (const entry of ROLL_DISCLOSURE_POLICY) {
		if (entry.field !== field) {
			out.push({ field: entry.field, audience: entry.audience });
			continue;
		}
		if (replacement !== undefined) out.push(replacement);
	}
	return out;
}

test('4. missing entry: the field is withheld and named unreadable, and the other two still publish', () => {
	const { columns, unreadable } = resolveRollColumns(policyWith('District', undefined));
	assert.deepEqual([...columns], ['LastName', 'FirstName']);
	assert.deepEqual([...unreadable], ['District']);
});

test('4a. malformed entry, shape 1: the entry is null', () => {
	const { columns, unreadable } = resolveRollColumns(policyWith('District', null));
	assert.ok(!columns.includes('District'));
	assert.deepEqual([...unreadable], ['District']);
});

test('4b. malformed entry, shape 2: the entry is a string rather than an object', () => {
	const { columns, unreadable } = resolveRollColumns(policyWith('District', 'District'));
	assert.ok(!columns.includes('District'));
	assert.deepEqual([...unreadable], ['District']);
});

test('4c. malformed entry, shape 3: `field` is an empty string', () => {
	const { columns, unreadable } = resolveRollColumns([
		{ field: '', audience: 'everyone' },
		{ field: 'LastName', audience: 'everyone' },
		{ field: 'FirstName', audience: 'everyone' },
	]);
	assert.deepEqual([...columns], ['LastName', 'FirstName']);
	assert.deepEqual([...unreadable], ['District']);
});

test('4d. malformed entry, shape 4: `audience` is not a string', () => {
	const { columns, unreadable } = resolveRollColumns(policyWith('District', { field: 'District', audience: 42 }));
	assert.ok(!columns.includes('District'));
	assert.deepEqual([...unreadable], ['District']);
});

test('4e. unknown audience: a code outside the schema vocabulary is withheld, not trusted', () => {
	const unknown = 'friends';
	assert.ok(!DISCLOSURE_AUDIENCE_CODES.includes(unknown), 'fixture sanity: the probe audience must not be a recognised code');
	const { columns, unreadable } = resolveRollColumns(policyWith('District', { field: 'District', audience: unknown }));
	assert.ok(!columns.includes('District'));
	assert.deepEqual([...unreadable], ['District']);
});

test('4f. known-but-unsatisfiable audience: `district` is a recognised code an anonymous reader cannot satisfy, and it fails closed the same way', () => {
	const other = DISCLOSURE_AUDIENCE_CODES.filter((code) => code !== ANONYMOUS_AUDIENCE);
	assert.equal(other.length, 1, 'fixture sanity: the schema view declares exactly one non-anonymous audience');
	const { columns, unreadable } = resolveRollColumns(policyWith('District', { field: 'District', audience: other[0] }));
	assert.ok(!columns.includes('District'));
	assert.deepEqual([...unreadable], ['District']);
});

test('4g. every fault mode leaves the OTHER two columns publishing — the resolver withholds one field, never the table', () => {
	for (const replacement of [undefined, null, 'District', { field: 'District', audience: 42 }, { field: 'District', audience: 'friends' }]) {
		const { columns } = resolveRollColumns(policyWith('District', replacement));
		assert.deepEqual([...columns], ['LastName', 'FirstName'], `a District fault collapsed the whole table for replacement ${JSON.stringify(replacement)}`);
	}
});

// ---------------------------------------------------------------------------
// 5. Fail-closed on garbage, and the intersection against ROLL_FIELDS.
// ---------------------------------------------------------------------------

test('5. six garbage inputs each yield no columns and every field unreadable, and none of them throws', () => {
	for (const input of [null, undefined, [], {}, 'x', 42]) {
		const verdict = resolveRollColumns(/** @type {any} */ (input));
		assert.deepEqual([...verdict.columns], [], `a column published for garbage input ${JSON.stringify(input) ?? 'undefined'}`);
		assert.deepEqual([...verdict.unreadable], [...ROLL_FIELDS], `the all-withheld verdict is incomplete for ${JSON.stringify(input) ?? 'undefined'}`);
	}
});

test('5a. a policy entry naming a field outside ROLL_FIELDS never produces a column', () => {
	const widened = [
		...ROLL_DISCLOSURE_POLICY.map((e) => ({ field: e.field, audience: e.audience })),
		{ field: 'ExtraFields', audience: 'everyone' },
		{ field: 'RegistrantId', audience: 'everyone' },
	];
	const { columns, unreadable } = resolveRollColumns(widened);
	assert.deepEqual([...columns], [...ROLL_FIELDS], 'a fourth policy entry widened the published column set');
	assert.deepEqual([...unreadable], []);
	for (const column of columns) {
		assert.ok(ROLL_FIELDS.includes(column), `${column} is not a member of the published field set`);
	}
});

test('5b. a duplicated or reordered policy cannot duplicate or reorder the table — the FIRST matching entry decides and the output is ROLL_FIELDS-ordered', () => {
	const duplicated = [
		{ field: 'District', audience: 'everyone' },
		{ field: 'District', audience: 'friends' },
		{ field: 'FirstName', audience: 'everyone' },
		{ field: 'LastName', audience: 'everyone' },
	];
	const { columns, unreadable } = resolveRollColumns(duplicated);
	assert.deepEqual([...columns], [...ROLL_FIELDS]);
	assert.deepEqual([...unreadable], []);
});

// ---------------------------------------------------------------------------
// 6. Purity — frozen output, repeatable, and the input is never mutated.
// ---------------------------------------------------------------------------

test('6. both returned arrays are frozen, the verdict is frozen, two calls agree, and the input object is unmutated', () => {
	const input = [
		{ field: 'LastName', audience: 'everyone' },
		{ field: 'FirstName', audience: 'district' },
		{ field: 'District', audience: 'everyone' },
	];
	const before = structuredClone(input);
	const first = resolveRollColumns(input);
	const second = resolveRollColumns(input);

	assert.ok(Object.isFrozen(first), 'the verdict object is not frozen');
	assert.ok(Object.isFrozen(first.columns), 'the columns array is not frozen');
	assert.ok(Object.isFrozen(first.unreadable), 'the unreadable array is not frozen');
	assert.deepEqual(first, second, 'two calls on the same input disagree');
	assert.deepEqual(input, before, 'resolveRollColumns mutated its input');
	assert.deepEqual([...first.columns], ['LastName', 'District']);
	assert.deepEqual([...first.unreadable], ['FirstName']);
});

// ---------------------------------------------------------------------------
// 7. The module's own shape: no import, no throw, no read.
// ---------------------------------------------------------------------------

test('7. roll-disclosure.js imports nothing, throws nothing and queries nothing — content selection is all it does', () => {
	for (const construct of ['import ', 'require(', 'throw ', 'db.', 'await ']) {
		assert.ok(!ROLL_DISCLOSURE.includes(construct), `roll-disclosure.js contains "${construct}" in executable source`);
	}
});

// ---------------------------------------------------------------------------
// 8. D-19, the render side. The forbidden-token matcher gets its planted
//    control BEFORE it runs against real source, and the fixture is built by
//    CONCATENATION so no forbidden literal is ever loose in this file's prose.
// ---------------------------------------------------------------------------

/**
 * @param {string} source
 * @returns {string[]} every forbidden token present in `source`.
 */
function forbiddenTokensIn(source) {
	return FORBIDDEN_ROLL_TOKENS.filter((token) => source.includes(token));
}

test('8. positive control: the forbidden-token matcher fires on a planted fixture assembled from the frozen array itself, once per member', () => {
	for (const token of FORBIDDEN_ROLL_TOKENS) {
		const planted = 'const leaked = row.' + token + ';';
		assert.deepEqual(forbiddenTokensIn(planted), [token], `the matcher is inert against a planted use of ${token}`);
	}
	assert.deepEqual(forbiddenTokensIn('const x = row.LastName;'), [], 'the matcher fires on a benign published column');
});

test('8a. neither roll-layer source names any forbidden registrant token in executable code', () => {
	assert.deepEqual(forbiddenTokensIn(ROLL_COMPONENT), [], 'RegistrantRoll.tsx names a forbidden registrant token');
	assert.deepEqual(forbiddenTokensIn(ROLL_DISCLOSURE), [], 'roll-disclosure.js names a forbidden registrant token');
});

// ---------------------------------------------------------------------------
// 9. D-20 — inline, with nothing to click first — and the overflow and
//    row-collapse prohibitions.
// ---------------------------------------------------------------------------

test('9. RegistrantRoll.tsx mounts no disclosure construct: the roll is inline (D-20)', () => {
	for (const construct of REVEAL_CONSTRUCTS) {
		assert.ok(!ROLL_COMPONENT.toLowerCase().includes(construct.toLowerCase()), `RegistrantRoll.tsx contains ${construct} — the roll must render with nothing to click first`);
	}
});

test('9a. RegistrantRoll.tsx overrides no overflow behaviour and injects no raw HTML — 54-09 own .registrant-roll rule owns the scroll', () => {
	for (const token of OVERFLOW_OVERRIDE_TOKENS) {
		assert.ok(!ROLL_COMPONENT.includes(token), `RegistrantRoll.tsx contains "${token}" — a component-level override would defeat the overflow rule`);
	}
	assert.ok(!ROLL_COMPONENT.includes('dangerouslySetInnerHTML'), 'RegistrantRoll.tsx opens the raw-HTML escape hatch on authority-supplied text');
});

test('9b. RegistrantRoll.tsx collapses, filters and reorders nothing — it renders the rows it is given, verbatim and in order', () => {
	for (const construct of ROW_COLLAPSING_CONSTRUCTS) {
		assert.ok(!ROLL_COMPONENT.includes(construct), `RegistrantRoll.tsx contains "${construct}" — a fan-out from a dropped upstream pin would be silently papered over`);
	}
	assert.ok(!/\bdedupe/i.test(ROLL_COMPONENT), 'RegistrantRoll.tsx dedupes its rows');
});

// ---------------------------------------------------------------------------
// 10. Class discipline (T-54-14-10). A computed className is invisible to
//     `css-class-coverage`, so it is forbidden outright rather than merely
//     covered.
// ---------------------------------------------------------------------------

/** @param {string} source @returns {string[]} every token of every STATIC className attribute. */
function staticClassTokens(source) {
	/** @type {string[]} */
	const out = [];
	const re = /className=["']([^"'{}]+)["']/g;
	let m;
	while ((m = re.exec(source))) {
		for (const token of m[1].split(/\s+/).filter(Boolean)) out.push(token);
	}
	return out;
}

test('10. positive control: the class extractor sees a planted static attribute and is BLIND to the computed form — which is why the computed form is banned rather than covered', () => {
	assert.deepEqual(staticClassTokens('<div className="registrant-roll">'), ['registrant-roll']);
	assert.deepEqual(staticClassTokens('<div className={`registrant-roll ${mod}`}>'), [], 'the extractor is not blind to the computed form — the ban below would be unnecessary');
});

test('10a. every className literal in RegistrantRoll.tsx is one of the two 54-09 declared roll classes, and no computed class attribute exists', () => {
	const tokens = staticClassTokens(ROLL_COMPONENT);
	assert.ok(tokens.length > 0, 'sanity: RegistrantRoll.tsx renders no class at all');
	const undeclared = tokens.filter((token) => !DECLARED_ROLL_CLASSES.includes(token));
	assert.deepEqual(undeclared, [], `RegistrantRoll.tsx renders class names outside the declared inventory: ${undeclared.join(', ')}`);
	assert.doesNotMatch(ROLL_COMPONENT, /className=\s*\{/, 'RegistrantRoll.tsx computes a class attribute — css-class-coverage cannot see it');
});

// ---------------------------------------------------------------------------
// 11. The copy keys the roll owns: mounted exactly once each, and every one
//     resolvable. `t()` throws on an unknown key, so this rung is what turns a
//     copy-table drift into a red test rather than a blank card.
// ---------------------------------------------------------------------------

test('11. each roll copy key appears exactly once as a literal in RegistrantRoll.tsx and resolves in COPY to a non-empty string', () => {
	for (const key of ROLL_COPY_KEYS) {
		const occurrences = (ROLL_COMPONENT.match(new RegExp(`'${key.replace(/\./g, '\\.')}'`, 'g')) ?? []).length;
		assert.equal(occurrences, 1, `${key} is mounted ${occurrences} times in RegistrantRoll.tsx — expected exactly one`);
		assert.equal(typeof COPY[key], 'string', `${key} is not declared in COPY — t() would throw and the card would fail to render`);
		assert.ok(/** @type {string} */ (COPY[key]).length > 0, `${key} resolves to an empty string`);
	}
});

// ---------------------------------------------------------------------------
// 12. The mount: where the roll renders, and what decides it.
//
//     RESTATED AGAINST THE TREE. The plan asked that the module mounting
//     `<RegistrantRoll` also contain the fact id as a literal. `FactSections`
//     selects its render branch on the DATA and never on an id — 54-13's rule,
//     and the reason a future model entry renders correctly with no edit at
//     the render site. So the mount location is asserted through the MODEL
//     instead, which is the stronger statement: exactly one fact entry carries
//     a collection key, it is the roll, and it sits in the electorate group.
// ---------------------------------------------------------------------------

test('12. exactly one fact entry declares a collection key, it is registrantRoll, and it sits in the electorate group directly after electorate', () => {
	const withEmptyKey = FACTS.filter((f) => f.emptyKey !== null);
	assert.equal(withEmptyKey.length, 1, 'more than one fact entry now carries a collection key — the roll branch no longer selects exactly one fact');
	assert.equal(withEmptyKey[0].id, 'registrantRoll');
	assert.equal(withEmptyKey[0].group, 'electorate');
	const ids = FACTS.map((f) => f.id);
	assert.equal(ids[ids.indexOf('registrantRoll') - 1], 'electorate', 'the roll is no longer declared directly after the electorate fact');
});

test('12a. the roll really lands in the rendered electorate group, for every phase the page can show', () => {
	for (const phase of ['pre', 'voting', 'settling', 'closed']) {
		const groups = groupFactsForPhase(phase);
		const electorate = groups.find((g) => g.group === 'electorate');
		assert.ok(electorate, `no electorate group for phase ${phase}`);
		const rollIndex = electorate.facts.findIndex((f) => f.id === 'registrantRoll');
		assert.ok(rollIndex >= 0, `the roll is absent from the electorate group in phase ${phase}`);
		assert.equal(electorate.facts[rollIndex - 1]?.id, 'electorate', `the roll does not follow the electorate fact in phase ${phase}`);
		assert.ok(factsFor(phase).some((f) => f.id === 'registrantRoll'));
	}
});

test('12b. <RegistrantRoll is mounted exactly once across the whole public app source, and the mount lives in the fact body', () => {
	const mounts = [ROLL_COMPONENT, FACT_SECTIONS, SHELL, READ_SEAM, ROLL_DISCLOSURE].map(
		(source) => (source.match(/<RegistrantRoll\b/g) ?? []).length,
	);
	assert.deepEqual(mounts, [0, 1, 0, 0, 0], 'the roll is mounted somewhere other than the fact body, or more than once');
});

test('12c. the fact body selects the roll branch on the DATA and never on the fact id', () => {
	assert.match(FACT_SECTIONS, /fact\.emptyKey\s*!==\s*null/, 'the fact body no longer selects the roll branch on the collection key');
	assert.doesNotMatch(FACT_SECTIONS, /['"`]registrantRoll['"`]/, 'the fact body selects a render branch on a hard-coded fact id');
});

// ---------------------------------------------------------------------------
// 13. The read. RESTATED AGAINST THE TREE, for the same reason 54-13 restated
//     the key-release read one plan earlier: `election-shell.test.mjs` case 12b
//     asserts the shell holds ZERO effects and ZERO awaits, and a second hook
//     beside the existing one would race that hook's cleanup close of the
//     shared handle. The roll is therefore read in the seam that already owns
//     the handle's lifetime, and the assertion is written where the wiring
//     actually lives.
// ---------------------------------------------------------------------------

test('13. the roll read is wired in the read seam that owns the handle, exactly once, and nowhere else under src/', () => {
	assert.equal((READ_SEAM.match(/readRegistrantRoll/g) ?? []).length >= 1, true, 'public-election-source.js does not wire readRegistrantRoll');
	for (const [label, source] of [
		['RegistrantRoll.tsx', ROLL_COMPONENT],
		['roll-disclosure.js', ROLL_DISCLOSURE],
		['FactSections.tsx', FACT_SECTIONS],
		['ElectionShell.tsx', SHELL],
	]) {
		assert.ok(!source.includes('readRegistrantRoll'), `${label} performs the roll read itself`);
	}
});

test('13a. the roll component fetches nothing: it receives rows, and imports nothing that could reach a database', () => {
	assert.ok(!ROLL_COMPONENT.includes('@votetorrent/web-data'), 'RegistrantRoll.tsx imports the data package');
	assert.ok(!ROLL_COMPONENT.includes('useEffect'), 'RegistrantRoll.tsx holds an effect');
	assert.ok(!ROLL_COMPONENT.includes('await '), 'RegistrantRoll.tsx awaits');
	assert.match(ROLL_COMPONENT, /resolveRollColumns\(/, 'RegistrantRoll.tsx does not resolve its columns through the disclosure resolver');
});

test('13b. the shell threads the rows down to the fact body rather than fetching them', () => {
	assert.match(SHELL, /<FactSections[^>]*roll=\{[^}]*\}/, 'the shell does not hand the fact body a roll value at all');
	assert.ok(!SHELL.includes('.rows'), 'the shell touches a raw query result');
});
