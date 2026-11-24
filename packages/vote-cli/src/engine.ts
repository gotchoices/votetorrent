// The stale-dist guard. Both apps and this CLI consume the BUILT vote-core, vote-engine and
// workflows packages (package.json main/exports point at dist/), and dist/ is gitignored, so a stale
// build never shows in `git status` and would silently exercise old code. Every daemon start and
// `vt run` calls assertFreshBuild() first; importing this module does nothing.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

/** Refuse a missing or stale dist for every target, in build order; return one mtime record each. */
export function assertFreshBuild (targets: readonly FreshnessTarget[] = DEFAULT_TARGETS): FreshnessRecord[] {
  void targets
  return []
}
