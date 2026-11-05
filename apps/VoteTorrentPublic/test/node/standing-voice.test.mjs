/**
 * standing-voice.test.mjs — the page's own three standing statements: mounted,
 * resolvable, uncollapsible, correctly placed, and free of any claim that
 * becomes false the moment this browser's copy starts syncing (D-29, D-32).
 *
 * Every path resolves through `scripts/lib/source-paths.mjs` (53-01) and the
 * copy table is imported by relative path, exactly as `election-shell.test.mjs`
 * does. Every scan strips comment lines before matching.
 *
 * ONE HYGIENE RULE THIS FILE IS BUILT AROUND, and it is why rung 6 below looks
 * indirect: the vocabulary it hunts for lives in a frozen array and is NEVER
 * restated in prose, and its positive control is CONCATENATED from a member of
 * that array rather than written out. A checker whose own comment spells the
 * pattern it greps for is permanently green — this repo has manufactured that
 * failure several times in this phase alone, and rung 6 is the one rung here
 * whose subject is words rather than structure.
 *
 * WHAT NO RUNG HERE CAN PROVE: that the three sentences are legible, or that
 * their styling actually de-emphasises them relative to the facts. Presence is
 * not rendering. Those are browser-tier assertions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publicSrc } from '../../../../scripts/lib/source-paths.mjs';
import { COPY } from '../../../../packages/ui-web/src/index.js';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';

const SHELL = stripComments(readFileSync(publicSrc('screens', 'ElectionShell.tsx'), 'utf8'));

/**
 * The three statements this plan mounts. `advisory.public.body` is NOT a
 * member: it is never spelled as a literal anywhere (the advisory resolves it
 * from a template built off its own variant), so it cannot be scanned for the
 * way these three can. It is asserted separately wherever the subject is the
 * VALUE rather than the mount.
 * @type {ReadonlyArray<string>}
 */
const STANDING_VOICE_KEYS = Object.freeze([
	'public.freshness.body',
	'public.caveat.timelineUnvalidated',
	'public.caveat.readOnly',
]);

/** Every value that makes up the page's voice, mount evidence aside. */
const VOICE_VALUE_KEYS = Object.freeze([...STANDING_VOICE_KEYS, 'advisory.public.body']);

/**
 * The vocabulary of a replication reach this tree does not have. Held here as
 * data and named nowhere else in this file — see the header.
 * @type {ReadonlyArray<string>}
 */
const OVERREACHING_CLAIM_TOKENS = Object.freeze([
	'replicat',
	'peer-to-peer',
	'peer to peer',
	'real-time',
	'real time',
	'sync',
	'up to date',
	'up-to-date',
	'anyone with a link',
	'everyone can see',
	'across the network',
	'live copy',
	'always current',
]);

/** The three rules the repo-root copy gate enforces on a copy VALUE, restated
 * here so a violation surfaces in this app's own suite rather than only there. */
const DECISION_ID_RE = /\bD-\d{2}\b/;
const PHASE_NUMBER_RE = /\bPhase\s+\d+\b/;
const RESTRICTED_MODE_RE = /read-only/i;

// ---------------------------------------------------------------------------
// 1. Sanity — anti-vacuous. Every rung below scans one string; if that string
//    were empty they would all pass while proving nothing.
// ---------------------------------------------------------------------------

test('1. sanity: the comment-stripped shell is non-empty and still carries the advisory mount this file positions the voice against', () => {
	assert.ok(SHELL.trim().length > 0, 'ElectionShell.tsx is empty after comment stripping');
	assert.match(SHELL, /<AdvisoryDisclosure\b/, 'the advisory mount is gone — every placement rung below would be measuring nothing');
	assert.match(SHELL, /variant="public"/, 'the advisory no longer carries the literal public variant');
});

// ---------------------------------------------------------------------------
// 2. Mounted — exactly once each.
//
//    Exactly once, not at least once: a second mount would print the same
//    sentence twice on a page whose whole subject is saying things once,
//    plainly.
// ---------------------------------------------------------------------------

test('2. each standing-voice key appears exactly once as a quoted literal in the shell', () => {
	for (const key of STANDING_VOICE_KEYS) {
		const occurrences = (SHELL.match(new RegExp(`'${key.replace(/\./g, '\\.')}'`, 'g')) ?? []).length;
		assert.equal(occurrences, 1, `${key} is mounted ${occurrences} times — expected exactly one`);
	}
});

// ---------------------------------------------------------------------------
// 3. Resolvable. `t()` throws on an unknown key, so this rung is what turns a
//    copy-table drift into a red test rather than a blank page.
// ---------------------------------------------------------------------------

test('3. every voice key, plus the page detail body, resolves in COPY to a non-empty string', () => {
	for (const key of [...VOICE_VALUE_KEYS, 'public.details.body']) {
		assert.equal(typeof COPY[key], 'string', `${key} is not declared in COPY — t() would throw and the page would fail to render`);
		assert.ok(/** @type {string} */ (COPY[key]).trim().length > 0, `${key} resolves to an empty string`);
	}
});

// ---------------------------------------------------------------------------
// 4. Uncollapsible (D-32). Reuses `election-shell.test.mjs`'s nesting idiom.
// ---------------------------------------------------------------------------

/**
 * @param {string} source
 * @param {string} needle
 * @returns {boolean} true if `needle` appears between a `<DetailsToggle` open tag and its close tag.
 */
function nestedInToggle(source, needle) {
	const openIdx = source.indexOf('<DetailsToggle');
	if (openIdx === -1) return false;
	const closeIdx = source.indexOf('</DetailsToggle>', openIdx);
	if (closeIdx === -1) return false;
	return source.slice(openIdx, closeIdx).includes(needle);
}

test('4. positive control: the nesting matcher fires on a planted fixture that puts a real voice key inside the toggle span', () => {
	for (const key of STANDING_VOICE_KEYS) {
		const planted = `<DetailsToggle summary="x"><p>{t('${key}')}</p></DetailsToggle>`;
		assert.ok(nestedInToggle(planted, key), `the matcher is inert against a planted nesting of ${key}`);
	}
	assert.ok(!nestedInToggle("<DetailsToggle summary=\"x\">{t('public.details.body')}</DetailsToggle>", STANDING_VOICE_KEYS[0]), 'the matcher fires on a toggle that holds none of the voice keys');
});

test('4a. D-32: no standing-voice key occurs inside the toggle span in the real shell — none of them can be collapsed out of view', () => {
	for (const key of STANDING_VOICE_KEYS) {
		assert.equal(nestedInToggle(SHELL, key), false, `${key} is mounted inside <DetailsToggle> and can be hidden`);
	}
});

test('4b. the block carries no condition of its own: the shell still holds exactly one return, and the three keys sit on unconditional lines', () => {
	assert.equal((SHELL.match(/\breturn\b/g) ?? []).length, 1, 'the shell gained a second return — the voice can now be branched away');
	for (const key of STANDING_VOICE_KEYS) {
		const line = SHELL.split('\n').find((l) => l.includes(key));
		assert.ok(line, `no source line mounts ${key}`);
		assert.doesNotMatch(line, /[?]|&&|\|\|/, `${key} is mounted behind a conditional: ${line.trim()}`);
	}
});

// ---------------------------------------------------------------------------
// 5. Placement (D-32). Between the fact body and the advisory.
// ---------------------------------------------------------------------------

test('5. source order: the fact body precedes every standing-voice key, and every key precedes the advisory', () => {
	const bodyIdx = SHELL.indexOf('{body}');
	const advisoryIdx = SHELL.indexOf('<AdvisoryDisclosure');
	assert.ok(bodyIdx >= 0, 'the shell no longer mounts the fact body under that name');
	assert.ok(advisoryIdx >= 0, 'the shell no longer mounts the advisory');
	for (const key of STANDING_VOICE_KEYS) {
		const keyIdx = SHELL.indexOf(key);
		assert.ok(keyIdx > bodyIdx, `${key} is mounted before the fact body — a reader meets a caveat before any fact`);
		assert.ok(keyIdx < advisoryIdx, `${key} is mounted after the advisory — the page-level statements no longer read as one voice`);
	}
});

// ---------------------------------------------------------------------------
// 6. Claim scope (D-29). The page may not describe a reach this tree does not
//    have. See this file's header for why the control is built by
//    concatenation and why no token is named in prose anywhere below.
// ---------------------------------------------------------------------------

/**
 * @param {string} value
 * @returns {string[]} every forbidden token present in `value`.
 */
function overreachingTokensIn(value) {
	const lowered = value.toLowerCase();
	return OVERREACHING_CLAIM_TOKENS.filter((token) => lowered.includes(token));
}

test('6. positive control: the claim matcher fires on a fixture assembled from the frozen array itself, once per member, and is silent on a benign sentence', () => {
	assert.ok(OVERREACHING_CLAIM_TOKENS.length > 0, 'the vocabulary is empty — the rung below would pass vacuously');
	for (const token of OVERREACHING_CLAIM_TOKENS) {
		const planted = 'This page is ' + token + ' with the rest of the network.';
		assert.ok(overreachingTokensIn(planted).includes(token), `the matcher is inert against a planted use of a vocabulary member`);
	}
	assert.deepEqual(overreachingTokensIn('This page shows what this browser already holds.'), [], 'the matcher fires on a benign sentence');
});

test('6a. D-29: no value in the page voice claims a reach this tree does not have', () => {
	for (const key of VOICE_VALUE_KEYS) {
		const found = overreachingTokensIn(/** @type {string} */ (COPY[key]));
		assert.deepEqual(found, [], `${key} claims a reach the web tree cannot deliver, and the claim would be false today`);
	}
});

// ---------------------------------------------------------------------------
// 7. Copy-gate compatibility, restated locally.
// ---------------------------------------------------------------------------

test('7. positive control: all three copy-value matchers fire on planted fixtures', () => {
	assert.match('see D-29 for the reasoning', DECISION_ID_RE);
	assert.match('this landed in Phase 54', PHASE_NUMBER_RE);
	assert.match('the page is in ' + 'read' + '-only mode', RESTRICTED_MODE_RE);
	assert.doesNotMatch('a plain sentence about an election', DECISION_ID_RE);
	assert.doesNotMatch('a plain sentence about an election', PHASE_NUMBER_RE);
	assert.doesNotMatch('a plain sentence about an election', RESTRICTED_MODE_RE);
});

test('7a. no voice value carries a decision id, a phase number or the banned restricted-mode phrase', () => {
	for (const key of [...VOICE_VALUE_KEYS, 'public.details.body']) {
		const value = /** @type {string} */ (COPY[key]);
		assert.doesNotMatch(value, DECISION_ID_RE, `${key} names an internal decision id`);
		assert.doesNotMatch(value, PHASE_NUMBER_RE, `${key} names an internal phase number`);
		assert.doesNotMatch(value, RESTRICTED_MODE_RE, `${key} uses the phrase the copy table bans outright`);
	}
});

// ---------------------------------------------------------------------------
// 8. The classes are 54-09's, and static.
//
//    RESTATED AGAINST THE TREE. The plan asked for this block to render on the
//    fact-card classes. 54-09 declared two rules FOR THIS BLOCK — a flex column
//    with a top margin, and a muted Label-size line — and its own summary says
//    they carry "the two caveats and the freshness line". Rendering the voice
//    as fact cards would leave both purpose-built rules unrendered and would
//    style three page-level statements as if they were election facts. The
//    class names below are 54-09's, so the coverage gate still resolves every
//    one of them.
// ---------------------------------------------------------------------------

test('8. the standing-voice block renders exactly the two 54-09 classes declared for it, as static literals', () => {
	const block = SHELL.slice(SHELL.indexOf('{body}'), SHELL.indexOf('<AdvisoryDisclosure'));
	assert.match(block, /className="public-caveats"/, 'the voice block does not carry its own container class');
	assert.equal((block.match(/className="public-caveat"/g) ?? []).length, 3, 'expected exactly three caveat lines, each carrying the shipped line class');
	assert.doesNotMatch(block, /className=\s*\{/, 'the voice block computes a class attribute — the coverage gate cannot see it');
});
