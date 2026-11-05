#!/usr/bin/env node
/**
 * assert-engine-reach.mjs — the post-build proof, still paired.
 *
 * The two halves are asserted together here because "the engine is reachable"
 * and "that reach is bounded" are only meaningful as a pair — proving reach
 * alone would say nothing about what else the reach smuggled in, and proving
 * an absence alone would say nothing about whether the schema import is real
 * or dead code that never survived the build.
 *
 * RETIREMENT LEDGER (54-10, wave 5)
 * ---------------------------------
 * Until now the negative half asserted ZERO database-opening symbols in the
 * emitted JavaScript. D-01 makes that claim FALSE BY DESIGN: an anonymous
 * reader's data comes from an already-bootstrapped browser's own IndexedDB,
 * reached through `@votetorrent/web-data/public`, so that code legitimately
 * ships. The removal is planned work owned by 54-10 and recorded at
 * `.planning/phases/54-public-no-login-election-view/54-ISSUES.md` I-02 —
 * left alone it would have gone red in a later wave as a mystery CI failure.
 *
 * THE PAIR STRUCTURE IS PRESERVED, NOT ABANDONED. The negative half is now
 * BOUNDED REACH rather than NO REACH: the page may reach the database, and
 * may never reach the privilege/officer surface.
 *
 * WHY THE REPLACEMENT DOES NOT SCAN BUNDLE TEXT
 * --------------------------------------------
 * esbuild renames bare local bindings, so an absence assertion on a
 * renameable imported identifier can pass on a bundle that genuinely
 * contains the code — a false green, and the same class of defeat this repo
 * has already measured against dist-level negative controls. Module paths in
 * a sourcemap's `sources` list are NOT renamed by any minifier, which is why
 * the replacement reads those instead of grepping the emitted JavaScript.
 *
 * The positive half is unchanged: markers derived from the LIVE
 * `VOTETORRENT_SCHEMA_SQL` value must all appear in the emitted JavaScript.
 *
 * Standalone Node script, no new dependencies. Follows the repo's established
 * one-self-contained-script-per-assertion idiom (see
 * apps/VoteTorrentDashboard/scripts/assert-no-node-polyfills.mjs and
 * assert-no-test-harness-in-dist.mjs): this script spawns its own `vite
 * build` rather than relying on a shared, possibly-stale `dist/`.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { VOTETORRENT_SCHEMA_SQL } from '@votetorrent/vote-engine/browser';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');
const DIST_ASSETS = path.join(DIST, 'assets');

/** @param {string} message */
function fail(message) {
	process.stderr.write(`[assert-engine-reach] FAIL: ${message}\n`);
	process.exit(1);
}

/** @param {string} message */
function ok(message) {
	process.stdout.write(`[assert-engine-reach] OK: ${message}\n`);
}

// ---------------------------------------------------------------------------
// `.map`-excluding walk, reused verbatim (body and comment) from
// assert-no-node-polyfills.mjs / assert-no-test-harness-in-dist.mjs.
// ---------------------------------------------------------------------------
/**
 * `.map` files are DELIBERATELY excluded: a source map embeds the original
 * sources of the whole graph, including files that merely DISCUSS a marker
 * or a DB-opening symbol in a comment, so scanning them would report prose
 * as evidence either way. What ships and executes is the `.js`/`.html`/
 * `.css`, which is what this scan covers.
 * @param {string} dir @returns {string[]}
 */
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

// ---------------------------------------------------------------------------
// Marker derivation — the heart of the check. Derived from the value ACTUALLY
// SHIPPED (VOTETORRENT_SCHEMA_SQL, imported above in this Node process),
// never from a second hand-maintained list that could drift.
//
// Markers are maximal runs of characters drawn only from ASCII letters,
// digits, underscore and space, of at least forty characters. Restricting
// markers to that character class is deliberate: such a run is emitted
// byte-identically inside the bundle's JavaScript string literal with no
// escaping ambiguity (no quote, backslash, newline or non-ASCII byte that a
// minifier's string-literal encoder might re-escape differently), so a
// marker miss means the text is genuinely absent rather than merely escaped
// differently.
// ---------------------------------------------------------------------------
const MARKER_CHARSET_RUN_RE = /[A-Za-z0-9_ ]{40,}/g;
const MIN_MARKERS = 8;

/**
 * @param {string} schema
 * @returns {string[]}
 */
function deriveMarkers(schema) {
	const runs = schema.match(MARKER_CHARSET_RUN_RE) ?? [];
	if (runs.length < MIN_MARKERS) {
		fail(
			`marker derivation itself broke — found only ${runs.length} qualifying run(s) of >=40 ` +
				`ASCII letter/digit/underscore/space characters in VOTETORRENT_SCHEMA_SQL, need at least ${MIN_MARKERS}.`,
		);
	}
	// Sample evenly across the whole run list (including the final third) so
	// markers are not clustered at the string's start.
	/** @type {string[]} */
	const markers = [];
	const step = runs.length / MIN_MARKERS;
	for (let i = 0; i < MIN_MARKERS; i++) {
		const idx = Math.min(runs.length - 1, Math.floor(i * step));
		markers.push(runs[idx]);
	}
	return markers;
}

const MARKERS = deriveMarkers(VOTETORRENT_SCHEMA_SQL);
ok(`derived ${MARKERS.length} marker(s) from the live VOTETORRENT_SCHEMA_SQL value (${VOTETORRENT_SCHEMA_SQL.length} chars, ${runsCount()} qualifying run(s) available).`);

/** @returns {number} */
function runsCount() {
	return (VOTETORRENT_SCHEMA_SQL.match(MARKER_CHARSET_RUN_RE) ?? []).length;
}

// ---------------------------------------------------------------------------
// Positive control, first, before the build: prove the marker matcher fires
// on a fixture containing every derived marker.
// ---------------------------------------------------------------------------
const ALL_MARKERS_FIXTURE = MARKERS.join(' | ');
const positiveMatchCount = MARKERS.filter((m) => ALL_MARKERS_FIXTURE.includes(m)).length;
if (positiveMatchCount !== MARKERS.length) {
	fail(
		`positive control failed — the all-markers fixture matched only ${positiveMatchCount}/${MARKERS.length} ` +
			'derived markers. The matcher cannot be trusted to scan the real bundle.',
	);
}
ok(`positive control: the all-markers fixture matched every one of ${MARKERS.length} derived marker(s).`);

// ---------------------------------------------------------------------------
// Negative control, and it is the discriminating one: a fixture containing
// ONLY the schema's own short first line must match NONE of the derived
// markers. This is the guard against a vacuous check: if the minifier ever
// constant-folded a short prefix into the bundle while tree-shaking the real
// ~132 KB string away, a check greping for the first line would pass on an
// engine that never actually shipped.
// ---------------------------------------------------------------------------
const FIRST_LINE_ONLY_FIXTURE = 'declare schema main';
const negativeMatchCount = MARKERS.filter((m) => FIRST_LINE_ONLY_FIXTURE.includes(m)).length;
if (negativeMatchCount !== 0) {
	fail(
		`negative control failed — the schema's-first-line-only fixture matched ${negativeMatchCount} ` +
			'derived marker(s). The matcher is not discriminating between the real schema and its short prefix.',
	);
}
ok(
	`negative control: the schema's-first-line-only fixture matched 0/${MARKERS.length} derived marker(s) — ` +
		'matcher is live and discriminating.',
);

// ---------------------------------------------------------------------------
// Module-graph matchers — the negative half's minification-proof successor.
//
// Held in a delimited frozen table so no matcher literal is loose in prose.
// Written as path-SUFFIX/segment patterns rather than package-relative
// specifiers, so they match both the built `dist/` form a published package
// resolves to and the `src/` form a workspace package resolves to.
// ---------------------------------------------------------------------------
const FORBIDDEN_GRAPH_MODULES = Object.freeze([
	{
		label: 'the privilege primitive (UserEngine, carrier of the officer-scope check)',
		re: /vote-engine\/(?:.*\/)?user\/user-engine\.(?:js|ts)$/,
		why: "D-01 defines *public* as *no officer identity*, so an officer-scope check is permanently illegitimate on this page.",
	},
	{
		label: 'the officer read surface of the shared data package',
		re: /web-data\/(?:.*\/)?officer\//,
		why: 'D-04 splits the data package by audience; only its public half may reach an anonymous page.',
	},
]);

const REQUIRED_GRAPH_MODULES = Object.freeze([
	{ label: "this app's own engine-preflight module", re: /(?:^|\/)src\/engine-preflight\.js$/ },
	{ label: "vote-engine's schema-sql module", re: /vote-engine\/(?:.*\/)?database\/schema-sql\.(?:js|ts)$/ },
]);

/** @param {string[]} paths @returns {Array<{ label: string, path: string }>} */
function matchForbidden(paths) {
	/** @type {Array<{ label: string, path: string }>} */
	const hits = [];
	for (const p of paths) {
		for (const { label, re } of FORBIDDEN_GRAPH_MODULES) {
			if (re.test(p)) hits.push({ label, path: p });
		}
	}
	return hits;
}

// Positive control, before the real scan: both matchers must fire, in both
// the dist/ and src/ resolution forms.
const FORBIDDEN_GRAPH_FIXTURE = Object.freeze([
	'../../../../packages/vote-engine/dist/user/user-engine.js',
	'../../../../packages/vote-engine/src/user/user-engine.ts',
	'../../../../packages/web-data/src/officer/read-keyholders.js',
	'../../node_modules/@votetorrent/web-data/dist/officer/index.js',
]);
const forbiddenFixtureHits = matchForbidden([...FORBIDDEN_GRAPH_FIXTURE]);
const unmatchedFixturePaths = FORBIDDEN_GRAPH_FIXTURE.filter((p) => !forbiddenFixtureHits.some((h) => h.path === p));
const silentMatchers = FORBIDDEN_GRAPH_MODULES.filter(({ label }) => !forbiddenFixtureHits.some((h) => h.label === label));
if (unmatchedFixturePaths.length > 0 || silentMatchers.length > 0) {
	fail(
		'module-graph positive control failed — the forbidden-module matchers are inert. ' +
			`Unmatched planted path(s): ${unmatchedFixturePaths.join(', ') || 'none'}. ` +
			`Matcher(s) that never fired: ${silentMatchers.map((m) => m.label).join(', ') || 'none'}.`,
	);
}
ok(
	`module-graph positive control: both forbidden-module matchers fired, covering all ${FORBIDDEN_GRAPH_FIXTURE.length} ` +
		'planted path(s) in both the dist/ and src/ resolution forms.',
);

// The DISCRIMINATING negative control, and it is the important one. A matcher
// that could not tell the privilege surface apart from the database lifecycle
// this page legitimately uses would force exactly the over-broad fence 54-10
// exists to retire. Every path below either ships today or becomes legitimate
// when the real read lands, and NONE of them may be forbidden.
const LEGITIMATE_GRAPH_FIXTURE = Object.freeze([
	'../../../../packages/vote-engine/dist/database/schema-sql.js',
	'../../../../packages/vote-engine/dist/database/initialize.js',
	'../../../../packages/vote-engine/src/database/initialize.ts',
	'../../../../packages/vote-engine/dist/user/builders/user-create-builder.js',
	'../../../../packages/web-data/src/public/read-election.js',
	'../../node_modules/@votetorrent/web-data/dist/public/index.js',
	'../../src/engine-preflight.js',
]);
const legitimateFixtureHits = matchForbidden([...LEGITIMATE_GRAPH_FIXTURE]);
if (legitimateFixtureHits.length > 0) {
	fail(
		'module-graph negative control failed — a forbidden-module matcher fired on a module the page legitimately uses: ' +
			legitimateFixtureHits.map((h) => `${h.path} (${h.label})`).join(', ') +
			'. An over-broad matcher here would recreate the very fence this script retired.',
	);
}
ok(
	`module-graph negative control: neither matcher fired on any of the ${LEGITIMATE_GRAPH_FIXTURE.length} legitimate module ` +
		'path(s), including the database lifecycle module the page is allowed to reach.',
);

// ---------------------------------------------------------------------------
// Build.
// ---------------------------------------------------------------------------
const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
if (!existsSync(viteBin)) {
	fail(`vite binary not found at ${viteBin} — run \`yarn install\` first.`);
}

const buildResult = spawnSync(process.execPath, [viteBin, 'build'], {
	encoding: 'utf8',
	cwd: ROOT,
});
if (buildResult.status !== 0) {
	fail(`vite build exited ${buildResult.status}.\n--- captured output ---\n${buildResult.stdout ?? ''}\n${buildResult.stderr ?? ''}`);
}
ok('vite build exited 0.');

if (!existsSync(DIST_ASSETS)) {
	fail(`${DIST_ASSETS} does not exist — the build did not emit the expected assets directory.`);
}

const emittedFiles = walkDist(DIST);
const emittedJs = emittedFiles.filter((f) => f.endsWith('.js'));
if (emittedJs.length === 0) {
	fail(`no .js files found under ${DIST} — the build emitted nothing to scan.`);
}

let concatenatedJs = '';
for (const filePath of emittedJs) {
	concatenatedJs += readFileSync(filePath, 'utf8');
}

// ---------------------------------------------------------------------------
// Real scan, positive half: every derived marker must be present in the
// emitted JavaScript.
// ---------------------------------------------------------------------------
/** @type {Array<{ index: number, marker: string }>} */
const missingMarkers = [];
MARKERS.forEach((marker, index) => {
	if (!concatenatedJs.includes(marker)) {
		missingMarkers.push({ index, marker });
	}
});
if (missingMarkers.length > 0) {
	fail(
		`${missingMarkers.length}/${MARKERS.length} derived marker(s) missing from the emitted JavaScript:\n` +
			missingMarkers.map(({ index }) => `  - marker at derivation index ${index}`).join('\n'),
	);
}
ok(`all ${MARKERS.length} derived marker(s) found in the emitted JavaScript (${emittedJs.length} .js file(s), ${concatenatedJs.length} chars concatenated).`);

// ---------------------------------------------------------------------------
// Real scan, negative half: the MODULE GRAPH, read from the build's own
// sourcemaps.
//
// Note the deliberate contrast with `walkDist` above, which excludes `.map`
// files. That exclusion is about the map's OTHER array — the one holding the
// original text of every module in the graph, prose and all, which is why
// scanning it would report a comment as evidence. This section never touches
// that array. It reads the `sources` list and nothing else: a list of module
// PATHS, carrying no prose, and renamed by no minifier.
// ---------------------------------------------------------------------------
/** @param {string} dir @returns {string[]} every emitted sourcemap. */
function walkSourcemaps(dir) {
	/** @type {string[]} */
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkSourcemaps(full));
			continue;
		}
		if (entry.name.endsWith('.map')) out.push(full);
	}
	return out;
}

const emittedMaps = walkSourcemaps(DIST);
if (emittedMaps.length === 0) {
	fail(
		`no .map file was emitted under ${DIST}. The module-graph scan below cannot run, and would otherwise pass ` +
			"VACUOUSLY — check that `sourcemap` is still enabled in vite.config.ts before assuming this is a build fluke.",
	);
}

/** @type {Set<string>} */
const graphSources = new Set();
for (const mapPath of emittedMaps) {
	/** @type {unknown} */
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(mapPath, 'utf8'));
	} catch (error) {
		fail(`could not parse ${mapPath} as JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	const list = /** @type {{ sources?: unknown }} */ (parsed).sources;
	if (!Array.isArray(list)) {
		fail(`${mapPath} has no "sources" array — the module-graph scan has nothing to read.`);
	}
	for (const entry of /** @type {unknown[]} */ (list)) {
		if (typeof entry === 'string') graphSources.add(entry);
	}
}
if (graphSources.size === 0) {
	fail(`the union of every emitted sourcemap's module-path list is EMPTY across ${emittedMaps.length} map(s) — the scan below would be vacuous.`);
}

const graphPaths = [...graphSources];
const forbiddenHits = matchForbidden(graphPaths);
if (forbiddenHits.length > 0) {
	fail(
		"the anonymous page's bundle reached the officer/privilege surface. Forbidden module(s) in the built graph:\n" +
			forbiddenHits.map((h) => `  - ${h.path}\n      ${h.label}`).join('\n'),
	);
}
ok(
	`module-graph negative: neither the privilege primitive nor the officer read surface appears among the ` +
		`${graphPaths.length} module path(s) in the built graph (${emittedMaps.length} sourcemap(s)).`,
);

// Positive, so the scan above cannot pass by reading an empty or wrong list.
const missingRequired = REQUIRED_GRAPH_MODULES.filter(({ re }) => !graphPaths.some((p) => re.test(p)));
if (missingRequired.length > 0) {
	fail(
		'the module-path list is not the list this scan believes it is — it is missing module(s) known to be in this build: ' +
			missingRequired.map((m) => m.label).join(', ') +
			'. Treat the negative result above as unproven until this is explained.',
	);
}
ok(
	`module-graph positive: the built graph contains ${REQUIRED_GRAPH_MODULES.map((m) => m.label).join(' and ')} — ` +
		'the scan read the real list.',
);

ok('proven: the schema reaches the built bundle, and the privilege/officer surface does not reach the built module graph.');
process.exit(0);
