/**
 * external-write-seam-sites.test.mjs — `56-09` Task 3's standing instrument:
 * the external-write seam (`applyExternalRowChanges`, and the `Database`
 * method that ingests its output -- see `SEAM_TOKEN` below for the exact
 * name; it is deliberately not spelled out in this paragraph, see the
 * anti-self-trip note further down -- "built for trusted replication-style
 * writes", running NO constraint validation) may appear in exactly the two
 * recorded production sites in this repo, pinned by a repo-wide scan rather
 * than a one-off plan-time grep.
 *
 * REPLACES a stale claim. The dashboard's old restore module used to say the
 * seam "may appear in EXACTLY ONE FILE, this one" -- true when written, false
 * the moment `56-09` added the second site. This file is the standing check
 * that claim was pinned to; that module has since left with the dashboard's
 * snapshot path (66-24).
 *
 * ANTI-SELF-TRIP DISCIPLINE (`project_self_tripping_checker_headers`, three
 * recurrences in Phase 53):
 *
 *   1. This instrument lives under `test/`, and every scan root below is a
 *      `src/` tree only -- structurally, this file can never scan itself.
 *   2. Comments are stripped (via the shared `stripComments` this repo's
 *      other scans already use) before matching, so a `src/` file that
 *      merely DISCUSSES the seam in a header comment -- as both
 *      `reactivity-bridge.js` files do, at length -- is not counted. `subscribe.js` names the seam once, in prose inside a
 *      JSDoc block; that mention must be stripped, not counted, and the
 *      self-check group below proves the stripper does exactly that.
 *   3. The assertion below is SET EQUALITY against a frozen two-element
 *      expectation -- never a `=== 0` or a `>= 1` count. Equality carries its
 *      own positive control: if the scan silently stopped reading files, the
 *      expected set would not be found and this test would fail loudly
 *      rather than passing on a narrowed, unverified root.
 *
 * WHY TWO SITES (66-13, 66-24). The officer dashboard's member device replicates
 * its officer tables from the strand the same way this page replicates the
 * public tables, so `apps/VoteTorrentDashboard/src/peer/reactivity-bridge.js`
 * became a deliberate production site in 66-13 (three sites for a while). The
 * dashboard's restore site left with its snapshot path in 66-24, so the two
 * remaining sites are both live replication: the dashboard's member replication
 * and this app's bridge.
 *
 * The token this instrument searches for is assembled from concatenated
 * fragments at runtime (below), so this file's own source never spells it
 * out as a contiguous literal -- belt-and-braces on top of point 1, since a
 * root-widening mistake that ever pointed a scan at `test/` would otherwise
 * make this checker permanently green on itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publicSrc, dashboardSrc, webDataSrc } from '../../../../scripts/lib/source-paths.mjs';
import { scannedFilesFor, stripComments } from '../../../../packages/web-data/test/lib/source-scan.mjs';

/**
 * The seam's own distinctive method name, on `Database` -- shared verbatim
 * by both production sites' call sites and by no other file in the three
 * scanned trees. Assembled from fragments; see the header's anti-self-trip
 * note.
 * @type {string}
 */
const SEAM_TOKEN = ['ingest', 'External', 'Row', 'Changes'].join('');

/** The whole-word matcher over already comment-stripped source. @type {RegExp} */
const SEAM_TOKEN_RE = new RegExp(`\\b${SEAM_TOKEN}\\b`);

/**
 * The three `src/` trees this seam could plausibly reach: the public app
 * (56-09's site), the dashboard (its member replication) and the shared
 * data package (D-22 forbids growing ITS external-write surface, so a future
 * violation there must also trip this instrument).
 * @type {ReadonlyArray<string>}
 */
const SCAN_ROOTS = Object.freeze([publicSrc(), dashboardSrc(), webDataSrc()]);

/**
 * The two, and only two, files this repo's product code is permitted to
 * invoke the seam from today. A third file appearing here means either a
 * new legitimate production site was added without updating this constant
 * (do so deliberately, with a header note explaining why a third site is
 * now correct) or an accidental widening that must be reverted. The
 * dashboard's member replication became a site in 66-13 and its restore
 * site left in 66-24 (see the header note).
 * @type {ReadonlyArray<string>}
 */
const EXPECTED_SEAM_SITES = Object.freeze(
	[
		dashboardSrc('peer', 'reactivity-bridge.js'),
		publicSrc('peer', 'reactivity-bridge.js'),
	].sort(),
);

// ---------------------------------------------------------------------------
// 1. Sanity.
// ---------------------------------------------------------------------------

test('EXPECTED_SEAM_SITES is a frozen, two-element constant naming the two production sites by absolute path', () => {
	assert.ok(Object.isFrozen(EXPECTED_SEAM_SITES));
	assert.equal(EXPECTED_SEAM_SITES.length, 2);
	assert.ok(EXPECTED_SEAM_SITES.every((f) => typeof f === 'string' && f.length > 0));
});

// ---------------------------------------------------------------------------
// 2. Comment-strip self-check -- the discriminating control this whole
//    instrument turns on. Run BEFORE the real scan.
// ---------------------------------------------------------------------------

test('self-check: comment-stripping reactivity-bridge.js still leaves its real seam call visible to the matcher', () => {
	const source = readFileSync(publicSrc('peer', 'reactivity-bridge.js'), 'utf8');
	const stripped = stripComments(source);
	assert.match(stripped, SEAM_TOKEN_RE, 'the comment stripper ate the real seam call in reactivity-bridge.js -- this instrument would report a false negative');
});

test('self-check: comment-stripping the dashboard reactivity-bridge.js still leaves its real seam call visible to the matcher', () => {
	const source = readFileSync(dashboardSrc('peer', 'reactivity-bridge.js'), 'utf8');
	const stripped = stripComments(source);
	assert.match(stripped, SEAM_TOKEN_RE, 'the comment stripper ate the real seam call in the dashboard reactivity-bridge.js -- this instrument would report a false negative');
});

test('self-check: a synthetic // comment mentioning the token is correctly stripped and no longer matches', () => {
	const syntheticLine = `// a header paragraph that merely discusses the ${SEAM_TOKEN} seam\nconst keep = 1;`;
	const stripped = stripComments(syntheticLine);
	assert.doesNotMatch(stripped, SEAM_TOKEN_RE, 'a // comment mentioning the seam token was not stripped -- prose would be miscounted as a production site');
	assert.match(stripped, /const keep = 1;/, 'the stripper ate the code that followed the comment');
});

test('self-check: a synthetic block comment mentioning the token is correctly stripped and no longer matches', () => {
	const syntheticBlock = `/**\n * this header paragraph discusses the ${SEAM_TOKEN} seam at length\n */\nconst keep = 1;`;
	const stripped = stripComments(syntheticBlock);
	assert.doesNotMatch(stripped, SEAM_TOKEN_RE, 'a block comment mentioning the seam token was not stripped');
	assert.match(stripped, /const keep = 1;/, 'the stripper ate the code that followed the comment');
});

test('control: the SAME matcher fires on the token in CODE position, so the stripping controls above discriminate rather than the matcher being universally inert', () => {
	const asCode = `db.${SEAM_TOKEN}(changes, { captureChanges: false });`;
	assert.match(stripComments(asCode), SEAM_TOKEN_RE, 'the matcher is inert even against the token in code position');
});

// ---------------------------------------------------------------------------
// 3. THE REAL SCAN. Every self-check above has already run.
// ---------------------------------------------------------------------------

test('56-09 T-corr: the external-write seam appears in EXACTLY the two recorded production sites, by set equality', () => {
	const files = scannedFilesFor({ roots: SCAN_ROOTS });
	/** @type {string[]} */
	const offenders = [];
	for (const file of files) {
		const stripped = stripComments(readFileSync(file, 'utf8'));
		if (SEAM_TOKEN_RE.test(stripped)) offenders.push(file);
	}
	assert.deepEqual(
		[...offenders].sort(),
		[...EXPECTED_SEAM_SITES],
		'the external-write seam is invoked from a file set that does not match EXPECTED_SEAM_SITES. ' +
			'If a new site was added deliberately, update EXPECTED_SEAM_SITES and say why in the commit; ' +
			'never adjust it to make a red gate green.',
	);
});
