// skeleton.spec.ts: the package-shape proof for @votetorrent/workflows (phase 67 plan 03).
// Runs against the BUILT dist: every exports target must exist, every import target must load under a
// plain `node` child (no --import hook, no NODE_OPTIONS), the index files must re-export exactly the
// fixed barrel set, each barrel must exist, and the platform subpath must carry zero runtime keys.
import { expect } from 'chai'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const BUILD_HINT = 'dist/platform/index.js is missing: run `yarn workspace @votetorrent/workflows build` first'

type ExportEntry = { types: string; import: string; default: string }
const manifest = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as { exports: Record<string, ExportEntry> }
const SUBPATHS = ['.', './authority', './voter', './platform']

const AUTHORITY_BARRELS = [
  './keyholder.js',
  './node.js',
  './network.js',
  './officer.js',
  './election.js',
  '../common/strand.js',
  '../common/join-node.js',
]
const VOTER_BARRELS = ['./ceremony.js', './reads.js', '../common/strand.js', '../common/join-node.js']
const BARREL_FILES = [
  'src/authority/keyholder.ts',
  'src/authority/node.ts',
  'src/authority/network.ts',
  'src/authority/officer.ts',
  'src/authority/election.ts',
  'src/common/strand.ts',
  'src/common/join-node.ts',
  'src/voter/ceremony.ts',
  'src/voter/reads.ts',
]

/** A child `node` with no hooks: NODE_OPTIONS removed, no execArgv, FORCE_COLOR=0. */
function plainNode (code: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0' }
  delete env.NODE_OPTIONS
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: pkgRoot, env, encoding: 'utf8' })
}

function reexportSpecifiers (file: string): string[] {
  const text = readFileSync(join(pkgRoot, file), 'utf8')
  return [...text.matchAll(/^export \* from '([^']+)'$/gm)].map((m) => m[1] as string)
}

describe('@votetorrent/workflows skeleton', function () {
  this.timeout(20_000)

  before(() => {
    if (!existsSync(join(pkgRoot, 'dist/platform/index.js'))) throw new Error(BUILD_HINT)
  })

  it('(a) each of the four exports has types/import/default and every target exists on disk', () => {
    expect(Object.keys(manifest.exports)).to.have.members(SUBPATHS)
    for (const sub of SUBPATHS) {
      const entry = manifest.exports[sub] as ExportEntry
      for (const cond of ['types', 'import', 'default'] as const) {
        expect(entry[cond], `${sub} ${cond}`).to.be.a('string')
        expect(existsSync(join(pkgRoot, entry[cond])), `${sub} ${cond} -> ${entry[cond]}`).to.equal(true)
      }
    }
  })

  it('(b) each import target loads in a plain node child with no hooks and no NODE_OPTIONS', () => {
    for (const sub of SUBPATHS) {
      const target = pathToFileURL(join(pkgRoot, (manifest.exports[sub] as ExportEntry).import)).href
      const r = plainNode(`await import(${JSON.stringify(target)})`)
      expect(r.status, `${sub}: ${r.stderr}`).to.equal(0)
    }
  })

  it('(c) authority/index.ts and voter/index.ts re-export exactly the fixed barrel set', () => {
    expect(reexportSpecifiers('src/authority/index.ts')).to.deep.equal(AUTHORITY_BARRELS)
    expect(reexportSpecifiers('src/voter/index.ts')).to.deep.equal(VOTER_BARRELS)
  })

  it('(d) each of the nine group barrels exists', () => {
    for (const f of BARREL_FILES) expect(existsSync(join(pkgRoot, f)), f).to.equal(true)
  })

  it('(e) the platform subpath is type-only: its loaded namespace has zero keys', () => {
    const target = pathToFileURL(join(pkgRoot, 'dist/platform/index.js')).href
    const r = plainNode(`const ns = await import(${JSON.stringify(target)}); console.log(Object.keys(ns).length)`)
    expect(r.status, r.stderr).to.equal(0)
    expect(r.stdout.trim()).to.equal('0')
  })
})
