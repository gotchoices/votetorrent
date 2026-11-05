#!/usr/bin/env node
/**
 * assert-ui-web-dedupe-and-gate.mjs — the D-21 repo-root tier-1 static assertion.
 *
 * What D-21 requires: every workspace depending on `@votetorrent/ui-web` must declare
 * `resolve.dedupe: ['react', 'react-dom']` in its production Vite config AND must declare a
 * `package.json` script whose command reaches the one shared browser-gate runner
 * (`packages/ui-web/scripts/run-ui-gates.mjs`). A consumer with no gate has nothing to fail,
 * so the behavioural gates (53-08/53-09) structurally cannot protect a fourth consumer that
 * forgets either requirement — this script is what makes that impossible to forget.
 *
 * Runs at tier 1, BEFORE any build: no browser, no network, no `yarn` invocation. It is a
 * comment-stripped line/regex scan over on-disk config text, never an AST parse and never an
 * evaluation of a consumer's (TypeScript) config module — so it CANNOT prove the `dedupe`
 * array is lexically nested inside the `resolve` object; it can only prove both tokens are
 * present, in that documented tolerance, in the same file. It never executes a consumer's
 * script string (no `spawnSync`/`execSync`/`child_process` anywhere in this file) — it only
 * resolves paths and compares `realpathSync` output.
 *
 * Consumers are DISCOVERED from the root `package.json` `workspaces` globs, never hard-coded.
 * A fourth consumer added later under an existing (or a new) workspace glob is checked with
 * no edit to this script.
 *
 * Standalone Node script. Imports only `node:fs`, `node:os`, `node:path` and `node:process`.
 * Declares no dependency and adds none.
 *
 * Structural precedent: `apps/VoteTorrentDashboard/scripts/assert-no-node-polyfills.mjs`.
 * `stripCommentLines` below is copied VERBATIM from that file — the other two instances of
 * this exact helper are that file and `scripts/lint-copy.mjs`; a future edit to the idiom
 * should find and update all three.
 *
 * CLI flags:
 *   --self-test-only   run the fixture self-test and exit without touching the real repository.
 *   --root <dir>       scan <dir> instead of `process.cwd()` for the real-scan phase (the
 *                       self-test still runs first, unconditionally, against its own temp
 *                       fixtures). This is the executor's tool for real-content inversion
 *                       controls: point it at a temp directory holding a copy of a real
 *                       consumer's files with exactly one requirement removed.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/**
 * Drop whole-line comments before matching, so a file that DISCUSSES a banned or required
 * token in prose is not reported as using (or as satisfying) it. Copied verbatim from
 * `apps/VoteTorrentDashboard/scripts/assert-no-node-polyfills.mjs` — the other instance of
 * this exact helper lives there and in `scripts/lint-copy.mjs`.
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
	process.stderr.write(`[assert-ui-web-dedupe-and-gate] FAIL: ${message}\n`);
	process.exit(1);
}

/** @param {string} message */
function ok(message) {
	process.stdout.write(`[assert-ui-web-dedupe-and-gate] OK: ${message}\n`);
}

// ---------------------------------------------------------------------------
// Discovery — parameterised by root directory so the self-test can point it
// at a temp fixture tree instead of the real repository.
// ---------------------------------------------------------------------------

/**
 * Expand the root `workspaces` globs into a list of workspace directories.
 *
 * Accepts `workspaces` as a bare array or the `{ packages: [...] }` object form (the shape at
 * HEAD). `nohoist` is not a workspace root and is ignored. Only the trailing-`/*` single-segment
 * pattern shape (e.g. `"packages/*"`) is supported — a bare directory, a nested `a/*\/b`, or a
 * `**` pattern is a loud failure naming the unsupported pattern, never a silent skip: a
 * silently skipped glob is precisely the "fourth consumer" hole this script exists to close.
 * @param {string} rootDir
 * @returns {string[]} absolute workspace directories that contain a `package.json`
 */
function expandWorkspaceGlobs(rootDir) {
	const manifest = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
	const ws = manifest.workspaces;
	/** @type {string[]} */
	let patterns;
	if (Array.isArray(ws)) {
		patterns = ws;
	} else if (ws && typeof ws === 'object' && Array.isArray(ws.packages)) {
		patterns = ws.packages;
	} else {
		throw new Error(
			`unsupported "workspaces" shape at ${path.join(rootDir, 'package.json')} — expected a bare array ` +
				'or an object with a "packages" array. Extend expandWorkspaceGlobs to handle it.',
		);
	}

	const dirs = [];
	for (const pattern of patterns) {
		const segments = pattern.split('/');
		const isSupportedShape = pattern.endsWith('/*') && segments.length === 2 && !pattern.includes('*'.repeat(2));
		if (!isSupportedShape) {
			throw new Error(
				`unsupported workspaces glob pattern "${pattern}" — only a trailing-"/*" single-segment-prefix ` +
					'pattern (e.g. "packages/*") is supported. A bare directory, a nested pattern, or a "**" ' +
					'pattern is not silently skipped; extend expandWorkspaceGlobs to handle it.',
			);
		}
		const parentRel = pattern.slice(0, -2);
		const parentAbs = path.join(rootDir, parentRel);
		if (!existsSync(parentAbs)) continue;
		for (const entry of readdirSync(parentAbs, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const childAbs = path.join(parentAbs, entry.name);
			if (existsSync(path.join(childAbs, 'package.json'))) dirs.push(childAbs);
		}
	}
	return dirs;
}

/**
 * Every discovered workspace directory's `package.json` is actually read and parsed. A
 * directory that `expandWorkspaceGlobs` found but whose manifest cannot be read/parsed is a
 * loud failure, not a silently dropped workspace.
 * @param {string} rootDir
 * @returns {number} the number of workspace directories read
 */
function assertAllWorkspacesReadable(rootDir) {
	const dirs = expandWorkspaceGlobs(rootDir);
	for (const dir of dirs) {
		const manifestPath = path.join(dir, 'package.json');
		try {
			JSON.parse(readFileSync(manifestPath, 'utf8'));
		} catch (err) {
			throw new Error(`workspace manifest ${manifestPath} could not be read/parsed: ${err.message}`);
		}
	}
	return dirs.length;
}

/**
 * @param {import('./types').Consumer[]} consumers
 */
function assertMinimumConsumerCount(consumers) {
	if (consumers.length < 2) {
		throw new Error(
			`only ${consumers.length} @votetorrent/ui-web consumer(s) discovered — a discovery bug that returns ` +
				'zero (or one) would make this entire assertion pass vacuously. Expected at least two.',
		);
	}
}

const CANONICAL_RUNNER_RELATIVE_PATH = path.join('packages', 'ui-web', 'scripts', 'run-ui-gates.mjs');

/**
 * @param {string} rootDir
 * @returns {string} the canonical runner's realpath
 */
function assertCanonicalRunnerExists(rootDir) {
	const runnerPath = path.join(rootDir, CANONICAL_RUNNER_RELATIVE_PATH);
	if (!existsSync(runnerPath)) {
		throw new Error(`canonical runner not found at ${runnerPath} — every consumer's gate script must reach it.`);
	}
	return realpathSync(runnerPath);
}

/**
 * The three discovery-liveness rungs, each a distinct named failure. Returns the canonical
 * runner's realpath (computed as part of the rungs) for reuse by the caller.
 * @param {string} rootDir
 * @param {import('./types').Consumer[]} consumers
 * @returns {string}
 */
function runDiscoveryRungs(rootDir, consumers) {
	assertMinimumConsumerCount(consumers);
	assertAllWorkspacesReadable(rootDir);
	return assertCanonicalRunnerExists(rootDir);
}

/** Fixed, ordered filename list — never a glob, never a `startsWith('vite.')` test — so the
 * deliberately dedupe-less harness config used elsewhere in this workspace tree can never be
 * mistaken for a production config. */
const PRODUCTION_VITE_CONFIG_FILENAMES = Object.freeze(['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs']);

/** Self-test-fixture-only filename for the deliberately dedupe-less harness build config that
 * 53-09/53-11 already ship in the real apps. Assembled at runtime, deliberately not spelled out
 * contiguously anywhere else in this file's source: the one place a production config filename
 * is ever named is `PRODUCTION_VITE_CONFIG_FILENAMES` above, and this fixture filename is not in
 * it — proven by discovery fixture 6 below. */
const GATE_CONFIG_FIXTURE_FILENAME = ['vite', 'gate', 'config', 'ts'].join('.');

/**
 * @param {string} workspaceDir
 * @returns {string | null}
 */
function findProductionViteConfig(workspaceDir) {
	for (const filename of PRODUCTION_VITE_CONFIG_FILENAMES) {
		const candidate = path.join(workspaceDir, filename);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/**
 * Classify a workspace as a consumer when `@votetorrent/ui-web` appears in its `dependencies`
 * or `devDependencies`. The shared package itself never depends on itself, so it is never
 * classified — no special-casing by name is needed or present.
 * @param {string} rootDir
 * @returns {Array<{ dir: string, name: string, manifest: Record<string, unknown> }>}
 */
function discoverConsumers(rootDir) {
	const workspaceDirs = expandWorkspaceGlobs(rootDir);
	const consumers = [];
	for (const dir of workspaceDirs) {
		const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
		const declaredDeps = {
			...(manifest.dependencies ?? {}),
			...(manifest.devDependencies ?? {}),
		};
		if ('@votetorrent/ui-web' in declaredDeps) {
			consumers.push({ dir, name: manifest.name, manifest });
		}
	}
	return consumers;
}

// ---------------------------------------------------------------------------
// Checker 1 — the dedupe checker. Comment-stripped, tolerant of every legitimate
// formatting of the array, and reports two distinct reasons.
// ---------------------------------------------------------------------------

/** A `resolve` identifier followed by a colon and an opening brace, whitespace-tolerant. */
const RESOLVE_KEY_RE = /\bresolve\s*:\s*\{/;
/** A `dedupe` key whose array literal may span lines; captures the array's inner text. */
const DEDUPE_KEY_RE = /\bdedupe\s*:\s*\[([^\]]*)\]/;
/** A quoted string token inside a captured array's inner text. */
const ARRAY_TOKEN_RE = /(['"])([^'"]+)\1/g;

/**
 * @param {string} configSource
 * @returns {{ ok: boolean, reason: string | null }}
 */
function checkDedupe(configSource) {
	const stripped = stripCommentLines(configSource);
	if (!RESOLVE_KEY_RE.test(stripped)) {
		return { ok: false, reason: 'no `resolve` object key found (comment-stripped scan)' };
	}
	const dedupeMatch = stripped.match(DEDUPE_KEY_RE);
	if (!dedupeMatch) {
		return { ok: false, reason: 'no `dedupe` array found (comment-stripped scan)' };
	}
	// Extracted as a SET of quoted tokens, not an ordered/exact-string match: reversed order,
	// single or double quotes, a trailing comma, multi-line arrays, and a third deduped
	// package all pass. A checker that rejects any of those fires on correct code, and a
	// matcher that fires on correct code gets deleted — which is worse than not having one.
	const tokens = new Set();
	for (const tokenMatch of dedupeMatch[1].matchAll(ARRAY_TOKEN_RE)) {
		tokens.add(tokenMatch[2]);
	}
	const required = ['react', 'react-dom'];
	const missing = required.filter((name) => !tokens.has(name));
	if (missing.length > 0) {
		return {
			ok: false,
			reason: `dedupe array is missing: ${missing.join(', ')} (found: ${[...tokens].join(', ') || 'none'})`,
		};
	}
	return { ok: true, reason: null };
}

// ---------------------------------------------------------------------------
// Checker 2 — the browser-gate-script checker. Requires the COMMAND to reach the
// runner; never a key name, and never an executed script string.
// ---------------------------------------------------------------------------

/** A non-whitespace path token ending in the canonical runner's filename. */
const RUN_UI_GATES_TOKEN_RE = /(\S*run-ui-gates\.mjs)/;

/**
 * @param {Record<string, unknown>} manifest
 * @param {string} workspaceDir
 * @param {string} canonicalRunnerRealPath
 * @returns {{ ok: boolean, reason: string | null, scriptKey: string | null }}
 */
function checkGateScript(manifest, workspaceDir, canonicalRunnerRealPath) {
	const scripts = manifest.scripts;
	if (!scripts || typeof scripts !== 'object') {
		return { ok: false, reason: 'manifest declares no scripts object', scriptKey: null };
	}
	let matchedKey = null;
	let matchedToken = null;
	for (const [key, command] of Object.entries(scripts)) {
		if (typeof command !== 'string') continue;
		const tokenMatch = command.match(RUN_UI_GATES_TOKEN_RE);
		if (tokenMatch) {
			matchedKey = key;
			matchedToken = tokenMatch[1];
			break;
		}
	}
	if (!matchedKey) {
		return { ok: false, reason: 'no script command reaches the canonical runner (run-ui-gates.mjs)', scriptKey: null };
	}
	const resolvedPath = path.resolve(workspaceDir, matchedToken);
	if (!existsSync(resolvedPath)) {
		return {
			ok: false,
			reason: `gate script path "${matchedToken}" (script "${matchedKey}") does not exist on disk`,
			scriptKey: matchedKey,
		};
	}
	let real;
	try {
		real = realpathSync(resolvedPath);
	} catch (err) {
		return {
			ok: false,
			reason: `gate script path "${matchedToken}" (script "${matchedKey}") could not be resolved: ${err.message}`,
			scriptKey: matchedKey,
		};
	}
	if (real !== canonicalRunnerRealPath) {
		return {
			ok: false,
			reason:
				`gate script (script "${matchedKey}") resolves to ${real}, which does not resolve to the canonical ` +
				`runner ${canonicalRunnerRealPath} — a forked or copied runner is not the one shared runner D-21 requires`,
			scriptKey: matchedKey,
		};
	}
	return { ok: true, reason: null, scriptKey: matchedKey };
}

// ---------------------------------------------------------------------------
// Per-consumer violation report and root-hoist rung.
// ---------------------------------------------------------------------------

/**
 * A frozen, top-level map of workspace name to a written exemption reason. Lands EMPTY: every
 * entry is printed on every run so an exemption is a visible, reviewable diff rather than a
 * silent skip. This is the honest handling of a future non-Vite consumer (a React Native app
 * importing only the copy table): it is neither forced to invent a Vite config nor quietly
 * dropped.
 */
const NON_BROWSER_CONSUMERS = Object.freeze({});

/**
 * @param {{ dir: string, name: string, manifest: Record<string, unknown> }} consumer
 * @param {{ canonicalRunnerRealPath: string, nonBrowserConsumers: Record<string, string> }} ctx
 * @returns {string[]} violation strings, never throws
 */
function checkConsumer(consumer, ctx) {
	/** @type {string[]} */
	const violations = [];

	const configPath = findProductionViteConfig(consumer.dir);
	if (!configPath) {
		if (consumer.name in ctx.nonBrowserConsumers) {
			// Exempted — the reason is printed by the caller from NON_BROWSER_CONSUMERS directly.
		} else {
			violations.push(
				`${consumer.name}: no production vite config found (checked ${PRODUCTION_VITE_CONFIG_FILENAMES.join(', ')}) ` +
					'and no NON_BROWSER_CONSUMERS exemption is declared for it',
			);
		}
	} else {
		const dedupeResult = checkDedupe(readFileSync(configPath, 'utf8'));
		if (!dedupeResult.ok) {
			violations.push(`${consumer.name}: ${dedupeResult.reason} (${configPath})`);
		}
	}

	const gateResult = checkGateScript(consumer.manifest, consumer.dir, ctx.canonicalRunnerRealPath);
	if (!gateResult.ok) {
		violations.push(`${consumer.name}: ${gateResult.reason}`);
	}

	return violations;
}

/**
 * Parse a `resolutions` key into a package name for exact comparison: strip a trailing
 * `@npm:<descriptor>` qualifier while preserving a leading `@scope/`, then compare the result
 * exactly. Substring matching would flag `@types/react` and `react-native-screens`, both
 * legitimately pinned at HEAD.
 * @param {string} key
 * @returns {string}
 */
function parseResolutionPackageName(key) {
	const npmIndex = key.indexOf('@npm:');
	if (npmIndex === -1) return key;
	return key.slice(0, npmIndex);
}

/**
 * Rejects `react`/`react-dom` in the root `dependencies`, `devDependencies` or `resolutions`.
 * A second, deliberate instance alongside `packages/ui-web/test/package-shape.test.mjs` — that
 * test may not run in the tier-1 CI job at this wave; this one runs in the root assertion CI
 * invokes directly. Cross-referenced by path at both sites.
 * @param {Record<string, unknown>} rootManifest
 * @returns {string[]}
 */
function checkRootHoist(rootManifest) {
	/** @type {string[]} */
	const violations = [];
	const declaredDeps = {
		...(rootManifest.dependencies ?? {}),
		...(rootManifest.devDependencies ?? {}),
	};
	for (const bad of ['react', 'react-dom']) {
		if (bad in declaredDeps) {
			violations.push(
				`root manifest declares "${bad}" in dependencies/devDependencies — React must never be hoisted to ` +
					'the root (this repo has no hoisted React; each workspace owns its own copy; see the ' +
					'apps/*/vite.config.ts D-19/D-21 comments and packages/ui-web/test/package-shape.test.mjs, ' +
					'the other deliberate instance of this rule)',
			);
		}
	}
	const resolutions = rootManifest.resolutions ?? {};
	for (const key of Object.keys(resolutions)) {
		const name = parseResolutionPackageName(key);
		if (name === 'react' || name === 'react-dom') {
			violations.push(
				`root resolutions declares "${key}" (parsed package name "${name}") — React must never be hoisted ` +
					'to the root via resolutions',
			);
		}
	}
	return violations;
}

/**
 * Aggregate: collects violations across ALL discovered consumers and returns them rather than
 * exiting at the first, so one run names every misconfigured consumer.
 * @param {string} rootDir
 * @param {{ nonBrowserConsumers: Record<string, string> }} ctx
 * @returns {{ consumers: Array<{ dir: string, name: string, manifest: Record<string, unknown> }>, violations: string[], canonicalRunnerRealPath: string }}
 */
function runAssertion(rootDir, ctx) {
	const canonicalRunnerRealPath = runDiscoveryRungs(rootDir, discoverConsumers(rootDir));
	const consumers = discoverConsumers(rootDir);
	const rootManifest = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
	const runCtx = { canonicalRunnerRealPath, nonBrowserConsumers: ctx.nonBrowserConsumers };
	const violations = [...checkRootHoist(rootManifest)];
	for (const consumer of consumers) {
		violations.push(...checkConsumer(consumer, runCtx));
	}
	return { consumers, violations, canonicalRunnerRealPath };
}

// ---------------------------------------------------------------------------
// Fixture self-test harness — no fixture is ever written inside the repository
// tree, only under the OS temp directory, removed in a `finally`.
// ---------------------------------------------------------------------------

/**
 * @param {(dir: string) => void} build
 * @param {(dir: string) => void} use
 */
function withFixtureRoot(build, use) {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'ui-web-consumers-'));
	try {
		build(dir);
		use(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** @param {string} filePath @param {object} obj */
function writeJSON(filePath, obj) {
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

/** @param {string} filePath @param {string} contents */
function writeText(filePath, contents) {
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, contents);
}

/** @param {string} rootDir */
function writeCanonicalRunnerStub(rootDir) {
	writeText(
		path.join(rootDir, CANONICAL_RUNNER_RELATIVE_PATH),
		'// fixture stub standing in for the canonical shared browser-gate runner\n',
	);
}

/** @param {string} rootDir @param {object} [overrides] */
function writeRootManifest(rootDir, overrides = {}) {
	const base = {
		name: 'fixture-root',
		private: true,
		workspaces: { packages: ['packages/*', 'apps/*'] },
	};
	writeJSON(path.join(rootDir, 'package.json'), { ...base, ...overrides });
}

/**
 * @param {string} name
 * @param {object} [extra]
 */
function compliantManifest(name, extra = {}) {
	return {
		name,
		private: true,
		dependencies: { '@votetorrent/ui-web': 'workspace:*' },
		scripts: {
			'browser-gate': 'node ../../packages/ui-web/scripts/run-ui-gates.mjs --app .',
		},
		...extra,
	};
}

const COMPLIANT_VITE_CONFIG = [
	'export default {',
	'\tplugins: [],',
	"\tresolve: { dedupe: ['react', 'react-dom'] },",
	'};',
	'',
].join('\n');

/**
 * @param {string} rootDir
 * @param {string} relDir
 * @param {{ manifest: object, viteConfig?: string, gateConfig?: string }} spec
 * @returns {string}
 */
function writeConsumerWorkspace(rootDir, relDir, spec) {
	const dir = path.join(rootDir, relDir);
	writeJSON(path.join(dir, 'package.json'), spec.manifest);
	if (spec.viteConfig !== undefined) writeText(path.join(dir, 'vite.config.ts'), spec.viteConfig);
	if (spec.gateConfig !== undefined) writeText(path.join(dir, GATE_CONFIG_FIXTURE_FILENAME), spec.gateConfig);
	return dir;
}

// ---------------------------------------------------------------------------
// Regex-level positive controls — run BEFORE the fixture arrays. A matcher
// that cannot detect its own textbook case proves nothing about the real scan.
// ---------------------------------------------------------------------------

const REGEX_POSITIVE_CONTROLS = /** @type {ReadonlyArray<readonly [string, RegExp, string]>} */ ([
	['resolve key', RESOLVE_KEY_RE, "export default { resolve: { dedupe: ['react'] } };"],
	['dedupe key, single line', DEDUPE_KEY_RE, "resolve: { dedupe: ['react', 'react-dom'] }"],
	['dedupe key, multi-line', DEDUPE_KEY_RE, "dedupe: [\n\t'react',\n\t'react-dom',\n]"],
	['run-ui-gates.mjs token', RUN_UI_GATES_TOKEN_RE, 'node ../../packages/ui-web/scripts/run-ui-gates.mjs --app .'],
]);
for (const [label, matcher, fixture] of REGEX_POSITIVE_CONTROLS) {
	if (!matcher.test(fixture)) {
		fail(`matcher is inert — the "${label}" positive-control fixture did not match. This gate cannot detect a real regression until the matcher is fixed.`);
	}
}
/**
 * A matcher that fires on everything is as useless as one that fires on nothing. Every
 * matcher (RESOLVE_KEY_RE, DEDUPE_KEY_RE, RUN_UI_GATES_TOKEN_RE) is checked against every
 * fixture's OWN (comment-stripped) content — never a hard-coded literal copy of it, and
 * never gated behind a marker substring that only some fixtures happen to contain. The
 * comment-only fixture (index 1) reduces to `''` after stripping and so trips none of the
 * three; comment-stripping itself is separately proven by the c2a/c2b inversion fixtures
 * above.
 */
const REGEX_BENIGN_FIXTURES = [
	"const resolveSomething = 'not a config key at all';",
	"// resolve: { dedupe: ['react', 'react-dom'] } -- discussed only in a line comment",
	"const dedupeCount = 2; // not a resolve.dedupe array",
	'node ../../packages/ui-web/scripts/run-tests-elsewhere.mjs --app .',
];
const REGEX_BENIGN_MATCHERS = /** @type {ReadonlyArray<readonly [string, RegExp]>} */ ([
	['RESOLVE_KEY_RE', RESOLVE_KEY_RE],
	['DEDUPE_KEY_RE', DEDUPE_KEY_RE],
	['RUN_UI_GATES_TOKEN_RE', RUN_UI_GATES_TOKEN_RE],
]);
for (const benign of REGEX_BENIGN_FIXTURES) {
	const stripped = stripCommentLines(benign);
	for (const [name, matcher] of REGEX_BENIGN_MATCHERS) {
		if (matcher.test(stripped)) {
			fail(`matcher is indiscriminate — ${name} matched the benign fixture ${JSON.stringify(benign)} (comment-stripped: ${JSON.stringify(stripped)}).`);
		}
	}
}
ok(
	`${REGEX_POSITIVE_CONTROLS.length} regex positive control(s) matched, ${REGEX_BENIGN_FIXTURES.length} benign fixture(s) x ${REGEX_BENIGN_MATCHERS.length} matcher(s) each did not — the checker matchers are live and discriminating.`,
);

// ---------------------------------------------------------------------------
// Discovery fixtures.
// ---------------------------------------------------------------------------

const DISCOVERY_FIXTURES = [
	{
		label: 'a third consumer is found under a workspace root that does not exist today (tools/*)',
		build(dir) {
			writeRootManifest(dir, { workspaces: { packages: ['packages/*', 'apps/*', 'tools/*'] } });
			writeConsumerWorkspace(dir, 'tools/widget', {
				manifest: compliantManifest('widget-consumer'),
				viteConfig: COMPLIANT_VITE_CONFIG,
			});
			writeCanonicalRunnerStub(dir);
		},
		expect(dir) {
			const consumers = discoverConsumers(dir);
			if (!consumers.some((c) => c.name === 'widget-consumer')) {
				throw new Error('expected the tools/* consumer to be discovered, it was not');
			}
		},
	},
	{
		label: 'a non-consumer workspace and the shared package itself are not classified as consumers',
		build(dir) {
			writeRootManifest(dir);
			writeConsumerWorkspace(dir, 'apps/plain', {
				manifest: { name: 'plain-app', private: true, dependencies: {} },
			});
			writeConsumerWorkspace(dir, 'packages/ui-web', {
				manifest: {
					name: '@votetorrent/ui-web',
					private: true,
					peerDependencies: { react: '19.0.0', 'react-dom': '19.0.0' },
					devDependencies: { react: '19.0.0', 'react-dom': '19.0.0' },
				},
			});
		},
		expect(dir) {
			const consumers = discoverConsumers(dir);
			if (consumers.some((c) => c.name === 'plain-app' || c.name === '@votetorrent/ui-web')) {
				throw new Error('a non-consumer or the shared package itself was classified as a consumer');
			}
		},
	},
	{
		label: 'a devDependencies-only declaration still counts as a consumer',
		build(dir) {
			writeRootManifest(dir);
			writeConsumerWorkspace(dir, 'apps/devdep-consumer', {
				manifest: { name: 'devdep-consumer', private: true, devDependencies: { '@votetorrent/ui-web': 'workspace:*' } },
			});
		},
		expect(dir) {
			const consumers = discoverConsumers(dir);
			if (!consumers.some((c) => c.name === 'devdep-consumer')) {
				throw new Error('expected a devDependencies-only declaration to be discovered as a consumer');
			}
		},
	},
	{
		label: 'an unsupported glob shape ("**") fails loudly instead of shrinking the list',
		build(dir) {
			writeRootManifest(dir, { workspaces: { packages: ['packages/*', '**'] } });
		},
		expect(dir) {
			let threw = false;
			try {
				expandWorkspaceGlobs(dir);
			} catch (err) {
				threw = true;
				if (!/unsupported/i.test(err.message)) throw new Error(`wrong failure message: ${err.message}`);
			}
			if (!threw) throw new Error('expected the "**" pattern to raise a named failure, it did not');
		},
	},
	{
		label: 'exactly one discovered consumer trips the two-consumer liveness rung',
		build(dir) {
			writeRootManifest(dir);
			writeConsumerWorkspace(dir, 'apps/only-one', {
				manifest: compliantManifest('only-one'),
				viteConfig: COMPLIANT_VITE_CONFIG,
			});
			writeCanonicalRunnerStub(dir);
		},
		expect(dir) {
			const consumers = discoverConsumers(dir);
			let threw = false;
			try {
				assertMinimumConsumerCount(consumers);
			} catch {
				threw = true;
			}
			if (!threw) throw new Error('expected the below-two-consumer rung to fail, it did not');
		},
	},
	{
		label: 'production-config discovery resolves vite.config.ts and excludes the harness gate config',
		build(dir) {
			writeRootManifest(dir);
			writeConsumerWorkspace(dir, 'apps/gate-only', {
				manifest: compliantManifest('gate-only'),
				gateConfig: 'export default {};\n',
			});
			writeConsumerWorkspace(dir, 'apps/both-configs', {
				manifest: compliantManifest('both-configs'),
				viteConfig: COMPLIANT_VITE_CONFIG,
				gateConfig: 'export default {};\n',
			});
		},
		expect(dir) {
			const gateOnlyDir = path.join(dir, 'apps', 'gate-only');
			if (findProductionViteConfig(gateOnlyDir) !== null) {
				throw new Error(`a consumer holding only the ${GATE_CONFIG_FIXTURE_FILENAME} harness config must resolve to null, it did not`);
			}
			const bothDir = path.join(dir, 'apps', 'both-configs');
			const resolved = findProductionViteConfig(bothDir);
			if (!resolved || !resolved.endsWith('vite.config.ts')) {
				throw new Error(`a consumer holding both configs must resolve to vite.config.ts, got: ${resolved}`);
			}
		},
	},
];

// ---------------------------------------------------------------------------
// Checker fixtures — inversion (must produce the named violation) and benign
// (must produce zero violations).
// ---------------------------------------------------------------------------

const CHECKER_FIXTURES = [
	// --- Inversion fixtures ---
	{
		label: 'no dedupe at all (resolve key present, no dedupe key)',
		kind: 'inversion',
		expectSubstring: 'no `dedupe` array found',
		build(dir) {
			writeConsumerWorkspace(dir, 'apps/c1', {
				manifest: compliantManifest('c1'),
				viteConfig: "export default {\n\tplugins: [],\n\tresolve: { alias: {} },\n};\n",
			});
		},
	},
	{
		label: 'dedupe appears only inside a // line comment',
		kind: 'inversion',
		expectSubstring: 'no `dedupe` array found',
		build(dir) {
			writeConsumerWorkspace(dir, 'apps/c2a', {
				manifest: compliantManifest('c2a'),
				viteConfig: [
					'export default {',
					'\tplugins: [],',
					'\tresolve: {',
					"\t\t// dedupe: ['react', 'react-dom'],",
					'\t},',
					'};',
					'',
				].join('\n'),
			});
		},
	},
	{
		label: 'dedupe appears only inside a /* */ block comment',
		kind: 'inversion',
		expectSubstring: 'no `dedupe` array found',
		build(dir) {
			writeConsumerWorkspace(dir, 'apps/c2b', {
				manifest: compliantManifest('c2b'),
				viteConfig: [
					'export default {',
					'\tplugins: [],',
					'\tresolve: {',
					"\t\t/* dedupe: ['react', 'react-dom'] */",
					'\t},',
					'};',
					'',
				].join('\n'),
			});
		},
	},
	{
		label: 'dedupe array lists react only',
		kind: 'inversion',
		expectSubstring: 'missing: react-dom',
		build(dir) {
			writeConsumerWorkspace(dir, 'apps/c3', {
				manifest: compliantManifest('c3'),
				viteConfig: "export default {\n\tplugins: [],\n\tresolve: { dedupe: ['react'] },\n};\n",
			});
		},
	},
	{
		label: 'dedupe array lists react-dom only',
		kind: 'inversion',
		expectSubstring: 'missing: react',
		build(dir) {
			writeConsumerWorkspace(dir, 'apps/c4', {
				manifest: compliantManifest('c4'),
				viteConfig: "export default {\n\tplugins: [],\n\tresolve: { dedupe: ['react-dom'] },\n};\n",
			});
		},
	},
	{
		label: 'dedupe array present but no resolve object key',
		kind: 'inversion',
		expectSubstring: 'no `resolve` object key found',
		build(dir) {
			writeConsumerWorkspace(dir, 'apps/c5', {
				manifest: compliantManifest('c5'),
				viteConfig: "export default {\n\tplugins: [],\n\tdedupe: ['react', 'react-dom'],\n};\n",
			});
		},
	},
	{
		label: 'no vite.config.* at all and no exemption',
		kind: 'inversion',
		expectSubstring: 'no production vite config found',
		build(dir) {
			writeConsumerWorkspace(dir, 'apps/c6', { manifest: compliantManifest('c6') });
		},
	},
	{
		label: 'manifest declares no scripts object',
		kind: 'inversion',
		expectSubstring: 'manifest declares no scripts object',
		build(dir) {
			writeConsumerWorkspace(dir, 'apps/c7', {
				manifest: { name: 'c7', private: true, dependencies: { '@votetorrent/ui-web': 'workspace:*' } },
				viteConfig: COMPLIANT_VITE_CONFIG,
			});
		},
	},
	{
		label: 'a gate-shaped script key whose command never mentions the canonical runner',
		kind: 'inversion',
		expectSubstring: 'no script command reaches the canonical runner',
		build(dir) {
			writeConsumerWorkspace(dir, 'apps/c8', {
				manifest: compliantManifest('c8', { scripts: { 'browser-gate': 'node scripts/legacy-runner.mjs --app .' } }),
				viteConfig: COMPLIANT_VITE_CONFIG,
			});
		},
	},
	{
		label: 'gate command references a run-ui-gates.mjs path that does not exist',
		kind: 'inversion',
		expectSubstring: 'does not exist on disk',
		build(dir) {
			writeConsumerWorkspace(dir, 'apps/c9', {
				manifest: compliantManifest('c9', { scripts: { 'browser-gate': 'node ./missing-dir/run-ui-gates.mjs --app .' } }),
				viteConfig: COMPLIANT_VITE_CONFIG,
			});
		},
	},
	{
		label: 'gate command references a forked copy at a different path (realpath mismatch)',
		kind: 'inversion',
		expectSubstring: 'does not resolve to the canonical runner',
		build(dir) {
			const consumerDir = writeConsumerWorkspace(dir, 'apps/c10', {
				manifest: compliantManifest('c10', { scripts: { 'browser-gate': 'node ./vendor/run-ui-gates.mjs --app .' } }),
				viteConfig: COMPLIANT_VITE_CONFIG,
			});
			writeText(path.join(consumerDir, 'vendor', 'run-ui-gates.mjs'), '// a forked copy, not the canonical runner\n');
		},
	},
	// --- Benign / inertness fixtures ---
	{
		label: 'a fully compliant consumer',
		kind: 'benign',
		build(dir) {
			writeConsumerWorkspace(dir, 'apps/b11', { manifest: compliantManifest('b11'), viteConfig: COMPLIANT_VITE_CONFIG });
		},
	},
	{
		label: 'reversed order, double quotes, trailing comma',
		kind: 'benign',
		build(dir) {
			writeConsumerWorkspace(dir, 'apps/b12', {
				manifest: compliantManifest('b12'),
				viteConfig: 'export default {\n\tplugins: [],\n\tresolve: { dedupe: ["react-dom", "react",] },\n};\n',
			});
		},
	},
	{
		label: 'array split across three lines',
		kind: 'benign',
		build(dir) {
			writeConsumerWorkspace(dir, 'apps/b13', {
				manifest: compliantManifest('b13'),
				viteConfig: [
					'export default {',
					'\tplugins: [],',
					'\tresolve: {',
					'\t\tdedupe: [',
					"\t\t\t'react',",
					"\t\t\t'react-dom',",
					'\t\t],',
					'\t},',
					'};',
					'',
				].join('\n'),
			});
		},
	},
	{
		label: 'a third entry in the dedupe array',
		kind: 'benign',
		build(dir) {
			writeConsumerWorkspace(dir, 'apps/b14', {
				manifest: compliantManifest('b14'),
				viteConfig: "export default {\n\tplugins: [],\n\tresolve: { dedupe: ['react', 'react-dom', 'some-other-lib'] },\n};\n",
			});
		},
	},
	{
		label: 'a compliant consumer that also ships the harness gate config with no dedupe',
		kind: 'benign',
		build(dir) {
			writeConsumerWorkspace(dir, 'apps/b15', {
				manifest: compliantManifest('b15'),
				viteConfig: COMPLIANT_VITE_CONFIG,
				gateConfig: 'export default {};\n',
			});
		},
	},
	{
		label: 'a no-vite-config consumer whose name is in a fixture NON_BROWSER_CONSUMERS map',
		kind: 'benign',
		nonBrowserConsumers: { 'exempt-consumer': 'this fixture consumer ships no browser build' },
		build(dir) {
			writeConsumerWorkspace(dir, 'apps/b16', { manifest: compliantManifest('exempt-consumer') });
		},
	},
	{
		label: 'a non-consumer workspace with neither dedupe nor a gate script produces no violation',
		kind: 'benign',
		build(dir) {
			writeConsumerWorkspace(dir, 'apps/keeper', { manifest: compliantManifest('keeper'), viteConfig: COMPLIANT_VITE_CONFIG });
			writeConsumerWorkspace(dir, 'apps/bystander', { manifest: { name: 'bystander', private: true, dependencies: {} } });
		},
	},
];

// ---------------------------------------------------------------------------
// Root-hoist fixtures — operate directly on manifest objects, no filesystem
// fixture root needed.
// ---------------------------------------------------------------------------

const ROOT_HOIST_FIXTURES = [
	{
		label: 'react in root devDependencies',
		kind: 'inversion',
		expectSubstring: 'React must never be hoisted',
		manifest: { devDependencies: { react: '19.0.0' } },
	},
	{
		label: 'descriptor-qualified react in root resolutions',
		kind: 'inversion',
		expectSubstring: 'React must never be hoisted',
		manifest: { resolutions: { 'react@npm:^19.0.0': '19.0.0' } },
	},
	{
		label: 'the real, legitimately pinned root resolutions object',
		kind: 'benign',
		manifest: {
			resolutions: {
				'@types/react': '19.2.17',
				'react-native-screens': '4.10.0',
				'@libp2p/peer-id@npm:^6.0.0': '6.0.13',
				'@quereus/quereus@npm:^4.17.1': 'patch:@quereus/quereus@npm%3A4.17.1#~/.yarn/patches/x.patch',
			},
		},
	},
];

// ---------------------------------------------------------------------------
// Fixture set runners.
// ---------------------------------------------------------------------------

function runDiscoveryFixtures() {
	let ran = 0;
	for (const fixture of DISCOVERY_FIXTURES) {
		withFixtureRoot(fixture.build, (dir) => {
			try {
				fixture.expect(dir);
				ran++;
			} catch (err) {
				fail(`discovery fixture "${fixture.label}" did not behave as expected: ${err.message}`);
			}
		});
	}
	ok(`${ran}/${DISCOVERY_FIXTURES.length} discovery fixture(s) behaved as expected.`);
}

function runCheckerFixtures() {
	let ran = 0;
	for (const fixture of CHECKER_FIXTURES) {
		withFixtureRoot(
			(dir) => {
				writeRootManifest(dir);
				writeCanonicalRunnerStub(dir);
				fixture.build(dir);
			},
			(dir) => {
				try {
					const canonicalRunnerRealPath = realpathSync(path.join(dir, CANONICAL_RUNNER_RELATIVE_PATH));
					const consumers = discoverConsumers(dir);
					const ctx = { canonicalRunnerRealPath, nonBrowserConsumers: fixture.nonBrowserConsumers ?? {} };
					const violations = consumers.flatMap((consumer) => checkConsumer(consumer, ctx));
					if (fixture.kind === 'inversion') {
						if (!violations.some((v) => v.includes(fixture.expectSubstring))) {
							throw new Error(`expected a violation containing "${fixture.expectSubstring}", got: ${JSON.stringify(violations)}`);
						}
					} else if (violations.length !== 0) {
						throw new Error(`expected zero violations, got: ${JSON.stringify(violations)}`);
					}
					ran++;
				} catch (err) {
					fail(`checker fixture "${fixture.label}" did not behave as expected: ${err.message}`);
				}
			},
		);
	}
	const inversionCount = CHECKER_FIXTURES.filter((f) => f.kind === 'inversion').length;
	const benignCount = CHECKER_FIXTURES.filter((f) => f.kind === 'benign').length;
	ok(
		`${ran}/${CHECKER_FIXTURES.length} checker fixture(s) behaved as expected — ${inversionCount} inversion ` +
			`fixture(s) produced their expected violation and ${benignCount} benign fixture(s) produced none, so the ` +
			'checkers are live and discriminating.',
	);
}

function runRootHoistFixtures() {
	let ran = 0;
	for (const fixture of ROOT_HOIST_FIXTURES) {
		const violations = checkRootHoist(fixture.manifest);
		if (fixture.kind === 'inversion') {
			if (!violations.some((v) => v.includes(fixture.expectSubstring))) {
				fail(`root-hoist fixture "${fixture.label}" did not produce the expected violation: ${JSON.stringify(violations)}`);
			}
		} else if (violations.length !== 0) {
			fail(`root-hoist fixture "${fixture.label}" was expected to produce zero violations, got: ${JSON.stringify(violations)}`);
		}
		ran++;
	}
	ok(`${ran}/${ROOT_HOIST_FIXTURES.length} root-hoist fixture(s) behaved as expected.`);
}

// ---------------------------------------------------------------------------
// Self-test entry point — runs on EVERY invocation, before the real scan.
// ---------------------------------------------------------------------------

runDiscoveryFixtures();
runCheckerFixtures();
runRootHoistFixtures();
// Print the (currently empty) exemption map on every run, per its own contract.
ok(`NON_BROWSER_CONSUMERS declares ${Object.keys(NON_BROWSER_CONSUMERS).length} exemption(s): ${JSON.stringify(NON_BROWSER_CONSUMERS)}`);

const SELF_TEST_ONLY = process.argv.includes('--self-test-only');
if (SELF_TEST_ONLY) {
	ok('self-test-only mode — exiting without scanning the real repository.');
	process.exit(0);
}

// ---------------------------------------------------------------------------
// The real scan.
// ---------------------------------------------------------------------------

const rootFlagIndex = process.argv.indexOf('--root');
const ROOT_OVERRIDE = rootFlagIndex !== -1 ? process.argv[rootFlagIndex + 1] : null;
const rootDir = ROOT_OVERRIDE ? path.resolve(ROOT_OVERRIDE) : process.cwd();

try {
	if (!ROOT_OVERRIDE) {
		const rootManifestPath = path.join(rootDir, 'package.json');
		if (!existsSync(rootManifestPath)) {
			throw new Error(`${rootManifestPath} does not exist — run this from the repository root, or pass --root <dir>.`);
		}
		const rootManifestProbe = JSON.parse(readFileSync(rootManifestPath, 'utf8'));
		if (!('workspaces' in rootManifestProbe)) {
			throw new Error(`${rootDir} does not look like the repository root — its package.json has no "workspaces" key.`);
		}
		if (!existsSync(path.join(rootDir, 'packages', 'ui-web', 'package.json'))) {
			throw new Error(`${rootDir} does not look like the repository root — packages/ui-web/package.json does not exist.`);
		}
	}

	const { consumers, violations, canonicalRunnerRealPath } = runAssertion(rootDir, { nonBrowserConsumers: NON_BROWSER_CONSUMERS });

	for (const consumer of consumers) {
		const configPath = findProductionViteConfig(consumer.dir);
		const gateResult = checkGateScript(consumer.manifest, consumer.dir, canonicalRunnerRealPath);
		process.stdout.write(
			`[assert-ui-web-dedupe-and-gate] CONSUMER: ${consumer.name} vite-config=${configPath ?? '(none)'} gate-script=${gateResult.scriptKey ?? '(none)'}\n`,
		);
	}

	if (violations.length > 0) {
		for (const v of violations) process.stderr.write(`[assert-ui-web-dedupe-and-gate] VIOLATION: ${v}\n`);
		fail(`${violations.length} violation(s) found across ${consumers.length} discovered consumer(s).`);
	}

	ok(`${consumers.length} consumer(s) discovered and verified clean: ${consumers.map((c) => c.name).join(', ')}.`);
	process.exit(0);
} catch (err) {
	fail(err.message);
}
