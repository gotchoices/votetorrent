#!/usr/bin/env node
/**
 * assert-libp2p-closure.mjs — the RESEARCH Assumption A2 verdict instrument
 * (56-02, Wave 1).
 *
 * A2: "libp2p's transitive dependency closure bundles cleanly under Vite for
 * a browser target" — explicitly UNVERIFIED in `56-RESEARCH.md` before this
 * script exists. As of the 2026-09-04 outline amendment, the closure under
 * test is SEVEN packages, not five: the five libp2p/optimystic originals
 * plus `@serfab/quereus-plugin-sereus` and `@serfab/cadre-core` — the two
 * packages behind the strand read path `56-16` (Wave 4) will build. This
 * script settles the bundling question for all seven, in Wave 1, so a
 * `node:`-only transitive dependency cannot be discovered four waves late.
 *
 * Builds `libp2p-closure-probe.js` (the real import site, Task 2) via
 * `vite.closure.config.ts`, then runs the same house-shape checks
 * `assert-no-node-polyfills.mjs` and `assert-single-quereus-instance.mjs`
 * already established for this app, PLUS an anti-vacuity presence check
 * over the widened seven-package set and a cross-build sentinel control.
 *
 * WHY THE REGEXES AND `stripCommentLines` ARE DUPLICATED, NOT IMPORTED. Both
 * sibling scripts (`assert-no-node-polyfills.mjs`,
 * `assert-single-quereus-instance.mjs`) run their whole pipeline at module
 * scope and end in `process.exit` — importing either would EXECUTE it. So
 * this file copies the matcher definitions rather than importing them. Do
 * not "fix" this duplication into an import; doing so detonates the script
 * that imports it.
 *
 * IF A2 COMES BACK NEGATIVE, this is a SUCCESSFUL outcome, not a bug in this
 * script. Do not add a polyfill, alias, define or shim to make it pass — see
 * `56-02-PLAN.md` § "IF A2 COMES BACK NEGATIVE" for the five items the
 * record must then carry.
 *
 * Standalone Node script, no new dependency.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const PREFIX = '[assert-libp2p-closure]';
const ROOT = process.cwd();
const DIST_CLOSURE = path.join(ROOT, 'dist-closure');
const DIST_CLOSURE_ASSETS = path.join(DIST_CLOSURE, 'assets');
const DIST = path.join(ROOT, 'dist');

/** The seven packages this plan widened the closure to. Order matches the
 * plan's own enumeration throughout `56-02-PLAN.md`.
 * @type {ReadonlyArray<string>} */
const WATCHED_PACKAGES = Object.freeze([
	'@optimystic/db-p2p',
	'@optimystic/db-core',
	'@optimystic/db-p2p-storage-web',
	'@libp2p/websockets',
	'@libp2p/crypto',
	'@serfab/quereus-plugin-sereus',
	'@serfab/cadre-core',
]);

/**
 * The exact sentinel `libp2p-closure-probe.js` publishes as a quoted
 * object-literal PROPERTY KEY. Defined ONCE, referenced everywhere else
 * through this constant — the self-tripping-checker discipline
 * (`project_self_tripping_checker_headers`, three recurrences in Phase 53)
 * requires this script's own comments not to requote the literal outside
 * this single definition.
 */
const SENTINEL = 'vtx-libp2p-closure-probe';

// ---------------------------------------------------------------------------
// Matchers — duplicated verbatim in shape from
// `scripts/assert-no-node-polyfills.mjs`. See that file's own header for the
// full rationale of each; not re-derived here.
// ---------------------------------------------------------------------------
const NODE_TOKEN_RE = /["'`]node:[a-z_]+(\/[a-z_-]+)*["'`]/;
const REQUIRE_TOKEN_RE = /require\(\s*["'](crypto|fs|path|buffer|stream)["']\s*\)/;
const ENV_READ_RE = /import\.meta\.env\b/;

/** @param {string} source */
function stripCommentLines(source) {
	return source
		.split('\n')
		.filter((line) => {
			const trimmed = line.trim();
			return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
		})
		.join('\n');
}

/** @param {string} message */
function fail(message) {
	process.stderr.write(`${PREFIX} FAIL: ${message}\n`);
	process.exit(1);
}

/** @param {string} message */
function ok(message) {
	process.stdout.write(`${PREFIX} OK: ${message}\n`);
}

/** @param {string} message */
function info(message) {
	process.stdout.write(`${PREFIX} INFO: ${message}\n`);
}

/**
 * Every TEXT artefact a build emits, anywhere under `dir` — `.map` files
 * DELIBERATELY excluded (a source map embeds original sources, including
 * files that merely DISCUSS a `node:` specifier in prose; what ships and
 * executes is the `.js`/`.mjs`/`.cjs`/`.html`/`.css`).
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
// THE PRESENCE ANALYSIS — the anti-vacuity engine shared by the section-1
// synthetic control and the real section-5 check. Resolve every sourcemap
// `sources` entry against the map's own directory, then collect the
// distinct PACKAGE ROOTS (the prefix up to and including the last
// `node_modules/<pkg>` segment) — the same discipline
// `assert-single-quereus-instance.mjs`'s `analyzeSources` established.
// ---------------------------------------------------------------------------
/**
 * @param {ReadonlyArray<{ sources: ReadonlyArray<unknown> | undefined, mapDir: string }>} sourceEntries
 * @param {string} pkg
 * @returns {{ matched: number, roots: string[], sources: string[] }}
 */
function analyzePackage(sourceEntries, pkg) {
	const needle = path.join('node_modules', pkg);
	/** @type {Set<string>} */
	const roots = new Set();
	/** @type {string[]} */
	const matchedSources = [];
	for (const { sources, mapDir } of sourceEntries) {
		for (const raw of sources ?? []) {
			if (typeof raw !== 'string') continue;
			const resolved = path.resolve(mapDir, raw);
			const at = resolved.lastIndexOf(needle);
			if (at === -1) continue;
			matchedSources.push(resolved);
			roots.add(resolved.slice(0, at + needle.length));
		}
	}
	return { matched: matchedSources.length, roots: [...roots].sort(), sources: matchedSources };
}

/**
 * @param {ReadonlyArray<{ sources: ReadonlyArray<unknown> | undefined, mapDir: string }>} sourceEntries
 * @param {ReadonlyArray<string>} packages
 * @returns {Map<string, { matched: number, roots: string[], sources: string[] }>}
 */
function presenceForAll(sourceEntries, packages) {
	/** @type {Map<string, { matched: number, roots: string[], sources: string[] }>} */
	const map = new Map();
	for (const pkg of packages) map.set(pkg, analyzePackage(sourceEntries, pkg));
	return map;
}

/** @param {Map<string, { matched: number }>} presenceMap @returns {string[]} */
function missingPackages(presenceMap) {
	return [...presenceMap.entries()].filter(([, r]) => r.matched === 0).map(([pkg]) => pkg);
}

/** @param {string[]} missing @returns {string} */
function formatMissingMessage(missing) {
	return (
		`zero sourcemap matches for: ${missing.join(', ')}. This check is ANTI-VACUOUS on purpose: zero matches ` +
		'is not "clean", it is "the package never arrived", and a scan that passes on an absent subject proves ' +
		'nothing about a present one.'
	);
}

// ---------------------------------------------------------------------------
// 1. Controls, BEFORE any build.
// ---------------------------------------------------------------------------

/** One fixture per matcher — reused verbatim from `assert-no-node-polyfills.mjs`.
 * @type {ReadonlyArray<readonly [string, RegExp, string]>} */
const POSITIVE_CONTROLS = /** @type {ReadonlyArray<readonly [string, RegExp, string]>} */ ([
	['node:crypto (the original enumerated builtin)', NODE_TOKEN_RE, 'import c from "node:crypto";'],
	['node:worker_threads (outside the old eight-builtin list)', NODE_TOKEN_RE, 'import w from "node:worker_threads";'],
	['node:http (outside the old eight-builtin list)', NODE_TOKEN_RE, 'const h = await import("node:http");'],
	['bare require of a builtin', REQUIRE_TOKEN_RE, 'const fs = require("fs");'],
	['env read, dotted VITE_ member', ENV_READ_RE, 'const u = import.meta.env.VITE_ENDPOINT;'],
	['env read, computed member access', ENV_READ_RE, "const u = import.meta.env['VITE_ENDPOINT'];"],
	['env read, destructured', ENV_READ_RE, 'const { VITE_ENDPOINT } = import.meta.env;'],
	['env read, aliased', ENV_READ_RE, 'const env = import.meta.env;'],
]);
for (const [label, matcher, fixture] of POSITIVE_CONTROLS) {
	if (!matcher.test(fixture)) {
		fail(`matcher is inert — the "${label}" positive-control fixture did not match. This gate cannot detect a real regression until the matcher is fixed.`);
	}
}

/** A matcher that fires on everything discriminates nothing — includes the
 * exact minified shape the sibling gate already measured in this app's own
 * bundle: `node` as an object-literal property name, not a module specifier. */
const BENIGN_FIXTURES = [
	'const o = { node: 1 };',
	'const u = "https://example.test/node/1";',
	'if(h<=p&&S>=p)return{node:w,offset:p-h};',
];
for (const benign of BENIGN_FIXTURES) {
	if (NODE_TOKEN_RE.test(benign)) {
		fail(`matcher is indiscriminate — NODE_TOKEN_RE matched the benign fixture ${JSON.stringify(benign)}.`);
	}
}

const ENV_BENIGN_FIXTURES = [
	'const env = process.env.NODE_ENV;',
	'const meta = { import: { meta: "x" } };',
	'// import.meta.env is read elsewhere, not here',
	'const url = new URL(import.meta.url);',
];
for (const benign of ENV_BENIGN_FIXTURES) {
	const stripped = stripCommentLines(benign);
	if (ENV_READ_RE.test(stripped)) {
		fail(`matcher is indiscriminate — ENV_READ_RE matched the benign fixture ${JSON.stringify(benign)}.`);
	}
}

ok(
	`${POSITIVE_CONTROLS.length} positive control(s) matched, ${BENIGN_FIXTURES.length} NODE_TOKEN_RE benign fixture(s) and ` +
		`${ENV_BENIGN_FIXTURES.length} ENV_READ_RE benign fixture(s) did not — matchers are live and discriminating.`,
);

/**
 * THE SYNTHETIC SIX-OF-SEVEN SOURCEMAP CONTROL. A presence check that has
 * never reported an absence has never been shown to be able to. This control
 * runs the REAL `analyzePackage`/`presenceForAll` (never a look-alike) over a
 * synthetic `sources` array naming six of the seven package roots, and
 * requires the analysis to report exactly the SEVENTH as missing — by name,
 * not merely as a count.
 *
 * `@serfab/cadre-core` is the omitted package here (an arbitrary but fixed
 * choice); the other six each get exactly one synthetic source.
 */
const SIX_OF_SEVEN_MAP_DIR = path.join(ROOT, 'dist-closure', 'assets');
const SIX_OF_SEVEN_SOURCES = [
	'../../node_modules/@optimystic/db-p2p/dist/src/rn.js',
	'../../node_modules/@optimystic/db-core/dist/src/cohort-topic/tiers.js',
	'../../node_modules/@optimystic/db-p2p-storage-web/dist/src/db.js',
	'../../node_modules/@libp2p/websockets/dist/src/index.js',
	'../../node_modules/@libp2p/crypto/dist/src/keys/index.js',
	'../../node_modules/@serfab/quereus-plugin-sereus/dist/connect.js',
];
const sixOfSevenPresence = presenceForAll([{ sources: SIX_OF_SEVEN_SOURCES, mapDir: SIX_OF_SEVEN_MAP_DIR }], WATCHED_PACKAGES);
const sixOfSevenMissing = missingPackages(sixOfSevenPresence);
if (sixOfSevenMissing.length !== 1 || sixOfSevenMissing[0] !== '@serfab/cadre-core') {
	fail(
		`positive control: the six-of-seven synthetic sourcemap fixture reported missing=[${sixOfSevenMissing.join(', ')}], ` +
			"expected exactly ['@serfab/cadre-core'] — the presence check cannot report a single absence correctly.",
	);
}
const sixOfSevenMessage = formatMissingMessage(sixOfSevenMissing);
if (!sixOfSevenMessage.includes('@serfab/cadre-core')) {
	fail('positive control: the missing-package message does not name the specific missing package — a count alone is not specific.');
}
for (const pkg of WATCHED_PACKAGES) {
	if (pkg === '@serfab/cadre-core') continue;
	const result = sixOfSevenPresence.get(pkg);
	if (!result || result.matched === 0) {
		fail(`positive control: the six-of-seven fixture unexpectedly reports zero matches for ${pkg}, which the fixture DOES include.`);
	}
}
ok('positive control: six-of-seven synthetic sourcemap fixture correctly reports exactly @serfab/cadre-core as absent, by name.');

// ---------------------------------------------------------------------------
// 2. Build the closure via `vite.closure.config.ts`.
// ---------------------------------------------------------------------------
const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
if (!existsSync(viteBin)) {
	fail(`vite binary not found at ${viteBin} — run \`yarn install\` first.`);
}

const closureBuild = spawnSync(process.execPath, [viteBin, 'build', '--config', 'vite.closure.config.ts'], {
	encoding: 'utf8',
	cwd: ROOT,
});
const closureOutput = `${closureBuild.stdout ?? ''}\n${closureBuild.stderr ?? ''}`;

if (closureBuild.status !== 0) {
	fail(
		'vite build --config vite.closure.config.ts exited ' +
			`${closureBuild.status}. THIS IS A RECORDED A2 FAILURE — no polyfill, alias, define or shim will be ` +
			`attempted as a remedy.\n--- captured output ---\n${closureOutput}`,
	);
}
ok('vite build --config vite.closure.config.ts exited 0.');

// ---------------------------------------------------------------------------
// 3. Vite's own externalization warning — the single most likely shape an A2
//    failure would take.
// ---------------------------------------------------------------------------
if (closureOutput.includes('has been externalized for browser compatibility')) {
	fail(
		'vite build output contains "has been externalized for browser compatibility" — a Node builtin reached the ' +
			`closure's browser module graph.\n--- captured output ---\n${closureOutput}`,
	);
}
ok('no "externalized for browser compatibility" warning in the closure build output.');

// ---------------------------------------------------------------------------
// 4. Artifact scan — the WHOLE dist-closure/ output, not just the entry
//    chunk. `@serfab/quereus-plugin-sereus`'s `dist/connect.js:20` performs a
//    dynamic `import('@optimystic/db-p2p')`, and Rollup emits a dynamic
//    import as a SEPARATE chunk — a scan that only looked at the entry would
//    be blind to the most likely offender the widening introduces.
// ---------------------------------------------------------------------------
if (!existsSync(DIST_CLOSURE)) {
	fail(`${DIST_CLOSURE} does not exist — the closure build did not emit the expected output directory.`);
}
const closureFiles = walkDist(DIST_CLOSURE);
if (closureFiles.length === 0) {
	fail(`no shippable file found under ${DIST_CLOSURE} — the closure build emitted nothing to scan.`);
}

for (const filePath of closureFiles) {
	const contents = stripCommentLines(readFileSync(filePath, 'utf8'));

	const nodeTokenMatch = contents.match(NODE_TOKEN_RE);
	if (nodeTokenMatch) {
		fail(`${filePath} contains the Node builtin token "${nodeTokenMatch[0]}".`);
	}
	const requireMatch = contents.match(REQUIRE_TOKEN_RE);
	if (requireMatch) {
		fail(`${filePath} contains a bare require() of a Node builtin: "${requireMatch[0]}".`);
	}
	const envMatch = contents.match(ENV_READ_RE);
	if (envMatch) {
		fail(`${filePath} contains "${envMatch[0]}" — a build-time value baked into the closure artefact.`);
	}
}
ok(`scanned ${closureFiles.length} emitted text file(s) under dist-closure/ (.map excluded) — no Node builtin, bare require or env read found.`);

// ---------------------------------------------------------------------------
// 5. Anti-vacuity presence check — every sourcemap under dist-closure/assets,
//    every one of the seven packages must have at least one match.
// ---------------------------------------------------------------------------
if (!existsSync(DIST_CLOSURE_ASSETS)) {
	fail(`${DIST_CLOSURE_ASSETS} does not exist — the closure build emitted no assets directory to scan.`);
}
const mapFiles = readdirSync(DIST_CLOSURE_ASSETS)
	.filter((name) => name.endsWith('.js.map'))
	.map((name) => path.join(DIST_CLOSURE_ASSETS, name));

if (mapFiles.length === 0) {
	fail(
		`no *.js.map under ${DIST_CLOSURE_ASSETS}. The presence check reads sourcemaps because they are the only place ` +
			'in a built artefact where two physical copies (or the absence) of a package are distinguishable — check ' +
			'that vite.closure.config.ts still inherits build.sourcemap: true from vite.config.ts.',
	);
}

const closureSourceEntries = mapFiles.map((mapFile) => {
	/** @type {any} */
	let map;
	try {
		map = JSON.parse(readFileSync(mapFile, 'utf8'));
	} catch {
		fail(`${mapFile} is not parseable JSON — a sourcemap this script cannot read is a failure, not a skip.`);
	}
	return { sources: map.sources, mapDir: path.dirname(mapFile) };
});

const presence = presenceForAll(closureSourceEntries, WATCHED_PACKAGES);
for (const [pkg, result] of presence) {
	info(
		`${pkg}: ${result.matched} matched source(s), ${result.roots.length} distinct on-disk root(s)` +
			(result.roots.length > 0 ? ` -> ${result.roots.map((r) => path.relative(path.join(ROOT, '..', '..'), r)).join(', ')}` : ''),
	);
}

// INFO-only, per-widening reporting requirement: whether @serfab/quereus-plugin-sereus's
// matched sources include the 4.48 MB plugin-browser.js pre-bundle. It must
// not — if it does, that is recorded as a genuine finding, not aliased away.
const sereusResult = presence.get('@serfab/quereus-plugin-sereus');
const sereusHasPluginBrowser = (sereusResult?.sources ?? []).some((s) => s.endsWith(path.join('dist', 'plugin-browser.js')));
if (sereusHasPluginBrowser) {
	fail(
		'@serfab/quereus-plugin-sereus matched sources include dist/plugin-browser.js — the 4.48 MB pre-bundle that ' +
			'inlines most of the libp2p stack. An export condition silently swapped the entry. This is a genuine ' +
			'finding to record, not to alias around.',
	);
}
info('@serfab/quereus-plugin-sereus matched sources do NOT include dist/plugin-browser.js (expected — the probe imports the package root only).');

const missing = missingPackages(presence);
if (missing.length > 0) {
	fail(formatMissingMessage(missing));
}
ok(`${mapFiles.length} sourcemap(s) scanned — all seven watched packages reached the closure artefact with a non-zero matched-source count.`);

// ---------------------------------------------------------------------------
// 6. Cross-build sentinel control. A second, production `vite build` (default
//    config, dist/), then require the sentinel PRESENT in dist-closure/ and
//    ABSENT from dist/. Same discipline as
//    `assert-no-test-harness-in-dist.mjs`'s dist/dist-gate presence control;
//    that script is NOT edited here — this control belongs beside the
//    artefact it is about.
// ---------------------------------------------------------------------------
const prodBuild = spawnSync(process.execPath, [viteBin, 'build'], { encoding: 'utf8', cwd: ROOT });
if (prodBuild.status !== 0) {
	fail(
		`production vite build (no --config) exited ${prodBuild.status} — needed for the cross-build sentinel control.\n` +
			`--- captured output ---\n${prodBuild.stdout ?? ''}\n${prodBuild.stderr ?? ''}`,
	);
}
ok('production vite build (no --config) exited 0 (cross-build sentinel control).');

if (!existsSync(DIST)) {
	fail(`${DIST} does not exist after the production build — the cross-build sentinel control needs it.`);
}
const prodFiles = walkDist(DIST);

const sentinelRe = new RegExp(SENTINEL);
const closureSentinelHit = closureFiles.some((f) => sentinelRe.test(readFileSync(f, 'utf8')));
if (!closureSentinelHit) {
	fail(`the sentinel was not found anywhere in dist-closure/ — the cross-build control cannot prove the matcher sees anything.`);
}
const prodSentinelHit = prodFiles.some((f) => sentinelRe.test(readFileSync(f, 'utf8')));
if (prodSentinelHit) {
	fail('the sentinel was found in production dist/ — the closure probe leaked into the shipped public bundle.');
}
ok('cross-build sentinel control: present in dist-closure/, absent from production dist/.');

// ---------------------------------------------------------------------------
// 7. INFO only — module count and raw emitted size for dist-closure/. No
//    comparison bar, no threshold, no failure path on any size figure.
// ---------------------------------------------------------------------------
const moduleCountMatch = closureOutput.match(/transforming\.\.\.\s*\n?.*?(\d+)\s+modules? transformed/s);
const moduleCount = moduleCountMatch ? moduleCountMatch[1] : 'unknown';
let closureBytes = 0;
for (const f of closureFiles) {
	if (f.endsWith('.js')) closureBytes += statSync(f).size;
}
info(
	`dist-closure/: modules transformed = ${moduleCount}, emitted size = ${(closureBytes / 1024).toFixed(0)} KB ` +
		'(raw, not gzip) — informational only, no threshold, no comparison bar.',
);

ok('A2 VERDICT: POSITIVE — the seven-package closure, including connectToStrand/StrandDatabase, bundles cleanly.');
process.exit(0);
