/**
 * relay-reachability-coverage.spec.ts
 *
 * P2P-11/38-12 regression lock. Per 38-12-RELAY-DIAGNOSIS.md the n=4 first-block
 * write FAILed at `1/4 approvals (needed 3); root: No response received` because
 * the over-broad 38-09 cold-dial guard in `Libp2pKeyPeerNetwork.connect()` was
 * HIJACKING the directly-reachable drone voter dials onto the drone's inert
 * `/p2p-circuit` relay path. This plan's relay-functional fix has two halves,
 * each locked here against the vendored-dist source of truth (what actually
 * ships to the on-device Metro bundle):
 *
 *   (i)  The tightened 38-09 guard — the cold-dial `/p2p-circuit` rewrite in
 *        `connect()` now gates on a known-direct-address check for `dialPeer`
 *        (via the peerStore) BEFORE constructing the circuit multiaddr, so a
 *        peer with a real direct address (drone-A / drone-B) falls through to
 *        the bare `dialProtocol(dialPeer, ...)` and is never hijacked.
 *   (ii) The T-38-12-01 DoS mitigation — a bounded `relayServerInit`
 *        (reservation limits) forwarded from the drone's network config through
 *        BOTH cadre-core node builders (control + strand) to
 *        `circuitRelayServer(options.relayServerInit)`, replacing the unlimited
 *        defaults, and set in `drone.mjs`.
 *
 * Assertions are anchored to the relevant method/config BODY (extract-slice
 * helpers) with markers built by string concatenation, so neither this spec's
 * own header text nor an unrelated comment elsewhere in a file can self-satisfy
 * an assertion (the 38-07/38-09 static-lock-authoring lesson). Static
 * source-text guard only — the on-device both-emulator PASS is 38-13's scope.
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
  throw new Error('relay-reachability-coverage: could not locate yarn.lock walking up from the spec')
}

const REPO_ROOT = findRepoRoot()
const KEY_NETWORK_PATH = join(
  REPO_ROOT, 'vendor', '@optimystic', 'db-p2p', 'dist', 'src', 'libp2p-key-network.js'
)
const CADRE_NODE_PATH = join(
  REPO_ROOT, 'vendor', '@serfab', 'cadre-core', 'dist', 'cadre-node.js'
)
const STRAND_MGR_PATH = join(
  REPO_ROOT, 'vendor', '@serfab', 'cadre-core', 'dist', 'strand-instance-manager.js'
)
const DRONE_PATH = join(REPO_ROOT, 'packages', 'p2p-probe-host', 'drone.mjs')

// Markers built by concatenation so this spec's own prose cannot satisfy them.
const CONNECT_SIGNATURE = 'connect' + '(peerId, protocol, options)'
const NEXT_METHOD_SIGNATURE = 'getFret' + '() {'
const BRANDED_CALL_MARKER = 'toBrandedPeerId' + '('
const CIRCUIT_MARKER = '/p2p-circuit' + '/p2p/'
const PEERSTORE_MARKER = 'peerStore' + '.get'
const RELAY_INIT_MARKER = 'relayServerInit'
const MAX_RES_MARKER = 'maxReservations'

/** Slice `connect()`'s own body (signature → next method signature). */
function extractConnectBody (src: string): string {
  const start = src.indexOf(CONNECT_SIGNATURE)
  expect(start, `Expected to find connect() in ${KEY_NETWORK_PATH}`).to.be.greaterThan(-1)
  const end = src.indexOf(NEXT_METHOD_SIGNATURE, start)
  expect(end, 'Expected the getFret() signature after connect()').to.be.greaterThan(start)
  return src.slice(start, end)
}

/** Slice a named method body from `<open>` up to `<close>` (both concatenated markers). */
function extractBetween (src: string, open: string, close: string, path: string): string {
  const start = src.indexOf(open)
  expect(start, `Expected to find "${open}" in ${path}`).to.be.greaterThan(-1)
  const end = src.indexOf(close, start)
  expect(end, `Expected to find "${close}" after "${open}" in ${path}`).to.be.greaterThan(start)
  return src.slice(start, end)
}

// SUPERSEDED (Phase 40-02, PUB-01/PUB-02 de-vendoring): this spec locks Phase 38's
// hand-patched `vendor/@optimystic/db-p2p` + `vendor/@serfab/cadre-core` dist source,
// which no longer exists now that VT consumes those packages from published npm
// (@serfab/cadre-core@0.8.1, @optimystic/db-p2p@0.14.1 — neither carries this P2P-11
// fix upstream). Cross-peer replication (P2P-11) is out of Phase 40's scope and was
// still FAIL as of 38-21 even with this fix live — Phase 41 owns re-diagnosing/
// re-patching (likely via a `yarn patch` on the published dist) against the
// de-vendored baseline. Skipped rather than deleted to preserve the historical
// static-lock shape for that future re-patch. See 40-02-SUMMARY.md.
describe.skip('P2P-11/38-12: relay-functional cross-peer reachability (tightened guard + bounded relayServerInit)', () => {
  it('the vendored-dist source files exist at the expected transplant paths', () => {
    expect(existsSync(KEY_NETWORK_PATH), `Expected ${KEY_NETWORK_PATH}`).to.equal(true)
    expect(existsSync(CADRE_NODE_PATH), `Expected ${CADRE_NODE_PATH}`).to.equal(true)
    expect(existsSync(STRAND_MGR_PATH), `Expected ${STRAND_MGR_PATH}`).to.equal(true)
    expect(existsSync(DRONE_PATH), `Expected ${DRONE_PATH}`).to.equal(true)
  })

  it('toBrandedPeerId( is still the FIRST call inside connect() (P2P-10/D-06 chokepoint preserved)', () => {
    const body = extractConnectBody(readFileSync(KEY_NETWORK_PATH, 'utf8'))
    const brandedIdx = body.indexOf(BRANDED_CALL_MARKER)
    expect(brandedIdx, 'Expected toBrandedPeerId( inside connect()').to.be.greaterThan(-1)
    const circuitIdx = body.indexOf(CIRCUIT_MARKER)
    if (circuitIdx > -1) {
      expect(
        brandedIdx,
        'toBrandedPeerId( must precede the /p2p-circuit construction (P2P-10/D-06 stays first)'
      ).to.be.lessThan(circuitIdx)
    }
  })

  it('the tightened 38-09 guard: a peerStore known-direct-address check gates the /p2p-circuit rewrite in connect()', () => {
    const body = extractConnectBody(readFileSync(KEY_NETWORK_PATH, 'utf8'))
    const peerStoreIdx = body.indexOf(PEERSTORE_MARKER)
    const circuitIdx = body.indexOf(CIRCUIT_MARKER)
    expect(
      peerStoreIdx,
      'Expected connect() to consult peerStore.get(dialPeer) for a known direct address ' +
      '(the 38-12 guard-tightening — fire the circuit branch ONLY for address-less peers, ' +
      'never hijack a direct drone-voter dial; see 38-12-RELAY-DIAGNOSIS.md §3/§5)'
    ).to.be.greaterThan(-1)
    expect(
      circuitIdx,
      'Expected connect() to still build a /p2p-circuit dial target for address-less peers'
    ).to.be.greaterThan(-1)
    expect(
      peerStoreIdx,
      'The peerStore known-direct-address check must appear BEFORE the /p2p-circuit ' +
      'construction (it decides whether to skip the circuit rewrite)'
    ).to.be.lessThan(circuitIdx)
  })

  it('T-38-12-01: cadre-node.js createControlNode() forwards a bounded relayServerInit', () => {
    const body = extractBetween(
      readFileSync(CADRE_NODE_PATH, 'utf8'),
      'async createControlNode()',
      'createStrandQueryable()',
      CADRE_NODE_PATH
    )
    expect(
      body.includes(RELAY_INIT_MARKER),
      'Expected createControlNode()\'s nodeOptions builder to forward relayServerInit from ' +
      'the network config (T-38-12-01 — bounds the already-constructed circuitRelayServer())'
    ).to.equal(true)
  })

  it('T-38-12-01: strand-instance-manager.js startStrand() forwards a bounded relayServerInit', () => {
    const body = extractBetween(
      readFileSync(STRAND_MGR_PATH, 'utf8'),
      'async startStrand(config)',
      'async stopStrand(strandId)',
      STRAND_MGR_PATH
    )
    expect(
      body.includes(RELAY_INIT_MARKER),
      'Expected startStrand()\'s createLibp2pNode({...}) to forward relayServerInit — the ' +
      'strand node is where replication/relay traffic flows, so its relay server MUST be ' +
      'bounded too (T-38-12-01, 38-12-RELAY-DIAGNOSIS.md §5b)'
    ).to.equal(true)
  })

  it('T-38-12-01: drone.mjs sets a bounded relayServerInit (reservation limits, not unlimited defaults)', () => {
    const src = readFileSync(DRONE_PATH, 'utf8')
    expect(
      src.includes(RELAY_INIT_MARKER),
      'Expected drone.mjs network config to set relayServerInit'
    ).to.equal(true)
    expect(
      src.includes(MAX_RES_MARKER),
      'Expected drone.mjs relayServerInit to carry a bounded reservation limit ' +
      '(maxReservations) rather than the unlimited circuit-relay-v2 defaults (T-38-12-01)'
    ).to.equal(true)
  })
})
