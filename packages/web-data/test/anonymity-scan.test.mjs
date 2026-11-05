/**
 * anonymity-scan.test.mjs — D-05's gate: no table an anonymous reader may not
 * see is referenced, as CODE, anywhere in the public entry's WHOLE import
 * closure.
 *
 * WHAT IT ROOTS OVER, AND WHY EACH ROOT IS WHAT IT IS
 * ---------------------------------------------------------------------------
 * Scanned:
 *   - `apps/VoteTorrentPublic/src` — the no-login app's whole source tree.
 *   - `packages/web-data/src` — the WHOLE package, not just `src/public`. This
 *     widened (54-20 / I-56) after the verifier found `open-db.js`,
 *     `reattach.js` and `networks-registry.js` sitting one directory ABOVE
 *     `src/public/` while still being loaded by the public entry: a forbidden
 *     table added to any of the three was invisible to this gate. A whole-tree
 *     root with explicit exclusions is what keeps the NEXT top-level module in
 *     scope by default — a hand-listed set of "the three files we found" would
 *     put the next one back outside the gate with nobody noticing. Control 6c
 *     below plants a forbidden-table statement into a temp copy of
 *     `reattach.js` and requires it be reported, so this widening's green is
 *     attributable to the connection layer being clean rather than to it
 *     still being unread.
 *
 * Deliberately OUTSIDE the root, each an exclusion rather than an oversight:
 *
 *   - `packages/web-data/src/classification.js`. It IS the table list; it holds
 *     every forbidden name as an object key. Widening the root over it would
 *     make this checker permanently green — the self-tripping-checker failure
 *     mode this repo has now recorded six times. Control 6 below copies that
 *     file into a temp scan root and asserts the scan DOES report it, so the
 *     real run's green is attributable to the root choice and not to a blind
 *     matcher. Do not widen the root; the control exists to make that
 *     conversation happen against evidence.
 *
 *   - `packages/web-data/src/officer/**`. The officer surface is SUPPOSED to
 *     read officer-only tables. What keeps it off an anonymous page is D-04's
 *     subpath split, asserted in `audience-boundary.test.mjs`, not this scan.
 *     Control 6b below proves this exclusion is load-bearing the same way
 *     control 6 does for `classification.js`: copy `officer/registrations.js`
 *     (the officer module that references forbidden-class tables as code —
 *     `officer/read-keyholders.js` was rejected as the fixture because its
 *     officer-only-ness is a JOIN PATTERN over two public-safe tables and it
 *     names no forbidden table at all, which would make this control pass
 *     vacuously) into a clean temp root and assert the scan DOES report it.
 *
 *   - `apps/VoteTorrentPublic/test/**`. Fixtures legitimately seed rows and
 *     never ship. The tables 54-16 will seed are public-safe after D-18/D-15,
 *     so this exclusion is not load-bearing today; it is recorded so that if a
 *     fixture ever needs a forbidden table, extending the exclusion is a known
 *     decision rather than a discovery.
 *
 * Both `packages/web-data` exclusions are entries in `SCAN_EXCLUSIONS`, applied
 * via `scannedFilesFor`/`scanForNames` (`./lib/source-scan.mjs`). An exclusion
 * entry that stops matching anything (a rename, a move) throws
 * `StaleExclusionError` rather than silently rotting into a permanent hole —
 * see the stale-exclusion and separator-boundary cases below control 6c.
 *
 * WHAT THIS GATE CANNOT PROVE (carried here from 54-VALIDATION so the limit
 * lives with the code):
 *   - It proves no forbidden table is REFERENCED in the public entry's file
 *     set. It does not prove the rendered page is anonymous.
 *   - A leak through a module reached at runtime by a COMPUTED dynamic
 *     specifier is invisible to it. (`audience-boundary.test.mjs` treats a
 *     computed specifier as a failure to analyse for exactly this reason.)
 *   - A leak through data already in memory — a value read by an allowed query
 *     and rendered — names no table anywhere and is out of reach.
 *   - Nothing about what the page DISPLAYS. That is 54-16's browser tier.
 * Two structural facts do more work than this scan does, and it is the
 * BACKSTOP, not the primary control: D-04's subpath split makes the officer
 * read layer unreachable by construction, and 54-06's import-time
 * `assertPublicSafe` / `assertNoIdentifyingColumns` make a widened public query
 * a load-time crash.
 *
 * RULE 1 OF THIS PLAN'S SCAN DESIGN, enforced by the self-trip guard at the
 * bottom: the forbidden name set is DERIVED at runtime from `CLASSIFICATION` ×
 * `FORBIDDEN_CLASSES`. The only hand-written table-name literals in this file
 * live between the two sentinel comments, and the guard asserts the rest of the
 * file — prose included — contains none of them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, copyFileSync, appendFileSync, mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { publicSrc, webDataSrc } from '../../../scripts/lib/source-paths.mjs';
import { CLASSIFICATION, FORBIDDEN_CLASSES, PUBLIC_SAFE_CLASSES } from '../src/classification.js';
import {
	StaleExclusionError,
	partitionByExtension,
	scanForNames,
	scannedFilesFor,
	scanSourceForNames,
	stripComments,
	walkSourceFiles,
} from './lib/source-scan.mjs';

/** Every table whose class an anonymous reader may not reach. DERIVED — never written down. */
const FORBIDDEN_NAMES = Object.freeze(
	Object.keys(CLASSIFICATION).filter((t) => FORBIDDEN_CLASSES.includes(CLASSIFICATION[t][0])),
);
/** Every table an anonymous reader may reach at all (PUBLIC whole-row, AGGREGATE counts-only). */
const PUBLIC_SAFE_NAMES = Object.freeze(
	Object.keys(CLASSIFICATION).filter((t) => PUBLIC_SAFE_CLASSES.includes(CLASSIFICATION[t][0])),
);

/**
 * The two sizes, pinned. RECLASSIFYING A TABLE MEANS CHANGING THESE NUMBERS
 * DELIBERATELY AND SAYING WHY IN THE COMMIT. Never nudge one to make a red gate
 * green: a shrinking forbidden count is a table becoming publishable, which is
 * the single most consequential edit anyone can make to this package.
 *
 * Cross-checked against this phase's decisions: against spike 087's shipped
 * classes, D-15 moves two tables out of NEVER into AGGREGATE and D-18 moves one
 * out of POLICY_GATED into PUBLIC, giving 28 forbidden and 33 public-safe of 61.
 * 54-06's landed `classification.js` produces exactly those numbers.
 *
 * 2026-10-01 (62-01 Task 2): +5 tables, deliberately classified. NEVER (+3): the three new
 * registration/association staging tables (sealed P2P-transport envelopes in transit; D-47
 * accepts the clear Digest as an equality/guessing-oracle exposure, not a publication decision —
 * table names intentionally NOT repeated here, see the self-trip guard below). AGGREGATE (+2):
 * the two new decision tables (decision throughput by status is public; individual rows name the
 * deciding officer and are not). 28 -> 31 forbidden, 33 -> 35 public-safe, 61 -> 66 total.
 *
 * 2026-10-01 (62-01 Task 3): +2 more tables, both PUBLIC_SAFE (forbidden stays 31). An
 * envelope-encryption-key table is AGGREGATE (mirrors UserKey: public keys are not secret, a full
 * listing is an identity graph). A per-authority intake-policy table is PUBLIC (mirrors
 * ElectionAttestationPolicy: a signed policy voters must read to act on, no person-level column).
 * 35 -> 37 public-safe, 66 -> 68 total.
 *
 * 2026-10-01 (62-02 Task 2): +4 keyholder DKG/key-loop tables, deliberately classified. NEVER
 * (+2): the two new DKG-transport tables (protocol plumbing — per-keyholder receiving keys,
 * encrypted share bundles, user ids; nothing a public reader needs — table names intentionally
 * NOT repeated here, see the self-trip guard below). PUBLIC_SAFE (+2): the published joint key
 * table (the whole point of publishing it is that voters encrypt to it) and the released-share
 * table (public by design once released, D-17 — anyone with k shares may reconstruct).
 * 31 -> 33 forbidden, 37 -> 39 public-safe, 68 -> 72 total.
 *
 * 2026-10-09 (vote-block schema): +2 vote-block tables, both AGGREGATE (counts only). Their
 * counts are turnout; their rows name registrants (the block's frozen voter list, and who voted
 * in which block), so no row is ever published. Forbidden stays 33, 39 -> 41 public-safe,
 * 72 -> 74 total.
 *
 * 2026-11-03: +2 tables, both NEVER (the strictest class, so nothing becomes publishable). One is
 * the officer-published tally row, which had landed unclassified and is now an interim NEVER until
 * the phase that shows results on the public page reclassifies it. The other is the officer-signed
 * revocation of one dashboard browser pairing (officer-only pairing machinery). Table names
 * intentionally NOT repeated here, see the self-trip guard below. 33 -> 35 forbidden, public-safe
 * stays 41, 74 -> 76 total.
 */
const EXPECTED_FORBIDDEN_COUNT = 35;
const EXPECTED_PUBLIC_SAFE_COUNT = 41;
const EXPECTED_TABLE_COUNT = 76;

/**
 * The size of the scanned file set, pinned the same way the table counts above
 * are: 18 files under the public app's `src` (its 19th file, `app.css`, is a
 * non-code extension) plus 8 files under `packages/web-data/src` after
 * `SCAN_EXCLUSIONS` removes `officer/` (5 files) and `classification.js` (1).
 * CHANGING THIS NUMBER MEANS A ROOT OR AN EXCLUSION CHANGED — DO IT
 * DELIBERATELY AND SAY WHY IN THE COMMIT. A shrinking count is a module
 * silently leaving the closure this gate reads; never nudge it to make a red
 * gate green.
 *
 * MOVED FROM 22 TO 26 in `56-09`, deliberately, for a named reason: four new
 * files landed under `apps/VoteTorrentPublic/src/peer/`, inside this scan's
 * public-app root, none of them a reclassification of an existing table —
 * `identity.js` and `edge-node.js` (`56-05`), `config.js` (`56-06`) and
 * `reactivity-bridge.js` (`56-09` itself). All four were verified to pass
 * the SUBSTANCE of this file's D-05 scan (test 16 below, over the widened
 * 26-file set) before this count was bumped — a passing count bump here is
 * never sufficient on its own; the content check must already be green.
 *
 * MOVED FROM 26 TO 28 after Wave 4, deliberately, same reason and same
 * evidence standard. TWO new files landed inside the public-app scan root,
 * neither a reclassification of an existing table:
 *   - `src/peer/strand-read.js` (`56-16`), a fifth connection-layer module;
 *   - `src/screens/PublicApp.tsx` (`56-12`), a new production composition.
 * The SUBSTANCE check (test 16 below, `D-05: zero forbidden-class table names
 * as code`) was already GREEN over the widened 28-file set at the moment this
 * count moved — control 6e was the sole failing assertion (140 tests, 139
 * pass). A passing count bump is never sufficient on its own; the content
 * check must already be green.
 *
 * The measured value was read back from the gate's own failure message rather
 * than derived by counting new modules by hand: an initial bump to 27 was
 * wrong because it reasoned only about `peer/` and missed `screens/`.
 *
 * NOTE FOR THE NEXT PLAN THAT ADDS A FILE UNDER `apps/VoteTorrentPublic/src/`:
 * this pin is structurally coupled to that WHOLE root, not just `peer/`, and no
 * single plan's isolated test run can see the drift — only a full
 * `@votetorrent/web-data` run does. Re-pin it in the SAME commit that adds the
 * file, verify the substance check first, and read the new number off this
 * gate's failure message instead of inferring it.
 *
 * 56-11 moved this 28 -> 29: it adds exactly one new file under the scanned
 * root, `apps/VoteTorrentPublic/src/peer/boot.js` (the production peer-layer
 * composition wired into `main.tsx`). Before re-pinning, test 16 ("D-05: zero
 * forbidden-class table names as code across the public entry source set")
 * was confirmed green over the widened 29-file set, per this file's own
 * discipline above.
 *
 * Phase 60 (2026-09-16) moves this 29 -> 31, deliberately, same reason and
 * same evidence standard: two files landed inside the public-app scan root
 * during Phase 56, after this pin was last set, neither a reclassification of
 * an existing table:
 *   - `apps/VoteTorrentPublic/src/peer/fret-routing-probe.js` (`56-20`,
 *     commit `1acaf6da`), a diagnostic FRET routing probe;
 *   - `apps/VoteTorrentPublic/src/peer/connection-lifecycle-probe.js`
 *     (`56-24`, commit `da4a5b61`), a bounded passive-tap/dial probe.
 * This is Phase 56 debt inherited into Phase 60, not something Phase 60's own
 * work added. Test 16 ("D-05: zero forbidden-class table names as code across
 * the public entry source set") was confirmed green over the widened 31-file
 * set before this count moved.
 *
 * 2026-11-03 moves this 31 -> 33, deliberately, same evidence standard. Two files landed inside
 * the public-app scan root after this pin was last set (the dashboard-reactivity work on the
 * public page, commit `a73b6f78`): `apps/VoteTorrentPublic/src/peer/collection-id.js` and
 * `apps/VoteTorrentPublic/src/peer/tail-reader.js`. This control was already red on the branch
 * point before the officer-dashboard schema work began, and that work adds no file under a scan
 * root. Test 16 ("D-05: zero forbidden-class table names as code across the public entry source
 * set") was confirmed green over the widened 33-file set before this count moved.
 */
const EXPECTED_SCANNED_FILE_COUNT = 33;

// The sentinel literals are ASSEMBLED, never written out, so each appears in
// this file exactly once — as the comment that delimits the region. A checker
// whose own source quotes the marker it searches for finds the wrong one.
const BEGIN_SENTINEL = ['BEGIN', 'CONTROL', 'FIXTURES'].join(' ');
const END_SENTINEL = ['END', 'CONTROL', 'FIXTURES'].join(' ');

/* ─────────────────────────────────────────────────────────────────────────────
 * BEGIN CONTROL FIXTURES
 * Every hand-written table-name literal in this file lives below, and nowhere
 * else. The self-trip guard removes this whole region before checking the rest.
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Four representative forbidden tables — one per forbidden class plus the two
 * shapes of NEVER — used ONLY to prove the derived set is real rather than
 * vacuously empty, and to give each matcher its own fixture.
 * @type {ReadonlyArray<readonly [string, string]>}
 */
const EXPECTED_FORBIDDEN_SAMPLE = Object.freeze([
	['POLICY_GATED', 'RegistrantSelective'],
	['NEVER (key material)', 'RegistrationBridgeKey'],
	['NEVER (task extension)', 'OnboardingTaskExtension'],
	['DRAFT (proposal)', 'ProposedElection'],
]);

/** One realistic SQL fixture per sampled name — the one-fixture-per-matcher discipline. */
const MATCHER_FIXTURES = Object.freeze([
	['RegistrantSelective', `const q = 'select SelectiveDetails from RegistrantSelective where RegistrantId = :id';`],
	['RegistrationBridgeKey', `const q = 'select Key from RegistrationBridgeKey where Id = :id';`],
	['OnboardingTaskExtension', `const q = 'select TaskId from Task T join OnboardingTaskExtension O on O.TaskId = T.Id';`],
	['ProposedElection', `const q = 'select Title from ProposedElection where Id = :id';`],
]);

/**
 * Text that MERELY RESEMBLES a forbidden name and must not fire. A matcher that
 * fires on everything is as useless as one that fires on nothing.
 */
const BENIGN_FIXTURES = Object.freeze([
	['lower-case object key', `const flags = { onboarding: 1, proposedElection: 2 };`],
	['css-ish class token', `<div className="onboarding-panel proposed-election" />`],
	['longer identifier with a forbidden name as a strict prefix', `const s = OnboardingWizardState.current;`],
	['hyphenated copy key', `t('public.onboarding-help.body');`],
]);

/** The single line used by the comment-vs-code control, in code position. */
const COMMENT_CONTROL_CODE_LINE = `const q = 'select Title from ProposedElection where Id = :id';`;
/** The name that control expects to be reported. */
const COMMENT_CONTROL_NAME = 'ProposedElection';
/** The name planted into a copy of the real tree by the file-level control. */
const PLANTED_NAME = 'ProposedBallot';

/* ─────────────────────────────────────────────────────────────────────────────
 * END CONTROL FIXTURES
 * ───────────────────────────────────────────────────────────────────────────── */

const THIS_FILE = fileURLToPath(import.meta.url);

/**
 * The whole public import closure: the no-login app's entire source tree, and
 * the WHOLE `packages/web-data/src` tree (not just `src/public`) minus
 * `SCAN_EXCLUSIONS`. See the file header for why the second root widened past
 * `src/public` in 54-20.
 */
const SCAN_ROOTS = Object.freeze([publicSrc(), webDataSrc()]);

/**
 * Exactly two exclusions, each proven load-bearing by its own control (6 for
 * `classification.js`, 6b for `officer/`) below. Adding a third entry here
 * without a matching inertness control is exactly the unverifiable state the
 * exclusion mechanism's own doc (`scannedFilesFor` in `./lib/source-scan.mjs`)
 * warns against.
 */
const SCAN_EXCLUSIONS = Object.freeze([webDataSrc('classification.js'), webDataSrc('officer')]);

// ───────────────────────────────────────────────────────────────────────────
// 0. The derived set is real. A derived set that goes empty makes every
//    assertion below pass vacuously, so this runs first.
// ───────────────────────────────────────────────────────────────────────────

test('derivation: the forbidden set is derived from CLASSIFICATION and is not vacuously empty', () => {
	assert.equal(
		Object.keys(CLASSIFICATION).length,
		EXPECTED_TABLE_COUNT,
		'the classification no longer holds the schema’s table count; reconcile against votetorrent.qsql (classification-drift.test.mjs) before touching this file',
	);
	assert.equal(
		FORBIDDEN_NAMES.length,
		EXPECTED_FORBIDDEN_COUNT,
		`the forbidden-class table count moved from ${EXPECTED_FORBIDDEN_COUNT} to ${FORBIDDEN_NAMES.length}. ` +
			'A table became publishable or unpublishable. Update this number DELIBERATELY and say why in the commit; ' +
			'never adjust it to make a red gate green.',
	);
	assert.equal(
		PUBLIC_SAFE_NAMES.length,
		EXPECTED_PUBLIC_SAFE_COUNT,
		`the public-safe table count moved from ${EXPECTED_PUBLIC_SAFE_COUNT} to ${PUBLIC_SAFE_NAMES.length}. ` +
			'Same rule: change the number deliberately, in a commit that explains the reclassification.',
	);
	assert.equal(FORBIDDEN_NAMES.length + PUBLIC_SAFE_NAMES.length, EXPECTED_TABLE_COUNT);
	for (const [label, name] of EXPECTED_FORBIDDEN_SAMPLE) {
		assert.ok(
			FORBIDDEN_NAMES.includes(name),
			`the derived forbidden set no longer contains the ${label} sample; the derivation is broken or the table was reclassified`,
		);
	}
});

// ───────────────────────────────────────────────────────────────────────────
// 1. Matcher control — one fixture per sampled name, run BEFORE the real scan.
// ───────────────────────────────────────────────────────────────────────────

test('control 1 (matcher): each sampled forbidden name is reported in a realistic SQL fixture', () => {
	for (const [name, fixture] of MATCHER_FIXTURES) {
		const hits = scanSourceForNames(fixture, FORBIDDEN_NAMES);
		assert.ok(
			hits.some((h) => h.name === name),
			`matcher is inert for "${name}" — its fixture was not reported. This gate cannot detect a real leak of that table.`,
		);
		assert.ok(
			hits.some((h) => h.name === name && h.sqlContext),
			`"${name}" was reported but not flagged as a SQL-context hit; the diagnostic enrichment is broken`,
		);
	}
});

// ───────────────────────────────────────────────────────────────────────────
// 2. Discrimination control — the matcher must not fire on lookalikes.
// ───────────────────────────────────────────────────────────────────────────

test('control 2 (discrimination): benign lookalike text is not reported', () => {
	for (const [label, fixture] of BENIGN_FIXTURES) {
		const hits = scanSourceForNames(fixture, FORBIDDEN_NAMES);
		assert.deepEqual(
			hits.map((h) => h.name),
			[],
			`matcher over-fires: the "${label}" fixture was reported. A matcher that fires on everything is as useless as one that fires on nothing.`,
		);
	}
});

// ───────────────────────────────────────────────────────────────────────────
// 3. Comment-vs-code control — D-05's core claim. The SAME text, twice.
//    This is what proves comment-stripping is a SUPPRESSION OF PROSE and not a
//    BLINDNESS OF THE MATCHER.
// ───────────────────────────────────────────────────────────────────────────

test('control 3 (comment vs code): identical text is reported as code and suppressed as a trailing // comment', () => {
	const asCode = COMMENT_CONTROL_CODE_LINE;
	const asTrailingComment = `const keep = 1; // ${COMMENT_CONTROL_CODE_LINE}`;

	assert.ok(
		scanSourceForNames(asCode, FORBIDDEN_NAMES).some((h) => h.name === COMMENT_CONTROL_NAME),
		'the text in CODE position was not reported — the matcher is blind, not merely comment-aware',
	);
	assert.deepEqual(
		scanSourceForNames(asTrailingComment, FORBIDDEN_NAMES).map((h) => h.name),
		[],
		'the identical text in a TRAILING // comment was reported; prose that explains a rule must not trip it',
	);
	assert.ok(
		stripComments(asTrailingComment).includes('const keep = 1;'),
		'the trailing-comment stripper truncated the code that preceded the comment',
	);
});

test('control 3b (comment vs code): the same text is suppressed in a block comment and in a JSX comment', () => {
	const asBlock = `const keep = 1; /* ${COMMENT_CONTROL_CODE_LINE} */`;
	const asMultiLineBlock = ['/**', ` * ${COMMENT_CONTROL_CODE_LINE}`, ' */', 'const keep = 1;'].join('\n');
	const asJsx = `<div>{/* ${COMMENT_CONTROL_CODE_LINE} */}</div>`;

	for (const [label, fixture] of [
		['single-line block', asBlock],
		['multi-line block', asMultiLineBlock],
		['JSX brace-wrapped block', asJsx],
	]) {
		assert.deepEqual(
			scanSourceForNames(fixture, FORBIDDEN_NAMES).map((h) => h.name),
			[],
			`the ${label} comment position was reported; the block-comment stripper does not cover it`,
		);
	}
	assert.ok(stripComments(asBlock).includes('const keep = 1;'), 'block stripping ate the preceding code');
	assert.ok(stripComments(asMultiLineBlock).includes('const keep = 1;'), 'multi-line block stripping ate the following code');
});

// ───────────────────────────────────────────────────────────────────────────
// 4. String-preservation control — the trailing-comment scanner must not
//    truncate a line at a `//` that is inside a string literal.
// ───────────────────────────────────────────────────────────────────────────

test('control 4 (string preservation): a // inside a string literal is not treated as a comment', () => {
	const url = `const endpoint = 'https://example.invalid/path'; const after = 2;`;
	const stripped = stripComments(url);
	assert.ok(stripped.includes('https://example.invalid/path'), 'the URL inside a string literal was truncated at its //');
	assert.ok(stripped.includes('const after = 2;'), 'code after the string was lost');

	const inTemplate = 'const t = `https://example.invalid`;';
	assert.ok(stripComments(inTemplate).includes('https://example.invalid'), 'a // inside a backtick template was truncated');

	const escaped = `const s = 'it\\'s // not a comment'; const after = 3;`;
	assert.ok(stripComments(escaped).includes('const after = 3;'), 'backslash escaping inside a string literal is mishandled');
});

// ───────────────────────────────────────────────────────────────────────────
// 5. Planted-violation control, AT FILE LEVEL. The working tree is never
//    written to: the plant goes into a temp COPY of the real source tree, and
//    the same walker/reader/matcher runs against it.
// ───────────────────────────────────────────────────────────────────────────

test('control 5 (planted violation in a copy of the real tree): clean before, exactly one offender after', () => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), 'vt-anonymity-scan-'));
	try {
		const copiedRoot = path.join(tmp, 'public');
		cpSync(webDataSrc('public'), copiedRoot, { recursive: true });

		// (a) The unmodified copy must scan clean, so the plant is provably what
		//     causes the failure rather than something the copy already carried.
		assert.deepEqual(
			scanForNames({ roots: [copiedRoot], names: FORBIDDEN_NAMES }),
			[],
			'an unmodified copy of the real public read layer already reports offenders; the plant below would prove nothing',
		);

		// (b) Choose the victim by WALKING the copy, not by naming a file — a
		//     hard-coded name silently stops testing anything when a file moves.
		const victim = walkSourceFiles(copiedRoot).filter((f) => f.endsWith('.js') && !f.endsWith('index.js'))[0];
		assert.ok(victim, 'the copied tree contains no scannable module to plant into');

		// (c) Plant INSIDE A MULTI-LINE TEMPLATE LITERAL. Two things at once: it
		//     proves the scan reads real template content, and it proves the
		//     line-local stripper does not swallow a multi-line template.
		appendFileSync(
			victim,
			['', 'export const PLANTED_SQL = `', `  select Id from ${PLANTED_NAME}`, '  where Id = :id`;', ''].join('\n'),
		);

		const offenders = scanForNames({ roots: [copiedRoot], names: FORBIDDEN_NAMES });
		assert.equal(
			offenders.length,
			1,
			`expected exactly one offender after the plant, got ${offenders.length}: ${JSON.stringify(offenders)}`,
		);
		assert.equal(offenders[0].file, victim, 'the offender was attributed to the wrong file');
		assert.equal(offenders[0].name, PLANTED_NAME, 'the offender was attributed to the wrong table');
		assert.equal(offenders[0].sqlContext, true, 'the planted FROM-position hit was not flagged as SQL context');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

// ───────────────────────────────────────────────────────────────────────────
// 6. Root-choice inertness control. `src/classification.js` legitimately holds
//    every forbidden name as an object key and is deliberately OUTSIDE this
//    scan's root. If the scan would not report it when it IS in scope, then
//    "narrow root" and "blind matcher" are indistinguishable and the real run's
//    green means nothing.
// ───────────────────────────────────────────────────────────────────────────

test('control 6 (root-choice inertness): the classification file IS reported when copied inside the scan root', () => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), 'vt-anonymity-root-'));
	try {
		const copiedRoot = path.join(tmp, 'public');
		cpSync(webDataSrc('public'), copiedRoot, { recursive: true });
		assert.deepEqual(scanForNames({ roots: [copiedRoot], names: FORBIDDEN_NAMES }), [], 'baseline copy is not clean');

		const smuggled = path.join(copiedRoot, path.basename(webDataSrc('classification.js')));
		copyFileSync(webDataSrc('classification.js'), smuggled);

		const offenders = scanForNames({ roots: [copiedRoot], names: FORBIDDEN_NAMES });
		const inSmuggled = offenders.filter((o) => o.file === smuggled);
		assert.ok(
			inSmuggled.length >= EXPECTED_FORBIDDEN_COUNT,
			`the classification file inside the scan root produced ${inSmuggled.length} offenders; ` +
				`expected at least ${EXPECTED_FORBIDDEN_COUNT} (it holds every forbidden name as an object key). ` +
				'If this assertion fails, the real run is green because the matcher is blind, not because the root is narrow.',
		);
		assert.equal(
			offenders.length,
			inSmuggled.length,
			'offenders appeared outside the smuggled file; the baseline was not clean after all',
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

// ───────────────────────────────────────────────────────────────────────────
// 6b. Officer-exclusion inertness control, modelled directly on control 6.
//     `officer/` is deliberately OUTSIDE this scan's root (D-04's subpath
//     split, not this scan, is what keeps it off an anonymous page). "the
//     officer directory is excluded" and "the matcher is blind to officer
//     queries" are indistinguishable without this control.
// ───────────────────────────────────────────────────────────────────────────

test('control 6b (officer-exclusion inertness): an officer module IS reported when copied inside the scan root', () => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), 'vt-anonymity-officer-'));
	try {
		const copiedRoot = path.join(tmp, 'public');
		cpSync(webDataSrc('public'), copiedRoot, { recursive: true });
		assert.deepEqual(
			scanForNames({ roots: [copiedRoot], names: FORBIDDEN_NAMES }),
			[],
			'baseline copy is not clean before the officer module is copied in',
		);

		// `officer/registrations.js`, not `officer/read-keyholders.js`: this file
		// is the one that actually references forbidden-class tables as CODE.
		// read-keyholders.js joins two PUBLIC-SAFE tables — its officer-only-ness
		// is a JOIN PATTERN D-04's subpath split guards, not a forbidden table
		// name, so it names nothing this scan's matcher would ever report and
		// would make this control pass vacuously regardless of whether the
		// exclusion is load-bearing.
		const smuggled = path.join(copiedRoot, path.basename(webDataSrc('officer', 'registrations.js')));
		copyFileSync(webDataSrc('officer', 'registrations.js'), smuggled);

		const offenders = scanForNames({ roots: [copiedRoot], names: FORBIDDEN_NAMES });
		assert.ok(
			offenders.some((o) => o.file === smuggled),
			'the officer module inside the scan root produced zero offenders — "officer/ is excluded" and ' +
				'"the matcher is blind to officer queries" are indistinguishable without this control',
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

// ───────────────────────────────────────────────────────────────────────────
// 6c. The connection-layer plant — the discriminating control this whole plan
//     turns on. A real run's green over the widened root must be attributable
//     to `open-db.js`/`reattach.js`/`networks-registry.js` being clean, not to
//     the widened root being unread. This proves the widened scan is not inert
//     by planting a forbidden-table statement into the one connection-layer
//     module NOT already covered by controls 5/6/6b's `src/public` copies.
// ───────────────────────────────────────────────────────────────────────────

test('control 6c (connection-layer plant): clean before, exactly one offender after planting into a copy of reattach.js', () => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), 'vt-anonymity-connlayer-'));
	try {
		const copiedRoot = path.join(tmp, 'web-data-src');
		cpSync(webDataSrc(), copiedRoot, { recursive: true });

		// (a) The unmodified copy, under the same two exclusions, must scan
		//     clean — the plant below is provably what causes the failure.
		const exclude = [path.join(copiedRoot, 'classification.js'), path.join(copiedRoot, 'officer')];
		assert.deepEqual(
			scanForNames({ roots: [copiedRoot], names: FORBIDDEN_NAMES, exclude }),
			[],
			'an unmodified copy of the connection layer already reports offenders; the plant below would prove nothing',
		);

		// (b) Plant INSIDE A MULTI-LINE TEMPLATE LITERAL, the same shape as
		//     control 5's plant and 54-08's control — it proves the scan reads
		//     real template content and that the line-local stripper does not
		//     swallow a multi-line template. Spliced in right after
		//     `readRowCounts` (reattach.js's own `from ${table}` row-count query)
		//     rather than appended past the file's closing brace, so it sits
		//     alongside the SQL the file already carries instead of dangling
		//     after `export`-able code has ended.
		const victim = path.join(copiedRoot, 'reattach.js');
		const original = readFileSync(victim, 'utf8');
		const anchor = 'export async function readRowCounts(db, tableNames) {';
		const anchorAt = original.indexOf(anchor);
		assert.ok(anchorAt >= 0, 'reattach.js no longer declares readRowCounts at the expected shape — update the plant anchor');
		const insertAt = original.indexOf('\n}\n', anchorAt) + '\n}\n'.length;
		const planted = ['', 'export const PLANTED_CONNECTION_LAYER_SQL = `', `  select Id from ${PLANTED_NAME}`, '  where Id = :id`;', ''].join(
			'\n',
		);
		writeFileSync(victim, original.slice(0, insertAt) + planted + original.slice(insertAt));

		const offenders = scanForNames({ roots: [copiedRoot], names: FORBIDDEN_NAMES, exclude });
		assert.equal(
			offenders.length,
			1,
			`expected exactly one offender after the connection-layer plant, got ${offenders.length}: ${JSON.stringify(offenders)}`,
		);
		assert.equal(offenders[0].file, victim, 'the offender was attributed to the wrong file');
		assert.equal(offenders[0].name, PLANTED_NAME, 'the offender was attributed to the wrong table');
		assert.equal(offenders[0].sqlContext, true, 'the planted FROM-position hit was not flagged as SQL context');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

// ───────────────────────────────────────────────────────────────────────────
// 6d. Stale-exclusion and separator-boundary behaviour of the exclusion
//     mechanism itself (`scannedFilesFor` in `./lib/source-scan.mjs`).
// ───────────────────────────────────────────────────────────────────────────

test('control 6d (stale exclusion): an exclude entry matching zero files throws StaleExclusionError', () => {
	const bogus = webDataSrc('this-path-does-not-exist.js');
	assert.throws(
		() => scannedFilesFor({ roots: [webDataSrc()], exclude: [bogus] }),
		(err) => err instanceof StaleExclusionError && err.message.includes(bogus),
		'a stale exclusion did not throw StaleExclusionError naming the offending path',
	);
});

test('control 6d (separator-boundary exclusion): excluding "officer" does not exclude a sibling "officer-notes.js"', () => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), 'vt-anonymity-boundary-'));
	try {
		mkdirSync(path.join(tmp, 'officer'), { recursive: true });
		writeFileSync(path.join(tmp, 'officer', 'a.js'), 'export const a = 1;\n');
		writeFileSync(path.join(tmp, 'officer-notes.js'), 'export const b = 1;\n');

		const scanned = scannedFilesFor({ roots: [tmp], exclude: [path.join(tmp, 'officer')] });
		assert.deepEqual(
			scanned,
			[path.join(tmp, 'officer-notes.js')],
			'excluding "officer" as a directory incorrectly swept up the sibling file "officer-notes.js" ' +
				'merely because its name shares a string prefix; the comparison must be on a path-separator boundary',
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

// ───────────────────────────────────────────────────────────────────────────
// 6e. The pinned scanned-file set: count AND named membership of the three
//     connection-layer modules. The count proves the set did not shrink; the
//     membership proves the three files I-56 is about are specifically in it.
//     A refactor that renames one of the three fails THIS gate and must be
//     re-approved, rather than sliding through under an unchanged count.
// ───────────────────────────────────────────────────────────────────────────

test('control 6e (pinned scanned-file set): the widened scan reads EXPECTED_SCANNED_FILE_COUNT files, including the three connection-layer modules by name', () => {
	const scanned = scannedFilesFor({ roots: SCAN_ROOTS, exclude: SCAN_EXCLUSIONS });
	assert.equal(
		scanned.length,
		EXPECTED_SCANNED_FILE_COUNT,
		`the scanned file set moved from ${EXPECTED_SCANNED_FILE_COUNT} to ${scanned.length} files. ` +
			'A root or an exclusion changed. Update this number DELIBERATELY and say why in the commit; ' +
			'never adjust it to make a red gate green.',
	);
	assert.ok(
		scanned.some((f) => f.endsWith(`${path.sep}open-db.js`)),
		'open-db.js is not in the scanned set — the connection layer this plan widened for is missing',
	);
	assert.ok(
		scanned.some((f) => f.endsWith(`${path.sep}reattach.js`)),
		'reattach.js is not in the scanned set — the connection layer this plan widened for is missing',
	);
	assert.ok(
		scanned.some((f) => f.endsWith(`${path.sep}networks-registry.js`)),
		'networks-registry.js is not in the scanned set — the connection layer this plan widened for is missing',
	);
});

// ───────────────────────────────────────────────────────────────────────────
// 7. Extension coverage. A file type nobody classified is a silent hole.
// ───────────────────────────────────────────────────────────────────────────

test('control 7 (unknown extensions): both real roots partition cleanly, and an unlisted extension fails', () => {
	for (const root of SCAN_ROOTS) {
		const part = partitionByExtension(walkSourceFiles(root));
		assert.deepEqual(
			part.unknown,
			[],
			`${root} holds files with an extension classified neither as code nor as non-code: ${part.unknown.join(', ')}. ` +
				'Classify the extension in test/lib/source-scan.mjs deliberately rather than letting the scan skip it.',
		);
		assert.ok(part.scanned.length > 0, `${root} walked to zero scannable files — the walker or the root is wrong`);
	}

	const tmp = mkdtempSync(path.join(os.tmpdir(), 'vt-anonymity-ext-'));
	try {
		mkdirSync(path.join(tmp, 'nested'), { recursive: true });
		writeFileSync(path.join(tmp, 'nested', 'thing.vue'), '<template/>');
		writeFileSync(path.join(tmp, 'ok.js'), 'export const a = 1;\n');
		const part = partitionByExtension(walkSourceFiles(tmp));
		assert.equal(part.unknown.length, 1, 'an unlisted extension was not routed to the unknown bucket');
		assert.throws(
			() => scanForNames({ roots: [tmp], names: FORBIDDEN_NAMES }),
			/UnknownExtensionError/,
			'scanForNames did not fail on an unrecognised extension; coverage could shrink silently',
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

// ───────────────────────────────────────────────────────────────────────────
// 8. Self-trip guard. This file is not inside the scan root today, so this is
//    discipline rather than necessity — but it costs one assertion and encodes
//    the failure mode this repo has recorded six times in this phase alone.
// ───────────────────────────────────────────────────────────────────────────

test('self-trip guard: outside the fixture region this file contains no forbidden table name, prose included', () => {
	const own = readFileSync(THIS_FILE, 'utf8');
	const begin = own.indexOf(BEGIN_SENTINEL);
	const end = own.indexOf(END_SENTINEL);
	assert.ok(begin > 0 && end > begin, 'the control-fixture sentinels are missing or out of order in this file');

	const remainder = own.slice(0, begin) + own.slice(end + END_SENTINEL.length);
	/** @type {string[]} */
	const leaks = [];
	for (const name of FORBIDDEN_NAMES) {
		if (new RegExp(`\\b${name}\\b`).test(remainder)) leaks.push(name);
	}
	assert.deepEqual(
		leaks,
		[],
		`this checker's own source names ${leaks.join(', ')} outside its fixture region. ` +
			'A checker whose prose quotes what it hunts is one root-widening away from being permanently green. ' +
			'Move the literal into the fixture region or assemble it.',
	);
});

// ───────────────────────────────────────────────────────────────────────────
// 9. THE REAL SCAN. Every control above has already run.
// ───────────────────────────────────────────────────────────────────────────

test('D-05: zero forbidden-class table names as code across the public entry source set', () => {
	const offenders = scanForNames({ roots: SCAN_ROOTS, names: FORBIDDEN_NAMES, exclude: SCAN_EXCLUSIONS });
	assert.deepEqual(
		offenders.map((o) => `${o.file}:${o.line} [${o.name}] sqlContext=${o.sqlContext} :: ${o.text}`),
		[],
		'a table an anonymous reader may not see is referenced as code in the public entry source set. ' +
			'The QUERY is what must change, not this rule.',
	);
});
