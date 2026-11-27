#!/usr/bin/env node
/**
 * assert-ci-baselines.mjs
 *
 * Verdict authority for the dashboard CI workflow's measured baselines and
 * its anti-silent-green receipt mechanism.
 *
 * Why this exists: a test runner's own process exit code is NOT a trustworthy
 * CI verdict in this repo. `yarn workspace @votetorrent/vote-engine test`
 * exits non-zero by design (its failing count is pinned in
 * scripts/ci-baselines.json's voteEngine.expectedFailing -- read that value,
 * do not restate it here, it has drifted from a hard-coded copy before);
 * `tsc --noEmit`
 * on apps/VoteTorrentAuthority exits non-zero by design (51 pre-existing
 * errors). Both need a checker that reads the actual counts and titles out of
 * a captured log and decides pass/fail against a committed, reviewed contract
 * (scripts/ci-baselines.json) -- not the raw process exit code, which this
 * script's callers deliberately do not trust either (see .github/workflows/
 * dashboard.yml's `if ! ...; then echo "... the checker decides"; fi` guards).
 *
 * Five subcommands:
 *   vote-engine <logfile> [--ci]       -- exact failure count + title match, passing floor.
 *                                          `--ci` selects ciBaselines.voteEngine.ciMinPassing
 *                                          over minPassing: a fresh CI checkout has no
 *                                          .planning/ (nested, gitignored repo), so one test
 *                                          skips there instead of passing -- see ci-baselines
 *                                          .json's voteEngine.note for the full explanation.
 *   tier1 <logfile> <elapsedSeconds> [--baseline <key>]
 *                                      -- named tier1 workspace floor + time budget.
 *                                         <key> defaults to dashboardTier1 (keeps every
 *                                         pre-existing two-argument caller working
 *                                         unchanged); each key carries its own
 *                                         receiptMarker so three tier-1 runs can never
 *                                         satisfy one receipt requirement between them.
 *   authority-typecheck <logfile>      -- tsc error-count ceiling
 *   receipts <receiptfile> <marker...> -- anti-silent-green marker presence check
 *   selftest                           -- the checker's own inertness control
 *
 * Two rules this file obeys and states here: it NEVER mutates ci-baselines.json,
 * and it has NO "update the baseline" mode. Updating a baseline is a human,
 * reviewed commit -- see ci-baselines.json's own _readme.
 *
 * Update / removal trigger: when a workflow step's log format changes (a new
 * mocha version, a new Node --test reporter default, a new tsc diagnostic
 * format), update the relevant parse* function in the SAME commit as whatever
 * changed the format, and re-run `selftest` before trusting the new parser.
 */

import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINES_PATH = path.join(__dirname, 'ci-baselines.json');

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function loadBaselines() {
  // Resolved relative to this file's own URL, never the invoking shell's
  // working directory -- jobs in web-gates.yml invoke this script from the
  // repo root AND from a workspace directory (e.g. apps/VoteTorrentDashboard,
  // apps/VoteTorrentPublic) alike, and a cwd-relative resolution would only
  // work from one of those.
  return JSON.parse(readFileSync(BASELINES_PATH, 'utf8'));
}

function readLogSafe(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function emitReceipt(line) {
  process.stdout.write(line + '\n');
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      writeFileSync(summaryPath, line + '\n', { flag: 'a' });
    } catch {
      // best-effort only -- never fail the check because the run-summary file
      // happens to be unwritable
    }
  }
}

function printNotices(notices) {
  for (const n of notices ?? []) {
    process.stdout.write(`::notice::${n}\n`);
  }
}

function fail(msg) {
  process.stderr.write(`[assert-ci-baselines] ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// mocha summary + failing-title parsing (vote-engine)
// ---------------------------------------------------------------------------

function parseMochaSummary(log) {
  const passingMatch = log.match(/^\s*(\d+)\s+passing\b/m);
  const failingMatch = log.match(/^\s*(\d+)\s+failing\b/m);
  if (!passingMatch && !failingMatch) return null; // the vacuous-pass guard
  return {
    passing: passingMatch ? Number(passingMatch[1]) : 0,
    failing: failingMatch ? Number(failingMatch[1]) : 0,
  };
}

/**
 * Mocha's spec reporter prints a bare "N) title" marker INLINE at the point
 * a test fails during the live run (no trailing colon, and it is never
 * followed by one until some unrelated later line happens to end with ':') --
 * that inline marker must NOT be parsed as a title source. The real,
 * parseable failure detail list is the one final block after the "M failing"
 * summary line, so failure-title parsing is scoped to start there.
 */
function extractFailureSection(log) {
  const re = /^\s*\d+\s+failing\b.*$/m;
  const m = re.exec(log);
  if (!m) return '';
  return log.slice(m.index + m[0].length);
}

/**
 * Within the failure detail section, a test's full title is nested across
 * multiple indented lines (one per enclosing `describe`), terminating in the
 * `it` title, which is the only line in the chain that ends with ':'. A
 * non-nested test's own opening "N) title:" line may already end with ':'.
 * This walks each failure block from its "N) " line until it hits the line
 * ending in ':', joining the lines with a single space to reconstruct the
 * full nested title.
 */
function parseMochaFailureTitles(log) {
  const lines = extractFailureSection(log).split('\n');
  const titles = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^\s*\d+\)\s+(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    const parts = [m[1].trim()];
    let j = i + 1;
    let done = parts[0].endsWith(':');
    while (!done && j < lines.length) {
      const trimmed = lines[j].trim();
      if (trimmed === '') break; // malformed block -- stop rather than run away
      parts.push(trimmed);
      done = trimmed.endsWith(':');
      j++;
    }
    let title = parts.join(' ');
    if (title.endsWith(':')) title = title.slice(0, -1);
    titles.push(title);
    i = done ? j : j; // advance past whatever we consumed either way
  }
  return titles;
}

function multisetDiff(observed, known) {
  const obsCount = new Map();
  for (const t of observed) obsCount.set(t, (obsCount.get(t) ?? 0) + 1);
  const knownCount = new Map();
  for (const t of known) knownCount.set(t, (knownCount.get(t) ?? 0) + 1);

  const unexpected = [];
  for (const [t, c] of obsCount) {
    const kc = knownCount.get(t) ?? 0;
    for (let k = 0; k < c - kc; k++) unexpected.push(t);
  }
  const missing = [];
  for (const [t, c] of knownCount) {
    const oc = obsCount.get(t) ?? 0;
    for (let k = 0; k < c - oc; k++) missing.push(t);
  }
  return { unexpected, missing };
}

function evaluateVoteEngine(log, baselines, opts = {}) {
  const cfg = baselines.voteEngine;
  const ci = Boolean(opts.ci);
  // CI never has `.planning/` (a nested, gitignored git repo with zero tracked files in the
  // outer tree), so one test (strand-cohort-routing-coverage.spec.ts's diagnosis-doc check)
  // guards on existsSync and calls this.skip() there instead of hard-failing an environment
  // that could never have the file. That moves it from passing into pending on CI only -- the
  // failing count and title set are unaffected in both environments, which is why only the
  // floor picks between two committed numbers instead of the whole check branching.
  const floor = ci ? cfg.ciMinPassing : cfg.minPassing;
  const floorName = ci ? 'ciMinPassing' : 'minPassing';
  const summary = parseMochaSummary(log);
  if (!summary) {
    return { ok: false, problems: ['no mocha summary found'] };
  }
  const titles = parseMochaFailureTitles(log);
  const { unexpected, missing } = multisetDiff(titles, cfg.knownFailureTitles);

  const problems = [];
  if (summary.failing !== cfg.expectedFailing) {
    if (summary.failing < cfg.expectedFailing) {
      problems.push(
        `failing count DROPPED to ${summary.failing} (expected exactly ${cfg.expectedFailing}) -- ` +
          `a drop is a signal to investigate, not a number to absorb: a failure that disappeared ` +
          `without a commit that fixed it needs explanation before the baseline is lowered`,
      );
    } else {
      problems.push(
        `failing count ROSE to ${summary.failing} (expected exactly ${cfg.expectedFailing}) -- ` +
          `a newly-introduced failure`,
      );
    }
  }
  if (unexpected.length > 0) {
    problems.push(`unexpected failing title(s): ${unexpected.map((t) => JSON.stringify(t)).join(', ')}`);
  }
  if (missing.length > 0) {
    problems.push(
      `known failing title(s) not observed (disappeared): ${missing.map((t) => JSON.stringify(t)).join(', ')}`,
    );
  }
  if (summary.passing < floor) {
    problems.push(`passing=${summary.passing} is below the floor ${floorName}=${floor}`);
  }

  return {
    ok: problems.length === 0,
    problems,
    receipt: `RECEIPT vote-engine-baseline passing=${summary.passing} failing=${summary.failing} ci=${ci}`,
  };
}

// ---------------------------------------------------------------------------
// tier1 (dashboard test:node) parsing
// ---------------------------------------------------------------------------

function parseTier1Summary(log) {
  let passMatch = log.match(/^#\s*pass\s+(\d+)/m);
  let failMatch = log.match(/^#\s*fail\s+(\d+)/m);
  if (!passMatch && !failMatch) {
    // Fallback: bare `pass N` / `fail N`, in case a future Node changes the
    // default `node --test` reporter away from TAP's `# pass N` form.
    passMatch = log.match(/^pass\s+(\d+)/m);
    failMatch = log.match(/^fail\s+(\d+)/m);
  }
  if (!passMatch && !failMatch) return null; // the vacuous-pass guard
  return {
    passing: passMatch ? Number(passMatch[1]) : 0,
    failing: failMatch ? Number(failMatch[1]) : 0,
  };
}

/**
 * Resolves and validates a NAMED tier1 baseline key. A missing key, a key that
 * is not an object, a key missing a finite minPassing/maxFailing/maxSeconds, or
 * a key with no string receiptMarker are ALL loud failures -- never a fall-back
 * to dashboardTier1. A fall-back would let one workspace's suite pass by
 * clearing a DIFFERENT workspace's floor, with a green receipt and no
 * diagnostic; a checker that invents its own receiptMarker could emit a marker
 * the workflow's `Receipts` step never required, and the run would go green on
 * a receipt nobody asked for.
 */
function resolveTier1Baseline(baselines, baselineKey) {
  const knownKeys = Object.keys(baselines);
  const cfg = baselines[baselineKey];
  if (cfg === undefined || cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return {
      ok: false,
      problems: [
        `unknown tier1 baseline key ${JSON.stringify(baselineKey)} -- known baseline keys: ${knownKeys.join(', ') || '(none)'}`,
      ],
    };
  }
  const problems = [];
  for (const field of ['minPassing', 'maxFailing', 'maxSeconds']) {
    if (typeof cfg[field] !== 'number' || !Number.isFinite(cfg[field])) {
      problems.push(
        `baseline key ${JSON.stringify(baselineKey)} is malformed: ${field} is not a finite number (got ${JSON.stringify(cfg[field])})`,
      );
    }
  }
  if (typeof cfg.receiptMarker !== 'string' || cfg.receiptMarker.length === 0) {
    problems.push(
      `baseline key ${JSON.stringify(baselineKey)} has no string receiptMarker -- a checker that invents one could ` +
        `emit a marker the receipts step never required, going green on a receipt nobody asked for`,
    );
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, cfg };
}

function evaluateTier1(log, elapsedSecondsArg, baselines, baselineKey) {
  const resolved = resolveTier1Baseline(baselines, baselineKey);
  if (!resolved.ok) return { ok: false, problems: resolved.problems };
  const cfg = resolved.cfg;
  const summary = parseTier1Summary(log);
  if (!summary) {
    return {
      ok: false,
      problems: ['no tier1 summary found (expected "# pass N" / "# fail N" or the bare spec-reporter fallback)'],
    };
  }
  // `Number('')` is 0, and 0 is finite -- so a bare Number() coercion turns an
  // UNSET shell variable into a perfectly valid "0 seconds elapsed" and the
  // budget passes on the strength of a value nobody measured. An empty or
  // whitespace-only argument must land on NaN like any other malformed input.
  const elapsed =
    typeof elapsedSecondsArg === 'number'
      ? elapsedSecondsArg
      : typeof elapsedSecondsArg === 'string' && elapsedSecondsArg.trim() !== ''
        ? Number(elapsedSecondsArg)
        : Number.NaN;
  const problems = [];
  if (summary.failing > cfg.maxFailing) {
    problems.push(`fail=${summary.failing} exceeds maxFailing=${cfg.maxFailing}`);
  }
  if (summary.passing < cfg.minPassing) {
    problems.push(`pass=${summary.passing} is below the floor minPassing=${cfg.minPassing}`);
  }
  // A NON-FINITE elapsed is a FAILURE, never a waiver. `Number.isFinite(elapsed)
  // && elapsed > max` skipped the budget entirely for a malformed argument -- an
  // empty string from an unset shell variable, or a SECONDS arithmetic that
  // produced nothing -- with no diagnostic at all. The receipt still printed
  // (`seconds=NaN`), so the run looked normal while the time bound had silently
  // ceased to exist.
  if (!Number.isFinite(elapsed)) {
    problems.push(
      `elapsedSeconds argument is not a finite number (got ${JSON.stringify(elapsedSecondsArg)}) -- ` +
        `the maxSeconds=${cfg.maxSeconds} budget cannot be evaluated, and an unevaluatable budget is not a passed one`,
    );
  } else if (elapsed > cfg.maxSeconds) {
    problems.push(`elapsed=${elapsed}s exceeds maxSeconds=${cfg.maxSeconds}`);
  }
  const notices = [];
  if (summary.passing > cfg.minPassing) {
    notices.push(
      `tier1 passing count ${summary.passing} exceeds the committed floor ${cfg.minPassing} -- ` +
        `raise ${baselineKey}.minPassing deliberately in ci-baselines.json`,
    );
  }
  return {
    ok: problems.length === 0,
    problems,
    notices,
    receipt: `RECEIPT ${cfg.receiptMarker} pass=${summary.passing} fail=${summary.failing} seconds=${elapsed}`,
  };
}

// ---------------------------------------------------------------------------
// authority typecheck ceiling
// ---------------------------------------------------------------------------

/**
 * The marker the workflow appends after running tsc, carrying the compiler's
 * real exit status. It exists because a CLEAN `tsc --noEmit` prints NOTHING,
 * which is byte-identical to a log from a compiler that never ran -- so
 * "contains no diagnostics" cannot, on its own, distinguish "someone fixed
 * everything" from "the step crashed". See evaluateAuthorityTypecheck.
 */
const TSC_RAN_CLEAN_RE = /^TSC-RAN exit=0$/m;

function evaluateAuthorityTypecheck(log, baselines) {
  const cfg = baselines.authorityTypecheck;
  const count = (log.match(/error TS\d+/g) || []).length;

  // THE VACUOUS-PASS GUARD, which this check did not have while its two
  // siblings did (evaluateVoteEngine's "no mocha summary found",
  // evaluateTier1's "no tier1 summary found"). An empty or crashed log yields
  // count = 0, which is <= the ceiling, so the check PASSED -- and helpfully
  // emitted a ::notice:: suggesting someone lower the ceiling. The workflow
  // step deliberately swallows tsc's exit code and hands the verdict here, so
  // nothing else could catch it.
  //
  // Evidence the compiler ran is EITHER at least one diagnostic OR the
  // workflow's explicit exit=0 marker. Requiring only the former would fail a
  // genuinely clean typecheck, which is the outcome this ceiling exists to
  // encourage.
  if (count === 0 && !TSC_RAN_CLEAN_RE.test(log)) {
    return {
      ok: false,
      problems: [
        'no tsc diagnostics AND no "TSC-RAN exit=0" marker -- the typecheck did not run. ' +
          'A clean run prints nothing, so the workflow must append that marker for a zero-error ' +
          'log to be distinguishable from an empty or crashed one',
      ],
    };
  }

  const problems = [];
  if (count > cfg.maxErrors) {
    problems.push(
      `errors=${count} exceeds ceiling maxErrors=${cfg.maxErrors} (delta +${count - cfg.maxErrors}) -- ` +
        `the producer half added to apps/VoteTorrentAuthority must introduce none`,
    );
  }
  const notices = [];
  if (count < cfg.maxErrors) {
    notices.push(
      `authority typecheck errors=${count} is below the ceiling maxErrors=${cfg.maxErrors} -- ` +
        `someone fixed something; lower authorityTypecheck.maxErrors deliberately in that same commit`,
    );
  }
  return {
    ok: problems.length === 0,
    problems,
    notices,
    receipt: `RECEIPT authority-typecheck-baseline errors=${count} ceiling=${cfg.maxErrors}`,
  };
}

// ---------------------------------------------------------------------------
// receipts (anti-silent-green)
// ---------------------------------------------------------------------------

function evaluateReceipts(receiptFile, markers) {
  const content = readLogSafe(receiptFile);
  const missing = [];
  for (const marker of markers) {
    const re = new RegExp('(^|\\s)RECEIPT\\s+' + escapeRegExp(marker) + '(\\s|$)', 'm');
    if (!re.test(content)) missing.push(marker);
  }
  return {
    ok: missing.length === 0,
    problems: missing.length > 0 ? [`missing receipt marker(s): ${missing.join(', ')}`] : [],
  };
}

// ---------------------------------------------------------------------------
// synthetic fixture builders (selftest only)
// ---------------------------------------------------------------------------

function buildMochaLog(passing, failing, titles) {
  let s = `  ${passing} passing (12ms)\n  ${failing} failing\n\n`;
  titles.forEach((t, idx) => {
    s += `  ${idx + 1}) ${t}:\n     Error: synthetic failure for selftest\n\n`;
  });
  return s;
}

function buildTier1LogHash(pass, fail) {
  return `TAP version 13\n1..${pass + fail}\n# tests ${pass + fail}\n# pass ${pass}\n# fail ${fail}\n`;
}

function buildTier1LogBare(pass, fail) {
  return `pass ${pass}\nfail ${fail}\n`;
}

function buildTscLog(n) {
  let s = '';
  for (let i = 0; i < n; i++) {
    s += `src/synthetic${i}.ts(1,1): error TS${1000 + i}: synthetic error for selftest\n`;
  }
  return s;
}

function buildReceiptFile(markers) {
  return markers.map((m) => `RECEIPT ${m} extra=data`).join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// selftest -- the checker's own inertness control
// ---------------------------------------------------------------------------

function runSelftest() {
  const baselines = loadBaselines();
  const tmp = mkdtempSync(path.join(tmpdir(), 'ci-baselines-selftest-'));

  let total = 0;
  let negativeTotal = 0;
  let negativeRejected = 0;
  const failures = [];

  function check(name, expectOk, result) {
    total++;
    const isNegative = !expectOk;
    if (isNegative) negativeTotal++;
    const correct = result.ok === expectOk;
    if (isNegative && correct) negativeRejected++;
    if (!correct) {
      const detail = result.problems && result.problems.length ? ` (${result.problems.join('; ')})` : '';
      failures.push(
        `${name}: expected ${expectOk ? 'PASS' : 'REJECT'} but got ${result.ok ? 'PASS' : 'REJECT'}${detail}`,
      );
    }
  }

  try {
    const knownTitles = baselines.voteEngine.knownFailureTitles;
    const veFloor = baselines.voteEngine.minPassing;
    const veExpectedFailing = baselines.voteEngine.expectedFailing;

    // 1. vote-engine, healthy
    check(
      'vote-engine healthy',
      true,
      evaluateVoteEngine(buildMochaLog(veFloor + 9, veExpectedFailing, knownTitles), baselines),
    );

    // 2. vote-engine, new failure (a 9th title, count rises)
    check(
      'vote-engine new failure',
      false,
      evaluateVoteEngine(
        buildMochaLog(veFloor + 9, veExpectedFailing + 1, [...knownTitles, 'a brand new failure title']),
        baselines,
      ),
    );

    // 3. vote-engine, substituted failure (same count, one title swapped)
    check(
      'vote-engine substituted failure',
      false,
      evaluateVoteEngine(
        buildMochaLog(veFloor + 9, veExpectedFailing, [...knownTitles.slice(1), 'a substituted failure title']),
        baselines,
      ),
    );

    // 4. vote-engine, drop (one fewer failure than expected)
    check(
      'vote-engine drop',
      false,
      evaluateVoteEngine(buildMochaLog(veFloor + 9, veExpectedFailing - 1, knownTitles.slice(1)), baselines),
    );

    // 5. vote-engine, below floor
    check(
      'vote-engine below floor',
      false,
      evaluateVoteEngine(buildMochaLog(Math.max(0, veFloor - 200), veExpectedFailing, knownTitles), baselines),
    );

    // 6. vote-engine, vacuous (empty log) -- the case that matters most
    check('vote-engine vacuous (empty log)', false, evaluateVoteEngine('', baselines));

    // 7. vote-engine, vacuous (no passing/failing summary line at all)
    check(
      'vote-engine vacuous (no summary line)',
      false,
      evaluateVoteEngine('mocha crashed before running anything\nsegmentation fault\n', baselines),
    );

    const veCiFloor = baselines.voteEngine.ciMinPassing;

    // 7a. vote-engine, --ci mode healthy at the LOWER ci floor (one fewer passing than local,
    //     because the .planning-guarded test reports pending instead of passing on CI)
    check(
      'vote-engine ci-mode healthy at ciMinPassing',
      true,
      evaluateVoteEngine(buildMochaLog(veCiFloor, veExpectedFailing, knownTitles), baselines, { ci: true }),
    );

    // 7b. vote-engine, --ci mode still enforces its own floor, not the local (higher) one
    check(
      'vote-engine ci-mode below ciMinPassing',
      false,
      evaluateVoteEngine(
        buildMochaLog(Math.max(0, veCiFloor - 50), veExpectedFailing, knownTitles),
        baselines,
        { ci: true },
      ),
    );

    // 7c. vote-engine, non-ci mode at exactly ciMinPassing must FAIL against the higher local
    //     floor -- proves the two floors are not silently interchangeable
    check(
      'vote-engine non-ci mode rejects the ci floor',
      false,
      evaluateVoteEngine(buildMochaLog(veCiFloor, veExpectedFailing, knownTitles), baselines, { ci: false }),
    );

    const t1Floor = baselines.dashboardTier1.minPassing;
    const t1MaxSeconds = baselines.dashboardTier1.maxSeconds;

    // 8. tier1, healthy (retargeted at dashboardTier1 explicitly -- the checker
    //    no longer hard-codes this key, so every case must name it)
    check(
      'tier1 healthy',
      true,
      evaluateTier1(buildTier1LogHash(t1Floor, 0), Math.max(1, t1MaxSeconds - 1), baselines, 'dashboardTier1'),
    );

    // 9. tier1, failing
    check('tier1 failing', false, evaluateTier1(buildTier1LogHash(t1Floor, 1), 1, baselines, 'dashboardTier1'));

    // 10. tier1, below floor
    check(
      'tier1 below floor',
      false,
      evaluateTier1(buildTier1LogHash(Math.max(0, t1Floor - 50), 0), 1, baselines, 'dashboardTier1'),
    );

    // 11. tier1, over budget
    check(
      'tier1 over budget',
      false,
      evaluateTier1(buildTier1LogHash(t1Floor, 0), t1MaxSeconds + 100, baselines, 'dashboardTier1'),
    );

    // 12. tier1, spec-reporter fallback form (no leading '#')
    check(
      'tier1 spec-reporter fallback form',
      true,
      evaluateTier1(buildTier1LogBare(t1Floor, 0), 1, baselines, 'dashboardTier1'),
    );

    // 13. tier1, vacuous
    check(
      'tier1 vacuous',
      false,
      evaluateTier1('nothing resembling a summary here\n', 1, baselines, 'dashboardTier1'),
    );

    // 13a-13c. tier1, malformed elapsed argument -- an unset shell variable
    //          (empty string), a non-numeric word, and an omitted argument. Each
    //          used to make the time budget silently disappear.
    check('tier1 elapsed empty string', false, evaluateTier1(buildTier1LogHash(t1Floor, 0), '', baselines, 'dashboardTier1'));
    check(
      'tier1 elapsed non-numeric',
      false,
      evaluateTier1(buildTier1LogHash(t1Floor, 0), 'not-a-number', baselines, 'dashboardTier1'),
    );
    check(
      'tier1 elapsed undefined',
      false,
      evaluateTier1(buildTier1LogHash(t1Floor, 0), undefined, baselines, 'dashboardTier1'),
    );

    // 13d. positive control for the three above: a well-formed elapsed at the
    //      exact budget still passes, so the new guard is not just rejecting
    //      everything.
    check(
      'tier1 elapsed exactly at the budget',
      true,
      evaluateTier1(buildTier1LogHash(t1Floor, 0), String(t1MaxSeconds), baselines, 'dashboardTier1'),
    );

    // 13e. tier1, keyed evaluator: one healthy + one below-floor case PER
    //      tier-1 baseline key present in the file, each built from that key's
    //      OWN floor -- so a key whose floor is nonsense is caught by the
    //      checker's own control, not just dashboardTier1's.
    const tier1Keys = Object.keys(baselines).filter((k) => /Tier1$/.test(k));
    for (const key of tier1Keys) {
      const floor = baselines[key].minPassing;
      const maxSeconds = baselines[key].maxSeconds;
      check(
        `tier1 (${key}) healthy [keyed]`,
        true,
        evaluateTier1(buildTier1LogHash(floor, 0), Math.max(1, maxSeconds - 1), baselines, key),
      );
      check(
        `tier1 (${key}) below floor [keyed]`,
        false,
        evaluateTier1(buildTier1LogHash(Math.max(0, floor - 50), 0), 1, baselines, key),
      );
    }

    // 13f. tier1, unknown baseline key -- must be REJECTED, never silently
    //      fall back to dashboardTier1.
    check(
      'tier1 unknown baseline key is rejected',
      false,
      evaluateTier1(buildTier1LogHash(t1Floor, 0), 1, baselines, 'noSuchTier'),
    );

    // 13g. tier1, malformed entry (missing minPassing) -- must be REJECTED.
    {
      const malformedBaselines = {
        ...baselines,
        malformedTier1ForSelftest: { maxFailing: 0, maxSeconds: 10, receiptMarker: 'tier1-malformed' },
      };
      check(
        'tier1 malformed entry (missing minPassing) is rejected',
        false,
        evaluateTier1(buildTier1LogHash(10, 0), 1, malformedBaselines, 'malformedTier1ForSelftest'),
      );
    }

    // 13h. tier1, missing receiptMarker -- must be REJECTED even though every
    //      numeric field is well-formed. A checker that invented a marker here
    //      could satisfy a receipt nobody required.
    {
      const noMarkerBaselines = {
        ...baselines,
        noMarkerTier1ForSelftest: { minPassing: 5, maxFailing: 0, maxSeconds: 10 },
      };
      check(
        'tier1 missing receiptMarker is rejected',
        false,
        evaluateTier1(buildTier1LogHash(5, 0), 1, noMarkerBaselines, 'noMarkerTier1ForSelftest'),
      );
    }

    // 13i. tier1, receiptMarker distinctness across the REAL committed file --
    //      two keys sharing a marker would let one suite's receipt satisfy
    //      another's requirement, the receipts mechanism's one failure mode.
    {
      const markers = tier1Keys.map((k) => baselines[k].receiptMarker);
      const distinct = new Set(markers).size === markers.length;
      check('tier1 receiptMarker values are pairwise distinct', true, {
        ok: distinct,
        problems: distinct ? [] : [`receiptMarker collision across ${tier1Keys.join(', ')}: ${markers.join(', ')}`],
      });
    }

    const tcCeiling = baselines.authorityTypecheck.maxErrors;

    // 14. authority-typecheck, exactly at the ceiling
    check(
      'authority-typecheck at ceiling',
      true,
      evaluateAuthorityTypecheck(buildTscLog(tcCeiling), baselines),
    );

    // 15. authority-typecheck, one over the ceiling
    check(
      'authority-typecheck over ceiling',
      false,
      evaluateAuthorityTypecheck(buildTscLog(tcCeiling + 1), baselines),
    );

    // 16. authority-typecheck, under the ceiling (notice, still passes)
    check(
      'authority-typecheck under ceiling (notice)',
      true,
      evaluateAuthorityTypecheck(buildTscLog(Math.max(0, tcCeiling - 2)), baselines),
    );

    // 16a. authority-typecheck, VACUOUS (empty log) -- the case that matters
    //      most, and the one cases 14-16 could never reach.
    check('authority-typecheck vacuous (empty log)', false, evaluateAuthorityTypecheck('', baselines));

    // 16b. authority-typecheck, the compiler crashed: no diagnostics, and the
    //      marker reports a non-zero exit.
    check(
      'authority-typecheck crashed (marker, non-zero exit, no diagnostics)',
      false,
      evaluateAuthorityTypecheck('Cannot find module typescript\nTSC-RAN exit=1\n', baselines),
    );

    // 16c. authority-typecheck, genuinely CLEAN: zero diagnostics, marker says
    //      exit=0. Must pass -- this is the outcome the ceiling encourages, and
    //      the guard above must not punish it.
    check(
      'authority-typecheck genuinely clean (marker, exit=0, no diagnostics)',
      true,
      evaluateAuthorityTypecheck('TSC-RAN exit=0\n', baselines),
    );

    // 17. receipts, complete set
    {
      const markers = ['toolchain', 'peers-clean', 'tier1-logic'];
      const file = path.join(tmp, 'receipts-complete.txt');
      writeFileSync(file, buildReceiptFile(markers));
      check('receipts complete set', true, evaluateReceipts(file, markers));
    }

    // 18. receipts, one marker missing
    {
      const markers = ['toolchain', 'peers-clean', 'tier1-logic'];
      const file = path.join(tmp, 'receipts-missing.txt');
      writeFileSync(file, buildReceiptFile(markers.slice(0, 2)));
      check('receipts one missing', false, evaluateReceipts(file, markers));
    }

    // 19. receipts, empty file
    {
      const file = path.join(tmp, 'receipts-empty.txt');
      writeFileSync(file, '');
      check('receipts empty file', false, evaluateReceipts(file, ['toolchain']));
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    process.stderr.write(
      `[assert-ci-baselines] checker is inert: ${failures[0]}\n` +
        failures
          .slice(1)
          .map((f) => `  also: ${f}\n`)
          .join(''),
    );
    process.exit(1);
  }

  process.stdout.write(
    `selftest: ${total}/${total} cases, ${negativeRejected}/${negativeTotal} negative cases correctly rejected\n`,
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

function main() {
  const [, , cmd, ...args] = process.argv;

  switch (cmd) {
    case 'vote-engine': {
      const [logfile, ...rest] = args;
      const ci = rest.includes('--ci');
      if (!logfile) fail('usage: assert-ci-baselines.mjs vote-engine <logfile> [--ci]');
      const result = evaluateVoteEngine(readLogSafe(logfile), loadBaselines(), { ci });
      if (!result.ok) fail(`vote-engine baseline check FAILED:\n  - ${result.problems.join('\n  - ')}`);
      printNotices(result.notices);
      emitReceipt(result.receipt);
      break;
    }
    case 'tier1': {
      const [logfile, elapsed, ...rest] = args;
      if (!logfile || elapsed === undefined) {
        fail('usage: assert-ci-baselines.mjs tier1 <logfile> <elapsedSeconds> [--baseline <key>]');
      }
      // Default preserves every pre-existing two-argument invocation
      // (53-02/53-03/53-12) unchanged.
      let baselineKey = 'dashboardTier1';
      if (rest.length > 0) {
        if (rest[0] === '--baseline' && rest.length >= 2) {
          baselineKey = rest[1];
          if (rest.length > 2) {
            fail(`unrecognised argument: ${JSON.stringify(rest[2])} -- an unknown trailing flag silently ` +
              `ignored into a green run is the same defect the shared runner's argument parser exists to avoid`);
          }
        } else {
          fail(`unrecognised argument: ${JSON.stringify(rest[0])} -- ` +
            'usage: assert-ci-baselines.mjs tier1 <logfile> <elapsedSeconds> [--baseline <key>]');
        }
      }
      const result = evaluateTier1(readLogSafe(logfile), elapsed, loadBaselines(), baselineKey);
      if (!result.ok) fail(`tier1 baseline check FAILED:\n  - ${result.problems.join('\n  - ')}`);
      printNotices(result.notices);
      emitReceipt(result.receipt);
      break;
    }
    case 'authority-typecheck': {
      const [logfile] = args;
      if (!logfile) fail('usage: assert-ci-baselines.mjs authority-typecheck <logfile>');
      const result = evaluateAuthorityTypecheck(readLogSafe(logfile), loadBaselines());
      if (!result.ok) fail(`authority-typecheck baseline check FAILED:\n  - ${result.problems.join('\n  - ')}`);
      printNotices(result.notices);
      emitReceipt(result.receipt);
      break;
    }
    case 'receipts': {
      const [receiptfile, ...markers] = args;
      if (!receiptfile || markers.length === 0) {
        fail('usage: assert-ci-baselines.mjs receipts <receiptfile> <marker...>');
      }
      const result = evaluateReceipts(receiptfile, markers);
      if (!result.ok) fail(result.problems.join('\n  - '));
      process.stdout.write(`RECEIPT-CHECK-OK all ${markers.length} marker(s) present\n`);
      break;
    }
    case 'selftest':
      runSelftest();
      break;
    default:
      fail(
        `unknown subcommand: ${cmd ?? '(none)'}\n` +
          'usage: assert-ci-baselines.mjs <vote-engine|tier1|authority-typecheck|receipts|selftest> ...',
      );
  }
}

main();
