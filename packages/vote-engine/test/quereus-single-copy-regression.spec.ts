/**
 * quereus-single-copy-regression.spec.ts
 *
 * UPG-03 CI regression lock — single @quereus/quereus 4.x copy.
 *
 * Guards the single-copy invariant that is otherwise only checked by the one-time
 * 33-01 checkpoint proof (`yarn why` + inline grep gates) and the peer-requirements
 * guard (`yarn lint:peers`, which catches plugin peer mismatches but NOT a dual
 * quereus copy on its own).
 *
 * Two invariants, parsed from the root yarn.lock (the source of truth for what
 * actually installs):
 *
 *   SC1 — zero `@quereus/quereus@npm:3.x` descriptors remain. A future dep re-split
 *          (e.g. a vendored @serfab bump that re-pins ^3.2.1 without a 4.x resolution
 *          override) would reintroduce a 3.x descriptor — this assertion catches it.
 *
 *   SC2 — every resolved @quereus/quereus block reports a single 4.x version. Yarn may
 *          list several descriptor keys (npm range + patch:) that all dedupe to ONE
 *          resolved version; this asserts there is exactly one distinct resolved version
 *          and it is 4.x (the "no dual-version install" requirement, UPG-03 SC1).
 *
 * Mirrors the noble-dedupe-regression.spec.ts pattern (SIGN-04 single-noble-copy lock).
 * This is a lockfile/version-tree guard, not a runtime-behaviour guard.
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
  throw new Error('quereus-single-copy-regression: could not locate yarn.lock walking up from the spec')
}

/**
 * Collect the resolved `version:` of every @quereus/quereus block in yarn.lock.
 * A block is a top-level (column-0) key line whose descriptor set includes
 * `@quereus/quereus@`, followed by an indented `version:` line. The trailing `@`
 * excludes sibling packages like @quereus/store, @quereus/isolation, and
 * @quereus/plugin-react-native-leveldb.
 */
function resolvedQuereusVersions (lock: string): string[] {
  const lines = lock.split('\n')
  const versions: string[] = []
  let inQuereusBlock = false
  for (const line of lines) {
    const isTopLevelKey = line.length > 0 && line[0] !== ' ' && line[0] !== '#' && line.trimEnd().endsWith(':')
    if (isTopLevelKey) {
      inQuereusBlock = /(^|[",])@quereus\/quereus@/.test(line)
      continue
    }
    if (inQuereusBlock) {
      const m = line.match(/^\s+version:\s*"?([^"\s]+)"?/)
      if (m) versions.push(m[1])
    }
  }
  return versions
}

describe('@quereus/quereus single-copy regression (UPG-03)', () => {
  const lock = readFileSync(join(findRepoRoot(), 'yarn.lock'), 'utf8')

  // SC1 — no quereus 3.x descriptors survive in the lockfile.
  it('SC1: yarn.lock has zero @quereus/quereus@npm:3.x descriptors (no 3.x residue)', () => {
    const threeX = lock.match(/@quereus\/quereus@npm:3\./g) ?? []
    expect(
      threeX.length,
      `Expected zero @quereus/quereus@npm:3.x descriptors, found ${threeX.length} — a 3.x copy has re-entered the install (UPG-03 single-copy violation)`
    ).to.equal(0)
  })

  // SC2 — exactly one resolved quereus version, and it is 4.x.
  it('SC2: a single resolved @quereus/quereus version, and it is 4.x (no dual-version install)', () => {
    const versions = resolvedQuereusVersions(lock)
    expect(versions.length, 'expected at least one resolved @quereus/quereus block in yarn.lock').to.be.greaterThan(0)

    const distinct = [...new Set(versions)]
    expect(
      distinct.length,
      `Expected a single resolved @quereus/quereus version, found ${distinct.length}: ${distinct.join(', ')} — dual-version install (UPG-03 violation)`
    ).to.equal(1)

    expect(
      distinct[0],
      `Resolved @quereus/quereus version must be 4.x, got ${distinct[0]}`
    ).to.match(/^4\./)
  })
})
