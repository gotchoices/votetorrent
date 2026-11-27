#!/usr/bin/env node
/**
 * assert-tokens-in-dist.mjs — the D-15/D-23 post-build bytes-in-dist gate.
 *
 * Proves the 34 design-token NAMES declared in `packages/ui-web/src/tokens.css`
 * reached the dashboard's built production CSS, i.e. that the canonical
 * `@import '@votetorrent/ui-web/tokens.css';` in `app.css` actually resolved and the
 * package stylesheet was inlined by Vite.
 *
 * IT PROVES NOTHING ABOUT WHETHER THOSE TOKENS RESOLVE TO THEIR DECLARED VALUES IN A
 * BROWSER. That is 53-08's D-23 probe — `getComputedStyle` is never called anywhere in
 * this script. A green run here must never be read as token coverage; it is only
 * evidence that the import's bytes made it into the shipped bundle. It IS nonetheless
 * a real, discriminating check: it goes red the moment the import is dropped.
 *
 * Requires a prior `vite build` — this is a post-build check, not a tier-1 one, and is
 * therefore not wired into `test:node` (that would make tier 1 depend on a build
 * artifact).
 *
 * Runs its own positive control FIRST, mirroring assert-no-node-polyfills.mjs's
 * structure. Standalone Node script, no new dependencies.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { uiWebSrc } from '../../../scripts/lib/source-paths.mjs';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');
const DIST_ASSETS = path.join(DIST, 'assets');

/** @param {string} message */
function fail(message) {
	process.stderr.write(`[assert-tokens-in-dist] FAIL: ${message}\n`);
	process.exit(1);
}

/** @param {string} message */
function ok(message) {
	process.stdout.write(`[assert-tokens-in-dist] OK: ${message}\n`);
}

/**
 * Extracts custom-property NAMES from a `tokens.css`-shaped source: a tab-indented
 * declaration line, name group only (never the value — dist CSS is minified and
 * re-serialises values, so only presence-of-name is checked here).
 * @param {string} source
 * @returns {string[]}
 */
function extractTokenNames(source) {
	const matches = [...source.matchAll(/^\t(--[a-z0-9-]+): .+;$/gm)];
	return matches.map((m) => m[1]);
}

/**
 * A name is "present" in the dist CSS only as a DECLARATION (`<name>:`), never merely
 * as a substring — a comment or an unrelated token sharing a prefix must not count.
 * @param {string} name
 * @param {string} distCss
 * @returns {boolean}
 */
function nameDeclaredIn(name, distCss) {
	return distCss.includes(`${name}:`);
}

// ---------------------------------------------------------------------------
// 1. Positive control — the extractor and the dist-side matcher must be shown
//    discriminating BEFORE they are trusted against the real build. A matcher
//    that has not been seen firing in both directions is not trusted.
// ---------------------------------------------------------------------------
{
	const fixture = ':root {\n\t--fixture-token: 1px;\n}\n';
	const names = extractTokenNames(fixture);
	if (names.length !== 1 || names[0] !== '--fixture-token') {
		fail(`extractor positive control failed — expected exactly ["--fixture-token"], got ${JSON.stringify(names)}`);
	}

	const benignFixture = '.layout {\n\tgap: var(--space-md);\n}\n';
	const benignNames = extractTokenNames(benignFixture);
	if (benignNames.length !== 0) {
		fail(`extractor benign control failed — a var(--...) REFERENCE must not be extracted as a declared name, got ${JSON.stringify(benignNames)}`);
	}

	const distFixturePresent = '.x{--fixture-token:1px}';
	if (!nameDeclaredIn('--fixture-token', distFixturePresent)) {
		fail('dist-side matcher positive control failed — a planted name was not detected as present');
	}
	const distFixtureAbsent = '.x{--another-token:1px}';
	if (nameDeclaredIn('--fixture-token', distFixtureAbsent)) {
		fail('dist-side matcher benign control failed — reported an absent name as present');
	}
}
ok('positive + benign controls passed — the name extractor and the dist-side matcher both discriminate.');

// ---------------------------------------------------------------------------
// 2. Read the names out of packages/ui-web/src/tokens.css itself. Never a
//    second hard-coded list here — that is exactly the drift D-23 forbids.
// ---------------------------------------------------------------------------
const tokensCssPath = uiWebSrc('tokens.css');
if (!existsSync(tokensCssPath)) {
	fail(`${tokensCssPath} does not exist.`);
}
const tokensCssSource = readFileSync(tokensCssPath, 'utf8');
const tokenNames = extractTokenNames(tokensCssSource);
if (tokenNames.length !== 34) {
	fail(
		`expected exactly 34 token names in ${tokensCssPath}, got ${tokenNames.length} — an empty or ` +
			'unparsed tokens.css must not make this scan trivially satisfiable.',
	);
}
ok(`read ${tokenNames.length} token names from ${tokensCssPath}.`);

// ---------------------------------------------------------------------------
// 3. Locate the dashboard's built CSS.
// ---------------------------------------------------------------------------
if (!existsSync(DIST_ASSETS)) {
	fail(`${DIST_ASSETS} does not exist — run \`vite build\` first.`);
}
const cssFiles = readdirSync(DIST_ASSETS).filter((f) => f.endsWith('.css') && !f.endsWith('.css.map'));
if (cssFiles.length === 0) {
	fail(`no CSS found under ${DIST_ASSETS} — the build emitted no stylesheet to scan.`);
}
const distCss = cssFiles.map((f) => readFileSync(path.join(DIST_ASSETS, f), 'utf8')).join('\n');
ok(`scanned ${cssFiles.length} built CSS file(s) under ${DIST_ASSETS}.`);

// ---------------------------------------------------------------------------
// 4. Require every name to appear in the concatenated dist CSS as a
//    declaration, not merely as a substring.
// ---------------------------------------------------------------------------
const missing = tokenNames.filter((name) => !nameDeclaredIn(name, distCss));
if (missing.length > 0) {
	fail(
		`${missing.length} of ${tokenNames.length} token name(s) did not reach the built CSS: ${missing.join(', ')}. ` +
			"This means the @import '@votetorrent/ui-web/tokens.css'; in app.css did not resolve into the production bundle.",
	);
}
ok(`all ${tokenNames.length} token name(s) found in the built CSS.`);
process.exit(0);
