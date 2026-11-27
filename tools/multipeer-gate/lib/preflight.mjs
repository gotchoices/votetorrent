/**
 * preflight.mjs — L0: does the tree on disk match the tree this gate CLAIMS to test?
 *
 * WHY THIS IS A LEG AND NOT A COMMENT IN THE README
 * -------------------------------------------------
 * This gate's whole value is that its result can be quoted: "the multi-peer path is green
 * on <these versions>". That sentence is false — in a way nobody can see from the output —
 * if `node_modules` holds something other than what `package.json` declares.
 *
 * It is not hypothetical. On 2026-09-14 this directory declared
 * `@optimystic/db-p2p@^1.0.0-beta.3` and `@serfab/cadre-core@0.13.0` while the installed
 * tree was `0.29.0` and `0.12.0` — a whole major behind. Both baselines taken that day
 * were therefore measuring a dependency set the manifest had already moved off, and the
 * two runs disagreed about which leg failed first for exactly that reason. `.gitignore`
 * hides `package-lock.json`, so nothing in the repository records which tree a past run
 * actually used, and no leg noticed.
 *
 * The second half matters as much as the first: a package can appear MORE THAN ONCE. A
 * dependency that pins an older range gets its own nested copy, so a fix verified against
 * the top-level copy can be absent from the one the code actually loads. Every resolved
 * copy is enumerated here, never just the first.
 *
 * Set `SKIP_PREFLIGHT=1` to run against a deliberately off-manifest tree (bisecting an
 * upstream regression, say). The skip is recorded in the summary, so a result obtained
 * that way cannot be quoted as if the manifest had been honoured.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

/** The packages whose identity the gate's result depends on. */
const TRACKED = /^(@optimystic\/|@serfab\/|@quereus\/)/;

/** Every copy of a tracked package under node_modules, with the version each resolves to. */
function resolvedCopies() {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 6 || !existsSync(dir)) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.name === 'node_modules') { walk(full, depth + 1); continue; }
      if (e.name.startsWith('@')) { walk(full, depth); continue; }
      const pkg = path.join(full, 'package.json');
      if (existsSync(pkg)) {
        try {
          const j = JSON.parse(readFileSync(pkg, 'utf8'));
          if (j.name && TRACKED.test(j.name)) {
            found.push({ name: j.name, version: j.version, at: path.relative(ROOT, full) });
          }
        } catch { /* not a readable manifest */ }
        const nested = path.join(full, 'node_modules');
        if (existsSync(nested)) walk(nested, depth + 1);
      }
    }
  };
  walk(path.join(ROOT, 'node_modules'), 0);
  return found;
}

/**
 * npm's own verdict on whether the installed tree satisfies the manifest. Using `npm ls`
 * rather than hand-rolled range matching is deliberate: prerelease ranges like
 * `^1.0.0-beta.3` are exactly where a hand-rolled comparison quietly gets it wrong, and a
 * preflight that is itself wrong is worse than none.
 */
function npmVerdict() {
  try {
    const out = execFileSync('npm', ['ls', '--json', '--all=false'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { ok: true, problems: JSON.parse(out).problems ?? [] };
  } catch (e) {
    // `npm ls` exits non-zero precisely WHEN there are problems, and still prints the JSON.
    try {
      const parsed = JSON.parse(e.stdout ?? '{}');
      const problems = parsed.problems ?? [];
      const deps = parsed.dependencies ?? {};
      for (const [name, d] of Object.entries(deps)) {
        if (d.missing) problems.push(`missing: ${name}@${d.required ?? '?'}`);
        if (d.invalid) problems.push(`invalid: ${name}@${d.version} does not satisfy ${d.invalid}`);
      }
      return { ok: true, problems };
    } catch {
      return { ok: false, problems: [], error: `npm ls could not be run or parsed: ${e?.message ?? e}` };
    }
  }
}

export function legPreflight(ctx) {
  if (process.env.SKIP_PREFLIGHT === '1') {
    ctx.record('L0', 'dependency-provenance', 'SKIP',
      'SKIP_PREFLIGHT=1 — the installed tree was NOT checked against package.json, so this ' +
      "run's result must not be quoted against the declared versions.");
    return true;
  }

  const copies = resolvedCopies();
  const byName = new Map();
  for (const c of copies) {
    if (!byName.has(c.name)) byName.set(c.name, []);
    byName.get(c.name).push(c);
  }
  const duplicated = [...byName.entries()].filter(([, v]) => new Set(v.map((x) => x.version)).size > 1);

  const verdict = npmVerdict();
  if (!verdict.ok) {
    ctx.record('L0', 'dependency-provenance', 'FAIL',
      `${verdict.error}. The gate cannot state which versions it tested, so no result from ` +
      'this run is quotable. Run `npm install` here, or set SKIP_PREFLIGHT=1 deliberately.');
    return false;
  }

  if (verdict.problems.length) {
    ctx.record('L0', 'dependency-provenance', 'FAIL',
      `the installed tree does not satisfy package.json: ${verdict.problems.join('; ')}. ` +
      `Resolved on disk: ${[...byName.entries()].map(([n, v]) => `${n}@${[...new Set(v.map((x) => x.version))].join('/')}`).join(' ')}. ` +
      'Run `npm install`. Every leg below would otherwise report on a dependency set this ' +
      'directory has already moved off, and the result would be quoted against the declared ' +
      'versions rather than the installed ones.');
    return false;
  }

  if (duplicated.length) {
    ctx.record('L0', 'dependency-provenance', 'FAIL',
      `these packages resolve to MORE THAN ONE version: ` +
      duplicated.map(([n, v]) => `${n} -> ${v.map((x) => `${x.version} (${x.at})`).join(', ')}`).join('; ') +
      '. A nested copy means the code under test may not be the copy that was fixed — ' +
      'add an `overrides` entry so the tree flattens to one.');
    return false;
  }

  ctx.record('L0', 'dependency-provenance', 'PASS',
    [...byName.entries()].map(([n, v]) => `${n}@${v[0].version}`).sort().join(' ') +
    ` (${copies.length} resolved copies, no duplicates, manifest satisfied)`);
  return true;
}
