#!/usr/bin/env node
/**
 * verify-security-controls.mjs
 *
 * Verdict authority for a phase security document's Control Registry and its
 * composition of the sibling plans' threat registers.
 *
 * Why this exists: Phase 51 shipped a `51-SECURITY.md` that recorded nine
 * threats CLOSED. Nine controls were real, correct and unit-tested. NONE of
 * them ran -- `AppAttestVerifier` and `PlatformDispatchingAttestationVerifier`
 * were referenced nowhere outside `packages/vote-engine/src/association/*` and
 * their own spec files, and `apps/VoteTorrentAuthority/src/engines/engine-
 * factory.ts` had no knowledge that iOS support existed. The document was not
 * wrong about the code. It was wrong about the system, and it stopped anyone
 * looking for eleven days (fixed later at `e64e112`).
 *
 * A `path:line` in a document proves a line exists. It does not prove anything
 * runs it. So this checker does two things a human reviewer demonstrably does
 * not do reliably:
 *
 *   1. re-derives every cited `path:line` against the tree as it stands, and
 *   2. walks the import graph from a declared entry point and refuses to let a
 *      control be recorded CLOSED unless a reachable, non-test module actually
 *      references its anchor.
 *
 * Five subcommands:
 *   controls  <phase-dir>   -- registry rules R1-R8: existence, line, reachability, verdict
 *   reconcile <phase-dir>   -- composition rules C1-C8 over the sibling plans' threat_models
 *   explain   <phase-dir>   -- authoring aid: computes and prints every Reached token.
 *                              ALWAYS exits 2. It is not a verdict and can never be
 *                              wired somewhere as a passing gate.
 *   all       <phase-dir>   -- controls then reconcile; runs the second even if the
 *                              first fails, so one command reports the whole picture
 *   selftest                -- the checker's own inertness control
 *
 * Three distinguishable outcomes, never two: a pass prints a receipt line naming
 * the row count, a failure prints one line per offending row beginning with its
 * rule token and exits 1, and a MISSING document exits 3 with a line beginning
 * `SKIPPED:`. `.planning` is a nested, gitignored repository the outer tree does
 * not carry, so a skip on a fresh checkout has to be visible rather than green.
 *
 * Two rules this file obeys and states here: it has NO "update the document"
 * mode -- a drifted `path:line` is a human, reviewed edit, never a machine
 * rewrite -- and it NEVER resolves a workspace member through `dist/`, because
 * a stale build artifact vouching for a control's reachability is exactly the
 * silent-green this file exists to prevent.
 *
 * The phase directory is REQUIRED for controls/reconcile/explain/all: pass it as
 * the positional argument or `--phase-dir .planning/phases/NN-...` (the npm
 * script forwards it: `yarn verify:security-controls .planning/phases/NN-...`).
 * Do NOT add a hardcoded default back -- the phase number, the plan glob and
 * the threat id prefix are all derived from the directory name, and a default
 * made every later phase silently re-check phase 52 instead. When the repo's module
 * resolution changes (a new workspace layout, a different source entry
 * convention), update `loadWorkspaceAliases` and `resolveRelativeSpecifier` in
 * the SAME commit, and re-run `selftest` before trusting the new resolver.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 1b. Repo root is resolved from this file's own location, never process.cwd():
// the script is invoked from the repo root by yarn and by hand from anywhere.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// The selftest's live corpus (case 27) only. It is NOT a default for the
// phase subcommands: those require an explicit phase directory, because a
// silent fall-back to phase 52 let every later phase "pass" without being checked.
const LIVE_CORPUS_PHASE_DIR = '.planning/phases/52-bootstrap-rendezvous-service';

// The live corpus floors. A floor, never an equality: adding a plan or a threat
// must never make the gate red. Measured 2026-08-29 across 52-01..52-16.
const LIVE_THREAT_FLOOR = 110;
const LIVE_PLAN_FLOOR = 12;

// A cited declaration may sit up to this many lines from where the document
// says it does before the row is called drifted. Anything inside the window is
// reported as a notice so it is still visible.
const LINE_TOLERANCE = 3;

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'Pods',
  '.git',
  '.expo',
  '.nx',
  'coverage',
  'ios',
  'android',
  'vendor',
]);

const REGISTRY_HEADER = [
  'Control ID',
  'Anchor',
  'Definition',
  'Entry point',
  'Reached',
  'Threats',
  'Verdict',
];

const REGISTER_HEADER = [
  'Threat',
  'STRIDE',
  'Component',
  'Disposition',
  'Source threats',
  'Status',
  'Evidence',
];

const NA_ENTRY_POINTS = new Set(['n/a (doc)', 'n/a (test-only)']);

// ---------------------------------------------------------------------------
// small shared helpers
// ---------------------------------------------------------------------------

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readFileSafe(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function fail(msg) {
  process.stderr.write(`[verify-security-controls] ${msg}\n`);
  process.exit(1);
}

function printNotices(notices) {
  for (const n of notices ?? []) process.stdout.write(`NOTICE: ${n}\n`);
}

/**
 * 1e. isTestPath -- the single most load-bearing predicate in this file.
 *
 * This is the definition that separates "a test calls it" from "the product
 * calls it". Phase 51's nine CLOSED controls were all called: by tests, and by
 * nothing else. Widen this predicate carelessly and the gate stops seeing that
 * shape; narrow it carelessly and a genuine production caller inside a
 * `tests/` directory is discounted. Change it only with a selftest fixture.
 */
function isTestPath(p) {
  const norm = p.split(path.sep).join('/');
  const segments = norm.split('/');
  if (segments.some((s) => s === 'test' || s === 'tests' || s === '__tests__' || s === '__mocks__')) {
    return true;
  }
  const base = segments[segments.length - 1] ?? '';
  return /\.(spec|test)\./.test(base);
}

/** Strip block comments and whole-line comments before scanning for specifiers. */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
}

/**
 * Line-preserving reduction of a source file to CODE ONLY: block comments,
 * line comments and the contents of single-line string / template literals are
 * blanked out, and the line count is unchanged so line numbers stay usable.
 *
 * This is what separates `sweepOnce` from `stageForFilesystemBinding`. Both are
 * exported, both are named several times inside their own module, and a naive
 * occurrence count calls them the same thing. After this reduction `sweepOnce`
 * still has a real intra-module CALL site while every remaining
 * `stageForFilesystemBinding` mention turns out to be a JSDoc `{@link}` or the
 * text of a `throw new Error(...)`. Known limit, stated rather than hidden: a
 * MULTI-LINE template literal is not stripped, so an anchor mentioned inside one
 * would be miscounted as code.
 */
function codeOnlyText(text) {
  const noBlocks = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlocks
    .split('\n')
    .map((line) => {
      if (/^\s*(\/\/|\*)/.test(line)) return '';
      return line
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/`(?:[^`\\]|\\.)*`/g, '``')
        .replace(/\/\/.*$/, '');
    })
    .join('\n');
}

/**
 * 1d (extraction half). One pass over three regexes covering every specifier
 * form this repo uses: `import ... from '...'` (whose clause spans lines here),
 * bare `import '...'`, `export ... from '...'`, dynamic `import('...')` and
 * `require('...')`. Matching on `from '...'` rather than on the whole clause is
 * what makes the multi-line case work without a bounded lazy quantifier.
 */
function extractSpecifiers(text) {
  const src = stripComments(text);
  const out = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(?\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src)) !== null) out.push(m[1]);
  }
  return out;
}

/**
 * 1d (resolution half). Try the exact path, then each source extension, then
 * the same extensions under `/index`. THEN, if the specifier ends in `.js` and
 * nothing resolved, retry the whole ladder with `.js` stripped -- that retry is
 * what makes packages/vote-engine's TypeScript-ESM `./snapshot-codec.js`
 * imports resolve to `snapshot-codec.ts`.
 */
function resolveCandidate(base) {
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const ext of SOURCE_EXTENSIONS) {
    const c = base + ext;
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  for (const ext of SOURCE_EXTENSIONS) {
    const c = path.join(base, 'index' + ext);
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

function resolveRelativeSpecifier(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const direct = resolveCandidate(base);
  if (direct) return direct;
  if (spec.endsWith('.js')) return resolveCandidate(base.slice(0, -3));
  return null;
}

// ---------------------------------------------------------------------------
// 1c. workspace alias map -- name -> TypeScript SOURCE entry, never dist/
// ---------------------------------------------------------------------------

function expandWorkspaceGlob(root, glob) {
  // Only the `dir/*` form this repo uses is supported; anything else is taken
  // literally. A member that cannot be expanded becomes an import-graph leaf.
  if (!glob.endsWith('/*')) return [path.join(root, glob)];
  const parent = path.join(root, glob.slice(0, -2));
  if (!existsSync(parent)) return [];
  return readdirSync(parent, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(parent, d.name));
}

function resolvePackageSourceEntry(memberDir, manifest) {
  for (const rel of ['src/index.ts', 'src/index.tsx', 'src/index.js']) {
    const c = path.join(memberDir, rel);
    if (existsSync(c)) return c;
  }
  const main = typeof manifest.main === 'string' ? manifest.main : null;
  if (main) {
    // NEVER resolve through dist/: it may be absent on a clean checkout and
    // stale otherwise, and a stale dist/ producing a false REACHED is precisely
    // the silent-green this script exists to prevent (T-52-15-08).
    const rewritten = main.replace(/^(\.\/)?dist\//, 'src/');
    const stripped = rewritten.replace(/\.(js|mjs|cjs)$/, '');
    const c = resolveCandidate(path.join(memberDir, stripped));
    if (c) return c;
  }
  return null;
}

function loadWorkspaceAliases(root) {
  const aliases = new Map();
  const notices = [];
  const rootManifestText = readFileSafe(path.join(root, 'package.json'));
  if (!rootManifestText) return { aliases, notices, memberDirs: [] };
  let rootManifest;
  try {
    rootManifest = JSON.parse(rootManifestText);
  } catch {
    notices.push('root package.json is not parseable; the workspace alias map is empty');
    return { aliases, notices, memberDirs: [] };
  }
  const globs = Array.isArray(rootManifest.workspaces)
    ? rootManifest.workspaces
    : (rootManifest.workspaces?.packages ?? []);
  const memberDirs = [];
  for (const glob of globs) {
    for (const dir of expandWorkspaceGlob(root, glob)) {
      const manifestText = readFileSafe(path.join(dir, 'package.json'));
      if (!manifestText) continue;
      let manifest;
      try {
        manifest = JSON.parse(manifestText);
      } catch {
        continue;
      }
      memberDirs.push(dir);
      if (typeof manifest.name !== 'string') continue;
      const entry = resolvePackageSourceEntry(dir, manifest);
      if (entry) {
        aliases.set(manifest.name, { entry, dir });
      } else {
        // A member that cannot be resolved becomes an import-graph LEAF. A
        // control whose definition lives inside it therefore reports
        // UNREACHABLE-FILE rather than silently passing.
        notices.push(
          `workspace member '${manifest.name}' has no resolvable source entry (${path.relative(root, dir)}) -- it is an import-graph leaf`,
        );
      }
    }
  }
  return { aliases, notices, memberDirs };
}

function resolveBareSpecifier(spec, aliases) {
  if (aliases.has(spec)) return aliases.get(spec).entry;
  // `name/subpath` resolved against the member's src/
  const slash = spec.lastIndexOf('/');
  for (let i = spec.length; i > 0; i = spec.lastIndexOf('/', i - 1)) {
    const head = spec.slice(0, i);
    if (!aliases.has(head)) continue;
    const { dir } = aliases.get(head);
    const sub = spec.slice(i + 1);
    if (!sub) return aliases.get(head).entry;
    const c = resolveCandidate(path.join(dir, 'src', sub.replace(/\.(js|mjs|cjs)$/, '')));
    if (c) return c;
    return aliases.get(head).entry;
  }
  void slash;
  return null;
}

// ---------------------------------------------------------------------------
// 1d. buildReachableSet -- breadth-first, memoised, never descends node_modules
// ---------------------------------------------------------------------------

function makeGraphContext(root) {
  const { aliases, notices, memberDirs } = loadWorkspaceAliases(root);
  return { root, aliases, notices, memberDirs, reachCache: new Map(), repoScanCache: null };
}

function buildReachableSet(entryAbs, ctx) {
  if (ctx.reachCache.has(entryAbs)) return ctx.reachCache.get(entryAbs);
  const files = new Set();
  let unresolvedRelative = 0;
  const unresolvedSamples = [];
  // Breadth-first with a Set of visited absolute paths. A cycle re-enqueues a
  // path already in the set and is discarded; no recursion, so no stack growth
  // (T-52-15-09).
  const queue = [entryAbs];
  while (queue.length > 0) {
    const file = queue.shift();
    if (files.has(file)) continue;
    if (file.split(path.sep).includes('node_modules')) continue;
    if (!existsSync(file)) continue;
    files.add(file);
    const text = readFileSafe(file);
    if (text === null) continue;
    for (const spec of extractSpecifiers(text)) {
      if (spec.startsWith('.')) {
        const resolved = resolveRelativeSpecifier(file, spec);
        if (resolved) {
          if (!files.has(resolved)) queue.push(resolved);
        } else {
          unresolvedRelative++;
          if (unresolvedSamples.length < 8) {
            unresolvedSamples.push(`${path.relative(ctx.root, file)} -> ${spec}`);
          }
        }
      } else if (spec.startsWith('node:')) {
        // builtin: leaf
      } else {
        const resolved = resolveBareSpecifier(spec, ctx.aliases);
        // Every other bare specifier is a leaf: do not read it, do not descend,
        // and do NOT count it as unresolved.
        if (resolved && !files.has(resolved)) queue.push(resolved);
      }
    }
  }
  const result = { files, unresolvedRelative, unresolvedSamples };
  ctx.reachCache.set(entryAbs, result);
  return result;
}

/**
 * Repo-wide reference scan, used ONLY to show a reader which files reference an
 * anchor when the computed reach is `file-only`. The reach VERDICT is computed
 * from the reachable set; this list is what makes "the references are all
 * tests" visible rather than inferred.
 */
function repoSourceFiles(ctx) {
  if (ctx.repoScanCache) return ctx.repoScanCache;
  const out = [];
  const roots = [...ctx.memberDirs, path.join(ctx.root, 'scripts')];
  for (const r of roots) {
    if (!existsSync(r)) continue;
    const stack = [r];
    while (stack.length > 0) {
      const dir = stack.pop();
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name)) continue;
          stack.push(full);
        } else if (SOURCE_EXTENSIONS.includes(path.extname(e.name))) {
          out.push(full);
        }
      }
    }
  }
  ctx.repoScanCache = out;
  return out;
}

function anchorRegExp(anchor) {
  return new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(anchor)}(?![A-Za-z0-9_$])`);
}

/**
 * 1f. computeReach -> one of `n/a` | `no` | `file-only` | `internal` | `yes`.
 *
 * The anchor is matched with a word-boundary regex, never a bare substring: a
 * substring match would let `putRecord` be "reached" by `putRecordLegacy`.
 *
 * DEVIATION FROM THE ORIGINATING PLAN, stated here because it changes a verdict
 * vocabulary. The plan specified four tokens and made `file-only` a hard
 * failure. Applied to this repository that rule produces SIX false positives:
 * `resolveDistRequest`, `isAuthorizedUpload`, `parseUploadRequest`,
 * `parseRedeemRequest`, `sweepOnce` and `PENDING_REVOKE_STORAGE_KEY` are all
 * module-internal helpers whose exported caller IS reached, so they genuinely
 * run. A gate that is red for a correct system is as useless as one that is
 * green for a broken one, so a fifth token distinguishes them:
 *
 *   yes        a reachable, non-test module OTHER than the definition file
 *              references the anchor. The only token that earns CLOSED.
 *   internal   no outside module does, but the definition file itself CALLS it
 *              (a code occurrence, not a comment or a string, at a line other
 *              than the declaration). Reported on every run; never CLOSED.
 *   file-only  nothing calls it anywhere -- the Phase 51 shape. Hard failure.
 *   no         the definition file is not reachable at all. Hard failure.
 *   n/a        the entry point is one of the two `n/a (...)` literals.
 *
 * The Phase 51 detection is unchanged: `stageForFilesystemBinding` still
 * computes `file-only` and still fails, because after comments and string
 * literals are removed its only remaining occurrence is its own declaration.
 */
function computeReach(definitionAbs, anchor, entryPointCell, ctx) {
  if (NA_ENTRY_POINTS.has(entryPointCell)) {
    return { token: 'n/a', referencedBy: [], unresolvedRelative: 0 };
  }
  const entryAbs = path.resolve(ctx.root, entryPointCell);
  if (!existsSync(entryAbs)) {
    return { token: 'no', referencedBy: [], unresolvedRelative: 0, missingEntry: entryPointCell };
  }
  const { files, unresolvedRelative } = buildReachableSet(entryAbs, ctx);
  if (!files.has(definitionAbs)) {
    return { token: 'no', referencedBy: [], unresolvedRelative };
  }
  const re = anchorRegExp(anchor);
  let reachedByNonTest = false;
  for (const f of files) {
    if (f === definitionAbs) continue;
    if (isTestPath(path.relative(ctx.root, f))) continue;
    const text = readFileSafe(f);
    if (text !== null && re.test(text)) {
      reachedByNonTest = true;
      break;
    }
  }
  if (reachedByNonTest) return { token: 'yes', referencedBy: [], unresolvedRelative };

  // Intra-module call site? Count CODE occurrences only.
  const defText = readFileSafe(definitionAbs) ?? '';
  const codeLines = codeOnlyText(defText).split('\n');
  const internalLines = [];
  for (let i = 0; i < codeLines.length; i++) if (re.test(codeLines[i])) internalLines.push(i + 1);

  const referencedBy = [];
  for (const f of repoSourceFiles(ctx)) {
    if (f === definitionAbs) continue;
    const text = readFileSafe(f);
    if (text !== null && re.test(text)) referencedBy.push(path.relative(ctx.root, f));
  }
  referencedBy.sort();
  const token = internalLines.length >= 2 ? 'internal' : 'file-only';
  return { token, referencedBy, unresolvedRelative, internalLines };
}

// ---------------------------------------------------------------------------
// markdown table helpers
// ---------------------------------------------------------------------------

function splitRow(line) {
  const trimmed = line.trim();
  const body = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return body.split('|').map((c) => c.trim());
}

function firstTableUnder(docText, heading) {
  const lines = docText.split('\n');
  const headingIdx = lines.findIndex((l) => l.trim() === heading);
  if (headingIdx === -1) return null;
  let i = headingIdx + 1;
  while (i < lines.length && !lines[i].trim().startsWith('|')) {
    if (/^##\s/.test(lines[i])) return null; // next section reached, no table
    i++;
  }
  if (i >= lines.length) return null;
  const table = [];
  const startLine = i;
  while (i < lines.length && lines[i].trim().startsWith('|')) {
    table.push(lines[i]);
    i++;
  }
  return { table, startLine };
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

function unbacktick(s) {
  return s.replace(/`/g, '').trim();
}

// ---------------------------------------------------------------------------
// 1g. parseRegistry
// ---------------------------------------------------------------------------

function parseRegistry(docText) {
  const problems = [];
  const found = firstTableUnder(docText, '## Control Registry');
  if (!found) {
    return { ok: false, rows: [], problems: ['MISSING-REGISTRY: no markdown table under `## Control Registry`'] };
  }
  const rows = found.table.map(splitRow);
  const header = rows[0];
  if (
    header.length !== REGISTRY_HEADER.length ||
    header.some((c, i) => c !== REGISTRY_HEADER[i])
  ) {
    return {
      ok: false,
      rows: [],
      problems: [
        `BAD-REGISTRY-HEADER: expected | ${REGISTRY_HEADER.join(' | ')} | but found | ${header.join(' | ')} |`,
      ],
    };
  }
  const dataRows = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    if (isSeparatorRow(cells)) continue;
    if (cells.length !== REGISTRY_HEADER.length) {
      problems.push(`BAD-REGISTRY-ROW: row ${i} has ${cells.length} cells, expected ${REGISTRY_HEADER.length}`);
      continue;
    }
    const [id, anchorCell, defCell, entryCell, reachedCell, threatsCell, verdictCell] = cells;
    const anchor = unbacktick(anchorCell);
    const definition = unbacktick(defCell);
    const entryPoint = unbacktick(entryCell);
    const lastColon = definition.lastIndexOf(':');
    const filePart = lastColon === -1 ? definition : definition.slice(0, lastColon);
    const linePart = lastColon === -1 ? '' : definition.slice(lastColon + 1);
    if (/^\d+\s*-\s*\d+$/.test(linePart)) {
      problems.push(`RANGE-NOT-ALLOWED: ${id} cites a line range (${definition}); the anchor is a declaration and declarations start on one line`);
      continue;
    }
    if (!/^\d+$/.test(linePart)) {
      problems.push(`BAD-DEFINITION: ${id} definition '${definition}' is not a repo-relative path:line`);
      continue;
    }
    dataRows.push({
      id,
      anchor,
      definitionFile: filePart,
      definitionLine: Number(linePart),
      entryPoint,
      reached: reachedCell,
      threats: threatsCell,
      verdict: verdictCell,
    });
  }
  return { ok: problems.length === 0, rows: dataRows, problems };
}

// ---------------------------------------------------------------------------
// 1h. evaluateControls -- R1..R8, accumulating EVERY failing row
// ---------------------------------------------------------------------------

function evaluateControls(docText, ctx) {
  const problems = [];
  const notices = [];
  const parsed = parseRegistry(docText);
  problems.push(...parsed.problems);
  if (!parsed.ok && parsed.rows.length === 0) {
    return { ok: false, problems, notices, rows: [] };
  }
  if (parsed.rows.length === 0) {
    problems.push('EMPTY-REGISTRY: `## Control Registry` has a header and no data rows -- an empty table is never a pass');
    return { ok: false, problems, notices, rows: [] };
  }

  const seenIds = new Set();
  const results = [];
  let maxUnresolved = 0;

  for (const row of parsed.rows) {
    if (!/^C-\d{2}-\d{2}$/.test(row.id)) {
      problems.push(`BAD-CONTROL-ID: '${row.id}' is not of the form C-NN-NN`);
    }
    if (seenIds.has(row.id)) problems.push(`DUPLICATE-CONTROL-ID: ${row.id} appears more than once`);
    seenIds.add(row.id);

    if (!row.anchor || /\s/.test(row.anchor)) {
      problems.push(`BAD-ANCHOR: ${row.id} anchor '${row.anchor}' must be exactly one backticked identifier`);
      continue;
    }

    const definitionAbs = path.resolve(ctx.root, row.definitionFile);

    // R1 MISSING-FILE
    if (!existsSync(definitionAbs)) {
      problems.push(`MISSING-FILE: ${row.id} cites ${row.definitionFile}, which does not exist`);
      continue;
    }

    const text = readFileSafe(definitionAbs);
    const lines = text === null ? [] : text.split('\n');
    const re = anchorRegExp(row.anchor);

    // R2/R3 -- anchor at the cited line, drifted, or gone
    const citedIdx = row.definitionLine - 1;
    const citedLineText = lines[citedIdx] ?? '';
    let trueLine = -1;
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        trueLine = i + 1;
        break;
      }
    }
    if (!re.test(citedLineText)) {
      if (trueLine === -1) {
        problems.push(`ANCHOR-MISSING: ${row.id} anchor '${row.anchor}' is absent from ${row.definitionFile} entirely`);
        continue;
      }
      // find the nearest occurrence for the tolerance test
      let nearest = -1;
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        const d = Math.abs(i + 1 - row.definitionLine);
        if (nearest === -1 || d < Math.abs(nearest - row.definitionLine)) nearest = i + 1;
      }
      if (Math.abs(nearest - row.definitionLine) > LINE_TOLERANCE) {
        problems.push(
          `LINE-DRIFT: ${row.id} cites ${row.definitionFile}:${row.definitionLine} but '${row.anchor}' is at line ${nearest} (first occurrence line ${trueLine})`,
        );
        continue;
      }
      notices.push(
        `${row.id} anchor '${row.anchor}' is at ${row.definitionFile}:${nearest}, ${Math.abs(nearest - row.definitionLine)} line(s) from the cited ${row.definitionLine} -- inside the +/-${LINE_TOLERANCE} tolerance`,
      );
    }

    // R4/R5 -- reachability
    const reach = computeReach(definitionAbs, row.anchor, row.entryPoint, ctx);
    maxUnresolved = Math.max(maxUnresolved, reach.unresolvedRelative ?? 0);
    if (reach.missingEntry) {
      problems.push(`MISSING-ENTRY-POINT: ${row.id} declares entry point ${reach.missingEntry}, which does not exist`);
      continue;
    }
    if (reach.token === 'no') {
      problems.push(
        `UNREACHABLE-FILE: ${row.id} -- ${row.definitionFile} is not reachable by import from ${row.entryPoint}`,
      );
    } else if (reach.token === 'file-only') {
      const refs = reach.referencedBy.length
        ? reach.referencedBy.join(', ')
        : '(nothing in the repository references it)';
      problems.push(
        `UNREACHED-SYMBOL: ${row.id} -- ${row.definitionFile} is reachable from ${row.entryPoint} but NOTHING calls '${row.anchor}': no reachable non-test module references it, and its own module carries no call site outside comments and string literals. Referenced by: ${refs}`,
      );
    } else if (reach.token === 'internal') {
      // Reported on EVERY run, never silent -- but not a failure, because the
      // exported caller that does reach it carries its own registry row.
      notices.push(
        `INTERNAL-ONLY: ${row.id} -- '${row.anchor}' is called only from inside ${row.definitionFile} (code lines ${reach.internalLines.join(', ')}). It can never be CLOSED; name the module-boundary symbol that reaches it in its own row.`,
      );
    }

    // R6 -- the author transcribes what the tool computed; a disagreement is red
    if (row.reached !== reach.token) {
      problems.push(
        `REACHED-MISMATCH: ${row.id} declares Reached '${row.reached}' but the computed token is '${reach.token}'`,
      );
    }

    // R7 -- CLOSED requires yes + at least one named threat
    const threatsNamed = row.threats.toLowerCase() !== 'none' && row.threats.length > 0;
    if (row.verdict === 'CLOSED' && (reach.token !== 'yes' || !threatsNamed)) {
      problems.push(
        `CLOSED-WITHOUT-REACH: ${row.id} is marked CLOSED with computed reach '${reach.token}' and Threats '${row.threats}' -- CLOSED requires Reached: yes and at least one named threat`,
      );
    }
    if (!['CLOSED', 'MITIGATED', 'PARTIAL'].includes(row.verdict)) {
      problems.push(`BAD-VERDICT: ${row.id} verdict '${row.verdict}' is not CLOSED, MITIGATED or PARTIAL`);
    }

    // R8 -- the two n/a entry-point literals force PARTIAL at most
    if (NA_ENTRY_POINTS.has(row.entryPoint) && row.verdict !== 'PARTIAL') {
      problems.push(
        `NA-ENTRY-VERDICT: ${row.id} declares entry point '${row.entryPoint}', which forces Verdict to PARTIAL at most, but it says '${row.verdict}'`,
      );
    }

    results.push({ ...row, computed: reach.token, referencedBy: reach.referencedBy });
  }

  notices.push(...ctx.notices);
  return {
    ok: problems.length === 0,
    problems,
    notices,
    rows: results,
    unresolvedRelative: maxUnresolved,
  };
}

// ---------------------------------------------------------------------------
// 2a. collectPlanThreats
// ---------------------------------------------------------------------------

/**
 * Slice ONLY the `<threat_model>` block. Never scan the whole plan: plan prose
 * quotes threat ids in objectives, read_first blocks and rationales, and a
 * whole-file scan would invent threats that no register declares.
 *
 * A plan may mention `<threat_model>` in prose BOTH before and inside its real
 * block -- 52-15-PLAN.md carries sixteen such mentions, two of them inside the
 * register's own rationale cells -- so neither "the first tag" nor "the last
 * tag" locates the block. The register's `| Threat ID |` header does. Anchor on
 * that, take the nearest enclosing tags, and assert the slice carries the
 * header, so a mis-slice is loud rather than silently empty.
 */
function sliceThreatModel(text) {
  const headerRe = /\|\s*Threat ID\s*\|/g;
  let headerIdx = -1;
  let m;
  while ((m = headerRe.exec(text)) !== null) headerIdx = m.index;
  if (headerIdx === -1) {
    // No register table at all: fall back to the tag pair so the caller can
    // report NO-THREAT-TABLE rather than NO-THREAT-MODEL.
    const closeIdx = text.lastIndexOf('</threat_model>');
    if (closeIdx === -1) return null;
    const openIdx = text.lastIndexOf('<threat_model>', closeIdx);
    if (openIdx === -1) return null;
    return text.slice(openIdx, closeIdx);
  }
  const openIdx = text.lastIndexOf('<threat_model>', headerIdx);
  const closeIdx = text.indexOf('</threat_model>', headerIdx);
  if (openIdx === -1 || closeIdx === -1) return null;
  return text.slice(openIdx, closeIdx);
}

/**
 * PLAN_SEG -- the plan-segment pattern, and the ONE place it is written.
 *
 * A plan id's middle segment is two digits OPTIONALLY followed by a single
 * lowercase letter: `01`, `08`, `03a`, `03b`. The letter is not decoration and
 * it is not a naming preference -- when a plan is too large for one executor's
 * context budget the planner SPLITS it into lettered siblings, and the letter
 * is then part of the plan id everywhere: the filename, every threat id inside
 * it, every transfer rationale that names it as an owner, and every
 * `<phase>-SECURITY.md` register row that cites one of its threats.
 *
 * A reader tempted to "simplify" this back to a two-digit-only pattern should
 * know what that costs, because it was measured: with two-digit-only patterns
 * this checker collected 17 of the 19 plan files in phase 54 and extracted 0
 * of the 15 threat rows the two lettered siblings declare -- and reported a
 * clean EXPLAIN while doing it. An absent plan is indistinguishable from a
 * plan that declared no threats.
 *
 * Widening ONLY the file-collection regex is worse than not widening at all:
 * the lettered files are then collected and counted, their header satisfies
 * the table check, and every row inside them is still dropped -- so the plan
 * count rises, the threat count does not, and the under-count survives behind
 * a number that moved. That half-fix was reproduced deliberately as this
 * change's negative control. Every site that decomposes a plan id MUST be
 * built from this constant.
 *
 * Bounded on purpose: ONE optional lowercase letter, never an unbounded run
 * and never a special case naming a particular plan. "Widened" must not become
 * "matches anything" -- a two-letter suffix and an uppercase suffix are both
 * still rejected, and the selftest asserts that as a negative case.
 *
 * @type {string}
 */
const PLAN_SEG = '\\d{2}[a-z]?';

/**
 * Rows are matched on their leading id cell. The exact shape parsed, taken from
 * `52-08-PLAN.md`'s register and reproduced here so the contract is readable
 * without opening a plan:
 *
 *   | T-52-08-12 | Information Disclosure | sealed ciphertext orphaned … | mitigate | Ciphertext is written … |
 *   | T-52-10-06 | Information Disclosure | ciphertext without a record … | mitigate (upstream control) | … `52-08` … |
 *
 * Five cells minimum: id, category, component, disposition, rationale. A
 * trailing `SC` in place of the last pair marks a supply-chain row, which is
 * excluded from the EMPTY-CORPUS floor but included in every coverage rule.
 */
function collectPlanThreats(phaseDirAbs, phaseNum) {
  const problems = [];
  const threats = [];
  const plans = [];
  if (!existsSync(phaseDirAbs)) {
    return { plans, threats, problems: [`EMPTY-CORPUS: phase directory ${phaseDirAbs} does not exist`] };
  }
  const planRe = new RegExp(`^${phaseNum}-${PLAN_SEG}-PLAN\\.md$`);
  const files = readdirSync(phaseDirAbs).filter((f) => planRe.test(f)).sort();
  const idRe = new RegExp(`^\\|\\s*(T-${phaseNum}-(${PLAN_SEG})-(\\d{2}|SC))\\s*\\|`);
  for (const f of files) {
    const text = readFileSafe(path.join(phaseDirAbs, f));
    if (text === null) continue;
    const block = sliceThreatModel(text);
    if (block === null) {
      problems.push(`NO-THREAT-MODEL: ${f} has no <threat_model> block`);
      continue;
    }
    if (!/\|\s*Threat ID\s*\|/.test(block)) {
      problems.push(`NO-THREAT-TABLE: ${f}'s <threat_model> slice carries no '| Threat ID |' header`);
      continue;
    }
    plans.push(f);
    for (const line of block.split('\n')) {
      const m = idRe.exec(line);
      if (!m) continue;
      const cells = splitRow(line);
      if (cells.length < 5) {
        problems.push(`BAD-THREAT-ROW: ${f} row ${m[1]} has ${cells.length} cells`);
        continue;
      }
      threats.push({
        id: m[1],
        plan: `${phaseNum}-${m[2]}`,
        planFile: f,
        isSupplyChain: m[3] === 'SC',
        category: cells[1],
        component: cells[2],
        dispositionCell: cells[3],
        rationale: cells.slice(4).join(' | '),
      });
    }
  }
  return { plans, threats, problems };
}

// ---------------------------------------------------------------------------
// 2b. normaliseDisposition
// ---------------------------------------------------------------------------

/**
 * A bare `mitigate` / `accept` / `transfer` passes through. A qualified form
 * `<token> (<qualifier>)` yields both parts, and a QUALIFIED `mitigate` is
 * treated as a transfer for graph purposes -- which is what makes
 * `T-52-10-06`'s `mitigate (upstream control)` visible to the cycle detector
 * instead of hiding behind a word that reads like local ownership.
 */
function normaliseDisposition(cell) {
  const raw = String(cell ?? '').trim().toLowerCase();
  const m = /^([a-z]+)\s*(?:\(([^)]*)\))?$/.exec(raw);
  if (!m) return { ok: false, raw };
  const token = m[1];
  const qualifier = m[2] ? m[2].trim() : null;
  if (!['mitigate', 'accept', 'transfer'].includes(token)) return { ok: false, raw };
  if (!qualifier) return { ok: true, token, qualifier: null, graph: token, raw };
  if (token === 'mitigate') return { ok: true, token, qualifier, graph: 'transfer', raw };
  return { ok: true, token, qualifier, graph: token, raw };
}

// ---------------------------------------------------------------------------
// 2c. owner extraction + the transfer graph
// ---------------------------------------------------------------------------

function extractOwnerRefs(rationale, phaseNum, selfId) {
  const threatIds = new Set();
  const planIds = new Set();
  const tRe = new RegExp(`T-${phaseNum}-${PLAN_SEG}-(?:\\d{2}|SC)`, 'g');
  let m;
  while ((m = tRe.exec(rationale)) !== null) {
    if (m[0] !== selfId) threatIds.add(m[0]);
  }
  const pRe = new RegExp(`(?<!T-)\\b${phaseNum}-(${PLAN_SEG})\\b(?!-)`, 'g');
  while ((m = pRe.exec(rationale)) !== null) planIds.add(`${phaseNum}-${m[1]}`);
  return { threatIds: [...threatIds], planIds: [...planIds] };
}

function detectCycles(edges) {
  // Explicit colour-marking depth-first search. WHITE = unvisited, GREY = on
  // the current path, BLACK = finished. A GREY hit is a back edge and the cycle
  // is the current path from that node onward.
  const colour = new Map();
  const cycles = [];
  const nodes = new Set();
  for (const [from, tos] of edges) {
    nodes.add(from);
    for (const t of tos) nodes.add(t);
  }
  const stack = [];
  function visit(n) {
    colour.set(n, 'grey');
    stack.push(n);
    for (const t of edges.get(n) ?? []) {
      const c = colour.get(t) ?? 'white';
      if (c === 'white') visit(t);
      else if (c === 'grey') {
        const start = stack.indexOf(t);
        cycles.push([...stack.slice(start), t].join(' -> '));
      }
    }
    stack.pop();
    colour.set(n, 'black');
  }
  for (const n of nodes) if ((colour.get(n) ?? 'white') === 'white') visit(n);
  return cycles;
}

// ---------------------------------------------------------------------------
// 2d/2e. the document's Reconciled Register and Residual Composition section
// ---------------------------------------------------------------------------

function parseReconciledRegister(docText) {
  const found = firstTableUnder(docText, '## Reconciled Register');
  if (!found) {
    return { ok: false, rows: [], problems: ['MISSING-REGISTER: no markdown table under `## Reconciled Register`'] };
  }
  const rows = found.table.map(splitRow);
  const header = rows[0];
  if (header.length !== REGISTER_HEADER.length || header.some((c, i) => c !== REGISTER_HEADER[i])) {
    return {
      ok: false,
      rows: [],
      problems: [
        `BAD-REGISTER-HEADER: expected | ${REGISTER_HEADER.join(' | ')} | but found | ${header.join(' | ')} |`,
      ],
    };
  }
  const dataRows = [];
  const problems = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    if (isSeparatorRow(cells)) continue;
    if (cells.length !== REGISTER_HEADER.length) {
      problems.push(`BAD-REGISTER-ROW: row ${i} has ${cells.length} cells, expected ${REGISTER_HEADER.length}`);
      continue;
    }
    dataRows.push({
      threat: cells[0],
      stride: cells[1],
      component: cells[2],
      disposition: cells[3],
      sources: cells[4],
      status: cells[5],
      evidence: cells[6],
    });
  }
  return { ok: problems.length === 0, rows: dataRows, problems };
}

function parseResidualSection(docText) {
  const lines = docText.split('\n');
  const start = lines.findIndex((l) => l.trim() === '## Residual Composition');
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

// ---------------------------------------------------------------------------
// C6 -- what makes a rationale substantive
// ---------------------------------------------------------------------------

const MIN_RATIONALE_CHARS = 80;

function rationaleMarkers(text, selfId) {
  const scrubbed = selfId ? text.split(selfId).join('') : text;
  const markers = [];
  if (/\bD-\d{2}\b/.test(scrubbed)) markers.push('D-NN');
  if (/[\w./-]+\.[A-Za-z]{2,4}:\d+/.test(scrubbed)) markers.push('path:line');
  if (new RegExp(`T-\\d{2}-${PLAN_SEG}-(?:\\d{2}|SC)`).test(scrubbed)) markers.push('T-id');
  if (/\bbecause\b/i.test(scrubbed)) markers.push('because');
  return markers;
}

// ---------------------------------------------------------------------------
// 2f. evaluateReconcile -- C1..C8
// ---------------------------------------------------------------------------

function evaluateReconcile(docText, corpus, options) {
  const phaseNum = options.phaseNum;
  const threatFloor = options.threatFloor ?? LIVE_THREAT_FLOOR;
  const problems = [...corpus.problems];
  const notices = [];

  // C1a -- EMPTY-CORPUS
  const countable = corpus.threats.filter((t) => !t.isSupplyChain);
  if (corpus.plans.length === 0) {
    problems.push('EMPTY-CORPUS: the plan glob matched zero plans');
  } else if (countable.length < threatFloor) {
    problems.push(
      `EMPTY-CORPUS: ${countable.length} non-supply-chain threats across ${corpus.plans.length} plans is below the floor of ${threatFloor}`,
    );
  }

  const register = parseReconciledRegister(docText);
  problems.push(...register.problems);
  const residual = parseResidualSection(docText);
  if (residual === null) {
    problems.push('MISSING-RESIDUALS: the document has no `## Residual Composition` section');
  }

  // Build the source-threat claim map
  const claimedBy = new Map(); // id -> [register row threat names]
  const idRe = new RegExp(`T-${phaseNum}-${PLAN_SEG}-(?:\\d{2}|SC)`, 'g');
  for (const row of register.rows) {
    const cell = row.sources;
    if (/^none \(phase-level\)$/i.test(cell.trim())) continue;
    const ids = cell.match(idRe) ?? [];
    if (ids.length === 0) {
      problems.push(`BAD-SOURCES: register row '${row.threat}' has an unparseable Source threats cell '${cell}'`);
      continue;
    }
    for (const id of ids) {
      if (!claimedBy.has(id)) claimedBy.set(id, []);
      claimedBy.get(id).push(row.threat);
    }
  }

  // C1b -- DROPPED-THREAT
  for (const t of corpus.threats) {
    if (!claimedBy.has(t.id)) {
      problems.push(`DROPPED-THREAT: ${t.id} (${t.planFile}) does not appear in any Reconciled Register Source threats cell`);
    }
  }
  // C2 -- DUPLICATE-CLAIM
  for (const [id, rows] of claimedBy) {
    if (rows.length > 1) {
      problems.push(`DUPLICATE-CLAIM: ${id} is claimed by ${rows.length} register rows: ${rows.join(' | ')}`);
    }
  }

  // C3 -- dispositions, C4 -- transfer ownership, C5 -- cycles
  const byId = new Map(corpus.threats.map((t) => [t.id, t]));
  const byPlan = new Map();
  for (const t of corpus.threats) {
    if (!byPlan.has(t.plan)) byPlan.set(t.plan, []);
    byPlan.get(t.plan).push(t);
  }
  const edges = new Map();
  let transfers = 0;
  const accepts = [];

  for (const t of corpus.threats) {
    const d = normaliseDisposition(t.dispositionCell);
    if (!d.ok) {
      problems.push(`BAD-DISPOSITION: ${t.id} has disposition '${t.dispositionCell}'`);
      continue;
    }
    t.norm = d;
    if (d.graph === 'accept') accepts.push(t);
    if (d.graph !== 'transfer') continue;
    transfers++;
    const owners = extractOwnerRefs(t.rationale, phaseNum, t.id);
    if (owners.threatIds.length === 0 && owners.planIds.length === 0) {
      problems.push(
        `BAD-DISPOSITION: ${t.id} is a transfer (${d.raw}) whose rationale names no owner plan (${phaseNum}-NN) or owner threat id`,
      );
      continue;
    }
    const targets = [];
    for (const oid of owners.threatIds) targets.push(oid);
    for (const pid of owners.planIds) targets.push(pid);
    edges.set(t.id, targets);

    // C4 -- the owner must have written the acceptance down on THEIR side.
    // The pair that formed once (T-52-08-12 / T-52-10-06, orphan ciphertext)
    // failed exactly because each side pointed at the other and neither wrote
    // down that it had accepted. So a named owner is not enough: the owner's
    // own register must carry a `mitigate` row that names the transferring
    // threat id or the transferring plan.
    let owned = false;
    const ownerPlans = new Set(owners.planIds);
    for (const oid of owners.threatIds) {
      const ot = byId.get(oid);
      if (ot) ownerPlans.add(ot.plan);
    }
    for (const pid of ownerPlans) {
      const rows = byPlan.get(pid);
      if (!rows) continue;
      for (const r of rows) {
        const rd = normaliseDisposition(r.dispositionCell);
        if (!rd.ok || rd.token !== 'mitigate' || rd.qualifier) continue;
        if (r.rationale.includes(t.id) || r.rationale.includes(t.plan)) {
          owned = true;
          break;
        }
      }
      if (owned) break;
    }
    if (!owned) {
      const named = [...ownerPlans].join(', ') || '(none)';
      problems.push(
        `TRANSFER-UNOWNED: ${t.id} transfers to ${named}, but no mitigate row in that owner's register names ${t.id} or ${t.plan}`,
      );
    }
  }

  // C5 -- CIRCULAR-TRANSFER
  for (const cyc of detectCycles(edges)) {
    problems.push(`CIRCULAR-TRANSFER: ${cyc}`);
  }

  // C6/C7 -- accepts
  let thinAtPlanLevel = 0;
  for (const a of accepts) {
    const planRationale = a.rationale;
    if (planRationale.length < MIN_RATIONALE_CHARS) {
      problems.push(
        `ACCEPT-NO-RATIONALE: ${a.id} rationale is ${planRationale.length} characters, below the ${MIN_RATIONALE_CHARS}-character minimum`,
      );
      continue;
    }
    // The composed rationale: the plan's own text, plus whatever the composing
    // document says about this id in its register row and in the residual
    // section. A sibling that wrote substantive prose carrying no machine
    // marker is not silently forgiven -- it is recorded as a notice and the
    // COMPOSING document must supply the citation.
    const planMarkers = rationaleMarkers(planRationale, a.id);
    if (planMarkers.length === 0) thinAtPlanLevel++;
    let composed = planRationale;
    for (const row of register.rows) {
      if (row.sources.includes(a.id)) composed += ' ' + row.disposition + ' ' + row.evidence + ' ' + row.threat;
    }
    if (residual) {
      for (const para of residual.split(/\n\s*\n/)) {
        if (para.includes(a.id)) composed += ' ' + para;
      }
    }
    const markers = rationaleMarkers(composed, a.id);
    if (markers.length === 0) {
      problems.push(
        `ACCEPT-NO-RATIONALE: ${a.id} rationale (${planRationale.length} chars, composed ${composed.length}) carries none of: a D-NN citation, a path:line, another T-${phaseNum}- id, or the word 'because'`,
      );
    }
    if (planMarkers.length === 0 && markers.length > 0) {
      notices.push(
        `${a.id}: plan-level rationale carries no machine-checkable marker; the citation is supplied by the composing document`,
      );
    }
    // C7 -- RESIDUAL-UNCOMPOSED
    if (residual !== null && !residual.includes(a.id)) {
      problems.push(
        `RESIDUAL-UNCOMPOSED: ${a.id} is an accept that never appears in '## Residual Composition' -- an accepted residual may not be listed once and never revisited`,
      );
    }
  }
  if (thinAtPlanLevel > 0) {
    notices.push(
      `${thinAtPlanLevel} of ${accepts.length} accept rows carry no D-NN / path:line / T-id / 'because' marker in the PLAN's own rationale`,
    );
  }

  // C8 -- CLOSED-OVER-ACCEPT
  const acceptIds = new Set(accepts.map((a) => a.id));
  for (const row of register.rows) {
    if (row.status !== 'CLOSED') continue;
    const ids = row.sources.match(idRe) ?? [];
    const over = ids.filter((i) => acceptIds.has(i));
    if (over.length > 0) {
      problems.push(
        `CLOSED-OVER-ACCEPT: register row '${row.threat}' is CLOSED while its sources include the accepted residual(s) ${over.join(', ')}`,
      );
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    notices,
    counts: {
      threats: corpus.threats.length,
      countable: countable.length,
      plans: corpus.plans.length,
      transfers,
      accepts: accepts.length,
      registerRows: register.rows.length,
    },
  };
}

// ---------------------------------------------------------------------------
// phase-dir plumbing
// ---------------------------------------------------------------------------

function phaseInfo(phaseDirArg) {
  if (!phaseDirArg) {
    fail(
      'a phase directory is required, e.g. `yarn verify:security-controls .planning/phases/NN-name`\n' +
        'usage: verify-security-controls.mjs <controls|reconcile|explain|all> <phase-dir> | selftest',
    );
  }
  const phaseDirRel = phaseDirArg;
  const phaseDirAbs = path.resolve(REPO_ROOT, phaseDirRel);
  const base = path.basename(phaseDirAbs);
  const m = /^(\d{2})-/.exec(base);
  if (!m) fail(`phase directory '${phaseDirRel}' does not begin with a two-digit phase number`);
  const phaseNum = m[1];
  return {
    phaseDirRel,
    phaseDirAbs,
    phaseNum,
    docPath: path.join(phaseDirAbs, `${phaseNum}-SECURITY.md`),
  };
}

// ---------------------------------------------------------------------------
// subcommands
// ---------------------------------------------------------------------------

function runControls(phaseDirArg, { quiet = false } = {}) {
  const info = phaseInfo(phaseDirArg);
  const docText = readFileSafe(info.docPath);
  if (docText === null) {
    if (!quiet) {
      process.stdout.write(
        `SKIPPED: ${path.relative(REPO_ROOT, info.docPath)} does not exist -- nothing to verify (this is not a pass)\n`,
      );
    }
    return { outcome: 'skipped' };
  }
  const ctx = makeGraphContext(REPO_ROOT);
  const result = evaluateControls(docText, ctx);
  printNotices(result.notices);
  if (!result.ok) {
    for (const p of result.problems) process.stdout.write(p + '\n');
    process.stdout.write(`CONTROLS-CHECK-FAILED rows=${result.rows.length} problems=${result.problems.length}\n`);
    return { outcome: 'failed', result };
  }
  process.stdout.write(
    `CONTROLS-CHECK-OK rows=${result.rows.length} unresolved-relative=${result.unresolvedRelative}\n`,
  );
  return { outcome: 'ok', result };
}

function runReconcile(phaseDirArg, { quiet = false } = {}) {
  const info = phaseInfo(phaseDirArg);
  const docText = readFileSafe(info.docPath);
  if (docText === null) {
    if (!quiet) {
      process.stdout.write(
        `SKIPPED: ${path.relative(REPO_ROOT, info.docPath)} does not exist -- nothing to reconcile (this is not a pass)\n`,
      );
    }
    return { outcome: 'skipped' };
  }
  const corpus = collectPlanThreats(info.phaseDirAbs, info.phaseNum);
  const result = evaluateReconcile(docText, corpus, { phaseNum: info.phaseNum });
  printNotices(result.notices);
  if (!result.ok) {
    for (const p of result.problems) process.stdout.write(p + '\n');
    process.stdout.write(`RECONCILE-CHECK-FAILED problems=${result.problems.length}\n`);
    return { outcome: 'failed', result };
  }
  const c = result.counts;
  process.stdout.write(
    `RECONCILE-CHECK-OK threats=${c.threats} plans=${c.plans} transfers=${c.transfers} accepts=${c.accepts}\n`,
  );
  return { outcome: 'ok', result };
}

function runExplain(phaseDirArg) {
  const info = phaseInfo(phaseDirArg);
  process.stdout.write('EXPLAIN-ONLY: this subcommand computes and reports; it is NOT a verdict and always exits 2.\n');
  const corpus = collectPlanThreats(info.phaseDirAbs, info.phaseNum);
  process.stdout.write(
    `corpus: plans=${corpus.plans.length} threats=${corpus.threats.length} (non-supply-chain=${corpus.threats.filter((t) => !t.isSupplyChain).length})\n`,
  );
  // Per-file, by name, with each file's own extracted row count. The totals
  // line above cannot distinguish "collected and parsed" from "collected and
  // silently contributing zero rows" -- which is exactly the half-fix shape
  // PLAN_SEG's comment describes. This line makes that distinguishable
  // without importing anything, and it is EXPLAIN-ONLY output: no verdict,
  // no problem code, no floor reads it.
  for (const f of corpus.plans) {
    const n = corpus.threats.filter((t) => t.planFile === f).length;
    process.stdout.write(`  plan-file: ${f} rows=${n}\n`);
  }
  for (const p of corpus.problems) process.stdout.write(`  corpus-problem: ${p}\n`);

  const docText = readFileSafe(info.docPath);
  if (docText === null) {
    process.stdout.write(
      `SKIPPED: ${path.relative(REPO_ROOT, info.docPath)} does not exist -- no Control Registry to explain\n`,
    );
    process.exit(2);
  }
  const ctx = makeGraphContext(REPO_ROOT);
  const parsed = parseRegistry(docText);
  for (const p of parsed.problems) process.stdout.write(`  registry-problem: ${p}\n`);
  for (const row of parsed.rows) {
    const definitionAbs = path.resolve(REPO_ROOT, row.definitionFile);
    if (!existsSync(definitionAbs)) {
      process.stdout.write(`${row.id} ${row.anchor}: MISSING-FILE ${row.definitionFile}\n`);
      continue;
    }
    const lines = (readFileSafe(definitionAbs) ?? '').split('\n');
    const re = anchorRegExp(row.anchor);
    const hits = [];
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) hits.push(i + 1);
    const atCited = hits.includes(row.definitionLine);
    let nearest = -1;
    for (const h of hits) {
      if (nearest === -1 || Math.abs(h - row.definitionLine) < Math.abs(nearest - row.definitionLine)) nearest = h;
    }
    const reach = computeReach(definitionAbs, row.anchor, row.entryPoint, ctx);
    process.stdout.write(
      `${row.id} ${row.anchor}: computed-reach=${reach.token} cited=${row.definitionLine} at-cited-line=${atCited ? 'yes' : 'NO'} nearest=${nearest} occurrences=${hits.length} entry=${row.entryPoint}\n`,
    );
    if (reach.token === 'file-only') {
      process.stdout.write(
        `    referenced by: ${reach.referencedBy.length ? reach.referencedBy.join(', ') : '(nothing)'}\n`,
      );
    }
  }
  for (const n of ctx.notices) process.stdout.write(`NOTICE: ${n}\n`);
  process.exit(2);
}

function runAll(phaseDirArg) {
  const a = runControls(phaseDirArg);
  // The second runs even when the first fails, so one command reports the
  // whole picture rather than the first thing that broke.
  const b = runReconcile(phaseDirArg);
  if (a.outcome === 'failed' || b.outcome === 'failed') process.exit(1);
  if (a.outcome === 'skipped' || b.outcome === 'skipped') process.exit(3);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 1j / 2h. selftest -- the inertness control
// ---------------------------------------------------------------------------

function writeFixture(root, rel, content) {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

function registryDoc(rows, { header = REGISTRY_HEADER } = {}) {
  const lines = [
    '# fixture',
    '',
    '## Control Registry',
    '',
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
  ];
  for (const r of rows) lines.push(`| ${r.join(' | ')} |`);
  lines.push('');
  return lines.join('\n');
}

function fixtureRoot(tmp, name) {
  const root = path.join(tmp, name);
  mkdirSync(root, { recursive: true });
  writeFixture(root, 'package.json', JSON.stringify({ name: 'fixture-root', workspaces: { packages: ['packages/*'] } }));
  return root;
}

function planDoc(threatRows) {
  return [
    '---',
    'phase: 90-fixture',
    '---',
    '',
    '<objective>prose that mentions T-90-99-99 outside any register</objective>',
    '',
    '<threat_model>',
    '',
    '| Threat ID | Category | Component | Disposition | Mitigation Plan |',
    '|---|---|---|---|---|',
    ...threatRows.map((r) => `| ${r.join(' | ')} |`),
    '',
    '</threat_model>',
    '',
  ].join('\n');
}

function securityDoc({ registerRows, residualBody, registerHeader = REGISTER_HEADER }) {
  return [
    '# fixture security',
    '',
    '## Control Registry',
    '',
    `| ${REGISTRY_HEADER.join(' | ')} |`,
    `|${REGISTRY_HEADER.map(() => '---').join('|')}|`,
    '',
    '## Reconciled Register',
    '',
    `| ${registerHeader.join(' | ')} |`,
    `|${registerHeader.map(() => '---').join('|')}|`,
    ...registerRows.map((r) => `| ${r.join(' | ')} |`),
    '',
    '## Residual Composition',
    '',
    residualBody,
    '',
    '## End',
    '',
  ].join('\n');
}

function runSelftest() {
  const tmp = mkdtempSync(path.join(tmpdir(), 'verify-security-controls-selftest-'));
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
      failures.push(`${name}: expected ${expectOk ? 'PASS' : 'REJECT'} but got ${result.ok ? 'PASS' : 'REJECT'}${detail}`);
    }
    return result;
  }

  function expectToken(name, result, token) {
    total++;
    negativeTotal++;
    const hit = (result.problems ?? []).some((p) => p.startsWith(token));
    if (hit) negativeRejected++;
    else failures.push(`${name}: expected a problem beginning '${token}', got: ${(result.problems ?? []).join('; ') || '(none)'}`);
  }

  function expectMentions(name, result, needles) {
    total++;
    const blob = (result.problems ?? []).join(' | ');
    const missing = needles.filter((n) => !blob.includes(n));
    if (missing.length > 0) failures.push(`${name}: message missing ${missing.join(', ')} -- got: ${blob}`);
  }

  try {
    // -----------------------------------------------------------------
    // controls fixtures
    // -----------------------------------------------------------------

    // 1. healthy -- anchor at the cited line, def file imported by the entry,
    //    anchor called from a second reachable non-test file.
    {
      const root = fixtureRoot(tmp, 'c1');
      writeFixture(root, 'src/guard.ts', "// header\nexport function assertThing() {\n  return true\n}\n");
      writeFixture(root, 'src/use.ts', "import { assertThing } from './guard.js'\nexport const x = assertThing()\n");
      writeFixture(root, 'entry.js', "import './src/use.js'\n");
      const doc = registryDoc([['C-90-01', '`assertThing`', '`src/guard.ts:2`', '`entry.js`', 'yes', 'T-90-01-01', 'CLOSED']]);
      check('1 healthy control', true, evaluateControls(doc, makeGraphContext(root)));
    }

    // 2. anchor referenced ONLY from a __tests__/ file in the reachable set.
    //    This is the Phase 51 shape, mechanised.
    {
      const root = fixtureRoot(tmp, 'c2');
      writeFixture(root, 'src/guard.ts', "// header\nexport function assertThing() {\n  return true\n}\n");
      writeFixture(root, 'src/__tests__/guard.spec.ts', "import { assertThing } from '../guard.js'\nassertThing()\n");
      writeFixture(root, 'entry.js', "import './src/guard.js'\nimport './src/__tests__/guard.spec.js'\n");
      const doc = registryDoc([['C-90-01', '`assertThing`', '`src/guard.ts:2`', '`entry.js`', 'file-only', 'T-90-01-01', 'MITIGATED']]);
      const r = check('2 anchor referenced only by tests', false, evaluateControls(doc, makeGraphContext(root)));
      expectToken('2 token', r, 'UNREACHED-SYMBOL');
    }

    // 3. definition file present on disk but imported by nothing.
    {
      const root = fixtureRoot(tmp, 'c3');
      writeFixture(root, 'src/orphan.ts', "// header\nexport function orphanThing() {}\n");
      writeFixture(root, 'entry.js', "console.log('nothing imported')\n");
      const doc = registryDoc([['C-90-01', '`orphanThing`', '`src/orphan.ts:2`', '`entry.js`', 'no', 'T-90-01-01', 'PARTIAL']]);
      const r = check('3 unreachable file', false, evaluateControls(doc, makeGraphContext(root)));
      expectToken('3 token', r, 'UNREACHABLE-FILE');
    }

    // 4. anchor present but well beyond the tolerance window.
    {
      const root = fixtureRoot(tmp, 'c4');
      writeFixture(root, 'src/guard.ts', '\n'.repeat(11) + 'export function assertThing() {}\n');
      writeFixture(root, 'src/use.ts', "import { assertThing } from './guard.js'\nexport const x = assertThing\n");
      writeFixture(root, 'entry.js', "import './src/use.js'\n");
      const doc = registryDoc([['C-90-01', '`assertThing`', '`src/guard.ts:2`', '`entry.js`', 'yes', 'T-90-01-01', 'CLOSED']]);
      const r = check('4 line drift', false, evaluateControls(doc, makeGraphContext(root)));
      expectToken('4 token', r, 'LINE-DRIFT');
      expectMentions('4 names the true line', r, ['line 12']);
    }

    // 5. anchor absent from the file entirely.
    {
      const root = fixtureRoot(tmp, 'c5');
      writeFixture(root, 'src/guard.ts', '// nothing named that here\nexport const other = 1\n');
      writeFixture(root, 'entry.js', "import './src/guard.js'\n");
      const doc = registryDoc([['C-90-01', '`assertThing`', '`src/guard.ts:2`', '`entry.js`', 'yes', 'T-90-01-01', 'CLOSED']]);
      const r = check('5 anchor missing', false, evaluateControls(doc, makeGraphContext(root)));
      expectToken('5 token', r, 'ANCHOR-MISSING');
    }

    // 6. cited file absent.
    {
      const root = fixtureRoot(tmp, 'c6');
      writeFixture(root, 'entry.js', "console.log(1)\n");
      const doc = registryDoc([['C-90-01', '`assertThing`', '`src/gone.ts:2`', '`entry.js`', 'no', 'T-90-01-01', 'PARTIAL']]);
      const r = check('6 missing file', false, evaluateControls(doc, makeGraphContext(root)));
      expectToken('6 token', r, 'MISSING-FILE');
      expectMentions('6 names the path', r, ['src/gone.ts']);
    }

    // 7. Reached cell says yes, computed is file-only.
    {
      const root = fixtureRoot(tmp, 'c7');
      writeFixture(root, 'src/guard.ts', '// header\nexport function assertThing() {}\n');
      writeFixture(root, 'entry.js', "import './src/guard.js'\n");
      const doc = registryDoc([['C-90-01', '`assertThing`', '`src/guard.ts:2`', '`entry.js`', 'yes', 'T-90-01-01', 'MITIGATED']]);
      const r = check('7 reached mismatch', false, evaluateControls(doc, makeGraphContext(root)));
      expectToken('7 token', r, 'REACHED-MISMATCH');
      expectMentions('7 names both tokens', r, ["'yes'", "'file-only'"]);
    }

    // 8. CLOSED with computed reach file-only.
    {
      const root = fixtureRoot(tmp, 'c8');
      writeFixture(root, 'src/guard.ts', '// header\nexport function assertThing() {}\n');
      writeFixture(root, 'entry.js', "import './src/guard.js'\n");
      const doc = registryDoc([['C-90-01', '`assertThing`', '`src/guard.ts:2`', '`entry.js`', 'file-only', 'T-90-01-01', 'CLOSED']]);
      const r = check('8 closed without reach', false, evaluateControls(doc, makeGraphContext(root)));
      expectToken('8 token', r, 'CLOSED-WITHOUT-REACH');
    }

    // 9. CLOSED with Threats: none.
    {
      const root = fixtureRoot(tmp, 'c9');
      writeFixture(root, 'src/guard.ts', '// header\nexport function assertThing() {}\n');
      writeFixture(root, 'src/use.ts', "import { assertThing } from './guard.js'\nexport const x = assertThing\n");
      writeFixture(root, 'entry.js', "import './src/use.js'\n");
      const doc = registryDoc([['C-90-01', '`assertThing`', '`src/guard.ts:2`', '`entry.js`', 'yes', 'none', 'CLOSED']]);
      const r = check('9 closed with no threats', false, evaluateControls(doc, makeGraphContext(root)));
      expectToken('9 token', r, 'CLOSED-WITHOUT-REACH');
    }

    // 10. `## Control Registry` present, zero data rows.
    {
      const root = fixtureRoot(tmp, 'c10');
      writeFixture(root, 'entry.js', 'console.log(1)\n');
      const doc = registryDoc([]);
      const r = check('10 empty registry', false, evaluateControls(doc, makeGraphContext(root)));
      expectToken('10 token', r, 'EMPTY-REGISTRY');
    }

    // 11. header row renamed.
    {
      const root = fixtureRoot(tmp, 'c11');
      writeFixture(root, 'entry.js', 'console.log(1)\n');
      const doc = registryDoc([['C-90-01', '`a`', '`b:1`', '`entry.js`', 'yes', 'T-90-01-01', 'CLOSED']], {
        header: ['Control', 'Anchor', 'Definition', 'Entry point', 'Reached', 'Threats', 'Verdict'],
      });
      const r = check('11 bad registry header', false, evaluateControls(doc, makeGraphContext(root)));
      expectToken('11 token', r, 'BAD-REGISTRY-HEADER');
    }

    // 12. TypeScript-ESM resolution: a.ts imports './b.js', only b.ts exists.
    {
      const root = fixtureRoot(tmp, 'c12');
      writeFixture(root, 'src/b.ts', '// header\nexport function tsEsmThing() {}\n');
      writeFixture(root, 'src/a.ts', "import { tsEsmThing } from './b.js'\nexport const y = tsEsmThing\n");
      writeFixture(root, 'entry.js', "import './src/a.js'\n");
      const doc = registryDoc([['C-90-01', '`tsEsmThing`', '`src/b.ts:2`', '`entry.js`', 'yes', 'T-90-01-01', 'CLOSED']]);
      check('12 ts-esm .js -> .ts resolution', true, evaluateControls(doc, makeGraphContext(root)));
    }

    // 12b. word-boundary anchor match: `putRecord` must NOT be considered
    //      reached by a file that only mentions `putRecordLegacy`. A bare
    //      `includes` would pass this row and hide an unreached control.
    {
      const root = fixtureRoot(tmp, 'c12b');
      writeFixture(root, 'src/store.ts', '// header\nexport function putRecord() {}\n');
      writeFixture(root, 'src/other.ts', "import './store.js'\nexport function putRecordLegacy() {}\n");
      writeFixture(root, 'entry.js', "import './src/other.js'\n");
      const doc = registryDoc([['C-90-01', '`putRecord`', '`src/store.ts:2`', '`entry.js`', 'file-only', 'T-90-01-01', 'MITIGATED']]);
      const r = check('12b prefix is not a reach', false, evaluateControls(doc, makeGraphContext(root)));
      expectToken('12b token', r, 'UNREACHED-SYMBOL');
    }

    // 12c. the two `n/a (...)` entry-point literals force PARTIAL at most.
    {
      const root = fixtureRoot(tmp, 'c12c');
      writeFixture(root, 'docs/OPERATOR.md', 'x\n');
      writeFixture(root, 'src/guard.ts', '// header\nexport function assertThing() {}\n');
      const okDoc = registryDoc([['C-90-01', '`assertThing`', '`src/guard.ts:2`', 'n/a (doc)', 'n/a', 'T-90-01-01', 'PARTIAL']]);
      check('12c n/a entry point at PARTIAL', true, evaluateControls(okDoc, makeGraphContext(root)));
      const badDoc = registryDoc([['C-90-01', '`assertThing`', '`src/guard.ts:2`', 'n/a (doc)', 'n/a', 'T-90-01-01', 'CLOSED']]);
      const r = check('12c n/a entry point at CLOSED', false, evaluateControls(badDoc, makeGraphContext(root)));
      expectToken('12c token', r, 'NA-ENTRY-VERDICT');
    }

    // 12d. `internal`: nothing outside the module references the anchor, but
    //      the module itself CALLS it. Declared honestly, this passes.
    {
      const root = fixtureRoot(tmp, 'c12d');
      writeFixture(
        root,
        'src/mod.ts',
        '// header\nexport function innerGuard() {}\nexport const outer = () => innerGuard()\n',
      );
      writeFixture(root, 'src/use.ts', "import { outer } from './mod.js'\nexport const x = outer\n");
      writeFixture(root, 'entry.js', "import './src/use.js'\n");
      const ok = registryDoc([['C-90-01', '`innerGuard`', '`src/mod.ts:2`', '`entry.js`', 'internal', 'T-90-01-01', 'MITIGATED']]);
      check('12d internal helper declared internal', true, evaluateControls(ok, makeGraphContext(root)));
      const closed = registryDoc([['C-90-01', '`innerGuard`', '`src/mod.ts:2`', '`entry.js`', 'internal', 'T-90-01-01', 'CLOSED']]);
      const r1 = check('12d internal helper claimed CLOSED', false, evaluateControls(closed, makeGraphContext(root)));
      expectToken('12d closed token', r1, 'CLOSED-WITHOUT-REACH');
      const lied = registryDoc([['C-90-01', '`innerGuard`', '`src/mod.ts:2`', '`entry.js`', 'yes', 'T-90-01-01', 'MITIGATED']]);
      const r2 = check('12d internal helper claimed yes', false, evaluateControls(lied, makeGraphContext(root)));
      expectToken('12d mismatch token', r2, 'REACHED-MISMATCH');
    }

    // 12e. THE CASE THAT KEEPS `internal` HONEST. The anchor is named four more
    //      times inside its own module -- in a JSDoc `{@link}` and in the text
    //      of two `throw new Error(...)` calls -- and never called. A naive
    //      occurrence count would call this `internal` and let it pass. It must
    //      still be `file-only`, and still a hard failure. This is the exact
    //      shape of `stageForFilesystemBinding` in the live tree.
    {
      const root = fixtureRoot(tmp, 'c12e');
      writeFixture(
        root,
        'src/mod.ts',
        [
          '/** See {@link neverCalled} for the staging shape. */',
          'export function neverCalled() {',
          "  if (a) throw new Error('neverCalled called twice')",
          "  if (b) throw new Error('neverCalled requires the in-memory result')",
          '}',
          '// neverCalled is described here and nowhere invoked',
          'export const outer = () => 1',
        ].join('\n'),
      );
      writeFixture(root, 'src/use.ts', "import { outer } from './mod.js'\nexport const x = outer\n");
      writeFixture(root, 'entry.js', "import './src/use.js'\n");
      const doc = registryDoc([['C-90-01', '`neverCalled`', '`src/mod.ts:2`', '`entry.js`', 'internal', 'T-90-01-01', 'MITIGATED']]);
      const r = check('12e comments and strings are not call sites', false, evaluateControls(doc, makeGraphContext(root)));
      expectToken('12e token', r, 'UNREACHED-SYMBOL');
    }

    // -----------------------------------------------------------------
    // 13 / 14. LIVE fixtures read the real tree. If either file is missing the
    // selftest FAILS with LIVE-FIXTURE-MISSING -- it never skips. A silently
    // skipped live control is the exact failure mode this file exists to stop.
    // -----------------------------------------------------------------

    const liveEntry = 'apps/VoteTorrentAuthority/index.js';
    const liveVerifier = 'packages/vote-engine/src/association/app-attest-verifier.ts';
    const liveTestSeam = 'apps/VoteTorrentAuthority/src/engines/key-vault.ts';

    // 13. LIVE TRUE POSITIVE. `AppAttestVerifier` is the exact control Phase 51
    //     recorded CLOSED while nothing in the app could reach it; the wiring
    //     commit `e64e112` injected it via engine-factory.ts. If this case ever
    //     goes red, the wiring regressed -- that is a FINDING, not a fixture bug.
    {
      total++;
      const missing = [liveEntry, liveVerifier].filter((p) => !existsSync(path.join(REPO_ROOT, p)));
      if (missing.length > 0) {
        failures.push(`13 live true positive: LIVE-FIXTURE-MISSING ${missing.join(', ')}`);
      } else {
        const lines = readFileSync(path.join(REPO_ROOT, liveVerifier), 'utf8').split('\n');
        const anchorLine = lines.findIndex((l) => /(?<![A-Za-z0-9_$])AppAttestVerifier(?![A-Za-z0-9_$])/.test(l)) + 1;
        const ctx = makeGraphContext(REPO_ROOT);
        const reach = computeReach(path.join(REPO_ROOT, liveVerifier), 'AppAttestVerifier', liveEntry, ctx);
        if (reach.token !== 'yes') {
          failures.push(
            `13 live true positive: expected computed reach 'yes' for AppAttestVerifier from ${liveEntry}, got '${reach.token}' (anchor at line ${anchorLine}). The Phase 51 wiring may have regressed.`,
          );
        }
      }
    }

    // 14. LIVE TRUE NEGATIVE. `setAuthorityKeyVaultForTests` is a test-only
    //     seam: key-vault.ts exports it for jest, and no production file calls
    //     it. This case mechanises "has no non-test caller" on a live file.
    {
      total++;
      negativeTotal++;
      const missing = [liveEntry, liveTestSeam].filter((p) => !existsSync(path.join(REPO_ROOT, p)));
      if (missing.length > 0) {
        failures.push(`14 live true negative: LIVE-FIXTURE-MISSING ${missing.join(', ')}`);
      } else {
        const ctx = makeGraphContext(REPO_ROOT);
        const reach = computeReach(path.join(REPO_ROOT, liveTestSeam), 'setAuthorityKeyVaultForTests', liveEntry, ctx);
        // This file names the anchor in its own live fixture. A checker naming a
        // symbol is not a caller of it, so exclude only this exact path -- never
        // `scripts/` wholesale, because a build script that calls a control IS a
        // caller and must keep showing up in the referencing list.
        const selfPath = path.relative(REPO_ROOT, fileURLToPath(import.meta.url));
        const nonTest = reach.referencedBy.filter((p) => !isTestPath(p) && p !== selfPath);
        if (reach.token === 'file-only' && nonTest.length === 0) {
          negativeRejected++;
        } else {
          failures.push(
            `14 live true negative: expected 'file-only' with only test referrers, got '${reach.token}' with non-test referrers [${nonTest.join(', ')}]. If it gained a production caller, replace this case.`,
          );
        }
      }
    }

    // -----------------------------------------------------------------
    // reconcile fixtures
    // -----------------------------------------------------------------

    const RECON_OPTS = { phaseNum: '90', threatFloor: 1 };

    function reconFixture(name, plans, doc) {
      const dir = path.join(tmp, name);
      mkdirSync(dir, { recursive: true });
      for (const [file, content] of Object.entries(plans)) writeFixture(dir, file, content);
      const corpus = collectPlanThreats(dir, '90');
      return { corpus, doc, dir };
    }

    const goodAcceptRationale =
      'Accepted because the alternative costs more than the residual: see D-08 and packages/x/src/y.ts:42 for the ordering this rests on.';

    // 15. healthy: two plans, four threats, one owned transfer, one
    //     well-rationalised accept that appears in the residual section.
    {
      const plans = {
        '90-01-PLAN.md': planDoc([
          ['T-90-01-01', 'Tampering', 'thing', 'mitigate', 'Handled here; also owns the condition 90-02 raises and names T-90-02-01 explicitly.'],
          ['T-90-01-02', 'Spoofing', 'other', 'accept', goodAcceptRationale],
        ]),
        '90-02-PLAN.md': planDoc([
          ['T-90-02-01', 'Tampering', 'thing', 'mitigate (upstream control)', 'The control is on the write side and already exists in `90-01`.'],
          ['T-90-02-02', 'Repudiation', 'log', 'mitigate', 'Local.'],
        ]),
      };
      const doc = securityDoc({
        registerRows: [
          ['R1', 'Tampering', 'thing', 'mitigate', 'T-90-01-01, T-90-02-01', 'MITIGATED', 'x'],
          ['R2', 'Spoofing', 'other', 'accept', 'T-90-01-02', 'PARTIAL', 'x'],
          ['R3', 'Repudiation', 'log', 'mitigate', 'T-90-02-02', 'MITIGATED', 'x'],
        ],
        residualBody: 'T-90-01-02 stacks with nothing; on its own it is bounded.',
      });
      const f = reconFixture('r15', plans, doc);
      check('15 healthy reconcile', true, evaluateReconcile(f.doc, f.corpus, RECON_OPTS));
    }

    // 16. a plan threat id absent from the register.
    {
      const plans = {
        '90-01-PLAN.md': planDoc([
          ['T-90-01-01', 'Tampering', 'thing', 'mitigate', 'Local.'],
          ['T-90-01-02', 'Spoofing', 'other', 'mitigate', 'Local.'],
        ]),
      };
      const doc = securityDoc({
        registerRows: [['R1', 'Tampering', 'thing', 'mitigate', 'T-90-01-01', 'MITIGATED', 'x']],
        residualBody: 'nothing accepted.',
      });
      const f = reconFixture('r16', plans, doc);
      const r = check('16 dropped threat', false, evaluateReconcile(f.doc, f.corpus, RECON_OPTS));
      expectToken('16 token', r, 'DROPPED-THREAT');
      expectMentions('16 names the id', r, ['T-90-01-02']);
    }

    // 17. one id in two Source threats cells.
    {
      const plans = {
        '90-01-PLAN.md': planDoc([['T-90-01-01', 'Tampering', 'thing', 'mitigate', 'Local.']]),
      };
      const doc = securityDoc({
        registerRows: [
          ['R1', 'Tampering', 'thing', 'mitigate', 'T-90-01-01', 'MITIGATED', 'x'],
          ['R2', 'Tampering', 'thing2', 'mitigate', 'T-90-01-01', 'MITIGATED', 'x'],
        ],
        residualBody: 'nothing accepted.',
      });
      const f = reconFixture('r17', plans, doc);
      const r = check('17 duplicate claim', false, evaluateReconcile(f.doc, f.corpus, RECON_OPTS));
      expectToken('17 token', r, 'DUPLICATE-CLAIM');
    }

    // 18. A -> B and B -> A. Named for the real pair that formed once:
    //     T-52-08-12 / T-52-10-06 over orphaned ciphertext. Both sides use the
    //     qualified `mitigate (upstream control)` shape that pair uses today,
    //     so the case proves 2b's normalisation is what makes the cycle visible.
    {
      const plans = {
        '90-01-PLAN.md': planDoc([
          ['T-90-01-01', 'Information Disclosure', 'orphan blob', 'mitigate (upstream control)', 'The control is on the other side: see T-90-02-01 in `90-02`.'],
        ]),
        '90-02-PLAN.md': planDoc([
          ['T-90-02-01', 'Information Disclosure', 'orphan blob', 'mitigate (upstream control)', 'The control is on the other side: see T-90-01-01 in `90-01`.'],
        ]),
      };
      const doc = securityDoc({
        registerRows: [['R1', 'Information Disclosure', 'orphan blob', 'transfer', 'T-90-01-01, T-90-02-01', 'PARTIAL', 'x']],
        residualBody: 'nothing accepted.',
      });
      const f = reconFixture('r18', plans, doc);
      const r = check('18 circular transfer', false, evaluateReconcile(f.doc, f.corpus, RECON_OPTS));
      expectToken('18 token', r, 'CIRCULAR-TRANSFER');
      expectMentions('18 prints both ids in the path', r, ['T-90-01-01', 'T-90-02-01']);
    }

    // 19. a transfer naming a plan that does not exist.
    {
      const plans = {
        '90-01-PLAN.md': planDoc([
          ['T-90-01-01', 'Tampering', 'thing', 'mitigate (upstream control)', 'Owned by `90-99`, which handles it.'],
        ]),
      };
      const doc = securityDoc({
        registerRows: [['R1', 'Tampering', 'thing', 'transfer', 'T-90-01-01', 'PARTIAL', 'x']],
        residualBody: 'nothing accepted.',
      });
      const f = reconFixture('r19', plans, doc);
      const r = check('19 transfer to a nonexistent plan', false, evaluateReconcile(f.doc, f.corpus, RECON_OPTS));
      expectToken('19 token', r, 'TRANSFER-UNOWNED');
    }

    // 20. THE CASE THAT SEPARATES A REAL HANDOVER FROM A HOPEFUL ONE: the owner
    //     plan exists and mitigates something, but its register never names the
    //     transferring threat or its plan. Acceptance has to be written down on
    //     the owner's side; a transferrer's assertion is not a handover.
    {
      const plans = {
        '90-01-PLAN.md': planDoc([
          ['T-90-01-01', 'Tampering', 'thing', 'mitigate (upstream control)', 'Owned by `90-02`.'],
        ]),
        '90-02-PLAN.md': planDoc([
          ['T-90-02-01', 'Tampering', 'unrelated', 'mitigate', 'Something else entirely, naming nobody.'],
        ]),
      };
      const doc = securityDoc({
        registerRows: [
          ['R1', 'Tampering', 'thing', 'transfer', 'T-90-01-01', 'PARTIAL', 'x'],
          ['R2', 'Tampering', 'unrelated', 'mitigate', 'T-90-02-01', 'MITIGATED', 'x'],
        ],
        residualBody: 'nothing accepted.',
      });
      const f = reconFixture('r20', plans, doc);
      const r = check('20 owner never accepted it', false, evaluateReconcile(f.doc, f.corpus, RECON_OPTS));
      expectToken('20 token', r, 'TRANSFER-UNOWNED');
    }

    // 21. accept with a 20-character rationale.
    {
      const plans = {
        '90-01-PLAN.md': planDoc([['T-90-01-01', 'Tampering', 'thing', 'accept', 'too short to count']]),
      };
      const doc = securityDoc({
        registerRows: [['R1', 'Tampering', 'thing', 'accept', 'T-90-01-01', 'PARTIAL', 'x']],
        residualBody: 'T-90-01-01 is here.',
      });
      const f = reconFixture('r21', plans, doc);
      const r = check('21 accept with a short rationale', false, evaluateReconcile(f.doc, f.corpus, RECON_OPTS));
      expectToken('21 token', r, 'ACCEPT-NO-RATIONALE');
      expectMentions('21 names the observed length', r, ['18 characters']);
    }

    // 22. accept with a long rationale carrying none of the four markers --
    //     length alone is not rationale, and neither the register row nor the
    //     residual paragraph supplies a citation.
    {
      const filler = 'This is a long sentence about the residual that asserts a conclusion and cites nothing at all whatsoever, repeated for length. '.repeat(2);
      const plans = {
        '90-01-PLAN.md': planDoc([['T-90-01-01', 'Tampering', 'thing', 'accept', filler]]),
      };
      const doc = securityDoc({
        registerRows: [['R1', 'Tampering', 'thing', 'accept', 'T-90-01-01', 'PARTIAL', 'x']],
        residualBody: 'T-90-01-01 is listed here and nowhere argued.',
      });
      const f = reconFixture('r22', plans, doc);
      const r = check('22 accept with length but no citation', false, evaluateReconcile(f.doc, f.corpus, RECON_OPTS));
      expectToken('22 token', r, 'ACCEPT-NO-RATIONALE');
    }

    // 22b. positive control for 22: the SAME marker-less plan rationale, but the
    //      composing document supplies the citation in the residual section.
    {
      const filler = 'This is a long sentence about the residual that asserts a conclusion and cites nothing at all whatsoever, repeated for length. '.repeat(2);
      const plans = {
        '90-01-PLAN.md': planDoc([['T-90-01-01', 'Tampering', 'thing', 'accept', filler]]),
      };
      const doc = securityDoc({
        registerRows: [['R1', 'Tampering', 'thing', 'accept', 'T-90-01-01', 'PARTIAL', 'x']],
        residualBody: 'T-90-01-01 is tolerable because D-08 makes delivery at-most-once by design.',
      });
      const f = reconFixture('r22b', plans, doc);
      check('22b composing document supplies the citation', true, evaluateReconcile(f.doc, f.corpus, RECON_OPTS));
    }

    // 23. accept absent from the residual section.
    {
      const plans = {
        '90-01-PLAN.md': planDoc([['T-90-01-01', 'Tampering', 'thing', 'accept', goodAcceptRationale]]),
      };
      const doc = securityDoc({
        registerRows: [['R1', 'Tampering', 'thing', 'accept', 'T-90-01-01', 'PARTIAL', 'x']],
        residualBody: 'nothing about that id at all.',
      });
      const f = reconFixture('r23', plans, doc);
      const r = check('23 accept not composed', false, evaluateReconcile(f.doc, f.corpus, RECON_OPTS));
      expectToken('23 token', r, 'RESIDUAL-UNCOMPOSED');
    }

    // 24. register row CLOSED whose sources include an accept.
    {
      const plans = {
        '90-01-PLAN.md': planDoc([['T-90-01-01', 'Tampering', 'thing', 'accept', goodAcceptRationale]]),
      };
      const doc = securityDoc({
        registerRows: [['R1', 'Tampering', 'thing', 'accept', 'T-90-01-01', 'CLOSED', 'x']],
        residualBody: 'T-90-01-01 is analysed here because D-08 says so.',
      });
      const f = reconFixture('r24', plans, doc);
      const r = check('24 closed over an accept', false, evaluateReconcile(f.doc, f.corpus, RECON_OPTS));
      expectToken('24 token', r, 'CLOSED-OVER-ACCEPT');
    }

    // 25. empty plan glob.
    {
      const doc = securityDoc({ registerRows: [], residualBody: 'nothing.' });
      const f = reconFixture('r25', {}, doc);
      const r = check('25 empty corpus', false, evaluateReconcile(f.doc, f.corpus, RECON_OPTS));
      expectToken('25 token', r, 'EMPTY-CORPUS');
    }

    // 26. the plan's PROSE outside the block mentions T-90-99-99, which no
    //     register declares. Slicing must not invent it.
    {
      const plans = {
        '90-01-PLAN.md': planDoc([['T-90-01-01', 'Tampering', 'thing', 'mitigate', 'Local.']]),
      };
      const doc = securityDoc({
        registerRows: [['R1', 'Tampering', 'thing', 'mitigate', 'T-90-01-01', 'MITIGATED', 'x']],
        residualBody: 'nothing accepted.',
      });
      const f = reconFixture('r26', plans, doc);
      check('26 prose outside the block is not a threat', true, evaluateReconcile(f.doc, f.corpus, RECON_OPTS));
      total++;
      if (f.corpus.threats.some((t) => t.id === 'T-90-99-99')) {
        failures.push('26: the phantom id T-90-99-99 from plan prose leaked into the collected set');
      }
    }

    // 26b. a register whose header was renamed.
    {
      const plans = {
        '90-01-PLAN.md': planDoc([['T-90-01-01', 'Tampering', 'thing', 'mitigate', 'Local.']]),
      };
      const doc = securityDoc({
        registerRows: [['R1', 'Tampering', 'thing', 'mitigate', 'T-90-01-01', 'MITIGATED', 'x']],
        residualBody: 'nothing accepted.',
        registerHeader: ['Threat', 'STRIDE', 'Component', 'Disposition', 'Sources', 'Status', 'Evidence'],
      });
      const f = reconFixture('r26b', plans, doc);
      const r = check('26b bad register header', false, evaluateReconcile(f.doc, f.corpus, RECON_OPTS));
      expectToken('26b token', r, 'BAD-REGISTER-HEADER');
    }

    // -----------------------------------------------------------------
    // 26c-26f. LETTERED PLAN SIBLINGS (PLAN_SEG).
    //
    // A plan too large for one executor's context budget is split into
    // lettered siblings, and the letter is part of the plan id at every site
    // that decomposes one. These four cases pin BOTH halves of that: the
    // lettered file is collected AND its rows are extracted. Asserting only
    // the first is the half-fix -- collected, counted, and every row silently
    // dropped -- which was reproduced deliberately against the live phase-54
    // corpus and reported plans=19 with the threat count unmoved.
    // -----------------------------------------------------------------

    // 26c. POSITIVE, both halves: a corpus holding a two-digit plan and a
    //      lettered sibling collects both files AND extracts the lettered
    //      file's rows, with `plan` carrying the letter so byPlan groups on
    //      the real id rather than collapsing 90-01a into 90-01.
    {
      total++;
      const plans = {
        '90-01-PLAN.md': planDoc([['T-90-01-01', 'Tampering', 'thing', 'mitigate', 'Local.']]),
        '90-01a-PLAN.md': planDoc([
          ['T-90-01a-01', 'Spoofing', 'lettered', 'mitigate', 'Local.'],
          ['T-90-01a-SC', 'Tampering', 'installs', 'mitigate', 'None introduced.'],
        ]),
      };
      const f = reconFixture('r26c', plans, securityDoc({ registerRows: [], residualBody: 'n/a' }));
      if (!f.corpus.plans.includes('90-01a-PLAN.md')) {
        failures.push(`26c: the lettered plan file was not collected (plans=${JSON.stringify(f.corpus.plans)})`);
      }
      if (!f.corpus.plans.includes('90-01-PLAN.md')) {
        failures.push('26c: widening the pattern lost the plain two-digit plan file');
      }
      // The assertion that would have caught the half-fix: the file being in
      // `plans` proves nothing about whether any row inside it was parsed.
      const lettered = f.corpus.threats.filter((t) => t.planFile === '90-01a-PLAN.md');
      if (lettered.length !== 2) {
        failures.push(`26c: expected 2 threat rows extracted from the lettered plan, got ${lettered.length}`);
      }
      if (!f.corpus.threats.some((t) => t.id === 'T-90-01a-01' && t.plan === '90-01a')) {
        failures.push(
          `26c: T-90-01a-01 was not extracted with plan '90-01a' (got ${JSON.stringify(f.corpus.threats.map((t) => [t.id, t.plan]))})`,
        );
      }
      if (!f.corpus.threats.some((t) => t.id === 'T-90-01a-SC' && t.isSupplyChain === true)) {
        failures.push('26c: the lettered supply-chain row was not recognised as supply-chain');
      }
      // Sort order, confirmed rather than assumed: the plain plan sorts before
      // its lettered sibling, and a later plan sorts after both.
      const ordered = collectPlanThreats(f.dir, '90').plans;
      if (ordered.join(',') !== '90-01-PLAN.md,90-01a-PLAN.md') {
        failures.push(`26c: unexpected collection order ${ordered.join(',')}`);
      }
    }

    // 26d. NEGATIVE, the pattern stays bounded: a two-letter suffix and an
    //      uppercase suffix are both rejected. "Widened" must not become
    //      "matches anything" -- without this, `\d{2}[a-z]*` or `\d{2}\w?`
    //      would pass 26c just as well and admit filenames nobody intended.
    {
      total++;
      negativeTotal++;
      const plans = {
        '90-01-PLAN.md': planDoc([['T-90-01-01', 'Tampering', 'thing', 'mitigate', 'Local.']]),
        '90-01ab-PLAN.md': planDoc([['T-90-01ab-01', 'Spoofing', 'two letters', 'mitigate', 'Local.']]),
        '90-01A-PLAN.md': planDoc([['T-90-01A-01', 'Spoofing', 'uppercase', 'mitigate', 'Local.']]),
        '90-1a-PLAN.md': planDoc([['T-90-1a-01', 'Spoofing', 'one digit', 'mitigate', 'Local.']]),
      };
      const f = reconFixture('r26d', plans, securityDoc({ registerRows: [], residualBody: 'n/a' }));
      const admitted = f.corpus.plans.filter((x) => x !== '90-01-PLAN.md');
      if (admitted.length !== 0) {
        failures.push(`26d: the bounded pattern admitted out-of-shape filenames ${JSON.stringify(admitted)}`);
      } else {
        negativeRejected++;
      }
    }

    // 26e. A TRANSFER whose rationale names the lettered plan id resolves,
    //      and raises no TRANSFER-UNOWNED. This is site 883 (`pRe`): its
    //      trailing word-boundary-then-not-a-hyphen guard was CHECKED, not
    //      assumed, to still behave with a letter present -- `90-01a` inside
    //      `T-90-01a-01` must not be extracted as a plan reference, and
    //      `90-01a` standing alone must be.
    {
      const plans = {
        '90-02-PLAN.md': planDoc([
          [
            'T-90-02-01',
            'Tampering',
            'thing',
            'mitigate (upstream control)',
            'The control is on the write side and already exists in `90-01a`.',
          ],
        ]),
        '90-01a-PLAN.md': planDoc([
          ['T-90-01a-01', 'Tampering', 'thing', 'mitigate', 'Owned here; this is the control 90-02 defers to.'],
        ]),
      };
      const doc = securityDoc({
        registerRows: [['R1', 'Tampering', 'thing', 'mitigate', 'T-90-01a-01, T-90-02-01', 'MITIGATED', 'x']],
        residualBody: 'nothing accepted.',
      });
      const f = reconFixture('r26e', plans, doc);
      const r = check('26e lettered transfer owner resolves', true, evaluateReconcile(f.doc, f.corpus, RECON_OPTS));
      if (String(r?.problems ?? []).includes('TRANSFER-UNOWNED')) {
        failures.push('26e: a transfer naming a lettered plan as its owner was reported unowned');
      }
      // Site 883 directly: the id form must NOT leak a plan reference.
      const refs = extractOwnerRefs('see T-90-01a-01 and also 90-01a itself', '90', 'T-90-02-01');
      if (!refs.planIds.includes('90-01a')) failures.push(`26e: extractOwnerRefs missed the bare lettered plan id (${JSON.stringify(refs)})`);
      if (!refs.threatIds.includes('T-90-01a-01')) failures.push(`26e: extractOwnerRefs missed the lettered threat id (${JSON.stringify(refs)})`);
      if (refs.planIds.length !== 1) failures.push(`26e: extractOwnerRefs over-extracted plan ids ${JSON.stringify(refs.planIds)}`);
    }

    // 26f. Site 985: an `accept` justified ONLY by a lettered threat id must
    //      carry the T-id rationale marker. Without this widening the row is
    //      reported as carrying no marker and fails ACCEPT-NO-RATIONALE.
    {
      total++;
      const markers = rationaleMarkers(
        'Accepted; the whole condition is already carried upstream by T-54-03a-05 and nothing here widens it.',
        'T-90-01-01',
      );
      if (!markers.includes('T-id')) {
        failures.push(`26f: a rationale citing a lettered threat id carried no T-id marker (got ${JSON.stringify(markers)})`);
      }
      const none = rationaleMarkers('Accepted; no citation of any kind appears in this sentence at all.', 'T-90-01-01');
      if (none.includes('T-id')) {
        failures.push('26f: the T-id marker fired on a rationale citing no threat id -- the probe does not discriminate');
      }
    }

    // 27. LIVE CORPUS. Guarded with existsSync; a missing phase directory FAILS
    //     with LIVE-FIXTURE-MISSING rather than skipping.
    {
      total++;
      const liveDir = path.join(REPO_ROOT, LIVE_CORPUS_PHASE_DIR);
      if (!existsSync(liveDir)) {
        failures.push(`27 live corpus: LIVE-FIXTURE-MISSING ${LIVE_CORPUS_PHASE_DIR}`);
      } else {
        const corpus = collectPlanThreats(liveDir, '52');
        const countable = corpus.threats.filter((t) => !t.isSupplyChain).length;
        if (countable < LIVE_THREAT_FLOOR || corpus.plans.length < LIVE_PLAN_FLOOR) {
          failures.push(
            `27 live corpus: expected >=${LIVE_THREAT_FLOOR} non-supply-chain threats over >=${LIVE_PLAN_FLOOR} plans, got ${countable} over ${corpus.plans.length}`,
          );
        }
        if (corpus.problems.length > 0) {
          failures.push(`27 live corpus: ${corpus.problems.join('; ')}`);
        }
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    process.stderr.write(
      `[verify-security-controls] checker is inert or regressed: ${failures[0]}\n` +
        failures.slice(1).map((f) => `  also: ${f}\n`).join(''),
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
  const [, , cmd, ...rest] = process.argv;
  let phaseDir;
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--phase-dir') {
      phaseDir = rest[++i];
    } else if (rest[i].startsWith('--phase-dir=')) {
      phaseDir = rest[i].slice('--phase-dir='.length);
    } else {
      positional.push(rest[i]);
    }
  }
  if (!phaseDir && positional.length > 0) phaseDir = positional[0];

  switch (cmd) {
    case 'controls': {
      const r = runControls(phaseDir);
      process.exit(r.outcome === 'ok' ? 0 : r.outcome === 'skipped' ? 3 : 1);
      break;
    }
    case 'reconcile': {
      const r = runReconcile(phaseDir);
      process.exit(r.outcome === 'ok' ? 0 : r.outcome === 'skipped' ? 3 : 1);
      break;
    }
    case 'explain':
      runExplain(phaseDir);
      break;
    case 'all':
      runAll(phaseDir);
      break;
    case 'selftest':
      runSelftest();
      break;
    default:
      fail(
        `unknown subcommand: ${cmd ?? '(none)'}\n` +
          'usage: verify-security-controls.mjs <controls|reconcile|explain|all|selftest> [phase-dir] [--phase-dir <dir>]',
      );
  }
}

main();
