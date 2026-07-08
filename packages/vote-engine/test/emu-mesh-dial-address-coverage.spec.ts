/**
 * emu-mesh-dial-address-coverage.spec.ts
 *
 * P2P-11/38-09 regression lock — the cold-dial branch of
 * `Libp2pKeyPeerNetwork.connect()` injects a drone-relayed `/p2p-circuit` dial
 * target when the target peer has no directly-dialable address (the NAT'd
 * emulator<->emulator case diagnosed in `38-09-ADDRESSING-DIAGNOSIS.md`),
 * instead of letting `libp2p.dialProtocol(dialPeer, ...)` throw "The dial
 * request has no valid addresses for peer" (540/~1137 drone errors in the
 * 38-08 clock-aligned n=4 capture — the dominant P2P-11 blocker).
 *
 * Four invariants, parsed from the vendored dist source (the source of truth
 * for what actually ships), all anchored to `connect()`'s own method body so
 * a comment elsewhere in the file (or in this spec) cannot self-satisfy the
 * assertion (the 38-07 spec-authoring lesson, restated in the 38-09 plan):
 *
 *   1. `toBrandedPeerId(` is still the FIRST call inside `connect()` — the
 *      P2P-10/D-06 chokepoint (36-38-01) must not regress.
 *   2. The warm-connection reuse branch (`open.newStream([protocol]`) is
 *      still present, unchanged.
 *   3. The cold-dial branch constructs a `/p2p-circuit` dial target — the
 *      NEW 38-09 fix.
 *   4. `runOnLimitedConnection: true` still appears in the cold-dial
 *      `dialOptions` (required to open a stream over the resulting limited/
 *      circuit-relay connection).
 *
 * Mirrors branded-peer-id-coverage.spec.ts / drone-materialize-defer-coverage.spec.ts's
 * "read a file with fs, regex/index-assert on its text, anchored to the
 * method body" shape. Static source-text assertions only — this is a
 * lockfile/source-tree guard, not a runtime-behaviour guard (the on-device
 * confirmation — absence of "no valid addresses for peer" in the drone log —
 * is 38-11's scope, per the plan's `<verify>`).
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
  throw new Error('emu-mesh-dial-address-coverage: could not locate yarn.lock walking up from the spec')
}

const REPO_ROOT = findRepoRoot()
const KEY_NETWORK_PATH = join(
  REPO_ROOT, 'vendor', '@optimystic', 'db-p2p', 'dist', 'src', 'libp2p-key-network.js'
)

// Build markers via concatenation so this spec's own explanatory text above
// cannot accidentally satisfy its own assertions (mirrors the
// branded-peer-id-coverage.spec.ts / 36-02 static-lock-authoring lesson).
const CONNECT_SIGNATURE = 'connect' + '(peerId, protocol, options) {'
const NEXT_METHOD_SIGNATURE = 'getFret' + '() {'
const BRANDED_CALL_MARKER = 'toBrandedPeerId' + '('
const WARM_REUSE_MARKER = 'open.newStream' + '([protocol]'
const CIRCUIT_MARKER = '/p2p-circuit' + '/p2p/'
const LIMITED_CONN_MARKER = 'runOnLimitedConnection' + ': true'

/** Extract the exact body of `connect()` — from its signature up to (not
 * including) the next method's signature — so all assertions are scoped to
 * this one method, not the whole file. */
function extractConnectBody (src: string): string {
  const start = src.indexOf(CONNECT_SIGNATURE)
  expect(start, `Expected to find the connect() method signature in ${KEY_NETWORK_PATH}`).to.be.greaterThan(-1)
  const end = src.indexOf(NEXT_METHOD_SIGNATURE, start)
  expect(end, 'Expected to find the next method signature (getFret) after connect()').to.be.greaterThan(start)
  return src.slice(start, end)
}

describe('P2P-11/38-09: drone-relayed /p2p-circuit dial-address injection at the connect() cold-dial chokepoint', () => {
  it('libp2p-key-network.js exists at the expected vendored-dist path', () => {
    expect(existsSync(KEY_NETWORK_PATH), `Expected ${KEY_NETWORK_PATH} to exist`).to.equal(true)
  })

  it('toBrandedPeerId( is still the FIRST call inside connect() (P2P-10/D-06 chokepoint preserved)', () => {
    const src = readFileSync(KEY_NETWORK_PATH, 'utf8')
    const body = extractConnectBody(src)
    const brandedIdx = body.indexOf(BRANDED_CALL_MARKER)
    const circuitIdx = body.indexOf(CIRCUIT_MARKER)
    expect(
      brandedIdx,
      'Expected toBrandedPeerId( to appear inside connect() (P2P-10/D-06 chokepoint missing)'
    ).to.be.greaterThan(-1)
    // toBrandedPeerId() must be the FIRST statement — i.e. it must appear
    // before any circuit-multiaddr construction this plan adds.
    if (circuitIdx > -1) {
      expect(
        brandedIdx,
        'Expected toBrandedPeerId( to appear BEFORE the /p2p-circuit dial-target construction (P2P-10/D-06 must stay the first operation in connect())'
      ).to.be.lessThan(circuitIdx)
    }
  })

  it('the warm-connection reuse branch (open.newStream([protocol]) is still present, unchanged', () => {
    const src = readFileSync(KEY_NETWORK_PATH, 'utf8')
    const body = extractConnectBody(src)
    expect(
      body.includes(WARM_REUSE_MARKER),
      'Expected connect() to still contain the warm-connection reuse branch ' +
      '(open.newStream([protocol] ...) — the 38-09 cold-dial fix must not regress it'
    ).to.equal(true)
  })

  it('the cold-dial branch constructs a /p2p-circuit dial target (P2P-11/38-09 fix)', () => {
    const src = readFileSync(KEY_NETWORK_PATH, 'utf8')
    const body = extractConnectBody(src)
    expect(
      body.includes(CIRCUIT_MARKER),
      'Expected connect()\'s cold-dial branch to construct a /p2p-circuit dial target ' +
      'when the target peer has no directly-dialable address (P2P-11/38-09 — the ' +
      '"no valid addresses for peer" dominant blocker fix per 38-09-ADDRESSING-DIAGNOSIS.md)'
    ).to.equal(true)
  })

  it('runOnLimitedConnection: true still appears in the cold-dial dialOptions', () => {
    const src = readFileSync(KEY_NETWORK_PATH, 'utf8')
    const body = extractConnectBody(src)
    const occurrences = body.split(LIMITED_CONN_MARKER).length - 1
    expect(
      occurrences,
      'Expected runOnLimitedConnection: true to appear at least once in connect() ' +
      '(required to open a stream over the resulting limited/circuit-relay connection)'
    ).to.be.greaterThan(0)
  })
})
