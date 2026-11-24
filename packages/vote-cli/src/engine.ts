// The stale-dist guard. Both apps and this CLI consume the BUILT vote-core, vote-engine and
// workflows packages (package.json main/exports point at dist/), and dist/ is gitignored, so a stale
// build never shows in `git status` and would silently exercise old code. Every daemon start and
// `vt run` calls assertFreshBuild() first; importing this module does nothing.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** `packages/`: two levels above this file, from src/engine.ts and from dist/engine.js alike. */
export const PACKAGES_DIR = fileURLToPath(new URL('../../', import.meta.url))

export interface FreshnessTarget {
  name: string
  srcDir: string
  distSentinel: string
}

export type StaleBuildCode = 'not-built' | 'stale' | 'src-missing'

export interface FreshnessRecord {
  name: string
  srcNewestMs: number
  distMtimeMs: number
}

const FIX = 'run yarn build in packages/vote-core, then packages/vote-engine, then packages/workflows'

export class StaleBuildError extends Error {
  readonly code: StaleBuildCode
  readonly target: string

  constructor (code: StaleBuildCode, target: string) {
    super(
      code === 'not-built'
        ? `${target} is not built: ${FIX}`
        : code === 'stale'
          ? `${target} dist is older than its src: ${FIX}`
          : `${target} src is missing`
    )
    this.name = 'StaleBuildError'
    this.code = code
    this.target = target
  }
}

/** The workflows entry the manifest's `exports["."].import` names (expected `./dist/index.js`). */
function workflowsSentinel (): string {
  const manifestPath = join(PACKAGES_DIR, 'workflows', 'package.json')
  let rel = './dist/index.js'
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      exports?: Record<string, { import?: string } | string>
    }
    const root = manifest.exports?.['.']
    const named = typeof root === 'string' ? root : root?.import
    if (typeof named === 'string' && named.length > 0) rel = named
  } catch {
    // no manifest yet: the default sentinel reads as not-built, which is the right answer
  }
  return join(PACKAGES_DIR, 'workflows', rel)
}

export const DEFAULT_TARGETS: readonly FreshnessTarget[] = Object.freeze([
  Object.freeze({
    name: 'vote-core',
    srcDir: join(PACKAGES_DIR, 'vote-core', 'src'),
    distSentinel: join(PACKAGES_DIR, 'vote-core', 'dist', 'src', 'index.js')
  }),
  Object.freeze({
    name: 'vote-engine',
    srcDir: join(PACKAGES_DIR, 'vote-engine', 'src'),
    distSentinel: join(PACKAGES_DIR, 'vote-engine', 'dist', 'rn-entry.js')
  }),
  Object.freeze({
    name: 'workflows',
    srcDir: join(PACKAGES_DIR, 'workflows', 'src'),
    distSentinel: workflowsSentinel()
  })
])

/** The newest mtime (ms) of any file below `dir`, recursively. */
function newest (dir: string): number {
  let max = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    max = Math.max(max, entry.isDirectory() ? newest(p) : statSync(p).mtimeMs)
  }
  return max
}

function mtimeOrNull (path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

/**
 * The `dist` directory the sentinel lives in (the nearest ancestor named `dist`, else the sentinel's
 * own directory). tsc and aegir re-emit only outputs whose content changed, so the sentinel's own
 * mtime can stay old after a real rebuild while a sibling output moved: the dist side of the
 * comparison is therefore the newest file anywhere under that directory, never the sentinel alone.
 */
function distRootOf (sentinel: string): string {
  let dir = dirname(sentinel)
  for (let cur = dir; ; cur = dirname(cur)) {
    if (basename(cur) === 'dist') return cur
    if (dirname(cur) === cur) return dir
  }
}

/**
 * Refuse a missing or stale dist for every target, in build order; return one mtime record each.
 * The sentinel is checked first, so a package that does not exist at all reads as `not-built`.
 */
export function assertFreshBuild (targets: readonly FreshnessTarget[] = DEFAULT_TARGETS): FreshnessRecord[] {
  const records: FreshnessRecord[] = []
  for (const target of targets) {
    const distMtimeMs = mtimeOrNull(target.distSentinel)
    if (distMtimeMs === null) throw new StaleBuildError('not-built', target.name)
    if (!existsSync(target.srcDir)) throw new StaleBuildError('src-missing', target.name)
    const srcNewestMs = newest(target.srcDir)
    const distNewestMs = Math.max(distMtimeMs, newest(distRootOf(target.distSentinel)))
    if (distNewestMs < srcNewestMs) throw new StaleBuildError('stale', target.name)
    records.push({ name: target.name, srcNewestMs, distMtimeMs: distNewestMs })
  }
  return records
}
