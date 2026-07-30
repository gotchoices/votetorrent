/**
 * no-portal-vendor-regression.spec.ts
 *
 * PUB-01 / PUB-02 CI regression lock — the 6 previously-vendored `@serfab/*` +
 * `@optimystic/db-*` packages stay on published npm; nothing re-introduces a
 * `portal:./vendor/...` resolution or descriptor.
 *
 * Mirrors quereus-single-copy-regression.spec.ts's pattern: `findRepoRoot()` walks
 * up to the dir containing yarn.lock (the source of truth for what actually
 * installs), reads it directly, and asserts unconditional invariants with chai
 * `expect(...).to.equal(0)` — a lock, not a ledger.
 *
 * Three invariants:
 *
 *   PUB-01-a — zero `portal:` locators for the 6 packages remain in yarn.lock. A
 *              future edit that re-vendors one of the 6 (e.g. `portal:./vendor/...`
 *              re-added to a root resolution or a workspace package.json
 *              descriptor) would reintroduce a portal locator for that package —
 *              this assertion catches it.
 *
 *   PUB-01-b — zero `./vendor/` resolution targets remain in the root
 *              package.json `resolutions` block. Guards the root manifest
 *              directly (belt-and-suspenders alongside PUB-01-a's lockfile
 *              check) and would catch a re-vendoring edit even before a
 *              `yarn install` regenerates the lockfile.
 *
 *   PUB-01-c — the 6 packages resolve to their published version lines
 *              (`@serfab/* ` 0.8.x, `@optimystic/db-*` 0.14.x) in yarn.lock —
 *              hardening beyond "not portal" to "actually the expected
 *              published range".
 *
 * This is a lockfile/manifest guard, not a runtime-behaviour guard.
 */

import { expect } from 'chai'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The 6 packages that were vendored via portal:./vendor/... and are now published. */
const DEVENDORED_PACKAGES = [
  '@serfab/cadre-core',
  '@serfab/quereus-plugin-sereus',
  '@serfab/strand-proto',
  '@optimystic/db-core',
  '@optimystic/db-p2p',
  '@optimystic/db-p2p-storage-rn'
]

/** Walk up from this spec to the repo root (the dir containing yarn.lock). */
function findRepoRoot (): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'yarn.lock'))) return dir
    dir = dirname(dir)
  }
  throw new Error('no-portal-vendor-regression: could not locate yarn.lock walking up from the spec')
}

/**
 * Count lockfile lines that co-occur a `portal:` resolution string with one of
 * the de-vendored package names — catches both a top-level descriptor key
 * (`"@serfab/cadre-core@portal:./vendor/@serfab/cadre-core::...":`) and a
 * `resolution:` line inside a block.
 */
function countPortalLocatorsFor (lock: string, packages: string[]): number {
  const lines = lock.split('\n')
  let count = 0
  for (const line of lines) {
    if (!line.includes('portal:')) continue
    if (packages.some((pkg) => line.includes(pkg))) count++
  }
  return count
}

/**
 * Collect the resolved `version:` of every block for a given package in
 * yarn.lock. Mirrors quereus-single-copy-regression.spec.ts's block-scan
 * approach: a top-level (column-0) key line whose descriptor set includes
 * `${pkg}@`, followed by an indented `version:` line.
 */
function resolvedVersionsFor (lock: string, pkg: string): string[] {
  const lines = lock.split('\n')
  const versions: string[] = []
  let inBlock = false
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const keyRe = new RegExp(`(^|[",])${escaped}@`)
  for (const line of lines) {
    const isTopLevelKey = line.length > 0 && line[0] !== ' ' && line[0] !== '#' && line.trimEnd().endsWith(':')
    if (isTopLevelKey) {
      inBlock = keyRe.test(line)
      continue
    }
    if (inBlock) {
      const m = line.match(/^\s+version:\s*"?([^"\s]+)"?/)
      if (m) versions.push(m[1])
    }
  }
  return versions
}

describe('no-portal / no-vendor regression (PUB-01 / PUB-02)', () => {
  const repoRoot = findRepoRoot()
  const lock = readFileSync(join(repoRoot, 'yarn.lock'), 'utf8')
  const rootPackageJson = readFileSync(join(repoRoot, 'package.json'), 'utf8')

  // PUB-01-a — zero portal: locators for the 6 de-vendored packages in yarn.lock.
  it('PUB-01-a: yarn.lock has zero portal: locators for the 6 de-vendored packages', () => {
    const count = countPortalLocatorsFor(lock, DEVENDORED_PACKAGES)
    expect(
      count,
      `Expected zero portal: locators for ${DEVENDORED_PACKAGES.join(', ')}, found ${count} — a package has been re-vendored (PUB-01 violation)`
    ).to.equal(0)
  })

  // PUB-01-b — zero ./vendor/ resolution targets in the root package.json resolutions block.
  it('PUB-01-b: root package.json has zero ./vendor/ resolution targets', () => {
    const parsed = JSON.parse(rootPackageJson) as { resolutions?: Record<string, string> }
    const resolutions = parsed.resolutions ?? {}
    const vendorEntries = Object.entries(resolutions).filter(([, value]) => value.includes('./vendor/'))
    expect(
      vendorEntries.length,
      `Expected zero ./vendor/ resolution targets in root package.json, found: ${vendorEntries.map(([k]) => k).join(', ')} — a package has been re-vendored (PUB-02 violation)`
    ).to.equal(0)
  })

  // PUB-01-c — the 6 packages resolve to their published version lines.
  it('PUB-01-c: the 6 de-vendored packages resolve to published versions (@serfab 0.9.x, @optimystic/db-* 0.17.x)', () => {
    for (const pkg of DEVENDORED_PACKAGES) {
      const versions = resolvedVersionsFor(lock, pkg)
      expect(versions.length, `expected at least one resolved ${pkg} block in yarn.lock`).to.be.greaterThan(0)

      const distinct = [...new Set(versions)]
      expect(
        distinct.length,
        `Expected a single resolved ${pkg} version, found ${distinct.length}: ${distinct.join(', ')}`
      ).to.equal(1)

      const expectedPrefix = pkg.startsWith('@serfab/') ? '0.9.' : '0.17.'
      expect(
        distinct[0],
        `Resolved ${pkg} version must start with ${expectedPrefix}, got ${distinct[0]}`
      ).to.match(new RegExp(`^${expectedPrefix.replace(/\./g, '\\.')}`))
    }
  })
})
