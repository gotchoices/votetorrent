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
 *
 * The 2026-09-30 sereus-master vendor exception (`portal:./vendor/@serfab/*` for sereus#19-#22)
 * ended with the adoption of @serfab 1.9.0, which ships those fixes; all 6 are guarded again.
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
  it('PUB-01-c: the 6 de-vendored packages resolve to published versions (@serfab 1.19.x, @optimystic/db-* 1.20.x)', () => {
    for (const pkg of DEVENDORED_PACKAGES) {
      const versions = resolvedVersionsFor(lock, pkg)
      expect(versions.length, `expected at least one resolved ${pkg} block in yarn.lock`).to.be.greaterThan(0)

      const distinct = [...new Set(versions)]
      expect(
        distinct.length,
        `Expected a single resolved ${pkg} version, found ${distinct.length}: ${distinct.join(', ')}`
      ).to.equal(1)

      // @serfab/strand-proto is still on the 0.11 line (neither 0.12 nor 0.13 was ever
      // published for it); cadre-core and quereus-plugin-sereus moved 0.12.0 -> 0.13.0
      // with the bump in eb5302af. @optimystic/db-* moved 1.0.0-beta.3 -> 1.1.0 on
      // 2026-09-21: 1.1.0 is the first STABLE optimystic line, and taking it was not
      // optional once its two quereus plugins narrowed their peer range to ^4.19.4.
      // NOTE the @serfab line is deliberately NOT moved in that bump even though
      // cadre-core 1.0.0 exists — cadre-core 0.13.0's `^1.0.0-beta.2` range already
      // admits 1.1.0, so the families were decoupled for this hop on purpose.
      // This assertion had drifted TWO bumps behind once already (it still named 0.12.x /
      // 0.27.x) because nothing re-runs it on a dependency change.
      // It drifted AGAIN (still 0.13.x / 1.1.x) across the cadre-core 1.2.0 and the
      // @optimystic 1.2.0 -> 1.3.0 -> 1.5.0 bumps; re-keyed 2026-09-28 with the
      // @optimystic 1.5.0 -> 1.7.0 and @serfab 1.2.0 -> 1.6.0 bumps to what yarn.lock actually resolves.
      // Spike 094: @serfab 1.6.0 -> 1.7.0 (strand peer book; the local fwdport patch carried verbatim).
      // 2026-10-01: @serfab 1.9.0 (sereus#19-#22 released; peer book replaced by strand network
      // state) and @optimystic 1.8.1, ending the sereus-master vendor copy.
      // 2026-10-02: @optimystic 1.8.1 -> 1.9.0 (needs libp2p ^3.3.11 / @libp2p/interface ^3.3.0;
      // the db-p2p `.unref?.()` patch carried forward unchanged). @serfab stays 1.9.0.
      // 2026-10-05: @serfab 1.9.0 -> 1.12.0 (strandReactivity, pending joins, formation
      // responder installed by start(); the public-observer + cohort-topic patch re-seated) and
      // @optimystic 1.9.0 -> 1.10.1 (reactivity substrate; the `.unref?.()` patch carried forward
      // unchanged — Optimystic#28 still open). The two families are on DIFFERENT lines from here on.
      // 2026-10-06: @serfab 1.12.0 -> 1.13.0 (control node dials bootstrap peers after bring-up;
      // native block digest in cadre-rn; the public-observer + cohort-topic patch carried verbatim)
      // and @optimystic 1.10.1 -> 1.11.0 (Optimystic#27 and #28 fixed; the db-p2p `.unref?.()`
      // patch RETIRED — every timer now goes through upstream's guarded `unrefTimer`).
      // 2026-10-08: @optimystic 1.11.0 -> 1.12.1 (Optimystic#32 stream-open fallback across
      // connections; a catching-up member abstains instead of vetoing). @serfab stays 1.13.0 (latest).
      // 2026-10-09: @serfab 1.13.0 -> 1.14.0 (cadre invitations replace the invite/accept ceremony,
      // per-stream control-protocol guard, provisional stranger admission; the public-observer +
      // cohort-topic patch forward-ported with a new guard-classification hunk). @optimystic stays 1.12.1.
      // 2026-10-13: @serfab 1.14.0 -> 1.15.0 (sereus#34 relay first-attempt fixed, strand redial on the
      // link budget, `sereus-invite:1.` invitations, CadrePeer `Profile` column; the patch carried with
      // identical hunk bodies) and @optimystic 1.12.1 -> 1.13.0 (lazy read-repair, isNetworkMember,
      // prepared streams, commit durability; p2p-fret ^1.0.2). @quereus 4.20.1 -> 4.20.2.
      // 2026-10-14: @optimystic 1.13.0 -> 1.14.0 (owed cancels re-sent by the writer; a two-member
      // cohort skips the commit round and defers a sole-reservation pend's delivery onto its commit).
      // @serfab stays 1.15.0 (latest), quereus 4.20.2, p2p-fret 1.0.2.
      // 2026-10-16: @serfab 1.15.0 -> 1.16.0 (dependency ranges only: cadre-core's dist is byte-identical
      // to 1.15.0, so the patch carries verbatim) and @optimystic 1.14.0 -> 1.15.0 (FRET maintenance
      // redial on the node's dial deadline; p2p-fret ^1.1.0 with idle backoff). quereus stays 4.20.2.
      // 2026-10-26: @serfab 1.16.0 -> 1.18.0 (owner keys apart from the node identity, machine
      // invitations grant no ownership, control-schema versions with in-place migration from 1.17 on
      // (a 1.16 store is refused `before-migrations`), identify-gated sibling reachability; the
      // public-observer patch forward-ported and the control-fork guard added) and @optimystic
      // 1.15.0 -> 1.19.0 (catalog-only ALTER, storage durability window, one request per member per
      // multi-collection commit, size-split blocks, Optimystic#35's 1 MiB cap lifted; p2p-fret ^1.2.1).
      // @quereus 4.20.2 -> 4.20.3, @libp2p/websockets 10.1.18 -> 10.1.25 (patched).
      // 2026-10-29: @serfab 1.18.0 -> 1.19.0 (cadre-rn's chunked TextDecoder + fast structuredClone,
      // sereus#51; cadre-core re-publishes only on address churn and pushes catch-up blocks in
      // db-p2p 1.19's shape, so the patch's peer-join-backfill hunk is dropped). @optimystic stays 1.19.0.
      // 2026-10-30: @serfab 1.19.0 -> 1.19.1 (strand offline mode, off by default; a control write whose
      // read no member answered retries on the typed BlockUnavailableError) and @optimystic 1.19.0 ->
      // 1.20.1 (typed PromiseShortfallError / ValidityRejectedError / BlockUnavailableError, the plugin's
      // offline queue). @quereus 4.20.3 -> 4.21.1 (statement write scope). All three patches carried
      // with identical hunk bodies.
      // 2026-11-02: @serfab 1.19.1 -> 1.20.0 (strandReactivity, StrandDatabase.watchTables) and @optimystic
      // 1.20.1 -> 1.24.0 (cohort-topic reactivity cheaper when idle, matchmaking sessions, client signatures
      // txsig:v3, so every machine moves together). @quereus 4.21.1 -> 4.24.0, p2p-fret 1.2.1 -> 1.3.0.
      // 2026-11-05: @serfab 1.20.0 -> 1.21.0 (a relay reservation re-dials after a dropped dial; a refused app
      // schema change keeps the earlier schema) and @optimystic 1.24.0 -> 1.25.0 (adapts to quereus 4.25's
      // unwound schema commit). @quereus 4.24.0 -> 4.26.0. cadre-core and db-p2p patches carried byte-identical.
      const expectedPrefix = pkg === '@serfab/strand-proto'
        ? '0.11.'
        : pkg.startsWith('@serfab/') ? '1.21.' : '1.25.'
      expect(
        distinct[0],
        `Resolved ${pkg} version must start with ${expectedPrefix}, got ${distinct[0]}`
      ).to.match(new RegExp(`^${expectedPrefix.replace(/\./g, '\\.')}`))
    }
  })
})
