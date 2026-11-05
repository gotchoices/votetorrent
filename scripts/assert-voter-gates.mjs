#!/usr/bin/env node
/**
 * assert-voter-gates.mjs
 *
 * Phase 59's own closing gate (59-11). Answers one question: did THIS
 * phase's own files introduce a regression, distinct from the red floor
 * this repo already carried before phase 59 touched anything.
 *
 * Why attribution, not a raw "green suite" gate: `yarn workspace
 * votetorrent-voter test` and every named typecheck target below were
 * ALREADY red at commit 46dae0c0, before phase 59 changed a line. A raw
 * "exit 0" gate is therefore impossible without lying, and a raw pass/fail
 * count comparison is too coarse -- the failing SET can rotate while the
 * COUNT holds (this repo has shipped that exact defect before). The
 * contract this script enforces lives in scripts/ci-baselines.json's
 * voterJest / voterTypecheck / voteCoreTypecheck / voteEngineTypecheck /
 * authorityTypecheck entries -- MEASURED numbers, never targets, and never
 * mutated by this script. See that file's own `_readme` for the house
 * rule this script extends: a DROP is investigated exactly like a RISE.
 *
 * What this script does that a bare `yarn test` cannot:
 *   1. Computes the phase-59 file set as a COMMIT-RANGE diff
 *      (`git diff --name-only <base>..HEAD`), never a working-tree diff --
 *      a concurrent session sharing this checkout (this repo has one)
 *      invalidates any whole-tree comparison.
 *   2. Runs the six commands itself and captures each into its own log
 *      under a run directory it prints.
 *   3. Checks each typecheck target's error COUNT against its committed
 *      ceiling (never above; a drop is reported, not silenced).
 *   4. ATTRIBUTES every parsed error path / failing suite path to the
 *      phase-59 file set -- this is the load-bearing half. A ceiling can
 *      hold while a phase-owned file quietly swaps in for a pre-existing
 *      one; attribution catches that, a count never could.
 *   5. Compares the observed failing-suite / failing-title SET (not just
 *      its size) against voterJest's knownFailingSuites/knownFailureTitles
 *      -- an unexpected member is a FAIL even at an unchanged count.
 *   6. Reports every DROP (a count that fell below its recorded floor, or
 *      a known failure that now passes) loudly, in its own block, on a
 *      PASS verdict -- never silently.
 *
 * `--selftest` runs steps 3-5's logic against four committed fixture
 * bundles under scripts/lib/__fixtures__/voter-gates/ (clean, an
 * ANSI-colorized variant of clean proving stripAnsi() below is load-bearing
 * -- see that function's own comment for why raw captured logs can carry
 * color even when nothing in this script's environment asks for it --  one
 * with a fabricated phase-owned error path, one with an unexpected failing
 * suite/title) so a future parser change cannot silently stop catching
 * what it claims to catch.
 *
 * This script never mutates scripts/ci-baselines.json and has no
 * "update the baseline" mode -- see that file's own `_readme`.
 *
 * A note on the one thing this file's own prose must never do: it must
 * never spell out, as a contiguous literal, the two-character marker this
 * script's own attribution/suite-identity logic scans a Jest bullet line
 * for. That marker is assembled from parts below rather than written
 * whole in a comment, precisely so this file cannot trip its own scan
 * the way three prior gates on this repo have. (Read the code, not this
 * sentence, for what the marker actually is.)
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BASELINES_PATH = path.join(__dirname, 'ci-baselines.json');
const FIXTURES_DIR = path.join(__dirname, 'lib', '__fixtures__', 'voter-gates');
const DEFAULT_BASE = '46dae0c0';

// The Jest failing-test bullet character, assembled rather than written as a
// literal so this file's own text can never satisfy (or be mistaken for) the
// pattern it scans captured logs for.
const BULLET = String.fromCharCode(0x25cf); // "●"

function loadBaselines() {
  return JSON.parse(readFileSync(BASELINES_PATH, 'utf8'));
}

function fail(msg) {
  process.stderr.write(`[assert-voter-gates] ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// target registry
// ---------------------------------------------------------------------------

const TARGETS = [
  {
    key: 'voterJest',
    label: 'Voter suite',
    kind: 'jest',
    bin: 'yarn',
    args: ['workspace', 'votetorrent-voter', 'test'],
    pathPrefix: 'apps/VoteTorrentVoter/',
    baselineKey: 'voterJest',
  },
  {
    key: 'voterTypecheck',
    label: 'Voter typecheck',
    kind: 'tsc',
    bin: 'yarn',
    args: ['workspace', 'votetorrent-voter', 'typecheck'],
    pathPrefix: 'apps/VoteTorrentVoter/',
    ceilingKey: 'voterTypecheck',
  },
  {
    key: 'authorityTypecheck',
    label: 'Authority typecheck',
    kind: 'tsc',
    bin: 'yarn',
    args: ['workspace', 'votetorrent-authority', 'typecheck'],
    pathPrefix: 'apps/VoteTorrentAuthority/',
    ceilingKey: 'authorityTypecheck',
  },
  {
    key: 'voteCoreTypecheck',
    label: 'vote-core typecheck',
    kind: 'tsc',
    bin: 'npx',
    args: ['tsc', '--noEmit', '-p', 'packages/vote-core/tsconfig.json'],
    pathPrefix: '',
    ceilingKey: 'voteCoreTypecheck',
  },
  {
    key: 'voteEngineTypecheckBuild',
    label: 'vote-engine typecheck (src, gated)',
    kind: 'tsc',
    bin: 'npx',
    args: ['tsc', '--noEmit', '-p', 'packages/vote-engine/tsconfig.build.json'],
    pathPrefix: '',
    ceilingKey: 'voteEngineTypecheck',
  },
  {
    key: 'voteEngineTypecheckFull',
    label: 'vote-engine typecheck (src+test, reported only -- includes test/, gates on nothing)',
    kind: 'tsc',
    bin: 'npx',
    args: ['tsc', '--noEmit', '-p', 'packages/vote-engine/tsconfig.json'],
    pathPrefix: '',
    ceilingKey: null,
  },
];

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

// Strips ANSI CSI escape sequences (color/bold/etc.) before any line-anchored
// or column-anchored parsing below. Captured child-process output can carry
// these even when nothing in this script's own environment requests color:
// FORCE_COLOR is inherited from the invoking shell (set to 3 in Claude Code
// agent shells, and by several CI images), and once it reaches jest the
// summary line becomes `\x1b[1mTest Suites: ...` -- no longer anchored at
// column 0, which silently defeats every `^...$` /m regex below on an
// otherwise-green run. Scoped to parsing only: the raw captured text (with
// any escapes intact) is still what gets written to each target's log file,
// so a human reading the log sees exactly what the child process emitted.
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

function stripAnsi(text) {
  return text.replace(ANSI_ESCAPE_RE, '');
}

function parseJestCounts(line) {
  const result = { failed: 0, passed: 0, skipped: 0, pending: 0, todo: 0, total: 0 };
  const re = /(\d+)\s+(failed|passed|skipped|pending|todo|total)/g;
  let m;
  while ((m = re.exec(line))) result[m[2]] = Number(m[1]);
  return result;
}

function parseJestLog(rawLog) {
  const log = stripAnsi(rawLog);
  const suitesLineMatch = log.match(/^Test Suites:.*$/m);
  const testsLineMatch = log.match(/^Tests:.*$/m);
  if (!suitesLineMatch || !testsLineMatch) return null; // vacuous-pass guard
  const suites = parseJestCounts(suitesLineMatch[0]);
  const tests = parseJestCounts(testsLineMatch[0]);
  const failSuites = [...log.matchAll(/^FAIL\s+(\S+)/gm)].map((m) => m[1]);
  const failTitleRe = new RegExp(`^\\s*${BULLET}\\s+(.+)$`, 'gm');
  const failTitles = [...log.matchAll(failTitleRe)]
    .map((m) => m[1].trim())
    .filter((t) => t.length > 0)
    // Jest's default reporter emits the SAME bullet character for two things
    // that are NOT failing-test identities: a "Console" header introducing
    // captured console.* output from a PASSING test (verbose console
    // capture), and an internal "Cannot log after tests are done..." warning
    // when a test's async work outlives the test itself. Both are STABLE
    // Jest-reporter strings (not app content, not phase-specific), and both
    // appear on a suite of 57/57 PASSING suites in this repo today -- an
    // unfiltered scan would report dozens of "unexpected failing titles"
    // against a genuinely green run. Real failing-test bullets never match
    // either shape.
    .filter((t) => t !== 'Console' && !t.startsWith('Cannot log after tests are done'));
  return { suites, tests, failSuites, failTitles };
}

const TSC_RAN_CLEAN_RE = /^TSC-RAN exit=0$/m;
const TSC_RAN_ANY_RE = /^TSC-RAN exit=(-?\d+)$/m;

function parseTscLog(rawLog, pathPrefix) {
  const log = stripAnsi(rawLog);
  const errorRe = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):/gm;
  const errors = [...log.matchAll(errorRe)].map((m) => ({
    file: pathPrefix + m[1],
    line: Number(m[2]),
    col: Number(m[3]),
    code: m[4],
  }));
  const ranMatch = log.match(TSC_RAN_ANY_RE);
  const ranClean = TSC_RAN_CLEAN_RE.test(log);
  return {
    errors,
    count: errors.length,
    ranExit: ranMatch ? Number(ranMatch[1]) : null,
    ranClean,
  };
}

function multisetDiff(observed, known) {
  const obsCount = new Map();
  for (const t of observed) obsCount.set(t, (obsCount.get(t) ?? 0) + 1);
  const knownCount = new Map();
  for (const t of known) knownCount.set(t, (knownCount.get(t) ?? 0) + 1);
  const unexpected = [];
  for (const [t, c] of obsCount) {
    const kc = knownCount.get(t) ?? 0;
    for (let i = 0; i < c - kc; i++) unexpected.push(t);
  }
  const missing = [];
  for (const [t, c] of knownCount) {
    const oc = obsCount.get(t) ?? 0;
    for (let i = 0; i < c - oc; i++) missing.push(t);
  }
  return { unexpected, missing };
}

// ---------------------------------------------------------------------------
// evaluation (shared by the real run and --selftest fixtures)
// ---------------------------------------------------------------------------

/**
 * @param {Record<string,string>} logs   TARGETS[].key -> raw captured text
 * @param {string[]} phaseFileSet        repo-relative paths from step 2
 * @param {object} baselines             scripts/ci-baselines.json, parsed
 */
function evaluateAll(logs, phaseFileSet, baselines) {
  const problems = [];
  const drops = [];
  const notices = [];
  const phaseSet = new Set(phaseFileSet);
  const parsed = {};

  for (const t of TARGETS) {
    const raw = logs[t.key];
    if (raw === undefined) {
      problems.push(`${t.label}: no captured log for target "${t.key}"`);
      continue;
    }
    if (t.kind === 'jest') {
      const p = parseJestLog(raw);
      if (!p) {
        problems.push(`${t.label}: vacuous log -- no "Test Suites:"/"Tests:" summary found`);
        continue;
      }
      parsed[t.key] = p;
    } else {
      const p = parseTscLog(raw, t.pathPrefix);
      // Vacuous-pass guard, same shape as assert-ci-baselines.mjs's
      // authority-typecheck check: a genuinely clean tsc run prints NOTHING,
      // which is byte-identical to a log from a step that never ran. Proof
      // of "it ran" is either a diagnostic OR the explicit TSC-RAN marker
      // this script itself appends after every real invocation.
      if (p.count === 0 && !p.ranClean) {
        problems.push(
          `${t.label}: no tsc diagnostics AND no "TSC-RAN exit=0" marker -- the typecheck did not run`,
        );
        continue;
      }
      if (p.ranExit !== null && p.ranExit !== 0 && p.count === 0) {
        problems.push(`${t.label}: tsc exited ${p.ranExit} with zero diagnostics -- looks crashed, not clean`);
        continue;
      }
      parsed[t.key] = p;
    }
  }

  // --- step 4: ceiling checks (typecheck targets with a ceilingKey) --------
  for (const t of TARGETS) {
    if (t.kind !== 'tsc' || !t.ceilingKey) continue;
    const p = parsed[t.key];
    if (!p) continue;
    const cfg = baselines[t.ceilingKey];
    if (!cfg || typeof cfg.maxErrors !== 'number') {
      problems.push(`${t.label}: ci-baselines.json has no usable ${t.ceilingKey}.maxErrors`);
      continue;
    }
    if (p.count > cfg.maxErrors) {
      problems.push(
        `${t.label}: errors=${p.count} exceeds ceiling ${t.ceilingKey}.maxErrors=${cfg.maxErrors} (delta +${p.count - cfg.maxErrors})`,
      );
    } else if (p.count < cfg.maxErrors) {
      drops.push(`${t.label}: errors DROPPED to ${p.count} (recorded ceiling ${t.ceilingKey}.maxErrors=${cfg.maxErrors})`);
    }
  }

  // --- step 5: attribution -- the load-bearing half ------------------------
  // Scoped to the GATED typecheck targets (those with a ceilingKey) plus the
  // Jest suite below. voteEngineTypecheckFull (tsconfig.json, src+test) is
  // deliberately EXCLUDED: it is "captured for the record and reported"
  // only, precisely because packages/vote-engine/test/ is already 143+
  // errors red independent of any phase's content (measured_pre_phase_floor
  // fact 3) -- attributing against it would turn "reported only" into a
  // silent hard gate that fails on ANY phase that adds a vote-engine test
  // file, which is the opposite of what "gates on nothing" means.
  const attributionHits = [];
  for (const t of TARGETS) {
    if (t.kind !== 'tsc' || !t.ceilingKey) continue;
    const p = parsed[t.key];
    if (!p) continue;
    for (const err of p.errors) {
      if (phaseSet.has(err.file)) {
        attributionHits.push(`${t.label}: ${err.file}(${err.line},${err.col}) error ${err.code} -- phase-owned file`);
      }
    }
  }
  {
    const jest = parsed.voterJest;
    if (jest) {
      const voterTarget = TARGETS.find((t) => t.key === 'voterJest');
      for (const suite of jest.failSuites) {
        const repoRelative = voterTarget.pathPrefix + suite;
        if (phaseSet.has(repoRelative)) {
          attributionHits.push(`Voter suite: FAIL ${repoRelative} -- phase-owned file`);
        }
      }
    }
  }
  if (attributionHits.length > 0) {
    problems.push(
      `phase-59 file set attribution: ${attributionHits.length} hit(s) -- the underlying plan is not done, ` +
        `the ceiling is not the fix:\n    ${attributionHits.join('\n    ')}`,
    );
  }

  // --- step 6: suite identity (set, not size) ------------------------------
  {
    const jest = parsed.voterJest;
    const cfg = baselines.voterJest;
    if (jest && cfg) {
      const knownSuites = cfg.knownFailingSuites ?? [];
      const knownTitles = cfg.knownFailureTitles ?? [];
      const suiteDiff = multisetDiff(jest.failSuites, knownSuites);
      const titleDiff = multisetDiff(jest.failTitles, knownTitles);
      if (suiteDiff.unexpected.length > 0) {
        problems.push(`voterJest: unexpected failing suite(s): ${suiteDiff.unexpected.map((s) => JSON.stringify(s)).join(', ')}`);
      }
      if (titleDiff.unexpected.length > 0) {
        problems.push(`voterJest: unexpected failing title(s): ${titleDiff.unexpected.map((s) => JSON.stringify(s)).join(', ')}`);
      }
      if (suiteDiff.missing.length > 0) {
        drops.push(`voterJest: known failing suite(s) now passing: ${suiteDiff.missing.map((s) => JSON.stringify(s)).join(', ')}`);
      }
      if (titleDiff.missing.length > 0) {
        drops.push(`voterJest: known failing title(s) now passing: ${titleDiff.missing.map((s) => JSON.stringify(s)).join(', ')}`);
      }

      // The voterJest count ceilings/floors themselves.
      if (jest.suites.failed > cfg.maxFailingSuites) {
        problems.push(`voterJest: failing suites=${jest.suites.failed} exceeds maxFailingSuites=${cfg.maxFailingSuites}`);
      } else if (jest.suites.failed < cfg.maxFailingSuites) {
        drops.push(`voterJest: failing suites DROPPED to ${jest.suites.failed} (recorded maxFailingSuites=${cfg.maxFailingSuites})`);
      }
      if (jest.suites.passed < cfg.minPassingSuites) {
        problems.push(`voterJest: passing suites=${jest.suites.passed} is below minPassingSuites=${cfg.minPassingSuites}`);
      }
      if (jest.tests.failed > cfg.maxFailingTests) {
        problems.push(`voterJest: failing tests=${jest.tests.failed} exceeds maxFailingTests=${cfg.maxFailingTests}`);
      } else if (jest.tests.failed < cfg.maxFailingTests) {
        drops.push(`voterJest: failing tests DROPPED to ${jest.tests.failed} (recorded maxFailingTests=${cfg.maxFailingTests})`);
      }
      if (jest.tests.passed < cfg.minPassingTests) {
        problems.push(`voterJest: passing tests=${jest.tests.passed} is below minPassingTests=${cfg.minPassingTests}`);
      }
    } else if (!jest) {
      // already recorded as vacuous above
    } else {
      problems.push('ci-baselines.json has no usable voterJest entry');
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    drops,
    notices,
    parsed,
  };
}

// ---------------------------------------------------------------------------
// real run
// ---------------------------------------------------------------------------

function runCaptured(target, runDir) {
  const r = spawnSync(target.bin, target.args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  let out = (r.stdout ?? '') + (r.stderr ?? '');
  if (target.kind === 'tsc') {
    out += `\nTSC-RAN exit=${r.status === null ? -1 : r.status}\n`;
  }
  const logPath = path.join(runDir, `${target.key}.log`);
  writeFileSync(logPath, out);
  return { code: r.status, logPath, out };
}

function realRun(base) {
  process.stdout.write(`[assert-voter-gates] base=${base}\n`);

  // --- step 1: provenance ---------------------------------------------------
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim();
  const porcelain = spawnSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout;
  process.stdout.write(`[assert-voter-gates] HEAD=${head}\n`);
  if (porcelain.trim().length > 0) {
    process.stdout.write(
      `[assert-voter-gates] WARNING: working tree is dirty (a second session may share this checkout):\n${porcelain}`,
    );
  } else {
    process.stdout.write('[assert-voter-gates] working tree clean\n');
  }
  const baseResolved = spawnSync('git', ['rev-parse', base], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim();
  if (!baseResolved) fail(`could not resolve base ${JSON.stringify(base)}`);
  process.stdout.write(`[assert-voter-gates] base resolved: ${base} -> ${baseResolved}\n`);

  // --- step 2: phase file set (commit-range diff, never working-tree) -----
  const diffOut = spawnSync('git', ['diff', '--name-only', `${baseResolved}..HEAD`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (diffOut.status !== 0) fail(`git diff --name-only ${baseResolved}..HEAD failed: ${diffOut.stderr}`);
  const phaseFileSet = diffOut.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  process.stdout.write(`[assert-voter-gates] phase file set: ${phaseFileSet.length} file(s)\n`);
  for (const f of phaseFileSet) process.stdout.write(`    ${f}\n`);

  // --- step 3: run + capture -------------------------------------------------
  const runDir = path.join(process.env.TMPDIR ?? '/tmp', 'voter-gates', String(Date.now()));
  mkdirSync(runDir, { recursive: true });
  process.stdout.write(`[assert-voter-gates] run directory: ${runDir}\n`);

  const logs = {};
  for (const t of TARGETS) {
    process.stdout.write(`[assert-voter-gates] running ${t.label}: ${t.bin} ${t.args.join(' ')}\n`);
    const r = runCaptured(t, runDir);
    logs[t.key] = r.out;
    process.stdout.write(`[assert-voter-gates]   log: ${r.logPath} (exit ${r.code})\n`);
  }

  const baselines = loadBaselines();
  const result = evaluateAll(logs, phaseFileSet, baselines);

  // print parsed counts for every target (verify criterion: "prints ... all
  // six parsed counts")
  for (const t of TARGETS) {
    const p = result.parsed[t.key];
    if (!p) {
      process.stdout.write(`[assert-voter-gates] ${t.label}: UNPARSEABLE\n`);
      continue;
    }
    if (t.kind === 'jest') {
      process.stdout.write(
        `[assert-voter-gates] ${t.label}: suites ${p.suites.passed} passed / ${p.suites.failed} failed / ${p.suites.total || p.suites.passed + p.suites.failed} total; ` +
          `tests ${p.tests.passed} passed / ${p.tests.failed} failed / ${p.tests.total || p.tests.passed + p.tests.failed} total\n`,
      );
    } else {
      process.stdout.write(`[assert-voter-gates] ${t.label}: ${p.count} error(s)\n`);
    }
  }

  if (result.drops.length > 0) {
    process.stdout.write(`[assert-voter-gates] DROP (${result.drops.length}):\n`);
    for (const d of result.drops) process.stdout.write(`    DROP: ${d}\n`);
  }

  if (!result.ok) {
    process.stdout.write(`[assert-voter-gates] FAIL reasons (${result.problems.length}):\n`);
    for (const p of result.problems) process.stdout.write(`    - ${p}\n`);
    process.stdout.write(`VOTER GATES: FAIL — ${result.problems.length} reason(s), see above\n`);
    process.exit(1);
  }

  process.stdout.write(`VOTER GATES: PASS${result.drops.length > 0 ? ` (with ${result.drops.length} DROP(s) reported above)` : ''}\n`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// --selftest
// ---------------------------------------------------------------------------

function loadFixtureBundle(name) {
  const dir = path.join(FIXTURES_DIR, name);
  if (!existsSync(dir)) fail(`fixture bundle missing: ${dir}`);
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const logs = {};
  for (const t of TARGETS) {
    // .txt, not .log -- this repo's root .gitignore blanket-excludes *.log,
    // which would silently exclude a committed fixture from every checkout.
    const p = path.join(dir, `${t.key}.txt`);
    if (!existsSync(p)) fail(`fixture bundle ${name} missing ${t.key}.txt`);
    logs[t.key] = readFileSync(p, 'utf8');
  }
  return { logs, phaseFileSet: manifest.phaseFileSet };
}

function runSelftest() {
  const baselines = loadBaselines();
  const failures = [];
  let total = 0;

  function check(name, expectOk, result) {
    total++;
    const correct = result.ok === expectOk;
    if (!correct) {
      failures.push(
        `${name}: expected ${expectOk ? 'PASS' : 'REJECT'} but got ${result.ok ? 'PASS' : 'REJECT'}` +
          (result.problems.length ? ` (${result.problems.join('; ')})` : ''),
      );
    }
    return { name, correct, result };
  }

  const cases = readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const required = ['clean', 'phase-owned-error', 'unknown-failing-suite', 'ansi-colored-clean'];
  for (const r of required) {
    if (!cases.includes(r)) fail(`required fixture bundle missing: ${r}`);
  }

  // 1. clean -- must PASS outright.
  {
    const bundle = loadFixtureBundle('clean');
    const result = evaluateAll(bundle.logs, bundle.phaseFileSet, baselines);
    check('clean fixture is PASS', true, result);
  }

  // 1b. ansi-colored-clean -- byte-identical to "clean" in substance (57/57 suites, 749/749
  // tests, a clean voter typecheck, the 49 pre-existing authority typecheck errors) but every
  // parsed line is wrapped in real ANSI CSI
  // escape sequences (\x1b[1m / \x1b[22m / \x1b[31m / \x1b[32m / \x1b[39m), reproducing exactly
  // what jest and tsc emit when FORCE_COLOR reaches them -- which it does in Claude Code agent
  // shells (FORCE_COLOR=3) and several CI images, with nothing in this script's own environment
  // asking for it. Without ANSI-stripping in parseJestLog/parseTscLog, the "Test Suites:"/
  // "Tests:" and "error TS" lines no longer start at column 0 and every `^...$` /m regex here
  // silently stops matching -- this is the exact defect this fixture exists to catch if a future
  // edit removes or narrows stripAnsi(). Must PASS outright, identically to "clean".
  {
    const bundle = loadFixtureBundle('ansi-colored-clean');
    const result = evaluateAll(bundle.logs, bundle.phaseFileSet, baselines);
    const c = check('ansi-colored-clean fixture is PASS', true, result);
    if (c.correct) {
      const jest = result.parsed.voterJest;
      const tc = result.parsed.voterTypecheck;
      const atc = result.parsed.authorityTypecheck;
      if (!jest || jest.suites.passed !== 57 || jest.suites.failed !== 0 || jest.tests.passed !== 749) {
        failures.push(
          `ansi-colored-clean fixture: PASSED but parsed the wrong Voter suite counts (ANSI codes leaked through as content) -- got ${JSON.stringify(jest)}`,
        );
      }
      if (!tc || tc.count !== 0 || !tc.ranClean) {
        failures.push(
          `ansi-colored-clean fixture: PASSED but misread the clean Voter typecheck (ANSI codes leaked through as content) -- got ${JSON.stringify(tc)}`,
        );
      }
      // The voter typecheck is clean (0 errors), so the colored `error TS` lines live in the
      // authority log -- this is what keeps parseTscLog's ANSI-stripping of diagnostics proven.
      if (!atc || atc.count !== 49) {
        failures.push(
          `ansi-colored-clean fixture: PASSED but parsed the wrong Authority typecheck error count (ANSI codes leaked through as content) -- got ${atc ? atc.count : atc}`,
        );
      }
    }
  }

  // 2. phase-owned-error -- must FAIL, and specifically for attribution
  //    (step 5), not for an unrelated reason.
  {
    const bundle = loadFixtureBundle('phase-owned-error');
    const result = evaluateAll(bundle.logs, bundle.phaseFileSet, baselines);
    const c = check('phase-owned-error fixture is REJECTED', false, result);
    if (c.correct) {
      const namesAttribution = result.problems.some((p) => p.includes('attribution'));
      if (!namesAttribution) {
        failures.push(
          `phase-owned-error fixture: rejected, but not for its own named reason (attribution) -- problems: ${result.problems.join('; ')}`,
        );
      }
    }
  }

  // 3. unknown-failing-suite -- must FAIL, and specifically for suite
  //    identity (step 6: an unexpected failing suite or title), not for an
  //    unrelated reason.
  {
    const bundle = loadFixtureBundle('unknown-failing-suite');
    const result = evaluateAll(bundle.logs, bundle.phaseFileSet, baselines);
    const c = check('unknown-failing-suite fixture is REJECTED', false, result);
    if (c.correct) {
      const namesSuiteIdentity = result.problems.some(
        (p) => p.includes('unexpected failing suite') || p.includes('unexpected failing title'),
      );
      if (!namesSuiteIdentity) {
        failures.push(
          `unknown-failing-suite fixture: rejected, but not for its own named reason (suite identity) -- problems: ${result.problems.join('; ')}`,
        );
      }
    }
  }

  if (failures.length > 0) {
    process.stderr.write(
      `[assert-voter-gates] selftest: checker is inert: ${failures[0]}\n` +
        failures
          .slice(1)
          .map((f) => `  also: ${f}\n`)
          .join(''),
    );
    process.exit(1);
  }

  process.stdout.write(`selftest: ${total}/${total} cases correct (${required.length} required fixtures: 2 must PASS, 2 must be REJECTED for their own named reason)\n`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) {
    runSelftest();
    return;
  }
  let base = DEFAULT_BASE;
  const baseIdx = args.indexOf('--base');
  if (baseIdx !== -1) {
    if (args.length <= baseIdx + 1) fail('usage: assert-voter-gates.mjs [--base <sha>] [--selftest]');
    base = args[baseIdx + 1];
  }
  realRun(base);
}

main();
