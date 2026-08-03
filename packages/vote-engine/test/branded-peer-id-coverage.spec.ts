/**
 * branded-peer-id-coverage.spec.ts
 *
 * P2P-10/D-06 regression lock — all 3 vendored dial sites route peer
 * identifiers through the shared `toBrandedPeerId()` helper.
 *
 * Guards the hardening landed in Phase 38 Plan 01: a single `toBrandedPeerId()`
 * export in `vendor/@optimystic/db-p2p/dist/src/peer-utils.js`, called at the
 * landed chokepoint (`libp2p-key-network.js:245`) plus the two siblings flagged
 * in review (`libp2p-node-base.js:295` RestorationCoordinator `connect` adapter,
 * `repo/service.js:69` `getPeerAddrs`). Static source-text assertions only —
 * this is a lockfile/source-tree guard, not a runtime-behaviour guard.
 *
 * Mirrors quereus-single-copy-regression.spec.ts's "read a file with fs,
 * regex-assert on its text" shape.
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
  throw new Error('branded-peer-id-coverage: could not locate yarn.lock walking up from the spec')
}

const REPO_ROOT = findRepoRoot()
const VENDOR_DB_P2P_SRC = join(REPO_ROOT, 'vendor', '@optimystic', 'db-p2p', 'dist', 'src')

const PEER_UTILS_PATH = join(VENDOR_DB_P2P_SRC, 'peer-utils.js')
const KEY_NETWORK_PATH = join(VENDOR_DB_P2P_SRC, 'libp2p-key-network.js')
const NODE_BASE_PATH = join(VENDOR_DB_P2P_SRC, 'libp2p-node-base.js')
const REPO_SERVICE_PATH = join(VENDOR_DB_P2P_SRC, 'repo', 'service.js')

// Build the banned/expected substrings via concatenation so this spec's own
// source text does not self-trip its own negative-lock assertions (mirrors
// the 36-02 static-lock deviation lesson).
const HELPER_EXPORT_MARKER = 'export ' + 'function toBrandedPeerId'
const HELPER_CALL_MARKER = 'toBrandedPeerId' + '('
const BARE_DIAL_PROTOCOL = 'node.dialProtocol' + '(pid, [protocol])'
const BARE_GET_CONNECTIONS = 'getConnections' + '(peerId)'

// SUPERSEDED (Phase 40-02, PUB-01/PUB-02 de-vendoring): this spec locks Phase 38's
// hand-patched `vendor/@optimystic/db-p2p` dist source, which no longer exists now
// that VT consumes it from published npm (@optimystic/db-p2p@0.14.1 does not carry
// this hardening upstream). Cross-peer replication (P2P-10/P2P-11) is out of Phase
// 40's scope — Phase 41 owns re-diagnosing/re-patching against the de-vendored
// baseline. Skipped rather than deleted to preserve the historical static-lock
// shape for that future re-patch. See 40-02-SUMMARY.md.
describe.skip('P2P-10/D-06: branded PeerId coverage across all 3 vendored dial sites', () => {
  it('peer-utils.js exports toBrandedPeerId()', () => {
    const src = readFileSync(PEER_UTILS_PATH, 'utf8')
    expect(
      src.includes(HELPER_EXPORT_MARKER),
      `Expected ${PEER_UTILS_PATH} to export toBrandedPeerId() (P2P-10/D-06) — the shared re-brand helper is missing`
    ).to.equal(true)
  })

  it('libp2p-key-network.js:245 chokepoint routes through toBrandedPeerId()', () => {
    const src = readFileSync(KEY_NETWORK_PATH, 'utf8')
    expect(
      src.includes(HELPER_CALL_MARKER),
      `Expected libp2p-key-network.js's dial chokepoint to call toBrandedPeerId() (P2P-10/D-06)`
    ).to.equal(true)
  })

  it('libp2p-node-base.js:295 RestorationCoordinator connect adapter routes through toBrandedPeerId()', () => {
    const src = readFileSync(NODE_BASE_PATH, 'utf8')
    expect(
      src.includes(HELPER_CALL_MARKER),
      `Expected libp2p-node-base.js's RestorationCoordinator connect adapter to route pid through toBrandedPeerId() (P2P-10/D-06)`
    ).to.equal(true)
  })

  it('repo/service.js:69 getPeerAddrs routes through toBrandedPeerId()', () => {
    const src = readFileSync(REPO_SERVICE_PATH, 'utf8')
    expect(
      src.includes(HELPER_CALL_MARKER),
      `Expected repo/service.js's getPeerAddrs to route peerId through toBrandedPeerId() (P2P-10/D-06)`
    ).to.equal(true)
  })

  it('negative lock: no unwrapped dial/getConnections pattern remains at the 2 sibling sites', () => {
    const nodeBaseSrc = readFileSync(NODE_BASE_PATH, 'utf8')
    const repoServiceSrc = readFileSync(REPO_SERVICE_PATH, 'utf8')

    expect(
      nodeBaseSrc.includes(BARE_DIAL_PROTOCOL),
      `Expected zero unwrapped 'node.dialProtocol(pid, [protocol])' occurrences in libp2p-node-base.js, found the bare pattern — a regression reintroduced the un-guarded dial (P2P-10/D-06 violation)`
    ).to.equal(false)

    expect(
      repoServiceSrc.includes(BARE_GET_CONNECTIONS),
      `Expected zero unwrapped 'getConnections(peerId)' occurrences in repo/service.js, found the bare pattern — a regression reintroduced the un-guarded call (P2P-10/D-06 violation)`
    ).to.equal(false)
  })
})
