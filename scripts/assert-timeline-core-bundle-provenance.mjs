#!/usr/bin/env node
/**
 * assert-timeline-core-bundle-provenance.mjs
 *
 * Phase 59's D-19 proof (59-11 Task 2): does the voter's real Metro
 * resolver -- not Node's, not Jest's -- actually keep the
 * `@votetorrent/ui-web/lifecycle-core` edge dependency-free, the way
 * 59-02-SUMMARY.md's Node-based module-graph recorder already proved
 * under Node? Jest and a plain Node script both resolve `exports` maps
 * differently from Metro (`apps/VoteTorrentVoter/metro.config.js` carries
 * `unstable_enablePackageExports`, a `resolveRequest` override and three
 * hand-applied redirects), so the claim is only actually true if it is
 * true of the bundle Metro **serves**.
 *
 * Why a bundle grep for source symbols does NOT work on this project:
 * Hermes bytecode plus minification destroys them in a release bundle,
 * and this repo has already recorded that as a dead end. What survives
 * Metro's own serializer, even after minification, is its module
 * REGISTRATION metadata: with `dev=true`,
 * `metro/src/DeltaBundler/Serializers/helpers/js.js` appends
 * `path.relative(projectRoot, module.path)` as the verbose fourth
 * argument of every `__d(...)` call -- emitted by the serializer itself,
 * not carried from source, so it cannot be destroyed by minification.
 * This script requests the bundle with `dev=true&minify=false&
 * modulesOnly=true&runModule=false` (the served text is then exactly the
 * entry's transitive graph, no polyfills, no run statement) and asserts
 * on that path list, confirmed live against this checkout: the real
 * `@votetorrent/ui-web/lifecycle-core` edge registers exactly TWO
 * modules -- the entry itself and
 * `../../packages/ui-web/src/lifecycle/timeline-core.js` -- while the
 * rejected `@votetorrent/ui-web/lifecycle` edge registers the full
 * vote-engine/vote-core/@quereus graph (hundreds of modules).
 *
 * Three independent defenses against a vacuously-green proof, all
 * mandatory (this repo's single most-repeated gate defect):
 *   1. `--reset-cache` on every Metro invocation. A negative control
 *      without it has passed here before even when the underlying fix
 *      WAS load-bearing, because Metro served a stale cached transform --
 *      indistinguishable from "the file is not in the graph".
 *   2. A SYNTHETIC control that must be caught as FORBIDDEN. If it is
 *      not, the deny scanner itself is inert and the whole run fails
 *      regardless of the main arm's result.
 *   3. Comment-stripping (`scripts/lib/strip-comments.mjs`) BEFORE every
 *      scan. `timeline-core.js`'s own header explains, in prose, that it
 *      imports no `vote-engine` -- confirmed live: an UNSTRIPPED scan of
 *      the clean main-arm bundle trips on that sentence and reports a
 *      false FORBIDDEN. Comment-stripping is not hygiene here; it is
 *      the difference between a true and a false verdict.
 *
 * Provenance, two independent legs, BOTH required before any dependency
 * verdict is trusted (a stale Metro has served the wrong tree's bundle on
 * this project before, costing three device runs):
 *   (a) a per-run random nonce, declared in the entry file this run just
 *       wrote, appears in the served (stripped) text;
 *   (b) the module-path list contains a path equal to
 *       `path.relative(voterAppRoot, fs.realpathSync(timelineCorePath))`,
 *       computed LIVE in this checkout, not hard-coded.
 * Either leg missing = PROVENANCE_FAIL, and no dependency verdict is
 * issued at all.
 *
 * Entry/control files are written at the voter app ROOT (not under
 * src/), specifically so the voter's own source-scanning gates (i18n
 * parity, no-inline-mock-imports, no-hardcoded-hex) never see them, and
 * they are written and confirmed present on disk BEFORE Metro starts --
 * Metro's haste map is built fresh under `--reset-cache`, and a file
 * added AFTER that point is invisible until the next file-watcher tick
 * (confirmed live: a request for a file created after Metro was already
 * running 404s for several seconds). All three are removed by an EXIT
 * trap; `.gitignore` carries their names so an interrupted run can never
 * be committed as residue.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
  readFileSync,
  appendFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './lib/strip-comments.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const VOTER_APP_ROOT = path.join(REPO_ROOT, 'apps', 'VoteTorrentVoter');
const TIMELINE_CORE_SRC = path.join(REPO_ROOT, 'packages', 'ui-web', 'src', 'lifecycle', 'timeline-core.js');
const GITIGNORE_PATH = path.join(REPO_ROOT, '.gitignore');

// 8081 is the on-device default, 8082 is this repo's own voter Metro
// (see project memory) -- neither is safe to reuse. This script starts and
// owns its OWN Metro instance; reusing a listener it did not start is
// exactly the stale-Metro hazard that has served a wrong-tree bundle here
// before.
const PORT = Number(process.env.TIMELINE_PROVENANCE_PORT ?? 8099);
const METRO_START_TIMEOUT_MS = 240_000; // a monorepo --reset-cache is slow; slow is not failure
const FETCH_TIMEOUT_MS = 60_000;

// Deny tokens assembled from parts, deliberately, so this file's own
// source text -- which must NAME these concepts in order to explain
// itself -- can never be mistaken for a hit by this scan or by any
// future one that greps this repo for the same words.
const DENY_TOKENS = [
  ['@votetorrent/', 'vote-engine'].join(''),
  ['packages/', 'vote-engine/'].join(''),
  ['@que', 'reus'].join(''),
  ['react', '-dom'].join(''),
  ['election', '-phase'].join(''),
];

const runDir = path.join(process.env.TMPDIR ?? '/tmp', 'timeline-provenance', String(Date.now()));
mkdirSync(runDir, { recursive: true });

function log(msg) {
  process.stdout.write(`[timeline-provenance] ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`[timeline-provenance] FATAL: ${msg}\n`);
  cleanupAndExit(1);
}

// ---------------------------------------------------------------------------
// cleanup -- entry files + Metro process, unconditional
// ---------------------------------------------------------------------------

const createdFiles = [];
let metroProc = null;
let exiting = false;

function cleanupAndExit(code) {
  if (exiting) return;
  exiting = true;
  for (const f of createdFiles) {
    try {
      if (existsSync(f)) rmSync(f);
    } catch {
      // best-effort
    }
  }
  if (metroProc && metroProc.pid) {
    try {
      process.kill(-metroProc.pid, 'SIGTERM');
    } catch {
      try {
        metroProc.kill('SIGTERM');
      } catch {
        // already dead
      }
    }
  }
  process.exit(code);
}

process.on('SIGINT', () => cleanupAndExit(130));
process.on('SIGTERM', () => cleanupAndExit(143));
process.on('exit', () => {
  // synchronous fallback -- the async cleanupAndExit path above already
  // handles the common cases, this only catches an unexpected throw.
  for (const f of createdFiles) {
    try {
      if (existsSync(f)) rmSync(f);
    } catch {
      // best-effort
    }
  }
});

// ---------------------------------------------------------------------------
// port hygiene
// ---------------------------------------------------------------------------

function isPortFree(port) {
  const r = spawnSync('lsof', ['-i', `:${port}`], { encoding: 'utf8' });
  // lsof exits 1 with empty stdout when nothing is listening.
  return r.status !== 0 || r.stdout.trim().length === 0;
}

// ---------------------------------------------------------------------------
// nonce + entry file bodies
// ---------------------------------------------------------------------------

function nonce() {
  return randomBytes(16).toString('hex');
}

const ENTRY_NAME = 'timeline-provenance-entry.js';
const CONTROL_REAL_NAME = 'timeline-provenance-control-real.js';
const CONTROL_SYNTHETIC_NAME = 'timeline-provenance-control-synthetic.js';

function entryBody(runNonce) {
  return (
    `// Autogenerated by scripts/assert-timeline-core-bundle-provenance.mjs -- deleted at end of run.\n` +
    `// The D-19 main arm: imports ONLY the ui-web lifecycle-core subpath.\n` +
    `export { finestStage } from '@votetorrent/ui-web/lifecycle-core';\n` +
    `export const PROVENANCE_NONCE = ${JSON.stringify(runNonce)};\n`
  );
}

function controlRealBody(runNonce) {
  return (
    `// Autogenerated by scripts/assert-timeline-core-bundle-provenance.mjs -- deleted at end of run.\n` +
    `// The D-19 real control: imports the REJECTED ./lifecycle edge (election-phase.js),\n` +
    `// which is known (59-02-SUMMARY.md) to drag in the full vote-engine/vote-core graph.\n` +
    `export { derivePhase } from '@votetorrent/ui-web/lifecycle';\n` +
    `export const PROVENANCE_NONCE = ${JSON.stringify(runNonce)};\n`
  );
}

function controlSyntheticBody(runNonce) {
  return (
    `// Autogenerated by scripts/assert-timeline-core-bundle-provenance.mjs -- deleted at end of run.\n` +
    `// The D-19 synthetic control: imports NOTHING forbidden, but carries a denylisted\n` +
    `// token as an inert STRING LITERAL in code position -- never executed, never\n` +
    `// imported. Proves the deny scanner actually fires. A PASS here invalidates the run.\n` +
    `export const PROVENANCE_NONCE = ${JSON.stringify(runNonce)};\n` +
    `export const SYNTHETIC_DENY_TOKEN = ${JSON.stringify(DENY_TOKENS[0])};\n`
  );
}

// ---------------------------------------------------------------------------
// .gitignore hygiene
// ---------------------------------------------------------------------------

function ensureGitignored() {
  const names = [ENTRY_NAME, CONTROL_REAL_NAME, CONTROL_SYNTHETIC_NAME];
  const current = existsSync(GITIGNORE_PATH) ? readFileSync(GITIGNORE_PATH, 'utf8') : '';
  const missing = names.filter((n) => !current.split('\n').some((line) => line.trim() === n));
  if (missing.length === 0) return;
  const header =
    '\n# 59-11: scripts/assert-timeline-core-bundle-provenance.mjs writes these at the\n' +
    '# voter app root for the duration of one run and removes them via an EXIT trap --\n' +
    '# listed here so an interrupted run can never be committed as residue.\n';
  appendFileSync(GITIGNORE_PATH, header + missing.join('\n') + '\n');
  log(`.gitignore: added ${missing.length} entr(y/ies)`);
}

// ---------------------------------------------------------------------------
// Metro lifecycle
// ---------------------------------------------------------------------------

async function waitForMetro(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) {
        const text = await res.text();
        if (text.includes('packager-status:running')) return true;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return false;
}

function startMetro(port) {
  const logPath = path.join(runDir, 'metro.log');
  writeFileSync(logPath, '');
  const args = ['start', '--port', String(port), '--reset-cache'];
  log(`starting Metro: yarn ${args.join(' ')} (cwd=${VOTER_APP_ROOT}), --reset-cache is MANDATORY`);
  const proc = spawn('yarn', args, {
    cwd: VOTER_APP_ROOT,
    detached: true, // own process group, so cleanupAndExit can kill the whole tree
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stream = [];
  proc.stdout.on('data', (d) => stream.push(d));
  proc.stderr.on('data', (d) => stream.push(d));
  proc.on('exit', () => {
    try {
      writeFileSync(logPath, Buffer.concat(stream));
    } catch {
      // best-effort
    }
  });
  proc.on('close', () => {
    try {
      writeFileSync(logPath, Buffer.concat(stream));
    } catch {
      // best-effort
    }
  });
  return { proc, logPath, getLog: () => Buffer.concat(stream).toString('utf8') };
}

// ---------------------------------------------------------------------------
// bundle fetch + parse
// ---------------------------------------------------------------------------

async function fetchBundle(port, entryFileName) {
  const entryNoExt = entryFileName.replace(/\.js$/, '');
  const url =
    `http://127.0.0.1:${port}/${entryNoExt}.bundle` +
    `?platform=android&dev=true&minify=false&modulesOnly=true&runModule=false`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    return { ok: false, kind: 'BUILD_ERROR', message: `fetch failed: ${e.message}`, url };
  }
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, kind: 'BUILD_ERROR', message: text.slice(0, 2000), url, status: res.status };
  }
  return { ok: true, text, url };
}

/**
 * Extracts every `__d(...)` verbose path, confirmed live against this
 * checkout's own Metro (dev=true, minify=false, modulesOnly=true,
 * runModule=false): each module factory's closing brace is followed, on
 * its OWN LINE starting at column 0, by the registration tail
 * `},<moduleId>,[<depIds>],"<verbosePath>");` -- e.g.
 * `},1,[],"../../packages/ui-web/src/lifecycle/timeline-core.js");`.
 * Anchoring on start-of-line `},` is deliberately NARROWER than a bare
 * `],"...");` search: this repo's bundle ALSO contains
 * `_$$_REQUIRE(_dependencyMap[0], "@votetorrent/ui-web/lifecycle-core")`
 * inside a module's own body, which a bare `],"...");` pattern matches
 * just as well (`_dependencyMap[0]` ends in `]` too) and would silently
 * fabricate an extra, wrong "module path" for a bare specifier string
 * that is not a registration at all -- confirmed live as a false
 * positive before this anchor was added. Verified against a real 888-line
 * dependency graph: every `^},` line in this checkout's bundles has a
 * FLAT (non-nested-bracket) dependency-id array, so `[^\]]*` is safe here
 * without a bracket-balancing scanner.
 */
function extractModulePaths(bundleText) {
  const re = /^\},\d+,\[[^\]]*\],"((?:[^"\\]|\\.)*)"\);$/gm;
  const paths = [];
  for (const m of bundleText.matchAll(re)) {
    paths.push(m[1]);
  }
  return paths;
}

function scanDeny(strippedText) {
  const hits = [];
  for (const token of DENY_TOKENS) {
    if (strippedText.includes(token)) hits.push(token);
  }
  return hits;
}

/**
 * @returns {{verdict: 'PASS'|'FORBIDDEN'|'BUILD_ERROR'|'PROVENANCE_FAIL', ...}}
 */
async function runArm({ port, entryFileName, runNonce, requireTimelineCoreLeg }) {
  const fetched = await fetchBundle(port, entryFileName);
  if (!fetched.ok) {
    return { verdict: 'BUILD_ERROR', message: fetched.message, url: fetched.url };
  }
  const stripped = stripComments(fetched.text);
  const modulePaths = extractModulePaths(stripped);

  // --- provenance leg (a): the per-run nonce must appear in the served,
  //     stripped text -- proves THIS Metro bundled the file THIS run just
  //     wrote, from THIS tree.
  const nonceOk = stripped.includes(runNonce);

  // --- provenance leg (b): only asserted for the main arm (the controls
  //     don't need it -- the main arm's own bundle is what's on trial).
  let timelineCoreLegOk = true;
  let timelineCoreRelPath = null;
  if (requireTimelineCoreLeg) {
    timelineCoreRelPath = path.relative(VOTER_APP_ROOT, realpathSync(TIMELINE_CORE_SRC));
    timelineCoreLegOk = modulePaths.includes(timelineCoreRelPath);
  }

  if (!nonceOk || !timelineCoreLegOk) {
    return {
      verdict: 'PROVENANCE_FAIL',
      nonceOk,
      timelineCoreLegOk,
      timelineCoreRelPath,
      modulePaths,
      url: fetched.url,
    };
  }

  const denyHits = scanDeny(stripped);
  const workspacePkgPaths = [...new Set(modulePaths)].filter(
    (p) => p.includes('packages/') && !p.includes('node_modules'),
  );

  if (denyHits.length > 0) {
    return { verdict: 'FORBIDDEN', denyHits, modulePaths, workspacePkgPaths, url: fetched.url };
  }

  return { verdict: 'PASS', modulePaths, workspacePkgPaths, url: fetched.url, timelineCoreRelPath };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  log(`run directory: ${runDir}`);

  // --- port hygiene ----------------------------------------------------------
  if (!isPortFree(PORT)) {
    fail(
      `port ${PORT} is already in use -- refusing to reuse a listener this script did not start ` +
        `(a stale Metro has served the wrong tree's bundle on this project before, costing three ` +
        `device runs). Free the port or set TIMELINE_PROVENANCE_PORT to an unused one.`,
    );
  }
  log(`port ${PORT} is free`);

  // --- entry/control files: write BEFORE starting Metro ----------------------
  const entryPath = path.join(VOTER_APP_ROOT, ENTRY_NAME);
  const controlRealPath = path.join(VOTER_APP_ROOT, CONTROL_REAL_NAME);
  const controlSyntheticPath = path.join(VOTER_APP_ROOT, CONTROL_SYNTHETIC_NAME);
  for (const p of [entryPath, controlRealPath, controlSyntheticPath]) {
    if (existsSync(p)) {
      fail(`${p} already exists -- a stale artifact from an interrupted run is not a clean input. Remove it and retry.`);
    }
  }

  const mainNonce = nonce();
  const realNonce = nonce();
  const syntheticNonce = nonce();

  writeFileSync(entryPath, entryBody(mainNonce));
  createdFiles.push(entryPath);
  writeFileSync(controlRealPath, controlRealBody(realNonce));
  createdFiles.push(controlRealPath);
  writeFileSync(controlSyntheticPath, controlSyntheticBody(syntheticNonce));
  createdFiles.push(controlSyntheticPath);
  log(`wrote 3 entry files at ${VOTER_APP_ROOT} (removed by EXIT trap)`);

  ensureGitignored();

  // --- start Metro -------------------------------------------------------------
  const metro = startMetro(PORT);
  metroProc = metro.proc;
  const up = await waitForMetro(PORT, METRO_START_TIMEOUT_MS);
  if (!up) {
    fail(`Metro did not report packager-status:running within ${METRO_START_TIMEOUT_MS}ms (see ${metro.logPath})`);
  }
  log(`Metro up on port ${PORT} (log: ${metro.logPath})`);

  // --- main arm ------------------------------------------------------------
  log('fetching main arm (lifecycle-core edge)...');
  const main_ = await runArm({
    port: PORT,
    entryFileName: ENTRY_NAME,
    runNonce: mainNonce,
    requireTimelineCoreLeg: true,
  });
  log(`main arm verdict: ${main_.verdict}`);
  if (main_.modulePaths) {
    log(`main arm module paths (${main_.modulePaths.length}):`);
    for (const p of main_.modulePaths) log(`    ${p}`);
  }

  if (main_.verdict === 'PROVENANCE_FAIL') {
    log(`PROVENANCE FAIL: nonceOk=${main_.nonceOk} timelineCoreLegOk=${main_.timelineCoreLegOk}`);
    if (main_.timelineCoreRelPath) log(`expected timeline-core path: ${main_.timelineCoreRelPath}`);
    process.stdout.write('TIMELINE-CORE BUNDLE PROVENANCE: FAIL — provenance could not be established\n');
    cleanupAndExit(1);
    return;
  }
  if (main_.verdict === 'BUILD_ERROR') {
    process.stdout.write(`TIMELINE-CORE BUNDLE PROVENANCE: FAIL — main arm BUILD_ERROR: ${main_.message}\n`);
    cleanupAndExit(1);
    return;
  }

  const problems = [];
  if (main_.verdict === 'FORBIDDEN') {
    problems.push(`main arm FORBIDDEN — deny hit(s): ${main_.denyHits.join(', ')}`);
  }
  if (main_.workspacePkgPaths && (main_.workspacePkgPaths.length !== 1 || main_.workspacePkgPaths[0] !== main_.timelineCoreRelPath)) {
    problems.push(
      `main arm workspace-package module set is not exactly {timeline-core.js}: got [${(main_.workspacePkgPaths ?? []).join(', ')}]`,
    );
  }

  // --- synthetic control: MUST be FORBIDDEN ---------------------------------
  log('fetching synthetic control...');
  const synthetic = await runArm({
    port: PORT,
    entryFileName: CONTROL_SYNTHETIC_NAME,
    runNonce: syntheticNonce,
    requireTimelineCoreLeg: false,
  });
  log(`synthetic control verdict: ${synthetic.verdict}`);
  if (synthetic.verdict === 'PROVENANCE_FAIL') {
    problems.push(`synthetic control PROVENANCE_FAIL — nonce not found in its own bundle, cannot trust this run at all`);
  } else if (synthetic.verdict !== 'FORBIDDEN') {
    problems.push(
      `synthetic control did NOT return FORBIDDEN (got ${synthetic.verdict}) -- the deny scanner is vacuous; ` +
        `this invalidates the whole run regardless of the main arm's result`,
    );
  } else {
    log(`synthetic control correctly caught: deny hit(s) ${synthetic.denyHits.join(', ')}`);
  }

  // --- real control: must be non-PASS, outcome recorded verbatim -----------
  log('fetching real control (./lifecycle edge)...');
  const real = await runArm({
    port: PORT,
    entryFileName: CONTROL_REAL_NAME,
    runNonce: realNonce,
    requireTimelineCoreLeg: false,
  });
  log(`real control verdict: ${real.verdict}`);
  let realControlOutcomeLine;
  if (real.verdict === 'FORBIDDEN') {
    realControlOutcomeLine = `REAL CONTROL OUTCOME: FORBIDDEN — deny hit(s): ${real.denyHits.join(', ')} — ${real.modulePaths.length} module(s) in graph`;
  } else if (real.verdict === 'BUILD_ERROR') {
    realControlOutcomeLine = `REAL CONTROL OUTCOME: BUILD_ERROR — ${real.message}`;
  } else if (real.verdict === 'PROVENANCE_FAIL') {
    realControlOutcomeLine = 'REAL CONTROL OUTCOME: PROVENANCE_FAIL — nonce not found in its own bundle';
    problems.push('real control PROVENANCE_FAIL — cannot trust this arm at all');
  } else {
    // PASS here means the ./lifecycle edge did NOT trip the deny scan,
    // which contradicts what this repo has already measured about it
    // (59-02-SUMMARY.md: 3,469 URLs, 3,402 matching vote-engine) -- a real
    // finding, not a soft one.
    realControlOutcomeLine = 'REAL CONTROL OUTCOME: PASS (unexpected — see acceptance criteria)';
    problems.push('real control (./lifecycle) returned PASS -- expected FORBIDDEN or BUILD_ERROR, never PASS');
  }
  log(realControlOutcomeLine);

  if (problems.length > 0) {
    process.stdout.write(`TIMELINE-CORE BUNDLE PROVENANCE: FAIL — ${problems.length} reason(s):\n`);
    for (const p of problems) process.stdout.write(`    - ${p}\n`);
    process.stdout.write(`${realControlOutcomeLine}\n`);
    cleanupAndExit(1);
    return;
  }

  process.stdout.write(
    `TIMELINE-CORE BUNDLE PROVENANCE: PASS — main arm clean (workspace-package module set: {${main_.timelineCoreRelPath}}), ` +
      `synthetic control caught, real control non-PASS\n`,
  );
  process.stdout.write(`${realControlOutcomeLine}\n`);
  cleanupAndExit(0);
}

main().catch((e) => {
  process.stderr.write(`[timeline-provenance] uncaught: ${e.stack ?? e}\n`);
  cleanupAndExit(1);
});
