// The built vote-engine, loaded by file path. `rn-entry.js` is the entry both apps import
// (`@votetorrent/vote-engine/rn`); the two deep modules below are what the apps reach through their
// own factories (views-in-main for strand databases, the dev association seeder is NOT used).
//
// Run `yarn build` in packages/vote-core and packages/vote-engine first — the CLI checks that the
// build is not older than the engine source (see assertFreshBuild).

import { statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ENGINE_ROOT = fileURLToPath(new URL('../../../packages/vote-engine/', import.meta.url))

const newest = (dir) => {
  let max = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    max = Math.max(max, entry.isDirectory() ? newest(p) : statSync(p).mtimeMs)
  }
  return max
}

/** Refuse to run on a vote-engine build older than its source: dist/ is gitignored, so a stale
 * build never shows in `git status` and would silently exercise old engine code. */
export function assertFreshBuild () {
  const src = newest(join(ENGINE_ROOT, 'src'))
  let dist = 0
  try { dist = statSync(join(ENGINE_ROOT, 'dist', 'rn-entry.js')).mtimeMs } catch { dist = 0 }
  if (dist === 0) throw new Error('vote-engine is not built: run `yarn build` in packages/vote-core and packages/vote-engine')
  if (dist < src) throw new Error('vote-engine dist is older than its src: run `yarn build` in packages/vote-core and packages/vote-engine')
}

assertFreshBuild()

export const VE = await import(new URL('../../../packages/vote-engine/dist/rn-entry.js', import.meta.url).href)
// CreateElectionScreen imports the builder from the package root, not from /rn.
export const { ElectionsCreateElectionBuilder } = await import(new URL('../../../packages/vote-engine/dist/index.js', import.meta.url).href)
export const { declareViewsInMain } = await import(new URL('../../../packages/vote-engine/dist/database/initialize.js', import.meta.url).href)
export const VC = await import('@votetorrent/vote-core')

/** VOTETORRENT_SCHEMA_SQL without its `declare schema … apply schema` wrapper — the strand sApp
 * schema, derived exactly as both apps' rn-db-factory.ts derive it. */
export const VOTETORRENT_INNER_DDL = VE.VOTETORRENT_SCHEMA_SQL
  .replace(/^\s*declare\s+schema\s+\w+\s*\{/, '')
  .replace(/\}\s*apply\s+schema\s+\w+\s*;\s*$/, '')
  .trim()

export const SAPP_ID = 'org.votetorrent'
