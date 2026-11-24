import { expect } from 'chai'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_TARGETS,
  StaleBuildError,
  assertFreshBuild,
  type FreshnessTarget
} from '../src/engine.js'

/**
 * engine-freshness.spec.ts: the control spec for the stale-dist guard. Every mtime is set with
 * utimesSync from a fixed base, so no test sleeps or depends on filesystem clock granularity.
 */

const T = 1_700_000_000
const NEWER = T + 100

const PACKAGES_DIR = fileURLToPath(new URL('../../', import.meta.url))

function touch (path: string, seconds: number): void {
  utimesSync(path, seconds, seconds)
}

/** Three fake packages a, b, c: src/x.ts and src/deep/y.ts at T, dist/index.js at T + 100. */
function makeFixture (root: string): FreshnessTarget[] {
  const targets: FreshnessTarget[] = []
  for (const name of ['a', 'b', 'c']) {
    const pkg = join(root, name)
    mkdirSync(join(pkg, 'src', 'deep'), { recursive: true })
    mkdirSync(join(pkg, 'dist'), { recursive: true })
    writeFileSync(join(pkg, 'src', 'x.ts'), 'export const x = 1\n')
    writeFileSync(join(pkg, 'src', 'deep', 'y.ts'), 'export const y = 2\n')
    writeFileSync(join(pkg, 'dist', 'index.js'), 'export const x = 1\n')
    touch(join(pkg, 'src', 'x.ts'), T)
    touch(join(pkg, 'src', 'deep', 'y.ts'), T)
    touch(join(pkg, 'src', 'deep'), T)
    touch(join(pkg, 'src'), T)
    touch(join(pkg, 'dist', 'index.js'), NEWER)
    targets.push({ name, srcDir: join(pkg, 'src'), distSentinel: join(pkg, 'dist', 'index.js') })
  }
  return targets
}

function refusal (fn: () => unknown): StaleBuildError {
  try {
    fn()
  } catch (err) {
    expect(err).to.be.instanceOf(StaleBuildError)
    expect((err as Error).name).to.equal('StaleBuildError')
    return err as StaleBuildError
  }
  expect.fail('assertFreshBuild did not throw')
}

describe('freshness: assertFreshBuild', () => {
  let root: string
  let targets: FreshnessTarget[]

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vt-fresh-'))
    targets = makeFixture(root)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('passes and returns one record per target when every dist sentinel is newer than its src', () => {
    const records = assertFreshBuild(targets)
    expect(records).to.have.lengthOf(3)
    expect(records.map((r) => r.name)).to.deep.equal(['a', 'b', 'c'])
    for (const r of records) {
      expect(r.distMtimeMs).to.be.greaterThan(r.srcNewestMs)
      expect(r.srcNewestMs).to.equal(T * 1000)
    }
  })

  it('refuses not-built when a dist sentinel is missing', () => {
    rmSync(join(root, 'b', 'dist', 'index.js'))
    const err = refusal(() => assertFreshBuild(targets))
    expect(err.code).to.equal('not-built')
    expect(err.target).to.equal('b')
  })

  it('refuses stale when a top-level src file is newer than the dist sentinel', () => {
    touch(join(root, 'c', 'src', 'x.ts'), T + 200)
    const err = refusal(() => assertFreshBuild(targets))
    expect(err.code).to.equal('stale')
    expect(err.target).to.equal('c')
  })

  it('refuses stale when only a nested src file is newer', () => {
    touch(join(root, 'a', 'src', 'deep', 'y.ts'), T + 200)
    const err = refusal(() => assertFreshBuild(targets))
    expect(err.code).to.equal('stale')
    expect(err.target).to.equal('a')
  })

  it('refuses src-missing when the src directory is absent but dist exists', () => {
    rmSync(join(root, 'b', 'src'), { recursive: true, force: true })
    const err = refusal(() => assertFreshBuild(targets))
    expect(err.code).to.equal('src-missing')
    expect(err.target).to.equal('b')
  })

  it('never puts an absolute path in the error message', () => {
    rmSync(join(root, 'a', 'dist', 'index.js'))
    const err = refusal(() => assertFreshBuild(targets))
    expect(err.message).to.not.include(root)
    expect(err.message).to.not.include(homedir())
    expect(err.message).to.include('run yarn build in packages/vote-core')
  })

  it('DEFAULT_TARGETS lists vote-core, vote-engine and workflows in build order', () => {
    expect(DEFAULT_TARGETS.map((t) => t.name)).to.deep.equal(['vote-core', 'vote-engine', 'workflows'])
    const manifest = JSON.parse(readFileSync(join(PACKAGES_DIR, 'workflows', 'package.json'), 'utf8'))
    const workflowsEntry: string = manifest.exports['.'].import
    expect(workflowsEntry.startsWith('./')).to.equal(true)
    const [core, engine, workflows] = DEFAULT_TARGETS
    expect(core?.distSentinel.endsWith(join('vote-core', 'dist', 'src', 'index.js'))).to.equal(true)
    expect(engine?.distSentinel.endsWith(join('vote-engine', 'dist', 'rn-entry.js'))).to.equal(true)
    expect(workflows?.distSentinel.endsWith(join('workflows', workflowsEntry.slice(2)))).to.equal(true)
    for (const t of DEFAULT_TARGETS) {
      expect(t.srcDir.endsWith(join(t.name, 'src'))).to.equal(true)
    }
  })
})
