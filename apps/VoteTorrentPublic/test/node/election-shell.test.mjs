/**
 * election-shell.test.mjs — the eleven lettered assertions from 53-07 Task 2
 * over `src/screens/ElectionShell.tsx` and its neighbours. Every path is
 * resolved through `scripts/lib/source-paths.mjs`'s `publicSrc()`/
 * `publicRoot()` and `uiWebSrc()` (D-25/53-01) — never re-derived from
 * `import.meta.url`. Every matcher gets a planted-fixture positive control
 * BEFORE it runs against real source, per this repo's own standing rule
 * that a comment merely DISCUSSING a forbidden term must never trip a
 * matcher (so every scan below strips comment lines first).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publicSrc, publicRoot, uiWebSrc, uiWebRoot } from '../../../../scripts/lib/source-paths.mjs';
import { COPY } from '../../../../packages/ui-web/src/index.js';
import { FACT_COPY_KEYS } from '../../../../packages/ui-web/src/lifecycle/facts.js';
import { ELECTION_ADDRESS_PARAM, NETWORK_ADDRESS_PARAM } from '../../src/election-address.js';
import { INDETERMINATE_PHASE } from '../../../../packages/ui-web/src/lifecycle/phase-ids.js';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';

/** @param {string} dir @returns {string[]} */
function walkAll(dir) {
	/** @type {string[]} */
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkAll(full));
		} else {
			out.push(full);
		}
	}
	return out;
}

const SHELL_PATH = publicSrc('screens', 'ElectionShell.tsx');
const SHELL_SOURCE_RAW = readFileSync(SHELL_PATH, 'utf8');
const SHELL_SOURCE = stripComments(SHELL_SOURCE_RAW);

// ---------------------------------------------------------------------------
// 1. Single return.
// ---------------------------------------------------------------------------

/** @param {string} source @returns {number} */
function countReturns(source) {
	return (source.match(/\breturn\b/g) ?? []).length;
}

test('positive control: the single-return matcher fires (counts 2) on a planted two-return fixture', () => {
	const fixture = 'function Foo() {\n\tif (x) {\n\t\treturn null;\n\t}\n\treturn <div />;\n}';
	assert.equal(countReturns(fixture), 2, 'matcher is inert against a planted two-return fixture');
});

test('ElectionShell.tsx contains exactly one `return` statement', () => {
	assert.equal(countReturns(SHELL_SOURCE), 1, 'expected exactly one return statement in ElectionShell.tsx');
});

// ---------------------------------------------------------------------------
// 2. Genuine mounts.
// ---------------------------------------------------------------------------

test('ElectionShell.tsx mounts <LifecyclePill, <AdvisoryDisclosure and <DetailsToggle each exactly once, with the literal variant="public"', () => {
	assert.equal((SHELL_SOURCE.match(/<LifecyclePill\b/g) ?? []).length, 1);
	assert.equal((SHELL_SOURCE.match(/<AdvisoryDisclosure\b/g) ?? []).length, 1);
	assert.equal((SHELL_SOURCE.match(/<DetailsToggle\b/g) ?? []).length, 1);
	assert.match(SHELL_SOURCE, /variant="public"/, 'expected the literal variant="public" (not a variable) so a grep can see it');
});

// ---------------------------------------------------------------------------
// 3. The toggle is never wrapped around the advisory.
// ---------------------------------------------------------------------------

/** @param {string} source @returns {boolean} true if <AdvisoryDisclosure appears between a <DetailsToggle open tag and its matching close tag. */
function advisoryNestedInToggle(source) {
	const openIdx = source.indexOf('<DetailsToggle');
	if (openIdx === -1) return false;
	const closeIdx = source.indexOf('</DetailsToggle>', openIdx);
	if (closeIdx === -1) return false;
	const between = source.slice(openIdx, closeIdx);
	return between.includes('<AdvisoryDisclosure');
}

test('positive control: the nesting matcher fires on a planted <DetailsToggle>...<AdvisoryDisclosure />...</DetailsToggle> fixture', () => {
	const fixture = '<DetailsToggle summary="x"><AdvisoryDisclosure variant="public" /></DetailsToggle>';
	assert.ok(advisoryNestedInToggle(fixture), 'matcher is inert against a planted nested fixture');
});

test('ElectionShell.tsx never nests <AdvisoryDisclosure inside <DetailsToggle (D-16 consumer-side half)', () => {
	assert.equal(advisoryNestedInToggle(SHELL_SOURCE), false);
});

// ---------------------------------------------------------------------------
// 4. A hook-calling component is mounted — classified by NAME, not
//    hard-coded to DetailsToggle.
// ---------------------------------------------------------------------------

const HOOK_CALL_RE = /\buse[A-Z]\w*\(/;

/** @param {string} name @returns {string} the .tsx source of a component re-exported from components.js by that name. */
function readComponentSource(name) {
	return stripComments(readFileSync(uiWebSrc('components', `${name}.tsx`), 'utf8'));
}

/** @returns {string[]} every component name re-exported from packages/ui-web/src/components.js. */
function listExportedComponentNames() {
	const barrel = stripComments(readFileSync(uiWebSrc('components.js'), 'utf8'));
	const names = [];
	const re = /export\s*\{\s*(\w+)\s*\}\s*from\s*'\.\/components\/\1\.js'/g;
	let m;
	while ((m = re.exec(barrel))) names.push(m[1]);
	return names;
}

test('positive control: the hook-call classifier identifies a planted useState( fixture as hook-calling and a planted hook-free fixture as not', () => {
	assert.match('function X() { const [a, setA] = useState(0); return null; }', HOOK_CALL_RE);
	assert.doesNotMatch('function X() { return null; }', HOOK_CALL_RE);
});

test('at least one hook-calling component re-exported from components.js has its JSX tag mounted in ElectionShell.tsx', () => {
	const names = listExportedComponentNames();
	assert.ok(names.length > 0, 'sanity: components.js must re-export at least one component');
	const classified = names.map((name) => ({ name, hookCalling: HOOK_CALL_RE.test(readComponentSource(name)) }));
	const hookCallingNames = classified.filter((c) => c.hookCalling).map((c) => c.name);
	const nonHookCallingNames = classified.filter((c) => !c.hookCalling).map((c) => c.name);
	assert.ok(hookCallingNames.length > 0, `no hook-calling component found among: ${JSON.stringify(classified)}`);
	const mountedHookCalling = hookCallingNames.filter((name) => SHELL_SOURCE.includes(`<${name}`));
	assert.ok(
		mountedHookCalling.length > 0,
		`ElectionShell.tsx mounts none of the classified hook-calling components (${hookCallingNames.join(', ')}); ` +
			`non-hook-calling set was (${nonHookCallingNames.join(', ')})`,
	);
});

// ---------------------------------------------------------------------------
// 5. No dangerouslySetInnerHTML anywhere under src/ or test/.
// ---------------------------------------------------------------------------

const RAW_HTML_ESCAPE_HATCH_RE = /dangerouslySetInnerHTML/;

test('positive control: the raw-HTML-injection matcher fires on a planted occurrence', () => {
	assert.match('<div dangerouslySetInnerHTML={{ __html: x }} />', RAW_HTML_ESCAPE_HATCH_RE);
});

test('no file under src/ or test/ (excluding test/node/*.test.mjs, whose own positive-control fixture literally plants the sentinel) uses the raw-HTML-injection escape hatch', () => {
	// test/node/ is this app's OWN scanner tooling — this very file, and
	// app-shape.test.mjs, each plant the sentinel string as a positive-control
	// fixture literal (never as real JSX usage), so excluding that one
	// directory is what keeps this check from permanently self-tripping on
	// its own control. The real subject of this scan is application code
	// (src/) and any browser-harness/fixture code Task 3 adds under
	// test/browser/ and test/fixtures/ — neither of which may plant the
	// escape hatch for real.
	const testNodeDir = publicRoot('test', 'node');
	const files = [...walkAll(publicSrc()), ...walkAll(publicRoot('test'))].filter((f) => !f.startsWith(testNodeDir));
	const offenders = [];
	for (const file of files) {
		const stripped = stripComments(readFileSync(file, 'utf8'));
		if (RAW_HTML_ESCAPE_HATCH_RE.test(stripped)) offenders.push(file);
	}
	assert.deepEqual(offenders, [], `these files use the raw-HTML-injection escape hatch: ${offenders.join(', ')}`);
});

// ---------------------------------------------------------------------------
// 6. A CLOSED URL parameter set, under src/.
//
// AMENDMENT LEDGER (54-11, wave 6) -------------------------------------------
//
// Until now this asserted that "election" was the ONLY parameter name
// reachable under src/. D-33 makes that claim false by design, and for a
// stated reason rather than for convenience: a browser holds one store per
// network and a network holds several elections, so an election id alone
// resolves only by walking the local networks registry and taking whichever
// network happened to come first -- an answer that is a function of a local
// inventory's ORDER, on a page whose entire value is that its claims can be
// checked. The address therefore names both, and this assertion's subject
// changes from "one name" to "a CLOSED SET of exactly two".
//
// What did NOT change, and is the part carrying the security content: the
// set is still asserted by `deepEqual` against an explicit list, so a THIRD
// parameter name still fails here; and the `forbidden` probe below -- the
// phase/time-selection names of T-53-07-04 and D-24 -- is UNCHANGED and
// still asserted absent. 54-10 anticipated exactly this amendment when it
// wrote, in section 10's own vocabulary comment, that the parameter set
// "deliberately EXCLUDES `election` (and any network parameter a later wave
// adds): those address WHICH election is shown, not WHICH PHASE it is shown
// in, and D-33 requires them."
//
// The two admitted names are read from `election-address.js`'s own exported
// constants, never transcribed here, so a rename in that module fails this
// assertion loudly instead of silently admitting a name nobody declared.
// ---------------------------------------------------------------------------

test('positive control: the closed-parameter-set assertion still REFUSES a third name — an exact deepEqual, not a containment check', () => {
	const admitted = [ELECTION_ADDRESS_PARAM, NETWORK_ADDRESS_PARAM].sort();
	const withAThirdName = [...admitted, 'audience'].sort();
	assert.notDeepEqual(withAThirdName, admitted, 'the amended assertion would admit a third parameter name — it has been widened into a containment check');
	assert.deepEqual([...admitted].sort(), admitted, 'sanity: the admitted set compares equal to itself');
});

test('the URL parameter names reachable anywhere under src/ are exactly the two the address module exports — no third name, and none of the phase/time-selection names (test/browser/ is excluded from this scan — its own ?phase= selector lives there, never in src/)', () => {
	const files = walkAll(publicSrc());
	/** @type {Map<string, string>} */
	const contents = new Map();
	for (const file of files) contents.set(file, stripComments(readFileSync(file, 'utf8')));

	// D-54-13-01, recorded here rather than fixed by widening the matcher.
	// This scan resolves EVERY `.get(ident)` / `.getAll(ident)` call site under
	// src/ back to a string literal, and it cannot tell
	// `URLSearchParams.prototype.get` from `Map.prototype.get` -- a source scan
	// has no type information. So ANY Map lookup in this app's src/ resolves to
	// `<unresolved:...>` and turns this rung red for a reason the diff never
	// explains. 54-13 hit exactly that when `fact-groups.js` bucketed with a
	// Map, and rewrote it to bucket by index instead.
	//
	// DO NOT "fix" this by narrowing the matcher to URLSearchParams. Narrowing
	// is the weakening path and it would need type information this scan does
	// not have. If you are here because a new Map lookup went red: use an index
	// array, as fact-groups.js does, and leave the gate indiscriminate.
	const CALL_SITE_RE = /\.(?:get|getAll)\(\s*([\w$]+|(['"`])([\w-]+)\2)\s*\)/g;
	/** @type {Set<string>} */
	const resolvedNames = new Set();
	const forbidden = ['at', 'phase', 'now'];

	for (const [, source] of contents) {
		let m;
		const re = new RegExp(CALL_SITE_RE.source, 'g');
		while ((m = re.exec(source))) {
			if (m[3] !== undefined) {
				resolvedNames.add(m[3]);
				continue;
			}
			const identifier = m[1];
			let found = null;
			for (const [, otherSource] of contents) {
				const constMatch = otherSource.match(new RegExp(`\\b${identifier}\\s*=\\s*(['"\`])([\\w-]+)\\1`));
				if (constMatch) {
					found = constMatch[2];
					break;
				}
			}
			resolvedNames.add(found ?? `<unresolved:${identifier}>`);
		}
	}

	const admitted = [ELECTION_ADDRESS_PARAM, NETWORK_ADDRESS_PARAM].sort();
	assert.equal(admitted.length, 2, 'sanity: the address module must export exactly two parameter-name constants for this scan to be written against');

	// D-54-10-01. These two checks run BEFORE the exact-set deepEqual below,
	// and that ordering is the whole point rather than a style preference.
	// They used to sit AFTER it, where they were unreachable: the deepEqual
	// had already proven the set was exactly ['election'], so every iteration
	// of the forbidden loop was trivially true. Three assertions, zero
	// coverage -- the same shape as WR-12's `assert.ok(true)`.
	//
	// Run first, they are live and they carry the SPECIFIC diagnostic: a page
	// that made a phase or time selection URL-reachable fails naming
	// T-53-07-04, not with an opaque set-inequality dump.
	for (const name of forbidden) {
		assert.ok(!resolvedNames.has(name), `"${name}" must not be reachable from the URL anywhere in src/ (T-53-07-04)`);
	}

	// The other half D-54-10-01 asked for: an UNRESOLVED call site is one this
	// scan cannot vouch for at all. `.get(SOME_CONST)` whose constant is
	// defined outside src/ would otherwise reach the deepEqual as the opaque
	// string `<unresolved:SOME_CONST>` and fail there -- but it would fail as
	// "the set is wrong" rather than as "this call site is unauditable", and
	// a reader would go looking for a third parameter name that does not
	// exist. See the CALL_SITE_RE note above for the Map.prototype.get
	// false-positive this is the most likely cause of.
	const unresolved = [...resolvedNames].filter((n) => n.startsWith('<unresolved:'));
	assert.deepEqual(
		unresolved,
		[],
		`every .get()/.getAll() call site under src/ must resolve to a string literal this scan can audit; unresolvable: ${unresolved.join(', ')}`,
	);

	assert.deepEqual(
		[...resolvedNames].sort(),
		admitted,
		`expected the URL parameter names in src/ to be exactly ${admitted.join(' + ')}, found: ${[...resolvedNames].join(', ')}`,
	);
});

// ---------------------------------------------------------------------------
// 7. D-18 inertness, CSS side. NARROWED BY 56-14 (D-16/D-19's live-update
// badge): `@keyframes`, `animation`, `animation-name` and `linear-gradient`
// stay at zero, unchanged from 53-D18. `transition:` is split into its own
// rung, permitted at EXACTLY ONE site: the badge's own sanctioned fade,
// inside the app's one `prefers-reduced-motion: no-preference` block. This
// narrows 56-12's own "no transition anywhere in app.css" criterion BY
// DESIGN, per the UI-SPEC — it is not a relaxation of the surrounding rule,
// which stays zero-tolerance for the other four constructs.
// ---------------------------------------------------------------------------

const CSS_NO_TRANSITION_ANIMATION_RE = /(@keyframes|animation(?:-name)?\s*:|linear-gradient\()/;
const CSS_TRANSITION_RE = /transition\s*:[^;]*;/g;
const REDUCED_MOTION_NO_PREFERENCE_HEADER_RE = /@media\s*\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)/;

/**
 * The one declaration the UI-SPEC sanctions, assembled from its own pieces
 * rather than spelled out whole — the same discipline section 12f already
 * uses (`project_self_tripping_checker_headers`).
 * @type {string}
 */
const EXPECTED_TRANSITION_DECLARATION = ['transition', ': ', 'opacity 200ms ease-out', ';'].join('');

/**
 * Locate the file's `@media (prefers-reduced-motion: no-preference)` block
 * span by BRACE MATCHING from the media query's own opening `{`, never by a
 * line-number guess. Returns `null` when no such header exists, or its
 * braces are unbalanced before EOF.
 * @param {string} source
 * @returns {{ start: number, end: number } | null}
 */
export function findNoPreferenceBlockSpan(source) {
	const headerMatch = REDUCED_MOTION_NO_PREFERENCE_HEADER_RE.exec(source);
	if (!headerMatch) return null;
	const openBraceIdx = source.indexOf('{', headerMatch.index + headerMatch[0].length);
	if (openBraceIdx === -1) return null;
	let depth = 0;
	for (let i = openBraceIdx; i < source.length; i += 1) {
		if (source[i] === '{') depth += 1;
		else if (source[i] === '}') {
			depth -= 1;
			if (depth === 0) return { start: openBraceIdx, end: i };
		}
	}
	return null;
}

/**
 * The pure, exported comparator this rung is built on — provable in
 * isolation against a synthetic CSS string, never a file. Reports the
 * number of `transition:` declarations found, whether the (sole, if
 * exactly one) declaration's character offset lies inside the single
 * no-preference block, and whether its text equals the pinned expected
 * declaration.
 * @param {string} cssSource
 * @returns {{ transitionCount: number, insideBlock: boolean, matchesExpected: boolean }}
 */
export function evaluateTransitionPlacement(cssSource) {
	const matches = [...cssSource.matchAll(CSS_TRANSITION_RE)];
	if (matches.length !== 1) {
		return { transitionCount: matches.length, insideBlock: false, matchesExpected: false };
	}
	const [match] = matches;
	const span = findNoPreferenceBlockSpan(cssSource);
	const offset = match.index ?? -1;
	const insideBlock = span !== null && offset >= span.start && offset < span.end;
	const matchesExpected = match[0].trim() === EXPECTED_TRANSITION_DECLARATION;
	return { transitionCount: matches.length, insideBlock, matchesExpected };
}

test('positive control: the CSS-animation matcher fires on planted @keyframes and linear-gradient fixtures', () => {
	assert.match('@keyframes shimmer{}', CSS_NO_TRANSITION_ANIMATION_RE);
	assert.match('linear-gradient(red, blue)', CSS_NO_TRANSITION_ANIMATION_RE);
});

test('positive control: the transition-placement evaluator fires on two differently-shaped violating inputs and passes on a healthy one — three synthetic CSS strings, never a file', () => {
	const healthy = [
		'.foo { color: red; }',
		'@media (prefers-reduced-motion: no-preference) {',
		'\t.live-update-badge {',
		`\t\t${EXPECTED_TRANSITION_DECLARATION}`,
		'\t}',
		'}',
	].join('\n');
	const healthyResult = evaluateTransitionPlacement(healthy);
	assert.equal(healthyResult.transitionCount, 1, 'fixture sanity: exactly one planted transition');
	assert.equal(healthyResult.insideBlock, true, 'the evaluator is inert against a correctly-placed transition');
	assert.equal(healthyResult.matchesExpected, true, 'the evaluator is inert against the pinned declaration text');

	const outsideBlock = [
		`.live-update-badge { ${EXPECTED_TRANSITION_DECLARATION} }`,
		'@media (prefers-reduced-motion: no-preference) {',
		'\t.other { color: blue; }',
		'}',
	].join('\n');
	const outsideResult = evaluateTransitionPlacement(outsideBlock);
	assert.equal(outsideResult.transitionCount, 1, 'fixture sanity: exactly one planted transition, outside the block');
	assert.equal(outsideResult.insideBlock, false, 'the evaluator cannot tell a mislocated transition from a correctly placed one');

	const secondTransition = [
		'@media (prefers-reduced-motion: no-preference) {',
		`\t.a { ${EXPECTED_TRANSITION_DECLARATION} }`,
		'\t.b { transition: opacity 100ms linear; }',
		'}',
	].join('\n');
	const secondResult = evaluateTransitionPlacement(secondTransition);
	assert.equal(secondResult.transitionCount, 2, 'fixture sanity: exactly two planted transitions');
	assert.equal(secondResult.matchesExpected, false, 'the evaluator cannot tell a second transition from a single sanctioned one');
});

test('no *.css file under src/ contains @keyframes, animation, animation-name or linear-gradient (D-18)', () => {
	const cssFiles = walkAll(publicSrc()).filter((f) => f.endsWith('.css'));
	assert.ok(cssFiles.length > 0, 'sanity: expected at least one .css file under src/');
	const offenders = [];
	for (const file of cssFiles) {
		const stripped = stripComments(readFileSync(file, 'utf8'));
		if (CSS_NO_TRANSITION_ANIMATION_RE.test(stripped)) offenders.push(file);
	}
	assert.deepEqual(offenders, [], `these CSS files carry an animation/gradient construct: ${offenders.join(', ')}`);
});

test('exactly one transition exists across every *.css under src/, and it lives in app.css (56-14)', () => {
	const cssFiles = walkAll(publicSrc()).filter((f) => f.endsWith('.css'));
	/** @type {Array<{ file: string, transitionCount: number }>} */
	const transitionsByFile = [];
	for (const file of cssFiles) {
		const stripped = stripComments(readFileSync(file, 'utf8'));
		const count = (stripped.match(CSS_TRANSITION_RE) ?? []).length;
		if (count > 0) transitionsByFile.push({ file, transitionCount: count });
	}
	assert.equal(
		transitionsByFile.length,
		1,
		`expected exactly one CSS file to carry a transition, found: ${transitionsByFile.map((t) => `${t.file} (${t.transitionCount})`).join(', ')}`,
	);
	assert.equal(transitionsByFile[0].file, publicSrc('app.css'), 'the one sanctioned transition must live in app.css');
	assert.equal(transitionsByFile[0].transitionCount, 1, 'app.css must carry exactly one transition declaration');
});

test('56-14: app.css\'s one transition matches the pinned sanctioned declaration and lies inside the single no-preference block, located by brace matching', () => {
	const appCssStripped = stripComments(readFileSync(publicSrc('app.css'), 'utf8'));
	const mediaHeaderCount = (appCssStripped.match(/@media\s*\(\s*prefers-reduced-motion/g) ?? []).length;
	assert.equal(mediaHeaderCount, 1, `expected exactly one prefers-reduced-motion media query in app.css, found ${mediaHeaderCount}`);
	const result = evaluateTransitionPlacement(appCssStripped);
	assert.equal(result.transitionCount, 1, 'app.css must carry exactly one transition declaration');
	assert.equal(result.matchesExpected, true, 'the one transition does not match the pinned sanctioned declaration');
	assert.equal(result.insideBlock, true, 'the one transition does not lie inside the single no-preference block');
});

// ---------------------------------------------------------------------------
// 8. D-18 inertness, DOM side.
// ---------------------------------------------------------------------------

test('ElectionShell.tsx contains no busy/status/progress/alert role and no spinner/shimmer/pulse/loading/pending identifier', () => {
	assert.doesNotMatch(SHELL_SOURCE, /aria-busy/);
	assert.doesNotMatch(SHELL_SOURCE, /role="status"/);
	assert.doesNotMatch(SHELL_SOURCE, /role="progressbar"/);
	assert.doesNotMatch(SHELL_SOURCE, /role="alert"/);
	assert.doesNotMatch(SHELL_SOURCE, /<progress/);
	assert.doesNotMatch(SHELL_SOURCE, /spinner|shimmer|pulse|loading|pending/i);
});

// ---------------------------------------------------------------------------
// 9. D-08 key totality, now across THREE scan roots (I-16, 54-05 Task 2 Part
// C). 54-04 places facts.js at packages/ui-web/src/lifecycle/facts.js, so
// every public.headline.*/public.tone.*/public.gap.* literal it mounts (as
// a DATA FIELD -- labelKey/sentenceKey/detailKey/etc, never a literal t()
// call site) sat in a directory neither prior root walked. Left unfixed,
// the moment 54-09 (wave 3) declared those keys in COPY this case would go
// red and stay red for the remaining eight waves -- a known-red suite is
// exactly where a genuine regression hides. This hunk is a SEPARATE,
// unrelated concern from case 10's fence narrowing below: it widens WHERE
// the scan looks, never WHAT it accepts -- both directions stay asserted
// empty, exactly as before.
// ---------------------------------------------------------------------------

const PUBLIC_VOICE_KEY_RE = /^(public\.|advisory\.public\.)/;
const KEY_LITERAL_RE = /['"`](public\.[\w.]+|advisory\.public\.[\w.]+)['"`]/g;

/**
 * The mounted-key walk, extracted so both the real case-9 assertion and
 * Control 1 below can exercise the identical routine over different root
 * sets. `KEY_LITERAL_RE` is anchored to the `public.`/`advisory.public.`
 * prefixes, so a `packages/ui-web/src/lifecycle/` file can only ever
 * contribute a key in that shape -- verified against the two files
 * currently in that directory (`election-phase.js`, `phase-ids.js`, plus
 * `facts.js` once 54-04 lands), none of which can trip the
 * mounted-not-declared direction with a `lifecycle.*`-shaped key. The
 * `variant="public"` special case is moved here UNCHANGED (it is
 * behaviour, not scaffolding): `advisory.public.body` is never spelled out
 * as a literal, resolved instead by `AdvisoryDisclosure`'s
 * `advisory.${variant}.body` TEMPLATE, so its literal mount evidence is
 * `variant="public"` itself.
 *
 * @param {string[]} scanDirs
 * @returns {Set<string>}
 */
function collectMountedPublicKeys(scanDirs) {
	/** @type {Set<string>} */
	const mountedKeys = new Set();
	for (const dir of scanDirs) {
		for (const file of walkAll(dir)) {
			const source = readFileSync(file, 'utf8');
			let m;
			const re = new RegExp(KEY_LITERAL_RE.source, 'g');
			while ((m = re.exec(source))) mountedKeys.add(m[1]);
			if (/variant="public"/.test(source)) mountedKeys.add('advisory.public.body');
		}
	}
	return mountedKeys;
}

// 54-09 REMOVED the interim dynamic skip 54-05 installed here (I-23). The
// literal call is deliberately not quoted anywhere in this file, so a
// reader grepping the suite for a disabled test finds nothing. Its one
// and only cause -- ~42 `facts.js` keys mounted but not yet declared in
// COPY -- is gone: `copy.js` now declares all 50 members of
// `FACT_COPY_KEYS`, `mountedNotDeclared` is empty, and the guard's own
// `mountedNotDeclared.length > 0` condition can no longer hold. It was
// removed rather than left in place because a skip whose reason has expired
// is indistinguishable, in a test report, from a test somebody switched off.
// The assertion below now runs unconditionally.
//
// -- TEMPLATE MOUNT EVIDENCE (54-09) ---------------------------------------
//
// `KEY_LITERAL_RE` can only see a key spelled out as a quoted literal, and
// eight keys are genuinely mounted without ever being spelled out:
// `facts.js` builds `public.tone.<tone>` and `public.group.<group>` from
// TEMPLATE EXPRESSIONS over its own frozen `TONES` and `FACT_GROUPS`
// arrays. They are as mounted as any literal -- `FACT_COPY_KEYS` publishes
// them, and a render site resolves them through those two functions -- but
// no literal scan can ever see them. This is the same situation, and takes
// the same shape of answer, as the `variant="public"` exemption already
// built into the walk above.
//
// The exemption is guarded so it cannot go vacuous, which is the whole
// difference between an exemption and a hole: a key qualifies only if it is
// BOTH a member of `FACT_COPY_KEYS` AND its generating template is still
// present in comment-stripped `facts.js` source. Delete either template and
// its four keys go straight back to being reported as never mounted.
const KEY_TEMPLATE_SOURCES = Object.freeze([
	{ prefix: 'public.tone.', template: 'public.tone.${' },
	{ prefix: 'public.group.', template: 'public.group.${' },
]);

const FACTS_SOURCE_STRIPPED = stripComments(readFileSync(uiWebSrc('lifecycle', 'facts.js'), 'utf8'));

/**
 * Keys emitted by a template expression rather than a literal. Empty unless
 * the template is really there, so a removed template is a red rung.
 * @returns {Set<string>}
 */
function collectTemplateMountedKeys() {
	/** @type {Set<string>} */
	const out = new Set();
	for (const { prefix, template } of KEY_TEMPLATE_SOURCES) {
		if (!FACTS_SOURCE_STRIPPED.includes(template)) continue;
		for (const key of FACT_COPY_KEYS) if (key.startsWith(prefix)) out.add(key);
	}
	return out;
}

// -- PENDING MOUNT, an expiring list (54-09) --------------------------------
//
// The keys 54-09 authored that sit OUTSIDE the fact model. They are
// declared now and mounted later, on purpose: `t()` throws on an unknown
// key, so the copy has to exist before the screens that render it, and the
// header of `copy.js` records the amended warrant under which they arrive
// early. Each is bound BY NAME by a render plan in a later wave --
// the two details-toggle labels and the key-release fail-closed line by the
// fact-card screen, the freshness line and the two standing caveats by the
// page-voice screen, and the disclosure-policy failure line by the rules
// card.
//
// 54-11 removed FOUR entries from this list -- the three index strings and
// the incomplete-holdings qualifier -- because `src/screens/ElectionIndex.tsx`
// now mounts them. That is the mechanism working as designed: the list shrinks
// as the render plans land. Eleven entries became seven.
//
// 54-13 removed THREE more -- the two details-toggle labels and the
// key-release fail-closed line -- because `src/screens/FactSections.tsx` now
// mounts all three as source literals at their call sites. Seven became four.
//
// 54-14 removed the LAST FOUR. The disclosure-policy failure line came out
// first: the staleness rung below went red naming that key the moment
// `src/screens/RegistrantRoll.tsx` mounted it, before any edit was made here.
// It renders in the ROLL card rather than the rules card -- the omission it
// explains happens in that table, and three group sections away it would no
// longer be attached to the column it is about; the key NAME is unchanged. The
// freshness line and the two standing caveats came out with the standing-voice
// block in `src/screens/ElectionShell.tsx`, which mounts all three as literals
// between the fact body and the advisory. The ratchet fired unprompted for
// those three too.
//
// THE LIST WAS EMPTY, THE END STATE IT WAS BUILT FOR -- and that was a
// reason to keep the machinery, not to delete it. 60-01 (Phase 60, D-08)
// re-populates it with three `public.*` keys: `60-01` is the sole owner of
// `copy.js` for the whole phase, so it lands every copy key the phase will
// ever need up front, including the three consumed only later by 60-05/60-06
// (the keyholder-release meter's empty frame and the roll-composition
// chart's tooltip/fold-label). Each is named by an already-locked decision
// (60-CONTEXT.md D-08/D-09) and a named future call site, not a guess --
// exactly the warrant this list has always required.
//
// This list is NOT a relaxation of the assertion, and two properties make
// that true rather than merely asserted:
//   - `declaredNotMounted` must be a SUBSET of it. Any other declared key
//     with no mount site still fails, exactly as before.
//   - Any member that HAS since been mounted must be deleted from it. A
//     stale entry fails loudly, naming itself, instead of quietly
//     forgiving something that no longer needs forgiving. That is what
//     makes the list shrink to empty as the render plans land, rather than
//     outliving its reason the way the removed skip would have.
/** @type {ReadonlyArray<string>} */
const PENDING_MOUNT_KEYS = Object.freeze([]);

test('the public-voice key set in COPY equals, in both directions, the set of public-voice keys mounted under src/, packages/ui-web/src/components/ and packages/ui-web/src/lifecycle/ -- as a literal, as the variant="public" template, or as one of facts.js own key templates -- apart from the named PENDING_MOUNT_KEYS still awaiting their render plan', () => {
	const declaredKeys = new Set(Object.keys(COPY).filter((k) => PUBLIC_VOICE_KEY_RE.test(k)));
	const scanDirs = [publicSrc(), uiWebRoot('src', 'components'), uiWebRoot('src', 'lifecycle')];
	const mountedKeys = collectMountedPublicKeys(scanDirs);
	for (const key of collectTemplateMountedKeys()) mountedKeys.add(key);

	const declaredNotMounted = [...declaredKeys].filter((k) => !mountedKeys.has(k));
	const mountedNotDeclared = [...mountedKeys].filter((k) => !declaredKeys.has(k));

	const pending = new Set(PENDING_MOUNT_KEYS);
	const unexplainedDeclaredNotMounted = declaredNotMounted.filter((k) => !pending.has(k));

	assert.deepEqual(
		unexplainedDeclaredNotMounted,
		[],
		`declared public-voice key(s) never mounted, and not on the pending-mount list: ${unexplainedDeclaredNotMounted.join(', ')}`,
	);
	assert.deepEqual(mountedNotDeclared, [], `mounted public-voice key(s) never declared in COPY: ${mountedNotDeclared.join(', ')}`);
});

test('the pending-mount list is not stale -- every key on it is still both declared in COPY and genuinely unmounted, so an entry whose render plan has landed fails here instead of quietly forgiving nothing', () => {
	const declaredKeys = new Set(Object.keys(COPY).filter((k) => PUBLIC_VOICE_KEY_RE.test(k)));
	const scanDirs = [publicSrc(), uiWebRoot('src', 'components'), uiWebRoot('src', 'lifecycle')];
	const mountedKeys = collectMountedPublicKeys(scanDirs);
	for (const key of collectTemplateMountedKeys()) mountedKeys.add(key);

	/** @type {string[]} */
	const stale = [];
	for (const key of PENDING_MOUNT_KEYS) {
		if (!declaredKeys.has(key)) stale.push(`${key}: no longer declared in COPY -- remove it from the list`);
		else if (mountedKeys.has(key)) stale.push(`${key}: now mounted -- remove it from the list`);
	}
	assert.deepEqual(stale, [], `the pending-mount list has stale entries:\n${stale.join('\n')}`);
});

test('control: the template mount-evidence exemption is real and can fail -- both facts.js key templates are present in comment-stripped source, and each contributes its four keys; a fabricated template contributes none', () => {
	for (const { template } of KEY_TEMPLATE_SOURCES) {
		assert.ok(
			FACTS_SOURCE_STRIPPED.includes(template),
			`facts.js no longer builds "${template}" -- the exemption for those keys must be deleted, not widened`,
		);
	}
	const templateMounted = collectTemplateMountedKeys();
	assert.equal(templateMounted.size, 8, `expected 4 tone + 4 group keys, got ${templateMounted.size}`);
	assert.ok(templateMounted.has('public.tone.go'));
	assert.ok(templateMounted.has('public.group.outcome'));
	// Inertness: a prefix whose template does NOT appear in facts.js
	// contributes nothing, which is what proves the guard is the thing doing
	// the work rather than the FACT_COPY_KEYS membership alone.
	assert.ok(!FACTS_SOURCE_STRIPPED.includes('public.__absent_template__.${'));
	assert.ok(!templateMounted.has('public.headline.voting'), 'headline keys are literals and must not arrive through the template path');
});

test('control 1: root membership actually drives discovery -- a synthetic key mounted only in a throwaway directory is found when that directory is in scanDirs and absent otherwise', () => {
	// Never added to COPY, and the real roots are never walked while it
	// exists, so this synthetic key cannot pollute either direction of the
	// real case-9 assertion above.
	const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'election-shell-case9-control-'));
	try {
		writeFileSync(path.join(tmpDir, 'Control.tsx'), "t('public.__control__.probe')");
		const foundInTmp = collectMountedPublicKeys([tmpDir]);
		const foundInRealSrc = collectMountedPublicKeys([publicSrc()]);
		assert.ok(foundInTmp.has('public.__control__.probe'), 'expected the synthetic key to be found when the throwaway root is in scanDirs');
		assert.ok(!foundInRealSrc.has('public.__control__.probe'), 'the synthetic key must not leak into a scan of the real src/ root');
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('control 2: the new packages/ui-web/src/lifecycle/ root exists on disk and yields at least one file', () => {
	// A mistyped path would make the widening above permanently inert while
	// looking perfectly correct in review -- this is the cheap check that
	// catches it.
	const lifecycleDir = uiWebRoot('src', 'lifecycle');
	assert.ok(existsSync(lifecycleDir), `expected ${lifecycleDir} to exist on disk`);
	assert.ok(walkAll(lifecycleDir).length > 0, `expected at least one file under ${lifecycleDir}`);
});

// ---------------------------------------------------------------------------
// 10. D-24 — no URL input selects a phase.
//
// RETIREMENT LEDGER (54-10, wave 5) ------------------------------------------
//
// What stood here until now was a single regex asserting ZERO occurrences of
// a named token list anywhere under src/. Phase 53 built it as a deliberate
// SCOPE FENCE -- a marker saying "the empty-shell phase has not started on
// the next phase's territory" -- and never as a security control. D-01 and
// D-06 move that boundary on purpose, so the fence is obsolete BY DESIGN:
// this phase IS that territory.
//
// The removal is PLANNED WORK owned by 54-10, recorded at
// `.planning/phases/54-public-no-login-election-view/54-ISSUES.md` I-02 and
// `54-RESEARCH.md` Pitfall 1. Left in place it would have turned red during
// waves 6-7 as a mystery CI failure, and the pressure at that moment is to
// delete it quietly -- which is exactly the thing I-02 exists to prevent.
//
// This is the COMPLETION OF A STAGED RETIREMENT, not a second unrelated
// deletion. 54-05 (wave 2) already dropped two of the nine alternatives for
// its own forced reason -- the shell's phase-derivation function and one real
// phase id, both made unsatisfiable by its ElectionShell.tsx repoint -- and
// left a comment naming 54-10 as the owner of the rest. Seven alternatives
// remained in force when this plan opened the file.
//
// Where each retired term's coverage went, term by term, so a later reader
// does not have to infer it:
//
//   - The four DATABASE-OPENING PRIMITIVES lose NOTHING AT ALL. They are the
//     terms spelled out in `test/node/engine-reach.test.mjs`'s own matcher --
//     deliberately not re-spelled in this comment, because a checker's
//     neighbour quoting the literals another checker hunts is how this repo
//     has manufactured a permanently-green gate several times in this phase.
//     That file's source scan enforced those terms INDEPENDENTLY of this one
//     and SURVIVES; 54-10 narrows it from a prohibition into a DELEGATION
//     rule -- the app may never open a database itself, and reaches one only
//     through `@votetorrent/web-data/public` (D-03/D-04).
//   - The three-bucket term is covered phase-wide, with its own positive
//     control, by `packages/ui-web/test/three-bucket-absent.test.mjs`
//     (54-05, D-07).
//   - The remaining two -- a module filename and a networks-listing function
//     name -- were pure territory markers with no security content. They go
//     uncovered, deliberately and on the record.
//
// WHAT SECTION 10 PROVES INSTEAD (D-24) --------------------------------------
//
// No URL input may choose which lifecycle phase a visitor is shown. The `at`
// prop stays exactly the injectable, test-only seam Phase 53 built (see
// `ElectionShell.tsx`'s `at` doc comment and `election-address.js`'s header
// point 4, which names the same threat as T-53-07-04).
//
// The two matchers below run over TWO ROOTS WITH OPPOSITE EXPECTATIONS --
// zero matches under `src/`, at least one under `test/browser/` -- rather
// than over one root with an exception list. An exception list is the
// weakening path, and a shared root would force the whole assertion to be
// dropped the first time the harness legitimately tripped it. The harness
// half is also the only thing proving the production half's green is a REAL
// absence rather than an inert matcher.
// ---------------------------------------------------------------------------

/**
 * The phase/time-selection query-parameter vocabulary D-24 forbids as an
 * input. Held as a delimited frozen constant so no matcher literal is ever
 * loose in prose. Deliberately EXCLUDES `election` (and any network
 * parameter a later wave adds): those address WHICH election is shown, not
 * WHICH PHASE it is shown in, and D-33 requires them.
 * @type {ReadonlyArray<string>}
 */
const PHASE_SELECTION_PARAM_NAMES = Object.freeze(['phase', 'at', 'now', 'instant', 'asof', 'when', 'time', 'clock']);

const PHASE_SELECTION_ALTERNATION = PHASE_SELECTION_PARAM_NAMES.join('|');

/**
 * Matches a query-parameter READ, never a bare identifier — built
 * programmatically from the frozen array above so the two can never drift.
 * Two branches: a `.get`/`.getAll`/`.has` call whose argument is one of the
 * names in single, double or backtick quotes; and a raw `?name=`/`&name=`
 * query-string literal. Matching the READ rather than the word is what keeps
 * an ordinary local variable called `now` or `time` from false-firing.
 * @type {RegExp}
 */
const PHASE_PARAM_READ_RE = new RegExp(
	`\\.(?:get|getAll|has)\\(\\s*(['"\`])(?:${PHASE_SELECTION_ALTERNATION})\\1\\s*\\)|[?&](?:${PHASE_SELECTION_ALTERNATION})=`,
	'i',
);

/**
 * Matches a JSX attribute of the form `at={`, with optional whitespace either
 * side of the `=`. Scoped to `.tsx` files only, because only a JSX mount site
 * can pass the prop.
 *
 * The lookbehind is what keeps this from firing on the two `at` forms that
 * legitimately live INSIDE `ElectionShell.tsx`: the interface field is
 * `at?:` (a colon, never a brace) and the destructured default is `at = null`
 * (a null literal, never a brace). It also blocks any longer identifier
 * ending in those two letters — a `format={...}` prop is not an `at` prop.
 * @type {RegExp}
 */
const AT_PROP_MOUNT_RE = /(?<![\w$.-])at\s*=\s*\{/;

// -- Controls first, before either matcher touches real source --------------

/** One planted line per vocabulary member, cycling the four accepted syntactic
 * forms, so a term that silently fell out of the fixture fails as a FIXTURE
 * defect rather than as a matcher defect. */
const PHASE_PARAM_READ_FIXTURE_LINES = PHASE_SELECTION_PARAM_NAMES.map((name, i) => {
	const form = i % 4;
	if (form === 0) return `const a${i} = params.get('${name}');`;
	if (form === 1) return `const b${i} = searchParams.has("${name}");`;
	if (form === 2) return `const c${i} = params.getAll(\`${name}\`);`;
	return `const d${i} = '/index.html?${name}=x';`;
});

test('positive control: the phase-parameter-read matcher fires on a planted fixture, once per vocabulary member and across all four accepted forms', () => {
	assert.equal(PHASE_PARAM_READ_FIXTURE_LINES.length, PHASE_SELECTION_PARAM_NAMES.length);
	PHASE_SELECTION_PARAM_NAMES.forEach((name, i) => {
		assert.ok(PHASE_PARAM_READ_FIXTURE_LINES[i].includes(name), `fixture sanity: line ${i} must literally contain "${name}"`);
		assert.match(PHASE_PARAM_READ_FIXTURE_LINES[i], PHASE_PARAM_READ_RE, `matcher is inert against the planted read of "${name}"`);
	});
	assert.match(PHASE_PARAM_READ_FIXTURE_LINES.join('\n'), PHASE_PARAM_READ_RE);
});

test('benign control: the phase-parameter-read matcher does NOT fire on election-address.js\'s real shape — a getAll through a constant, a quoted "election" literal, and the address query string D-33 requires', () => {
	const benign = [
		'const values = params.getAll(ELECTION_ADDRESS_PARAM);',
		"const single = params.get('election');",
		"const href = '/index.html?election=abc';",
		'const now = Date.now();',
		'const time = clock.read();',
	].join('\n');
	assert.doesNotMatch(benign, PHASE_PARAM_READ_RE, 'matcher cannot discriminate a phase override from the election address parameter');
	// And against the real file, not just a hand-written approximation of it.
	assert.doesNotMatch(stripComments(readFileSync(publicSrc('election-address.js'), 'utf8')), PHASE_PARAM_READ_RE);
});

test('positive control: the at-prop mount matcher fires on a planted <ElectionShell at={x} /> and does not fire on the two at forms inside ElectionShell.tsx or on a longer prop name ending in those letters', () => {
	assert.match('<ElectionShell at={FIXTURE_INSTANTS[phase]} />', AT_PROP_MOUNT_RE);
	assert.match('\t\t\t\tat = { instant }', AT_PROP_MOUNT_RE);
	assert.doesNotMatch('\tat?: string | null;', AT_PROP_MOUNT_RE);
	assert.doesNotMatch('export function ElectionShell({ search, at = null, election = null }: ElectionShellProps) {', AT_PROP_MOUNT_RE);
	assert.doesNotMatch('<Stamp format={iso} />', AT_PROP_MOUNT_RE);
	assert.doesNotMatch('<LifecyclePill phase={phase} />', AT_PROP_MOUNT_RE);
});

// -- The production scans: both expect ZERO ---------------------------------

const D24_FAILURE_REASON =
	'A URL-selectable lifecycle instant would let a link author choose which lifecycle state any visitor is shown — ' +
	'a false claim about an election\'s state, delivered by a hostile link, on a page whose only value is that its ' +
	'claims can be checked (D-24; successor to T-53-07-04).';

test('D-24: no file under src/ reads a phase- or time-selection query parameter', () => {
	const offenders = [];
	for (const file of walkAll(publicSrc())) {
		const stripped = stripComments(readFileSync(file, 'utf8'));
		if (PHASE_PARAM_READ_RE.test(stripped)) offenders.push(file);
	}
	assert.deepEqual(offenders, [], `these files read a phase/time-selection query parameter: ${offenders.join(', ')}. ${D24_FAILURE_REASON}`);
});

test('D-24: no .tsx file under src/ passes an at prop to a mount site — the seam stays test-only', () => {
	const tsxFiles = walkAll(publicSrc()).filter((f) => f.endsWith('.tsx'));
	assert.ok(tsxFiles.length > 0, 'sanity: expected at least one .tsx file under src/');
	const offenders = [];
	for (const file of tsxFiles) {
		const stripped = stripComments(readFileSync(file, 'utf8'));
		if (AT_PROP_MOUNT_RE.test(stripped)) offenders.push(file);
	}
	assert.deepEqual(offenders, [], `these production .tsx files pass the at prop at a mount site: ${offenders.join(', ')}. ${D24_FAILURE_REASON}`);
});

// -- The harness scan: same two matchers, opposite expectation --------------

test('harness discrimination: test/browser/ DOES exercise both seams — at least one file reads a phase-selection parameter and at least one .tsx passes the at prop, so the two production scans above are proving a real absence rather than running an inert matcher', () => {
	// Asserted over the DIRECTORY, never against a file by name, so later
	// harness work can relocate or split the gate without breaking this.
	const harnessDir = publicRoot('test', 'browser');
	const files = walkAll(harnessDir);
	assert.ok(files.length > 0, `sanity: expected at least one file under ${harnessDir}`);

	const paramReaders = [];
	const atMounters = [];
	for (const file of files) {
		const stripped = stripComments(readFileSync(file, 'utf8'));
		if (PHASE_PARAM_READ_RE.test(stripped)) paramReaders.push(file);
		if (file.endsWith('.tsx') && AT_PROP_MOUNT_RE.test(stripped)) atMounters.push(file);
	}

	assert.ok(
		paramReaders.length > 0,
		`no file under ${harnessDir} reads a phase-selection query parameter. The browser harness is the ONLY sanctioned ` +
			'consumer of that seam; if it has stopped exercising it, the src/ scan above is no longer proving anything and ' +
			'must be re-pointed rather than left green.',
	);
	assert.ok(
		atMounters.length > 0,
		`no .tsx file under ${harnessDir} passes the at prop. Same reasoning: the harness is the only sanctioned consumer ` +
			'of the injectable instant, and a production-absence scan whose matcher has never been seen to fire on real ' +
			'code is a vacuous gate.',
	);
});

// -- Argument provenance: the instant can never be re-plumbed from the URL --
//
// The two scans above would both stay green if somebody parsed the address
// and handed the result to the instant resolver under a different name. This
// closes that path in the direction that matters most: every call site's
// argument text must name the injected binding and must name nothing
// address-derived.

const INSTANT_CALL_SOURCE = 'resolveComparisonInstant\\(([^)]*)\\)';
const INSTANT_ARG_FORBIDDEN_RE = /\b(search|address|params|location|URLSearchParams)\b/;

/** @param {string} source @returns {string[]} the argument text of every call site. */
function instantCallArguments(source) {
	/** @type {string[]} */
	const out = [];
	const re = new RegExp(INSTANT_CALL_SOURCE, 'g');
	let m;
	while ((m = re.exec(source))) out.push(m[1]);
	return out;
}

test('positive control: the instant-provenance check fires on a planted address-derived argument and on a planted argument that never names the injected binding', () => {
	const addressDerived = 'const { phase } = derivePhase(x, y, resolveComparisonInstant(parseElectionAddress(search).instant));';
	const addressArgs = instantCallArguments(addressDerived);
	assert.equal(addressArgs.length, 1, 'fixture sanity: exactly one planted call site');
	assert.match(addressArgs[0], INSTANT_ARG_FORBIDDEN_RE, 'the forbidden-provenance matcher is inert against an address-derived argument');

	const urlDerived = 'resolveComparisonInstant(params.get("at") ?? undefined)';
	const urlArgs = instantCallArguments(urlDerived);
	assert.equal(urlArgs.length, 1);
	assert.match(urlArgs[0], INSTANT_ARG_FORBIDDEN_RE);

	const unbound = 'resolveComparisonInstant(fromSomewhereElse)';
	const unboundArgs = instantCallArguments(unbound);
	assert.equal(unboundArgs.length, 1);
	assert.doesNotMatch(unboundArgs[0], /\bat\b/, 'the names-the-binding check is inert against an argument that never names it');
});

test('D-24 structural: every resolveComparisonInstant call site in ElectionShell.tsx passes the injected at binding and nothing address-derived', () => {
	const args = instantCallArguments(SHELL_SOURCE);
	assert.ok(args.length > 0, 'sanity: expected at least one resolveComparisonInstant call site in ElectionShell.tsx');
	for (const arg of args) {
		assert.match(arg, /\bat\b/, `a resolveComparisonInstant call site does not pass the injected at binding: "${arg}". ${D24_FAILURE_REASON}`);
		assert.doesNotMatch(arg, INSTANT_ARG_FORBIDDEN_RE, `a resolveComparisonInstant call site takes an address-derived argument: "${arg}". ${D24_FAILURE_REASON}`);
	}
});

// ---------------------------------------------------------------------------
// 11. 53-06's invariants survive.
// ---------------------------------------------------------------------------

test("53-06's invariants survive: app.css's leading @import, no :root/custom property, main.tsx's frozen __PUBLIC_APP__ and app.css-first import, AppChrome.tsx's wordlessness", () => {
	const cssSource = readFileSync(publicSrc('app.css'), 'utf8');
	const lines = cssSource.split('\n');
	let firstMeaningfulLine;
	let inBlockComment = false;
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (line === '') continue;
		if (inBlockComment) {
			if (line.includes('*/')) inBlockComment = false;
			continue;
		}
		if (line.startsWith('/*')) {
			if (!line.includes('*/')) inBlockComment = true;
			continue;
		}
		firstMeaningfulLine = line;
		break;
	}
	assert.equal(firstMeaningfulLine, "@import '@votetorrent/ui-web/tokens.css';");
	assert.doesNotMatch(cssSource, /:root/);
	assert.doesNotMatch(cssSource, /^\s*--/m);

	const mainSource = readFileSync(publicSrc('main.tsx'), 'utf8');
	assert.equal(mainSource.trim().split('\n')[0].trim(), "import './app.css';");
	assert.match(mainSource, /window\.__PUBLIC_APP__\s*=\s*Object\.freeze\(/);

	const JSX_TEXT_RUN_RE = /[>][^<>{}]*[A-Za-z]{2,}[^<>{}]*[<]/;
	const chromeSource = readFileSync(publicSrc('screens', 'AppChrome.tsx'), 'utf8');
	const offendingLines = chromeSource.split('\n').filter((line) => JSX_TEXT_RUN_RE.test(line));
	assert.deepEqual(offendingLines, [], `AppChrome.tsx contains a JSX text run: ${JSON.stringify(offendingLines)}`);
});

// ---------------------------------------------------------------------------
// 12. 54-12 — the real read landed in this shell.
//
// Additions, not edits: nothing above this line changed. Each matcher runs its
// planted-fixture control BEFORE it touches real source, and each control is
// asserted to FIRE rather than merely to exist.
// ---------------------------------------------------------------------------

// -- 12a. D-17: the banner carries colour AND a redundant word ---------------

const TONE_CHIP_RE = /status-banner__tone/;
const TONE_MODIFIER_RE = /status-banner--\$\{\s*tone\s*\}/;
const TONE_KEY_CALL_RE = /toneCopyKey\(/;

test('positive control: the D-17 banner matchers all fire on a planted complete banner, and the chip matcher goes silent on a planted chip-removed variant', () => {
	const complete =
		'<div className={`status-banner status-banner--${tone}`}>' +
		'<span className="status-banner__tone">{t(toneCopyKey(tone))}</span>' +
		'<p className="status-banner__headline">{headlineText}</p></div>';
	assert.match(complete, TONE_CHIP_RE, 'the chip matcher is inert against a planted complete banner');
	assert.match(complete, TONE_MODIFIER_RE, 'the tone-modifier matcher is inert against a planted complete banner');
	assert.match(complete, TONE_KEY_CALL_RE, 'the tone-key matcher is inert against a planted complete banner');

	// The failure this control exists for: a banner that kept its colour and
	// lost its word. Colour alone is invisible in greyscale and to a
	// colour-blind reader, which is the entire content of D-17.
	const chipRemoved =
		'<div className={`status-banner status-banner--${tone}`}>' +
		'<p className="status-banner__headline">{headlineText}</p></div>';
	assert.doesNotMatch(chipRemoved, TONE_CHIP_RE, 'the chip matcher cannot tell a chipless banner from a complete one');
	assert.doesNotMatch(chipRemoved, TONE_KEY_CALL_RE);
});

test('D-17: ElectionShell.tsx renders the tone chip, the tone modifier interpolated from the derived tone, and resolves the chip word through toneCopyKey', () => {
	assert.match(SHELL_SOURCE, TONE_CHIP_RE, 'the status banner has no tone chip — the tone would survive only as colour');
	assert.match(SHELL_SOURCE, TONE_MODIFIER_RE, 'the banner block carries no tone modifier interpolated from `tone`');
	assert.match(SHELL_SOURCE, TONE_KEY_CALL_RE, 'the chip word is not resolved through toneCopyKey');
	assert.match(SHELL_SOURCE, /status-banner__headline/, 'the headline sentence carries no class — 54-09 declared `.status-banner__headline` and app.css states the chip and the headline are the banner two children');
});

// -- 12b. The shell holds no effect, no await and no read -------------------

test('ElectionShell.tsx contains zero useEffect, zero `await ` and zero readAddressedElection — every one of those lives in use-public-election.ts, which is what protects the single-return structure case 1 asserts', () => {
	for (const [label, needle] of [
		['useEffect', 'useEffect'],
		['await', 'await '],
		['readAddressedElection', 'readAddressedElection'],
	]) {
		assert.equal(
			(SHELL_SOURCE.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length,
			0,
			`ElectionShell.tsx names ${label}. The hook owns every effect, every await and every cleanup closure; ` +
				'inlining one here trips case 1 as a confusing return-count mismatch instead of failing by name here.',
		);
	}
});

// -- 12c. 53-D17: the injected election prop bypasses the read (behavioural) -

// Imported from the plain-JS read seam rather than from the hook, because
// `node --test` cannot import a `.ts` module without a type-stripping flag
// this workspace's runner does not pass -- and a predicate that can only be
// checked by matching source text is a predicate that is not really checked.
// `use-public-election.ts` re-exports the same binding, which the assertion
// below pins so the two can never come apart.
const { shouldReadFor } = await import('../../src/public-election-source.js');

test('the hook really does publish the same predicate: use-public-election.ts re-exports shouldReadFor from the read seam rather than defining a second copy', () => {
	const hookSource = stripComments(readFileSync(publicSrc('screens', 'use-public-election.ts'), 'utf8'));
	assert.match(hookSource, /export \{ shouldReadFor \}/, 'the hook does not re-export shouldReadFor');
	assert.doesNotMatch(hookSource, /function shouldReadFor/, 'the hook defines a SECOND shouldReadFor -- the behavioural assertion below would then be measuring the wrong one');
});

test('53-D17 behavioural: shouldReadFor is false whenever an election was injected, and true only for a null election with an address naming both a network and an election', () => {
	assert.equal(typeof shouldReadFor, 'function', 'the read seam must export shouldReadFor so this can be asserted by behaviour rather than by a source matcher');
	const okAddress = { status: 'ok', networkHash: 'aBcDeF0123456789aBcDeF0123456789', electionId: 'election-0123456789abcdef' };

	assert.equal(shouldReadFor({ title: 'x', timeline: null }, okAddress), false, 'a supplied election must open no database — every existing browser gate depends on it');
	assert.equal(shouldReadFor(null, okAddress), true, 'a null election with a complete address must read');
	assert.equal(shouldReadFor(null, { status: 'missing', networkHash: null, electionId: null }), false);
	assert.equal(shouldReadFor(null, { status: 'incomplete', networkHash: okAddress.networkHash, electionId: null }), false);
	assert.equal(shouldReadFor(null, null), false);
});

// -- 12d. 54-05's white-screen trap is not reintroduced ---------------------

const NULL_COALESCE_RE = /\?\?\s*null/;
const CROSS_CHECK_GUARD_RE = /crossCheck\s*=\s*\(\s*\w+\s*\?\?\s*\{\}\s*\)/;

const DERIVE_PHASE_TRAP_REASON =
	'54-05 measured this: parseTimeline(timeline, election = {}) fires its default parameter ONLY for `undefined`, and its ' +
	'body then reads `election.ballotDeadline` unguarded — so a `null` first argument throws a TypeError and WHITE-SCREENS ' +
	'the shipped root URL. The election prop is optional, so that is a reachable input, not a theoretical one (T-54-12-07).';

test('positive control: the derivePhase null-coalesce matcher fires on a planted `?? null` cross-check and the guard matcher goes silent on it', () => {
	const planted = 'const crossCheck = (shellElection ?? null) as unknown as Parameters<typeof derivePhase>[0];';
	assert.match(planted, NULL_COALESCE_RE, 'the null-coalesce matcher is inert against the planted trap');
	assert.doesNotMatch(planted, CROSS_CHECK_GUARD_RE, 'the guard matcher accepts the planted trap as if it were the safe form');
	const safe = 'const crossCheck = (shellElection ?? {}) as unknown as Parameters<typeof derivePhase>[0];';
	assert.match(safe, CROSS_CHECK_GUARD_RE, 'the guard matcher is inert against the real safe form');
});

test('T-54-12-07: no line in ElectionShell.tsx that names derivePhase or its cross-check argument coalesces to null, and the cross-check itself coalesces to an empty object', () => {
	const offenders = SHELL_SOURCE.split('\n').filter(
		(line) => (line.includes('derivePhase') || line.includes('crossCheck')) && NULL_COALESCE_RE.test(line),
	);
	assert.deepEqual(offenders, [], `${DERIVE_PHASE_TRAP_REASON}\nOffending line(s): ${JSON.stringify(offenders)}`);
	assert.match(SHELL_SOURCE, CROSS_CHECK_GUARD_RE, `the derivePhase cross-check no longer guards its first argument. ${DERIVE_PHASE_TRAP_REASON}`);
});

// -- 12e. This plan's own copy keys are mounted -----------------------------
//
// Computed directly rather than relying on case 9 being green overall, so
// these keys are proven independently of whether some other plan's keys are
// outstanding (this plan's <interfaces> section 5).

const OWNED_KEY_PREFIXES = Object.freeze(['public.headline.', 'public.tone.', 'public.election.notHeld.']);

test("54-12's own copy keys are mounted and declared in both directions, computed independently of the rest of case 9", () => {
	const declaredKeys = new Set(Object.keys(COPY).filter((k) => PUBLIC_VOICE_KEY_RE.test(k)));
	const scanDirs = [publicSrc(), uiWebRoot('src', 'components'), uiWebRoot('src', 'lifecycle')];
	const mountedKeys = collectMountedPublicKeys(scanDirs);
	for (const key of collectTemplateMountedKeys()) mountedKeys.add(key);

	/** @param {string} k */
	const owned = (k) => OWNED_KEY_PREFIXES.some((p) => k.startsWith(p));

	const declaredNotMounted = [...declaredKeys].filter((k) => owned(k) && !mountedKeys.has(k));
	const mountedNotDeclared = [...mountedKeys].filter((k) => owned(k) && !declaredKeys.has(k));

	// Anti-vacuity: if the prefixes matched nothing at all, both lists would be
	// empty and this case would prove nothing.
	const ownedDeclared = [...declaredKeys].filter(owned);
	assert.ok(ownedDeclared.length >= 13, `expected at least 7 headline + 4 tone + 2 notHeld keys, found ${ownedDeclared.length}`);

	assert.deepEqual(declaredNotMounted, [], `54-12 keys declared but never mounted: ${declaredNotMounted.join(', ')}`);
	assert.deepEqual(mountedNotDeclared, [], `54-12 keys mounted but never declared: ${mountedNotDeclared.join(', ')}`);
});

// -- 12f. D-10: the skeleton guard names the read state, never a phase ------
//
// The phase name 54-05's holding measure tested against is ASSEMBLED rather
// than written, so this file's own matcher cannot be satisfied by this file's
// own prose. The two assertions below pin that: the assembled token really is
// the phase name (it is a value the shared model can return), and this file's
// RAW source contains it nowhere as a literal.

const HOLDING_MEASURE_PHASE = ['indeter', 'minate'].join('');

test("self-trip control: the retired holding measure's phase name is assembled, so this file's own raw source contains it nowhere as a literal", () => {
	// A checker whose own prose quotes the pattern it hunts is permanently
	// green -- this phase has manufactured that failure seven times. The path
	// is resolved through source-paths.mjs, never from import.meta.url, per
	// this file's own header rule.
	const raw = readFileSync(publicRoot('test', 'node', 'election-shell.test.mjs'), 'utf8');
	const occurrences = (raw.match(new RegExp(HOLDING_MEASURE_PHASE, 'g')) ?? []).length;
	assert.equal(occurrences, 0, `the phase name must never appear as a literal in this file, found ${occurrences} occurrence(s)`);
	// ...and the assembled token really is the phase name the shared model can
	// return, so the assertion below is not comparing against a typo.
	assert.equal(HOLDING_MEASURE_PHASE, INDETERMINATE_PHASE, 'the assembled token is not the phase id the lifecycle model publishes');
});

test('positive control: the holding-measure matcher fires on a planted reinstatement of 54-05 widened condition, and not on the narrowed guard that replaced it', () => {
	const widened = `{phase === null || phase === '${HOLDING_MEASURE_PHASE}' ? (\n<div className="skeleton" data-slot="lifecycle">`;
	assert.ok(widened.includes(HOLDING_MEASURE_PHASE), 'fixture sanity: the planted condition must literally name the phase');
	const narrowed = '{showLifecycleSlot ? (\n<div className="skeleton" data-slot="lifecycle">';
	assert.ok(!narrowed.includes(HOLDING_MEASURE_PHASE), 'the matcher cannot tell the narrowed guard from the widened one');
});

test("D-10: 54-05's skeleton holding measure is gone — ElectionShell.tsx names no lifecycle phase at all, and the lifecycle slot is gated on the READ state", () => {
	assert.ok(
		!SHELL_SOURCE.includes(HOLDING_MEASURE_PHASE),
		"ElectionShell.tsx still names the phase 54-05's holding measure tested against. That measure kept the lifecycle " +
			'skeleton rendering across the four-phase vocabulary change and named 54-12 as the owner of its replacement: an ' +
			'unreadable schedule must now say so IN WORDS through the status banner, not hold a grey bar in its place (D-10).',
	);
	assert.match(SHELL_SOURCE, /showLifecycleSlot\s*=\s*[^;]*read\.state === 'reading'/, 'the lifecycle slot guard does not name the reading state');
	assert.match(SHELL_SOURCE, /\{showLifecycleSlot \? \(/, 'the lifecycle slot is not gated on that guard');
});

// -- 12g. D-02: the three states are structurally distinct child sets -------

test('D-02/D-21: notHeld now SHARES its scaffolding with reading and ready — the three states are distinguished by the not-held sentence and the absence of a banner, not by the absence of frames', () => {
	// One section, not three. All three states are CHILDREN of it, which is
	// what keeps 54-11's ElectionIndex mount and the unconditional advisory
	// where 53-D16 and assert-placeholders-labelled.mjs need them.
	assert.equal((SHELL_SOURCE.match(/<section className="election"/g) ?? []).length, 1, 'the election section was duplicated or replaced');

	// notHeld: two unclassed elements, gated on `holdsNothing`, which is
	// itself gated on the address naming an election. A link that names NO
	// election is not a browser that fails to hold one.
	assert.match(SHELL_SOURCE, /const holdsNothing = addressed && read\.state === 'notHeld'/);
	assert.match(SHELL_SOURCE, /\{holdsNothing \? <h2>\{t\('public\.election\.notHeld\.title'\)\}<\/h2> : null\}/);
	assert.match(SHELL_SOURCE, /\{holdsNothing \? <p>\{t\('public\.election\.notHeld\.body'\)\}<\/p> : null\}/);

	// ...it still renders NO banner: we did not fail to read a schedule, we
	// hold no election, and a `bad` / phase-unknown banner here would be a
	// false sentence (D-28). That distinction survives D-21 unchanged.
	assert.match(SHELL_SOURCE, /const showBanner = addressed && \(read\.state === 'ready' \|\| read\.state === 'unreadable'\)/);

	// D-21: the title and timeline skeletons are NO LONGER suppressed on the
	// notHeld branch — the old suppression patterns must be ABSENT now.
	assert.ok(!SHELL_SOURCE.includes("holdsNothing ? null : ("), 'D-21: the title frame must no longer be suppressed on the not-held page');
	assert.ok(!SHELL_SOURCE.includes('shellElection === null && !holdsNothing'), 'D-21: the timeline frame must no longer be suppressed on the not-held page');

	// The lifecycle slot guard now also admits `holdsNothing`, so all three
	// labelled frames render together on the not-held page, exactly as they
	// do on the election-less page — the property
	// assert-placeholders-labelled.mjs measures in a real browser and no
	// source scan can see.
	assert.match(SHELL_SOURCE, /const showLifecycleSlot = !addressed \|\| read\.state === 'reading'/);
	assert.match(SHELL_SOURCE, /const showLifecycleSlot\s*=\s*[^;]*\bholdsNothing\b/, 'the showLifecycleSlot predicate does not name holdsNothing');

	// RENDERING proof lives elsewhere: this file is a source scan, and a
	// source scan cannot see whether the frames laid out or whether the
	// retoned pill's colour actually resolved. See the browser rung built in
	// 56-03 Task 2 (`test/browser/empty-state-gate.mjs`) for that proof.
});

test('54-11 ElectionIndex mount survives: still imported, still one guarded JSX line, still INSIDE the .election section', () => {
	assert.match(SHELL_SOURCE, /import \{ ElectionIndex \} from '\.\/ElectionIndex'/);
	assert.equal((SHELL_SOURCE.match(/<ElectionIndex\b/g) ?? []).length, 1);
	const sectionOpen = SHELL_SOURCE.indexOf('<section className="election"');
	const sectionClose = SHELL_SOURCE.indexOf('</section>', sectionOpen);
	const mountAt = SHELL_SOURCE.indexOf('<ElectionIndex');
	assert.ok(sectionOpen !== -1 && sectionClose !== -1 && mountAt > sectionOpen && mountAt < sectionClose, 'the ElectionIndex mount moved outside the .election section');
});
