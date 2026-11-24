// purity.spec.ts — the static purity guard for @votetorrent/workflows (phase 67 plan 04, CLI-02).
//
// Every src file is scanned (the closure AND any orphan): no react-native or @react-native-* family
// package, no AsyncStorage, no native attestation module, no rn-leveldb, no @quereus RN LevelDB plugin, no
// @votetorrent/vote-cli, no Node builtin, no require()/createRequire/globalThis.require, no non-literal
// dynamic import, and every relative import carries a `.js` suffix, resolves to a src file and stays inside
// the package. Type-only imports of a forbidden package are hits too: this package has no react-native
// dependency at all.
//
// P3-P6 are the self-tests. Each reads a real file, plants ONE line into its text through the `read`
// override (asserting the planted text differs from the real text), and compares the hits with and
// without the plant, so they hold whatever state the real tree is in. They were committed RED against
// vacuous detectors first.
import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  FORBIDDEN_PACKAGES,
  PACKAGE_ROOT,
  PINNED_ENTRY_FILES,
  listSrcFiles,
  purityHits,
  type ReadFn,
} from './guards/workflows-graph.js'

const KEYHOLDER = 'src/authority/keyholder.ts'
const PLATFORM_INDEX = 'src/platform/index.ts'

/** A `read` that serves the real tree except `rel`, whose real text gets `line` appended. */
function plant (rel: string, line: string): ReadFn {
  const abs = join(PACKAGE_ROOT, rel)
  const real = readFileSync(abs, 'utf8')
  const planted = `${real}\n${line}\n`
  expect(planted, `plant into ${rel} must change the text`).to.not.equal(real)
  return (f) => (f === abs ? planted : readFileSync(f, 'utf8'))
}

/** Hits the plant adds over the real tree (robust to a sibling plan's in-progress file). */
function addedHits (rel: string, line: string): string[] {
  const base = new Set(purityHits(PACKAGE_ROOT))
  return purityHits(PACKAGE_ROOT, plant(rel, line)).filter((h) => !base.has(h))
}

describe('purity: @votetorrent/workflows source stays Node- and Metro-safe', function () {
  this.timeout(20_000)

  it('P1 real tree: no forbidden specifier, require call, builtin, escape or unresolved relative in any src file', () => {
    const hits = purityHits(PACKAGE_ROOT)
    expect(hits, `purity hits:\n  ${hits.join('\n  ')}`).to.deep.equal([])
  })

  it('P2 real tree: scans every src file, including the 13 pinned entry files', () => {
    const files = listSrcFiles(PACKAGE_ROOT)
    expect(files.length).to.be.at.least(13)
    for (const pinned of PINNED_ENTRY_FILES) expect(files, pinned).to.include(pinned)
  })

  it('P3 self-test: a planted value import of each forbidden package is caught', () => {
    const packages = [...FORBIDDEN_PACKAGES, '@react-native-community/netinfo', '@react-native/assets-registry']
    for (const pkg of packages) {
      const added = addedHits(KEYHOLDER, `import x from '${pkg}'`)
      expect(added, `plant of ${pkg}: ${JSON.stringify(added)}`).to.have.length(1)
      expect(added[0]).to.include(KEYHOLDER).and.to.include(pkg)
    }
    const reexport = addedHits(KEYHOLDER, "export { X } from 'react-native'")
    expect(reexport, JSON.stringify(reexport)).to.have.length(1)
    expect(reexport[0]).to.include(KEYHOLDER).and.to.include('react-native')
  })

  it('P4 self-test: require(), createRequire, globalThis.require, literal and non-literal dynamic import are caught', () => {
    const plants = [
      "const m = require('rn-leveldb')",
      'const r = createRequire(import.meta.url)',
      "globalThis.require('x')",
      "await import('@votetorrent/attestation-native')",
      'await import(name)',
    ]
    for (const line of plants) {
      const added = addedHits(KEYHOLDER, line)
      expect(added.length, `plant ${JSON.stringify(line)}: ${JSON.stringify(added)}`).to.be.at.least(1)
      for (const hit of added) expect(hit).to.include(KEYHOLDER)
    }
  })

  it('P5 self-test: node builtins, an app-path escape, an extensionless or unresolvable relative import are caught', () => {
    const plants = [
      "import { readFileSync } from 'node:fs'",
      "import path from 'path'",
      "import { k } from '../../../../apps/VoteTorrentAuthority/src/engines/key-vault.js'",
      "import { a } from './sibling'",
      "import { a } from './does-not-exist.js'",
    ]
    for (const line of plants) {
      const added = addedHits(KEYHOLDER, line)
      expect(added, `plant ${JSON.stringify(line)}: ${JSON.stringify(added)}`).to.have.length(1)
      expect(added[0]).to.include(KEYHOLDER)
    }
  })

  it('P6 self-test: comments, strings, requireUserAuth and a type-only relative import are not hits; a type-only react-native import is', () => {
    const clean: Array<[string, string]> = [
      [KEYHOLDER, "// import 'react-native'"],
      [KEYHOLDER, "/* require('rn-leveldb') */"],
      [KEYHOLDER, "const u = 'https://example.invalid/x' // require('a')"],
      [KEYHOLDER, 'const p = { requireUserAuth: true }'],
      [PLATFORM_INDEX, "import type { KvStorage } from './index.js'"],
    ]
    for (const [rel, line] of clean) {
      const added = addedHits(rel, line)
      expect(added, `plant ${JSON.stringify(line)} into ${rel}: ${JSON.stringify(added)}`).to.deep.equal([])
    }
    const typeOnly = addedHits(KEYHOLDER, "import type { ViewStyle } from 'react-native'")
    expect(typeOnly, JSON.stringify(typeOnly)).to.have.length(1)
    expect(typeOnly[0]).to.include(KEYHOLDER).and.to.include('react-native')
  })
})
