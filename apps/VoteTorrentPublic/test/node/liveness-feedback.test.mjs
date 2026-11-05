/**
 * liveness-feedback.test.mjs — the tier-1 contract for Surface 5 (56-14,
 * D-16's UI feedback half / D-19's UI half): the widened connection
 * predicate, the `justUpdated` observation and its auto-clear timer, and the
 * live-update badge's own render guard.
 *
 * WHY THIS FILE CANNOT IMPORT `use-public-election.ts` OR CALL
 * `usePublicElection` DIRECTLY — the same two-part constraint
 * `offline-surfaces.test.mjs`'s own header states for `PublicApp.tsx`'s
 * hook, doubled here: (1) `node --test` cannot parse a `.ts` module without a
 * type-stripping flag this workspace's runner does not pass, and (2) even if
 * it could, `usePublicElection` is a React hook — calling it outside a
 * render cycle throws "Invalid hook call" regardless of the file extension.
 * This suite proves behaviour in THREE complementary ways instead of one
 * direct call:
 *
 *   (a) THE CONNECTION FORMULA IS EXTRACTED AND EXECUTED. The four-row
 *       conjunct table is pure boolean logic with no React dependency, so
 *       this file extracts the REAL ternary expression's source text out of
 *       comment-stripped `use-public-election.ts` (never re-typing the
 *       formula by hand) and evaluates it with `new Function` against all
 *       four named input combinations. This drives the real code, not a
 *       re-implementation of it — a change to the formula that keeps the
 *       same four outputs on the same four inputs would go undetected by a
 *       pure source-text match, but a change that alters any of the four
 *       outputs fails here.
 *   (b) THE NOTICE-DISCRIMINATION AND TIMER SHAPES ARE SOURCE-SCANNED,
 *       comment-stripped, each matcher proven against a planted violation
 *       before it runs against real source — same discipline
 *       `election-shell.test.mjs` uses throughout.
 *   (c) THE BADGE'S OWN GUARD IS SOURCE-SCANNED IN `ElectionShell.tsx`,
 *       pinning the `!== 'down'` decision so a later "tidy" to `=== 'live'`
 *       is a red test with a reason attached.
 *
 * Task 3's browser gate (`run-liveness-gate.mjs`) is what actually drives
 * the hook end to end on a real page — this file is its Node-tier
 * counterpart, proving the same claims where they CAN be proven without a
 * browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publicSrc } from '../../../../scripts/lib/source-paths.mjs';
import { COPY } from '../../../../packages/ui-web/src/index.js';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';

const HOOK_PATH = publicSrc('screens', 'use-public-election.ts');
const HOOK_RAW = readFileSync(HOOK_PATH, 'utf8');
const HOOK_SOURCE = stripComments(HOOK_RAW);

const SHELL_PATH = publicSrc('screens', 'ElectionShell.tsx');
const SHELL_RAW = readFileSync(SHELL_PATH, 'utf8');
const SHELL_SOURCE = stripComments(SHELL_RAW);

const APP_CSS_SOURCE = stripComments(readFileSync(publicSrc('app.css'), 'utf8'));

// ---------------------------------------------------------------------------
// (a) Behaviour of the conjunct — the four-row connection table, extracted
//     from the real source and EXECUTED against all four named inputs.
// ---------------------------------------------------------------------------

/**
 * Pull the real `connection = ...;` ternary expression's text out of
 * comment-stripped `use-public-election.ts`. Throws (never returns a
 * fallback) when the shape is not found, so a rewrite that changes this
 * expression's syntax fails LOUDLY here rather than silently exercising a
 * stale, hand-copied formula.
 * @param {string} source
 * @returns {string}
 */
function extractConnectionExpression(source) {
	const match = source.match(/connection\s*=\s*([^;]+);/);
	if (!match) throw new Error('extractConnectionExpression: no `connection = ...;` assignment found in use-public-election.ts');
	return match[1].trim();
}

/**
 * Evaluate the REAL extracted expression against synthetic inputs — genuine
 * execution of production source text, not a re-implementation of its
 * logic. `subscription` and `peerFeed` are the only two free identifiers the
 * real expression names.
 * @param {string} expression
 * @param {boolean} subscriptionLive
 * @param {'unobserved' | 'running' | 'stopped'} peerFeed
 * @returns {'unknown' | 'live' | 'down'}
 */
function evalConnectionExpression(expression, subscriptionLive, peerFeed) {
	// eslint-disable-next-line no-new-func -- deliberate: this is the whole point of this rung.
	const fn = new Function('subscription', 'peerFeed', `return (${expression});`);
	return fn({ live: subscriptionLive }, peerFeed);
}

const CONNECTION_EXPRESSION = extractConnectionExpression(HOOK_SOURCE);

test('sanity: the real connection expression was extracted and is non-empty, and names both free identifiers a caller must bind', () => {
	assert.ok(CONNECTION_EXPRESSION.length > 0, 'the extractor returned an empty string');
	assert.match(CONNECTION_EXPRESSION, /subscription\.live/, 'the extracted expression does not name the change-channel conjunct');
	assert.match(CONNECTION_EXPRESSION, /peerFeed/, 'the extracted expression does not name the peer-feed conjunct');
});

test('positive control: the extractor throws on a fixture with no connection assignment, and succeeds on a planted one', () => {
	assert.throws(() => extractConnectionExpression('const x = 1;'));
	const planted = "connection = subscription.live ? 'live' : 'down';";
	assert.doesNotThrow(() => extractConnectionExpression(planted));
	assert.equal(extractConnectionExpression(planted), "subscription.live ? 'live' : 'down'");
});

test('56-14 D-16/D-17: the four-row connection table, each row named and EXECUTED against the real extracted formula', () => {
	// | change channel | peerFeed     | connection |
	// | absent         | any          | 'down'     |
	assert.equal(evalConnectionExpression(CONNECTION_EXPRESSION, false, 'unobserved'), 'down', 'channel absent + unobserved must resolve to down');
	assert.equal(evalConnectionExpression(CONNECTION_EXPRESSION, false, 'running'), 'down', 'channel absent must resolve to down regardless of peerFeed (including running)');
	assert.equal(evalConnectionExpression(CONNECTION_EXPRESSION, false, 'stopped'), 'down', 'channel absent must resolve to down regardless of peerFeed (including stopped)');
	// | present        | 'running'    | 'live'     |
	assert.equal(evalConnectionExpression(CONNECTION_EXPRESSION, true, 'running'), 'live', 'channel present + running must resolve to live');
	// | present        | 'stopped'    | 'down'     |  -- new in this plan
	assert.equal(evalConnectionExpression(CONNECTION_EXPRESSION, true, 'stopped'), 'down', "channel present + stopped must resolve to down -- new in this plan, and the row that keeps Surface 1's staleness banner honest for a boot that could not start");
	// | present        | 'unobserved' | 'unknown'  |
	assert.equal(evalConnectionExpression(CONNECTION_EXPRESSION, true, 'unobserved'), 'unknown', "channel present + unobserved must resolve to unknown -- the row that keeps test:live-read green");
});

test("the literal 'down' is produced at exactly one assignment site in use-public-election.ts (comment-stripped), and that one site names both conjuncts", () => {
	// Scoped to assignments to the `connection` BINDING specifically — the
	// `PublicConnectionState` type alias also spells the literal 'down' (as
	// a member of its union), and that is a TYPE declaration, never a
	// produced VALUE; a bare `=\s*[^;]*'down'` scan would double-count it.
	const downAssignments = [...HOOK_SOURCE.matchAll(/\bconnection\s*=\s*[^;]*'down'[^;]*;/g)];
	assert.equal(downAssignments.length, 1, `expected exactly one connection-assignment expression containing 'down', found ${downAssignments.length}`);
	assert.match(downAssignments[0][0], /subscription\.live/, "the one 'down'-producing assignment does not name the change-channel conjunct");
	assert.match(downAssignments[0][0], /peerFeed/, "the one 'down'-producing assignment does not name the peer-feed conjunct");
});

// ---------------------------------------------------------------------------
// (b) Behaviour of the observation — the notice discrimination.
// ---------------------------------------------------------------------------

const NOTICE_DISCRIMINATION_RE = /setDataVersion\(\s*\(n\)\s*=>\s*n\s*\+\s*1\s*\);\s*if\s*\(\s*notice\?\.remote\s*===\s*true\s*\)\s*setUpdateTick\(\s*\(n\)\s*=>\s*n\s*\+\s*1\s*\);/;

test('positive control: the notice-discrimination matcher fires on the real declaration shape and goes silent on a fixture that bumps both counters unconditionally', () => {
	const real = 'setDataVersion((n) => n + 1);\n\t\tif (notice?.remote === true) setUpdateTick((n) => n + 1);';
	assert.match(real, NOTICE_DISCRIMINATION_RE);
	const contaminated = 'setDataVersion((n) => n + 1);\n\t\tsetUpdateTick((n) => n + 1);';
	assert.doesNotMatch(contaminated, NOTICE_DISCRIMINATION_RE, 'the matcher cannot tell an unconditional bump from a discriminated one');
});

test('56-14 D-16: bumpDataVersion increments dataVersion unconditionally and increments a SEPARATE counter only when notice.remote is strictly true', () => {
	assert.match(HOOK_SOURCE, NOTICE_DISCRIMINATION_RE, 'bumpDataVersion does not discriminate on notice.remote the way this plan requires');
});

test('56-14 <interface_contract> §2: bumpDataVersion reads only `remote` off the notice — zero occurrences of notice.table or notice.type', () => {
	assert.doesNotMatch(HOOK_SOURCE, /notice\??\.table/, 'the hook reads notice.table — no table-to-fact reverse map exists, and none may be built here');
	assert.doesNotMatch(HOOK_SOURCE, /notice\??\.type/, 'the hook reads notice.type — granularity must stay at the table+op level this file never re-derives further');
});

// ---------------------------------------------------------------------------
// (c) Behaviour of the timer.
// ---------------------------------------------------------------------------

const TIMER_EFFECT_RE =
	/if\s*\(\s*updateTick\s*===\s*0\s*\)\s*return\s+undefined;\s*setJustUpdated\(true\);\s*const\s+timer\s*=\s*setTimeout\(\s*\(\)\s*=>\s*setJustUpdated\(false\),\s*LIVE_UPDATE_BADGE_MS\s*\);\s*return\s*\(\)\s*=>\s*clearTimeout\(timer\);/;

test('positive control: the timer-effect matcher fires on the real declaration shape and goes silent on a fixture using a numeric literal instead of the named constant', () => {
	const real =
		'if (updateTick === 0) return undefined;\n\t\tsetJustUpdated(true);\n\t\tconst timer = setTimeout(() => setJustUpdated(false), LIVE_UPDATE_BADGE_MS);\n\t\treturn () => clearTimeout(timer);';
	assert.match(real, TIMER_EFFECT_RE);
	const contaminated = real.replace('LIVE_UPDATE_BADGE_MS', '4000');
	assert.doesNotMatch(contaminated, TIMER_EFFECT_RE, 'the matcher cannot tell a transcribed numeric literal from the named constant');
});

test('56-14 D-19: the timer effect schedules nothing on tick zero, sets justUpdated, schedules exactly one setTimeout keyed on LIVE_UPDATE_BADGE_MS (never a numeric literal), and clears it in its cleanup', () => {
	assert.match(HOOK_SOURCE, TIMER_EFFECT_RE, 'the timer effect does not match the shape this plan requires');
});

test('use-public-election.ts contains exactly two useEffect occurrences (the attach effect and the timer effect) and exactly one setTimeout call, comment-stripped', () => {
	assert.equal((HOOK_SOURCE.match(/\buseEffect\(/g) ?? []).length, 2, 'expected exactly two useEffect calls');
	assert.equal((HOOK_SOURCE.match(/\bsetTimeout\(/g) ?? []).length, 1, 'expected exactly one setTimeout call');
});

test('use-public-election.ts exports PublicPeerFeedState as exactly the three named values, and LIVE_UPDATE_BADGE_MS with the value 4000', () => {
	assert.match(HOOK_SOURCE, /export type PublicPeerFeedState = 'unobserved' \| 'running' \| 'stopped';/);
	assert.match(HOOK_SOURCE, /export const LIVE_UPDATE_BADGE_MS = 4000;/);
});

// ---------------------------------------------------------------------------
// (c continued) The badge's own guard, from source — ElectionShell.tsx.
// ---------------------------------------------------------------------------

test("56-14: showLiveUpdate names the ready state, justUpdated and the connection, and does NOT name 'live' -- pinning the !== 'down' decision", () => {
	const line = SHELL_SOURCE.split('\n').find((l) => l.includes('showLiveUpdate ='));
	assert.ok(line, 'no source line declares showLiveUpdate in ElectionShell.tsx');
	assert.match(line, /read\.state === 'ready'/, 'showLiveUpdate does not name the ready state');
	assert.match(line, /read\.justUpdated/, 'showLiveUpdate does not name justUpdated');
	assert.match(line, /read\.connection !== 'down'/, "showLiveUpdate does not use the !== 'down' guard this plan's <decision_on_the_open_limit> requires");
	assert.doesNotMatch(line, /'live'/, "showLiveUpdate names the 'live' literal -- a later \"tidy\" to === 'live' would reintroduce the false-negative on 'unknown' this plan's decision explicitly rejects");
});

// ---------------------------------------------------------------------------
// Ordering — the badge is the trailing chip, after the headline; the
// pre-existing 56-12 ordering survives unchanged.
// ---------------------------------------------------------------------------

test('56-14: in comment-stripped ElectionShell.tsx, the live-update-badge class literal appears after status-banner__headline and inside the same status-banner block', () => {
	const headlineIdx = SHELL_SOURCE.indexOf('status-banner__headline');
	const badgeIdx = SHELL_SOURCE.indexOf('live-update-badge');
	assert.ok(headlineIdx !== -1, 'status-banner__headline is not present in ElectionShell.tsx');
	assert.ok(badgeIdx !== -1, 'live-update-badge is not present in ElectionShell.tsx');
	assert.ok(badgeIdx > headlineIdx, 'the live-update-badge literal does not appear after status-banner__headline');

	// "Inside the same block" — no intervening close of the status-banner div
	// between the headline and the badge.
	const between = SHELL_SOURCE.slice(headlineIdx, badgeIdx);
	assert.doesNotMatch(between, /<\/div>/, 'a </div> sits between status-banner__headline and live-update-badge -- the badge is not inside the same status-banner block');
});

test('56-12/56-14 ordering survives: staleness-banner precedes election-address, which precedes status-banner', () => {
	// Anchored on the rendered `className="..."` literal, never the bare
	// substring — `election-address` also occurs earlier, in the
	// `../election-address.js` IMPORT PATH, which would otherwise false-win
	// the ordering check.
	const stalenessIdx = SHELL_SOURCE.indexOf('className="staleness-banner"');
	const addressIdx = SHELL_SOURCE.indexOf('className="election-address"');
	const statusIdx = SHELL_SOURCE.indexOf('className={`status-banner');
	assert.ok(stalenessIdx !== -1 && addressIdx !== -1 && statusIdx !== -1, 'one of the three ordering anchors is missing from ElectionShell.tsx');
	assert.ok(stalenessIdx < addressIdx, 'staleness-banner no longer precedes election-address');
	assert.ok(addressIdx < statusIdx, 'election-address no longer precedes status-banner');
});

// ---------------------------------------------------------------------------
// No per-fact reach.
// ---------------------------------------------------------------------------

test('56-14 <interface_contract> §2: neither ElectionShell.tsx nor use-public-election.ts imports from facts.js, and neither renders a notice table or type', () => {
	assert.doesNotMatch(SHELL_SOURCE, /from ['"].*facts\.js['"]/, 'ElectionShell.tsx imports from facts.js -- no table-to-fact reverse map may be built for this badge');
	assert.doesNotMatch(HOOK_SOURCE, /from ['"].*facts\.js['"]/, 'use-public-election.ts imports from facts.js -- no table-to-fact reverse map may be built for this badge');
});

// ---------------------------------------------------------------------------
// Copy.
// ---------------------------------------------------------------------------

const BANNED_LEXEMES = Object.freeze(['officer', 'permission', 'scope', 'login', 'account', 'dashboard', 'snapshot', 'simulated']);
const DECISION_ID_RE = /\bD-\d{2}\b/;
const PHASE_NUMBER_RE = /\bPhase\s+\d+\b/;

test('positive control: the copy-hygiene matchers fire on planted violations', () => {
	assert.match('see D-16 for the reasoning', DECISION_ID_RE);
	assert.match('this landed in Phase 56', PHASE_NUMBER_RE);
	for (const lexeme of BANNED_LEXEMES) {
		assert.ok(`this contains the word ${lexeme} in it`.toLowerCase().includes(lexeme), `fixture sanity: planted lexeme "${lexeme}" must appear`);
	}
});

test("public.liveUpdate.badge is declared, contains no placeholder, no banned lexeme, no decision id and no phase number, and equals the UI-SPEC's exact word", () => {
	const value = COPY['public.liveUpdate.badge'];
	assert.equal(typeof value, 'string', 'public.liveUpdate.badge is not declared in COPY');
	assert.equal(value, 'UPDATED');
	assert.doesNotMatch(value, /\{\{/, 'the badge word carries an interpolation placeholder — the UI-SPEC specifies a bare word');
	assert.doesNotMatch(value, DECISION_ID_RE);
	assert.doesNotMatch(value, PHASE_NUMBER_RE);
	const lowered = value.toLowerCase();
	for (const lexeme of BANNED_LEXEMES) {
		assert.ok(!lowered.includes(lexeme), `public.liveUpdate.badge contains the banned lexeme "${lexeme}"`);
	}
});

// ---------------------------------------------------------------------------
// Tokens.
// ---------------------------------------------------------------------------

test('the .live-update-badge rule contains no hex literal and no rgba( literal', () => {
	const ruleMatch = APP_CSS_SOURCE.match(/\.live-update-badge\s*\{[^}]*\}/);
	assert.ok(ruleMatch, '.live-update-badge rule not found in app.css');
	assert.doesNotMatch(ruleMatch[0], /#[0-9a-fA-F]{3,8}\b/, '.live-update-badge contains a hex colour literal');
	assert.doesNotMatch(ruleMatch[0], /rgba\(/, '.live-update-badge contains an rgba( literal');
});
