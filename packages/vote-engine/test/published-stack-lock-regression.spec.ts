/**
 * published-stack-lock-regression.spec.ts
 *
 * Phase 40 CI regression locks — three lockfile/manifest invariants for the
 * published-package stack that no existing spec covers:
 *
 *   UPG-06 — patched @quereus/quereus 4.26.0 single copy. Extends
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
 *            1.1.x version (off the formerly-patched 0.13.5), and the two
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

  describe('UPG-06: patched @quereus/quereus 4.26.0 single copy', () => {
    it('resolves a single @quereus/quereus version, and it is exactly 4.26.0', () => {
      const versions = resolvedVersionsFor(lock, '@quereus/quereus')
      expect(versions.length, 'expected at least one resolved @quereus/quereus block in yarn.lock').to.be.greaterThan(0)

      const distinct = [...new Set(versions)]
      expect(
        distinct.length,
        `Expected a single resolved @quereus/quereus version, found ${distinct.length}: ${distinct.join(', ')} — dual-version install`
      ).to.equal(1)

      expect(
        distinct[0],
        `Resolved @quereus/quereus version must be exactly 4.26.0, got ${distinct[0]}`
      ).to.equal('4.26.0')
    })

    it('carries the required 4.26.0 patch (@quereus-quereus-npm-4.26.0-votetorrent)', () => {
      const count = (lock.match(/@quereus-quereus-npm-4\.26\.0-votetorrent/g) ?? []).length
      expect(
        count,
        'Expected the @quereus-quereus-npm-4.26.0-votetorrent patch locator to be present in yarn.lock. Forward-ported '
        + '4.11.0 -> 4.14.0 (spike 064) -> 4.17.1 -> 4.18.0 -> 4.19.4 -> 4.20.0 -> 4.20.1 -> 4.20.2 -> 4.20.3 -> 4.21.1 -> 4.24.0 -> 4.26.0. '
        + 'The 4.26.0 hop (2026-11-05, forced by @optimystic 1.25.0 / @serfab 1.21.0, whose peer ranges moved to ^4.25.0): '
        + 'unpatched, vote-engine went 591 failing, mostly the ExpirationValid / SubmittedAtValid datetime class, so the coercion '
        + 'half stays. The schema-declarative macrotask-yield hunk is RETIRED: 4.25 paces apply schema through the event loop '
        + 'upstream (bug-apply-schema-starves-event-loop, quereus#34). dml-executor.js gained a NOTE comment beside the first '
        + 'UPDATE preCoerced site, and row-constraints.js hunk #3 was again appended by hand. The DELETE preCoerced site stays true. '
        + 'The 4.24.0 hop (2026-11-02, forced by @optimystic 1.24.0 / @serfab 1.20.0, whose peer ranges moved to ^4.24.0 / ^4.23.0): '
        + 'the 4.21.1 patch body dry-runs onto 4.24.0 with the same single known row-constraints.js hunk #3 rejection as on 4.21.1 '
        + '(no trailing newline); re-confirm coerceNewSection and the preCoerced sites in every installed copy after install. '
        + 'The 4.21.1 hop (2026-10-30, forced by @optimystic 1.20.1 / @serfab 1.19.1, whose peer ranges moved to ^4.21.1): '
        + 'of the six patched files only dml-executor.js changed upstream (4.21.0 threads a writeScope argument through '
        + 'the write args), which moved the INSERT and UPDATE preCoerced hunks\' context, so those two and row-constraints.js '
        + 'hunk #3 were re-seated by hand and the patch regenerated through yarn patch / patch-commit with 0 changed +/- '
        + 'lines; the DELETE-path preCoerced stays true. Re-measured UNPATCHED on this machine: 3040 passing / 588 failing, '
        + 'the same datetime class (ExpirationValid / SubmittedAtValid / CidValid). quereus#28 and #34 still OPEN. The 4.20.3 hop '
        + '(2026-10-26, forced by @optimystic 1.19.0 / @serfab 1.18.0, whose peer ranges moved to ^4.20.3): 4.20.3 changes '
        + 'only schema-differ.js, which no hunk touches, so the body is verbatim and every hunk incl. coerceNewSection '
        + 'was confirmed in all 7 installed copies. Re-measured UNPATCHED on this machine, not carried forward: 2828 '
        + 'passing / 584 failing, dominated by ExpirationValid / SubmittedAtValid (~369) and the CidValid / SignatureValid '
        + 'digests over the same datetimes (~196); and a founder apply of 100 tables lets a 5 ms timer fire 0 times '
        + 'unpatched vs ~135 patched (the yield half; quereus#34 OPEN). The 4.20.2 hop was (2026-10-13, with '
        + '@serfab 1.15.0 / @optimystic 1.13.0; 4.20.2 only adds the sqllogic corpus to the package and its dist is '
        + 'BYTE-IDENTICAL to 4.20.1, so the body is verbatim). The 4.20.1 hop was (2026-10-06, forced by '
        + '@optimystic 1.11.0 / @serfab 1.13.0, whose peer ranges moved to ^4.20.1; all six patched files are '
        + 'BYTE-IDENTICAL between 4.20.0 and 4.20.1, so the body is verbatim and every hunk incl. coerceNewSection '
        + 'was confirmed in the installed dist). The 4.20.0 hop was (2026-09-28, forced by @optimystic '
        + '1.7.0, whose two quereus plugins raised their peer range again to ^4.20.0; the 4.20.0 hop left the five '
        + 'datetime files BYTE-IDENTICAL to 4.19.4, so that half is verbatim, but 4.20.0 moved the migration loop body '
        + 'into runStepsWithUndoJournal (the new undo journal), so the macrotask yield was re-seated at the end of that '
        + 'loop — still once per successful step. The 4.19.4 hop was (2026-09-21, forced by @optimystic 1.1.0, whose '
        + 'two quereus plugins raised peerDependencies[\'@quereus/quereus\'] from ^4.3.0 to ^4.19.4 — upstream '
        + 'deliberately narrowed the range because 4.12-4.19.3 load but hit the schema-differ type-alias retype '
        + 'defect). The 4.19.4 hop IS verbatim for the five datetime files: all four of dml-executor.js, insert.js, '
        + 'update.js and write-coercion.js applied with only line offsets, and the sixth file (schema-declarative.js, '
        + 'the network-create macrotask yield) applied clean too. ONE hunk needed hand-work, and it is the same one '
        + 'every hop: row-constraints.js ships with NO trailing newline, so `git apply` REJECTS hunk #3 (the '
        + '`coerceNewSection` function definition) while hunks #1-#2 (the import and the call site) land — leaving a '
        + 'module that CALLS coerceNewSection without defining it, which loads fine and fails only at runtime. On '
        + 'every future hop, grep the installed dist for `^function coerceNewSection` and do not trust a clean '
        + '`git apply` exit code. Also re-verified the 4.14.0 trap: dml-executor.js has FOUR `preCoerced` sites and '
        + 'only THREE may be flipped to false — the fourth (the DELETE path, line ~1245 on 4.19.4) must stay true. '
        + 'The patch carries TWO concerns: the datetime immediate-CHECK coercion restoration, and the '
        + 'runBatchedMigrationLoop macrotask yield that keeps a caller\'s own setTimeout timeout able to fire. '
        + 'Re-measured on 4.19.4 on this machine, not carried forward: installing UNPATCHED gives 1453 passing / '
        + '285 failing, and 212 of those 285 are exactly this class (ExpirationValid / SubmittedAtValid '
        + '`isISODatetime(x) and like(\'%Z\', x)`); re-applying the patch gives 1725 passing / 18 failing. Upstream '
        + 'issue: gotchoices/quereus#28, still OPEN, so this patch is not yet retirable.'
      ).to.be.greaterThan(0)
    })

    it('has zero references to superseded quereus patch locators (4.2.1-64e8a4bca7, 4.3.1-6814ac0861, 4.14.0-042f7e4e5e, 4.17.1-831db23a51, 4.18.0-9b9f24c666, 4.19.4-6fd16bc9e5, 4.20.0-6fd16bc9e5, 4.20.1-votetorrent, 4.20.2-votetorrent, 4.20.3-votetorrent)', () => {
      const supersededCounts = {
        '4.2.1-64e8a4bca7': (lock.match(/4\.2\.1-64e8a4bca7/g) ?? []).length,
        '4.3.1-6814ac0861': (lock.match(/4\.3\.1-6814ac0861/g) ?? []).length,
        '4.14.0-042f7e4e5e': (lock.match(/4\.14\.0-042f7e4e5e/g) ?? []).length,
        '4.17.1-831db23a51': (lock.match(/4\.17\.1-831db23a51/g) ?? []).length,
        '4.18.0-9b9f24c666': (lock.match(/4\.18\.0-9b9f24c666/g) ?? []).length,
        '4.19.4-6fd16bc9e5': (lock.match(/4\.19\.4-6fd16bc9e5/g) ?? []).length,
        '4.20.0-6fd16bc9e5': (lock.match(/4\.20\.0-6fd16bc9e5/g) ?? []).length,
        '4.20.1-votetorrent': (lock.match(/4\.20\.1-votetorrent/g) ?? []).length,
        '4.20.2-votetorrent': (lock.match(/4\.20\.2-votetorrent/g) ?? []).length,
        '4.20.3-votetorrent': (lock.match(/4\.20\.3-votetorrent/g) ?? []).length,
      }
      const residue = Object.entries(supersededCounts).filter(([, n]) => n > 0)
      expect(
        residue.length,
        `Expected zero references to superseded quereus patch locators, found: ${residue.map(([k, n]) => `${k}×${n}`).join(', ')} — stale patch residue`
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

  describe('PUB-02: @optimystic/quereus-plugin-optimystic reconciled to ^1.8.x, dead patches retired', () => {
    it('resolves a single @optimystic/quereus-plugin-optimystic version, and it is 1.8.x', () => {
      const versions = resolvedVersionsFor(lock, '@optimystic/quereus-plugin-optimystic')
      expect(versions.length, 'expected at least one resolved @optimystic/quereus-plugin-optimystic block in yarn.lock').to.be.greaterThan(0)

      const distinct = [...new Set(versions)]
      expect(
        distinct.length,
        `Expected a single resolved @optimystic/quereus-plugin-optimystic version, found ${distinct.length}: ${distinct.join(', ')}`
      ).to.equal(1)

      expect(
        distinct[0],
        `Resolved @optimystic/quereus-plugin-optimystic version must be 1.25.x, got ${distinct[0]}`
      ).to.match(/^1\.25\./)
    })

    it('resolves ^1.25.0 in the root package.json dependency declaration', () => {
      const parsed = JSON.parse(rootPackageJson) as {
        dependencies?: Record<string, string>
        resolutions?: Record<string, string>
      }
      const declared = parsed.dependencies?.['@optimystic/quereus-plugin-optimystic'] ??
        parsed.resolutions?.['@optimystic/quereus-plugin-optimystic']
      expect(
        declared,
        'Expected root package.json to declare @optimystic/quereus-plugin-optimystic as ^1.25.0'
      ).to.equal('^1.25.0')
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
