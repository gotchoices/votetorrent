#!/usr/bin/env node
//
// scripts/lib/dist-freshness.mjs
//
// Purpose : a per-file stale-dist guard for TypeScript packages that ship `dist`.
//           The recorded trap (D-16, 2026-08-04): both apps and the vt CLI resolve
//           `@votetorrent/vote-engine` and `@votetorrent/workflows` through
//           package.json `main`/`exports`, which point at dist/, so Metro and
//           plain `node` bundle or load the BUILT package and never read src/.
//           dist/ is gitignored, so a stale build never shows in `git status`,
//           and an on-device or host run against it reports a VACUOUS PASS.
//           `check-dist-freshness.sh` compares vote-engine's schema export;
//           this module covers the whole tree of a package file by file:
//             missing  — a src/<rel>.ts with no dist/<rel>.js
//             stale    — a dist/<rel>.js older than its src/<rel>.ts, when no
//                        dist file at all was emitted after that src edit
//             leftover — a dist/<rel>.js whose src/<rel>.ts is gone (a deleted or
//                        renamed source is still being shipped)
//           The stale rule is the one `packages/vote-cli/src/engine.ts`
//           (`assertFreshBuild`) applies to its sentinels: a build that ran after
//           the src edit is proven by ANY dist file newer than that src, because
//           `tsc -b`/aegir re-emit only outputs whose content changed, so a
//           byte-stable module keeps an old mtime after a perfectly fresh build.
//           A per-file strict rule would read that as stale forever.
//
// Modes   : imported (`staleDistFiles(packageRoot)`), or a CLI:
//             node scripts/lib/dist-freshness.mjs <packageRoot> <label>
//           exit 0 = fresh or no dist present (SKIP), 1 = problems, 2 = usage.
//           The package root is the ONLY input. No env var and no flag redirects
//           the check, so a caller cannot point it at an empty tree.
//
// Provenance / scope: script and test tooling only, in the same sense
//           `scripts/lib/strip-comments.mjs` declares for itself. Never imported
//           by any package `src/`; never reaches a production bundle. Proven by
//           `scripts/lib/dist-freshness.test.mjs` (node:test, RED control on the
//           stale comparison) and used by `scripts/check-dist-freshness.sh` and
//           `packages/workflows/test/load-under-node.spec.ts`.
//
// Deps    : node builtins only.
//
// ---------------------------------------------------------------------------

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const toPosix = (p) => p.split(sep).join('/')

/** Recursively list files under `dir` whose names pass `keep`, as paths relative to `dir` (POSIX). */
function walk (dir, keep, base = dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(p, keep, base))
    else if (keep(entry.name)) out.push(toPosix(relative(base, p)))
  }
  return out
}

/** The newest mtime of any file under `dir` (0 when there is none). */
function newestMtimeMs (dir) {
  let max = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    max = Math.max(max, entry.isDirectory() ? newestMtimeMs(p) : statSync(p).mtimeMs)
  }
  return max
}

const isSrcTs = (name) => name.endsWith('.ts') && !name.endsWith('.d.ts')
const isDistJs = (name) => name.endsWith('.js')

/**
 * Compare `<packageRoot>/dist` with `<packageRoot>/src` file by file.
 *
 * @param {string} packageRoot
 * @returns {{ distPresent: boolean, problems: { kind: 'missing' | 'stale' | 'leftover', file: string }[] }}
 *   `file` is package-relative POSIX: `src/<rel>.ts` for missing/stale, `dist/<rel>.js` for leftover.
 *   Problems are sorted by `file`.
 * @throws {Error} when `<packageRoot>/src` does not exist (a usage error, never a pass)
 */
export function staleDistFiles (packageRoot) {
  const srcDir = join(packageRoot, 'src')
  const distDir = join(packageRoot, 'dist')
  if (!existsSync(srcDir)) throw new Error(`dist-freshness: no src directory at ${srcDir}`)
  if (!existsSync(distDir)) return { distPresent: false, problems: [] }

  const problems = []
  const srcFiles = walk(srcDir, isSrcTs)
  const expectedDist = new Set()
  const newestDistMs = newestMtimeMs(distDir)
  for (const rel of srcFiles) {
    const distRel = rel.replace(/\.ts$/, '.js')
    expectedDist.add(distRel)
    const distPath = join(distDir, distRel)
    if (!existsSync(distPath)) {
      problems.push({ kind: 'missing', file: `src/${rel}` })
      continue
    }
    const srcStat = statSync(join(srcDir, rel))
    const distStat = statSync(distPath)
    // Stale: this output predates its source AND no output at all was emitted after the edit.
    if (distStat.mtimeMs < srcStat.mtimeMs && newestDistMs < srcStat.mtimeMs) {
      problems.push({ kind: 'stale', file: `src/${rel}` })
    }
  }
  for (const rel of walk(distDir, isDistJs)) {
    if (!expectedDist.has(rel)) problems.push({ kind: 'leftover', file: `dist/${rel}` })
  }
  problems.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  return { distPresent: true, problems }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main (argv) {
  const [packageRoot, label] = argv
  if (!packageRoot || !label) {
    process.stderr.write('usage: node scripts/lib/dist-freshness.mjs <packageRoot> <label>\n')
    return 2
  }
  const shown = toPosix(relative(process.cwd(), packageRoot)) || '.'
  let result
  try {
    result = staleDistFiles(packageRoot)
  } catch (err) {
    process.stderr.write(`[dist-check] usage error: ${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }
  if (!result.distPresent) {
    process.stdout.write(`[dist-check] SKIP: no ${label} build present at ${shown}/dist — nothing stale can be served.\n`)
    return 0
  }
  if (result.problems.length > 0) {
    const lines = [`[dist-check] FAIL: ${label} dist disagrees with its src (${result.problems.length} files).`]
    for (const p of result.problems.slice(0, 20)) lines.push(`[dist-check]   ${p.kind} ${p.file}`)
    lines.push(`[dist-check] Rebuild with: yarn --cwd ${shown} clean && yarn --cwd ${shown} build`)
    process.stderr.write(lines.join('\n') + '\n')
    return 1
  }
  const srcCount = walk(join(packageRoot, 'src'), isSrcTs).length
  process.stdout.write(`[dist-check] OK: built ${label} dist matches its src (${srcCount} files)\n`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
