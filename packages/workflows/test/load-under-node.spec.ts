// load-under-node.spec.ts — CLI-02's runtime proof for @votetorrent/workflows (phase 67 plan 04).
//
// The module list is derived from the package's own `exports` map and followed through every relative
// import (value or type) of the subpath indexes and the 9 group barrels. Each module in that closure is
// imported from its BUILT dist file in its own plain `node` child: no loader hook, no NODE_OPTIONS, no
// TS_NODE_* env, a throwaway cwd. A src file no export reaches is an orphan and fails L2, so no shared
// module escapes this check or the purity guard. L3 refuses a missing, stale or leftover dist first, so a
// pass here is a pass over the code that actually ships.
//
// L5-L8 are the controls (specifier forms, a synthetic package with an orphan, a loader that fails a
// planted require()/react-native import and passes a clean module, a child with no hook). They were
// committed RED against vacuous detectors first.
import { expect } from 'chai'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { staleDistFiles } from '../../../scripts/lib/dist-freshness.mjs'
import {
  PACKAGE_ROOT,
  PINNED_ENTRY_FILES,
  childInvocation,
  distFileFor,
  loadUnderNode,
  moduleClosure,
  orphanFiles,
  specifiers,
} from './guards/workflows-graph.js'

const tmpDirs: string[] = []
function tmp (prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}
function write (root: string, rel: string, content: string): string {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
  return p
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapLimit<T, R> (items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

describe('load-under-node: every exported workflows module loads under plain node, no hooks', function () {
  this.timeout(30_000)

  after(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
  })

  it('L1 real tree: the export closure contains the 13 pinned entry files', () => {
    const closure = moduleClosure(PACKAGE_ROOT)
    for (const pinned of PINNED_ENTRY_FILES) expect(closure, `closure: ${JSON.stringify(closure)}`).to.include(pinned)
  })

  it('L2 real tree: no orphan src file outside the export closure', () => {
    const orphans = orphanFiles(PACKAGE_ROOT)
    expect(orphans, `orphan src files (no export reaches them):\n  ${orphans.join('\n  ')}`).to.deep.equal([])
  })

  it('L3 real tree: dist is present and fresh for every src file', () => {
    const r = staleDistFiles(PACKAGE_ROOT)
    expect(r.distPresent, 'no dist: run `yarn --cwd packages/workflows build`').to.equal(true)
    const detail = r.problems.map((p) => `${p.kind} ${p.file}`).join('\n  ')
    expect(r.problems, `dist disagrees with src (run \`yarn --cwd packages/workflows build\`):\n  ${detail}`).to.deep.equal([])
  })

  it('L4 real tree: each module in the closure loads in its own plain node process', async function () {
    const closure = moduleClosure(PACKAGE_ROOT)
    this.timeout(Math.max(30_000, closure.length * 60_000))
    const results = await mapLimit(closure, 2, async (f) => ({ f, r: await loadUnderNode(distFileFor(f), 60_000) }))
    const failures = results.filter(({ r }) => !r.ok).map(({ f, r }) => `${f} exit ${r.code}: ${r.stderrTail}`)
    expect(failures, `modules that do not load under plain node:\n  ${failures.join('\n  ')}`).to.deep.equal([])
  })

  it('L5 control: specifier extraction reads export *, export {..}, export type, export * as, multi-line and side-effect forms', () => {
    const text = [
      "export * from './a.js'",
      "export { x } from './b.js'",
      "export type { T } from './c.js'",
      "export * as ns from './d.js'",
      'export {',
      '  e,',
      "} from './e.js'",
      "import './f.js'",
    ].join('\n')
    const specs = specifiers(text)
    expect(specs.map((s) => s.spec)).to.deep.equal(['./a.js', './b.js', './c.js', './d.js', './e.js', './f.js'])
    expect(specs.map((s) => s.typeOnly)).to.deep.equal([false, false, true, false, false, false])
    expect(specs.map((s) => s.kind)).to.deep.equal(['static', 'static', 'static', 'static', 'static', 'side-effect'])
  })

  it('L6 control: a synthetic package reports its closure and its orphan', () => {
    const root = tmp('wf-graph-')
    write(root, 'package.json', JSON.stringify({ name: 'fixture', type: 'module', exports: { '.': { import: './dist/index.js' } } }))
    write(root, 'src/index.ts', "export * from './a.js'\n")
    write(root, 'src/a.ts', "export type { T } from './b.js'\n")
    write(root, 'src/b.ts', 'export type T = number\n')
    write(root, 'src/orphan.ts', 'export const o = 1\n')
    expect(moduleClosure(root)).to.deep.equal(['src/a.ts', 'src/b.ts', 'src/index.ts'])
    expect(orphanFiles(root)).to.deep.equal(['src/orphan.ts'])
  })

  it('L7 control: the loader fails a planted require() and a planted react-native import, and passes a clean module', async () => {
    const root = tmp('wf-load-ctl-')
    write(root, 'package.json', '{"type":"module"}\n')
    const req = write(root, 'req.js', "const f = require('node:fs')\nexport { f }\n")
    const rn = write(root, 'rn.js', "import 'react-native'\n")
    const ok = write(root, 'ok.js', 'export const a = 1\n')

    const reqResult = await loadUnderNode(req, 20_000)
    expect(reqResult.ok, JSON.stringify(reqResult)).to.equal(false)
    expect(reqResult.stderrTail).to.match(/require is not defined/)

    const rnResult = await loadUnderNode(rn, 20_000)
    expect(rnResult.ok, JSON.stringify(rnResult)).to.equal(false)

    const okResult = await loadUnderNode(ok, 20_000)
    expect(okResult.ok, JSON.stringify(okResult)).to.equal(true)
  })

  it('L8 control: the child gets no loader hook', () => {
    const saved = { NODE_OPTIONS: process.env.NODE_OPTIONS, TS_NODE_PROJECT: process.env.TS_NODE_PROJECT }
    process.env.NODE_OPTIONS = '--import=./register-ts-node.mjs'
    process.env.TS_NODE_PROJECT = './tsconfig.test.json'
    try {
      const inv = childInvocation(join(PACKAGE_ROOT, 'dist', 'index.js'))
      for (const flag of ['--import', '--loader', '--experimental-loader', '--require', '-r']) {
        expect(inv.args.some((a) => a === flag || a.startsWith(`${flag}=`)), flag).to.equal(false)
      }
      expect(inv.env).to.not.have.property('NODE_OPTIONS')
      expect(inv.env).to.not.have.property('NODE_PATH')
      expect(Object.keys(inv.env).filter((k) => k.startsWith('TS_NODE_'))).to.deep.equal([])
      expect(inv.env.FORCE_COLOR).to.equal('0')
    } finally {
      if (saved.NODE_OPTIONS === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = saved.NODE_OPTIONS
      if (saved.TS_NODE_PROJECT === undefined) delete process.env.TS_NODE_PROJECT
      else process.env.TS_NODE_PROJECT = saved.TS_NODE_PROJECT
    }
  })
})
