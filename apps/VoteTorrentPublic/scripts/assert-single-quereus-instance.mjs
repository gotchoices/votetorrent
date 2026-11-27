#!/usr/bin/env node
/**
 * assert-single-quereus-instance.mjs — the artefact-level proof of the
 * precondition 54-03a placed on this phase and 54-11 discharged: exactly ONE
 * on-disk copy of `@quereus/quereus`, and exactly one of
 * `@quereus/plugin-indexeddb`, reaches the public app's built bundle.
 *
 * WHY THIS EXISTS EVEN THOUGH THE BUILD IS GREEN. `.yarnrc.yml` sets
 * `nmHoistingLimits: workspaces`, so nothing is hoisted and
 * `packages/web-data` and this app each own a PHYSICAL COPY of the engine. A
 * second copy means a second `Database` CLASS IDENTITY and a second plugin
 * registry: plugin registration, or an `instanceof` boundary between the
 * handle the data package opens and the code that declares a schema onto it,
 * fails — and it fails IN A BUILD THAT STILL EXITS 0. That is the measured
 * spike-089 signature (a duplicate React was harmless for a zero-hook
 * component and dropped the same control from 18/18 to 8/12 once one
 * `useState` was involved, in a build that exited 0), one stack down. A green
 * build is therefore explicitly NOT accepted as evidence here, and neither is
 * a green `app-shape.test.mjs`: `resolve.dedupe` is a CONFIG INTENT, and this
 * script measures the ARTEFACT.
 *
 * WHY A SOURCEMAP AND NOT A BUNDLE GREP. esbuild renames bare local bindings,
 * so a `typeof` probe on a minified identifier is falsely inert (this repo has
 * measured that: a dist-level negative control must mutate a symbol in an
 * object-literal property-key position to survive minification at all). And a
 * string-literal probe cannot distinguish ONE copy from TWO — both bundles
 * contain the same literals. A sourcemap's `sources` array is the only place
 * in a built artefact where two physical copies are distinguishable: the
 * entries are real on-disk paths and are not minified.
 *
 * Follows `assert-no-node-polyfills.mjs`'s house shape: every control runs
 * BEFORE the build, and every control exercises the SAME analysis function the
 * real check uses, so a control that passes is really exercising the real
 * pipeline rather than a look-alike written beside it.
 *
 * Standalone Node script, no new dependencies.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const PREFIX = '[assert-single-quereus]';
const ROOT = process.cwd();

/**
 * 56-02: two OPTIONAL CLI flags, additive only — same contract as
 * `assert-no-node-polyfills.mjs`'s. When neither is passed, argv and paths
 * are BYTE-IDENTICAL to before this change.
 * @param {string} name
 */
function getFlag(name) {
	const idx = process.argv.indexOf(name);
	return idx === -1 ? undefined : process.argv[idx + 1];
}
const BUILD_CONFIG = getFlag('--build-config');
const DIST_DIRNAME = getFlag('--dist') ?? 'dist';
const DIST_ASSETS = path.join(ROOT, DIST_DIRNAME, 'assets');

/** The two packages the single-instance obligation names. @type {ReadonlyArray<string>} */
const WATCHED_PACKAGES = Object.freeze(['@quereus/quereus', '@quereus/plugin-indexeddb']);

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
 * THE ANALYSIS. Resolve every sourcemap `sources` entry against the map's own
 * directory, then collect the distinct PACKAGE ROOTS — the prefix up to and
 * including the last `node_modules/<pkg>` segment. Resolving first is what
 * makes two different relative prefixes that denote the SAME directory count
 * once, and two that denote different directories count twice.
 *
 * @param {ReadonlyArray<string>} sources
 * @param {string} mapDir absolute directory the relative sources resolve against
 * @param {string} pkg e.g. '@quereus/quereus'
 * @returns {{ matched: number, roots: string[] }}
 */
export function analyzeSources(sources, mapDir, pkg) {
	const needle = path.join('node_modules', pkg);
	/** @type {Set<string>} */
	const roots = new Set();
	let matched = 0;
	for (const raw of sources ?? []) {
		if (typeof raw !== 'string') continue;
		const resolved = path.resolve(mapDir, raw);
		const at = resolved.lastIndexOf(needle);
		if (at === -1) continue;
		matched += 1;
		roots.add(resolved.slice(0, at + needle.length));
	}
	return { matched, roots: [...roots].sort() };
}

/**
 * THE PREDICATE, shared by the controls and by the real check. Empty means the
 * package reached the bundle from exactly one place.
 *
 * Two conditions, and the ANTI-VACUITY one is the load-bearing half: a
 * zero-match result means the engine never reached the bundle at all, and a
 * naive "at most one root" check would then PASS while proving nothing — which
 * is precisely how a stubbed `DEFAULT_PUBLIC_SOURCE` would slip past this
 * gate (53-D07's failure mode: clean imports, every gate green, false words).
 *
 * @param {string} pkg
 * @param {{ matched: number, roots: string[] }} result
 * @returns {string[]}
 */
export function problemsFor(pkg, result) {
	/** @type {string[]} */
	const problems = [];
	if (result.matched === 0) {
		problems.push(
			`no source under node_modules/${pkg} reached the bundle at all. This check is ANTI-VACUOUS on purpose: ` +
				'zero matches is not "one copy", it is "the engine never arrived", and a gate that passes on an absent ' +
				'subject proves nothing about a present one.',
		);
	}
	if (result.roots.length > 1) {
		problems.push(
			`${result.roots.length} distinct on-disk roots of ${pkg} reached the bundle:\n  ${result.roots.join('\n  ')}\n` +
				'A second copy is a second class identity and a second plugin registry. Add the package to ' +
				"`resolve.dedupe` in vite.config.ts AND declare it in this app's package.json — dedupe resolves its " +
				'entries from the project root, so an entry naming a package the app does not declare resolves to nothing.',
		);
	}
	return problems;
}

// A gate whose output cannot tell you WHAT it looked at is a gate whose
// greens cannot be quoted. Print the effective dist directory and build
// config before any check runs.
process.stdout.write(
	`${PREFIX} INFO: examining dist directory "${DIST_DIRNAME}" (${path.join(ROOT, DIST_DIRNAME)}), build config: ` +
		`${BUILD_CONFIG ?? 'default (vite.config.ts)'}.\n`,
);

// ---------------------------------------------------------------------------
// 1. Controls, BEFORE the build. Each one runs the real `analyzeSources` and
//    the real `problemsFor`, never a look-alike.
// ---------------------------------------------------------------------------
const CONTROL_DIR = DIST_ASSETS;

/** Two distinct roots — the exact failure this gate exists to catch. */
const TWO_ROOT_FIXTURE = [
	'../../node_modules/@quereus/quereus/dist/src/core/database.js',
	'../../node_modules/@quereus/quereus/dist/src/common/errors.js',
	'../../../../packages/web-data/node_modules/@quereus/quereus/dist/src/core/database.js',
];
const twoRoot = analyzeSources(TWO_ROOT_FIXTURE, CONTROL_DIR, '@quereus/quereus');
if (twoRoot.roots.length !== 2) {
	fail(`positive control: a two-root fixture was reported as ${twoRoot.roots.length} root(s) — the analysis cannot see a duplicate copy.`);
}
if (problemsFor('@quereus/quereus', twoRoot).length === 0) {
	fail('positive control: the predicate accepted a two-root fixture — this gate cannot fail and therefore proves nothing.');
}

/** Many files, one root — a matcher that fires on everything discriminates nothing. */
const ONE_ROOT_FIXTURE = [
	'../../node_modules/@quereus/quereus/dist/src/core/database.js',
	'../../node_modules/@quereus/quereus/dist/src/common/errors.js',
	'../../node_modules/@quereus/quereus/dist/src/planner/builder.js',
	'../../node_modules/react/index.js',
];
const oneRoot = analyzeSources(ONE_ROOT_FIXTURE, CONTROL_DIR, '@quereus/quereus');
if (oneRoot.roots.length !== 1) {
	fail(`benign control: a single-root fixture was reported as ${oneRoot.roots.length} root(s) — the analysis over-counts.`);
}
if (problemsFor('@quereus/quereus', oneRoot).length !== 0) {
	fail(`benign control: the predicate rejected a legitimate single-root fixture: ${problemsFor('@quereus/quereus', oneRoot).join(' / ')}`);
}

/** No engine at all — must be reported as ZERO and must FAIL on anti-vacuity. */
const NO_ENGINE_FIXTURE = ['../../node_modules/react/index.js', '../../src/main.tsx'];
const noEngine = analyzeSources(NO_ENGINE_FIXTURE, CONTROL_DIR, '@quereus/quereus');
if (noEngine.matched !== 0 || noEngine.roots.length !== 0) {
	fail(`inertness control: a fixture with no engine sources reported ${noEngine.matched} match(es) and ${noEngine.roots.length} root(s).`);
}
const noEngineProblems = problemsFor('@quereus/quereus', noEngine);
if (noEngineProblems.length === 0 || !noEngineProblems[0].includes('never arrived')) {
	fail('inertness control: the predicate PASSED a bundle containing no engine at all — the anti-vacuity half is missing.');
}

ok(
	'3 controls observed firing: the two-root positive control reported 2 and was rejected, the one-root benign control ' +
		'reported 1 and was accepted, and the no-engine inertness control reported 0 and was rejected on anti-vacuity.',
);

// ---------------------------------------------------------------------------
// 2. Build. `vite.config.ts` sets `build.sourcemap: true`, which this whole
//    script depends on — an absent map is a hard failure, never a skip.
// ---------------------------------------------------------------------------
const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
if (!existsSync(viteBin)) {
	fail(`vite binary not found at ${viteBin} — run \`yarn install\` first.`);
}
const viteBuildArgs = [viteBin, 'build'];
if (BUILD_CONFIG) viteBuildArgs.push('--config', BUILD_CONFIG);
const build = spawnSync(process.execPath, viteBuildArgs, { encoding: 'utf8', cwd: ROOT });
if (build.status !== 0) {
	fail(`vite build exited ${build.status}.\n--- captured output ---\n${build.stdout ?? ''}\n${build.stderr ?? ''}`);
}
ok('vite build exited 0.');

// ---------------------------------------------------------------------------
// 3. The real check, over every emitted sourcemap.
// ---------------------------------------------------------------------------
if (!existsSync(DIST_ASSETS)) {
	fail(`${DIST_ASSETS} does not exist — the build emitted no assets directory to scan.`);
}
const mapFiles = readdirSync(DIST_ASSETS)
	.filter((name) => name.endsWith('.js.map'))
	.map((name) => path.join(DIST_ASSETS, name));

if (mapFiles.length === 0) {
	fail(
		`no *.js.map under ${DIST_ASSETS}. This script reads sourcemaps because they are the only place in a built ` +
			'artefact where two physical copies of a package are distinguishable — check that vite.config.ts still sets ' +
			'`build.sourcemap: true`. An absent map is a hard failure, never a skip.',
	);
}

/** @type {string[]} */
const allProblems = [];
for (const pkg of WATCHED_PACKAGES) {
	/** @type {Set<string>} */
	const roots = new Set();
	let matched = 0;
	for (const mapFile of mapFiles) {
		/** @type {any} */
		let map;
		try {
			map = JSON.parse(readFileSync(mapFile, 'utf8'));
		} catch {
			fail(`${mapFile} is not parseable JSON — a sourcemap this script cannot read is a failure, not a skip.`);
		}
		const result = analyzeSources(map.sources, path.dirname(mapFile), pkg);
		matched += result.matched;
		for (const root of result.roots) roots.add(root);
	}
	const combined = { matched, roots: [...roots].sort() };
	const problems = problemsFor(pkg, combined);
	info(
		`${pkg}: ${combined.matched} matched source(s), ${combined.roots.length} distinct on-disk root(s)` +
			(combined.roots.length > 0 ? ` -> ${combined.roots.map((r) => path.relative(path.join(ROOT, '..', '..'), r)).join(', ')}` : ''),
	);
	allProblems.push(...problems);
}

if (allProblems.length > 0) {
	fail(`the built bundle does not carry exactly one copy of each watched package:\n- ${allProblems.join('\n- ')}`);
}

ok(
	`${mapFiles.length} sourcemap(s) scanned — each of ${WATCHED_PACKAGES.join(' and ')} reached the bundle from exactly ` +
		'ONE on-disk root, with a non-zero matched-source count.',
);
process.exit(0);
