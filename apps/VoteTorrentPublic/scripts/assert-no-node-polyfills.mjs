#!/usr/bin/env node
/**
 * assert-no-node-polyfills.mjs — the public app's own instance of the D-19 /
 * T-53-06-03 / T-53-06-04 purity gate.
 *
 * Adapted near-verbatim from apps/VoteTorrentDashboard/scripts/assert-no-node-polyfills.mjs.
 * It exists as this app's OWN instance, not a shared runner, because
 * `resolve.dedupe`-style per-app configuration means a green dashboard predicts
 * nothing about this app (spike 089/091) — the recipe must be proven per
 * consumer, not once. This app's audience is fully anonymous (no login, no
 * session), so any baked build-time value here is world-readable.
 *
 * Proves this app's Vite build never pulls a Node builtin (or a polyfill for
 * one) into the browser bundle, and never bakes a build-time env value or a
 * `define`/`envPrefix` escape into the public bundle. Runs its own positive
 * control FIRST — a purity gate that cannot detect impurity is worse than no
 * gate.
 *
 * Standalone Node script, no new dependencies.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();

/**
 * 56-02: two OPTIONAL CLI flags, additive only. When neither is passed, argv
 * and paths are BYTE-IDENTICAL to before this change — the existing
 * `assert:no-polyfills` invocation (and anything in CI that calls it) is
 * untouched in behaviour. `--build-config <path>` is appended to the `vite
 * build` argv as `--config <path>` (omitted entirely when absent);
 * `--dist <dirname>` is the directory walked and the base of the assets
 * directory (defaults to `dist`).
 * @param {string} name
 */
function getFlag(name) {
	const idx = process.argv.indexOf(name);
	return idx === -1 ? undefined : process.argv[idx + 1];
}
const BUILD_CONFIG = getFlag('--build-config');
const DIST_DIRNAME = getFlag('--dist') ?? 'dist';
const DIST = path.join(ROOT, DIST_DIRNAME);
const DIST_ASSETS = path.join(DIST, 'assets');

/**
 * Denylist matcher shared by the positive control and the real bundle scan.
 *
 * ANY `node:` specifier, not an enumerated eight. The previous list covered
 * crypto/fs/path/buffer/stream/util/os/child_process and silently permitted
 * `node:http`, `node:https`, `node:net`, `node:zlib`, `node:url`,
 * `node:events`, `node:assert` and `node:worker_threads` — a denylist whose
 * gaps are exactly the builtins a transport-flavoured dependency would reach
 * for. A gate is only worth its narrowest matcher.
 *
 * THE QUOTE DELIMITER IS LOAD-BEARING, not decoration. A bare
 * /\bnode:[a-z_]+\b/ fires on minified object literals — the current bundle
 * contains `return{node:w,offset:p-h}` from a DOM-range helper, which is a
 * property named `node`, not a module specifier. A module specifier is always
 * a string literal, so requiring the delimiter is both stricter about what it
 * accepts and free of that entire false-positive class. The benign fixtures
 * below pin exactly that.
 */
const NODE_TOKEN_RE = /["'`]node:[a-z_]+(\/[a-z_-]+)*["'`]/;
const REQUIRE_TOKEN_RE = /require\(\s*["'](crypto|fs|path|buffer|stream)["']\s*\)/;

/**
 * ANY read of `import.meta.env`, not just a `VITE_`-prefixed member access.
 * `contents.includes('import.meta.env.VITE_')` passed every one of these
 * unchanged, and each bakes a build-time value into the PUBLIC bundle:
 *
 *   const url = import.meta.env['VITE_ENDPOINT'];   // computed member access
 *   const { VITE_ENDPOINT } = import.meta.env;      // destructuring
 *   const env = import.meta.env; env.VITE_X;        // aliasing
 */
const ENV_READ_RE = /import\.meta\.env\b/;

/** A custom `envPrefix` exempts a whole namespace from Vite's own VITE_ rule;
 * a `define` entry bakes a literal with no `import.meta.env` reference at all.
 * vite.config.ts carries a comment forbidding both — a comment is not a gate. */
const VITE_DEFINE_RE = /\bdefine\s*:/;
const VITE_ENV_PREFIX_RE = /\benvPrefix\s*:/;

/**
 * Drop whole-line comments before matching, so a file that DISCUSSES a banned
 * token in prose is not reported as using it. Same line-based idiom the
 * repo's other assertions use.
 * @param {string} source
 */
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
	process.stderr.write(`[assert-no-node-polyfills] FAIL: ${message}\n`);
	process.exit(1);
}

/** @param {string} message */
function ok(message) {
	process.stdout.write(`[assert-no-node-polyfills] OK: ${message}\n`);
}

// A gate whose output cannot tell you WHAT it looked at is a gate whose
// greens cannot be quoted. Print the effective dist directory and build
// config before any check runs.
process.stdout.write(
	`[assert-no-node-polyfills] INFO: examining dist directory "${DIST_DIRNAME}" (${DIST}), build config: ` +
		`${BUILD_CONFIG ?? 'default (vite.config.ts)'}.\n`,
);

// ---------------------------------------------------------------------------
// 1. Positive control — the matcher must be able to detect impurity, or the
//    gate proves nothing. Run this BEFORE touching the build.
// ---------------------------------------------------------------------------
/** One fixture per matcher. A gate with an unexercised matcher proves nothing
 * about the thing that matcher is the only defence against.
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
	['vite define entry', VITE_DEFINE_RE, 'export default defineConfig({ define: { __X__: "1" } });'],
	['vite envPrefix entry', VITE_ENV_PREFIX_RE, 'export default defineConfig({ envPrefix: "APP_" });'],
]);
for (const [label, matcher, fixture] of POSITIVE_CONTROLS) {
	if (!matcher.test(fixture)) {
		fail(
			`matcher is inert — the "${label}" positive-control fixture did not match. ` +
				'This gate cannot detect a real regression until the matcher is fixed.',
		);
	}
}
/** A matcher that fires on everything is as useless as one that fires on
 * nothing. `node:` must not match an ordinary object-literal key or a URL. */
const BENIGN_FIXTURES = [
	'const o = { node: 1 };',
	'const u = "https://example.test/node/1";',
	// The exact minified shape the real bundle emits today.
	'if(h<=p&&S>=p)return{node:w,offset:p-h};',
];
for (const benign of BENIGN_FIXTURES) {
	if (NODE_TOKEN_RE.test(benign)) {
		fail(`matcher is indiscriminate — NODE_TOKEN_RE matched the benign fixture ${JSON.stringify(benign)}.`);
	}
}

/** ENV_READ_RE is deliberately broad (`import.meta.env` with no `.VITE_`
 * requirement, per WR-07) — broad enough that it could plausibly be "fixed"
 * back to uselessness by narrowing it if it ever flagged legitimate code. A
 * negative control pins that it does NOT fire on ordinary code that merely
 * mentions "env" or "import.meta" without reading the env object itself,
 * proving the matcher discriminates rather than merely matching everything. */
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

// ---------------------------------------------------------------------------
// 2. Spawn `vite build` and capture output.
// ---------------------------------------------------------------------------
const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
if (!existsSync(viteBin)) {
	fail(`vite binary not found at ${viteBin} — run \`yarn install\` first.`);
}

const viteBuildArgs = [viteBin, 'build'];
if (BUILD_CONFIG) viteBuildArgs.push('--config', BUILD_CONFIG);
const buildResult = spawnSync(process.execPath, viteBuildArgs, {
	encoding: 'utf8',
	cwd: ROOT,
});

const buildOutput = `${buildResult.stdout ?? ''}\n${buildResult.stderr ?? ''}`;

if (buildResult.status !== 0) {
	fail(`vite build exited ${buildResult.status}.\n--- captured output ---\n${buildOutput}`);
}
ok('vite build exited 0.');

// ---------------------------------------------------------------------------
// 3. Vite's own externalization warning is a direct tell that a Node builtin
//    reached the browser graph.
// ---------------------------------------------------------------------------
if (buildOutput.includes('has been externalized for browser compatibility')) {
	fail(
		'vite build output contains "has been externalized for browser compatibility" — ' +
			'a Node builtin reached the browser module graph.\n' +
			`--- captured output ---\n${buildOutput}`,
	);
}
ok('no "externalized for browser compatibility" warning in build output.');

// ---------------------------------------------------------------------------
// 4. Scan every emitted bundle for a Node builtin token or a bare require() of one.
// ---------------------------------------------------------------------------
if (!existsSync(DIST_ASSETS)) {
	fail(`${DIST_ASSETS} does not exist — the build did not emit the expected assets directory.`);
}

/**
 * Every TEXT artefact the build emits, anywhere under `dist/` — not just
 * `dist/assets/*.js`. `index.html` and any non-`.js` emitted chunk were
 * previously unscanned.
 *
 * `.map` files are DELIBERATELY excluded: a source map embeds the original
 * sources of the whole graph, including files that merely DISCUSS `node:` or
 * `import.meta.env` in a comment, so scanning them would report prose as
 * impurity. What ships and executes is the `.js`/`.html`/`.css`, which is
 * what this scan covers.
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

const emittedFiles = walkDist(DIST);
const emittedJs = emittedFiles.filter((f) => f.endsWith('.js') && f.startsWith(DIST_ASSETS));
if (emittedJs.length === 0) {
	fail(`no .js files found under ${DIST_ASSETS} — the build emitted nothing to scan.`);
}
// 56-02: an entry HTML document, not necessarily named `index.html`. The
// production build's `rollupOptions.input` is implicit and emits
// `index.html` at the dist root; `vite.closure.config.ts` (and its siblings
// `vite.live.config.ts`/`vite.gate.config.ts`) point `rollupOptions.input` at
// a named HTML file under `test/browser/`, which Vite emits at that SAME
// relative path under the outDir (e.g. `dist-closure/test/browser/
// libp2p-closure-probe.html`), never renamed to `index.html`. Requiring the
// literal name would make this check fail on every non-default `--dist`
// build even though the entry document was genuinely emitted.
if (!emittedFiles.some((f) => f.endsWith('.html'))) {
	fail(`no *.html entry document found under ${DIST} — the build did not emit an entry document.`);
}

let totalBytes = 0;
for (const filePath of emittedFiles) {
	if (filePath.endsWith('.js')) totalBytes += statSync(filePath).size;
	const contents = readFileSync(filePath, 'utf8');

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
		fail(`${filePath} contains "${envMatch[0]}" — a build-time value baked into the public bundle.`);
	}
}
ok(`scanned ${emittedFiles.length} emitted text file(s) under ${DIST_DIRNAME}/ (index.html included, .map excluded) — no Node builtin or env read found.`);

// ---------------------------------------------------------------------------
// 5. This app's own manifest must not declare a polyfill package. Hard-coded
//    to the project root regardless of --dist/--build-config: there is ONE
//    manifest, regardless of which entry was built.
// ---------------------------------------------------------------------------
const DENYLISTED_DEPS = [
	'buffer',
	'process',
	'crypto-browserify',
	'stream-browserify',
	'path-browserify',
	'readable-stream',
	'node-stdlib-browser',
	'vite-plugin-node-polyfills',
	'events',
	'util',
	'assert',
];

const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const declaredDeps = {
	...(manifest.dependencies ?? {}),
	...(manifest.devDependencies ?? {}),
};

const foundPolyfillDeps = DENYLISTED_DEPS.filter((dep) => dep in declaredDeps);
if (foundPolyfillDeps.length > 0) {
	fail(`package.json declares denylisted polyfill dependency(ies): ${foundPolyfillDeps.join(', ')}.`);
}
ok('package.json declares no Node-polyfill dependency.');

// ---------------------------------------------------------------------------
// 6. Secrets hygiene — no .env* file, no import.meta.env.VITE_ read.
//    This app has no server, no session and no secret to hold. Its audience
//    is fully anonymous, so any baked build-time value here is world-readable.
// ---------------------------------------------------------------------------
/** @param {string} dir */
function walk(dir) {
	/** @type {string[]} */
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === 'node_modules' || entry.name === 'dist') continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walk(full));
		} else {
			out.push(full);
		}
	}
	return out;
}

const appFiles = walk(ROOT).filter((f) => {
	const base = path.basename(f);
	return base.startsWith('.env');
});
if (appFiles.length > 0) {
	fail(`found .env* file(s) under ${ROOT}: ${appFiles.join(', ')}. This app has no secret to hold.`);
}
ok('no .env* file found under the workspace member.');

const srcDir = path.join(ROOT, 'src');
if (existsSync(srcDir)) {
	const srcFiles = walk(srcDir);
	for (const f of srcFiles) {
		// Comment lines are stripped first, so a file that legitimately EXPLAINS
		// in prose why it never reads this mechanism is not punished for the
		// explanation.
		const contents = stripCommentLines(readFileSync(f, 'utf8'));
		const match = contents.match(ENV_READ_RE);
		if (match) {
			fail(`${f} reads "${match[0]}" — any bundled build-time value would be public.`);
		}
	}
	ok(`scanned ${srcFiles.length} file(s) under src/ — no import.meta.env read of any form found.`);
}

// ---------------------------------------------------------------------------
// 6b. The build config itself. `vite.config.ts` was never scanned by earlier
//     scripts (only `src/` was), so its own comment forbidding `define` was
//     the only thing enforcing it — and a comment is not a gate. A `define`
//     entry bakes a literal with no `import.meta.env` reference for section 6
//     to find, and a custom `envPrefix` exempts an entire namespace.
//
//     56-02: hard-coded to `vite.config.ts` (`base`) regardless of
//     --build-config — every sibling config, including the closure config,
//     inherits `base` through `mergeConfig`, so `base`'s own absence of
//     `define`/`envPrefix` is load-bearing for EVERY build made from it.
// ---------------------------------------------------------------------------
const viteConfigPath = path.join(ROOT, 'vite.config.ts');
if (!existsSync(viteConfigPath)) {
	fail(`${viteConfigPath} does not exist — this gate cannot confirm the build config declares no define/envPrefix.`);
}
const viteConfigSource = stripCommentLines(readFileSync(viteConfigPath, 'utf8'));
if (VITE_DEFINE_RE.test(viteConfigSource)) {
	fail('vite.config.ts declares a `define` entry — it would bake a build-time literal into the public bundle.');
}
if (VITE_ENV_PREFIX_RE.test(viteConfigSource)) {
	fail('vite.config.ts declares an `envPrefix` — it would exempt a whole env namespace from the VITE_ rule.');
}
if (ENV_READ_RE.test(viteConfigSource)) {
	fail('vite.config.ts reads import.meta.env.');
}
ok('vite.config.ts declares no define, no envPrefix and no env read.');

// ---------------------------------------------------------------------------
// 7. Informational — module count and emitted size. This app has no prior
//    measurement to compare against (it did not exist before this plan), so
//    this is reported as a plain figure with no comparison bar. Does not gate.
// ---------------------------------------------------------------------------
const moduleCountMatch = buildOutput.match(/transforming\.\.\.\s*\n?.*?(\d+)\s+modules? transformed/s);
const moduleCount = moduleCountMatch ? moduleCountMatch[1] : 'unknown';
const kb = (totalBytes / 1024).toFixed(0);
process.stdout.write(
	`[assert-no-node-polyfills] INFO: modules transformed = ${moduleCount}, ` +
		`emitted ${DIST_DIRNAME}/assets size = ${kb} KB (raw, not gzip) — no prior measurement to compare against yet.\n`,
);

ok('all checks passed — the bundle needs zero Node polyfills.');
process.exit(0);
