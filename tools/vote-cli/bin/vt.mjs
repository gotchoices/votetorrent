#!/usr/bin/env node
// vt — the VoteTorrent CLI launcher.
//
// The CLI resolves every third-party package (cadre-core, libp2p, noble, quereus) through
// packages/vote-engine/node_modules, so it runs on exactly the patched dependency tree the apps
// use. A directory outside the yarn workspace graph that installed its own node_modules would get
// STOCK quereus and cadre-core and silently drop the repo's yarn patches, so this launcher links
// vote-engine's node_modules instead of installing anything.

import { existsSync, lstatSync, symlinkSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const cliRoot = join(here, '..')
const engineModules = join(cliRoot, '..', '..', 'packages', 'vote-engine', 'node_modules')
const link = join(cliRoot, 'node_modules')

if (!existsSync(engineModules)) {
  console.error(`vt: ${engineModules} is missing — run \`yarn install\` at the repo root first`)
  process.exit(2)
}
let linked = false
try { linked = lstatSync(link).isSymbolicLink() } catch { linked = false }
if (!linked) {
  if (existsSync(link)) {
    console.error(`vt: ${link} exists and is not a symlink to vote-engine's node_modules; remove it`)
    process.exit(2)
  }
  symlinkSync(relative(cliRoot, engineModules), link, 'dir')
}

await import('../src/cli.mjs')
