#!/usr/bin/env node
/**
 * assert-no-test-harness-in-dist.mjs — the public app's own instance of the
 * D-17 post-build scan (53-09), following
 * `apps/VoteTorrentDashboard/scripts/assert-no-test-harness-in-dist.mjs`'s
 * structure with THIS app's own token set.
 *
 * WHY THIS APP'S TOKEN SET IS WORSE THAN A HARNESS-FILENAME LEAK ALONE. This
 * app's harness (`test/browser/election-shell-gate.tsx`, 53-07) renders a
 * FIXTURE ELECTION (`test/fixtures/election-fixture.js`, sentinel
 * `vtx-fixture`) so the public leg has something real to mount. If that
 * fixture ever reached `dist/`, a page whose entire purpose is that its
 * claims can be checked by an anonymous reader would assert INVENTED
 * election facts — not merely leak a filename, but ship false content. The
 * token set below is inherited verbatim from 53-07's own fixture and
 * harness (never invented or duplicated here): `vtx-fixture`,
 * `FIXTURE_ELECTION`, `election-shell-gate`, `__ELECTION_SHELL_GATE__`, plus
 * `__UI_GATE__`/`__UI_GATE_DONE__` for the readout channel 53-09's Task 2
 * publishes. `__PUBLIC_APP__` is DELIBERATELY EXCLUDED — `main.tsx` (53-06)
 * ships it as a genuine production readout, and listing it here would make
 * every production build fail this scan.
 *
 * Runs its own positive control FIRST, PLUS two benign negative-control
 * fixtures proving the matcher discriminates rather than firing on
 * everything (the dashboard's own script has no negative fixture; this one
 * adds them, because a matcher that fires on everything would make the
 * `dist/` result meaningless in the other direction) — a check that cannot
 * detect a planted token, and a check that fires on ordinary production
 * text, both prove nothing.
 *
 * THE CROSS-BUILD PRESENCE CONTROL — the part that makes "zero in dist/"
 * meaningful. After the production `dist/` scan finds zero hits, this
 * script runs the SAME matcher and the SAME `walkDist` over this app's own
 * `dist-gate/` (53-07's gate build, which DOES embed the fixture and the
 * harness) and requires AT LEAST ONE hit. Without this, "zero in dist/"
 * could mean either "genuinely absent" or "the matcher/file-selection step
 * sees nothing anywhere" — this control is what tells the two apart, using
 * the exact token set the production scan uses so the two agree by
 * construction.
 *
 * Standalone Node script, no new dependency.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');
const DIST_ASSETS = path.join(DIST, 'assets');
const DIST_GATE = path.join(ROOT, 'dist-gate');

/**
 * This app's own harness/fixture tokens, inherited from 53-07 (the fixture
 * and harness filenames/sentinel) plus 53-09's own readout-channel globals.
 * `__PUBLIC_APP__` — 53-06's genuine production readout — is deliberately
 * NOT a member.
 */
const TEST_HARNESS_TOKEN_RE = /(vtx-fixture|FIXTURE_ELECTION|election-shell-gate|__ELECTION_SHELL_GATE__|__UI_GATE__|__UI_GATE_DONE__)/;

/** @param {string} message */
function fail(message) {
	process.stderr.write(`[assert-no-test-harness-in-dist] FAIL: ${message}\n`);
	process.exit(1);
}

/** @param {string} message */
function ok(message) {
	process.stdout.write(`[assert-no-test-harness-in-dist] OK: ${message}\n`);
}

// ---------------------------------------------------------------------------
// 1. Positive control — the matcher must be able to detect every named
//    token BEFORE it is trusted to scan the real build output.
// ---------------------------------------------------------------------------
const POSITIVE_CONTROL_FIXTURES = [
	"export const FIXTURE_ELECTION_ID = 'vtx-fixture-0001';",
	'export const FIXTURE_ELECTION = Object.freeze({ title: "..." });',
	'import { ElectionShell } from "../../src/screens/ElectionShell";\n// election-shell-gate.tsx',
	'window.__ELECTION_SHELL_GATE__ = Object.freeze({ harness: "election-shell-gate" });',
	'window.__UI_GATE__ = Object.freeze({ mounted: [], error: null });',
	'window.__UI_GATE_DONE__ = true;',
];
for (const fixture of POSITIVE_CONTROL_FIXTURES) {
	if (!TEST_HARNESS_TOKEN_RE.test(fixture)) {
		fail(`matcher is inert — the fixture ${JSON.stringify(fixture)} did not match. This gate cannot detect a real regression.`);
	}
}

/** The exact class of false positive the dashboard's own script's header
 * documents: a `.map` file's `sourcesContent` naming the harness in a DOC
 * COMMENT, not shipped code. The matcher itself is still expected to fire
 * on this text — the FIX is that the file-selection step below never hands
 * a `.map` file to it. */
const SOURCEMAP_STYLE_FIXTURE = '{"sourcesContent":["/**\\n * election-shell-gate.tsx"]}';
if (!TEST_HARNESS_TOKEN_RE.test(SOURCEMAP_STYLE_FIXTURE)) {
	fail('matcher is inert against a sourcemap-shaped fixture — cannot prove the fix is a SCOPE change, not a matcher change.');
}
ok(`${POSITIVE_CONTROL_FIXTURES.length + 1} positive control(s) matched — matcher is live.`);

// ---------------------------------------------------------------------------
// 1b. Benign negative controls — proving the matcher DISCRIMINATES rather
//     than firing on everything. The dashboard's own script has no negative
//     fixture; a matcher that matches every string would make a "zero
//     hits" result in dist/ meaningless.
// ---------------------------------------------------------------------------
const BENIGN_FIXTURES = [
	'const rootElement = document.getElementById("root"); createRoot(rootElement).render(<App />);',
	"export const COPY = { 'public.chrome.appName': 'VoteTorrent Public Election View' };",
];
for (const fixture of BENIGN_FIXTURES) {
	if (TEST_HARNESS_TOKEN_RE.test(fixture)) {
		fail(`matcher fired on an ordinary production-shaped fixture ${JSON.stringify(fixture)} — it does not discriminate, so a "zero hits" result in dist/ would mean nothing.`);
	}
}
ok(`${BENIGN_FIXTURES.length} benign negative control(s) correctly did NOT match — matcher discriminates.`);

// ---------------------------------------------------------------------------
// 2. Require a pre-built dist/ (this script does not build; the documented
//    command is `yarn build && node scripts/assert-no-test-harness-in-dist.mjs`).
// ---------------------------------------------------------------------------
if (!existsSync(DIST_ASSETS)) {
	fail(`${DIST_ASSETS} does not exist — run \`yarn build\` first.`);
}

// ---------------------------------------------------------------------------
// 3. Walk a dist-shaped directory, scanning ONLY what ships and executes:
//    .js/.mjs/.cjs, .html, .css. `.map` files are DELIBERATELY excluded —
//    verbatim copy of the dashboard's own walkDist.
// ---------------------------------------------------------------------------
/** @param {string} dir @returns {string[]} */
function walkDist(dir) {
	/** @type {string[]} */
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkDist(full));
			continue;
		}
		if (entry.name.endsWith('.map')) continue;
		if (/\.(js|mjs|cjs|html|css)$/.test(entry.name)) out.push(full);
	}
	return out;
}

const emittedFiles = walkDist(DIST);
const emittedJs = emittedFiles.filter((f) => f.endsWith('.js'));
if (emittedJs.length === 0) {
	fail(`no .js files found under ${DIST} — the build emitted nothing to scan.`);
}

// Confirm the excluded .map DOES still carry a token right now (informational
// only — not a pass/fail condition), so a PASS reads as "found and correctly
// excluded" rather than "never looked".
const mapFiles = readdirSync(DIST_ASSETS).filter((f) => f.endsWith('.map'));
const mapHits = mapFiles.filter((f) => TEST_HARNESS_TOKEN_RE.test(readFileSync(path.join(DIST_ASSETS, f), 'utf8')));
if (mapHits.length > 0) {
	ok(`observed (informational, not a failure): ${mapHits.length} sourcemap file(s) carry a harness token in sourcesContent, correctly excluded from the scan: ${mapHits.join(', ')}`);
} else {
	ok('observed: no sourcemap file currently carries a harness token either (nothing to exclude right now).');
}

const offenders = [];
for (const filePath of emittedFiles) {
	const contents = readFileSync(filePath, 'utf8');
	const match = contents.match(TEST_HARNESS_TOKEN_RE);
	if (match) {
		offenders.push(`${filePath}: "${match[0]}"`);
	}
}

if (offenders.length > 0) {
	fail(`the shipped bundle contains a test-harness or fixture-election token:\n${offenders.map((o) => `  - ${o}`).join('\n')}`);
}
ok(`scanned ${emittedFiles.length} shipped file(s) (.map excluded) under dist/ — no test-harness token found.`);

// ---------------------------------------------------------------------------
// 4. The cross-build presence control (D-17, the part that makes the
//    absence above meaningful). The SAME matcher and the SAME walkDist,
//    run over this app's OWN dist-gate/ (53-07's gate build, which DOES
//    embed the fixture and the harness) — at least one hit is required.
// ---------------------------------------------------------------------------
if (!existsSync(DIST_GATE)) {
	fail(
		`${DIST_GATE} does not exist — the cross-build presence control needs a gate build to compare ` +
			`against. Run \`yarn build && yarn build:gate && yarn assert:no-test-harness-in-dist\`.`,
	);
}

const gateFiles = walkDist(DIST_GATE);
if (gateFiles.length === 0) {
	fail(`no shippable files found under ${DIST_GATE} — the gate build emitted nothing to scan.`);
}

const gateHits = [];
for (const filePath of gateFiles) {
	const contents = readFileSync(filePath, 'utf8');
	const match = contents.match(TEST_HARNESS_TOKEN_RE);
	if (match) {
		gateHits.push(`${filePath}: "${match[0]}"`);
	}
}

if (gateHits.length === 0) {
	fail(
		`the cross-build presence control found ZERO harness tokens in ${DIST_GATE} — this means the ` +
			`matcher or the file-selection step sees nothing anywhere, which makes the dist/ "zero hits" ` +
			`result above meaningless rather than a real absence.`,
	);
}
ok(
	`cross-build presence control: found ${gateHits.length} harness-token hit(s) in dist-gate/ (the gate build DOES ` +
		`embed the fixture and harness, as expected) — proving the scan can see the token, so the zero result ` +
		`in dist/ is a genuine absence: ${gateHits[0]}`,
);
