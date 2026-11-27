#!/usr/bin/env node
/**
 * run-ui-gates.mjs — the ONE shared browser-gate runner (D-19), invoked once
 * per consuming app against THAT app's own production build.
 *
 * WHY `vite dev` IS DISQUALIFIED AS A TRANSPORT: every gate that existed in
 * this repository before this file passed on all four candidate shared-
 * package shapes spike 090 measured, including one that cannot build at all
 * and two that ship broken — because a dev server compiles and serves
 * source on demand, which is not what a consumer's browser ever receives.
 * `yarn build` itself misses a real `TS2322` (Vite does not typecheck) and
 * misses the entire design-token layer being absent; counting the page's
 * loaded style resources is likewise blind — that count is unchanged even
 * with every token removed, which is exactly why this runner never gates on
 * it (see `token-declared-values` below instead). This runner therefore
 * NEVER starts a dev server: it always builds (unless `--skip-build`) and
 * serves the resulting `dist/`-shaped directory over `lib/serve-dist.mjs`.
 *
 * FLAG CATALOGUE:
 *   --app <dir>            App directory to gate. Default: `.` (resolved to
 *                           an absolute path from the invoking cwd).
 *   --gate-config <path>   Vite config for the GATE build, resolved relative
 *                           to `--app`. Default: `test/browser/vite.gate.config.ts`
 *                           (the dashboard's own layout — see "Per-app
 *                           layout" below for why that default is not a
 *                           canonical fact).
 *   --gate-dist <path>     Directory the gate build emits into, resolved
 *                           relative to `--app`. Default: `test/browser/dist`.
 *   --gate-entry <name>    Filename of the harness HTML entry the gate build
 *                           must emit exactly one of. Default: `ui-gate.html`.
 *   --port <n>              Port `serve-dist.mjs` binds. Default: `5183`, or
 *                           the `UI_GATE_PORT` environment variable.
 *   --skip-build            Reuse an existing `--gate-dist` build rather than
 *                           rebuilding it.
 *   --list-rungs             Print the frozen rung ids, one per line, and
 *                           exit 0.
 * Any other argument, including any unrecognised `--prove-*`, exits 2 naming
 * the offending flag — an unknown flag must never be silently ignored into a
 * green run.
 *
 * PER-APP LAYOUT — named defaults, not frozen facts. D-19's requirement is
 * that ONE shared runner is invoked ONCE PER CONSUMING APP against that
 * app's OWN production build. The two consumers do not, and will not, share
 * a directory layout: the dashboard's gate config lives under `test/browser/`
 * and emits into `test/browser/dist` (this plan's own Task 3), while the
 * public app's lives at the app root and emits into `dist-gate/` with its
 * own entry filename (53-06/53-07 own that app's layout). A runner that
 * could only express one app's layout could not satisfy D-19 — so
 * `--gate-config`/`--gate-dist`/`--gate-entry`/`--port` are documented CLI
 * overrides, each resolved relative to `--app` (except `--port`), and every
 * downstream reference in this file uses the RESOLVED per-invocation value,
 * never a constant directly. The dashboard's values are the DEFAULTS purely
 * because it is the first consumer, never because they are canonical.
 *
 * PORT POLICY, stated once for the whole phase. `5180` is the dashboard's
 * dev/preview port. `5181` is `run-headless.mjs`'s dev-server port AND the
 * public app's dev/preview port (53-06) — that overlap is harmless and
 * deliberately tolerated, because `vite dev` is never a gate and CI never
 * starts the public app's dev or preview server, so the two never bind
 * concurrently. `5183` is the dashboard's gate port (this plan) and `5191`
 * is the public app's gate port (53-09); they are distinct from each other
 * and from 5180/5181. A BOUND PORT MUST FAIL THE RUN LOUDLY:
 * `lib/serve-dist.mjs` propagates the `listen` error rather than retrying,
 * falling back, or picking another port, and this runner exits 2 with a
 * message naming the port and the flag that would change it.
 *
 * THE INVERSION SEAM (53-11's landing site, per D-20). `INVERSION_CONTROLS`
 * is declared below as an empty, frozen object. 53-11 adds exactly two
 * entries — `--prove-token-missing` and `--prove-dedupe-removed` — that each
 * rebuild a MUTATED PRODUCTION VARIANT (never mutate `--gate-dist` post-
 * build, never inject at runtime: spike 089 measured a runtime React-
 * identity check as false-negative because esbuild hands importers
 * different namespace wrappers around one module) and must print the
 * literal string `is inert` and exit non-zero when the underlying run it
 * inverts still passes. `finishRun(underlyingRunPassed, reason)` reports the
 * NORMAL run's verdict only; `runProveNoDedupe`/`runProveTokenMissing` each
 * print their own dedicated `is inert`/"genuinely failed" verdict line
 * directly rather than routing through it (WR-14, Phase 53 review — an
 * earlier inversion-aware branch on `finishRun` was dead code coupled to a CI
 * grep floor, and was removed).
 *
 * `import { chromium } from 'playwright'` — the FULL package, never the
 * lighter core-only sibling, and never a hardcoded system-Chrome binary path
 * (the spikes' macOS Chrome path does not exist on `ubuntu-24.04`). Never
 * request a named browser channel such as the real-Chrome one — plain
 * `chromium.launch({ headless: true })` works locally at HEAD; the
 * CONTEXT.md caveat about Playwright not running locally is stale
 * (53-08-PLAN.md constraint 3). Reworded (53-09) to avoid this file's own
 * acceptance criterion tripping on its own header prose — see
 * `gate-source-integrity.test.mjs`'s comment-stripping discipline for the
 * same class of self-tripping check this criterion's grep is.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { serveDist } from './lib/serve-dist.mjs';
import { parseTokensCss, normaliseTokenValue, hexToRgb, compareToken, BASE_RULE_CHECKS } from './lib/tokens.mjs';
import { readMutationReport } from './mutations.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Cross-page readout channel names — a shared runner and a shared name, so no consumer invents its own. */
export const GATE_READOUT_GLOBAL = '__UI_GATE__';
export const GATE_DONE_GLOBAL = '__UI_GATE_DONE__';

/**
 * Frozen rung-id registry, module-level, single source of truth. `record()`
 * throws on any id outside this array — the structural enforcement of "do
 * not interpolate a value under test into a check's name": a rung cannot be
 * named after anything computed. `gate-source-integrity.test.mjs` greps for
 * this literal name.
 */
export const RUNG_IDS = Object.freeze([
	'harness-readout',
	'shared-components-mounted',
	'resolved-component-styles',
	'token-declared-values',
	'base-rule-used-values',
	'identity:hook-mounted',
	'identity:hook-interaction',
	'identity:same-use-state',
	'identity:same-internals',
	'identity:no-dispatcher-error',
]);

/**
 * `resolved-component-styles` (CR-01, 53-CR01's gap-closure round). Where
 * `shared-components-mounted` above only asserts a harness wrapper has a
 * non-empty child (true regardless of styling — this is exactly how CR-01's
 * defect survived every existing rung), this rung reads a declared CSS
 * property off the component's OWN rendered element and requires it to match
 * the value `packages/ui-web/src/components.css` declares for it. Each
 * `selector` below is queried as a DESCENDANT of the harness's
 * `[data-ui-gate="<gate>"]` wrapper first (both harnesses wrap
 * `AdvisoryDisclosure`/`LifecyclePill` in an extra harness-only element,
 * since each renders a childless text node); if that finds nothing, the
 * wrapper element itself is tried (both harnesses tag `DetailsToggle`'s own
 * `.dt-toggle-group` root directly, with no extra wrapper).
 *
 * `expected` values are transcribed from `components.css` as authored in the
 * same commit that added this rung — this table going red on an unrelated,
 * deliberate CSS edit is a signal to update the table, not to silence the
 * rung.
 *
 * `apps` (60-03, D-10/D-15): an optional frozen array of consuming-app
 * `package.json` `name` fields. A check with no `apps` field runs against
 * every consumer, exactly as the three original entries always have. A
 * check WITH an `apps` field is skipped — never silently reported "not
 * found" — for any app whose own `name` is not a member of that array. The
 * four chart entries below are scoped to `votetorrent-dashboard` only: the
 * public app's own chart proof belongs to 60-08's public gate, and scoping
 * here keeps the public run's rung count and verdict untouched by this
 * plan. An IN-SCOPE check that finds no element still reports the existing
 * "not found" problem — scoping must never become a second, silent way for
 * a check to vanish.
 *
 * @type {ReadonlyArray<{ gate: string, selector: string, cssProperty: string, expected: string, apps?: ReadonlyArray<string> }>}
 */
const RESOLVED_STYLE_CHECKS = Object.freeze([
	Object.freeze({ gate: 'LifecyclePill', selector: '.lifecycle-pill', cssProperty: 'borderTopStyle', expected: 'solid' }),
	Object.freeze({ gate: 'AdvisoryDisclosure', selector: '.pv-disclosure', cssProperty: 'fontSize', expected: '12px' }),
	Object.freeze({ gate: 'DetailsToggle', selector: '.dt-toggle-group', cssProperty: 'flexDirection', expected: 'column' }),
	// The four 60-03 chart colour-mechanism checks. Every `expected` value is
	// the rgb() read-back of the matching token as declared in tokens.css —
	// `--ok: #22c55e`, `--chart-series-2: #d95926`, `--chart-series-1:
	// #3987e5` — never the hex the token declares. An unresolved token
	// computes to `rgb(0, 0, 0)`, which is what the `--prove-token-missing`
	// control (below) requires these four entries to go red under.
	Object.freeze({
		gate: 'BarSeries',
		selector: '.vt-chart__bar--ok',
		cssProperty: 'fill',
		expected: 'rgb(34, 197, 94)',
		apps: Object.freeze(['votetorrent-dashboard']),
	}),
	Object.freeze({
		gate: 'StackedBarSeries',
		selector: '.vt-chart__segment--series-2',
		cssProperty: 'fill',
		expected: 'rgb(217, 89, 38)',
		apps: Object.freeze(['votetorrent-dashboard']),
	}),
	Object.freeze({
		gate: 'TimeSeries',
		selector: '.vt-chart__line',
		cssProperty: 'stroke',
		expected: 'rgb(57, 135, 229)',
		apps: Object.freeze(['votetorrent-dashboard']),
	}),
	Object.freeze({
		gate: 'Meter',
		selector: '.vt-chart__meter-fill',
		cssProperty: 'backgroundColor',
		expected: 'rgb(57, 135, 229)',
		apps: Object.freeze(['votetorrent-dashboard']),
	}),
]);

/**
 * The React-identity rung group (D-19, 53-09). Every rung id above is a
 * STATIC string literal, never a template literal interpolating a value
 * under test — `gate-source-integrity.test.mjs`'s rung (2) enforces this
 * structurally, and it applies to these five rungs exactly as it already
 * applies to the four 53-08 landed.
 *
 * A duplicate React is harmless for a purely presentational component; it
 * bites only at the HOOK DISPATCHER a real `useState` call reads through
 * (measured signature: `Cannot read properties of null (reading
 * 'useState')`, 19/19 → 8/12 — see this file's own header). The mount rung
 * below cannot see that failure by itself: a duplicate React still renders
 * a hook-bearing component's initial output correctly in every variant
 * spike 089 measured. The REAL click in `identity:hook-interaction` is what
 * makes this gate see anything a mount alone could not — it drives a live
 * state transition through the dispatcher itself, not merely the initial
 * render.
 */
const DISPATCHER_NULL_ERROR_RE =
	/Cannot read properties of null \(reading '(useState|useRef|useEffect|useContext|useMemo)'\)/;

/** Per-app layout defaults — see this file's header "PER-APP LAYOUT" note. */
const DEFAULT_GATE_CONFIG_REL = 'test/browser/vite.gate.config.ts';
const DEFAULT_GATE_DIST_REL = 'test/browser/dist';
const DEFAULT_GATE_ENTRY_NAME = 'ui-gate.html';
const DEFAULT_PORT = 5183;

/**
 * The inversion seam (53-11, D-20). Exactly two entries, one per control —
 * `--prove-no-dedupe` (the dashboard's D-19 seam, spike 089's measured
 * 19/19 -> 8/12 partial-failure shape) and `--prove-token-missing` (D-23's
 * resolved-computed-value probe, the only observation that can see a token
 * layer whose reference was removed). See this file's header "THE INVERSION
 * SEAM" note for the full contract each control must satisfy.
 */
const INVERSION_CONTROLS = Object.freeze({
	'--prove-no-dedupe': Object.freeze({ mutation: 'no-dedupe', inversionId: '--prove-no-dedupe' }),
	'--prove-token-missing': Object.freeze({ mutation: 'token-missing', inversionId: '--prove-token-missing' }),
});

const KNOWN_FLAGS = new Set([
	'--app',
	'--gate-config',
	'--gate-dist',
	'--gate-entry',
	'--port',
	'--skip-build',
	'--list-rungs',
	'--prove-no-dedupe',
	'--prove-token-missing',
]);

/**
 * WR-05 (Phase 53 review): the five flags below take a value. This file's own
 * header states "An unknown flag is never silently ignored" -- a TRUNCATED
 * value-taking flag (missing its value entirely, or immediately followed by
 * another known flag) is the same class of silent failure: `argv[(i += 1)]`
 * previously read `undefined` or the next flag's own text as if it were this
 * flag's value, and `opts.gateConfig ?? DEFAULT_GATE_CONFIG_REL` in `main()`
 * then silently substituted the dashboard's own layout default for a
 * consumer that asked for something else and never got it.
 */
const VALUE_FLAGS = new Set(['--app', '--gate-config', '--gate-dist', '--gate-entry', '--port']);

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
	/** @type {{ app: string, gateConfig: string | null, gateDist: string | null, gateEntry: string | null, port: string | null, skipBuild: boolean, listRungs: boolean, proveNoDedupe: boolean, proveTokenMissing: boolean }} */
	const opts = {
		app: '.',
		gateConfig: null,
		gateDist: null,
		gateEntry: null,
		port: null,
		skipBuild: false,
		listRungs: false,
		proveNoDedupe: false,
		proveTokenMissing: false,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (!KNOWN_FLAGS.has(arg)) {
			process.stderr.write(
				`[run-ui-gates] unrecognised argument "${arg}" — every flag must be one of ${[...KNOWN_FLAGS].join(', ')}. An unknown flag is never silently ignored.\n`,
			);
			process.exit(2);
		}
		if (VALUE_FLAGS.has(arg) && (i + 1 >= argv.length || KNOWN_FLAGS.has(argv[i + 1]))) {
			process.stderr.write(
				`[run-ui-gates] ${arg} requires a value — a missing value must never fall back to a default.\n`,
			);
			process.exit(2);
		}
		switch (arg) {
			case '--app':
				opts.app = argv[(i += 1)];
				break;
			case '--gate-config':
				opts.gateConfig = argv[(i += 1)];
				break;
			case '--gate-dist':
				opts.gateDist = argv[(i += 1)];
				break;
			case '--gate-entry':
				opts.gateEntry = argv[(i += 1)];
				break;
			case '--port':
				opts.port = argv[(i += 1)];
				break;
			case '--skip-build':
				opts.skipBuild = true;
				break;
			case '--list-rungs':
				opts.listRungs = true;
				break;
			case '--prove-no-dedupe':
				opts.proveNoDedupe = true;
				break;
			case '--prove-token-missing':
				opts.proveTokenMissing = true;
				break;
			default:
				break;
		}
	}
	return opts;
}

/**
 * Resolves `relPath` against `appDir` and requires the result to remain
 * inside `appDir` — a `--gate-config`/`--gate-dist`/`--gate-entry` value that
 * escapes the `--app` directory exits 2.
 *
 * @param {string} appDir
 * @param {string} relPath
 * @param {string} flagName
 */
function resolveWithinApp(appDir, relPath, flagName) {
	const resolved = path.resolve(appDir, relPath);
	const relative = path.relative(appDir, resolved);
	const escapes = relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
	if (escapes) {
		process.stderr.write(`[run-ui-gates] ${flagName} "${relPath}" resolves outside --app "${appDir}"\n`);
		process.exit(2);
	}
	return resolved;
}

/** @type {Array<{ id: string, passed: boolean, detail: string }>} */
const rungs = [];

/**
 * @param {string} id
 * @param {boolean} passed
 * @param {string} detail
 */
function record(id, passed, detail) {
	if (!RUNG_IDS.includes(id)) {
		throw new Error(`record(): "${id}" is not a member of RUNG_IDS`);
	}
	rungs.push({ id, passed, detail });
}

/**
 * Empties the module-level `rungs` array (53-11, D-20) — the two `--prove-*`
 * controls each drive TWO full gate passes in one process (a healthy
 * baseline leg, then a mutant leg), and every rung function above records
 * into this ONE shared array via `record()`. Never called by the normal
 * (non-control) flow, which runs exactly one pass per process.
 */
function resetRungs() {
	rungs.length = 0;
}

/**
 * Spawns `vite build --config <gateConfigRel>` with `cwd: appDir`, streaming
 * stdout/stderr prefixed `[vite build]`. Rejects (via process.exit(2)) if
 * `gateConfigAbs` does not exist — a consuming app without a gate config is
 * a setup error, not a gate failure.
 *
 * @param {string} appDir
 * @param {string} gateConfigAbs
 * @param {string} gateConfigRel
 */
async function buildGateEntry(appDir, gateConfigAbs, gateConfigRel) {
	if (!existsSync(gateConfigAbs)) {
		process.stderr.write(
			`[run-ui-gates] gate config not found at "${gateConfigAbs}" (--gate-config "${gateConfigRel}"). ` +
				`Every consumer of this runner must supply a gate vite config that imports and merges its ` +
				`own vite.config.ts — see packages/ui-web/README.md's "Browser gates (D-19)" harness contract.\n`,
		);
		process.exit(2);
	}
	const viteBin = path.join(appDir, 'node_modules', 'vite', 'bin', 'vite.js');
	await new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(process.execPath, [viteBin, 'build', '--config', gateConfigRel], {
			cwd: appDir,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		child.stdout?.on('data', (d) => process.stdout.write(`[vite build] ${d}`));
		child.stderr?.on('data', (d) => process.stderr.write(`[vite build] ${d}`));
		child.on('error', rejectPromise);
		child.on('exit', (code) => {
			if (code === 0) resolvePromise(undefined);
			else rejectPromise(new Error(`vite build (--config ${gateConfigRel}) exited with code ${code}`));
		});
	});
}

/**
 * Walks `gateDistDir` recursively for files named `gateEntryName`, requiring
 * EXACTLY ONE match. Resolves by search rather than by predicting Vite's
 * output path algebra for a non-root HTML input.
 *
 * @param {string} gateDistDir
 * @param {string} gateEntryName
 */
function resolveGateEntry(gateDistDir, gateEntryName) {
	if (!existsSync(gateDistDir)) {
		process.stderr.write(`[run-ui-gates] gate dist directory "${gateDistDir}" does not exist — did the build run?\n`);
		process.exit(2);
	}

	/** @param {string} dir @returns {string[]} */
	function walk(dir) {
		/** @type {string[]} */
		const out = [];
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				out.push(...walk(full));
			} else if (entry.name === gateEntryName) {
				out.push(full);
			}
		}
		return out;
	}

	const matches = walk(gateDistDir);
	if (matches.length === 0) {
		process.stderr.write(
			`[run-ui-gates] gate build emitted no "${gateEntryName}" under "${gateDistDir}" (--gate-entry "${gateEntryName}" names the file to look for)\n`,
		);
		process.exit(2);
	}
	if (matches.length > 1) {
		process.stderr.write(
			`[run-ui-gates] gate build emitted ${matches.length} files named "${gateEntryName}":\n${matches.map((m) => `  - ${m}`).join('\n')}\n`,
		);
		process.exit(2);
	}
	return path.relative(gateDistDir, matches[0]);
}

/**
 * Spawns `vite build --config <configRel>` with `cwd: appDir` and an
 * additional `env` (53-11, D-20) — the lenient sibling of `buildGateEntry`
 * above, used ONLY by the two `--prove-*` controls' mutant-build step. Unlike
 * `buildGateEntry`, this NEVER calls `process.exit`: a control must
 * distinguish "the mutant build failed" from every other precondition
 * failure, each with its own message, and an abrupt exit would collapse all
 * of them into one exit code with no attribution.
 *
 * @param {string} appDir
 * @param {string} configRel
 * @param {Record<string, string>} env
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function spawnViteBuild(appDir, configRel, env) {
	const viteBin = path.join(appDir, 'node_modules', 'vite', 'bin', 'vite.js');
	return new Promise((resolvePromise) => {
		let stdout = '';
		let stderr = '';
		const child = spawn(process.execPath, [viteBin, 'build', '--config', configRel], {
			cwd: appDir,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, ...env },
		});
		child.stdout?.on('data', (d) => {
			stdout += String(d);
			process.stdout.write(`[vite build --config ${configRel}] ${d}`);
		});
		child.stderr?.on('data', (d) => {
			stderr += String(d);
			process.stderr.write(`[vite build --config ${configRel}] ${d}`);
		});
		child.on('error', (err) => resolvePromise({ code: 1, stdout, stderr: stderr + String(err) }));
		child.on('exit', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
	});
}

/**
 * Resolves the DISTINCT React installations reachable from `appDir` (53-11,
 * D-20's `--prove-no-dedupe` precondition (2)): the app's own
 * `node_modules/react` and the shared `@votetorrent/ui-web` package's own
 * `node_modules/react`. Every candidate is resolved with `fs.realpathSync`
 * and de-duplicated on the realpath — spike 089's FIRST copy-counter
 * followed the `@votetorrent/ui-web` symlink recursively and reported 5
 * copies where `find` said 3 (`.planning/spikes/089-.../README.md` step 7).
 * This function refuses to repeat that: it resolves the `@votetorrent/ui-web`
 * symlink exactly ONCE (to find that package's own `node_modules/react`) and
 * never walks further into anything it finds there.
 *
 * @param {string} appDir
 * @returns {string[]} distinct realpaths, in resolution order
 */
function resolveReactCopies(appDir) {
	/** @type {string[]} */
	const candidates = [];

	const appReactPkg = path.join(appDir, 'node_modules', 'react', 'package.json');
	if (existsSync(appReactPkg)) {
		candidates.push(path.dirname(appReactPkg));
	}

	const uiWebLink = path.join(appDir, 'node_modules', '@votetorrent', 'ui-web');
	if (existsSync(uiWebLink)) {
		// Resolve the symlink exactly once — never descend into whatever else
		// lives inside the resolved target directory.
		const uiWebReal = realpathSync(uiWebLink);
		const uiWebReactPkg = path.join(uiWebReal, 'node_modules', 'react', 'package.json');
		if (existsSync(uiWebReactPkg)) {
			candidates.push(path.dirname(uiWebReactPkg));
		}
	}

	const realpaths = candidates.map((p) => realpathSync(p));
	return [...new Set(realpaths)];
}

/**
 * WR-03 (Phase 53 review): `runGatePassLenient` returns a union of a failure
 * shape and a success shape, discriminated on `ok`. Without an explicit
 * `@returns` annotation, TypeScript infers `ok` widened to plain `boolean` in
 * BOTH branches (an object literal's property type widens unless a
 * contextual type pins it), which silently defeats `if (!x.ok) return;`
 * narrowing at every call site — the exact shape of the 7 live `TS18048`
 * ('...possibly undefined') errors this annotation removes. Naming the union
 * here, once, keeps `ok` a true literal discriminant everywhere this
 * function's result flows.
 * @typedef {{ ok: false, stage: string, message: string }} GatePassFailure
 * @typedef {{ ok: true, readout: any, lines: string[], tokenCount: number,
 *   rungs: Array<{id: string, passed: boolean, detail: string}>, total: number,
 *   passed: number, allPassed: boolean, extra: unknown }} GatePassSuccess
 */

/**
 * The lenient sibling of `main()`'s own build+serve+drive+rung sequence
 * (53-11, D-20), used ONLY by the two `--prove-*` controls. Every failure is
 * RETURNED as a labelled result rather than causing `process.exit` — a
 * control must distinguish "the build failed" from "the entry could not be
 * resolved" from "the port was bound" from "the wrong shape fired", and an
 * abrupt exit would collapse all of them into one exit code. Reuses every
 * REAL rung function (`runOnPage`, `runHarnessReadoutRung`,
 * `runSharedComponentsRung`, `runTokenRungs`, `runIdentityRungs`) and the
 * same `serveDist`/`chromium` transport `main()` uses — never `vite dev`,
 * never a second copy of any rung.
 *
 * @param {{ appDir: string, buildConfigRel: string | null, buildEnv?: Record<string, string>, distAbs: string, entryName: string, port: number, extraPageWork?: (page: import('playwright').Page) => Promise<any> }} opts
 * @returns {Promise<GatePassFailure | GatePassSuccess>}
 */
async function runGatePassLenient({ appDir, buildConfigRel, buildEnv, distAbs, entryName, port, extraPageWork }) {
	resetRungs();

	if (buildConfigRel) {
		const buildResult = await spawnViteBuild(appDir, buildConfigRel, buildEnv ?? {});
		if (buildResult.code !== 0) {
			return {
				ok: false,
				stage: 'build',
				message: `build (--config ${buildConfigRel}) exited with code ${buildResult.code}`,
			};
		}
	}

	if (!existsSync(distAbs)) {
		return { ok: false, stage: 'dist-missing', message: `gate dist directory "${distAbs}" does not exist` };
	}

	/** @param {string} dir @returns {string[]} */
	function walk(dir) {
		/** @type {string[]} */
		const out = [];
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) out.push(...walk(full));
			else if (entry.name === entryName) out.push(full);
		}
		return out;
	}
	const matches = walk(distAbs);
	if (matches.length !== 1) {
		return {
			ok: false,
			stage: 'entry-resolution',
			message: `expected exactly one "${entryName}" under "${distAbs}", found ${matches.length}`,
		};
	}
	const entryRel = path.relative(distAbs, matches[0]);

	let serverHandle;
	let browser;
	try {
		try {
			serverHandle = await serveDist(distAbs, port);
		} catch (err) {
			const code = /** @type {any} */ (err)?.code;
			if (code === 'EADDRINUSE') {
				return { ok: false, stage: 'port', message: `port ${port} is already bound` };
			}
			throw err;
		}

		browser = await chromium.launch({ headless: true });
		const page = await browser.newPage();
		const url = `${serverHandle.url}/${entryRel}`;
		const { readout, lines } = await runOnPage(page, url, `control app=${path.basename(appDir)} dist=${path.basename(distAbs)}`);

		runHarnessReadoutRung(readout);
		await runSharedComponentsRung(page, readout);
		await runResolvedStyleRung(page, resolveAppPackageName(appDir));
		const tokenCount = await runTokenRungs(page);
		await runIdentityRungs(page, readout, lines);

		let extra;
		if (extraPageWork) {
			extra = await extraPageWork(page);
		}

		await page.close();
		printSummaryTable();

		const snapshot = rungs.slice();
		const passed = snapshot.filter((r) => r.passed).length;
		return {
			ok: true,
			readout,
			lines,
			tokenCount,
			rungs: snapshot,
			total: snapshot.length,
			passed,
			allPassed: passed === snapshot.length,
			extra,
		};
	} finally {
		await browser?.close();
		await serverHandle?.close();
	}
}

/**
 * Drives an already-open page to `url` and reads its `__UI_GATE__` /
 * `__UI_GATE_DONE__` readout. Deliberately does NOT close `page` — unlike
 * `run-headless.mjs`'s per-call close (that file's tier-2 flow needs
 * page ISOLATION across seed/verify pairs), this runner's remaining rungs
 * (`shared-components-mounted`, `token-declared-values`,
 * `base-rule-used-values`) all need to query the SAME already-rendered DOM
 * and the SAME `getComputedStyle` the harness produced — closing here would
 * make every rung after this one unable to run. The caller closes the page
 * once every rung that needs it has run.
 *
 * @param {import('playwright').Page} page
 * @param {string} url
 * @param {string} label
 */
async function runOnPage(page, url, label) {
	/** @type {string[]} */
	const lines = [];
	page.on('console', (m) => lines.push(`[${m.type()}] ${m.text()}`));
	page.on('pageerror', (e) => lines.push(`[pageerror] ${e.message}`));
	await page.goto(url, { waitUntil: 'load' });
	await page
		.waitForFunction((name) => /** @type {any} */ (globalThis)[name] === true, GATE_DONE_GLOBAL, { timeout: 60_000 })
		.catch(() => {});
	const readout = await page.evaluate((name) => /** @type {any} */ (globalThis)[name] ?? null, GATE_READOUT_GLOBAL);

	console.log(`\n===== ${label} =====`);
	for (const l of lines) console.log(l);
	// A missing readout is a DISTINCT verdict from a partial one (a readout
	// that published but has some rungs failed): a harness that never got far
	// enough to publish ANYTHING (a whole-page crash before __UI_GATE_DONE__
	// was ever set) reads "NO RESULT" here, exactly as run-headless.mjs's own
	// runOnPage already distinguishes the two. Preserving this distinction is
	// what lets identity:hook-mounted/hook-interaction fail while
	// harness-readout, token-declared-values and base-rule-used-values still
	// pass — the measured 19/19 → 8/12 PARTIAL signature (d)(ii) requires.
	if (readout == null) {
		console.log('NO RESULT');
	}
	return { readout, lines };
}

/**
 * `harness-readout`: passes when the readout is non-null, its `error` field
 * is `null`, and its `mounted` field is a non-empty array.
 *
 * @param {any} readout
 */
function runHarnessReadoutRung(readout) {
	const passed = readout != null && readout.error === null && Array.isArray(readout.mounted) && readout.mounted.length > 0;
	record('harness-readout', passed, passed ? `mounted=${readout.mounted.length}` : `readout=${JSON.stringify(readout)}`);
	return passed;
}

/**
 * Parses the named exports of `components.js`, matching only the explicit
 * form `export { Name } from './components/Name.js';`, one per line.
 * Exits 2 if the file contains an `export *` — a star re-export makes the
 * export set unenumerable and this rung un-total.
 *
 * @param {string} componentsSource
 */
function parseComponentExportNames(componentsSource) {
	if (/export\s*\*/.test(componentsSource)) {
		process.stderr.write(
			'[run-ui-gates] packages/ui-web/src/components.js contains an `export *` — a star re-export makes the export set unenumerable, which makes the shared-components-mounted rung un-total. Rewrite it as explicit `export { Name } from \'./components/Name.js\';` lines.\n',
		);
		process.exit(2);
	}
	/** @type {string[]} */
	const names = [];
	const re = /^export \{ (\w+) \} from '\.\/components\/\1\.js';$/gm;
	let match;
	while ((match = re.exec(componentsSource)) !== null) {
		names.push(match[1]);
	}
	return names;
}

/**
 * `shared-components-mounted`: every named export of `components.js` must
 * appear in `readout.mounted` AND the built page must have a
 * `[data-ui-gate="Name"]` element with `childElementCount > 0` for each — a
 * component that mounts but renders nothing fails.
 *
 * @param {import('playwright').Page} page
 * @param {any} readout
 */
async function runSharedComponentsRung(page, readout) {
	const componentsSource = readFileSync(new URL('../src/components.js', import.meta.url), 'utf8');
	const names = parseComponentExportNames(componentsSource);
	const mountedSet = new Set(readout?.mounted ?? []);
	/** @type {string[]} */
	const problems = [];
	for (const name of names) {
		if (!mountedSet.has(name)) {
			problems.push(`${name}: not present in readout.mounted`);
			continue;
		}
		// eslint-disable-next-line no-await-in-loop -- sequential DOM reads against the one shared page, mirrors run-headless.mjs's own driveTier3Rungs discipline
		const hasNonEmptyBody = await page.evaluate((n) => {
			const el = document.querySelector(`[data-ui-gate="${n}"]`);
			return el != null && el.childElementCount > 0;
		}, name);
		if (!hasNonEmptyBody) {
			problems.push(`${name}: [data-ui-gate="${name}"] missing or has zero child elements`);
		}
	}
	record(
		'shared-components-mounted',
		problems.length === 0,
		problems.length === 0 ? `${names.length}/${names.length} components mounted and non-empty` : problems.join('; '),
	);
}

/**
 * Reads the `name` field of `appDir`'s own `package.json` (60-03) — the
 * value every `RESOLVED_STYLE_CHECKS` entry's optional `apps` array is
 * matched against. Returns `null` rather than throwing on a missing/
 * unparseable `package.json`, so a check scoped by `apps` simply stays
 * out of scope rather than crashing the run.
 *
 * @param {string} appDir
 * @returns {string | null}
 */
function resolveAppPackageName(appDir) {
	try {
		const pkg = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8'));
		return typeof pkg.name === 'string' ? pkg.name : null;
	} catch {
		return null;
	}
}

/**
 * `resolved-component-styles` (CR-01, see `RESOLVED_STYLE_CHECKS`'s own
 * header for the full rationale). Reads each check's `cssProperty` off the
 * component's OWN rendered element — never the harness's
 * `[data-ui-gate]` wrapper directly, unless that wrapper element IS the
 * component's own root (`DetailsToggle`'s `.dt-toggle-group`, tagged directly
 * by both harnesses).
 *
 * `appPackageName` (60-03) narrows `RESOLVED_STYLE_CHECKS` to the checks
 * in scope for THIS app: a check with no `apps` field always runs; a check
 * with an `apps` field runs only when `appPackageName` is a member. An
 * in-scope check that finds no element still reports "not found" — scoping
 * out-of-scope checks must never become a second way for a real miss to go
 * unreported.
 *
 * @param {import('playwright').Page} page
 * @param {string | null} appPackageName
 */
async function runResolvedStyleRung(page, appPackageName) {
	const inScopeChecks = RESOLVED_STYLE_CHECKS.filter((check) => !check.apps || check.apps.includes(/** @type {string} */ (appPackageName)));
	/** @type {string[]} */
	const problems = [];
	for (const check of inScopeChecks) {
		// eslint-disable-next-line no-await-in-loop -- sequential DOM reads against the one shared page, mirrors runSharedComponentsRung's own discipline
		const value = await page.evaluate((c) => {
			const wrapper = document.querySelector(`[data-ui-gate="${c.gate}"]`);
			if (wrapper == null) return null;
			const el = wrapper.querySelector(c.selector) ?? (wrapper.matches(c.selector) ? wrapper : null);
			if (el == null) return null;
			return /** @type {any} */ (getComputedStyle(el))[c.cssProperty];
		}, check);
		if (value == null) {
			problems.push(`${check.gate}: "${check.selector}" not found under [data-ui-gate="${check.gate}"]`);
			continue;
		}
		if (value !== check.expected) {
			problems.push(`${check.gate}: ${check.cssProperty}=${JSON.stringify(value)}, expected ${JSON.stringify(check.expected)}`);
		}
	}
	record(
		'resolved-component-styles',
		problems.length === 0,
		problems.length === 0
			? `${inScopeChecks.length}/${inScopeChecks.length} resolved styles matched`
			: problems.join('; '),
	);
}

/**
 * `token-declared-values` (D-23, TOTAL) and `base-rule-used-values` (the
 * D-15 base/reset half). Reads `packages/ui-web/src/tokens.css` via a
 * package-relative URL — the package's OWN source, never the app's.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<number>} the token count enumerated, for the receipt line
 */
async function runTokenRungs(page) {
	const tokensCssSource = readFileSync(new URL('../src/tokens.css', import.meta.url), 'utf8');
	const { tokens, rootDeclarationLineCount, hasRegisteredProperty } = parseTokensCss(tokensCssSource);

	if (tokens.size === 0) {
		record('token-declared-values', false, 'parsed zero tokens from tokens.css');
		record('base-rule-used-values', false, 'skipped — zero tokens parsed, see token-declared-values');
		return 0;
	}
	if (tokens.size !== rootDeclarationLineCount) {
		record(
			'token-declared-values',
			false,
			`tokens.size=${tokens.size} !== rootDeclarationLineCount=${rootDeclarationLineCount} — the two independent parses disagree`,
		);
		record('base-rule-used-values', false, 'skipped — parser disagreement, see token-declared-values');
		return tokens.size;
	}
	if (hasRegisteredProperty) {
		process.stderr.write(
			'[run-ui-gates] tokens.css contains an @property registration — a registered custom property has a COMPUTED, engine-normalised value, which invalidates this probe\'s exact declared-value comparison. Extend this probe deliberately before such a token lands.\n',
		);
		process.exit(2);
	}

	const names = [...tokens.keys()];
	const actual = await page.evaluate((tokenNames) => {
		const cs = getComputedStyle(document.documentElement);
		/** @type {Record<string, string>} */
		const out = {};
		for (const name of tokenNames) out[name] = cs.getPropertyValue(name);
		return out;
	}, names);

	/** @type {Array<{ name: string, expected: string, actual: string }>} */
	const mismatches = [];
	for (const name of names) {
		const expected = /** @type {string} */ (tokens.get(name));
		const actualValue = actual[name] ?? '';
		const { passed } = compareToken(expected, actualValue);
		if (!passed) mismatches.push({ name, expected, actual: actualValue });
	}
	record(
		'token-declared-values',
		mismatches.length === 0,
		mismatches.length === 0 ? `${names.length}/${names.length} tokens resolved to their declared value` : `${mismatches.length}/${names.length} mismatched`,
	);
	if (mismatches.length > 0) {
		console.log('\n--- token-declared-values mismatches ---');
		for (const m of mismatches) console.log(`${m.name} / ${JSON.stringify(m.expected)} / ${JSON.stringify(m.actual)}`);
	}

	const bodyActual = await page.evaluate((checks) => {
		const cs = getComputedStyle(document.body);
		/** @type {Record<string, string>} */
		const out = {};
		for (const check of checks) out[check.id] = String(/** @type {any} */ (cs)[check.cssProperty]);
		return out;
	}, BASE_RULE_CHECKS);

	/** @type {Array<{ id: string, expected: string, actual: string }>} */
	const baseMismatches = [];
	for (const check of BASE_RULE_CHECKS) {
		const declared = /** @type {string} */ (tokens.get(check.token));
		const expected = check.normaliser === 'hexToRgb' ? hexToRgb(declared) : normaliseTokenValue(declared);
		const actualValue = bodyActual[check.id];
		const passed = normaliseTokenValue(actualValue) === normaliseTokenValue(expected);
		if (!passed) baseMismatches.push({ id: check.id, expected, actual: actualValue });
	}
	record(
		'base-rule-used-values',
		baseMismatches.length === 0,
		baseMismatches.length === 0 ? `${BASE_RULE_CHECKS.length}/${BASE_RULE_CHECKS.length} base rules matched` : `${baseMismatches.length}/${BASE_RULE_CHECKS.length} mismatched`,
	);
	if (baseMismatches.length > 0) {
		console.log('\n--- base-rule-used-values mismatches ---');
		for (const m of baseMismatches) console.log(`${m.id} / ${JSON.stringify(m.expected)} / ${JSON.stringify(m.actual)}`);
	}

	return tokens.size;
}

/**
 * The five `identity:` rungs (D-19, 53-09). Every rung is wrapped in its own
 * `try`/`catch` and records a failure rather than throwing — a throwing rung
 * must never suppress the rungs after it, which is the structural half of
 * the measured PARTIAL failure signature (this file's header "THE INVERSION
 * SEAM" note; the harness-side half is each harness's own separate root for
 * the hook-root region).
 *
 * Reads `readout.identity` for the four fields the harness publishes: the
 * two SOUND measures (a hook-function-reference equality and a client-
 * internals-holder equality) plus a version-string equality and a
 * namespace-object equality, both carried as decoys and printed in the run
 * log below by this function ONLY for that logging — never referenced in
 * any rung's pass/fail condition here.
 *
 * @param {import('playwright').Page} page
 * @param {any} readout
 * @param {string[]} consoleLines
 */
async function runIdentityRungs(page, readout, consoleLines) {
	try {
		const mounted = await page.evaluate(() => {
			const el = document.querySelector('[data-ui-gate="hook-root"]');
			return el != null && el.childElementCount > 0 && (el.textContent ?? '').trim().length > 0;
		});
		record(
			'identity:hook-mounted',
			mounted,
			mounted ? 'hook-root region present with non-empty content' : 'hook-root region missing, empty, or has zero children',
		);
	} catch (err) {
		record('identity:hook-mounted', false, `threw: ${String(/** @type {any} */ (err)?.message ?? err)}`);
	}

	try {
		const before = await page.evaluate(() => document.querySelector('[data-ui-gate="hook-root"]')?.textContent ?? '');
		await page.click('[data-ui-gate="hook-root"] button');
		await page.waitForFunction(
			(prevText) => (document.querySelector('[data-ui-gate="hook-root"]')?.textContent ?? '') !== prevText,
			before,
			{ timeout: 10_000 },
		);
		const after = await page.evaluate(() => document.querySelector('[data-ui-gate="hook-root"]')?.textContent ?? '');
		const passed = before.length > 0 && after.length > 0 && after !== before;
		record(
			'identity:hook-interaction',
			passed,
			passed
				? `real click changed hook-root text (before=${JSON.stringify(before)}, after=${JSON.stringify(after)})`
				: `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
		);
	} catch (err) {
		record('identity:hook-interaction', false, `threw: ${String(/** @type {any} */ (err)?.message ?? err)}`);
	}

	try {
		const sameUseState = readout?.identity?.sameUseState === true;
		record('identity:same-use-state', sameUseState, `identity.sameUseState=${JSON.stringify(readout?.identity?.sameUseState)}`);
	} catch (err) {
		record('identity:same-use-state', false, `threw: ${String(/** @type {any} */ (err)?.message ?? err)}`);
	}

	try {
		const sameInternals = readout?.identity?.sameInternals === true;
		record('identity:same-internals', sameInternals, `identity.sameInternals=${JSON.stringify(readout?.identity?.sameInternals)}`);
	} catch (err) {
		record('identity:same-internals', false, `threw: ${String(/** @type {any} */ (err)?.message ?? err)}`);
	}

	try {
		const offending = consoleLines.filter((l) => DISPATCHER_NULL_ERROR_RE.test(l));
		const passed = offending.length === 0;
		record(
			'identity:no-dispatcher-error',
			passed,
			passed ? 'no null-dispatcher error observed' : `observed: ${offending.join(' | ')}`,
		);
	} catch (err) {
		record('identity:no-dispatcher-error', false, `threw: ${String(/** @type {any} */ (err)?.message ?? err)}`);
	}

	// --- run-log printing block: the two DECOY fields, logged for
	// observability only. Neither name may appear in a rung's pass/fail
	// condition above, in a ternary, or in a boolean expression anywhere in
	// this file outside this block — `gate-source-integrity.test.mjs`-style
	// scanning (grep) is what enforces that structurally.
	const decoyVersionsMatch = readout?.identity?.versionsMatch;
	const decoySameNamespace = readout?.identity?.sameNamespace;
	console.log(
		`[identity] decoy versionsMatch=${JSON.stringify(decoyVersionsMatch)} — recorded only; both React copies report the identical version string in every broken variant spike 089 measured, so this can never gate a verdict.`,
	);
	console.log(
		`[identity] decoy sameNamespace=${JSON.stringify(decoySameNamespace)} — recorded only; a namespace-object comparison false-negatives when a bundler hands two importers different wrappers around one module, so this can never gate a verdict.`,
	);
}

function printSummaryTable() {
	console.log('\n--- ui-gates summary ---');
	for (const r of rungs) {
		console.log(`${r.id.padEnd(28)} ${r.passed ? 'PASS' : 'FAIL'}  ${r.detail}`);
	}
}

function getPlaywrightVersion() {
	try {
		const pkgUrl = new URL('../node_modules/playwright-core/package.json', import.meta.url);
		const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8'));
		return pkg.version;
	} catch {
		return 'unknown';
	}
}

/**
 * Reports the normal (non-control) run's verdict. Named to mirror
 * `run-headless.mjs`'s own `finishRun` — see this file's header "THE
 * INVERSION SEAM" note.
 *
 * WR-14 (Phase 53 review): this function previously also carried a second,
 * inversion-aware branch (`inversionId !== null`) that its OWN comment
 * admitted was "unreachable from any call site in this file today" —
 * `runProveNoDedupe`/`runProveTokenMissing` print their own dedicated
 * "is inert"/"genuinely failed" lines rather than routing through it. That
 * dead branch supplied one of the exactly-three comment-filtered `is inert`
 * occurrences a CI floor in `web-gates.yml` counted (`>= 3`), making the
 * floor honest only by accident: deleting the branch as an unrelated,
 * reasonable cleanup would have failed `Gate-source integrity` for a
 * non-regression. Removed here; `web-gates.yml`'s floor is lowered to `>= 2`
 * in the same round, counting only the two real emission sites this
 * function no longer duplicates.
 *
 * @param {boolean} underlyingRunPassed
 * @param {string} reason
 */
function finishRun(underlyingRunPassed, reason) {
	console.log(`\nUI GATES: ${underlyingRunPassed ? 'PASS' : 'FAIL'} (${reason})`);
	process.exitCode = underlyingRunPassed ? 0 : 1;
}

/**
 * WITNESS-ONLY EXCEPTION (D-20/D-23, 53-11): the one deliberate appearance of
 * the DOM's loaded-stylesheet count in this file. `gate-source-integrity
 * .test.mjs`'s check (1) forbids the MAIN token probe from ever reverting to
 * a vacuous stylesheet-count check (see this file's own header note on why
 * counting loaded style resources is blind — it stays unchanged even with
 * every token removed). This function is not that probe: it is
 * `--prove-token-missing`'s STANDING WITNESS that such a vacuous check WOULD
 * have passed on a deliberately broken, token-less build — see
 * `runProveTokenMissing`'s own `prove-token-missing:stylesheets-still-present`
 * line. The test's own scan strips exactly this comment plus this function's
 * body before counting, the same way it strips comments elsewhere in this
 * file; a companion test proves the stripped region contains exactly one
 * occurrence, so this exception cannot silently grow to swallow a real
 * regression.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<number>}
 */
async function readStyleSheetCountWitness(page) {
	return page.evaluate(() => document.styleSheets.length);
}

/**
 * `--prove-no-dedupe` (53-11, D-20). Rebuilds the app's own production
 * config with `resolve.dedupe` removed, reruns the SAME gate against that
 * mutant build, and requires the MEASURED PARTIAL failure shape spike 089
 * recorded (19/19 -> 8/12, annotation only, never a hard-coded assertion):
 * every token rung still passing, at least one `identity:` rung failing, and
 * the dispatcher-null message captured.
 *
 * @param {{ appDir: string, gateConfigRel: string, gateDistAbs: string, gateEntryName: string, port: number }} opts
 */
async function runProveNoDedupe({ appDir, gateConfigRel, gateDistAbs, gateEntryName, port }) {
	const PREFIX = '--prove-no-dedupe: control could not run —';

	// Precondition (1): the app's own healthy gate build/run, in this same invocation.
	const baseline = await runGatePassLenient({ appDir, buildConfigRel: gateConfigRel, distAbs: gateDistAbs, entryName: gateEntryName, port });
	if (!baseline.ok) {
		console.log(`\n${PREFIX} baseline gate build/run did not complete`);
		console.log(`  stage=${baseline.stage} detail=${baseline.message}`);
		process.exitCode = 1;
		return;
	}
	if (!baseline.allPassed) {
		const failed = baseline.rungs.filter((r) => !r.passed).map((r) => r.id);
		console.log(`\n${PREFIX} baseline gate run did not pass every rung — this control cannot attribute anything to the mutation`);
		console.log(`  baseline RUNGS: ${baseline.passed}/${baseline.total}  failed: ${failed.join(', ') || 'none'}`);
		process.exitCode = 1;
		return;
	}
	console.log(`[--prove-no-dedupe] baseline leg: RUNGS: ${baseline.passed}/${baseline.total} (full pass)`);

	// Precondition (2): at least two distinct React copies resolvable.
	const reactCopies = resolveReactCopies(appDir);
	if (reactCopies.length < 2) {
		console.log(`\n${PREFIX} fewer than two distinct React installations are resolvable from this app`);
		console.log(`  count=${reactCopies.length} realpaths=${JSON.stringify(reactCopies)} — removing dedupe cannot collapse anything; this is a workspace-layout change, not an inert gate`);
		process.exitCode = 1;
		return;
	}
	console.log(`[--prove-no-dedupe] resolved ${reactCopies.length} distinct React realpaths: ${reactCopies.join(' | ')}`);

	// Precondition (3)+(4): the mutation applies AND the mutant build exits 0.
	const mutantOutDirAbs = path.join(appDir, 'dist-mutant-no-dedupe');
	const mutantBuild = await spawnViteBuild(appDir, 'vite.mutant.config.ts', { UI_GATE_MUTATION: 'no-dedupe' });
	if (mutantBuild.code !== 0) {
		console.log(`\n${PREFIX} the no-dedupe mutant build failed`);
		console.log(`  exit code=${mutantBuild.code}`);
		process.exitCode = 1;
		return;
	}

	let report;
	try {
		report = readMutationReport(mutantOutDirAbs);
	} catch (err) {
		console.log(`\n${PREFIX} ${/** @type {any} */ (err)?.message ?? err}`);
		process.exitCode = 1;
		return;
	}
	console.log(`[--prove-no-dedupe] mutation report: ${JSON.stringify(report)}`);
	// WR-08 (Phase 53 review): this control previously logged the report and
	// asserted NOTHING about it, unlike its `--prove-token-missing` sibling
	// (`report.removals >= 1` below). `writeMutationReportPlugin` is called
	// with `{ mutation, removedDedupe, selfReference }` (see
	// vite.mutant.config.ts in both consumers) -- require the report to
	// actually record a non-empty `removedDedupe` array naming the real
	// mutation, so a no-op report can never be waved through silently.
	if (report.mutation !== 'no-dedupe' || !Array.isArray(report.removedDedupe) || report.removedDedupe.length === 0) {
		console.log(`\n${PREFIX} the mutation report does not record a removed dedupe array — a no-op, not an inert gate`);
		console.log(`  report=${JSON.stringify(report)}`);
		process.exitCode = 1;
		return;
	}

	// The inverted assertion: the SAME gate, against the mutant build.
	const mutantRun = await runGatePassLenient({ appDir, buildConfigRel: null, distAbs: mutantOutDirAbs, entryName: gateEntryName, port });
	if (!mutantRun.ok) {
		console.log('\n--prove-no-dedupe: FAIL — wrong failure shape');
		console.log(`  the mutant leg did not produce a readout — stage=${mutantRun.stage} detail=${mutantRun.message}`);
		process.exitCode = 1;
		return;
	}

	const readoutExists = mutantRun.readout != null;
	// This runner's readout carries no dedicated `crashed` field (that
	// concept belongs to run-headless.mjs's compose-gate harness); `readout
	// == null` (this runner's own "NO RESULT" condition) is the equivalent
	// signal — a whole-page crash before __UI_GATE_DONE__ was ever set.
	const crashed = !readoutExists;
	const identityRungs = mutantRun.rungs.filter((r) => r.id.startsWith('identity:'));
	// The plan's own invariant is scoped to the two D-23 TOKEN rungs
	// specifically ("removing dedupe must not disturb styling"), not to
	// harness-readout/shared-components-mounted. Measured live: this
	// harness's DetailsToggleHarness (the shared-components-mounted rung's
	// subject) shares the SAME #root tree as AdvisoryDisclosure/LifecyclePill
	// with no per-component error boundary, so a real hook-dispatcher throw
	// inside it unmounts the WHOLE #root tree — harness-readout and
	// shared-components-mounted going down ALONGSIDE the identity rungs is
	// therefore part of the genuine measured shape here, not a sign the
	// control fired wrong. The two token rungs read computed CSS custom
	// properties directly off document.documentElement, independent of the
	// React tree, which is why they alone are required to survive.
	const TOKEN_RUNG_IDS_FOR_DEDUPE = ['token-declared-values', 'base-rule-used-values'];
	const tokenRungs = mutantRun.rungs.filter((r) => TOKEN_RUNG_IDS_FOR_DEDUPE.includes(r.id));
	const allTokenRungsPassed = tokenRungs.every((r) => r.passed);
	const failedIdentity = identityRungs.filter((r) => !r.passed);
	const dispatcherHit = mutantRun.lines.some((l) => DISPATCHER_NULL_ERROR_RE.test(l));

	console.log(`[--prove-no-dedupe] mutant leg: RUNGS: ${mutantRun.passed}/${mutantRun.total}  (baseline was ${baseline.passed}/${baseline.total}; spike reference 19/19 -> 8/12, annotation only)`);
	console.log(`[--prove-no-dedupe] readout-exists=${readoutExists} crashed=${crashed} all-token-rungs-passed=${allTokenRungsPassed} failed-identity-rungs=${failedIdentity.map((r) => r.id).join(',') || 'none'} dispatcher-message-observed=${dispatcherHit}`);

	if (mutantRun.allPassed) {
		console.log('\nUI GATES --prove-no-dedupe: FAIL — gate is inert (the mutated build removing resolve.dedupe still passed every rung — a duplicate React reaching the hook dispatcher was not detected)');
		process.exitCode = 1;
		return;
	}

	const shapeOk = readoutExists && !crashed && allTokenRungsPassed && failedIdentity.length > 0 && dispatcherHit;
	if (!shapeOk) {
		/** @type {string[]} */
		const unmet = [];
		if (!readoutExists) unmet.push('no readout published (NO RESULT)');
		if (!allTokenRungsPassed) unmet.push('a token rung also failed');
		if (failedIdentity.length === 0) unmet.push('no identity rung failed');
		if (!dispatcherHit) unmet.push('the dispatcher-null message was not observed');
		console.log('\n--prove-no-dedupe: FAIL — wrong failure shape');
		console.log(`  unmet: ${unmet.join('; ')}`);
		process.exitCode = 1;
		return;
	}

	console.log('\nUI GATES --prove-no-dedupe: PASS — the underlying run genuinely failed in the measured partial shape');
	console.log(`  baseline ${baseline.passed}/${baseline.total}, mutant ${mutantRun.passed}/${mutantRun.total}, failed identity rungs: ${failedIdentity.map((r) => r.id).join(', ')}`);
	process.exitCode = 0;
}

/**
 * `--prove-token-missing` (53-11, D-20). Rebuilds the app's own gate build
 * with the shared tokens stylesheet REFERENCE stripped, reruns the SAME gate
 * against that mutant build, and requires the MIRROR shape of
 * `runProveNoDedupe`'s: the mutant build itself exits 0, at least one token
 * rung fails on a resolved computed value, every `identity:` rung still
 * passes, and the DOM's loaded-stylesheet count is recorded as the standing
 * witness that a vacuous sheet-count check would have passed on this build.
 *
 * @param {{ appDir: string, gateConfigRel: string, gateDistAbs: string, gateEntryName: string, port: number }} opts
 */
async function runProveTokenMissing({ appDir, gateConfigRel, gateDistAbs, gateEntryName, port }) {
	const PREFIX = '--prove-token-missing: control could not run —';
	const TOKEN_RUNG_IDS = ['token-declared-values', 'base-rule-used-values'];

	const baseline = await runGatePassLenient({ appDir, buildConfigRel: gateConfigRel, distAbs: gateDistAbs, entryName: gateEntryName, port });
	if (!baseline.ok) {
		console.log(`\n${PREFIX} baseline gate build/run did not complete`);
		console.log(`  stage=${baseline.stage} detail=${baseline.message}`);
		process.exitCode = 1;
		return;
	}
	if (!baseline.allPassed) {
		const failed = baseline.rungs.filter((r) => !r.passed).map((r) => r.id);
		console.log(`\n${PREFIX} baseline gate run did not pass every rung, token half included — this control cannot attribute anything to the mutation`);
		console.log(`  baseline RUNGS: ${baseline.passed}/${baseline.total}  failed: ${failed.join(', ') || 'none'}`);
		process.exitCode = 1;
		return;
	}
	console.log(`[--prove-token-missing] baseline leg: RUNGS: ${baseline.passed}/${baseline.total} (full pass, token half included)`);

	const mutantOutDirAbs = path.join(appDir, 'dist-mutant-token-missing');
	const mutantBuild = await spawnViteBuild(appDir, 'vite.mutant.config.ts', { UI_GATE_MUTATION: 'token-missing' });
	if (mutantBuild.code !== 0) {
		console.log(`\n${PREFIX} the token-missing mutant build failed`);
		console.log(`  exit code=${mutantBuild.code}`);
		process.exitCode = 1;
		return;
	}
	console.log('[--prove-token-missing] mutant build exited 0 — the token layer\'s absence is invisible to the build, as measured');

	let report;
	try {
		report = readMutationReport(mutantOutDirAbs);
	} catch (err) {
		console.log(`\n${PREFIX} ${/** @type {any} */ (err)?.message ?? err}`);
		process.exitCode = 1;
		return;
	}
	if (!(report.removals >= 1)) {
		console.log(`\n${PREFIX} the mutation report shows zero removals — a no-op, not an inert gate`);
		console.log(`  report=${JSON.stringify(report)}`);
		process.exitCode = 1;
		return;
	}
	console.log(`[--prove-token-missing] mutation report: ${JSON.stringify(report)}`);

	const mutantRun = await runGatePassLenient({
		appDir,
		buildConfigRel: null,
		distAbs: mutantOutDirAbs,
		entryName: gateEntryName,
		port,
		extraPageWork: readStyleSheetCountWitness,
	});
	if (!mutantRun.ok) {
		console.log('\n--prove-token-missing: FAIL — wrong failure shape');
		console.log(`  the mutant leg did not produce a readout — stage=${mutantRun.stage} detail=${mutantRun.message}`);
		process.exitCode = 1;
		return;
	}

	const readoutExists = mutantRun.readout != null;
	const crashed = !readoutExists;

	if (!readoutExists) {
		console.log('\n--prove-token-missing: FAIL — wrong failure shape');
		console.log('  no readout published (NO RESULT) — a dead page has not reproduced this defect');
		process.exitCode = 1;
		return;
	}

	const styleSheetCount = /** @type {number} */ (mutantRun.extra);
	console.log('prove-token-missing:stylesheets-still-present');
	console.log(`  count=${styleSheetCount} — this is the vacuous check D-23 replaced: a sheet-count check would have reported this build present/passing even with the whole token layer's reference removed.`);

	if (!(styleSheetCount >= 1)) {
		console.log(`\n${PREFIX} the standing witness read a loaded-stylesheet count of ${styleSheetCount} on the mutant page`);
		console.log('  a build with no stylesheet at all is a different mutation than the one requested, and would let a sheet count pass as a real check');
		process.exitCode = 1;
		return;
	}

	const tokenRungs = mutantRun.rungs.filter((r) => TOKEN_RUNG_IDS.includes(r.id));
	const identityRungs = mutantRun.rungs.filter((r) => r.id.startsWith('identity:'));
	const failedTokenRungs = tokenRungs.filter((r) => !r.passed);
	const allIdentityPassed = identityRungs.every((r) => r.passed);

	console.log(`[--prove-token-missing] mutant leg: RUNGS: ${mutantRun.passed}/${mutantRun.total}  (baseline was ${baseline.passed}/${baseline.total})`);
	console.log(`[--prove-token-missing] readout-exists=${readoutExists} crashed=${crashed} failed-token-rungs=${failedTokenRungs.map((r) => r.id).join(',') || 'none'} all-identity-rungs-passed=${allIdentityPassed}`);
	if (failedTokenRungs.length > 0) {
		console.log(`[--prove-token-missing] first failed token rung detail: ${failedTokenRungs[0].id} — ${failedTokenRungs[0].detail}`);
	}

	if (mutantRun.allPassed) {
		console.log('\nUI GATES --prove-token-missing: FAIL — gate is inert (the mutated build with the shared token layer\'s reference removed still passed every rung — the token probe could not see it)');
		process.exitCode = 1;
		return;
	}

	const shapeOk = !crashed && failedTokenRungs.length > 0 && allIdentityPassed;
	if (!shapeOk) {
		/** @type {string[]} */
		const unmet = [];
		if (failedTokenRungs.length === 0) unmet.push('no token rung failed');
		if (!allIdentityPassed) unmet.push('an identity rung also failed');
		console.log('\n--prove-token-missing: FAIL — wrong failure shape');
		console.log(`  unmet: ${unmet.join('; ')}`);
		process.exitCode = 1;
		return;
	}

	console.log('\nUI GATES --prove-token-missing: PASS — the underlying run genuinely failed on a resolved computed value');
	console.log(`  baseline ${baseline.passed}/${baseline.total}, mutant ${mutantRun.passed}/${mutantRun.total}, failed token rungs: ${failedTokenRungs.map((r) => r.id).join(', ')}, stylesheets-still-present=${styleSheetCount}`);
	process.exitCode = 0;
}

async function main() {
	const argv = process.argv.slice(2);
	const opts = parseArgs(argv);

	if (opts.listRungs) {
		for (const id of RUNG_IDS) console.log(id);
		return;
	}

	const appDir = path.resolve(process.cwd(), opts.app);
	const gateConfigRel = opts.gateConfig ?? DEFAULT_GATE_CONFIG_REL;
	const gateDistRel = opts.gateDist ?? DEFAULT_GATE_DIST_REL;
	const gateEntryName = opts.gateEntry ?? DEFAULT_GATE_ENTRY_NAME;
	// WR-06 (Phase 53 review): a bare `Number()` coercion here previously (a)
	// crashed with a raw stack trace on `--port abc` (NaN reaches
	// `server.listen`) instead of this file's own documented `exit 2`, and (b)
	// treated `UI_GATE_PORT=''` as `0` (`Number('')` is `0`, not `NaN` --
	// empty string is NOT nullish so `??` never falls through to the
	// default), silently binding an OS-assigned port nobody asked for. Both
	// are validated here, once, before anything downstream ever sees `port`.
	const portRaw = opts.port ?? process.env.UI_GATE_PORT ?? String(DEFAULT_PORT);
	const port = Number(String(portRaw).trim());
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		process.stderr.write(
			`[run-ui-gates] --port/UI_GATE_PORT must be an integer 1-65535, got ${JSON.stringify(portRaw)}\n`,
		);
		process.exit(2);
	}

	const gateConfigAbs = resolveWithinApp(appDir, gateConfigRel, '--gate-config');
	const gateDistAbs = resolveWithinApp(appDir, gateDistRel, '--gate-dist');

	console.log(`[run-ui-gates] app=${appDir}`);
	console.log(`[run-ui-gates] gate-config=${gateConfigRel} (resolved: ${gateConfigAbs})`);
	console.log(`[run-ui-gates] gate-dist=${gateDistRel} (resolved: ${gateDistAbs})`);
	console.log(`[run-ui-gates] gate-entry=${gateEntryName}`);
	console.log(`[run-ui-gates] port=${port}`);

	// The two --prove-* controls (53-11, D-20) run ENTIRELY on their own and
	// return here, before any of the normal build/serve/gate flow below —
	// never combined with each other or with a normal run in one invocation.
	const activeControlFlags = Object.keys(INVERSION_CONTROLS).filter(
		(flag) => (flag === '--prove-no-dedupe' && opts.proveNoDedupe) || (flag === '--prove-token-missing' && opts.proveTokenMissing),
	);
	if (activeControlFlags.length > 1) {
		process.stderr.write(`[run-ui-gates] only one of ${activeControlFlags.join(', ')} may run per invocation\n`);
		process.exit(2);
	}
	if (opts.proveNoDedupe) {
		await runProveNoDedupe({ appDir, gateConfigRel, gateDistAbs, gateEntryName, port });
		return;
	}
	if (opts.proveTokenMissing) {
		await runProveTokenMissing({ appDir, gateConfigRel, gateDistAbs, gateEntryName, port });
		return;
	}

	if (!opts.skipBuild) {
		await buildGateEntry(appDir, gateConfigAbs, gateConfigRel);
	}

	const entryRel = resolveGateEntry(gateDistAbs, gateEntryName);

	let serverHandle;
	try {
		serverHandle = await serveDist(gateDistAbs, port);
	} catch (err) {
		const code = /** @type {any} */ (err)?.code;
		if (code === 'EADDRINUSE') {
			process.stderr.write(
				`[run-ui-gates] port ${port} is already bound — pass --port <n> (or set UI_GATE_PORT) to use a different one\n`,
			);
			process.exit(2);
		}
		throw err;
	}

	let browser;
	try {
		try {
			browser = await chromium.launch({ headless: true });
		} catch (err) {
			if (String(/** @type {any} */ (err)?.message ?? err).includes("Executable doesn't exist")) {
				process.stderr.write(
					'[run-ui-gates] Playwright could not find the Chromium binary. Run:\n  yarn workspace @votetorrent/ui-web exec playwright install chromium\n',
				);
				process.exit(2);
			}
			throw err;
		}

		const page = await browser.newPage();
		const url = `${serverHandle.url}/${entryRel}`;
		const { readout, lines } = await runOnPage(page, url, `app=${path.basename(appDir)}`);

		runHarnessReadoutRung(readout);
		await runSharedComponentsRung(page, readout);
		await runResolvedStyleRung(page, resolveAppPackageName(appDir));
		const tokenCount = await runTokenRungs(page);
		await runIdentityRungs(page, readout, lines);

		await page.close();

		printSummaryTable();
		const allPassed = rungs.every((r) => r.passed);
		const playwrightVersion = getPlaywrightVersion();
		console.log(
			`RECEIPT ui-gates app=${path.basename(appDir)} rungs=${rungs.length} passed=${rungs.filter((r) => r.passed).length} playwright=${playwrightVersion} tokens=${tokenCount}`,
		);
		finishRun(allPassed, allPassed ? 'all rungs passed' : 'one or more rungs failed');
	} finally {
		await browser?.close();
		await serverHandle?.close();
	}
}

main().catch((err) => {
	console.error('[run-ui-gates] runner crashed:', err);
	process.exitCode = 1;
});
