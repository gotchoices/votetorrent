#!/usr/bin/env node
/**
 * assert-no-test-harness-in-dist.mjs — the T-50-14-04 gate, fixed (RF-01).
 *
 * T-50-14-04's stated mitigation was "a grep over `dist/` for `compose-gate`
 * returning zero." As written it does not hold: a live `yarn build` emits
 * exactly one match, in `dist/assets/index-*.js.map`'s embedded
 * `sourcesContent`, which carries a `DashboardShell.tsx:114` doc comment that
 * names the test file verbatim. No `.js` chunk contains the string, so the
 * SECURITY property this check exists to guard (the browser-only test harness
 * never executes in the shipped bundle) is intact -- but the check's own
 * scope was wrong: an unscoped `grep -r dist/` catches the sourcemap too, and
 * a sourcemap's `sourcesContent` is the ORIGINAL, commented source of the
 * whole graph -- of course it can mention a test file that discusses itself
 * in prose. Scanning it as if it were shipped, executable code manufactures a
 * false failure exactly the same way a naive whole-file regex used to in
 * `lint-copy.mjs`.
 *
 * FIX: scope the scan to what actually SHIPS AND EXECUTES -- `.js` (also
 * `.mjs`/`.cjs`) and `.html`/`.css` chunks -- and explicitly exclude `.map`
 * files, mirroring `assert-no-node-polyfills.mjs`'s own `walkDist` exclusion
 * (see that file's comment for the same reasoning, independently arrived at
 * for a different token).
 *
 * Runs its own positive control FIRST — a check that cannot detect a planted
 * test-harness token proves nothing. Standalone Node script, no new
 * dependencies.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');
const DIST_ASSETS = path.join(DIST, 'assets');

/** Any test-only harness marker. `compose-gate` is T-50-14-04's own named
 * token; the two `window.__..._GATE__` globals are the harness's own
 * cross-page readout channel and would be an even stronger tell if they
 * alone leaked without the literal filename. `ui-gate`/`__UI_GATE__` are
 * 53-08's own D-24 styled harness entry (T-53-08-04) and its readout
 * channel, added the same way. `chart-geometry-gate`/`__CHART_GEOMETRY_GATE__`
 * are 60-07's own D-24 chart-geometry harness entry (T-60-07-01) and its
 * readout channel, widened here the same way. `gap-probe` and the three
 * `__GAP_PROBE_*` globals are the WR-01/WR-02/WR-03 gap-closure harness
 * (`test/browser/gap-probe.tsx`, built to `dist-gap-probe`) and its readout
 * channel; `zero-state-legend`/`label-headroom` are the two gate drivers that
 * read it. Added by the phase-60 security audit, which found this list blind
 * to every one of them (`60-WR / T-60-WR-01`). `live-gate`/`__LIVE_GATE__` are
 * 66-25's live gate entry (`test/browser/live-gate.tsx`) and its readout channel.
 *
 * ONE KNOWN BENIGN COLLISION, recorded rather than special-cased: `gap-probe`
 * also appears in a DOC COMMENT in shipped source
 * (`packages/ui-web/src/charts/chart-contracts.ts:63`, which names the probe
 * that motivated `zeroSafeDataMax`). It cannot reach `dist/` because the
 * production build minifies comments away — verified live when this line was
 * written by a real `yarn build` plus a direct grep of `dist/` for all four
 * new tokens: zero matches. It is listed deliberately anyway: a token that is
 * unreachable only because of a minifier setting is still worth watching, and
 * the matcher stays a plain substring test with no comment-aware
 * special-casing, exactly as the `.map` note below insists. If a future build
 * config stops stripping comments this fires, and that is the correct thing
 * to investigate rather than a bug in the matcher. */
const TEST_HARNESS_TOKEN_RE =
	/(compose-gate|db-gate|shell-gate|gate-matrix|ui-gate|chart-geometry-gate|gap-probe|zero-state-legend|label-headroom|__COMPOSE_GATE__|__DB_GATE__|__SHELL_GATE__|__UI_GATE__|__CHART_GEOMETRY_GATE__|__GAP_PROBE_THROWS__|__GAP_PROBE_DONE__|__GAP_PROBE_ERROR__|live-gate|__LIVE_GATE__)/;

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
// 1. Positive control — the matcher must be able to detect the token BEFORE
//    it is trusted to scan the real build output.
// ---------------------------------------------------------------------------
const POSITIVE_CONTROL_FIXTURES = [
	'import { runComposeGate } from "./test/browser/compose-gate.js";',
	'window.__COMPOSE_GATE__ = { passed: 1 };',
	'/test/browser/db-gate.js',
	'import { UiGateHarness } from "./test/browser/ui-gate.js";',
	'window.__UI_GATE__ = { mounted: [], error: null };',
	'import { ChartGeometryHarness } from "./test/browser/chart-geometry-gate.js";',
	'window.__CHART_GEOMETRY_GATE__ = { mounted: [], error: null };',
	'import { GapProbe } from "./test/browser/gap-probe.js";',
	'window.__GAP_PROBE_DONE__ = true;',
	'window.__GAP_PROBE_THROWS__ = { "legend-non-legend-tone": "…" };',
	'window.__GAP_PROBE_ERROR__ = null;',
	'/test/browser/zero-state-legend-gate.js',
	'/test/browser/label-headroom-gate.js',
	'import { runLiveGate } from "./test/browser/live-gate.js";',
	'window.__LIVE_GATE__ = { mounted: [], error: null };',
];
for (const fixture of POSITIVE_CONTROL_FIXTURES) {
	if (!TEST_HARNESS_TOKEN_RE.test(fixture)) {
		fail(`matcher is inert — the fixture ${JSON.stringify(fixture)} did not match. This gate cannot detect a real regression.`);
	}
}
/** The exact class of false positive RF-01 found: a `.map` file's
 * `sourcesContent` naming the harness in a DOC COMMENT, not shipped code.
 * The matcher itself is still expected to fire on this text — the FIX is
 * that the file-selection step below never hands a `.map` file to it, not
 * that the matcher pretends not to see the word. This benign fixture proves
 * the matcher stays a plain substring test with no special-casing that could
 * silently go blind to a real `.js` occurrence. */
const SOURCEMAP_STYLE_FIXTURE = '{"sourcesContent":["/**\\n * compose-gate.tsx"]}';
if (!TEST_HARNESS_TOKEN_RE.test(SOURCEMAP_STYLE_FIXTURE)) {
	fail('matcher is inert against a sourcemap-shaped fixture — cannot prove the fix is a SCOPE change, not a matcher change.');
}
ok(`${POSITIVE_CONTROL_FIXTURES.length + 1} positive control(s) matched — matcher is live.`);

// ---------------------------------------------------------------------------
// 2. Require a pre-built dist/ (this script does not build; the caller's
//    documented command is `yarn build && node scripts/assert-no-test-harness-in-dist.mjs`,
//    matching assert-no-node-polyfills.mjs's own two-step convention where a
//    build step precedes the scan).
// ---------------------------------------------------------------------------
if (!existsSync(DIST_ASSETS)) {
	fail(`${DIST_ASSETS} does not exist — run \`yarn build\` first.`);
}

// ---------------------------------------------------------------------------
// 3. Walk dist/, scanning ONLY what ships and executes: .js/.mjs/.cjs,
//    .html, .css. `.map` files are DELIBERATELY excluded — see the file
//    header. This mirrors assert-no-node-polyfills.mjs's walkDist exactly.
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

// Confirm the excluded .map DOES still carry the token right now — a live,
// observed fact, not an assumption — so this run's PASS is legible as "found
// and correctly excluded" rather than "never looked". Not itself a pass/fail
// condition: a future rewrite of that doc comment making the .map clean too
// is not a regression.
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
	fail(`the shipped bundle contains a test-harness token:\n${offenders.map((o) => `  - ${o}`).join('\n')}`);
}
ok(`scanned ${emittedFiles.length} shipped file(s) (.map excluded) under dist/ — no test-harness token found.`);
