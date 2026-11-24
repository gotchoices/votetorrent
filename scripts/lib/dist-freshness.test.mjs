// dist-freshness.test.mjs — controls for scripts/lib/dist-freshness.mjs (phase 67 plan 04, CLI-02).
//
// Each case builds a throwaway fixture package (src + dist) under the OS tmp dir with explicit
// mtimes, so the verdict depends on the rule and not on how fast the test wrote the files. Cases (b)
// and the stale leg of (h) are the RED controls: with the stale comparison reversed they fail.
//
// Run: FORCE_COLOR=0 node --test scripts/lib/dist-freshness.test.mjs   (from the repo root)

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { staleDistFiles } from './dist-freshness.mjs'

const LIB = fileURLToPath(new URL('./dist-freshness.mjs', import.meta.url))
const fixtures = []

after(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true })
})

/** Write `rel` under `root` with the given mtime (seconds since epoch). */
function put (root, rel, mtimeSec, content = '// x\n') {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
  utimesSync(p, mtimeSec, mtimeSec)
  return p
}

const T0 = Math.floor(Date.now() / 1000) - 600 // src written ten minutes ago
const T_BUILD = T0 + 60 // dist emitted a minute later

/** A fresh fixture: src a.ts + sub/b.ts, dist a.js + sub/b.js (plus a .d.ts and a .js.map) built after them. */
function freshFixture () {
  const root = mkdtempSync(join(tmpdir(), 'dist-fresh-'))
  fixtures.push(root)
  put(root, 'src/a.ts', T0)
  put(root, 'src/sub/b.ts', T0)
  put(root, 'dist/a.js', T_BUILD)
  put(root, 'dist/sub/b.js', T_BUILD)
  put(root, 'dist/a.d.ts', T_BUILD)
  put(root, 'dist/a.js.map', T_BUILD)
  return root
}

test('(a) fresh: dist newer than src, .d.ts and .js.map ignored -> no problems', () => {
  const root = freshFixture()
  const r = staleDistFiles(root)
  assert.equal(r.distPresent, true)
  assert.deepEqual(r.problems, [])
})

test('(b) stale: src/a.ts bumped 10 s after its dist file -> exactly one stale problem', () => {
  const root = freshFixture()
  const later = T_BUILD + 10
  utimesSync(join(root, 'src/a.ts'), later, later)
  assert.deepEqual(staleDistFiles(root).problems, [{ kind: 'stale', file: 'src/a.ts' }])
})

test('(c) missing: dist/sub/b.js deleted -> one missing problem naming the src file', () => {
  const root = freshFixture()
  unlinkSync(join(root, 'dist/sub/b.js'))
  assert.deepEqual(staleDistFiles(root).problems, [{ kind: 'missing', file: 'src/sub/b.ts' }])
})

test('(d) leftover: dist/old.js with no src -> one leftover problem naming the dist file', () => {
  const root = freshFixture()
  put(root, 'dist/old.js', T_BUILD)
  assert.deepEqual(staleDistFiles(root).problems, [{ kind: 'leftover', file: 'dist/old.js' }])
})

test('(e) a src/types.d.ts creates no problem', () => {
  const root = freshFixture()
  put(root, 'src/types.d.ts', T0)
  assert.deepEqual(staleDistFiles(root).problems, [])
})

test('(f) no dist dir -> distPresent false, no problems', () => {
  const root = mkdtempSync(join(tmpdir(), 'dist-fresh-'))
  fixtures.push(root)
  put(root, 'src/a.ts', T0)
  assert.deepEqual(staleDistFiles(root), { distPresent: false, problems: [] })
})

test('(g) no src dir -> throws naming the missing directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'dist-fresh-'))
  fixtures.push(root)
  put(root, 'dist/a.js', T_BUILD)
  assert.throws(() => staleDistFiles(root), /src/)
})

test('(h) CLI exit codes: fresh 0 / stale 1 / no dist 0 (SKIP) / no args 2', () => {
  const run = (args) => spawnSync(process.execPath, [LIB, ...args], { encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } })

  const fresh = freshFixture()
  const okRun = run([fresh, 'fixture'])
  assert.equal(okRun.status, 0, okRun.stderr)
  assert.match(okRun.stdout, /\[dist-check\] OK:/)

  const stale = freshFixture()
  utimesSync(join(stale, 'src/a.ts'), T_BUILD + 10, T_BUILD + 10)
  const staleRun = run([stale, 'fixture'])
  assert.equal(staleRun.status, 1)
  assert.match(staleRun.stderr, /\[dist-check\] FAIL:/)
  assert.match(staleRun.stderr, /stale src\/a\.ts/)
  assert.match(staleRun.stderr, /Rebuild with:/)

  const noDist = mkdtempSync(join(tmpdir(), 'dist-fresh-'))
  fixtures.push(noDist)
  put(noDist, 'src/a.ts', T0)
  const skipRun = run([noDist, 'fixture'])
  assert.equal(skipRun.status, 0, skipRun.stderr)
  assert.match(skipRun.stdout, /\[dist-check\] SKIP:/)

  const noArgs = run([])
  assert.equal(noArgs.status, 2)
  assert.match(noArgs.stderr, /usage:/)
})
