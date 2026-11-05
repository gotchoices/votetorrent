/**
 * public-voice.test.mjs — the D-07/D-08 lints over every public-voice `COPY`
 * value (53-07). Travels with the table (D-25), not with any one consumer:
 * this file reads only `COPY` from `../src/index.js` and does no
 * source-tree read of its own.
 *
 * Two lints, each proven live BEFORE it is trusted against the real table:
 *
 * 1. Banned lexemes -- no public-voice value may claim officer/permission/
 *    scope/login/account/dashboard/snapshot/simulation words, because this
 *    app has none of those concepts.
 * 2. No authority derivation -- no public-voice value may share a
 *    contiguous 6-word run with the authority-voiced corpus
 *    (`advisory.authority.*`, `gate.*`, `bootstrap.*`). This is the
 *    mechanical proxy for "authored fresh, never found-and-replaced" --
 *    spike 091's defect was exactly a shared component rendering the
 *    authority's own sentence, verbatim, on the public page.
 *
 * Neither lint interpolates a value under test into its own name, and
 * neither is an always-true disjunct -- both traps this repo has already
 * hit once, one of which shipped on a completely dead page.
 *
 * 54-09 amended this file's imports. It previously read `COPY` and nothing
 * else; it now also imports one SIBLING MODULE IN THE SAME PACKAGE,
 * `../src/lifecycle/facts.js`, for its `FACT_COPY_KEYS` export. That is not
 * the consumer coupling the note above rules out -- the rule is that this
 * file must not reach into an app workspace's own use of the table, and
 * `facts.js` is part of the same package as `copy.js`. The reason for the
 * import is concrete: 54-09 takes the public-voice key set from ten names to
 * seventy-one, and fifty of those are exactly the members of
 * `FACT_COPY_KEYS`. Transcribing fifty names here would create a second list
 * that drifts from the first -- which is the failure `FACT_COPY_KEYS` was
 * derived (rather than hand-written) to prevent. Deriving the set also means
 * both lints below now run over all seventy-one values automatically, with
 * no further edit, which is the point.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { COPY } from '../src/index.js';
import { FACT_COPY_KEYS } from '../src/lifecycle/facts.js';

// ---------------------------------------------------------------------------
// Key-set definitions.
// ---------------------------------------------------------------------------

/** Every COPY key this file treats as "public voice" (D-08). @type {RegExp} */
const PUBLIC_VOICE_KEY_RE = /^(public\.|advisory\.public\.)/;

/** Every COPY key this file treats as "authority voice" (the corpus a
 * public-voice value must never derive from). @type {RegExp} */
const AUTHORITY_KEY_RE = /^(advisory\.authority\.|gate\.|bootstrap\.)/;

const publicVoiceEntries = Object.entries(COPY).filter(([key]) => PUBLIC_VOICE_KEY_RE.test(key));
const authorityEntries = Object.entries(COPY).filter(([key]) => AUTHORITY_KEY_RE.test(key));

test('sanity: both the public-voice and authority-voice key sets are non-empty (an empty set would make every scan below vacuously pass)', () => {
	assert.ok(publicVoiceEntries.length > 0, 'expected at least one public.*/advisory.public.* key');
	assert.ok(authorityEntries.length > 0, 'expected at least one advisory.authority.*/gate.*/bootstrap.* key');
});

/**
 * The ten keys 53-07 added. Still hand-listed, because nothing derives them
 * and ten names is not a drift surface.
 * @type {ReadonlyArray<string>}
 */
const KEYS_53_07 = Object.freeze([
	'advisory.public.body',
	'public.chrome.appName',
	'public.details.body',
	'public.details.summary',
	'public.election.addressLabel',
	'public.election.slot.lifecycle',
	'public.election.slot.timeline',
	'public.election.slot.title',
	'public.election.unreadableAddress.body',
	'public.election.unreadableAddress.title',
]);

/**
 * The eleven keys 54-09 added that sit OUTSIDE the fact model -- the
 * freshness line, the two standing caveats, the fail-closed disclosure-policy
 * note, the four index strings, the two details-toggle summary labels and the
 * key-release fail-closed line. The other fifty come from `FACT_COPY_KEYS`.
 * @type {ReadonlyArray<string>}
 */
const KEYS_54_09_NON_FACT = Object.freeze([
	'public.freshness.body',
	'public.fact.keyrelease.unreadable',
	'public.caveat.timelineUnvalidated',
	'public.caveat.readOnly',
	'public.rules.policyUnreadable',
	'public.index.viewElectionCta',
	'public.index.emptyHeading',
	'public.index.emptyBody',
	'public.index.someUnreadable',
	'public.gap.detailsSummary',
	'public.fact.detailsSummary',
]);

/**
 * The two keys 54-12 added: D-02's addressed-but-not-held sentence, mounted
 * in the same change by `apps/VoteTorrentPublic/src/screens/ElectionShell.tsx`
 * (so neither is ever a pending-mount entry). Listed here rather than folded
 * into the 54-09 array above because the provenance of a key is the thing a
 * later reader most often needs and least often has.
 * @type {ReadonlyArray<string>}
 */
const KEYS_54_12 = Object.freeze(['public.election.notHeld.title', 'public.election.notHeld.body']);

/**
 * The six keys 56-12 added: Surface 1's staleness badge/body (D-17) and
 * Surface 3's two-variant config-fault title/body pairs (D-13). Listed here
 * on the same precedent `KEYS_54_12` above follows -- provenance is the
 * thing a later reader most often needs and least often has.
 * @type {ReadonlyArray<string>}
 */
const KEYS_56_12 = Object.freeze([
	'public.staleness.badge',
	'public.staleness.body',
	'public.config.missing.title',
	'public.config.missing.body',
	'public.config.malformed.title',
	'public.config.malformed.body',
]);

/**
 * The one key 56-14 added: Surface 5's live-update badge word (D-16/D-19).
 * Listed here on the same precedent `KEYS_54_12`/`KEYS_56_12` above follow.
 * @type {ReadonlyArray<string>}
 */
const KEYS_56_14 = Object.freeze(['public.liveUpdate.badge']);

/**
 * The three `public.*` keys 60-01 added, out of its twenty-two total (the
 * other nineteen are `panelFrame.*`/`panels.*`, which sit outside this
 * file's public-voice scope): the keyholder-release meter's empty frame
 * (named by the 60-06 call site), and the roll composition chart's hover
 * tooltip and "Other" fold label (D-09). Listed here on the same precedent
 * `KEYS_54_12`/`KEYS_56_12`/`KEYS_56_14` above follow.
 * @type {ReadonlyArray<string>}
 */
const KEYS_60_01 = Object.freeze([
	'public.fact.keyrelease.meterEmpty',
	'public.registrantRoll.chart.tooltip',
	'public.registrantRoll.chart.otherBucket',
]);

test('the public-voice key set is exactly the ten keys 53-07 added, plus facts.js FACT_COPY_KEYS, plus the eleven non-fact keys 54-09 added, plus the two 54-12 added, plus the six 56-12 added, plus the one 56-14 added, plus the three 60-01 added -- derived from the fact model, not transcribed', () => {
	const keys = publicVoiceEntries.map(([key]) => key).sort();
	const expected = [
		...new Set([...KEYS_53_07, ...FACT_COPY_KEYS, ...KEYS_54_09_NON_FACT, ...KEYS_54_12, ...KEYS_56_12, ...KEYS_56_14, ...KEYS_60_01]),
	].sort();
	assert.deepEqual(keys, expected);
});

// MEASURED, not adopted: 71, not the 67 54-09's plan predicted. The plan's
// own arithmetic is 10 (53-07) + 61 (54-09) = 71; "67" appears several
// times in that plan and is a slip, not a different set. Nothing downstream
// depends on the number -- the deep-equal above is the real assertion and
// it names every key -- but the count is pinned here anyway, because the
// deep-equal alone would still pass if BOTH sides lost the same fifty keys.
test('sanity: the derived expectation above is 83 keys and FACT_COPY_KEYS contributes 50 of them (if FACT_COPY_KEYS ever came back empty, the deep-equal above would still pass on a table that had lost fifty values)', () => {
	assert.equal(FACT_COPY_KEYS.length, 50);
	assert.equal(KEYS_53_07.length, 10);
	assert.equal(KEYS_54_09_NON_FACT.length, 11);
	assert.equal(KEYS_54_12.length, 2);
	assert.equal(KEYS_56_12.length, 6);
	assert.equal(KEYS_56_14.length, 1);
	assert.equal(KEYS_60_01.length, 3);
	assert.equal(
		new Set([...KEYS_53_07, ...FACT_COPY_KEYS, ...KEYS_54_09_NON_FACT, ...KEYS_54_12, ...KEYS_56_12, ...KEYS_56_14, ...KEYS_60_01]).size,
		83,
	);
	assert.equal(publicVoiceEntries.length, 83);
});

// ---------------------------------------------------------------------------
// Lint 1 — banned lexemes.
// ---------------------------------------------------------------------------

/** @type {ReadonlyArray<string>} */
const BANNED_LEXEMES = Object.freeze([
	'officer',
	'permission',
	'scope',
	'sign in',
	'sign-in',
	'signed in',
	'log in',
	'login',
	'account',
	'dashboard',
	'snapshot',
	'simulated',
]);

/** @param {string} value @returns {string | null} */
function findBannedLexeme(value) {
	const lower = value.toLowerCase();
	for (const lexeme of BANNED_LEXEMES) {
		if (lower.includes(lexeme)) return lexeme;
	}
	return null;
}

test('positive control: the banned-lexeme matcher fires on the literal spike-091 defect sentence', () => {
	const fixture = "What's shown here follows the officer's permissions";
	const hit = findBannedLexeme(fixture);
	assert.ok(hit, 'matcher is inert -- cannot detect the exact spike-091 defect it exists to catch');
});

test('benign control: an ordinary public-voice-shaped sentence does not trip the banned-lexeme matcher (a matcher that fires on everything discriminates nothing)', () => {
	const benign = 'Anyone can open this page and see the same election record, published exactly as it stands.';
	assert.equal(findBannedLexeme(benign), null);
});

test('no public-voice COPY value contains a banned lexeme', () => {
	const offenders = [];
	for (const [key, value] of publicVoiceEntries) {
		const hit = findBannedLexeme(value);
		if (hit) offenders.push(`${key}: contains "${hit}"`);
	}
	assert.deepEqual(offenders, [], `banned-lexeme lint failed:\n${offenders.join('\n')}`);
});

// ---------------------------------------------------------------------------
// Lint 2 — no authority derivation (shared 6-word run).
// ---------------------------------------------------------------------------

/** @param {string} value @returns {string[]} */
function toWords(value) {
	return value
		.toLowerCase()
		.replace(/[’']/g, '')
		.replace(/[^a-z0-9\s]+/g, ' ')
		.split(/\s+/)
		.filter((w) => w.length > 0);
}

/** @param {string[]} wordList @returns {Set<string>} */
function sixWordRuns(wordList) {
	const runs = new Set();
	for (let i = 0; i + 6 <= wordList.length; i += 1) {
		runs.add(wordList.slice(i, i + 6).join(' '));
	}
	return runs;
}

const authorityRuns = new Set();
for (const [, value] of authorityEntries) {
	for (const run of sixWordRuns(toWords(value))) authorityRuns.add(run);
}

test('positive control: substituting the REAL advisory.authority.body value in place of a public-voice value trips the 6-word-run matcher', () => {
	const authorityValue = COPY['advisory.authority.body'];
	assert.ok(typeof authorityValue === 'string' && authorityValue.length > 0, 'sanity: advisory.authority.body must exist and be non-empty');
	const runsOfAuthorityValue = sixWordRuns(toWords(authorityValue));
	const hit = [...runsOfAuthorityValue].some((run) => authorityRuns.has(run));
	assert.ok(
		hit,
		'matcher is inert -- rendering the real authority.body value AS IF it were a public-voice value must be detectable, ' +
			'because that is exactly the spike-091 defect this lint exists to catch',
	);
});

test('no public-voice COPY value shares a contiguous 6-word run with the authority-voiced corpus (advisory.authority.*, gate.*, bootstrap.*)', () => {
	const offenders = [];
	for (const [key, value] of publicVoiceEntries) {
		const runs = sixWordRuns(toWords(value));
		for (const run of runs) {
			if (authorityRuns.has(run)) {
				offenders.push(`${key}: shares run "${run}" with the authority-voiced corpus`);
				break;
			}
		}
	}
	assert.deepEqual(offenders, [], `no-authority-derivation lint failed:\n${offenders.join('\n')}`);
});
