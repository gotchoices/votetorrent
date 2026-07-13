/**
 * published-stack-lock-regression.spec.ts
 *
 * Phase 40 CI regression locks — three lockfile/manifest invariants for the
 * published-package stack that no existing spec covers:
 *
 *   UPG-06 — patched @quereus/quereus 4.3.1 single copy. Extends
 *            quereus-single-copy-regression.spec.ts (UPG-03, "single copy,
 *            4.x") to the phase-specific version+patch: the resolved version
 *            must be exactly 4.3.1, the required forward-ported patch locator
 *            (@quereus-quereus-npm-4.3.1-6814ac0861 — applyViewDefaults +
 *            runBatchedMigrationLoop; npm's 4.3.1 ships applyViewDefaults=0,
 *            so the patch is not optional) must be present, and the
 *            superseded 4.2.1 patch locator must be gone.
 *
 *   PUB-01 (multiaddr clause) — a single resolved @multiformats/multiaddr
 *            version, and it is 13.x (VT's own libp2p matrix). A second
 *            resolved multiaddr line is the spike-021 Variant-B hazard
 *            (adopting a second libp2p matrix from a published dependency).
 *
 *   PUB-02 — @optimystic/quereus-plugin-optimystic reconciled to a single
 *            0.14.x version (off the formerly-patched 0.13.5), and the two
 *            dead patch locators from the pre-de-vendoring state
 *            (@optimystic-quereus-plugin-optimystic-npm-0.13.5,
 *            @serfab-cadre-core-npm-0.7.1) have zero references anywhere in
 *            yarn.lock — both packages superseded the hand-patches upstream
 *            (0.14.1 / 0.8.1) and the patches were deleted in 40-02.
 *
 * Mirrors quereus-single-copy-regression.spec.ts / no-portal-vendor-regression.spec.ts's
 * pattern: findRepoRoot() walks up to the dir containing yarn.lock (the source
 * of truth for what actually installs), reads it + the root package.json
 * directly, and asserts unconditional invariants with chai
 * expect(...).to.equal(...) — a lock, not a ledger.
 *
 * This is a lockfile/manifest guard, not a runtime-behaviour guard.
 */

import { expect } from 'chai'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Walk up from this spec to the repo root (the dir containing yarn.lock). */
function findRepoRoot (): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'yarn.lock'))) return dir
    dir = dirname(dir)
  }
  throw new Error('published-stack-lock-regression: could not locate yarn.lock walking up from the spec')
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

describe('published stack lock regression (UPG-06 / PUB-01 / PUB-02)', () => {
  const repoRoot = findRepoRoot()
  const lock = readFileSync(join(repoRoot, 'yarn.lock'), 'utf8')
  const rootPackageJson = readFileSync(join(repoRoot, 'package.json'), 'utf8')

  describe('UPG-06: patched @quereus/quereus 4.3.1 single copy', () => {
    it('resolves a single @quereus/quereus version, and it is exactly 4.3.1', () => {
      const versions = resolvedVersionsFor(lock, '@quereus/quereus')
      expect(versions.length, 'expected at least one resolved @quereus/quereus block in yarn.lock').to.be.greaterThan(0)

      const distinct = [...new Set(versions)]
      expect(
        distinct.length,
        `Expected a single resolved @quereus/quereus version, found ${distinct.length}: ${distinct.join(', ')} — dual-version install`
      ).to.equal(1)

      expect(
        distinct[0],
        `Resolved @quereus/quereus version must be exactly 4.3.1, got ${distinct[0]}`
      ).to.equal('4.3.1')
    })

    it('carries the required 4.3.1 forward-port patch (@quereus-quereus-npm-4.3.1-6814ac0861)', () => {
      const count = (lock.match(/@quereus-quereus-npm-4\.3\.1-6814ac0861/g) ?? []).length
      expect(
        count,
        'Expected the @quereus-quereus-npm-4.3.1-6814ac0861 patch locator (applyViewDefaults + runBatchedMigrationLoop forward-port) to be present in yarn.lock — npm\'s 4.3.1 ships applyViewDefaults=0, the patch is required'
      ).to.be.greaterThan(0)
    })

    it('has zero references to the superseded 4.2.1 patch locator (4.2.1-64e8a4bca7)', () => {
      const count = (lock.match(/4\.2\.1-64e8a4bca7/g) ?? []).length
      expect(
        count,
        `Expected zero references to the superseded 4.2.1 patch locator, found ${count} — stale patch residue`
      ).to.equal(0)
    })
  })

  describe('PUB-01: single @multiformats/multiaddr copy (VT\'s own 13.x libp2p matrix)', () => {
    it('resolves a single @multiformats/multiaddr version, and it is 13.x', () => {
      const versions = resolvedVersionsFor(lock, '@multiformats/multiaddr')
      expect(versions.length, 'expected at least one resolved @multiformats/multiaddr block in yarn.lock').to.be.greaterThan(0)

      const distinct = [...new Set(versions)]
      expect(
        distinct.length,
        `Expected a single resolved @multiformats/multiaddr version, found ${distinct.length}: ${distinct.join(', ')} — dual-multiaddr install (spike-021 Variant-B hazard)`
      ).to.equal(1)

      expect(
        distinct[0],
        `Resolved @multiformats/multiaddr version must be 13.x, got ${distinct[0]}`
      ).to.match(/^13\./)
    })
  })

  describe('PUB-02: @optimystic/quereus-plugin-optimystic reconciled to ^0.14.x, dead patches retired', () => {
    it('resolves a single @optimystic/quereus-plugin-optimystic version, and it is 0.14.x', () => {
      const versions = resolvedVersionsFor(lock, '@optimystic/quereus-plugin-optimystic')
      expect(versions.length, 'expected at least one resolved @optimystic/quereus-plugin-optimystic block in yarn.lock').to.be.greaterThan(0)

      const distinct = [...new Set(versions)]
      expect(
        distinct.length,
        `Expected a single resolved @optimystic/quereus-plugin-optimystic version, found ${distinct.length}: ${distinct.join(', ')}`
      ).to.equal(1)

      expect(
        distinct[0],
        `Resolved @optimystic/quereus-plugin-optimystic version must be 0.14.x, got ${distinct[0]}`
      ).to.match(/^0\.14\./)
    })

    it('resolves ^0.14.1 in the root package.json dependency declaration', () => {
      const parsed = JSON.parse(rootPackageJson) as {
        dependencies?: Record<string, string>
        resolutions?: Record<string, string>
      }
      const declared = parsed.dependencies?.['@optimystic/quereus-plugin-optimystic'] ??
        parsed.resolutions?.['@optimystic/quereus-plugin-optimystic']
      expect(
        declared,
        'Expected root package.json to declare @optimystic/quereus-plugin-optimystic as ^0.14.1'
      ).to.equal('^0.14.1')
    })

    it('has zero references to the dead patch locators (0.13.5 plugin-optimystic patch, 0.7.1 cadre-core patch)', () => {
      const pluginPatchCount = (lock.match(/@optimystic-quereus-plugin-optimystic-npm-0\.13\.5/g) ?? []).length
      const cadreCorePatchCount = (lock.match(/@serfab-cadre-core-npm-0\.7\.1/g) ?? []).length

      expect(
        pluginPatchCount,
        `Expected zero references to @optimystic-quereus-plugin-optimystic-npm-0.13.5, found ${pluginPatchCount} — dead patch residue (superseded upstream in 0.14.1)`
      ).to.equal(0)

      expect(
        cadreCorePatchCount,
        `Expected zero references to @serfab-cadre-core-npm-0.7.1, found ${cadreCorePatchCount} — dead patch residue (connectionGater upstream in 0.8.1)`
      ).to.equal(0)
    })
  })
})
